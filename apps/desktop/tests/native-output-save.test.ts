import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { saveNativeSnapshot } from '../src/main/native-output-save.js';

it('reports a partial write, then saves exact bytes without overwriting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-native-save-test-'));
  try {
    const destination = path.join(root, 'output.xlsx');
    const bytes = Buffer.from([0, 255, 42, 128]);
    await expect(saveNativeSnapshot(destination, bytes, async file => { await file.writeFile(bytes.subarray(0, 2)); throw new Error('disk failure'); })).rejects.toThrow('NATIVE_OUTPUT_WRITE_INCOMPLETE');
    expect(await readFile(destination)).toEqual(bytes.subarray(0, 2));
    await unlink(destination);
    await saveNativeSnapshot(destination, bytes);
    expect(await readFile(destination)).toEqual(bytes);
    await expect(saveNativeSnapshot(destination, Buffer.from('different'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination)).toEqual(bytes);
    expect(await readdir(root)).toEqual(['output.xlsx']);
  } finally { await rm(root, { recursive: true }); }
});

it('refuses a destination replaced while the owned file is open without deleting either file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-native-save-test-'));
  try {
    const destination = path.join(root, 'output.xlsx'); const moved = path.join(root, 'original.xlsx');
    await expect(saveNativeSnapshot(destination, Buffer.from('verified'), async file => {
      await file.writeFile('verified');
      await rename(destination, moved);
      await writeFile(destination, 'replacement', { flag: 'wx' });
    })).rejects.toThrow('NATIVE_OUTPUT_WRITE_INCOMPLETE');
    expect(await readFile(destination, 'utf8')).toBe('replacement');
    expect(await readFile(moved, 'utf8')).toBe('verified');
  } finally { await rm(root, { recursive: true }); }
});

it('warns that the destination may be incomplete when closing fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-native-save-test-'));
  try {
    const destination = path.join(root, 'output.xlsx');
    await expect(saveNativeSnapshot(destination, Buffer.from('bytes'), async file => {
      await file.writeFile('bytes');
      const close = file.close.bind(file);
      file.close = async (): Promise<void> => { await close(); throw new Error('close failed'); };
    })).rejects.toThrow('NATIVE_OUTPUT_WRITE_INCOMPLETE');
    expect(await readFile(destination, 'utf8')).toBe('bytes');
  } finally { await rm(root, { recursive: true }); }
});
