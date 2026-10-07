import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export type LibraryRouteKind = 'gotzji-library' | 'lnwjud-library';
export type LibraryEffectClass = 'read' | 'write' | 'delivery';
export type LibraryCancellationMode = 'none' | 'revoke-future' | 'stop-owned';
export type LibraryActor = 'grace' | 'mammos' | 'facty' | 'indie';
export type LibraryDeliveryScope = 'commit' | 'push' | 'deploy' | 'user-delivery';
export type LibraryObligation =
  | 'index-first' | 'source-priority' | 'handoff' | 'index-writeback'
  | 'pipeline' | 'atoms' | 'privacy-boundary' | 'private-lane' | 'facty-audit'
  | 'source-build-live-separation' | 'live-verification';

export interface LibraryPolicySource { readonly id: string; readonly relativePath: string; readonly maxBytes?: number }
export interface LibraryPolicyDescriptor { readonly id: string; readonly relativePath: string; readonly sha256: string; readonly sizeBytes: number }
export interface LibrarySourceScope { readonly projectRoot: string; readonly descriptors: readonly LibraryPolicyDescriptor[]; readonly digest: string }
export interface LibraryRouteAuthority {
  readonly route: LibraryRouteKind; readonly adapterId: string; readonly ownerId: string;
  readonly authorityId: string; readonly projectId: string;
  readonly catalogId: 'gotzji.library.v1' | 'lnwjud.library.v1';
}
export interface LibraryWorkflowStep {
  readonly id: string; readonly operation: string; readonly effect: LibraryEffectClass;
  readonly dependsOn: readonly string[]; readonly cancellation: LibraryCancellationMode;
  readonly actor: LibraryActor; readonly requiredObligations: readonly LibraryObligation[];
  readonly deliveryScope?: LibraryDeliveryScope; readonly requiresSpokeProof?: boolean;
}
export interface LibraryWorkflowDefinition {
  readonly id: string; readonly version: number; readonly title: string;
  readonly sources: readonly LibraryPolicySource[]; readonly allowedParameters: readonly string[];
  readonly requiredParameters: readonly string[]; readonly privacy: 'project-policy' | 'private';
  readonly steps: readonly LibraryWorkflowStep[];
}
export interface LibraryWorkflowAst { readonly kind: 'library-workflow'; readonly workflowId: string; readonly workflowVersion: number; readonly nodes: readonly LibraryWorkflowStep[] }
export interface LibraryWorkflowInput {
  readonly requestId: string; readonly workflowId: string; readonly workflowVersion: number;
  readonly projectId: string; readonly parameters: Readonly<Record<string, string | number | boolean>>;
}
export interface LibraryWorkflowPreparation {
  readonly input: LibraryWorkflowInput; readonly route: LibraryRouteAuthority;
  readonly sourceScope: LibrarySourceScope; readonly ast: LibraryWorkflowAst; readonly digest: string;
}
export interface LibrarySelectedJobAuthority { readonly jobId: string; readonly bindingDigest: string }
export interface LibraryDeliveryAuthority { readonly scope: LibraryDeliveryScope; readonly authorityDigest: string }
export interface LibraryOperationGrantRequest {
  readonly requestDigest: string; readonly preparationDigest: string; readonly sourceDigest: string;
  readonly ownerId: string; readonly authorityId: string; readonly adapterId: string;
  readonly route: LibraryRouteKind; readonly selectedJobId: string; readonly selectedJobBindingDigest: string;
  readonly workflowId: string; readonly workflowVersion: number; readonly stepId: string;
  readonly operation: string; readonly effect: LibraryEffectClass;
  readonly dependencyReceiptDigests: readonly string[]; readonly deliveryAuthority?: LibraryDeliveryAuthority;
}
export interface VerifiedLibraryOperationGrant { readonly requestDigest: string; readonly grantId: string; readonly grantDigest: string; readonly expiresAt: string }
export type VerifiedOperationGrant = (request: LibraryOperationGrantRequest) => Promise<VerifiedLibraryOperationGrant>;
export interface LibrarySpokeProof {
  readonly kind: 'runtime-spoke-receipt'; readonly actor: 'mammos' | 'facty' | 'indie';
  readonly invocationDigest: string; readonly artifactDigest: string; readonly verdict?: 'PASS' | 'CAVEATS' | 'BLOCK';
}
export interface LibraryStepReceipt {
  readonly preparationDigest: string; readonly sourceDigest: string; readonly jobId: string;
  readonly stepId: string; readonly operation: string; readonly grantDigest: string;
  readonly status: 'completed' | 'failed' | 'blocked'; readonly outputDigest: string;
  readonly obligations: readonly LibraryObligation[]; readonly spokeProof?: LibrarySpokeProof;
}
export interface LibraryCancellationPlan { readonly selectedStepId: string; readonly stopOwned: readonly string[]; readonly revokeFuture: readonly string[]; readonly preserve: readonly string[] }

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_.-]{1,100}$/;

export function digestLibraryValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function loadLibraryPolicy(projectRoot: string, sources: readonly LibraryPolicySource[]): LibrarySourceScope {
  if (!path.isAbsolute(projectRoot)) throw new Error('LIBRARY_ROOT_ABSOLUTE_REQUIRED');
  const root = realpathSync(projectRoot);
  if (!lstatSync(root).isDirectory()) throw new Error('LIBRARY_ROOT_DIRECTORY_REQUIRED');
  const ids = new Set<string>(); const names = new Set<string>();
  const descriptors = sources.map((source): LibraryPolicyDescriptor => {
    if (!ID.test(source.id) || ids.has(source.id)) throw new Error('LIBRARY_SOURCE_ID_INVALID'); ids.add(source.id);
    if (!source.relativePath || path.isAbsolute(source.relativePath)) throw new Error('LIBRARY_SOURCE_PATH_INVALID');
    const normalized = source.relativePath.replaceAll('\\', '/');
    if (names.has(normalized)) throw new Error('LIBRARY_SOURCE_PATH_DUPLICATE'); names.add(normalized);
    const target = path.resolve(root, source.relativePath); const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('LIBRARY_SOURCE_SCOPE_DENIED');
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(target) !== target) throw new Error('LIBRARY_SOURCE_REDIRECTED');
    const bytes = readFileSync(target);
    if (bytes.length > (source.maxBytes ?? 2 * 1024 * 1024)) throw new Error('LIBRARY_SOURCE_TOO_LARGE');
    return { id: source.id, relativePath: normalized, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { projectRoot: root, descriptors, digest: digestLibraryValue(descriptors) };
}

export function validateLibraryWorkflow(definition: LibraryWorkflowDefinition): LibraryWorkflowAst {
  if (!ID.test(definition.id) || !Number.isSafeInteger(definition.version) || definition.version < 1) throw new Error('LIBRARY_WORKFLOW_ID_INVALID');
  const ids = new Set(definition.steps.map((entry) => entry.id));
  if (ids.size !== definition.steps.length || definition.steps.some((entry) => !ID.test(entry.id) || !ID.test(entry.operation))) throw new Error('LIBRARY_STEP_ID_INVALID');
  for (const entry of definition.steps) {
    if (entry.dependsOn.some((dependency) => !ids.has(dependency) || dependency === entry.id)) throw new Error('LIBRARY_DEPENDENCY_INVALID');
    if (entry.effect === 'delivery' && !entry.deliveryScope) throw new Error('LIBRARY_DELIVERY_SCOPE_REQUIRED');
    if (entry.effect !== 'delivery' && entry.deliveryScope) throw new Error('LIBRARY_DELIVERY_SCOPE_INVALID');
    if (entry.requiresSpokeProof && !['mammos', 'facty', 'indie'].includes(entry.actor)) throw new Error('LIBRARY_SPOKE_PROOF_INVALID');
  }
  const visiting = new Set<string>(); const visited = new Set<string>(); const byId = new Map(definition.steps.map((entry) => [entry.id, entry]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('LIBRARY_DEPENDENCY_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return { kind: 'library-workflow', workflowId: definition.id, workflowVersion: definition.version, nodes: definition.steps.map((entry) => ({ ...entry })) };
}

export function libraryCancellationPlan(ast: LibraryWorkflowAst, selectedStepId: string): LibraryCancellationPlan {
  const selected = ast.nodes.find((entry) => entry.id === selectedStepId); if (!selected) throw new Error('LIBRARY_STEP_NOT_FOUND');
  const revoked = new Set<string>(); let changed = true;
  while (changed) {
    changed = false;
    for (const entry of ast.nodes) if (entry.id !== selectedStepId && !revoked.has(entry.id) && entry.dependsOn.some((dependency) => dependency === selectedStepId || revoked.has(dependency))) { revoked.add(entry.id); changed = true; }
  }
  return { selectedStepId, stopOwned: selected.cancellation === 'stop-owned' ? [selectedStepId] : [], revokeFuture: [...revoked], preserve: ast.nodes.map((entry) => entry.id).filter((id) => id !== selectedStepId && !revoked.has(id)) };
}

export function assertLibraryRoute(route: LibraryRouteAuthority): void {
  const expected = route.route === 'gotzji-library' ? 'gotzji.library.v1' : route.route === 'lnwjud-library' ? 'lnwjud.library.v1' : undefined;
  if (!expected || route.catalogId !== expected || !ID.test(route.adapterId) || !ID.test(route.ownerId) || !ID.test(route.authorityId) || !ID.test(route.projectId)) throw new Error('LIBRARY_ROUTE_AUTHORITY_DENIED');
}

export function assertLibraryStepReceipt(preparation: LibraryWorkflowPreparation, step: LibraryWorkflowStep, grant: VerifiedLibraryOperationGrant, receipt: LibraryStepReceipt): void {
  if (receipt.preparationDigest !== preparation.digest || receipt.sourceDigest !== preparation.sourceScope.digest || receipt.stepId !== step.id || receipt.operation !== step.operation || receipt.grantDigest !== grant.grantDigest || !SHA256.test(receipt.outputDigest)) throw new Error('LIBRARY_STEP_RECEIPT_MISMATCH');
  const obligations = new Set(receipt.obligations);
  if (step.requiredObligations.some((obligation) => !obligations.has(obligation))) throw new Error('LIBRARY_OBLIGATION_EVIDENCE_REQUIRED');
  if (step.requiresSpokeProof) {
    const proof = receipt.spokeProof;
    if (!proof || proof.kind !== 'runtime-spoke-receipt' || proof.actor !== step.actor || !SHA256.test(proof.invocationDigest) || !SHA256.test(proof.artifactDigest)) throw new Error('LIBRARY_RUNTIME_SPOKE_PROOF_REQUIRED');
    if (step.actor === 'facty' && !proof.verdict) throw new Error('LIBRARY_FACTY_VERDICT_REQUIRED');
  }
}
