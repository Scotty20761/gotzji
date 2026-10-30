import { lstat, open, type FileHandle } from 'node:fs/promises';

/** Create only a new destination and verify the bytes using the same open handle. */
export async function saveNativeSnapshot(destination: string, content: Buffer, write: (file: FileHandle, bytes: Buffer) => Promise<void> = async (file, bytes) => file.writeFile(bytes)): Promise<void> {
  const file = await open(destination, 'wx+', 0o600);
  try {
    await write(file, content);
    const pinned = await file.stat({ bigint: true });
    if (!pinned.isFile() || pinned.nlink !== 1n || pinned.size !== BigInt(content.length)) throw new Error('NATIVE_OUTPUT_WRITE_INCOMPLETE');
    const copy = Buffer.alloc(content.length + 1); let length = 0;
    while (length < copy.length) { const read = await file.read(copy, length, copy.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await file.stat({ bigint: true });
    const current = await lstat(destination, { bigint: true });
    if (length !== content.length || !copy.subarray(0, length).equals(content) || after.size !== pinned.size || after.mtimeNs !== pinned.mtimeNs
      || after.nlink !== 1n || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev !== pinned.dev || current.ino !== pinned.ino) throw new Error('NATIVE_OUTPUT_WRITE_INCOMPLETE');
  } catch { throw new Error('NATIVE_OUTPUT_WRITE_INCOMPLETE'); }
  finally { await file.close().catch(() => { throw new Error('NATIVE_OUTPUT_WRITE_INCOMPLETE'); }); }
}
