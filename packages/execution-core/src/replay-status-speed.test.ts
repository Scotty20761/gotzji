import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { type WorkerRow } from './store.js';
import { stopWorker } from './managed-worker.js';
import type { ProductOperationInput, TaskBinding } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

// Replay of a real lnwjud slowdown (synthetic data), incident I8: listing tasks took 10.9 s. gotzji's status must stay
// fast with a long history and live work.
interface Fixture { root: string; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-replay-status-');
  const library = path.join(root, 'library');
  await mkdir(path.join(library, 'references'), { recursive: true });
  for (const filename of ['CLAUDE.md', 'AGENTS.md', 'references/agent-knowledge-workflow.md', 'KNOWLEDGE_INDEX.md']) await writeFile(path.join(library, filename), `Prepared policy ${filename}\n`);
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: { executable: process.execPath, libraryRoot: library, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) } });
  const f = { root, core, credential: core.enrollAdapter('desktop', 'owner') }; fixtures.push(f);
  f.core.registerReviewedCommand(f.credential, { recipeId: 'run', executable: process.execPath, args: ['${projectRoot}/job.mjs'], dependencies: ['${projectRoot}/job.mjs'], timeoutMs: 60000 });
  return f;
}
/** A project whose command runs until a `release` file appears in the project folder. */
async function project(f: Fixture, id: string): Promise<string> {
  const root = path.join(f.root, id); await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'job.mjs'), `import { existsSync } from 'node:fs';\nconst t = setInterval(() => { console.log('progress-${id}'); if (existsSync(new URL('./release', import.meta.url))) clearInterval(t); }, 50);\n`);
  f.core.registerProject(f.credential, { projectId: id, displayName: id, rootPath: root, recipeIds: ['run'] });
  return root;
}
async function submit(f: Fixture, input: ProductOperationInput): Promise<TaskBinding> {
  return f.core.select(f.credential, (await f.core.submit(f.credential, f.core.prepareOperation(f.credential, input).preparationId)).jobId);
}
async function until(f: Fixture, predicate: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 600; n++) { try { await f.core.tick(); } catch { /* views carry the blocker */ } if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error('replay state did not settle');
}
/** Seeded clones have worker rows but never a process; teardown proves stops only for real workers. */
const seeded = new Set<string>();
/** Clone one finished job as `count` finished jobs, the shape of a long-lived host's history. */
function seedHistory(f: Fixture, jobId: string, count: number): void {
  const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
  try {
    const goalId = String(db.prepare('SELECT goal_id FROM gotzji_claims WHERE id=?').get(jobId)?.goal_id);
    db.exec('BEGIN IMMEDIATE;');
    db.prepare('CREATE TEMP TABLE seed_goal AS SELECT * FROM goals WHERE id=?').run(goalId);
    // A goal's snapshot requires one checkpoint per revision.
    db.prepare('CREATE TEMP TABLE seed_checkpoints AS SELECT * FROM goal_checkpoints WHERE goal_id=?').run(goalId);
    const seq = Number(db.prepare('SELECT COALESCE(MAX(enqueue_seq),0) AS seq FROM gotzji_queue').get()?.seq);
    for (const table of ['gotzji_claims', 'gotzji_product_jobs', 'gotzji_operations', 'gotzji_workers', 'gotzji_queue']) db.prepare(`CREATE TEMP TABLE seed_${table} AS SELECT * FROM ${table} WHERE ${table === 'gotzji_claims' ? 'id' : 'job_id'}=?`).run(jobId);
    for (let n = 0; n < count; n++) {
      const id = randomBytes(32).toString('hex'); const goal = randomBytes(16).toString('hex'); seeded.add(id);
      db.prepare('UPDATE seed_goal SET id=?, goal_key=?').run(goal, `gotzji-${id}`); db.exec('INSERT INTO goals SELECT * FROM seed_goal;');
      db.prepare("UPDATE seed_checkpoints SET id=? || '-' || revision, goal_id=?").run(goal, goal); db.exec('INSERT INTO goal_checkpoints SELECT * FROM seed_checkpoints;');
      db.prepare('UPDATE seed_gotzji_claims SET id=?, request_id=?, goal_key=?, goal_id=?').run(id, `history-${n}`, `gotzji-${id}`, goal); db.exec('INSERT INTO gotzji_claims SELECT * FROM seed_gotzji_claims;');
      db.prepare('UPDATE seed_gotzji_product_jobs SET job_id=?').run(id); db.exec('INSERT INTO gotzji_product_jobs SELECT * FROM seed_gotzji_product_jobs;');
      db.prepare('UPDATE seed_gotzji_operations SET job_id=?').run(id); db.exec('INSERT INTO gotzji_operations SELECT * FROM seed_gotzji_operations;');
      db.prepare('UPDATE seed_gotzji_workers SET job_id=?, epoch=?').run(id, randomBytes(16).toString('hex')); db.exec('INSERT INTO gotzji_workers SELECT * FROM seed_gotzji_workers;');
      db.prepare('UPDATE seed_gotzji_queue SET job_id=?, enqueue_seq=?').run(id, seq + n + 1); db.exec('INSERT INTO gotzji_queue SELECT * FROM seed_gotzji_queue;');
    }
    db.exec('COMMIT;');
  } finally { db.close(); }
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    const workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; db.close();
    // Every worker this test started must be proven stopped; a silent failure here leaks a live process.
    for (const worker of workers) if (!seeded.has(worker.job_id)) expect(await stopWorker(worker)).toBe(true);
    try { f.core.close(); } catch { /* detached */ }
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('replayed status speed (incident I8)', () => {
  it('lists the newest page, one job and the queue quickly beside 3,000 finished jobs and live work', async () => {
    const f = await fixture();
    const a = await project(f, 'a'); const b = await project(f, 'b');
    await writeFile(path.join(a, 'release'), '');
    const finished = await submit(f, { requestId: 'finished', projectId: 'a', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, finished);
    await until(f, async () => (await f.core.get(f.credential, finished)).status === 'completed');
    await rm(path.join(a, 'release'));
    seedHistory(f, finished.jobId, 3000);
    // Live work: two long commands, and 30 jobs queued behind the first.
    const long = await submit(f, { requestId: 'long-a', projectId: 'a', operation: 'command.run', commandId: 'run' });
    const other = await submit(f, { requestId: 'long-b', projectId: 'b', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, long); await f.core.resume(f.credential, other);
    await until(f, async () => f.core.logs(f.credential, long).text.includes('progress-a') && f.core.logs(f.credential, other).text.includes('progress-b'));
    const queued: TaskBinding[] = [];
    for (let n = 0; n < 30; n++) { const binding = await submit(f, { requestId: `queued-${n}`, projectId: 'a', operation: 'command.run', commandId: 'run' }); queued.push(binding); await f.core.resume(f.credential, binding); }

    const timed = async <T>(action: () => Promise<T>): Promise<{ value: T; ms: number }> => { const started = performance.now(); const value = await action(); return { value, ms: Math.round(performance.now() - started) }; };
    const first = await timed(() => f.core.list(f.credential));
    const one = await timed(() => f.core.get(f.credential, long));
    const queue = await timed(() => f.core.inspectQueue(f.credential));
    console.log(`status with 3,033 jobs: list ${first.ms} ms, get ${one.ms} ms, queue ${queue.ms} ms`);
    expect(first.value).toHaveLength(100);
    expect(first.value[0]?.requestId).toBe('queued-29');
    expect(queue.value).toHaveLength(30);
    expect(queue.value.map((view) => view.queuePosition)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(first.ms).toBeLessThan(2000); expect(one.ms).toBeLessThan(500); expect(queue.ms).toBeLessThan(1000);
    // Paging continues where the page ended, without overlap.
    const next = await f.core.list(f.credential, { before: first.value[99]!.jobId });
    expect(next).toHaveLength(100);
    expect(next.some((view) => first.value.some((seen) => seen.jobId === view.jobId))).toBe(false);
    await expect(f.core.list(f.credential, { limit: 0 })).rejects.toMatchObject({ field: 'limit' });
    await expect(f.core.list(f.credential, { before: 'f'.repeat(64) })).rejects.toMatchObject({ field: 'before' });
    // Only active work is checked when the browser asks whether anything is running.
    // A channel lists only its own jobs, however many others are newer.
    expect((await f.core.list(f.credential, { operation: 'command.run', projectIds: ['b'] })).map((view) => view.jobId)).toEqual([other.jobId]);
    expect(await f.core.list(f.credential, { projectIds: [] })).toEqual([]);
    expect((await f.core.activeJobs(f.credential)).map((view) => view.jobId)).toEqual(expect.arrayContaining([long.jobId, other.jobId]));
    expect(await f.core.activeJobs(f.credential)).toHaveLength(32);
    // Leave nothing running: cancel the queue, then let both commands finish.
    for (const binding of queued) await f.core.cancel(f.credential, binding);
    await writeFile(path.join(a, 'release'), ''); await writeFile(path.join(b, 'release'), '');
    await until(f, async () => (await f.core.get(f.credential, long)).status === 'completed' && (await f.core.get(f.credential, other)).status === 'completed');
  }, 120000);
});
