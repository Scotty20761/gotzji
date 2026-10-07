import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const GOTZJI_RUNTIME_PREFIX = 'resources/gotzji-core/';
export const GOTZJI_RUNTIME_MANIFEST = 'product-runtime-manifest.json';
const requiredEntries = ['product-server.mjs', 'product-broker.mjs', 'product-runner.mjs', 'fixture-worker.mjs'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function validateGotzjiRuntimeManifest(manifest, version) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.product !== 'gotzji' || manifest.version !== version
    || manifest.catalogVersion !== 1 || manifest.storeSchemaVersion !== 1 || manifest.entrypoint !== 'product-server.mjs'
    || !Array.isArray(manifest.files) || manifest.files.length < requiredEntries.length) {
    throw new Error('The gotzji core runtime manifest identity/version/catalog/store schema is invalid');
  }
  const entries = new Map();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.relativePath !== 'string' || entry.relativePath.length === 0
      || entry.relativePath.includes('\\') || entry.relativePath.startsWith('/') || entry.relativePath.includes(':')
      || entry.relativePath.split('/').some((part) => part === '..' || part === '.' || part === '')
      || entry.relativePath === GOTZJI_RUNTIME_MANIFEST || entries.has(entry.relativePath)
      || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
      throw new Error('The gotzji core runtime manifest contains an invalid or duplicate file');
    }
    entries.set(entry.relativePath, entry);
  }
  for (const entry of requiredEntries) {
    if (!entries.has(entry)) throw new Error(`The gotzji core runtime manifest is missing ${entry}`);
  }
  return entries;
}

export async function verifyGotzjiRuntimeDirectory(directory, version) {
  const manifestPath = path.join(directory, GOTZJI_RUNTIME_MANIFEST);
  await assertRegularFile(manifestPath);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!manifestBytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))) {
    throw new Error('The gotzji core runtime manifest must use the canonical build encoding');
  }
  const entries = validateGotzjiRuntimeManifest(manifest, version);
  const actualPaths = await walk(directory);
  if (actualPaths.length !== entries.size + 1 || actualPaths.some((entry) => entry !== GOTZJI_RUNTIME_MANIFEST && !entries.has(entry))) {
    throw new Error('The gotzji core runtime inventory contains missing or unlisted packaged files');
  }
  const files = [];
  for (const [relativePath, expected] of entries) {
    const filePath = path.join(directory, ...relativePath.split('/'));
    const metadata = await assertRegularFile(filePath);
    const sha256 = digest(await readFile(filePath));
    if (metadata.size !== expected.sizeBytes || sha256 !== expected.sha256) {
      throw new Error(`The gotzji core runtime bytes differ from the manifest: ${relativePath}`);
    }
    files.push({ name: path.posix.basename(relativePath), relativePath: `${GOTZJI_RUNTIME_PREFIX}${relativePath}`, sizeBytes: metadata.size, sha256 });
  }
  files.push({ name: GOTZJI_RUNTIME_MANIFEST, relativePath: `${GOTZJI_RUNTIME_PREFIX}${GOTZJI_RUNTIME_MANIFEST}`, sizeBytes: manifestBytes.length, sha256: digest(manifestBytes) });
  return { manifest, manifestSha256: digest(manifestBytes), files };
}

export function validateGotzjiRuntimeProvenance(core, runtime, version) {
  const entries = validateGotzjiRuntimeManifest(core?.manifest, version);
  if (!Array.isArray(runtime) || !/^[0-9a-f]{64}$/.test(core?.manifestSha256 ?? '')) {
    throw new Error('The gotzji core runtime provenance is missing or invalid');
  }
  if (digest(`${JSON.stringify(core.manifest, null, 2)}\n`) !== core.manifestSha256) {
    throw new Error('The gotzji core manifest content differs from its recorded digest');
  }
  const recorded = runtime.filter((entry) => entry?.relativePath?.startsWith(GOTZJI_RUNTIME_PREFIX));
  if (recorded.length !== entries.size + 1 || new Set(recorded.map((entry) => entry.relativePath)).size !== recorded.length) {
    throw new Error('The gotzji core runtime provenance inventory is incomplete or duplicated');
  }
  for (const [relativePath, expected] of entries) {
    const entry = recorded.find((candidate) => candidate.relativePath === `${GOTZJI_RUNTIME_PREFIX}${relativePath}`);
    if (!entry || entry.sha256 !== expected.sha256 || entry.sizeBytes !== expected.sizeBytes) {
      throw new Error(`The gotzji core runtime provenance differs from the manifest: ${relativePath}`);
    }
  }
  const manifestEntry = recorded.find((entry) => entry.relativePath === `${GOTZJI_RUNTIME_PREFIX}${GOTZJI_RUNTIME_MANIFEST}`);
  if (manifestEntry?.sha256 !== core.manifestSha256) {
    throw new Error('The gotzji core runtime manifest is not bound to the packaged bytes');
  }
  return core;
}

async function assertRegularFile(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(filePath) !== path.resolve(filePath)) {
    throw new Error(`The gotzji runtime file is not a canonical regular file: ${path.basename(filePath)}`);
  }
  return metadata;
}

async function walk(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('The gotzji core runtime must not contain symbolic links');
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), `${relativePath}/`));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error('The gotzji core runtime contains an unsupported filesystem entry');
  }
  return files;
}
