import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionCore } from './core.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import { childEnvironment } from './product-security.mjs';
import { startProductHttp } from './product-http.js';

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
});
