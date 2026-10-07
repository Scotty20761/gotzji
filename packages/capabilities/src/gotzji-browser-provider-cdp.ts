import type { BrowserCdpProtocol } from './browser-cdp-backend.js';
import { GotzjiBrowserProvider, GotzjiBrowserProviderError, type GotzjiBrowserBinding, type GotzjiBrowserNode, type GotzjiBrowserScope, type GotzjiBrowserTransport } from './gotzji-browser-provider-policy.js';
import { nativeDigest, type GotzjiNativeGrant } from './gotzji-native-contract.js';

export interface GotzjiOwnedBrowserSession {
  readonly browserId: string;
  readonly contextId: string;
  readonly profileId: string;
  readonly tabId: string;
  readonly providerTabId: string;
  readonly cdpBrowserContextId: string;
}
/** The host proves exact PID/start identity, profile root and port; this adapter never launches/adopts a user browser. */
export class GotzjiBrowserCdpTransport implements GotzjiBrowserTransport {
  public constructor(private readonly protocol: BrowserCdpProtocol, private readonly session: GotzjiOwnedBrowserSession,
    private readonly verifyOwnedSession: () => Promise<boolean>) {
    if (typeof verifyOwnedSession !== 'function' || Object.values(session).some((value) => typeof value !== 'string')
      || ['browserId', 'contextId', 'profileId', 'tabId', 'providerTabId'].some((key) => !session[key as keyof GotzjiOwnedBrowserSession])) throw new GotzjiBrowserProviderError('BROWSER_SESSION_UNVERIFIED');
  }
  public async binding(signal?: AbortSignal): Promise<GotzjiBrowserBinding> {
    await this.owner(signal);
    const tabs = await this.protocol.listTabs(signal);
    const tab = tabs.find((candidate) => candidate.id === this.session.tabId);
    if (!tab) throw new GotzjiBrowserProviderError('BROWSER_TAB_MISSING');
    const target = await this.request('Target.getTargetInfo', { targetId: this.session.tabId }, signal);
    const info = record(target.targetInfo) ? target.targetInfo : undefined;
    if (info?.targetId !== this.session.tabId || (info.browserContextId ?? '') !== this.session.cdpBrowserContextId || info.type !== 'page') throw new GotzjiBrowserProviderError('BROWSER_SESSION_UNVERIFIED');
    const tree = await this.request('Page.getFrameTree', {}, signal);
    const frameTree = record(tree.frameTree) ? tree.frameTree : undefined;
    const frame = record(frameTree?.frame) ? frameTree.frame : undefined;
    if (typeof frame?.loaderId !== 'string' || !frame.loaderId || typeof frame.url !== 'string' || frame.url !== tab.url) throw new GotzjiBrowserProviderError('BROWSER_DOCUMENT_CHANGED');
    return { browserId: this.session.browserId, contextId: this.session.contextId, profileId: this.session.profileId,
      tabId: this.session.tabId, providerTabId: this.session.providerTabId, url: frame.url, documentId: frame.loaderId };
  }
  public async inspect(selector: string, signal?: AbortSignal): Promise<GotzjiBrowserNode> {
    const selected = await this.binding(signal);
    const value = await this.evaluate(selected, selector, 'inspect', '', '', signal);
    if (!record(value) || typeof value.count !== 'number' || typeof value.identity !== 'string'
      || typeof value.text !== 'string' || typeof value.tag !== 'string' || (value.value !== null && typeof value.value !== 'string')
      || ['editable', 'enabled', 'visible', 'protected'].some((key) => typeof value[key] !== 'boolean')) throw new GotzjiBrowserProviderError('BROWSER_PROVIDER_FAILED');
    return value as unknown as GotzjiBrowserNode;
  }
  public async click(selector: string, expectedIdentity: string, signal?: AbortSignal): Promise<void> {
    const selected = await this.binding(signal);
    await this.evaluate(selected, selector, 'click', '', expectedIdentity, signal);
  }
  public async fill(selector: string, text: string, expectedIdentity: string, signal?: AbortSignal): Promise<void> {
    const selected = await this.binding(signal);
    await this.evaluate(selected, selector, 'fill', text, expectedIdentity, signal);
  }
  public async navigate(url: string, signal?: AbortSignal): Promise<GotzjiBrowserBinding> {
    const before = await this.binding(signal);
    const navigation = await this.request('Page.navigate', { url }, signal);
    if (navigation.errorText) throw new GotzjiBrowserProviderError('BROWSER_NAVIGATION_FAILED', 'unknown');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new GotzjiBrowserProviderError('BROWSER_CANCELLED', 'unknown');
      try {
        const after = await this.binding(signal);
        if (after.url === url && after.documentId !== before.documentId) {
          const document = await this.request('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, signal);
          const result = record(document.result) ? document.result : undefined;
          if (result?.value === 'interactive' || result?.value === 'complete') return after;
        }
      } catch (error) { if (!(error instanceof GotzjiBrowserProviderError) || error.code !== 'BROWSER_DOCUMENT_CHANGED') throw error; }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new GotzjiBrowserProviderError('BROWSER_NAVIGATION_TIMEOUT', 'unknown');
  }
  private async owner(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new GotzjiBrowserProviderError('BROWSER_CANCELLED');
    if (!await this.verifyOwnedSession()) throw new GotzjiBrowserProviderError('BROWSER_SESSION_UNVERIFIED');
    if (signal?.aborted) throw new GotzjiBrowserProviderError('BROWSER_CANCELLED');
  }
  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.owner(signal);
    const response = await this.protocol.request(this.session.tabId, method, params, signal);
    if (!record(response) || response.error || !record(response.result)) throw new GotzjiBrowserProviderError('BROWSER_PROVIDER_FAILED');
    return response.result;
  }
  private async evaluate(binding: GotzjiBrowserBinding, selector: string, action: 'inspect' | 'click' | 'fill', text: string, expectedIdentity: string, signal?: AbortSignal): Promise<unknown> {
    // All JavaScript is authored here. Arguments are data, never executable caller expressions.
    const expression = `(${nativeElementAction.toString()})(${JSON.stringify({ url: binding.url, selector, action, text, expectedIdentity })})`;
    const response = await this.request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, signal);
    const result = record(response.result) ? response.result : undefined;
    if (response.exceptionDetails || !result || !record(result.value)) throw new GotzjiBrowserProviderError('BROWSER_PROVIDER_FAILED');
    if (typeof result.value.error === 'string') throw new GotzjiBrowserProviderError(safeCode(result.value.error));
    return result.value;
  }
}

export function createGotzjiBrowserCdpProvider(protocol: BrowserCdpProtocol, session: GotzjiOwnedBrowserSession,
  verifyOwnedSession: () => Promise<boolean>, verifyGrant: (grant: GotzjiNativeGrant, digest: string, resources: readonly string[]) => Promise<boolean>, scope?: GotzjiBrowserScope): GotzjiBrowserProvider {
  return new GotzjiBrowserProvider(new GotzjiBrowserCdpTransport(protocol, session, verifyOwnedSession), nativeDigest, verifyGrant, scope);
}
function safeCode(code: string): string { return ['BROWSER_DOCUMENT_CHANGED', 'BROWSER_OBJECT_CHANGED', 'BROWSER_OBJECT_MISSING', 'BROWSER_OBJECT_AMBIGUOUS', 'BROWSER_WAITING_FOR_USER', 'BROWSER_OBJECT_UNSUPPORTED'].includes(code) ? code : 'BROWSER_PROVIDER_FAILED'; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function nativeElementAction(input: { url: string; selector: string; action: 'inspect' | 'click' | 'fill'; text: string; expectedIdentity: string }): unknown {
  if (location.href !== input.url) return { error: 'BROWSER_DOCUMENT_CHANGED' };
  const nodes = document.querySelectorAll(input.selector);
  const empty = { count: nodes.length, identity: '', tag: '', text: '', value: null, editable: false, enabled: false, visible: false, protected: false };
  if (nodes.length !== 1) return input.action === 'inspect' ? empty : { error: nodes.length === 0 ? 'BROWSER_OBJECT_MISSING' : 'BROWSER_OBJECT_AMBIGUOUS' };
  const node = nodes[0] as HTMLElement;
  const tag = node.tagName;
  const kind = node.getAttribute('type') ?? '';
  const metadata = ['type', 'name', 'id', 'autocomplete', 'placeholder', 'aria-label'].map((key) => node.getAttribute(key) ?? '').join(' ');
  const editable = (tag === 'INPUT' && ['text', 'search', 'url', 'tel', 'email', 'number', ''].includes(kind.toLowerCase())) || tag === 'TEXTAREA';
  const protectedField = tag === 'IFRAME' || kind.toLowerCase() === 'password'
    || /(?:password|passwd|passcode|captcha|one[-_ ]?time|otp|credit[-_ ]?card|cc-number|cc-csc|api[-_ ]?key|access[-_ ]?token|secret|authenticat)/iu.test(metadata);
  const identity = JSON.stringify([tag, ...['id', 'name', 'type', 'data-testid'].map((key) => node.getAttribute(key) ?? '')]);
  const renderedText = editable ? '' : (node.innerText ?? node.textContent ?? '');
  const protectedText = /(?:sk-[A-Za-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,})/u.test(renderedText);
  const candidateValue = protectedField ? null : editable ? (node as HTMLInputElement | HTMLTextAreaElement).value : null;
  const protectedValue = candidateValue !== null && /(?:sk-[A-Za-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,})/u.test(candidateValue);
  const protectedNode = protectedField || protectedText || protectedValue;
  const value = protectedNode ? null : candidateValue;
  const enabled = !node.hasAttribute('disabled') && !node.hasAttribute('readonly') && node.getAttribute('aria-disabled') !== 'true';
  const visible = node.getClientRects().length > 0;
  if (input.action === 'inspect') return { count: 1, identity, tag, text: protectedNode ? '' : renderedText.slice(0, 32769), value: value === null ? null : value.slice(0, 32769), editable, enabled, visible, protected: protectedNode };
  if (protectedNode) return { error: 'BROWSER_WAITING_FOR_USER' };
  if (identity !== input.expectedIdentity) return { error: 'BROWSER_OBJECT_CHANGED' };
  if (!enabled || !visible || (input.action === 'fill' && !editable)) return { error: 'BROWSER_OBJECT_UNSUPPORTED' };
  if (input.action === 'click') node.click();
  else {
    const prototype = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return { error: 'BROWSER_OBJECT_UNSUPPORTED' };
    setter.call(node, input.text);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { dispatched: true };
}
