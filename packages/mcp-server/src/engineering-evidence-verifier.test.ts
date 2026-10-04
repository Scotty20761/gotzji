import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import { engineeringCommandFingerprint } from '@lnwjud/shared';
import { RuntimeEngineeringEvidenceVerifier, createEngineeringArtifactVerifier, createEngineeringSourceStateProvider, type EngineeringSourceState } from './engineering-evidence-verifier.js';

describe('RuntimeEngineeringEvidenceVerifier', () => {
  it('reads the current tracked source SHA and cleanliness through bounded read-only Git commands', async () => {
    const commit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const runGit = vi.fn(async (_workspaceId: string, args: readonly string[]) => args[0] === 'rev-parse'
      ? ok({ exitCode: 0, stdout: `${commit}\n` })
      : ok({ exitCode: 0, stdout: ' M tracked.ts\n' }));
    const sourceState = createEngineeringSourceStateProvider(runGit);

    await expect(sourceState('workspace-1')).resolves.toEqual({ commit, clean: false });
    expect(runGit).toHaveBeenCalledWith('workspace-1', ['rev-parse', 'HEAD']);
    expect(runGit).toHaveBeenCalledWith('workspace-1', ['status', '--porcelain=v1', '--untracked-files=no']);
  });

  it('verifies only fresh non-empty package artifacts contained by the workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lnwjud-engineering-artifact-'));
    const artifact = join(root, 'dist', 'installer.exe');
    try {
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(artifact, 'package-bytes');
      const now = Date.now();
      await utimes(artifact, new Date(now), new Date(now));
      const verifier = createEngineeringArtifactVerifier(async () => root);
      const observation = {
        startedAt: new Date(now - 5_000).toISOString(),
        finishedAt: new Date(now + 5_000).toISOString(),
      };

      await expect(verifier('workspace-1', 'dist/installer.exe', observation)).resolves.toBe(true);
      await expect(verifier('workspace-1', '../outside.exe', observation)).resolves.toBe(false);
      await utimes(artifact, new Date(now - 60_000), new Date(now - 60_000));
      await expect(verifier('workspace-1', 'dist/installer.exe', observation)).resolves.toBe(false);
      await writeFile(join(root, 'dist', 'empty.exe'), '');
      await expect(verifier('workspace-1', 'dist/empty.exe', observation)).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts only an actual successful host task in the same workspace', async () => {
    const process = { statusForGoalLiveness: vi.fn(async () => err(appError('PROCESS_NOT_FOUND', 'missing'))) };
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => taskId === 'task-ok'
      ? ok({ state: 'completed', exit_code: 0, executable: 'pnpm', arguments: ['test'] })
      : err(appError('PROCESS_NOT_FOUND', 'missing'))) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({ process, shell });

    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1',
      command: 'pnpm test', runId: 'task-ok', exitCode: 0,
    }, 'focused_validation')).resolves.toBe(true);
    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1',
      command: 'pnpm test', runId: 'fabricated', exitCode: 0,
    }, 'focused_validation')).resolves.toBe(false);
    expect(shell.statusForGoalLiveness).toHaveBeenCalledWith('workspace-1', 'task-ok');
  });

  it('rejects failed, nonterminal, mismatched-exit, or missing run IDs', async () => {
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => ok(
      taskId === 'failed' ? { state: 'failed', exit_code: 1 }
        : taskId === 'running' ? { state: 'running' }
          : { state: 'completed', exit_code: 0 },
    )) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({ shell });
    const base = { source: 'host_observed' as const, observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1', command: 'pnpm test' };

    await expect(verifier.verify('workspace-1', { ...base, runId: 'failed', exitCode: 1 }, 'focused_validation')).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', { ...base, runId: 'running' }, 'focused_validation')).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', { ...base, runId: 'ok', exitCode: 1 }, 'focused_validation')).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', base, 'focused_validation')).resolves.toBe(false);
  });

  it('returns allowlisted diagnostic reasons without exposing host output', async () => {
    const secretOutput = 'token=host-secret C:\\private\\workspace';
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => (
      taskId === 'missing'
        ? err(appError('PROCESS_NOT_FOUND', secretOutput))
        : ok(taskId === 'running'
          ? { state: 'running', stdout: secretOutput }
          : taskId === 'failed'
            ? { state: 'completed', exit_code: 7, stdout: secretOutput }
            : { state: 'completed', exit_code: 0, executable: 'echo', arguments: ['wrong'], stdout: secretOutput })
    )) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({ shell });
    const base = { source: 'host_observed' as const, observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1', command: 'pnpm test' };

    await expect(verifier.verifyDetailed('workspace-1', base, 'focused_validation'))
      .resolves.toEqual({ verified: false, reason: 'missing_run_id' });
    await expect(verifier.verifyDetailed('workspace-1', { ...base, runId: 'missing' }, 'focused_validation'))
      .resolves.toEqual({ verified: false, reason: 'run_not_found' });
    await expect(verifier.verifyDetailed('workspace-1', { ...base, runId: 'running' }, 'focused_validation'))
      .resolves.toEqual({ verified: false, reason: 'run_not_terminal' });
    await expect(verifier.verifyDetailed('workspace-1', { ...base, runId: 'failed', exitCode: 7 }, 'focused_validation'))
      .resolves.toEqual({ verified: false, reason: 'run_nonzero_exit' });
    const mismatch = await verifier.verifyDetailed('workspace-1', { ...base, runId: 'wrong', exitCode: 0 }, 'focused_validation');
    expect(mismatch).toEqual({ verified: false, reason: 'command_fingerprint_mismatch' });
    expect(JSON.stringify(mismatch)).not.toContain(secretOutput);
  });

  it('optionally binds a successful run receipt to the canonical goal owner and intent revision', async () => {
    const command = 'pnpm test';
    const shell = { statusForGoalLiveness: vi.fn(async () => ok({
      state: 'completed', exit_code: 0, command_fingerprint: engineeringCommandFingerprint(command),
      goal_id: 'goal-1', owner_client_id: 'client-1', user_intent_revision: 4,
    })) };
    const strict = new RuntimeEngineeringEvidenceVerifier({ shell, requireGoalBinding: true });
    const legacy = new RuntimeEngineeringEvidenceVerifier({ shell });
    const evidence = {
      source: 'host_observed' as const, observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1',
      command, runId: 'run-1', exitCode: 0,
    };
    const expected = { goalId: 'goal-1', ownerClientId: 'client-1', userIntentRevision: 4 };

    await expect(strict.verifyDetailed('workspace-1', evidence, 'focused_validation', [], expected))
      .resolves.toEqual({ verified: true });
    for (const mismatched of [
      { ...expected, goalId: 'goal-2' },
      { ...expected, ownerClientId: 'client-2' },
      { ...expected, userIntentRevision: 5 },
    ]) {
      await expect(strict.verifyDetailed('workspace-1', evidence, 'focused_validation', [], mismatched))
        .resolves.toEqual({ verified: false, reason: 'job_binding_mismatch' });
      await expect(strict.verify('workspace-1', evidence, 'focused_validation', [], mismatched)).resolves.toBe(false);
    }
    await expect(strict.verifyDetailed('workspace-1', evidence, 'focused_validation'))
      .resolves.toEqual({ verified: false, reason: 'job_binding_mismatch' });
    await expect(legacy.verify('workspace-1', evidence, 'focused_validation')).resolves.toBe(true);
  });

  it('rejects an unrelated successful command and an observation without command identity', async () => {
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => ok(
      taskId === 'unidentified'
        ? { state: 'completed', exit_code: 0 }
        : { state: 'completed', exit_code: 0, executable: 'echo', arguments: ['hello'] },
    )) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({ shell });
    const evidence = { source: 'host_observed' as const, observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1', command: 'pnpm test', exitCode: 0 };

    await expect(verifier.verify('workspace-1', { ...evidence, runId: 'unrelated' }, 'focused_validation')).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', { ...evidence, runId: 'unidentified' }, 'focused_validation')).resolves.toBe(false);
  });

  it('does not treat an arbitrary successful local command as hosted CI, target-platform, or package proof', async () => {
    const shell = { statusForGoalLiveness: vi.fn(async () => ok({ state: 'completed', exit_code: 0, executable: 'pnpm', arguments: ['test'] })) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({ shell });
    const evidence = { source: 'host_observed' as const, observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1', command: 'pnpm test', runId: 'task-ok', exitCode: 0 };
    for (const gateId of ['exact_sha_ci', 'cross_platform', 'package']) {
      await expect(verifier.verify('workspace-1', evidence, gateId)).resolves.toBe(false);
    }
  });

  it('accepts exact-SHA CI and package proof only from the canonical self-verifying commands', async () => {
    const commit = 'cbb9ac40cc6d1acfd0f66a0a2d62c25a8f3a1264';
    const ciCommand = 'gh run view 36568935961 --json "headSha,status,conclusion"';
    const nonCanonicalCiCommand = `${ciCommand} --repo example`;
    const packageCommand = 'node apps/desktop/scripts/verify-release-evidence.mjs';
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => taskId === 'ci-proof'
      ? ok({
          state: 'completed', exit_code: 0, command_fingerprint: engineeringCommandFingerprint(ciCommand),
          stdout: JSON.stringify({ headSha: commit, status: 'completed', conclusion: 'success' }),
        })
      : taskId === 'noncanonical-ci-proof'
        ? ok({
            state: 'completed', exit_code: 0, command_fingerprint: engineeringCommandFingerprint(nonCanonicalCiCommand),
            stdout: JSON.stringify({ headSha: commit, status: 'completed', conclusion: 'success' }),
          })
        : ok({
          state: 'completed', exit_code: 0, command_fingerprint: engineeringCommandFingerprint(packageCommand),
          stdout: `Release evidence verified for lnwjud 5.7.2 win32/x64 commit ${commit}\n`,
        })) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({
      shell,
      sourceState: async (): Promise<EngineeringSourceState> => ({ commit, clean: true }),
    });

    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-29T00:00:00Z', workspaceId: 'workspace-1',
      command: ciCommand, runId: 'ci-proof', exitCode: 0, commit, conclusion: 'success',
    }, 'exact_sha_ci')).resolves.toBe(true);
    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-29T00:00:00Z', workspaceId: 'workspace-1',
      command: packageCommand, runId: 'package-proof', exitCode: 0, commit,
      artifact: 'apps/desktop/dist/installers/lnwjud-Setup-5.7.2.exe',
    }, 'package')).resolves.toBe(true);
    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-29T00:00:00Z', workspaceId: 'workspace-1',
      command: 'gh run view 36568935961 --json "headSha,status,conclusion"', runId: 'ci-proof', exitCode: 0,
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', conclusion: 'success',
    }, 'exact_sha_ci')).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-29T00:00:00Z', workspaceId: 'workspace-1',
      command: packageCommand, runId: 'package-proof', exitCode: 0, commit,
    }, 'package')).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-29T00:00:00Z', workspaceId: 'workspace-1',
      command: nonCanonicalCiCommand, runId: 'noncanonical-ci-proof', exitCode: 0, commit, conclusion: 'success',
    }, 'exact_sha_ci')).resolves.toBe(false);
    await expect(verifier.verifyDetailed('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-29T00:00:00Z', workspaceId: 'workspace-1',
      command: packageCommand, runId: 'package-proof', exitCode: 0, commit,
    }, 'package')).resolves.toEqual({ verified: false, reason: 'artifact_mismatch' });
    await expect(verifier.verifyDetailed('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-29T00:00:00Z', workspaceId: 'workspace-1',
      command: nonCanonicalCiCommand, runId: 'noncanonical-ci-proof', exitCode: 0, commit, conclusion: 'success',
    }, 'exact_sha_ci')).resolves.toEqual({ verified: false, reason: 'ci_mismatch' });
  });

  it('accepts a fresh generic package artifact from the exact durable shell receipt and rejects stale or missing artifacts', async () => {
    const commit = 'cbb9ac40cc6d1acfd0f66a0a2d62c25a8f3a1264';
    const command = 'corepack pnpm@10.15.0 desktop:pack:windows';
    const artifact = 'dist/installers/lnwjud-Watcher-Setup-0.2.8.exe';
    const shell = { statusForGoalLiveness: vi.fn(async () => ok({
      state: 'completed', exit_code: 0, command_fingerprint: engineeringCommandFingerprint(command),
      started_at: '2026-09-30T00:00:00.000Z', finished_at: '2026-09-30T00:02:00.000Z',
    })) };
    const artifactVerifier = vi.fn(async (_workspaceId: string, candidate: string) => candidate === artifact);
    const verifier = new RuntimeEngineeringEvidenceVerifier({
      shell,
      sourceState: async (): Promise<EngineeringSourceState> => ({ commit, clean: true }),
      artifactVerifier,
    });
    const evidence = {
      source: 'host_observed' as const, observedAt: '2026-09-30T00:02:01.000Z', workspaceId: 'workspace-1',
      command, runId: 'watcher-package', exitCode: 0, commit, artifact,
    };

    await expect(verifier.verify('workspace-1', evidence, 'package')).resolves.toBe(true);
    expect(artifactVerifier).toHaveBeenCalledWith('workspace-1', artifact, {
      startedAt: '2026-09-30T00:00:00.000Z', finishedAt: '2026-09-30T00:02:00.000Z',
    });
    await expect(verifier.verify('workspace-1', { ...evidence, artifact: 'dist/readme.txt' }, 'package')).resolves.toBe(false);
    artifactVerifier.mockResolvedValueOnce(false);
    await expect(verifier.verify('workspace-1', evidence, 'package')).resolves.toBe(false);
  });

  it('accepts complete exact-SHA hosted platform matrix proof and rejects partial platform evidence', async () => {
    const commit = 'cbb9ac40cc6d1acfd0f66a0a2d62c25a8f3a1264';
    const command = 'gh run view 36568935961 --json "headSha,status,conclusion,jobs"';
    const completeOutput = JSON.stringify({
      headSha: commit,
      status: 'completed',
      conclusion: 'success',
      jobs: [
        { name: 'Native Platform Contract (Windows)', status: 'completed', conclusion: 'success' },
        { name: 'Native Platform Contract (macOS)', status: 'completed', conclusion: 'success' },
        { name: 'Native Platform Contract (Linux)', status: 'completed', conclusion: 'success' },
      ],
    });
    const partialOutput = JSON.stringify({
      headSha: commit,
      status: 'completed',
      conclusion: 'success',
      jobs: [
        { name: 'Native Platform Contract (Windows)', status: 'completed', conclusion: 'success' },
      ],
    });
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => ok({
      state: 'completed', exit_code: 0, command_fingerprint: engineeringCommandFingerprint(command),
      stdout: taskId === 'complete-matrix' ? completeOutput : partialOutput,
    })) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({
      shell,
      sourceState: async (): Promise<EngineeringSourceState> => ({ commit, clean: true }),
    });
    const base = {
      source: 'host_observed' as const, observedAt: '2026-09-30T00:00:00Z', workspaceId: 'workspace-1',
      command, exitCode: 0, commit, conclusion: 'success',
    };

    await expect(verifier.verify('workspace-1', { ...base, runId: 'complete-matrix' }, 'cross_platform', ['win32', 'linux']))
      .resolves.toBe(true);
    await expect(verifier.verify('workspace-1', { ...base, runId: 'partial-matrix' }, 'cross_platform', ['win32', 'linux']))
      .resolves.toBe(false);
  });

  it('rejects historical exact-SHA CI or package proof when the current tracked source is dirty or at another commit', async () => {
    const historicalCommit = 'cbb9ac40cc6d1acfd0f66a0a2d62c25a8f3a1264';
    const currentCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => taskId === 'ci-proof'
      ? ok({
          state: 'completed', exit_code: 0, executable: 'gh',
          arguments: ['run', 'view', '36568935961', '--json', 'headSha,status,conclusion'],
          stdout: JSON.stringify({ headSha: historicalCommit, status: 'completed', conclusion: 'success' }),
        })
      : ok({
          state: 'completed', exit_code: 0, executable: 'node',
          arguments: ['apps/desktop/scripts/verify-release-evidence.mjs'],
          stdout: `Release evidence verified for lnwjud 5.7.2 win32/x64 commit ${historicalCommit}\n`,
        })) };
    const historicalEvidence = {
      source: 'host_observed' as const,
      observedAt: '2026-09-29T00:00:00Z',
      workspaceId: 'workspace-1',
      exitCode: 0,
      commit: historicalCommit,
    };
    const mismatched = new RuntimeEngineeringEvidenceVerifier({
      shell,
      sourceState: async (): Promise<EngineeringSourceState> => ({ commit: currentCommit, clean: true }),
    });
    const dirty = new RuntimeEngineeringEvidenceVerifier({
      shell,
      sourceState: async (): Promise<EngineeringSourceState> => ({ commit: historicalCommit, clean: false }),
    });
    const ciEvidence = {
      ...historicalEvidence,
      command: 'gh run view 36568935961 --json "headSha,status,conclusion"',
      runId: 'ci-proof',
      conclusion: 'success',
    };
    const packageEvidence = {
      ...historicalEvidence,
      command: 'node apps/desktop/scripts/verify-release-evidence.mjs',
      runId: 'package-proof',
      artifact: 'apps/desktop/dist/installers/lnwjud-Setup-5.7.2.exe',
    };

    await expect(mismatched.verify('workspace-1', ciEvidence, 'exact_sha_ci')).resolves.toBe(false);
    await expect(mismatched.verify('workspace-1', packageEvidence, 'package')).resolves.toBe(false);
    await expect(dirty.verify('workspace-1', ciEvidence, 'exact_sha_ci')).resolves.toBe(false);
    await expect(dirty.verify('workspace-1', packageEvidence, 'package')).resolves.toBe(false);
    await expect(mismatched.verifyDetailed('workspace-1', ciEvidence, 'exact_sha_ci'))
      .resolves.toEqual({ verified: false, reason: 'source_state_mismatch' });
  });
});
