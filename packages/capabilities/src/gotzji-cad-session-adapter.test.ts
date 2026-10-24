import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GotzjiCadSessionAdapter } from './gotzji-cad-session-adapter.js';
import { nativeBytesDigest, nativeFileDigest, planGotzjiNativeOperation, type GotzjiNativeGrant } from './gotzji-native-contract.js';
import { GotzjiNativeNoLaunchError, type GotzjiNativeProcessEvidenceBinding, type GotzjiNativeProcessInvocation } from './gotzji-native-adapter.js';

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
async function adapter(f: Awaited<ReturnType<typeof fixture>>, verifyGrant: () => Promise<boolean>, runner: (script: string, input: unknown, signal?: AbortSignal, evidence?: GotzjiNativeProcessInvocation, beforeSpawn?: () => Promise<void>) => Promise<unknown>, processEvidence?: GotzjiNativeProcessEvidenceBinding, beforeProviderSpawn?: () => Promise<void>): Promise<GotzjiCadSessionAdapter> {
  return new GotzjiCadSessionAdapter({ scriptPath: f.script, scriptSha256: await nativeFileDigest(f.script), executable: f.executable, executableSha256: await nativeFileDigest(f.executable), verifyGrant, runner, ...(processEvidence ? { processEvidence } : {}), ...(beforeProviderSpawn ? { beforeProviderSpawn } : {}) });
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
    const f = await fixture(); const authorize = vi.fn(async () => true); const dispatch = vi.fn(async () => undefined); let calls = 0; const invocations: string[] = [];
    const operation = { operation: 'cad.entity.move' as const, filePath: f.source, expectedSha256: f.expected, outputPath: f.output, handle: '254', displacement: [2, 2, 0] as const };
    const plan = await planGotzjiNativeOperation(operation, f.root);
    const processEvidence = { schemaVersion: 1 as const, effectRoot: f.root, journalPath: path.join(f.root, 'native-process-identities.jsonl'), jobId: 'job', epoch: 'epoch', generation: 1, planDigest: plan.digest, provider: 'cad-session' as const, evidenceKey: 'a'.repeat(64) };
    const a = await adapter(f, authorize, async (_script, input, _signal, evidence, beforeSpawn) => {
      await beforeSpawn?.();
      if (evidence) invocations.push(evidence.invocationId);
      calls++; const request = input as { operation: string };
      if (request.operation === 'cad.entity.move') { await writeFile(f.output, 'saved output fixture'); return receipt(line(), line(2)); }
      return receipt(line(2));
    }, processEvidence, dispatch);
    const result = await a.execute(f.grant, operation);
    expect(result.savedAndReopened).toBe(true); expect(result.originalPreserved).toBe(true); expect(calls).toBe(2); expect(authorize).toHaveBeenCalledTimes(2);
    expect(invocations).toHaveLength(2); expect(new Set(invocations).size).toBe(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, 1); expect(dispatch).toHaveBeenNthCalledWith(2, 2);
    expect(result.outputSha256).toBe(nativeBytesDigest(await readFile(f.output)));
  });
  it('keeps first-invocation evidence when the CAD reopen helper cannot launch on attempt two', async () => {
    const f = await fixture(); const operation = { operation: 'cad.entity.move' as const, filePath: f.source, expectedSha256: f.expected, outputPath: f.output, handle: '254', displacement: [2, 2, 0] as const };
    const plan = await planGotzjiNativeOperation(operation, f.root); const journal = path.join(f.root, 'native-process-identities.jsonl');
    const processEvidence = { schemaVersion: 1 as const, effectRoot: f.root, journalPath: journal, jobId: 'job', epoch: 'epoch', generation: 1, planDigest: plan.digest, provider: 'cad-session' as const, evidenceKey: 'a'.repeat(64) };
    const dispatch = vi.fn(async () => undefined); let calls = 0;
    const a = await adapter(f, async () => true, async (_script, _input, _signal, _evidence, beforeSpawn) => {
      await beforeSpawn?.(); calls += 1;
      if (calls === 1) { await writeFile(journal, 'first-invocation-evidence'); await writeFile(f.output, 'saved output fixture'); return receipt(line(), line(2)); }
      throw new GotzjiNativeNoLaunchError('synchronous-spawn-throw');
    }, processEvidence, dispatch);
    await expect(a.execute(f.grant, operation)).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_START_FAILED', confirmedNoProviderProcess: true });
    expect(dispatch).toHaveBeenNthCalledWith(1, 1); expect(dispatch).toHaveBeenNthCalledWith(2, 2); expect(await readFile(journal, 'utf8')).toBe('first-invocation-evidence');
  });
  it('reads the layer table, Thai names and colour methods included, and keeps the original untouched (incident I6)', async () => {
    const f = await fixture();
    const zero = { name: '0', method: 195, index: 7, rgb: [255, 255, 255], book: '', colorName: '', linetype: 'Continuous', lineweight: -3, on: true, frozen: false, locked: false, plottable: true };
    const thai = { ...zero, name: 'เลเยอร์', frozen: true, locked: true, plottable: false };
    const rgb = { ...zero, name: 'GJ_RGB', method: 194, index: 168, rgb: [10, 20, 30] };
    const table = { count: 3, current: '0', digest: 'b'.repeat(64), layers: [zero, thai, rgb] };
    const session = { ...receipt(), native: table };
    const requests: unknown[] = [];
    const a = await adapter(f, async () => true, async (_script, input) => { requests.push(input); return session; });
    const result = await a.execute(f.grant, { operation: 'cad.layers.inspect', filePath: f.source, expectedSha256: f.expected });
    expect(result).toMatchObject({ operation: 'cad.layers.inspect', outputSha256: null, savedAndReopened: false, originalPreserved: true, before: table, after: null });
    expect(requests).toEqual([{ operation: 'cad.layers.inspect', filePath: f.source, expectedSha256: f.expected, executable: f.executable }]);
    // A table that does not hold together is refused; nothing was written, so nothing happened.
    for (const native of [{ ...table, count: 4 }, { ...table, current: 'absent' }, { ...table, layers: [zero, { ...rgb, rgb: [10, 20, 300] }, thai] }, { ...table, layers: [zero, { ...thai, name: '' }, rgb] },
      { ...table, layers: [zero, thai, { ...rgb, name: 'gj_rgb' }, { ...rgb, name: 'GJ_RGB' }], count: 4 }, { ...table, digest: 'not-a-digest' }]) {
      const broken = await adapter(f, async () => true, async () => ({ ...receipt(), native }));
      await expect(broken.execute(f.grant, { operation: 'cad.layers.inspect', filePath: f.source, expectedSha256: f.expected })).rejects.toMatchObject({ code: 'CAD_LAYER_TABLE_UNVERIFIED', outcome: 'none' });
    }
    // An entity handle is not part of this operation.
    await expect(a.execute(f.grant, { operation: 'cad.layers.inspect', filePath: f.source, expectedSha256: f.expected, handle: '254' })).rejects.toMatchObject({ code: 'NATIVE_INPUT_INVALID' });
  });
  it('records that ZWCAD asked about an earlier crash, so the owner can learn of it', async () => {
    const f = await fixture();
    const a = await adapter(f, async () => true, async () => ({ ...receipt(line()), crashPromptDeclined: true }));
    expect(await a.execute(f.grant, { operation: 'cad.entity.inspect', filePath: f.source, expectedSha256: f.expected, handle: '254' })).toMatchObject({ crashPromptDeclined: true });
    const quiet = await adapter(f, async () => true, async () => receipt(line()));
    expect(await quiet.execute(f.grant, { operation: 'cad.entity.inspect', filePath: f.source, expectedSha256: f.expected, handle: '254' })).not.toHaveProperty('crashPromptDeclined');
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
