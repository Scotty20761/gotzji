/* global URL, AbortController */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { assertProductDependencies, providerFailureCode } from './product-security.mjs';
import { assertProfile } from './grace-broker.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Native execution stays under this worker after Grace's bounded control turn. */
export function productNativeManager(config, directory, callbacks) {
  const prepared = config.operation === 'grace.product-operation' ? JSON.parse(config.text) : null;
  let current; let controller;
  let readPreparedNativeState; let reconcilePreparedNativeStop; let pending;
  function terminationProved(state) {
    const proof = state?.stopEvidence;
    return proof?.observed === 'absent' || (state?.dispatch === 'pre-dispatch' && proof?.schemaVersion === 1
      && proof.observed === 'pre-dispatch' && proof.identityCount === 0 && proof.identityDigest === null
      && proof.verifier === 'host-signed-pre-dispatch-v1');
  }
  function persist() { callbacks.persist('native-progress.json', current); appendFileSync(path.join(directory, 'product.stdout'), JSON.stringify(current) + '\n', { mode: 0o600 }); }
  return {
    status: () => current,
    start: () => {
      if (current) return current;
      if (prepared?.kind !== 'native') throw new Error('NATIVE_PREPARATION_REQUIRED');
      controller = new AbortController();
      const started = Date.now();
      current = { jobId: config.jobId, epoch: config.epoch, runId: hash(config.jobId + '\0' + config.epoch + '\0' + prepared.native.planDigest), state: 'running', elapsedMs: 0, checks: 0, lastProgressAt: new Date().toISOString() };
      persist();
      pending = Promise.resolve().then(async () => {
        const brokerUrl = existsSync(new URL('./product-native.js', import.meta.url)) ? new URL('./product-native-broker.mjs', import.meta.url) : new URL('../dist/product-native-broker.mjs', import.meta.url);
        const backend = await import(brokerUrl.href);
        readPreparedNativeState = backend.readPreparedNativeState;
        reconcilePreparedNativeStop = backend.reconcilePreparedNativeStop;
        const { assertProductAuthority } = await import('./product-broker.mjs');
        const verifyLiveAuthority = () => {
          assertProductDependencies(config); assertProfile(config.grace);
          const db = new DatabaseSync(config.database, { timeout: 5000 });
          try { assertProductAuthority(db, config); return true; } finally { db.close(); }
        };
        const receipt = await backend.executePreparedNativeOperation(config, controller.signal, { verifyLiveAuthority });
        writeFileSync(path.join(config.effectRoot, 'result.txt'), JSON.stringify(receipt), { mode: 0o600 });
        current = { ...current, state: 'completed', outcome: 'verified', elapsedMs: Date.now() - started, checks: 1, lastProgressAt: new Date().toISOString() }; persist(); callbacks.finished(current);
      }).catch((error) => {
        let state;
        try { state = readPreparedNativeState?.(config); } catch { state = { outcome: 'unknown' }; }
        const uncertain = state?.outcome === 'unknown' || state?.state === 'started' || state?.state === 'uncertain' || error?.outcome === 'unknown';
        current = { ...current, state: uncertain ? 'uncertain' : 'failed', outcome: uncertain ? 'unknown' : state?.outcome ?? error?.outcome ?? 'unknown', ...(state?.stopEvidence ? { stopEvidence: state.stopEvidence } : {}), code: providerFailureCode(error, 'NATIVE_PROVIDER_FAILED'), elapsedMs: Date.now() - started, lastProgressAt: new Date().toISOString() };
        persist(); callbacks.finished(current);
      });
      return current;
    },
    stop: async () => {
      if (!current) return true;
      if (current.state === 'running') controller.abort();
      // Await the provider's bounded abort path; an abort signal or helper exit
      // alone never proves that its out-of-process native application stopped.
      if (pending) await pending;
      try {
        const state = readPreparedNativeState?.(config);
        if (state?.outcome === 'none' || state?.outcome === 'verified' || (!state && current.outcome === 'none')) return true;
        if (terminationProved(state)) return true;
        const stop = await reconcilePreparedNativeStop?.(config);
        if (!stop || !terminationProved(readPreparedNativeState?.(config))) return false;
        current = { ...current, state: stop.outcome === 'none' ? 'failed' : 'uncertain', outcome: stop.outcome, stopEvidence: stop.stopEvidence, lastProgressAt: new Date().toISOString() };
        persist();
        // Termination permits the worker to stop. Core retains uncertain effects for the app-only owner decision.
        return true;
      } catch { return false; }
    },
  };
}
