import type { GotzjiNativeGrant } from './gotzji-native-contract.js';

/** Identities are supplied by trusted provider enrollment, never inferred from the active tab. */
export interface GotzjiBrowserBinding {
  readonly browserId: string;
  readonly contextId: string;
  readonly profileId: string;
  readonly tabId: string;
  readonly providerTabId: string;
  readonly url: string;
  readonly documentId: string;
}
export interface GotzjiBrowserNode {
  readonly count: number;
  readonly identity: string;
  readonly tag: string;
  readonly text: string;
  readonly value: string | null;
  readonly editable: boolean;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly protected: boolean;
}
export type GotzjiBrowserStep =
  | { readonly operation: 'browser.navigate'; readonly url: string }
  | { readonly operation: 'browser.read' | 'browser.query'; readonly selector: string }
  | { readonly operation: 'browser.type'; readonly selector: string; readonly text: string }
  | { readonly operation: 'browser.click'; readonly selector: string; readonly postSelector: string; readonly expectedPostText: string };
export type GotzjiBrowserProviderOperation = GotzjiBrowserStep & { readonly binding: GotzjiBrowserBinding }
  | { readonly operation: 'browser.workflow'; readonly binding: GotzjiBrowserBinding; readonly steps: readonly GotzjiBrowserStep[] };
/** This is a private adapter seam. It is never a public evaluate/CDP/raw-input tool. */
export interface GotzjiBrowserTransport {
  binding(signal?: AbortSignal): Promise<GotzjiBrowserBinding>;
  inspect(selector: string, signal?: AbortSignal): Promise<GotzjiBrowserNode>;
  click(selector: string, expectedIdentity: string, signal?: AbortSignal): Promise<void>;
  fill(selector: string, text: string, expectedIdentity: string, signal?: AbortSignal): Promise<void>;
  navigate?(url: string, signal?: AbortSignal): Promise<GotzjiBrowserBinding>;
}
export interface GotzjiBrowserScope { readonly allowedOrigins: readonly string[]; readonly fixtureMode?: boolean }
export interface GotzjiBrowserProviderPlan {
  readonly digest: string;
  readonly resourceKeys: readonly string[];
  readonly claims: readonly { readonly key: string; readonly mode: 'read' | 'exclusive' }[];
  readonly input: GotzjiBrowserProviderOperation;
}
export interface GotzjiBrowserProviderReceipt {
  readonly operation: GotzjiBrowserProviderOperation['operation'];
  readonly operationDigest: string;
  readonly binding: GotzjiBrowserBinding;
  readonly initialBinding: GotzjiBrowserBinding;
  readonly resourceKeys: readonly string[];
  readonly verified: true;
  readonly effect: 'none' | 'verified';
  readonly releaseResources: true;
  readonly steps: readonly { readonly operation: GotzjiBrowserStep['operation']; readonly before: GotzjiBrowserNode; readonly after: GotzjiBrowserNode }[];
}
export class GotzjiBrowserProviderError extends Error {
  public constructor(public readonly code: string, public readonly effect: 'none' | 'unknown' = 'none',
    public readonly field?: string) { super(code); this.name = 'GotzjiBrowserProviderError'; }
  public get releaseResources(): boolean { return this.effect === 'none'; }
}

export function planGotzjiBrowserOperation(input: unknown, digest: (value: unknown) => string): GotzjiBrowserProviderPlan {
  validate(input);
  const normalized = JSON.parse(JSON.stringify(input)) as GotzjiBrowserProviderOperation;
  for (const step of steps(normalized)) if (step.operation === 'browser.navigate') (step as { url: string }).url = safeBrowserUrl(step.url);
  const { browserId, contextId, profileId, tabId, providerTabId } = normalized.binding;
  const contextKey = `native-browser-context:${digest({ browserId, contextId, profileId })}`;
  const tabKey = `native-browser-tab:${digest({ browserId, contextId, profileId, tabId, providerTabId })}`;
  const mutates = steps(normalized).some((step) => ['browser.type', 'browser.click', 'browser.navigate'].includes(step.operation));
  return { input: normalized, digest: digest(normalized), resourceKeys: [contextKey, tabKey],
    claims: [{ key: contextKey, mode: 'read' }, { key: tabKey, mode: mutates ? 'exclusive' : 'read' }] };
}

export class GotzjiBrowserProvider {
  private active = false;
  private uncertain = false;
  public constructor(private readonly transport: GotzjiBrowserTransport,
    private readonly digest: (value: unknown) => string,
    private readonly verifyGrant: (grant: GotzjiNativeGrant, digest: string, resources: readonly string[]) => Promise<boolean>,
    private readonly scope?: GotzjiBrowserScope) {
    if (typeof digest !== 'function' || typeof verifyGrant !== 'function') throw new GotzjiBrowserProviderError('NATIVE_AUTHORITY_DENIED');
    if (scope) { validateGotzjiBrowserScope(scope); this.scope = Object.freeze({ allowedOrigins: Object.freeze([...scope.allowedOrigins]), ...(scope.fixtureMode === undefined ? {} : { fixtureMode: scope.fixtureMode }) }); }
  }
  public prepare(input: unknown): GotzjiBrowserProviderPlan {
    // Copy before awaiting host authorization; callers cannot mutate the authorized request in flight.
    return planGotzjiBrowserOperation(input, this.digest);
  }
  public async execute(grant: GotzjiNativeGrant, input: unknown, signal?: AbortSignal): Promise<GotzjiBrowserProviderReceipt> {
    const plan = this.prepare(input);
    const work = steps(plan.input);
    const mutates = work.some((step) => ['browser.type', 'browser.click', 'browser.navigate'].includes(step.operation));
    if (this.scope) assertGotzjiBrowserUrlScope(plan.input.binding.url, this.scope);
    for (const step of work) if (step.operation === 'browser.navigate') {
      if (!this.scope) throw new GotzjiBrowserProviderError('BROWSER_ORIGIN_SCOPE_REQUIRED');
      assertGotzjiBrowserUrlScope(step.url, this.scope);
      if (!this.transport.navigate) throw new GotzjiBrowserProviderError('BROWSER_METHOD_UNAVAILABLE');
    }
    if (this.active) throw new GotzjiBrowserProviderError('BROWSER_PROVIDER_BUSY');
    if (this.uncertain && mutates) throw new GotzjiBrowserProviderError('BROWSER_RECONCILIATION_REQUIRED', 'unknown');
    this.active = true;
    let dispatched = false;
    let bound = plan.input.binding;
    try {
      const authorize = async (): Promise<void> => {
        cancelled(signal, dispatched);
        if (!validGrant(grant) || !await this.verifyGrant(grant, plan.digest, plan.resourceKeys)) throw new GotzjiBrowserProviderError('NATIVE_AUTHORITY_DENIED', dispatched ? 'unknown' : 'none');
        cancelled(signal, dispatched);
      };
      await authorize();
      await this.assertBinding(bound, signal);
      const evidence: GotzjiBrowserProviderReceipt['steps'][number][] = [];
      for (const step of work) {
        await authorize();
        await this.assertBinding(bound, signal);
        if (step.operation === 'browser.navigate') {
          const prior = bound;
          await authorize();
          dispatched = true;
          const after = await this.transport.navigate!(step.url, signal);
          cancelled(signal, true);
          if (['browserId', 'contextId', 'profileId', 'tabId', 'providerTabId'].some((key) => after[key as keyof GotzjiBrowserBinding] !== prior[key as keyof GotzjiBrowserBinding])
            || after.url !== step.url || !after.documentId || after.documentId === prior.documentId) throw new GotzjiBrowserProviderError('BROWSER_POSTCONDITION_FAILED', 'unknown');
          assertGotzjiBrowserUrlScope(after.url, this.scope!);
          bound = after;
          await this.assertBinding(bound, signal);
          evidence.push({ operation: step.operation, before: documentNode(prior), after: documentNode(after) });
          continue;
        }
        const before = await this.node(step.selector, signal);
        let after = before;
        if (step.operation === 'browser.type' || step.operation === 'browser.click') {
          if (!before.visible || !before.enabled || (step.operation === 'browser.type' && !before.editable)) throw new GotzjiBrowserProviderError('BROWSER_OBJECT_UNSUPPORTED');
          await authorize();
          await this.assertBinding(bound, signal);
          dispatched = true; // Once dispatch is attempted, a lost response never authorizes automatic replay.
          if (step.operation === 'browser.type') await this.transport.fill(step.selector, step.text, before.identity, signal);
          else await this.transport.click(step.selector, before.identity, signal);
          cancelled(signal, true);
          await this.assertBinding(bound, signal);
          after = await this.node(step.operation === 'browser.type' ? step.selector : step.postSelector, signal);
          if (step.operation === 'browser.type' ? after.value !== step.text : after.text !== step.expectedPostText) throw new GotzjiBrowserProviderError('BROWSER_POSTCONDITION_FAILED', 'unknown');
        }
        evidence.push({ operation: step.operation, before, after });
      }
      cancelled(signal, dispatched);
      await this.assertBinding(bound, signal);
      return { operation: plan.input.operation, operationDigest: plan.digest, initialBinding: plan.input.binding, binding: bound,
        resourceKeys: plan.resourceKeys, verified: true, effect: dispatched ? 'verified' : 'none', releaseResources: true, steps: evidence };
    } catch (error) {
      const effect = dispatched ? 'unknown' : error instanceof GotzjiBrowserProviderError ? error.effect : 'none';
      if (effect === 'unknown') this.uncertain = true;
      // Provider text can contain URLs, form values or credentials; expose stable codes only.
      throw new GotzjiBrowserProviderError(error instanceof GotzjiBrowserProviderError ? error.code : 'BROWSER_PROVIDER_FAILED', effect,
        error instanceof GotzjiBrowserProviderError ? error.field : undefined);
    } finally { this.active = false; }
  }
  private async assertBinding(expected: GotzjiBrowserBinding, signal?: AbortSignal): Promise<void> {
    const actual = await this.transport.binding(signal);
    if (Object.keys(expected).some((key) => actual[key as keyof GotzjiBrowserBinding] !== expected[key as keyof GotzjiBrowserBinding])) throw new GotzjiBrowserProviderError('BROWSER_DOCUMENT_CHANGED');
  }
  private async node(selector: string, signal?: AbortSignal): Promise<GotzjiBrowserNode> {
    const node = await this.transport.inspect(selector, signal);
    if (node.count !== 1) throw new GotzjiBrowserProviderError(node.count === 0 ? 'BROWSER_OBJECT_MISSING' : 'BROWSER_OBJECT_AMBIGUOUS');
    if (node.protected) throw new GotzjiBrowserProviderError('BROWSER_WAITING_FOR_USER');
    if (!node.identity || node.text.length > 32768 || (node.value?.length ?? 0) > 32768) throw new GotzjiBrowserProviderError('BROWSER_OBJECT_UNSUPPORTED');
    return node;
  }
}
function steps(input: GotzjiBrowserProviderOperation): readonly GotzjiBrowserStep[] { return input.operation === 'browser.workflow' ? input.steps : [input]; }
function cancelled(signal: AbortSignal | undefined, dispatched: boolean): void { if (signal?.aborted === true) throw new GotzjiBrowserProviderError('BROWSER_CANCELLED', dispatched ? 'unknown' : 'none'); }
function validGrant(value: GotzjiNativeGrant): boolean { return record(value) && ['ownerId', 'projectId', 'jobId', 'operationId', 'rootPath', 'proof'].every((key) => typeof value[key] === 'string' && !!value[key]); }
function validate(value: unknown): asserts value is GotzjiBrowserProviderOperation {
  if (!record(value) || !record(value.binding)) invalid('binding');
  const binding = value.binding;
  const keys = ['browserId', 'contextId', 'profileId', 'tabId', 'providerTabId', 'url', 'documentId'];
  if (Object.keys(binding).length !== keys.length || keys.some((key) => typeof binding[key] !== 'string' || !binding[key] || binding[key].length > 4096 || /[\r\n\0]/u.test(binding[key]))) invalid('binding');
  if (binding.url !== 'about:blank') safeBrowserUrl(binding.url as string);
  if (value.operation === 'browser.workflow') {
    if (Object.keys(value).some((key) => !['operation', 'binding', 'steps'].includes(key)) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 16) invalid('steps');
    for (const step of value.steps as unknown[]) validateStep(step, false);
  } else validateStep(value, true);
}
function validateStep(value: unknown, bound: boolean): void {
  if (!record(value) || !['browser.read', 'browser.query', 'browser.type', 'browser.click', 'browser.navigate'].includes(String(value.operation))) invalid('operation');
  if (value.operation === 'browser.navigate') {
    if (Object.keys(value).some((key) => !['operation', 'url', ...(bound ? ['binding'] : [])].includes(key)) || typeof value.url !== 'string') invalid('url');
    safeBrowserUrl(value.url as string); return;
  }
  const keys = ['operation', 'selector', ...(bound ? ['binding'] : []), ...(value.operation === 'browser.type' ? ['text'] : []), ...(value.operation === 'browser.click' ? ['postSelector', 'expectedPostText'] : [])];
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid('operation');
  for (const key of ['selector', ...(value.operation === 'browser.click' ? ['postSelector'] : [])]) if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 1024 || /[\r\n\0]/u.test(value[key])) invalid(key);
  for (const key of value.operation === 'browser.type' ? ['text'] : value.operation === 'browser.click' ? ['expectedPostText'] : []) {
    if (typeof value[key] !== 'string' || value[key].length > 32768 || /\0/u.test(value[key])) invalid(key);
    if (/(?:sk-[A-Za-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,}|(?:password|api[_-]?key|access[_-]?token)\s*[:=])/iu.test(value[key])) invalid(key);
  }
}
function invalid(field: string): never { throw new GotzjiBrowserProviderError('BROWSER_INPUT_INVALID', 'none', field); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function safeBrowserUrl(value: string): string {
  let parsed: URL; try { parsed = new URL(value); } catch { invalid('url'); }
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/u.test(value) || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || [...parsed.searchParams.keys()].some((key) => /(?:token|key|secret|password|authorization|code|session)/iu.test(key)) || /(?:token|key|secret|password)=/iu.test(parsed.hash)) invalid('url');
  return parsed.href;
}
export function validateGotzjiBrowserScope(scope: GotzjiBrowserScope): void {
  if (!scope || !Array.isArray(scope.allowedOrigins) || scope.allowedOrigins.length > 16 || new Set(scope.allowedOrigins).size !== scope.allowedOrigins.length) throw new GotzjiBrowserProviderError('BROWSER_ORIGIN_SCOPE_INVALID');
  for (const origin of scope.allowedOrigins) {
    const parsed = new URL(safeBrowserUrl(origin));
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !(scope.fixtureMode === true && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'))) throw new GotzjiBrowserProviderError('BROWSER_ORIGIN_SCOPE_INVALID');
  }
}
export function assertGotzjiBrowserUrlScope(value: string, scope: GotzjiBrowserScope): void {
  validateGotzjiBrowserScope(scope);
  if (value === 'about:blank') return;
  if (!scope.allowedOrigins.includes(new URL(safeBrowserUrl(value)).origin)) throw new GotzjiBrowserProviderError('BROWSER_ORIGIN_SCOPE_DENIED');
}
function documentNode(binding: GotzjiBrowserBinding): GotzjiBrowserNode { return { count: 1, identity: binding.documentId, tag: 'DOCUMENT', text: binding.url, value: null, editable: false, enabled: true, visible: true, protected: false }; }
