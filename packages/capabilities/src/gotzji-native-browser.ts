import { BrowserCdpBackend, type BrowserCdpProtocol } from './browser-cdp-backend.js';
import { GotzjiNativeError, nativeDigest, type GotzjiNativeGrant } from './gotzji-native-contract.js';

export interface GotzjiBrowserOperation {
  readonly operation: 'browser.query' | 'browser.click' | 'browser.type';
  readonly tabId: string;
  readonly expectedUrl: string;
  readonly selector: string;
  readonly text?: string;
  readonly postSelector?: string;
  readonly expectedPostText?: string;
}
export interface GotzjiBrowserReceipt {
  readonly operation: GotzjiBrowserOperation['operation'];
  readonly tabId: string;
  readonly url: string;
  readonly verified: true;
  readonly before: unknown;
  readonly after: unknown;
}
/** Reuses upstream typed CDP actions, without exposing evaluate/launch/new-tab/default-tab routes. */
export class GotzjiNativeBrowserAdapter {
  public constructor(private readonly protocol: BrowserCdpProtocol,
    private readonly verifyGrant: (grant: GotzjiNativeGrant, digest: string, resources: readonly string[]) => Promise<boolean>) {}
  public async execute(grant: GotzjiNativeGrant, input: GotzjiBrowserOperation, signal?: AbortSignal): Promise<GotzjiBrowserReceipt> {
    if (!input || Object.keys(input).some((key) => !['operation', 'tabId', 'expectedUrl', 'selector', 'text', 'postSelector', 'expectedPostText'].includes(key))
      || !['browser.query', 'browser.click', 'browser.type'].includes(input.operation)
      || !input.tabId || !input.expectedUrl || !input.selector || input.selector.length > 4096
      || (input.operation === 'browser.type' && (typeof input.text !== 'string' || input.text.length > 32768))
      || (input.operation === 'browser.click' && (!input.postSelector || typeof input.expectedPostText !== 'string'))) throw new GotzjiNativeError('BROWSER_INPUT_INVALID');
    const resources = ['native-interactive:windows', `native-browser-tab:${nativeDigest(input.tabId)}`];
    if (!grant.ownerId || !grant.jobId || !grant.proof || !await this.verifyGrant(grant, nativeDigest(input), resources)) throw new GotzjiNativeError('NATIVE_AUTHORITY_DENIED');
    const selectedTab = (await this.protocol.listTabs(signal)).find((tab) => tab.id === input.tabId);
    if (selectedTab?.url !== input.expectedUrl) throw new GotzjiNativeError('BROWSER_DOCUMENT_CHANGED');
    const guarded: BrowserCdpProtocol = {
      status: (abort) => this.protocol.status(abort), listTabs: (abort) => this.protocol.listTabs(abort),
      newTab: async () => { throw new GotzjiNativeError('BROWSER_METHOD_DENIED'); },
      closeTab: async () => { throw new GotzjiNativeError('BROWSER_METHOD_DENIED'); },
      request: async (tabId, method, params, abort) => {
        const tab = (await this.protocol.listTabs(abort)).find((candidate) => candidate.id === input.tabId);
        if (tabId !== input.tabId || tab?.url !== input.expectedUrl) throw new GotzjiNativeError('BROWSER_DOCUMENT_CHANGED');
        if (method !== 'Runtime.evaluate' || typeof params.expression !== 'string') throw new GotzjiNativeError('BROWSER_OBJECT_UNSUPPORTED');
        const expression = `(() => { if (location.href !== ${JSON.stringify(input.expectedUrl)}) return {ok:false,error:'BROWSER_DOCUMENT_CHANGED'}; return (${params.expression}); })()`;
        return this.protocol.request(tabId, method, { ...params, expression }, abort);
      },
    };
    const backend = new BrowserCdpBackend({ protocol: guarded });
    const call = async (action: 'query' | 'click' | 'type', parameters: Record<string, unknown>): Promise<unknown> => {
      const result = await backend.execute({ action, tab_id: input.tabId, parameters }, signal,
        { mode: 'standard', applicationApproved: true, bypassApplicationAuthorization: false, source: 'scoped_policy' });
      if (!result.ok) throw new GotzjiNativeError('BROWSER_PROVIDER_FAILED', undefined, action === 'query' ? 'none' : 'unknown');
      if (!record(result.value) || result.value.ok === false) throw new GotzjiNativeError('BROWSER_POSTCONDITION_FAILED', undefined, action === 'query' ? 'none' : 'unknown');
      return result.value;
    };
    const before = await call('query', { selector: input.selector });
    let after = before;
    if (input.operation !== 'browser.query') {
      if (input.operation === 'browser.type' && record(before) && before.tag !== 'INPUT' && before.tag !== 'TEXTAREA') throw new GotzjiNativeError('BROWSER_OBJECT_UNSUPPORTED');
      await call(input.operation === 'browser.click' ? 'click' : 'type', { selector: input.selector, ...(input.operation === 'browser.type' ? { text: input.text, clear: true } : {}) });
      after = await call('query', { selector: input.postSelector ?? input.selector });
      if (!record(after) || after.text !== (input.expectedPostText ?? input.text)) throw new GotzjiNativeError('BROWSER_POSTCONDITION_FAILED', undefined, 'unknown');
    }
    return { operation: input.operation, tabId: input.tabId, url: input.expectedUrl, verified: true, before, after };
  }
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
