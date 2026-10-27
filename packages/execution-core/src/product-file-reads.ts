import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { CoreError, type ProjectFileResult, type ProjectListResult, type ProjectSearchResult, type RegisteredProject } from './types.js';
import { projectTarget } from './product-projects.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
type Coverage = { truncated: boolean; incompleteReasons: string[]; skippedCount: number };
function incomplete(result: Coverage, reason: string, skipped = false): void {
  result.truncated = true;
  if (!result.incompleteReasons.includes(reason)) result.incompleteReasons.push(reason);
  if (skipped) result.skippedCount++;
}
function exceedsResponse(result: unknown): boolean { return Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE_BYTES - 512; }
async function directoryTarget(project: RegisteredProject, relativePath: string, privateRoots: readonly string[]): Promise<string> {
  const target = projectTarget(project, relativePath, privateRoots, true);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(target) !== target) invalidPath('Select an ordinary project directory without redirected paths');
  return target;
}
function relativeName(project: RegisteredProject, target: string): string { return path.relative(project.rootPath, target).split(path.sep).join('/'); }
function invalidPath(reason: string): never { throw new CoreError('FILE_SCOPE_CHANGED', reason, 'path', 'filesystem', 'Select a regular file inside the registered project'); }
function fileReadError(error: unknown): never {
  if (error instanceof CoreError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  throw new CoreError(code === 'ENOENT' ? 'FILE_NOT_FOUND' : code === 'ENOTDIR' ? 'PATH_NOT_DIRECTORY' : ['EPERM', 'EACCES'].includes(code ?? '') ? 'FILE_PERMISSION_DENIED' : 'FILE_READ_FAILED', 'The selected project path could not be read', 'path', 'filesystem', 'Check the selected path and file access');
}
async function readFileSnapshot(project: RegisteredProject, relativePath: string, privateRoots: readonly string[], budget?: { remaining: number }): Promise<ProjectFileResult> {
  try {
    const target = projectTarget(project, relativePath, privateRoots);
    const before = await lstat(target, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || realpathSync(target) !== target) invalidPath('Redirected paths and non-file objects cannot be read');
    if (before.nlink > 1n) throw new CoreError('FILE_LINK_SCOPE_DENIED', 'Multi-link files may alias private runtime data and cannot be read', 'path');
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const pinned = await file.stat({ bigint: true });
      if (pinned.nlink > 1n) throw new CoreError('FILE_LINK_SCOPE_DENIED', 'Multi-link files may alias private runtime data and cannot be read', 'path');
      if (pinned.dev !== before.dev || pinned.ino !== before.ino) throw new CoreError('FILE_VERSION_CONFLICT', 'The file was replaced while it was opened; read the new version', 'path');
      if (pinned.size > BigInt(MAX_FILE_BYTES)) throw new CoreError('FILE_TOO_LARGE', 'Files above 1 MiB need a bounded range operation', 'path');
      if (budget && pinned.size > BigInt(budget.remaining)) throw new CoreError('BYTE_LIMIT', 'The search byte budget is exhausted', 'path');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, Math.min(buffer.length - length, budget?.remaining ?? buffer.length), null);
        if (!bytesRead) break;
        length += bytesRead;
        if (budget) budget.remaining -= bytesRead;
      }
      if (length > MAX_FILE_BYTES) throw new CoreError('FILE_TOO_LARGE', 'Files above 1 MiB need a bounded range operation', 'path');
      const after = await file.stat({ bigint: true });
      if (after.nlink > 1n) throw new CoreError('FILE_LINK_SCOPE_DENIED', 'The file acquired another link during the read', 'path');
      if (after.size !== BigInt(length) || after.mtimeNs !== pinned.mtimeNs) throw new CoreError('FILE_VERSION_CONFLICT', 'The file changed while being read; read the current version again', 'path');
      // A gotzji atomic replacement may leave this handle on the complete old version. A redirected path is never accepted.
      projectTarget(project, relativePath, privateRoots);
      if (realpathSync(target) !== target || (await lstat(target)).isSymbolicLink()) invalidPath('The path was redirected during the read');
      const bytes = buffer.subarray(0, length);
      const content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes) || bytes.some((byte) => byte < 9 || byte === 11 || byte > 13 && byte < 32 || byte === 127)) throw new CoreError('FILE_ENCODING_UNSUPPORTED', 'Select UTF-8 text without binary control bytes; binary files need their qualified provider', 'path');
      return { content, sha256: createHash('sha256').update(bytes).digest('hex') };
    } finally { await file.close(); }
  } catch (error) { return fileReadError(error); }
}
export async function readProjectFile(project: RegisteredProject, relativePath: string, privateRoots: readonly string[], budget?: { remaining: number }): Promise<ProjectFileResult> {
  for (let attempt = 0; ; attempt++) {
    try { return await readFileSnapshot(project, relativePath, privateRoots, budget); }
    catch (error) { if (!(error instanceof CoreError) || error.code !== 'FILE_VERSION_CONFLICT' || attempt >= 2) throw error; }
  }
}

/** Read one bounded binary snapshot through the same project and handle boundaries as text reads. */
export async function readVerifiedProjectArtifact(project: RegisteredProject, relativePath: string, privateRoots: readonly string[], expectedSha256: string): Promise<Buffer> {
  const limit = 16 * 1024 * 1024;
  try {
    const target = projectTarget(project, relativePath, privateRoots);
    const root = await lstat(project.rootPath, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) throw new CoreError('PROJECT_ROOT_CHANGED');
    const before = await lstat(target, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || realpathSync(target) !== target) invalidPath('Select a regular output file inside the project');
    if (before.nlink > 1n) throw new CoreError('FILE_LINK_SCOPE_DENIED');
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const pinned = await file.stat({ bigint: true });
      if (pinned.nlink > 1n) throw new CoreError('FILE_LINK_SCOPE_DENIED');
      if (pinned.dev !== before.dev || pinned.ino !== before.ino) throw new CoreError('FILE_VERSION_CONFLICT');
      if (pinned.size > BigInt(limit)) throw new CoreError('ARTIFACT_TOO_LARGE');
      const bytes = Buffer.alloc(Number(pinned.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (after.nlink > 1n) throw new CoreError('FILE_LINK_SCOPE_DENIED');
      if (after.size !== BigInt(length) || after.mtimeNs !== pinned.mtimeNs) throw new CoreError('FILE_VERSION_CONFLICT');
      projectTarget(project, relativePath, privateRoots);
      const currentRoot = await lstat(project.rootPath, { bigint: true });
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino) throw new CoreError('PROJECT_ROOT_CHANGED');
      const current = await lstat(target, { bigint: true });
      if (realpathSync(target) !== target || current.isSymbolicLink() || !current.isFile()) invalidPath('The output path was redirected during the read');
      if (current.nlink > 1n) throw new CoreError('FILE_LINK_SCOPE_DENIED');
      if (current.dev !== pinned.dev || current.ino !== pinned.ino) throw new CoreError('FILE_VERSION_CONFLICT');
      const snapshot = bytes.subarray(0, length);
      if (createHash('sha256').update(snapshot).digest('hex') !== expectedSha256) throw new CoreError('NATIVE_ARTIFACT_CHANGED');
      return snapshot;
    } finally { await file.close(); }
  } catch (error) { return fileReadError(error); }
}
export async function searchProjectFiles(project: RegisteredProject, relativePath: string, query: string, privateRoots: readonly string[]): Promise<ProjectSearchResult> {
  const result: { matches: { path: string; line: number; text: string }[] } & Coverage = { matches: [], truncated: false, incompleteReasons: [], skippedCount: 0 };
  if (typeof query !== 'string' || !query || query.length > 1024 || /[\r\n]/u.test(query)) throw new CoreError('PRODUCT_SCHEMA_INVALID', 'Use a nonempty single-line literal query up to 1024 characters', 'query');
  const deadline = performance.now() + 2000;
  const budget = { remaining: 32 * 1024 * 1024 };
  const pending = [relativePath];
  let scanned = 0;
  let stopped = false;
  try {
    await directoryTarget(project, relativePath, privateRoots);
    while (pending.length && !stopped) {
      const selectedDirectory = pending.pop()!;
      try {
        const target = await directoryTarget(project, selectedDirectory, privateRoots);
        const directory = await opendir(target);
        for await (const entry of directory) {
          if (performance.now() >= deadline || scanned >= 10000) { incomplete(result, scanned >= 10000 ? 'SCAN_LIMIT' : 'TIME_LIMIT'); stopped = true; break; }
          scanned++;
          const name = relativeName(project, path.join(target, entry.name));
          try {
            const selected = projectTarget(project, name, privateRoots);
            const info = await lstat(selected);
            if (info.isSymbolicLink() || realpathSync(selected) !== selected) invalidPath('Redirected entries are not searched');
            if (info.isDirectory()) { pending.push(name); continue; }
            if (!info.isFile()) { incomplete(result, 'NON_FILE_ENTRY', true); continue; }
            if (info.nlink > 1) throw new CoreError('FILE_LINK_SCOPE_DENIED', 'Multi-link files cannot be searched', 'path');
            const { content } = await readProjectFile(project, name, privateRoots, budget);
            const lines = content.split('\n');
            for (let index = 0; index < lines.length; index++) {
              if (performance.now() >= deadline) { incomplete(result, 'TIME_LIMIT'); stopped = true; break; }
              const text = lines[index]!.replace(/\r$/u, '');
              if (!text.includes(query)) continue;
              if (result.matches.length === 100) { incomplete(result, 'MATCH_LIMIT'); stopped = true; break; }
              result.matches.push({ path: name, line: index + 1, text });
              if (exceedsResponse(result)) { result.matches.pop(); incomplete(result, 'RESPONSE_LIMIT'); stopped = true; break; }
            }
            if (stopped) break;
          } catch (error) {
            if (error instanceof CoreError && error.code === 'BYTE_LIMIT') { incomplete(result, 'BYTE_LIMIT'); stopped = true; break; }
            incomplete(result, error instanceof CoreError ? error.code : 'ENTRY_READ_FAILED', true);
          }
        }
      } catch (error) { incomplete(result, error instanceof CoreError ? error.code : 'DIRECTORY_READ_FAILED', true); }
    }
    await directoryTarget(project, relativePath, privateRoots);
    result.matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return result;
  } catch (error) { return fileReadError(error); }
}
export async function listProjectFiles(project: RegisteredProject, relativePath: string, privateRoots: readonly string[]): Promise<ProjectListResult> {
  const result: { entries: { path: string; type: 'file' | 'directory' }[] } & Coverage = { entries: [], truncated: false, incompleteReasons: [], skippedCount: 0 };
  try {
    const target = await directoryTarget(project, relativePath, privateRoots);
    const directory = await opendir(target);
    for await (const entry of directory) {
      const name = relativeName(project, path.join(target, entry.name));
      try {
        const selected = projectTarget(project, name, privateRoots);
        const info = await lstat(selected);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || realpathSync(selected) !== selected) invalidPath('Redirected entries are not listed');
        if (info.isFile() && info.nlink > 1) throw new CoreError('FILE_LINK_SCOPE_DENIED', 'Multi-link files cannot be listed', 'path');
        if (result.entries.length === 500) { incomplete(result, 'ENTRY_LIMIT'); break; }
        result.entries.push({ path: name, type: info.isDirectory() ? 'directory' : 'file' });
        if (exceedsResponse(result)) { result.entries.pop(); incomplete(result, 'RESPONSE_LIMIT'); break; }
      } catch (error) { incomplete(result, error instanceof CoreError ? error.code : 'ENTRY_READ_FAILED', true); }
    }
    await directoryTarget(project, relativePath, privateRoots);
    result.entries.sort((a, b) => a.path.localeCompare(b.path));
    return result;
  } catch (error) { return fileReadError(error); }
}
