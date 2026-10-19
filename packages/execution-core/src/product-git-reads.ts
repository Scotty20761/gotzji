import { lstat, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { DirectGitRunner, GitAdapter, type GitRunner, type GitStatusEntry, type GitLogEntry } from '@lnwjud/git';
import { childEnvironment } from './product-security.mjs';
import { projectFileBytesSync } from './project-file-snapshot.mjs';
import { readProjectFile } from './product-file-reads.js';
import { projectTarget } from './product-projects.js';
import { CoreError, type ProjectGitInput, type RegisteredProject } from './types.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
// Git for Windows does not accept Node's \\.\nul device spelling as a config path.
const gitNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
type Repository = { root: string; gitDirectory: string; identity: string; metadata: { source: string; relative: string; size: number }[] };
export type ProjectGitResult = { projectId: string; truncated: boolean } & ({ view: 'status'; entries: readonly GitStatusEntry[] } | { view: 'log'; entries: readonly GitLogEntry[]; limit: number } | { view: 'diff'; patch: string; path: string; staged: boolean });
const invalidLayout = (): never => { throw new CoreError('GIT_LAYOUT_UNSUPPORTED', 'Use an ordinary project repository without redirected or shared Git metadata', 'projectId'); };

async function repository(project: RegisteredProject, privateRoots: readonly string[]): Promise<Repository> {
  const root = projectTarget(project, '.', privateRoots, true);
  // Git inspects a repository as a whole. A nested private root cannot be excluded by a pathname filter.
  if (privateRoots.some((item) => { const relative = path.relative(root, item); return !relative || !relative.startsWith('..') && !path.isAbsolute(relative); })) throw new CoreError('GIT_PRIVATE_RUNTIME_OVERLAP');
  if (/[\r\n"]/u.test(root)) invalidLayout();
  const gitDirectory = path.join(root, '.git');
  const info = await lstat(gitDirectory, { bigint: true }).catch(() => undefined);
  if (!info) throw new CoreError('GIT_REPOSITORY_REQUIRED', 'The selected project must contain its own .git directory', 'projectId');
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(gitDirectory) !== gitDirectory) invalidLayout();
  const pending = [gitDirectory];
  let scanned = 0;
  const metadata: Repository['metadata'] = [];
  while (pending.length) {
    for (const item of await readdir(pending.pop()!, { withFileTypes: true })) {
      if (++scanned > 10000) throw new CoreError('GIT_METADATA_LIMIT');
      const selected = path.join(item.parentPath, item.name);
      const stat = await lstat(selected);
      if (stat.isSymbolicLink() || realpathSync(selected) !== selected || (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))) invalidLayout();
      if (item.name.startsWith('sharedindex.')) invalidLayout();
      if (['alternates', 'http-alternates', 'commondir', 'grafts'].includes(item.name)) invalidLayout();
      if (stat.isDirectory()) pending.push(selected);
      else {
        const relative = path.relative(gitDirectory, selected).split(path.sep).join('/');
        if (['HEAD', 'index', 'packed-refs', 'shallow', 'config', 'info/exclude'].includes(relative) || relative.startsWith('refs/')) metadata.push({ source: selected, relative, size: stat.size });
      }
    }
  }
  return { root, gitDirectory, identity: `${info.dev}:${info.ino}`, metadata };
}

async function diffTarget(project: RegisteredProject, selected: string, privateRoots: readonly string[]): Promise<void> {
  const target = projectTarget(project, selected, privateRoots);
  const relative = path.relative(project.rootPath, target);
  if (relative.split(path.sep)[0]?.toLowerCase() === '.git') throw new CoreError('GIT_PATH_DENIED');
  let current = project.rootPath;
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) break; // A deleted tracked file still has a useful index/HEAD diff.
    if (info.isSymbolicLink() || realpathSync(current) !== current || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink > 1)) throw new CoreError('GIT_PATH_DENIED');
  }
}

export async function readProjectGit(project: RegisteredProject, input: ProjectGitInput, privateRoots: readonly string[], scratchRoot: string): Promise<ProjectGitResult> {
  const selected = await repository(project, privateRoots);
  if (input.view === 'diff') await diffTarget(project, input.path, privateRoots);
  const scratch = await mkdtemp(path.join(scratchRoot, 'git-read-'));
  try {
    const directory = path.join(scratch, 'repository');
    await mkdir(path.join(directory, 'refs'), { recursive: true });
    await mkdir(path.join(directory, 'objects', 'info'), { recursive: true });
    let copiedBytes = 0;
    for (const entry of selected.metadata) {
      if (copiedBytes + entry.size > 8 * 1024 * 1024) throw new CoreError('GIT_METADATA_LIMIT');
      const bytes = projectFileBytesSync(entry.source, Math.min(8 * 1024 * 1024 - copiedBytes, entry.size + 1));
      copiedBytes += bytes.length;
      const destination = entry.relative === 'config' ? path.join(scratch, 'source-config') : path.join(directory, entry.relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    const env = { ...childEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNull, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
    const direct = new DirectGitRunner();
    const settings = await direct.run(['config', '--null', '--no-includes', '--file', path.join(scratch, 'source-config'), '--get-regexp', '^(core\\.(repositoryformatversion|filemode|ignorecase|symlinks)|extensions\\..*)$'], scratch, { env, timeoutMs: 10000 });
    if (settings.exitCode !== 0 || settings.truncated) throw new CoreError('GIT_CONFIG_UNAVAILABLE');
    const config = new Map<string, string>();
    for (const item of settings.stdout.split('\0').filter(Boolean)) {
      const separator = item.indexOf('\n');
      const key = item.slice(0, separator).toLowerCase(); const value = item.slice(separator + 1).toLowerCase();
      if (separator < 0 || !['core.repositoryformatversion', 'core.filemode', 'core.ignorecase', 'core.symlinks', 'extensions.objectformat'].includes(key) || !/^(?:true|false|0|1|sha1|sha256)$/u.test(value)) invalidLayout();
      config.set(key, value);
    }
    const safeConfig = `[core]\nrepositoryformatversion = ${config.get('core.repositoryformatversion') ?? '0'}\nbare = false\nfilemode = ${config.get('core.filemode') ?? 'false'}\nignorecase = ${config.get('core.ignorecase') ?? 'false'}\nsymlinks = ${config.get('core.symlinks') ?? 'false'}\n${config.has('extensions.objectformat') ? `[extensions]\nobjectformat = ${config.get('extensions.objectformat')}\n` : ''}`;
    await writeFile(path.join(directory, 'config'), safeConfig);
    await writeFile(path.join(directory, 'objects', 'info', 'alternates'), JSON.stringify(path.join(selected.gitDirectory, 'objects').split(path.sep).join('/')) + '\n');
    let worktree = selected.root;
    if (input.view === 'diff' && !input.staged) {
      worktree = path.join(scratch, 'worktree'); await mkdir(worktree);
      try {
        const file = await readProjectFile(project, input.path, privateRoots);
        const destination = path.join(worktree, path.relative(selected.root, projectTarget(project, input.path, privateRoots)));
        await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, file.content);
      } catch (error) { if (!(error instanceof CoreError) || error.code !== 'FILE_NOT_FOUND') throw error; }
    }
    const prefix = ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '--git-dir', directory, '--work-tree', worktree, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', `core.attributesFile=${gitNull}`];
    const runner: GitRunner = { run: async (args, cwd, options) => {
      const safeArgs = args[0] === 'diff' ? [...args.slice(0, 1), '--no-textconv', '--ignore-submodules=all', ...args.slice(1)] : args[0] === 'status' ? [...args, '--ignore-submodules=all'] : [...args];
      const result = await direct.run([...prefix, ...safeArgs], cwd, { ...options, env, timeoutMs: 10000 });
      if (result.truncated) throw new CoreError('GIT_OUTPUT_LIMIT', 'The Git output exceeds this bounded view');
      return result;
    } };
    const git = new GitAdapter(runner);
    let value: ProjectGitResult;
    if (input.view === 'status') {
      const result = await git.status(selected.root);
      if (!result.ok) throw new CoreError(result.error.code, 'The selected Git view could not be read', 'view');
      value = { projectId: project.projectId, view: 'status', ...result.value, truncated: false };
    } else if (input.view === 'log') {
      const result = await git.log(selected.root, { maxCommits: 20, maxBytes: 48 * 1024 });
      if (!result.ok) throw new CoreError(result.error.code, 'The selected Git view could not be read', 'view');
      value = { projectId: project.projectId, view: 'log', ...result.value, limit: 20 };
    } else {
      const result = await git.diff(selected.root, { path: path.relative(selected.root, projectTarget(project, input.path, privateRoots)).split(path.sep).join('/'), staged: input.staged ?? false, maxBytes: 48 * 1024 });
      if (!result.ok) throw new CoreError(result.error.code, 'The selected Git view could not be read', 'view');
      value = { projectId: project.projectId, view: 'diff', ...result.value, path: input.path, staged: input.staged ?? false };
    }
    const current = await repository(project, privateRoots);
    if (current.identity !== selected.identity) throw new CoreError('GIT_REPOSITORY_CHANGED');
    if (input.view === 'diff') await diffTarget(project, input.path, privateRoots);
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESPONSE_BYTES) throw new CoreError('GIT_OUTPUT_LIMIT');
    return value;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
