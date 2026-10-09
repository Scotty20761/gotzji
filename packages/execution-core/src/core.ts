import { randomUUID, createHmac } from 'node:crypto';
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
import { CoreStore, hash, secret, type AdapterRow, type ClaimRow, type WorkerRow, type WriterRow, type CoreUpgrade } from './store.js';
import { callWorker, launchWorker, observeWorker, stopWorker, workerFingerprint } from './managed-worker.js';
import { signed } from './managed-worker.js';
import { assertGraceProfile, graceProfile, productGraceProfile, type GraceProfile, type GraceRegistration, type ProductGraceRegistration } from './grace-profile.js';
import { PRODUCT_CATALOG, registeredProject, productOperation, reviewedRecipe } from './product-projects.js';
import { CoreError, type JobView, type SettleDecision, type Preparation, type RequestInput, type TaskBinding, type CodeRunReceipt, type RegisteredProject, type ProjectRegistration, type ProductOperationInput, type BasicProductOperationInput, type ProductOperation, type PreparedProductOperation, type CatalogEntry, type ReviewedCommandRegistration } from './types.js';
import { PRODUCT_NATIVE_OPERATIONS, prepareProductNativeOperation, type ProductNativeInput, type TrustedProductNativeOptions, type ProductNativeOperationName } from './product-native.js';
import { libraryRoute, libraryCatalog, prepareLibraryOperation, verifiedLibraryNavigationEvolution, type ProductLibraryInput, type TrustedLibraryOptions } from './product-library.js';
import type { LibraryRouteKind, LibraryDeliveryScope } from './library-workflow-contract.js';
import { PRODUCT_BROWSER_OPERATIONS, prepareProductBrowserOperation, type ProductBrowserInput, type ProductBrowserOperationName, type TrustedProductBrowserOptions } from './product-browser.js';

const WORKSPACE = 'gotzji-qualification-library';
const MUTATION_QUEUES = new Map<string, Promise<unknown>>();
// Engineering defaults: two write-class Grace jobs (multi-job spec) plus one more slot that only reads can reach, so a
// version-pinned read never waits behind long commands while total model sessions stay bounded.
const GRACE_SLOTS = 3;
const WRITE_SLOTS = 2;
const SETTLE_REFUSALS = {
  SETTLE_UNSUPPORTED: 'Only project file and command jobs can be settled by the owner',
  JOB_NOT_SETTLEABLE: 'Only a blocked job that still holds its project can be settled',
  WORKER_STOP_REQUIRED: 'The job worker must be proven stopped before settling',
  JOB_STILL_RUNNING: 'This job has not finished working; cancel it instead',
} as const;
export interface CoreNativeOptions extends TrustedProductNativeOptions {
  readonly operations?: readonly ProductNativeOperationName[];
  readonly testRunnerModule?: string;
}
export interface CoreBrowserOptions extends TrustedProductBrowserOptions { readonly testTransportModule?: string }
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
  readonly #native: CoreNativeOptions | null;
  readonly #library: TrustedLibraryOptions | null;
  #browser: CoreBrowserOptions | null;
  readonly #privateRuntimeRoots: readonly string[];
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  private constructor(root: string, now: () => Date, grace: GraceRegistration | undefined, controlOnly: boolean, product?: ProductGraceRegistration, upgrade?: CoreUpgrade, nativeOptions?: CoreNativeOptions, libraryOptions?: TrustedLibraryOptions, browserOptions?: CoreBrowserOptions, privateRuntimeRoots: readonly string[] = []) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(root);
    this.#privateRuntimeRoots=[...new Set([this.#root,...privateRuntimeRoots.map((entry)=>realpathSync(entry))])];
    this.#now = now;
    this.#controlOnly = controlOnly;
    this.#native = nativeOptions ? { ...nativeOptions } : null;
    this.#library = libraryOptions ? { ...libraryOptions } : null;
    this.#browser = browserOptions ? { ...browserOptions } : null;
    this.#grace = !controlOnly && product ? productGraceProfile(product) : !controlOnly && grace ? graceProfile(grace) : null;
    if (nativeOptions?.testRunnerModule && this.#grace?.mode !== 'test-driver') throw new CoreError('NATIVE_TEST_RUNNER_DENIED');
    if (libraryOptions?.testRunnerModule && this.#grace?.mode !== 'test-driver') throw new CoreError('LIBRARY_TEST_RUNNER_DENIED');
    if (browserOptions?.testTransportModule && this.#grace?.mode !== 'test-driver') throw new CoreError('BROWSER_TEST_TRANSPORT_DENIED');
    this.#policy = controlOnly ? CoreStore.existingPolicy(path.join(this.#root,'core.sqlite')) : this.policyFingerprint();
    this.#store = new CoreStore(path.join(this.#root, 'core.sqlite'), this.#policy, upgrade);
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
  public static async open(root: string, options: { now?: () => Date; grace?: GraceRegistration; product?: ProductGraceRegistration; controlOnly?: boolean; upgrade?: CoreUpgrade; nativeOptions?: CoreNativeOptions; libraryOptions?: TrustedLibraryOptions; browserOptions?: CoreBrowserOptions; privateRuntimeRoots?: readonly string[] } = {}): Promise<ExecutionCore> {
    if (options.grace && options.product) throw new CoreError('CORE_PROFILE_CONFLICT');
    if (options.controlOnly && options.upgrade) throw new CoreError('CONTROL_ONLY');
    const core = new ExecutionCore(root, options.now ?? ((): Date => new Date()), options.grace, options.controlOnly === true, options.product, options.upgrade, options.nativeOptions, options.libraryOptions, options.browserOptions, options.privateRuntimeRoots);
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
  /** Trusted updater metadata; not a user work tool or credential. */
  public authority(): { policy: string; authorityId: string } {
    this.assertAuthority(); return CoreStore.inspectAuthority(path.join(this.#root, 'core.sqlite'));
  }
  /** Host-management API; never exposed in the adapter/model tool catalog. */
  public enrollAdapter(adapterId: string, owner: string): string {
    this.assertEffects();
    if (!/^[a-z0-9-]{1,64}$/.test(adapterId) || !/^[a-z0-9-]{1,64}$/.test(owner)) throw new CoreError('INVALID_ENROLLMENT');
    const credential = secret();
    this.#store.database.connection.prepare('INSERT INTO gotzji_adapters VALUES (?,?,?,?)').run(adapterId, owner, hash(credential), this.#policy);
    return credential;
  }
  /** Trusted startup replay: persist the private credential before calling this. */
  public ensureAdapterEnrollment(adapterId: string, owner: string, credential: string): void {
    this.assertEffects();
    if (!/^[a-z0-9-]{1,64}$/.test(adapterId) || !/^[a-z0-9-]{1,64}$/.test(owner) || !/^[a-f0-9]{64}$/.test(credential)) throw new CoreError('INVALID_ENROLLMENT');
    const digest = hash(credential);
    this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_adapters VALUES (?,?,?,?)').run(adapterId, owner, digest, this.#policy);
    const row = this.#store.database.connection.prepare('SELECT * FROM gotzji_adapters WHERE id=?').get(adapterId);
    if (!row || row.owner !== owner || row.policy !== this.#policy || row.credential_hash !== digest) throw new CoreError('ADAPTER_ENROLLMENT_CONFLICT', 'The persisted adapter credential does not match its existing authority');
  }
  public prepare(credential: string, input: RequestInput): Preparation {
    if (input?.operation === 'grace.product-operation') throw new CoreError('PRODUCT_PREPARATION_REQUIRED');
    return this.createPreparation(credential, input);
  }
  private createPreparation(credential: string, input: RequestInput): Preparation {
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
  /** Trusted app/host enrollment. Do not expose this method as an MCP tool. */
  public registerProject(credential: string, registration: ProjectRegistration): RegisteredProject {
    const adapter = this.authorize(credential, true);
    if (this.#grace?.recipe !== 'product') throw new CoreError('PRODUCT_PROFILE_REQUIRED');
    let project = registeredProject(adapter.owner, registration);
    for (const recipeId of project.recipeIds) if (!this.#store.database.connection.prepare('SELECT 1 FROM gotzji_reviewed_recipes WHERE owner=? AND recipe_id=?').get(adapter.owner, recipeId)) throw new CoreError('RECIPE_NOT_REGISTERED', 'Choose a recipe from the server catalog', 'recipeIds');
    const related = this.listProjects(credential).filter((entry) => {
      const relative = path.relative(entry.rootPath, project.rootPath);
      const reverse = path.relative(project.rootPath, entry.rootPath);
      return (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) || (!reverse || (!reverse.startsWith('..') && !path.isAbsolute(reverse)));
    });
    if (new Set(related.map((entry) => entry.resourceKey)).size > 1) throw new CoreError('PROJECT_REGISTRATION_CONFLICT', 'A parent enrollment cannot merge already independent project authorities', 'rootPath');
    if (related[0]) project = { ...project, resourceKey: related[0].resourceKey };
    const previous = this.#store.database.connection.prepare('SELECT registration FROM gotzji_projects WHERE owner=? AND project_id=?').get(adapter.owner, project.projectId);
    if (previous && String(previous.registration) !== JSON.stringify(project)) throw new CoreError('PROJECT_REGISTRATION_CONFLICT', 'Use a new project ID for a changed trusted registration', 'projectId');
    this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_projects VALUES (?,?,?)').run(adapter.owner, project.projectId, JSON.stringify(project));
    return project;
  }
  /** Trusted composition, test setup, or the owner through the local app (incident I7). Never callable through MCP. */
  public registerReviewedCommand(credential: string, registration: ReviewedCommandRegistration): CatalogEntry {
    const adapter = this.authorize(credential, true);
    if (this.#grace?.recipe !== 'product') throw new CoreError('PRODUCT_PROFILE_REQUIRED');
    const recipe = reviewedRecipe(registration);
    const serialized = JSON.stringify(recipe);
    const previous = this.#store.database.connection.prepare('SELECT recipe FROM gotzji_reviewed_recipes WHERE owner=? AND recipe_id=?').get(adapter.owner, recipe.recipeId);
    if (previous && String(previous.recipe) !== serialized) throw new CoreError('RECIPE_REGISTRATION_CONFLICT', 'Review changed code as a new immutable recipe ID', 'recipeId');
    this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_reviewed_recipes VALUES (?,?,?)').run(adapter.owner, recipe.recipeId, serialized);
    return { name: `command.recipe.${recipe.recipeId}`, recipeId: recipe.recipeId, state: 'available', description: recipe.displayName ?? recipe.recipeId, controller: 'grace' };
  }
  /** App-only and append-only: binds a reviewed recipe to a project without rewriting the registration jobs embed. */
  public bindProjectRecipe(credential: string, binding: { readonly projectId: string; readonly recipeId: string }): RegisteredProject {
    const adapter = this.authorize(credential, true);
    if (this.#grace?.recipe !== 'product') throw new CoreError('PRODUCT_PROFILE_REQUIRED');
    const row = this.#store.database.connection.prepare('SELECT registration FROM gotzji_projects WHERE owner=? AND project_id=?').get(adapter.owner, binding.projectId);
    if (!row) throw new CoreError('PROJECT_NOT_REGISTERED', 'Choose a registered project', 'projectId');
    const project = JSON.parse(String(row.registration)) as RegisteredProject;
    if (project.kind === 'library') throw new CoreError('RECIPE_BINDING_UNSUPPORTED', 'Library projects run their own workflows', 'projectId');
    if (!this.#store.database.connection.prepare('SELECT 1 FROM gotzji_reviewed_recipes WHERE owner=? AND recipe_id=?').get(adapter.owner, binding.recipeId)) throw new CoreError('RECIPE_NOT_REGISTERED', 'Choose a recipe from the server catalog', 'recipeId');
    this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_project_recipes VALUES (?,?,?,?)').run(adapter.owner, project.projectId, binding.recipeId, this.#now().toISOString());
    return { ...project, recipeIds: this.projectRecipeIds(credential, project) };
  }
  /** Recipes a project may run: its registration's own plus every owner binding, in that order. */
  public projectRecipeIds(credential: string, project: RegisteredProject): readonly string[] {
    const adapter = this.authorize(credential);
    return [...new Set([...project.recipeIds, ...this.boundRecipeIds(adapter.owner, project.projectId)])];
  }
  /** What the owner approved, for the app only: the catalog the model reads never carries local paths. */
  public recipeReview(credential: string, recipeId: string): { readonly recipeId: string; readonly executable: string; readonly executableSha256: string; readonly args: readonly string[]; readonly timeoutMs: number; readonly dependencies: readonly { readonly path: string; readonly pinned: 'at-approval' | 'each-run'; readonly sha256?: string }[] } {
    const adapter = this.authorize(credential);
    const row = this.#store.database.connection.prepare('SELECT recipe FROM gotzji_reviewed_recipes WHERE owner=? AND recipe_id=?').get(adapter.owner, recipeId);
    if (!row) throw new CoreError('RECIPE_NOT_REGISTERED', 'Choose a recipe from the server catalog', 'recipeId');
    const recipe = JSON.parse(String(row.recipe)) as ReturnType<typeof reviewedRecipe>;
    return { recipeId: recipe.recipeId, executable: recipe.executable, executableSha256: recipe.executableHash, args: recipe.args, timeoutMs: recipe.timeoutMs,
      dependencies: recipe.dependencies.map((item) => { const fixed = item.includes('${projectRoot}') ? undefined : recipe.fixedDependencies.find((entry) => entry.path === path.resolve(item)); return fixed ? { path: item, pinned: 'at-approval' as const, sha256: fixed.hash } : { path: item, pinned: 'each-run' as const }; }) };
  }
  private boundRecipeIds(owner: string, projectId: string): readonly string[] {
    return this.#store.database.connection.prepare('SELECT recipe_id FROM gotzji_project_recipes WHERE owner=? AND project_id=? ORDER BY bound_at,recipe_id').all(owner, projectId).map((entry) => String(entry.recipe_id));
  }
  public listProjects(credential: string): readonly RegisteredProject[] {
    const adapter = this.authorize(credential);
    return this.#store.database.connection.prepare('SELECT registration FROM gotzji_projects WHERE owner=? ORDER BY project_id').all(adapter.owner).map((row) => JSON.parse(String(row.registration)) as RegisteredProject);
  }
  /** App-only enrollment of one host-owned browser session; never expose private session facts through MCP. */
  public async enrollBrowserSession(credential: string, options: CoreBrowserOptions): Promise<void> {
    const adapter=this.authorize(credential,true);
    if(this.#grace?.recipe!=='product')throw new CoreError('PRODUCT_PROFILE_REQUIRED');
    if(options.testTransportModule)throw new CoreError('BROWSER_TEST_TRANSPORT_STATIC_ONLY');
    const project=this.listProjects(credential).find((entry)=>entry.projectId===options.session?.projectId);
    if(!project||project.owner!==adapter.owner||options.session.owner!==adapter.owner||typeof options.verifyOwnedSession!=='function'||!await options.verifyOwnedSession(options.session))throw new CoreError('BROWSER_SESSION_UNVERIFIED');
    this.#browser={...options,session:structuredClone(options.session),prerequisites:structuredClone(options.prerequisites)};
  }
  /** Clear catalog availability only after the host has stopped the exact owned browser session. */
  public clearBrowserSession(credential:string,sessionId:string):void {
    const adapter=this.authorize(credential,true);
    if(!this.#browser||this.#browser.session.owner!==adapter.owner||this.#browser.session.sessionId!==sessionId)throw new CoreError('BROWSER_SESSION_AUTHORITY_DENIED');
    for(const row of this.#store.database.connection.prepare("SELECT c.*,g.status AS goal_status,o.phase AS operation_phase FROM gotzji_claims c LEFT JOIN goals g ON g.id=c.goal_id LEFT JOIN gotzji_operations o ON o.job_id=c.id WHERE c.owner=?").all(adapter.owner)){
      const claim=row as unknown as ClaimRow&{goal_status?:string;operation_phase?:string};const input=this.#store.input(claim);if(input.operation!=='grace.product-operation')continue;
      let prepared:PreparedProductOperation;try{prepared=JSON.parse(input.text) as PreparedProductOperation;}catch{continue;}
      if(prepared.kind==='browser'&&(claim.goal_status==='active'||claim.operation_phase==='uncertain'||!!this.#store.writer(claim.id)))throw new CoreError('BROWSER_SESSION_IN_USE');
    }
    this.#browser=null;
  }
  /** Trusted adapter enrollment, absent from ordinary app/MCP work arguments. */
  public enrollLibraryRoute(credential: string, input: { readonly projectId: string; readonly route: LibraryRouteKind }): void {
    const adapter = this.authorize(credential, true);
    const project = this.listProjects(credential).find((entry) => entry.projectId === input.projectId);
    if (!project) throw new CoreError('PROJECT_NOT_REGISTERED');
    const route = libraryRoute(adapter.owner, adapter.id, this.authority().authorityId, project, input.route);
    const previous = this.#store.database.connection.prepare('SELECT route FROM gotzji_library_routes WHERE adapter=? AND project_id=?').get(adapter.id, project.projectId);
    if (previous && previous.route !== route.route) throw new CoreError('LIBRARY_ROUTE_CONFLICT');
    this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_library_routes VALUES (?,?,?)').run(adapter.id, project.projectId, route.route);
  }
  /** Owner-controlled delivery enrollment. This is not an untrusted model tool. */
  public authorizeLibraryDelivery(credential: string, binding: TaskBinding, scope: LibraryDeliveryScope): string {
    const claim = this.bound(credential, binding);
    const prepared = JSON.parse(this.#store.input(claim).text) as PreparedProductOperation;
    if (prepared.kind !== 'library' || !['commit','push','deploy','user-delivery'].includes(scope)) throw new CoreError('LIBRARY_DELIVERY_SCOPE_DENIED');
    const adapter = this.authorize(credential);
    if (!this.#store.database.connection.prepare('SELECT 1 FROM gotzji_library_routes WHERE adapter=? AND project_id=?').get(adapter.id, prepared.project.projectId)) throw new CoreError('LIBRARY_ROUTE_AUTHORITY_DENIED');
    const digest = hash(JSON.stringify({ owner: claim.owner, job: claim.id, intent: claim.digest, policy: claim.policy, scope }));
    this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_library_delivery VALUES (?,?,?)').run(claim.id, scope, digest);
    return digest;
  }
  /** Select an existing Library job through either explicitly enrolled route without adopting unrelated jobs. */
  public selectLibraryJob(credential: string, projectId: string, jobId: string): TaskBinding {
    const adapter = this.authorize(credential);
    const claim = this.#store.claim(jobId);
    const prepared = JSON.parse(this.#store.input(claim).text) as PreparedProductOperation;
    if (claim.owner !== adapter.owner || prepared.kind !== 'library' || prepared.project.projectId !== projectId
      || !this.#store.database.connection.prepare('SELECT 1 FROM gotzji_library_routes WHERE adapter=? AND project_id=?').get(adapter.id, projectId)) throw new CoreError('LIBRARY_ROUTE_AUTHORITY_DENIED');
    return this.select(credential, jobId);
  }
  public catalog(credential: string): readonly CatalogEntry[] {
    const adapter = this.authorize(credential);
    const entries = PRODUCT_CATALOG.map((entry) => this.#grace?.recipe === 'product' || entry.state === 'unsupported' ? { ...entry } : { ...entry, state: 'unsupported' as const, reason: 'PRODUCT_PROFILE_REQUIRED' });
    const recipes = this.#store.database.connection.prepare('SELECT recipe_id,recipe FROM gotzji_reviewed_recipes WHERE owner=? ORDER BY recipe_id').all(adapter.owner).map((row): CatalogEntry => ({ name: `command.recipe.${String(row.recipe_id)}`, recipeId: String(row.recipe_id), state: 'available', description: (JSON.parse(String(row.recipe)) as ReviewedCommandRegistration).displayName ?? String(row.recipe_id), controller: 'grace' }));
    const native = PRODUCT_NATIVE_OPERATIONS.map((name): CatalogEntry => ({ name, state: this.nativeAvailable(name) ? 'available' : 'unsupported', description: `Grace-controlled ${name} with original preservation and native receipt verification`, controller: 'grace', ...(this.nativeAvailable(name) ? {} : { reason: 'NATIVE_PROVIDER_NOT_QUALIFIED' }) }));
    const browser = PRODUCT_BROWSER_OPERATIONS.map((name): CatalogEntry => ({ name, state: this.#browser && this.#grace?.recipe === 'product' && (this.#browser.operations ?? PRODUCT_BROWSER_OPERATIONS).includes(name) ? 'available' : 'unsupported', description:`Grace-controlled ${name} in the enrolled owned browser session`,controller:'grace',...(this.#browser && this.#grace?.recipe === 'product' ? {} : {reason:'BROWSER_PROVIDER_NOT_QUALIFIED'}) }));
    const library: CatalogEntry[] = [];
    if (this.#library) for (const project of this.listProjects(credential).filter((entry) => entry.kind === 'library')) {
      const route = this.#store.database.connection.prepare('SELECT route FROM gotzji_library_routes WHERE adapter=? AND project_id=?').get(adapter.id, project.projectId);
      if (route) for (const workflow of libraryCatalog()) library.push({ name: 'library.workflow', workflowId: workflow.id, workflowVersion: workflow.version, projectId: project.projectId, state: 'available', description: workflow.title, controller: 'grace' });
    }
    return [...entries, ...recipes, ...native, ...browser, ...library];
  }
  private nativeAvailable(operation: ProductNativeOperationName): boolean {
    if (!this.#native || this.#grace?.recipe !== 'product' || !(this.#native.operations ?? PRODUCT_NATIVE_OPERATIONS.filter((name) => !name.startsWith('cad.'))).includes(operation)) return false;
    try {
      if (operation.startsWith('cad.')) return !!this.#native.cad && hash(readFileSync(this.#native.cad.scriptPath)) === this.#native.cad.scriptSha256 && hash(readFileSync(this.#native.cad.executable)) === this.#native.cad.executableSha256;
      return !lstatSync(this.#native.scriptPath).isSymbolicLink() && realpathSync(this.#native.scriptPath) === path.resolve(this.#native.scriptPath) && hash(readFileSync(this.#native.scriptPath)) === this.#native.scriptSha256;
    } catch { return false; }
  }
  public prepareOperation(credential: string, input: BasicProductOperationInput): Preparation;
  public prepareOperation(credential: string, input: ProductNativeInput): Promise<Preparation>;
  public prepareOperation(credential: string, input: ProductBrowserInput): Promise<Preparation>;
  public prepareOperation(credential: string, input: ProductLibraryInput): Preparation;
  public prepareOperation(credential: string, input: ProductOperationInput): Preparation | Promise<Preparation>;
  public prepareOperation(credential: string, input: ProductOperationInput): Preparation | Promise<Preparation> {
    const adapter = this.authorize(credential, true);
    if (this.#grace?.recipe !== 'product') throw new CoreError('PRODUCT_PROFILE_REQUIRED');
    const row = this.#store.database.connection.prepare('SELECT registration FROM gotzji_projects WHERE owner=? AND project_id=?').get(adapter.owner, input?.projectId ?? '');
    if (!row) throw new CoreError('PROJECT_NOT_REGISTERED', 'Enroll this project in the app before submitting work', 'projectId');
    for (const jobId of input.dependsOn ?? []) {
      const claim = this.#store.claim(jobId);
      if (claim.owner !== adapter.owner || claim.id === hash(`${adapter.owner}\0${input.requestId}`) || claim.goal_id === null) throw new CoreError('DEPENDENCY_AUTHORITY_DENIED', 'Select an existing owned job other than this request', 'dependsOn');
    }
    if (input.operation === 'library.workflow') {
      if (!this.#library) throw new CoreError('LIBRARY_EXECUTOR_NOT_REGISTERED');
      const project = JSON.parse(String(row.registration)) as RegisteredProject;
      const enrolled = this.#store.database.connection.prepare('SELECT route FROM gotzji_library_routes WHERE adapter=? AND project_id=?').get(adapter.id, project.projectId);
      if (!enrolled) throw new CoreError('LIBRARY_ROUTE_AUTHORITY_DENIED');
      const route = libraryRoute(adapter.owner, adapter.id, this.authority().authorityId, project, String(enrolled.route) as LibraryRouteKind);
      const prepared = prepareLibraryOperation(project, input, route, this.#library);
      return this.createPreparation(credential, { requestId: input.requestId, operation: 'grace.product-operation', text: JSON.stringify(prepared) });
    }
    if (PRODUCT_BROWSER_OPERATIONS.includes(input.operation as ProductBrowserOperationName)) {
      if (!this.#browser || !(this.#browser.operations ?? PRODUCT_BROWSER_OPERATIONS).includes(input.operation as ProductBrowserOperationName)) throw new CoreError('BROWSER_PROVIDER_NOT_QUALIFIED');
      const enrollment=this.#browser;
      return prepareProductBrowserOperation(JSON.parse(String(row.registration)) as RegisteredProject,input,enrollment).then((operation)=>{
        if(this.#browser!==enrollment||this.#browser.session.sessionId!==operation.browser.session.sessionId||this.#browser.manifestSha256!==operation.browser.manifestSha256)throw new CoreError('BROWSER_SESSION_CHANGED');
        return this.createPreparation(credential,{requestId:input.requestId,operation:'grace.product-operation',text:JSON.stringify(operation)});
      });
    }
    if (PRODUCT_NATIVE_OPERATIONS.includes(input.operation as ProductNativeOperationName)) {
      const existing = this.#store.database.connection.prepare('SELECT * FROM gotzji_claims WHERE id=? AND owner=?').get(hash(`${adapter.owner}\0${input.requestId}`), adapter.owner) as unknown as ClaimRow | undefined;
      if (existing) {
        const known = JSON.parse(this.#store.input(existing).text) as PreparedProductOperation;
        if (known.kind !== 'native') return Promise.reject(new CoreError('REQUEST_DIGEST_CONFLICT'));
        const normalize = (value: ProductNativeInput): Record<string, unknown> => ({ ...value, path: path.relative(known.project.rootPath, path.resolve(known.project.rootPath, value.path)), expectedSha256: value.expectedSha256 ?? known.beforeSha256, ...('outputPath' in value && value.outputPath ? { outputPath: path.relative(known.project.rootPath, path.resolve(known.project.rootPath, value.outputPath)) } : {}) });
        const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b))) : entry);
        if (canonical(normalize(input as ProductNativeInput)) !== canonical(known.input)) return Promise.reject(new CoreError('REQUEST_DIGEST_CONFLICT'));
        const preparation = this.#store.database.connection.prepare('SELECT id,digest FROM gotzji_preparations WHERE owner=? AND adapter=? AND digest=? ORDER BY rowid LIMIT 1').get(adapter.owner, adapter.id, existing.digest);
        if (preparation) return Promise.resolve({ preparationId: String(preparation.id), digest: String(preparation.digest) });
        const id = randomUUID(); this.#store.database.connection.prepare('INSERT INTO gotzji_preparations VALUES (?,?,?,?,?,?)').run(id, adapter.id, adapter.owner, existing.digest, existing.input, existing.policy);
        return Promise.resolve({ preparationId: id, digest: existing.digest });
      }
      if (!this.#native || !this.nativeAvailable(input.operation as ProductNativeOperationName)) throw new CoreError('NATIVE_PROVIDER_NOT_QUALIFIED', 'Use an installed qualified provider with the pinned script', 'operation');
      return prepareProductNativeOperation(JSON.parse(String(row.registration)) as RegisteredProject, input, this.#native).then((operation) => this.createPreparation(credential, { requestId: input.requestId, operation: 'grace.product-operation', text: JSON.stringify(operation) }));
    }
    const basic = input as BasicProductOperationInput;
    const recipe = basic.operation === 'command.run' ? this.#store.database.connection.prepare('SELECT recipe FROM gotzji_reviewed_recipes WHERE owner=? AND recipe_id=?').get(adapter.owner, basic.commandId ?? '') : undefined;
    const operation = productOperation(JSON.parse(String(row.registration)) as RegisteredProject, basic, recipe ? JSON.parse(String(recipe.recipe)) as ReturnType<typeof reviewedRecipe> : undefined,{privateRuntimeRoots:this.privateRuntimeRoots(),boundRecipeIds:this.boundRecipeIds(adapter.owner,basic.projectId)});
    return this.createPreparation(credential, { requestId: input.requestId, operation: 'grace.product-operation', text: JSON.stringify(operation) });
  }
  public async list(credential: string): Promise<readonly JobView[]> {
    const adapter = this.authorize(credential);
    const claims = this.#store.database.connection.prepare('SELECT * FROM gotzji_claims WHERE owner=? AND goal_id IS NOT NULL ORDER BY rowid DESC').all(adapter.owner) as unknown as ClaimRow[];
    return Promise.all(claims.map((claim) => this.view(claim)));
  }
  public async inspectQueue(credential: string): Promise<readonly JobView[]> {
    const adapter = this.authorize(credential);
    return Promise.all(this.orderedQueue(adapter.owner).map((claim) => this.view(claim)));
  }
  public async reprioritize(credential: string, input: { readonly jobId: string; readonly priority: number }): Promise<JobView> {
    const adapter = this.authorize(credential);
    if (!input || Object.keys(input).sort().join(',') !== 'jobId,priority' || !Number.isInteger(input.priority) || input.priority < 0 || input.priority > 3) throw new CoreError('INVALID_REQUEST', 'Use priority 0 through 3', 'priority');
    const claim = this.#store.claim(input.jobId);
    if (claim.owner !== adapter.owner) throw new CoreError('TASK_AUTHORITY_DENIED');
    return this.serial(claim.id, async () => {
      if ((await this.snapshot(claim)).status !== 'active' || this.#store.worker(claim.id)) throw new CoreError('JOB_NOT_QUEUED');
      const updated = this.#store.database.connection.prepare('UPDATE gotzji_queue SET priority=? WHERE job_id=?').run(input.priority, claim.id);
      if (Number(updated.changes) !== 1) throw new CoreError('JOB_NOT_QUEUED');
      this.#store.event(claim.id, `priority:${input.priority}`, this.#now().toISOString());
      return this.view(claim);
    });
  }
  private orderedQueue(owner?: string): ClaimRow[] {
    return this.#store.database.connection.prepare(`SELECT c.* FROM gotzji_queue q JOIN gotzji_claims c ON c.id=q.job_id JOIN goals g ON g.id=c.goal_id WHERE g.status='active' AND NOT EXISTS(SELECT 1 FROM gotzji_workers w WHERE w.job_id=c.id) ${owner ? 'AND c.owner=?' : ''} ORDER BY MIN(3,q.priority+CAST(MAX(0,?-q.enqueued_at)/30000 AS INTEGER)) DESC,q.enqueue_seq ASC`).all(...(owner ? [owner, this.#now().getTime()] : [this.#now().getTime()])) as unknown as ClaimRow[];
  }
  public async submit(credential: string, preparationId: string): Promise<JobView> {
    const adapter = this.authorize(credential, true);
    const preparation = this.#store.database.connection.prepare('SELECT * FROM gotzji_preparations WHERE id=?').get(preparationId);
    if (!preparation || preparation.adapter !== adapter.id || !this.#store.acceptsPolicy(String(preparation.policy), this.#policy)) throw new CoreError('PREPARATION_DENIED');
    if (preparation.policy !== this.#policy) {
      const oldInput = JSON.parse(String(preparation.input)) as RequestInput;
      const oldClaim = this.#store.claim(hash(`${adapter.owner}\0${oldInput.requestId}`));
      if (oldClaim.owner !== adapter.owner || oldClaim.policy !== preparation.policy || oldClaim.digest !== preparation.digest) throw new CoreError('PREPARATION_DENIED');
      return this.view(oldClaim);
    }
    const input = this.validateInput(JSON.parse(String(preparation.input)) as RequestInput);
    const id = hash(`${adapter.owner}\0${input.requestId}`);
    const database = this.#store.database.connection;
    database.exec('BEGIN IMMEDIATE;');
    try {
      if (input.operation === 'grace.product-operation' && !database.prepare('SELECT 1 FROM gotzji_claims WHERE id=?').get(id)) {
        const waiting = database.prepare("SELECT COUNT(*) AS count FROM gotzji_claims c LEFT JOIN goals g ON c.goal_id=g.id WHERE c.owner=? AND json_extract(c.input,'$.operation')='grace.product-operation' AND (g.status='active' OR c.goal_id IS NULL) AND NOT EXISTS(SELECT 1 FROM gotzji_workers w WHERE w.job_id=c.id)").get(adapter.owner);
        if (Number(waiting?.count) >= 32) throw new CoreError('QUEUE_CAPACITY_REACHED', 'Wait for a queued job to start or cancel a selected job');
      }
      database.prepare('INSERT OR IGNORE INTO gotzji_claims VALUES (?,?,?,?,?,?,NULL,?)').run(id, adapter.owner, input.requestId, String(preparation.digest), JSON.stringify(input), `gotzji-${id}`, this.#policy);
      database.exec('COMMIT;');
    } catch (error) { database.exec('ROLLBACK;'); throw error; }
    const claim = this.#store.claim(id);
    if (claim.digest !== preparation.digest) throw new CoreError('REQUEST_DIGEST_CONFLICT');
    await this.serial(id, async (): Promise<void> => {
      const authorization = hash(JSON.stringify({owner:claim.owner,intent:claim.digest,boundary:'local',policy:this.#policy,revision:0}));
      this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_authorized_jobs VALUES (?,?,?,?,?,?,?)').run(claim.id,claim.owner,claim.digest,'local',this.#policy,authorization,0);
      await this.ensureGoal(claim);
      if (input.operation === 'grace.product-operation') {
        const operation = JSON.parse(input.text) as ProductOperation;
        this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_product_jobs(job_id,project_id,resource_key,operation,waiting_reason) VALUES (?,?,?,?,NULL)').run(claim.id, operation.project.projectId, operation.project.resourceKey, operation.input.operation);
        this.#store.database.connection.prepare('INSERT OR IGNORE INTO gotzji_queue SELECT ?,COALESCE(MAX(enqueue_seq),0)+1,?,? FROM gotzji_queue').run(claim.id, operation.input.priority ?? 1, this.#now().getTime());
        this.#store.event(claim.id, 'accepted', this.#now().toISOString());
      }
    });
    return this.view(claim);
  }
  /** Explicit task selection plus verified enrollment, returning adapter-private authority. */
  public select(credential: string, jobId: string): TaskBinding {
    const adapter = this.authorize(credential);
    const claim = this.#store.claim(jobId);
    if (claim.owner !== adapter.owner || !this.#store.acceptsPolicy(claim.policy, this.#policy)) throw new CoreError('TASK_AUTHORITY_DENIED');
    const handle = secret();
    this.#store.database.connection.prepare('INSERT INTO gotzji_bindings VALUES (?,?,?,?)').run(hash(handle), adapter.id, jobId, claim.policy);
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
  public async readOperationResult(credential: string, binding: TaskBinding): Promise<Record<string, unknown>> {
    const claim = this.bound(credential, binding);
    if (this.#store.input(claim).operation !== 'grace.product-operation' || (await this.view(claim)).status !== 'completed') throw new CoreError('RESULT_NOT_VERIFIED');
    const receipt = this.#store.operation(claim.id)?.receipt;
    if (!receipt) throw new CoreError('RESULT_NOT_VERIFIED');
    const result = JSON.parse(receipt) as Record<string, unknown>;
    const filename = path.join(this.effectRoot(claim.id), 'result.txt');
    if (lstatSync(filename).isSymbolicLink()) throw new CoreError('EFFECT_ROOT_CHANGED');
    const bytes = readFileSync(filename);
    if (hash(bytes) !== result.artifactHash) throw new CoreError('ARTIFACT_CHANGED');
    const output = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const prepared = JSON.parse(this.#store.input(claim).text) as PreparedProductOperation;
    if (prepared.kind === 'native' && 'outputPath' in prepared.native.input) {
      const native = output.nativeReceipt as { outputSha256?: string } | undefined;
      if (!native?.outputSha256 || hash(readFileSync(prepared.native.input.outputPath)) !== native.outputSha256) throw new CoreError('NATIVE_ARTIFACT_CHANGED');
    }
    if (output.operation === 'file.write') {
      const before = path.join(this.effectRoot(claim.id), 'before.bin');
      if (existsSync(before)) {
        if (lstatSync(before).isSymbolicLink()) throw new CoreError('ARTIFACT_CHANGED');
        const snapshot = readFileSync(before);
        if (hash(snapshot) !== output.beforeSha256) throw new CoreError('ARTIFACT_CHANGED');
        return { ...result, output, before: { sha256: hash(snapshot), content: snapshot.toString('utf8') } };
      }
    }
    return { ...result, output };
  }
  public logs(credential:string,binding:TaskBinding,cursor=0,limit=4000):{text:string;nextCursor:number} {
    const claim=this.bound(credential,binding);const worker=this.#store.worker(claim.id);
    if(!worker||!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>16000) throw new CoreError('INVALID_LOG_CURSOR');
    const filename=path.join(worker.directory,this.#store.input(claim).operation==='grace.product-operation'?'product.stdout':'validation.stdout');
    if(!existsSync(filename)) return {text:'',nextCursor:cursor};
    const info=lstatSync(filename);if(info.isSymbolicLink()||cursor>info.size) throw new CoreError('INVALID_LOG_CURSOR');
    const fd=openSync(filename,'r');try{const buffer=Buffer.alloc(Math.min(limit,info.size-cursor));const count=readSync(fd,buffer,0,buffer.length,cursor);return {text:buffer.subarray(0,count).toString('utf8'),nextCursor:cursor+count};}finally{closeSync(fd);}
  }
  public async resume(credential: string, binding: TaskBinding): Promise<JobView> {
    const claim = this.bound(credential, binding, true);
    return this.serial(claim.id, async (): Promise<JobView> => {
      this.assertEffects(claim);
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
        if (this.isRead(claim)) { await this.finishAbsentRead(claim, worker); return this.view(claim); }
        if (this.verifyEffect(claim)) {
          await this.reacquire(claim, worker);
          await this.complete(claim, this.requireWorker(claim.id));
          return this.view(claim);
        }
        const operation = this.#store.operation(claim.id);
        if (operation?.phase === 'started' || operation?.phase === 'uncertain' || operation?.phase === 'settled') {
          this.markUncertain(claim.id);
          throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
        }
        this.#store.database.connection.prepare('DELETE FROM gotzji_workers WHERE job_id=?').run(claim.id);
        this.releaseWriter(claim.id, worker.epoch);
      }
      return this.launchClaim(claim);
  }
  private async launchClaim(claim: ClaimRow, recovered?: WorkerRow): Promise<JobView> {
      if (this.#store.input(claim).operation === 'grace.product-operation' && !recovered) {
        const operation = JSON.parse(this.#store.input(claim).text) as ProductOperation;
        for (const dependencyId of operation.input.dependsOn ?? []) {
          const dependency = this.#store.claim(dependencyId);
          const state = await this.snapshot(dependency);
          if (state.status !== 'completed') {
            const waiting = state.status === 'active' ? 'WAITING_FOR_DEPENDENCY' : 'DEPENDENCY_FAILED';
            this.#store.database.connection.prepare('UPDATE gotzji_product_jobs SET waiting_reason=?,blocking_dependency=? WHERE job_id=?').run(waiting, dependencyId, claim.id);
            if (waiting === 'DEPENDENCY_FAILED') {
              const session = `dependency-${randomUUID()}`;
              const acquired = unwrap(await this.#service.runGoal(this.actor(claim, session), { workspaceId: WORKSPACE, goalKey: claim.goal_key, leaseSeconds: 300 }));
              if (!acquired.acquired || !acquired.leaseToken) throw new CoreError('LEASE_NOT_ACQUIRED');
              unwrap(await this.#service.finishGoal(this.actor(claim, session), { goalId: acquired.goalId, leaseToken: acquired.leaseToken, expectedRevision: acquired.revision, status: 'failed', summary: 'A required owned dependency did not complete successfully', evidence: [] }));
              this.#store.event(claim.id, waiting, this.#now().toISOString());
            }
            return this.view(claim);
          }
        }
        const limit = this.#store.database.connection.prepare('SELECT retry_at FROM gotzji_provider_limits WHERE owner=?').get(claim.owner);
        if (limit && (limit.retry_at === null || Number(limit.retry_at) > this.#now().getTime())) {
          this.#store.database.connection.prepare('UPDATE gotzji_product_jobs SET waiting_reason=? WHERE job_id=?').run('PROVIDER_LIMIT', claim.id);
          return this.view(claim);
        }
        if (limit) this.#store.database.connection.prepare('DELETE FROM gotzji_provider_limits WHERE owner=?').run(claim.owner);
        const earlier = this.orderedQueue().find((candidate) => this.isRead(candidate) === this.isRead(claim) && this.queueReady(candidate));
        if (earlier && earlier.id !== claim.id) {
          this.#store.database.connection.prepare('UPDATE gotzji_product_jobs SET waiting_reason=?,blocking_job=? WHERE job_id=?').run('PRIORITY_WAIT', earlier.id, claim.id);
          return this.view(claim);
        }
      }
      const epoch = randomUUID();
      if (!recovered) {
        const product = this.#store.input(claim).operation === 'grace.product-operation';
        const database = this.#store.database.connection;
        database.exec('BEGIN IMMEDIATE;');
        try {
          const scope = this.resourceScope(claim);
          const resources = this.resourceKeys(claim);
          const occupied = resources.map((key) => ({ key, row: database.prepare('SELECT job_id FROM gotzji_resource_claims WHERE resource_key=?').get(key) ?? database.prepare('SELECT job_id FROM gotzji_writers WHERE root=?').get(key) })).find((entry) => !!entry.row);
          const held = occupied?.row;
          const read = this.isRead(claim);
          const total = Number(database.prepare('SELECT COUNT(*) AS count FROM gotzji_writers').get()?.count);
          const writes = Number(database.prepare("SELECT COUNT(*) AS count FROM gotzji_writers WHERE root NOT LIKE 'read:%'").get()?.count);
          if (held || (product && (total >= GRACE_SLOTS || (!read && writes >= WRITE_SLOTS)))) {
            if (!product) throw new CoreError('LIBRARY_WRITER_HELD');
            // Name a job of the class whose slots are full: a write cap waits on writes, the shared cap frees fastest with reads.
            const capacityOwner = database.prepare(`SELECT job_id FROM gotzji_writers WHERE root ${!read && writes >= WRITE_SLOTS ? 'NOT ' : ''}LIKE 'read:%' ORDER BY rowid LIMIT 1`).get() ?? database.prepare('SELECT job_id FROM gotzji_writers ORDER BY rowid LIMIT 1').get();
            database.prepare('UPDATE gotzji_product_jobs SET waiting_reason=?,blocking_resource=?,blocking_job=? WHERE job_id=?').run(held ? 'RESOURCE_HELD' : 'WORKER_CAPACITY', occupied?.key ?? scope, String(held?.job_id ?? capacityOwner?.job_id ?? ''), claim.id);
            database.exec('COMMIT;');
            return this.view(claim);
          }
          database.prepare('INSERT INTO gotzji_writers VALUES (?,?,?)').run(scope, claim.id, epoch);
          for (const resource of resources) database.prepare('INSERT INTO gotzji_resource_claims VALUES (?,?,?)').run(resource, claim.id, epoch);
          if (product) database.prepare('UPDATE gotzji_product_jobs SET waiting_reason=NULL,blocking_resource=NULL,blocking_job=NULL,blocking_dependency=NULL WHERE job_id=?').run(claim.id);
          database.exec('COMMIT;');
        } catch (error) { database.exec('ROLLBACK;'); throw error; }
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
      const projectPolicies = input.operation === 'grace.product-operation' ? (JSON.parse(input.text) as ProductOperation).projectPolicies : {};
      const profile = this.#grace && input.operation === 'grace.product-operation' ? { ...this.#grace, documents: { ...this.#grace.documents, ...projectPolicies } } : this.#grace;
      const nativeTestRunner = this.#native?.testRunnerModule ? { path: realpathSync(this.#native.testRunnerModule), sha256: hash(readFileSync(this.#native.testRunnerModule)) } : undefined;
      const libraryTestRunner = this.#library?.testRunnerModule ? { path: realpathSync(this.#library.testRunnerModule), sha256: hash(readFileSync(this.#library.testRunnerModule)) } : undefined;
      const browserTestTransport = this.#browser?.testTransportModule ? { path: realpathSync(this.#browser.testTransportModule), sha256: hash(readFileSync(this.#browser.testTransportModule)) } : undefined;
      const preparedKind = input.operation === 'grace.product-operation' ? (JSON.parse(input.text) as PreparedProductOperation).kind : undefined;
      await launchWorker(worker, realpathSync(effectRoot), input.operation, input.text, { jobId: claim.id, owner: claim.owner, policy: this.#policy, database: path.join(this.#root,'core.sqlite'), intentRevision: acquired.userIntentRevision, authorizationDigest:String(authorization?.authorization_digest), grace: input.operation.startsWith('grace.') ? profile : null, privateRuntimeRoots:this.privateRuntimeRoots(), ...(preparedKind === 'native' && nativeTestRunner ? { nativeTestRunner } : {}), ...(preparedKind === 'library' && libraryTestRunner ? { libraryTestRunner } : {}), ...(preparedKind === 'browser' && browserTestTransport ? { browserTestTransport } : {}) });
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
  /**
   * App-only owner decision for a blocked project job that holds its project after its work ended: the core marked it
   * uncertain, its goal ended, or its worker reports finished work. Running work is never settled; Cancel stops it.
   * Records the decision with the observed bytes before ending an active goal as cancelled, then releases exactly this
   * job's claims. It never completes or delivers, stops only the job's own worker through the stop proof, and keeps a
   * completed job's verified receipt. Native, browser and Library jobs keep provider reconciliation.
   */
  public async settleBlockedJob(credential: string, binding: TaskBinding, decision: SettleDecision): Promise<JobView> {
    if (decision !== 'effect-present' && decision !== 'no-effect') throw new CoreError('SETTLE_DECISION_INVALID', 'Choose effect-present or no-effect', 'decision');
    const claim = this.bound(credential, binding);
    return this.serial(claim.id, async (): Promise<JobView> => {
      const goal = await this.ensureGoal(claim);
      const refusal = this.settleRefusal(claim, (await this.view(claim)).status, goal.status === 'active');
      if (refusal) throw new CoreError(refusal, SETTLE_REFUSALS[refusal], refusal === 'SETTLE_UNSUPPORTED' ? 'operation' : 'jobId');
      if (goal.status === 'completed' && decision === 'no-effect') throw new CoreError('SETTLE_DECISION_INVALID', 'This job completed with a verified effect', 'decision');
      const writer = this.#store.writer(claim.id) as WriterRow;
      const worker = this.#store.worker(claim.id);
      if (worker && !await stopWorker(worker)) throw new CoreError('WORKER_STOP_REQUIRED', SETTLE_REFUSALS.WORKER_STOP_REQUIRED, 'jobId');
      const summary = decision === 'effect-present' ? 'OWNER_SETTLED_EFFECT_PRESENT' : 'OWNER_SETTLED_NO_EFFECT';
      const prepared = JSON.parse(this.#store.input(claim).text) as ProductOperation;
      let observedSha256: string | null | undefined;
      if (prepared.input.operation === 'file.write' && prepared.target) { try { observedSha256 = hash(readFileSync(prepared.target)); } catch { observedSha256 = null; } }
      const observedAt = this.#now().toISOString();
      const database = this.#store.database.connection;
      // The decision is durable before the goal ends, so an interrupted settle leaves evidence and no 'started' phase behind.
      if (goal.status === 'completed') database.prepare('UPDATE gotzji_operations SET phase=? WHERE job_id=?').run('verified', claim.id);
      else database.prepare('INSERT INTO gotzji_operations(job_id,digest,phase,receipt) VALUES (?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET phase=excluded.phase,receipt=excluded.receipt')
        .run(claim.id, this.operationDigest(claim), 'settled', JSON.stringify({ verifier: 'owner-settlement-v1', decision, owner: claim.owner, observedAt, ...(observedSha256 === undefined ? {} : { observedSha256 }), previous: this.#store.operation(claim.id)?.receipt ?? null }));
      this.#store.event(claim.id, summary, observedAt);
      if (goal.status === 'active') unwrap(await this.#service.cancelGoal(this.actor(claim, 'settle'), { goalId: goal.goalId, expectedRevision: goal.revision, summary, evidence: [] }));
      this.#store.clearDiagnostic(claim.id);
      this.releaseWriter(claim.id, writer.epoch);
      return this.view(claim);
    });
  }
  /** One answer for the job view and the settle action; undefined means the owner may settle. Reads files only. */
  private settleRefusal(claim: ClaimRow, status: JobView['status'], active: boolean): keyof typeof SETTLE_REFUSALS | undefined {
    const input = this.#store.input(claim);
    const prepared = input.operation === 'grace.product-operation' ? JSON.parse(input.text) as PreparedProductOperation : undefined;
    if (!prepared || (prepared.kind !== undefined && prepared.kind !== 'basic')) return 'SETTLE_UNSUPPORTED';
    const writer = this.#store.writer(claim.id);
    if (!writer || status !== 'blocked') return 'JOB_NOT_SETTLEABLE';
    const worker = this.#store.worker(claim.id);
    if (!worker) return this.unlaunched(writer.epoch) ? undefined : 'WORKER_STOP_REQUIRED';
    if (worker.epoch !== writer.epoch) return 'WORKER_STOP_REQUIRED';
    if (!active) return undefined;
    // An active job's own uncertainty is no evidence: one slow status check marks live work uncertain. Only the worker's
    // signed record that its work ended counts; a dead worker that never recorded it is released through Cancel.
    let ended: boolean;
    try { ended = ['done', 'failed', 'cancelled'].includes(String(signed<{ state: string }>(worker, 'observation.json')?.state)) || !!signed<{ state: string }>(worker, 'stopped.json'); }
    catch { return 'WORKER_STOP_REQUIRED'; }
    return ended ? undefined : 'JOB_STILL_RUNNING';
  }
  /** Host supervisor tick: no caller credentials, receipt booleans or executables accepted. */
  public async tick(): Promise<void> {
    this.assertAuthority();
    const claims = this.#store.database.connection.prepare("SELECT c.* FROM gotzji_claims c LEFT JOIN goals g ON g.id=c.goal_id WHERE c.goal_id IS NOT NULL AND (g.id IS NULL OR g.goal_key<>c.goal_key OR g.status='active' OR EXISTS(SELECT 1 FROM gotzji_writers w WHERE w.job_id=c.id))").all() as unknown as ClaimRow[];
    const queue = this.orderedQueue();
    claims.sort((left, right) => {
      const a = queue.findIndex((entry) => entry.id === left.id); const b = queue.findIndex((entry) => entry.id === right.id);
      return (a < 0 ? -1 : a) - (b < 0 ? -1 : b);
    });
    let failure: unknown;
    for (const claim of claims) {
      try {
        await this.serial(claim.id, async (): Promise<void> => {
          const goal = await this.snapshot(claim);
          if (claim.policy !== this.#policy && goal.status === 'active') {
            this.#store.diagnose(claim.id, 'POLICY_RECONCILIATION_REQUIRED', this.#now().toISOString());
            return;
          }
          if (goal.status !== 'active') {
            if (this.#store.writer(claim.id)) await this.cleanupTerminal(claim);
          } else {
            const worker = this.#store.worker(claim.id);
            if (worker) { this.assertEffects(claim); await this.reconcile(claim, worker); }
            else if (this.#store.writer(claim.id)) await this.reconcileUnlaunchedWriter(claim);
            else if (this.#store.input(claim).operation === 'grace.product-operation') { this.assertEffects(claim); await this.resumeClaim(claim); }
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
  private assertEffects(claim?: ClaimRow): void {
    this.assertAuthority();
    if (this.#controlOnly) throw new CoreError('CONTROL_ONLY');
    if (this.#grace) this.assertGraceForClaim(claim);
    if (this.#policy !== this.policyFingerprint()) throw new CoreError('CORE_DEPENDENCIES_CHANGED');
  }
  private assertGraceForClaim(claim?: ClaimRow): void {
    if (!this.#grace) return;
    if (!claim || this.#store.input(claim).operation !== 'grace.product-operation') { assertGraceProfile(this.#grace); return; }
    const prepared = JSON.parse(this.#store.input(claim).text) as PreparedProductOperation;
    const worker = this.#store.worker(claim.id);
    if (prepared.kind !== 'library' || !worker) { assertGraceProfile(this.#grace); return; }
    const evolution = verifiedLibraryNavigationEvolution(prepared, this.#store.database.connection, claim.id, worker, this.effectRoot(claim.id));
    if (!evolution) { assertGraceProfile(this.#grace); return; }
    const entries = [{ path: this.#grace.executable, hash: this.#grace.executableHash }, { path: this.#grace.sourceFile, hash: this.#grace.sourceHash },
      ...Object.values(this.#grace.documents), ...(this.#grace.testDriver && this.#grace.testDriverHash ? [{ path: this.#grace.testDriver, hash: this.#grace.testDriverHash }] : [])];
    for (const entry of entries) {
      const expected = evolution.has(path.resolve(entry.path)) ? evolution.get(path.resolve(entry.path)) : entry.hash;
      if (expected === null) { if (existsSync(entry.path)) throw new CoreError('GRACE_DEPENDENCIES_CHANGED'); continue; }
      if (!existsSync(entry.path) || lstatSync(entry.path).isSymbolicLink() || realpathSync(entry.path) !== entry.path || hash(readFileSync(entry.path)) !== expected) throw new CoreError('GRACE_DEPENDENCIES_CHANGED');
    }
  }
  private policyFingerprint(): string {
    return hash(JSON.stringify(this.policyFingerprintComponents()));
  }
  private policyFingerprintComponents(): Record<string, unknown> {
    const source = (name: string): URL => { const authored = new URL(`../src/${name}.ts`, import.meta.url); return existsSync(authored) ? authored : new URL(`./${name}.js`, import.meta.url); };
    const libraryContracts = ['product-library','library-workflow-contract','library-workflow-adapter','library-workflow-registry'].map((name) => hash(readFileSync(source(name))));
    return { version: 8, root: this.#root,privateRuntimeRoots:this.#privateRuntimeRoots, control:hash(readFileSync(source('core'))), productContract:hash(readFileSync(source('product-projects'))), ledger:hash(readFileSync(source('store'))), nativeContract:hash(readFileSync(source('product-native'))), browserContract:hash(readFileSync(source('product-browser'))), libraryContracts, finalMemoContract:hash(readFileSync(new URL('./product-library-final-memo.mjs',import.meta.url))),
      nativeOptions:this.#native, nativeTestRunnerHash:this.#native?.testRunnerModule?hash(readFileSync(this.#native.testRunnerModule)):null,
      libraryOptions:this.#library?{pythonExecutable:this.#library.pythonExecutable,pythonSha256:this.#library.pythonSha256}:null, libraryTestRunnerHash:this.#library?.testRunnerModule?hash(readFileSync(this.#library.testRunnerModule)):null,
      browserRuntimeEnrollment:'private-pinned-session',browserTestTransportHash:this.#browser?.testTransportModule?hash(readFileSync(this.#browser.testTransportModule)):null,
      worker: workerFingerprint(), grace: this.#grace ? { ...this.#grace, documents: Object.fromEntries(Object.entries(this.#grace.documents).map(([name, entry]) => [name, { path: entry.path, hash: `prepared-document:${name}` }])) } : null, deliveryBoundary:'local', recipes: ['fixture.write','fixture.hold',...(this.#grace ? ['grace.read-save-check','grace.code-check'] : [])], curation: 'explicit-only' };
  }
  private authorize(credential: string, effects = false): AdapterRow { if (effects) this.assertEffects(); else this.assertAuthority(); return this.#store.adapter(credential, this.#policy); }
  private bound(credential: string, binding: TaskBinding, effects = false): ClaimRow {
    const adapter = this.authorize(credential,false);
    const claim = this.#store.claim(binding.jobId);
    const row = this.#store.database.connection.prepare('SELECT * FROM gotzji_bindings WHERE handle_hash=? AND adapter=? AND job_id=? AND policy=?').get(hash(binding.handle), adapter.id, binding.jobId, claim.policy);
    if (!row || claim.owner !== adapter.owner || !this.#store.acceptsPolicy(claim.policy, this.#policy)) throw new CoreError('TASK_AUTHORITY_DENIED');
    if (effects && claim.policy !== this.#policy) throw new CoreError('POLICY_RECONCILIATION_REQUIRED', 'Revalidate this unchanged job intent/project/effect under the new trusted runtime before resuming');
    if (effects) this.assertEffects(claim);
    return claim;
  }
  private validateInput(input: RequestInput): RequestInput {
    if (!input || Object.keys(input).sort().join(',') !== 'operation,requestId,text' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId) || !['fixture.write', 'fixture.hold','grace.read-save-check','grace.code-check','grace.product-operation'].includes(input.operation) || typeof input.text !== 'string' || Buffer.byteLength(input.text) > (input.operation === 'grace.product-operation' ? 100000 : 65536)) throw new CoreError('INVALID_REQUEST');
    if (input.operation === 'grace.read-save-check' && (!this.#grace || hash(input.text) !== this.#grace.sourceHash)) throw new CoreError('GRACE_PREPARATION_DENIED');
    if (input.operation === 'grace.code-check' && (this.#grace?.recipe !== 'code-check' || hash(input.text) !== this.#grace.expectedHash)) throw new CoreError('GRACE_PREPARATION_DENIED');
    if (this.#grace?.recipe === 'product' && input.operation !== 'grace.product-operation') throw new CoreError('QUALIFICATION_NOT_AVAILABLE');
    if (input.operation === 'grace.product-operation') {
      if (this.#grace?.recipe !== 'product') throw new CoreError('PRODUCT_PROFILE_REQUIRED');
      let operation: PreparedProductOperation;
      try { operation = JSON.parse(input.text) as PreparedProductOperation; } catch { throw new CoreError('INVALID_REQUEST', 'Invalid operation preparation', 'arguments'); }
      const project = this.#store.database.connection.prepare('SELECT registration FROM gotzji_projects WHERE owner=? AND project_id=?').get(operation.project?.owner ?? '', operation.project?.projectId ?? '');
      if (!project || String(project.registration) !== JSON.stringify(operation.project) || operation.input?.requestId !== input.requestId) throw new CoreError('PRODUCT_PREPARATION_DENIED');
      if(operation.kind==='browser'&&(!this.#browser||this.#browser.session.sessionId!==operation.browser.session.sessionId||this.#browser.manifestSha256!==operation.browser.manifestSha256||JSON.stringify(this.#browser.session)!==JSON.stringify(operation.browser.session)))throw new CoreError('BROWSER_SESSION_CHANGED');
    }
    return { requestId: input.requestId, operation: input.operation, text: input.text };
  }
  private actor(claim: ClaimRow, session: string): FileActor { return { clientId: claim.owner, clientName: 'Gotzji execution core', sessionId: session }; }
  private async snapshot(claim: ClaimRow): Promise<GoalSnapshot> { return unwrap(await this.#service.getGoal(this.actor(claim, 'core'), { workspaceId: WORKSPACE, goalKey: claim.goal_key })); }
  private async ensureGoal(claim: ClaimRow): Promise<GoalSnapshot> {
    const existing = await this.#goals.getByKey(WORKSPACE, claim.goal_key);
    if (!existing) {
      const input = this.#store.input(claim);
      const product = input.operation === 'grace.product-operation' ? JSON.parse(input.text) as ProductOperation : null;
      const result = unwrap(await this.#service.runGoal(this.actor(claim, `preparing-${claim.id}`), { workspaceId: WORKSPACE, goalKey: claim.goal_key, objective: product ? `Grace-controlled ${product.input.operation} in ${product.project.displayName}` : 'Qualify governed execution', plan: { steps: [{ id: 'effect', title: product ? 'Execute the approved project operation and verify its observed result' : 'Execute and independently verify the fixed qualification recipe' }] }, ...(input.operation==='grace.code-check'?{engineering:{schemaVersion:1 as const,primaryTaskKind:'bugfix' as const,riskTier:'low' as const,policyDigest:this.#policy,deliveryScope:'local' as const,gates:[{id:'focused_validation',title:'Actual registered command',applicability:'required' as const,status:'pending' as const,reason:'Host observed recipe verification',basedOnUserIntentRevision:0}]}}:{}), leaseSeconds: 300 }));
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
    const run=worker && claim.policy === this.#policy?this.codeRun(claim,worker):undefined;
    const preparedKind = worker && this.#store.input(claim).operation === 'grace.product-operation' ? (JSON.parse(this.#store.input(claim).text) as PreparedProductOperation).kind : undefined;
    const nativeProgress = worker && this.#store.input(claim).operation === 'grace.product-operation' ? signed<{ jobId: string; runId: string; state: string; elapsedMs: number; checks: number; lastProgressAt: string }>(worker, preparedKind === 'library' ? 'library-progress.json' : preparedKind === 'browser' ? 'browser-progress.json' : 'native-progress.json') : undefined;
    const product = this.#store.database.connection.prepare('SELECT * FROM gotzji_product_jobs WHERE job_id=?').get(claim.id);
    const providerLimit = product && goal.status === 'active' ? this.#store.database.connection.prepare('SELECT retry_at FROM gotzji_provider_limits WHERE owner=?').get(claim.owner) : undefined;
    const waitingForProvider = providerLimit && (providerLimit.retry_at === null || Number(providerLimit.retry_at) > this.#now().getTime());
    if (waitingForProvider) status = 'blocked';
    const progress = run ?? nativeProgress;
    const result: JobView = { jobId: claim.id, status, revision: goal.revision, operation: this.#store.input(claim).operation, evidenceDigest: operation?.receipt ? hash(operation.receipt) : null, curation: 'explicit-only', deliveryBoundary:'local', ...(product ? { projectId: String(product.project_id), requestedOperation: String(product.operation) as ProductOperationInput['operation'], ...(product.waiting_reason ? { waitingReason: String(product.waiting_reason) } : {}) } : {}), ...(progress?{progress:{runId:progress.runId,state:progress.state,elapsedMs:progress.elapsedMs,checks:progress.checks,lastProgressAt:progress.lastProgressAt}}:{}), ...(diagnostic ? {blockerCode:String(diagnostic.code)} : expired ? {blockerCode:'LEASE_RECOVERY_REQUIRED'} : {}) };
    const queued = product ? this.#store.database.connection.prepare('SELECT priority FROM gotzji_queue WHERE job_id=?').get(claim.id) : undefined;
    const position = product && status === 'queued' ? this.orderedQueue(claim.owner).findIndex((entry) => entry.id === claim.id) + 1 : 0;
    const projected: JobView = { ...result, requestId: claim.request_id, ...(goal.terminalSummary ? { summary: goal.terminalSummary } : {}), ...(waitingForProvider ? { status: 'blocked', blockerCode: 'GRACE_ACCOUNT_LIMIT', waitingReason: 'PROVIDER_LIMIT', ...(providerLimit.retry_at === null ? {} : { retryAt: new Date(Number(providerLimit.retry_at)).toISOString() }) } : {}), ...(claim.policy !== this.#policy && goal.status === 'active' ? { status: 'blocked', blockerCode: 'POLICY_RECONCILIATION_REQUIRED' } : {}), ...(queued ? { priority: Number(queued.priority), ...(position ? { queuePosition: position } : {}) } : {}), ...(product?.blocking_resource ? { blockingResource: String(product.blocking_resource) } : {}), ...(product?.blocking_job ? { blockingJob: String(product.blocking_job) } : {}), ...(product?.blocking_dependency ? { blockingDependency: String(product.blocking_dependency) } : {}) };
    return projected.status === 'blocked' && !this.settleRefusal(claim, 'blocked', goal.status === 'active') ? { ...projected, settleDecisions: goal.status === 'completed' ? ['effect-present'] : ['effect-present', 'no-effect'] } : projected;
  }
  private effectRoot(jobId: string): string { return path.join(this.#root, 'effects', jobId); }
  /** A basic project read is version-pinned, so it claims only its own scope and never a project. */
  private isRead(claim: ClaimRow): boolean {
    const input = this.#store.input(claim);
    if (input.operation !== 'grace.product-operation') return false;
    const prepared = JSON.parse(input.text) as PreparedProductOperation;
    return (prepared.kind === undefined || prepared.kind === 'basic') && prepared.input.operation === 'file.read';
  }
  private resourceScope(claim: ClaimRow): string {
    if (this.isRead(claim)) return `read:${claim.id}`;
    const product = this.#store.database.connection.prepare('SELECT resource_key FROM gotzji_product_jobs WHERE job_id=?').get(claim.id);
    return product ? `project:${String(product.resource_key)}` : this.#root;
  }
  private privateRuntimeRoots(): readonly string[] { return [...new Set([...this.#privateRuntimeRoots,...(this.#browser?[path.dirname(this.#browser.manifestPath),this.#browser.session.profilePath]:[])])]; }
  private resourceKeys(claim: ClaimRow): readonly string[] {
    const input = this.#store.input(claim);
    if (input.operation === 'grace.product-operation') {
      const prepared = JSON.parse(input.text) as PreparedProductOperation;
      if (prepared.kind === 'native') return prepared.native.resourceKeys;
      if (prepared.kind === 'library') return prepared.library.resources;
      if (prepared.kind === 'browser') return prepared.browser.resourceKeys;
    }
    return [this.resourceScope(claim)];
  }
  private queueReady(claim: ClaimRow): boolean {
    if (claim.policy !== this.#policy) return false;
    const limit = this.#store.database.connection.prepare('SELECT retry_at FROM gotzji_provider_limits WHERE owner=?').get(claim.owner);
    if (limit && (limit.retry_at === null || Number(limit.retry_at) > this.#now().getTime())) return false;
    if (this.resourceKeys(claim).some((resource) => this.#store.database.connection.prepare('SELECT 1 FROM gotzji_resource_claims WHERE resource_key=?').get(resource) || this.#store.database.connection.prepare('SELECT 1 FROM gotzji_writers WHERE root=?').get(resource)) || this.#store.database.connection.prepare('SELECT 1 FROM gotzji_diagnostics WHERE job_id=?').get(claim.id)) return false;
    const prepared = JSON.parse(this.#store.input(claim).text) as ProductOperation;
    return (prepared.input.dependsOn ?? []).every((id) => this.#store.database.connection.prepare('SELECT g.status FROM gotzji_claims c JOIN goals g ON g.id=c.goal_id WHERE c.id=?').get(id)?.status === 'completed');
  }
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
    this.assertEffects(claim);
    const current = this.requireWorker(claim.id);
    const writer = this.#store.database.connection.prepare('SELECT * FROM gotzji_writers WHERE root=?').get(this.resourceScope(claim));
    if (current.epoch !== worker.epoch || writer?.job_id !== claim.id || writer.epoch !== worker.epoch) throw new CoreError('WORKER_FENCE_INVALID');
    for (const resource of this.resourceKeys(claim)) if (!this.#store.database.connection.prepare('SELECT 1 FROM gotzji_resource_claims WHERE resource_key=? AND job_id=? AND epoch=?').get(resource, claim.id, worker.epoch)) throw new CoreError('WORKER_FENCE_INVALID');
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
    if (input.operation === 'grace.product-operation') {
      const prepared = JSON.parse(input.text) as PreparedProductOperation;
      const result = JSON.parse(effect.toString('utf8')) as Record<string, unknown>;
      if (result.state !== 'completed' || result.operation !== prepared.input.operation) return false;
      if (prepared.kind === 'native') {
        const filename = path.join(this.effectRoot(claim.id), 'native-operation.json');
        if (lstatSync(filename).isSymbolicLink()) throw new CoreError('NATIVE_EVIDENCE_INVALID');
        const envelope = JSON.parse(readFileSync(filename, 'utf8')) as { body: string; mac: string };
        const current = this.requireWorker(claim.id);
        if (createHmac('sha256', current.token).update(envelope.body).digest('hex') !== envelope.mac) throw new CoreError('NATIVE_EVIDENCE_INVALID');
        const state = JSON.parse(envelope.body) as { state: string; outcome: string; jobId: string; epoch: string; intentDigest: string; receipt: Record<string, unknown> };
        const receipt = result.nativeReceipt as { sourceSha256?: string; outputSha256?: string; originalPreserved?: boolean; savedAndReopened?: boolean; unrelatedPreserved?: boolean; verified?: boolean } | undefined;
        if (state.state !== 'completed' || state.outcome !== 'verified' || state.jobId !== claim.id || state.epoch !== current.epoch || state.intentDigest !== prepared.native.planDigest || JSON.stringify(state.receipt) !== effect.toString('utf8') || result.jobId !== claim.id || result.epoch !== current.epoch || result.intentDigest !== prepared.native.planDigest || result.scriptSha256 !== prepared.native.scriptSha256 || JSON.stringify(result.resourceKeys) !== JSON.stringify(prepared.native.resourceKeys) || receipt?.sourceSha256 !== prepared.beforeSha256 || !receipt.originalPreserved || !receipt.verified || hash(readFileSync(prepared.target)) !== prepared.beforeSha256) throw new CoreError('NATIVE_EVIDENCE_INVALID');
        if ('outputPath' in prepared.native.input && (!receipt.savedAndReopened || !receipt.unrelatedPreserved || !receipt.outputSha256 || hash(readFileSync(prepared.native.input.outputPath)) !== receipt.outputSha256)) throw new CoreError('NATIVE_ARTIFACT_CHANGED');
      } else if (prepared.kind === 'library') {
        const current = this.requireWorker(claim.id);
        const filename = path.join(this.effectRoot(claim.id), 'library-operation.json');
        if (!existsSync(filename) || lstatSync(filename).isSymbolicLink()) throw new CoreError('LIBRARY_EVIDENCE_INVALID');
        const envelope = JSON.parse(readFileSync(filename, 'utf8')) as { body: string; mac: string };
        if (createHmac('sha256', current.token).update(envelope.body).digest('hex') !== envelope.mac) throw new CoreError('LIBRARY_EVIDENCE_INVALID');
        const state = JSON.parse(envelope.body) as { state:string; outcome:string; jobId:string; epoch:string; intentDigest:string; resourceKeys:readonly string[]; receipt:Record<string,unknown> };
        if (state.state !== 'completed' || state.outcome !== 'verified' || state.jobId !== claim.id || state.epoch !== current.epoch || state.intentDigest !== prepared.library.digest
          || JSON.stringify(state.resourceKeys) !== JSON.stringify(prepared.library.resources) || JSON.stringify(state.receipt) !== effect.toString('utf8')
          || result.projectId !== prepared.project.projectId || result.workflowId !== prepared.library.ast.workflowId || result.workflowVersion !== prepared.library.ast.workflowVersion
          || result.intentDigest !== prepared.library.digest || result.sourceDigest !== prepared.library.sourceScope.digest || JSON.stringify(result.resourceKeys) !== JSON.stringify(prepared.library.resources)) throw new CoreError('LIBRARY_RECEIPT_INVALID');
        const steps = result.steps as readonly { stepId?:string; operation?:string; status?:string }[] | undefined;
        if (!Array.isArray(steps) || steps.length !== prepared.library.ast.nodes.length) throw new CoreError('LIBRARY_RECEIPT_INVALID');
        for (const step of prepared.library.ast.nodes) {
          const verified = this.#store.database.connection.prepare('SELECT phase,receipt FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(claim.id, `library-step:${step.id}`);
          if (!verified || verified.phase !== 'verified' || typeof verified.receipt !== 'string') throw new CoreError('LIBRARY_RECEIPT_INVALID');
          const stored = JSON.parse(String(verified.receipt)) as { receipt?: { stepId?:string; operation?:string; status?:string } };
          const reported = steps.find((entry) => entry.stepId === step.id);
          if (!reported || reported.operation !== step.operation || reported.status !== 'completed' || JSON.stringify(stored.receipt) !== JSON.stringify(reported)) throw new CoreError('LIBRARY_RECEIPT_INVALID');
        }
      } else if (prepared.kind === 'browser') {
        const current=this.requireWorker(claim.id);const evidenceFile=path.join(this.effectRoot(claim.id),'browser-operation.json');
        if(!existsSync(evidenceFile)||lstatSync(evidenceFile).isSymbolicLink())throw new CoreError('BROWSER_EVIDENCE_INVALID');
        const envelope=JSON.parse(readFileSync(evidenceFile,'utf8')) as {body:string;mac:string};
        if(createHmac('sha256',current.token).update(envelope.body).digest('hex')!==envelope.mac)throw new CoreError('BROWSER_EVIDENCE_INVALID');
        const state=JSON.parse(envelope.body) as {state:string;outcome:string;jobId:string;epoch:string;generation:number;intentDigest:string;resourceKeys:readonly string[];receipt:Record<string,unknown>};
        const browserReceipt=result.browserReceipt as {verified?:boolean;operationDigest?:string;initialBinding?:Record<string,string>;binding?:Record<string,string>;resourceKeys?:readonly string[];releaseResources?:boolean;steps?:readonly {operation?:string;after?:{tag?:string;text?:string;identity?:string}}[]}|undefined;
        const plannedSteps=prepared.browser.input.operation==='browser.workflow'?prepared.browser.input.steps:[prepared.browser.input];
        const navigations=plannedSteps.filter((entry)=>entry.operation==='browser.navigate') as readonly {operation:'browser.navigate';url:string}[];const lastNavigation=navigations.at(-1);
        const stableBindingKeys=['browserId','contextId','profileId','tabId','providerTabId'];
        if(state.state!=='completed'||state.outcome!=='verified'||state.jobId!==claim.id||state.epoch!==current.epoch||state.generation!==current.generation||state.intentDigest!==prepared.browser.planDigest
          ||JSON.stringify(state.resourceKeys)!==JSON.stringify(prepared.browser.resourceKeys)||JSON.stringify(state.receipt)!==effect.toString('utf8')||result.jobId!==claim.id||result.epoch!==current.epoch
          ||result.intentDigest!==prepared.browser.planDigest||result.projectId!==prepared.project.projectId||result.operation!==prepared.input.operation||result.sessionId!==prepared.input.sessionId||result.tabId!==prepared.input.tabId
          ||result.manifestSha256!==prepared.browser.manifestSha256||JSON.stringify(result.resourceKeys)!==JSON.stringify(prepared.browser.resourceKeys)||browserReceipt?.verified!==true
          ||browserReceipt.operationDigest!==prepared.browser.planDigest||JSON.stringify(browserReceipt.initialBinding)!==JSON.stringify(prepared.browser.input.binding)
          ||JSON.stringify(browserReceipt.resourceKeys)!==JSON.stringify(prepared.browser.adapterResourceKeys)||browserReceipt.releaseResources!==true)throw new CoreError('BROWSER_RECEIPT_INVALID');
        if(!browserReceipt.binding||stableBindingKeys.some((key)=>browserReceipt.binding?.[key]!==prepared.browser.input.binding[key as keyof typeof prepared.browser.input.binding]))throw new CoreError('BROWSER_RECEIPT_INVALID');
        if(lastNavigation){const navigationIndex=plannedSteps.map((entry)=>entry.operation).lastIndexOf('browser.navigate');const lastStep=browserReceipt.steps?.[navigationIndex];if(browserReceipt.binding.url!==lastNavigation.url||!browserReceipt.binding.documentId||browserReceipt.binding.documentId===prepared.browser.input.binding.documentId||lastStep?.operation!=='browser.navigate'||lastStep.after?.tag!=='DOCUMENT'||lastStep.after.text!==lastNavigation.url||lastStep.after.identity!==browserReceipt.binding.documentId)throw new CoreError('BROWSER_RECEIPT_INVALID');}
        else if(JSON.stringify(browserReceipt.binding)!==JSON.stringify(prepared.browser.input.binding))throw new CoreError('BROWSER_RECEIPT_INVALID');
      } else if (prepared.input.operation === 'command.run') {
        const run = signed<Record<string, unknown>>(this.requireWorker(claim.id), 'product-run.json');
        if (!run || JSON.stringify(run) !== effect.toString('utf8') || run.jobId !== claim.id || run.epoch !== this.requireWorker(claim.id).epoch || run.exitCode !== 0 || run.commandId !== prepared.command?.commandId || run.commandFingerprint !== hash(JSON.stringify(prepared.command))) throw new CoreError('COMMAND_RECEIPT_INVALID');
      } else {
        if (result.projectId !== prepared.project.projectId || result.path !== prepared.input.path || result.sha256 !== (prepared.afterSha256 ?? prepared.beforeSha256)) throw new CoreError('FILE_RECEIPT_INVALID');
        if (prepared.input.operation === 'file.write' && (!prepared.target || !existsSync(prepared.target) || realpathSync(prepared.target) !== prepared.target || hash(readFileSync(prepared.target)) !== prepared.afterSha256)) throw new CoreError('ARTIFACT_CHANGED');
        if (prepared.input.operation === 'file.read' && (typeof result.content !== 'string' || hash(result.content) !== prepared.beforeSha256)) throw new CoreError('FILE_RECEIPT_INVALID');
      }
      if (requireGraceCompletion) this.verifyGraceExecution(claim);
      const receipt = JSON.stringify({ recipe: input.operation, recipeDigest: operation.digest, artifactHash: hash(effect), bytes: effect.byteLength, verifier: 'host-product-receipt-v1', operation: prepared.input.operation, projectId: prepared.project.projectId });
      this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=?,receipt=? WHERE job_id=?').run('verified', receipt, claim.id);
      return true;
    }
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
    const product=this.#store.input(claim).operation==='grace.product-operation';
    const policies = product ? { ...this.#grace?.documents, ...(JSON.parse(this.#store.input(claim).text) as ProductOperation).projectPolicies } : this.#grace?.documents ?? {};
    for (const id of [...Object.keys(policies).map((name)=>'policy:'+name),...(product?['execute_operation','operation_status']:['read_source',...(code?['check_before','apply_change','start_validation','validation_status']:['save_result','check_result'])])]) {
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
      if (this.isRead(claim)) { await this.finishAbsentRead(claim, worker); return; }
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
      if (this.isRead(claim)) {
        const code = this.readFailure(claim);
        if (code) await this.failRead(claim, worker, code, hash(code)); else await this.complete(claim, worker);
        return;
      }
      if (this.verifyEffect(claim)) await this.complete(claim, worker);
      else {this.markUncertain(claim.id);throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');}
    } else if (observation.state === 'failed' || observation.state === 'cancelled') {
      if (this.#store.input(claim).operation === 'grace.product-operation') {
        const native = signed<{ state: string; code?: string }>(worker, 'native-progress.json');
        if (native?.state === 'uncertain') { this.markUncertain(claim.id); throw new CoreError(native.code ?? 'NATIVE_EFFECT_RECONCILIATION_REQUIRED', 'Inspect the selected native document and owned application before releasing resources', 'operation', 'native'); }
        if (native?.state === 'failed') {
          if (!await stopWorker(worker)) throw new CoreError('NATIVE_TERMINATION_UNCONFIRMED');
          const current = await this.snapshot(claim);
          unwrap(await this.#service.finishGoal(this.actor(claim, worker.session), { goalId: current.goalId, leaseToken: worker.lease, expectedRevision: current.revision, status: 'failed', summary: native.code ?? 'NATIVE_PROVIDER_FAILED', evidence: [{ kind: 'hash', value: hash(JSON.stringify(native)) }] }));
          this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=?,receipt=? WHERE job_id=?').run('verified', JSON.stringify({ verifier: 'host-native-no-effect-failure-v1', failure: native.code ?? 'NATIVE_PROVIDER_FAILED' }), claim.id);
          this.releaseWriter(claim.id, worker.epoch); return;
        }
        const prepared = JSON.parse(this.#store.input(claim).text) as PreparedProductOperation;
        const library = prepared.kind === 'library' ? signed<{ state:string; code?:string }>(worker, 'library-progress.json') : undefined;
        if (library?.state === 'uncertain') { this.markUncertain(claim.id); throw new CoreError(library.code ?? 'LIBRARY_EFFECT_RECONCILIATION_REQUIRED'); }
        if (library?.state === 'failed' && library.code === 'LIBRARY_FACTY_BLOCKED' && existsSync(path.join(this.effectRoot(claim.id),'result.txt'))) {
          if (!await stopWorker(worker)) throw new CoreError('CLEANUP_RECONCILIATION_REQUIRED');
          const current = await this.snapshot(claim);
          unwrap(await this.#service.finishGoal(this.actor(claim, worker.session), { goalId: current.goalId, leaseToken: worker.lease, expectedRevision: current.revision, status: 'failed', summary: 'LIBRARY_FACTY_BLOCKED', evidence: [{ kind:'hash', value:hash(readFileSync(path.join(this.effectRoot(claim.id),'result.txt'))) }] }));
          this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=?,receipt=? WHERE job_id=?').run('verified',JSON.stringify({verifier:'host-library-block-v1',failure:'LIBRARY_FACTY_BLOCKED'}),claim.id);
          this.releaseWriter(claim.id,worker.epoch);return;
        }
        const browser = prepared.kind === 'browser' ? signed<{ state:string; code?:string; outcome?:string }>(worker, 'browser-progress.json') : undefined;
        if (browser?.state === 'uncertain' || browser?.outcome === 'unknown') { this.markUncertain(claim.id); throw new CoreError(browser.code ?? 'BROWSER_EFFECT_RECONCILIATION_REQUIRED'); }
        if (browser?.state === 'failed' && browser.outcome === 'none') {
          if (!await stopWorker(worker)) throw new CoreError('CLEANUP_RECONCILIATION_REQUIRED');
          const current=await this.snapshot(claim);const code=browser.code??'BROWSER_PROVIDER_FAILED';
          unwrap(await this.#service.finishGoal(this.actor(claim,worker.session),{goalId:current.goalId,leaseToken:worker.lease,expectedRevision:current.revision,status:'failed',summary:code,evidence:[{kind:'hash',value:hash(JSON.stringify(browser))}]}));
          this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=?,receipt=? WHERE job_id=?').run('verified',JSON.stringify({verifier:'host-browser-no-effect-failure-v1',failure:code}),claim.id);
          this.releaseWriter(claim.id,worker.epoch);return;
        }
        const limit = signed<{ code: string; retryAt: string | null; jobId: string; eventsHash: string; apiKeySource: string; toolUseCount: number }>(worker, 'grace-runtime-failure.json');
        if (limit?.code === 'GRACE_ACCOUNT_LIMIT') {
          await this.waitForProvider(claim, worker, limit);
          return;
        }
        const run = signed<Record<string, unknown>>(worker, 'product-run.json');
        if (run && ['failed','cancelled'].includes(String(run.state)) && run.jobId === claim.id && run.epoch === worker.epoch) {
          if (!await stopWorker(worker)) throw new CoreError('CLEANUP_RECONCILIATION_REQUIRED');
          const current = await this.snapshot(claim);
          unwrap(await this.#service.finishGoal(this.actor(claim, worker.session), { goalId: current.goalId, leaseToken: worker.lease, expectedRevision: current.revision, status: 'failed', summary: String(run.reason ?? 'COMMAND_FAILED'), evidence: [{ kind: 'hash', value: hash(JSON.stringify(run)) }] }));
          this.#store.event(claim.id, String(run.reason ?? 'COMMAND_FAILED'), this.#now().toISOString());
          this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=?,receipt=? WHERE job_id=?').run('verified', JSON.stringify({ verifier: 'host-command-failure-v1', commandReceiptHash: hash(JSON.stringify(run)), failureCode: String(run.reason ?? 'COMMAND_FAILED') }), claim.id);
          this.releaseWriter(claim.id, worker.epoch);
          return;
        }
        const incident = signed<{ code: string; field?: string }>(worker, 'broker-error.json');
        if (incident && this.isRead(claim)) { await this.failRead(claim, worker, incident.code, hash(JSON.stringify(incident))); return; }
        if (incident) { this.markUncertain(claim.id); throw new CoreError(incident.code, 'Inspect the selected operation before retrying', incident.field); }
        if (this.isRead(claim)) { await this.failRead(claim, worker, 'READ_FAILED', hash('READ_FAILED')); return; }
      }
      this.markUncertain(claim.id);
      throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    } else if (this.#now().getTime() - worker.last_renewed >= 30000) {
      await this.validateWorker(claim, worker);
      await this.checkpoint(claim, worker, 'running');
    }
  }
  /** The failure code when a read's result cannot be verified; undefined when it can. */
  private readFailure(claim: ClaimRow): string | undefined {
    try { return this.verifyEffect(claim) ? undefined : 'READ_RESULT_MISSING'; }
    catch (error) { return error instanceof CoreError ? error.code : 'READ_RESULT_INVALID'; }
  }
  /** A read whose worker is proven gone completes from its verified result or ends failed; it never keeps its slot. */
  private async finishAbsentRead(claim: ClaimRow, worker: WorkerRow): Promise<void> {
    const code = this.readFailure(claim);
    await this.reacquire(claim, worker);
    const current = this.requireWorker(claim.id);
    if (code) await this.failRead(claim, current, code, hash(code)); else await this.complete(claim, current);
  }
  /** A read has no effect: any failure ends it failed and frees its slot instead of holding the job for the owner. */
  private async failRead(claim: ClaimRow, worker: WorkerRow, code: string, evidence: string): Promise<void> {
    if (!await stopWorker(worker)) throw new CoreError('CLEANUP_RECONCILIATION_REQUIRED');
    const current = await this.snapshot(claim);
    unwrap(await this.#service.finishGoal(this.actor(claim, worker.session), { goalId: current.goalId, leaseToken: worker.lease, expectedRevision: current.revision, status: 'failed', summary: code, evidence: [{ kind: 'hash', value: evidence }] }));
    this.#store.event(claim.id, code, this.#now().toISOString());
    this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=?,receipt=? WHERE job_id=?').run('verified', JSON.stringify({ verifier: 'host-read-no-effect-failure-v1', failure: code }), claim.id);
    this.releaseWriter(claim.id, worker.epoch);
  }
  private async reacquire(claim: ClaimRow, worker: WorkerRow): Promise<void> {
    if (await observeWorker(worker) !== 'absent') throw new CoreError('WORKER_RECONCILIATION_REQUIRED');
    const session = `reconciler-${randomUUID()}`;
    const acquired = unwrap(await this.#service.runGoal(this.actor(claim, session), { workspaceId: WORKSPACE, goalKey: claim.goal_key, leaseSeconds: 300 }));
    if (!acquired.acquired || !acquired.leaseToken) throw new CoreError('LEASE_NOT_ACQUIRED');
    this.#store.database.connection.prepare('UPDATE gotzji_workers SET session=?,lease=?,generation=? WHERE job_id=? AND epoch=?').run(session, acquired.leaseToken, acquired.leaseGeneration, claim.id, worker.epoch);
  }
  private async waitForProvider(claim: ClaimRow, worker: WorkerRow, receipt: { retryAt: string | null; jobId: string; eventsHash: string; apiKeySource: string; toolUseCount: number }): Promise<void> {
    const eventsFile = path.join(worker.directory, 'claude-events.jsonl');
    const events = readFileSync(eventsFile);
    const observed = events.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; message?: { content?: { type: string }[] } });
    if (receipt.jobId !== claim.id || receipt.apiKeySource !== 'none' || receipt.eventsHash !== hash(events) || receipt.toolUseCount !== 0 || observed.some((event) => event.type === 'assistant' && event.message?.content?.some((entry) => entry.type === 'tool_use')) || this.#store.database.connection.prepare('SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(claim.id, 'execute_operation') || existsSync(path.join(this.effectRoot(claim.id), 'result.txt')) || existsSync(path.join(worker.directory, 'product-run.json'))) throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    if (!await stopWorker(worker)) throw new CoreError('CLEANUP_RECONCILIATION_REQUIRED');
    const goal = await this.snapshot(claim);
    const retryAt = receipt.retryAt === null ? null : Date.parse(receipt.retryAt);
    if (retryAt !== null && !Number.isFinite(retryAt)) throw new CoreError('GRACE_LIMIT_RECEIPT_INVALID');
    unwrap(await this.#service.checkpointGoal(this.actor(claim, worker.session), { goalId: goal.goalId, leaseToken: worker.lease, expectedRevision: goal.revision, currentPhase: 'waiting-provider', summary: 'Subscribed Grace provider reported an account limit before any tool effect', stepUpdates: [], nextAction: receipt.retryAt ? `Retry the same owned job after ${receipt.retryAt}` : 'Resolve the reported account limit', blockers: ['GRACE_ACCOUNT_LIMIT'], evidence: [{ kind: 'hash', value: hash(JSON.stringify(receipt)) }], trackedTasks: [], releaseLease: true }));
    this.#store.database.connection.prepare('INSERT INTO gotzji_provider_limits VALUES (?,?,?,?) ON CONFLICT(owner) DO UPDATE SET job_id=excluded.job_id,retry_at=excluded.retry_at,receipt=excluded.receipt').run(claim.owner, claim.id, retryAt, JSON.stringify(receipt));
    this.#store.archiveWorker(worker, 'stopped', this.#now().toISOString());
    this.#store.database.connection.prepare('DELETE FROM gotzji_workers WHERE job_id=? AND epoch=?').run(claim.id, worker.epoch);
    this.#store.database.connection.prepare('DELETE FROM gotzji_recipe_operations WHERE job_id=?').run(claim.id);
    this.#store.database.connection.prepare('UPDATE gotzji_operations SET phase=?,receipt=NULL WHERE job_id=?').run('reserved', claim.id);
    this.#store.database.connection.prepare('UPDATE gotzji_product_jobs SET waiting_reason=? WHERE job_id=?').run('PROVIDER_LIMIT', claim.id);
    this.releaseWriter(claim.id, worker.epoch);
    this.#store.event(claim.id, 'GRACE_ACCOUNT_LIMIT', this.#now().toISOString());
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
    if (input.operation === 'grace.product-operation') {
      const prepared = JSON.parse(input.text) as PreparedProductOperation;
      if (prepared.kind === 'native') {
        const progress = signed<{ state: string; code?: string }>(worker, 'native-progress.json');
        if (progress && !['completed','failed'].includes(progress.state)) throw new CoreError('NATIVE_TERMINATION_UNCONFIRMED', 'Inspect the owned native application before releasing document and UI resources', 'operation', 'native');
        if (hash(readFileSync(prepared.target)) !== prepared.beforeSha256) throw new CoreError('NATIVE_ORIGINAL_CHANGED');
      } else if (prepared.kind !== 'library' && prepared.kind !== 'browser' && prepared.input.operation === 'file.write') {
        const safeCreate=prepared.beforeSha256===null&&!!prepared.target&&(!existsSync(prepared.target)||(realpathSync(prepared.target)===prepared.target&&!lstatSync(prepared.target).isSymbolicLink()&&hash(readFileSync(prepared.target))===prepared.afterSha256));
        const safeExisting=prepared.beforeSha256!==null&&!!prepared.target&&existsSync(prepared.target)&&realpathSync(prepared.target)===prepared.target&&!lstatSync(prepared.target).isSymbolicLink()&&[prepared.beforeSha256,prepared.afterSha256].includes(hash(readFileSync(prepared.target)));
        if (!safeCreate&&!safeExisting) {
          this.markUncertain(claim.id); throw new CoreError('EFFECT_RECONCILIATION_REQUIRED', 'The selected file no longer matches the approved before/after bytes', 'path');
        }
      }
    }
    if (input.operation !== 'fixture.hold' && input.operation !== 'grace.product-operation' && existsSync(path.join(this.effectRoot(claim.id), 'result.txt'))) this.verifyEffect(claim, false);
    this.releaseWriter(claim.id, worker.epoch);
  }
  private unlaunched(epoch: string): boolean {
    const directory = path.join(this.#root,'workers',epoch);
    if (existsSync(directory) && realpathSync(directory) !== directory) return false;
    for (const name of ['config.json','ready.json','observation.json']) {
      try { lstatSync(path.join(directory,name)); return false; }
      catch (error) { if (!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; }
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
      database.prepare('UPDATE gotzji_resource_claims SET epoch=? WHERE job_id=? AND epoch=?').run(epoch, claim.id, worker.epoch);
      database.prepare('DELETE FROM gotzji_workers WHERE job_id=? AND epoch=?').run(claim.id,worker.epoch);
      database.prepare('UPDATE gotzji_operations SET phase=?,receipt=NULL WHERE job_id=?').run('reserved',claim.id);
      database.prepare('DELETE FROM gotzji_recipe_operations WHERE job_id=?').run(claim.id);
      database.exec('COMMIT;');
    } catch (error) { database.exec('ROLLBACK;'); throw error; }
  }
  private async recoverExpired(claim: ClaimRow, worker: WorkerRow): Promise<void> {
    this.assertEffects(claim);
    this.#store.diagnose(claim.id,'LEASE_RECOVERY_REQUIRED',this.#now().toISOString());
    const config = JSON.parse(readFileSync(path.join(worker.directory,'config.json'),'utf8')) as {intentRevision:number};
    const goal = await this.snapshot(claim);
    if (goal.userIntentRevision !== config.intentRevision) throw new CoreError('INTENT_RECONCILIATION_REQUIRED');
    this.authorization(claim,goal.userIntentRevision);
    const input = this.#store.input(claim);
    const codeRunBefore=input.operation==='grace.code-check'?this.codeRun(claim,worker):undefined;
    if (!await stopWorker(worker)) throw new CoreError('CLEANUP_RECONCILIATION_REQUIRED');
    if (this.isRead(claim)) { await this.finishAbsentRead(claim, worker); this.#store.clearDiagnostic(claim.id); return; }
    const operation = this.#store.operation(claim.id);
    if (!operation || operation.digest !== this.operationDigest(claim) || operation.phase === 'revoked' || operation.phase === 'uncertain') throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    const filename = path.join(this.effectRoot(claim.id),'result.txt');
    let complete = false;
    if (existsSync(filename)) {
      this.verifyEffect(claim,false); // Unknown bytes keep the held writer.
      if (input.operation === 'fixture.write') complete = true;
      else if (input.operation === 'grace.read-save-check' || input.operation === 'grace.code-check' || input.operation === 'grace.product-operation') {
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
    if (input.operation === 'grace.product-operation' && !complete) throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    if (!['fixture.hold','fixture.write','grace.read-save-check','grace.code-check','grace.product-operation'].includes(input.operation)) throw new CoreError('EFFECT_RECONCILIATION_REQUIRED');
    // Only these reviewed recipes have a proved bounded effect set. The
    // snapshot save is exclusive/idempotent; its verifier is read-only.
    this.#store.archiveWorker(worker,'stopped',this.#now().toISOString());
    await this.reacquire(claim,worker);
    const recovered = this.requireWorker(claim.id);
    if (complete) await this.complete(claim,recovered);
    else await this.launchClaim(claim,recovered);
    this.#store.clearDiagnostic(claim.id);
  }
  private releaseWriter(jobId: string, epoch: string): void {
    const database = this.#store.database.connection; database.exec('BEGIN IMMEDIATE;');
    try { database.prepare('DELETE FROM gotzji_resource_claims WHERE job_id=? AND epoch=?').run(jobId, epoch); database.prepare('DELETE FROM gotzji_writers WHERE job_id=? AND epoch=?').run(jobId, epoch); database.exec('COMMIT;'); }
    catch (error) { database.exec('ROLLBACK;'); throw error; }
  }
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
