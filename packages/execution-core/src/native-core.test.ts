import { mkdir, writeFile, readFile, rm, rmdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { hash, type WorkerRow } from './store.js';
import { callWorker, stopWorker, signed, observeWorker } from './managed-worker.js';
import { processIdentities, sameProcessIdentity } from './process-identity.mjs';
import type { ProductNativeInput } from './product-native.js';
import type { TaskBinding } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

interface Fixture { root: string; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
let stopCheck: { closing: boolean; pending: Set<Promise<unknown>>; restore?: (() => void) | undefined } | undefined;
function checkStopOpen(): void { if (stopCheck?.closing) throw new Error('Stop check is closing; retained fixture'); }
function trackStopCheck<T>(promise: Promise<T>): Promise<T> {
  const check = stopCheck;
  check?.pending.add(promise);
  void promise.then(() => check?.pending.delete(promise), () => check?.pending.delete(promise));
  return promise;
}
async function drainStopCheck(): Promise<void> {
  const check = stopCheck;
  if (!check) return;
  check.closing = true; check.restore?.(); check.restore = undefined;
  if (!check.pending.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const drained = await Promise.race([Promise.allSettled([...check.pending]).then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), process.env.CI ? 15000 : 5000); })]);
    if (!drained) throw new Error('Stop check still pending; Core and fixture retained');
  } finally { if (timer) clearTimeout(timer); }
}
async function fixture(cancelOutcome?: 'none' | 'unknown', direct = false): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-native-core-');
  const libraryRoot = path.join(root, 'library'); await mkdir(path.join(libraryRoot, 'references'), { recursive: true });
  for (const file of ['CLAUDE.md','AGENTS.md','KNOWLEDGE_INDEX.md','references/agent-knowledge-workflow.md']) await writeFile(path.join(libraryRoot, file), 'Explicit no-model core fixture policy\n');
  const scriptPath = path.join(root, 'fixture-provider.ps1'); await writeFile(scriptPath, 'test-only provider; never execute as PowerShell');
  const runner = path.join(root, 'test-native-runner.mjs');
  await writeFile(runner, `import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';const hash=x=>createHash('sha256').update(x).digest('hex');export async function testRunner(_script,input){await new Promise(resolve=>setTimeout(resolve,400));if(input.range==='Z1')throw Object.assign(new Error('NATIVE_TERMINATION_UNVERIFIED'),{code:'NATIVE_TERMINATION_UNVERIFIED',outcome:'unknown'});let outputSha256=null;if(input.outputPath){writeFileSync(input.outputPath,'preserved-fixture-output');outputSha256=hash(readFileSync(input.outputPath));}return{operation:input.operation,provider:input.operation.split('.')[0],providerVersion:'explicit-no-model-fixture',nativePid:process.pid,sourceSha256:hash(readFileSync(input.filePath)),outputSha256,originalPreserved:true,savedAndReopened:!!input.outputPath,unrelatedPreserved:true,verified:true,before:input.operation==='excel.sheets.inspect'?{sheets:[{name:'ข้อมูล',used_range:'B2:D4',rows:3,columns:3}],total:1,returned:1,truncated:false}:{fixture:'original'},after:input.operation==='excel.sheets.inspect'?{sheets:[{name:'ข้อมูล',used_range:'B2:D4',rows:3,columns:3}],total:1,returned:1,truncated:false}:{fixture:'changed'}};}`);
  if (cancelOutcome) {
    await writeFile(runner, `import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';const hash=x=>createHash('sha256').update(x).digest('hex');export async function testRunner(_script,input,signal){if(input.range==='C1'){writeFileSync(${JSON.stringify(path.join(root, 'native-started'))},'started');await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});throw Object.assign(new Error('NATIVE_CANCELLED'),{code:'NATIVE_CANCELLED',outcome:${JSON.stringify(cancelOutcome)}});}return{operation:input.operation,provider:'excel',providerVersion:'explicit-no-model-fixture',nativePid:process.pid,sourceSha256:hash(readFileSync(input.filePath)),outputSha256:null,originalPreserved:true,savedAndReopened:false,unrelatedPreserved:true,verified:true,before:{},after:{}};}`);
  }
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: direct ? { mode: 'host-direct', libraryRoot, testOnlyProviders: true } : { executable: process.execPath, libraryRoot, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) }, nativeOptions: { scriptPath, scriptSha256: hash(await readFile(scriptPath)), testRunnerModule: runner, operations: ['excel.sheets.inspect','excel.range.read','excel.range.write'] } });
  const credential = core.enrollAdapter('native-fixture', 'owner');
  for (const projectId of ['one','two']) { const project = path.join(root, projectId); await mkdir(project); await writeFile(path.join(project, 'source.xlsx'), 'original fixture bytes'); await writeFile(path.join(project, 'AGENTS.md'), 'Actual selected project native rule\n'); core.registerProject(credential, { projectId, displayName: projectId, rootPath: project }); }
  const f = { root, core, credential }; fixtures.push(f); return f;
}
async function job(f: Fixture, input: ProductNativeInput): Promise<TaskBinding> {
  const prep = await f.core.prepareOperation(f.credential, input); const result = await f.core.submit(f.credential, prep.preparationId); return f.core.select(f.credential, result.jobId);
}
async function until(f: Fixture, check: () => Promise<boolean>): Promise<void> {
  for (let count = 0; count < 150; count++) { try { await f.core.tick(); } catch { /* inspect the independently projected state */ } if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error(JSON.stringify(await f.core.list(f.credential)));
}
afterEach(async () => {
  // A timed-out check cannot close SQLite underneath its outstanding public call.
  await drainStopCheck();
  for (const f of fixtures.splice(0)) {
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 }); const workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; db.close();
    for (const worker of workers) {
      if (await stopWorker(worker)) continue;
      // The synthetic runner never starts a native application. For this
      // injected uncertain case only, tear down our authenticated Node root
      // after matching its real OS birth/executable; never kill stale children.
      const config = JSON.parse(await readFile(path.join(worker.directory, 'config.json'), 'utf8'));
      if (!(config.grace.mode === 'test-driver' || (config.grace.mode === 'host-direct' && config.grace.testOnlyProviders === true)) || !config.nativeTestRunner) throw new Error('Unexpected production fixture');
      const observed = await callWorker(worker, 'status'); const ready = signed<{ identity: { birth: string; executable: string } }>(worker, 'ready.json');
      if (!sameProcessIdentity(ready?.identity, (await processIdentities([observed.pid]))[observed.pid])) throw new Error('Fixture root identity changed');
      if (stopCheck) process.stderr.write(`[native-stop-refusal-cleanup] ${JSON.stringify({ stage: 'identity-proved', pid: observed.pid, identity: ready?.identity })}\n`);
      process.kill(observed.pid);
      let absent = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await observeWorker(worker) === 'absent') { absent = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!absent) { f.core.close(); throw new Error(`Synthetic worker absence unproved; retained ${f.root}`); }
      if (stopCheck) process.stderr.write('[native-stop-refusal-cleanup] {"stage":"worker-absent"}\n');
    }
    f.core.close();
    const root = path.resolve(f.root);
    if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('gotzji-native-core-')) throw new Error('Native cleanup scope denied');
    await rm(root, { recursive: true, force: true });
    if (stopCheck) process.stderr.write('[native-stop-refusal-cleanup] {"stage":"core-closed-root-removed"}\n');
  }
  stopCheck = undefined;
});
describe('native operations through Grace and the shared Goal (explicit no-model runner)', () => {
  it('settles a typed stop refusal before the next event turn without a stop receipt', async () => {
    stopCheck = { closing: false, pending: new Set() };
    try {
      const f = await trackStopCheck(fixture('unknown')); checkStopOpen();
      const first = await trackStopCheck(job(f, { requestId: 'stop-refusal', projectId: 'one', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'C1' })); checkStopOpen();
      await trackStopCheck(f.core.resume(f.credential, first)); checkStopOpen();
      await trackStopCheck(until(f, async () => { try { return await readFile(path.join(f.root, 'native-started'), 'utf8') === 'started'; } catch { return false; } })); checkStopOpen();
      const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
      let worker: WorkerRow;
      try { worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(first.jobId) as unknown as WorkerRow; } finally { db.close(); }
      const ready = signed<{ port: number }>(worker, 'ready.json');
      expect(ready).toBeDefined(); expect(signed(worker, 'stopped.json')).toBeUndefined();
      const originalFetch = globalThis.fetch;
      let settled = false, observed = false;
      let checkpoint!: (value: { settled: boolean; status: number }) => void;
      const delivered = new Promise<{ settled: boolean; status: number }>((resolve) => { checkpoint = resolve; });
      stopCheck.restore = (): void => { globalThis.fetch = originalFetch; };
      globalThis.fetch = async (input, init): Promise<Response> => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        const response = await originalFetch(input, init);
        if (!observed && url.origin === `http://127.0.0.1:${ready?.port}` && url.pathname === '/cancel' && init?.method === 'POST') {
          observed = true;
          setImmediate(() => checkpoint({ settled, status: response.status }));
        }
        return response;
      };
      const stopping = trackStopCheck(stopWorker(worker));
      void stopping.then(() => { settled = true; }, () => { settled = true; });
      const atDelivery = await delivered; checkStopOpen();
      const result = await stopping; checkStopOpen();
      stopCheck.restore(); stopCheck.restore = undefined;
      const progress = signed<{ state: string; outcome: string }>(worker, 'native-progress.json');
      process.stderr.write(`[native-stop-refusal-checkpoint] ${JSON.stringify({ ...atDelivery, result, stoppedPresent: !!signed(worker, 'stopped.json'), progress })}\n`);
      expect(result).toBe(false);
      expect(signed(worker, 'stopped.json')).toBeUndefined();
      expect(progress).toMatchObject({ state: 'uncertain', outcome: 'unknown' });
      expect(await trackStopCheck(observeWorker(worker))).toBe('running');
      expect(atDelivery.status).toBe(409);
      expect(atDelivery.settled).toBe(true);
    } finally { await drainStopCheck(); }
  }, 20000);
  it('retries cancellation after a refused stop-receipt write without restarting native work', async () => {
    const f = await fixture('none');
    const first = await job(f, { requestId: 'cancel-retry', projectId: 'one', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'C1' });
    await f.core.resume(f.credential, first);
    await until(f, async () => { try { return await readFile(path.join(f.root, 'native-started'), 'utf8') === 'started'; } catch { return false; } });
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(first.jobId) as unknown as WorkerRow; db.close();
    const stopped = path.join(worker.directory, 'stopped.json');
    const relative = path.relative(f.root, path.resolve(stopped));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Retry fixture cleanup scope denied');
    await mkdir(stopped);
    try {
      await expect(f.core.cancel(f.credential, first)).rejects.toMatchObject({ code: 'EISDIR' });
      expect(await observeWorker(worker)).toBe('running');
    } finally { await rmdir(stopped); }
    expect(await f.core.cancel(f.credential, first)).toMatchObject({ status: 'cancelled' });
    expect(await observeWorker(worker)).toBe('absent');
    expect(signed(worker, 'stopped.json')).toMatchObject({ state: 'cancelled' });
  }, 20000);
  it.runIf(process.platform === 'win32')('cancels a prepared native source with a Windows case alias', async () => {
    const f = await fixture('none');
    const first = await job(f, { requestId: 'cancel-case', projectId: 'one', operation: 'excel.range.read', path: 'SOURCE.XLSX', sheet: 'Sheet1', range: 'C1' });
    await f.core.resume(f.credential, first);
    await until(f, async () => { try { return await readFile(path.join(f.root, 'native-started'), 'utf8') === 'started'; } catch { return false; } });
    expect(await f.core.cancel(f.credential, first)).toMatchObject({ status: 'cancelled' });
  }, 20000);
  it('reverifies completed native output before a racing cancel releases its claims', async () => {
    const f = await fixture();
    const first = await job(f, { requestId: 'completed-tamper', projectId: 'one', operation: 'excel.range.write', path: 'source.xlsx', outputPath: 'output.xlsx', sheet: 'Sheet1', range: 'A1', values: [['new']] });
    await f.core.resume(f.credential, first);
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(first.jobId) as unknown as WorkerRow; db.close();
    let completed = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (signed<{ state: string }>(worker, 'native-progress.json')?.state === 'completed') { completed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(completed).toBe(true);
    await writeFile(path.join(f.root, 'one', 'output.xlsx'), 'independent owner output');
    await expect(f.core.cancel(f.credential, first)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_CHANGED' });
    const check = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    expect(Number(check.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims WHERE job_id=?').get(first.jobId)?.count)).toBeGreaterThan(0); check.close();
  }, 20000);
  it('awaits native abort proof, permits repeated cancel and frees UI for the next project', async () => {
    const f = await fixture('none');
    const first = await job(f, { requestId: 'cancel-proved', projectId: 'one', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'C1' });
    await f.core.resume(f.credential, first);
    await until(f, async () => { try { return await readFile(path.join(f.root, 'native-started'), 'utf8') === 'started'; } catch { return false; } });
    expect(await f.core.cancel(f.credential, first)).toMatchObject({ status: 'cancelled' });
    expect(await f.core.cancel(f.credential, first)).toMatchObject({ status: 'cancelled' });
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims WHERE job_id=?').get(first.jobId)?.count).toBe(0); db.close();
    const next = await job(f, { requestId: 'after-cancel', projectId: 'two', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'A1' });
    expect(await f.core.resume(f.credential, next)).not.toHaveProperty('waitingReason');
    await until(f, async () => (await f.core.get(f.credential, next)).status === 'completed');
  }, 20000);
  it('keeps native UI claims when repeated cancel still has an unknown outcome', async () => {
    const f = await fixture('unknown');
    const first = await job(f, { requestId: 'cancel-unknown', projectId: 'one', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'C1' });
    await f.core.resume(f.credential, first);
    await until(f, async () => { try { return await readFile(path.join(f.root, 'native-started'), 'utf8') === 'started'; } catch { return false; } });
    await expect(f.core.cancel(f.credential, first)).rejects.toMatchObject({ code: 'CLEANUP_RECONCILIATION_REQUIRED' });
    await expect(f.core.cancel(f.credential, first)).rejects.toMatchObject({ code: 'CLEANUP_RECONCILIATION_REQUIRED' });
    const next = await job(f, { requestId: 'after-unknown', projectId: 'two', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'A1' });
    expect(await f.core.resume(f.credential, next)).toMatchObject({ waitingReason: 'RESOURCE_HELD', blockingJob: first.jobId });
  }, 20000);
  for (const changed of ['source', 'output'] as const) {
    it(`stops a signed pre-dispatch refusal with changed ${changed} bytes for owner settlement only`, async () => {
      const started = performance.now(); let phase = 'fixture'; let failure: unknown;
      const stages: Record<string, number> = {}; let last = started;
      const mark = (next: string): void => { const now = performance.now(); stages[phase] = Math.round((now - last) * 100) / 100; last = now; phase = next; };
      try {
        const f = await fixture();
        const first = await job(f, { requestId: `pre-dispatch-${changed}`, projectId: 'one', operation: 'excel.range.write', path: 'source.xlsx', outputPath: 'output.xlsx', sheet: 'Sheet1', range: 'Z1', values: [['new']] });
        mark('resume'); await f.core.resume(f.credential, first);
        // This consumer setup has already ended. Failed-cancel retries are covered separately.
        mark('awaitBlocked'); await until(f, async () => (await f.core.get(f.credential, first)).status === 'blocked');
        mark('injectHostProof');
        const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
        const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(first.jobId) as unknown as WorkerRow; db.close();
        const config = JSON.parse(await readFile(path.join(worker.directory, 'config.json'), 'utf8')) as { effectRoot: string };
        const filename = path.join(config.effectRoot, 'native-operation.json');
        const envelope = JSON.parse(await readFile(filename, 'utf8')) as { body: string };
        // Consumer fixture: the synthetic Node runner created no native app. The broker's production producer is
        // checked independently; here the host-signed tuple reaches the actual worker/Core cancellation boundary.
        const state = JSON.parse(envelope.body) as Record<string, unknown>;
        state.dispatch = 'pre-dispatch'; state.dispatchAttempt = 0; state.state = 'uncertain'; state.outcome = 'unknown';
        state.stopEvidence = { schemaVersion: 1, observed: 'pre-dispatch', identityCount: 0, identityDigest: null, verifier: 'host-signed-pre-dispatch-v1' };
        const body = JSON.stringify(state);
        await writeFile(filename, JSON.stringify({ body, mac: createHmac('sha256', worker.token).update(body).digest('hex') }));
        expect(JSON.parse((JSON.parse(await readFile(filename, 'utf8')) as { body: string }).body)).toMatchObject({ dispatch: 'pre-dispatch', dispatchAttempt: 0,
          stopEvidence: { schemaVersion: 1, observed: 'pre-dispatch', identityCount: 0, identityDigest: null, verifier: 'host-signed-pre-dispatch-v1' } });
        const target = path.join(f.root, 'one', changed === 'source' ? 'source.xlsx' : 'output.xlsx');
        await writeFile(target, 'independent owner bytes');
        mark('cancelWithProof'); await expect(f.core.cancel(f.credential, first)).rejects.toMatchObject({ code: changed === 'source' ? 'NATIVE_ORIGINAL_CHANGED' : 'NATIVE_EFFECT_RECONCILIATION_REQUIRED' });
        mark('proveWorkerAbsent'); expect(await observeWorker(worker)).toBe('absent');
        expect((await f.core.get(f.credential, first)).settleDecisions).toContain('effect-present');
        const held = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
        try { expect(Number(held.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims WHERE job_id=?').get(first.jobId)?.count)).toBeGreaterThan(0); } finally { held.close(); }
        mark('ownerSettle'); expect(await f.core.settleBlockedJob(f.credential, first, 'effect-present')).toMatchObject({ status: 'cancelled' });
        const released = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
        try { expect(Number(released.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims WHERE job_id=?').get(first.jobId)?.count)).toBe(0); } finally { released.close(); }
        expect(await readFile(target, 'utf8')).toBe('independent owner bytes');
        await expect(f.core.readOperationResult(f.credential, first)).rejects.toMatchObject({ code: 'RESULT_NOT_VERIFIED' });
        mark('nextProject'); const next = await job(f, { requestId: `after-pre-dispatch-${changed}`, projectId: 'two', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'A1' });
        expect(await f.core.resume(f.credential, next)).not.toHaveProperty('waitingReason');
        await until(f, async () => (await f.core.get(f.credential, next)).status === 'completed');
        mark('done');
      } catch (error) { failure = error; throw error; }
      finally {
        const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
        if (elapsedMs > 10_000 || failure !== undefined) process.stderr.write(`[native-pre-dispatch-timing] ${JSON.stringify({ changed, phase, elapsedMs, stages, failure: failure instanceof Error ? failure.name : failure === undefined ? null : typeof failure })}\n`);
      }
    }, 20000);
    it(`retains cancelled native claims when its no-effect result conflicts with ${changed} bytes`, async () => {
      const f = await fixture('none');
      const first = await job(f, { requestId: `cancel-${changed}`, projectId: 'one', operation: 'excel.range.write', path: 'source.xlsx', outputPath: 'output.xlsx', sheet: 'Sheet1', range: 'C1', values: [['new']] });
      await f.core.resume(f.credential, first);
      await until(f, async () => { try { return await readFile(path.join(f.root, 'native-started'), 'utf8') === 'started'; } catch { return false; } });
      const target = path.join(f.root, 'one', changed === 'source' ? 'source.xlsx' : 'output.xlsx');
      await writeFile(target, 'independent owner bytes');
      await expect(f.core.cancel(f.credential, first)).rejects.toMatchObject({ code: changed === 'source' ? 'NATIVE_ORIGINAL_CHANGED' : 'NATIVE_EFFECT_RECONCILIATION_REQUIRED' });
      expect(await readFile(target, 'utf8')).toBe('independent owner bytes');
      const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
      expect(Number(db.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims WHERE job_id=?').get(first.jobId)?.count)).toBeGreaterThan(0); db.close();
      expect((await f.core.get(f.credential, first)).settleDecisions).toContain('effect-present');
      expect(await f.core.settleBlockedJob(f.credential, first, 'effect-present')).toMatchObject({ status: 'cancelled' });
      await expect(f.core.readOperationResult(f.credential, first)).rejects.toMatchObject({ code: 'RESULT_NOT_VERIFIED' });
      const next = await job(f, { requestId: `after-settle-${changed}`, projectId: 'two', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'A1' });
      expect(await f.core.resume(f.credential, next)).not.toHaveProperty('waitingReason');
      await until(f, async () => (await f.core.get(f.credential, next)).status === 'completed');
    }, 20000);
  }
  it('discovers Excel sheets through the durable native job and retrieves the same metadata after reopen and replay', async () => {
    const f = await fixture(undefined, true);
    const input: ProductNativeInput = { requestId: 'native-sheets', projectId: 'one', operation: 'excel.sheets.inspect', path: 'source.xlsx' };
    const prepared = await f.core.prepareOperation(f.credential, input);
    const admitted = await f.core.submit(f.credential, prepared.preparationId); const binding = f.core.select(f.credential, admitted.jobId);
    await f.core.resume(f.credential, binding);
    await until(f, async () => (await f.core.get(f.credential, binding)).status === 'completed');
    const result = await f.core.readOperationResult(f.credential, binding);
    expect(result).toMatchObject({ operation: input.operation, projectId: 'one', output: { path: input.path, nativeReceipt: { savedAndReopened: false, outputSha256: null, originalPreserved: true, after: { sheets: [{ name: 'ข้อมูล', used_range: 'B2:D4', rows: 3, columns: 3 }], total: 1, returned: 1, truncated: false } } } });
    f.core.close();
    const scriptPath = path.join(f.root, 'fixture-provider.ps1');
    f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: { mode: 'host-direct', libraryRoot: path.join(f.root, 'library'), testOnlyProviders: true }, nativeOptions: { scriptPath, scriptSha256: hash(await readFile(scriptPath)), testRunnerModule: path.join(f.root, 'test-native-runner.mjs'), operations: ['excel.sheets.inspect', 'excel.range.read', 'excel.range.write'] } });
    expect(await f.core.readOperationResult(f.credential, binding)).toEqual(result);
    expect((await f.core.submit(f.credential, prepared.preparationId)).jobId).toBe(admitted.jobId);
    expect((await f.core.list(f.credential)).map((row) => row.jobId)).toEqual([admitted.jobId]);
    expect(await readFile(path.join(f.root, 'one', 'source.xlsx'), 'utf8')).toBe('original fixture bytes');
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()?.count).toBe(1); expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims').get()?.count).toBe(0); }
    finally { db.close(); }
  }, 20000);
  it.each([false, true])('seals a typed native operation, verifies original/output and replay (direct=%s)', async (direct) => {
    const f = await fixture(undefined, direct);
    const input: ProductNativeInput = { requestId: 'native-write', projectId: 'one', operation: 'excel.range.write', path: 'source.xlsx', outputPath: 'output.xlsx', sheet: 'Sheet1', range: 'A1', values: [['new']] };
    const binding = await job(f, input); await f.core.resume(f.credential, binding);
    await until(f, async () => (await f.core.get(f.credential, binding)).status === 'completed');
    expect(await readFile(path.join(f.root, 'one', 'source.xlsx'), 'utf8')).toBe('original fixture bytes');
    expect(await f.core.readOperationResult(f.credential, binding)).toMatchObject({ operation: 'excel.range.write', output: { nativeReceipt: { providerVersion: 'explicit-no-model-fixture', originalPreserved: true, savedAndReopened: true } } });
    const repeated = await f.core.prepareOperation(f.credential, input);
    expect((await f.core.submit(f.credential, repeated.preparationId)).jobId).toBe(binding.jobId);
    await expect(f.core.prepareOperation(f.credential, { ...input, values: [['different']] })).rejects.toMatchObject({ code: 'REQUEST_DIGEST_CONFLICT' });
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()?.count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims').get()?.count).toBe(0); db.close();
  }, 20000);
  it('holds global UI/document/provider locks atomically across independent projects', async () => {
    const f = await fixture(); const first = await job(f, { requestId: 'first', projectId: 'one', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'A1' });
    const second = await job(f, { requestId: 'second', projectId: 'two', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'A1' });
    await f.core.resume(f.credential, first);
    expect(await f.core.resume(f.credential, second)).toMatchObject({ status: 'queued', waitingReason: 'RESOURCE_HELD', blockingResource: 'globalui:windows', blockingJob: first.jobId });
    await until(f, async () => (await f.core.get(f.credential, second)).status === 'completed');
  }, 20000);
  it('queues behind a waiting native job only for the resource it waits on, so other projects keep the shared UI (incident I3)', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'one', 'job.mjs'), "import { existsSync } from 'node:fs';\nconsole.log('begin');\nconst t = setInterval(() => { console.log('progress'); if (existsSync(new URL('./release', import.meta.url))) { clearInterval(t); console.log('end'); } }, 50);\n");
    f.core.registerReviewedCommand(f.credential, { recipeId: 'hold', executable: process.execPath, args: ['${projectRoot}/job.mjs'], dependencies: ['${projectRoot}/job.mjs'], timeoutMs: 30000, writeScope: 'project' });
    f.core.bindProjectRecipe(f.credential, { projectId: 'one', recipeId: 'hold' });
    const hold = await job(f, { requestId: 'hold', projectId: 'one', operation: 'command.run', commandId: 'hold' } as unknown as ProductNativeInput);
    await f.core.resume(f.credential, hold);
    await until(f, async () => f.core.logs(f.credential, hold).text.includes('progress'));
    const waiting = await job(f, { requestId: 'native-one', projectId: 'one', operation: 'excel.range.write', path: 'source.xlsx', outputPath: 'output.xlsx', sheet: 'Sheet1', range: 'A1', values: [['one']] });
    expect(await f.core.resume(f.credential, waiting)).toMatchObject({ waitingReason: 'RESOURCE_HELD', blockingJob: hold.jobId });
    const other = await job(f, { requestId: 'native-two', projectId: 'two', operation: 'excel.range.write', path: 'source.xlsx', outputPath: 'output.xlsx', sheet: 'Sheet1', range: 'A1', values: [['two']] });
    expect(await f.core.resume(f.credential, other)).not.toHaveProperty('waitingReason');
    await until(f, async () => (await f.core.get(f.credential, other)).status === 'completed');
    await writeFile(path.join(f.root, 'one', 'release'), '');
    await until(f, async () => (await f.core.get(f.credential, waiting)).status === 'completed');
  }, 30000);
  it('retains every resource on uncertain native effects and refuses fabricated provider/script/grant arguments', async () => {
    const f = await fixture();
    await expect(f.core.prepareOperation(f.credential, { requestId: 'forged', projectId: 'one', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'A1', scriptPath: 'caller.ps1' } as never)).rejects.toMatchObject({ code: 'NATIVE_INPUT_INVALID' });
    const binding = await job(f, { requestId: 'uncertain', projectId: 'one', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'Z1' });
    await f.core.resume(f.credential, binding);
    await until(f, async () => (await f.core.get(f.credential, binding)).status === 'blocked');
    expect(await f.core.get(f.credential, binding)).toMatchObject({ blockerCode: 'NATIVE_TERMINATION_UNVERIFIED' });
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 }); expect(Number(db.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims WHERE job_id=?').get(binding.jobId)?.count)).toBeGreaterThanOrEqual(4); db.close();
  }, 20000);
});
