import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import { engineeringTools } from './engineering-tools.js';

const actor = { clientId: 'test-client', clientName: 'Engineering test' };

describe('engineering_prepare_task', () => {
  it('is read-only and delegates only to the preparation service', async () => {
    const prepare = vi.fn(async () => ok({
      objective: 'Fix auth bug',
      assessment: { project: { kind: 'node' } },
      policy: { enabled: true, policyDigest: 'digest' },
      workflow: { primaryTaskKind: 'bugfix', riskTier: 'medium', deliveryScope: 'local' },
    } as never));
    const [tool] = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { engineeringPreparation: { prepare } as never },
    });

    expect(tool).toMatchObject({
      name: 'engineering_prepare_task',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      execution: { taskSupport: 'forbidden' },
    });
    expect(tool.parse({ workspaceId: 'workspace-1', objective: 'Fix auth bug', scopedPath: 'src/auth.ts' })).toMatchObject({ ok: true });
    expect(await tool.execute({ workspaceId: 'workspace-1', objective: 'Fix auth bug', scopedPath: 'src/auth.ts' }, new AbortController().signal)).toMatchObject({
      ok: true,
      value: {
        engineeringTask: {
          objective: 'Fix auth bug',
          policyDigest: 'digest',
          primaryTaskKind: 'bugfix',
          riskTier: 'medium',
          deliveryScope: 'local',
        },
      },
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith('workspace-1', 'Fix auth bug', 'src/auth.ts');
  });

  it('rejects malformed input before the preparation service can run', () => {
    const [tool] = engineeringTools({ actor, contextEconomy: {} as never, services: {} });
    expect(tool.parse({ workspaceId: 'workspace-1', objective: '' })).toMatchObject({ ok: false });
    expect(tool.parse({ workspaceId: 'workspace-1', objective: 'Fix bug', unknown: true })).toMatchObject({ ok: false });
  });

  it('returns bounded schema diagnostics without echoing rejected input', () => {
    const [tool] = engineeringTools({ actor, contextEconomy: {} as never, services: {} });
    const rejected = tool.parse({ workspaceId: 'workspace-1', objective: 123, secret: 'credential-value' });
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Tool input is invalid',
        details: { fieldPath: 'objective', reason: 'invalid_type' },
      },
    });
    expect(JSON.stringify(rejected)).not.toContain('credential-value');
  });
});

describe('engineering_start_task', () => {
  const prepared = (): ReturnType<typeof ok> => ok({
    objective: 'Fix auth bug',
    assessment: { project: { kind: 'node' } },
    policy: { enabled: true, policyDigest: 'digest-1', reasons: ['enabled'] },
    workflow: {
      primaryTaskKind: 'bugfix',
      riskTier: 'high',
      riskReasons: ['auth persistence'],
      workflow: [
        { id: 'reproduce', title: 'Reproduce the failure' },
        { id: 'validate', title: 'Validate the repair' },
      ],
      gates: [{
        id: 'focused_validation',
        title: 'Focused validation',
        applicability: 'required',
        status: 'pending',
        reason: 'Behavior changed',
        basedOnUserIntentRevision: 0,
      }],
      selectedCodeIntelligence: 'lsp_search',
      codeIntelligenceReason: 'Use LSP',
      deliveryScope: 'local',
    },
  } as never);

  it('creates a durable engineering goal with workflow metadata without touching scheduled continuation services', async () => {
    const runGoal = vi.fn(async () => ok({ goalId: 'goal-1', status: 'active', acquired: true }));
    const getGoal = vi.fn(async () => err(appError('INVALID_INPUT', 'Goal was not found')));
    const prepare = vi.fn(async () => prepared());
    const scheduled = { prepareScheduledContinuation: vi.fn() };
    const tools = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: {
        goals: { runGoal, getGoal } as never,
        engineeringPreparation: { prepare } as never,
        scheduledContinuations: scheduled as never,
      },
    });
    const tool = tools.find((entry) => entry.name === 'engineering_start_task');

    expect(tool).toMatchObject({
      name: 'engineering_start_task',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
    });
    const input = { workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' };
    expect(tool?.parse(input)).toMatchObject({ ok: true });
    expect(await tool?.execute(input, new AbortController().signal)).toMatchObject({ ok: true });
    expect(runGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      ...input,
      plan: { steps: [
        { id: 'reproduce', title: 'Reproduce the failure' },
        { id: 'validate', title: 'Validate the repair' },
      ] },
      engineering: expect.objectContaining({ schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'high', policyDigest: 'digest-1' }),
    }));
    expect(scheduled.prepareScheduledContinuation).not.toHaveBeenCalled();
  });

  it('resumes an existing engineering goal without replacing its evolved plan or metadata', async () => {
    const runGoal = vi.fn(async () => ok({ goalId: 'goal-1', status: 'active', acquired: true }));
    const getGoal = vi.fn(async () => ok({
      goalId: 'goal-1',
      engineering: { schemaVersion: 1, policyDigest: 'digest-1', scopedPath: 'src/auth/session.ts' },
      plan: { steps: [{ id: 'reproduce', title: 'Reproduce', status: 'completed' }] },
    } as never));
    const prepare = vi.fn(async () => prepared());
    const tools = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal } as never, engineeringPreparation: { prepare } as never },
    });
    const tool = tools.find((entry) => entry.name === 'engineering_start_task');
    const input = { workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' };

    expect(await tool?.execute(input, new AbortController().signal)).toMatchObject({ ok: true });
    expect(prepare).toHaveBeenCalledWith('workspace-1', 'Fix auth bug', 'src/auth/session.ts');
    expect(runGoal).toHaveBeenCalledWith(actor, input);
  });

  it('keeps an active durable task resumable when the repository later opts new Engineering preparation out', async () => {
    const existingEngineering = { schemaVersion: 1, policyDigest: 'digest-active', scopedPath: 'src/auth/session.ts', gates: [] };
    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: existingEngineering } as never));
    const runGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', revision: 4, userIntentRevision: 1,
      currentPhase: 'validate', nextAction: 'Continue validation', blockers: [], trackedTasks: [], engineering: existingEngineering,
    } as never));
    const checkpointGoal = vi.fn();
    const prepare = vi.fn(async () => ok({
      objective: 'Fix auth bug', assessment: {}, workflow: { primaryTaskKind: 'bugfix', riskTier: 'high', deliveryScope: 'local', workflow: [], gates: [] },
      policy: { enabled: false, source: 'project', policyDigest: 'digest-project-off', reasons: ['Project profile engineering.mode=off disables new task preparation.'] },
    } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare } as never },
    }).find((entry) => entry.name === 'engineering_start_task');

    await expect(tool?.execute({ workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { engineeringTask: { policyDigest: 'digest-active', scopedPath: 'src/auth/session.ts' } },
    });
    expect(prepare).toHaveBeenCalledWith('workspace-1', 'Fix auth bug', 'src/auth/session.ts');
    expect(checkpointGoal).not.toHaveBeenCalled();
  });

  it('fails closed when Harness is inactive and reconciles a changed policy on the same durable goal', async () => {
    const runGoal = vi.fn();
    const inactivePrepare = vi.fn(async () => ok({
      objective: 'Fix auth bug',
      assessment: {},
      workflow: {},
      policy: { enabled: false, policyDigest: 'off', reasons: ['Workspace disabled Harness.'] },
    } as never));
    const inactive = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal: vi.fn(async () => err(appError('INVALID_INPUT', 'Goal was not found'))) } as never, engineeringPreparation: { prepare: inactivePrepare } as never },
    }).find((entry) => entry.name === 'engineering_start_task');
    const input = { workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' };
    expect(await inactive?.execute(input, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(runGoal).not.toHaveBeenCalled();

    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: { schemaVersion: 1, policyDigest: 'old-digest', gates: [], reviewFindings: [] } } as never));
    const changedRunGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', leaseGeneration: 3,
      revision: 5, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Run validation', blockers: [], trackedTasks: [],
      engineering: { schemaVersion: 1, policyDigest: 'old-digest', gates: [], reviewFindings: [] },
    } as never));
    const checkpointGoal = vi.fn(async (_actor, request: { engineering?: unknown }) => ok({
      goalId: 'goal-1', status: 'active', revision: 6, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Run validation', blockers: [], trackedTasks: [],
      engineering: request.engineering,
    } as never));
    const changed = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal: changedRunGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare: vi.fn(async () => prepared()) } as never },
    }).find((entry) => entry.name === 'engineering_start_task');
    expect(await changed?.execute(input, new AbortController().signal)).toMatchObject({
      ok: true,
      value: { acquired: true, leaseToken: 'lease-1', revision: 6, engineeringTask: { policyDigest: 'digest-1', goalRevision: 6, userIntentRevision: 2 } },
    });
    expect(checkpointGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      goalId: 'goal-1', expectedRevision: 5,
      engineering: expect.objectContaining({ policyDigest: 'digest-1' }),
    }));
  });

  it('preserves completed gate evidence when only the policy digest changes but the gate contract is unchanged', async () => {
    const evidence = {
      source: 'host_observed' as const,
      observedAt: '2026-09-29T00:00:00Z',
      workspaceId: 'workspace-1',
      command: 'pnpm test',
      runId: 'task-1',
      exitCode: 0,
    };
    const existingEngineering = {
      schemaVersion: 1 as const,
      primaryTaskKind: 'bugfix' as const,
      riskTier: 'high' as const,
      policyDigest: 'old-digest',
      deliveryScope: 'local' as const,
      gates: [{
        id: 'focused_validation',
        title: 'Focused validation',
        applicability: 'required' as const,
        status: 'passed' as const,
        reason: 'Behavior changed',
        basedOnUserIntentRevision: 2,
        evidence,
      }],
    };
    const getGoal = vi.fn(async () => ok({ goalId: 'goal-1', engineering: existingEngineering } as never));
    const runGoal = vi.fn(async () => ok({
      goalId: 'goal-1', status: 'active', acquired: true, leaseToken: 'lease-1', leaseGeneration: 3,
      revision: 5, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Finish', blockers: [], trackedTasks: [],
      engineering: existingEngineering,
    } as never));
    const checkpointGoal = vi.fn(async (_actor, request: { engineering?: unknown }) => ok({
      goalId: 'goal-1', status: 'active', revision: 6, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Finish', blockers: [], trackedTasks: [],
      engineering: request.engineering,
    } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { runGoal, getGoal, checkpointGoal } as never, engineeringPreparation: { prepare: vi.fn(async () => prepared()) } as never },
    }).find((entry) => entry.name === 'engineering_start_task');

    await expect(tool?.execute({ workspaceId: 'workspace-1', goalKey: 'engineering.auth-fix', objective: 'Fix auth bug' }, new AbortController().signal)).resolves.toMatchObject({ ok: true });
    expect(checkpointGoal).toHaveBeenCalledWith(actor, expect.objectContaining({
      engineering: expect.objectContaining({
        policyDigest: 'digest-1',
        gates: [expect.objectContaining({
          id: 'focused_validation',
          status: 'passed',
          reason: 'Behavior changed',
          evidence,
        })],
      }),
    }));
  });
});

describe('engineering_get_status', () => {
  it('returns the current gate projection and truthful local boundary without mutating the goal', async () => {
    const getGoal = vi.fn(async () => ok({
      goalId: 'goal-1', workspaceId: 'workspace-1', objective: 'Fix auth bug', status: 'active', revision: 7, userIntentRevision: 2, currentPhase: 'validate', nextAction: 'Run focused test', blockers: [],
      acceptanceCriteria: [{ id: 'bug-fixed', title: 'Bug fixed', status: 'completed' }], plan: { steps: [{ id: 'fix', title: 'Fix', status: 'completed' }] }, trackedTasks: [],
      engineering: {
        schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'high', policyDigest: 'digest-1', deliveryScope: 'local', scopedPath: 'src/auth/session.ts',
        gates: [
          { id: 'focused_validation', title: 'Focused validation', applicability: 'required', status: 'passed', reason: 'Passed', basedOnUserIntentRevision: 0, evidence: { source: 'host_observed', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1', command: 'pnpm test', exitCode: 0 } },
          { id: 'docs_impact', title: 'Docs impact', applicability: 'required', status: 'not_applicable', reason: 'No docs impact', basedOnUserIntentRevision: 0 },
        ],
      },
    } as never));
    const prepare = vi.fn(async () => ok({ policy: { enabled: true, policyDigest: 'digest-1' } } as never));
    const tool = engineeringTools({
      actor,
      contextEconomy: {} as never,
      services: { goals: { getGoal } as never, engineeringPreparation: { prepare } as never },
    }).find((entry) => entry.name === 'engineering_get_status');

    expect(tool).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true } });
    expect(await tool?.execute({ goalId: 'goal-1' }, new AbortController().signal)).toMatchObject({
      ok: true,
      value: {
        deliveryBoundary: 'ready_locally', unresolvedGateIds: [], policyChanged: false, primaryTaskKind: 'bugfix', riskTier: 'high',
        engineeringTask: { goalId: 'goal-1', policyDigest: 'digest-1', goalRevision: 7, userIntentRevision: 2, scopedPath: 'src/auth/session.ts' },
      },
    });
    expect(getGoal).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith('workspace-1', 'Fix auth bug', 'src/auth/session.ts');
  });

  it('keeps policy drift and incomplete acceptance visibly pending', async () => {
    const getGoal = vi.fn(async () => ok({
      goalId: 'goal-1', workspaceId: 'workspace-1', objective: 'Fix auth bug', status: 'active', revision: 7, userIntentRevision: 2,
      currentPhase: 'validate', nextAction: 'Revalidate', blockers: [], trackedTasks: [],
      acceptanceCriteria: [{ id: 'bug-fixed', title: 'Bug fixed', status: 'pending' }], plan: { steps: [] },
      engineering: { schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'high', policyDigest: 'old-digest', deliveryScope: 'local',
        gates: [{ id: 'diff', title: 'Diff', applicability: 'required', status: 'passed', reason: 'Done', basedOnUserIntentRevision: 2,
          evidence: { source: 'host_observed', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1' } }] },
    } as never));
    const prepare = vi.fn(async () => ok({ policy: { enabled: true, policyDigest: 'new-digest' } } as never));
    const tool = engineeringTools({ actor, contextEconomy: {} as never, services: { goals: { getGoal } as never, engineeringPreparation: { prepare } as never } })
      .find((entry) => entry.name === 'engineering_get_status');
    expect(await tool?.execute({ goalId: 'goal-1' }, new AbortController().signal)).toMatchObject({
      ok: true, value: { policyChanged: true, deliveryBoundary: 'checks_pending', acceptanceCriteria: [{ id: 'bug-fixed', status: 'pending' }] },
    });
  });

  it('does not claim local readiness from a passed gate backed only by user attestation', async () => {
    const getGoal = vi.fn(async () => ok({
      goalId: 'goal-1', workspaceId: 'workspace-1', objective: 'Fix auth bug', status: 'active', revision: 3, userIntentRevision: 0,
      currentPhase: 'validate', nextAction: 'Verify diff', blockers: [], trackedTasks: [],
      acceptanceCriteria: [{ id: 'done', title: 'Done', status: 'completed' }], plan: { steps: [{ id: 'fix', title: 'Fix', status: 'completed' }] },
      engineering: { schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'medium', policyDigest: 'digest-1', deliveryScope: 'local',
        gates: [{ id: 'diff', title: 'Diff', applicability: 'required', status: 'passed', reason: 'Checked', basedOnUserIntentRevision: 0,
          evidence: { source: 'user_attested', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1' } }] },
    } as never));
    const tool = engineeringTools({ actor, contextEconomy: {} as never, services: { goals: { getGoal } as never,
      engineeringPreparation: { prepare: vi.fn(async () => ok({ policy: { enabled: true, policyDigest: 'digest-1' } } as never)) } as never } })
      .find((entry) => entry.name === 'engineering_get_status');
    expect(await tool?.execute({ goalId: 'goal-1' }, new AbortController().signal)).toMatchObject({
      ok: true, value: { unresolvedGateIds: ['diff'], deliveryBoundary: 'checks_pending' },
    });
  });
});
