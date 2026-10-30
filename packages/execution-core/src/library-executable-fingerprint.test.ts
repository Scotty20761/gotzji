import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreStore, hash } from './store.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import { assertProductDependencies } from './product-security.mjs';
import { assertPreparedLibraryDependencies } from './product-library-broker.mjs';
import { createOwnedTestLifetime, finishOwnedTest, type OwnedTestLifetime } from '../test-support/owned-test-lifetime.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const owned: { root: string; store?: CoreStore }[] = [];
let testLifetime: OwnedTestLifetime;
beforeEach(() => { testLifetime = createOwnedTestLifetime(); });
function ownBody<Arguments extends unknown[]>(body: (...args: Arguments) => Promise<void>): (...args: Arguments) => Promise<void> { return (...args) => testLifetime.run(() => body(...args)); }
afterEach(async () => {
  await finishOwnedTest(testLifetime, () => undefined, () => owned.splice(0), async value => {
    try {
      if (value.store) {
        expect(value.store.database.connection.prepare('SELECT COUNT(*) AS count FROM gotzji_claims').get()?.count).toBe(0);
        expect(value.store.database.connection.prepare('SELECT COUNT(*) AS count FROM gotzji_workers').get()?.count).toBe(0);
      }
    } finally { value.store?.close(); }
    await rm(value.root, { recursive: true, force: true });
  });
});

interface Pin { path: string; hash: string }
interface Fixture {
  root: string; executable: string; source: string; policy: string;
  prepared: { kind: string; projectPolicies: Record<string, Pin>; policyDirectories: string[]; library: { ast: { workflowId: string; workflowVersion: number }; selectedSources: Pin[]; python: Pin } };
  config: { text: string; database: string; jobId: string; effectRoot: string; grace: { mode: string; executable: string; executableHash: string; sourceFile: string; sourceHash: string; documents: Record<string, Pin> } };
}
async function fixture(): Promise<Fixture> {
  const parent = testLifetime;
  const root = await canonicalTemporaryDirectory('gotzji-library-executable-pin-');
  const ownership: { root: string; store?: CoreStore } = { root }; owned.push(ownership);
  const executable = path.join(root, 'owned-program.bin');
  const source = path.join(root, 'source.md');
  const policy = path.join(root, 'AGENTS.md');
  await writeFile(executable, Buffer.alloc(1024 * 1024, 0x61));
  await writeFile(source, 'Original source\n');
  await writeFile(policy, 'Frozen policy\n');
  const pin = async (filename: string): Promise<Pin> => ({ path: filename, hash: hash(await readFile(filename)) });
  const programPin = await pin(executable); const sourcePin = await pin(source); const policyPin = await pin(policy);
  const prepared = { kind: 'library', projectPolicies: { project_policy_root: policyPin }, policyDirectories: [root], library: { ast: { workflowId: 'library.read', workflowVersion: 1 }, selectedSources: [sourcePin], python: programPin } };
  const state = path.join(root, 'state'); await mkdir(state);
  const store = new CoreStore(path.join(state, 'core.sqlite'), 'a'.repeat(64)); ownership.store = store;
  const config = { text: JSON.stringify(prepared), database: path.join(state, 'core.sqlite'), jobId: 'dependency-observation-without-admission', effectRoot: root, grace: { mode: 'test-driver', executable, executableHash: programPin.hash, sourceFile: source, sourceHash: sourcePin.hash, documents: { rules: policyPin } } };
  parent.signal.throwIfAborted();
  return { root, executable, source, policy, prepared, config };
}
const checks = [
  { name: 'product dependency gate', calls: 32, error: 'LIBRARY_SOURCE_CHANGED', check: (value: Fixture): void => assertProductDependencies(value.config) },
  { name: 'prepared Library dependency gate', calls: 16, error: 'PROJECT_POLICY_CHANGED', check: (value: Fixture): void => assertPreparedLibraryDependencies(value.config, value.prepared) },
];

describe('frozen Library executables at actual dependency call sites', () => {
  it('checks the controller pin even when the valid Python pin warmed the same file', ownBody(async () => {
    const f = await fixture(); assertPreparedLibraryDependencies(f.config, f.prepared);
    const wrongController = { ...f.config, grace: { ...f.config.grace, executableHash: 'e'.repeat(64) } };
    expect(() => assertPreparedLibraryDependencies(wrongController, f.prepared)).toThrow('PROJECT_POLICY_CHANGED');
  }));

  for (const gate of checks) {
    it(`${gate.name} reads one unchanged executable once across repeated checks`, ownBody(async () => {
      const f = await fixture(); vi.mocked(readFileSync).mockClear();
      for (let index = 0; index < gate.calls; index++) gate.check(f);
      expect(vi.mocked(readFileSync).mock.calls.filter(([filename]) => filename === f.executable)).toHaveLength(1);
    }));

    it.each(['in-place', 'replacement'] as const)(`${gate.name} rejects %s changed bytes with size and mtime restored`, ownBody(async (mode: 'in-place' | 'replacement') => {
      const f = await fixture(); gate.check(f); const before = await stat(f.executable);
      if (mode === 'replacement') {
        const replacement = path.join(f.root, 'replacement.bin');
        await writeFile(replacement, Buffer.alloc(1024 * 1024, 0x62));
        await rename(f.executable, path.join(f.root, 'original.bin')); await rename(replacement, f.executable);
      } else await writeFile(f.executable, Buffer.alloc(1024 * 1024, 0x62));
      await utimes(f.executable, before.atime, before.mtime);
      expect(() => gate.check(f)).toThrow(gate.error);
    }));

    it(`${gate.name} still validates the expected hash and frozen source/policy`, ownBody(async () => {
      const f = await fixture(); gate.check(f);
      const wrongPin = { ...f.prepared, library: { ...f.prepared.library, python: { ...f.prepared.library.python, hash: 'f'.repeat(64) } } };
      const wrongConfig = { ...f.config, text: JSON.stringify(wrongPin) };
      expect(() => gate.name === 'product dependency gate' ? assertProductDependencies(wrongConfig) : assertPreparedLibraryDependencies(wrongConfig, wrongPin)).toThrow(gate.error);
      await writeFile(f.source, 'Changed source\n');
      expect(() => gate.check(f)).toThrow();
      await writeFile(f.source, 'Original source\n'); await writeFile(f.policy, 'Changed policy\n');
      expect(() => gate.check(f)).toThrow('PROJECT_POLICY_CHANGED');
    }));

    it(`${gate.name} retains missing and noncanonical path refusal after warming the program pin`, ownBody(async () => {
      const f = await fixture(); gate.check(f);
      const alias = f.root + path.sep + '.' + path.sep + 'owned-program.bin';
      const aliased = { ...f.prepared, library: { ...f.prepared.library, python: { ...f.prepared.library.python, path: alias } } };
      const aliasConfig = { ...f.config, text: JSON.stringify(aliased) };
      expect(() => gate.name === 'product dependency gate' ? assertProductDependencies(aliasConfig) : assertPreparedLibraryDependencies(aliasConfig, aliased)).toThrow(gate.error);
      await rename(f.executable, path.join(f.root, 'moved-program.bin'));
      expect(() => gate.check(f)).toThrow(gate.error);
    }));
  }
});
