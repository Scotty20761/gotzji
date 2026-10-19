import { describe, expect, it } from 'vitest';
import { createOwnedTestLifetime, finishOwnedTest } from '../test-support/owned-test-lifetime.js';
import { waitForFixture } from './test-fixture-lifecycle.mjs';

describe('owned test-body teardown boundaries', () => {
  it('aborts child observers while draining a pending resume and reports its body outcome once before cleanup', async () => {
    const parent = createOwnedTestLifetime(); const child = createOwnedTestLifetime(parent.signal); const events: string[] = [];
    let entered!: () => void; let release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; }); const resume = new Promise<void>(resolve => { release = resolve; });
    const observer = child.run(async signal => waitForFixture(signal, async () => { entered(); return undefined; })).then(() => undefined, (error: unknown) => error);
    const body = parent.run(async () => { await resume; events.push('resume-settled'); const error = await observer; if (error) throw error; }).then(() => undefined, (error: unknown) => error);
    await observed;
    const cleanup = finishOwnedTest(parent, () => { events.push('restore'); }, () => ['owned'], async () => { await child.close(); events.push('close-core', 'remove-root'); });
    await Promise.resolve(); await Promise.resolve(); const abortedBeforeResumeSettled = child.signal?.aborted;
    const eventsBeforeResumeSettled = [...events]; release(); if (!child.signal.aborted) await child.close(); const error = await body; await cleanup;
    expect(abortedBeforeResumeSettled).toBe(true); expect(eventsBeforeResumeSettled).toEqual([]);
    expect(error).toMatchObject({ message: 'Fixture teardown' });
    expect(events).toEqual(['resume-settled', 'restore', 'close-core', 'remove-root']);
  });
  it('passes an already-closing parent signal to a fixture created late without duplicating its body error', async () => {
    const parent = createOwnedTestLifetime(); await parent.close();
    const child = createOwnedTestLifetime(parent.signal); expect(child.signal.aborted).toBe(true);
    await expect(child.run(async signal => signal.throwIfAborted())).rejects.toBe(parent.signal.reason);
    await expect(child.close()).resolves.toBeUndefined();
  });
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
