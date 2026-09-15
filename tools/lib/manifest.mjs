/**
 * Shared helpers for the Tuff speech-model tooling.
 *
 * A bundle manifest is the canonical, order-stable projection of a version
 * descriptor that the catalog hashes. It contains only what a client must be
 * able to verify: which files the version is made of, how big they are, and
 * what they hash to. Presentation fields (name, description, benchmark) are
 * deliberately excluded so editing prose never changes a published digest.
 *
 * Canonical form: UTF-8 JSON with every object key sorted, no whitespace,
 * weight file first, then auxiliary files sorted by file name.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** @param {unknown} value */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays left in place.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    const body = Object.keys(/** @type {Record<string, unknown>} */ (value))
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(/** @type {any} */ (value)[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Files that make up a version, in canonical order: weights first, then
 * auxiliary files sorted by their bundle-relative path.
 * @param {any} descriptor
 */
export function bundleFiles(descriptor) {
  const auxiliary = [...(descriptor.auxiliary ?? [])].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
  return [
    {
      role: 'weights',
      file: descriptor.runtime.file,
      bytes: descriptor.runtime.bytes,
      sha256: descriptor.runtime.sha256,
    },
    ...auxiliary.map((item) => ({
      role: item.role,
      file: item.file,
      bytes: item.bytes,
      sha256: item.sha256,
    })),
  ];
}

/**
 * SHA-256 over the canonical bundle manifest, as published in catalog.json.
 * @param {any} descriptor
 * @returns {string}
 */
export function bundleManifestHash(descriptor) {
  const manifest = {
    id: descriptor.id,
    version: descriptor.version,
    engine: descriptor.engine,
    files: bundleFiles(descriptor),
  };
  return createHash('sha256').update(stableStringify(manifest), 'utf8').digest('hex');
}

/** Total download size of a version: weights plus auxiliary files. */
export function bundleBytes(descriptor) {
  return bundleFiles(descriptor).reduce((sum, file) => sum + file.bytes, 0);
}

/**
 * Streaming SHA-256 of a file on disk.
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * Compare two `x.y.z` versions numerically.
 * @returns {number}
 */
export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
