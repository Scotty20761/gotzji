export type EngineeringTaskKind =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'review'
  | 'incident'
  | 'release'
  | 'maintenance'
  | 'docs'
  | 'unknown';

export type EngineeringRiskTier = 'low' | 'medium' | 'high' | 'critical';

export type EngineeringDeliveryScope =
  | 'local'
  | 'commit'
  | 'push'
  | 'pull_request'
  | 'merge'
  | 'release'
  | 'deploy';

export type EngineeringGateStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'not_applicable'
  | 'stale';

export type EngineeringGateEvidenceSource = 'host_observed' | 'user_attested';

export interface EngineeringGateEvidence {
  readonly source: EngineeringGateEvidenceSource;
  readonly observedAt: string;
  readonly workspaceId: string;
  readonly commit?: string;
  readonly command?: string;
  readonly runId?: string;
  readonly exitCode?: number;
  readonly conclusion?: string;
  readonly artifact?: string;
}

export const ENGINEERING_GATE_EVIDENCE_FAILURE_REASONS = [
  'missing_run_id',
  'missing_command',
  'runtime_provider_unavailable',
  'run_not_found',
  'run_observation_unavailable',
  'run_not_terminal',
  'run_nonzero_exit',
  'run_exit_code_mismatch',
  'command_fingerprint_mismatch',
  'source_state_mismatch',
  'artifact_mismatch',
  'ci_mismatch',
  'job_binding_mismatch',
  'host_runtime_rejected',
] as const;

export type EngineeringGateEvidenceFailureReason = typeof ENGINEERING_GATE_EVIDENCE_FAILURE_REASONS[number];

export type EngineeringGateEvidenceVerificationResult =
  | { readonly verified: true }
  | { readonly verified: false; readonly reason: EngineeringGateEvidenceFailureReason };

export interface EngineeringGateEvidenceBinding {
  readonly goalId: string;
  readonly ownerClientId: string;
  readonly userIntentRevision: number;
}

const ENGINEERING_GATE_EVIDENCE_FAILURE_REASON_SET = new Set<string>(ENGINEERING_GATE_EVIDENCE_FAILURE_REASONS);

export function isEngineeringGateEvidenceFailureReason(value: unknown): value is EngineeringGateEvidenceFailureReason {
  return typeof value === 'string' && ENGINEERING_GATE_EVIDENCE_FAILURE_REASON_SET.has(value);
}

export interface EngineeringGateDefinition {
  readonly id: string;
  readonly title: string;
  readonly applicability: 'required' | 'optional' | 'not_applicable';
  readonly status: EngineeringGateStatus;
  readonly reason: string;
  readonly basedOnUserIntentRevision: number;
  readonly checkCommand?: string;
  readonly requiredPlatforms?: readonly ('win32' | 'darwin' | 'linux')[];
  readonly evidence?: EngineeringGateEvidence;
}

/** Required proof gates cannot be dismissed by a free-form reason. */
export function mayMarkEngineeringGateNotApplicable(gate: EngineeringGateDefinition): boolean {
  return gate.applicability !== 'required' || gate.id === 'docs_impact' || gate.id === 'independent_review';
}

const HOST_OBSERVED_GATE_IDS = new Set(['diff', 'focused_validation', 'integration', 'restart_persistence', 'architecture', 'cross_platform', 'exact_sha_ci', 'package']);

export function requiresHostObservedEngineeringEvidence(gateId: string): boolean {
  return HOST_OBSERVED_GATE_IDS.has(gateId);
}

/**
 * Minimal Engineering Harness projection stored on the existing durable goal.
 * Goal plan, acceptance criteria, evidence, checkpoints, leases, and intent
 * revision remain authoritative in their existing fields.
 */
export type EngineeringReviewFindingSeverity = 'blocking' | 'non_blocking';
export type EngineeringReviewFindingState = 'open' | 'validated' | 'rejected' | 'resolved';

export interface EngineeringReviewFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: EngineeringReviewFindingSeverity;
  readonly state: EngineeringReviewFindingState;
  readonly reason: string;
  readonly source?: string;
}

export interface EngineeringGoalMetadata {
  readonly schemaVersion: 1;
  readonly primaryTaskKind: EngineeringTaskKind;
  readonly riskTier: EngineeringRiskTier;
  readonly policyDigest: string;
  readonly deliveryScope: EngineeringDeliveryScope;
  readonly scopedPath?: string;
  readonly gates: readonly EngineeringGateDefinition[];
  readonly reviewFindings?: readonly EngineeringReviewFinding[];
}
