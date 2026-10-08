import { readFile, readdir, writeFile, rm, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { alive, callWorker, signed, stopWorker, ownedProcessAlive, verifyStoppedWorker } from './managed-worker.js';
import { processIdentities } from './process-identity.mjs';
import { createHmac } from 'node:crypto';
import { type WorkerRow } from './store.js';
import type { TaskBinding, QualificationOperation } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

interface Fixture { root: string; core: ExecutionCore; gotzji: string; lnwjud: string; foreign: string; bindings: TaskBinding[] }
const fixtures: Fixture[] = [];
const cores: ExecutionCore[] = [];
const unrelated: ChildProcess[] = [];
async function fixture(options: { now?: () => Date } = {}): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-core-');
  const core = await ExecutionCore.open(root, options);
  cores.push(core);
  const value = { root, core, gotzji: core.enrollAdapter('gotzji', 'owner-one'), lnwjud: core.enrollAdapter('lnwjud-library', 'owner-one'), foreign: core.enrollAdapter('foreign', 'owner-two'), bindings: [] };
  fixtures.push(value);
  return value;
}
async function submit(f: Fixture, id = 'request-one', operation: QualificationOperation = 'fixture.write', text = 'ทดสอบ gotzji'): Promise<TaskBinding> {
  const preparation = f.core.prepare(f.gotzji, { requestId: id, operation, text });
  const job = await f.core.submit(f.gotzji, preparation.preparationId);
  const binding = f.core.select(f.gotzji, job.jobId);
  f.bindings.push(binding);
  return binding;
}
function db(f: Fixture): DatabaseSync { return new DatabaseSync(path.join(f.root, 'core.sqlite')); }
function worker(f: Fixture, binding: TaskBinding): WorkerRow {
  const database = db(f);
  try { return database.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow; }
  finally { database.close(); }
}
async function until(action: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 150; n++) { if (await action()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('condition not observed');
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const database = db(f);
    const workers = database.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[];
    database.close();
    for (const w of workers) await stopWorker(w);
    // All cleanup targets are exact fixture roots allocated above.
    for (const c of cores.splice(0)) { try { c.close(); } catch { /* already closed */ } }
    await rm(f.root, { recursive: true, force: true });
  }
  for (const child of unrelated.splice(0)) child.kill();
});

describe('neutral execution authority — real SQLite, files and owned processes', () => {
  it('does not cancel an unrelated live process that occupies a recorded old PID with a different birth identity', async () => {
    const f = await fixture(); const binding = await submit(f, 'identity-reuse');
    await f.core.resume(f.gotzji, binding); await f.core.tick();
    const w = worker(f, binding);
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' }); unrelated.push(child);
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const pid = child.pid!; const identity = (await processIdentities([pid]))[pid];
    expect(identity && typeof identity === 'object').toBe(true);
    if (!identity || typeof identity !== 'object') throw new Error('Actual process birth probe unavailable');
    const previousIdentity = { ...identity, birth: 'different-recorded-previous-birth' };
    expect(await ownedProcessAlive(pid, previousIdentity)).toBe(false);
    const rewrite = async (name: string, transform: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
      const filename = path.join(w.directory, name); const record = JSON.parse(await readFile(filename, 'utf8')) as { body: string };
      const body = JSON.stringify(transform(JSON.parse(record.body) as Record<string, unknown>));
      await writeFile(filename, JSON.stringify({ body, mac: createHmac('sha256', w.token).update(body).digest('hex') }));
    };
    await rewrite('ready.json', (value) => ({ ...value, pid, identity: undefined }));
    await rewrite('stopped.json', (value) => ({ ...value, pid, identities: {}, descendants: [], closedDescendants: [] }));
    expect(await verifyStoppedWorker(w)).toBe(false);
    // Model the old signed record after OS PID reuse. The current process has
    // real independently observed birth/executable data and is not our worker.
    await rewrite('ready.json', (value) => ({ ...value, pid, identity: previousIdentity }));
    await rewrite('stopped.json', (value) => ({ ...value, pid, identities: { [pid]: previousIdentity }, descendants: [], closedDescendants: [] }));
    expect(await stopWorker(w)).toBe(true);
    expect(alive(pid)).toBe(true); expect(child.exitCode).toBeNull();
  }, 15000);
  it('persists one native Goal and returns the same claim on concurrent duplicate submit', async () => {
    const f = await fixture();
    const p = f.core.prepare(f.gotzji, { requestId: 'same', operation: 'fixture.write', text: 'one' });
    const jobs = await Promise.all(Array.from({ length: 8 }, () => f.core.submit(f.gotzji, p.preparationId)));
    expect(new Set(jobs.map((j) => j.jobId)).size).toBe(1);
    const database = db(f);
    expect(database.prepare('SELECT count(*) AS n FROM goals').get()?.n).toBe(1);
    expect(database.prepare('SELECT count(*) AS n FROM gotzji_claims').get()?.n).toBe(1);
    database.close();
  });
  it('shares owner/request dedupe across two distinct enrolled channels', async () => {
    const f = await fixture();
    const binding = await submit(f);
    const p = f.core.prepare(f.lnwjud, { requestId: 'request-one', operation: 'fixture.write', text: 'ทดสอบ gotzji' });
    const second = await f.core.submit(f.lnwjud, p.preparationId);
    expect(second.jobId).toBe(binding.jobId);
    expect(await f.core.get(f.lnwjud, f.core.select(f.lnwjud, binding.jobId))).toMatchObject({ status: 'queued' });
  });
  it('rejects changed content under the same logical request ID', async () => {
    const f = await fixture(); await submit(f);
    const p = f.core.prepare(f.gotzji, { requestId: 'request-one', operation: 'fixture.write', text: 'different' });
    await expect(f.core.submit(f.gotzji, p.preparationId)).rejects.toMatchObject({ code: 'REQUEST_DIGEST_CONFLICT' });
  });
  it('creates a new job for a deliberate identical request with a new ID', async () => {
    const f = await fixture();
    expect((await submit(f, 'new')).jobId).not.toBe((await submit(f, 'old')).jobId);
  });
  it('rejects unknown credentials and model-selected role/executable fields', async () => {
    const f = await fixture();
    expect(() => f.core.prepare('guessed', { requestId: 'x', operation: 'fixture.write', text: 'x' })).toThrow('AUTHORITY_DENIED');
    expect(() => f.core.prepare(f.gotzji, { requestId: 'x', operation: 'fixture.write', text: 'x', role: 'Grace', executable: 'powershell' } as never)).toThrow('INVALID_REQUEST');
    expect(() => f.core.prepare(f.gotzji, { requestId: 'x', operation: 'arbitrary' as never, text: 'x' })).toThrow('INVALID_REQUEST');
  });
  it('rejects a foreign owner, guessed handle and cross-adapter handle', async () => {
    const f = await fixture(); const b = await submit(f);
    expect(() => f.core.select(f.foreign, b.jobId)).toThrow('TASK_AUTHORITY_DENIED');
    await expect(f.core.get(f.gotzji, { ...b, handle: 'guess' })).rejects.toMatchObject({ code: 'TASK_AUTHORITY_DENIED' });
    await expect(f.core.get(f.lnwjud, b)).rejects.toMatchObject({ code: 'TASK_AUTHORITY_DENIED' });
  });
  it('rejects another adapter reusing a preparation', async () => {
    const f = await fixture(); const p = f.core.prepare(f.gotzji, { requestId: 'x', operation: 'fixture.write', text: 'x' });
    await expect(f.core.submit(f.lnwjud, p.preparationId)).rejects.toMatchObject({ code: 'PREPARATION_DENIED' });
  });
  it('reconciles the interrupted claim-to-Goal mapping before starting work', async () => {
    const f = await fixture(); const b = await submit(f);
    const database = db(f); database.prepare('UPDATE gotzji_claims SET goal_id=NULL').run(); database.close();
    const p = f.core.prepare(f.gotzji, { requestId: 'request-one', operation: 'fixture.write', text: 'ทดสอบ gotzji' });
    expect((await f.core.submit(f.gotzji, p.preparationId)).jobId).toBe(b.jobId);
    const check = db(f); expect(check.prepare('SELECT count(*) AS n FROM goals').get()?.n).toBe(1); check.close();
  });
  it('verifies the actual effect and cleanup before native completion', async () => {
    const f = await fixture(); const b = await submit(f);
    await f.core.resume(f.gotzji, b); await f.core.tick();
    expect(await f.core.result(f.gotzji, b)).toMatchObject({ status: 'completed', curation: 'explicit-only' });
    expect(await readFile(path.join(f.root, 'effects', b.jobId, 'result.txt'), 'utf8')).toBe('ทดสอบ gotzji');
    const database = db(f); expect(database.prepare('SELECT count(*) AS n FROM gotzji_writers').get()?.n).toBe(0); database.close();
  });
  it('keeps untrusted display projections separate from authority', async () => {
    const f = await fixture(); const b = await submit(f);
    const projection = new DatabaseSync(path.join(f.root, 'app-projection.sqlite'));
    projection.exec('CREATE TABLE goals(id TEXT,status TEXT);'); projection.prepare('INSERT INTO goals VALUES (?,?)').run(b.jobId, 'completed'); projection.close();
    expect(await f.core.get(f.gotzji, b)).toMatchObject({ status: 'queued', evidenceDigest: null });
    const database = db(f); expect(database.prepare('SELECT count(*) AS n FROM gotzji_workers').get()?.n).toBe(0); database.close();
  });
  it('accepts no caller completion/receipt override', async () => {
    const f = await fixture(); const b = await submit(f);
    expect('finish' in f.core || 'recordReceipt' in f.core).toBe(false);
    expect(await f.core.get(f.gotzji, { ...b, completed: true, receipt: 'forged' } as never)).toMatchObject({ status: 'queued', evidenceDigest: null });
  });
  it('rebinds a reconnected channel without rotating a live worker epoch', async () => {
    const f = await fixture(); const b = await submit(f, 'hold', 'fixture.hold');
    await f.core.resume(f.gotzji, b);
    const before = worker(f, b);
    const rebound = f.core.select(f.lnwjud, b.jobId);
    await f.core.resume(f.lnwjud, rebound);
    expect(worker(f, b).epoch).toBe(before.epoch);
    expect(worker(f, b).generation).toBe(before.generation);
    await f.core.cancel(f.lnwjud, rebound);
  });
  it('refuses a second Library writer even after time advances beyond TTL', async () => {
    let time = new Date('2026-10-04T00:00:00Z');
    const f = await fixture({ now: () => time }); const a = await submit(f, 'hold', 'fixture.hold'); const b = await submit(f, 'second');
    await f.core.resume(f.gotzji, a);
    time = new Date(time.getTime() + 301000);
    await expect(f.core.resume(f.gotzji, b)).rejects.toMatchObject({ code: 'LIBRARY_WRITER_HELD' });
    await f.core.cancel(f.gotzji, a);
  });
  it('renews the same live worker lease at 30 seconds', async () => {
    let time = new Date('2026-10-04T00:00:00Z'); const f = await fixture({ now: () => time }); const b = await submit(f, 'hold', 'fixture.hold');
    await f.core.resume(f.gotzji, b); const before = worker(f, b);
    time = new Date(time.getTime() + 30001); await f.core.tick();
    expect(worker(f, b).epoch).toBe(before.epoch); expect(worker(f, b).last_renewed).toBe(time.getTime());
  });
  it('adopts a live durable worker after the core is closed and reopened', async () => {
    const f = await fixture(); const b = await submit(f, 'hold', 'fixture.hold');
    await f.core.resume(f.gotzji, b); const before = worker(f, b); f.core.close();
    f.core = await ExecutionCore.open(f.root); cores.push(f.core);
    await f.core.resume(f.lnwjud, f.core.select(f.lnwjud, b.jobId));
    expect(worker(f, b).epoch).toBe(before.epoch);
    expect(await f.core.cancel(f.gotzji, b)).toMatchObject({ status: 'cancelled' });
  });
  it('recovers an effect after lost acknowledgement without rewriting the file', async () => {
    const f = await fixture(); const b = await submit(f); await f.core.resume(f.gotzji, b);
    const filename = path.join(f.root, 'effects', b.jobId, 'result.txt'); const before = await stat(filename);
    f.core.close(); f.core = await ExecutionCore.open(f.root); cores.push(f.core); await f.core.tick();
    expect(await f.core.get(f.gotzji, b)).toMatchObject({ status: 'completed' });
    expect((await stat(filename)).mtimeMs).toBe(before.mtimeMs);
  });
  it('inspects an effect left by an absent worker before acquiring a new native lease', async () => {
    const f = await fixture(); const b = await submit(f); await f.core.resume(f.gotzji, b);
    const w = worker(f, b); await stopWorker(w); const before = await stat(path.join(f.root, 'effects', b.jobId, 'result.txt'));
    await f.core.resume(f.gotzji, b);
    expect(await f.core.get(f.gotzji, b)).toMatchObject({ status: 'completed' });
    expect(worker(f, b).generation).toBeGreaterThan(w.generation);
    expect((await stat(path.join(f.root, 'effects', b.jobId, 'result.txt'))).mtimeMs).toBe(before.mtimeMs);
  });
  it('blocks changed/unknown effects and preserves writer ownership', async () => {
    const f = await fixture(); const b = await submit(f); await f.core.resume(f.gotzji, b);
    await writeFile(path.join(f.root, 'effects', b.jobId, 'result.txt'), 'unexpected');
    await expect(f.core.tick()).rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' });
    expect(await f.core.get(f.gotzji, b)).toMatchObject({ status: 'blocked' });
    const database = db(f); expect(database.prepare('SELECT count(*) AS n FROM gotzji_writers').get()?.n).toBe(1); database.close();
  });
  it('proves owned child and grandchild termination without stopping an unrelated process', async () => {
    const f = await fixture(); const b = await submit(f, 'hold', 'fixture.hold');
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' }); unrelated.push(other);
    await f.core.resume(f.gotzji, b); const w = worker(f, b);
    await until(async () => (await callWorker(w, 'status')).descendants.length === 2);
    const observation = await callWorker(w, 'status');
    expect(await f.core.cancel(f.lnwjud, f.core.select(f.lnwjud, b.jobId))).toMatchObject({ status: 'cancelled' });
    expect([observation.pid, ...observation.descendants].every((pid) => alive(pid) === false)).toBe(true);
    expect(alive(other.pid!)).toBe(true);
  });
  it('rejects a stale worker generation before another effect', async () => {
    const f = await fixture(); const b = await submit(f, 'hold', 'fixture.hold'); await f.core.resume(f.gotzji, b);
    const database = db(f); database.prepare('UPDATE gotzji_workers SET generation=generation+1').run(); database.close();
    // advance renewal timestamp to force validation at the next tick
    const check = db(f); check.prepare('UPDATE gotzji_workers SET last_renewed=0').run(); check.close();
    await expect(f.core.tick()).rejects.toMatchObject({ code: 'WORKER_FENCE_INVALID' });
  });
  it('rejects forged process evidence instead of releasing the writer', async () => {
    const f = await fixture(); const b = await submit(f, 'hold', 'fixture.hold'); await f.core.resume(f.gotzji, b);
    const w = worker(f, b); const filename = path.join(w.directory, 'ready.json'); const original = await readFile(filename);
    await writeFile(filename, JSON.stringify({ body: '{}', mac: 'forged' }));
    await expect(f.core.resume(f.gotzji, b)).rejects.toMatchObject({ code: 'WORKER_RECONCILIATION_REQUIRED' });
    await writeFile(filename, original);
  });
  it('rejects a changed core policy/schema before accepting another operation', async () => {
    const f = await fixture(); const database = db(f); database.prepare('UPDATE gotzji_meta SET version=2').run(); database.close();
    expect(() => f.core.prepare(f.gotzji, { requestId: 'x', operation: 'fixture.write', text: 'x' })).toThrow('CORE_VERSION_OR_POLICY_CHANGED');
  });
  it('never exposes credentials, continuation handles, leases or private worker paths in public results', async () => {
    const f = await fixture(); const b = await submit(f); await f.core.resume(f.gotzji, b); await f.core.tick();
    const output = JSON.stringify(await f.core.result(f.gotzji, b)); const w = worker(f, b);
    for (const sensitive of [f.gotzji, f.lnwjud, b.handle, w.lease, w.token, w.directory]) expect(output).not.toContain(sensitive);
  });
  it('keeps terminal results retrievable after reconnect without creating curation or schedules', async () => {
    const f = await fixture(); const b = await submit(f); await f.core.resume(f.gotzji, b); await f.core.tick();
    const result = await f.core.result(f.lnwjud, f.core.select(f.lnwjud, b.jobId));
    expect(result).toMatchObject({ status: 'completed', curation: 'explicit-only' });
    const database = db(f); expect(database.prepare('SELECT count(*) AS n FROM goal_scheduled_continuations').get()?.n).toBe(0); database.close();
  });
  it('does not mistake a stopped process marker for completion evidence', async () => {
    const f = await fixture(); const b = await submit(f, 'hold', 'fixture.hold'); await f.core.resume(f.gotzji, b);
    const w = worker(f, b); await stopWorker(w); expect(signed(w, 'stopped.json')).toBeDefined();
    await expect(f.core.resume(f.gotzji, b)).rejects.toMatchObject({ code: 'EFFECT_RECONCILIATION_REQUIRED' });
    expect(await f.core.get(f.gotzji, b)).not.toMatchObject({ status: 'completed' });
  });
  it('keeps one writer across independent core hosts, not just one in-memory caller', async () => {
    const f = await fixture(); const b = await submit(f, 'hold', 'fixture.hold');
    const second = await ExecutionCore.open(f.root); cores.push(second);
    const selected = second.select(f.lnwjud, b.jobId);
    await Promise.allSettled([f.core.resume(f.gotzji, b), second.resume(f.lnwjud, selected)]);
    const database = db(f); expect(database.prepare('SELECT count(*) AS n FROM gotzji_workers').get()?.n).toBe(1); expect(database.prepare('SELECT count(*) AS n FROM gotzji_writers').get()?.n).toBe(1); database.close();
    await second.cancel(f.lnwjud, selected);
  });
  it('refuses to create a fresh authority after its existing database disappears', async () => {
    const f = await fixture(); const b = await submit(f, 'hold', 'fixture.hold'); await f.core.resume(f.gotzji, b);
    f.core.close(); const filename = path.join(f.root, 'core.sqlite');
    await rename(filename, filename + '.saved');
    try { await expect(ExecutionCore.open(f.root)).rejects.toMatchObject({ code: 'CORE_DATABASE_MISSING' }); }
    finally { await rename(filename + '.saved', filename); }
  });

  it('waits for another connection holding the database instead of failing to reopen', async () => {
    const f = await fixture(); f.core.close(); const filename = path.join(f.root, 'core.sqlite');
    // A worker's last connection closing checkpoints the WAL under an exclusive lock; this child holds one for 400 ms.
    const holder = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(${JSON.stringify(filename)}); db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE gotzji_meta SET version=version;'); console.log('locked'); setTimeout(() => { db.exec('COMMIT;'); db.close(); }, 400);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve, reject) => { holder.stdout?.on('data', (data: Buffer) => { if (String(data).includes('locked')) resolve(); }); holder.once('exit', (code) => reject(new Error(`holder exited ${String(code)}`))); });
      const reopened = await ExecutionCore.open(f.root); cores.push(reopened);
      expect(reopened.enrollAdapter('after-lock', 'owner-one')).toBeTypeOf('string');
    } finally {
      if (holder.exitCode === null) await new Promise((resolve) => holder.once('exit', resolve));
    }
  });

  it('opens every core database connection with a busy timeout', async () => {
    // Without one a connection fails at once while another process holds the database (CI: reopen, phase-r frontend).
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const sources = (await readdir(directory)).filter((name) => /\.(?:ts|mjs)$/u.test(name) && !name.endsWith('.test.ts'));
    const missing: string[] = [];
    for (const name of sources) {
      const text = await readFile(path.join(directory, name), 'utf8');
      for (const match of text.matchAll(/new DatabaseSync\(/gu)) if (!(text.slice(match.index, match.index + 300).split(');')[0] ?? '').includes('timeout')) missing.push(`${name}:${text.slice(0, match.index).split('\n').length}`);
    }
    expect(sources.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
  it('accepts the declared payload boundary without dropping bytes and rejects overflow', async () => {
    const f = await fixture(); const text = 'a'.repeat(65536); const b = await submit(f, 'large', 'fixture.write', text);
    await f.core.resume(f.gotzji, b); await f.core.tick();
    expect((await readFile(path.join(f.root, 'effects', b.jobId, 'result.txt'))).byteLength).toBe(65536);
    expect(() => f.core.prepare(f.gotzji, { requestId: 'overflow', operation: 'fixture.write', text: text + 'b' })).toThrow('INVALID_REQUEST');
  });
  it('does not release ownership from parent death alone, regardless of OS descendant cleanup', async () => {
    const f = await fixture(); const b = await submit(f, 'hold', 'fixture.hold'); await f.core.resume(f.gotzji, b);
    const w = worker(f, b); await until(async () => (await callWorker(w, 'status')).descendants.length === 2);
    const observation = await callWorker(w, 'status');
    process.kill(observation.pid);
    await until(async () => alive(observation.pid) === false);
    try {
      // Windows may finish inherited descendants between two observations.
      // Either reconciliation disposition must preserve the durable writer;
      // a previously sampled process state is not an immutable expected result.
      await expect(f.core.resume(f.gotzji, b)).rejects.toMatchObject({ code: expect.stringMatching(/^(WORKER|EFFECT)_RECONCILIATION_REQUIRED$/) });
      expect(worker(f, b).epoch).toBe(w.epoch);
      const database = db(f); expect(database.prepare('SELECT count(*) AS n FROM gotzji_writers').get()?.n).toBe(1); database.close();
    } finally {
      // Exact descendant identities came from this task's authenticated observation.
      for (const pid of observation.descendants) if (alive(pid) === true) process.kill(pid);
      await until(async () => observation.descendants.every((pid) => alive(pid) === false));
    }
  });

  it('keeps owner settlement to the owning adapter, product project jobs and the two named decisions', async () => {
    const f = await fixture(); const b = await submit(f);
    await expect(f.core.settleBlockedJob(f.gotzji, b, 'released' as never)).rejects.toMatchObject({ code: 'SETTLE_DECISION_INVALID', field: 'decision' });
    await expect(f.core.settleBlockedJob(f.foreign, b, 'no-effect')).rejects.toMatchObject({ code: 'TASK_AUTHORITY_DENIED' });
    await expect(f.core.settleBlockedJob(f.gotzji, b, 'no-effect')).rejects.toMatchObject({ code: 'SETTLE_UNSUPPORTED', field: 'operation' });
  });
});
