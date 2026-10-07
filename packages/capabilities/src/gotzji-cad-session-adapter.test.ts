import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GotzjiCadSessionAdapter } from './gotzji-cad-session-adapter.js';
import { nativeBytesDigest, nativeFileDigest, type GotzjiNativeGrant } from './gotzji-native-contract.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const line = (delta = 0): Record<string, unknown> => ({ handle: '254', objectType: 'AcDbLine', layer: 'GOTZJI_TARGET', startPoint: [delta, delta, 0], endPoint: [10 + delta, delta, 0] });
function receipt(before = line(), after = before): Record<string, unknown> {
  return { native: { before, after, unrelatedPreserved: true }, nativePid: 12345, birth: '639269393227748505', providerVersion: '25.0.305.15253', owned: true, closed: true, originalSessionsPreserved: true, unrelatedHash: 'a'.repeat(64) };
}
async function fixture(): Promise<{ root: string; source: string; output: string; script: string; executable: string; grant: GotzjiNativeGrant; expected: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gotzji-cad-contract-'))); roots.push(root);
  const source = path.join(root, 'source.dwg'); const output = path.join(root, 'output.dwg'); const script = path.join(root, 'provider.ps1'); const executable = path.join(root, 'ZWCAD.exe');
  await Promise.all([writeFile(source, 'original DWG fixture'), writeFile(script, 'trusted provider fixture'), writeFile(executable, 'trusted executable fixture')]);
  return { root, source, output, script, executable, grant: { ownerId: 'owner', projectId: 'project', jobId: 'job', operationId: 'op', rootPath: root, proof: 'synthetic test enrollment' }, expected: await nativeFileDigest(source) };
}
async function adapter(f: Awaited<ReturnType<typeof fixture>>, verifyGrant: () => Promise<boolean>, runner: (script: string, input: unknown) => Promise<unknown>): Promise<GotzjiCadSessionAdapter> {
  return new GotzjiCadSessionAdapter({ scriptPath: f.script, scriptSha256: await nativeFileDigest(f.script), executable: f.executable, executableSha256: await nativeFileDigest(f.executable), verifyGrant, runner });
}
describe('CAD provider-owned session contract (synthetic seam, no native qualification)', () => {
  it('denies a forged grant before starting any native process', async () => {
    const f = await fixture(); const run = vi.fn(); const a = await adapter(f, async () => false, run);
    await expect(a.execute(f.grant, { operation: 'cad.entity.inspect', filePath: f.source, expectedSha256: f.expected, handle: '254' })).rejects.toMatchObject({ code: 'NATIVE_AUTHORITY_DENIED' });
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps fixture creation, arbitrary LISP and executable selection outside the public operation contract', async () => {
    const f = await fixture(); const run = vi.fn(); const a = await adapter(f, async () => true, run);
    for (const input of [
      { operation: 'cad.session.fixture', filePath: f.source, expectedSha256: f.expected, handle: '254' },
      { operation: 'cad.entity.inspect', filePath: f.source, expectedSha256: f.expected, handle: '254', lisp: '(arbitrary)' },
      { operation: 'cad.entity.inspect', filePath: f.source, expectedSha256: f.expected, handle: '254', executable: 'caller.exe' },
    ]) await expect(a.execute(f.grant, input)).rejects.toMatchObject({ code: 'NATIVE_INPUT_INVALID' });
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['owned', 'closed', 'originalSessionsPreserved'])('rejects unverified %s instead of treating ambient/unclosed CAD as acceptance', async (field) => {
    const f = await fixture(); const a = await adapter(f, async () => true, async () => ({ ...receipt(), [field]: false }));
    await expect(a.execute(f.grant, { operation: 'cad.entity.inspect', filePath: f.source, expectedSha256: f.expected, handle: '254' })).rejects.toMatchObject({ code: 'CAD_SESSION_OWNERSHIP_OR_RECEIPT_UNVERIFIED', outcome: 'unknown' });
  });
  it('checks the original grant again and independently reopens saved output before accepting a move', async () => {
    const f = await fixture(); const authorize = vi.fn(async () => true); let calls = 0;
    const a = await adapter(f, authorize, async (_script, input) => {
      calls++; const request = input as { operation: string };
      if (request.operation === 'cad.entity.move') { await writeFile(f.output, 'saved output fixture'); return receipt(line(), line(2)); }
      return receipt(line(2));
    });
    const result = await a.execute(f.grant, { operation: 'cad.entity.move', filePath: f.source, expectedSha256: f.expected, outputPath: f.output, handle: '254', displacement: [2, 2, 0] });
    expect(result.savedAndReopened).toBe(true); expect(result.originalPreserved).toBe(true); expect(calls).toBe(2); expect(authorize).toHaveBeenCalledTimes(2);
    expect(result.outputSha256).toBe(nativeBytesDigest(await readFile(f.output)));
  });
  it('rejects a mismatched native reopen and preserves the original source', async () => {
    const f = await fixture(); let calls = 0;
    const a = await adapter(f, async () => true, async () => {
      calls++; if (calls === 1) { await writeFile(f.output, 'saved output fixture'); return receipt(line(), line(2)); }
      return receipt(line(99));
    });
    await expect(a.execute(f.grant, { operation: 'cad.entity.move', filePath: f.source, expectedSha256: f.expected, outputPath: f.output, handle: '254', displacement: [2, 2, 0] })).rejects.toMatchObject({ code: 'CAD_SESSION_REOPEN_UNVERIFIED' });
    expect(await nativeFileDigest(f.source)).toBe(f.expected);
  });
  it('reports a retained partial effect when authority is revoked after saving and does not open another process', async () => {
    const f = await fixture(); let checks = 0;
    const run = vi.fn(async () => { await writeFile(f.output, 'saved output fixture'); return receipt(line(), line(2)); });
    const a = await adapter(f, async () => ++checks === 1, run);
    await expect(a.execute(f.grant, { operation: 'cad.entity.move', filePath: f.source, expectedSha256: f.expected, outputPath: f.output, handle: '254', displacement: [2, 2, 0] })).rejects.toMatchObject({ code: 'NATIVE_AUTHORITY_DENIED', outcome: 'unknown' });
    expect(run).toHaveBeenCalledTimes(1); expect(await nativeFileDigest(f.source)).toBe(f.expected); expect(await readFile(f.output, 'utf8')).toBe('saved output fixture');
  });
  it('refuses changed provider bytes between save and reopen rather than adopting another script', async () => {
    const f = await fixture();
    const run = vi.fn(async () => { await writeFile(f.output, 'saved output fixture'); await writeFile(f.script, 'changed provider bytes'); return receipt(line(), line(2)); });
    const a = await adapter(f, async () => true, run);
    await expect(a.execute(f.grant, { operation: 'cad.entity.move', filePath: f.source, expectedSha256: f.expected, outputPath: f.output, handle: '254', displacement: [2, 2, 0] })).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_CHANGED', outcome: 'unknown' });
    expect(run).toHaveBeenCalledTimes(1); expect(await nativeFileDigest(f.source)).toBe(f.expected);
  });
  it('does not start a process for cancellation received before admission', async () => {
    const f = await fixture(); const run = vi.fn(); const a = await adapter(f, async () => true, run); const controller = new AbortController(); controller.abort();
    await expect(a.execute(f.grant, { operation: 'cad.entity.inspect', filePath: f.source, expectedSha256: f.expected, handle: '254' }, controller.signal)).rejects.toMatchObject({ code: 'NATIVE_CANCELLED_BEFORE_START' });
    expect(run).not.toHaveBeenCalled();
  });
});
