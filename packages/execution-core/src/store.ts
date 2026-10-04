import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
  public constructor(filename: string, policy: string) {
    this.#filename = filename;
    const anchorFile = path.join(path.dirname(filename), 'authority.json');
    const anchored = existsSync(anchorFile);
    if (anchored && !existsSync(filename)) throw new CoreError('CORE_DATABASE_MISSING');
    const authority = anchored ? String((JSON.parse(readFileSync(anchorFile, 'utf8')) as { authority: string }).authority) : secret();
    this.database = new SqliteDatabase(filename, { onCanonicalFileReplaced: (): void => { this.#replaced = true; } });
    try {
      if (anchored && !this.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='gotzji_meta'").get()) throw new CoreError('CORE_DATABASE_REPLACED');
      this.database.applyMigration({ id: 'gotzji_001_control', sql: SQL });
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
  public input(claim: ClaimRow): RequestInput { return JSON.parse(claim.input) as RequestInput; }
  public close(): void { this.database.close(); }
}
