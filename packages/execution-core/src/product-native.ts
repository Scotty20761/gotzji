import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { nativeDigest, nativeFileDigest, planGotzjiNativeOperation, type GotzjiNativeOperation, type GotzjiNativePlan } from '@lnwjud/capabilities/gotzji-native-contract';
import { discoverPolicies } from './product-projects.js';
import { CoreError, type FileFingerprint, type RegisteredProject } from './types.js';

export const PRODUCT_NATIVE_OPERATIONS = ['excel.range.read', 'excel.range.write', 'word.paragraph.read', 'word.paragraph.write', 'powerpoint.shape.read', 'powerpoint.shape.write', 'cad.entity.inspect', 'cad.entity.move'] as const;
export type ProductNativeOperationName = typeof PRODUCT_NATIVE_OPERATIONS[number];
type PublicNativeVariant<T extends GotzjiNativeOperation> = T extends GotzjiNativeOperation
  ? Omit<T, 'filePath' | 'expectedSha256' | 'outputPath'> & {
    readonly requestId: string; readonly projectId: string; readonly path: string; readonly expectedSha256?: string;
    readonly priority?: number; readonly dependsOn?: readonly string[];
  } & (T extends { readonly outputPath: string } ? { readonly outputPath: string } : { readonly outputPath?: never }) : never;
export type ProductNativeInput = PublicNativeVariant<GotzjiNativeOperation>;
/** Trusted composition only; these fields never come from app/MCP operation arguments. */
export interface TrustedProductNativeOptions {
  readonly scriptPath: string; readonly scriptSha256: string;
  readonly operations?: readonly ProductNativeOperationName[];
  readonly cad?: { readonly scriptPath: string; readonly scriptSha256: string; readonly executable: string; readonly executableSha256: string };
}
export interface PreparedProductNativeOperation {
  readonly kind: 'native';
  readonly input: ProductNativeInput;
  readonly project: RegisteredProject;
  readonly target: string;
  readonly beforeSha256: string;
  readonly projectPolicies: Readonly<Record<string, FileFingerprint>>;
  readonly policyDirectories: readonly string[];
  readonly native: {
    readonly input: GotzjiNativeOperation;
    readonly planDigest: string;
    readonly adapterResourceKeys: readonly string[];
    readonly resourceKeys: readonly string[];
    readonly scriptPath: string;
    readonly scriptSha256: string;
    readonly provider: 'office' | 'cad-session';
    readonly cad?: { readonly executable: string; readonly executableSha256: string };
  };
}
const nativeFields: Record<ProductNativeOperationName, readonly string[]> = {
  'excel.range.read': ['sheet', 'range'], 'excel.range.write': ['sheet', 'range', 'values', 'outputPath'],
  'word.paragraph.read': ['paragraph'], 'word.paragraph.write': ['paragraph', 'text', 'outputPath'],
  'powerpoint.shape.read': ['slide', 'shape'], 'powerpoint.shape.write': ['slide', 'shape', 'text', 'outputPath'],
  'cad.entity.inspect': ['handle'], 'cad.entity.move': ['handle', 'displacement', 'outputPath'],
};
export function productNativeResources(project: RegisteredProject, plan: GotzjiNativePlan): readonly string[] {
  return [...new Set([`project:${project.resourceKey}`, 'globalui:windows', ...plan.resourceKeys])].sort();
}
export async function prepareProductNativeOperation(project: RegisteredProject, value: unknown, options: TrustedProductNativeOptions): Promise<PreparedProductNativeOperation> {
  if (!record(value) || typeof value.operation !== 'string' || !PRODUCT_NATIVE_OPERATIONS.includes(value.operation as ProductNativeOperationName)) invalid('operation');
  const operation = value.operation as ProductNativeOperationName;
  if (options.operations && !options.operations.includes(operation)) throw new CoreError('NATIVE_OPERATION_UNAVAILABLE', undefined, 'operation');
  if (Object.keys(value).some((key) => !['requestId', 'projectId', 'operation', 'path', 'expectedSha256', 'priority', 'dependsOn', ...nativeFields[operation]].includes(key))) invalid('arguments');
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(value.requestId)) invalid('requestId');
  if (value.projectId !== project.projectId || !project.owner || !project.resourceKey) throw new CoreError('NATIVE_PROJECT_DENIED', undefined, 'projectId');
  if (value.priority !== undefined && (!Number.isInteger(value.priority) || Number(value.priority) < 0 || Number(value.priority) > 3)) invalid('priority');
  if (value.dependsOn !== undefined && (!Array.isArray(value.dependsOn) || value.dependsOn.length > 8 || value.dependsOn.some((id: unknown) => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) || new Set(value.dependsOn).size !== value.dependsOn.length)) invalid('dependsOn');
  const root = await realpath(project.rootPath);
  if (root !== project.rootPath) throw new CoreError('PROJECT_ROOT_CHANGED', undefined, 'rootPath');
  const target = relativeTarget(root, value.path, 'path');
  const beforeSha256 = await nativeFileDigest(target);
  if (value.expectedSha256 !== undefined && value.expectedSha256 !== beforeSha256) throw new CoreError('NATIVE_FILE_VERSION_CONFLICT', undefined, 'expectedSha256');
  const nativeInput: Record<string, unknown> = { operation, filePath: target, expectedSha256: beforeSha256 };
  const publicInput: Record<string, unknown> = { requestId: value.requestId, projectId: project.projectId, operation, path: path.relative(root, target), expectedSha256: beforeSha256,
    ...(value.priority === undefined ? {} : { priority: value.priority }), ...(value.dependsOn === undefined ? {} : { dependsOn: [...value.dependsOn] }) };
  for (const key of nativeFields[operation]) {
    if (key === 'outputPath') {
      nativeInput.outputPath = relativeTarget(root, value.outputPath, key);
      publicInput.outputPath = path.relative(root, String(nativeInput.outputPath));
    } else { nativeInput[key] = value[key]; publicInput[key] = value[key]; }
  }
  const plan = await planGotzjiNativeOperation(nativeInput, root);
  const provider = operation.startsWith('cad.') ? 'cad-session' : 'office';
  if (provider === 'cad-session' && !options.cad) throw new CoreError('NATIVE_PROVIDER_NOT_CONFIGURED', undefined, 'cad');
  const selectedProvider = provider === 'cad-session' ? options.cad! : options;
  const scriptPath = await pinnedNativeFile(selectedProvider.scriptPath, selectedProvider.scriptSha256, 'scriptPath');
  const cad = provider === 'cad-session' ? { executable: await pinnedNativeFile(options.cad!.executable, options.cad!.executableSha256, 'executable'), executableSha256: options.cad!.executableSha256 } : undefined;
  const policies = discoverPolicies(root, [path.dirname(target), ...('outputPath' in plan.input ? [path.dirname(plan.input.outputPath)] : [])]);
  return deepFreeze({ kind: 'native', input: structuredClone(publicInput) as unknown as ProductNativeInput, project: structuredClone(project), target, beforeSha256, ...policies,
    native: { input: structuredClone(plan.input), planDigest: plan.digest, adapterResourceKeys: plan.resourceKeys, resourceKeys: productNativeResources(project, plan), scriptPath, scriptSha256: selectedProvider.scriptSha256, provider, ...(cad ? { cad } : {}) } });
}
export interface NativeWorkerBinding {
  readonly owner: string; readonly jobId: string; readonly epoch: string; readonly generation: number; readonly session: string;
  readonly intentRevision: number; readonly authorizationDigest: string; readonly policy: string; readonly token: string; readonly lease: string;
  readonly effectRoot: string; readonly database: string; readonly text: string; readonly grace: { readonly mode: 'claude' | 'test-driver' };
  readonly nativeTestRunner?: { readonly path: string; readonly sha256: string };
}
export interface NativeWorkerAuthorization { readonly body: string; readonly mac: string }
export interface AuthorizedNativeWorkerConfig extends NativeWorkerBinding { readonly nativeAuthorization: NativeWorkerAuthorization }
export function signPreparedNativeOperation(config: NativeWorkerBinding, prepared: PreparedProductNativeOperation): NativeWorkerAuthorization {
  if (config.text !== JSON.stringify(prepared)) throw new CoreError('NATIVE_INTENT_BINDING_DENIED');
  const body = nativeAuthorizationBody(config, prepared);
  return { body, mac: createHmac('sha256', config.token).update(body).digest('hex') };
}
export function assertPreparedNativeAuthorization(config: AuthorizedNativeWorkerConfig): PreparedProductNativeOperation {
  if (!config.nativeAuthorization || typeof config.nativeAuthorization.body !== 'string' || !/^[a-f0-9]{64}$/u.test(config.nativeAuthorization.mac)) throw new CoreError('NATIVE_AUTHORIZATION_REQUIRED');
  const expected = createHmac('sha256', config.token).update(config.nativeAuthorization.body).digest('hex');
  if (!safeEqual(expected, config.nativeAuthorization.mac)) throw new CoreError('NATIVE_AUTHORIZATION_DENIED');
  let value: unknown;
  try { value = JSON.parse(config.text); } catch { throw new CoreError('NATIVE_INTENT_BINDING_DENIED'); }
  if (!record(value) || value.kind !== 'native' || !record(value.native) || !record(value.project) || value.project.owner !== config.owner) throw new CoreError('NATIVE_INTENT_BINDING_DENIED');
  const prepared = value as unknown as PreparedProductNativeOperation;
  if (nativeAuthorizationBody(config, prepared) !== config.nativeAuthorization.body || nativeDigest(prepared.native.input) !== prepared.native.planDigest) throw new CoreError('NATIVE_INTENT_BINDING_DENIED');
  return prepared;
}
function nativeAuthorizationBody(config: NativeWorkerBinding, prepared: PreparedProductNativeOperation): string {
  if (!config.owner || !config.jobId || !config.epoch || !config.session || !/^[a-f0-9]{64}$/u.test(config.token) || !config.lease
    || !Number.isSafeInteger(config.generation) || config.generation < 1 || !Number.isSafeInteger(config.intentRevision) || config.intentRevision < 0
    || !/^[a-f0-9]{64}$/u.test(config.authorizationDigest) || !/^[a-f0-9]{64}$/u.test(config.policy) || !['claude', 'test-driver'].includes(config.grace?.mode)) throw new CoreError('NATIVE_WORKER_BINDING_INVALID');
  if (config.nativeTestRunner && (config.grace.mode !== 'test-driver' || !path.isAbsolute(config.nativeTestRunner.path) || !/^[a-f0-9]{64}$/u.test(config.nativeTestRunner.sha256))) throw new CoreError('NATIVE_TEST_RUNNER_DENIED');
  return JSON.stringify({ schemaVersion: 1, owner: config.owner, jobId: config.jobId, epoch: config.epoch, generation: config.generation, session: config.session,
    intentRevision: config.intentRevision, authorizationDigest: config.authorizationDigest, policy: config.policy, leaseDigest: hash(config.lease),
    effectRoot: config.effectRoot, database: config.database, mode: config.grace.mode, ...(config.nativeTestRunner ? { nativeTestRunner: config.nativeTestRunner } : {}), textDigest: hash(config.text), preparedDigest: hash(JSON.stringify(prepared)),
    planDigest: prepared.native.planDigest, resourceKeys: prepared.native.resourceKeys, scriptPath: prepared.native.scriptPath, scriptSha256: prepared.native.scriptSha256,
    provider: prepared.native.provider, ...(prepared.native.cad ? { cad: prepared.native.cad } : {}) });
}
async function pinnedNativeFile(filename: string, expected: string, field: string): Promise<string> {
  const actual = await realpath(filename); const metadata = await lstat(filename);
  if (actual !== path.resolve(filename) || metadata.isSymbolicLink() || !metadata.isFile() || !/^[a-f0-9]{64}$/u.test(expected) || await nativeFileDigest(actual) !== expected) throw new CoreError('NATIVE_PROVIDER_CHANGED', undefined, field);
  return actual;
}
function relativeTarget(root: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /^[a-zA-Z]:/u.test(value) || value.includes('\0')) invalid(field);
  const target = path.resolve(root, value); const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new CoreError('NATIVE_SCOPE_DENIED', undefined, field);
  return target;
}
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach((child: unknown) => deepFreeze(child)); Object.freeze(value); } return value; }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(field: string): never { throw new CoreError('NATIVE_INPUT_INVALID', undefined, field, 'native', 'Select an enrolled project and supported typed operation'); }
