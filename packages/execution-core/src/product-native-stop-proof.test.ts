/* global setTimeout, clearTimeout */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as processIdentityObserver from './process-identity.mjs';
import { GotzjiNativeAdapter } from '@lnwjud/capabilities/gotzji-native-adapter';
import { GotzjiNativeError } from '@lnwjud/capabilities/gotzji-native-contract';
import { prepareProductNativeOperation, signPreparedNativeOperation, type AuthorizedNativeWorkerConfig, type NativeWorkerBinding } from './product-native.js';
import { executePreparedNativeOperation, readPreparedNativeState, reconcilePreparedNativeStop } from './product-native-broker.mjs';
import { createWindowsProcessIdentityReader, processIdentities, sameProcessIdentity, type ProcessIdentity, type WindowsPowerShellSession } from './process-identity.mjs';
import type { RegisteredProject } from './types.js';

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
let qualificationRoot = path.resolve(process.env.LOCALAPPDATA ?? process.cwd(), 'gotzji', 'qualification');
interface OwnedChild { readonly child: ChildProcess; identity?: ProcessIdentity; noProcess?: true }
const roots: string[] = []; const children: OwnedChild[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  let cleanupProved = true;
  for (const child of children.splice(0)) { try { await stop(child); } catch { cleanupProved = false; } }
  if (!cleanupProved) throw new Error(`Synthetic child absence unproved; retained roots: ${roots.join(', ')}`);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(mode: 'claude' | 'test-driver' = 'claude', providerSource = 'trusted'): Promise<{ root: string; source: string; output: string; config: AuthorizedNativeWorkerConfig; prepared: Awaited<ReturnType<typeof prepareProductNativeOperation>> }> {
  await mkdir(qualificationRoot, { recursive: true }); qualificationRoot = await realpath(qualificationRoot);
  const root = await realpath(await mkdtemp(path.join(qualificationRoot, 'native-stop-proof-'))); roots.push(root);
  const projectRoot = path.join(root, 'project'); const effectRoot = path.join(root, 'effects'); await mkdir(projectRoot); await mkdir(effectRoot);
  const source = path.join(projectRoot, 'source.xlsx'); const output = path.join(projectRoot, 'output.xlsx'); const scriptPath = path.join(root, 'provider.ps1');
  await writeFile(source, 'original'); await writeFile(scriptPath, providerSource);
  const project: RegisteredProject = { projectId: 'project', displayName: 'fixture', rootPath: projectRoot, owner: 'owner', resourceKey: 'resource', recipeIds: [] };
  const prepared = await prepareProductNativeOperation(project, { requestId: 'request', projectId: 'project', operation: 'excel.range.write', path: 'source.xlsx', outputPath: 'output.xlsx', sheet: 'Sheet', range: 'A1', values: [['after']] }, { scriptPath, scriptSha256: digest(providerSource) });
  const binding: NativeWorkerBinding = { owner: 'owner', jobId: 'job', epoch: 'epoch', generation: 1, session: 'session', intentRevision: 0, authorizationDigest: 'a'.repeat(64), policy: 'b'.repeat(64), token: 'c'.repeat(64), lease: 'lease', effectRoot, database: path.join(root, 'core.sqlite'), text: JSON.stringify(prepared), grace: { mode } };
  return { root, source, output, prepared, config: { ...binding, nativeAuthorization: signPreparedNativeOperation(binding, prepared) } };
}
function evidenceBinding(f: Awaited<ReturnType<typeof fixture>>): { publicBinding: Record<string, unknown>; key: string; journal: string } {
  const journal = path.join(f.config.effectRoot, 'native-process-identities.jsonl');
  const publicBinding = { schemaVersion: 1, effectRoot: f.config.effectRoot, journalPath: journal, jobId: f.config.jobId, epoch: f.config.epoch, generation: f.config.generation, planDigest: f.prepared.native.planDigest, provider: f.prepared.native.provider };
  const key = createHmac('sha256', Buffer.from(f.config.token, 'hex')).update('gotzji-native-process-evidence-v1\0').update(JSON.stringify(publicBinding)).digest('hex');
  return { publicBinding, key, journal };
}
async function journal(f: Awaited<ReturnType<typeof fixture>>, identities: readonly ProcessIdentity[], pids: readonly number[], macKey?: string): Promise<void> {
  const binding = evidenceBinding(f); const lines: string[] = [];
  for (let index = 0; index < identities.length; index++) {
    const body = JSON.stringify({ schemaVersion: 1, recordType: 'identity', jobId: f.config.jobId, epoch: f.config.epoch, generation: f.config.generation,
      planDigest: f.prepared.native.planDigest, invocationId: randomUUID(), provider: f.prepared.native.provider, pid: pids[index], birth: identities[index]!.birth, executable: identities[index]!.executable, recordedAt: new Date().toISOString() });
    const mac = createHmac('sha256', Buffer.from(macKey ?? binding.key, 'hex')).update(body).digest('hex'); lines.push(JSON.stringify({ body, mac }));
  }
  await writeFile(binding.journal, `${lines.join('\n')}\n`);
}
async function ownedNode(executable = process.execPath): Promise<OwnedChild> {
  const child = spawn(executable, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' }); const owned: OwnedChild = { child }; children.push(owned);
  try { await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
  catch (error) { owned.noProcess = true; throw error; }
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!Number.isSafeInteger(child.pid) || child.pid! < 1) throw new Error('Synthetic child PID unavailable after spawn');
    const value = (await processIdentities([child.pid!]))[child.pid!];
    if (value && value !== 'unknown') { owned.identity = value; return owned; }
    if (child.exitCode !== null) throw new Error('Synthetic child exited before identity proof');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Synthetic child identity unavailable within bounded acquisition');
}
async function stop(owned: OwnedChild): Promise<void> {
  if (owned.noProcess) return;
  if (!owned.identity) {
    const current = (await processIdentities([owned.child.pid!]))[owned.child.pid!];
    if (current === null) return;
    if (!current || current === 'unknown') throw new Error(`Synthetic child identity unproved for PID ${owned.child.pid}`);
    owned.identity = current;
  }
  if (owned.child.exitCode === null) { try { owned.child.kill(); } catch { /* exact child already ended */ } }
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!sameProcessIdentity(owned.identity, (await processIdentities([owned.child.pid!]))[owned.child.pid!])) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Synthetic child absence unproved for PID ${owned.child.pid}`);
}

describe('native process stop evidence', () => {
  it('persists only the final correlated identity failure while keeping stop proof unknown', async () => {
    const f = await fixture();
    await journal(f, [{ birth: 'owned-fixture-birth', executable: process.execPath }], [101]);
    let calls = 0;
    const session = { identity: async () => { calls += 1; throw Object.assign(new Error('private provider text'), { code: calls < 3 ? 'EACCES' : 'POWERSHELL_SESSION_TIMEOUT' }); } } as unknown as WindowsPowerShellSession;
    const read = createWindowsProcessIdentityReader({ currentPid: 999, exists: () => true, session });
    vi.spyOn(processIdentityObserver, 'processIdentities').mockImplementation(read);
    const result = await reconcilePreparedNativeStop(f.config);
    expect(calls).toBe(3);
    expect(result).toMatchObject({ outcome: 'unknown', stopEvidence: { observed: 'unknown', identityCount: 1,
      identityDiagnostics: { 101: 'PROBE_POWERSHELL_SESSION_TIMEOUT' } }, effectEvidence: { source: 'unchanged', output: 'absent' } });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown', stopEvidence: result.stopEvidence });
    expect(JSON.stringify(readPreparedNativeState(f.config))).not.toContain('private provider text');
  });
  it('drops prior diagnostic codes when a fresh observation proves absence', async () => {
    const f = await fixture();
    await journal(f, [{ birth: 'owned-fixture-birth', executable: process.execPath }], [101]);
    let unavailable = true;
    const session = { identity: async () => {
      if (unavailable) throw Object.assign(new Error('private session failure'), { code: 'EACCES' });
      return { 101: null };
    } } as unknown as WindowsPowerShellSession;
    const read = createWindowsProcessIdentityReader({ currentPid: 999, exists: () => true, session });
    vi.spyOn(processIdentityObserver, 'processIdentities').mockImplementation(read);
    const earlier = await reconcilePreparedNativeStop(f.config);
    expect(earlier.stopEvidence).toMatchObject({ observed: 'unknown', identityDiagnostics: { 101: 'PROBE_EACCES' } });
    unavailable = false;
    const latest = await reconcilePreparedNativeStop(f.config);
    expect(latest).toMatchObject({ outcome: 'none', stopEvidence: { observed: 'absent' } });
    expect(latest.stopEvidence).not.toHaveProperty('identityDiagnostics');
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'not-started', stopEvidence: latest.stopEvidence });
    expect(earlier.stopEvidence.identityDiagnostics).toEqual({ 101: 'PROBE_EACCES' });
  });
  it('retains correlated stop diagnostics on the provider error path without changing its error or outcome', async () => {
    const f = await fixture();
    await journal(f, [{ birth: 'owned-fixture-birth', executable: process.execPath }], [101]);
    const session = { identity: async () => { throw Object.assign(new Error('private session failure'), { code: 'EPIPE' }); } } as unknown as WindowsPowerShellSession;
    const read = createWindowsProcessIdentityReader({ currentPid: 999, exists: () => true, session });
    vi.spyOn(processIdentityObserver, 'processIdentities').mockImplementation(read);
    vi.spyOn(GotzjiNativeAdapter.prototype, 'execute').mockRejectedValue(new GotzjiNativeError('SYNTHETIC_PROVIDER_STOPPED', undefined, 'unknown'));
    await expect(executePreparedNativeOperation(f.config, undefined, { verifyLiveAuthority: () => true })).rejects.toMatchObject({
      code: 'SYNTHETIC_PROVIDER_STOPPED', outcome: 'unknown', stopEvidence: { observed: 'unknown', identityDiagnostics: { 101: 'PROBE_EPIPE' } } });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', code: 'SYNTHETIC_PROVIDER_STOPPED', outcome: 'unknown',
      stopEvidence: { observed: 'unknown', identityDiagnostics: { 101: 'PROBE_EPIPE' } } });
  });
  it('signs a recoverable pre-dispatch no-launch proof when adapter admission refuses before the runner', async () => {
    const f = await fixture(); await writeFile(f.prepared.native.scriptPath, 'changed before adapter admission');
    await expect(executePreparedNativeOperation(f.config, undefined, { verifyLiveAuthority: () => true })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_CHANGED', outcome: 'none' });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'not-started', outcome: 'none', dispatch: 'pre-dispatch', stopEvidence: { observed: 'pre-dispatch', verifier: 'host-signed-pre-dispatch-v1' } });
    await expect(reconcilePreparedNativeStop(f.config)).resolves.toMatchObject({ outcome: 'none', stopEvidence: { observed: 'pre-dispatch' }, effectEvidence: { source: 'unchanged', output: 'absent' } });
  });
  it.runIf(process.platform === 'win32')('keeps a missing identity journal unknown after the trusted dispatch boundary', async () => {
    const provider = `$null=[Console]::In.ReadToEnd();[Console]::Write('{"ok":false,"error":{"code":"SYNTHETIC_DISPATCH_FAILURE","outcome":"none"}}')`;
    const f = await fixture('claude', provider);
    await expect(executePreparedNativeOperation(f.config, undefined, { verifyLiveAuthority: () => true })).rejects.toMatchObject({ code: 'SYNTHETIC_DISPATCH_FAILURE', outcome: 'unknown' });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown', dispatch: 'dispatched', stopEvidence: { observed: 'unknown', reason: 'missing' } });
  });
  it.runIf(process.platform === 'win32').each(['word-identity-window-zero', 'word-identity-window-multiple'])('retains %s in the signed state without treating a missing identity as stopped', async (field) => {
    const provider = `$null=[Console]::In.ReadToEnd();[Console]::Write('{"ok":false,"error":{"code":"NATIVE_SESSION_IDENTITY_UNVERIFIED","field":"${field}","outcome":"unknown"}}')`;
    const f = await fixture('claude', provider);
    await expect(executePreparedNativeOperation(f.config, undefined, { verifyLiveAuthority: () => true })).rejects.toMatchObject({ code: 'NATIVE_SESSION_IDENTITY_UNVERIFIED', outcome: 'unknown' });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown', field, stopEvidence: { observed: 'unknown', reason: 'missing' } });
    await reconcilePreparedNativeStop(f.config);
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown', field, stopEvidence: { observed: 'unknown', reason: 'missing' } });
  });
  it.runIf(process.platform === 'win32')('signs no-launch only for a first helper attempt confirmed absent by the runner', async () => {
    const f = await fixture(); const originalRoot = process.env.SystemRoot;
    try {
      process.env.SystemRoot = 'Z:\\gotzji-missing-system-root';
      await expect(executePreparedNativeOperation(f.config, undefined, { verifyLiveAuthority: () => true })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_START_FAILED', outcome: 'none' });
      expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'not-started', outcome: 'none', dispatch: 'pre-dispatch', dispatchAttempt: 0,
        stopEvidence: { observed: 'pre-dispatch', verifier: 'host-signed-pre-dispatch-v1', reason: 'host-confirmed-first-spawn-no-launch', identityCount: 0, identityDigest: null } });
    } finally { if (originalRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalRoot; }
  });
  for (const changed of ['source', 'output'] as const) {
    it.runIf(process.platform === 'win32')(`keeps confirmed first-attempt no-launch separate from ${changed} drift`, async () => {
      const f = await fixture(); const originalRoot = process.env.SystemRoot; let checks = 0;
      try {
        process.env.SystemRoot = 'Z:\\gotzji-missing-system-root';
        await expect(executePreparedNativeOperation(f.config, undefined, { verifyLiveAuthority: async () => {
          checks += 1; if (checks === 2) await writeFile(changed === 'source' ? f.source : f.output, 'independent owner bytes'); return true;
        } })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_START_FAILED', outcome: 'unknown' });
        expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown', dispatch: 'pre-dispatch', dispatchAttempt: 0,
          stopEvidence: { observed: 'pre-dispatch', verifier: 'host-signed-pre-dispatch-v1', reason: 'host-confirmed-first-spawn-no-launch', identityCount: 0, identityDigest: null },
          effectEvidence: { [changed]: changed === 'source' ? 'changed' : 'present' } });
      } finally { if (originalRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalRoot; }
    });
  }
  it('keeps missing or invalid provider identity unknown', async () => {
    const f = await fixture();
    await expect(reconcilePreparedNativeStop(f.config)).resolves.toMatchObject({ outcome: 'unknown', stopEvidence: { observed: 'unknown', reason: 'missing' } });
    await writeFile(evidenceBinding(f).journal, `${JSON.stringify({ body: '{}', mac: '0'.repeat(64) })}\n`);
    await expect(reconcilePreparedNativeStop(f.config)).resolves.toMatchObject({ outcome: 'unknown', stopEvidence: { observed: 'unknown', reason: 'mac' } });
    const binding = evidenceBinding(f); const own = (await processIdentities([process.pid]))[process.pid] as ProcessIdentity;
    const wrongProvider = JSON.stringify({ schemaVersion: 1, recordType: 'identity', jobId: f.config.jobId, epoch: f.config.epoch, generation: f.config.generation, planDigest: f.prepared.native.planDigest, invocationId: randomUUID(), provider: 'cad-session', pid: process.pid, birth: own.birth, executable: own.executable, recordedAt: new Date().toISOString() });
    const mac = createHmac('sha256', Buffer.from(binding.key, 'hex')).update(wrongProvider).digest('hex');
    await writeFile(binding.journal, `${JSON.stringify({ body: wrongProvider, mac })}\n`);
    await expect(reconcilePreparedNativeStop(f.config)).resolves.toMatchObject({ outcome: 'unknown', stopEvidence: { observed: 'unknown', reason: 'binding' } });
  });
  it.runIf(process.platform !== 'win32')('preserves mixed-case POSIX executable identity when proving a live child', async () => {
    const f = await fixture(); const mixedDirectory = path.join(f.root, 'MixedCaseBin'); const executable = path.join(mixedDirectory, 'NodeFixture');
    await mkdir(mixedDirectory); await copyFile(process.execPath, executable); await chmod(executable, 0o755);
    const owned = await ownedNode(executable); expect(owned.identity!.executable).toContain('MixedCaseBin');
    await journal(f, [owned.identity!], [owned.child.pid!]);
    await expect(reconcilePreparedNativeStop(f.config)).resolves.toMatchObject({ outcome: 'unknown', stopEvidence: { observed: 'alive', identityCount: 1 } });
    await stop(owned); children.splice(children.indexOf(owned), 1);
  }, 20_000);
  it.runIf(process.platform === 'win32')('rejects a hard-linked journal snapshot without changing its outside owner bytes', async () => {
    const f = await fixture(); const outside = path.join(f.root, 'owner-evidence.txt'); const binding = evidenceBinding(f);
    await writeFile(outside, 'outside owner evidence must remain exact'); await link(outside, binding.journal);
    await expect(reconcilePreparedNativeStop(f.config)).resolves.toMatchObject({ outcome: 'unknown', stopEvidence: { observed: 'unknown', reason: 'invalid-file' } });
    expect(await readFile(outside, 'utf8')).toBe('outside owner evidence must remain exact'); expect(await readFile(binding.journal, 'utf8')).toBe('outside owner evidence must remain exact');
  });
  it('requires every invocation identity absent, then preserves termination proof separately from file-effect proof', async () => {
    const f = await fixture(); const first = await ownedNode(); const second = await ownedNode();
    await journal(f, [first.identity!, second.identity!], [first.child.pid!, second.child.pid!]); await stop(first); children.splice(children.indexOf(first), 1);
    await expect(reconcilePreparedNativeStop(f.config)).resolves.toMatchObject({ outcome: 'unknown', stopEvidence: { observed: 'alive', identityCount: 2 }, effectEvidence: { source: 'unchanged', output: 'absent' } });
    await stop(second); children.splice(children.indexOf(second), 1);
    await expect(reconcilePreparedNativeStop(f.config)).resolves.toMatchObject({ outcome: 'none', stopEvidence: { observed: 'absent', identityCount: 2 }, effectEvidence: { source: 'unchanged', output: 'absent' } });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'not-started', outcome: 'none', stopEvidence: { observed: 'absent' } });
    await writeFile(f.output, 'owner bytes after stop');
    await expect(reconcilePreparedNativeStop(f.config)).resolves.toMatchObject({ outcome: 'unknown', stopEvidence: { observed: 'absent' }, effectEvidence: { output: 'present' } });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown', stopEvidence: { observed: 'absent' } });
  }, 20_000);
  it('re-reads file effects after a live identity exits and treats an exact PID identity mismatch as absent', async () => {
    const deadline = performance.now() + 20_000;
    const racing = await fixture();
    // Preserve this exact fixture until both the child and its reconciliation are proved settled.
    roots.splice(roots.indexOf(racing.root), 1);
    let owned: OwnedChild | undefined;
    let pending: ReturnType<typeof reconcilePreparedNativeStop> | undefined;
    let releaseLive = (): void => {};
    let restoreObserver = (): void => {};
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const child = await ownedNode(); owned = child;
      await journal(racing, [child.identity!], [child.child.pid!]);
      const pid = child.child.pid!;
      const readActual = processIdentityObserver.processIdentities;
      let initialObservation: Record<string, unknown> | undefined;
      let reported = false;
      let reportFirst!: (matching: boolean) => void;
      const liveDelivery = new Promise<void>((resolve) => { releaseLive = resolve; });
      const firstProbe = new Promise<boolean>((resolve) => { reportFirst = resolve; });
      const diagnostic = (): string => JSON.stringify({ initialObservation, exitCode: child.child.exitCode, signalCode: child.child.signalCode, outputExistsNow: existsSync(racing.output) });
      const observer = vi.spyOn(processIdentityObserver, 'processIdentities').mockImplementation(async (values) => {
        const observed = await readActual(values);
        if (reported || values.length !== 1 || values[0] !== pid) return observed;
        reported = true;
        const actual = observed[pid], matching = sameProcessIdentity(child.identity, actual);
        initialObservation = { at: performance.now(), pid, expected: child.identity, actual: actual === undefined ? 'missing-key' : actual,
          exitCode: child.child.exitCode, signalCode: child.child.signalCode, output: racing.output,
          preparedOutput: 'outputPath' in racing.prepared.native.input ? racing.prepared.native.input.outputPath : null, outputExists: existsSync(racing.output) };
        reportFirst(matching);
        if (matching) await liveDelivery;
        return observed;
      });
      restoreObserver = (): void => { observer.mockRestore(); };
      const reconciliation = reconcilePreparedNativeStop(racing.config); pending = reconciliation;
      void reconciliation.catch(() => undefined);
      const firstMatching = await Promise.race([firstProbe, reconciliation.then((result) => {
        throw new Error(`Reconciliation completed before the actual live boundary: ${JSON.stringify(result)}; ${diagnostic()}`);
      }), new Promise<never>((_resolve, reject) => {
        observationTimer = setTimeout(() => reject(new Error(`Actual live boundary unproved: ${diagnostic()}`)), Math.max(1, deadline - performance.now() - 500));
      })]);
      if (observationTimer) clearTimeout(observationTimer);
      expect(firstMatching, diagnostic()).toBe(true);
      expect(initialObservation?.outputExists, diagnostic()).toBe(false);
      await writeFile(racing.output, 'late provider effect');
      await stop(child);
      releaseLive();
      await expect(reconciliation).resolves.toMatchObject({ outcome: 'unknown', stopEvidence: { observed: 'absent' }, effectEvidence: { source: 'unchanged', output: 'present' } });
    } catch (error) { failure = { error }; }
    releaseLive(); restoreObserver(); if (observationTimer) clearTimeout(observationTimer);
    try {
      const cleanup = (async (): Promise<void> => {
        if (owned) { await stop(owned); const index = children.indexOf(owned); if (index >= 0) children.splice(index, 1); }
        if (pending) await pending.catch(() => undefined);
      })();
      await Promise.race([cleanup, new Promise<never>((_resolve, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error(`Owned native observation cleanup unproved; retained root: ${racing.root}`)), Math.max(1, deadline - performance.now() - 250));
      })]);
    } catch (error) {
      if (failure) throw new AggregateError([failure.error, error], 'Owned native observation failed and cleanup is unproved');
      throw error;
    } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
    if (failure) throw failure.error;
    roots.push(racing.root);

    const mismatch = await fixture(); const own = (await processIdentities([process.pid]))[process.pid];
    if (!own || own === 'unknown') throw new Error('Current process identity unavailable');
    await journal(mismatch, [{ ...own, birth: `${own.birth}-different` }], [process.pid]);
    await expect(reconcilePreparedNativeStop(mismatch.config)).resolves.toMatchObject({ outcome: 'none', stopEvidence: { observed: 'absent' }, effectEvidence: { source: 'unchanged', output: 'absent' } });
  }, 20_000);
  it('preserves signed synthetic process absence while re-reading changed file effects', async () => {
    const f = await fixture('test-driver');
    const runner = async (): Promise<never> => { await writeFile(f.output, 'synthetic provider output'); throw new GotzjiNativeError('SYNTHETIC_PROVIDER_STOPPED', undefined, 'none'); };
    await expect(executePreparedNativeOperation(f.config, undefined, { testRunner: runner })).rejects.toMatchObject({ code: 'SYNTHETIC_PROVIDER_STOPPED', outcome: 'unknown' });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown', stopEvidence: { observed: 'absent' }, effectEvidence: { output: 'present' } });
    await expect(reconcilePreparedNativeStop(f.config)).resolves.toMatchObject({ outcome: 'unknown', stopEvidence: { observed: 'absent' }, effectEvidence: { source: 'unchanged', output: 'present' } });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown', stopEvidence: { observed: 'absent' } });
  });
});
