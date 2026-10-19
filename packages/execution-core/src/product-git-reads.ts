import { lstat, realpath, opendir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { DirectGitRunner, GitAdapter, type GitRunner, type GitStatusEntry, type GitLogEntry } from '@lnwjud/git';
import { childEnvironment } from './product-security.mjs';
import { projectFileBytesSync, copyProjectFileSnapshot } from './project-file-snapshot.mjs';
import { readProjectFile } from './product-file-reads.js';
import { projectTarget } from './product-projects.js';
import { CoreError, type ProjectGitInput, type RegisteredProject } from './types.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
// Git for Windows does not accept Node's \\.\nul device spelling as a config path.
const gitNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
type Repository = { root: string; gitDirectory: string; identity: string; metadata: { source: string; relative: string; size: number }[]; objects: { source: string; relative: string; stat: BigIntStats }[] };
export type ProjectGitResult = { projectId: string; truncated: boolean } & ({ view: 'status'; entries: readonly GitStatusEntry[] } | { view: 'log'; entries: readonly GitLogEntry[]; limit: number } | { view: 'diff'; patch: string; path: string; staged: boolean });
const invalidLayout = (): never => { throw new CoreError('GIT_LAYOUT_UNSUPPORTED', 'Use an ordinary project repository without redirected or shared Git metadata', 'projectId'); };

async function repository(project: RegisteredProject, privateRoots: readonly string[], deadline: number, snapshotBudget: () => number): Promise<Repository> {
  if (/^[\\/]{2}/u.test(project.rootPath)) throw new CoreError('GIT_NETWORK_ROOT_DENIED', 'Select a local project repository for this view', 'projectId');
  const root = projectTarget(project, '.', privateRoots, true);
  // Git inspects a repository as a whole. A nested private root cannot be excluded by a pathname filter.
  if (privateRoots.some((item) => { const relative = path.relative(root, item); return !relative || !relative.startsWith('..') && !path.isAbsolute(relative); })) throw new CoreError('GIT_PRIVATE_RUNTIME_OVERLAP');
  if (/[\r\n"]/u.test(root)) invalidLayout();
  const gitDirectory = path.join(root, '.git');
  const info = await lstat(gitDirectory, { bigint: true }).catch(() => undefined);
  if (!info) throw new CoreError('GIT_REPOSITORY_REQUIRED', 'The selected project must contain its own .git directory', 'projectId');
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(gitDirectory) !== gitDirectory) invalidLayout();
  const metadata: Repository['metadata'] = [];
  const checkBudget = (): void => { snapshotBudget(); if (performance.now() >= deadline) throw new CoreError('GIT_VALIDATION_BUDGET'); };
  const inspect = async (selected: string): Promise<BigIntStats> => {
    checkBudget();
    const [stat, resolved] = await Promise.all([lstat(selected, { bigint: true }), realpath(selected)]);
    checkBudget();
    if (stat.isSymbolicLink() || resolved !== selected || (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1n))) invalidLayout();
    return stat;
  };
  const addMetadata = async (selected: string): Promise<void> => {
    const stat = await inspect(selected);
    if (!stat.isFile()) invalidLayout();
    if (metadata.length >= 10000) throw new CoreError('GIT_METADATA_LIMIT');
    metadata.push({ source: selected, relative: path.relative(gitDirectory, selected).split(path.sep).join('/'), size: Number(stat.size) });
  };
  const pending: string[] = [];
  for await (const item of await opendir(gitDirectory)) {
    checkBudget();
    const selected = path.join(gitDirectory, item.name);
    if (item.name === 'commondir' || item.name.startsWith('sharedindex.')) invalidLayout();
    if (['HEAD', 'index', 'packed-refs', 'shallow', 'config'].includes(item.name)) await addMetadata(selected);
    if (item.name === 'refs') { if (!(await inspect(selected)).isDirectory()) invalidLayout(); pending.push(selected); }
  }
  while (pending.length) {
    const directory = pending.pop()!;
    for await (const item of await opendir(directory)) {
      const selected = path.join(directory, item.name);
      const stat = await inspect(selected);
      if (stat.isDirectory()) pending.push(selected); else await addMetadata(selected);
    }
  }
  const infoDirectory = path.join(gitDirectory, 'info');
  const infoStat = await lstat(infoDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (infoStat) {
    if (!(await inspect(infoDirectory)).isDirectory()) invalidLayout();
    for await (const item of await opendir(infoDirectory)) {
      if (item.name === 'grafts') invalidLayout();
      if (item.name === 'exclude') await addMetadata(path.join(infoDirectory, item.name));
    }
  }
  const objects = path.join(gitDirectory, 'objects');
  const objectInfo = await inspect(objects);
  if (!objectInfo.isDirectory()) invalidLayout();
  const objectIdentity = `${objectInfo.dev}:${objectInfo.ino}`;
  const objectsToCopy: Repository['objects'] = [];
  let objectBytes = 0n;
  const objectDirectories = [objects];
  // Validate every object Git may consult, without treating objects as copied refs/index metadata.
  while (objectDirectories.length) {
    const directory = objectDirectories.pop()!;
    let batch: string[] = [];
    const validateBatch = async (): Promise<void> => {
      checkBudget();
      const results = await Promise.allSettled(batch.map(async (selected): Promise<void> => {
        const stat = await inspect(selected);
        if (stat.isDirectory()) objectDirectories.push(selected);
        else {
          objectBytes += stat.size;
          if (objectBytes > 512n * 1024n * 1024n) throw new CoreError('GIT_OBJECT_BYTES_LIMIT');
          objectsToCopy.push({ source: selected, relative: path.relative(objects, selected), stat });
        }
      }));
      batch = [];
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      checkBudget();
    };
    for await (const item of await opendir(directory)) {
      if (['alternates', 'http-alternates'].includes(item.name)) invalidLayout();
      batch.push(path.join(directory, item.name));
      if (batch.length === 32) await validateBatch();
    }
    await validateBatch();
  }
  checkBudget();
  return { root, gitDirectory, identity: `${info.dev}:${info.ino}:${objectIdentity}`, metadata, objects: objectsToCopy };
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
  const started = performance.now();
  // Census retains its own 10s ceiling; all snapshot work shares the original 10s+15s allowance.
  // Config now consumes that allowance too, rather than adding a separate 10s phase.
  const snapshotDeadline = started + 25000;
  const snapshotBudget = (): number => {
    const remaining = snapshotDeadline - performance.now();
    if (remaining <= 0) throw new CoreError('GIT_SNAPSHOT_BUDGET');
    return Math.ceil(remaining);
  };
  const selected = await repository(project, privateRoots, started + 10000, snapshotBudget);
  if (input.view === 'diff') await diffTarget(project, input.path, privateRoots);
  snapshotBudget();
  const scratch = await mkdtemp(path.join(scratchRoot, 'git-read-'));
  try {
    snapshotBudget();
    const directory = path.join(scratch, 'repository');
    await mkdir(path.join(directory, 'refs'), { recursive: true }); snapshotBudget();
    await mkdir(path.join(directory, 'objects', 'info'), { recursive: true }); snapshotBudget();
    let copiedBytes = 0;
    for (const entry of selected.metadata) {
      snapshotBudget();
      if (copiedBytes + entry.size > 8 * 1024 * 1024) throw new CoreError('GIT_METADATA_LIMIT');
      const bytes = projectFileBytesSync(entry.source, Math.min(8 * 1024 * 1024 - copiedBytes, entry.size + 1));
      snapshotBudget();
      copiedBytes += bytes.length;
      const destination = entry.relative === 'config' ? path.join(scratch, 'source-config') : path.join(directory, entry.relative);
      await mkdir(path.dirname(destination), { recursive: true }); snapshotBudget();
      await writeFile(destination, bytes); snapshotBudget();
    }
    const env = { ...childEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNull, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
    const direct = new DirectGitRunner();
    const settings = await direct.run(['config', '--null', '--no-includes', '--file', path.join(scratch, 'source-config'), '--get-regexp', '^(core\\.(repositoryformatversion|filemode|ignorecase|symlinks)|extensions\\..*)$'], scratch, { env, timeoutMs: Math.min(10000, snapshotBudget()) });
    snapshotBudget();
    if (settings.exitCode !== 0 || settings.truncated) throw new CoreError('GIT_CONFIG_UNAVAILABLE');
    const config = new Map<string, string>();
    for (const item of settings.stdout.split('\0').filter(Boolean)) {
      const separator = item.indexOf('\n');
      const key = item.slice(0, separator).toLowerCase(); const value = item.slice(separator + 1).toLowerCase();
      if (separator < 0 || !['core.repositoryformatversion', 'core.filemode', 'core.ignorecase', 'core.symlinks', 'extensions.objectformat'].includes(key) || !/^(?:true|false|0|1|sha1|sha256)$/u.test(value)) invalidLayout();
      config.set(key, value);
    }
    const safeConfig = `[core]\nrepositoryformatversion = ${config.get('core.repositoryformatversion') ?? '0'}\nbare = false\nfilemode = ${config.get('core.filemode') ?? 'false'}\nignorecase = ${config.get('core.ignorecase') ?? 'false'}\nsymlinks = ${config.get('core.symlinks') ?? 'false'}\n${config.has('extensions.objectformat') ? `[extensions]\nobjectformat = ${config.get('extensions.objectformat')}\n` : ''}`;
    await writeFile(path.join(directory, 'config'), safeConfig); snapshotBudget();
    let objectBytes = 0;
    const copyBudget = (bytes: number): void => {
      snapshotBudget();
      objectBytes += bytes;
      if (objectBytes > 512 * 1024 * 1024) throw new CoreError('GIT_OBJECT_BYTES_LIMIT');
    };
    copyBudget(0);
    const objectDirectories = [...new Set(selected.objects.map((entry) => path.dirname(path.join(directory, 'objects', entry.relative))))];
    for (let offset = 0; offset < objectDirectories.length; offset += 32) {
      await Promise.all(objectDirectories.slice(offset, offset + 32).map((destination) => mkdir(destination, { recursive: true })));
      copyBudget(0);
    }
    for (let offset = 0; offset < selected.objects.length; offset += 16) {
      const copied = await Promise.allSettled(selected.objects.slice(offset, offset + 16).map(async (entry): Promise<void> => {
        const destination = path.join(directory, 'objects', entry.relative);
        await copyProjectFileSnapshot(entry.source, destination, entry.stat, copyBudget);
      }));
      const failure = copied.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') { if (failure.reason instanceof CoreError) throw failure.reason; throw new CoreError('GIT_REPOSITORY_CHANGED'); }
      copyBudget(0);
    }
    let worktree = selected.root;
    if (input.view === 'diff' && !input.staged) {
      worktree = path.join(scratch, 'worktree'); await mkdir(worktree);
      try {
        const file = await readProjectFile(project, input.path, privateRoots);
        const destination = path.join(worktree, path.relative(selected.root, projectTarget(project, input.path, privateRoots)));
        await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, file.content);
      } catch (error) { if (!(error instanceof CoreError) || error.code !== 'FILE_NOT_FOUND') throw error; }
    }
    snapshotBudget();
    const prefix = ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '--git-dir', directory, '--work-tree', worktree, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'status.relativePaths=false', '-c', `core.attributesFile=${gitNull}`];
    const runner: GitRunner = { run: async (args, _cwd, options) => {
      const safeArgs = args[0] === 'diff' ? [...args.slice(0, 1), '--no-textconv', '--ignore-submodules=all', ...args.slice(1)] : args[0] === 'status' ? [...args, '--ignore-submodules=all'] : [...args];
      const result = await direct.run([...prefix, ...safeArgs], scratch, { ...options, env, timeoutMs: 10000 });
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
    projectTarget(project, '.', privateRoots, true);
    const [gitIdentity, objectIdentity] = await Promise.all([lstat(selected.gitDirectory, { bigint: true }), lstat(path.join(selected.gitDirectory, 'objects'), { bigint: true })]);
    if (gitIdentity.isSymbolicLink() || objectIdentity.isSymbolicLink() || `${gitIdentity.dev}:${gitIdentity.ino}:${objectIdentity.dev}:${objectIdentity.ino}` !== selected.identity) throw new CoreError('GIT_REPOSITORY_CHANGED');
    if (input.view === 'diff') await diffTarget(project, input.path, privateRoots);
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESPONSE_BYTES) throw new CoreError('GIT_OUTPUT_LIMIT');
    return value;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
