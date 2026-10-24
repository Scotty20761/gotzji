import { constants, closeSync, createWriteStream, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function refuse(code) { const error = new Error(code); error.code = code; throw error; }

/** Stream one observed ordinary binary file from its pinned handle into an exclusive owned copy. */
export async function copyProjectFileSnapshot(target, destination, expected, beforeWrite) {
  const source = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const [pinned, current, resolved] = await Promise.all([source.stat({ bigint: true }), lstat(target, { bigint: true }), realpath(target)]);
    if (!pinned.isFile() || current.isSymbolicLink() || resolved !== target || pinned.nlink > 1n || current.nlink > 1n) refuse('FILE_SCOPE_CHANGED');
    if (pinned.dev !== expected.dev || pinned.ino !== expected.ino || current.dev !== pinned.dev || current.ino !== pinned.ino || pinned.size !== expected.size || pinned.mtimeNs !== expected.mtimeNs || pinned.ctimeNs !== expected.ctimeNs) refuse('FILE_VERSION_CONFLICT');
    let length = 0;
    if (pinned.size <= 64n * 1024n) {
      // Loose objects are usually small. Keep their allocation bounded and avoid a stream graph per object.
      const buffer = Buffer.alloc(Number(pinned.size) + 1);
      while (length < buffer.length) {
        const { bytesRead } = await source.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (BigInt(length) !== pinned.size) refuse('FILE_VERSION_CONFLICT');
      beforeWrite(length);
      await writeFile(destination, buffer.subarray(0, length), { flag: 'wx', mode: 0o600 });
    } else {
      const budget = new Transform({ transform(chunk, _encoding, done) {
        try { beforeWrite(chunk.length); length += chunk.length; done(null, chunk); } catch (error) { done(error); }
      } });
      await pipeline(source.createReadStream({ autoClose: false }), budget, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    }
    const [after, pathAfter, resolvedAfter] = await Promise.all([source.stat({ bigint: true }), lstat(target, { bigint: true }), realpath(target)]);
    if (after.nlink > 1n || pathAfter.nlink > 1n || pathAfter.isSymbolicLink() || resolvedAfter !== target || pathAfter.dev !== pinned.dev || pathAfter.ino !== pinned.ino) refuse('FILE_SCOPE_CHANGED');
    if (after.size !== BigInt(length) || after.size !== pinned.size || after.mtimeNs !== pinned.mtimeNs || after.ctimeNs !== pinned.ctimeNs) refuse('FILE_VERSION_CONFLICT');
    return length;
  } finally { await source.close(); }
}
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
