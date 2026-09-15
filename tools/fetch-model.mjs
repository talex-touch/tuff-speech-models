#!/usr/bin/env node
/**
 * fetch-model.mjs — download and verify one speech model version for Tuff.
 *
 * Reads catalog.json (never the descriptor directly, so the published digest is
 * what gets enforced), resolves the version's download URL from the descriptor's
 * `source.url`, streams each missing file into the install directory, and only
 * keeps a file whose byte size and SHA-256 match the descriptor. A mismatch is a
 * hard failure: the partial download is deleted and nothing is installed.
 *
 * Usage:
 *   node tools/fetch-model.mjs <id> [version] [--dir <path>]
 *   node tools/fetch-model.mjs tuff-asr-zh            # default version of the id
 *   node tools/fetch-model.mjs whisper-tiny 1.0.0
 *
 * Default install directory:
 *   ~/Library/Application Support/Tuff/speech-models/<id>/<version>/
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { bundleFiles, bundleManifestHash, sha256File } from './lib/manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'catalog.json');

class Failure extends Error {}

function fail(message) {
  throw new Failure(message);
}

/**
 * Where a fetched model is installed.
 *
 * Kept identical to Tuff's own `resolveModelStoreRoot()` in
 * `packages/tuff-voice/src/local/model-store.ts`, so a model fetched here is
 * found by the runtime with no registration step and no second convention:
 * explicit path > TUFF_SPEECH_MODEL_DIR > platform default.
 */
function defaultInstallRoot() {
  const explicit = process.env.TUFF_SPEECH_MODEL_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Tuff', 'speech-models');
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'Tuff', 'speech-models');
}

function parseArgs(argv) {
  const positional = [];
  let dir;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--dir') {
      dir = argv[index + 1];
      if (!dir) fail('--dir needs a path');
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) fail(`unknown option "${arg}"`);
    positional.push(arg);
  }
  if (positional.length === 0) return { help: true };
  if (positional.length > 2) fail(`expected at most <id> [version], got ${positional.join(' ')}`);

  // Accept both "id version" and "id@version".
  const [first, second] = positional;
  if (second) return { id: first, version: second, dir };
  const at = first.indexOf('@');
  return at === -1
    ? { id: first, version: undefined, dir }
    : { id: first.slice(0, at), version: first.slice(at + 1), dir };
}

function usage() {
  console.log(`tuff-speech-models — install one model version

Usage:
  node tools/fetch-model.mjs <id> [version] [--dir <path>]

Examples:
  node tools/fetch-model.mjs tuff-asr-zh          # the catalog's default version of that id
  node tools/fetch-model.mjs whisper-tiny 1.0.0   # an explicit version

Default install directory: ${defaultInstallRoot()}/<id>/<version>/
  (the same layout Tuff's runtime resolves; override with TUFF_SPEECH_MODEL_DIR
   or --dir)`);
}

function selectEntry(catalog, id, version) {
  const matches = catalog.models.filter((entry) => entry.id === id);
  if (matches.length === 0) {
    const available = [...new Set(catalog.models.map((entry) => entry.id))].sort().join(', ');
    fail(`no model "${id}" in catalog.json. Available ids: ${available}`);
  }
  if (version) {
    const exact = matches.find((entry) => entry.version === version);
    if (!exact) {
      const available = matches.map((entry) => entry.version).join(', ');
      fail(`model "${id}" has no version "${version}". Available: ${available}`);
    }
    return exact;
  }
  return matches.find((entry) => entry.default === true) ?? matches[0];
}

/** Throttled progress line, only emitted on a TTY so logs stay clean. */
function progressFormatter(file) {
  if (!process.stdout.isTTY) return null;
  let last = 0;
  return (received, total) => {
    const now = Date.now();
    if (now - last < 500) return;
    last = now;
    const pct = total ? `${((received / total) * 100).toFixed(1)}%` : `${received} B`;
    process.stdout.write(`\r  ${file} ${pct} (${received} bytes)   `);
  };
}

async function downloadTo(url, destination, label) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    fail(`${label}: download failed — HTTP ${response.status} ${response.statusText} from ${url}`);
  }
  if (!response.body) fail(`${label}: download returned an empty body from ${url}`);

  const declared = Number(response.headers.get('content-length') ?? '0');
  const hash = createHash('sha256');
  const handle = await open(destination, 'w');
  let received = 0;
  const onProgress = progressFormatter(path.basename(destination));
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      hash.update(chunk);
      await handle.write(chunk);
      if (onProgress) onProgress(received, declared);
    }
  } finally {
    await handle.close();
    if (onProgress) process.stdout.write('\r');
  }

  if (declared && declared !== received) {
    fail(`${label}: truncated download — server declared ${declared} bytes, received ${received}`);
  }

  return { bytes: received, sha256: hash.digest('hex') };
}

async function installFile({ targetDir, fileSpec, url, label }) {
  const destination = path.join(targetDir, fileSpec.file);
  if (existsSync(destination)) {
    const info = await stat(destination);
    const digest = await sha256File(destination);
    if (info.size === fileSpec.bytes && digest === fileSpec.sha256) {
      return { file: fileSpec.file, status: 'already-present', bytes: info.size, sha256: digest, label };
    }
    console.log(`  ! ${label}: existing file does not match the descriptor, re-downloading`);
    await rm(destination, { force: true });
  }

  const partial = `${destination}.part`;
  await rm(partial, { force: true });
  const started = Date.now();
  let result;
  try {
    result = await downloadTo(url, partial, label);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (result.bytes !== fileSpec.bytes) {
    await rm(partial, { force: true });
    fail(`${label}: refusing to install — expected ${fileSpec.bytes} bytes, downloaded ${result.bytes}`);
  }
  if (result.sha256 !== fileSpec.sha256) {
    await rm(partial, { force: true });
    fail(
      `${label}: refusing to install — sha256 mismatch\n`
        + `    expected ${fileSpec.sha256}\n    actual   ${result.sha256}\n`
        + '    the partial download was deleted; nothing was installed',
    );
  }

  await rename(partial, destination);
  return {
    file: fileSpec.file,
    status: 'downloaded',
    bytes: result.bytes,
    sha256: result.sha256,
    seconds: elapsed,
    source: url,
    label,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (!existsSync(CATALOG_PATH)) {
    fail('catalog.json is missing — run `node tools/verify-catalog.mjs` first');
  }
  const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
  const entry = selectEntry(catalog, args.id, args.version);

  const descriptorPath = path.join(ROOT, entry.descriptor);
  if (!existsSync(descriptorPath)) {
    fail(`catalog points at ${entry.descriptor}, which does not exist`);
  }
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));

  // Enforce the published digest: the catalog promises a canonical bundle.
  const manifestHash = bundleManifestHash(descriptor);
  if (manifestHash !== entry.sha256) {
    fail(
      `${entry.descriptor}: bundle digest does not match catalog.json\n`
        + `    catalog  ${entry.sha256}\n    computed ${manifestHash}\n`
        + '    run `node tools/verify-catalog.mjs` to republish the catalog',
    );
  }

  const targetDir = path.join(args.dir ?? defaultInstallRoot(), entry.id, entry.version);

  console.log(`model      ${entry.id}@${entry.version}${entry.default ? '  (catalog default)' : ''}`);
  console.log(`engine     ${entry.engine}  languages ${entry.languages.join(', ')}`);
  console.log(`descriptor ${entry.descriptor}`);
  console.log(`bundle     sha256 ${entry.sha256}`);
  console.log(`target     ${targetDir}`);

  await mkdir(targetDir, { recursive: true });

  const installs = [];
  const files = bundleFiles(descriptor);
  for (const fileSpec of files) {
    const label = fileSpec.role === 'weights'
      ? `${entry.id}@${entry.version} weights`
      : `${entry.id}@${entry.version} ${fileSpec.role}`;
    const url = fileSpec.role === 'weights' ? descriptor.source?.url : fileSpec.url;
    if (!url) {
      const present = existsSync(path.join(targetDir, fileSpec.file));
      if (present) continue;
      fail(
        `${label}: no download URL — ${entry.descriptor} has no source.url for "${fileSpec.file}". `
          + 'This file must be shipped with the model bundle; it cannot be fetched.',
      );
    }
    installs.push(await installFile({ targetDir, fileSpec, url, label }));
  }

  // The descriptor travels with the bundle: Tuff's runtime reads `<install>/model.json`
  // to decide which engine runs the weights and what they must hash to, so an install
  // without it would be invisible. Copy the validated descriptor bytes through unchanged.
  const installedDescriptor = path.join(targetDir, 'model.json');
  await copyFile(descriptorPath, installedDescriptor);
  const installedDescriptorText = await readFile(installedDescriptor, 'utf8');
  const reread = JSON.parse(installedDescriptorText);
  if (reread.id !== entry.id || reread.version !== entry.version || bundleManifestHash(reread) !== entry.sha256) {
    fail(`${installedDescriptor}: the installed descriptor does not round-trip to the catalog entry`);
  }
  console.log(`  ↓ descriptor (model.json): ${Buffer.byteLength(installedDescriptorText, 'utf8')} bytes`);

  // Report, and prove what actually landed on disk.
  for (const item of installs) {
    if (item.status === 'already-present') {
      console.log(`  = ${item.label} (${item.file}): already installed, sha256 verified`);
    } else {
      console.log(`  ↓ ${item.label} (${item.file}): ${item.bytes} bytes in ${item.seconds}s from ${item.source}`);
    }
  }
  let totalBytes = 0;
  for (const fileSpec of files) {
    const installed = path.join(targetDir, fileSpec.file);
    const info = await stat(installed);
    const digest = await sha256File(installed);
    if (info.size !== fileSpec.bytes || digest !== fileSpec.sha256) {
      fail(`${installed}: post-install verification failed — the file on disk is not what the descriptor promises`);
    }
    totalBytes += info.size;
  }

  const state = installs.every((item) => item.status === 'already-present')
    ? 'already installed and verified'
    : `installed ${installs.filter((item) => item.status === 'downloaded').length} file(s)`;
  console.log(`result     ${state} — ${totalBytes} bytes verified in ${targetDir}`);
}

main().catch(async (error) => {
  if (error instanceof Failure) {
    console.error(`fetch-model: FAIL\n  ${error.message}`);
  } else {
    console.error(`fetch-model: FAIL (unexpected)\n  ${error.stack ?? error.message}`);
  }
  process.exit(1);
});