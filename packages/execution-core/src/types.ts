export type QualificationOperation = 'fixture.write' | 'fixture.hold';
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
}
/** Adapter-private, never part of model-visible output. */
export interface TaskBinding { readonly jobId: string; readonly handle: string }
export class CoreError extends Error {
  public constructor(public readonly code: string) { super(code); this.name = 'CoreError'; }
}
export interface WorkerObservation {
  readonly epoch: string;
  readonly pid: number;
  readonly state: 'ready' | 'running' | 'done' | 'cancelled' | 'failed';
  readonly descendants: readonly number[];
}
