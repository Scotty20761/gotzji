import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecutionCore } from './core.js';
import { GotzjiConnectionService, type ProductConnectionStatus } from './product-connection.js';
import { productControlSchema, startProductHttp } from './product-http.js';
import { windowsProductSecretProtector, type ProductSecretProtector } from './product-host.js';
import { CoreError, type TaskBinding } from './types.js';

interface ChannelConfiguration { schemaVersion: 1; ownerId: string; credential: string; mcpPathSecret: string; projectIds: string[] }
export interface LibraryChannelOptions { readonly directory: string; readonly ownerId: string; readonly primaryCredential: string; readonly core: ExecutionCore; readonly version: string; readonly allowWork: () => boolean; readonly tunnel?: { readonly executable: string; readonly executableSha256: string }; readonly protector?: ProductSecretProtector }
/** A second transport adapter over the SAME core/ledger, never a second engine. */
export class ProductLibraryChannel {
  private config: ChannelConfiguration | undefined;
  private listener: Awaited<ReturnType<typeof startProductHttp>> | undefined;
  private connection: GotzjiConnectionService | undefined;
  private readonly protector: ProductSecretProtector;
  private initializing: Promise<void> | undefined;
  private readonly preparationIds = new Set<string>();
  private mutation: Promise<unknown> = Promise.resolve();
  public constructor(private readonly options: LibraryChannelOptions) { this.protector = options.protector ?? windowsProductSecretProtector(); }
  public async restore(): Promise<void> { if (existsSync(this.statePath())) await this.initialize(); }
  public enroll(projectId: string): Promise<unknown> { return this.serial(async () => {
    if (!this.options.allowWork()) throw new CoreError('PRODUCT_BUILD_RECONCILIATION_REQUIRED');
    const project = this.options.core.listProjects(this.options.primaryCredential).find((entry) => entry.projectId === projectId && entry.kind === 'library');
    if (!project || project.owner !== this.options.ownerId) throw new CoreError('LIBRARY_ROUTE_AUTHORITY_DENIED');
    await this.initialize(); const config = this.config!;
    this.options.core.enrollLibraryRoute(config.credential, { projectId, route: 'lnwjud-library' });
    if (!config.projectIds.includes(projectId)) { const next = { ...config, projectIds: [...config.projectIds, projectId] }; await this.save(next); this.config = next; }
    return this.status();
  }); }
  public async status(): Promise<unknown> { return { channel: 'lnwjud-library', state: this.listener ? 'enrolled' : 'not-enrolled', projectIds: this.config?.projectIds ?? [], connection: this.connection ? await this.connection.status() : { state: 'not-configured', configured: false, transport: 'openai-secure-mcp-tunnel' } }; }
  public async configure(input: { tunnelId: string; runtimeKey: string; organizationId?: string }): Promise<ProductConnectionStatus> { if (!this.connection) throw new CoreError('LIBRARY_CHANNEL_ENROLLMENT_REQUIRED'); return this.connection.configure(input); }
  public async start(): Promise<ProductConnectionStatus> { if (!this.connection) throw new CoreError('LIBRARY_CHANNEL_ENROLLMENT_REQUIRED'); return this.connection.start(); }
  public async stop(): Promise<ProductConnectionStatus> { if (!this.connection) throw new CoreError('LIBRARY_CHANNEL_ENROLLMENT_REQUIRED'); return this.connection.stop(); }
  public async close(): Promise<void> { if (this.listener) await this.listener.close(); this.listener = undefined; }
  private initialize(): Promise<void> {
    if (this.listener) return Promise.resolve(); if (this.initializing) return this.initializing;
    const pending = this.boot().finally(() => { if (this.initializing === pending) this.initializing = undefined; }); this.initializing = pending; return pending;
  }
  private async boot(): Promise<void> {
    if (existsSync(this.statePath())) {
      if (lstatSync(this.statePath()).isSymbolicLink()) throw new CoreError('LIBRARY_CHANNEL_OWNER_DENIED');
      const envelope = JSON.parse(readFileSync(this.statePath(), 'utf8')) as { schemaVersion: number; payload: string };
      if (envelope.schemaVersion !== 1 || typeof envelope.payload !== 'string' || envelope.payload.length > 32768) throw new CoreError('LIBRARY_CHANNEL_OWNER_DENIED');
      const config = JSON.parse(await this.protector.unprotect(envelope.payload)) as ChannelConfiguration;
      if (config.schemaVersion !== 1 || config.ownerId !== this.options.ownerId || !/^[a-f0-9]{64}$/u.test(config.credential) || !/^[a-f0-9]{64}$/u.test(config.mcpPathSecret) || !Array.isArray(config.projectIds) || config.projectIds.some((entry) => !/^[a-zA-Z0-9_-]{1,64}$/u.test(entry))) throw new CoreError('LIBRARY_CHANNEL_OWNER_DENIED');
      this.config = config;
    } else {
      this.config = { schemaVersion: 1, ownerId: this.options.ownerId, credential: randomBytes(32).toString('hex'), mcpPathSecret: randomBytes(32).toString('hex'), projectIds: [] };
      // Credential persistence precedes idempotent enrollment, including crash recovery.
      await this.save(this.config);
    }
    const config = this.config;
    if (this.options.allowWork()) {
      this.options.core.ensureAdapterEnrollment('lnwjud-library', this.options.ownerId, config.credential);
      for (const projectId of config.projectIds) this.options.core.enrollLibraryRoute(config.credential, { projectId, route: 'lnwjud-library' });
    } else await this.options.core.list(config.credential, { limit: 1 });
    const controls = new Set(['health', 'list', 'inspectQueue', 'status', 'logs', 'result', 'cancel']);
    const schema = (method: string): Record<string, unknown> => {
      const value = productControlSchema(method);
      if (method !== 'prepareOperation') return value;
      const variants = value.oneOf as Record<string, unknown>[];
      return { oneOf: variants.filter((entry) => (entry.properties as Record<string, { const?: unknown }>).operation?.const === 'library.workflow') };
    };
    this.listener = await startProductHttp({ token: randomBytes(32).toString('hex'), mcpPathSecret: config.mcpPathSecret, serverName: 'gotzji-lnwjud-library', version: this.options.version, inputSchema: schema, rpc: async (method, input, surface) => {
      if (surface !== 'mcp') throw new CoreError('LIBRARY_CHANNEL_APP_DENIED');
      if (!this.options.allowWork() && !controls.has(method)) throw new CoreError('PRODUCT_BUILD_RECONCILIATION_REQUIRED');
      switch (method) {
        case 'health': return { product: 'gotzji', channel: 'lnwjud-library', state: this.options.allowWork() ? 'ready' : 'control-only', authorityId: this.options.core.authority().authorityId };
        case 'listProjects': return this.options.core.listProjects(config.credential).filter((entry) => this.config!.projectIds.includes(entry.projectId));
        case 'catalog': return this.options.core.catalog(config.credential).filter((entry) => entry.name === 'library.workflow' && this.config!.projectIds.includes(String(entry.projectId)));
        case 'prepareOperation': { if (input.operation !== 'library.workflow' || !this.config!.projectIds.includes(String(input.projectId))) throw new CoreError('LIBRARY_ROUTE_AUTHORITY_DENIED'); const preparation = await this.options.core.prepareOperation(config.credential, input as never); this.preparationIds.add(preparation.preparationId); return preparation; }
        case 'submit': if (!this.preparationIds.has(String(input.preparationId))) throw new CoreError('LIBRARY_PREPARATION_RESELECT_REQUIRED'); return this.options.core.submit(config.credential, String(input.preparationId));
        case 'list': return this.options.core.list(config.credential, { ...(input.limit === undefined ? {} : { limit: Number(input.limit) }), ...(input.before === undefined ? {} : { before: String(input.before) }), operation: 'library.workflow', projectIds: this.config!.projectIds });
        case 'inspectQueue': return (await this.options.core.inspectQueue(config.credential)).filter((entry) => entry.requestedOperation === 'library.workflow' && this.config!.projectIds.includes(entry.projectId ?? ''));
        case 'reprioritize': await this.binding(String(input.jobId)); return this.options.core.reprioritize(config.credential, input as never);
        case 'status': return this.options.core.get(config.credential, await this.binding(String(input.jobId)));
        case 'logs': return this.options.core.logs(config.credential, await this.binding(String(input.jobId)), Number(input.cursor ?? 0), Number(input.limit ?? 4000));
        case 'result': return this.options.core.readOperationResult(config.credential, await this.binding(String(input.jobId)));
        case 'cancel': return this.options.core.cancel(config.credential, await this.binding(String(input.jobId)));
        case 'resume': return this.options.core.resume(config.credential, await this.binding(String(input.jobId)));
        default: throw new CoreError('LIBRARY_CHANNEL_METHOD_DENIED');
      }
    } });
    const body = JSON.stringify({ channel: 'lnwjud-library', port: this.listener.port, pid: process.pid, ownerId: this.options.ownerId, authorityId: this.options.core.authority().authorityId });
    writeFileSync(path.join(this.options.directory, 'product-lnwjud-library-endpoint.json'), JSON.stringify({ body, mac: createHmac('sha256', config.credential).update(body).digest('hex') }), { mode: 0o600 });
    if (this.options.tunnel) { this.connection = new GotzjiConnectionService({ directory: this.options.directory, ownerId: this.options.ownerId, ...this.options.tunnel, channel: 'lnwjud-library', mcpTarget: (): string => `http://127.0.0.1:${this.listener!.port}/mcp/${config.mcpPathSecret}` }); if (this.options.allowWork()) await this.connection.restore(); }
  }
  /** A job of this channel's projects, found directly rather than in a page of jobs, so older jobs stay reachable. */
  private async binding(jobId: string): Promise<TaskBinding> {
    for (const projectId of this.config!.projectIds) { try { return this.options.core.selectLibraryJob(this.config!.credential, projectId, jobId); } catch { /* not this project's Library job */ } }
    throw new CoreError('LIBRARY_ROUTE_AUTHORITY_DENIED');
  }
  private statePath(): string { return path.join(this.options.directory, 'product-lnwjud-library.sealed.json'); }
  private async save(config: ChannelConfiguration): Promise<void> { const candidate = `${this.statePath()}.${randomUUID()}.tmp`; writeFileSync(candidate, JSON.stringify({ schemaVersion: 1, payload: await this.protector.protect(JSON.stringify(config)) }), { flag: 'wx', mode: 0o600 }); renameSync(candidate, this.statePath()); }
  private serial<T>(action: () => Promise<T>): Promise<T> { const promise = this.mutation.then(action); this.mutation = promise.catch(() => undefined); return promise; }
}
