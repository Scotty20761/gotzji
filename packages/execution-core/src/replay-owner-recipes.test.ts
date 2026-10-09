import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { type WorkerRow } from './store.js';
import { stopWorker } from './managed-worker.js';
import type { TaskBinding, ProductOperationInput } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

// Replay of a real lnwjud block (synthetic data), incident I7: real work runs project scripts (a python phase test and
// a PowerShell hash) that only an owner-approved recipe may start.
interface Fixture { root: string; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-replay-recipes-');
  const library = path.join(root, 'library');
  await mkdir(path.join(library, 'references'), { recursive: true });
  for (const filename of ['CLAUDE.md', 'AGENTS.md', 'references/agent-knowledge-workflow.md', 'KNOWLEDGE_INDEX.md']) await writeFile(path.join(library, filename), `Prepared policy ${filename}\n`);
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: { executable: process.execPath, libraryRoot: library, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) } });
  const f = { root, core, credential: core.enrollAdapter('desktop', 'owner') }; fixtures.push(f);
  f.core.registerReviewedCommand(f.credential, { recipeId: 'run', executable: process.execPath, args: ['${projectRoot}/job.mjs'], dependencies: ['${projectRoot}/job.mjs'], timeoutMs: 15000 });
  return f;
}
async function project(f: Fixture, id: string, holdMs: number): Promise<string> {
  const root = path.join(f.root, id); await mkdir(path.join(root, 'validation'), { recursive: true });
  await writeFile(path.join(root, 'job.mjs'), `console.log('begin-${id}');setTimeout(()=>console.log('end-${id}'),${holdMs});`);
  await writeFile(path.join(root, 'validation', 'test_phase2.mjs'), `console.log('phase2 checks passed for ${id}');`);
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
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    const workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; db.close();
    for (const worker of workers) await stopWorker(worker);
    try { f.core.close(); } catch { /* detached */ }
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('replayed owner recipes (incident I7)', () => {
  it('runs an owner-approved project script bound to an existing project without disturbing its running jobs', async () => {
    const f = await fixture(); await project(f, 'one', 2500);
    const running = await submit(f, { requestId: 'running', projectId: 'one', operation: 'command.run', commandId: 'run' });
    const queued = await submit(f, { requestId: 'queued', projectId: 'one', operation: 'command.run', commandId: 'run' });
    await f.core.resume(f.credential, running);
    expect(await f.core.resume(f.credential, queued)).toMatchObject({ waitingReason: 'RESOURCE_HELD' });
    f.core.registerReviewedCommand(f.credential, { recipeId: 'phase-tests', displayName: 'Phase 2 checks', executable: process.execPath, args: ['${projectRoot}/validation/test_phase2.mjs'], dependencies: ['${projectRoot}/validation/test_phase2.mjs'], timeoutMs: 15000 });
    expect(f.core.bindProjectRecipe(f.credential, { projectId: 'one', recipeId: 'phase-tests' }).recipeIds).toEqual(['run', 'phase-tests']);
    // Binding never rewrites the registration a prepared job embeds, so the running and queued jobs both finish.
    await until(f, async () => (await f.core.get(f.credential, running)).status === 'completed' && (await f.core.get(f.credential, queued)).status === 'completed');
    const phase = await submit(f, { requestId: 'phase', projectId: 'one', operation: 'command.run', commandId: 'phase-tests' });
    await f.core.resume(f.credential, phase);
    await until(f, async () => (await f.core.get(f.credential, phase)).status === 'completed');
    expect(await f.core.readOperationResult(f.credential, phase)).toMatchObject({ output: { state: 'completed', exitCode: 0 } });
    expect(f.core.logs(f.credential, phase).text).toContain('phase2 checks passed for one');
    expect(f.core.listProjects(f.credential)[0]!.recipeIds).toEqual(['run']);
    expect(() => f.core.bindProjectRecipe(f.credential, { projectId: 'one', recipeId: 'not-approved' })).toThrow(expect.objectContaining({ code: 'RECIPE_NOT_REGISTERED' }));
  }, 40000);

  it('refuses unnamed script arguments and network programs, and tells the owner when each file is pinned', async () => {
    const f = await fixture(); const tools = path.join(f.root, 'tools'); await mkdir(tools, { recursive: true });
    const pinned = path.join(tools, 'check.mjs'); await writeFile(pinned, `console.log('pinned check');`);
    const register = (args: string[], dependencies: string[] = [], executable = process.execPath): unknown => f.core.registerReviewedCommand(f.credential, { recipeId: `r${String(Math.random()).slice(2, 10)}`, executable, args, dependencies });
    expect(() => register(['validation/test_phase2.py'])).toThrow(expect.objectContaining({ field: 'args' }));
    expect(() => register(['test_phase2.py'])).toThrow(expect.objectContaining({ field: 'args' }));
    expect(() => register(['--file=${projectRoot}/x.py'])).toThrow(expect.objectContaining({ field: 'dependencies' }));
    expect(() => register([path.join(tools, 'missing.mjs')])).toThrow(expect.objectContaining({ field: 'dependencies' }));
    // Two leading slashes name a network share on every platform; two backslashes are not even absolute outside Windows.
    expect(() => register(['-I', '--check'], [], '//server/share/python.exe')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', field: 'executable' }));
    // Windows switches such as cmd's /c or msbuild's /p: are arguments, not files.
    if (process.platform === 'win32') expect(register(['/c', 'echo', '/p:Configuration=Release'])).toMatchObject({ state: 'available' });
    f.core.registerReviewedCommand(f.credential, { recipeId: 'pinned', executable: process.execPath, args: [pinned, '--file=${projectRoot}/x.mjs'], dependencies: [pinned, '${projectRoot}/x.mjs'] });
    const review = f.core.recipeReview(f.credential, 'pinned');
    expect(review).toMatchObject({ executable: process.execPath, executableSha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex') });
    expect(review.dependencies).toEqual([{ path: pinned, pinned: 'at-approval', sha256: createHash('sha256').update(await readFile(pinned)).digest('hex') }, { path: '${projectRoot}/x.mjs', pinned: 'each-run' }]);
  });

  it('fails closed when a script pinned at approval changes before the next run', async () => {
    const f = await fixture(); await project(f, 'one', 100);
    const pinned = path.join(f.root, 'tools', 'check.mjs'); await mkdir(path.dirname(pinned), { recursive: true }); await writeFile(pinned, `console.log('approved bytes');`);
    f.core.registerReviewedCommand(f.credential, { recipeId: 'pinned-check', executable: process.execPath, args: [pinned], dependencies: [pinned] });
    f.core.bindProjectRecipe(f.credential, { projectId: 'one', recipeId: 'pinned-check' });
    await writeFile(pinned, `console.log('changed after approval');`);
    expect(() => f.core.prepareOperation(f.credential, { requestId: 'changed', projectId: 'one', operation: 'command.run', commandId: 'pinned-check' })).toThrow(expect.objectContaining({ code: 'COMMAND_DEPENDENCIES_CHANGED' }));
  });

  it.runIf(process.platform === 'win32')('runs an owner-approved Windows PowerShell hash script and returns its output', async () => {
    const f = await fixture(); const root = await project(f, 'one', 100);
    await writeFile(path.join(root, 'drawing.dxf'), '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n');
    await writeFile(path.join(root, 'hash.ps1'), "(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot 'drawing.dxf')).Hash.ToLowerInvariant()\n");
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    f.core.registerReviewedCommand(f.credential, { recipeId: 'hash-drawing', executable: powershell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '${projectRoot}/hash.ps1'], dependencies: ['${projectRoot}/hash.ps1'], timeoutMs: 60000 });
    f.core.bindProjectRecipe(f.credential, { projectId: 'one', recipeId: 'hash-drawing' });
    const job = await submit(f, { requestId: 'hash', projectId: 'one', operation: 'command.run', commandId: 'hash-drawing' });
    await f.core.resume(f.credential, job);
    await until(f, async () => ['completed', 'failed', 'blocked'].includes((await f.core.get(f.credential, job)).status));
    expect(await f.core.readOperationResult(f.credential, job)).toMatchObject({ output: { state: 'completed', exitCode: 0 } });
    expect(f.core.logs(f.credential, job).text).toContain(createHash('sha256').update(await readFile(path.join(root, 'drawing.dxf'))).digest('hex'));
  }, 60000);
});
