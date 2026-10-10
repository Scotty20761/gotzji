import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GotzjiBrowserBinding, GotzjiBrowserNode, GotzjiBrowserTransport } from '@lnwjud/capabilities/gotzji-browser-provider-policy';
import { GotzjiBrowserProviderError } from '@lnwjud/capabilities/gotzji-browser-provider-policy';
import { nativeDigest } from '@lnwjud/capabilities/gotzji-native-contract';
import { prepareProductBrowserOperation, signPreparedBrowserOperation, assertPreparedBrowserAuthorization, type AuthorizedBrowserWorkerConfig, type BrowserWorkerBinding, type PreparedProductBrowserOperation, type ProductBrowserInput, type TrustedProductBrowserOptions, type TrustedProductBrowserSessionManifest } from './product-browser.js';
import { executePreparedBrowserOperation, readPreparedBrowserState } from './product-browser-broker.mjs';
import type { RegisteredProject } from './types.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
let qualificationRoot = path.resolve(process.env.LOCALAPPDATA ?? process.cwd(), 'gotzji', 'qualification');
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) { const relative = path.relative(qualificationRoot, root); if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Browser fixture cleanup scope denied'); await rm(root, { recursive: true, force: true }); }
});
async function fixture(): Promise<{ project: RegisteredProject; options: TrustedProductBrowserOptions; input: ProductBrowserInput; prepared: PreparedProductBrowserOperation; config: AuthorizedBrowserWorkerConfig; transport: GotzjiBrowserTransport; effectRoot: string; modulePath: string }> {
  await mkdir(qualificationRoot, { recursive: true }); qualificationRoot = await realpath(qualificationRoot);
  const root = await mkdtemp(path.join(qualificationRoot, 'product-browser-test-')); roots.push(root);
  const projectRoot = path.join(root, 'project'); const effectRoot = path.join(root, 'effects'); const profilePath = path.join(root, 'gotzji-browser-provider-owned');
  await mkdir(projectRoot); await mkdir(effectRoot); await mkdir(profilePath);
  await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Browser fixture rules\n');
  const executable = path.join(root, 'chrome.exe'); await writeFile(executable, 'trusted-fixture-executable');
  const modulePath = path.join(root, 'provider.mjs'); await writeFile(modulePath, 'trusted-browser-module');
  const binding: GotzjiBrowserBinding = { browserId: 'owned-browser', contextId: 'owned-process', profileId: nativeDigest(profilePath.toLowerCase()), tabId: 'tab-one', providerTabId: 'native-tab-one', url: 'http://127.0.0.1:12345/fixture', documentId: 'loader-one' };
  const session: TrustedProductBrowserSessionManifest = { schemaVersion: 1, sessionId: 'session-one', owner: 'owner', projectId: 'project', pid: 12345, pidBirth: '2026-10-07T00:00:00.0000000Z', executable, executableSha256: hash('trusted-fixture-executable'), profilePath, port: 12345, cdpBrowserContextId: 'owned-native-context', binding, allowedOrigins: ['http://127.0.0.1:12345'], fixtureMode: true };
  const manifestPath = path.join(root, 'browser-session.json'); const manifest = JSON.stringify(session); await writeFile(manifestPath, manifest);
  const project: RegisteredProject = { projectId: 'project', displayName: 'Browser fixture', rootPath: projectRoot, owner: 'owner', resourceKey: 'project-resource', recipeIds: [] };
  const options: TrustedProductBrowserOptions = { session, manifestPath, manifestSha256: hash(manifest), prerequisites: [{ path: modulePath, hash: hash('trusted-browser-module') }], verifyOwnedSession: async () => true, deadlineMs: 1000 };
  const input: ProductBrowserInput = { requestId: 'request-one', projectId: 'project', operation: 'browser.type', sessionId: 'session-one', tabId: binding.tabId, expectedUrl: binding.url, expectedDocumentId: binding.documentId, selector: '#note', text: 'after' };
  const prepared = await prepareProductBrowserOperation(project, input, options);
  const privateBinding: BrowserWorkerBinding = { owner: 'owner', jobId: 'job-one', epoch: 'epoch-one', generation: 1, session: 'private-worker', intentRevision: 0, authorizationDigest: 'a'.repeat(64), policy: 'b'.repeat(64), token: 'c'.repeat(64), lease: 'private-lease', database: path.join(root, 'core.sqlite'), effectRoot, text: JSON.stringify(prepared), grace: { mode: 'test-driver' } };
  const config = { ...privateBinding, browserAuthorization: signPreparedBrowserOperation(privateBinding, prepared) };
  let node: GotzjiBrowserNode = { count: 1, identity: 'note-text', tag: 'INPUT', text: '', value: 'before', editable: true, enabled: true, visible: true, protected: false };
  const transport: GotzjiBrowserTransport = { binding: vi.fn(async () => ({ ...binding })), inspect: vi.fn(async () => ({ ...node })), click: vi.fn(), fill: vi.fn(async (_selector, text) => { node = { ...node, value: text }; }) };
  return { project, options, input, prepared, config, transport, effectRoot, modulePath };
}
const authority = { verifyLiveAuthority: async (): Promise<boolean> => true, verifyOwnedSession: async (): Promise<boolean> => true };
describe('signed Grace browser provider preparation and broker', () => {
  it('refuses navigation outside the frozen enrolled origin scope and public attempts to broaden it', async () => {
    const f = await fixture(); const common = { requestId: 'navigate-one', projectId: f.project.projectId, operation: 'browser.navigate', sessionId: f.options.session.sessionId, tabId: f.options.session.binding.tabId, expectedUrl: f.options.session.binding.url, expectedDocumentId: f.options.session.binding.documentId, url: 'https://nodejs.org/api/url.html' };
    await expect(prepareProductBrowserOperation(f.project, common, f.options)).rejects.toThrow('BROWSER_ORIGIN_SCOPE_DENIED');
    await expect(prepareProductBrowserOperation(f.project, { ...common, allowedOrigins: ['https://nodejs.org'] }, f.options)).rejects.toThrow('BROWSER_INPUT_INVALID');
  });
  it('freezes session/tab/URL/native prerequisites and server-derived resources after reading actual project policy', async () => {
    const f = await fixture(); expect(Object.isFrozen(f.prepared.browser.session.binding)).toBe(true);
    expect(f.prepared.browser.resourceKeys).toContain('project:project-resource');
    expect(f.prepared.browser.resourceKeys).not.toContain('globalui:windows');
    expect(f.prepared.browser.adapterResourceKeys).toHaveLength(2);
    expect(Object.values(f.prepared.projectPolicies).some(entry => entry.path.endsWith('AGENTS.md'))).toBe(true);
  });
  it('refuses public provider paths, ports, profiles, grants and arbitrary JavaScript', async () => {
    const f = await fixture(); for (const key of ['profilePath', 'port', 'pid', 'manifestPath', 'grant', 'expression']) await expect(prepareProductBrowserOperation(f.project, { ...f.input, [key]: 'caller-controlled' }, f.options)).rejects.toThrow('BROWSER_INPUT_INVALID');
  });
  it('requires the exact enrolled session/tab/URL/document and a mandatory owner verifier', async () => {
    const f = await fixture();
    for (const key of ['sessionId', 'tabId', 'expectedUrl', 'expectedDocumentId']) await expect(prepareProductBrowserOperation(f.project, { ...f.input, [key]: 'different' }, f.options)).rejects.toThrow('BROWSER_DOCUMENT_CHANGED');
    await expect(prepareProductBrowserOperation(f.project, f.input, { ...f.options, verifyOwnedSession: undefined as never })).rejects.toThrow('BROWSER_SESSION_VERIFIER_REQUIRED');
    await expect(prepareProductBrowserOperation(f.project, f.input, { ...f.options, verifyOwnedSession: async () => false })).rejects.toThrow('BROWSER_SESSION_UNVERIFIED');
  });
  it('rejects changed manifest/executable/provider prerequisite bytes before preparation', async () => {
    const f = await fixture(); await writeFile(f.modulePath, 'changed'); await expect(prepareProductBrowserOperation(f.project, f.input, f.options)).rejects.toThrow('BROWSER_PREREQUISITE_CHANGED');
  });
  it('rejects signed worker owner/lease/epoch/scope/provider drift and unauthorized test modules', async () => {
    const f = await fixture();
    for (const change of [{ owner: 'foreign-owner' }, { epoch: 'different-epoch' }, { generation: 2 }, { lease: 'different-lease' }, { effectRoot: f.project.rootPath }, { policy: 'd'.repeat(64) }]) expect(() => assertPreparedBrowserAuthorization({ ...f.config, ...change })).toThrow();
    const text = JSON.parse(f.config.text) as PreparedProductBrowserOperation; const altered = { ...text, browser: { ...text.browser, resourceKeys: [] } };
    expect(() => assertPreparedBrowserAuthorization({ ...f.config, text: JSON.stringify(altered) })).toThrow('BROWSER_INTENT_BINDING_DENIED');
    expect(() => signPreparedBrowserOperation({ ...f.config, browserTestTransport: { path: f.modulePath, sha256: hash('trusted-browser-module') }, grace: { mode: 'claude' } }, f.prepared)).toThrow('BROWSER_TEST_TRANSPORT_DENIED');
  });
  it('requires live owner authority and session ownership in every mode', async () => {
    const f = await fixture(); await expect(executePreparedBrowserOperation(f.config, undefined, { testTransport: f.transport })).rejects.toThrow('BROWSER_LIVE_AUTHORITY_REQUIRED');
    await expect(executePreparedBrowserOperation(f.config, undefined, { ...authority, verifyOwnedSession: async () => false, testTransport: f.transport })).rejects.toMatchObject({ code: 'BROWSER_SESSION_UNVERIFIED', outcome: 'none' });
    expect(f.transport.fill).not.toHaveBeenCalled();
  });
  it('refuses test transport injection into a real Claude worker', async () => {
    const f = await fixture(); const binding = { ...f.config, grace: { mode: 'claude' as const } }; const config = { ...binding, browserAuthorization: signPreparedBrowserOperation(binding, f.prepared) };
    await expect(executePreparedBrowserOperation(config, undefined, { ...authority, testTransport: f.transport })).rejects.toThrow('BROWSER_TEST_TRANSPORT_DENIED');
  });
  it('records one signed completed effect and reuses its receipt without replay', async () => {
    const f = await fixture(); const options = { ...authority, testTransport: f.transport };
    await expect(executePreparedBrowserOperation(f.config, undefined, options)).resolves.toMatchObject({ state: 'completed', browserReceipt: { verified: true, effect: 'verified' } });
    await expect(executePreparedBrowserOperation(f.config, undefined, options)).resolves.toMatchObject({ state: 'completed' });
    expect(f.transport.fill).toHaveBeenCalledTimes(1); expect(readPreparedBrowserState(f.config)).toMatchObject({ state: 'completed', outcome: 'verified' });
    expect(await readFile(path.join(f.effectRoot, 'browser-operation.json'), 'utf8')).not.toContain('private-lease');
  });
  it('coalesces concurrent same-operation requests into one native dispatch', async () => {
    const f = await fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.transport.fill).mockImplementation(async () => { await wait; });
    const options = { ...authority, testTransport: f.transport }; const first = executePreparedBrowserOperation(f.config, undefined, options); const second = executePreparedBrowserOperation(f.config, undefined, options); release();
    await expect(first).rejects.toMatchObject({ code: 'BROWSER_POSTCONDITION_FAILED', outcome: 'unknown' }); await expect(second).rejects.toMatchObject({ code: 'BROWSER_POSTCONDITION_FAILED', outcome: 'unknown' });
    expect(f.transport.fill).toHaveBeenCalledTimes(1);
  });
  it('writes unknown effects after response loss and refuses every later replay', async () => {
    const f = await fixture(); vi.mocked(f.transport.fill).mockRejectedValue(new Error('sensitive-provider-error-must-not-escape')); const options = { ...authority, testTransport: f.transport };
    await expect(executePreparedBrowserOperation(f.config, undefined, options)).rejects.toMatchObject({ code: 'BROWSER_PROVIDER_FAILED', outcome: 'unknown' });
    expect(readPreparedBrowserState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown' });
    await expect(executePreparedBrowserOperation(f.config, undefined, options)).rejects.toThrow('BROWSER_EFFECT_RECONCILIATION_REQUIRED'); expect(f.transport.fill).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(f.effectRoot, 'browser-operation.json'), 'utf8')).not.toContain('sensitive-provider-error');
  });
  it('retains a fence when authority is revoked after native mutation', async () => {
    const f = await fixture(); let mutated = false; const fill = vi.mocked(f.transport.fill).getMockImplementation()!;
    vi.mocked(f.transport.fill).mockImplementation(async (...args) => { await fill(...args); mutated = true; });
    await expect(executePreparedBrowserOperation(f.config, undefined, { ...authority, verifyLiveAuthority: async () => !mutated, testTransport: f.transport })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(readPreparedBrowserState(f.config)).toMatchObject({ state: 'uncertain', outcome: 'unknown' });
  });
  it('records pre-dispatch cancellation as no effect and does not invoke native input', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(executePreparedBrowserOperation(f.config, controller.signal, { ...authority, testTransport: f.transport })).rejects.toMatchObject({ code: 'BROWSER_CANCELLED', outcome: 'none' }); expect(f.transport.fill).not.toHaveBeenCalled();
    expect(readPreparedBrowserState(f.config)).toMatchObject({ state: 'not-started', outcome: 'none' });
  });
  it('rejects changed prerequisite or forged evidence before native replay', async () => {
    const f = await fixture(); const options = { ...authority, testTransport: f.transport };
    await writeFile(f.modulePath, 'tampered'); await expect(executePreparedBrowserOperation(f.config, undefined, options)).rejects.toMatchObject({ code: 'BROWSER_PREREQUISITE_CHANGED', outcome: 'none' }); expect(f.transport.fill).not.toHaveBeenCalled();
    await writeFile(path.join(f.effectRoot, 'browser-operation.json'), 'malformed'); expect(() => readPreparedBrowserState(f.config)).toThrow('BROWSER_EVIDENCE_INVALID');
  });
  it('rejects protected objects with signed no-effect evidence', async () => {
    const f = await fixture(); vi.mocked(f.transport.inspect).mockImplementation(async () => { throw new GotzjiBrowserProviderError('BROWSER_WAITING_FOR_USER'); });
    await expect(executePreparedBrowserOperation(f.config, undefined, { ...authority, testTransport: f.transport })).rejects.toMatchObject({ code: 'BROWSER_WAITING_FOR_USER', outcome: 'none' }); expect(f.transport.fill).not.toHaveBeenCalled();
  });
});
