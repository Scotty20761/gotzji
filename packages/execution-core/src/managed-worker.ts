import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { CoreError, type WorkerObservation } from './types.js';
import { hash, secret, type WorkerRow } from './store.js';
import type { GraceProfile } from './grace-profile.js';
import { processIdentities, sameProcessIdentity, type ProcessIdentity } from './process-identity.mjs';
import { signPreparedNativeOperation, type PreparedProductNativeOperation } from './product-native.js';
import { signLibraryBinding } from './product-library.js';
import { signPreparedBrowserOperation, type PreparedProductBrowserOperation } from './product-browser.js';

export const WORKER_FILE = fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url));
export function workerFingerprint(): string {
  return hash([...['fixture-worker','grace-broker','grace-runtime','grace-stdio','grace-verifier','fingerprints','phase-r-runner','phase-r-validator','phase-r-host-identity','product-broker','product-runner','product-security','process-identity','product-native-broker','product-native-manager','product-browser-broker','product-browser-manager','product-library-broker','product-library-manager','product-library-final-memo'].map((name) => hash(readFileSync(new URL(`./${name}.mjs`, import.meta.url)))),hash(readFileSync(new URL('./product-library-weekly-wrapper.py',import.meta.url)))].join(':'));
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
interface Ready { epoch: string; pid: number; port: number; identity?: ProcessIdentity }
export async function ownedProcessAlive(pid: number, expected: ProcessIdentity | undefined, reader: typeof processIdentities = processIdentities): Promise<boolean | 'unknown'> {
  if (alive(pid) === false) return false;
  if (!expected) return 'unknown';
  const observed = (await reader([pid]))[pid];
  if (observed === 'unknown' || observed === undefined) return 'unknown';
  return observed === null ? false : sameProcessIdentity(expected, observed);
}
function stoppedEntries(worker: WorkerRow, observation: WorkerObservation): { pid: number; expected: ProcessIdentity | undefined }[] | undefined {
  const ready = signed<Ready>(worker, 'ready.json');
  if (!ready || observation.state !== 'cancelled' || observation.pid !== ready.pid) return undefined;
  return [
    { pid: observation.pid, expected: ready.identity ?? observation.identities?.[observation.pid] },
    ...observation.descendants
      .filter((pid) => !observation.closedDescendants?.includes(pid))
      .map((pid) => ({ pid, expected: observation.identities?.[pid] })),
  ];
}
async function stoppedOwnership(worker: WorkerRow, observation: WorkerObservation, liveness: typeof alive = alive, reader: typeof processIdentities = processIdentities): Promise<boolean> {
  const entries = stoppedEntries(worker, observation);
  if (!entries) return false;
  const live = entries.filter((entry) => liveness(entry.pid) !== false);
  if (!live.length) return true;
  const identities = await reader(live.map((entry) => entry.pid));
  return live.every(({ pid, expected }) => {
    if (!expected) return false;
    const observed = identities[pid];
    return observed === null || (observed !== 'unknown' && observed !== undefined && !sameProcessIdentity(expected, observed));
  });
}
export async function verifyStoppedWorker(worker: WorkerRow): Promise<boolean> {
  const observation = signed<WorkerObservation>(worker, 'stopped.json');
  return !!observation && await stoppedOwnership(worker, observation);
}
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
      if (!ready) return 'unknown';
      const observation = signed<WorkerObservation>(worker, 'observation.json');
      const stopped = signed<WorkerObservation>(worker, 'stopped.json');
      if (await ownedProcessAlive(ready.pid, ready.identity ?? observation?.identities?.[ready.pid]) !== false) return 'unknown';
      // A dead parent is not proof that its descendants are gone. Unknown
      // enrollment during a hold/spawn also retains ownership for inspection.
      const config = JSON.parse(readFileSync(path.join(worker.directory, 'config.json'), 'utf8')) as { operation: string };
      if (config.operation === 'fixture.hold' && observation?.state === 'running' && !stopped && observation.descendants.length !== 2) return 'unknown';
      if (config.operation.startsWith('grace.') && observation?.state === 'running' && !stopped && observation.descendants.length < 1) return 'unknown';
      if (stopped) return await stoppedOwnership(worker, stopped) ? 'absent' : 'unknown';
      for (const pid of observation?.descendants ?? []) if (!observation?.closedDescendants?.includes(pid) && await ownedProcessAlive(pid, observation?.identities?.[pid]) !== false) return 'unknown';
      return 'absent';
    } catch { return 'unknown'; }
  }
}
export async function stopWorker(worker: WorkerRow): Promise<boolean> {
  const observed = await observeWorker(worker);
  if (observed === 'absent') return true;
  if (observed === 'unknown') return false;
  try { await callWorker(worker, 'cancel'); } catch { /* Lost response still needs independent exit evidence. */ }
  return await awaitStoppedOwnership(worker);
}
/** The signed worker receipt remains the authority; injected observations only support focused stop-proof tests. */
export async function awaitStoppedOwnership(worker: WorkerRow, dependencies: { alive?: typeof alive; identities?: typeof processIdentities; delay?: () => Promise<void> } = {}): Promise<boolean> {
  const liveness = dependencies.alive ?? alive;
  const reader = dependencies.identities ?? processIdentities;
  for (let n = 0; n < 100; n++) {
    const stopped = signed<WorkerObservation>(worker, 'stopped.json');
    const entries = stopped ? stoppedEntries(worker, stopped) : undefined;
    if (entries && entries.every((entry) => liveness(entry.pid) === false)) return true;
    await (dependencies.delay?.() ?? new Promise((resolve) => setTimeout(resolve, 20)));
  }
  const stopped = signed<WorkerObservation>(worker, 'stopped.json');
  return !!stopped && await stoppedOwnership(worker, stopped, liveness, reader);
}
export async function launchWorker(worker: WorkerRow, effectRoot: string, operation: string, text: string, binding: { jobId: string; owner: string; policy: string; database: string; intentRevision: number; authorizationDigest?: string; grace: GraceProfile | null; privateRuntimeRoots: readonly string[]; nativeTestRunner?: { readonly path: string; readonly sha256: string }; libraryTestRunner?: { readonly path: string; readonly sha256: string }; browserTestTransport?: { readonly path:string; readonly sha256:string } }): Promise<void> {
  if (realpathSync(effectRoot) !== effectRoot) throw new CoreError('EFFECT_ROOT_CHANGED');
  const config = path.join(worker.directory, 'config.json');
  const configuration = { ...binding, authorizationDigest: binding.authorizationDigest ?? '', epoch: worker.epoch, token: worker.token, effectRoot, operation, text, generation: worker.generation, session: worker.session, lease: worker.lease };
  const prepared = operation === 'grace.product-operation' ? JSON.parse(text) as { kind?: string } : null;
  const nativeAuthorization = prepared?.kind === 'native' && configuration.grace ? signPreparedNativeOperation({ ...configuration, grace: configuration.grace, authorizationDigest: configuration.authorizationDigest ?? '' }, prepared as PreparedProductNativeOperation) : undefined;
  const libraryAuthorization = prepared?.kind === 'library' && configuration.grace ? signLibraryBinding(configuration) : undefined;
  const browserAuthorization = prepared?.kind === 'browser' && configuration.grace ? signPreparedBrowserOperation({ ...configuration, grace: configuration.grace },prepared as PreparedProductBrowserOperation) : undefined;
  const libraryWrapper = prepared?.kind === 'library' ? { path:fileURLToPath(new URL('./product-library-weekly-wrapper.py',import.meta.url)),sha256:hash(readFileSync(new URL('./product-library-weekly-wrapper.py',import.meta.url))) } : undefined;
  writeFileSync(config, JSON.stringify({ ...configuration, ...(nativeAuthorization ? { nativeAuthorization } : {}), ...(libraryAuthorization ? { libraryAuthorization } : {}), ...(libraryWrapper ? { libraryWrapper } : {}), ...(browserAuthorization ? { browserAuthorization } : {}) }), { mode: 0o600, flag: 'wx' });
  const child = spawn(process.execPath, [WORKER_FILE, config], { windowsHide: true, detached: true, stdio: 'ignore' });
  const failed = new Promise<never>((_resolve, reject) => child.once('error', () => reject(new CoreError('WORKER_LAUNCH_FAILED'))));
  child.unref();
  await Promise.race([failed, (async (): Promise<void> => {
    for (let n = 0; n < 600; n++) {
      if (signed(worker, 'ready.json')) { await callWorker(worker, 'status'); return; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new CoreError('WORKER_READY_UNKNOWN');
  })()]);
}
