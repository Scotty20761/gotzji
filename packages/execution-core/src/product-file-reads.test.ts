import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { ExecutionCore } from './core.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import { productBrokerCall } from './product-broker.mjs';

const fixtures: { root: string; core: ExecutionCore; credential?: string }[] = [];
async function fixture(protectNested = false, driver?: (root: string) => Promise<string>): Promise<{ root: string; core: ExecutionCore; credential: string; projectRoot: string }> {
  const root = await canonicalTemporaryDirectory('gotzji-direct-reads-');
  const libraryRoot = path.join(root, 'policy');
  ensureProductControlDocuments(libraryRoot);
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot);
  if (protectNested) await mkdir(path.join(projectRoot, 'internal'));
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: { executable: process.execPath, libraryRoot, ...(driver ? { testDriver: await driver(root) } : {}) }, privateRuntimeRoots: protectNested ? [path.join(projectRoot, 'internal')] : [] });
  const registered: { root: string; core: ExecutionCore; credential?: string } = { root, core }; fixtures.push(registered);
  const credential = core.enrollAdapter('desktop', 'owner');
  registered.credential = credential;
  core.registerProject(credential, { projectId: 'project', displayName: 'Synthetic project', rootPath: projectRoot });
  return { root, core, credential, projectRoot };
}
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const { root, core, credential } of fixtures.splice(0)) {
    if (credential) for (const job of await core.activeJobs(credential)) await core.cancel(credential, core.select(credential, job.jobId));
    core.close();
    await rm(root, { recursive: true, force: true });
  }
});

describe('direct project file reads', () => {
  it('pins legacy preparation to its opened file when a private hard link is swapped after the path check', async () => {
    const f = await fixture(true);
    const target = path.join(f.projectRoot, 'note.txt'); const secret = path.join(f.projectRoot, 'internal', 'private.txt');
    await writeFile(target, 'public'); await writeFile(secret, 'PRIVATE_RUNTIME_BYTES');
    const original = fs.openSync; let swapped = false;
    vi.spyOn(fs, 'openSync').mockImplementation((filename, flags, mode) => {
      if (filename === target && !swapped) { swapped = true; fs.renameSync(target, target + '.original'); fs.linkSync(secret, target); }
      return original(filename, flags, mode);
    });
    syncBuiltinESMExports();
    expect(() => f.core.prepareOperation(f.credential, { requestId: 'legacy-swap', projectId: 'project', operation: 'file.read', path: 'note.txt' })).toThrow('FILE_LINK_SCOPE_DENIED');
    expect(swapped).toBe(true);
    expect(await f.core.list(f.credential)).toEqual([]);
  });
  it('refuses an NTFS hard link to protected runtime bytes', async () => {
    const f = await fixture(true);
    const protectedFile = path.join(f.projectRoot, 'internal', 'private.txt');
    await writeFile(protectedFile, 'PRIVATE_RUNTIME_BYTES');
    await link(protectedFile, path.join(f.projectRoot, 'alias.txt'));
    await expect(f.core.readProjectFile(f.credential, { projectId: 'project', path: 'alias.txt' })).rejects.toMatchObject({ code: 'FILE_LINK_SCOPE_DENIED' });
    expect(await f.core.searchProjectFiles(f.credential, { projectId: 'project', query: 'PRIVATE_RUNTIME_BYTES' })).toMatchObject({ matches: [], truncated: true });
  });
  it('rejects valid UTF-8 binary control bytes rather than treating them as text', async () => {
    const f = await fixture();
    await writeFile(path.join(f.projectRoot, 'binary.bin'), Buffer.from([0, 1, 2, 10, 65]));
    await expect(f.core.readProjectFile(f.credential, { projectId: 'project', path: 'binary.bin' })).rejects.toMatchObject({ code: 'FILE_ENCODING_UNSUPPORTED' });
    expect(await f.core.searchProjectFiles(f.credential, { projectId: 'project', query: 'A' })).toMatchObject({ matches: [], skippedCount: 1, incompleteReasons: ['FILE_ENCODING_UNSUPPORTED'] });
  });
  it('reads while a real admitted command is still running', async () => {
    const f = await fixture(false, async () => fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)));
    await writeFile(path.join(f.projectRoot, 'note.txt'), 'hello\n');
    await writeFile(path.join(f.projectRoot, 'job.mjs'), "console.log('running');setInterval(()=>console.log('progress'),100);");
    f.core.registerReviewedCommand(f.credential, { recipeId: 'long', executable: process.execPath, args: ['${projectRoot}/job.mjs'], dependencies: ['${projectRoot}/job.mjs'], timeoutMs: 20000, writeScope: 'project' });
    f.core.bindProjectRecipe(f.credential, { projectId: 'project', recipeId: 'long' });
    const job = await f.core.submit(f.credential, f.core.prepareOperation(f.credential, { requestId: 'long-command', projectId: 'project', operation: 'command.run', commandId: 'long' }).preparationId);
    const binding = f.core.select(f.credential, job.jobId); await f.core.resume(f.credential, binding);
    for (let attempt = 0; attempt < 150 && !f.core.logs(f.credential, binding).text.includes('progress'); attempt++) { await f.core.tick(); await new Promise((resolve) => setTimeout(resolve, 50)); }
    expect(f.core.logs(f.credential, binding).text).toContain('progress');
    expect(await f.core.readProjectFile(f.credential, { projectId: 'project', path: 'note.txt' })).toMatchObject({ content: 'hello\n' });
    expect((await f.core.get(f.credential, binding)).status).toBe('running');
  }, 30000);
  it('reads despite an actual provider-limit receipt and adds no second job', async () => {
    const f = await fixture(false, async (root) => {
      const driver = path.join(root, 'quota-driver.mjs');
      await writeFile(driver, `import{readFileSync}from'node:fs';import{fullTools}from${JSON.stringify(new URL('./grace-broker.mjs', import.meta.url).href)};const c=JSON.parse(readFileSync(process.argv[2],'utf8'));console.log(JSON.stringify({type:'system',subtype:'init',tools:fullTools(c),apiKeySource:'none',model:'explicit-quota-test-driver'}));console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'seven_day',resetsAt:${Math.floor(Date.now() / 1000) + 3600}}}));console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true}));`);
      return driver;
    });
    await writeFile(path.join(f.projectRoot, 'note.txt'), 'hello\n');
    const job = await f.core.submit(f.credential, f.core.prepareOperation(f.credential, { requestId: 'quota-write', projectId: 'project', operation: 'file.write', path: 'write.txt', expectedSha256: null, content: 'not written' }).preparationId);
    const binding = f.core.select(f.credential, job.jobId); await f.core.resume(f.credential, binding);
    for (let attempt = 0; attempt < 150 && (await f.core.get(f.credential, binding)).blockerCode !== 'GRACE_ACCOUNT_LIMIT'; attempt++) { await f.core.tick(); await new Promise((resolve) => setTimeout(resolve, 50)); }
    expect(await f.core.get(f.credential, binding)).toMatchObject({ blockerCode: 'GRACE_ACCOUNT_LIMIT' });
    expect(await f.core.readProjectFile(f.credential, { projectId: 'project', path: 'note.txt' })).toMatchObject({ content: 'hello\n' });
    expect(await f.core.list(f.credential)).toHaveLength(1);
  }, 30000);
  it('returns a complete old or new version during atomic replacements', async () => {
    const f = await fixture(false, async () => fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)));
    const target = path.join(f.projectRoot, 'note.txt');
    const before = 'A'.repeat(65536); const after = 'B'.repeat(65536);
    await writeFile(target, before);
    const version = await f.core.readProjectFile(f.credential, { projectId: 'project', path: 'note.txt' });
    const job = await f.core.submit(f.credential, f.core.prepareOperation(f.credential, { requestId: 'replace', projectId: 'project', operation: 'file.write', path: 'note.txt', expectedSha256: version.sha256, content: after }).preparationId);
    const binding = f.core.select(f.credential, job.jobId); await f.core.resume(f.credential, binding);
    for (let index = 0; index < 150 && (await f.core.get(f.credential, binding)).status !== 'completed'; index++) {
      const read = await f.core.readProjectFile(f.credential, { projectId: 'project', path: 'note.txt' });
      expect([before, after]).toContain(read.content);
      expect(read.sha256).toBe(read.content === before ? version.sha256 : 'fee47b1f0d7685a226fd5f2b9dd8f525038bbb05fe9d89a5d75c249edac868e3');
      await f.core.tick(); await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await f.core.get(f.credential, binding)).status).toBe('completed');
    expect(await f.core.readProjectFile(f.credential, { projectId: 'project', path: 'note.txt' })).toMatchObject({ content: after });
  }, 30000);
  it('rechecks original bytes after a deterministic filesystem refusal in the real admitted broker', async () => {
    const f = await fixture(false, async (root) => {
      const driver = path.join(root, 'hold-driver.mjs');
      await writeFile(driver, `import{readFileSync}from'node:fs';import{fullTools}from${JSON.stringify(new URL('./grace-broker.mjs', import.meta.url).href)};const c=JSON.parse(readFileSync(process.argv[2],'utf8'));console.log(JSON.stringify({type:'system',subtype:'init',tools:fullTools(c),apiKeySource:'none',model:'explicit-hold-driver'}));await new Promise(r=>setTimeout(r,30000));`);
      return driver;
    });
    const target = path.join(f.projectRoot, 'note.txt'); await writeFile(target, 'original');
    const version = await f.core.readProjectFile(f.credential, { projectId: 'project', path: 'note.txt' });
    const job = await f.core.submit(f.credential, f.core.prepareOperation(f.credential, { requestId: 'retry-check', projectId: 'project', operation: 'file.write', path: 'note.txt', expectedSha256: version.sha256, content: 'approved replacement' }).preparationId);
    const binding = f.core.select(f.credential, job.jobId);
    await f.core.resume(f.credential, binding);
    const epochs = await readdir(path.join(f.root, 'state', 'workers'));
    const config = JSON.parse(await readFile(path.join(f.root, 'state', 'workers', epochs[0]!, 'config.json'), 'utf8'));
    for (const document of Object.keys(config.grace.documents)) productBrokerCall(config, 'read_policy', { document }, true);
    const original = fs.renameSync; let attempts = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      attempts++;
      if (attempts === 1) { fs.writeFileSync(target, 'external owner change'); throw Object.assign(new Error('held'), { code: 'EPERM' }); }
      original(source, destination);
    });
    syncBuiltinESMExports();
    expect(() => productBrokerCall(config, 'execute_operation', {}, true)).toThrow('FILE_VERSION_CONFLICT');
    expect(attempts).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('external owner change');
    vi.restoreAllMocks(); syncBuiltinESMExports();
    try { await f.core.cancel(f.credential, binding); } catch (error) { expect(error).toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' }); }
    // The synthetic owner inspected the external change; settle only this disposable test's stopped operation.
    await f.core.settleBlockedJob(f.credential, binding, 'no-effect');
  }, 30000);
  it('enforces the byte budget independently of its elapsed-time limit', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 33 }, (_, index) => writeFile(path.join(f.projectRoot, `${index}.txt`), 'a'.repeat(1024 * 1024))));
    vi.spyOn(performance, 'now').mockReturnValue(0);
    expect(await f.core.searchProjectFiles(f.credential, { projectId: 'project', query: 'missing' })).toMatchObject({ matches: [], truncated: true, incompleteReasons: ['BYTE_LIMIT'] });
  }, 20000);
  it('preserves empty results and rejects missing, binary and oversized files with reasons', async () => {
    const f = await fixture();
    expect(await f.core.listProjectFiles(f.credential, { projectId: 'project' })).toMatchObject({ entries: [], truncated: false });
    expect(await f.core.searchProjectFiles(f.credential, { projectId: 'project', query: 'missing' })).toMatchObject({ matches: [], truncated: false });
    await expect(f.core.readProjectFile(f.credential, { projectId: 'project', path: 'missing.txt' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', field: 'path', reason: expect.any(String) });
    await writeFile(path.join(f.projectRoot, 'binary.bin'), Buffer.from([255, 254, 0]));
    await writeFile(path.join(f.projectRoot, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
    await expect(f.core.readProjectFile(f.credential, { projectId: 'project', path: 'binary.bin' })).rejects.toMatchObject({ code: 'FILE_ENCODING_UNSUPPORTED' });
    await expect(f.core.readProjectFile(f.credential, { projectId: 'project', path: 'large.txt' })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await f.core.searchProjectFiles(f.credential, { projectId: 'project', query: 'missing' })).toMatchObject({ matches: [], truncated: true, skippedCount: 2, incompleteReasons: expect.arrayContaining(['FILE_ENCODING_UNSUPPORTED', 'FILE_TOO_LARGE']) });
  });
  it('denies another owner, traversal, Windows junctions and nested private-runtime content', async () => {
    const f = await fixture(true);
    const other = f.core.enrollAdapter('plugin', 'other-owner');
    await writeFile(path.join(f.projectRoot, 'internal', 'secret.txt'), 'DO_NOT_RETURN');
    await mkdir(path.join(f.root, 'outside'));
    await writeFile(path.join(f.root, 'outside', 'outside.txt'), 'DO_NOT_RETURN');
    await symlink(path.join(f.root, 'outside'), path.join(f.projectRoot, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.core.readProjectFile(other, { projectId: 'project', path: 'internal/secret.txt' })).rejects.toMatchObject({ code: 'PROJECT_NOT_REGISTERED' });
    await expect(f.core.readProjectFile(f.credential, { projectId: 'project', path: '../outside/outside.txt' })).rejects.toMatchObject({ field: 'path' });
    await expect(f.core.readProjectFile(f.credential, { projectId: 'project', path: 'link/outside.txt' })).rejects.toMatchObject({ code: 'FILE_SCOPE_CHANGED' });
    await expect(f.core.readProjectFile(f.credential, { projectId: 'project', path: 'internal/secret.txt' })).rejects.toMatchObject({ code: 'PRIVATE_RUNTIME_SCOPE_DENIED' });
    expect(await f.core.listProjectFiles(f.credential, { projectId: 'project' })).toMatchObject({ entries: [], truncated: true, skippedCount: 2 });
    expect(await f.core.searchProjectFiles(f.credential, { projectId: 'project', query: 'DO_NOT_RETURN' })).toMatchObject({ matches: [], truncated: true, skippedCount: 2 });
  });
  it('marks list and search truncation instead of returning a falsely complete answer', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(path.join(f.projectRoot, `${index}.txt`), 'match\n')));
    expect(await f.core.listProjectFiles(f.credential, { projectId: 'project' })).toMatchObject({ entries: expect.any(Array), truncated: true, incompleteReasons: ['ENTRY_LIMIT'] });
    const matches = await f.core.searchProjectFiles(f.credential, { projectId: 'project', query: 'match' });
    expect(matches.matches).toHaveLength(100);
    expect(matches).toMatchObject({ truncated: true, incompleteReasons: ['MATCH_LIMIT'] });
  }, 20000);
  it('bounds the serialized response for a long matching line', async () => {
    const f = await fixture();
    await writeFile(path.join(f.projectRoot, 'long.txt'), 'match' + 'a'.repeat(70 * 1024));
    const result = await f.core.searchProjectFiles(f.credential, { projectId: 'project', query: 'match' });
    expect(result).toMatchObject({ truncated: true, incompleteReasons: ['RESPONSE_LIMIT'] });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
  });
  it('reports the elapsed search budget and rejects executable or extra operation fields', async () => {
    const f = await fixture();
    await writeFile(path.join(f.projectRoot, 'note.txt'), 'match\n');
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(2001);
    expect(await f.core.searchProjectFiles(f.credential, { projectId: 'project', query: 'match' })).toMatchObject({ matches: [], truncated: true, incompleteReasons: ['TIME_LIMIT'] });
    const forged = { projectId: 'project', path: 'note.txt', commandId: 'forged' };
    await expect(f.core.readProjectFile(f.credential, forged)).rejects.toMatchObject({ code: 'PRODUCT_SCHEMA_INVALID' });
    expect(await f.core.list(f.credential)).toEqual([]);
  });
  it('searches literal case-sensitive Thai text recursively with one-based line numbers', async () => {
    const f = await fixture();
    await mkdir(path.join(f.projectRoot, 'sub'));
    await writeFile(path.join(f.projectRoot, 'sub', 'thai.txt'), 'first\r\nค้นหา ABC\r\nค้นหา abc\r\n');
    expect(await f.core.searchProjectFiles(f.credential, { projectId: 'project', query: 'ค้นหา ABC' })).toEqual({ matches: [{ path: 'sub/thai.txt', line: 2, text: 'ค้นหา ABC' }], truncated: false, incompleteReasons: [], skippedCount: 0 });
  });
  it('lists only the selected directory and identifies files and folders', async () => {
    const f = await fixture();
    await mkdir(path.join(f.projectRoot, 'sub'));
    await writeFile(path.join(f.projectRoot, 'note.txt'), 'hello\n');
    await writeFile(path.join(f.projectRoot, 'sub', 'child.txt'), 'child\n');
    expect(await f.core.listProjectFiles(f.credential, { projectId: 'project' })).toEqual({ entries: [{ path: 'note.txt', type: 'file' }, { path: 'sub', type: 'directory' }], truncated: false, incompleteReasons: [], skippedCount: 0 });
  });
  it('returns exact UTF-8 bytes and their version without submitting a Grace job', async () => {
    const f = await fixture();
    await writeFile(path.join(f.projectRoot, 'note.txt'), 'hello\n');
    const result = await f.core.readProjectFile(f.credential, { projectId: 'project', path: 'note.txt' });
    expect(result).toMatchObject({ content: 'hello\n', sha256: '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03' });
    expect(await f.core.list(f.credential)).toEqual([]);
  });
});
