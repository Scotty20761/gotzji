/* global URL, AbortController */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { assertProductDependencies } from './product-security.mjs';
import { assertProfile } from './grace-broker.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

/** Starts only through the bounded Grace worker control turn. Status/poll never starts provider work. */
export function productBrowserManager(config, directory, callbacks) {
  const prepared = config.operation === 'grace.product-operation' ? JSON.parse(config.text) : null;
  let current; let controller; let readState; let pending;
  function persist() { callbacks.persist('browser-progress.json', current); appendFileSync(path.join(directory, 'product.stdout'), JSON.stringify(current) + '\n', { mode: 0o600 }); }
  return {
    status: () => current,
    start: () => {
      if (current) return current;
      if (prepared?.kind !== 'browser') throw new Error('BROWSER_PREPARATION_REQUIRED');
      controller = new AbortController(); const started = Date.now();
      current = { jobId: config.jobId, epoch: config.epoch, runId: hash(config.jobId + '\0' + config.epoch + '\0' + prepared.browser.planDigest), state: 'running', elapsedMs: 0, checks: 0, lastProgressAt: new Date().toISOString() }; persist();
      pending = Promise.resolve().then(async () => {
        const brokerUrl = existsSync(new URL('./product-browser.js', import.meta.url)) ? new URL('./product-browser-broker.mjs', import.meta.url) : new URL('../dist/product-browser-broker.mjs', import.meta.url);
        const backend = await import(brokerUrl.href); readState = backend.readPreparedBrowserState;
        const { assertProductAuthority } = await import('./product-broker.mjs');
        const verifyLiveAuthority = () => {
          assertProductDependencies(config); assertProfile(config.grace);
          const db = new DatabaseSync(config.database, { timeout: 5000 });
          try { assertProductAuthority(db, config); return true; } finally { db.close(); }
        };
        const receipt = await backend.executePreparedBrowserOperation(config, controller.signal, {
          verifyLiveAuthority, verifyOwnedSession: backend.verifyOwnedProductBrowserSession,
          onProgress: progress => { current = { ...current, phase: progress.phase, elapsedMs: Date.now() - started, lastProgressAt: progress.at }; persist(); },
        });
        writeFileSync(path.join(config.effectRoot, 'result.txt'), JSON.stringify(receipt), { mode: 0o600 });
        current = { ...current, state: 'completed', elapsedMs: Date.now() - started, checks: 1, lastProgressAt: new Date().toISOString() }; persist(); callbacks.finished(current);
      }).catch(error => {
        let state; try { state = readState?.(config); } catch { state = { outcome: 'unknown' }; }
        const uncertain = state?.outcome === 'unknown' || ['started', 'uncertain'].includes(state?.state) || error?.outcome === 'unknown';
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'BROWSER_PROVIDER_FAILED';
        current = { ...current, state: uncertain ? 'uncertain' : controller.signal.aborted ? 'cancelled' : 'failed', outcome: uncertain ? 'unknown' : state?.outcome ?? error?.outcome ?? 'unknown', code, elapsedMs: Date.now() - started, lastProgressAt: new Date().toISOString() }; persist(); callbacks.finished(current);
      });
      return current;
    },
    stop: async () => {
      if (!current) return true;
      if (current.state === 'uncertain') return false;
      if (['failed', 'cancelled', 'completed'].includes(current.state)) {
        const state = readState?.(config); return current.outcome === 'none' || state?.outcome === 'none' || state?.outcome === 'verified';
      }
      controller.abort();
      // Never close a shared owned browser to cancel one tab job. Await only bounded native completion;
      // a lost dispatch/response retains the canonical resource fence until explicit inspection.
      if (pending) await pending;
      const state = readState?.(config); return state?.outcome === 'none' || state?.outcome === 'verified';
    },
  };
}
