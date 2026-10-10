import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// publishHostReady renames the previous daemon-ready.json away before it renames the new record in. A reader that
// checked existence just before the first rename finds no file when it inspects it (macOS CI, 6a19e15c).
const vanished = vi.hoisted(() => ({ file: '', at: 'read' as 'lstat' | 'read', thrown: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const gone = (file: unknown, at: 'lstat' | 'read'): void => {
    if (vanished.file === '' || file !== vanished.file || vanished.at !== at) return;
    vanished.thrown += 1;
    throw Object.assign(new Error(`ENOENT: no such file or directory, ${at} '${String(file)}'`), { code: 'ENOENT' });
  };
  return {
    ...fs,
    lstatSync: ((file: Parameters<typeof fs.lstatSync>[0], ...rest: unknown[]) => { gone(file, 'lstat'); return (fs.lstatSync as (...args: unknown[]) => unknown)(file, ...rest); }) as typeof fs.lstatSync,
    readFileSync: ((file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) => { gone(file, 'read'); return (fs.readFileSync as (...args: unknown[]) => unknown)(file, ...rest); }) as typeof fs.readFileSync,
  };
});
const { readHostReadyRecord } = await import('./phase-r-host-identity.mjs');

describe('host-ready record read during a republish', () => {
  const roots: string[] = [];
  const key = 'k'.repeat(64);
  afterEach(() => { vanished.file = ''; vanished.thrown = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  // A valid published record: if the simulated disappearance ever stops applying, the reader returns it and the test fails.
  function published(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gotzji-host-ready-race-')); roots.push(root);
    const body = JSON.stringify({ pid: 4242, port: 51000, sourceHash: 'a'.repeat(64), configurationHash: 'b'.repeat(64), ownerNonce: 'c'.repeat(48) });
    writeFileSync(path.join(root, 'daemon-ready.json'), JSON.stringify({ body, mac: createHmac('sha256', key).update(body).digest('hex') }));
    return root;
  }

  it('returns the record when nothing vanishes', () => {
    expect(readHostReadyRecord(published(), key)).toMatchObject({ pid: 4242, port: 51000 });
  });

  it.each(['lstat', 'read'] as const)('reads a record that disappears after the existence check (at %s) as not yet published', (at) => {
    const root = published();
    vanished.file = path.join(root, 'daemon-ready.json'); vanished.at = at;
    expect(readHostReadyRecord(root, key)).toBeNull();
    expect(vanished.thrown).toBe(1);
  });
});
