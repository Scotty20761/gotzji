import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GotzjiNativeError } from '@lnwjud/capabilities/gotzji-native-contract';
import { prepareProductNativeOperation, signPreparedNativeOperation, assertPreparedNativeAuthorization, type NativeWorkerBinding, type AuthorizedNativeWorkerConfig } from './product-native.js';
import { executePreparedNativeOperation, readPreparedNativeState } from './product-native-broker.mjs';
import { replaceFileSync } from './product-security.mjs';
import type { RegisteredProject } from './types.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
let qualificationRoot = path.resolve(process.env.LOCALAPPDATA ?? process.cwd(), 'gotzji', 'qualification');
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(qualificationRoot, root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Native fixture cleanup scope denied');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(): Promise<{ project: RegisteredProject; scriptPath: string; scriptSha256: string; config: AuthorizedNativeWorkerConfig }> {
  await mkdir(qualificationRoot, { recursive: true }); qualificationRoot = await realpath(qualificationRoot);
  const root = await mkdtemp(path.join(qualificationRoot, 'product-native-test-')); roots.push(root);
  const projectRoot = path.join(root, 'project'); const effects = path.join(root, 'effects');
  await mkdir(projectRoot); await mkdir(effects); await writeFile(path.join(projectRoot, 'source.xlsx'), 'original');
  await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Explicit native project rule\n');
  const scriptPath = path.join(root, 'trusted.ps1'); await writeFile(scriptPath, 'trusted-provider');
  const project: RegisteredProject = { projectId: 'project', displayName: 'Native fixture', rootPath: projectRoot, owner: 'owner', resourceKey: 'project-resource', recipeIds: [] };
  const prepared = await prepareProductNativeOperation(project, { requestId: 'request-one', projectId: 'project', operation: 'excel.range.write', path: 'source.xlsx', outputPath: 'result.xlsx', sheet: 'Sheet', range: 'A1', values: [['after']] }, { scriptPath, scriptSha256: hash('trusted-provider') });
  const binding: NativeWorkerBinding = { owner: 'owner', jobId: 'job', epoch: 'epoch', generation: 1, session: 'session', intentRevision: 0, authorizationDigest: 'a'.repeat(64), policy: 'b'.repeat(64), token: 'c'.repeat(64), lease: 'private-lease', database: path.join(root, 'core.sqlite'), effectRoot: effects, text: JSON.stringify(prepared), grace: { mode: 'test-driver' } };
  return { project, scriptPath, scriptSha256: hash('trusted-provider'), config: { ...binding, nativeAuthorization: signPreparedNativeOperation(binding, prepared) } };
}
describe('native preparation and private worker binding', () => {
  it('retries only transient Windows receipt replacement failures while preserving the target', () => {
    let attempts = 0; let waits = 0;
    const rename = (): void => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('transient receipt lock'), { code: 'EPERM' });
    };
    replaceFileSync('candidate', 'receipt', { platform: 'win32', rename, wait: () => { waits += 1; } });
    expect(attempts).toBe(3); expect(waits).toBe(2);
    expect(() => replaceFileSync('candidate', 'receipt', {
      platform: 'win32', rename: () => { throw Object.assign(new Error('permanent failure'), { code: 'EINVAL' }); }, wait: () => { throw new Error('unexpected retry'); },
    })).toThrow('permanent failure');
  });
  it('derives frozen source/output scope, provider/global UI/project resources and actual project policies', async () => {
    const f = await fixture(); const prepared = assertPreparedNativeAuthorization(f.config);
    expect(prepared.native.resourceKeys).toContain('globalui:windows');
    expect(prepared.native.resourceKeys).toContain('project:project-resource');
    expect(prepared.native.resourceKeys.filter((key) => key.startsWith('native-document:'))).toHaveLength(2);
    expect(Object.values(prepared.projectPolicies).some((entry) => entry.path.endsWith('AGENTS.md'))).toBe(true);
    expect(prepared.native.input.filePath).toBe(path.join(f.project.rootPath, 'source.xlsx'));
  });
  it('rejects public absolute/traversal refs and model-controlled script, grants or command arguments', async () => {
    const f = await fixture(); const options = { scriptPath: f.scriptPath, scriptSha256: f.scriptSha256 };
    const input = { requestId: 'request', projectId: 'project', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet', range: 'A1' };
    await expect(prepareProductNativeOperation(f.project, { ...input, path: '../source.xlsx' }, options)).rejects.toThrow('NATIVE_SCOPE_DENIED');
    await expect(prepareProductNativeOperation(f.project, { ...input, path: path.join(f.project.rootPath, 'source.xlsx') }, options)).rejects.toThrow('NATIVE_INPUT_INVALID');
    for (const field of ['scriptPath', 'grant', 'executable', 'args']) await expect(prepareProductNativeOperation(f.project, { ...input, [field]: 'caller-supplied' }, options)).rejects.toThrow('NATIVE_INPUT_INVALID');
  });
  it('binds the full private owner/job/epoch/lease/generation/policy/native intent, rejecting signed-config drift', async () => {
    const f = await fixture();
    for (const change of [{ owner: 'foreign-owner' }, { epoch: 'different' }, { generation: 2 }, { lease: 'different-lease' }, { policy: 'd'.repeat(64) }, { effectRoot: f.project.rootPath }]) {
      expect(() => assertPreparedNativeAuthorization({ ...f.config, ...change })).toThrow();
    }
    const payload = JSON.parse(f.config.text) as { native: { resourceKeys: string[] } }; payload.native.resourceKeys = [];
    expect(() => assertPreparedNativeAuthorization({ ...f.config, text: JSON.stringify(payload) })).toThrow('NATIVE_INTENT_BINDING_DENIED');
  });
  it('does not admit a test runner into a real Claude profile', async () => {
    const f = await fixture(); const prepared = assertPreparedNativeAuthorization(f.config);
    const binding = { ...f.config, grace: { mode: 'claude' as const } };
    const config = { ...binding, nativeAuthorization: signPreparedNativeOperation(binding, prepared) };
    await expect(executePreparedNativeOperation(config, undefined, { testRunner: vi.fn() })).rejects.toThrow('NATIVE_TEST_RUNNER_DENIED');
    await expect(executePreparedNativeOperation(config)).rejects.toThrow('NATIVE_LIVE_AUTHORITY_REQUIRED');
  });
  it('binds trusted test modules and rejects forged paths, mode changes and changed bytes before import', async () => {
    const f = await fixture(); const prepared = assertPreparedNativeAuthorization(f.config);
    const modulePath = path.join(path.dirname(f.scriptPath), 'test-runner.mjs');
    const source = 'export const testRunner = () => { throw new Error("QUALIFICATION_RUNNER_CALLED"); };';
    await writeFile(modulePath, source);
    const binding = { ...f.config, nativeTestRunner: { path: modulePath, sha256: hash(source) } };
    const config = { ...binding, nativeAuthorization: signPreparedNativeOperation(binding, prepared) };
    expect(assertPreparedNativeAuthorization(config)).toEqual(prepared);
    for (const nativeTestRunner of [{ path: f.scriptPath, sha256: hash(source) }, { path: modulePath, sha256: 'd'.repeat(64) }]) {
      expect(() => assertPreparedNativeAuthorization({ ...config, nativeTestRunner })).toThrow('NATIVE_INTENT_BINDING_DENIED');
    }
    expect(() => signPreparedNativeOperation({ ...binding, grace: { mode: 'claude' } }, prepared)).toThrow('NATIVE_TEST_RUNNER_DENIED');
    expect(() => assertPreparedNativeAuthorization({ ...config, grace: { mode: 'claude' } })).toThrow('NATIVE_TEST_RUNNER_DENIED');
    await writeFile(modulePath, 'throw new Error("FORGED_MODULE_EXECUTED");');
    await expect(executePreparedNativeOperation(config)).rejects.toThrow('NATIVE_TEST_RUNNER_CHANGED');
  });
  it('rechecks live authority during admission and refuses a revoked provider invocation', async () => {
    const f = await fixture(); const runner = vi.fn(); let checks = 0;
    await expect(executePreparedNativeOperation(f.config, undefined, { testRunner: runner, verifyLiveAuthority: () => ++checks === 1 })).rejects.toMatchObject({ code: 'NATIVE_AUTHORITY_DENIED', outcome: 'none' });
    expect(runner).not.toHaveBeenCalled(); expect(checks).toBe(2);
  });
  it('retains effects as uncertain when live authority is revoked after native completion', async () => {
    const f = await fixture(); let checks = 0;
    const runner = async (): Promise<unknown> => {
      await writeFile(path.join(f.project.rootPath, 'result.xlsx'), 'after');
      return { operation: 'excel.range.write', provider: 'excel', providerVersion: '16', nativePid: 1, sourceSha256: hash('original'), outputSha256: hash('after'), originalPreserved: true, savedAndReopened: true, unrelatedPreserved: true, verified: true, before: {}, after: {} };
    };
    await expect(executePreparedNativeOperation(f.config, undefined, { testRunner: runner, verifyLiveAuthority: () => ++checks < 3 })).rejects.toMatchObject({ code: 'LIVE_AUTHORITY_DENIED', outcome: 'unknown' });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown' });
  });
  it('pins a CAD owned-session provider and executable rather than selecting ambient Office COM', async () => {
    const f = await fixture(); const source = path.join(f.project.rootPath, 'source.dwg'); const exe = path.join(path.dirname(f.scriptPath), 'ZWCAD.exe');
    await writeFile(source, 'native drawing'); await writeFile(exe, 'trusted-executable');
    const input = { requestId: 'cad-request', projectId: 'project', operation: 'cad.entity.inspect', path: 'source.dwg', handle: 'A1' };
    await expect(prepareProductNativeOperation(f.project, input, { scriptPath: f.scriptPath, scriptSha256: f.scriptSha256 })).rejects.toThrow('NATIVE_PROVIDER_NOT_CONFIGURED');
    const prepared = await prepareProductNativeOperation(f.project, input, { scriptPath: f.scriptPath, scriptSha256: f.scriptSha256, cad: { scriptPath: f.scriptPath, scriptSha256: f.scriptSha256, executable: exe, executableSha256: hash('trusted-executable') } });
    expect(prepared.native).toMatchObject({ provider: 'cad-session', cad: { executable: exe, executableSha256: hash('trusted-executable') } });
    // The layer table is read through the same owned session and takes no entity handle.
    const layers = await prepareProductNativeOperation(f.project, { requestId: 'cad-layers', projectId: 'project', operation: 'cad.layers.inspect', path: 'source.dwg' }, { scriptPath: f.scriptPath, scriptSha256: f.scriptSha256, cad: { scriptPath: f.scriptPath, scriptSha256: f.scriptSha256, executable: exe, executableSha256: hash('trusted-executable') } });
    expect(layers.native).toMatchObject({ provider: 'cad-session', input: { operation: 'cad.layers.inspect' } });
    await expect(prepareProductNativeOperation(f.project, { requestId: 'cad-layers', projectId: 'project', operation: 'cad.layers.inspect', path: 'source.dwg', handle: 'A1' }, { scriptPath: f.scriptPath, scriptSha256: f.scriptSha256, cad: { scriptPath: f.scriptPath, scriptSha256: f.scriptSha256, executable: exe, executableSha256: hash('trusted-executable') } })).rejects.toThrow('NATIVE_INPUT_INVALID');
  });
  it('rejects changed source bytes before calling a provider', async () => {
    const f = await fixture(); const runner = vi.fn();
    await writeFile(path.join(f.project.rootPath, 'source.xlsx'), 'changed');
    await expect(executePreparedNativeOperation(f.config, undefined, { testRunner: runner })).rejects.toThrow('NATIVE_FILE_VERSION_CONFLICT');
    expect(runner).not.toHaveBeenCalled();
  });
  it('retains signed before/after evidence and reuses one completed effect rather than invoking native work again', async () => {
    const f = await fixture();
    const runner = vi.fn(async (): Promise<unknown> => {
      await writeFile(path.join(f.project.rootPath, 'result.xlsx'), 'after');
      return { operation: 'excel.range.write', provider: 'excel', providerVersion: '16', nativePid: 1, sourceSha256: hash('original'), outputSha256: hash('after'), originalPreserved: true, savedAndReopened: true, unrelatedPreserved: true, verified: true, before: { selected: 'original' }, after: { selected: 'after' } };
    });
    await expect(executePreparedNativeOperation(f.config, undefined, { testRunner: runner })).resolves.toMatchObject({ state: 'completed', nativeReceipt: { verified: true } });
    await expect(executePreparedNativeOperation(f.config, undefined, { testRunner: runner })).resolves.toMatchObject({ state: 'completed' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'completed', outcome: 'verified' });
    expect(await readFile(path.join(f.project.rootPath, 'source.xlsx'), 'utf8')).toBe('original');
    await writeFile(path.join(f.project.rootPath, 'result.xlsx'), 'tampered');
    await expect(executePreparedNativeOperation(f.config, undefined, { testRunner: runner })).rejects.toThrow('NATIVE_ARTIFACT_CHANGED');
  });
  it('retains an uncertain native-stop fence and refuses replay after interruption', async () => {
    const f = await fixture(); const runner = vi.fn(async (): Promise<unknown> => { throw new GotzjiNativeError('NATIVE_TERMINATION_UNVERIFIED', undefined, 'unknown'); });
    await expect(executePreparedNativeOperation(f.config, undefined, { testRunner: runner })).rejects.toMatchObject({ code: 'NATIVE_TERMINATION_UNVERIFIED', outcome: 'unknown' });
    expect(readPreparedNativeState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown' });
    await expect(executePreparedNativeOperation(f.config, undefined, { testRunner: runner })).rejects.toThrow('NATIVE_EFFECT_RECONCILIATION_REQUIRED');
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
