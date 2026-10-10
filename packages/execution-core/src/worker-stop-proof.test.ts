import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitStoppedOwnership } from './managed-worker.js';
import type { WorkerRow } from './store.js';
import type { WorkerObservation } from './types.js';
import type { ProcessIdentity } from './process-identity.mjs';

const roots: string[] = [];
const original: ProcessIdentity = { birth: 'original', executable: 'c:\\node.exe' };
async function envelope(worker: WorkerRow, file: string, value: object): Promise<void> {
  const body = JSON.stringify(value);
  await writeFile(path.join(worker.directory, file), JSON.stringify({ body, mac: createHmac('sha256', worker.token).update(body).digest('hex') }));
}
async function fixture(): Promise<{ worker: WorkerRow; receipt: WorkerObservation }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gotzji-stop-proof-')); roots.push(directory);
  const worker: WorkerRow = { directory, token: 'private-test-token', epoch: 'epoch', job_id: 'job', session: 'session', lease: 'lease', generation: 1, launch_state: 'running', last_renewed: 0 };
  const receipt: WorkerObservation = { epoch: worker.epoch, pid: 101, state: 'cancelled', descendants: [102, 103], closedDescendants: [103], identities: { 101: original, 102: original } };
  await envelope(worker, 'ready.json', { epoch: worker.epoch, pid: 101, identity: original });
  await envelope(worker, 'stopped.json', receipt);
  return { worker, receipt };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('signed stop receipt proof', () => {
  it('lets exited root and descendants settle without repeated OS identity probes', async () => {
    const { worker } = await fixture(); let settled = false;
    const identities = vi.fn(async () => ({ 101: original, 102: original }));
    const liveness = vi.fn((pid: number): boolean => pid === 103 || !settled);
    expect(await awaitStoppedOwnership(worker, { alive: liveness, identities, delay: async () => { settled = true; } })).toBe(true);
    expect(identities).not.toHaveBeenCalled();
    expect(liveness.mock.calls.some(([pid]) => pid === 103)).toBe(false);
  });
  it.each(['reused', 'same', 'unknown'] as const)('makes one final identity proof for persistent %s PIDs', async (kind) => {
    const { worker } = await fixture();
    const observed = kind === 'reused' ? { ...original, birth: 'replacement' } : kind === 'same' ? original : 'unknown' as const;
    const identities = vi.fn(async () => ({ 101: observed, 102: observed }));
    expect(await awaitStoppedOwnership(worker, { alive: () => true, identities, delay: async () => undefined })).toBe(kind === 'reused');
    expect(identities).toHaveBeenCalledTimes(1);
    expect(identities).toHaveBeenCalledWith([101, 102]);
  });
  it('never turns unknown liveness into absence', async () => {
    const { worker } = await fixture(); const identities = vi.fn(async () => ({ 101: 'unknown' as const, 102: 'unknown' as const }));
    expect(await awaitStoppedOwnership(worker, { alive: () => 'unknown', identities, delay: async () => undefined })).toBe(false);
    expect(identities).toHaveBeenCalledTimes(1);
  });
  it('requires the final signed receipt after the grace window', async () => {
    const { worker } = await fixture(); let attempts = 0;
    const identities = vi.fn(async () => ({ 101: original, 102: original }));
    expect(await awaitStoppedOwnership(worker, { alive: () => true, identities, delay: async () => { if (++attempts === 100) await rm(path.join(worker.directory, 'stopped.json')); } })).toBe(false);
    expect(identities).not.toHaveBeenCalled();
  });
  it.each(['missing-ready', 'wrong-pid', 'wrong-state', 'no-receipt'] as const)('rejects %s even with absent PIDs', async (kind) => {
    const { worker, receipt } = await fixture();
    if (kind === 'missing-ready') await rm(path.join(worker.directory, 'ready.json'));
    if (kind === 'no-receipt') await rm(path.join(worker.directory, 'stopped.json'));
    if (kind === 'wrong-pid') await envelope(worker, 'stopped.json', { ...receipt, pid: 999 });
    if (kind === 'wrong-state') await envelope(worker, 'stopped.json', { ...receipt, state: 'running' });
    const identities = vi.fn(async () => ({}));
    expect(await awaitStoppedOwnership(worker, { alive: () => false, identities, delay: async () => undefined })).toBe(false);
    expect(identities).not.toHaveBeenCalled();
  });
  it.each(['mac', 'epoch'] as const)('retains invalid %s evidence as an error', async (kind) => {
    const { worker, receipt } = await fixture();
    if (kind === 'mac') await writeFile(path.join(worker.directory, 'stopped.json'), JSON.stringify({ body: JSON.stringify(receipt), mac: 'wrong' }));
    else await envelope(worker, 'stopped.json', { ...receipt, epoch: 'other' });
    await expect(awaitStoppedOwnership(worker, { alive: () => false, delay: async () => undefined })).rejects.toMatchObject({ code: kind === 'mac' ? 'WORKER_EVIDENCE_INVALID' : 'WORKER_EPOCH_INVALID' });
  });
});
