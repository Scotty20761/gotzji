export type QualificationOperation = 'fixture.write' | 'fixture.hold' | 'grace.read-save-check' | 'grace.code-check';
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
export interface JobView {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly revision: number;
  readonly operation: QualificationOperation;
  readonly evidenceDigest: string | null;
  readonly curation: 'explicit-only';
  readonly blockerCode?: string;
  readonly deliveryBoundary?: 'local';
  readonly progress?: { readonly runId: string; readonly state: string; readonly elapsedMs: number; readonly checks: number; readonly lastProgressAt: string };
}
/** Adapter-private, never part of model-visible output. */
export interface TaskBinding { readonly jobId: string; readonly handle: string }
export class CoreError extends Error {
  public constructor(public readonly code: string, public readonly reason?: string) { super(code); this.name = 'CoreError'; }
}
export interface WorkerObservation {
  readonly epoch: string;
  readonly pid: number;
  readonly state: 'ready' | 'running' | 'done' | 'cancelled' | 'failed';
  readonly descendants: readonly number[];
}
export interface CodeRunReceipt {
  readonly jobId: string; readonly epoch: string; readonly runId: string; readonly authorizationDigest: string;
  readonly intentRevision: number; readonly command: string; readonly commandFingerprint: string;
  readonly state: 'running' | 'completed' | 'failed' | 'cancelled'; readonly exitCode: number | null;
  readonly artifactHash: string; readonly checks: number; readonly elapsedMs: number; readonly lastProgressAt: string;
}
