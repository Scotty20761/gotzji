import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Standalone packaging verifier has no generated TypeScript declaration.
import { verifyGotzjiRuntimeDirectory, validateGotzjiRuntimeProvenance } from '../../apps/desktop/scripts/verify-gotzji-runtime.mjs';

const temporaryRoots: string[] = [];
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
interface CoreManifest {
  schemaVersion: number; product: string; version: string; catalogVersion: number; storeSchemaVersion: number; entrypoint: string;
  files: Array<{ relativePath: string; sizeBytes: number; sha256: string }>;
}
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; manifest: CoreManifest; manifestPath: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gotzji-runtime-inventory-')));
  temporaryRoots.push(root);
  const names = ['product-server.mjs', 'product-broker.mjs', 'product-runner.mjs', 'fixture-worker.mjs'];
  const files = await Promise.all(names.map(async (relativePath) => {
    const text = `// ${relativePath}\n`;
    await writeFile(path.join(root, relativePath), text);
    return { relativePath, sizeBytes: Buffer.byteLength(text), sha256: digest(text) };
  }));
  const manifest = { schemaVersion: 1, product: 'gotzji', version: '5.7.3', catalogVersion: 1, storeSchemaVersion: 1, entrypoint: 'product-server.mjs', files };
  const manifestPath = path.join(root, 'product-runtime-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest, manifestPath };
}

describe('gotzji packaged neutral host inventory', () => {
  it('collects real bytes for the exact manifest and validates the corresponding runtime provenance', async () => {
    const f = await fixture();
    const result = await verifyGotzjiRuntimeDirectory(f.root, '5.7.3');
    expect(result.files).toHaveLength(5);
    expect(result.files.find((entry: { relativePath: string }) => entry.relativePath === 'resources/gotzji-core/product-server.mjs')).toBeTruthy();
    expect(validateGotzjiRuntimeProvenance(result, result.files, '5.7.3')).toBe(result);
  });

  it.each(['changed file', 'missing file', 'unlisted file', 'wrong version', 'unsafe path', 'wrong catalog', 'wrong schema'])(
    'rejects %s rather than publishing incomplete or misidentified core bytes', async (failure) => {
      const f = await fixture();
      if (failure === 'changed file') await writeFile(path.join(f.root, 'product-server.mjs'), 'changed host bytes');
      if (failure === 'missing file') await unlink(path.join(f.root, 'product-server.mjs'));
      if (failure === 'unlisted file') await writeFile(path.join(f.root, 'not-in-the-inventory.mjs'), 'new bytes');
      if (failure === 'wrong version') f.manifest.version = '99.0.0';
      if (failure === 'unsafe path') f.manifest.files[0]!.relativePath = '../outside.mjs';
      if (failure === 'wrong catalog') f.manifest.catalogVersion = 999;
      if (failure === 'wrong schema') f.manifest.storeSchemaVersion = 999;
      await writeFile(f.manifestPath, `${JSON.stringify(f.manifest, null, 2)}\n`);
      await expect(verifyGotzjiRuntimeDirectory(f.root, '5.7.3')).rejects.toThrow();
    },
  );

  it('rejects changed manifest contents and missing host provenance even when their own checksums look valid', async () => {
    const f = await fixture();
    const result = await verifyGotzjiRuntimeDirectory(f.root, '5.7.3');
    expect(() => validateGotzjiRuntimeProvenance(result, result.files.slice(1), '5.7.3')).toThrow('incomplete');
    result.manifest.files[0].sha256 = 'a'.repeat(64);
    expect(() => validateGotzjiRuntimeProvenance(result, result.files, '5.7.3')).toThrow('content differs');
    expect(await readFile(f.manifestPath, 'utf8')).not.toContain('a'.repeat(64));
  });
});
