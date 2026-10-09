import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { type WorkerRow } from './store.js';
import { callWorker, stopWorker } from './managed-worker.js';
import type { TaskBinding, ProductOperationInput } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

// Replay of a real lnwjud block (synthetic data), incident I2: read-only work waited behind long-running writes.
interface Fixture { root: string; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-replay-reads-');
  const library = path.join(root, 'library');
  await mkdir(path.join(library, 'references'), { recursive: true });
  for (const filename of ['CLAUDE.md', 'AGENTS.md', 'references/agent-knowledge-workflow.md', 'KNOWLEDGE_INDEX.md']) await writeFile(path.join(library, filename), `Prepared policy ${filename}\n`);
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: { executable: process.execPath, libraryRoot: library, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) } });
  const f = { root, core, credential: core.enrollAdapter('desktop', 'owner') }; fixtures.push(f);
  f.core.registerReviewedCommand(f.credential, { recipeId: 'run', executable: process.execPath, args: ['${projectRoot}/job.mjs'], dependencies: ['${projectRoot}/job.mjs'], timeoutMs: 15000 });
  return f;
}
async function project(f: Fixture, id: string, holdMs: number): Promise<string> {
  const root = path.join(f.root, id); await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'source.txt'), `Original ${id}\n`);
  await writeFile(path.join(root, 'job.mjs'), `console.log('begin-${id}');const t=setInterval(()=>console.log('progress-${id}'),100);setTimeout(()=>{clearInterval(t);console.log('end-${id}');},${holdMs});`);
  f.core.registerProject(f.credential, { projectId: id, displayName: id, rootPath: root, recipeIds: ['run'] });
  return root;
}
async function submit(f: Fixture, input: ProductOperationInput): Promise<TaskBinding> {
  const job = await f.core.submit(f.credential, f.core.prepareOperation(f.credential, input).preparationId);
  return f.core.select(f.credential, job.jobId);
}
async function until(f: Fixture, predicate: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 300; n++) { try { await f.core.tick(); } catch { /* views carry the blocker */ } if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error('replay state did not settle: ' + JSON.stringify(await f.core.list(f.credential)));
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    const workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; db.close();
    for (const worker of workers) await stopWorker(worker);
    try { f.core.close(); } catch { /* detached */ }
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('replayed read blocks (incident I2)', () => {
  it('reads beside long commands and a queued write, waiting at most for another read', async () => {
    const f = await fixture();
    // The commands outlast the test; teardown stops them through their owned workers.
    for (const id of ['one', 'two', 'three', 'four']) await project(f, id, 20000);
    const one = await submit(f, { requestId: 'long-one', projectId: 'one', operation: 'command.run', commandId: 'run' });
    const two = await submit(f, { requestId: 'long-two', projectId: 'two', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, one); await f.core.resume(f.credential, two);
    await until(f, async () => f.core.logs(f.credential, one).text.includes('progress-one') && f.core.logs(f.credential, two).text.includes('progress-two'));
    const queuedWrite = await submit(f, { requestId: 'long-four', projectId: 'four', operation: 'command.run', commandId: 'run' });
    expect(await f.core.resume(f.credential, queuedWrite)).toMatchObject({ status: 'queued', waitingReason: 'WORKER_CAPACITY' });
    const sameProject = await submit(f, { requestId: 'read-one', projectId: 'one', operation: 'file.read', path: 'source.txt' });
    const otherProject = await submit(f, { requestId: 'read-three', projectId: 'three', operation: 'file.read', path: 'source.txt' });
    expect(await f.core.resume(f.credential, sameProject)).not.toHaveProperty('waitingReason');
    const second = await f.core.resume(f.credential, otherProject);
    if (second.waitingReason) expect(second).toMatchObject({ waitingReason: 'WORKER_CAPACITY', blockingJob: sameProject.jobId });
    await until(f, async () => (await f.core.get(f.credential, sameProject)).status === 'completed' && (await f.core.get(f.credential, otherProject)).status === 'completed');
    expect(f.core.logs(f.credential, one).text).not.toContain('end-one');
    expect(await f.core.readOperationResult(f.credential, sameProject)).toMatchObject({ output: { content: 'Original one\n' } });
    expect((await f.core.get(f.credential, queuedWrite)).status).toBe('queued');
  }, 40000);

  it('ends a read whose file changed after preparation as failed and frees its slot', async () => {
    const f = await fixture(); const root = await project(f, 'one', 100);
    const stale = await submit(f, { requestId: 'stale-read', projectId: 'one', operation: 'file.read', path: 'source.txt' });
    await writeFile(path.join(root, 'source.txt'), 'Changed after the read was prepared\n');
    try { await f.core.resume(f.credential, stale); } catch { /* the conflict may surface at resume or in the worker */ }
    await until(f, async () => (await f.core.get(f.credential, stale)).status === 'failed');
    expect(await f.core.get(f.credential, stale)).toMatchObject({ status: 'failed', summary: 'FILE_VERSION_CONFLICT' });
    await expect(f.core.readOperationResult(f.credential, stale)).rejects.toMatchObject({ code: 'RESULT_NOT_VERIFIED' });
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_writers WHERE job_id=?').get(stale.jobId)).toMatchObject({ count: 0 }); db.close();
    const fresh = await submit(f, { requestId: 'fresh-read', projectId: 'one', operation: 'file.read', path: 'source.txt' });
    await f.core.resume(f.credential, fresh);
    await until(f, async () => (await f.core.get(f.credential, fresh)).status === 'completed');
    expect(await f.core.readOperationResult(f.credential, fresh)).toMatchObject({ output: { content: 'Changed after the read was prepared\n' } });
  }, 30000);

  it('ends a read whose worker died before recording its result as failed, so its slot never strands', async () => {
    const f = await fixture(); for (const id of ['one', 'two', 'three']) await project(f, id, 20000);
    const doomed = await submit(f, { requestId: 'doomed', projectId: 'three', operation: 'file.read', path: 'source.txt' });
    await f.core.resume(f.credential, doomed);
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(doomed.jobId) as unknown as WorkerRow; db.close();
    for (let i = 0; i < 100 && (await callWorker(worker, 'status')).state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 30));
    // A crash before the result was recorded: the process is gone, no stopped record, last observation running, no result.
    expect(await stopWorker(worker)).toBe(true);
    await unlink(path.join(worker.directory, 'stopped.json'));
    await unlink(path.join(f.root, 'state', 'effects', doomed.jobId, 'result.txt'));
    const observation = path.join(worker.directory, 'observation.json');
    const body = JSON.stringify({ ...(JSON.parse((JSON.parse(await readFile(observation, 'utf8')) as { body: string }).body) as object), state: 'running' });
    await writeFile(observation, JSON.stringify({ body, mac: createHmac('sha256', worker.token).update(body).digest('hex') }));
    await until(f, async () => (await f.core.get(f.credential, doomed)).status === 'failed');
    const one = await submit(f, { requestId: 'long-one', projectId: 'one', operation: 'command.run', commandId: 'run' });
    const two = await submit(f, { requestId: 'long-two', projectId: 'two', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, one); await f.core.resume(f.credential, two);
    const fresh = await submit(f, { requestId: 'fresh', projectId: 'three', operation: 'file.read', path: 'source.txt' });
    expect(await f.core.resume(f.credential, fresh)).not.toHaveProperty('waitingReason');
    await until(f, async () => (await f.core.get(f.credential, fresh)).status === 'completed');
  }, 40000);
});
