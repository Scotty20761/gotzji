/* global URL, AbortController */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { assertProductDependencies } from './product-security.mjs';
import { assertProfile } from './grace-broker.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Native execution stays under this worker after Grace's bounded control turn. */
export function productNativeManager(config, directory, callbacks) {
  const prepared = config.operation === 'grace.product-operation' ? JSON.parse(config.text) : null;
  let current; let controller;
  let readPreparedNativeState;
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
      void Promise.resolve().then(async () => {
        const brokerUrl = existsSync(new URL('./product-native.js', import.meta.url)) ? new URL('./product-native-broker.mjs', import.meta.url) : new URL('../dist/product-native-broker.mjs', import.meta.url);
        const backend = await import(brokerUrl.href);
        readPreparedNativeState = backend.readPreparedNativeState;
        const { assertProductAuthority } = await import('./product-broker.mjs');
        const verifyLiveAuthority = () => {
          assertProductDependencies(config); assertProfile(config.grace);
          const db = new DatabaseSync(config.database, { timeout: 5000 });
          try { assertProductAuthority(db, config); return true; } finally { db.close(); }
        };
        const receipt = await backend.executePreparedNativeOperation(config, controller.signal, { verifyLiveAuthority });
        writeFileSync(path.join(config.effectRoot, 'result.txt'), JSON.stringify(receipt), { mode: 0o600 });
        current = { ...current, state: 'completed', elapsedMs: Date.now() - started, checks: 1, lastProgressAt: new Date().toISOString() }; persist(); callbacks.finished(current);
      }).catch((error) => {
        const state = readPreparedNativeState?.(config);
        const uncertain = state?.outcome === 'unknown' || state?.state === 'started' || state?.state === 'uncertain';
        current = { ...current, state: uncertain ? 'uncertain' : 'failed', code: typeof error?.code === 'string' ? error.code : error.message ?? 'NATIVE_PROVIDER_FAILED', elapsedMs: Date.now() - started, lastProgressAt: new Date().toISOString() };
        persist(); callbacks.finished(current);
      });
      return current;
    },
    stop: async () => {
      if (!current || current.state === 'failed') return true;
      if (current.state === 'completed') return readPreparedNativeState?.(config)?.outcome === 'verified';
      controller.abort();
      // Killing a PowerShell helper is not proof that an out-of-process COM
      // application stopped. Retain every resource until native inspection.
      return false;
    },
  };
}
