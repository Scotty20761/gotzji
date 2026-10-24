import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownedRootRemovalEvidence } from '../e2e/owned-fixture-cleanup.js';

const roots: string[] = [];
async function fixture(): Promise<{ root: string; outside: string }> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gotzji-cleanup-diagnostic-'))); roots.push(parent);
  const root = path.join(parent, 'owned-data'); const outside = path.join(parent, 'outside-data');
  await mkdir(root); await mkdir(outside); return { root, outside };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('gotzji-cleanup-diagnostic-')) throw new Error('Diagnostic fixture cleanup scope denied');
    await rm(root, { recursive: true, force: true });
  }
});
describe('owned-root deletion failure evidence', () => {
  it('retains the actual filesystem category, syscall and owned-relative failed path', async () => {
    const { root } = await fixture(); await mkdir(path.join(root, 'runtime'));
    const error = Object.assign(new Error('private absolute details'), { code: 'EPERM', syscall: 'unlink', path: path.join(root, 'runtime', 'core.sqlite') });
    expect(await ownedRootRemovalEvidence(root, error)).toMatchObject({ code: 'EPERM', syscall: 'unlink', path: 'runtime/core.sqlite', remaining: [{ name: 'runtime', kind: 'directory' }], truncated: false });
  });
  it('redacts outside error paths and lists a junction without traversing it', async () => {
    const { root, outside } = await fixture(); await writeFile(path.join(outside, 'PRIVATE_OUTSIDE_NAME'), 'private');
    await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const evidence = await ownedRootRemovalEvidence(root, { code: 'EPERM', syscall: 'unlink', path: path.join(outside, 'PRIVATE_OUTSIDE_NAME') });
    expect(evidence).toMatchObject({ path: '<outside-owned-root>', remaining: [{ name: 'link', kind: 'link' }] });
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_OUTSIDE_NAME'); expect(JSON.stringify(evidence)).not.toContain(outside);
  });
  it('bounds remaining entry names and explicitly labels truncation', async () => {
    const { root } = await fixture(); await Promise.all(Array.from({ length: 25 }, (_, index) => writeFile(path.join(root, `owned-${index}.txt`), 'owned')));
    const evidence = await ownedRootRemovalEvidence(root, { code: 'ENOTEMPTY', syscall: 'rmdir', path: root });
    expect(evidence).toMatchObject({ code: 'ENOTEMPTY', path: '.', truncated: true }); expect(evidence.remaining).toHaveLength(20);
  });
  it('refuses a replaced root junction before exposing any outside entry names', async () => {
    const { root, outside } = await fixture(); await writeFile(path.join(outside, 'PRIVATE_ROOT_SENTINEL'), 'private');
    await rename(root, `${root}-retained`);
    await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    const evidence = await ownedRootRemovalEvidence(root, { code: 'ENOTEMPTY', syscall: 'rmdir', path: root });
    expect(evidence).toMatchObject({ remaining: [], censusError: 'ROOT_SCOPE_CHANGED' });
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_ROOT_SENTINEL'); expect(JSON.stringify(evidence)).not.toContain(outside);
  });
  it('records a failed read-only census without inventing absence or exposing outside paths', async () => {
    const { root } = await fixture(); const missing = path.join(root, 'missing');
    expect(await ownedRootRemovalEvidence(missing, { code: 'EACCES' })).toMatchObject({ code: 'EACCES', path: '<unknown>', remaining: [], censusError: 'ENOENT' });
  });
});
