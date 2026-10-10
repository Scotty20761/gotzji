import { GotzjiBrowserProviderError, type GotzjiBrowserBinding, type GotzjiBrowserNode, type GotzjiBrowserTransport } from './gotzji-browser-provider-policy.js';

/** Only the documented CUA API is used here. This qualification adapter is NOT a standalone app dependency. */
interface CuaLocator {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  getAttribute(name: string): Promise<string | null>;
  evaluateAll<T>(reader: (elements: Element[]) => T): Promise<T>;
  click(options: { timeoutMs: number }): Promise<void>;
  fill(value: string, options: { timeoutMs: number }): Promise<void>;
}
export interface GotzjiCuaQualificationTab {
  readonly id: string;
  url(): Promise<string | undefined>;
  readonly playwright: { locator(selector: string): CuaLocator };
}
export interface GotzjiCuaQualificationRuntime {
  listBrowsers(): Promise<readonly { id: string; profileName?: string; metadata?: { extensionInstanceId?: string; codexSessionId?: string } }[]>;
  listTabs(browserId: string): Promise<readonly { id: string; providerTabId?: string; browserId?: string; url?: string }[]>;
}
export class GotzjiBrowserCuaQualificationTransport implements GotzjiBrowserTransport {
  public constructor(private readonly runtime: GotzjiCuaQualificationRuntime, private readonly tab: GotzjiCuaQualificationTab,
    private readonly browserId: string) {}
  public async binding(signal?: AbortSignal): Promise<GotzjiBrowserBinding> {
    aborted(signal);
    const browser = (await this.runtime.listBrowsers()).find((candidate) => candidate.id === this.browserId);
    const selected = (await this.runtime.listTabs(this.browserId)).find((candidate) => candidate.id === this.tab.id);
    const contextId = browser?.metadata?.extensionInstanceId ?? browser?.metadata?.codexSessionId;
    const documentId = await this.tab.playwright.locator('html').getAttribute('data-gotzji-document-id');
    const url = await this.tab.url();
    if (!browser?.profileName || !contextId || !selected?.providerTabId || !url || selected.url !== url || !documentId
      || (selected.browserId !== undefined && selected.browserId !== this.browserId)) throw new GotzjiBrowserProviderError('BROWSER_SESSION_UNVERIFIED');
    aborted(signal);
    return { browserId: this.browserId, contextId, profileId: browser.profileName, tabId: this.tab.id,
      providerTabId: selected.providerTabId, url, documentId };
  }
  public async inspect(selector: string, signal?: AbortSignal): Promise<GotzjiBrowserNode> {
    aborted(signal);
    const locator = this.tab.playwright.locator(selector);
    const info = await locator.evaluateAll(readCuaNodes);
    if (info.count !== 1 || info.protected) return info;
    const visible = await locator.isVisible();
    const enabled = await locator.isEnabled();
    aborted(signal);
    return { ...info, visible, enabled: info.enabled && enabled };
  }
  public async click(selector: string, expectedIdentity: string, signal?: AbortSignal): Promise<void> {
    await this.target(selector, expectedIdentity, false, signal);
    await this.tab.playwright.locator(selector).click({ timeoutMs: 3000 });
  }
  public async fill(selector: string, text: string, expectedIdentity: string, signal?: AbortSignal): Promise<void> {
    await this.target(selector, expectedIdentity, true, signal);
    await this.tab.playwright.locator(selector).fill(text, { timeoutMs: 3000 });
  }
  private async target(selector: string, expectedIdentity: string, editable: boolean, signal?: AbortSignal): Promise<void> {
    const node = await this.inspect(selector, signal);
    if (node.protected) throw new GotzjiBrowserProviderError('BROWSER_WAITING_FOR_USER');
    if (node.count !== 1 || node.identity !== expectedIdentity) throw new GotzjiBrowserProviderError('BROWSER_OBJECT_CHANGED');
    if (!node.visible || !node.enabled || (editable && !node.editable)) throw new GotzjiBrowserProviderError('BROWSER_OBJECT_UNSUPPORTED');
    aborted(signal);
  }
}
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new GotzjiBrowserProviderError('BROWSER_CANCELLED'); }
function readCuaNodes(elements: Element[]): GotzjiBrowserNode {
  const empty = { count: elements.length, identity: '', tag: '', text: '', value: null, editable: false, enabled: false, visible: false, protected: false };
  if (elements.length !== 1) return empty;
  const element = elements[0] as HTMLElement;
  const tag = element.tagName;
  const kind = element.getAttribute('type') ?? '';
  const metadata = ['type', 'name', 'id', 'autocomplete', 'placeholder', 'aria-label'].map((key) => element.getAttribute(key) ?? '').join(' ');
  const editable = (tag === 'INPUT' && ['text', 'search', 'url', 'tel', 'email', 'number', ''].includes(kind.toLowerCase())) || tag === 'TEXTAREA';
  const renderedText = editable ? '' : (element.innerText ?? element.textContent ?? '');
  const protectedField = tag === 'IFRAME' || kind.toLowerCase() === 'password'
    || /(?:password|passwd|passcode|captcha|one[-_ ]?time|otp|credit[-_ ]?card|cc-number|cc-csc|api[-_ ]?key|access[-_ ]?token|secret|authenticat)/iu.test(metadata)
    || /(?:sk-[A-Za-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,})/u.test(renderedText);
  const candidateValue = protectedField ? null : editable ? (element as HTMLInputElement).value : null;
  const protectedNode = protectedField || (candidateValue !== null && /(?:sk-[A-Za-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,})/u.test(candidateValue));
  return { count: 1, identity: JSON.stringify([tag, ...['id', 'name', 'type', 'data-testid'].map((key) => element.getAttribute(key) ?? '')]), tag,
    text: protectedNode ? '' : renderedText.slice(0, 32769), value: protectedNode ? null : candidateValue === null ? null : candidateValue.slice(0, 32769),
    editable, enabled: !element.hasAttribute('disabled') && !element.hasAttribute('readonly') && element.getAttribute('aria-disabled') !== 'true', visible: false, protected: protectedNode };
}
