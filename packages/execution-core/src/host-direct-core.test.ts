import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { hash, type WorkerRow } from './store.js';
import { callWorker, observeWorker, signed, stopWorker } from './managed-worker.js';
import type { BasicProductOperationInput, TaskBinding } from './types.js';
import { productControlSchema, startProductHttp } from './product-http.js';
import { productBrokerCall } from './product-broker.mjs';
import { runHostDirect } from './host-direct-runtime.mjs';

interface Fixture { root: string; state: string; project: string; policy: string; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
async function fixture(legacy = false, library = false): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-direct-core-'); const state = path.join(root, 'state');
  const policy = path.join(root, 'policy'); const project = path.join(root, 'project');
  ensureProductControlDocuments(policy); await mkdir(project); await writeFile(path.join(project, 'note.txt'), 'before\n');
  const core = await ExecutionCore.open(state, { product: legacy ? { executable: process.execPath, libraryRoot: policy, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) } : { mode: 'host-direct', libraryRoot: policy }, libraryOptions: { pythonExecutable: process.execPath, pythonSha256: hash(await readFile(process.execPath)) } });
  const credential = core.enrollAdapter('fixture', 'owner'); core.registerProject(credential, { projectId: 'project', displayName: 'Synthetic', rootPath: project, ...(library ? { kind: 'library' as const } : {}) });
  if (library) core.enrollLibraryRoute(credential, { projectId: 'project', route: 'gotzji-library' });
  const value = { root, state, project, policy, core, credential }; fixtures.push(value); return value;
}
function workers(f: Fixture): WorkerRow[] { const db = new DatabaseSync(path.join(f.state, 'core.sqlite'), { readOnly: true }); try { return db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; } finally { db.close(); } }
async function admitted(f: Fixture, input: BasicProductOperationInput): Promise<TaskBinding> { const prep = f.core.prepareOperation(f.credential, input); const job = await f.core.submit(f.credential, prep.preparationId); return f.core.select(f.credential, job.jobId); }
async function completed(f: Fixture, binding: TaskBinding): Promise<void> { for (let n = 0; n < 150; n++) { await f.core.tick(); if ((await f.core.get(f.credential, binding)).status === 'completed') return; await new Promise((resolve) => setTimeout(resolve, 40)); } throw new Error(JSON.stringify(await f.core.get(f.credential, binding))); }
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const worker of workers(f)) { if (!await stopWorker(worker) || await observeWorker(worker) !== 'absent') { f.core.close(); throw new Error(`Owned fixture retained: ${f.root}`); } }
    f.core.close(); const target = path.resolve(f.root);
    if (path.dirname(target) !== await realpath(os.tmpdir()) || !path.basename(target).startsWith('gotzji-direct-core-')) throw new Error('FIXTURE_CLEANUP_SCOPE_DENIED');
    await rm(target, { recursive: true, force: true });
  }
});

describe('direct controller authority, cancellation and historical preservation', () => {
  it('refuses a stopped controller before its first broker call and before final receipt publication', async () => {
    const f = await fixture(); const binding = await admitted(f, { requestId: 'controller-stop', projectId: 'project', operation: 'file.read', path: 'note.txt' }); await f.core.resume(f.credential, binding);
    const worker = workers(f)[0]!;
    for (let n = 0; n < 100 && !existsSync(path.join(worker.directory, 'controller-runtime.json')); n++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(path.join(worker.directory, 'controller-runtime.json'))).toBe(true);
    const source = new DatabaseSync(path.join(f.state, 'core.sqlite'), { readOnly: true }); const database = path.join(f.root, 'owned-controller-copy.sqlite');
    try { await backup(source, database); } finally { source.close(); }
    const config = JSON.parse(readFileSync(path.join(worker.directory, 'config.json'), 'utf8')); const effectRoot = path.join(f.root, 'owned-controller-effects'); await cp(config.effectRoot, effectRoot, { recursive: true });
    const prepared = { ...config, database, effectRoot }; let published = 0;
    const callbacks = { approved: (): boolean => false, persist: (): void => { published++; }, finish: (): void => { published++; } };
    await expect(runHostDirect(prepared, {}, callbacks)).rejects.toThrow('RUNTIME_OR_TOOL_DENIED'); expect(published).toBe(0);
    let calls = 0; const expectedCalls = Object.keys(config.grace.documents).length + 2;
    await expect(runHostDirect(prepared, {}, { ...callbacks, approved: (): boolean => ++calls <= expectedCalls })).rejects.toThrow('RUNTIME_OR_TOOL_DENIED'); expect(calls).toBe(expectedCalls + 1); expect(published).toBe(0);
    expect(await readFile(path.join(f.project, 'note.txt'), 'utf8')).toBe('before\n'); await completed(f, binding);
  }, 20000);
  it('refuses controller migration with a queued active job and keeps its original cancellation controls', async () => {
    const f = await fixture(true); const binding = await admitted(f, { requestId: 'queued-legacy', projectId: 'project', operation: 'file.read', path: 'note.txt' });
    expect(workers(f)).toEqual([]); const authority = f.core.authority(); f.core.close();
    await expect(ExecutionCore.open(f.state, { product: { mode: 'host-direct', libraryRoot: f.policy }, upgrade: { expectedPolicy: authority.policy, expectedAuthorityId: authority.authorityId } })).rejects.toThrow('UPGRADE_RECONCILIATION_REQUIRED');
    f.core = await ExecutionCore.openForControl(f.state);
    expect(f.core.authority()).toEqual(authority); expect(await f.core.get(f.credential, binding)).toMatchObject({ status: 'queued' });
    expect(await f.core.cancel(f.credential, binding)).toMatchObject({ status: 'cancelled' }); expect(await readFile(path.join(f.project, 'note.txt'), 'utf8')).toBe('before\n');
  });
  it('rejects scope, wrong owner, stale version, lease forgery and signed receipt binding drift', async () => {
    const f = await fixture();
    expect(() => f.core.prepareOperation(f.credential, { requestId: 'outside', projectId: 'project', operation: 'file.read', path: '../outside.txt' })).toThrow();
    expect(() => f.core.prepareOperation(f.credential, { requestId: 'version', projectId: 'project', operation: 'file.write', path: 'note.txt', content: 'after', expectedSha256: '0'.repeat(64) })).toThrow('FILE_VERSION_CONFLICT');
    const input: BasicProductOperationInput = { requestId: 'receipt', projectId: 'project', operation: 'file.write', path: 'note.txt', content: 'after\n', expectedSha256: hash('before\n') };
    const binding = await admitted(f, input); const foreign = f.core.enrollAdapter('other', 'other-owner');
    await expect(f.core.get(foreign, binding)).rejects.toThrow('TASK_AUTHORITY_DENIED');
    await f.core.resume(f.credential, binding); const worker = workers(f)[0]!;
    for (let n = 0; n < 100 && !existsSync(path.join(worker.directory, 'controller-runtime.json')); n++) await new Promise(resolve => setTimeout(resolve, 20));
    const config = JSON.parse(readFileSync(path.join(worker.directory, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(() => productBrokerCall({ ...config, lease: 'forged' }, 'read_policy', { document: 'rules' }, true, {})).toThrow('LIVE_AUTHORITY_DENIED');
    const filename = path.join(worker.directory, 'controller-runtime.json'); const original = readFileSync(filename, 'utf8');
    const receipt = JSON.parse(JSON.parse(original).body) as Record<string, unknown>;
    for (const change of [{ generation: worker.generation + 1 }, { policy: '0'.repeat(64) }, { jobId: 'foreign-job' }, { brokerReceipts: [] }]) {
      const body = JSON.stringify({ ...receipt, ...change }); writeFileSync(filename, JSON.stringify({ body, mac: createHmac('sha256', worker.token).update(body).digest('hex') }));
      await expect(f.core.tick()).rejects.toThrow('CONTROLLER_RUNTIME_EVIDENCE_REQUIRED');
    }
    writeFileSync(filename, original); await completed(f, binding);
    expect(await readFile(path.join(f.project, 'note.txt'), 'utf8')).toBe('after\n');
    expect(existsSync(path.join(worker.directory, 'claude-events.jsonl'))).toBe(false);
    const stale = await admitted(f, { ...input, requestId: 'stale-at-execution', expectedSha256: hash('after\n'), content: 'intended\n' });
    await writeFile(path.join(f.project, 'note.txt'), 'independent owner edit\n');
    await f.core.resume(f.credential, stale); await f.core.tick().catch(() => undefined);
    expect(await readFile(path.join(f.project, 'note.txt'), 'utf8')).toBe('independent owner edit\n');
    expect((await f.core.get(f.credential, stale)).status).not.toBe('completed');
  }, 30000);

  it('cancels the same direct worker and independently proves its reviewed command child absent', async () => {
    const f = await fixture(); await writeFile(path.join(f.project, 'hold.mjs'), "console.log('owned command ready');setInterval(()=>{},1000);\n");
    f.core.registerReviewedCommand(f.credential, { recipeId: 'hold', executable: process.execPath, args: ['${projectRoot}/hold.mjs'], dependencies: ['${projectRoot}/hold.mjs'], timeoutMs: 20000 });
    f.core.bindProjectRecipe(f.credential, { projectId: 'project', recipeId: 'hold' });
    const binding = await admitted(f, { requestId: 'cancel-command', projectId: 'project', operation: 'command.run', commandId: 'hold' }); await f.core.resume(f.credential, binding);
    const worker = workers(f)[0]!;
    for (let n = 0; n < 100 && !f.core.logs(f.credential, binding).text.includes('owned command ready'); n++) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.core.logs(f.credential, binding).text).toContain('owned command ready');
    const observation = await callWorker(worker, 'status'); expect(observation.descendants).toHaveLength(1);
    await expect(callWorker(worker, 'start')).rejects.toThrow('WORKER_UNAVAILABLE');
    expect(signed(worker, 'controller-runtime.json')).toMatchObject({ mode: 'host-direct' });
    expect(await f.core.cancel(f.credential, binding)).toMatchObject({ status: 'cancelled' }); expect(await observeWorker(worker)).toBe('absent');
    for (const pid of [observation.pid, ...observation.descendants]) expect(() => process.kill(pid, 0)).toThrow();
    expect(await f.core.cancel(f.credential, binding)).toMatchObject({ status: 'cancelled' });
  }, 30000);

  it('retains a completed legacy result and original request lineage across quiescent controller upgrade', async () => {
    const f = await fixture(true);
    const input: BasicProductOperationInput = { requestId: 'historical-write', projectId: 'project', operation: 'file.write', path: 'note.txt', expectedSha256: hash('before\n'), content: 'historical result\n' };
    const binding = await admitted(f, input); await f.core.resume(f.credential, binding); await completed(f, binding);
    const before = await f.core.readOperationResult(f.credential, binding); const authority = f.core.authority(); f.core.close();
    const product = { mode: 'host-direct' as const, libraryRoot: f.policy };
    await expect(ExecutionCore.open(f.state, { product })).rejects.toThrow('CORE_VERSION_OR_POLICY_CHANGED');
    f.core = await ExecutionCore.open(f.state, { product, libraryOptions: { pythonExecutable: process.execPath, pythonSha256: hash(await readFile(process.execPath)) }, upgrade: { expectedAuthorityId: authority.authorityId, expectedPolicy: authority.policy } });
    expect(await f.core.readOperationResult(f.credential, f.core.select(f.credential, binding.jobId))).toEqual(before);
    const prep = f.core.prepareOperation(f.credential, input); expect((await f.core.submit(f.credential, prep.preparationId)).jobId).toBe(binding.jobId);
    expect(await f.core.readOperationResult(f.credential, f.core.select(f.credential, binding.jobId))).toEqual(before);
    const second = await admitted(f, { requestId: 'new-controller', projectId: 'project', operation: 'file.read', path: 'note.txt' }); await f.core.resume(f.credential, second); await completed(f, second);
  }, 30000);

  it('omits and rejects model workflows through Core, HTTP and the retained legacy Library adapter', async () => {
    const f = await fixture(false, true); const legacy = f.core.enrollAdapter('lnwjud-library', 'owner'); f.core.enrollLibraryRoute(legacy, { projectId: 'project', route: 'lnwjud-library' });
    const schema = JSON.stringify(productControlSchema('prepareOperation'));
    for (const [workflowId, workflowVersion] of [['library.weekly-reading', 2], ['library.final-memo', 2], ['library.memo-review', 1]] as const) {
      expect(schema).not.toContain(workflowId);
      const input = { operation: 'library.workflow' as const, requestId: 'model-work', projectId: 'project', workflowId, workflowVersion, parameters: {} };
      for (const credential of [f.credential, legacy]) {
        expect(f.core.catalog(credential).some((entry) => entry.workflowId === workflowId && entry.state === 'available')).toBe(false);
        expect(() => f.core.prepareOperation(credential, input)).toThrow('CHATGPT_ORCHESTRATION_REQUIRED');
      }
    }
    let calls = 0; const http = await startProductHttp({ token: 't'.repeat(64), mcpPathSecret: 'p'.repeat(64), rpc: async () => { calls++; return {}; } });
    try {
      const result = await (await fetch(`http://127.0.0.1:${http.port}/mcp/${'p'.repeat(64)}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gotzji_prepare_operation', arguments: { requestId: 'model-http', projectId: 'project', operation: 'library.workflow', workflowId: 'library.final-memo', workflowVersion: 2, parameters: {} } } }) })).json() as { result: { isError: boolean; content: { text: string }[] } };
      expect(result.result.isError).toBe(true); expect(result.result.content[0]!.text).toContain('CHATGPT_ORCHESTRATION_REQUIRED'); expect(calls).toBe(0);
    } finally { await http.close(); }
  });
});
