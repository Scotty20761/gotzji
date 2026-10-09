import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { type WorkerRow } from './store.js';
import { callWorker, stopWorker } from './managed-worker.js';
import type { TaskBinding, ProductOperationInput } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

// Replay of a real lnwjud block (synthetic data), incident I3: a second job in another subfolder of the same workspace
// was refused while a long job held the whole workspace.
interface Fixture { root: string; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-replay-workspace-');
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
async function project(f: Fixture, id: string, root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'job.mjs'), `import { existsSync } from 'node:fs';\nconsole.log('begin-${id}');\nconst t = setInterval(() => { console.log('progress-${id}'); if (existsSync(new URL('./release', import.meta.url))) { clearInterval(t); console.log('end-${id}'); } }, 50);\n`);
  f.core.registerProject(f.credential, { projectId: id, displayName: id, rootPath: root, recipeIds: ['run', 'run-here'] });
  return root;
}
async function submit(f: Fixture, input: ProductOperationInput): Promise<TaskBinding> {
  const job = await f.core.submit(f.credential, f.core.prepareOperation(f.credential, input).preparationId);
  return f.core.select(f.credential, job.jobId);
}
async function until(f: Fixture, predicate: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 600; n++) { try { await f.core.tick(); } catch { /* views carry the blocker */ } if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error('replay state did not settle: ' + JSON.stringify(await f.core.list(f.credential)));
}
const status = async (f: Fixture, binding: TaskBinding): Promise<string> => (await f.core.get(f.credential, binding)).status;
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; db.close();
    for (const worker of workers) await stopWorker(worker);
    try { f.core.close(); } catch { /* detached */ }
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('replayed workspace claims (incident I3)', () => {
  it('lets subfolder projects of one Git workspace write together while the workspace stays readable', async () => {
    const f = await fixture(); const workspace = path.join(f.root, 'workspace');
    await mkdir(path.join(workspace, '.git'), { recursive: true });
    await project(f, 'workspace', workspace);
    await mkdir(path.join(workspace, 'shared'), { recursive: true }); await writeFile(path.join(workspace, 'shared', 'guide.md'), 'Shared procedure\n');
    const a = await project(f, 'part-a', path.join(workspace, 'a')); await project(f, 'part-b', path.join(workspace, 'b'));
    // One repository, so all three projects share one workspace key.
    expect(new Set(f.core.listProjects(f.credential).map((entry) => entry.resourceKey)).size).toBe(1);
    const long = await submit(f, { requestId: 'long-a', projectId: 'part-a', operation: 'command.run', commandId: 'run-here' });
    await f.core.resume(f.credential, long);
    await until(f, async () => f.core.logs(f.credential, long).text.includes('progress-part-a'));
    const write = await submit(f, { requestId: 'write-b', projectId: 'part-b', operation: 'file.write', path: 'notes.txt', expectedSha256: null, content: 'Part B notes\n' });
    const read = await submit(f, { requestId: 'read-guide', projectId: 'workspace', operation: 'file.read', path: 'shared/guide.md' });
    expect(await f.core.resume(f.credential, write)).not.toHaveProperty('waitingReason');
    expect(await f.core.resume(f.credential, read)).not.toHaveProperty('waitingReason');
    await until(f, async () => await status(f, write) === 'completed' && await status(f, read) === 'completed');
    expect(f.core.logs(f.credential, long).text).not.toContain('end-part-a');
    await writeFile(path.join(a, 'release'), '');
    await until(f, async () => await status(f, long) === 'completed');
  }, 40000);

  it('keeps a whole-workspace command exclusive, and later folder jobs queue behind it instead of overtaking it', async () => {
    const f = await fixture(); const workspace = path.join(f.root, 'workspace');
    await mkdir(path.join(workspace, '.git'), { recursive: true });
    await project(f, 'workspace', workspace); const a = await project(f, 'part-a', path.join(workspace, 'a')); const b = await project(f, 'part-b', path.join(workspace, 'b'));
    const first = await submit(f, { requestId: 'first-a', projectId: 'part-a', operation: 'command.run', commandId: 'run-here' });
    await f.core.resume(f.credential, first);
    await until(f, async () => f.core.logs(f.credential, first).text.includes('progress-part-a'));
    // A command without a declared scope may touch the whole repository, so it waits for the folder job ...
    const whole = await submit(f, { requestId: 'whole', projectId: 'workspace', operation: 'command.run', commandId: 'run' });
    expect(await f.core.resume(f.credential, whole)).toMatchObject({ waitingReason: 'RESOURCE_HELD', blockingJob: first.jobId });
    // ... and later folder jobs elsewhere in the workspace wait behind it, so it cannot be starved.
    const later = await submit(f, { requestId: 'later-b', projectId: 'part-b', operation: 'command.run', commandId: 'run-here' });
    const write = await submit(f, { requestId: 'write-b', projectId: 'part-b', operation: 'file.write', path: 'notes.txt', expectedSha256: null, content: 'Part B notes\n' });
    expect(await f.core.resume(f.credential, later)).toMatchObject({ waitingReason: 'PRIORITY_WAIT', blockingJob: whole.jobId });
    expect(await f.core.resume(f.credential, write)).toMatchObject({ waitingReason: 'PRIORITY_WAIT', blockingJob: whole.jobId });
    await writeFile(path.join(a, 'release'), '');
    await until(f, async () => await status(f, first) === 'completed' && f.core.logs(f.credential, whole).text.includes('progress-workspace'));
    // While the whole-workspace command runs, nothing else in the workspace starts.
    expect(await status(f, later)).toBe('queued'); expect(await status(f, write)).toBe('queued');
    await writeFile(path.join(workspace, 'release'), '');
    await until(f, async () => await status(f, whole) === 'completed' && f.core.logs(f.credential, later).text.includes('progress-part-b'));
    await writeFile(path.join(b, 'release'), '');
    await until(f, async () => await status(f, later) === 'completed' && await status(f, write) === 'completed');
    expect(await readFile(path.join(b, 'notes.txt'), 'utf8')).toBe('Part B notes\n');
  }, 60000);

  it('keeps a stalled folder job from freezing its workspace: only the whole-workspace command waits for the owner', async () => {
    const f = await fixture(); const workspace = path.join(f.root, 'workspace');
    await mkdir(path.join(workspace, '.git'), { recursive: true });
    await project(f, 'workspace', workspace); const a = await project(f, 'part-a', path.join(workspace, 'a')); await project(f, 'part-b', path.join(workspace, 'b'));
    // Incident I1 inside a workspace: a part-a write finished, then the owner edited the file before it was verified.
    const stuck = await submit(f, { requestId: 'stuck-a', projectId: 'part-a', operation: 'file.write', path: 'notes.txt', expectedSha256: null, content: 'Approved a\n' });
    await f.core.resume(f.credential, stuck);
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { readOnly: true, timeout: 5000 });
    const worker = db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(stuck.jobId) as unknown as WorkerRow; db.close();
    for (let n = 0; n < 300 && (await callWorker(worker, 'status')).state !== 'done'; n++) await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(path.join(a, 'notes.txt'), 'Owner edit\n');
    await until(f, async () => await status(f, stuck) === 'blocked');
    const whole = await submit(f, { requestId: 'whole', projectId: 'workspace', operation: 'command.run', commandId: 'run' });
    expect(await f.core.resume(f.credential, whole)).toMatchObject({ waitingReason: 'RESOURCE_HELD', blockingJob: stuck.jobId });
    // The stalled job waits for its owner, so nothing queues behind the whole-workspace command and part-b keeps working.
    const write = await submit(f, { requestId: 'write-b', projectId: 'part-b', operation: 'file.write', path: 'notes.txt', expectedSha256: null, content: 'Part B notes\n' });
    expect(await f.core.resume(f.credential, write)).not.toHaveProperty('waitingReason');
    await until(f, async () => await status(f, write) === 'completed');
    // Once the owner settles the stalled job, the whole-workspace command runs.
    await f.core.settleBlockedJob(f.credential, stuck, 'effect-present');
    await until(f, async () => f.core.logs(f.credential, whole).text.includes('progress-workspace'));
    await writeFile(path.join(workspace, 'release'), '');
    await until(f, async () => await status(f, whole) === 'completed');
  }, 60000);

  it('claims only the folder a job writes in: siblings run together, ancestors and descendants take turns', async () => {
    // No Git: nested registrations share the workspace's key.
    const f = await fixture(); const workspace = path.join(f.root, 'plain');
    await project(f, 'workspace', workspace);
    await mkdir(path.join(workspace, 'shared'), { recursive: true }); await writeFile(path.join(workspace, 'shared', 'guide.md'), 'Shared procedure\n');
    const a = await project(f, 'part-a', path.join(workspace, 'a')); await project(f, 'part-ab', path.join(workspace, 'ab'));
    await mkdir(path.join(a, 'sub'), { recursive: true });
    expect(new Set(f.core.listProjects(f.credential).map((entry) => entry.resourceKey)).size).toBe(1);
    const long = await submit(f, { requestId: 'long-a', projectId: 'part-a', operation: 'command.run', commandId: 'run-here' });
    await f.core.resume(f.credential, long);
    await until(f, async () => f.core.logs(f.credential, long).text.includes('progress-part-a'));
    // A sibling whose name extends part-a's, and a workspace file outside part-a, are not part-a's folder.
    // (One at a time: with part-a's job, two writes would fill both write slots.)
    const sibling = await submit(f, { requestId: 'write-ab', projectId: 'part-ab', operation: 'file.write', path: 'notes.txt', expectedSha256: null, content: 'AB\n' });
    expect(await f.core.resume(f.credential, sibling)).not.toHaveProperty('waitingReason');
    await until(f, async () => await status(f, sibling) === 'completed');
    const guide = await submit(f, { requestId: 'write-guide', projectId: 'workspace', operation: 'file.write', path: 'shared/guide.md', expectedSha256: createHash('sha256').update('Shared procedure\n').digest('hex'), content: 'Shared procedure, revised\n' });
    expect(await f.core.resume(f.credential, guide)).not.toHaveProperty('waitingReason');
    await until(f, async () => await status(f, guide) === 'completed');
    // A write inside part-a waits for part-a's job, and a job on the whole workspace folder waits behind that write.
    const inside = await submit(f, { requestId: 'write-inside', projectId: 'part-a', operation: 'file.write', path: 'sub/x.txt', expectedSha256: null, content: 'inside\n' });
    expect(await f.core.resume(f.credential, inside)).toMatchObject({ waitingReason: 'RESOURCE_HELD', blockingJob: long.jobId });
    const ancestor = await submit(f, { requestId: 'ancestor', projectId: 'workspace', operation: 'command.run', commandId: 'run-here' });
    expect(await f.core.resume(f.credential, ancestor)).toMatchObject({ waitingReason: 'PRIORITY_WAIT', blockingJob: inside.jobId });
    expect(f.core.logs(f.credential, long).text).not.toContain('end-part-a');
    await writeFile(path.join(a, 'release'), '');
    await until(f, async () => await status(f, inside) === 'completed' && f.core.logs(f.credential, ancestor).text.includes('progress-workspace'));
    await writeFile(path.join(workspace, 'release'), '');
    await until(f, async () => await status(f, ancestor) === 'completed' && await status(f, long) === 'completed');
  }, 60000);

  it('keys a drive root once and compares folders by whole names, with no wildcard characters', async () => {
    const { claimsOverlap, folderClaim } = await import('./product-projects.js');
    const root = path.parse(process.cwd()).root; const work = path.join(root, 'Work');
    expect(folderClaim('g', root)).toBe(`folder:g:${root.toLowerCase()}`);
    expect(folderClaim('g', path.join(work, 'A'))).toBe(`folder:g:${path.join(work, 'A').toLowerCase()}${path.sep}`);
    expect(claimsOverlap(folderClaim('g', root), folderClaim('g', path.join(work, 'A')))).toBe(true);
    expect(claimsOverlap(folderClaim('g', path.join(work, 'A')), folderClaim('g', path.join(work, 'A', 'sub')))).toBe(true);
    expect(claimsOverlap(folderClaim('g', path.join(work, 'A')), folderClaim('g', path.join(work, 'AB')))).toBe(false);
    expect(claimsOverlap(folderClaim('g', path.join(work, 'A_1')), folderClaim('g', path.join(work, 'A%1')))).toBe(false);
    expect(claimsOverlap('project:g', folderClaim('g', path.join(work, 'A')))).toBe(true);
    expect(claimsOverlap('project:g', folderClaim('h', path.join(work, 'A')))).toBe(false);
    expect(claimsOverlap(folderClaim('g', work), folderClaim('h', work))).toBe(false);
    expect(claimsOverlap('globalui:windows', 'project:g')).toBe(false);
  });

  it('records a declared write scope with the recipe and shows the default as the whole workspace', async () => {
    const f = await fixture();
    expect(() => f.core.registerReviewedCommand(f.credential, { recipeId: 'odd', executable: process.execPath, args: ['--version'], dependencies: [], writeScope: 'repository' as 'project' })).toThrow(expect.objectContaining({ field: 'writeScope' }));
    expect(f.core.recipeReview(f.credential, 'run-here')).toMatchObject({ writeScope: 'project' });
    expect(f.core.recipeReview(f.credential, 'run')).toMatchObject({ writeScope: 'workspace' });
    // Recipes without a scope keep their stored form, so re-registering them stays idempotent.
    expect(() => f.core.registerReviewedCommand(f.credential, { recipeId: 'run', executable: process.execPath, args: ['${projectRoot}/job.mjs'], dependencies: ['${projectRoot}/job.mjs'], timeoutMs: 30000 })).not.toThrow();
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { readOnly: true, timeout: 5000 });
    const stored = db.prepare("SELECT recipe FROM gotzji_reviewed_recipes WHERE recipe_id='run'").get(); db.close();
    expect(JSON.parse(String(stored?.recipe))).not.toHaveProperty('writeScope');
  });
});
