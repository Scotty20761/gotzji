import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionCore } from './core.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import type { ProductBrowserInput, TrustedProductBrowserOptions, TrustedProductBrowserSessionManifest } from './product-browser.js';

const lifecycleBytes = vi.hoisted(() => ({ changed: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: ((file: Parameters<typeof actual.readFileSync>[0], ...options: unknown[]) => {
    const bytes = (actual.readFileSync as (...parameters: unknown[]) => string | Buffer)(file, ...options);
    return lifecycleBytes.changed && /[/\\]project-lifecycle\.(?:ts|js)$/u.test(String(file))
      ? typeof bytes === 'string' ? `${bytes}\n// changed lifecycle contract` : Buffer.concat([bytes, Buffer.from('\n// changed lifecycle contract')]) : bytes;
  }) as typeof actual.readFileSync };
});

const roots: string[] = [];
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('gotzji-project-lifecycle-')) throw new Error('FIXTURE_SCOPE_DENIED');
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(now = new Date('2026-10-22T06:00:00.000Z')): Promise<{
  root: string; state: string; policy: string; project: string; core: ExecutionCore; app: string; chat: string; foreign: string;
}> {
  const root = await canonicalTemporaryDirectory('gotzji-project-lifecycle-'); roots.push(root);
  const state = path.join(root, 'state'); const policy = path.join(root, 'policy'); const project = path.join(root, 'project');
  await mkdir(project); await writeFile(path.join(project, 'AGENTS.md'), 'Current project rules\n'); await writeFile(path.join(project, 'note.txt'), 'original file\n');
  ensureProductControlDocuments(policy);
  const core = await ExecutionCore.open(state, { now: () => now, product: { mode: 'host-direct', libraryRoot: policy } });
  const app = core.enrollAdapter('desktop', 'owner'); const chat = core.enrollAdapter('chatgpt', 'owner'); const foreign = core.enrollAdapter('foreign', 'other-owner');
  core.registerProject(app, { projectId: 'project', displayName: 'Project', rootPath: project });
  return { root, state, policy, project, core, app, chat, foreign };
}

describe('app-only project archive and restore', () => {
  it('refuses lifecycle mutation when the lifecycle contract bytes change after Core opens', async () => {
    const f = await fixture();
    try {
      lifecycleBytes.changed = true;
      expect(() => f.core.setProjectArchived(f.app, { projectId: 'project', archived: true })).toThrow('CORE_DEPENDENCIES_CHANGED');
      expect(f.core.listManagedProjects(f.app)[0]!.archivedAt).toBeNull();
    } finally { lifecycleBytes.changed = false; f.core.close(); }
  });

  it.each(['selection', 'recipe', 'memory'] as const)('serializes %s writes with a second Core archiving the project', async (operation) => {
    const f = await fixture();
    const peer = await ExecutionCore.open(f.state, { product: { mode: 'host-direct', libraryRoot: f.policy } });
    let capturePeer = true; const peerConnections: DatabaseSync[] = []; let interleave = false; let attempted = false; let archived = false;
    const prepare = DatabaseSync.prototype.prepare;
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (capturePeer) peerConnections.push(this);
      const statement = prepare.call(this, sql);
      if (interleave && sql.includes('SELECT p.registration,l.archived_at,l.generation')) {
        const get = statement.get.bind(statement);
        statement.get = (...parameters: Parameters<typeof get>): ReturnType<typeof get> => {
          const row = get(...parameters);
          if (!attempted) {
            attempted = true;
            try { peer.setProjectArchived(f.app, { projectId: 'project', archived: true }); archived = true; }
            catch (error) { if (!(error instanceof Error) || !error.message.includes('database is locked')) throw error; }
          }
          return row;
        };
      }
      return statement;
    });
    try {
      peer.listManagedProjects(f.app); capturePeer = false; peerConnections.at(-1)!.exec('PRAGMA busy_timeout=0;');
      f.core.registerReviewedCommand(f.app, { recipeId: 'race-check', executable: process.execPath, args: ['--version'], dependencies: [] });
      interleave = true;
      const write = (): unknown => operation === 'selection' ? f.core.selectProject(f.app, 'project') : operation === 'recipe'
        ? f.core.bindProjectRecipe(f.app, { projectId: 'project', recipeId: 'race-check' })
        : f.core.saveProjectMemory(f.chat, { projectId: 'project', expectedRevision: 0, memory: { summary: 'saved before archive', decisions: [], openQuestions: [], resultPaths: [] } });
      expect(write).not.toThrow();
      expect(attempted).toBe(true);
      expect(archived).toBe(false);
      interleave = false;
      peer.setProjectArchived(f.app, { projectId: 'project', archived: true });
      peer.setProjectArchived(f.app, { projectId: 'project', archived: false });
      expect(f.core.selectedProject(f.chat)).toBeNull();
      if (operation === 'recipe') expect(f.core.projectRecipeIds(f.app, f.core.listProjects(f.app)[0]!)).toContain('race-check');
      if (operation === 'memory') expect((await f.core.projectContext(f.chat, 'project')).memory.revision).toBe(1);
    } finally { spy.mockRestore(); peer.close(); f.core.close(); }
  });

  it('persists archive state, clears selection, and retains files, memory, recipe bindings and canonical history', async () => {
    const f = await fixture(); let core = f.core;
    try {
      const recipe = core.registerReviewedCommand(f.app, { recipeId: 'check', executable: process.execPath, args: ['--version'], dependencies: [] });
      core.bindProjectRecipe(f.app, { projectId: 'project', recipeId: recipe.recipeId! });
      const memory = { summary: 'Continue this project', decisions: ['Keep canonical history'], openQuestions: ['Next task'], resultPaths: ['result.md'] };
      core.saveProjectMemory(f.chat, { projectId: 'project', expectedRevision: 0, memory });
      core.selectProject(f.app, 'project');
      const preparation = core.prepareOperation(f.chat, { requestId: 'history', projectId: 'project', operation: 'file.write', path: 'future.txt', expectedSha256: null, content: 'never written' });
      const job = await core.submit(f.chat, preparation.preparationId); const binding = core.select(f.chat, job.jobId);
      expect((await core.cancel(f.chat, binding)).status).toBe('cancelled');

      const archived = core.setProjectArchived(f.app, { projectId: 'project', archived: true });
      expect(archived.archivedAt).toBe('2026-10-22T06:00:00.000Z');
      expect(core.listProjects(f.chat)).toEqual([]); expect(core.selectedProject(f.chat)).toBeNull();
      expect(core.listManagedProjects(f.app)).toMatchObject([{ projectId: 'project', archivedAt: '2026-10-22T06:00:00.000Z' }]);
      await expect(core.readProjectFile(f.chat, { projectId: 'project', path: 'note.txt' })).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      await expect(core.listProjectFiles(f.chat, { projectId: 'project' })).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      await expect(core.searchProjectFiles(f.chat, { projectId: 'project', query: 'original' })).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      await expect(core.readProjectGit(f.chat, { projectId: 'project', view: 'status' })).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      expect(() => core.prepareOperation(f.chat, { requestId: 'archived', projectId: 'project', operation: 'file.write', path: 'blocked.txt', expectedSha256: null, content: 'blocked' })).toThrow('PROJECT_ARCHIVED');
      expect(() => core.selectProject(f.chat, 'project')).toThrow('PROJECT_ARCHIVED');
      expect(() => core.saveProjectMemory(f.chat, { projectId: 'project', expectedRevision: 1, memory })).toThrow('PROJECT_ARCHIVED');
      expect(() => core.bindProjectRecipe(f.app, { projectId: 'project', recipeId: recipe.recipeId! })).toThrow('PROJECT_ARCHIVED');
      expect(() => core.setProjectArchived(f.foreign, { projectId: 'project', archived: true })).toThrow('PROJECT_NOT_REGISTERED');
      expect((await core.list(f.chat)).map((entry) => entry.jobId)).toContain(job.jobId);
      expect((await core.get(f.chat, binding)).status).toBe('cancelled');
      expect(await readFile(path.join(f.project, 'note.txt'), 'utf8')).toBe('original file\n');

      core.close();
      core = await ExecutionCore.open(f.state, { now: () => new Date('2026-10-22T07:00:00.000Z'), product: { mode: 'host-direct', libraryRoot: f.policy } });
      expect(core.listProjects(f.chat)).toEqual([]);
      expect(core.listManagedProjects(f.chat)[0]).toMatchObject({ projectId: 'project', displayName: 'Project', archivedAt: '2026-10-22T06:00:00.000Z' });
      expect(core.setProjectArchived(f.app, { projectId: 'project', archived: false }).archivedAt).toBeNull();
      expect(core.selectedProject(f.chat)).toBeNull();
      const context = await core.projectContext(f.chat, 'project');
      expect(context.memory).toMatchObject({ revision: 1, summary: memory.summary, resultPaths: ['result.md'] });
      expect(context.jobs.map((entry) => entry.jobId)).toContain(job.jobId);
      expect(core.projectRecipeIds(f.chat, context.project)).toContain('check');
      expect(await readFile(path.join(f.project, 'note.txt'), 'utf8')).toBe('original file\n');
      expect(() => core.registerProject(f.app, { projectId: 'overlap', displayName: 'Overlap', rootPath: f.project })).not.toThrow();
      expect(core.listManagedProjects(f.app).find((entry) => entry.projectId === 'overlap')?.resourceKey).toBe(context.project.resourceKey);
    } finally { core.close(); }
  });

  it('refuses queued and retained project authority without cancelling or cleaning it', async () => {
    const f = await fixture();
    try {
      const preAssociation = f.core.prepareOperation(f.chat, { requestId: 'pre-association', projectId: 'project', operation: 'file.write', path: 'gap.txt', expectedSha256: null, content: 'gap' });
      const gap = new DatabaseSync(path.join(f.state, 'core.sqlite'));
      const prepared = gap.prepare('SELECT digest,input,policy FROM gotzji_preparations WHERE id=?').get(preAssociation.preparationId)!;
      const gapJob = digest('owner\0pre-association');
      try { gap.prepare('INSERT INTO gotzji_claims VALUES (?,?,?,?,?,?,NULL,?)').run(gapJob, 'owner', 'pre-association', prepared.digest, prepared.input, `gotzji-${gapJob}`, prepared.policy); }
      finally { gap.close(); }
      expect(() => f.core.setProjectArchived(f.app, { projectId: 'project', archived: true })).toThrow('PROJECT_BUSY');
      const removeGap = new DatabaseSync(path.join(f.state, 'core.sqlite'));
      try { expect(removeGap.prepare('SELECT 1 FROM gotzji_product_jobs WHERE job_id=?').get(gapJob)).toBeUndefined(); removeGap.prepare('DELETE FROM gotzji_claims WHERE id=?').run(gapJob); }
      finally { removeGap.close(); }

      const preparation = f.core.prepareOperation(f.chat, { requestId: 'busy', projectId: 'project', operation: 'file.write', path: 'busy.txt', expectedSha256: null, content: 'queued' });
      const job = await f.core.submit(f.chat, preparation.preparationId); const binding = f.core.select(f.chat, job.jobId);
      expect(() => f.core.setProjectArchived(f.app, { projectId: 'project', archived: true })).toThrow('PROJECT_BUSY');
      expect((await f.core.get(f.chat, binding)).status).toBe('queued');
      await f.core.cancel(f.chat, binding);
      const database = new DatabaseSync(path.join(f.state, 'core.sqlite'));
      try { database.prepare('INSERT INTO gotzji_resource_claims VALUES (?,?,?)').run(`project:${f.core.listProjects(f.app)[0]!.resourceKey}`, job.jobId, 'retained-test-epoch'); }
      finally { database.close(); }
      expect(() => f.core.setProjectArchived(f.app, { projectId: 'project', archived: true })).toThrow('PROJECT_BUSY');
      expect(f.core.listProjects(f.app)).toHaveLength(1);
      const cleanup = new DatabaseSync(path.join(f.state, 'core.sqlite'));
      try { cleanup.prepare('DELETE FROM gotzji_resource_claims WHERE job_id=? AND epoch=?').run(job.jobId, 'retained-test-epoch'); }
      finally { cleanup.close(); }
      expect(f.core.setProjectArchived(f.app, { projectId: 'project', archived: true }).archivedAt).not.toBeNull();
    } finally { f.core.close(); }
  });

  it('invalidates an unsubmitted preparation across archive and restore while preserving admitted replay', async () => {
    const f = await fixture();
    try {
      const stale = f.core.prepareOperation(f.chat, { requestId: 'stale', projectId: 'project', operation: 'file.write', path: 'stale.txt', expectedSha256: null, content: 'must not run' });
      f.core.setProjectArchived(f.app, { projectId: 'project', archived: true });
      f.core.setProjectArchived(f.app, { projectId: 'project', archived: false });
      await expect(f.core.submit(f.chat, stale.preparationId)).rejects.toMatchObject({ code: 'PROJECT_LIFECYCLE_CHANGED' });
      await expect(readFile(path.join(f.project, 'stale.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const current = f.core.prepareOperation(f.chat, { requestId: 'admitted', projectId: 'project', operation: 'file.write', path: 'admitted.txt', expectedSha256: null, content: 'queued' });
      const job = await f.core.submit(f.chat, current.preparationId); const binding = f.core.select(f.chat, job.jobId); await f.core.cancel(f.chat, binding);
      f.core.setProjectArchived(f.app, { projectId: 'project', archived: true });
      const replay = f.core.prepareOperation(f.chat, { requestId: 'admitted', projectId: 'project', operation: 'file.write', path: 'admitted.txt', expectedSha256: null, content: 'queued' });
      expect((await f.core.submit(f.chat, replay.preparationId)).jobId).toBe(job.jobId);
      expect((await f.core.get(f.chat, binding)).status).toBe('cancelled');
    } finally { f.core.close(); }
  });

  it('rejects an async provider preparation when archive and restore change the captured generation', async () => {
    const root = await canonicalTemporaryDirectory('gotzji-project-lifecycle-'); roots.push(root);
    const state = path.join(root, 'state'); const policy = path.join(root, 'policy'); const project = path.join(root, 'project'); const browser = path.join(root, 'gotzji');
    await mkdir(project); await mkdir(browser); ensureProductControlDocuments(policy);
    const executable = path.join(browser, 'chrome.exe'); const prerequisite = path.join(browser, 'provider.mjs'); const profilePath = path.join(browser, 'gotzji-browser-provider-owned');
    await mkdir(profilePath); await writeFile(executable, 'fixture chrome'); await writeFile(prerequisite, 'fixture provider');
    const binding = { browserId: 'browser', contextId: 'context', profileId: 'profile', tabId: 'tab', providerTabId: 'native-tab', url: 'http://127.0.0.1:12345/fixture', documentId: 'document' };
    const session: TrustedProductBrowserSessionManifest = { schemaVersion: 1, sessionId: 'session', owner: 'owner', projectId: 'project', pid: 12345, pidBirth: 'birth', executable, executableSha256: digest('fixture chrome'), profilePath, port: 12345, cdpBrowserContextId: 'context', binding, allowedOrigins: ['http://127.0.0.1:12345'], fixtureMode: true };
    const manifestPath = path.join(browser, 'browser-session.json'); const manifest = JSON.stringify(session); await writeFile(manifestPath, manifest);
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; }); const barrier = new Promise<void>((resolve) => { release = resolve; });
    const browserOptions: TrustedProductBrowserOptions = { session, manifestPath, manifestSha256: digest(manifest), prerequisites: [{ path: prerequisite, hash: digest('fixture provider') }], verifyOwnedSession: async () => { entered(); await barrier; return true; }, deadlineMs: 1000 };
    const core = await ExecutionCore.open(state, { product: { mode: 'host-direct', libraryRoot: policy }, browserOptions });
    try {
      const app = core.enrollAdapter('desktop', 'owner'); const chat = core.enrollAdapter('chatgpt', 'owner');
      core.registerProject(app, { projectId: 'project', displayName: 'Project', rootPath: project });
      const input: ProductBrowserInput = { requestId: 'browser-race', projectId: 'project', operation: 'browser.read', sessionId: 'session', tabId: 'tab', expectedUrl: binding.url, expectedDocumentId: binding.documentId, selector: 'body' };
      const pending = core.prepareOperation(chat, input); await waiting;
      core.setProjectArchived(app, { projectId: 'project', archived: true }); core.setProjectArchived(app, { projectId: 'project', archived: false }); release();
      await expect(pending).rejects.toMatchObject({ code: 'PROJECT_LIFECYCLE_CHANGED' });
    } finally { release(); core.close(); }
  });
});
