import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { type WorkerRow } from './store.js';
import { stopWorker } from './managed-worker.js';
import type { Preparation, TaskBinding } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

// Replay of a real lnwjud gap (synthetic data), incident I5: a normal project could not deliver at all, and lnwjud read
// "Do not commit, push, release, or deploy." as a deploy request. In gotzji a delivery command is the owner's to run.
interface Fixture { root: string; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-replay-delivery-');
  const library = path.join(root, 'library');
  await mkdir(path.join(library, 'references'), { recursive: true });
  for (const filename of ['CLAUDE.md', 'AGENTS.md', 'references/agent-knowledge-workflow.md', 'KNOWLEDGE_INDEX.md']) await writeFile(path.join(library, filename), `Prepared policy ${filename}\n`);
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: { executable: process.execPath, libraryRoot: library, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) } });
  const f = { root, core, credential: core.enrollAdapter('desktop', 'owner') }; fixtures.push(f);
  return f;
}
async function run(f: Fixture, preparation: Preparation): Promise<TaskBinding> {
  const binding = f.core.select(f.credential, (await f.core.submit(f.credential, preparation.preparationId)).jobId);
  await f.core.resume(f.credential, binding);
  for (let n = 0; n < 300 && (await f.core.get(f.credential, binding)).status !== 'completed'; n++) { try { await f.core.tick(); } catch { /* views carry the blocker */ } await new Promise((resolve) => setTimeout(resolve, 30)); }
  return binding;
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

describe('replayed delivery (incident I5)', () => {
  it('lets only the owner start a delivery command, which then promotes the validated file', async () => {
    const f = await fixture(); const project = path.join(f.root, 'macro'); await mkdir(project, { recursive: true });
    await writeFile(path.join(project, 'release-candidate.txt'), 'Validated macro v2\n');
    // The promote script lives outside the project, so the owner's approval pins its bytes.
    const promote = path.join(f.root, 'tools', 'promote.mjs'); await mkdir(path.dirname(promote), { recursive: true });
    await writeFile(promote, "import { copyFileSync, mkdirSync } from 'node:fs';\nconst official = new URL('../official/', import.meta.url);\nmkdirSync(official, { recursive: true });\ncopyFileSync('release-candidate.txt', new URL('macro.txt', official));\nconsole.log('promoted');\n");
    f.core.registerReviewedCommand(f.credential, { recipeId: 'check', executable: process.execPath, args: ['--version'], dependencies: [] });
    f.core.registerReviewedCommand(f.credential, { recipeId: 'promote', displayName: 'Promote to official', executable: process.execPath, args: [promote], dependencies: [promote], delivery: true });
    f.core.registerProject(f.credential, { projectId: 'macro', displayName: 'Macro', rootPath: project, recipeIds: ['check'] });
    f.core.bindProjectRecipe(f.credential, { projectId: 'macro', recipeId: 'promote' });
    expect(f.core.recipeReview(f.credential, 'promote')).toMatchObject({ delivery: true });
    expect(f.core.catalog(f.credential).find((entry) => entry.recipeId === 'promote')).toMatchObject({ controller: 'owner', description: expect.stringContaining('the owner runs it from the gotzji app') });
    expect(f.core.catalog(f.credential).find((entry) => entry.recipeId === 'check')).toMatchObject({ controller: 'grace' });
    // Grace's path is refused before any preparation exists; an ordinary recipe still prepares there.
    expect(() => f.core.prepareOperation(f.credential, { requestId: 'grace-promote', projectId: 'macro', operation: 'command.run', commandId: 'promote' })).toThrow(expect.objectContaining({ code: 'DELIVERY_OWNER_ONLY', field: 'commandId' }));
    expect(f.core.prepareOperation(f.credential, { requestId: 'grace-check', projectId: 'macro', operation: 'command.run', commandId: 'check' })).toHaveProperty('preparationId');
    expect(await f.core.list(f.credential)).toEqual([]);
    // The owner starts it from the app, and the validated file becomes the official one.
    const binding = await run(f, f.core.prepareOperation(f.credential, { requestId: 'owner-promote', projectId: 'macro', operation: 'command.run', commandId: 'promote' }, { ownerRun: true }));
    expect(await f.core.readOperationResult(f.credential, binding)).toMatchObject({ output: { state: 'completed', exitCode: 0 } });
    expect(await readFile(path.join(f.root, 'official', 'macro.txt'), 'utf8')).toBe('Validated macro v2\n');
  }, 40000);

  it('accepts a delivery declaration only as true', async () => {
    const f = await fixture();
    expect(() => f.core.registerReviewedCommand(f.credential, { recipeId: 'odd', executable: process.execPath, args: ['--version'], dependencies: [], delivery: false as unknown as true })).toThrow(expect.objectContaining({ field: 'delivery' }));
    f.core.registerReviewedCommand(f.credential, { recipeId: 'plain', executable: process.execPath, args: ['--version'], dependencies: [] });
    expect(f.core.recipeReview(f.credential, 'plain')).toMatchObject({ delivery: false });
  });
});
