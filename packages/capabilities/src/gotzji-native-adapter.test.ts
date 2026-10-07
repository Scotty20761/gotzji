import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GotzjiNativeAdapter, gotzjiNativeChildEnvironment } from './gotzji-native-adapter.js';
import { nativeBytesDigest, planGotzjiNativeOperation, type GotzjiNativeGrant } from './gotzji-native-contract.js';
import { GotzjiNativeBrowserAdapter } from './gotzji-native-browser.js';
import type { BrowserCdpProtocol } from './browser-cdp-backend.js';

let qualificationRoot = path.resolve(process.env.LOCALAPPDATA ?? process.cwd(), 'gotzji', 'qualification');
const fixtures: string[] = [];
afterEach(async () => {
  for (const directory of fixtures.splice(0)) {
    const relative = path.relative(qualificationRoot, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture cleanup scope denied');
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture(): Promise<{ root: string; source: string; output: string; script: string; grant: GotzjiNativeGrant }> {
  await mkdir(qualificationRoot, { recursive: true });
  qualificationRoot = await realpath(qualificationRoot);
  const root = await mkdtemp(path.join(qualificationRoot, 'native-adapter-test-')); fixtures.push(root);
  const source = path.join(root, 'source.xlsx'); const output = path.join(root, 'result.xlsx'); const script = path.join(root, 'provider.ps1');
  await writeFile(source, 'original'); await writeFile(script, 'pinned provider');
  return { root, source, output, script, grant: { ownerId: 'owner', projectId: 'project', jobId: 'job', operationId: 'operation', rootPath: root, proof: 'private-proof' } };
}
function input(source: string, output: string): Record<string, unknown> {
  return { operation: 'excel.range.write', filePath: source, outputPath: output, expectedSha256: nativeBytesDigest(Buffer.from('original')), sheet: 'Sheet', range: 'A1', values: [['after']] };
}

describe('gotzji native admission and verification', () => {
  it('keeps Windows native prerequisites while excluding inherited credentials and incompatible module paths', () => {
    const environment = gotzjiNativeChildEnvironment({ SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Owner', CLAUDE_API_KEY: 'private', SOME_AUTH: 'private', NODE_OPTIONS: 'untrusted-loader', PSModulePath: 'PowerShell-7-modules' });
    expect(environment.USERPROFILE).toBe('C:\\Owner');
    expect(environment.PSModulePath).toContain('WindowsPowerShell');
    expect(environment.CLAUDE_API_KEY).toBeUndefined(); expect(environment.SOME_AUTH).toBeUndefined(); expect(environment.NODE_OPTIONS).toBeUndefined();
  });
  it('requires an authentic host grant and provider pin before invoking native code', async () => {
    const f = await fixture(); const runner = vi.fn();
    const adapter = new GotzjiNativeAdapter({ scriptPath: f.script, scriptSha256: nativeBytesDigest(Buffer.from('pinned provider')), verifyGrant: async (): Promise<boolean> => false, runner });
    await expect(adapter.execute(f.grant, input(f.source, f.output))).rejects.toThrow('NATIVE_AUTHORITY_DENIED');
    expect(runner).not.toHaveBeenCalled();
    const wrongPin = new GotzjiNativeAdapter({ scriptPath: f.script, scriptSha256: '0'.repeat(64), verifyGrant: async (): Promise<boolean> => true, runner });
    await expect(wrongPin.execute(f.grant, input(f.source, f.output))).rejects.toThrow('NATIVE_PROVIDER_CHANGED');
    expect(runner).not.toHaveBeenCalled();
  });
  it('denies stale bytes, existing output, invalid matrices and unexpected/raw fields without changing originals', async () => {
    const f = await fixture();
    await expect(planGotzjiNativeOperation({ ...input(f.source, f.output), expectedSha256: '0'.repeat(64) }, f.root)).rejects.toThrow('NATIVE_FILE_VERSION_CONFLICT');
    await expect(planGotzjiNativeOperation({ ...input(f.source, f.output), values: ['after'] }, f.root)).rejects.toThrow('values');
    await expect(planGotzjiNativeOperation({ ...input(f.source, f.output), executable: 'anything' }, f.root)).rejects.toThrow('NATIVE_INPUT_INVALID');
    await writeFile(f.output, 'existing');
    await expect(planGotzjiNativeOperation(input(f.source, f.output), f.root)).rejects.toThrow('NATIVE_OUTPUT_EXISTS');
    expect(await readFile(f.source, 'utf8')).toBe('original'); expect(await readFile(f.output, 'utf8')).toBe('existing');
  });
  it('derives document/provider resources and rejects output targets outside the enrolled project', async () => {
    const f = await fixture();
    const plan = await planGotzjiNativeOperation(input(f.source, f.output), f.root);
    expect(plan.resourceKeys).toHaveLength(3); expect(plan.resourceKeys[0]).toBe('native-provider:excel');
    await expect(planGotzjiNativeOperation(input(f.source, path.join(qualificationRoot, 'outside.xlsx')), f.root)).rejects.toThrow('NATIVE_SCOPE_DENIED');
  });
  it('independently checks original and returned output hashes rather than accepting preservation flags', async () => {
    const f = await fixture();
    const adapter = new GotzjiNativeAdapter({ scriptPath: f.script, scriptSha256: nativeBytesDigest(Buffer.from('pinned provider')), verifyGrant: async (): Promise<boolean> => true,
      runner: async (): Promise<unknown> => {
        await writeFile(f.output, 'wrong result');
        return { operation: 'excel.range.write', provider: 'excel', providerVersion: '16.0', nativePid: 123, sourceSha256: nativeBytesDigest(Buffer.from('original')), outputSha256: '0'.repeat(64), originalPreserved: true, savedAndReopened: true, unrelatedPreserved: true, verified: true, before: {}, after: {} };
      } });
    await expect(adapter.execute(f.grant, input(f.source, f.output))).rejects.toMatchObject({ code: 'NATIVE_PRESERVATION_FAILED', outcome: 'unknown' });
    expect(await readFile(f.source, 'utf8')).toBe('original');
  });
  it('aborting before provider startup does not invoke it or claim an effect', async () => {
    const f = await fixture(); const runner = vi.fn(); const signal = AbortSignal.abort();
    const adapter = new GotzjiNativeAdapter({ scriptPath: f.script, scriptSha256: nativeBytesDigest(Buffer.from('pinned provider')), verifyGrant: async (): Promise<boolean> => true, runner });
    await expect(adapter.execute(f.grant, input(f.source, f.output), signal)).rejects.toMatchObject({ code: 'NATIVE_CANCELLED_BEFORE_START', outcome: 'none' });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('gotzji selected browser admission', () => {
  it('rejects a changed selected tab document before dispatch', async () => {
    const f = await fixture(); const dispatch = vi.fn();
    const protocol: BrowserCdpProtocol = { status: async () => ({ ready: true, port: 1 }), listTabs: async () => [{ id: 'tab', type: 'page', title: 'Fixture', url: 'https://changed.example' }], newTab: vi.fn(), closeTab: vi.fn(), request: dispatch };
    const adapter = new GotzjiNativeBrowserAdapter(protocol, async () => true);
    await expect(adapter.execute(f.grant, { operation: 'browser.query', tabId: 'tab', expectedUrl: 'https://selected.example', selector: '#input' })).rejects.toThrow('BROWSER_DOCUMENT_CHANGED');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('requires a verified grant before reading browser tabs', async () => {
    const f = await fixture(); const listTabs = vi.fn();
    const protocol: BrowserCdpProtocol = { status: async () => ({ ready: true, port: 1 }), listTabs, newTab: vi.fn(), closeTab: vi.fn(), request: vi.fn() };
    const adapter = new GotzjiNativeBrowserAdapter(protocol, async () => false);
    await expect(adapter.execute(f.grant, { operation: 'browser.query', tabId: 'tab', expectedUrl: 'https://selected.example', selector: '#input' })).rejects.toThrow('NATIVE_AUTHORITY_DENIED');
    expect(listTabs).not.toHaveBeenCalled();
  });
  it('dispatches only a selected typed click and independently observes its postcondition', async () => {
    const f = await fixture(); let text = 'before'; const expressions: string[] = [];
    const protocol: BrowserCdpProtocol = { status: async () => ({ ready: true, port: 1 }), listTabs: async () => [{ id: 'tab', type: 'page', title: 'Fixture', url: 'https://selected.example' }], newTab: vi.fn(), closeTab: vi.fn(),
      request: async (tabId, method, params) => {
        expect(tabId).toBe('tab'); expect(method).toBe('Runtime.evaluate');
        const expression = String(params.expression); expressions.push(expression);
        if (expression.includes('el.click()')) { text = 'after'; return { result: { result: { value: { ok: true } } } }; }
        return { result: { result: { value: { ok: true, text, tag: 'BUTTON' } } } };
      } };
    const adapter = new GotzjiNativeBrowserAdapter(protocol, async () => true);
    await expect(adapter.execute(f.grant, { operation: 'browser.click', tabId: 'tab', expectedUrl: 'https://selected.example', selector: '#button', postSelector: '#state', expectedPostText: 'after' })).resolves.toMatchObject({ tabId: 'tab', verified: true });
    expect(expressions).toHaveLength(3); expect(expressions.every((expression) => expression.includes('location.href'))).toBe(true);
  });
});
