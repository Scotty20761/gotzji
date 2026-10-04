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
