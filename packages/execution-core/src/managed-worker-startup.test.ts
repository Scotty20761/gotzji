import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchWorker } from './managed-worker.js';
import type { WorkerRow } from './store.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn() }));
let root: string;
let worker: WorkerRow;
let child: ChildProcess;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const pending: Promise<unknown>[] = [];
beforeEach(async () => {
  root = await canonicalTemporaryDirectory('gotzji-worker-startup-');
  const directory = path.join(root, 'worker'); mkdirSync(directory); mkdirSync(path.join(root, 'effects'));
  worker = { directory, token: 'owned-startup-token', epoch: 'owned-startup-epoch', job_id: 'owned-job', session: 'owned-session', lease: 'owned-lease', generation: 1, launch_state: 'launching', last_renewed: 0 };
  child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null, unref: vi.fn() }) as unknown as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
  fetchMock = vi.fn<typeof fetch>(async input => {
    const nonce = new URL(String(input)).searchParams.get('nonce');
    return new Response(JSON.stringify({ epoch: worker.epoch, pid: child.pid, state: 'idle', descendants: [], nonce }));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(async () => {
  await vi.runAllTimersAsync(); await Promise.allSettled(pending.splice(0));
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (await realpath(root) !== root || path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('gotzji-worker-startup-')) throw new Error('Startup fixture cleanup scope denied');
  await rm(root, { recursive: true, force: true });
});
function ready(epoch = worker.epoch): void {
  const body = JSON.stringify({ epoch, pid: child.pid, port: 1234, identity: { birth: 'owned-birth', executable: process.execPath } });
  writeFileSync(path.join(worker.directory, 'ready.json'), JSON.stringify({ body, mac: createHmac('sha256', worker.token).update(body).digest('hex') }));
}
function launch(): Promise<unknown> {
  const promise = launchWorker(worker, path.join(root, 'effects'), 'fixture.hold', '', { jobId: worker.job_id, owner: 'owner', policy: 'owned-policy', database: path.join(root, 'core.sqlite'), intentRevision: 1, grace: null, privateRuntimeRoots: [] }).then(() => undefined, (error: unknown) => error);
  pending.push(promise); return promise;
}
function noPendingStartup(): void {
  expect(child.listenerCount('error')).toBe(0); expect(child.listenerCount('exit')).toBe(0); expect(vi.getTimerCount()).toBe(0);
}
function retainedBeforeStart(): void {
  expect(existsSync(path.join(worker.directory, 'config.json'))).toBe(true);
  expect(JSON.parse(readFileSync(path.join(worker.directory, 'config.json'), 'utf8'))).toMatchObject({ epoch: worker.epoch, operation: 'fixture.hold' });
  expect(existsSync(path.join(root, 'effects', 'effect.txt'))).toBe(false);
  expect(fetchMock.mock.calls.every(([input]) => new URL(String(input)).pathname === '/status')).toBe(true);
}
describe('worker startup prerequisite deadline', () => {
  it('waits beyond twelve seconds for the existing cold identity prerequisite, then authenticates once', async () => {
    let settled = false; const result = launch().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(13_000); expect(settled).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
    ready(); await vi.advanceTimersByTimeAsync(20); expect(await result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1); noPendingStartup(); retainedBeforeStart();
  });
  it.each([{ observed: 36_999, accepted: true }, { observed: 37_000, accepted: false }])('uses an absolute strict deadline when readiness is observed at $observed ms', async ({ observed, accepted }) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const result = launch(); ready(); clock.mockReturnValue(observed);
    await vi.advanceTimersByTimeAsync(20);
    if (accepted) { expect(await result).toBeUndefined(); expect(fetchMock).toHaveBeenCalledTimes(1); }
    else { expect(await result).toMatchObject({ code: 'WORKER_READY_UNKNOWN' }); expect(fetchMock).not.toHaveBeenCalled(); }
    noPendingStartup(); retainedBeforeStart();
  });
  it('charges the signed-ready filesystem read to the same deadline before accepting it', async () => {
    ready(); vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(36_999).mockReturnValue(37_000);
    expect(await launch()).toMatchObject({ code: 'WORKER_READY_UNKNOWN' }); expect(fetchMock).not.toHaveBeenCalled(); noPendingStartup(); retainedBeforeStart();
  });
  it('retains unknown ownership at the exact deadline without an authenticated start', async () => {
    const result = launch(); await vi.advanceTimersByTimeAsync(37_000);
    expect(await result).toMatchObject({ code: 'WORKER_READY_UNKNOWN' }); expect(fetchMock).not.toHaveBeenCalled();
    noPendingStartup(); retainedBeforeStart();
  });
  it.each(['error', 'exit'] as const)('settles early child %s and removes its competing readiness timer and listeners', async event => {
    const result = launch(); child.emit(event, event === 'error' ? new Error('owned spawn failure') : 1);
    expect(await result).toMatchObject({ code: 'WORKER_LAUNCH_FAILED' }); noPendingStartup(); retainedBeforeStart();
  });
  it('rejects an already exited child before accepting even a signed ready entry', async () => {
    Object.assign(child, { exitCode: 1 }); ready(); const result = launch();
    expect(await result).toMatchObject({ code: 'WORKER_LAUNCH_FAILED' }); expect(fetchMock).not.toHaveBeenCalled(); noPendingStartup(); retainedBeforeStart();
  });
  it('requires the existing authenticated status handshake and settles readiness resources on its refusal', async () => {
    ready(); fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }));
    expect(await launch()).toMatchObject({ code: 'WORKER_UNAVAILABLE' }); expect(fetchMock).toHaveBeenCalledTimes(1); noPendingStartup(); retainedBeforeStart();
  });
  it('rejects stale signed readiness without dispatch and without leaving a polling continuation', async () => {
    ready('stale-epoch'); expect(await launch()).toMatchObject({ code: 'WORKER_EPOCH_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled(); noPendingStartup(); retainedBeforeStart();
  });
});
