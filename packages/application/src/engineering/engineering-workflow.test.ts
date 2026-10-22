import { describe, expect, it } from 'vitest';
import { classifyEngineeringRisk, classifyEngineeringTaskKind, inferDeliveryScope, planEngineeringWorkflow } from './engineering-workflow.js';
import type { EngineeringProjectAssessment } from './engineering-project-assessment.js';

const assessment = (instruction = '', codeGraphIndexed = false): EngineeringProjectAssessment => ({
  project: {
    rootPath: 'C:/repo',
    kind: 'node',
    packageManager: 'pnpm',
    frameworks: ['typescript'],
    scripts: {},
    configFiles: ['tsconfig.json'],
    confidence: 'strong',
    detectedFiles: ['package.json'],
    platforms: ['node'],
    suggestedCommands: {},
  },
  instructions: instruction.length === 0 ? [] : [{ path: 'AGENTS.md', scopePath: '.', status: 'loaded', bytes: instruction.length, content: instruction }],
  projectProfile: {},
  projectProfileStatus: 'missing',
  fingerprint: 'fingerprint',
  codeGraphIndexed,
  warnings: [],
});

describe('engineering workflow routing', () => {
  it('keeps typo-only documentation work low risk without speculative behavioral gates', () => {
    const planned = planEngineeringWorkflow('Fix README typo only', assessment());
    expect(planned.primaryTaskKind).toBe('docs');
    expect(planned.riskTier).toBe('low');
    expect(planned.workflow.map((step) => step.id)).toEqual(['inspect', 'implement', 'validate']);
    expect(planned.gates.map((gate) => gate.id)).toEqual(['diff', 'docs_impact']);
  });

  it('escalates auth persistence work and requires restart, security, integration, and review gates', () => {
    const planned = planEngineeringWorkflow('Fix auth token persistence across restart', assessment());
    expect(planned.primaryTaskKind).toBe('bugfix');
    expect(planned.riskTier).toBe('high');
    expect(planned.gates.map((gate) => gate.id)).toEqual(expect.arrayContaining([
      'coverage', 'focused_validation', 'integration', 'restart_persistence', 'security_review', 'independent_review',
    ]));
  });

  it('does not silently broaden delivery beyond the request', () => {
    expect(inferDeliveryScope('Fix locally and validate')).toBe('local');
    expect(inferDeliveryScope('Fix and open a PR')).toBe('pull_request');
    expect(inferDeliveryScope('Release version 5.7.0')).toBe('release');
    expect(inferDeliveryScope('Fix the bug locally; do not push or release')).toBe('local');
    expect(classifyEngineeringTaskKind('Fix the bug locally; do not push or release')).toBe('bugfix');
  });

  it('keeps comma-separated delivery prohibitions and readiness descriptions local', () => {
    expect(inferDeliveryScope('Do not commit, push, release, or deploy.')).toBe('local');
    expect(inferDeliveryScope('The changes are uncommitted and must remain local.')).toBe('local');
    expect(inferDeliveryScope('Validate production-build readiness locally.')).toBe('local');
    expect(classifyEngineeringTaskKind('Do not commit, push, release, or deploy. Fix the parser only.')).toBe('bugfix');
  });

  it('distinguishes genuine affirmative delivery from English and Thai list prohibitions', () => {
    expect(inferDeliveryScope('Commit the fix, push it, and deploy to production.')).toBe('deploy');
    expect(inferDeliveryScope('ห้าม commit, push, release หรือ deploy ให้แก้และทดสอบในเครื่องเท่านั้น')).toBe('local');
  });

  it('keeps historical and read-only delivery topics local to an audit', () => {
    const objectives = [
      'Full Audit; inspect source code and production read-only; no deploy requested',
      'Full Audit of source and existing production deployments',
      'Review existing production deployments',
      'Production deployment history review',
      'Production deployment review, then do not deploy',
      'Production deployment\nread-only review',
      'Read-only code review of the release from yesterday',
      'Review release',
      'Audit current release',
      'Review deployment scripts / release pipeline',
      'Review code; do not deploy production',
      'ตรวจโค้ด production แบบอ่านอย่างเดียว ห้าม deploy',
      'ตรวจสอบย้อนหลังการรีลีส ยังไม่ต้องปล่อยเวอร์ชัน',
      "Review yesterday's release",
      "Review last week's release",
      'Review old release',
      'Review release v5.8.4',
      'Review v5.8.4 release',
    ];

    for (const objective of objectives) {
      const planned = planEngineeringWorkflow(objective, assessment());
      expect(planned.primaryTaskKind, objective).toBe('review');
      expect(planned.riskTier, objective).toBe('low');
      expect(planned.deliveryScope, objective).toBe('local');
      expect(planned.gates.map((gate) => gate.id), objective).not.toContain('exact_sha_ci');
      expect(planned.gates.map((gate) => gate.id), objective).not.toContain('package');
    }
  });

  it('keeps an audit that requests a code change on the mutation workflow', () => {
    const planned = planEngineeringWorkflow('Audit and fix authentication persistence', assessment());
    expect(planned.primaryTaskKind).toBe('bugfix');
    expect(planned.riskTier).toBe('high');
    expect(planned.gates.map((gate) => gate.id)).toEqual(expect.arrayContaining([
      'coverage', 'focused_validation', 'integration', 'restart_persistence', 'security_review',
    ]));
  });

  it.each(['ตรวจสอบการ deploy production', 'ตรวจสอบ production deployment'])('keeps Thai deployment review topics local: %s', (objective) => {
    const planned = planEngineeringWorkflow(objective, assessment());
    expect(planned.primaryTaskKind).toBe('review');
    expect(planned.riskTier).toBe('low');
    expect(planned.deliveryScope).toBe('local');
  });

  it('preserves affirmative delivery actions after a prohibition or alongside a review', () => {
    const publishAfterBut = 'Review code; do not deploy but publish a release';
    expect(classifyEngineeringTaskKind(publishAfterBut)).toBe('release');
    expect(classifyEngineeringRisk(publishAfterBut).tier).toBe('critical');
    expect(inferDeliveryScope(publishAfterBut)).toBe('release');
    expect(planEngineeringWorkflow(publishAfterBut, assessment()).gates.map((gate) => gate.id)).toEqual(expect.arrayContaining(['exact_sha_ci', 'package']));

    const publishAfterNewline = 'Review code; never deploy\nPublish a release';
    expect(classifyEngineeringTaskKind(publishAfterNewline)).toBe('release');
    expect(classifyEngineeringRisk(publishAfterNewline).tier).toBe('critical');
    expect(inferDeliveryScope(publishAfterNewline)).toBe('release');

    const commitAfterNegation = 'Review code; do not deploy; commit the audit documentation';
    expect(classifyEngineeringTaskKind(commitAfterNegation)).toBe('review');
    expect(inferDeliveryScope(commitAfterNegation)).toBe('commit');

    const explicitProductionDeploy = 'Review and deploy production after approval';
    expect(classifyEngineeringTaskKind(explicitProductionDeploy)).toBe('review');
    expect(classifyEngineeringRisk(explicitProductionDeploy).tier).toBe('critical');
    expect(inferDeliveryScope(explicitProductionDeploy)).toBe('deploy');
    expect(planEngineeringWorkflow(explicitProductionDeploy, assessment()).gates.map((gate) => gate.id)).toEqual(expect.arrayContaining(['exact_sha_ci', 'package']));

    const deployToProduction = 'Deploy to production after approval';
    expect(classifyEngineeringRisk(deployToProduction).tier).toBe('critical');
    expect(inferDeliveryScope(deployToProduction)).toBe('deploy');

    for (const objective of ['Production deployment after approval', 'Production deploy after approval']) {
      expect(classifyEngineeringRisk(objective).tier, objective).toBe('critical');
      expect(inferDeliveryScope(objective), objective).toBe('deploy');
    }

    const historicalThenPublish = "Review last week's release, then publish a new release";
    expect(classifyEngineeringTaskKind(historicalThenPublish)).toBe('release');
    expect(classifyEngineeringRisk(historicalThenPublish).tier).toBe('critical');
    expect(inferDeliveryScope(historicalThenPublish)).toBe('release');

    const explicitVersionPublish = 'Review release v5.8.4, then publish release v5.8.5';
    expect(classifyEngineeringTaskKind(explicitVersionPublish)).toBe('release');
    expect(classifyEngineeringRisk(explicitVersionPublish).tier).toBe('critical');
    expect(inferDeliveryScope(explicitVersionPublish)).toBe('release');

    const reviewAndPublishVersion = 'Review and publish release v5.8.5';
    expect(classifyEngineeringTaskKind(reviewAndPublishVersion)).toBe('release');
    expect(classifyEngineeringRisk(reviewAndPublishVersion).tier).toBe('critical');
    expect(inferDeliveryScope(reviewAndPublishVersion)).toBe('release');
    expect(planEngineeringWorkflow(reviewAndPublishVersion, assessment()).gates.map((gate) => gate.id)).toEqual(expect.arrayContaining(['exact_sha_ci', 'package']));
  });

  it.each([
    'Production deployment; do not deploy',
    'Production deployment; no deploy',
    'Deploy to production; do not deploy',
    'Production deployment; after tests pass; do not deploy',
    'Deploy production; do not deploy staging and production',
    'Deploy production; do not deploy production and staging after tests pass',
    'Deploy production; do not deploy production and test and staging',
  ])('does not infer an affirmative production deploy from a later prohibition: %s', (objective) => {
    const planned = planEngineeringWorkflow(objective, assessment());

    expect(planned.primaryTaskKind).toBe('unknown');
    expect(planned.riskTier).toBe('medium');
    expect(planned.deliveryScope).toBe('local');
  });

  it.each([
    'Production deployment after tests pass; then document the release notes',
    'Production deployment; do not deploy to staging',
    'Deploy to production; do not deploy to staging',
    'Deploy production; do not deploy staging after tests pass',
    'Production deployment; do not deploy; then deploy production after approval',
    'Deploy production; do not deploy; then production deployment after approval',
  ])('preserves a production deployment across unrelated later clauses: %s', (objective) => {
    const planned = planEngineeringWorkflow(objective, assessment());

    expect(planned.riskTier).toBe('critical');
    expect(planned.deliveryScope).toBe('deploy');
  });

  it('preserves a staging deployment when production is explicitly prohibited', () => {
    const planned = planEngineeringWorkflow('Deploy staging; do not deploy production', assessment());

    expect(planned.primaryTaskKind).toBe('unknown');
    expect(planned.deliveryScope).toBe('deploy');
    expect(planned.gates.map((gate) => gate.id)).toEqual(expect.arrayContaining(['exact_sha_ci', 'package']));
  });

  it.each([
    'Deploy staging; do not deploy preview',
    'Deploy preview; do not deploy test after the meeting',
    'Deploy preview; do not deploy stage this change',
    'Deploy staging; do not deploy production and stage this change for approval',
    'Deploy preview; do not deploy production and test the API',
    'Deploy preview; do not deploy production and test after the meeting',
  ])('does not treat coordinated action verbs as deployment targets: %s', (objective) => {
    const planned = planEngineeringWorkflow(objective, assessment());

    expect(planned.deliveryScope).toBe('deploy');
    expect(planned.gates.map((gate) => gate.id)).toEqual(expect.arrayContaining(['exact_sha_ci', 'package']));
  });

  it.each([
    'Deploy staging; do not deploy',
    'Deploy staging; do not deploy at all',
    'Deploy staging; do not deploy to staging',
    'Deploy staging; do not deploy production and staging',
  ])('does not preserve a staging deployment after a broad or matching prohibition: %s', (objective) => {
    const planned = planEngineeringWorkflow(objective, assessment());

    expect(planned.deliveryScope).toBe('local');
    expect(planned.gates.map((gate) => gate.id)).not.toContain('exact_sha_ci');
    expect(planned.gates.map((gate) => gate.id)).not.toContain('package');
  });

  it('records CodeGraph-first project instructions without claiming availability', () => {
    const planned = planEngineeringWorkflow('Refactor the auth service', assessment('When .codegraph exists, use CodeGraph first.', true));
    expect(planned.selectedCodeIntelligence).toBe('codegraph');
    expect(planEngineeringWorkflow('Refactor the auth service', assessment('When .codegraph exists, use CodeGraph first.')).selectedCodeIntelligence).toBe('lsp_search');
  });

  it('includes explicit project architecture and required-platform checks in the gate plan', () => {
    const prepared = assessment();
    const planned = planEngineeringWorkflow('Refactor the auth service', {
      ...prepared,
      projectProfile: { engineering: { architecture: { checkCommand: 'pnpm lint:arch' }, requiredPlatforms: ['win32', 'linux'] } },
    });
    expect(planned.gates.find((gate) => gate.id === 'architecture')).toMatchObject({ applicability: 'required', status: 'pending', checkCommand: 'pnpm lint:arch' });
    expect(planned.gates.find((gate) => gate.id === 'cross_platform')).toMatchObject({
      applicability: 'required', status: 'pending', requiredPlatforms: ['win32', 'linux'],
    });
    expect(planned.gates.find((gate) => gate.id === 'architecture')?.checkCommand).toBe('pnpm lint:arch');
    expect(planned.gates.find((gate) => gate.id === 'cross_platform')?.reason).toContain('win32');
  });

  it('applies Standard, Senior, Strict, and Custom policy differences to analysis and gates', () => {
    const objective = 'Implement a local settings workflow';
    const standard = planEngineeringWorkflow(objective, assessment(), 0, { profile: 'standard' });
    const senior = planEngineeringWorkflow(objective, assessment(), 0, { profile: 'senior' });
    const strict = planEngineeringWorkflow(objective, assessment(), 0, { profile: 'strict' });
    const custom = planEngineeringWorkflow(objective, assessment(), 0, {
      profile: 'custom',
      custom: { analysis: 'focused', review: 'always', validation: 'strict', docsImpactCheck: false },
    });

    expect(standard.analysisMode).toBe('focused');
    expect(standard.gates.map((gate) => gate.id)).not.toContain('self_review');
    expect(senior.analysisMode).toBe('cross_file');
    expect(senior.gates.map((gate) => gate.id)).toContain('self_review');
    expect(strict.gates.map((gate) => gate.id)).toEqual(expect.arrayContaining(['integration', 'self_review', 'independent_review']));
    expect(custom.analysisMode).toBe('focused');
    expect(custom.gates.map((gate) => gate.id)).toEqual(expect.arrayContaining(['integration', 'self_review', 'independent_review', 'docs_impact']));
    expect(custom.gates.find((gate) => gate.id === 'docs_impact')).toMatchObject({ applicability: 'not_applicable', status: 'not_applicable' });
  });

  it('keeps CSS-only spacing work on the lightweight maintenance path', () => {
    const planned = planEngineeringWorkflow('CSS-only spacing adjustment', assessment());
    expect(planned.primaryTaskKind).toBe('maintenance');
    expect(planned.riskTier).toBe('low');
    expect(planned.workflow.map((step) => step.id)).toEqual(['inspect', 'implement', 'validate']);
  });

  it('classifies review and release separately from mutation-oriented feature work', () => {
    expect(classifyEngineeringTaskKind('Review this diff only')).toBe('review');
    expect(classifyEngineeringTaskKind('Release and publish v5.7.0')).toBe('release');
    expect(classifyEngineeringRisk('Release and publish v5.7.0').tier).toBe('critical');
  });
});
