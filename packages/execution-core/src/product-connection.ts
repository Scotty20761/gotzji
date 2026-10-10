import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { processIdentities, sameProcessIdentity, type ProcessIdentity } from './process-identity.mjs';
import { windowsProductSecretProtector, type ProductSecretProtector } from './product-host.js';
import { CoreError } from './types.js';

interface ConnectionConfiguration {
  schemaVersion: 1; ownerId: string; tunnelId: string; runtimeKey: string; bridgeSecret: string; desiredActive: boolean;
  channel?: 'product' | 'lnwjud-library';
  organizationId?: string;
  process?: { pid: number; identity?: ProcessIdentity; executableSha256: string };
}
export interface ProductConnectionStatus {
  readonly state: 'not-configured' | 'stopped' | 'connecting' | 'ready' | 'unavailable' | 'reconciliation-required';
  readonly configured: boolean; readonly transport: 'openai-secure-mcp-tunnel'; readonly tunnelId?: string; readonly errorCode?: string;
}
export interface ProductConnectionOptions {
  readonly directory: string; readonly ownerId: string; readonly executable: string; readonly executableSha256: string;
  readonly mcpTarget: () => string; readonly protector?: ProductSecretProtector;
  readonly channel?: 'product' | 'lnwjud-library';
}
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const equal = (expected: string, observed: string | undefined): boolean => { const left = Buffer.from(expected); const right = Buffer.from(observed ?? ''); return left.length === right.length && timingSafeEqual(left, right); };

/** Trusted host composition only; no caller URL, credential or command inputs. */
export function productTunnelProfile(tunnelId: string, bridgePort: number, healthFile: string, organizationId?: string): object {
  return { config_version: 1, control_plane: { base_url: 'https://api.openai.com', tunnel_id: tunnelId, api_key: 'env:CONTROL_PLANE_API_KEY', ...(organizationId ? { organization_id: organizationId } : {}) },
    health: { listen_addr: '127.0.0.1:0', url_file: healthFile }, admin_ui: { open_browser: false },
    log: { level: 'warn', format: 'json', file: 'stdout', http_raw_unsafe: false },
    mcp: { connection_max_ttl: '168h0m0s', max_concurrent_requests: 40, extra_headers: { Authorization: 'env:GOTZJI_TUNNEL_BRIDGE_AUTH' }, discovery_extra_headers: { Authorization: 'env:GOTZJI_TUNNEL_BRIDGE_AUTH' }, server_urls: [{ channel: 'main', url: `http://127.0.0.1:${bridgePort}/mcp` }] } };
}

/** Secret-authenticated /mcp bridge. It exposes no app RPC or credential surface. */
export async function startProductTunnelBridge(target: string, secret: string): Promise<{ port: number; close(): Promise<void> }> {
  const destination = new URL(target);
  if (destination.protocol !== 'http:' || destination.hostname !== '127.0.0.1' || !/^\/mcp\/[a-f0-9]{64}$/u.test(destination.pathname) || destination.username || destination.password || destination.search || destination.hash || !/^[a-f0-9]{64}$/u.test(secret)) throw new CoreError('CONNECTION_TARGET_DENIED');
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!equal(`Bearer ${secret}`, request.headers.authorization) || !/^127\.0\.0\.1:\d+$/u.test(request.headers.host ?? '') || request.headers.origin) { response.writeHead(403); response.end(); return; }
    if (request.method === 'GET' && request.url?.startsWith('/.well-known/')) { response.writeHead(404); response.end(); return; }
    if (request.method !== 'POST' || request.url !== '/mcp') { response.writeHead(405); response.end(); return; }
    try {
      let body = ''; for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body) > 1024 * 1024) throw new CoreError('REQUEST_TOO_LARGE'); }
      const upstream = await fetch(destination, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const bytes = await upstream.text(); if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new CoreError('CONNECTION_RESPONSE_TOO_LARGE');
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(bytes);
    } catch { response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'CONNECTION_UPSTREAM_UNAVAILABLE' })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: (server.address() as AddressInfo).port, close: () => closeServer(server) };
}

/** Host-owned transport: closing the app window does not stop this service. */
export class GotzjiConnectionService {
  private readonly protector: ProductSecretProtector;
  private child: ChildProcess | undefined;
  private bridge: Awaited<ReturnType<typeof startProductTunnelBridge>> | undefined;
  private healthFile: string | undefined;
  private errorCode: string | undefined;
  private mutation: Promise<unknown> = Promise.resolve();
  public constructor(private readonly options: ProductConnectionOptions) {
    this.protector = options.protector ?? windowsProductSecretProtector();
    mkdirSync(this.profileDirectory(), { recursive: true, mode: 0o700 });
  }
  public async status(): Promise<ProductConnectionStatus> {
    const config = await this.read();
    const base = { configured: !!config, transport: 'openai-secure-mcp-tunnel' as const, ...(config ? { tunnelId: config.tunnelId } : {}) };
    if (!config) return { ...base, state: 'not-configured' };
    if (!config.process) return { ...base, state: config.desiredActive ? 'unavailable' : 'stopped', ...(this.errorCode ? { errorCode: this.errorCode } : {}) };
    const observed = (await processIdentities([config.process.pid]))[config.process.pid];
    if (observed === 'unknown') return { ...base, state: 'reconciliation-required', errorCode: 'CONNECTION_PROCESS_UNKNOWN' };
    if (!config.process.identity && observed) return { ...base, state: 'reconciliation-required', errorCode: 'CONNECTION_PROCESS_UNKNOWN' };
    if (!sameProcessIdentity(config.process.identity, observed)) return { ...base, state: config.desiredActive ? 'unavailable' : 'stopped', ...(this.errorCode ? { errorCode: this.errorCode } : {}) };
    if (this.child?.pid !== config.process.pid || !this.bridge) return { ...base, state: 'reconciliation-required', errorCode: 'CONNECTION_PREDECESSOR_ACTIVE' };
    if (this.healthFile && existsSync(this.healthFile)) {
      try {
        const url = readFileSync(this.healthFile, 'utf8').trim(); const parsed = new URL(url);
        if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('invalid health endpoint');
        this.assertClient();
        await exec(this.options.executable, ['health', '--url-file', this.healthFile, '--pid', String(config.process.pid), '--require-control-plane-poll', '--json'], { windowsHide: true, timeout: 2500, maxBuffer: 65536 });
        return { ...base, state: 'ready' };
      } catch { /* Only a current successful readiness response is ready. */ }
    }
    return { ...base, state: 'connecting', ...(this.errorCode ? { errorCode: this.errorCode } : {}) };
  }
  public configure(input: { tunnelId: string; runtimeKey: string; organizationId?: string }): Promise<ProductConnectionStatus> { return this.serial(async () => {
    if (!input || Object.keys(input).some((key) => !['tunnelId', 'runtimeKey', 'organizationId'].includes(key)) || !/^tunnel_[a-z0-9]{32}$/u.test(input.tunnelId) || typeof input.runtimeKey !== 'string' || input.runtimeKey.trim().length < 20 || input.runtimeKey.length > 1024 || /[\r\n\0]/u.test(input.runtimeKey) || input.organizationId !== undefined && !/^org[-_][A-Za-z0-9_-]{1,160}$/u.test(input.organizationId)) throw new CoreError('CONNECTION_CONFIGURATION_INVALID');
    const current = await this.status();
    if (['connecting', 'ready', 'reconciliation-required'].includes(current.state)) throw new CoreError('CONNECTION_STOP_REQUIRED');
    await this.write({ schemaVersion: 1, ownerId: this.options.ownerId, channel: this.options.channel ?? 'product', tunnelId: input.tunnelId, ...(input.organizationId ? { organizationId: input.organizationId } : {}), runtimeKey: input.runtimeKey.trim(), bridgeSecret: randomBytes(32).toString('hex'), desiredActive: false });
    this.errorCode = undefined; return this.status();
  }); }
  public start(): Promise<ProductConnectionStatus> { return this.serial(async () => {
    const config = await this.read(); if (!config) throw new CoreError('CONNECTION_CONFIGURATION_REQUIRED');
    const current = await this.status(); if (current.state === 'ready' || current.state === 'connecting') return current;
    if (current.state === 'reconciliation-required') throw new CoreError('CONNECTION_RECONCILIATION_REQUIRED');
    this.assertClient();
    this.bridge = await startProductTunnelBridge(this.options.mcpTarget(), config.bridgeSecret);
    const generation = randomUUID(); this.healthFile = path.join(this.profileDirectory(), `health-${generation}.url`);
    const profile = productTunnelProfile(config.tunnelId, this.bridge.port, this.healthFile, config.organizationId);
    const profilePath = path.join(this.profileDirectory(), this.options.channel === 'lnwjud-library' ? 'lnwjud-library.json' : 'gotzji.json');
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    const allowed = new Set(['path','pathext','systemroot','windir','temp','tmp','userprofile','appdata','localappdata','home','lang']);
    const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
    environment.CONTROL_PLANE_API_KEY = config.runtimeKey; environment.GOTZJI_TUNNEL_BRIDGE_AUTH = `Bearer ${config.bridgeSecret}`;
    const child = spawn(this.options.executable, ['run', '--config', profilePath, '--pid.file', path.join(this.profileDirectory(), `pid-${generation}.txt`)], { windowsHide: true, detached: true, env: environment, stdio: 'ignore' });
    this.child = child; child.on('error', () => { this.errorCode = 'CONNECTION_CLIENT_UNAVAILABLE'; }); child.once('exit', () => { this.errorCode = 'CONNECTION_CLIENT_EXITED'; }); child.unref();
    if (!child.pid) { await this.bridge.close(); this.bridge = undefined; throw new CoreError('CONNECTION_CLIENT_UNAVAILABLE'); }
    // Persist uncertainty before the OS probe; a probe failure never permits a
    // second transport worker or an unproved PID kill on the next Start call.
    await this.write({ ...config, desiredActive: true, process: { pid: child.pid, executableSha256: this.options.executableSha256 } });
    let identity: ProcessIdentity | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const observed = (await processIdentities([child.pid]))[child.pid];
      if (observed && observed !== 'unknown') { identity = observed; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!identity || identity.executable.toLowerCase() !== realpathSync(this.options.executable).toLowerCase()) { this.errorCode = 'CONNECTION_PROCESS_UNKNOWN'; throw new CoreError(this.errorCode); }
    await this.write({ ...config, desiredActive: true, process: { pid: child.pid, identity, executableSha256: this.options.executableSha256 } });
    this.errorCode = undefined; return this.status();
  }); }
  public stop(): Promise<ProductConnectionStatus> { return this.serial(async () => {
    const config = await this.read(); if (!config) return this.status();
    if (config.process) {
      const observed = (await processIdentities([config.process.pid]))[config.process.pid];
      if (observed === 'unknown') throw new CoreError('CONNECTION_PROCESS_UNKNOWN');
      if (!config.process.identity && observed) throw new CoreError('CONNECTION_PROCESS_UNKNOWN');
      if (sameProcessIdentity(config.process.identity, observed)) {
        this.assertClient();
        if (config.process.executableSha256 !== this.options.executableSha256 || config.process.identity!.executable.toLowerCase() !== realpathSync(this.options.executable).toLowerCase()) throw new CoreError('CONNECTION_PROCESS_OWNER_DENIED');
        process.kill(config.process.pid, 'SIGTERM');
        for (let attempt = 0; attempt < 20; attempt++) { const value = (await processIdentities([config.process.pid]))[config.process.pid]; if (value !== 'unknown' && !sameProcessIdentity(config.process.identity, value)) break; if (attempt === 19) throw new CoreError('CONNECTION_TERMINATION_UNVERIFIED'); await new Promise((resolve) => setTimeout(resolve, 100)); }
      }
    }
    await this.bridge?.close(); this.bridge = undefined; this.child = undefined; this.healthFile = undefined; this.errorCode = undefined;
    const retained = { ...config, desiredActive: false }; delete retained.process;
    await this.write(retained); return this.status();
  }); }
  public async restore(): Promise<void> { const config = await this.read(); if (config?.desiredActive) { try { await this.start(); } catch { this.errorCode = 'CONNECTION_RECONCILIATION_REQUIRED'; } } }
  private profileDirectory(): string { return path.join(this.options.directory, this.options.channel === 'lnwjud-library' ? 'gotzji-lnwjud-library-tunnel' : 'gotzji-tunnel'); }
  private configPath(): string { return path.join(this.options.directory, this.options.channel === 'lnwjud-library' ? 'product-lnwjud-library-tunnel.sealed.json' : 'product-tunnel.sealed.json'); }
  private assertClient(): void {
    const filename = this.options.executable; const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(filename) !== path.resolve(filename) || hash(readFileSync(filename)) !== this.options.executableSha256) throw new CoreError('CONNECTION_CLIENT_CHANGED');
  }
  private async read(): Promise<ConnectionConfiguration | undefined> {
    if (!existsSync(this.configPath())) return undefined;
    if (lstatSync(this.configPath()).isSymbolicLink() || realpathSync(this.configPath()) !== path.resolve(this.configPath())) throw new CoreError('CONNECTION_CONFIGURATION_DENIED');
    const envelope = JSON.parse(readFileSync(this.configPath(), 'utf8')) as { schemaVersion: number; payload: string };
    if (envelope.schemaVersion !== 1 || typeof envelope.payload !== 'string' || envelope.payload.length > 16384) throw new CoreError('CONNECTION_CONFIGURATION_INVALID');
    const config = JSON.parse(await this.protector.unprotect(envelope.payload)) as ConnectionConfiguration;
    if (config.schemaVersion !== 1 || config.ownerId !== this.options.ownerId || (config.channel ?? 'product') !== (this.options.channel ?? 'product') || !/^tunnel_[a-z0-9]{32}$/u.test(config.tunnelId) || !/^[a-f0-9]{64}$/u.test(config.bridgeSecret) || typeof config.runtimeKey !== 'string' || typeof config.desiredActive !== 'boolean' || config.organizationId !== undefined && !/^org[-_][A-Za-z0-9_-]{1,160}$/u.test(config.organizationId)) throw new CoreError('CONNECTION_OWNER_DENIED');
    if (config.process && (!Number.isSafeInteger(config.process.pid) || config.process.pid < 1 || config.process.identity && (typeof config.process.identity.birth !== 'string' || typeof config.process.identity.executable !== 'string') || !/^[a-f0-9]{64}$/u.test(config.process.executableSha256))) throw new CoreError('CONNECTION_PROCESS_OWNER_DENIED');
    return config;
  }
  private async write(config: ConnectionConfiguration): Promise<void> {
    const candidate = `${this.configPath()}.${randomUUID()}.tmp`;
    writeFileSync(candidate, JSON.stringify({ schemaVersion: 1, payload: await this.protector.protect(JSON.stringify(config)) }), { flag: 'wx', mode: 0o600 });
    renameSync(candidate, this.configPath());
  }
  private serial<T>(action: () => Promise<T>): Promise<T> { const result = this.mutation.then(action); this.mutation = result.catch(() => undefined); return result; }
}
function closeServer(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
