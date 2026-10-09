import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { hash, type WorkerRow } from './store.js';
import { alive, callWorker, stopWorker } from './managed-worker.js';
import type { ProductGraceRegistration } from './grace-profile.js';
import type { ProductOperationInput, TaskBinding, WorkerObservation } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

// Replay of the I8 design review's blocker (synthetic data): a finished job whose worker crashed, as on a reboot,
// never writes stopped.json, so its kept row refused every later update and left the host control-only.
interface Fixture { root: string; library: string; profile: ProductGraceRegistration; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
async function fixture(options: { now?: () => Date } = {}): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-replay-retire-');
  const library = path.join(root, 'library');
  await mkdir(path.join(library, 'references'), { recursive: true });
  for (const filename of ['CLAUDE.md', 'AGENTS.md', 'references/agent-knowledge-workflow.md', 'KNOWLEDGE_INDEX.md']) await writeFile(path.join(library, filename), `Prepared policy ${filename}\n`);
  const profile: ProductGraceRegistration = { executable: process.execPath, libraryRoot: library, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) };
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: profile, ...options });
  const f = { root, library, profile, core, credential: core.enrollAdapter('desktop', 'owner') }; fixtures.push(f);
  const project = path.join(root, 'one'); await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'notes.txt'), 'Original\n');
  core.registerProject(f.credential, { projectId: 'one', displayName: 'one', rootPath: project });
  return f;
}
async function submit(f: Fixture, input: ProductOperationInput): Promise<TaskBinding> {
  return f.core.select(f.credential, (await f.core.submit(f.credential, f.core.prepareOperation(f.credential, input).preparationId)).jobId);
}
async function until(f: Fixture, predicate: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 300; n++) { try { await f.core.tick(); } catch { /* views carry the blocker */ } if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error('replay state did not settle: ' + JSON.stringify(await f.core.list(f.credential)));
}
function workerOf(f: Fixture, jobId: string): WorkerRow {
  const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { readOnly: true, timeout: 5000 });
  try { return db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(jobId) as unknown as WorkerRow; } finally { db.close(); }
}
/** Wait until this test's worker reports `state` with its children closed, then crash it (a kill, so it never writes stopped.json). */
async function crashWhen(worker: WorkerRow, state: string): Promise<void> {
  const settled = (observed: WorkerObservation): boolean => observed.state === state && observed.descendants.every((pid) => observed.closedDescendants?.includes(pid));
  let observed = await callWorker(worker, 'status');
  for (let n = 0; n < 300 && !settled(observed); n++) { await new Promise((resolve) => setTimeout(resolve, 30)); observed = await callWorker(worker, 'status'); }
  expect(settled(observed)).toBe(true);
  process.kill(observed.pid);
  for (let n = 0; n < 200 && alive(observed.pid); n++) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(alive(observed.pid)).toBe(false);
}
async function upgrade(f: Fixture): Promise<void> {
  const old = f.core.authority(); f.core.close();
  await writeFile(path.join(f.library, 'CLAUDE.md'), `Upgraded runtime policy ${Date.now()}\n`);
  f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, upgrade: { expectedAuthorityId: old.authorityId, expectedPolicy: old.policy } });
  expect(f.core.authority().policy).not.toBe(old.policy);
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; db.close();
    for (const worker of workers) expect(await stopWorker(worker)).toBe(true);
    try { f.core.close(); } catch { /* detached */ }
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('replayed worker retirement (incident I8)', () => {
  it('lets the next update install after a finished job\'s worker crashed', async () => {
    const f = await fixture();
    const write = await submit(f, { requestId: 'write', projectId: 'one', operation: 'file.write', path: 'notes.txt', expectedSha256: hash('Original\n'), content: 'Changed\n' });
    await f.core.resume(f.credential, write);
    const worker = workerOf(f, write.jobId);
    // The write lands, then the worker crashes before the core reconciles it.
    await crashWhen(worker, 'done');
    await until(f, async () => (await f.core.get(f.credential, write)).status === 'completed');
    expect(await readFile(path.join(f.root, 'one', 'notes.txt'), 'utf8')).toBe('Changed\n');
    expect(existsSync(path.join(worker.directory, 'stopped.json'))).toBe(false);
    await upgrade(f);
    expect((await f.core.get(f.credential, f.core.select(f.credential, write.jobId))).status).toBe('completed');
  }, 40000);

  it('retires such workers recorded by an earlier build when the host opens, so the update after that installs', async () => {
    const f = await fixture();
    const write = await submit(f, { requestId: 'write', projectId: 'one', operation: 'file.write', path: 'notes.txt', expectedSha256: hash('Original\n'), content: 'Changed\n' });
    await f.core.resume(f.credential, write);
    const worker = workerOf(f, write.jobId);
    await crashWhen(worker, 'done');
    await until(f, async () => (await f.core.get(f.credential, write)).status === 'completed');
    // An earlier build kept no retirement record.
    const old = f.core.authority(); f.core.close();
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    db.prepare('DELETE FROM gotzji_worker_history WHERE epoch=?').run(worker.epoch); db.close();
    await writeFile(path.join(f.library, 'CLAUDE.md'), 'Upgraded runtime policy\n');
    const upgrade = { expectedAuthorityId: old.authorityId, expectedPolicy: old.policy };
    // The new build's first start still refuses the update, as the host server does, and comes up control-only;
    // that open records the retirement, so the next start installs the update.
    await expect(ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, upgrade })).rejects.toMatchObject({ code: 'UPGRADE_RECONCILIATION_REQUIRED' });
    f.core = await ExecutionCore.openForControl(path.join(f.root, 'state')); f.core.close();
    f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, upgrade });
    expect(f.core.authority().policy).not.toBe(old.policy);
  }, 40000);

  it('still starts when a finished worker\'s stop record cannot be verified, and keeps refusing the update', async () => {
    const f = await fixture();
    const write = await submit(f, { requestId: 'write', projectId: 'one', operation: 'file.write', path: 'notes.txt', expectedSha256: hash('Original\n'), content: 'Changed\n' });
    await f.core.resume(f.credential, write);
    await until(f, async () => (await f.core.get(f.credential, write)).status === 'completed');
    const worker = workerOf(f, write.jobId);
    const old = f.core.authority(); f.core.close();
    // An earlier build kept no retirement record, and the stop record was damaged since.
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    db.prepare('DELETE FROM gotzji_worker_history WHERE epoch=?').run(worker.epoch); db.close();
    const stopped = path.join(worker.directory, 'stopped.json'); const record = await readFile(stopped);
    await writeFile(stopped, JSON.stringify({ body: '{}', mac: '0'.repeat(64) }));
    f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile }); f.core.close();
    await writeFile(path.join(f.library, 'CLAUDE.md'), 'Upgraded runtime policy\n');
    await expect(ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, upgrade: { expectedAuthorityId: old.authorityId, expectedPolicy: old.policy } })).rejects.toMatchObject({ code: 'UPGRADE_RECONCILIATION_REQUIRED' });
    await writeFile(stopped, record);
    f.core = await ExecutionCore.openForControl(path.join(f.root, 'state'));
  }, 40000);

  it('records a relaunched job\'s earlier worker, so the next open finds no orphan', async () => {
    let clock = new Date(); const f = await fixture({ now: () => clock });
    const prepared = f.core.prepareOperation(f.credential, { requestId: 'write', projectId: 'one', operation: 'file.write', path: 'notes.txt', expectedSha256: hash('Original\n'), content: 'Changed\n' });
    // A rule added after preparation makes the worker stop before any effect.
    await writeFile(path.join(f.root, 'one', 'CLAUDE.md'), 'Rule added after preparation\n');
    const write = f.core.select(f.credential, (await f.core.submit(f.credential, prepared.preparationId)).jobId);
    await f.core.resume(f.credential, write);
    const worker = workerOf(f, write.jobId);
    await crashWhen(worker, 'failed');
    // Fault injection: the state a reboot between launch and start leaves behind (worker gone, operation reserved).
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    db.prepare("UPDATE gotzji_operations SET phase='reserved' WHERE job_id=?").run(write.jobId); db.close();
    // The owner resumes once the dead worker's lease has lapsed; the job runs again in a new worker.
    clock = new Date(clock.getTime() + 301_000);
    await f.core.resume(f.credential, write);
    expect(workerOf(f, write.jobId).epoch).not.toBe(worker.epoch);
    await until(f, async () => (await f.core.get(f.credential, write)).status === 'failed');
    f.core.close();
    f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile });
    const history = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { readOnly: true, timeout: 5000 });
    expect(history.prepare('SELECT reason FROM gotzji_worker_history WHERE epoch=?').get(worker.epoch)).toMatchObject({ reason: 'absent' }); history.close();
    expect(await readFile(path.join(f.root, 'one', 'notes.txt'), 'utf8')).toBe('Original\n');
  }, 40000);
});
