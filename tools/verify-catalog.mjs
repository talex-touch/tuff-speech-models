#!/usr/bin/env node
/**
 * verify-catalog.mjs — validate every model descriptor and regenerate catalog.json.
 *
 * What it enforces (any failure exits non-zero and writes nothing):
 *   1. Every models/<id>/<version>/model.json satisfies schema/model.schema.json.
 *   2. The descriptor's `id` and `version` match its directory path, and each
 *      (id, version) pair appears exactly once.
 *   3. `license.redistributable === true` for every published version. A
 *      descriptor whose weights may not be hosted must never reach the catalog.
 *   4. At most one version per model id is `default`, and the catalog as a whole
 *      has exactly one default — the version Tuff installs on first run.
 *   5. Every `defaults.json` entry names an existing id@version.
 *   6. Each weight/auxiliary file's SHA-256 and byte size, whenever that file is
 *      present in the checkout (weights are gitignored, so absence is normal).
 *
 * It then writes catalog.json deterministically: entries sorted by id then
 * version, and `generatedAt` only advances when the model set actually changed.
 *
 * Usage: node tools/verify-catalog.mjs [--check]
 *   --check  validate without writing catalog.json (used in CI / pre-commit)
 */

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  bundleBytes,
  bundleManifestHash,
  compareVersions,
  isPlainObject,
  sha256File,
  stableStringify,
} from './lib/manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'models');
const CATALOG_PATH = path.join(ROOT, 'catalog.json');
const DEFAULTS_PATH = path.join(ROOT, 'defaults.json');
const MODEL_SCHEMA_PATH = path.join(ROOT, 'schema', 'model.schema.json');
const CATALOG_SCHEMA_PATH = path.join(ROOT, 'schema', 'catalog.schema.json');

class Failure extends Error {}

/** Fail fast on the first structural problem, but report all schema detail. */
function fail(message) {
  throw new Failure(message);
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Minimal JSON Schema validator for the subset the Tuff schemas actually use:
 * type, const, enum, pattern, minLength, maxLength, format=date-time,
 * minimum, required, properties, additionalProperties, items, minItems.
 * Deliberately self-contained — this repository has no npm dependencies.
 */
function validateSchema(value, schema, at, errors) {
  const where = at || '$';

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((type) => {
      switch (type) {
        case 'object':
          return isPlainObject(value);
        case 'array':
          return Array.isArray(value);
        case 'string':
          return typeof value === 'string';
        case 'integer':
          return Number.isInteger(value);
        case 'number':
          return typeof value === 'number' && Number.isFinite(value);
        case 'boolean':
          return typeof value === 'boolean';
        case 'null':
          return value === null;
        default:
          throw new Error(`validator: unsupported schema type "${type}"`);
      }
    });
    if (!ok) {
      errors.push(`${where}: expected ${types.join('|')}, got ${describeValue(value)}`);
      return;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${where}: must equal ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${where}: must be one of ${schema.enum.join(', ')}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${where}: ${JSON.stringify(value)} does not match /${schema.pattern}/`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${where}: must be at least ${schema.minLength} characters, got ${value.length}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${where}: must be at most ${schema.maxLength} characters, got ${value.length}`);
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push(`${where}: ${JSON.stringify(value)} is not a valid date-time`);
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${where}: must be >= ${schema.minimum}, got ${value}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${where}: needs at least ${schema.minItems} items, got ${value.length}`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateSchema(item, schema.items, `${where}[${index}]`, errors));
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${where}: missing required property "${key}"`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateSchema(child, properties[key], `${where}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${where}: unexpected property "${key}"`);
      } else if (isPlainObject(schema.additionalProperties)) {
        validateSchema(child, schema.additionalProperties, `${where}.${key}`, errors);
      }
    }
  }
}

function assertSchema(value, schema, label) {
  const errors = [];
  validateSchema(value, schema, '$', errors);
  if (errors.length > 0) {
    fail(`${label} does not satisfy its schema:\n    - ${errors.join('\n    - ')}`);
  }
}

async function readJson(file, label) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    fail(`${label} could not be read at ${path.relative(ROOT, file) || file}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} is not valid JSON (${path.relative(ROOT, file)}): ${error.message}`);
  }
}

/** Discover every models/<id>/<version>/model.json and reject stray layouts. */
async function discoverDescriptors() {
  if (!existsSync(MODELS_DIR)) fail('models/ directory is missing');
  const found = [];
  const ids = (await readdir(MODELS_DIR, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const idEntry of ids) {
    if (!idEntry.isDirectory()) {
      fail(`models/${idEntry.name} is a file; models/<id>/<version>/model.json is the only layout`);
    }
    const idDir = path.join(MODELS_DIR, idEntry.name);
    const versions = (await readdir(idDir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    if (versions.length === 0) fail(`models/${idEntry.name}/ has no version directories`);
    for (const versionEntry of versions) {
      if (!versionEntry.isDirectory()) {
        fail(`models/${idEntry.name}/${versionEntry.name} is a file, not a version directory`);
      }
      const descriptorPath = path.join(idDir, versionEntry.name, 'model.json');
      if (!existsSync(descriptorPath)) {
        fail(`models/${idEntry.name}/${versionEntry.name}/ is missing model.json`);
      }
      found.push({
        descriptorPath,
        repoPath: `models/${idEntry.name}/${versionEntry.name}/model.json`,
        versionDir: path.dirname(descriptorPath),
        dirId: idEntry.name,
        dirVersion: versionEntry.name,
      });
    }
  }
  if (found.length === 0) fail('no model descriptors found under models/');
  return found;
}

/** Verify a bundle file on disk when it is present; absence is not an error. */
async function verifyLocalFile({ file, bytes, sha256, label, notes }) {
  if (!existsSync(file)) {
    notes.push(`${label}: not present locally, digest not checked`);
    return false;
  }
  const actual = await sha256File(file);
  const { size } = await stat(file);
  if (size !== bytes) {
    fail(`${label}: expected ${bytes} bytes, found ${size} bytes (${path.relative(ROOT, file)})`);
  }
  if (actual !== sha256) {
    fail(`${label}: sha256 mismatch (${path.relative(ROOT, file)})\n    expected ${sha256}\n    actual   ${actual}`);
  }
  notes.push(`${label}: verified ${bytes} bytes, sha256 ${actual.slice(0, 16)}…`);
  return true;
}

async function loadDefaults(descriptors) {
  const known = new Map();
  for (const descriptor of descriptors) {
    const key = `${descriptor.data.id}@${descriptor.data.version}`;
    if (known.has(key)) {
      fail(`duplicate version: ${key} is defined by both ${known.get(key)} and ${descriptor.repoPath}`);
    }
    known.set(key, descriptor.repoPath);
  }

  let config = { schemaVersion: 1, defaults: {} };
  if (existsSync(DEFAULTS_PATH)) {
    const parsed = await readJson(DEFAULTS_PATH, 'defaults.json');
    if (!isPlainObject(parsed)) fail('defaults.json must contain a JSON object');
    if (parsed.schemaVersion !== 1) fail(`defaults.json: schemaVersion must be 1, got ${JSON.stringify(parsed.schemaVersion)}`);
    if (!isPlainObject(parsed.defaults)) fail('defaults.json: "defaults" must be a JSON object');
    config = parsed;
  }

  const defaults = new Map();
  for (const [id, version] of Object.entries(config.defaults)) {
    if (typeof version !== 'string') {
      fail(`defaults.json: value for "${id}" must be a version string, got ${JSON.stringify(version)}`);
    }
    if (!known.has(`${id}@${version}`)) {
      fail(`defaults.json points at ${id}@${version}, which no descriptor defines`);
    }
    defaults.set(id, version);
  }
  return defaults;
}

function buildCatalogEntry(descriptor, defaults) {
  const { data } = descriptor;
  return {
    id: data.id,
    version: data.version,
    name: data.name,
    engine: data.engine,
    languages: data.languages,
    descriptor: descriptor.repoPath,
    bytes: bundleBytes(data),
    sha256: bundleManifestHash(data),
    default: defaults.get(data.id) === data.version,
    redistributable: data.license.redistributable,
  };
}

async function main() {
  const checkOnly = process.argv.includes('--check');

  const modelSchema = await readJson(MODEL_SCHEMA_PATH, 'schema/model.schema.json');
  const catalogSchema = await readJson(CATALOG_SCHEMA_PATH, 'schema/catalog.schema.json');

  const discovered = await discoverDescriptors();

  // 1 + 2: schema-valid, path-consistent descriptors.
  const descriptors = [];
  for (const entry of discovered) {
    const data = await readJson(entry.descriptorPath, entry.repoPath);
    assertSchema(data, modelSchema, entry.repoPath);
    if (data.id !== entry.dirId) {
      fail(`${entry.repoPath}: id is "${data.id}" but the directory says "${entry.dirId}"`);
    }
    if (data.version !== entry.dirVersion) {
      fail(`${entry.repoPath}: version is "${data.version}" but the directory says "${entry.dirVersion}"`);
    }

    // 3: never publish weights we are not allowed to host.
    if (data.license.redistributable !== true) {
      fail(
        `${entry.repoPath}: license.redistributable is ${JSON.stringify(data.license.redistributable)} `
          + `(spdx "${data.license.spdx}") — this repository publishes only redistributable weights`,
      );
    }

    // Runtime file names must stay inside the version directory.
    const weightsFile = path.resolve(entry.versionDir, data.runtime.file);
    if (!weightsFile.startsWith(`${path.resolve(entry.versionDir)}${path.sep}`)) {
      fail(`${entry.repoPath}: runtime.file "${data.runtime.file}" escapes the version directory`);
    }
    if (path.basename(data.runtime.file) !== data.runtime.file) {
      fail(`${entry.repoPath}: runtime.file "${data.runtime.file}" must be a bare file name`);
    }

    descriptors.push({ ...entry, data, weightsFile });
  }

  const defaults = await loadDefaults(descriptors);

  // 4: exactly one default in the catalog; never two defaults for one id.
  const byId = new Map();
  for (const descriptor of descriptors) {
    const list = byId.get(descriptor.data.id) ?? [];
    list.push(descriptor);
    byId.set(descriptor.data.id, list);
  }
  for (const [id, list] of byId) {
    const marked = list.filter((item) => defaults.get(id) === item.data.version);
    if (marked.length > 1) {
      fail(`model "${id}" has ${marked.length} default versions; at most one is allowed`);
    }
  }
  const catalogDefaults = descriptors.filter((item) => defaults.get(item.data.id) === item.data.version);
  if (catalogDefaults.length !== 1) {
    const listed = catalogDefaults.map((item) => `${item.data.id}@${item.data.version}`).join(', ') || 'none';
    fail(
      `catalog must have exactly one default version (Tuff installs exactly one speech model on first run), `
        + `found ${catalogDefaults.length}: ${listed}.\n`
        + `    Fix defaults.json (currently: ${JSON.stringify(defaults.size ? Object.fromEntries(defaults) : {})}).`,
    );
  }

  // 6: local digest verification.
  const notes = [];
  for (const descriptor of descriptors) {
    await verifyLocalFile({
      file: descriptor.weightsFile,
      bytes: descriptor.data.runtime.bytes,
      sha256: descriptor.data.runtime.sha256,
      label: `${descriptor.data.id}@${descriptor.data.version} weights (${descriptor.data.runtime.file})`,
      notes,
    });
    for (const item of descriptor.data.auxiliary ?? []) {
      await verifyLocalFile({
        file: path.join(descriptor.versionDir, item.file),
        bytes: item.bytes,
        sha256: item.sha256,
        label: `${descriptor.data.id}@${descriptor.data.version} ${item.role} (${item.file})`,
        notes,
      });
    }
  }

  // Deterministic catalog: sorted by id, then version.
  const entries = descriptors
    .map((descriptor) => buildCatalogEntry(descriptor, defaults))
    .sort((a, b) => (a.id === b.id ? compareVersions(a.version, b.version) : a.id < b.id ? -1 : 1));

  const previous = existsSync(CATALOG_PATH) ? await readJson(CATALOG_PATH, 'catalog.json') : null;
  const unchanged =
    isPlainObject(previous)
    && typeof previous.generatedAt === 'string'
    && stableStringify(previous.models ?? null) === stableStringify(entries);

  const catalog = {
    schemaVersion: 1,
    generatedAt: unchanged ? previous.generatedAt : new Date().toISOString(),
    models: entries,
  };

  assertSchema(catalog, catalogSchema, 'generated catalog.json');
  if (!unchanged && new Set(entries.map((entry) => entry.sha256)).size !== entries.length) {
    fail('two catalog entries share a bundle digest; descriptors are not distinct');
  }

  for (const note of notes) console.log(`  · ${note}`);
  for (const entry of entries) {
    console.log(
      `  ✓ ${entry.id}@${entry.version} → ${entry.descriptor} `
        + `(${entry.bytes} bytes, ${entry.sha256.slice(0, 16)}…${entry.default ? ', default' : ''})`,
    );
  }

  if (checkOnly) {
    console.log('verify-catalog: OK (--check, catalog.json not written)');
    return;
  }

  await mkdir(path.dirname(CATALOG_PATH), { recursive: true });
  await writeFile(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(
    `verify-catalog: OK — catalog.json ${unchanged ? 'unchanged' : 'updated'} `
      + `(${entries.length} versions, default ${catalogDefaults[0].data.id}@${catalogDefaults[0].data.version}, `
      + `generatedAt ${catalog.generatedAt})`,
  );
}

main().catch((error) => {
  if (error instanceof Failure) {
    console.error(`verify-catalog: FAIL\n  ${error.message}`);
  } else {
    console.error(`verify-catalog: FAIL (unexpected)\n  ${error.stack ?? error.message}`);
  }
  process.exit(1);
});
