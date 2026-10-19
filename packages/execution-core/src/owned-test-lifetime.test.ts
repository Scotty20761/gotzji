import { describe, expect, it } from 'vitest';
import { createOwnedTestLifetime, finishOwnedTest } from '../test-support/owned-test-lifetime.js';

describe('owned test-body teardown boundaries', () => {
  it('drains a timed-out body before restoring mocks, closing Core or removing a late fixture', async () => {
    const lifetime = createOwnedTestLifetime(); const events: string[] = []; const fixtures: string[] = [];
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }); const barrier = new Promise<void>(resolve => { release = resolve; });
    const body = lifetime.run(async () => { enter(); await barrier; fixtures.push('late-fixture'); events.push('body-settled'); return 'read completed'; });
    await entered;
    const cleanup = finishOwnedTest(lifetime, () => { events.push('restore-mocks'); }, () => { events.push('snapshot-fixtures'); return fixtures.splice(0); }, async (fixture) => { events.push(`close-core:${fixture}`, `remove-root:${fixture}`); });
    await Promise.resolve(); await Promise.resolve(); expect(events).toEqual([]);
    release(); expect(await body).toBe('read completed'); await cleanup;
    expect(events).toEqual(['body-settled', 'restore-mocks', 'snapshot-fixtures', 'close-core:late-fixture', 'remove-root:late-fixture']);
  });
  it('reports the original body rejection once and still closes every fixture', async () => {
    const lifetime = createOwnedTestLifetime(); const original = new Error('original assertion'); const closed: number[] = [];
    await expect(lifetime.run(async () => { throw original; })).rejects.toBe(original);
    await expect(finishOwnedTest(lifetime, () => undefined, () => [1, 2], async value => { closed.push(value); })).resolves.toBeUndefined();
    expect(closed).toEqual([1, 2]);
  });
  it('settles every independent cleanup before reporting any failed fixture', async () => {
    const lifetime = createOwnedTestLifetime(); const attempted: number[] = []; const failure = new Error('retain failed root');
    const result = finishOwnedTest(lifetime, () => undefined, () => [1, 2, 3], async value => { attempted.push(value); if (value === 1) throw failure; });
    await expect(result).rejects.toMatchObject({ errors: [failure] }); expect(attempted).toEqual([1, 2, 3]);
  });
});
