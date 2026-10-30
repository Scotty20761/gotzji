import { createTestFixtureLifecycle } from '../src/test-fixture-lifecycle.mjs';

interface CanonicalLifecycle { readonly signal: AbortSignal; run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>; close(): Promise<void> }
export interface OwnedTestLifetime { readonly signal: AbortSignal; run<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T>; close(): Promise<void> }
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** Track the whole body without reporting its awaited rejection again during teardown. */
export function createOwnedTestLifetime(parentSignal?: AbortSignal): OwnedTestLifetime {
  const lifecycle = createTestFixtureLifecycle() as CanonicalLifecycle;
  const signal = parentSignal ? AbortSignal.any([lifecycle.signal, parentSignal]) : lifecycle.signal;
  return {
    signal,
    async run<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const outcome = await lifecycle.run<Outcome<T>>(async (): Promise<Outcome<T>> => {
        try { return { ok: true, value: await body(signal) }; }
        catch (error) { return { ok: false, error }; }
      });
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
    close: (): Promise<void> => lifecycle.close(),
  };
}

export async function finishOwnedTest<T>(lifetime: OwnedTestLifetime, restore: () => void,
  takeFixtures: () => readonly T[], closeFixture: (fixture: T) => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  try { await lifetime.close(); } catch (error) { failures.push(error); }
  try { restore(); } catch (error) { failures.push(error); }
  let fixtures: readonly T[] = [];
  try { fixtures = takeFixtures(); } catch (error) { failures.push(error); }
  const results = await Promise.allSettled(fixtures.map(fixture => Promise.resolve().then(() => closeFixture(fixture))));
  for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, 'Owned test cleanup failed; unproved roots retained');
}
