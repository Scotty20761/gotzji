import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { CoreError, type WorkerObservation } from './types.js';
import { hash, secret, type WorkerRow } from './store.js';
import type { GraceProfile } from './grace-profile.js';

export const WORKER_FILE = fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url));
export function workerFingerprint(): string {
  return hash(['fixture-worker','grace-broker','grace-runtime','grace-stdio','grace-verifier','fingerprints','phase-r-runner','phase-r-validator','phase-r-host-identity'].map((name) => hash(readFileSync(new URL(`./${name}.mjs`, import.meta.url)))).join(':'));
}
export function alive(pid: number): boolean | 'unknown' {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? false : 'unknown'; }
}
export function signed<T>(worker: WorkerRow, name: string): T | undefined {
  const filename = path.join(worker.directory, name);
  if (!existsSync(filename)) return undefined;
  const value = JSON.parse(readFileSync(filename, 'utf8')) as { body: string; mac: string };
  if (createHmac('sha256', worker.token).update(value.body).digest('hex') !== value.mac) throw new CoreError('WORKER_EVIDENCE_INVALID');
  const result = JSON.parse(value.body) as T & { epoch: string };
  if (result.epoch !== worker.epoch) throw new CoreError('WORKER_EPOCH_INVALID');
  return result;
}
interface Ready { epoch: string; pid: number; port: number }
export async function callWorker(worker: WorkerRow, action: 'status' | 'start' | 'cancel'): Promise<WorkerObservation> {
  const ready = signed<Ready>(worker, 'ready.json');
  if (!ready || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw new CoreError('WORKER_UNAVAILABLE');
  const nonce = secret();
  const response = await fetch(`http://127.0.0.1:${ready.port}/${action}?nonce=${nonce}`, {
    method: action === 'status' ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${worker.token}` }, signal: AbortSignal.timeout(3000), redirect: 'error',
  });
  if (!response.ok) throw new CoreError('WORKER_UNAVAILABLE');
  const value = await response.json() as WorkerObservation & { nonce?: string };
  if (value.epoch !== worker.epoch || value.pid !== ready.pid || (action === 'status' && value.nonce !== nonce)) throw new CoreError('WORKER_IDENTITY_INVALID');
  return value;
}
export async function observeWorker(worker: WorkerRow): Promise<'running' | 'absent' | 'unknown'> {
  try { await callWorker(worker, 'status'); return 'running'; }
  catch {
    try {
      const ready = signed<Ready>(worker, 'ready.json');
      if (!ready || alive(ready.pid) !== false) return 'unknown';
      const observation = signed<WorkerObservation>(worker, 'observation.json');
      const stopped = signed<WorkerObservation>(worker, 'stopped.json');
      // A dead parent is not proof that its descendants are gone. Unknown
      // enrollment during a hold/spawn also retains ownership for inspection.
      const config = JSON.parse(readFileSync(path.join(worker.directory, 'config.json'), 'utf8')) as { operation: string };
      if (config.operation === 'fixture.hold' && observation?.state === 'running' && !stopped && observation.descendants.length !== 2) return 'unknown';
      if (config.operation.startsWith('grace.') && observation?.state === 'running' && !stopped && observation.descendants.length < 1) return 'unknown';
      const descendants = stopped?.descendants ?? observation?.descendants ?? [];
      return descendants.every((pid) => alive(pid) === false) ? 'absent' : 'unknown';
    } catch { return 'unknown'; }
  }
}
export async function stopWorker(worker: WorkerRow): Promise<boolean> {
  const observed = await observeWorker(worker);
  if (observed === 'absent') return true;
  if (observed === 'unknown') return false;
  try { await callWorker(worker, 'cancel'); } catch { /* Lost response still needs independent exit evidence. */ }
  for (let n = 0; n < 100; n++) {
    const stopped = signed<WorkerObservation>(worker, 'stopped.json');
    if (stopped && [stopped.pid, ...stopped.descendants].every((pid) => alive(pid) === false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
export async function launchWorker(worker: WorkerRow, effectRoot: string, operation: string, text: string, binding: { jobId: string; owner: string; policy: string; database: string; intentRevision: number; authorizationDigest?: string; grace: GraceProfile | null }): Promise<void> {
  if (realpathSync(effectRoot) !== effectRoot) throw new CoreError('EFFECT_ROOT_CHANGED');
  const config = path.join(worker.directory, 'config.json');
  writeFileSync(config, JSON.stringify({ ...binding, epoch: worker.epoch, token: worker.token, effectRoot, operation, text, generation: worker.generation, session: worker.session, lease: worker.lease }), { mode: 0o600, flag: 'wx' });
  const child = spawn(process.execPath, [WORKER_FILE, config], { windowsHide: true, detached: true, stdio: 'ignore' });
  const failed = new Promise<never>((_resolve, reject) => child.once('error', () => reject(new CoreError('WORKER_LAUNCH_FAILED'))));
  child.unref();
  await Promise.race([failed, (async (): Promise<void> => {
    for (let n = 0; n < 150; n++) {
      if (signed(worker, 'ready.json')) { await callWorker(worker, 'status'); return; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new CoreError('WORKER_READY_UNKNOWN');
  })()]);
}
