import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ScheduledContinuationService } from '@lnwjud/application';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';
import type { AcquireGoalRecordRequest, GoalRecord } from '@lnwjud/domain';

const databases: SqliteDatabase[] = [];
const initialTime = '2026-10-13T00:00:00.000Z';
const expiredTime = '2026-10-13T00:06:00.000Z';
const token = 'owned-test-lease';
const tokenHash = createHash('sha256').update(token).digest('hex');
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
async function fixture(): Promise<{ database: SqliteDatabase; repository: SqliteGoalRepository; acquisition: AcquireGoalRecordRequest; goal: GoalRecord; request: Parameters<SqliteGoalRepository['renewExpiredOwnedLease']>[0] }> {
  const database = new SqliteDatabase(':memory:'); databases.push(database);
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({ id: 'workspace', displayName: 'Synthetic', rootPath: process.cwd(), realRootPath: process.cwd(), createdAt: initialTime });
  const repository = new SqliteGoalRepository(database);
  const acquisition = { goalId: 'goal', workspaceId: 'workspace', goalKey: 'owned-command', objective: 'Synthetic command',
    plan: { steps: [{ id: 'run', title: 'Run', status: 'pending' as const }] }, ownerClientId: 'owner', ownerSessionId: 'session',
    leaseTokenHash: tokenHash, leaseSeconds: 300, now: initialTime };
  const { goal } = await repository.acquire(acquisition);
  const request = { goalId: goal.id, ownerClientId: goal.ownerClientId, ownerSessionId: goal.leaseOwnerSessionId!, leaseTokenHash: goal.leaseTokenHash!,
    expectedRevision: goal.revision, expectedUserIntentRevision: goal.userIntentRevision, expectedGeneration: goal.leaseGeneration,
    expectedActivitySeq: goal.leaseActivitySeq, expectedHeartbeat: goal.leaseHeartbeatAt, expectedExpiry: goal.leaseExpiresAt!, now: expiredTime };
  return { database, repository, acquisition, goal, request };
}

describe('trusted same-owner expired-lease renewal', () => {
  it('preserves token/session/generation/revision and blocks takeover after renewal wins', async () => {
    const f = await fixture(); const renewed = await f.repository.renewExpiredOwnedLease(f.request);
    expect(renewed).toMatchObject({ leaseTokenHash: tokenHash, leaseOwnerSessionId: 'session', leaseGeneration: f.goal.leaseGeneration,
      revision: f.goal.revision, leaseActivitySeq: f.goal.leaseActivitySeq + 1, leaseHeartbeatAt: expiredTime, leaseExpiresAt: '2026-10-13T00:11:00.000Z' });
    expect(await f.repository.acquire({ ...f.acquisition, ownerSessionId: 'replacement', leaseTokenHash: 'b'.repeat(64), now: expiredTime })).toMatchObject({ acquired: false });
    await expect(f.repository.renewExpiredOwnedLease(f.request)).rejects.toBeDefined();
  });
  for (const field of ['ownerClientId', 'ownerSessionId', 'leaseTokenHash', 'expectedRevision', 'expectedUserIntentRevision', 'expectedGeneration', 'expectedActivitySeq', 'expectedHeartbeat', 'expectedExpiry'] as const) {
    it(`refuses a stale ${field} without changing any lease field`, async () => {
      const f = await fixture(); const value = f.request[field];
      const changed = typeof value === 'number' ? value + 1 : value === undefined ? initialTime : `${value}-changed`;
      await expect(f.repository.renewExpiredOwnedLease({ ...f.request, [field]: changed })).rejects.toBeDefined();
      expect(await f.repository.getById(f.goal.id)).toEqual(f.goal);
    });
  }
  it('refuses the stale generation after takeover wins', async () => {
    const f = await fixture();
    const winner = await f.repository.acquire({ ...f.acquisition, ownerSessionId: 'replacement', leaseTokenHash: 'b'.repeat(64), now: expiredTime });
    expect(winner.acquired).toBe(true);
    await expect(f.repository.renewExpiredOwnedLease(f.request)).rejects.toBeDefined();
    expect(await f.repository.getById(f.goal.id)).toEqual(winner.goal);
  });
  it('requires an expired lease and refuses terminal work', async () => {
    const f = await fixture();
    await expect(f.repository.renewExpiredOwnedLease({ ...f.request, now: initialTime })).rejects.toBeDefined();
    await f.repository.cancel({ checkpointId: 'owner-cancel-checkpoint', goalId: f.goal.id, ownerClientId: 'owner', expectedRevision: f.goal.revision, summary: 'Owner cancelled', evidence: [], now: initialTime });
    await expect(f.repository.renewExpiredOwnedLease(f.request)).rejects.toBeDefined();
  });
  it('does not revive a goal with a live scheduled-continuation fence', async () => {
    const f = await fixture();
    const scheduled = new ScheduledContinuationService(f.repository, { now: (): Date => new Date(initialTime) });
    const prepared = await scheduled.prepareScheduledContinuation({ clientId: 'owner', clientName: 'Synthetic', sessionId: 'session' }, {
      goalId: f.goal.id, leaseToken: token, expectedRevision: f.goal.revision, currentPhase: 'running', summary: 'Synthetic fence', stepUpdates: [],
      nextAction: 'Continue', blockers: [], evidence: [], activeTaskIds: [], executionPreference: 'cloud',
    });
    expect(prepared.ok).toBe(true);
    const current = (await f.repository.getById(f.goal.id))!;
    await expect(f.repository.renewExpiredOwnedLease({ ...f.request, expectedRevision: current.revision,
      expectedActivitySeq: current.leaseActivitySeq, expectedHeartbeat: current.leaseHeartbeatAt, expectedExpiry: current.leaseExpiresAt! })).rejects.toBeDefined();
    expect(await f.repository.getById(f.goal.id)).toEqual(current);
  });
});
