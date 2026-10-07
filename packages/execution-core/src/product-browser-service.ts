import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecutionCore } from './core.js';
import { createTrustedProductBrowserEnrollment, verifyOwnedProductBrowserSession } from './product-browser-broker.mjs';
import type { ProductBrowserPublicBinding, TrustedProductBrowserEnrollment, TrustedProductBrowserOptions } from './product-browser.js';
import { windowsProductSecretProtector, type ProductSecretProtector } from './product-host.js';
import { CoreError } from './types.js';

interface StoredBrowser { schemaVersion: 1; ownerId: string; projectId: string; options: Omit<TrustedProductBrowserOptions, 'verifyOwnedSession'>; publicBinding: ProductBrowserPublicBinding }
export interface ProductBrowserServiceOptions { readonly directory: string; readonly ownerId: string; readonly credential: string; readonly executable: string; readonly executableSha256: string; readonly prerequisite: { readonly path: string; readonly hash: string }; readonly core: ExecutionCore; readonly protector?: ProductSecretProtector }

/** Browser creation/enrollment is owner setup. Work still enters prepare/Grace. */
export class ProductBrowserService {
  private current: { projectId: string; enrollment: TrustedProductBrowserEnrollment } | undefined;
  private readonly protector: ProductSecretProtector;
  private mutation: Promise<unknown> = Promise.resolve();
  public constructor(private readonly options: ProductBrowserServiceOptions) { this.protector = options.protector ?? windowsProductSecretProtector(); mkdirSync(path.join(options.directory, 'browser-sessions'), { recursive: true, mode: 0o700 }); }
  public start(input: { projectId: string; startUrl: string; allowedOrigins?: readonly string[] }): Promise<unknown> { return this.serial(async () => {
    if (!input || Object.keys(input).some((key) => !['projectId', 'startUrl', 'allowedOrigins'].includes(key))) throw new CoreError('BROWSER_INPUT_INVALID');
    const project = this.options.core.listProjects(this.options.credential).find((entry) => entry.projectId === input.projectId);
    if (!project || project.owner !== this.options.ownerId) throw new CoreError('BROWSER_PROJECT_DENIED');
    if (this.current) { if (this.current.projectId !== project.projectId) throw new CoreError('BROWSER_SESSION_STOP_REQUIRED'); return this.project(); }
    const url = new URL(input.startUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new CoreError('BROWSER_URL_SCOPE_DENIED');
    const enrollment = await createTrustedProductBrowserEnrollment(project, { profileParent: path.join(this.options.directory, 'browser-sessions'), chromeExecutable: this.options.executable, executableSha256: this.options.executableSha256, startUrl: input.startUrl, allowedOrigins: input.allowedOrigins ?? [url.origin], prerequisites: [this.options.prerequisite] });
    try { await this.options.core.enrollBrowserSession(this.options.credential, enrollment.options); await this.save(project.projectId, enrollment); }
    catch (error) { await enrollment.stop(); throw error; }
    this.current = { projectId: project.projectId, enrollment }; return this.project();
  }); }
  public inspect(projectId: string): Promise<unknown> { return this.serial(async () => {
    if (!this.current) return { state: 'not-enrolled', projectId };
    if (this.current.projectId !== projectId) throw new CoreError('BROWSER_PROJECT_DENIED');
    if (!await verifyOwnedProductBrowserSession(this.current.enrollment.options.session)) return { state: 'unavailable', projectId, reason: 'BROWSER_SESSION_UNVERIFIED' };
    if (!await this.busy()) {
      const refreshed = await this.current.enrollment.refresh();
      await this.options.core.enrollBrowserSession(this.options.credential, refreshed.options);
      this.current = { projectId, enrollment: { ...this.current.enrollment, ...refreshed } }; await this.save(projectId, this.current.enrollment);
    }
    return this.project();
  }); }
  public stop(projectId: string): Promise<unknown> { return this.serial(async () => {
    if (!this.current) return { state: 'not-enrolled', projectId };
    if (this.current.projectId !== projectId) throw new CoreError('BROWSER_PROJECT_DENIED');
    if (await this.busy()) throw new CoreError('BROWSER_SESSION_HAS_RETAINED_JOBS');
    const sessionId = this.current.enrollment.options.session.sessionId;
    this.options.core.clearBrowserSession(this.options.credential, sessionId);
    await this.current.enrollment.stop(); this.current = undefined;
    // A terminal record stays protected for restart reconstruction; it carries
    // no executable callbacks and cannot make a new session appear owned.
    await this.protectedWrite({ schemaVersion: 1, ownerId: this.options.ownerId, stopped: true });
    return { state: 'stopped', projectId };
  }); }
  public async restore(): Promise<void> {
    const filename = this.statePath(); if (!existsSync(filename)) return;
    if (lstatSync(filename).isSymbolicLink()) throw new CoreError('BROWSER_ENROLLMENT_DENIED');
    const envelope = JSON.parse(readFileSync(filename, 'utf8')) as { schemaVersion: number; payload: string };
    if (envelope.schemaVersion !== 1 || typeof envelope.payload !== 'string' || envelope.payload.length > 32768) throw new CoreError('BROWSER_ENROLLMENT_DENIED');
    const record = JSON.parse(await this.protector.unprotect(envelope.payload)) as StoredBrowser & { stopped?: boolean };
    if (record.ownerId !== this.options.ownerId || record.schemaVersion !== 1) throw new CoreError('BROWSER_OWNER_DENIED');
    if (record.stopped) return;
    // Restoration is completed through the provider's exact native ownership
    // helper. A missing process never authorizes ambient browser adoption.
    if (!record.options?.session || record.options.session.owner !== this.options.ownerId || record.options.session.projectId !== record.projectId) throw new CoreError('BROWSER_OWNER_DENIED');
    if (!await verifyOwnedProductBrowserSession(record.options.session)) return;
    const module = await import('./product-browser-broker.mjs');
    if (!('restoreTrustedProductBrowserEnrollment' in module) || typeof module.restoreTrustedProductBrowserEnrollment !== 'function') throw new CoreError('BROWSER_RESTORATION_UNAVAILABLE');
    const project = this.options.core.listProjects(this.options.credential).find((entry) => entry.projectId === record.projectId);
    if (!project || project.owner !== this.options.ownerId) throw new CoreError('BROWSER_PROJECT_DENIED');
    const enrollment = await module.restoreTrustedProductBrowserEnrollment(project, record.options) as TrustedProductBrowserEnrollment;
    await this.options.core.enrollBrowserSession(this.options.credential, enrollment.options); this.current = { projectId: project.projectId, enrollment };
  }
  public projection(): unknown { return this.current ? this.project() : { state: 'not-enrolled' }; }
  private project(): unknown { return this.current ? { state: 'ready', projectId: this.current.projectId, ...this.current.enrollment.publicBinding } : { state: 'not-enrolled' }; }
  private async busy(): Promise<boolean> { return (await this.options.core.list(this.options.credential)).some((entry) => entry.requestedOperation?.startsWith('browser.') && !['completed', 'cancelled', 'failed'].includes(entry.status)); }
  private async save(projectId: string, enrollment: TrustedProductBrowserEnrollment): Promise<void> {
    const { verifyOwnedSession: _verify, ...options } = enrollment.options; void _verify;
    await this.protectedWrite({ schemaVersion: 1, ownerId: this.options.ownerId, projectId, options, publicBinding: enrollment.publicBinding });
  }
  private statePath(): string { return path.join(this.options.directory, 'product-browser.sealed.json'); }
  private async protectedWrite(value: object): Promise<void> {
    const candidate = `${this.statePath()}.${randomUUID()}.tmp`; const payload = await this.protector.protect(JSON.stringify(value));
    writeFileSync(candidate, JSON.stringify({ schemaVersion: 1, payload }), { flag: 'wx', mode: 0o600 }); renameSync(candidate, this.statePath());
  }
  private serial<T>(action: () => Promise<T>): Promise<T> { const promise = this.mutation.then(action); this.mutation = promise.catch(() => undefined); return promise; }
}
export function productBrowserPrerequisite(filename: string): { path: string; hash: string } { return { path: filename, hash: createHash('sha256').update(readFileSync(filename)).digest('hex') }; }
