import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GoalContinuationService, GoalMutationFenceService, GoalRequestCancellationService,
  type FileActor, type GoalSnapshot, type GoalTaskCancellationResult,
} from '@lnwjud/application';
import { isEngineeringGateEvidenceFailureReason, type Result } from '@lnwjud/domain';
import { RuntimeEngineeringEvidenceVerifier } from '@lnwjud/mcp-server/engineering-evidence-verifier';
import { SqliteGoalRepository, SqliteWorkspaceRepository } from '@lnwjud/storage';
import { CoreStore, hash, secret, type AdapterRow, type ClaimRow, type WorkerRow } from './store.js';
import { callWorker, launchWorker, observeWorker, stopWorker, workerFingerprint } from './managed-worker.js';
import { signed } from './managed-worker.js';
import { assertGraceProfile, graceProfile, type GraceProfile, type GraceRegistration } from './grace-profile.js';
import { CoreError, type JobView, type Preparation, type RequestInput, type TaskBinding, type CodeRunReceipt } from './types.js';

const WORKSPACE = 'gotzji-qualification-library';
const MUTATION_QUEUES = new Map<string, Promise<unknown>>();
function unwrap<T>(result: Result<T>): T { if (!result.ok) {const reason=result.error.details?.reason;throw new CoreError(result.error.code,isEngineeringGateEvidenceFailureReason(reason)?reason:undefined);} return result.value; }

/** Foundation host. Only fixed qualification recipes are executable in this version. */
export class ExecutionCore {
  readonly #store: CoreStore;
  readonly #goals: SqliteGoalRepository;
  readonly #service: GoalContinuationService;
  readonly #root: string;
  readonly #policy: string;
  readonly #now: () => Date;
  readonly #grace: GraceProfile | null;
  readonly #controlOnly: boolean;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  private constructor(root: string, now: () => Date, grace: GraceRegistration | undefined, controlOnly: boolean) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(root);
    this.#now = now;
    this.#controlOnly = controlOnly;
    this.#grace = !controlOnly && grace ? graceProfile(grace) : null;
    this.#policy = controlOnly ? CoreStore.existingPolicy(path.join(this.#root,'core.sqlite')) : this.policyFingerprint();
    this.#store = new CoreStore(path.join(this.#root, 'core.sqlite'), this.#policy);
    this.#goals = new SqliteGoalRepository(this.#store.database);
    const workspaces = new SqliteWorkspaceRepository(this.#store.database);
    const fence = new GoalMutationFenceService(this.#goals, {
      now,
      taskStateReader: { read: async (_workspaceId, task): Promise<'running' | 'terminal' | 'absent' | 'unknown'> => {
        const epoch = typeof task === 'string' ? task : task.taskId;
        const row = this.#store.database.connection.prepare('SELECT * FROM gotzji_workers WHERE epoch=?').get(epoch) as unknown as WorkerRow | undefined;
        if (row) return observeWorker(row);
        const retired = this.#store.database.connection.prepare('SELECT reason FROM gotzji_worker_history WHERE epoch=?').get(epoch);
        return retired && ['stopped','not_launched'].includes(String(retired.reason)) ? 'terminal' : 'unknown';
      } },
    });
    this.#service = new GoalContinuationService(workspaces, this.#goals, {
      now, scheduledContinuations: this.#goals, workerLiveness: fence,
      engineeringEvidenceVerifier: new RuntimeEngineeringEvidenceVerifier({ requireGoalBinding: true, shell: { statusForGoalLiveness: async (_workspace, runId): Promise<Result<unknown>> => {
        for (const row of this.#store.database.connection.prepare('SELECT * FROM gotzji_claims WHERE goal_id IS NOT NULL').all()) {
          const claim = row as unknown as ClaimRow; const worker = this.#store.worker(claim.id);
          if (!worker) continue;
          try {
            const receipt = this.codeRun(claim,worker);
            if (receipt?.runId === runId) return {ok:true,value:{
              state:receipt.state==='failed'?'completed':receipt.state,
              exit_code:receipt.exitCode,
              command_fingerprint:receipt.commandFingerprint,
              goal_id:claim.goal_id,
              owner_client_id:claim.owner,
              user_intent_revision:receipt.intentRevision,
            }};
          } catch { /* another job's bad receipt cannot starve this run */ }
        }
        return {ok:false,error:{code:'PROCESS_NOT_FOUND',message:'Host run not found',recoverable:false}};
      } } }),
      requestCancellation: new GoalRequestCancellationService(),
      taskCancellation: { cancelForGoal: async (_owner, _workspace, tasks): Promise<readonly GoalTaskCancellationResult[]> => Promise.all(tasks.map(async (task): Promise<GoalTaskCancellationResult> => {
        const taskId = typeof task === 'string' ? task : task.taskId;
        const worker = this.#store.database.connection.prepare('SELECT * FROM gotzji_workers WHERE epoch=?').get(taskId) as unknown as WorkerRow | undefined;
        const stopped = worker ? await stopWorker(worker) : false;
        return { taskId, provider: 'process', status: stopped ? 'cancelled' : 'failed', providers: [] };
      })) },
    });
  }
  public static async open(root: string, options: { now?: () => Date; grace?: GraceRegistration; controlOnly?: boolean } = {}): Promise<ExecutionCore> {
    const core = new ExecutionCore(root, options.now ?? ((): Date => new Date()), options.grace, options.controlOnly === true);
    const workersPath = path.join(core.#root, 'workers');
    if (existsSync(workersPath)) for (const entry of readdirSync(workersPath)) {
      if (existsSync(path.join(workersPath, entry, 'config.json')) && !core.#store.database.connection.prepare('SELECT 1 FROM gotzji_workers WHERE epoch=? UNION ALL SELECT 1 FROM gotzji_worker_history WHERE epoch=?').get(entry,entry)) {
        core.close(); throw new CoreError('ORPHAN_WORKER_RECONCILIATION_REQUIRED');
      }
    }
    const workspaces = new SqliteWorkspaceRepository(core.#store.database);
    if (!await workspaces.get(WORKSPACE)) await workspaces.insert({ id: WORKSPACE, displayName: 'Gotzji qualification', rootPath: core.#root, realRootPath: core.#root, createdAt: core.#now().toISOString() });
    return core;
  }
  public static async openForControl(root: string): Promise<ExecutionCore> { return ExecutionCore.open(root,{controlOnly:true}); }
  /** Host-management API; never exposed in the adapter/model tool catalog. */
  public enrollAdapter(adapterId: string, owner: string): string {
    this.assertEffects();
    if (!/^[a-z0-9-]{1,64}$/.test(adapterId) || !/^[a-z0-9-]{1,64}$/.test(owner)) throw new CoreError('INVALID_ENROLLMENT');
    const credential = secret();
    this.#store.database.connection.prepare('INSERT INTO gotzji_adapters VALUES (?,?,?,?)').run(adapterId, owner, hash(credential), this.#policy);
    return credential;
  }
  public prepare(credential: string, input: RequestInput): Preparation {
    const adapter = this.authorize(credential, true);
    const normalized = this.validateInput(input);
    const digest = hash(JSON.stringify({ input: normalized, policy: this.#policy }));
    const id = randomUUID();
    this.#store.database.connection.prepare('INSERT INTO gotzji_preparations VALUES (?,?,?,?,?,?)').run(id, adapter.id, adapter.owner, digest, JSON.stringify(normalized), this.#policy);
    return { preparationId: id, digest };
  }
  public prepareSourceSnapshot(credential: string, requestId: string): Preparation {
    this.authorize(credential, true);
    if (!this.#grace) throw new CoreError('GRACE_NOT_REGISTERED');
    return this.prepare(credential, { requestId, operation: 'grace.read-save-check', text: readFileSync(this.#grace.sourceFile, 'utf8') });
  }
  public prepareCodeChange(credential: string, requestId: string, requestedDelivery = 'local'): Preparation {
    this.authorize(credential,true);
    if (requestedDelivery !== 'local') throw new CoreError('DELIVERY_SCOPE_DENIED');
    if (this.#grace?.recipe !== 'code-check' || this.#grace.expectedContent === null) throw new CoreError('CODE_RECIPE_NOT_REGISTERED');
    return this.prepare(credential,{requestId,operation:'grace.code-check',text:this.#grace.expectedContent});
  }
  public async submit(credential: string, preparationId: string): Promise<JobView> {
    const adapter = this.authorize(credential, true);
    const preparation = this.#store.database.connection.prepare('SELECT * FROM gotzji_preparations WHERE id=?').get(preparationId);
    if (!preparation || preparation.adapter !== adapter.id || preparation.policy !== this.#policy) throw new CoreError('PREPARATION_DENIED');
    const input = this.validateInput(JSON.parse(String(preparation.input)) as RequestInput);
    const id = hash(`${adapter.owner}\0${input.requestId}`);
    this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_claims VALUES (?,?,?,?,?,?,NULL,?)').run(id, adapter.owner, input.requestId, String(preparation.digest), JSON.stringify(input), `gotzji-${id}`, this.#policy);
    const claim = this.#store.claim(id);
    if (claim.digest !== preparation.digest) throw new CoreError('REQUEST_DIGEST_CONFLICT');
    await this.serial(id, async (): Promise<void> => {
      const authorization = hash(JSON.stringify({owner:claim.owner,intent:claim.digest,boundary:'local',policy:this.#policy,revision:0}));
      this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_authorized_jobs VALUES (?,?,?,?,?,?,?)').run(claim.id,claim.owner,claim.digest,'local',this.#policy,authorization,0);
      await this.ensureGoal(claim);
    });
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
  public async readCodeResult(credential: string, binding: TaskBinding): Promise<{sha256:string;content:string}> {
    const claim=this.bound(credential,binding);
    if(this.#store.input(claim).operation!=='grace.code-check'||(await this.view(claim)).status!=='completed') throw new CoreError('RESULT_NOT_VERIFIED');
    const filename=path.join(this.effectRoot(claim.id),'result.txt');
    if(lstatSync(filename).isSymbolicLink()) throw new CoreError('EFFECT_ROOT_CHANGED');
    const bytes=readFileSync(filename);
    if(hash(bytes)!==hash(this.#store.input(claim).text)) throw new CoreError('ARTIFACT_CHANGED');
    return {sha256:hash(bytes),content:bytes.toString('utf8')};
  }
  public logs(credential:string,binding:TaskBinding,cursor=0,limit=4000):{text:string;nextCursor:number} {
    const claim=this.bound(credential,binding);const worker=this.#store.worker(claim.id);
    if(!worker||!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>16000) throw new CoreError('INVALID_LOG_CURSOR');
    const filename=path.join(worker.directory,'validation.stdout');
    if(!existsSync(filename)) return {text:'',nextCursor:cursor};
    const info=lstatSync(filename);if(info.isSymbolicLink()||cursor>info.size) throw new CoreError('INVALID_LOG_CURSOR');
    const fd=openSync(filename,'r');try{const buffer=Buffer.alloc(Math.min(limit,info.size-cursor));const count=readSync(fd,buffer,0,buffer.length,cursor);return {text:buffer.subarray(0,count).toString('utf8'),nextCursor:cursor+count};}finally{closeSync(fd);}
  }
  public async resume(credential: string, binding: TaskBinding): Promise<JobView> {
    const claim = this.bound(credential, binding, true);
    return this.serial(claim.id, async (): Promise<JobView> => {
      this.assertEffects();
      await this.resumeClaim(claim);
      this.#store.clearDiagnostic(claim.id);
      return this.view(claim);
    });
  }
  private async resumeClaim(claim: ClaimRow): Promise<JobView> {
      const goal = await this.ensureGoal(claim);
      if (goal.status !== 'active') { await this.cleanupTerminal(claim); this.#store.clearDiagnostic(claim.id); return this.view(claim); }
      const worker = this.#store.worker(claim.id);
      if (!worker && this.#store.writer(claim.id)) await this.reconcileUnlaunchedWriter(claim);
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
      return this.launchClaim(claim);
  }
  private async launchClaim(claim: ClaimRow, recovered?: WorkerRow): Promise<JobView> {
      const epoch = randomUUID();
      if (!recovered) {
        const writer = this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_writers VALUES (?,?,?)').run(this.#root, claim.id, epoch);
        if (Number(writer.changes) !== 1) throw new CoreError('LIBRARY_WRITER_HELD');
      }
      try {
      const directory = path.join(this.#root, 'workers', epoch);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const effectRoot = this.effectRoot(claim.id);
      mkdirSync(effectRoot, { recursive: true, mode: 0o700 });
      const session = recovered?.session ?? `worker-${epoch}`;
      const acquired = recovered ? { acquired:true,leaseToken:recovered.lease,leaseGeneration:recovered.generation,userIntentRevision:(await this.snapshot(claim)).userIntentRevision } : unwrap(await this.#service.runGoal(this.actor(claim, session), { workspaceId: WORKSPACE, goalKey: claim.goal_key, leaseSeconds: 300 }));
      if (!acquired.acquired || !acquired.leaseToken) throw new CoreError('LEASE_NOT_ACQUIRED');
      if (recovered) this.resetForReplay(claim, recovered, epoch);
      this.#store.database.connection.prepare('INSERT INTO gotzji_workers VALUES (?,?,?,?,?,?,?,?,?)').run(claim.id, epoch, session, acquired.leaseToken, acquired.leaseGeneration, directory, secret(), 'reserved', this.#now().getTime());
      const worker = this.requireWorker(claim.id);
      await this.checkpoint(claim, worker, 'queued');
      const input = this.#store.input(claim);
      this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_operations VALUES (?,?,?,NULL)').run(claim.id, this.operationDigest(claim), 'reserved');
      await this.validateWorker(claim, worker);
      this.#store.database.connection.prepare('UPDATE gotzji_workers SET launch_state=? WHERE job_id=?').run('launching', claim.id);
      const authorization = this.#store.database.connection.prepare('SELECT authorization_digest FROM gotzji_authorized_jobs WHERE job_id=?').get(claim.id);
      await launchWorker(worker, realpathSync(effectRoot), input.operation, input.text, { jobId: claim.id, owner: claim.owner, policy: this.#policy, database: path.join(this.#root,'core.sqlite'), intentRevision: acquired.userIntentRevision, authorizationDigest:String(authorization?.authorization_digest), grace: input.operation.startsWith('grace.') ? this.#grace : null });
      this.#store.database.connection.prepare('UPDATE gotzji_workers SET launch_state=? WHERE job_id=?').run('ready', claim.id);
      await this.startReserved(claim, worker);
      return this.view(claim);
      } catch (error) { await this.compensateUnlaunched(claim, epoch); throw error; }
  }
  public async cancel(credential: string, binding: TaskBinding): Promise<JobView> {
    const claim = this.bound(credential, binding);
    return this.serial(claim.id, async (): Promise<JobView> => {
      const goal = await this.ensureGoal(claim);
      if (goal.status !== 'active') { await this.cleanupTerminal(claim); this.#store.clearDiagnostic(claim.id); return this.view(claim); }
      this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=? WHERE job_id=? AND phase != ?').run('revoked', claim.id, 'verified');
      unwrap(await this.#service.cancelGoal(this.actor(claim, 'cancel'), { goalId: goal.goalId, expectedRevision: goal.revision, summary: 'Owner requested cancellation', evidence: [] }));
      await this.cleanupTerminal(claim);
      this.#store.clearDiagnostic(claim.id);
      return this.view(claim);
    });
  }
  /** Host supervisor tick: no caller credentials, receipt booleans or executables accepted. */
  public async tick(): Promise<void> {
    this.assertAuthority();
    const claims = this.#store.database.connection.prepare('SELECT * FROM gotzji_claims WHERE goal_id IS NOT NULL').all() as unknown as ClaimRow[];
    let failure: unknown;
    for (const claim of claims) {
      try {
        await this.serial(claim.id, async (): Promise<void> => {
          const goal = await this.snapshot(claim);
          if (goal.status !== 'active') {
            if (this.#store.writer(claim.id)) await this.cleanupTerminal(claim);
          } else {
            const worker = this.#store.worker(claim.id);
            if (worker) { this.assertEffects(); await this.reconcile(claim, worker); }
            else if (this.#store.writer(claim.id)) await this.reconcileUnlaunchedWriter(claim);
          }
          this.#store.clearDiagnostic(claim.id);
        });
      } catch (error) {
        this.#store.diagnose(claim.id,error instanceof CoreError ? error.code : 'SUPERVISION_FAILED',this.#now().toISOString());
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  public startSupervisor(): void {
    this.assertEffects();
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick().catch(() => { /* Persisted in-flight ownership stays held on uncertainty. */ }); }, 1000);
    this.#timer.unref();
  }
  /** Detach the host only. Durable workers keep running and can be adopted by a reopened host. */
  public close(): void { if (this.#timer) clearInterval(this.#timer); this.#closed = true; this.#store.close(); }

  private assertAuthority(): void {
    if (this.#closed) throw new CoreError('CORE_CLOSED');
    this.#store.assertUsable();
    if (realpathSync(this.#root) !== this.#root) throw new CoreError('CORE_DEPENDENCIES_CHANGED');
    const meta = this.#store.database.connection.prepare('SELECT version,policy FROM gotzji_meta').get();
    if (meta?.version !== 1 || meta.policy !== this.#policy) throw new CoreError('CORE_VERSION_OR_POLICY_CHANGED');
  }
  private assertEffects(): void {
    this.assertAuthority();
    if (this.#controlOnly) throw new CoreError('CONTROL_ONLY');
    if (this.#grace) assertGraceProfile(this.#grace);
    if (this.#policy !== this.policyFingerprint()) throw new CoreError('CORE_DEPENDENCIES_CHANGED');
  }
  private policyFingerprint(): string { const source=new URL('../src/core.ts',import.meta.url); return hash(JSON.stringify({ version: 4, root: this.#root, control:hash(readFileSync(existsSync(source)?source:new URL(import.meta.url))), worker: workerFingerprint(), grace: this.#grace, deliveryBoundary:'local', recipes: ['fixture.write','fixture.hold',...(this.#grace ? ['grace.read-save-check','grace.code-check'] : [])], curation: 'explicit-only' })); }
  private authorize(credential: string, effects = false): AdapterRow { if (effects) this.assertEffects(); else this.assertAuthority(); return this.#store.adapter(credential, this.#policy); }
  private bound(credential: string, binding: TaskBinding, effects = false): ClaimRow {
    const adapter = this.authorize(credential,effects);
    const row = this.#store.database.connection.prepare('SELECT * FROM gotzji_bindings WHERE handle_hash=? AND adapter=? AND job_id=? AND policy=?').get(hash(binding.handle), adapter.id, binding.jobId, this.#policy);
    const claim = this.#store.claim(binding.jobId);
    if (!row || claim.owner !== adapter.owner) throw new CoreError('TASK_AUTHORITY_DENIED');
    return claim;
  }
  private validateInput(input: RequestInput): RequestInput {
    if (!input || Object.keys(input).sort().join(',') !== 'operation,requestId,text' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId) || !['fixture.write', 'fixture.hold','grace.read-save-check','grace.code-check'].includes(input.operation) || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 65536) throw new CoreError('INVALID_REQUEST');
    if (input.operation === 'grace.read-save-check' && (!this.#grace || hash(input.text) !== this.#grace.sourceHash)) throw new CoreError('GRACE_PREPARATION_DENIED');
    if (input.operation === 'grace.code-check' && (this.#grace?.recipe !== 'code-check' || hash(input.text) !== this.#grace.expectedHash)) throw new CoreError('GRACE_PREPARATION_DENIED');
    return { requestId: input.requestId, operation: input.operation, text: input.text };
  }
  private actor(claim: ClaimRow, session: string): FileActor { return { clientId: claim.owner, clientName: 'Gotzji execution core', sessionId: session }; }
  private async snapshot(claim: ClaimRow): Promise<GoalSnapshot> { return unwrap(await this.#service.getGoal(this.actor(claim, 'core'), { workspaceId: WORKSPACE, goalKey: claim.goal_key })); }
  private async ensureGoal(claim: ClaimRow): Promise<GoalSnapshot> {
    const existing = await this.#goals.getByKey(WORKSPACE, claim.goal_key);
    if (!existing) {
      const result = unwrap(await this.#service.runGoal(this.actor(claim, `preparing-${claim.id}`), { workspaceId: WORKSPACE, goalKey: claim.goal_key, objective: 'Qualify governed execution', plan: { steps: [{ id: 'effect', title: 'Execute and independently verify the fixed qualification recipe' }] }, ...(this.#store.input(claim).operation==='grace.code-check'?{engineering:{schemaVersion:1 as const,primaryTaskKind:'bugfix' as const,riskTier:'low' as const,policyDigest:this.#policy,deliveryScope:'local' as const,gates:[{id:'focused_validation',title:'Actual registered command',applicability:'required' as const,status:'pending' as const,reason:'Host observed recipe verification',basedOnUserIntentRevision:0}]}}:{}), leaseSeconds: 300 }));
      if (result.acquired && result.leaseToken) unwrap(await this.#service.checkpointGoal(this.actor(claim, `preparing-${claim.id}`), { goalId: result.goalId, leaseToken: result.leaseToken, expectedRevision: result.revision, currentPhase: 'queued', summary: 'Durable request accepted; execution not started', stepUpdates: [], nextAction: 'Acquire controlled worker', blockers: [], evidence: [], releaseLease: true }));
    }
    const goal = await this.snapshot(claim);
    this.#store.database.connection.prepare('UPDATE gotzji_claims SET goal_id=? WHERE id=? AND (goal_id IS NULL OR goal_id=?)').run(goal.goalId, claim.id, goal.goalId);
    return goal;
  }
  private async view(claim: ClaimRow): Promise<JobView> {
    this.assertAuthority();
    const goal = await this.snapshot(claim);
    const operation = this.#store.operation(claim.id);
    const held = !!this.#store.database.connection.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=?').get(claim.id);
    let status: JobView['status'] = goal.status === 'active' ? 'queued' : goal.status;
    if (goal.status === 'active' && this.#store.worker(claim.id)) status = operation?.phase === 'verified' ? 'verifying' : 'running';
    if (operation?.phase === 'uncertain' || (goal.status !== 'active' && held)) status = 'blocked';
    const diagnostic = this.#store.database.connection.prepare('SELECT code FROM gotzji_diagnostics WHERE job_id=?').get(claim.id);
    const worker = this.#store.worker(claim.id);
    const expired = goal.status === 'active' && worker && (!goal.leaseExpiresAt || Date.parse(goal.leaseExpiresAt) <= this.#now().getTime());
    if (diagnostic || expired) status = 'blocked';
    const run=worker?this.codeRun(claim,worker):undefined;
    const result: JobView = { jobId: claim.id, status, revision: goal.revision, operation: this.#store.input(claim).operation, evidenceDigest: operation?.receipt ? hash(operation.receipt) : null, curation: 'explicit-only', deliveryBoundary:'local', ...(run?{progress:{runId:run.runId,state:run.state,elapsedMs:run.elapsedMs,checks:run.checks,lastProgressAt:run.lastProgressAt}}:{}), ...(diagnostic ? {blockerCode:String(diagnostic.code)} : expired ? {blockerCode:'LEASE_RECOVERY_REQUIRED'} : {}) };
    return result;
  }
  private effectRoot(jobId: string): string { return path.join(this.#root, 'effects', jobId); }
  private authorization(claim:ClaimRow,intentRevision?:number):string {
    const row=this.#store.database.connection.prepare('SELECT * FROM gotzji_authorized_jobs WHERE job_id=?').get(claim.id);
    const digest=hash(JSON.stringify({owner:claim.owner,intent:claim.digest,boundary:'local',policy:this.#policy,revision:0}));
    if(!row||row.owner!==claim.owner||row.intent_digest!==claim.digest||row.boundary!=='local'||row.policy!==this.#policy||row.authorization_digest!==digest) throw new CoreError('DELIVERY_AUTHORITY_DENIED');
    if(intentRevision!==undefined&&row.intent_revision!==intentRevision) throw new CoreError('INTENT_RECONCILIATION_REQUIRED');
    return digest;
  }
  private codeRun(claim:ClaimRow,worker:WorkerRow):CodeRunReceipt|undefined {
    if(this.#store.input(claim).operation!=='grace.code-check') return undefined;
    const run=signed<CodeRunReceipt>(worker,'validation.json');if(!run) return undefined;
    const authorization=this.authorization(claim,run.intentRevision);
    const expectedCommand=this.registeredValidatorCommand(claim,worker);
    const expectedFingerprint=hash(expectedCommand);
    if(run.jobId!==claim.id||run.authorizationDigest!==authorization||run.artifactHash!==hash(this.#store.input(claim).text)||run.command!==expectedCommand||run.commandFingerprint!==expectedFingerprint||!Number.isSafeInteger(run.checks)||run.checks<0||!Number.isFinite(run.elapsedMs)||!['running','completed','failed','cancelled'].includes(run.state)) throw new CoreError('COMMAND_RECEIPT_INVALID');
    if(run.runId!==hash(claim.id+'\0'+worker.epoch+'\0'+authorization+'\0'+expectedCommand)) throw new CoreError('COMMAND_RECEIPT_INVALID');
    return run;
  }
  private registeredValidatorCommand(claim:ClaimRow,worker:WorkerRow):string {
    const filename=path.join(worker.directory,'config.json');
    if(lstatSync(filename).isSymbolicLink()) throw new CoreError('COMMAND_RECEIPT_INVALID');
    const config=JSON.parse(readFileSync(filename,'utf8')) as {jobId?:unknown;epoch?:unknown;operation?:unknown;effectRoot?:unknown;grace?:{expectedHash?:unknown;validationMs?:unknown}};
    if(config.jobId!==claim.id||config.epoch!==worker.epoch||config.operation!=='grace.code-check'||config.effectRoot!==this.effectRoot(claim.id)||config.grace?.expectedHash!==hash(this.#store.input(claim).text)||!Number.isInteger(config.grace.validationMs)||Number(config.grace.validationMs)<0||Number(config.grace.validationMs)>600000) throw new CoreError('COMMAND_RECEIPT_INVALID');
    const display=(value:string):string=>/^[A-Za-z0-9_./:@+\\-]+$/.test(value)?value:JSON.stringify(value);
    return [process.execPath,fileURLToPath(new URL('./phase-r-validator.mjs',import.meta.url)),path.join(this.effectRoot(claim.id),'result.txt'),String(config.grace.expectedHash),String(config.grace.validationMs)].map(display).join(' ');
  }
  private operationDigest(claim: ClaimRow): string { return hash(JSON.stringify({ job: claim.id, intent: claim.digest, policy: this.#policy, recipe: this.#store.input(claim) })); }
  private requireWorker(jobId: string): WorkerRow { const worker = this.#store.worker(jobId); if (!worker) throw new CoreError('WORKER_NOT_FOUND'); return worker; }
  private async validateWorker(claim: ClaimRow, worker: WorkerRow): Promise<void> {
    this.assertEffects();
    const current = this.requireWorker(claim.id);
    const writer = this.#store.database.connection.prepare('SELECT * FROM gotzji_writers WHERE root=?').get(this.#root);
    if (current.epoch !== worker.epoch || writer?.job_id !== claim.id || writer.epoch !== worker.epoch) throw new CoreError('WORKER_FENCE_INVALID');
    const goal = unwrap(await this.#service.validateGoalLease(this.actor(claim, worker.session), { goalId: (await this.snapshot(claim)).goalId, leaseToken: worker.lease }));
    if (goal.leaseGeneration !== worker.generation) throw new CoreError('WORKER_FENCE_INVALID');
    this.authorization(claim,goal.userIntentRevision);
  }
  private async checkpoint(claim: ClaimRow, worker: WorkerRow, phase: string, complete = false): Promise<void> {
    const goal = await this.snapshot(claim);
    const run=complete?this.codeRun(claim,worker):undefined;
    const extra=run?{engineeringGateUpdates:[{gateId:'focused_validation',status:'passed' as const,evidence:{source:'host_observed' as const,workspaceId:WORKSPACE,observedAt:run.lastProgressAt,command:run.command,runId:run.runId,exitCode:run.exitCode??-1}}],resumeContext:{changedFiles:['result.txt'],commands:[{command:run.command,status:'passed' as const,exitCode:run.exitCode??-1,result:`${run.checks} semantic/property checks; ${run.artifactHash}`}],decisions:['Host-authorized local repair'],failedAttempts:[],pendingValidation:[],resumePrerequisites:[],stateFacts:[],artifacts:[{kind:'hash' as const,value:run.artifactHash}]}}:{};
    unwrap(await this.#service.checkpointGoal(this.actor(claim, worker.session), { goalId: goal.goalId, leaseToken: worker.lease, expectedRevision: goal.revision, currentPhase: phase, summary: `Core observed ${phase}`, stepUpdates: complete ? [{ stepId: 'effect', status: 'completed', summary: 'Independent receipt verified' }] : [], nextAction: complete ? '' : 'Observe governed effect', blockers: [], evidence: [], trackedTasks: complete ? [] : [{ taskId: worker.epoch, provider: 'process', role: 'blocking_job', cancelWithGoal: true }],...extra }));
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
    if (input.operation.startsWith('grace.') && requireGraceCompletion) this.verifyGraceExecution(claim);
    const receipt = JSON.stringify({ recipe: input.operation, recipeDigest: operation.digest, artifactHash: hash(effect), bytes: effect.byteLength, verifier: 'host-file-sha256-v1' });
    this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=?,receipt=? WHERE job_id=?').run('verified', receipt, claim.id);
    return true;
  }
  private verifyGraceExecution(claim: ClaimRow): void {
    const worker = this.requireWorker(claim.id);
    const runtime = signed<{ mode: string; exitCode: number; eventsHash: string; apiKeySource: string; model: string }>(worker, 'grace-runtime.json');
    if (!runtime || runtime.mode !== this.#grace?.mode || runtime.exitCode !== 0 || runtime.apiKeySource !== 'none' || runtime.eventsHash !== hash(readFileSync(path.join(worker.directory,'claude-events.jsonl')))) throw new CoreError('GRACE_RUNTIME_EVIDENCE_REQUIRED');
    const code=this.#store.input(claim).operation==='grace.code-check';
    for (const id of [...Object.keys(this.#grace?.documents??{}).map((name)=>'policy:'+name),'read_source',...(code?['check_before','apply_change','start_validation','validation_status']:['save_result','check_result'])]) {
      const row = this.#store.database.connection.prepare('SELECT * FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(claim.id,id);
      if (!row || row.phase !== 'verified' || typeof row.receipt !== 'string') throw new CoreError('GRACE_OPERATION_EVIDENCE_REQUIRED');
      if (id === 'check_result') {
        const receipt = JSON.parse(row.receipt) as { exitCode: number; sha256: string; verifierHash: string };
        if (receipt.exitCode !== 0 || receipt.sha256 !== this.#grace?.sourceHash || receipt.verifierHash !== hash(readFileSync(new URL('./grace-verifier.mjs', import.meta.url)))) throw new CoreError('GRACE_CHECK_EVIDENCE_REQUIRED');
      }
      if(id==='check_before'&&(JSON.parse(row.receipt).exitCode!==1||JSON.parse(row.receipt).sourceHash!==this.#grace?.sourceHash)) throw new CoreError('GRACE_REPRO_EVIDENCE_REQUIRED');
    }
    if(code){const run=this.codeRun(claim,worker);if(!run||run.state!=='completed'||run.exitCode!==0||run.checks<5||run.artifactHash!==hash(this.#store.input(claim).text)) throw new CoreError('GRACE_CHECK_EVIDENCE_REQUIRED');}
  }
  private verifyStoppedCodeReplay(claim:ClaimRow,worker:WorkerRow,before:CodeRunReceipt,after:CodeRunReceipt):void {
    if(before.state!=='running'||after.state!=='cancelled'||after.runId!==before.runId||after.command!==before.command||after.checks<before.checks) throw new CoreError('GRACE_CHECK_EVIDENCE_REQUIRED');
    const runtime=signed<{mode:string;exitCode:number;eventsHash:string;apiKeySource:string}>(worker,'grace-runtime.json');
    const events=path.join(worker.directory,'claude-events.jsonl');
    if(!runtime||runtime.mode!==this.#grace?.mode||runtime.exitCode!==0||runtime.apiKeySource!=='none'||runtime.eventsHash!==hash(readFileSync(events))) throw new CoreError('GRACE_RUNTIME_EVIDENCE_REQUIRED');
    const receipts=new Map<string,Record<string,unknown>>();
    for(const id of [...Object.keys(this.#grace?.documents??{}).map((name)=>'policy:'+name),'read_source','check_before','apply_change','start_validation','validation_status']){
      const row=this.#store.database.connection.prepare('SELECT phase,receipt FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(claim.id,id);
      if(!row||row.phase!=='verified'||typeof row.receipt!=='string') throw new CoreError('GRACE_OPERATION_EVIDENCE_REQUIRED');
      receipts.set(id,JSON.parse(row.receipt) as Record<string,unknown>);
    }
    if(receipts.get('read_source')?.sha256!==this.#grace?.sourceHash||receipts.get('check_before')?.exitCode!==1||receipts.get('check_before')?.sourceHash!==this.#grace?.sourceHash||receipts.get('apply_change')?.sha256!==this.#grace?.expectedHash||receipts.get('start_validation')?.runId!==before.runId||receipts.get('validation_status')?.runId!==before.runId) throw new CoreError('GRACE_CHECK_EVIDENCE_REQUIRED');
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
    const goal = await this.snapshot(claim);
    if (!goal.leaseExpiresAt || !Number.isFinite(Date.parse(goal.leaseExpiresAt)) || Date.parse(goal.leaseExpiresAt) <= this.#now().getTime()) {
      await this.recoverExpired(claim, worker); return;
    }
    const observation = await callWorker(worker, 'status');
    if (observation.state === 'ready') {
      if (this.#store.operation(claim.id)?.phase === 'reserved') await this.startReserved(claim, worker);
      else throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    } else if (observation.state === 'done') {
      if (this.verifyEffect(claim)) await this.complete(claim, worker);
      else {this.markUncertain(claim.id);throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');}
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
    if (!this.#store.writer(claim.id)) return;
    if (!worker) { await this.reconcileUnlaunchedWriter(claim); return; }
    if (this.unlaunched(worker.epoch)) { await this.compensateUnlaunched(claim,worker.epoch); return; }
    if (!await stopWorker(worker)) throw new CoreError('CLEANUP_RECONCILIATION_REQUIRED');
    const input = this.#store.input(claim);
    if (input.operation !== 'fixture.hold' && existsSync(path.join(this.effectRoot(claim.id), 'result.txt'))) this.verifyEffect(claim, false);
    this.releaseWriter(claim.id, worker.epoch);
  }
  private unlaunched(epoch: string): boolean {
    const directory = path.join(this.#root,'workers',epoch);
    if (existsSync(directory) && realpathSync(directory) !== directory) return false;
    for (const name of ['config.json','ready.json','observation.json']) {
      try { lstatSync(path.join(directory,name)); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    }
    // The only launch adapter writes config before spawn; mutations are held
    // under the job guard, so absent durable launch files prove no dispatch.
    return true;
  }
  private async reconcileUnlaunchedWriter(claim: ClaimRow): Promise<void> {
    const writer = this.#store.writer(claim.id);
    if (!writer) return;
    if (!this.unlaunched(writer.epoch)) throw new CoreError('WORKER_RECONCILIATION_REQUIRED');
    this.releaseWriter(claim.id,writer.epoch);
  }
  private async compensateUnlaunched(claim: ClaimRow, epoch: string): Promise<void> {
    if (!this.unlaunched(epoch)) return;
    const worker = this.#store.worker(claim.id);
    if (worker && worker.epoch !== epoch) return;
    if (worker) {
      this.#store.archiveWorker(worker,'not_launched',this.#now().toISOString());
      const goal = await this.snapshot(claim);
      if (goal.status === 'active' && goal.leaseExpiresAt && Date.parse(goal.leaseExpiresAt) > this.#now().getTime()) {
        unwrap(await this.#service.checkpointGoal(this.actor(claim,worker.session), {goalId:goal.goalId,leaseToken:worker.lease,expectedRevision:goal.revision,currentPhase:'queued',summary:'Unlaunched worker reservation reconciled',stepUpdates:[],nextAction:'Retry controlled admission',blockers:[],evidence:[],trackedTasks:[],releaseLease:true}));
      }
      this.#store.database.connection.prepare('DELETE FROM gotzji_workers WHERE job_id=? AND epoch=?').run(claim.id,epoch);
    }
    this.releaseWriter(claim.id,epoch);
  }
  private resetForReplay(claim: ClaimRow, worker: WorkerRow, epoch: string): void {
    this.#store.archiveWorker(worker,'stopped',this.#now().toISOString());
    const database = this.#store.database.connection;
    database.exec('BEGIN IMMEDIATE;');
    try {
      const changed = database.prepare('UPDATE gotzji_writers SET epoch=? WHERE job_id=? AND epoch=?').run(epoch,claim.id,worker.epoch);
      if (Number(changed.changes) !== 1) throw new CoreError('WORKER_FENCE_INVALID');
      database.prepare('DELETE FROM gotzji_workers WHERE job_id=? AND epoch=?').run(claim.id,worker.epoch);
      database.prepare('UPDATE gotzji_operations SET phase=?,receipt=NULL WHERE job_id=?').run('reserved',claim.id);
      database.prepare('DELETE FROM gotzji_recipe_operations WHERE job_id=?').run(claim.id);
      database.exec('COMMIT;');
    } catch (error) { database.exec('ROLLBACK;'); throw error; }
  }
  private async recoverExpired(claim: ClaimRow, worker: WorkerRow): Promise<void> {
    this.assertEffects();
    this.#store.diagnose(claim.id,'LEASE_RECOVERY_REQUIRED',this.#now().toISOString());
    const config = JSON.parse(readFileSync(path.join(worker.directory,'config.json'),'utf8')) as {intentRevision:number};
    const goal = await this.snapshot(claim);
    if (goal.userIntentRevision !== config.intentRevision) throw new CoreError('INTENT_RECONCILIATION_REQUIRED');
    this.authorization(claim,goal.userIntentRevision);
    const input = this.#store.input(claim);
    const codeRunBefore=input.operation==='grace.code-check'?this.codeRun(claim,worker):undefined;
    if (!await stopWorker(worker)) throw new CoreError('CLEANUP_RECONCILIATION_REQUIRED');
    const operation = this.#store.operation(claim.id);
    if (!operation || operation.digest !== this.operationDigest(claim) || operation.phase === 'revoked' || operation.phase === 'uncertain') throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    const filename = path.join(this.effectRoot(claim.id),'result.txt');
    let complete = false;
    if (existsSync(filename)) {
      this.verifyEffect(claim,false); // Unknown bytes keep the held writer.
      if (input.operation === 'fixture.write') complete = true;
      else if (input.operation === 'grace.read-save-check' || input.operation === 'grace.code-check') {
        try { this.verifyGraceExecution(claim); complete = true; }
        catch (error) {
          if (input.operation==='grace.code-check') {
            if(codeRunBefore?.state==='failed') throw new CoreError('VALIDATION_FAILED');
            const run=this.codeRun(claim,worker);
            if(!codeRunBefore||!run) throw error;
            this.verifyStoppedCodeReplay(claim,worker,codeRunBefore,run);
          } else if (!(error instanceof CoreError) || !['GRACE_RUNTIME_EVIDENCE_REQUIRED','GRACE_OPERATION_EVIDENCE_REQUIRED'].includes(error.code)) throw error;
        }
      }
    }
    if (!['fixture.hold','fixture.write','grace.read-save-check','grace.code-check'].includes(input.operation)) throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    // Only these reviewed recipes have a proved bounded effect set. The
    // snapshot save is exclusive/idempotent; its verifier is read-only.
    this.#store.archiveWorker(worker,'stopped',this.#now().toISOString());
    await this.reacquire(claim,worker);
    const recovered = this.requireWorker(claim.id);
    if (complete) await this.complete(claim,recovered);
    else await this.launchClaim(claim,recovered);
    this.#store.clearDiagnostic(claim.id);
  }
  private releaseWriter(jobId: string, epoch: string): void { this.#store.database.connection.prepare('DELETE FROM gotzji_writers WHERE job_id=? AND epoch=?').run(jobId, epoch); }
  private markUncertain(jobId: string): void { this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=? WHERE job_id=?').run('uncertain', jobId); }
  private async serial<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    const key = `${this.#root}\0${jobId}`;
    const previous = MUTATION_QUEUES.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async (): Promise<T> => {
      const guard = await this.#store.acquireGuard(jobId);
      try { return await action(); }
      finally { this.#store.releaseGuard(jobId,guard); }
    });
    MUTATION_QUEUES.set(key,next);
    try { return await next; } finally { if (MUTATION_QUEUES.get(key) === next) MUTATION_QUEUES.delete(key); }
  }
}
