import { createHash } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { GotzjiBrowserProvider, GotzjiBrowserProviderError, type GotzjiBrowserBinding, type GotzjiBrowserNode, type GotzjiBrowserProviderOperation, type GotzjiBrowserTransport } from './gotzji-browser-provider-policy.js';

const binding: GotzjiBrowserBinding = { browserId: 'owned-chrome', contextId: 'process-start-20761', profileId: 'owned-profile-1', tabId: 'explicit-tab', providerTabId: 'native-tab-1', url: 'http://127.0.0.1:43210/fixture', documentId: 'loader-1' };
const grant = { ownerId: 'owner-1', projectId: 'project-1', jobId: 'job-1', operationId: 'operation-1', rootPath: 'E:/owned-fixture', proof: 'synthetic-test-grant' };
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function fixture(): { provider: GotzjiBrowserProvider; transport: GotzjiBrowserTransport; verify: Mock<() => Promise<boolean>>; nodes: Map<string, GotzjiBrowserNode>; changeBinding: (value: Partial<GotzjiBrowserBinding>) => void } {
  let current = { ...binding };
  const nodes = new Map<string, GotzjiBrowserNode>([
    ['#note', { count: 1, identity: 'note-text', tag: 'INPUT', text: '', value: 'original', editable: true, enabled: true, visible: true, protected: false }],
    ['#apply', { count: 1, identity: 'apply-button', tag: 'BUTTON', text: 'Apply', value: null, editable: false, enabled: true, visible: true, protected: false }],
    ['#result', { count: 1, identity: 'result-output', tag: 'P', text: 'Not applied', value: null, editable: false, enabled: true, visible: true, protected: false }],
    ['#secret', { count: 1, identity: 'secret-input', tag: 'INPUT', text: '', value: null, editable: true, enabled: true, visible: true, protected: true }],
    ['#keep', { count: 1, identity: 'keep', tag: 'P', text: 'unrelated preserved', value: null, editable: false, enabled: true, visible: true, protected: false }],
  ]);
  const transport: GotzjiBrowserTransport = {
    binding: vi.fn(async () => ({ ...current })),
    inspect: vi.fn(async (selector) => nodes.get(selector) ?? { count: 0, identity: '', tag: '', text: '', value: null, editable: false, enabled: false, visible: false, protected: false }),
    fill: vi.fn(async (selector, text, identity) => { const node = nodes.get(selector)!; if (node.identity !== identity) throw new Error('changed'); nodes.set(selector, { ...node, value: text }); }),
    click: vi.fn(async () => { nodes.set('#result', { ...nodes.get('#result')!, text: `Applied: ${nodes.get('#note')!.value}` }); }),
  };
  const verify = vi.fn(async () => true);
  const provider = new GotzjiBrowserProvider(transport, digest, verify);
  return { provider, transport, verify, nodes, changeBinding: (value: Partial<GotzjiBrowserBinding>): void => { current = { ...current, ...value }; } };
}
const type = (): GotzjiBrowserProviderOperation => ({ operation: 'browser.type', binding: { ...binding }, selector: '#note', text: 'native qualification' });
const workflow = (): GotzjiBrowserProviderOperation => ({ operation: 'browser.workflow', binding: { ...binding }, steps: [
  { operation: 'browser.type', selector: '#note', text: 'native qualification' },
  { operation: 'browser.click', selector: '#apply', postSelector: '#result', expectedPostText: 'Applied: native qualification' },
  { operation: 'browser.read', selector: '#keep' },
] });

describe('gotzji selected browser provider policy', () => {
  it('navigates only within frozen owner scope and returns a fresh document binding for later workflow steps', async () => {
    const f = fixture(); f.transport.navigate = vi.fn(async (url) => { f.changeBinding({ url, documentId: 'loader-2' }); return f.transport.binding(); });
    const provider = new GotzjiBrowserProvider(f.transport, digest, f.verify, { allowedOrigins: ['http://127.0.0.1:43210', 'https://nodejs.org'], fixtureMode: true });
    const receipt = await provider.execute(grant, { operation: 'browser.workflow', binding, steps: [{ operation: 'browser.navigate', url: 'https://nodejs.org/api/url.html' }, { operation: 'browser.read', selector: '#keep' }] });
    expect(receipt.initialBinding).toEqual(binding); expect(receipt.binding).toMatchObject({ url: 'https://nodejs.org/api/url.html', documentId: 'loader-2', tabId: binding.tabId });
    expect(receipt.steps[0]?.after).toMatchObject({ tag: 'DOCUMENT', text: 'https://nodejs.org/api/url.html', identity: 'loader-2' }); expect(receipt.steps[1]?.after.text).toBe('unrelated preserved');
  });
  it('cannot broaden a frozen origin scope by mutating the original options', async () => {
    const f = fixture(); f.transport.navigate = vi.fn(); const origins = ['http://127.0.0.1:43210'];
    const provider = new GotzjiBrowserProvider(f.transport, digest, f.verify, { allowedOrigins: origins, fixtureMode: true }); origins.push('https://site.invalid');
    await expect(provider.execute(grant, { operation: 'browser.navigate', binding, url: 'https://site.invalid/' })).rejects.toMatchObject({ code: 'BROWSER_ORIGIN_SCOPE_DENIED', effect: 'none' }); expect(f.transport.navigate).not.toHaveBeenCalled();
  });
  it('requires an explicit owner origin scope before navigation', async () => {
    const f = fixture(); f.transport.navigate = vi.fn();
    await expect(f.provider.execute(grant, { operation: 'browser.navigate', binding, url: 'https://nodejs.org/api/url.html' })).rejects.toMatchObject({ code: 'BROWSER_ORIGIN_SCOPE_REQUIRED', effect: 'none' }); expect(f.transport.navigate).not.toHaveBeenCalled();
  });
  it('retains an unknown fence if a navigation changes the chosen tab or does not obtain a fresh document', async () => {
    const f = fixture(); f.transport.navigate = vi.fn(async () => ({ ...binding, url: 'https://nodejs.org/api/url.html', tabId: 'another-tab' }));
    const provider = new GotzjiBrowserProvider(f.transport, digest, f.verify, { allowedOrigins: ['http://127.0.0.1:43210', 'https://nodejs.org'], fixtureMode: true });
    await expect(provider.execute(grant, { operation: 'browser.navigate', binding, url: 'https://nodejs.org/api/url.html' })).rejects.toMatchObject({ code: 'BROWSER_POSTCONDITION_FAILED', effect: 'unknown', releaseResources: false });
  });
  it.each(['https://user:password@nodejs.org/api/url.html', 'javascript:alert(1)', 'https://nodejs.org/?%74oken=private'])('rejects credential-bearing or executable destination %s before dispatch', (url) => {
    const f = fixture(); expect(() => f.provider.prepare({ operation: 'browser.navigate', binding, url })).toThrow('BROWSER_INPUT_INVALID');
  });
  it('verifies the whole typed workflow, preserves unrelated content, and grants only exact resources', async () => {
    const f = fixture(); const input = workflow(); const plan = f.provider.prepare(input);
    const receipt = await f.provider.execute(grant, input);
    expect(receipt.verified).toBe(true); expect(receipt.effect).toBe('verified');
    expect(receipt.steps[0]?.after.value).toBe('native qualification');
    expect(receipt.steps[1]?.after.text).toBe('Applied: native qualification');
    expect(receipt.steps[2]?.after.text).toBe('unrelated preserved');
    expect(f.verify).toHaveBeenCalledWith(grant, digest(input), plan.resourceKeys);
    expect(plan.claims.map((claim) => claim.mode)).toEqual(['read', 'exclusive']);
    expect(plan.resourceKeys.join(' ')).not.toMatch(/native-interactive|synthetic-test-grant|explicit-tab/);
  });
  it('uses read claims and no mutation for a query', async () => {
    const f = fixture(); const input = { operation: 'browser.query', binding, selector: '#note' };
    expect(f.provider.prepare(input).claims.map((claim) => claim.mode)).toEqual(['read', 'read']);
    expect((await f.provider.execute(grant, input)).effect).toBe('none'); expect(f.transport.fill).not.toHaveBeenCalled();
  });
  it.each(['browserId', 'contextId', 'profileId', 'tabId', 'providerTabId', 'url', 'documentId'] as const)('never redirects when %s changes', async (key) => {
    const f = fixture(); f.changeBinding({ [key]: 'different' });
    await expect(f.provider.execute(grant, type())).rejects.toMatchObject({ code: 'BROWSER_DOCUMENT_CHANGED', effect: 'none' });
    expect(f.transport.fill).not.toHaveBeenCalled();
  });
  it('refuses missing grants before provider access', async () => {
    const f = fixture(); await expect(f.provider.execute({ ...grant, proof: '' }, type())).rejects.toMatchObject({ code: 'NATIVE_AUTHORITY_DENIED' });
    expect(f.transport.binding).not.toHaveBeenCalled();
  });
  it('refuses an expired/revoked host grant before native dispatch', async () => {
    const f = fixture(); f.verify.mockResolvedValue(false);
    await expect(f.provider.execute(grant, type())).rejects.toMatchObject({ code: 'NATIVE_AUTHORITY_DENIED' }); expect(f.transport.fill).not.toHaveBeenCalled();
  });
  it('copies request bytes before asynchronous authorization', async () => {
    const f = fixture(); const input = type(); f.verify.mockImplementation(async () => { (input as { text: string }).text = 'changed by caller'; return true; });
    expect((await f.provider.execute(grant, input)).steps[0]?.after.value).toBe('native qualification');
  });
  it('requires a mandatory verifier callback', () => {
    const f = fixture(); expect(() => new GotzjiBrowserProvider(f.transport, digest, undefined as never)).toThrow('NATIVE_AUTHORITY_DENIED');
  });
  it('does not read or edit a protected field', async () => {
    const f = fixture(); await expect(f.provider.execute(grant, { ...type(), selector: '#secret' })).rejects.toMatchObject({ code: 'BROWSER_WAITING_FOR_USER', effect: 'none' });
    expect(f.transport.fill).not.toHaveBeenCalled();
  });
  it('refuses a missing or ambiguous selected element', async () => {
    const f = fixture(); await expect(f.provider.execute(grant, { ...type(), selector: '#missing' })).rejects.toMatchObject({ code: 'BROWSER_OBJECT_MISSING' });
    f.nodes.set('#note', { ...f.nodes.get('#note')!, count: 2 });
    await expect(f.provider.execute(grant, type())).rejects.toMatchObject({ code: 'BROWSER_OBJECT_AMBIGUOUS' }); expect(f.transport.fill).not.toHaveBeenCalled();
  });
  it('cancellation before dispatch has no effects', async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort();
    await expect(f.provider.execute(grant, type(), abort.signal)).rejects.toMatchObject({ code: 'BROWSER_CANCELLED', effect: 'none', releaseResources: true }); expect(f.transport.fill).not.toHaveBeenCalled();
  });
  it('cancellation after dispatch retains the fence and never replays', async () => {
    const f = fixture(); const abort = new AbortController(); vi.mocked(f.transport.fill).mockImplementation(async () => { abort.abort(); });
    await expect(f.provider.execute(grant, type(), abort.signal)).rejects.toMatchObject({ code: 'BROWSER_CANCELLED', effect: 'unknown', releaseResources: false });
    await expect(f.provider.execute(grant, type())).rejects.toMatchObject({ code: 'BROWSER_RECONCILIATION_REQUIRED', effect: 'unknown' }); expect(f.transport.fill).toHaveBeenCalledTimes(1);
  });
  it('losing a response preserves unknown effects without exposing the provider exception', async () => {
    const f = fixture(); vi.mocked(f.transport.fill).mockRejectedValue(new Error('secret-provider-password-do-not-expose'));
    try { await f.provider.execute(grant, type()); throw new Error('expected failure'); } catch (error) {
      expect(error).toBeInstanceOf(GotzjiBrowserProviderError); expect(error).toMatchObject({ code: 'BROWSER_PROVIDER_FAILED', effect: 'unknown', releaseResources: false }); expect(String(error)).not.toContain('secret-provider-password');
    }
    expect((await f.provider.execute(grant, { operation: 'browser.query', binding, selector: '#note' })).verified).toBe(true);
    await expect(f.provider.execute(grant, type())).rejects.toMatchObject({ code: 'BROWSER_RECONCILIATION_REQUIRED' });
  });
  it('holds resources when a postcondition fails', async () => {
    const f = fixture(); vi.mocked(f.transport.fill).mockResolvedValue();
    await expect(f.provider.execute(grant, type())).rejects.toMatchObject({ code: 'BROWSER_POSTCONDITION_FAILED', effect: 'unknown', releaseResources: false });
  });
  it('detects same-URL reload after dispatch from the document identity', async () => {
    const f = fixture(); vi.mocked(f.transport.fill).mockImplementation(async () => f.changeBinding({ documentId: 'loader-after-reload' }));
    await expect(f.provider.execute(grant, type())).rejects.toMatchObject({ code: 'BROWSER_DOCUMENT_CHANGED', effect: 'unknown' });
  });
  it('denies concurrent entry on one bound provider without affecting the first action', async () => {
    const f = fixture(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); f.verify.mockImplementation(async () => { await gate; return true; });
    const first = f.provider.execute(grant, type()); await expect(f.provider.execute(grant, type())).rejects.toMatchObject({ code: 'BROWSER_PROVIDER_BUSY' }); release(); await first;
  });
  it.each([
    { ...type(), expression: 'alert(1)' }, { ...type(), operation: 'browser.evaluate' }, { ...type(), tabId: 'unbound' },
    { ...type(), text: 'sk-abcdefghijklmnop12345678' }, { ...type(), binding: { ...binding, url: 'https://site.invalid/?token=do-not-read' } },
    { operation: 'browser.click', binding, selector: '#apply' }, { operation: 'browser.workflow', binding, steps: [{ ...type(), binding: undefined }] },
  ])('rejects invalid/raw/secret-bearing public shape %#', (input) => expect(() => fixture().provider.prepare(input)).toThrow('BROWSER_INPUT_INVALID'));
});
