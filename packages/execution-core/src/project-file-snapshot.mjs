import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { Buffer } from 'node:buffer';

function refuse(code) { const error = new Error(code); error.code = code; throw error; }
/** A synchronous compatibility snapshot: never reopen a pathname after checking its file identity. */
export function projectFileBytesSync(target, limit = 1024 * 1024) {
  const before = lstatSync(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || realpathSync(target) !== target) refuse('FILE_SCOPE_CHANGED');
  if (before.nlink > 1n) refuse('FILE_LINK_SCOPE_DENIED');
  const descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const pinned = fstatSync(descriptor, { bigint: true });
    if (pinned.nlink > 1n) refuse('FILE_LINK_SCOPE_DENIED');
    if (pinned.dev !== before.dev || pinned.ino !== before.ino) refuse('FILE_VERSION_CONFLICT');
    if (pinned.size > BigInt(limit)) refuse('FILE_TOO_LARGE');
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(descriptor, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    if (length > limit) refuse('FILE_TOO_LARGE');
    const after = fstatSync(descriptor, { bigint: true });
    if (after.nlink > 1n) refuse('FILE_LINK_SCOPE_DENIED');
    if (after.size !== BigInt(length) || after.mtimeNs !== pinned.mtimeNs) refuse('FILE_VERSION_CONFLICT');
    const current = lstatSync(target, { bigint: true });
    if (current.isSymbolicLink() || current.nlink > 1n || realpathSync(target) !== target) refuse('FILE_SCOPE_CHANGED');
    return buffer.subarray(0, length);
  } finally { closeSync(descriptor); }
}
