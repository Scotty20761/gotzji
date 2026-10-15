/* global AbortController, setTimeout, clearTimeout */
export function createTestFixtureLifecycle() {
  const controller = new AbortController();
  const pending = new Set();
  const resources = [];
  const failures = [];

  return {
    signal: controller.signal,
    run(operation) {
      let promise;
      try {
        promise = Promise.resolve(operation(controller.signal));
      } catch (error) {
        promise = Promise.reject(error);
      }
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        (error) => {
          pending.delete(promise);
          if (error !== controller.signal.reason) {
            failures.push(new Error('Fixture wait failed during teardown', { cause: error }));
          }
        },
      );
      return promise;
    },
    own(label, close) {
      resources.push({ label, close });
    },
    async close() {
      controller.abort(new Error('Fixture teardown'));
      await Promise.allSettled([...pending]);
      for (const resource of resources.splice(0).reverse()) {
        try {
          await resource.close();
        } catch (error) {
          failures.push(new Error(`Failed to close ${resource.label}`, { cause: error }));
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Fixture cleanup failed');
    },
  };
}

export async function waitForFixture(signal, read) {
  while (true) {
    signal.throwIfAborted();
    const value = await read();
    signal.throwIfAborted();
    if (value !== undefined) return value;
    await abortableDelay(signal, 25);
  }
}

function abortableDelay(signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, timeoutMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
