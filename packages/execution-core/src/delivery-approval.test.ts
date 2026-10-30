import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import { stopWorker } from './managed-worker.js';
import type { WorkerRow } from './store.js';
import type { BasicProductOperationInput, Preparation } from './types.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Array<{ root: string; core: ExecutionCore }> = [];
async function fixture(): Promise<{ root: string; core: ExecutionCore; app: string; chat: string; foreign: string; advance: () => void }> {
  const root = await canonicalTemporaryDirectory('gotzji-delivery-approval-');
  const policy = path.join(root, 'policy'); ensureProductControlDocuments(policy);
  let now = Date.now();
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: { mode: 'host-direct', libraryRoot: policy }, now: () => new Date(now) });
  fixtures.push({ root, core });
  const app = core.enrollAdapter('app', 'owner'); const chat = core.enrollAdapter('chat', 'owner');
  const foreign = core.enrollAdapter('foreign', 'other');
  core.registerReviewedCommand(app, { recipeId: 'ship', executable: process.execPath, args: ['${projectRoot}/ship.mjs'], dependencies: ['${projectRoot}/ship.mjs'], delivery: true });
  for (const projectId of ['alpha', 'beta']) {
    const folder = path.join(root, projectId); await mkdir(folder);
    await writeFile(path.join(folder, 'AGENTS.md'), 'Current project policy\n');
    await writeFile(path.join(folder, 'ship.mjs'), "import {appendFileSync} from 'node:fs';appendFileSync('delivered.txt','once\\n');console.log('delivery verified');");
    core.registerProject(app, { projectId, displayName: projectId, rootPath: folder, recipeIds: ['ship'] });
  }
  return { root, core, app, chat, foreign, advance: (): void => { now += 31 * 60_000; } };
}
function input(requestId: string, projectId = 'alpha'): BasicProductOperationInput {
  return { requestId, projectId, operation: 'command.run', commandId: 'ship' };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const database = new DatabaseSync(path.join(f.root, 'state/core.sqlite'));
    const workers = database.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; database.close();
    for (const worker of workers) expect(await stopWorker(worker)).toBe(true);
    f.core.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
function prepare(f: Fixture, requestId = 'request', projectId = 'alpha'): Preparation { return f.core.prepareOperation(f.chat, input(requestId, projectId)); }

describe('ChatGPT delivery with exact-request owner decisions', () => {
  it('creates no job during preparation or approval, persists the decision and admits the same job once', async () => {
    const f = await fixture(); const prepared = prepare(f);
    expect(f.core.listDeliveryApprovals(f.app)).toHaveLength(1);
    expect(f.core.deliveryApproval(f.chat, prepared.preparationId)).toMatchObject({ digest: prepared.digest, decision: 'pending', project: { projectId: 'alpha' } });
    await expect(f.core.submit(f.chat, prepared.preparationId)).rejects.toThrow('DELIVERY_APPROVAL_REQUIRED');
    expect(await f.core.list(f.app)).toEqual([]);
    f.core.decideDeliveryApproval(f.app, prepared.preparationId, prepared.digest, 'approved');
    expect(await f.core.list(f.app)).toEqual([]);
    f.core.close();
    f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: { mode: 'host-direct', libraryRoot: path.join(f.root, 'policy') } });
    fixtures[0]!.core = f.core;
    expect(f.core.deliveryApproval(f.chat, prepared.preparationId)).toMatchObject({ decision: 'approved' });
    const job = await f.core.submit(f.chat, prepared.preparationId);
    expect((await f.core.submit(f.chat, prepared.preparationId)).jobId).toBe(job.jobId);
    expect(await f.core.list(f.app)).toHaveLength(1);
    expect(f.core.listDeliveryApprovals(f.app)).toEqual([]);
    const binding = f.core.select(f.chat, job.jobId);
    await f.core.resume(f.chat, binding);
    for (let attempt = 0; attempt < 200 && (await f.core.get(f.chat, binding)).status !== 'completed'; attempt++) {
      await f.core.tick(); await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(await f.core.readOperationResult(f.chat, binding)).toMatchObject({ output: { state: 'completed', exitCode: 0 } });
    expect(await readFile(path.join(f.root, 'alpha/delivered.txt'), 'utf8')).toBe('once\n');
    expect((await f.core.submit(f.chat, prepared.preparationId)).jobId).toBe(job.jobId);
    expect(await readFile(path.join(f.root, 'alpha/delivered.txt'), 'utf8')).toBe('once\n');
  }, 30000);

  it('refuses foreign owners, forged digests and decisions, and unapproved requests in another project', async () => {
    const f = await fixture(); const alpha = prepare(f); const beta = prepare(f, 'beta', 'beta');
    expect(() => f.core.deliveryApproval(f.foreign, alpha.preparationId)).toThrow('DELIVERY_APPROVAL_DENIED');
    expect(() => f.core.decideDeliveryApproval(f.foreign, alpha.preparationId, alpha.digest, 'approved')).toThrow('DELIVERY_APPROVAL_DENIED');
    expect(() => f.core.decideDeliveryApproval(f.app, alpha.preparationId, '0'.repeat(64), 'approved')).toThrow('DELIVERY_APPROVAL_DENIED');
    f.core.decideDeliveryApproval(f.app, alpha.preparationId, alpha.digest, 'approved');
    await expect(f.core.submit(f.chat, beta.preparationId)).rejects.toThrow('DELIVERY_APPROVAL_REQUIRED');
    await expect(f.core.submit(f.app, alpha.preparationId)).rejects.toThrow('PREPARATION_DENIED');
    expect(await f.core.list(f.app)).toEqual([]);
  });

  it.each(['script', 'instructions'])('invalidates review when %s changes before approval', async kind => {
    const f = await fixture(); const prepared = prepare(f);
    await writeFile(path.join(f.root, 'alpha', kind === 'script' ? 'ship.mjs' : 'AGENTS.md'), 'changed bytes');
    expect(() => f.core.decideDeliveryApproval(f.app, prepared.preparationId, prepared.digest, 'approved')).toThrow('DELIVERY_PREPARATION_CHANGED');
    expect(await f.core.list(f.app)).toEqual([]);
  });

  it.each(['script', 'instructions'])('invalidates approval when %s changes before admission', async kind => {
    const f = await fixture(); const prepared = prepare(f);
    f.core.decideDeliveryApproval(f.app, prepared.preparationId, prepared.digest, 'approved');
    await writeFile(path.join(f.root, 'alpha', kind === 'script' ? 'ship.mjs' : 'AGENTS.md'), 'changed bytes');
    await expect(f.core.submit(f.chat, prepared.preparationId)).rejects.toThrow('DELIVERY_PREPARATION_CHANGED');
    expect(await f.core.list(f.app)).toEqual([]);
  });

  it('retains rejection and expiration without admitting any work', async () => {
    const f = await fixture(); const rejected = prepare(f, 'rejected'); const expired = prepare(f, 'expired');
    f.core.decideDeliveryApproval(f.app, rejected.preparationId, rejected.digest, 'rejected');
    expect(() => f.core.decideDeliveryApproval(f.app, rejected.preparationId, rejected.digest, 'approved')).toThrow('DELIVERY_APPROVAL_DENIED');
    await expect(f.core.submit(f.chat, rejected.preparationId)).rejects.toThrow('DELIVERY_APPROVAL_REQUIRED');
    f.core.decideDeliveryApproval(f.app, expired.preparationId, expired.digest, 'approved'); f.advance();
    await expect(f.core.submit(f.chat, expired.preparationId)).rejects.toThrow('DELIVERY_APPROVAL_REQUIRED');
    expect(f.core.deliveryApproval(f.chat, expired.preparationId)).toMatchObject({ decision: 'expired' });
    expect(await f.core.list(f.app)).toEqual([]);
  });
});
