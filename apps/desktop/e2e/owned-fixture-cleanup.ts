import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface OwnedRootRemovalEvidence {
  readonly code: string; readonly syscall: string; readonly path: string;
  readonly remaining: readonly { readonly name: string; readonly kind: 'directory' | 'file' | 'link' | 'other' }[];
  readonly truncated: boolean; readonly censusError?: string;
}
/** Read only the already-verified owned root. Error paths are evidence, never filesystem operands. */
export async function ownedRootRemovalEvidence(root: string, error: unknown): Promise<OwnedRootRemovalEvidence> {
  const source = record(error) ? error : {};
  let failedPath = '<unknown>';
  if (typeof source.path === 'string') {
    const relative = path.relative(root, source.path);
    failedPath = path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
      ? '<outside-owned-root>' : relative.split(path.sep).join('/') || '.';
  }
  const category = { code: typeof source.code === 'string' ? source.code : 'UNKNOWN', syscall: typeof source.syscall === 'string' ? source.syscall : 'UNKNOWN', path: failedPath };
  try {
    const before = await lstat(root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(root) !== root) throw Object.assign(new Error('Root scope changed'), { code: 'ROOT_SCOPE_CHANGED' });
    const entries = await readdir(root, { withFileTypes: true });
    const after = await lstat(root, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || await realpath(root) !== root) throw Object.assign(new Error('Root scope changed'), { code: 'ROOT_SCOPE_CHANGED' });
    return { ...category, remaining: entries.slice(0, 20).map(entry => ({ name: entry.name,
      kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })), truncated: entries.length > 20 };
  } catch (cause) {
    return { ...category, remaining: [], truncated: false, censusError: record(cause) && typeof cause.code === 'string' ? cause.code : 'UNKNOWN' };
  }
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
