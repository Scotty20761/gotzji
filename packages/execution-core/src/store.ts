import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '@lnwjud/storage';
import { CoreError, type RequestInput } from './types.js';

export function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function secret(): string { return randomBytes(32).toString('hex'); }
export interface AdapterRow { id: string; owner: string; credential_hash: string; policy: string }
export interface ClaimRow {
  id: string; owner: string; request_id: string; digest: string; input: string;
  goal_key: string; goal_id: string | null; policy: string;
}
export interface WorkerRow {
  job_id: string; epoch: string; session: string; lease: string; generation: number;
  directory: string; token: string; launch_state: string; last_renewed: number;
}
export interface OperationRow { job_id: string; digest: string; phase: string; receipt: string | null }
export interface WriterRow { root: string; job_id: string; epoch: string }
export interface CoreUpgrade { readonly expectedAuthorityId: string; readonly expectedPolicy: string }

const SQL = `
CREATE TABLE gotzji_meta (version INTEGER NOT NULL, policy TEXT NOT NULL, authority_id TEXT NOT NULL);
CREATE TABLE gotzji_adapters (id TEXT PRIMARY KEY, owner TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE, policy TEXT NOT NULL);
CREATE TABLE gotzji_preparations (id TEXT PRIMARY KEY, adapter TEXT NOT NULL, owner TEXT NOT NULL, digest TEXT NOT NULL, input TEXT NOT NULL, policy TEXT NOT NULL);
CREATE TABLE gotzji_claims (id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, input TEXT NOT NULL, goal_key TEXT NOT NULL UNIQUE, goal_id TEXT, policy TEXT NOT NULL, UNIQUE(owner,request_id));
CREATE TABLE gotzji_bindings (handle_hash TEXT PRIMARY KEY, adapter TEXT NOT NULL, job_id TEXT NOT NULL, policy TEXT NOT NULL);
CREATE TABLE gotzji_workers (job_id TEXT PRIMARY KEY, epoch TEXT NOT NULL UNIQUE, session TEXT NOT NULL, lease TEXT NOT NULL, generation INTEGER NOT NULL, directory TEXT NOT NULL, token TEXT NOT NULL, launch_state TEXT NOT NULL, last_renewed INTEGER NOT NULL);
CREATE TABLE gotzji_writers (root TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, epoch TEXT NOT NULL);
CREATE TABLE gotzji_operations (job_id TEXT PRIMARY KEY, digest TEXT NOT NULL, phase TEXT NOT NULL, receipt TEXT);
CREATE TABLE gotzji_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, view TEXT NOT NULL);
`;

/** Private host ledger sharing the native Goal database; not another job state machine. */
export class CoreStore {
  public readonly database: SqliteDatabase;
  #replaced = false;
  readonly #filename: string;
  readonly #identity: string;
  public static inspectAuthority(filename: string): { policy: string; authorityId: string } {
    const policy = CoreStore.existingPolicy(filename);
    const anchor = JSON.parse(readFileSync(path.join(path.dirname(filename), 'authority.json'), 'utf8')) as { authority: string };
    return { policy, authorityId: anchor.authority };
  }
  /** Trusted, quiescent build/schema cutover. No request/claim/receipt is rewritten. */
  public static upgradePolicy(filename: string, policy: string, expected: CoreUpgrade): void {
    if (!/^[a-f0-9]{64}$/.test(policy) || !/^[a-f0-9]{64}$/.test(expected.expectedPolicy) || !/^[a-f0-9]{64}$/.test(expected.expectedAuthorityId)) throw new CoreError('UPGRADE_AUTHORITY_DENIED');
    if (lstatSync(filename).isSymbolicLink()) throw new CoreError('CORE_DATABASE_REPLACED');
    const anchor = JSON.parse(readFileSync(path.join(path.dirname(filename), 'authority.json'), 'utf8')) as { authority: string };
    if (anchor.authority !== expected.expectedAuthorityId) throw new CoreError('UPGRADE_AUTHORITY_DENIED');
    const identity = statSync(filename, { bigint: true });
    const database = new DatabaseSync(filename, { timeout: 5000 });
    try {
      database.exec('BEGIN IMMEDIATE;');
      const meta = database.prepare('SELECT * FROM gotzji_meta').get();
      if (meta?.version !== 1 || meta.authority_id !== expected.expectedAuthorityId) throw new CoreError('UPGRADE_AUTHORITY_DENIED');
      database.exec('CREATE TABLE IF NOT EXISTS gotzji_policy_history (seq INTEGER PRIMARY KEY AUTOINCREMENT,from_policy TEXT NOT NULL,to_policy TEXT NOT NULL,authority_id TEXT NOT NULL);');
      if (meta.policy === policy) {
        if (expected.expectedPolicy !== policy && !database.prepare('SELECT 1 FROM gotzji_policy_history WHERE from_policy=? AND to_policy=? AND authority_id=?').get(expected.expectedPolicy, policy, expected.expectedAuthorityId)) throw new CoreError('UPGRADE_POLICY_CONFLICT');
        database.exec('COMMIT;'); return;
      }
      if (meta.policy !== expected.expectedPolicy) throw new CoreError('UPGRADE_POLICY_CONFLICT');
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='gotzji_resource_claims'").get() && database.prepare('SELECT 1 FROM gotzji_resource_claims LIMIT 1').get()) throw new CoreError('UPGRADE_RECONCILIATION_REQUIRED');
      if (database.prepare('SELECT 1 FROM gotzji_writers LIMIT 1').get() || database.prepare("SELECT 1 FROM gotzji_operations WHERE phase IN ('started','uncertain') LIMIT 1").get() || database.prepare("SELECT 1 FROM gotzji_claims c LEFT JOIN goals g ON g.id=c.goal_id WHERE c.goal_id IS NULL OR g.id IS NULL OR g.goal_key<>c.goal_key LIMIT 1").get() || database.prepare("SELECT 1 FROM gotzji_workers w JOIN gotzji_claims c ON c.id=w.job_id JOIN goals g ON g.id=c.goal_id WHERE g.status='active' LIMIT 1").get()) throw new CoreError('UPGRADE_RECONCILIATION_REQUIRED', 'Finish or inspect active/uncertain jobs before changing the runtime policy');
      for (const row of database.prepare('SELECT * FROM gotzji_workers').all()) {
        const worker = row as unknown as WorkerRow;
        // A finished job's worker recorded as stopped or proven gone (incident I8) cannot write stopped.json after a crash.
        if (database.prepare("SELECT 1 FROM gotzji_worker_history WHERE epoch=? AND job_id=? AND reason IN ('stopped','absent')").get(worker.epoch, worker.job_id)) continue;
        const filename = path.join(worker.directory, 'stopped.json');
        if (!existsSync(filename) || lstatSync(filename).isSymbolicLink()) throw new CoreError('UPGRADE_RECONCILIATION_REQUIRED');
        const record = JSON.parse(readFileSync(filename, 'utf8')) as { body: string; mac: string };
        const body = JSON.parse(record.body) as { epoch: string; state: string };
        if (createHmac('sha256', worker.token).update(record.body).digest('hex') !== record.mac || body.epoch !== worker.epoch || body.state !== 'cancelled') throw new CoreError('UPGRADE_RECONCILIATION_REQUIRED');
      }
      const current = statSync(filename, { bigint: true });
      if (identity.dev !== current.dev || identity.ino !== current.ino || identity.birthtimeNs !== current.birthtimeNs) throw new CoreError('CORE_DATABASE_REPLACED');
      database.prepare('UPDATE gotzji_meta SET policy=? WHERE policy=? AND authority_id=?').run(policy, expected.expectedPolicy, expected.expectedAuthorityId);
      database.prepare('UPDATE gotzji_adapters SET policy=? WHERE policy=?').run(policy, expected.expectedPolicy);
      database.prepare('INSERT INTO gotzji_policy_history(from_policy,to_policy,authority_id) VALUES (?,?,?)').run(expected.expectedPolicy, policy, expected.expectedAuthorityId);
      database.exec('COMMIT;');
    } catch (error) { try { database.exec('ROLLBACK;'); } catch { /* closed transaction */ } throw error; }
    finally { database.close(); }
  }
  public static existingPolicy(filename: string): string {
    const anchorFile = path.join(path.dirname(filename), 'authority.json');
    if (!existsSync(filename) || !existsSync(anchorFile)) throw new CoreError('CORE_DATABASE_MISSING');
    const anchor = JSON.parse(readFileSync(anchorFile, 'utf8')) as { authority: string };
    const database = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
    try {
      const meta = database.prepare('SELECT version,policy,authority_id FROM gotzji_meta').get();
      if (meta?.version !== 1 || meta.authority_id !== anchor.authority || typeof meta.policy !== 'string') throw new CoreError('CORE_VERSION_OR_POLICY_CHANGED');
      return meta.policy;
    } finally { database.close(); }
  }
  public constructor(filename: string, policy: string, upgrade?: CoreUpgrade) {
    this.#filename = filename;
    const anchorFile = path.join(path.dirname(filename), 'authority.json');
    const anchored = existsSync(anchorFile);
    if (anchored && !existsSync(filename)) throw new CoreError('CORE_DATABASE_MISSING');
    const authority = anchored ? String((JSON.parse(readFileSync(anchorFile, 'utf8')) as { authority: string }).authority) : secret();
    if (upgrade) {
      if (!anchored) throw new CoreError('UPGRADE_AUTHORITY_DENIED');
      CoreStore.upgradePolicy(filename, policy, upgrade);
    }
    if (anchored && CoreStore.existingPolicy(filename) !== policy) throw new CoreError('CORE_VERSION_OR_POLICY_CHANGED');
    this.database = new SqliteDatabase(filename, { onCanonicalFileReplaced: (): void => { this.#replaced = true; } });
    try {
      if (anchored && !this.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='gotzji_meta'").get()) throw new CoreError('CORE_DATABASE_REPLACED');
      this.database.applyMigration({ id: 'gotzji_001_control', sql: SQL });
      this.database.applyMigration({ id: 'gotzji_002_recipe_operations', sql: 'CREATE TABLE gotzji_recipe_operations (job_id TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL, phase TEXT NOT NULL, receipt TEXT, PRIMARY KEY(job_id,operation_id));' });
      this.database.applyMigration({ id: 'gotzji_003_lifecycle', sql: `
        CREATE TABLE gotzji_mutation_guards (job_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL);
        CREATE TABLE gotzji_diagnostics (job_id TEXT PRIMARY KEY, code TEXT NOT NULL, observed_at TEXT NOT NULL);
        CREATE TABLE gotzji_worker_history (epoch TEXT PRIMARY KEY, job_id TEXT NOT NULL, worker_json TEXT NOT NULL, reason TEXT NOT NULL, observed_at TEXT NOT NULL);
        CREATE TABLE gotzji_operation_history (epoch TEXT PRIMARY KEY, job_id TEXT NOT NULL, operation_json TEXT);
        CREATE TABLE gotzji_recipe_history (epoch TEXT NOT NULL, job_id TEXT NOT NULL, operation_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(epoch,operation_id));
      ` });
      this.database.applyMigration({ id: 'gotzji_004_authorized_jobs', sql: 'CREATE TABLE gotzji_authorized_jobs (job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, intent_digest TEXT NOT NULL, boundary TEXT NOT NULL, policy TEXT NOT NULL, authorization_digest TEXT NOT NULL, intent_revision INTEGER NOT NULL);' });
      this.database.applyMigration({ id: 'gotzji_005_product', sql: `
        CREATE TABLE gotzji_projects (owner TEXT NOT NULL, project_id TEXT NOT NULL, registration TEXT NOT NULL, PRIMARY KEY(owner,project_id));
        CREATE TABLE gotzji_product_jobs (job_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, resource_key TEXT NOT NULL, operation TEXT NOT NULL, waiting_reason TEXT);
        CREATE TABLE gotzji_job_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, event TEXT NOT NULL, observed_at TEXT NOT NULL);
      ` });
      this.database.applyMigration({ id: 'gotzji_006_reviewed_queue', sql: `
        CREATE TABLE gotzji_reviewed_recipes (owner TEXT NOT NULL, recipe_id TEXT NOT NULL, recipe TEXT NOT NULL, PRIMARY KEY(owner,recipe_id));
        CREATE TABLE gotzji_queue (job_id TEXT PRIMARY KEY, enqueue_seq INTEGER NOT NULL UNIQUE, priority INTEGER NOT NULL, enqueued_at INTEGER NOT NULL);
        INSERT INTO gotzji_queue SELECT job_id, rowid, 1, 0 FROM gotzji_product_jobs;
        ALTER TABLE gotzji_product_jobs ADD COLUMN blocking_resource TEXT;
        ALTER TABLE gotzji_product_jobs ADD COLUMN blocking_job TEXT;
        ALTER TABLE gotzji_product_jobs ADD COLUMN blocking_dependency TEXT;
        CREATE TABLE gotzji_provider_limits (owner TEXT PRIMARY KEY, job_id TEXT NOT NULL, retry_at INTEGER, receipt TEXT NOT NULL);
      ` });
      this.database.applyMigration({ id: 'gotzji_007_policy_history', sql: 'CREATE TABLE IF NOT EXISTS gotzji_policy_history (seq INTEGER PRIMARY KEY AUTOINCREMENT,from_policy TEXT NOT NULL,to_policy TEXT NOT NULL,authority_id TEXT NOT NULL);' });
      this.database.applyMigration({ id: 'gotzji_008_native_resources', sql: 'CREATE TABLE gotzji_resource_claims (resource_key TEXT PRIMARY KEY,job_id TEXT NOT NULL,epoch TEXT NOT NULL);' });
      this.database.applyMigration({ id: 'gotzji_009_library_routes', sql: `CREATE TABLE gotzji_library_routes (adapter TEXT NOT NULL,project_id TEXT NOT NULL,route TEXT NOT NULL,PRIMARY KEY(adapter,project_id)); CREATE TABLE gotzji_library_delivery (job_id TEXT NOT NULL,scope TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(job_id,scope));` });
      this.database.applyMigration({ id: 'gotzji_010_project_recipe_bindings', sql: 'CREATE TABLE gotzji_project_recipes (owner TEXT NOT NULL,project_id TEXT NOT NULL,recipe_id TEXT NOT NULL,bound_at TEXT NOT NULL,PRIMARY KEY(owner,project_id,recipe_id));' });
      this.database.connection.prepare('INSERT INTO gotzji_meta SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM gotzji_meta)').run(policy, authority);
      const meta = this.database.connection.prepare('SELECT version,policy,authority_id FROM gotzji_meta').get();
      if (meta?.version !== 1 || meta.policy !== policy || meta.authority_id !== authority) throw new CoreError('CORE_VERSION_OR_POLICY_CHANGED');
      if (!anchored) writeFileSync(anchorFile, JSON.stringify({ authority }), { flag: 'wx', mode: 0o600 });
      this.#identity = this.identity();
    } catch (error) { this.database.close(); throw error; }
  }
  private identity(): string { const s = statSync(this.#filename, { bigint: true }); return `${s.dev}:${s.ino}:${s.birthtimeNs}`; }
  public assertUsable(): void {
    if (!existsSync(this.#filename) || this.identity() !== this.#identity) throw new CoreError('CORE_DATABASE_REPLACED');
    void this.database.connection;
    if (this.#replaced) throw new CoreError('CORE_DATABASE_REPLACED');
  }
  public adapter(credential: string, policy: string): AdapterRow {
    const row = this.database.connection.prepare('SELECT * FROM gotzji_adapters WHERE credential_hash=?').get(hash(credential)) as unknown as AdapterRow | undefined;
    if (!row || row.policy !== policy) throw new CoreError('AUTHORITY_DENIED');
    return row;
  }
  public acceptsPolicy(policy: string, current: string): boolean {
    if (policy === current) return true;
    const authority = this.database.connection.prepare('SELECT authority_id FROM gotzji_meta').get();
    return !!this.database.connection.prepare('WITH RECURSIVE lineage(policy) AS (SELECT ? UNION SELECT h.from_policy FROM gotzji_policy_history h JOIN lineage l ON h.to_policy=l.policy WHERE h.authority_id=?) SELECT 1 FROM lineage WHERE policy=?').get(current, String(authority?.authority_id), policy);
  }
  public claim(jobId: string): ClaimRow {
    const row = this.database.connection.prepare('SELECT * FROM gotzji_claims WHERE id=?').get(jobId) as unknown as ClaimRow | undefined;
    if (!row) throw new CoreError('TASK_NOT_FOUND');
    return row;
  }
  public worker(jobId: string): WorkerRow | undefined {
    return this.database.connection.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(jobId) as unknown as WorkerRow | undefined;
  }
  public operation(jobId: string): OperationRow | undefined {
    return this.database.connection.prepare('SELECT * FROM gotzji_operations WHERE job_id=?').get(jobId) as unknown as OperationRow | undefined;
  }
  public writer(jobId: string): WriterRow | undefined {
    return this.database.connection.prepare('SELECT * FROM gotzji_writers WHERE job_id=?').get(jobId) as unknown as WriterRow | undefined;
  }
  public async acquireGuard(jobId: string): Promise<string> {
    const nonce = secret();
    for (let attempt = 0; attempt < 250; attempt++) {
      this.assertUsable();
      const acquired = this.database.connection.prepare('INSERT OR IGNORE INTO gotzji_mutation_guards VALUES (?,?,?)').run(jobId, process.pid, nonce);
      if (Number(acquired.changes) === 1) return nonce;
      const owner = this.database.connection.prepare('SELECT * FROM gotzji_mutation_guards WHERE job_id=?').get(jobId);
      if (owner && typeof owner.pid === 'number') {
        let absent = false;
        try { process.kill(owner.pid, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        // Unknown/live/reused PIDs are not reclaimed on elapsed time.
        if (absent) this.database.connection.prepare('DELETE FROM gotzji_mutation_guards WHERE job_id=? AND pid=? AND nonce=?').run(jobId, owner.pid, String(owner.nonce));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new CoreError('MUTATION_BUSY');
  }
  public releaseGuard(jobId: string, nonce: string): void {
    // The host may have detached while an admitted call was settling. Use a
    // short connection, checked against the exact canonical file identity.
    if (!existsSync(this.#filename) || this.identity() !== this.#identity) return;
    const database = new DatabaseSync(this.#filename, { timeout: 5000 });
    try { database.prepare('DELETE FROM gotzji_mutation_guards WHERE job_id=? AND pid=? AND nonce=?').run(jobId, process.pid, nonce); }
    finally { database.close(); }
  }
  public diagnose(jobId: string, code: string, observedAt: string): void {
    this.database.connection.prepare('INSERT INTO gotzji_diagnostics VALUES (?,?,?) ON CONFLICT(job_id) DO UPDATE SET code=excluded.code,observed_at=excluded.observed_at').run(jobId, code, observedAt);
  }
  public event(jobId: string, event: string, observedAt: string): void {
    this.database.connection.prepare('INSERT INTO gotzji_job_events(job_id,event,observed_at) VALUES (?,?,?)').run(jobId, event, observedAt);
  }
  public clearDiagnostic(jobId: string): void { this.database.connection.prepare('DELETE FROM gotzji_diagnostics WHERE job_id=?').run(jobId); }
  public archiveWorker(worker: WorkerRow, reason: string, observedAt: string): void {
    this.database.connection.prepare('INSERT OR IGNORE INTO gotzji_worker_history VALUES (?,?,?,?,?)').run(worker.epoch, worker.job_id, JSON.stringify(worker), reason, observedAt);
    const operation = this.operation(worker.job_id);
    this.database.connection.prepare('INSERT OR IGNORE INTO gotzji_operation_history VALUES (?,?,?)').run(worker.epoch, worker.job_id, operation ? JSON.stringify(operation) : null);
    for (const row of this.database.connection.prepare('SELECT * FROM gotzji_recipe_operations WHERE job_id=?').all(worker.job_id)) {
      this.database.connection.prepare('INSERT OR IGNORE INTO gotzji_recipe_history VALUES (?,?,?,?)').run(worker.epoch, worker.job_id, String(row.operation_id), JSON.stringify(row));
    }
  }
  public input(claim: ClaimRow): RequestInput { return JSON.parse(claim.input) as RequestInput; }
  public close(): void { this.database.close(); }
}
