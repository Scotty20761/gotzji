import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { productOperation, registeredProject, reviewedRecipe } from './product-projects.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(): Promise<{
  root: string; executable: string; prepare: (id: string) => unknown;
}> {
  const root = await canonicalTemporaryDirectory('gotzji-command-fingerprint-'); roots.push(root);
  const project = path.join(root, 'project'); await mkdir(project);
  // Admission only: these bytes are hashed but never executed or passed to a worker.
  const executable = path.join(root, 'owned-program.bin'); await writeFile(executable, Buffer.alloc(1024 * 1024, 0x61));
  const recipe = reviewedRecipe({ recipeId: 'check', executable, args: ['--version'], dependencies: [] });
  const registration = registeredProject('owner', { projectId: 'project', displayName: 'Owned project', rootPath: project, recipeIds: ['check'] });
  return { root, executable, prepare: (requestId: string): unknown => productOperation(registration, { requestId, projectId: 'project', operation: 'command.run', commandId: 'check' }, recipe) };
}

describe('reviewed command admission fingerprints', () => {
  it('does not reread an unchanged program for every one of 32 queue preparations', async () => {
    const f = await fixture();
    vi.mocked(readFileSync).mockClear();
    for (let index = 0; index < 32; index++) f.prepare(`request-${index}`);
    expect(vi.mocked(readFileSync).mock.calls.filter(([filename]) => filename === f.executable)).toHaveLength(1);
    expect((await readFile(f.executable)).length).toBe(1024 * 1024);
  });

  it.each(['in-place', 'replacement'] as const)('still rejects %s changed bytes after a successful cached preparation', async mode => {
    const f = await fixture(); f.prepare('before');
    const before = await stat(f.executable);
    if (mode === 'replacement') {
      await writeFile(path.join(f.root, 'replacement.bin'), Buffer.alloc(1024 * 1024, 0x62));
      await rename(f.executable, path.join(f.root, 'original.bin'));
      await rename(path.join(f.root, 'replacement.bin'), f.executable);
    } else await writeFile(f.executable, Buffer.alloc(1024 * 1024, 0x62));
    // Keep size and mtime the same: ctime/identity must invalidate the cache as well.
    await utimes(f.executable, before.atime, before.mtime);
    expect(() => f.prepare('changed')).toThrow(expect.objectContaining({ code: 'COMMAND_DEPENDENCIES_CHANGED', field: 'commandId' }));
  });
});
