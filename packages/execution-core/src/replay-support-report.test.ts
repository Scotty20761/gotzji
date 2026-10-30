import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { hash, type WorkerRow } from './store.js';
import { stopWorker } from './managed-worker.js';
import type { Preparation, TaskBinding } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

// Replay of lnwjud's incident report (synthetic data), incident I8: it gave no reason for each failed call, its load
// meter read 0 and it called 12 failures inconclusive. gotzji's owner report names every reason and every holder.
interface Fixture { root: string; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-replay-report-');
  const library = path.join(root, 'library');
  await mkdir(path.join(library, 'references'), { recursive: true });
  for (const filename of ['CLAUDE.md', 'AGENTS.md', 'references/agent-knowledge-workflow.md', 'KNOWLEDGE_INDEX.md']) await writeFile(path.join(library, filename), `Prepared policy ${filename}\n`);
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: { executable: process.execPath, libraryRoot: library, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) } });
  const f = { root, core, credential: core.enrollAdapter('desktop', 'owner') }; fixtures.push(f);
  const job = { executable: process.execPath, args: ['${projectRoot}/job.mjs'], dependencies: ['${projectRoot}/job.mjs'], timeoutMs: 30000 };
  f.core.registerReviewedCommand(f.credential, { recipeId: 'run', ...job });
  f.core.registerReviewedCommand(f.credential, { recipeId: 'run-here', ...job, writeScope: 'project' });
  return f;
}
/** A project whose command runs until a `release` file appears in the project folder. */
async function project(f: Fixture, id: string): Promise<string> {
  const root = path.join(f.root, id); await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'job.mjs'), `import { existsSync } from 'node:fs';\nconst t = setInterval(() => { console.log('progress-${id}'); if (existsSync(new URL('./release', import.meta.url))) clearInterval(t); }, 50);\n`);
  f.core.registerProject(f.credential, { projectId: id, displayName: id, rootPath: root, recipeIds: ['run', 'run-here'] });
  return root;
}
async function start(f: Fixture, preparation: Preparation): Promise<TaskBinding> {
  const binding = f.core.select(f.credential, (await f.core.submit(f.credential, preparation.preparationId)).jobId);
  await f.core.resume(f.credential, binding);
  return binding;
}
async function until(f: Fixture, predicate: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 600; n++) { try { await f.core.tick(); } catch { /* views carry the blocker */ } if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error('replay state did not settle: ' + JSON.stringify(await f.core.list(f.credential)));
}
const status = async (f: Fixture, binding: TaskBinding): Promise<string> => (await f.core.get(f.credential, binding)).status;
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    const workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; db.close();
    for (const worker of workers) await stopWorker(worker);
    try { f.core.close(); } catch { /* detached */ }
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('replayed support report (incident I8)', () => {
  it('names every failure, counts them by reason and shows who holds what, with no path or request text', async () => {
    const f = await fixture();
    const one = await project(f, 'one'); const two = await project(f, 'two'); const three = await project(f, 'three');
    // A command refused because its script changed after it was prepared.
    const prepared = f.core.prepareOperation(f.credential, { requestId: 'changed-script', projectId: 'one', operation: 'command.run', commandId: 'run' });
    await writeFile(path.join(one, 'job.mjs'), 'console.log("changed");');
    const changed = await start(f, prepared);
    // A write refused by a rule added after it was prepared.
    await writeFile(path.join(two, 'notes.txt'), 'Original\n');
    const write = f.core.prepareOperation(f.credential, { requestId: 'policy-drift', projectId: 'two', operation: 'file.write', path: 'notes.txt', expectedSha256: hash('Original\n'), content: 'Changed\n' });
    await writeFile(path.join(two, 'CLAUDE.md'), 'Rules added after preparation\n');
    const refused = await start(f, write);
    await until(f, async () => await status(f, changed) === 'failed' && await status(f, refused) === 'failed');
    // A folder job holds project three while a whole-workspace command waits for it.
    const holder = await start(f, f.core.prepareOperation(f.credential, { requestId: 'holder', projectId: 'three', operation: 'command.run', commandId: 'run-here' }));
    await until(f, async () => f.core.logs(f.credential, holder).text.includes('progress-three'));
    const waiter = f.core.select(f.credential, (await f.core.submit(f.credential, f.core.prepareOperation(f.credential, { requestId: 'waiter', projectId: 'three', operation: 'command.run', commandId: 'run' }).preparationId)).jobId);
    expect(await f.core.resume(f.credential, waiter)).toMatchObject({ waitingReason: 'RESOURCE_HELD', blockingJob: holder.jobId });

    const report = await f.core.supportReport(f.credential, { eventLoopDelayMs: { p50: 1, p99: 2, max: 3 } });
    expect(report.counts.failuresBySummary).toMatchObject({ COMMAND_DEPENDENCIES_CHANGED: 1, PROJECT_POLICY_CHANGED: 1 });
    expect(report.counts.jobsByGoalStatus).toMatchObject({ failed: 2, active: 2 });
    const job = (binding: TaskBinding): typeof report.jobs[number] | undefined => report.jobs.find((entry) => entry.jobId === binding.jobId);
    expect(job(changed)).toMatchObject({ status: 'failed', summary: 'COMMAND_DEPENDENCIES_CHANGED', projectId: 'one', operation: 'command.run', requestIdHash: hash('changed-script').slice(0, 12) });
    expect(job(changed)?.events.map((entry) => entry.event)).toContain('COMMAND_DEPENDENCIES_CHANGED');
    expect(job(refused)).toMatchObject({ status: 'failed', summary: 'PROJECT_POLICY_CHANGED', projectId: 'two', operation: 'file.write' });
    expect(job(waiter)).toMatchObject({ status: 'queued', waitingReason: 'RESOURCE_HELD', blockingJob: holder.jobId, blockingResource: expect.stringMatching(/^folder:[a-f0-9]{12}$/u) });
    expect(report.holders).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'writer', jobId: holder.jobId, resource: expect.stringMatching(/^folder:[a-f0-9]{12}$/u) })]));
    expect(report.queue).toEqual([expect.objectContaining({ jobId: waiter.jobId, waitingReason: 'RESOURCE_HELD', blockingJob: holder.jobId })]);
    expect(report.providers).toMatchObject({ browserConfigured: false, libraryConfigured: false });
    expect(report.providers.native.length).toBeGreaterThan(0);
    expect(report.providers.native.every((entry) => entry.state === 'unsupported')).toBe(true);
    expect(report.host).toEqual({ eventLoopDelayMs: { p50: 1, p99: 2, max: 3 } });
    // Nothing that names a place or a request leaves in the report (JSON doubles backslashes, so check both forms).
    const text = JSON.stringify(report); const escaped = (value: string): string => JSON.stringify(value).slice(1, -1);
    for (const secret of [f.root, f.root.toLowerCase(), one, two, three, 'changed-script', 'policy-drift', 'notes.txt']) {
      expect(text).not.toContain(secret); expect(text).not.toContain(escaped(secret));
    }
    // Provider text that once reached a code (a path or document name) is withheld, as a summary, a blocker and a count.
    const leaked = "ENOENT: no such file or directory, open 'C:\\Users\\owner\\Client Report.xlsx'";
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { timeout: 5000 });
    db.prepare('UPDATE goals SET terminal_summary=? WHERE id=(SELECT goal_id FROM gotzji_claims WHERE id=?)').run(leaked, refused.jobId);
    db.prepare('INSERT INTO gotzji_diagnostics VALUES (?,?,?)').run(waiter.jobId, leaked, new Date().toISOString()); db.close();
    const withheld = await f.core.supportReport(f.credential);
    expect(withheld.counts.failuresBySummary).toMatchObject({ PROVIDER_FAILURE_REDACTED: 1 });
    expect(withheld.counts.diagnosticsByCode).toEqual({ PROVIDER_FAILURE_REDACTED: 1 });
    expect(withheld.jobs.find((entry) => entry.jobId === refused.jobId)).toMatchObject({ summary: 'PROVIDER_FAILURE_REDACTED' });
    expect(withheld.jobs.find((entry) => entry.jobId === waiter.jobId)).toMatchObject({ blockerCode: 'PROVIDER_FAILURE_REDACTED' });
    expect(JSON.stringify(withheld)).not.toContain('Client Report');
    await writeFile(path.join(three, 'release'), '');
    await until(f, async () => await status(f, holder) === 'completed');
  }, 60000);

  it('keeps provider failure text out of failure codes at the source', async () => {
    const { providerFailureCode } = await import('./product-security.mjs');
    expect(providerFailureCode(Object.assign(new Error('open failed'), { code: 'EPERM' }), 'NATIVE_PROVIDER_FAILED')).toBe('EPERM');
    expect(providerFailureCode(new Error('NATIVE_SCRIPT_CHANGED'), 'NATIVE_PROVIDER_FAILED')).toBe('NATIVE_SCRIPT_CHANGED');
    expect(providerFailureCode(new Error("ENOENT: no such file or directory, open 'C:\\Users\\owner\\Report.xlsx'"), 'NATIVE_PROVIDER_FAILED')).toBe('NATIVE_PROVIDER_FAILED');
    expect(providerFailureCode(Object.assign(new Error('x'), { code: 'not a code' }), 'LIBRARY_EXECUTION_FAILED')).toBe('LIBRARY_EXECUTION_FAILED');
    expect(providerFailureCode(undefined, 'LIBRARY_EXECUTION_FAILED')).toBe('LIBRARY_EXECUTION_FAILED');
  });
});
