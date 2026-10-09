import { existsSync, lstatSync } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { type WorkerRow } from './store.js';
import { stopWorker } from './managed-worker.js';
import type { ProductGraceRegistration } from './grace-profile.js';
import type { ProductOperationInput, TaskBinding } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

// Replay of incident I8's retention gap (synthetic data): lnwjud kept no bounded history, and gotzji kept every job's
// worker and effect folders forever. A finished job's folders go 30 days after it ended, or oldest first above the
// size cap; its record stays.
const DAY = 24 * 60 * 60 * 1000;
interface Fixture { root: string; profile: ProductGraceRegistration; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
async function fixture(now: () => Date): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-replay-retention-');
  const library = path.join(root, 'library');
  await mkdir(path.join(library, 'references'), { recursive: true });
  for (const filename of ['CLAUDE.md', 'AGENTS.md', 'references/agent-knowledge-workflow.md', 'KNOWLEDGE_INDEX.md']) await writeFile(path.join(library, filename), `Prepared policy ${filename}\n`);
  const profile: ProductGraceRegistration = { executable: process.execPath, libraryRoot: library, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) };
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: profile, now });
  const f = { root, profile, core, credential: core.enrollAdapter('desktop', 'owner') }; fixtures.push(f);
  f.core.registerReviewedCommand(f.credential, { recipeId: 'run', executable: process.execPath, args: ['${projectRoot}/job.mjs'], dependencies: ['${projectRoot}/job.mjs'], timeoutMs: 60000 });
  const project = path.join(root, 'one'); await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'notes.txt'), 'Original\n');
  // A command that runs until a `release` file appears in the project folder.
  await writeFile(path.join(project, 'job.mjs'), "import { existsSync } from 'node:fs';\nconst t = setInterval(() => { console.log('progress'); if (existsSync(new URL('./release', import.meta.url))) clearInterval(t); }, 50);\n");
  f.core.registerProject(f.credential, { projectId: 'one', displayName: 'one', rootPath: project, recipeIds: ['run'] });
  return f;
}
async function submit(f: Fixture, input: ProductOperationInput): Promise<TaskBinding> {
  return f.core.select(f.credential, (await f.core.submit(f.credential, f.core.prepareOperation(f.credential, input).preparationId)).jobId);
}
async function until(f: Fixture, predicate: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 300; n++) { try { await f.core.tick(); } catch { /* views carry the blocker */ } if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error('replay state did not settle: ' + JSON.stringify(await f.core.list(f.credential)));
}
async function read(f: Fixture, requestId: string): Promise<TaskBinding> {
  const binding = await submit(f, { requestId, projectId: 'one', operation: 'file.read', path: 'notes.txt' });
  await f.core.resume(f.credential, binding);
  await until(f, async () => (await f.core.get(f.credential, binding)).status === 'completed');
  return binding;
}
function database(f: Fixture): DatabaseSync { return new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { readOnly: true, timeout: 5000 }); }
/** The worker and effect folders retention would remove for this job. */
function folders(f: Fixture, jobId: string): string[] {
  const db = database(f);
  try {
    const epochs = db.prepare('SELECT epoch FROM gotzji_workers WHERE job_id=? UNION SELECT epoch FROM gotzji_worker_history WHERE job_id=?').all(jobId, jobId).map((row) => String(row.epoch));
    return [...epochs.map((epoch) => path.join(f.root, 'state', 'workers', epoch)), path.join(f.root, 'state', 'effects', jobId)];
  } finally { db.close(); }
}
function events(f: Fixture, jobId: string, event: string): number {
  const db = database(f);
  try { return Number(db.prepare('SELECT COUNT(*) AS count FROM gotzji_job_events WHERE job_id=? AND event=?').get(jobId, event)?.count); } finally { db.close(); }
}
async function bytes(target: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) total += await bytes(child); else if (entry.isFile()) total += (await lstat(child)).size;
  }
  return total;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    const workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[];
    const retired = new Set(db.prepare('SELECT epoch FROM gotzji_worker_history').all().map((row) => String(row.epoch))); db.close();
    for (const worker of workers) {
      // Retention removes only the folder of a worker already proven stopped and retired; every other one must prove its stop.
      if (!existsSync(worker.directory)) { expect(retired.has(worker.epoch)).toBe(true); continue; }
      expect(await stopWorker(worker)).toBe(true);
    }
    try { f.core.close(); } catch { /* detached */ }
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('replayed retention (incident I8)', () => {
  it('removes a finished job\'s folders 30 days after it ended, keeps its record, and never touches live or younger work', async () => {
    let clock = new Date(); const f = await fixture(() => clock);
    const old = await read(f, 'old');
    clock = new Date(clock.getTime() + 2 * DAY);
    const recent = await read(f, 'recent');
    // 31 days after the first job ended, and 29 after the second, while a command is running.
    clock = new Date(clock.getTime() + 29 * DAY);
    const running = await submit(f, { requestId: 'running', projectId: 'one', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, running);
    await until(f, async () => f.core.logs(f.credential, running).text.includes('progress'));
    expect(folders(f, old.jobId).some((folder) => existsSync(folder))).toBe(false);
    expect(folders(f, recent.jobId).every((folder) => existsSync(folder))).toBe(true);
    expect(folders(f, running.jobId).every((folder) => existsSync(folder))).toBe(true);
    // The record stays; its logs read as expired and its result as RESULT_EXPIRED.
    expect(await f.core.get(f.credential, old)).toMatchObject({ jobId: old.jobId, status: 'completed' });
    expect(f.core.logs(f.credential, old)).toEqual({ text: '', nextCursor: 0, expired: true });
    await expect(f.core.readOperationResult(f.credential, old)).rejects.toMatchObject({ code: 'RESULT_EXPIRED' });
    expect(await f.core.readOperationResult(f.credential, recent)).toMatchObject({ output: { content: 'Original\n' } });
    expect(events(f, old.jobId, 'RETENTION_PRUNED')).toBe(1);
    await writeFile(path.join(f.root, 'one', 'release'), '');
    await until(f, async () => (await f.core.get(f.credential, running)).status === 'completed');
    // The next hourly pass finds nothing more to do.
    clock = new Date(clock.getTime() + 61 * 60 * 1000);
    await f.core.tick();
    expect(events(f, old.jobId, 'RETENTION_PRUNED')).toBe(1);
    expect(folders(f, recent.jobId).every((folder) => existsSync(folder))).toBe(true);
    expect(folders(f, running.jobId).every((folder) => existsSync(folder))).toBe(true);
  }, 60000);

  it('leaves a worker folder that was replaced by a link, records that once, and still removes the rest', async () => {
    let clock = new Date(); const f = await fixture(() => clock);
    const old = await read(f, 'old');
    const [workerFolder, effectFolder] = folders(f, old.jobId) as [string, string];
    // Something replaced the finished worker's folder with a link to an unrelated folder.
    const unrelated = path.join(f.root, 'unrelated'); await mkdir(unrelated); await writeFile(path.join(unrelated, 'keep.txt'), 'keep\n');
    const moved = path.join(f.root, 'moved-worker'); await rename(workerFolder, moved);
    await symlink(unrelated, workerFolder, 'junction');
    clock = new Date(clock.getTime() + 31 * DAY);
    await f.core.tick();
    expect(lstatSync(workerFolder).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(unrelated, 'keep.txt'))).toBe(true);
    expect(existsSync(effectFolder)).toBe(false);
    expect(events(f, old.jobId, 'RETENTION_PRUNE_FAILED')).toBe(1);
    expect(events(f, old.jobId, 'RETENTION_PRUNED')).toBe(0);
    // A removal that stopped partway still reads as expired.
    expect(f.core.logs(f.credential, old)).toEqual({ text: '', nextCursor: 0, expired: true });
    await expect(f.core.readOperationResult(f.credential, old)).rejects.toMatchObject({ code: 'RESULT_EXPIRED' });
    clock = new Date(clock.getTime() + 61 * 60 * 1000);
    await f.core.tick();
    expect(events(f, old.jobId, 'RETENTION_PRUNE_FAILED')).toBe(1);
    // Put the real folder back so the teardown can prove the worker stopped.
    await unlink(workerFolder); await rename(moved, workerFolder);
  }, 60000);

  it('removes the oldest finished jobs first while their folders exceed the size cap', async () => {
    let clock = new Date(); const f = await fixture(() => clock);
    const first = await read(f, 'first');
    clock = new Date(clock.getTime() + DAY); const second = await read(f, 'second');
    clock = new Date(clock.getTime() + DAY); const third = await read(f, 'third');
    // A cap that removing the oldest job alone satisfies.
    let oldest = 0; for (const folder of folders(f, first.jobId)) oldest += await bytes(folder);
    const total = await bytes(path.join(f.root, 'state', 'workers')) + await bytes(path.join(f.root, 'state', 'effects'));
    f.core.close();
    clock = new Date(clock.getTime() + 2 * 60 * 60 * 1000);
    f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, now: () => clock, retentionBytes: total - oldest });
    await f.core.tick();
    expect(folders(f, first.jobId).some((folder) => existsSync(folder))).toBe(false);
    expect(folders(f, second.jobId).every((folder) => existsSync(folder))).toBe(true);
    expect(folders(f, third.jobId).every((folder) => existsSync(folder))).toBe(true);
    expect(events(f, first.jobId, 'RETENTION_PRUNED')).toBe(1);
  }, 60000);
});
