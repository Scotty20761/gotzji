import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertGotzjiBrowserUrlScope, planGotzjiBrowserOperation, validateGotzjiBrowserScope, type GotzjiBrowserBinding, type GotzjiBrowserProviderOperation, type GotzjiBrowserProviderPlan, type GotzjiBrowserStep } from '@lnwjud/capabilities/gotzji-browser-provider-policy';
import { nativeDigest, nativeFileDigest } from '@lnwjud/capabilities/gotzji-native-contract';
import { discoverPolicies } from './product-projects.js';
import type { NativeWorkerBinding } from './product-native.js';
import { CoreError, type FileFingerprint, type RegisteredProject } from './types.js';

export const PRODUCT_BROWSER_OPERATIONS = ['browser.read', 'browser.query', 'browser.type', 'browser.click', 'browser.navigate', 'browser.workflow'] as const;
export type ProductBrowserOperationName = typeof PRODUCT_BROWSER_OPERATIONS[number];
type BrowserRequestBase = { readonly requestId: string; readonly projectId: string; readonly sessionId: string; readonly tabId: string; readonly expectedUrl: string; readonly expectedDocumentId: string; readonly priority?: number; readonly dependsOn?: readonly string[] };
export type ProductBrowserInput = BrowserRequestBase & (GotzjiBrowserStep | { readonly operation: 'browser.workflow'; readonly steps: readonly GotzjiBrowserStep[] });
export interface TrustedProductBrowserSessionManifest {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly owner: string;
  readonly projectId: string;
  readonly pid: number;
  readonly pidBirth: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly profilePath: string;
  readonly port: number;
  readonly cdpBrowserContextId: string;
  readonly binding: GotzjiBrowserBinding;
  readonly allowedOrigins: readonly string[];
  readonly fixtureMode: boolean;
}
/** Private host enrollment only. No paths, PID, port, manifest or verification callbacks are public arguments. */
export interface TrustedProductBrowserOptions {
  readonly session: TrustedProductBrowserSessionManifest;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly prerequisites: readonly FileFingerprint[];
  readonly verifyOwnedSession: (session: TrustedProductBrowserSessionManifest) => Promise<boolean>;
  readonly operations?: readonly ProductBrowserOperationName[];
  readonly deadlineMs?: number;
}
export interface TrustedProductBrowserLaunchOptions {
  readonly profileParent: string;
  readonly chromeExecutable: string;
  readonly executableSha256: string;
  readonly startUrl?: string;
  readonly allowedOrigins: readonly string[];
  readonly prerequisites: readonly FileFingerprint[];
  readonly deadlineMs?: number;
  readonly headless?: boolean;
}
export interface ProductBrowserPublicBinding { readonly sessionId: string; readonly tabId: string; readonly expectedUrl: string; readonly expectedDocumentId: string; readonly allowedOrigins: readonly string[] }
export interface TrustedProductBrowserEnrollment {
  readonly options: TrustedProductBrowserOptions;
  readonly publicBinding: ProductBrowserPublicBinding;
  refresh(): Promise<{ readonly options: TrustedProductBrowserOptions; readonly publicBinding: ProductBrowserPublicBinding }>;
  stop(): Promise<{ readonly stopped: true; readonly pid: number }>;
}
export interface PreparedProductBrowserOperation {
  readonly kind: 'browser';
  readonly input: ProductBrowserInput;
  readonly project: RegisteredProject;
  readonly projectPolicies: Readonly<Record<string, FileFingerprint>>;
  readonly policyDirectories: readonly string[];
  readonly browser: {
    readonly input: GotzjiBrowserProviderOperation;
    readonly planDigest: string;
    readonly adapterResourceKeys: readonly string[];
    readonly resourceKeys: readonly string[];
    readonly session: TrustedProductBrowserSessionManifest;
    readonly manifestPath: string;
    readonly manifestSha256: string;
    readonly prerequisites: readonly FileFingerprint[];
    readonly deadlineMs: number;
  };
}
export function productBrowserResources(project: RegisteredProject, plan: GotzjiBrowserProviderPlan): readonly string[] {
  // Current core resource keys are exclusive. Conservatively serialize one owned context until read-claim admission is qualified.
  return [...new Set([`project:${project.resourceKey}`, ...plan.resourceKeys])].sort();
}
export async function prepareProductBrowserOperation(project: RegisteredProject, value: unknown, options: TrustedProductBrowserOptions): Promise<PreparedProductBrowserOperation> {
  if (!record(value) || !PRODUCT_BROWSER_OPERATIONS.includes(value.operation as ProductBrowserOperationName)) invalid('operation');
  const operation = value.operation as ProductBrowserOperationName;
  const specific = operation === 'browser.workflow' ? ['steps'] : operation === 'browser.navigate' ? ['url'] : ['selector', ...(operation === 'browser.type' ? ['text'] : operation === 'browser.click' ? ['postSelector', 'expectedPostText'] : [])];
  if (Object.keys(value).some((key) => !['requestId', 'projectId', 'operation', 'sessionId', 'tabId', 'expectedUrl', 'expectedDocumentId', 'priority', 'dependsOn', ...specific].includes(key))) invalid('arguments');
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(value.requestId)) invalid('requestId');
  if (value.projectId !== project.projectId || !project.owner || !project.resourceKey) throw new CoreError('BROWSER_PROJECT_DENIED', undefined, 'projectId');
  if (value.priority !== undefined && (!Number.isInteger(value.priority) || Number(value.priority) < 0 || Number(value.priority) > 3)) invalid('priority');
  if (value.dependsOn !== undefined && (!Array.isArray(value.dependsOn) || value.dependsOn.length > 8 || value.dependsOn.some((id: unknown) => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) || new Set(value.dependsOn).size !== value.dependsOn.length)) invalid('dependsOn');
  if (options.operations && !options.operations.includes(operation)) throw new CoreError('BROWSER_OPERATION_UNAVAILABLE', undefined, 'operation');
  if (typeof options.verifyOwnedSession !== 'function') throw new CoreError('BROWSER_SESSION_VERIFIER_REQUIRED');
  const root = await realpath(project.rootPath);
  if (root !== project.rootPath) throw new CoreError('PROJECT_ROOT_CHANGED');
  validateSession(options.session, project);
  if (value.sessionId !== options.session.sessionId || value.tabId !== options.session.binding.tabId || value.expectedUrl !== options.session.binding.url || value.expectedDocumentId !== options.session.binding.documentId) throw new CoreError('BROWSER_DOCUMENT_CHANGED');
  const manifestPath = await pinned(options.manifestPath, options.manifestSha256);
  if (!/(?:^|[\\/])gotzji(?:[\\/]|$)/iu.test(manifestPath)) throw new CoreError('BROWSER_MANIFEST_SCOPE_DENIED');
  let manifest: unknown; try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new CoreError('BROWSER_MANIFEST_CHANGED'); }
  if (nativeDigest(manifest) !== nativeDigest(options.session)) throw new CoreError('BROWSER_MANIFEST_CHANGED');
  if (!Array.isArray(options.prerequisites) || options.prerequisites.length < 1 || options.prerequisites.length > 16) throw new CoreError('BROWSER_PREREQUISITES_REQUIRED');
  for (const entry of options.prerequisites) await pinned(entry.path, entry.hash);
  await pinned(options.session.executable, options.session.executableSha256);
  if (!await options.verifyOwnedSession(options.session)) throw new CoreError('BROWSER_SESSION_UNVERIFIED');
  const nativeInput: Record<string, unknown> = { operation, binding: structuredClone(options.session.binding) };
  for (const key of specific) nativeInput[key] = structuredClone(value[key]);
  let plan: GotzjiBrowserProviderPlan;
  try { plan = planGotzjiBrowserOperation(nativeInput, nativeDigest); } catch (error) { throw new CoreError('BROWSER_INPUT_INVALID', undefined, error instanceof Error && 'field' in error ? String(error.field) : 'arguments'); }
  try {
    assertGotzjiBrowserUrlScope(plan.input.binding.url, options.session);
    for (const step of plan.input.operation === 'browser.workflow' ? plan.input.steps : [plan.input]) if (step.operation === 'browser.navigate') assertGotzjiBrowserUrlScope(step.url, options.session);
  } catch { throw new CoreError('BROWSER_ORIGIN_SCOPE_DENIED'); }
  const deadlineMs = options.deadlineMs ?? 30000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 120000) throw new CoreError('BROWSER_DEADLINE_INVALID');
  const policies = discoverPolicies(root, [root]);
  return freeze({ kind: 'browser', input: structuredClone(value) as ProductBrowserInput, project: structuredClone(project), ...policies,
    browser: { input: plan.input, planDigest: plan.digest, adapterResourceKeys: plan.resourceKeys, resourceKeys: productBrowserResources(project, plan),
      session: structuredClone(options.session), manifestPath, manifestSha256: options.manifestSha256, prerequisites: structuredClone(options.prerequisites), deadlineMs } });
}
export interface BrowserWorkerBinding extends NativeWorkerBinding { readonly browserTestTransport?: { readonly path: string; readonly sha256: string } }
export interface BrowserWorkerAuthorization { readonly body: string; readonly mac: string }
export interface AuthorizedBrowserWorkerConfig extends BrowserWorkerBinding { readonly browserAuthorization: BrowserWorkerAuthorization }
export function signPreparedBrowserOperation(config: BrowserWorkerBinding, prepared: PreparedProductBrowserOperation): BrowserWorkerAuthorization {
  if (config.text !== JSON.stringify(prepared)) throw new CoreError('BROWSER_INTENT_BINDING_DENIED');
  const body = authorizationBody(config, prepared);
  return { body, mac: createHmac('sha256', config.token).update(body).digest('hex') };
}
export function assertPreparedBrowserAuthorization(config: AuthorizedBrowserWorkerConfig): PreparedProductBrowserOperation {
  if (!config.browserAuthorization || typeof config.browserAuthorization.body !== 'string' || !/^[a-f0-9]{64}$/u.test(config.browserAuthorization.mac)) throw new CoreError('BROWSER_AUTHORIZATION_REQUIRED');
  if (!equal(createHmac('sha256', config.token).update(config.browserAuthorization.body).digest('hex'), config.browserAuthorization.mac)) throw new CoreError('BROWSER_AUTHORIZATION_DENIED');
  let value: unknown; try { value = JSON.parse(config.text); } catch { throw new CoreError('BROWSER_INTENT_BINDING_DENIED'); }
  if (!record(value) || value.kind !== 'browser' || !record(value.browser) || !record(value.project) || value.project.owner !== config.owner) throw new CoreError('BROWSER_INTENT_BINDING_DENIED');
  const prepared = value as unknown as PreparedProductBrowserOperation;
  if (authorizationBody(config, prepared) !== config.browserAuthorization.body || nativeDigest(prepared.browser.input) !== prepared.browser.planDigest) throw new CoreError('BROWSER_INTENT_BINDING_DENIED');
  return prepared;
}
function authorizationBody(config: BrowserWorkerBinding, prepared: PreparedProductBrowserOperation): string {
  if (!config.owner || !config.jobId || !config.epoch || !config.session || !/^[a-f0-9]{64}$/u.test(config.token) || !config.lease
    || !Number.isSafeInteger(config.generation) || config.generation < 1 || !Number.isSafeInteger(config.intentRevision) || config.intentRevision < 0
    || !/^[a-f0-9]{64}$/u.test(config.authorizationDigest) || !/^[a-f0-9]{64}$/u.test(config.policy) || !['claude', 'test-driver'].includes(config.grace?.mode) || config.nativeTestRunner) throw new CoreError('BROWSER_WORKER_BINDING_INVALID');
  if (config.browserTestTransport && (config.grace.mode !== 'test-driver' || !path.isAbsolute(config.browserTestTransport.path) || !/^[a-f0-9]{64}$/u.test(config.browserTestTransport.sha256))) throw new CoreError('BROWSER_TEST_TRANSPORT_DENIED');
  return JSON.stringify({ schemaVersion: 1, owner: config.owner, jobId: config.jobId, epoch: config.epoch, generation: config.generation, session: config.session,
    intentRevision: config.intentRevision, authorizationDigest: config.authorizationDigest, policy: config.policy, leaseDigest: hash(config.lease), effectRoot: config.effectRoot,
    database: config.database, mode: config.grace.mode, textDigest: hash(config.text), preparedDigest: nativeDigest(prepared), planDigest: prepared.browser.planDigest,
    resourceKeys: prepared.browser.resourceKeys, manifestSha256: prepared.browser.manifestSha256, ...(config.browserTestTransport ? { browserTestTransport: config.browserTestTransport } : {}) });
}
function validateSession(session: TrustedProductBrowserSessionManifest, project: RegisteredProject): void {
  try { validateGotzjiBrowserScope(session); } catch { throw new CoreError('BROWSER_SESSION_UNVERIFIED'); }
  if (!session || session.schemaVersion !== 1 || session.owner !== project.owner || session.projectId !== project.projectId || !session.sessionId
    || !Number.isSafeInteger(session.pid) || session.pid < 1 || typeof session.pidBirth !== 'string' || !session.pidBirth
    || !Number.isSafeInteger(session.port) || session.port < 1024 || session.port > 65535 || typeof session.cdpBrowserContextId !== 'string'
    || !path.isAbsolute(session.profilePath) || !/(?:^|[\\/])gotzji(?:[\\/]|$)/iu.test(session.profilePath)
    || !path.basename(session.profilePath).startsWith('gotzji-browser-provider-') || path.basename(session.executable).toLowerCase() !== 'chrome.exe') throw new CoreError('BROWSER_SESSION_UNVERIFIED');
}
async function pinned(filename: string, expected: string): Promise<string> {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || !/^[a-f0-9]{64}$/u.test(expected)) throw new CoreError('BROWSER_PREREQUISITE_CHANGED');
    const actual = await realpath(filename); const metadata = await lstat(filename);
    if (actual !== path.resolve(filename) || metadata.isSymbolicLink() || !metadata.isFile() || await nativeFileDigest(actual) !== expected) throw new CoreError('BROWSER_PREREQUISITE_CHANGED');
    return actual;
  } catch { throw new CoreError('BROWSER_PREREQUISITE_CHANGED'); }
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach((child: unknown) => freeze(child)); Object.freeze(value); } return value; }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function equal(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(field: string): never { throw new CoreError('BROWSER_INPUT_INVALID', undefined, field, 'browser', 'Select an enrolled owned browser session and a supported typed operation'); }
