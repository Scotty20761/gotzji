export type QualificationOperation = 'fixture.write' | 'fixture.hold' | 'grace.read-save-check' | 'grace.code-check' | 'grace.product-operation';
export interface RequestInput {
  readonly requestId: string;
  readonly operation: QualificationOperation;
  readonly text: string;
}
export interface Preparation {
  readonly preparationId: string;
  readonly digest: string;
}
export type JobStatus = 'queued' | 'running' | 'verifying' | 'blocked' | 'completed' | 'cancelled' | 'failed';
export type SettleDecision = 'effect-present' | 'no-effect';
export interface JobView {
  readonly jobId: string;
  readonly requestId?: string;
  readonly status: JobStatus;
  readonly revision: number;
  readonly operation: QualificationOperation;
  readonly evidenceDigest: string | null;
  readonly curation: 'explicit-only';
  readonly blockerCode?: string;
  readonly deliveryBoundary?: 'local';
  readonly projectId?: string;
  readonly requestedOperation?: ProductOperationName;
  readonly waitingReason?: string;
  readonly summary?: string;
  readonly priority?: number;
  readonly queuePosition?: number;
  readonly blockingResource?: string;
  readonly blockingJob?: string;
  readonly blockingDependency?: string;
  readonly retryAt?: string;
  readonly progress?: { readonly runId: string; readonly state: string; readonly elapsedMs: number; readonly checks: number; readonly lastProgressAt: string };
  /** Decisions the owner may record to settle this blocked project job: it holds its project and its work has ended. */
  readonly settleDecisions?: readonly SettleDecision[];
}
/** Adapter-private, never part of model-visible output. */
export interface TaskBinding { readonly jobId: string; readonly handle: string }
export class CoreError extends Error {
  public constructor(public readonly code: string, public readonly reason?: string, public readonly field?: string, public readonly layer?: string, public readonly action?: string) { super(code); this.name = 'CoreError'; }
}
export type BasicProductOperationName = 'file.read' | 'file.write' | 'command.run';
export type ProductOperationName = BasicProductOperationName | import('./product-native.js').ProductNativeOperationName | import('./product-browser.js').ProductBrowserOperationName | 'library.workflow';
export interface BasicProductOperationInput {
  readonly requestId: string;
  readonly projectId: string;
  readonly operation: BasicProductOperationName;
  readonly path?: string;
  readonly expectedSha256?: string | null;
  readonly content?: string;
  readonly commandId?: string;
  readonly dependsOn?: readonly string[];
  readonly priority?: number;
}
export type ProductOperationInput = BasicProductOperationInput | import('./product-native.js').ProductNativeInput | import('./product-browser.js').ProductBrowserInput | import('./product-library.js').ProductLibraryInput;
/** Command/project enrollment is trusted host setup, never a model-controlled executable. */
export interface ProjectRegistration {
  readonly projectId: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly kind?: 'project' | 'library';
  readonly recipeIds?: readonly string[];
}
/** Only trusted composition/test setup can enroll executable recipes. */
export interface ReviewedCommandRegistration {
  readonly recipeId: string;
  readonly displayName?: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly dependencies: readonly string[];
}
export interface FileFingerprint { readonly path: string; readonly hash: string }
export interface ReviewedCommand {
  readonly commandId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly dependencies: readonly FileFingerprint[];
}
export interface RegisteredProject extends ProjectRegistration {
  readonly owner: string;
  readonly rootPath: string;
  readonly resourceKey: string;
  readonly recipeIds: readonly string[];
}
export interface ProductOperation {
  readonly kind?: 'basic';
  readonly input: BasicProductOperationInput;
  readonly project: RegisteredProject;
  readonly target?: string;
  readonly beforeSha256?: string | null;
  readonly afterSha256?: string;
  readonly command?: ReviewedCommand & { readonly executableHash: string };
  readonly projectPolicies: Readonly<Record<string, FileFingerprint>>;
  readonly policyDirectories: readonly string[];
}
export type PreparedProductOperation = ProductOperation | import('./product-native.js').PreparedProductNativeOperation | import('./product-browser.js').PreparedProductBrowserOperation | import('./product-library.js').PreparedLibraryOperation;
export interface CatalogEntry {
  readonly name: string;
  readonly state: 'available' | 'unsupported';
  readonly description: string;
  readonly controller: 'grace';
  readonly reason?: string;
  readonly recipeId?: string;
  readonly workflowId?: string;
  readonly workflowVersion?: number;
  readonly projectId?: string;
}
export interface WorkerObservation {
  readonly epoch: string;
  readonly pid: number;
  readonly state: 'ready' | 'running' | 'done' | 'cancelled' | 'failed';
  readonly descendants: readonly number[];
  readonly identities?: Readonly<Record<number, { readonly birth: string; readonly executable: string }>>;
  readonly closedDescendants?: readonly number[];
}
export interface CodeRunReceipt {
  readonly jobId: string; readonly epoch: string; readonly runId: string; readonly authorizationDigest: string;
  readonly intentRevision: number; readonly command: string; readonly commandFingerprint: string;
  readonly state: 'running' | 'completed' | 'failed' | 'cancelled'; readonly exitCode: number | null;
  readonly artifactHash: string; readonly checks: number; readonly elapsedMs: number; readonly lastProgressAt: string;
}
