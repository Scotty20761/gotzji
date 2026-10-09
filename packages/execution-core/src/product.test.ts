import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { hash, type WorkerRow } from './store.js';
import { stopWorker, callWorker } from './managed-worker.js';
import type { TaskBinding, ProductOperationInput } from './types.js';
import type { ProductGraceRegistration } from './grace-profile.js';
import { filesystem } from './product-projects.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
const { productBrokerCall } = await import('./product-broker.mjs');
const { childEnvironment, sanitizedStream } = await import('./product-security.mjs');

interface Fixture { root: string; core: ExecutionCore; credential: string; bindings: TaskBinding[]; profile: ProductGraceRegistration }
const fixtures: Fixture[] = [];
async function fixture(options: { now?: () => Date; quotaReset?: number; delayedProductMs?: number } = {}): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-product-');
  const library = path.join(root, 'library');
  await mkdir(path.join(library, 'references'), { recursive: true });
  for (const filename of ['CLAUDE.md','AGENTS.md','references/agent-knowledge-workflow.md','KNOWLEDGE_INDEX.md']) await writeFile(path.join(library, filename), `Prepared policy ${filename}\n`);
  let testDriver = fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url));
  if (options.quotaReset) {
    testDriver = path.join(root, 'quota-driver.mjs');
    const marker = path.join(root, 'quota-observed');
    await writeFile(testDriver, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';import {fullTools} from ${JSON.stringify(new URL('./grace-broker.mjs', import.meta.url).href)};const marker=${JSON.stringify(marker)};if(existsSync(marker)){await import(${JSON.stringify(new URL('./grace-test-driver.mjs', import.meta.url).href)});}else{writeFileSync(marker,'observed',{flag:'wx'});const config=JSON.parse(readFileSync(process.argv[2],'utf8'));console.log(JSON.stringify({type:'system',subtype:'init',tools:fullTools(config),apiKeySource:'none',model:'explicit-quota-test-driver'}));console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'seven_day',resetsAt:${options.quotaReset}}}));console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true}));}`);
  }
  if(options.delayedProductMs){
    testDriver=path.join(root,'delayed-driver.mjs');
    await writeFile(testDriver,`import {readFileSync} from 'node:fs';import {fullTools} from ${JSON.stringify(new URL('./grace-broker.mjs',import.meta.url).href)};const config=JSON.parse(readFileSync(process.argv[2],'utf8'));const endpoint='http://127.0.0.1:'+process.argv[3]+'/broker';console.log(JSON.stringify({type:'system',subtype:'init',tools:fullTools(config),apiKeySource:'none',model:'explicit-delayed-test-driver'}));async function call(name,args){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'mcp__gotzji_task__'+name,input:args}]}}));const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});if(!response.ok)throw new Error('denied');return response.json();}for(const document of Object.keys(config.grace.documents))await call('read_policy',{document});await new Promise(resolve=>setTimeout(resolve,${options.delayedProductMs}));await call('execute_operation',{});await call('operation_status',{});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false}));`);
  }
  const profile = { executable: process.execPath, libraryRoot: library, testDriver };
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: profile, ...(options.now ? { now: options.now } : {}) });
  const credential = core.enrollAdapter('desktop', 'owner');
  const f = { root, core, credential, bindings: [], profile }; fixtures.push(f);
  return f;
}
async function project(f: Fixture, id: string, holdMs = 600): Promise<string> {
  const root = path.join(f.root, id); await mkdir(root);
  await writeFile(path.join(root, 'source.txt'), 'Original\r\nภาษาไทย\r\n');
  await writeFile(path.join(root, 'job.mjs'), `console.log('begin-${id}');const interval=setInterval(()=>console.log('progress-${id}'),100);setTimeout(()=>{clearInterval(interval);console.log('end-${id}');},${holdMs});`);
  f.core.registerReviewedCommand(f.credential, { recipeId: 'run', executable: process.execPath, args: ['${projectRoot}/job.mjs'], dependencies: ['${projectRoot}/job.mjs'], timeoutMs: 10000 });
  f.core.registerProject(f.credential, { projectId: id, displayName: id, rootPath: root, recipeIds: ['run'] });
  return root;
}
async function submit(f: Fixture, input: ProductOperationInput): Promise<TaskBinding> {
  const preparation = f.core.prepareOperation(f.credential, input);
  const job = await f.core.submit(f.credential, preparation.preparationId);
  const binding = f.core.select(f.credential, job.jobId); f.bindings.push(binding);
  return binding;
}
async function until(f: Fixture, predicate: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 200; n++) {
    try { await f.core.tick(); } catch { /* asserted independently by views */ }
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('product state did not settle: ' + JSON.stringify(await f.core.list(f.credential)));
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; db.close();
    for (const worker of workers) await stopWorker(worker);
    try { f.core.close(); } catch { /* detached */ }
    await rm(f.root, { recursive: true, force: true });
  }
});
describe('governed product operations — real native Goal, file and process seams', () => {
  it('runs Grace-controlled read/write against enrolled project bytes with durable result and exact CRLF', async () => {
    const f = await fixture(); const root = await project(f, 'one');
    const read = await submit(f, { requestId: 'read', projectId: 'one', operation: 'file.read', path: 'source.txt' });
    await f.core.resume(f.credential, read);
    await until(f, async () => (await f.core.get(f.credential, read)).status === 'completed');
    expect(await f.core.readOperationResult(f.credential, read)).toMatchObject({ output: { content: 'Original\r\nภาษาไทย\r\n', sha256: hash(await readFile(path.join(root, 'source.txt'))) } });
    const write = await submit(f, { requestId: 'write', projectId: 'one', operation: 'file.write', path: 'source.txt', expectedSha256: hash(await readFile(path.join(root, 'source.txt'))), content: 'Changed\r\nภาษาไทย\r\n' });
    await f.core.resume(f.credential, write);
    await until(f, async () => (await f.core.get(f.credential, write)).status === 'completed');
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('Changed\r\nภาษาไทย\r\n');
    expect(await f.core.readOperationResult(f.credential, write)).toMatchObject({ operation: 'file.write', before: { content: 'Original\r\nภาษาไทย\r\n' } });
  }, 20000);
  it('rejects stale hashes, unknown projects and path escape with a useful field before admission', async () => {
    const f = await fixture(); await project(f, 'one');
    expect(() => f.core.prepareOperation(f.credential, { requestId: 'x', projectId: 'missing', operation: 'file.read', path: 'source.txt' })).toThrow('PROJECT_NOT_REGISTERED');
    expect(() => f.core.prepareOperation(f.credential, { requestId: 'x', projectId: 'one', operation: 'file.read', path: '../library/CLAUDE.md' })).toThrow('INVALID_REQUEST');
    try { f.core.prepareOperation(f.credential, { requestId: 'x', projectId: 'one', operation: 'file.write', path: 'source.txt', content: 'x', expectedSha256: 'a'.repeat(64) }); throw new Error('accepted'); }
    catch (error) { expect(error).toMatchObject({ code: 'FILE_VERSION_CONFLICT', field: 'expectedSha256' }); }
    expect(await f.core.list(f.credential)).toEqual([]);
  });
  it('runs two independent real commands concurrently while a shared project waits and then completes', async () => {
    const f = await fixture(); await project(f, 'one', 1600); await project(f, 'two', 1600);
    const first = await submit(f, { requestId: 'first', projectId: 'one', operation: 'command.run', commandId: 'run' });
    const second = await submit(f, { requestId: 'second', projectId: 'two', operation: 'command.run', commandId: 'run' });
    const conflicting = await submit(f, { requestId: 'conflict', projectId: 'one', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, first); await f.core.resume(f.credential, second);
    const overlap=new DatabaseSync(path.join(f.root,'state','core.sqlite'));expect(overlap.prepare('SELECT COUNT(*) AS count FROM gotzji_workers WHERE job_id IN (?,?)').get(first.jobId,second.jobId)?.count).toBe(2);expect(overlap.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims WHERE job_id IN (?,?)').get(first.jobId,second.jobId)?.count).toBe(2);overlap.close();
    expect(await f.core.resume(f.credential, conflicting)).toMatchObject({ status: 'queued', waitingReason: 'RESOURCE_HELD' });
    await until(f, async () => f.core.logs(f.credential, first).text.includes('progress-one') && f.core.logs(f.credential, second).text.includes('progress-two'));
    await until(f, async () => (await f.core.get(f.credential, conflicting)).status === 'completed');
    expect(await f.core.readOperationResult(f.credential, first)).toMatchObject({ output: { state: 'completed', exitCode: 0 } });
    const core = f.core; core.close();
    f.core = await ExecutionCore.openForControl(path.join(f.root, 'state'));
    expect(f.core.logs(f.credential, first).text).toContain('end-one');
    expect(await f.core.readOperationResult(f.credential, first)).toMatchObject({ output: { state: 'completed' } });
  }, 25000);
  it('cancels the selected command without stopping the independent job or its result', async () => {
    const f = await fixture(); await project(f, 'one', 4000); await project(f, 'two', 1200);
    const first = await submit(f, { requestId: 'first', projectId: 'one', operation: 'command.run', commandId: 'run' });
    const second = await submit(f, { requestId: 'second', projectId: 'two', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, first); await f.core.resume(f.credential, second);
    await until(f, async () => f.core.logs(f.credential, first).text.includes('progress-one'));
    expect(await f.core.cancel(f.credential, first)).toMatchObject({ status: 'cancelled' });
    await until(f, async () => (await f.core.get(f.credential, second)).status === 'completed');
    expect(f.core.logs(f.credential, second).text).toContain('end-two');
  }, 20000);
  it('keeps owner/request replay stable across adapters and refuses a changed operation', async () => {
    const f = await fixture(); await project(f, 'one');
    const first = await submit(f, { requestId: 'same', projectId: 'one', operation: 'file.read', path: 'source.txt' });
    const other = f.core.enrollAdapter('plugin', 'owner');
    const prepared = f.core.prepareOperation(other, { requestId: 'same', projectId: 'one', operation: 'file.read', path: 'source.txt' });
    expect((await f.core.submit(other, prepared.preparationId)).jobId).toBe(first.jobId);
    const different = f.core.prepareOperation(other, { requestId: 'same', projectId: 'one', operation: 'command.run', commandId: 'run' });
    await expect(f.core.submit(other, different.preparationId)).rejects.toMatchObject({ code: 'REQUEST_DIGEST_CONFLICT' });
    const foreign = f.core.enrollAdapter('foreign', 'stranger');
    expect(f.core.listProjects(foreign)).toEqual([]);
    expect(() => f.core.select(foreign, first.jobId)).toThrow('TASK_AUTHORITY_DENIED');
  });
  it('bounds the durable waiting queue at 32 jobs, preserving control and replay', async () => {
    const f = await fixture(); await project(f, 'one');
    for (let i = 0; i < 32; i++) await submit(f, { requestId: 'queued-' + i, projectId: 'one', operation: 'command.run', commandId: 'run' });
    const overflow = f.core.prepareOperation(f.credential, { requestId: 'overflow', projectId: 'one', operation: 'command.run', commandId: 'run' });
    await expect(f.core.submit(f.credential, overflow.preparationId)).rejects.toMatchObject({ code: 'QUEUE_CAPACITY_REACHED' });
    await f.core.cancel(f.credential, f.bindings[0]!);
    expect((await f.core.submit(f.credential, overflow.preparationId)).status).toBe('queued');
    expect((await f.core.list(f.credential)).length).toBe(33);
  }, 15000);
  it('waits for dependencies and rejects failed dependency work without starting an effect', async () => {
    const f = await fixture(); await project(f, 'one'); await project(f, 'two');
    const dependency = await submit(f, { requestId: 'parent', projectId: 'one', operation: 'command.run', commandId: 'run' });
    const dependent = await submit(f, { requestId: 'child', projectId: 'two', operation: 'file.read', path: 'source.txt', dependsOn: [dependency.jobId] });
    expect(await f.core.resume(f.credential, dependent)).toMatchObject({ status: 'queued', waitingReason: 'WAITING_FOR_DEPENDENCY' });
    await f.core.cancel(f.credential, dependency);
    expect(await f.core.resume(f.credential, dependent)).toMatchObject({ status: 'failed', waitingReason: 'DEPENDENCY_FAILED' });
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    expect(db.prepare('SELECT 1 FROM gotzji_workers WHERE job_id=?').get(dependent.jobId)).toBeUndefined(); db.close();
  });
  it('declares unqualified native providers and forbids qualification recipes on the product authority', async () => {
    const f = await fixture();
    expect(f.core.catalog(f.credential).find((entry) => entry.name === 'cad')).toMatchObject({ state: 'unsupported', reason: 'PROVIDER_NOT_QUALIFIED' });
    expect(() => f.core.prepare(f.credential, { requestId: 'bypass', operation: 'fixture.write', text: 'bypass' })).toThrow('QUALIFICATION_NOT_AVAILABLE');
    expect(() => f.core.prepare(f.credential, { requestId: 'bypass', operation: 'grace.product-operation', text: '{}' })).toThrow('PRODUCT_PREPARATION_REQUIRED');
  });
  it('replays trusted startup enrollment after insertion without rotating identity or admitting a different owner/token', async () => {
    const f = await fixture();
    f.core.ensureAdapterEnrollment('desktop', 'owner', f.credential);
    f.core.ensureAdapterEnrollment('desktop', 'owner', f.credential);
    expect(f.core.listProjects(f.credential)).toEqual([]);
    expect(() => f.core.ensureAdapterEnrollment('desktop', 'stranger', f.credential)).toThrow('ADAPTER_ENROLLMENT_CONFLICT');
    expect(() => f.core.ensureAdapterEnrollment('desktop', 'owner', 'a'.repeat(64))).toThrow('ADAPTER_ENROLLMENT_CONFLICT');
    expect(() => f.core.ensureAdapterEnrollment('different', 'owner', f.credential)).toThrow('ADAPTER_ENROLLMENT_CONFLICT');
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_adapters').get()?.count).toBe(1); db.close();
  });
  it('rejects invalid lease expiry, changed ownership and broker arguments before a new effect', async () => {
    const f = await fixture(); await project(f, 'one', 3000);
    const binding = await submit(f, { requestId: 'authority', projectId: 'one', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, binding);
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow;
    const config = JSON.parse(await readFile(path.join(worker.directory, 'config.json'), 'utf8'));
    expect(() => productBrokerCall(config, 'execute_operation', { command: 'unreviewed' }, true, {})).toThrow('ARGUMENTS_DENIED');
    expect(() => productBrokerCall({ ...config, owner: 'stranger' }, 'operation_status', {}, true, {})).toThrow('LIVE_AUTHORITY_DENIED');
    db.prepare("UPDATE goals SET lease_expires_at='invalid'").run();
    expect(() => productBrokerCall(config, 'operation_status', {}, true, {})).toThrow('LIVE_AUTHORITY_DENIED');
    db.prepare('UPDATE goals SET lease_expires_at=?').run(new Date(Date.now() + 300000).toISOString());
    db.close();
  }, 10000);
  it('records a reviewed command deadline as actual failure with retained output rather than observer timeout', async () => {
    const f = await fixture(); const root = await project(f, 'one', 8000);
    f.core.registerReviewedCommand(f.credential, { recipeId: 'short', executable: process.execPath, args: [path.join(root, 'job.mjs')], dependencies: [path.join(root, 'job.mjs')], timeoutMs: 200 });
    f.core.registerProject(f.credential, { projectId: 'deadline', displayName: 'Deadline', rootPath: root, recipeIds: ['short'] });
    const binding = await submit(f, { requestId: 'deadline', projectId: 'deadline', operation: 'command.run', commandId: 'short' });
    await f.core.resume(f.credential, binding);
    await until(f, async () => (await f.core.get(f.credential, binding)).status === 'failed');
    expect(f.core.logs(f.credential, binding).text).toContain('begin-one');
    expect(await f.core.get(f.credential, binding)).toMatchObject({ status: 'failed', summary: 'COMMAND_TIMED_OUT' });
  }, 15000);
  it('retains the resource fence when cancellation observes unexpected project-file bytes', async () => {
    const f = await fixture(); const root = await project(f, 'one');
    const target = path.join(root, 'source.txt');
    const binding = await submit(f, { requestId: 'change', projectId: 'one', operation: 'file.write', path: 'source.txt', expectedSha256: hash(await readFile(target)), content: 'Approved\r\n' });
    await f.core.resume(f.credential, binding);
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow; db.close();
    for (let i = 0; i < 100 && (await callWorker(worker, 'status')).state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(target, 'Unexpected external content');
    await expect(f.core.cancel(f.credential, binding)).rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED', field: 'path' });
    expect(await f.core.get(f.credential, binding)).toMatchObject({ status: 'blocked' });
  }, 10000);

  it('lets the owner settle a write held by bytes changed after it ran, so the next job on that project runs', async () => {
    const f = await fixture(); const root = await project(f, 'one');
    const target = path.join(root, 'source.txt');
    const binding = await submit(f, { requestId: 'change', projectId: 'one', operation: 'file.write', path: 'source.txt', expectedSha256: hash(await readFile(target)), content: 'Approved\r\n' });
    await f.core.resume(f.credential, binding);
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow; db.close();
    for (let i = 0; i < 100 && (await callWorker(worker, 'status')).state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(target, 'Owner edit after the run');
    await expect(f.core.tick()).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
    expect(await f.core.get(f.credential, binding)).toMatchObject({ status: 'blocked', blockerCode: 'ARTIFACT_CHANGED', settleDecisions: ['effect-present', 'no-effect'] });
    // A write-class job: reads no longer wait on project claims (incident I2).
    const next = await submit(f, { requestId: 'next', projectId: 'one', operation: 'command.run', commandId: 'run' });
    const waiting = await f.core.resume(f.credential, next);
    expect(waiting).toMatchObject({ status: 'queued', waitingReason: 'RESOURCE_HELD', blockingJob: binding.jobId }); expect(waiting).not.toHaveProperty('settleDecisions');
    await expect(f.core.settleBlockedJob(f.credential, next, 'no-effect')).rejects.toMatchObject({ code: 'JOB_NOT_SETTLEABLE' });
    expect(await f.core.settleBlockedJob(f.credential, binding, 'effect-present')).toMatchObject({ status: 'cancelled', summary: 'OWNER_SETTLED_EFFECT_PRESENT' });
    const state = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const operation = state.prepare('SELECT phase,receipt FROM gotzji_operations WHERE job_id=?').get(binding.jobId) as { phase: string; receipt: string };
    const events = (state.prepare('SELECT event FROM gotzji_job_events WHERE job_id=?').all(binding.jobId) as { event: string }[]).map((row) => row.event);
    const held = state.prepare('SELECT COUNT(*) AS count FROM gotzji_writers WHERE job_id=?').get(binding.jobId) as { count: number }; state.close();
    expect(operation.phase).toBe('settled');
    expect(JSON.parse(operation.receipt)).toMatchObject({ verifier: 'owner-settlement-v1', decision: 'effect-present', observedSha256: hash(Buffer.from('Owner edit after the run')) });
    expect(events).toContain('OWNER_SETTLED_EFFECT_PRESENT'); expect(held.count).toBe(0);
    await expect(f.core.settleBlockedJob(f.credential, binding, 'effect-present')).rejects.toMatchObject({ code: 'JOB_NOT_SETTLEABLE' });
    await until(f, async () => (await f.core.get(f.credential, next)).status === 'completed');
    await expect(f.core.settleBlockedJob(f.credential, next, 'no-effect')).rejects.toMatchObject({ code: 'JOB_NOT_SETTLEABLE' });
    expect(await readFile(target, 'utf8')).toBe('Owner edit after the run');
  }, 15000);

  it('refuses to settle a running job or a worker without stop proof, then settles a cancelled held write from a control-only host', async () => {
    const f = await fixture(); const root = await project(f, 'one'); await project(f, 'two', 1600);
    const running = await submit(f, { requestId: 'long', projectId: 'two', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, running);
    await until(f, async () => f.core.logs(f.credential, running).text.includes('progress-two'));
    await expect(f.core.settleBlockedJob(f.credential, running, 'no-effect')).rejects.toMatchObject({ code: 'JOB_NOT_SETTLEABLE' });
    const target = path.join(root, 'source.txt');
    const binding = await submit(f, { requestId: 'change', projectId: 'one', operation: 'file.write', path: 'source.txt', expectedSha256: hash(await readFile(target)), content: 'Approved\r\n' });
    await f.core.resume(f.credential, binding);
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow; db.close();
    for (let i = 0; i < 100 && (await callWorker(worker, 'status')).state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(target, 'Owner edit after the run');
    await expect(f.core.cancel(f.credential, binding)).rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED', field: 'path' });
    // A host whose runtime changed starts control-only while this writer is held; settling must work there.
    f.core.close(); f.core = await ExecutionCore.openForControl(path.join(f.root, 'state'));
    expect(await f.core.get(f.credential, binding)).toMatchObject({ status: 'blocked', settleDecisions: ['effect-present', 'no-effect'] });
    const ready = path.join(worker.directory, 'ready.json'); const proof = await readFile(ready);
    await writeFile(ready, '{}');
    await expect(f.core.settleBlockedJob(f.credential, binding, 'no-effect')).rejects.toMatchObject({ code: 'WORKER_STOP_REQUIRED' });
    expect(await f.core.get(f.credential, binding)).toMatchObject({ status: 'blocked' });
    await writeFile(ready, proof);
    // A held job can lack its operation row (interrupted admission); the decision still becomes a durable receipt.
    const admission = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite')); admission.prepare('DELETE FROM gotzji_operations WHERE job_id=?').run(binding.jobId); admission.close();
    expect(await f.core.settleBlockedJob(f.credential, binding, 'no-effect')).toMatchObject({ status: 'cancelled' });
    const state = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const operation = state.prepare('SELECT phase,receipt FROM gotzji_operations WHERE job_id=?').get(binding.jobId) as { phase: string; receipt: string };
    const events = (state.prepare('SELECT event FROM gotzji_job_events WHERE job_id=?').all(binding.jobId) as { event: string }[]).map((row) => row.event); state.close();
    expect(operation.phase).toBe('settled');
    expect(JSON.parse(operation.receipt)).toMatchObject({ verifier: 'owner-settlement-v1', decision: 'no-effect', observedSha256: hash(Buffer.from('Owner edit after the run')), previous: null });
    expect(events).toContain('OWNER_SETTLED_NO_EFFECT');
    f.core.close(); f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile });
    await until(f, async () => (await f.core.get(f.credential, running)).status === 'completed');
  }, 25000);

  it('never settles running work that only looks blocked, so the command still reaches its end', async () => {
    const f = await fixture(); await project(f, 'two', 4000);
    const running = await submit(f, { requestId: 'long', projectId: 'two', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, running);
    await until(f, async () => f.core.logs(f.credential, running).text.includes('progress-two'));
    // An owner-wide provider limit from another job and a transient supervision diagnostic both project this live job as blocked.
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    db.prepare('INSERT INTO gotzji_provider_limits VALUES (?,?,?,?)').run('owner', 'f'.repeat(64), null, '{}');
    db.prepare('INSERT INTO gotzji_diagnostics VALUES (?,?,?)').run(running.jobId, 'WORKER_UNAVAILABLE', new Date().toISOString());
    const view = await f.core.get(f.credential, running);
    expect(view.status).toBe('blocked'); expect(view).not.toHaveProperty('settleDecisions');
    await expect(f.core.settleBlockedJob(f.credential, running, 'no-effect')).rejects.toMatchObject({ code: 'JOB_STILL_RUNNING' });
    db.prepare('DELETE FROM gotzji_provider_limits').run(); db.prepare('DELETE FROM gotzji_diagnostics').run();
    // A worker that misses a status call is busy, not lost: within the grace window nothing about the job changes.
    const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(running.jobId) as unknown as WorkerRow;
    const ready = path.join(worker.directory, 'ready.json'); const proof = await readFile(ready);
    // Restore the status channel even if an expectation fails, so teardown can still stop this worker.
    await writeFile(ready, '{}');
    try {
      await f.core.tick();
      expect((await f.core.get(f.credential, running)).status).toBe('running');
      expect(db.prepare('SELECT phase FROM gotzji_operations WHERE job_id=?').get(running.jobId)).toMatchObject({ phase: 'started' });
      // Unobservable past the grace window, it is marked uncertain; that alone must not make it settleable.
      db.prepare('UPDATE gotzji_workers SET last_renewed=? WHERE job_id=?').run(Date.now() - 120_000, running.jobId);
      await expect(f.core.tick()).rejects.toMatchObject({ code: 'WORKER_RECONCILIATION_REQUIRED' });
    } finally { db.close(); await writeFile(ready, proof); }
    await f.core.tick();
    const uncertain = await f.core.get(f.credential, running);
    expect(uncertain.status).toBe('blocked'); expect(uncertain).not.toHaveProperty('settleDecisions');
    await expect(f.core.settleBlockedJob(f.credential, running, 'effect-present')).rejects.toMatchObject({ code: 'JOB_STILL_RUNNING' });
    await until(f, async () => (await f.core.get(f.credential, running)).status === 'completed');
    expect(f.core.logs(f.credential, running).text).toContain('end-two');
  }, 20000);

  it('keeps a completed job’s verified result when the owner settles a writer still held after completion', async () => {
    const f = await fixture(); const root = await project(f, 'one');
    const target = path.join(root, 'source.txt');
    const binding = await submit(f, { requestId: 'change', projectId: 'one', operation: 'file.write', path: 'source.txt', expectedSha256: hash(await readFile(target)), content: 'Approved\r\n' });
    await f.core.resume(f.credential, binding);
    let state = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const writer = state.prepare('SELECT root,job_id,epoch FROM gotzji_writers WHERE job_id=?').get(binding.jobId) as { root: string; job_id: string; epoch: string };
    const claims = state.prepare('SELECT resource_key,job_id,epoch FROM gotzji_resource_claims WHERE job_id=?').all(binding.jobId) as { resource_key: string; job_id: string; epoch: string }[]; state.close();
    await until(f, async () => (await f.core.get(f.credential, binding)).status === 'completed');
    const result = await f.core.readOperationResult(f.credential, binding);
    // The window between finishing the goal and releasing the writer, followed by an owner edit that cleanup cannot verify.
    state = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    state.prepare('INSERT INTO gotzji_writers(root,job_id,epoch) VALUES (?,?,?)').run(writer.root, writer.job_id, writer.epoch);
    for (const claim of claims) state.prepare('INSERT INTO gotzji_resource_claims(resource_key,job_id,epoch) VALUES (?,?,?)').run(claim.resource_key, claim.job_id, claim.epoch);
    state.prepare('UPDATE gotzji_operations SET phase=? WHERE job_id=?').run('uncertain', binding.jobId); state.close();
    await writeFile(target, 'Owner edit after completion');
    expect(await f.core.get(f.credential, binding)).toMatchObject({ status: 'blocked', settleDecisions: ['effect-present'] });
    await expect(f.core.settleBlockedJob(f.credential, binding, 'no-effect')).rejects.toMatchObject({ code: 'SETTLE_DECISION_INVALID' });
    expect(await f.core.settleBlockedJob(f.credential, binding, 'effect-present')).toMatchObject({ status: 'completed' });
    expect(await f.core.readOperationResult(f.credential, binding)).toEqual(result);
    state = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    expect(state.prepare('SELECT COUNT(*) AS count FROM gotzji_writers WHERE job_id=?').get(binding.jobId)).toMatchObject({ count: 0 }); state.close();
  }, 15000);
  it('rejects IPC-style executable/argument enrollment and changed prepared script dependencies', async () => {
    const f = await fixture(); const root = await project(f, 'one');
    expect(() => f.core.registerProject(f.credential, { projectId: 'forged', displayName: 'Forged', rootPath: root, commands: [{ executable: 'powershell.exe', args: ['anything'] }] } as never)).toThrow('INVALID_REQUEST');
    expect(f.core.catalog(f.credential).find((entry) => entry.recipeId === 'run')).toMatchObject({ state: 'available', recipeId: 'run' });
    expect(JSON.stringify(f.core.catalog(f.credential))).not.toContain(process.execPath);
    const prepared = f.core.prepareOperation(f.credential, { requestId: 'dependency-drift', projectId: 'one', operation: 'command.run', commandId: 'run' });
    await writeFile(path.join(root, 'job.mjs'), 'console.log("unreviewed-change");');
    const job = await f.core.submit(f.credential, prepared.preparationId); const binding = f.core.select(f.credential, job.jobId); f.bindings.push(binding);
    await f.core.resume(f.credential, binding);
    // Refused before the command started, so it ends failed and frees its project instead of holding it (incident I1b).
    await until(f, async () => (await f.core.get(f.credential, binding)).status === 'failed');
    expect(await f.core.get(f.credential, binding)).toMatchObject({ summary: 'COMMAND_DEPENDENCIES_CHANGED' });
    expect(f.core.logs(f.credential, binding).text).not.toContain('unreviewed-change');
    const state = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { readOnly: true, timeout: 5000 });
    expect(state.prepare('SELECT COUNT(*) AS count FROM gotzji_writers WHERE job_id=?').get(binding.jobId)).toMatchObject({ count: 0 }); state.close();
  }, 15000);
  it('ends a write refused before it touched the file as failed and frees its project (incident I1b)', async () => {
    const f = await fixture(); const root = await project(f, 'one');
    await writeFile(path.join(root, 'notes.txt'), 'Original\n');
    const prepared = f.core.prepareOperation(f.credential, { requestId: 'policy-drift', projectId: 'one', operation: 'file.write', path: 'notes.txt', expectedSha256: hash('Original\n'), content: 'Changed\n' });
    // A rule added after the write was prepared makes the broker refuse before writing.
    await writeFile(path.join(root, 'CLAUDE.md'), 'Rules added after preparation\n');
    const job = await f.core.submit(f.credential, prepared.preparationId); const binding = f.core.select(f.credential, job.jobId); f.bindings.push(binding);
    await f.core.resume(f.credential, binding);
    await until(f, async () => (await f.core.get(f.credential, binding)).status === 'failed');
    expect(await f.core.get(f.credential, binding)).toMatchObject({ summary: 'PROJECT_POLICY_CHANGED' });
    expect(await readFile(path.join(root, 'notes.txt'), 'utf8')).toBe('Original\n');
    const state = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { readOnly: true, timeout: 5000 });
    expect(state.prepare('SELECT COUNT(*) AS count FROM gotzji_writers WHERE job_id=?').get(binding.jobId)).toMatchObject({ count: 0 }); state.close();
  }, 15000);
  it('requires frozen project and ancestor policy reads and rejects changed or newly added rules', async () => {
    const f = await fixture(); const root = await project(f, 'one', 3000);
    await writeFile(path.join(f.root, 'AGENTS.md'), 'Ancestor policy\n'); await writeFile(path.join(root, 'CLAUDE.md'), 'Actual project policy\n');
    const binding = await submit(f, { requestId: 'policy', projectId: 'one', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, binding);
    await until(f, async () => f.core.logs(f.credential, binding).text.includes('progress-one'));
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite')); const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow;
    const config = JSON.parse(await readFile(path.join(worker.directory, 'config.json'), 'utf8'));
    const policies = Object.keys(JSON.parse(config.text).projectPolicies); expect(policies.length).toBe(2);
    expect(policies.every((id) => !!db.prepare('SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=? AND phase=?').get(binding.jobId, 'policy:' + id, 'verified'))).toBe(true);
    db.prepare('DELETE FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').run(binding.jobId, 'policy:' + policies[0]);
    expect(() => productBrokerCall(config, 'operation_status', {}, true, {})).toThrow('PREWORK_REQUIRED');
    await writeFile(path.join(root, 'CLAUDE.md'), 'Changed project rules\n');
    expect(() => productBrokerCall(config, 'execute_operation', {}, true, {})).toThrow('PROJECT_POLICY_CHANGED');
    db.close();
  }, 15000);
  it('persists priority/FIFO across reopen, advances actual queued work and ages low priority jobs', async () => {
    let clock = new Date(); const f = await fixture({ now: () => clock }); await project(f, 'one', 800);
    const first = await submit(f, { requestId: 'first-order', projectId: 'one', operation: 'command.run', commandId: 'run', priority: 0 });
    const second = await submit(f, { requestId: 'second-order', projectId: 'one', operation: 'command.run', commandId: 'run' });
    const third = await submit(f, { requestId: 'third-order', projectId: 'one', operation: 'command.run', commandId: 'run' });
    expect((await f.core.inspectQueue(f.credential)).map((job) => job.jobId)).toEqual([second.jobId, third.jobId, first.jobId]);
    await f.core.reprioritize(f.credential, { jobId: third.jobId, priority: 3 });
    f.core.close(); f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, now: () => clock });
    expect((await f.core.inspectQueue(f.credential))[0]).toMatchObject({ jobId: third.jobId, priority: 3, queuePosition: 1 });
    clock = new Date(clock.getTime() + 91000);
    expect((await f.core.inspectQueue(f.credential)).map((job) => job.jobId)).toEqual([first.jobId, second.jobId, third.jobId]);
    await f.core.tick(); expect(await f.core.get(f.credential, first)).toMatchObject({ status: 'running' });
    expect(await f.core.get(f.credential, second)).toMatchObject({ status: 'queued', blockingJob: first.jobId, waitingReason: 'RESOURCE_HELD' });
    await until(f, async () => (await f.core.get(f.credential, second)).status === 'running');
    expect((await f.core.get(f.credential, first)).status).toBe('completed');
  }, 20000);
  it('creates an explicitly absent project file once and rejects source drift or private-runtime creation',async()=>{
    const f=await fixture();const root=await project(f,'one');
    const creation=f.core.prepareOperation(f.credential,{requestId:'create-new',projectId:'one',operation:'file.write',path:'new-module.mjs',expectedSha256:null,content:'export const value = 1;\r\n'});const createdJob=await f.core.submit(f.credential,creation.preparationId);const created=f.core.select(f.credential,createdJob.jobId);f.bindings.push(created);
    await f.core.resume(f.credential,created);await until(f,async()=> (await f.core.get(f.credential,created)).status==='completed');
    expect(await readFile(path.join(root,'new-module.mjs'),'utf8')).toBe('export const value = 1;\r\n');
    expect(await f.core.readOperationResult(f.credential,created)).toMatchObject({output:{beforeSha256:null,sha256:hash('export const value = 1;\r\n')}});
    expect((await f.core.submit(f.credential,creation.preparationId)).jobId).toBe(created.jobId);
    expect(()=>f.core.prepareOperation(f.credential,{requestId:'different-create',projectId:'one',operation:'file.write',path:'new-module.mjs',expectedSha256:null,content:'export const value = 1;\r\n'})).toThrow('FILE_VERSION_CONFLICT');
    const pending=f.core.prepareOperation(f.credential,{requestId:'create-race',projectId:'one',operation:'file.write',path:'race.mjs',expectedSha256:null,content:'approved\n'});await writeFile(path.join(root,'race.mjs'),'external\n');
    const job=await f.core.submit(f.credential,pending.preparationId);const binding=f.core.select(f.credential,job.jobId);f.bindings.push(binding);await f.core.resume(f.credential,binding);await until(f,async()=> (await f.core.get(f.credential,binding)).status==='blocked');
    expect(await readFile(path.join(root,'race.mjs'),'utf8')).toBe('external\n');
    f.core.registerProject(f.credential,{projectId:'broad-create',displayName:'Broad create',rootPath:f.root});
    expect(()=>f.core.prepareOperation(f.credential,{requestId:'private-create',projectId:'broad-create',operation:'file.write',path:'state/forged-worker.json',expectedSha256:null,content:'{}'})).toThrow('PRIVATE_RUNTIME_SCOPE_DENIED');
  },25000);
  it('reconciles a lost create response from exact bytes without repeating the exclusive effect',async()=>{
    const f=await fixture({delayedProductMs:1200});const root=await project(f,'one');const content='created exactly once\n';
    const preparation=f.core.prepareOperation(f.credential,{requestId:'create-response-loss',projectId:'one',operation:'file.write',path:'lost-create.txt',expectedSha256:null,content});const job=await f.core.submit(f.credential,preparation.preparationId);const binding=f.core.select(f.credential,job.jobId);f.bindings.push(binding);await f.core.resume(f.credential,binding);
    const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'));await until(f,()=>Number(db.prepare("SELECT COUNT(*) AS count FROM gotzji_recipe_operations WHERE job_id=? AND operation_id LIKE 'policy:%' AND phase='verified'").get(binding.jobId)?.count)===4);
    const worker=db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow;const config=JSON.parse(await readFile(path.join(worker.directory,'config.json'),'utf8'));const claim=db.prepare('SELECT digest FROM gotzji_claims WHERE id=?').get(binding.jobId);
    const operationDigest=hash(JSON.stringify({name:'execute_operation',args:{},intent:String(claim?.digest),epoch:config.epoch}));db.prepare('INSERT INTO gotzji_recipe_operations VALUES (?,?,?,?,NULL)').run(binding.jobId,'execute_operation',operationDigest,'started');
    await writeFile(path.join(root,'lost-create.txt'),content,{flag:'wx'});await until(f,async()=> (await f.core.get(f.credential,binding)).status==='completed');
    expect(await readFile(path.join(root,'lost-create.txt'),'utf8')).toBe(content);expect(await f.core.readOperationResult(f.credential,binding)).toMatchObject({output:{beforeSha256:null,sha256:hash(content)}});db.close();
  },20000);
  it('bounds waiting per owner while retaining another owner\'s admission and queue controls', async () => {
    const f = await fixture(); const root = await project(f, 'one');
    for (let i = 0; i < 32; i++) await submit(f, { requestId: 'owner-one-' + i, projectId: 'one', operation: 'file.read', path: 'source.txt' });
    const other = f.core.enrollAdapter('second-owner', 'another-owner');
    f.core.registerProject(other, { projectId: 'other', displayName: 'Other', rootPath: root });
    const prepared = f.core.prepareOperation(other, { requestId: 'other-admission', projectId: 'other', operation: 'file.read', path: 'source.txt' });
    const job = await f.core.submit(other, prepared.preparationId);
    expect((await f.core.inspectQueue(other))[0]?.jobId).toBe(job.jobId);
    await expect(f.core.reprioritize(other, { jobId: f.bindings[0]!.jobId, priority: 3 })).rejects.toMatchObject({ code: 'TASK_AUTHORITY_DENIED' });
  }, 20000);
  it('uses an explicit child environment and redacts retained model-visible logs across chunks', async () => {
    expect(childEnvironment({ PATH: 'safe', PSModuleAnalysisCachePath: 'C:/cache/ModuleAnalysisCache', SECRET_X: 'sensitive-host-secret', NODE_OPTIONS: '--dangerous', ANTHROPIC_API_KEY: 'provider-secret' })).toEqual({ PATH: 'safe', PSModuleAnalysisCachePath: 'C:/cache/ModuleAnalysisCache' });
    let sanitized = ''; const stream = sanitizedStream((text: string) => { sanitized += text; });
    stream.write(Buffer.from('SECRET_X=sensitive-')); stream.write(Buffer.from('value\nAuthorization: Bearer token-value\n')); stream.end();
    expect(sanitized).not.toContain('sensitive-value'); expect(sanitized).not.toContain('token-value');
    let structured = ''; const jsonStream = sanitizedStream((text: string) => { structured += text; });
    jsonStream.write(Buffer.from('{"nested":{"SECRET_X":"json-private-value"}}\n')); jsonStream.end();
    expect(structured).not.toContain('json-private-value'); expect(structured).toContain('[REDACTED]');
    const f = await fixture(); const root = await project(f, 'one');
    const script = path.join(root, 'secrets.mjs'); await writeFile(script, 'console.log("SECRET_X="+(process.env.SECRET_X??"absent"));process.stdout.write("API_KEY=sk-");setTimeout(()=>console.log("sentinel-private"),40);');
    f.core.registerReviewedCommand(f.credential, { recipeId: 'redacted', executable: process.execPath, args: [script], dependencies: [script], timeoutMs: 5000 });
    f.core.registerProject(f.credential, { projectId: 'secrets', displayName: 'Secrets', rootPath: root, recipeIds: ['redacted'] });
    const previous = process.env.SECRET_X; process.env.SECRET_X = 'host-sentinel-private';
    try {
      const binding = await submit(f, { requestId: 'redaction', projectId: 'secrets', operation: 'command.run', commandId: 'redacted' });
      await f.core.resume(f.credential, binding); await until(f, async () => (await f.core.get(f.credential, binding)).status === 'completed');
      const logs = f.core.logs(f.credential, binding).text; expect(logs).not.toContain('host-sentinel-private'); expect(logs).not.toContain('sentinel-private'); expect(logs).toContain('[REDACTED]');
    } finally { if (previous === undefined) delete process.env.SECRET_X; else process.env.SECRET_X = previous; }
  }, 15000);
  it('reports missing and permission failures with actionable filesystem fields', async () => {
    const f = await fixture(); await project(f, 'one');
    try { f.core.prepareOperation(f.credential, { requestId: 'missing-file', projectId: 'one', operation: 'file.read', path: 'missing.txt' }); throw new Error('accepted'); }
    catch (error) { expect(error).toMatchObject({ code: 'FILE_NOT_FOUND', field: 'path', layer: 'filesystem', action: 'Check the selected path and prepare again' }); }
    expect(() => filesystem('path', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); })).toThrow('FILE_PERMISSION_DENIED');
  });
  it('keeps server-owned worker/config/receipt paths outside a broadly enrolled parent project', async()=>{
    const f=await fixture();await project(f,'one',4000);await writeFile(path.join(f.root,'public.txt'),'ordinary\n');
    f.core.registerProject(f.credential,{projectId:'broad',displayName:'Broad owner scope',rootPath:f.root});
    const running=await submit(f,{requestId:'private-boundary-worker',projectId:'one',operation:'command.run',commandId:'run'});await f.core.resume(f.credential,running);
    const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'));const worker=db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(running.jobId) as unknown as WorkerRow;db.close();
    const relative=path.relative(f.root,path.join(worker.directory,'config.json'));
    const privateHash=hash(await readFile(path.join(worker.directory,'config.json')));
    expect(()=>f.core.prepareOperation(f.credential,{requestId:'private-read',projectId:'broad',operation:'file.read',path:relative})).toThrow('PRIVATE_RUNTIME_SCOPE_DENIED');
    expect(()=>f.core.prepareOperation(f.credential,{requestId:'private-write',projectId:'broad',operation:'file.write',path:relative,expectedSha256:privateHash,content:'forged'})).toThrow('PRIVATE_RUNTIME_SCOPE_DENIED');
    const ordinary=await submit(f,{requestId:'ordinary-read',projectId:'broad',operation:'file.read',path:'public.txt'});await f.core.resume(f.credential,ordinary);await until(f,async()=> (await f.core.get(f.credential,ordinary)).status==='completed');
    expect(await f.core.readOperationResult(f.credential,ordinary)).toMatchObject({output:{content:'ordinary\n'}});
  },20000);
  it('retains the same job on an actual rejected quota event and suppresses further model launches until provider reset', async () => {
    let now = new Date(); const reset = Math.floor(now.getTime() / 1000) + 3600;
    const f = await fixture({ quotaReset: reset, now: () => now }); await project(f, 'one');
    const binding = await submit(f, { requestId: 'quota-job', projectId: 'one', operation: 'file.read', path: 'source.txt' });
    await f.core.resume(f.credential, binding);
    await until(f, async () => (await f.core.get(f.credential, binding)).blockerCode === 'GRACE_ACCOUNT_LIMIT');
    expect(await f.core.get(f.credential, binding)).toMatchObject({ status: 'blocked', retryAt: new Date(reset * 1000).toISOString(), waitingReason: 'PROVIDER_LIMIT' });
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_writers').get()?.count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_workers').get()?.count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_worker_history').get()?.count).toBe(1);
    await f.core.resume(f.credential, binding); await f.core.tick();
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_worker_history').get()?.count).toBe(1);
    expect(db.prepare('SELECT status FROM goals').get()?.status).toBe('active');
    now = new Date((reset + 1) * 1000);
    await f.core.resume(f.credential, binding);
    await until(f, async () => (await f.core.get(f.credential, binding)).status === 'completed');
    expect((await f.core.get(f.credential, binding)).jobId).toBe(binding.jobId);
    expect(await f.core.readOperationResult(f.credential, binding)).toMatchObject({ output: { content: 'Original\r\nภาษาไทย\r\n' } });
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_worker_history').get()?.count).toBe(1);
    expect(db.prepare('SELECT status FROM goals').get()?.status).toBe('completed'); db.close();
  }, 15000);
  it('upgrades an anchored quiescent predecessor store and rolls policy back without rewriting job intent or result', async () => {
    const f = await fixture(); await project(f, 'one');
    const prepared = f.core.prepareOperation(f.credential, { requestId: 'upgrade-result', projectId: 'one', operation: 'file.read', path: 'source.txt' });
    const job = await f.core.submit(f.credential, prepared.preparationId); const binding = f.core.select(f.credential, job.jobId); f.bindings.push(binding);
    await f.core.resume(f.credential, binding); await until(f, async () => (await f.core.get(f.credential, binding)).status === 'completed');
    const originalResult = await f.core.readOperationResult(f.credential, binding);
    const predecessor = f.core.authority();
    const filename = path.join(f.root, 'state', 'core.sqlite');
    const db = new DatabaseSync(filename);
    const records = (): string => JSON.stringify(['gotzji_claims','gotzji_preparations','gotzji_operations','gotzji_authorized_jobs'].map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
    const before = records();
    f.core.close();
    // A controlled earlier store schema, separate from every real user ledger.
    db.exec(`DROP TABLE gotzji_resource_claims; DROP TABLE gotzji_policy_history; DROP TABLE gotzji_provider_limits; DROP TABLE gotzji_queue; DROP TABLE gotzji_reviewed_recipes;
      ALTER TABLE gotzji_product_jobs DROP COLUMN blocking_resource;
      ALTER TABLE gotzji_product_jobs DROP COLUMN blocking_job;
      ALTER TABLE gotzji_product_jobs DROP COLUMN blocking_dependency;
      DELETE FROM schema_migrations WHERE id IN ('gotzji_006_reviewed_queue','gotzji_007_policy_history','gotzji_008_native_resources');`);
    const policyFile = path.join(f.profile.libraryRoot, 'CLAUDE.md'); const oldPolicyBytes = await readFile(policyFile);
    await writeFile(policyFile, 'New reviewed runtime policy\n');
    f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, upgrade: { expectedAuthorityId: predecessor.authorityId, expectedPolicy: predecessor.policy } });
    const current = f.core.authority(); expect(current.authorityId).toBe(predecessor.authorityId); expect(current.policy).not.toBe(predecessor.policy);
    expect(records()).toBe(before);
    expect(await f.core.readOperationResult(f.credential, binding)).toEqual(originalResult);
    expect((await f.core.submit(f.credential, prepared.preparationId)).jobId).toBe(job.jobId);
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE id='gotzji_006_reviewed_queue'").get()).toBeDefined();
    f.core.close(); await writeFile(policyFile, oldPolicyBytes);
    f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, upgrade: { expectedAuthorityId: current.authorityId, expectedPolicy: current.policy } });
    expect(f.core.authority()).toEqual(predecessor); expect(records()).toBe(before);
    expect(await f.core.readOperationResult(f.credential, f.core.select(f.credential, job.jobId))).toEqual(originalResult);
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_policy_history').get()?.count).toBe(2); db.close();
  }, 15000);
  it('keeps old no-effect queued jobs selectable after upgrade but denies unreviewed resumption', async () => {
    const f = await fixture(); await project(f, 'one');
    const binding = await submit(f, { requestId: 'old-queued', projectId: 'one', operation: 'file.read', path: 'source.txt' });
    const old = f.core.authority(); f.core.close(); await writeFile(path.join(f.profile.libraryRoot, 'CLAUDE.md'), 'Upgraded runtime policy\n');
    f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, upgrade: { expectedAuthorityId: old.authorityId, expectedPolicy: old.policy } });
    expect(await f.core.get(f.credential, binding)).toMatchObject({ jobId: binding.jobId, status: 'blocked', blockerCode: 'POLICY_RECONCILIATION_REQUIRED' });
    await expect(f.core.resume(f.credential, binding)).rejects.toMatchObject({ code: 'POLICY_RECONCILIATION_REQUIRED' });
    expect((await f.core.cancel(f.credential, f.core.select(f.credential, binding.jobId))).status).toBe('cancelled');
  });
  it('denies an upgrade when live workers or an incorrect authority expectation exist', async () => {
    const f = await fixture(); await project(f, 'one', 3000);
    const binding = await submit(f, { requestId: 'live-upgrade', projectId: 'one', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, binding); const old = f.core.authority();
    await writeFile(path.join(f.profile.libraryRoot, 'CLAUDE.md'), 'Changed candidate policy\n');
    await expect(ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, upgrade: { expectedAuthorityId: old.authorityId, expectedPolicy: old.policy } })).rejects.toMatchObject({ code: 'UPGRADE_RECONCILIATION_REQUIRED' });
    await expect(ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, upgrade: { expectedAuthorityId: 'a'.repeat(64), expectedPolicy: old.policy } })).rejects.toMatchObject({ code: 'UPGRADE_AUTHORITY_DENIED' });
    expect((await f.core.get(f.credential, binding)).jobId).toBe(binding.jobId);
  }, 15000);
});
