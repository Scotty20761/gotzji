import type {
  EngineeringDeliveryScope,
  EngineeringGateDefinition,
  EngineeringGoalMetadata,
  EngineeringRiskTier,
  EngineeringTaskKind,
} from '@lnwjud/domain';
import { projectEngineeringSettings, type EngineeringHarnessSettings, type EngineeringProfile, type ProjectEngineeringSettings } from '@lnwjud/shared';
import type { EngineeringProjectAssessment } from './engineering-project-assessment.js';

export type EngineeringCodeIntelligence = 'codegraph' | 'lsp_search';

export interface EngineeringWorkflowPolicy {
  readonly profile: EngineeringProfile;
  readonly custom?: NonNullable<EngineeringHarnessSettings['custom']>;
}

export interface EngineeringWorkflowStep {
  readonly id: string;
  readonly title: string;
}

export interface EngineeringWorkflowPlan {
  readonly primaryTaskKind: EngineeringTaskKind;
  readonly riskTier: EngineeringRiskTier;
  readonly analysisMode: 'focused' | 'cross_file';
  readonly riskReasons: readonly string[];
  readonly workflow: readonly EngineeringWorkflowStep[];
  readonly gates: readonly EngineeringGateDefinition[];
  readonly selectedCodeIntelligence: EngineeringCodeIntelligence;
  readonly codeIntelligenceReason: string;
  readonly deliveryScope: EngineeringDeliveryScope;
}

export function planEngineeringWorkflow(
  objective: string,
  assessment: EngineeringProjectAssessment,
  userIntentRevision = 0,
  policy: EngineeringWorkflowPolicy = { profile: 'senior' },
): EngineeringWorkflowPlan {
  const primaryTaskKind = classifyEngineeringTaskKind(objective);
  const { tier: riskTier, reasons: riskReasons } = classifyEngineeringRisk(objective, primaryTaskKind);
  const analysisMode = policy.profile === 'standard'
    ? 'focused'
    : policy.profile === 'custom'
      ? policy.custom?.analysis ?? 'cross_file'
      : 'cross_file';
  const deliveryScope = inferDeliveryScope(objective);
  const workflow = workflowFor(primaryTaskKind, riskTier);
  const gates = gatesFor(primaryTaskKind, riskTier, deliveryScope, objective, userIntentRevision, policy, projectEngineeringSettings(assessment.projectProfile));
  const instructionText = assessment.instructions
    .filter((entry) => entry.status === 'loaded' || entry.status === 'truncated')
    .map((entry) => entry.content ?? '')
    .join('\n');
  const codeGraphRequested = /codegraph/i.test(instructionText) && assessment.codeGraphIndexed === true;
  return {
    primaryTaskKind,
    riskTier,
    analysisMode,
    riskReasons,
    workflow,
    gates,
    selectedCodeIntelligence: codeGraphRequested ? 'codegraph' : 'lsp_search',
    codeIntelligenceReason: codeGraphRequested
      ? 'Applicable project instructions require CodeGraph and this workspace has a .codegraph index; verify the callable tool before use.'
      : 'No indexed CodeGraph-first instruction applies; use available symbol/LSP tools with search fallback.',
    deliveryScope,
  };
}

export function engineeringGoalMetadata(
  policyDigest: string,
  plan: EngineeringWorkflowPlan,
  scopedPath?: string,
): EngineeringGoalMetadata {
  return {
    schemaVersion: 1,
    primaryTaskKind: plan.primaryTaskKind,
    riskTier: plan.riskTier,
    policyDigest,
    deliveryScope: plan.deliveryScope,
    ...(scopedPath === undefined ? {} : { scopedPath }),
    gates: plan.gates,
  };
}

export function classifyEngineeringTaskKind(objective: string): EngineeringTaskKind {
  const value = objective.trim().toLowerCase();
  if (/(\brelease\b|\bpublish\b|\btag\b|ปล่อยเวอร์ชัน|รีลีส)/i.test(affirmativeDeliveryText(value))) return 'release';
  if (/(\bincident\b|\boutage\b|production down|service down|เหตุขัดข้อง|ระบบล่ม)/i.test(value)) return 'incident';
  if (/(\breview\b|code review|audit diff|ตรวจโค้ด|รีวิวโค้ด)/i.test(value)) return 'review';
  if (/(\bdocs?\b|readme|typo|copy change|documentation|เอกสาร|คำผิด)/i.test(value)) return 'docs';
  if (/(css[- ]only|style[- ]only|icon[- ]only|spacing[- ]only|harmless rename|ระยะห่าง|ไอคอน)/i.test(value)) return 'maintenance';
  if (/(\brefactor\b|restructure|rename architecture|รีแฟคเตอร์|ปรับโครงสร้าง)/i.test(value)) return 'refactor';
  if (/(\bbug\b|\bfix\b|broken|fails?|error|regression|doesn'?t|cannot|แก้บั๊ก|พัง|เออเรอร์)/i.test(value)) return 'bugfix';
  if (/(\badd\b|\bimplement\b|\bfeature\b|create|support|enable|เพิ่ม|สร้าง|รองรับ)/i.test(value)) return 'feature';
  if (/(dependency|upgrade|maintenance|chore|cleanup|อัปเดต dependency|บำรุงรักษา)/i.test(value)) return 'maintenance';
  return 'unknown';
}

export function classifyEngineeringRisk(
  objective: string,
  taskKind: EngineeringTaskKind = classifyEngineeringTaskKind(objective),
): { readonly tier: EngineeringRiskTier; readonly reasons: readonly string[] } {
  const value = objective.trim().toLowerCase();
  const reasons: string[] = [];
  if (taskKind === 'release' || /(production deploy|data migration|destructive|drop table|credential boundary|deploy production|ขึ้น production)/i.test(value)) {
    reasons.push('Release, production, destructive data, or credential-boundary work requires recovery/provenance evidence.');
    return { tier: 'critical', reasons };
  }
  if (/(auth|token|session|permission|security|persist|storage|database|schema|migration|concurr|race|cross[- ]platform|native|api contract|oauth|สิทธิ์|ฐานข้อมูล|โทเคน|เซสชัน)/i.test(value)) {
    reasons.push('The request touches a high-risk contract, persistence, security, concurrency, native, or cross-platform surface.');
    return { tier: 'high', reasons };
  }
  if (taskKind === 'docs' || /(css[- ]only|copy only|icon only|spacing|typo|คำผิด|ระยะห่าง|ไอคอน)/i.test(value)) {
    reasons.push('The request is documentation, copy, styling, icon, or another low-risk mechanical change.');
    return { tier: 'low', reasons };
  }
  if (taskKind === 'review') {
    reasons.push('Review is read-only unless mutation is separately requested.');
    return { tier: 'low', reasons };
  }
  reasons.push('The request changes local software behavior or structure without a high-risk trigger.');
  return { tier: 'medium', reasons };
}

export function inferDeliveryScope(objective: string): EngineeringDeliveryScope {
  const value = affirmativeDeliveryText(objective.trim().toLowerCase());
  if (/(\bdeploy\b|ขึ้น prod|ขึ้น production)/i.test(value)) return 'deploy';
  if (/(\brelease\b|\bpublish\b|\btag\b|รีลีส|ปล่อยเวอร์ชัน)/i.test(value)) return 'release';
  if (/(\bmerge\b|รวม pr)/i.test(value)) return 'merge';
  if (/(\bpull request\b|\bpr\b)/i.test(value)) return 'pull_request';
  if (/(\bpush\b|ส่งขึ้น git)/i.test(value)) return 'push';
  if (/(\bcommit\b|คอมมิต)/i.test(value)) return 'commit';
  return 'local';
}

function affirmativeDeliveryText(value: string): string {
  // Delivery words inside a prohibition are not authorization. Treat the
  // remainder of that clause conservatively until the next sentence or
  // semicolon. Commas often separate one prohibited delivery list.
  return value.replace(/(?:\b(?:do not|don't|dont|never|without|no)\b|ไม่ต้อง|ห้าม|อย่า)[^;.\n!?]*/gi, ' ');
}

function workflowFor(taskKind: EngineeringTaskKind, riskTier: EngineeringRiskTier): readonly EngineeringWorkflowStep[] {
  if (taskKind === 'docs' || (taskKind === 'maintenance' && riskTier === 'low')) {
    return [
      { id: 'inspect', title: 'Inspect target and nearby conventions' },
      { id: 'implement', title: 'Apply the bounded edit' },
      { id: 'validate', title: 'Check the resulting diff and applicable formatting or links' },
    ];
  }
  if (taskKind === 'review') {
    return [
      { id: 'scope', title: 'Resolve exact review scope and base' },
      { id: 'analyze', title: 'Inspect affected paths, callers, and contracts' },
      { id: 'report', title: 'Report source-backed findings without mutation' },
    ];
  }
  if (taskKind === 'bugfix') {
    return [
      { id: 'reproduce', title: 'Reproduce the failure or record why reproduction is unavailable' },
      { id: 'trace', title: 'Trace root cause and affected references' },
      { id: 'plan', title: 'Plan the smallest justified repair and regression evidence' },
      { id: 'implement', title: 'Implement the repair' },
      { id: 'validate', title: 'Run focused regression and affected diagnostics' },
      { id: 'review', title: 'Review compatibility, side effects, and documentation impact' },
    ];
  }
  if (taskKind === 'refactor') {
    return [
      { id: 'invariants', title: 'Capture current behavior, invariants, callers, and compatibility constraints' },
      { id: 'plan', title: 'Plan the migration or structural change' },
      { id: 'implement', title: 'Perform the refactor with reference-aware tooling where available' },
      { id: 'validate', title: 'Verify existing behavior and configured architecture checks' },
      { id: 'review', title: 'Review dependency and compatibility impact' },
    ];
  }
  if (taskKind === 'incident') {
    return [
      { id: 'observe', title: 'Capture observed failure, timeline, and scope' },
      { id: 'contain', title: 'Contain risk without hiding the root cause' },
      { id: 'diagnose', title: 'Establish root cause from evidence' },
      { id: 'repair', title: 'Apply and validate recovery' },
      { id: 'followup', title: 'Record regression and follow-up evidence' },
    ];
  }
  if (taskKind === 'release') {
    return [
      { id: 'source', title: 'Resolve exact source SHA and authorized delivery boundary' },
      { id: 'verify', title: 'Run required local and hosted release gates' },
      { id: 'artifacts', title: 'Verify exact-run artifacts, signatures, and provenance where applicable' },
      { id: 'deliver', title: 'Perform only the explicitly authorized delivery actions' },
    ];
  }
  return [
    { id: 'requirements', title: 'Resolve requirement and affected contracts' },
    { id: 'architecture', title: 'Inspect current architecture and affected references' },
    { id: 'risk', title: 'Confirm impact, risk, and validation plan' },
    { id: 'implement', title: 'Implement within the requested scope' },
    { id: 'validate', title: 'Run proportionate focused and integration validation' },
    { id: 'review', title: 'Review compatibility, tests, and documentation impact' },
  ];
}

function gatesFor(
  taskKind: EngineeringTaskKind,
  riskTier: EngineeringRiskTier,
  deliveryScope: EngineeringDeliveryScope,
  objective: string,
  userIntentRevision: number,
  policy: EngineeringWorkflowPolicy,
  project: ProjectEngineeringSettings,
): readonly EngineeringGateDefinition[] {
  const gates: EngineeringGateDefinition[] = [];
  const custom = policy.profile === 'custom' ? policy.custom : undefined;
  const strictValidation = policy.profile === 'strict' || custom?.validation === 'strict';
  const alwaysReview = policy.profile === 'strict' || custom?.review === 'always';
  const seniorReview = policy.profile === 'senior';
  const docsImpactCheck = custom?.docsImpactCheck ?? true;
  const add = (
    id: string,
    title: string,
    reason: string,
    applicability: EngineeringGateDefinition['applicability'] = 'required',
    checkCommand?: string,
    requiredPlatforms?: EngineeringGateDefinition['requiredPlatforms'],
  ): void => {
    gates.push({
      id,
      title,
      applicability,
      status: applicability === 'not_applicable' ? 'not_applicable' : 'pending',
      reason,
      basedOnUserIntentRevision: userIntentRevision,
      ...(checkCommand === undefined ? {} : { checkCommand }),
      ...(requiredPlatforms === undefined || requiredPlatforms.length === 0 ? {} : { requiredPlatforms }),
    });
  };

  add('diff', 'Diff/static inspection', 'Every mutation must be checked against the requested scope.');
  const changesBehavior = taskKind === 'feature' || taskKind === 'bugfix' || taskKind === 'refactor' || taskKind === 'incident';
  if (changesBehavior) add('coverage', 'Existing coverage inspection', 'Behavioral work must inspect existing relevant tests before adding a regression.');
  if (changesBehavior && riskTier !== 'low') add('focused_validation', 'Focused behavioral validation', 'Run the lowest meaningful test or diagnostic layer for the changed behavior.');
  if (changesBehavior && project.architecture !== undefined) {
    add('architecture', 'Project architecture check', 'Run the declared project architecture check and record the checked scope and rule coverage.', 'required', project.architecture.checkCommand);
  }
  if (riskTier === 'high' || riskTier === 'critical' || (strictValidation && changesBehavior && riskTier === 'medium')) {
    add('integration', 'Integration or contract validation', strictValidation && riskTier === 'medium'
      ? 'Strict validation requires proof across the affected contract boundary for behavioral work.'
      : 'High-risk work requires proof across the affected contract boundary.');
  }
  if (/(persist|storage|session|token|database|restart|ฐานข้อมูล|โทเคน|เซสชัน)/i.test(objective)) add('restart_persistence', 'Restart/persistence evidence', 'Persistence work must prove behavior across restart or reload.');
  if (/(auth|token|permission|security|credential|oauth|สิทธิ์|โทเคน)/i.test(objective)) add('security_review', 'Security boundary review', 'Security-sensitive changes require explicit boundary review.');
  if (/(cross[- ]platform|windows|macos|linux|native|แพลตฟอร์ม)/i.test(objective) || (changesBehavior && project.requiredPlatforms.length > 0)) {
    const requiredPlatforms = project.requiredPlatforms.length > 0 ? project.requiredPlatforms : inferRequiredPlatforms(objective);
    add('cross_platform', 'Cross-platform evidence', project.requiredPlatforms.length > 0
      ? `Project profile requires target-host or CI evidence for: ${project.requiredPlatforms.join(', ')}.`
      : 'Cross-platform claims require target-host or CI evidence.', 'required', undefined, requiredPlatforms);
  }
  if (changesBehavior && (alwaysReview || (seniorReview && riskTier !== 'low'))) {
    add('self_review', 'Implementation review', 'Review the final diff for compatibility, side effects, missing tests, and documentation impact.');
  }
  if (riskTier === 'high' || riskTier === 'critical' || (alwaysReview && changesBehavior && riskTier === 'medium')) {
    add('independent_review', 'Independent review', 'Risk/profile policy requires an independent review when an authorized reviewer is available.');
  }
  if (docsImpactCheck) add('docs_impact', 'Documentation impact', 'Record whether user/configuration/API/release documentation changed or why no update is required.');
  else add('docs_impact', 'Documentation impact', 'Custom preset disabled the optional documentation-impact check.', 'not_applicable');
  if (deliveryScope === 'release' || deliveryScope === 'deploy' || taskKind === 'release') {
    add('exact_sha_ci', 'Exact-SHA hosted checks', 'Release delivery requires terminal hosted checks for the exact source SHA.');
    add('package', 'Artifact/package verification', 'Release delivery requires package/artifact evidence where the project process requires it.');
  }
  return gates;
}

function inferRequiredPlatforms(objective: string): readonly ('win32' | 'darwin' | 'linux')[] {
  const platforms: ('win32' | 'darwin' | 'linux')[] = [];
  if (/windows/i.test(objective)) platforms.push('win32');
  if (/(macos|mac\s*os)/i.test(objective)) platforms.push('darwin');
  if (/linux/i.test(objective)) platforms.push('linux');
  if (platforms.length > 0) return platforms;
  return ['win32', 'darwin', 'linux'];
}
