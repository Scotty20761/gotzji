import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionCore } from './core.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import { childEnvironment } from './product-security.mjs';
import { startProductHttp } from './product-http.js';
import { readProjectGit } from './product-git-reads.js';
import { DirectGitRunner, type GitRunResult } from '@lnwjud/git';

const run = promisify(execFile);
const fixtures: { root: string; core: ExecutionCore }[] = [];
async function fixture(): Promise<{ root: string; projectRoot: string; core: ExecutionCore; credential: string; git: (args: string[]) => Promise<{ stdout: string; stderr: string }> }> {
  const root = await canonicalTemporaryDirectory('gotzji-git-reads-');
  const projectRoot = path.join(root, 'project');
  const libraryRoot = path.join(root, 'policy');
  ensureProductControlDocuments(libraryRoot);
  await mkdir(projectRoot);
  const git = (args: string[]): Promise<{ stdout: string; stderr: string }> => run('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', ...args], {
    cwd: projectRoot, windowsHide: true,
    env: { ...childEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Synthetic Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid', GIT_TEMPLATE_DIR: '' },
  });
  await git(['init']);
  await writeFile(path.join(projectRoot, 'note.txt'), 'original\n');
  await git(['add', 'note.txt']);
  await git(['commit', '-m', 'Synthetic first commit']);
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: { executable: process.execPath, libraryRoot } });
  fixtures.push({ root, core });
  const credential = core.enrollAdapter('desktop', 'owner');
  core.registerProject(credential, { projectId: 'repo', displayName: 'Synthetic Git', rootPath: projectRoot });
  return { root, projectRoot, core, credential, git };
}
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const { root, core } of fixtures.splice(0)) { core.close(); await rm(root, { recursive: true, force: true }); }
});

describe('owner project Git reads', () => {
  it('reads real status, selected-file diff and recent history without changing the index or creating jobs', async () => {
    const f = await fixture();
    await writeFile(path.join(f.projectRoot, 'note.txt'), 'changed\n');
    await writeFile(path.join(f.projectRoot, 'new.txt'), 'untracked\n');
    const before = await readFile(path.join(f.projectRoot, '.git', 'index'));
    expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'status' })).toMatchObject({ view: 'status', entries: expect.arrayContaining([{ path: 'note.txt', kind: 'modified', indexStatus: ' ', worktreeStatus: 'M' }]), truncated: false });
    expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'diff', path: 'note.txt' })).toMatchObject({ patch: expect.stringContaining('+changed'), truncated: false });
    expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'log' })).toMatchObject({ entries: [expect.objectContaining({ subject: 'Synthetic first commit', hash: expect.stringMatching(/^[a-f0-9]{40}$/u) })], limit: 20 });
    expect(await readFile(path.join(f.projectRoot, '.git', 'index'))).toEqual(before);
    expect(await f.core.list(f.credential)).toEqual([]);
    expect((await readdir(path.join(f.root, 'state'))).filter((item) => item.startsWith('git-read-'))).toEqual([]);
  });

  it('rejects owner mismatch, extra command arguments, parent discovery and redirected object stores', async () => {
    const f = await fixture();
    await expect(readProjectGit({ ...f.core.listProjects(f.credential)[0]!, rootPath: '\\\\unreachable.invalid\\share\\repo' }, { projectId: 'repo', view: 'status' }, [], path.join(f.root, 'state'))).rejects.toMatchObject({ code: 'GIT_NETWORK_ROOT_DENIED' });
    const foreign = f.core.enrollAdapter('foreign-desktop', 'another-owner');
    await expect(f.core.readProjectGit(foreign, { projectId: 'repo', view: 'status' })).rejects.toMatchObject({ code: 'PROJECT_NOT_REGISTERED' });
    await expect(f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'status', args: ['push'] } as never)).rejects.toMatchObject({ code: 'PRODUCT_SCHEMA_INVALID' });
    await mkdir(path.join(f.projectRoot, 'nested'));
    f.core.registerProject(f.credential, { projectId: 'nested', displayName: 'Nested', rootPath: path.join(f.projectRoot, 'nested') });
    await expect(f.core.readProjectGit(f.credential, { projectId: 'nested', view: 'status' })).rejects.toMatchObject({ code: 'GIT_REPOSITORY_REQUIRED' });
    await writeFile(path.join(f.projectRoot, '.git', 'objects', 'info', 'alternates'), path.join(f.root, 'other-objects'));
    await expect(f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'log' })).rejects.toMatchObject({ code: 'GIT_LAYOUT_UNSUPPORTED' });
  });

  it('ignores inherited Git redirection and never runs repository textconv or fsmonitor helpers', async () => {
    const f = await fixture();
    const marker = path.join(f.root, 'helper-ran');
    const helper = path.join(f.root, 'helper.mjs');
    await writeFile(helper, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`);
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${helper.replaceAll('\\', '/')}"`;
    await f.git(['config', 'core.fsmonitor', command]);
    await f.git(['config', 'diff.synthetic.textconv', command]);
    await f.git(['config', 'filter.synthetic.clean', command]);
    await writeFile(path.join(f.projectRoot, '.gitattributes'), '*.txt diff=synthetic filter=synthetic\n');
    await writeFile(path.join(f.projectRoot, 'note.txt'), 'safe changed\n');
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(f.root, 'nonexistent');
    try {
      expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'status' })).toMatchObject({ truncated: false });
      expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'diff', path: 'note.txt' })).toMatchObject({ patch: expect.stringContaining('+safe changed') });
      expect(existsSync(marker)).toBe(false);
    } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  });

  it('serves real Git through its advertised MCP schema and rejects caller commands before dispatch', async () => {
    const f = await fixture();
    let calls = 0;
    const host = await startProductHttp({ token: 'synthetic-owner', mcpPathSecret: 'synthetic-mcp', rpc: async (method, input) => {
      calls++;
      if (method !== 'readProjectGit') throw new Error('Unexpected fixture method');
      return f.core.readProjectGit(f.credential, input as never);
    } });
    const call = async (method: string, params: Record<string, unknown>): Promise<{ result: { tools: { name: string }[]; content: { text: string }[] } }> => (await (await fetch(`http://127.0.0.1:${host.port}/mcp/synthetic-mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
    try {
      const advertised = await call('tools/list', {});
      expect(advertised.result.tools.find((item: { name: string }) => item.name === 'gotzji_git')).toMatchObject({ annotations: { readOnlyHint: true } });
      const real = await call('tools/call', { name: 'gotzji_git', arguments: { projectId: 'repo', view: 'log' } });
      expect(JSON.parse(real.result.content[0].text)).toMatchObject({ view: 'log', entries: [expect.objectContaining({ subject: 'Synthetic first commit' })] });
      const denied = await call('tools/call', { name: 'gotzji_git', arguments: { projectId: 'repo', view: 'status', args: ['push'] } });
      expect(JSON.stringify(denied)).toContain('PRODUCT_SCHEMA_INVALID');
      expect(calls).toBe(1);
    } finally { await host.close(); }
  });

  it('labels a bounded large diff and denies a private hard-linked worktree file', async () => {
    const f = await fixture();
    await writeFile(path.join(f.projectRoot, 'note.txt'), 'large change\n'.repeat(10000));
    expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'diff', path: 'note.txt' })).toMatchObject({ truncated: true });
    await writeFile(path.join(f.root, 'state', 'private.txt'), 'PRIVATE_BYTES');
    await link(path.join(f.root, 'state', 'private.txt'), path.join(f.projectRoot, 'alias.txt'));
    await expect(f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'diff', path: 'alias.txt' })).rejects.toMatchObject({ code: 'GIT_PATH_DENIED' });
  });

  it('preserves multiple commit identities and staged, deleted and Unicode file semantics', async () => {
    const f = await fixture();
    const name = 'โฟลเดอร์/ชื่อ file.txt';
    await mkdir(path.join(f.projectRoot, 'โฟลเดอร์'));
    await writeFile(path.join(f.projectRoot, name), 'ต้นฉบับ\n');
    await f.git(['add', name]); await f.git(['commit', '-m', 'Synthetic second commit']);
    const log = await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'log' });
    expect(log.view).toBe('log');
    if (log.view !== 'log') throw new Error('Incorrect Git result view');
    expect(log.entries).toHaveLength(2);
    for (const entry of log.entries) expect(entry.hash).toMatch(/^[a-f0-9]{40}$/u);
    await writeFile(path.join(f.projectRoot, name), 'บันทึกที่เตรียม\n'); await f.git(['add', name]);
    const index = await readFile(path.join(f.projectRoot, '.git', 'index'));
    await writeFile(path.join(f.projectRoot, name), 'ยังไม่เตรียม\n');
    expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'diff', path: name, staged: true })).toMatchObject({ patch: expect.stringContaining('+บันทึกที่เตรียม') });
    expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'diff', path: name })).toMatchObject({ patch: expect.stringContaining('+ยังไม่เตรียม') });
    await rm(path.join(f.projectRoot, name));
    expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'status' })).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ path: name, kind: 'deleted' })]) });
    expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'diff', path: name })).toMatchObject({ patch: expect.stringContaining('-บันทึกที่เตรียม') });
    expect(await readFile(path.join(f.projectRoot, '.git', 'index'))).toEqual(index);
  }, 20000);

  it('accepts a large ordinary object store without counting unrelated metadata as copied inputs', async () => {
    const f = await fixture();
    const entries = Array.from({ length: 10020 }, (_, index) => {
      const text = `Synthetic owned object ${index}`;
      const content = Buffer.from(`blob ${Buffer.byteLength(text)}\0${text}`);
      const hash = createHash('sha1').update(content).digest('hex');
      return { path: path.join(f.projectRoot, '.git', 'objects', hash.slice(0, 2), hash.slice(2)), content: deflateSync(content) };
    });
    await Promise.all([...new Set(entries.map((entry) => path.dirname(entry.path)))].map((directory) => mkdir(directory, { recursive: true })));
    for (let offset = 0; offset < entries.length; offset += 64) await Promise.all(entries.slice(offset, offset + 64).map((entry) => writeFile(entry.path, entry.content)));
    await mkdir(path.join(f.projectRoot, '.git', 'logs', 'unrelated'), { recursive: true });
    await symlink(path.join(f.root, 'state'), path.join(f.projectRoot, '.git', 'logs', 'unrelated', 'not-consumed'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'status' })).toMatchObject({ entries: [], truncated: false });
  }, 30000);

  it('rejects hard-linked loose objects, packs, indexes, commit graphs and redirected object directories', async () => {
    const f = await fixture();
    const secret = path.join(f.root, 'state', 'private-object'); await writeFile(secret, 'PRIVATE_BYTES');
    for (const relative of ['aa/' + '1'.repeat(38), 'pack/pack-' + '2'.repeat(40) + '.pack', 'pack/pack-' + '2'.repeat(40) + '.idx', 'info/commit-graphs/graph-' + '3'.repeat(40) + '.graph']) {
      const target = path.join(f.projectRoot, '.git', 'objects', relative); await mkdir(path.dirname(target), { recursive: true }); await link(secret, target);
      await expect(f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'log' })).rejects.toMatchObject({ code: 'GIT_LAYOUT_UNSUPPORTED' });
      await rm(target);
    }
    await symlink(path.join(f.root, 'state'), path.join(f.projectRoot, '.git', 'objects', 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'status' })).rejects.toMatchObject({ code: 'GIT_LAYOUT_UNSUPPORTED' });
  }, 20000);

  it('fails closed when complete object validation cannot finish within its read budget', async () => {
    const f = await fixture();
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10001);
    await expect(f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'status' })).rejects.toMatchObject({ code: 'GIT_VALIDATION_BUDGET' });
    expect((await readdir(path.join(f.root, 'state'))).filter((item) => item.startsWith('git-read-'))).toEqual([]);
  });

  it('does not admit outside object data introduced through an alternate after the census', async () => {
    const f = await fixture();
    const outside = path.join(f.root, 'state', 'outside-repo'); await mkdir(outside);
    await f.git(['-C', outside, 'init']);
    await writeFile(path.join(outside, 'secret.txt'), 'Synthetic outside private bytes');
    await f.git(['-C', outside, 'add', 'secret.txt']);
    await f.git(['-C', outside, 'commit', '-m', 'SYNTHETIC_PRIVATE_OUTSIDE_SUBJECT']);
    const outsideId = (await f.git(['-C', outside, 'rev-parse', 'HEAD'])).stdout.trim();
    const headRef = (await f.git(['symbolic-ref', 'HEAD'])).stdout.trim();
    await writeFile(path.join(f.projectRoot, '.git', headRef), outsideId + '\n');
    const native = DirectGitRunner.prototype.run; let injected = false; let ownedObjectView = false;
    vi.spyOn(DirectGitRunner.prototype, 'run').mockImplementation(async function (this: DirectGitRunner, args, cwd, options): Promise<GitRunResult> {
      if (!injected && args[0] === 'config') { injected = true; await writeFile(path.join(f.projectRoot, '.git', 'objects', 'info', 'alternates'), path.join(outside, '.git', 'objects') + '\n'); }
      if (args.includes('--git-dir')) {
        const directory = args[args.indexOf('--git-dir') + 1]!;
        ownedObjectView = directory.startsWith(path.join(f.root, 'state', 'git-read-')) && !existsSync(path.join(directory, 'objects', 'info', 'alternates')) && cwd === path.dirname(directory);
      }
      return native.call(this, args, cwd, options);
    });
    const observed = await f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'log' }).then((value) => ({ value }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    expect(injected).toBe(true);
    expect((await f.git(['log', '-1', '--format=%s'])).stdout.trim()).toBe('SYNTHETIC_PRIVATE_OUTSIDE_SUBJECT');
    expect(ownedObjectView).toBe(true);
    expect(JSON.stringify(observed)).not.toContain('SYNTHETIC_PRIVATE_OUTSIDE_SUBJECT');
    expect(observed).toHaveProperty('error');
    expect(await f.core.list(f.credential)).toEqual([]);
  }, 20000);

  it('refuses a replaced pack before admitting Git to the owned object view', async () => {
    const f = await fixture(); await f.git(['repack', '-ad']);
    const packs = path.join(f.projectRoot, '.git', 'objects', 'pack');
    const pack = (await readdir(packs)).find((name) => name.endsWith('.pack'))!;
    const native = DirectGitRunner.prototype.run; let injected = false; let objectReads = 0;
    vi.spyOn(DirectGitRunner.prototype, 'run').mockImplementation(async function (this: DirectGitRunner, args, cwd, options): Promise<GitRunResult> {
      if (!injected && args[0] === 'config') {
        injected = true;
        await rename(path.join(packs, pack), path.join(f.root, 'state', 'original.pack'));
        await writeFile(path.join(packs, pack), 'Changed after census');
      }
      if (args.includes('--git-dir')) objectReads++;
      return native.call(this, args, cwd, options);
    });
    await expect(f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'log' })).rejects.toMatchObject({ code: 'GIT_REPOSITORY_CHANGED' });
    expect(injected).toBe(true); expect(objectReads).toBe(0);
  }, 20000);

  it('checks the validation deadline after the final real asynchronous object lookup', async () => {
    const f = await fixture(); const objects = path.join(f.projectRoot, '.git', 'objects');
    await rm(objects, { recursive: true, force: true });
    const bytes = Buffer.from('blob 5\0clock'); const id = createHash('sha1').update(bytes).digest('hex');
    const target = path.join(objects, id.slice(0, 2), id.slice(2)); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, deflateSync(bytes));
    let clock = 0; let crossed = false; const real = fsPromises.realpath;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(fsPromises, 'realpath').mockImplementation(async (selected): Promise<string> => {
      const value = await real(selected);
      if (selected === target) { crossed = true; clock = 10001; }
      return value;
    });
    syncBuiltinESMExports();
    const git = vi.spyOn(DirectGitRunner.prototype, 'run');
    await expect(f.core.readProjectGit(f.credential, { projectId: 'repo', view: 'status' })).rejects.toMatchObject({ code: 'GIT_VALIDATION_BUDGET' });
    expect(crossed).toBe(true); expect(git).not.toHaveBeenCalled();
  }, 20000);
});
