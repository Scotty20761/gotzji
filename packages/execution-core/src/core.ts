import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  GoalContinuationService, GoalMutationFenceService, GoalRequestCancellationService,
  type FileActor, type GoalSnapshot, type GoalTaskCancellationResult,
} from '@lnwjud/application';
import type { Result } from '@lnwjud/domain';
import { SqliteGoalRepository, SqliteWorkspaceRepository } from '@lnwjud/storage';
import { CoreStore, hash, secret, type AdapterRow, type ClaimRow, type WorkerRow } from './store.js';
import { callWorker, launchWorker, observeWorker, stopWorker, workerFingerprint } from './managed-worker.js';
import { signed } from './managed-worker.js';
import { assertGraceProfile, graceProfile, type GraceProfile, type GraceRegistration } from './grace-profile.js';
import { CoreError, type JobView, type Preparation, type RequestInput, type TaskBinding } from './types.js';

const WORKSPACE = 'gotzji-qualification-library';
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new CoreError(result.error.code); return result.value; }

/** Foundation host. Only fixed qualification recipes are executable in this version. */
export class ExecutionCore {
  readonly #store: CoreStore;
  readonly #goals: SqliteGoalRepository;
  readonly #service: GoalContinuationService;
  readonly #root: string;
  readonly #policy: string;
  readonly #now: () => Date;
  readonly #grace: GraceProfile | null;
  readonly #locks = new Map<string, Promise<unknown>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  private constructor(root: string, now: () => Date, grace: GraceRegistration | undefined) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(root);
    this.#now = now;
    this.#grace = grace ? graceProfile(grace) : null;
    this.#policy = this.policyFingerprint();
    this.#store = new CoreStore(path.join(this.#root, 'core.sqlite'), this.#policy);
    this.#goals = new SqliteGoalRepository(this.#store.database);
    const workspaces = new SqliteWorkspaceRepository(this.#store.database);
    const fence = new GoalMutationFenceService(this.#goals, {
      now,
      taskStateReader: { read: async (_workspaceId, task): Promise<'running' | 'absent' | 'unknown'> => {
        const epoch = typeof task === 'string' ? task : task.taskId;
        const row = this.#store.database.connection.prepare('SELECT * FROM gotzji_workers WHERE epoch=?').get(epoch) as unknown as WorkerRow | undefined;
        return row ? observeWorker(row) : 'unknown';
      } },
    });
    this.#service = new GoalContinuationService(workspaces, this.#goals, {
      now, scheduledContinuations: this.#goals, workerLiveness: fence,
      engineeringEvidenceVerifier: { verify: async (): Promise<boolean> => false },
      requestCancellation: new GoalRequestCancellationService(),
      taskCancellation: { cancelForGoal: async (_owner, _workspace, tasks): Promise<readonly GoalTaskCancellationResult[]> => Promise.all(tasks.map(async (task): Promise<GoalTaskCancellationResult> => {
        const taskId = typeof task === 'string' ? task : task.taskId;
        const worker = this.#store.database.connection.prepare('SELECT * FROM gotzji_workers WHERE epoch=?').get(taskId) as unknown as WorkerRow | undefined;
        const stopped = worker ? await stopWorker(worker) : false;
        return { taskId, provider: 'process', status: stopped ? 'cancelled' : 'failed', providers: [] };
      })) },
    });
  }
  public static async open(root: string, options: { now?: () => Date; grace?: GraceRegistration } = {}): Promise<ExecutionCore> {
    const core = new ExecutionCore(root, options.now ?? ((): Date => new Date()), options.grace);
    const workersPath = path.join(core.#root, 'workers');
    if (existsSync(workersPath)) for (const entry of readdirSync(workersPath)) {
      if (existsSync(path.join(workersPath, entry, 'config.json')) && !core.#store.database.connection.prepare('SELECT 1 FROM gotzji_workers WHERE epoch=?').get(entry)) {
        core.close(); throw new CoreError('ORPHAN_WORKER_RECONCILIATION_REQUIRED');
      }
    }
    const workspaces = new SqliteWorkspaceRepository(core.#store.database);
    if (!await workspaces.get(WORKSPACE)) await workspaces.insert({ id: WORKSPACE, displayName: 'Gotzji qualification', rootPath: core.#root, realRootPath: core.#root, createdAt: core.#now().toISOString() });
    return core;
  }
  /** Host-management API; never exposed in the adapter/model tool catalog. */
  public enrollAdapter(adapterId: string, owner: string): string {
    if (!/^[a-z0-9-]{1,64}$/.test(adapterId) || !/^[a-z0-9-]{1,64}$/.test(owner)) throw new CoreError('INVALID_ENROLLMENT');
    const credential = secret();
    this.#store.database.connection.prepare('INSERT INTO gotzji_adapters VALUES (?,?,?,?)').run(adapterId, owner, hash(credential), this.#policy);
    return credential;
  }
  public prepare(credential: string, input: RequestInput): Preparation {
    const adapter = this.authorize(credential);
    const normalized = this.validateInput(input);
    const digest = hash(JSON.stringify({ input: normalized, policy: this.#policy }));
    const id = randomUUID();
    this.#store.database.connection.prepare('INSERT INTO gotzji_preparations VALUES (?,?,?,?,?,?)').run(id, adapter.id, adapter.owner, digest, JSON.stringify(normalized), this.#policy);
    return { preparationId: id, digest };
  }
  public prepareSourceSnapshot(credential: string, requestId: string): Preparation {
    if (!this.#grace) throw new CoreError('GRACE_NOT_REGISTERED');
    return this.prepare(credential, { requestId, operation: 'grace.read-save-check', text: readFileSync(this.#grace.sourceFile, 'utf8') });
  }
  public async submit(credential: string, preparationId: string): Promise<JobView> {
    const adapter = this.authorize(credential);
    const preparation = this.#store.database.connection.prepare('SELECT * FROM gotzji_preparations WHERE id=?').get(preparationId);
    if (!preparation || preparation.adapter !== adapter.id || preparation.policy !== this.#policy) throw new CoreError('PREPARATION_DENIED');
    const input = this.validateInput(JSON.parse(String(preparation.input)) as RequestInput);
    const id = hash(`${adapter.owner}\0${input.requestId}`);
    this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_claims VALUES (?,?,?,?,?,?,NULL,?)').run(id, adapter.owner, input.requestId, String(preparation.digest), JSON.stringify(input), `gotzji-${id}`, this.#policy);
    const claim = this.#store.claim(id);
    if (claim.digest !== preparation.digest) throw new CoreError('REQUEST_DIGEST_CONFLICT');
    await this.serial(id, async (): Promise<void> => { await this.ensureGoal(claim); });
    return this.view(claim);
  }
  /** Explicit task selection plus verified enrollment, returning adapter-private authority. */
  public select(credential: string, jobId: string): TaskBinding {
    const adapter = this.authorize(credential);
    const claim = this.#store.claim(jobId);
    if (claim.owner !== adapter.owner || claim.policy !== this.#policy) throw new CoreError('TASK_AUTHORITY_DENIED');
    const handle = secret();
    this.#store.database.connection.prepare('INSERT INTO gotzji_bindings VALUES (?,?,?,?)').run(hash(handle), adapter.id, jobId, this.#policy);
    return { jobId, handle };
  }
  public async get(credential: string, binding: TaskBinding): Promise<JobView> { return this.view(this.bound(credential, binding)); }
  public async result(credential: string, binding: TaskBinding): Promise<JobView> { return this.get(credential, binding); }
  public async resume(credential: string, binding: TaskBinding): Promise<JobView> {
    const claim = this.bound(credential, binding);
    return this.serial(claim.id, async (): Promise<JobView> => {
      const goal = await this.ensureGoal(claim);
      if (goal.status !== 'active') { await this.cleanupTerminal(claim); return this.view(claim); }
      let worker = this.#store.worker(claim.id);
      if (worker) {
        const observation = await observeWorker(worker);
        if (observation === 'unknown') throw new CoreError('WORKER_RECONCILIATION_REQUIRED');
        if (observation === 'running') { await this.reconcile(claim, worker); return this.view(claim); }
        // The process is proven absent; inspect before any new epoch or replay.
        if (this.verifyEffect(claim)) {
          await this.reacquire(claim, worker);
          await this.complete(claim, this.requireWorker(claim.id));
          return this.view(claim);
        }
        const operation = this.#store.operation(claim.id);
        if (operation?.phase === 'started' || operation?.phase === 'uncertain') {
          this.markUncertain(claim.id);
          throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
        }
        this.#store.database.connection.prepare('DELETE FROM gotzji_workers WHERE job_id=?').run(claim.id);
        this.releaseWriter(claim.id, worker.epoch);
      }
      const epoch = randomUUID();
      const writer = this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_writers VALUES (?,?,?)').run(this.#root, claim.id, epoch);
      if (Number(writer.changes) !== 1) throw new CoreError('LIBRARY_WRITER_HELD');
      const directory = path.join(this.#root, 'workers', epoch);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const effectRoot = this.effectRoot(claim.id);
      mkdirSync(effectRoot, { recursive: true, mode: 0o700 });
      const session = `worker-${epoch}`;
      const acquired = unwrap(await this.#service.runGoal(this.actor(claim, session), { workspaceId: WORKSPACE, goalKey: claim.goal_key, leaseSeconds: 300 }));
      if (!acquired.acquired || !acquired.leaseToken) throw new CoreError('LEASE_NOT_ACQUIRED');
      this.#store.database.connection.prepare('INSERT INTO gotzji_workers VALUES (?,?,?,?,?,?,?,?,?)').run(claim.id, epoch, session, acquired.leaseToken, acquired.leaseGeneration, directory, secret(), 'reserved', this.#now().getTime());
      worker = this.requireWorker(claim.id);
      await this.checkpoint(claim, worker, 'queued');
      const input = this.#store.input(claim);
      this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_operations VALUES (?,?,?,NULL)').run(claim.id, this.operationDigest(claim), 'reserved');
      await this.validateWorker(claim, worker);
      this.#store.database.connection.prepare('UPDATE gotzji_workers SET launch_state=? WHERE job_id=?').run('launching', claim.id);
      await launchWorker(worker, realpathSync(effectRoot), input.operation, input.text, { jobId: claim.id, owner: claim.owner, policy: this.#policy, database: path.join(this.#root,'core.sqlite'), intentRevision: acquired.userIntentRevision, grace: input.operation === 'grace.read-save-check' ? this.#grace : null });
      this.#store.database.connection.prepare('UPDATE gotzji_workers SET launch_state=? WHERE job_id=?').run('ready', claim.id);
      await this.startReserved(claim, worker);
      return this.view(claim);
    });
  }
  public async cancel(credential: string, binding: TaskBinding): Promise<JobView> {
    const claim = this.bound(credential, binding);
    return this.serial(claim.id, async (): Promise<JobView> => {
      const goal = await this.ensureGoal(claim);
      if (goal.status !== 'active') { await this.cleanupTerminal(claim); return this.view(claim); }
      this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=? WHERE job_id=? AND phase != ?').run('revoked', claim.id, 'verified');
      unwrap(await this.#service.cancelGoal(this.actor(claim, 'cancel'), { goalId: goal.goalId, expectedRevision: goal.revision, summary: 'Owner requested cancellation', evidence: [] }));
      await this.cleanupTerminal(claim);
      return this.view(claim);
    });
  }
  /** Host supervisor tick: no caller credentials, receipt booleans or executables accepted. */
  public async tick(): Promise<void> {
    this.assertOpen();
    const claims = this.#store.database.connection.prepare('SELECT * FROM gotzji_claims WHERE goal_id IS NOT NULL').all() as unknown as ClaimRow[];
    for (const claim of claims) await this.serial(claim.id, async (): Promise<void> => {
      const worker = this.#store.worker(claim.id);
      if (!worker) return;
      const goal = await this.snapshot(claim);
      if (goal.status !== 'active') { await this.cleanupTerminal(claim); return; }
      await this.reconcile(claim, worker);
    });
  }
  public startSupervisor(): void {
    this.assertOpen();
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick().catch(() => { /* Persisted in-flight ownership stays held on uncertainty. */ }); }, 1000);
    this.#timer.unref();
  }
  /** Detach the host only. Durable workers keep running and can be adopted by a reopened host. */
  public close(): void { if (this.#timer) clearInterval(this.#timer); this.#closed = true; this.#store.close(); }

  private assertOpen(): void {
    if (this.#closed) throw new CoreError('CORE_CLOSED');
    this.#store.assertUsable();
    if (this.#grace) assertGraceProfile(this.#grace);
    if (realpathSync(this.#root) !== this.#root || this.#policy !== this.policyFingerprint()) throw new CoreError('CORE_DEPENDENCIES_CHANGED');
    const meta = this.#store.database.connection.prepare('SELECT version,policy FROM gotzji_meta').get();
    if (meta?.version !== 1 || meta.policy !== this.#policy) throw new CoreError('CORE_VERSION_OR_POLICY_CHANGED');
  }
  private policyFingerprint(): string { return hash(JSON.stringify({ version: 2, root: this.#root, worker: workerFingerprint(), grace: this.#grace, recipes: ['fixture.write','fixture.hold',...(this.#grace ? ['grace.read-save-check'] : [])], curation: 'explicit-only' })); }
  private authorize(credential: string): AdapterRow { this.assertOpen(); return this.#store.adapter(credential, this.#policy); }
  private bound(credential: string, binding: TaskBinding): ClaimRow {
    const adapter = this.authorize(credential);
    const row = this.#store.database.connection.prepare('SELECT * FROM gotzji_bindings WHERE handle_hash=? AND adapter=? AND job_id=? AND policy=?').get(hash(binding.handle), adapter.id, binding.jobId, this.#policy);
    const claim = this.#store.claim(binding.jobId);
    if (!row || claim.owner !== adapter.owner) throw new CoreError('TASK_AUTHORITY_DENIED');
    return claim;
  }
  private validateInput(input: RequestInput): RequestInput {
    if (!input || Object.keys(input).sort().join(',') !== 'operation,requestId,text' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId) || !['fixture.write', 'fixture.hold','grace.read-save-check'].includes(input.operation) || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 65536) throw new CoreError('INVALID_REQUEST');
    if (input.operation === 'grace.read-save-check' && (!this.#grace || hash(input.text) !== this.#grace.sourceHash)) throw new CoreError('GRACE_PREPARATION_DENIED');
    return { requestId: input.requestId, operation: input.operation, text: input.text };
  }
  private actor(claim: ClaimRow, session: string): FileActor { return { clientId: claim.owner, clientName: 'Gotzji execution core', sessionId: session }; }
  private async snapshot(claim: ClaimRow): Promise<GoalSnapshot> { return unwrap(await this.#service.getGoal(this.actor(claim, 'core'), { workspaceId: WORKSPACE, goalKey: claim.goal_key })); }
  private async ensureGoal(claim: ClaimRow): Promise<GoalSnapshot> {
    const existing = await this.#goals.getByKey(WORKSPACE, claim.goal_key);
    if (!existing) {
      const result = unwrap(await this.#service.runGoal(this.actor(claim, `preparing-${claim.id}`), { workspaceId: WORKSPACE, goalKey: claim.goal_key, objective: 'Qualify governed execution', plan: { steps: [{ id: 'effect', title: 'Execute and independently verify the fixed qualification recipe' }] }, leaseSeconds: 300 }));
      if (result.acquired && result.leaseToken) unwrap(await this.#service.checkpointGoal(this.actor(claim, `preparing-${claim.id}`), { goalId: result.goalId, leaseToken: result.leaseToken, expectedRevision: result.revision, currentPhase: 'queued', summary: 'Durable request accepted; execution not started', stepUpdates: [], nextAction: 'Acquire controlled worker', blockers: [], evidence: [], releaseLease: true }));
    }
    const goal = await this.snapshot(claim);
    this.#store.database.connection.prepare('UPDATE gotzji_claims SET goal_id=? WHERE id=? AND (goal_id IS NULL OR goal_id=?)').run(goal.goalId, claim.id, goal.goalId);
    return goal;
  }
  private async view(claim: ClaimRow): Promise<JobView> {
    this.assertOpen();
    const goal = await this.snapshot(claim);
    const operation = this.#store.operation(claim.id);
    const held = !!this.#store.database.connection.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=?').get(claim.id);
    let status: JobView['status'] = goal.status === 'active' ? 'queued' : goal.status;
    if (goal.status === 'active' && this.#store.worker(claim.id)) status = operation?.phase === 'verified' ? 'verifying' : 'running';
    if (operation?.phase === 'uncertain' || (goal.status !== 'active' && held)) status = 'blocked';
    const result: JobView = { jobId: claim.id, status, revision: goal.revision, operation: this.#store.input(claim).operation, evidenceDigest: operation?.receipt ? hash(operation.receipt) : null, curation: 'explicit-only' };
    return result;
  }
  private effectRoot(jobId: string): string { return path.join(this.#root, 'effects', jobId); }
  private operationDigest(claim: ClaimRow): string { return hash(JSON.stringify({ job: claim.id, intent: claim.digest, policy: this.#policy, recipe: this.#store.input(claim) })); }
  private requireWorker(jobId: string): WorkerRow { const worker = this.#store.worker(jobId); if (!worker) throw new CoreError('WORKER_NOT_FOUND'); return worker; }
  private async validateWorker(claim: ClaimRow, worker: WorkerRow): Promise<void> {
    this.assertOpen();
    const current = this.requireWorker(claim.id);
    const writer = this.#store.database.connection.prepare('SELECT * FROM gotzji_writers WHERE root=?').get(this.#root);
    if (current.epoch !== worker.epoch || writer?.job_id !== claim.id || writer.epoch !== worker.epoch) throw new CoreError('WORKER_FENCE_INVALID');
    const goal = unwrap(await this.#service.validateGoalLease(this.actor(claim, worker.session), { goalId: (await this.snapshot(claim)).goalId, leaseToken: worker.lease }));
    if (goal.leaseGeneration !== worker.generation) throw new CoreError('WORKER_FENCE_INVALID');
  }
  private async checkpoint(claim: ClaimRow, worker: WorkerRow, phase: string, complete = false): Promise<void> {
    const goal = await this.snapshot(claim);
    unwrap(await this.#service.checkpointGoal(this.actor(claim, worker.session), { goalId: goal.goalId, leaseToken: worker.lease, expectedRevision: goal.revision, currentPhase: phase, summary: `Core observed ${phase}`, stepUpdates: complete ? [{ stepId: 'effect', status: 'completed', summary: 'Independent receipt verified' }] : [], nextAction: complete ? '' : 'Observe governed effect', blockers: [], evidence: [], trackedTasks: complete ? [] : [{ taskId: worker.epoch, provider: 'process', role: 'blocking_job', cancelWithGoal: true }] }));
    this.#store.database.connection.prepare('UPDATE gotzji_workers SET last_renewed=? WHERE job_id=? AND epoch=?').run(this.#now().getTime(), claim.id, worker.epoch);
  }
  private async startReserved(claim: ClaimRow, worker: WorkerRow): Promise<void> {
    await this.validateWorker(claim, worker);
    const operation = this.#store.operation(claim.id);
    if (operation?.digest !== this.operationDigest(claim) || operation.phase !== 'reserved') throw new CoreError('OPERATION_FENCE_INVALID');
    const changed = this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=? WHERE job_id=? AND phase=?').run('started', claim.id, 'reserved');
    if (Number(changed.changes) !== 1) throw new CoreError('OPERATION_FENCE_INVALID');
    await callWorker(worker, 'start');
    await this.checkpoint(claim, worker, 'running');
  }
  private verifyEffect(claim: ClaimRow, requireGraceCompletion = true): boolean {
    const input = this.#store.input(claim);
    const operation = this.#store.operation(claim.id);
    if (!operation || operation.digest !== this.operationDigest(claim)) throw new CoreError('OPERATION_FENCE_INVALID');
    if (input.operation === 'fixture.hold') return false;
    const filename = path.join(this.effectRoot(claim.id), 'result.txt');
    if (!existsSync(filename)) return false;
    if (realpathSync(this.effectRoot(claim.id)) !== this.effectRoot(claim.id) || lstatSync(filename).isSymbolicLink()) { this.markUncertain(claim.id); throw new CoreError('EFFECT_ROOT_CHANGED'); }
    const effect = readFileSync(filename);
    if (hash(effect) !== hash(input.text)) {
      this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=? WHERE job_id=?').run('uncertain', claim.id);
      throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    }
    if (input.operation === 'grace.read-save-check' && requireGraceCompletion) this.verifyGraceExecution(claim);
    const receipt = JSON.stringify({ recipe: input.operation, recipeDigest: operation.digest, artifactHash: hash(effect), bytes: effect.byteLength, verifier: 'host-file-sha256-v1' });
    this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=?,receipt=? WHERE job_id=?').run('verified', receipt, claim.id);
    return true;
  }
  private verifyGraceExecution(claim: ClaimRow): void {
    const worker = this.requireWorker(claim.id);
    const runtime = signed<{ mode: string; exitCode: number; eventsHash: string; apiKeySource: string; model: string }>(worker, 'grace-runtime.json');
    if (!runtime || runtime.mode !== this.#grace?.mode || runtime.exitCode !== 0 || runtime.apiKeySource !== 'none' || runtime.eventsHash !== hash(readFileSync(path.join(worker.directory,'claude-events.jsonl')))) throw new CoreError('GRACE_RUNTIME_EVIDENCE_REQUIRED');
    for (const id of ['policy:rules','policy:agents','policy:workflow','policy:index','read_source','save_result','check_result']) {
      const row = this.#store.database.connection.prepare('SELECT * FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(claim.id,id);
      if (!row || row.phase !== 'verified' || typeof row.receipt !== 'string') throw new CoreError('GRACE_OPERATION_EVIDENCE_REQUIRED');
      if (id === 'check_result') {
        const receipt = JSON.parse(row.receipt) as { exitCode: number; sha256: string; verifierHash: string };
        if (receipt.exitCode !== 0 || receipt.sha256 !== this.#grace?.sourceHash || receipt.verifierHash !== hash(readFileSync(new URL('./grace-verifier.mjs', import.meta.url)))) throw new CoreError('GRACE_CHECK_EVIDENCE_REQUIRED');
      }
    }
  }
  private async reconcile(claim: ClaimRow, worker: WorkerRow): Promise<void> {
    const observed = await observeWorker(worker);
    if (observed === 'unknown') { this.markUncertain(claim.id); throw new CoreError('WORKER_RECONCILIATION_REQUIRED'); }
    if (observed === 'absent') {
      if (!this.verifyEffect(claim)) { this.markUncertain(claim.id); throw new CoreError('EFFECT_RECONCILIATION_REQUIRED'); }
      await this.reacquire(claim, worker);
      await this.complete(claim, this.requireWorker(claim.id));
      return;
    }
    const observation = await callWorker(worker, 'status');
    if (observation.state === 'ready') {
      if (this.#store.operation(claim.id)?.phase === 'reserved') await this.startReserved(claim, worker);
      else throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    } else if (observation.state === 'done') {
      if (this.verifyEffect(claim)) await this.complete(claim, worker);
    } else if (observation.state === 'failed' || observation.state === 'cancelled') {
      this.markUncertain(claim.id);
      throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    } else if (this.#now().getTime() - worker.last_renewed >= 30000) {
      await this.validateWorker(claim, worker);
      await this.checkpoint(claim, worker, 'running');
    }
  }
  private async reacquire(claim: ClaimRow, worker: WorkerRow): Promise<void> {
    if (await observeWorker(worker) !== 'absent') throw new CoreError('WORKER_RECONCILIATION_REQUIRED');
    const session = `reconciler-${randomUUID()}`;
    const acquired = unwrap(await this.#service.runGoal(this.actor(claim, session), { workspaceId: WORKSPACE, goalKey: claim.goal_key, leaseSeconds: 300 }));
    if (!acquired.acquired || !acquired.leaseToken) throw new CoreError('LEASE_NOT_ACQUIRED');
    this.#store.database.connection.prepare('UPDATE gotzji_workers SET session=?,lease=?,generation=? WHERE job_id=? AND epoch=?').run(session, acquired.leaseToken, acquired.leaseGeneration, claim.id, worker.epoch);
  }
  private async complete(claim: ClaimRow, worker: WorkerRow): Promise<void> {
    await this.validateWorker(claim, worker);
    if (!this.verifyEffect(claim)) throw new CoreError('COMPLETION_EVIDENCE_REQUIRED');
    if (!await stopWorker(worker)) throw new CoreError('CLEANUP_RECONCILIATION_REQUIRED');
    await this.checkpoint(claim, worker, 'verifying', true);
    const goal = await this.snapshot(claim);
    const receipt = this.#store.operation(claim.id)?.receipt;
    if (!receipt) throw new CoreError('COMPLETION_EVIDENCE_REQUIRED');
    unwrap(await this.#service.finishGoal(this.actor(claim, worker.session), { goalId: goal.goalId, leaseToken: worker.lease, expectedRevision: goal.revision, status: 'completed', summary: 'Backend verified effect and owned process cleanup', evidence: [{ kind: 'hash', value: hash(receipt) }] }));
    this.releaseWriter(claim.id, worker.epoch);
    const view = await this.view(claim);
    this.#store.database.connection.prepare('INSERT INTO gotzji_outbox(job_id,view) VALUES (?,?)').run(claim.id, JSON.stringify(view));
  }
  private async cleanupTerminal(claim: ClaimRow): Promise<void> {
    const worker = this.#store.worker(claim.id);
    if (!worker) return;
    if (!await stopWorker(worker)) throw new CoreError('CLEANUP_RECONCILIATION_REQUIRED');
    const input = this.#store.input(claim);
    if (input.operation !== 'fixture.hold' && existsSync(path.join(this.effectRoot(claim.id), 'result.txt'))) this.verifyEffect(claim, false);
    this.releaseWriter(claim.id, worker.epoch);
  }
  private releaseWriter(jobId: string, epoch: string): void { this.#store.database.connection.prepare('DELETE FROM gotzji_writers WHERE job_id=? AND epoch=?').run(jobId, epoch); }
  private markUncertain(jobId: string): void { this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=? WHERE job_id=?').run('uncertain', jobId); }
  private async serial<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(jobId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.#locks.set(jobId, next);
    try { return await next; } finally { if (this.#locks.get(jobId) === next) this.#locks.delete(jobId); }
  }
}
