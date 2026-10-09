import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError } from './types.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { childEnvironment, sanitizedStream } from './product-security.mjs';
import { processIdentities, sameProcessIdentity, windowsPowerShellSession, type ProcessIdentity, type WindowsPowerShellSession } from './process-identity.mjs';

export interface ProductSecretProtector {
  protect(value: string): Promise<string>;
  unprotect(value: string): Promise<string>;
}
export interface ProductHostConfiguration {
  readonly schemaVersion: 1;
  readonly directory: string;
  readonly ownerId: string;
  readonly daemonSecret: string;
  readonly mcpPathSecret: string;
  readonly executable: string;
  readonly libraryRoot: string;
  readonly credential?: string;
  readonly authority?: { readonly policy: string; readonly authorityId: string };
  readonly native?: { readonly scriptPath: string; readonly scriptSha256: string; readonly cad?: { readonly scriptPath: string; readonly scriptSha256: string; readonly executable: string; readonly executableSha256: string } };
  readonly tunnel?: { readonly executable: string; readonly executableSha256: string };
  readonly browser?: { readonly executable: string; readonly executableSha256: string };
  readonly library?: { readonly pythonExecutable: string; readonly pythonSha256: string };
}
export interface ProductHostOptions {
  readonly dataPath: string;
  readonly resourcesPath: string;
  readonly packaged: boolean;
  readonly directory?: string;
  readonly executable?: string;
  readonly libraryRoot?: string;
  readonly hostEntryPath?: string;
  readonly secretProtector?: ProductSecretProtector;
  readonly testOnlyInsecureSecretProtector?: boolean;
  readonly startupBudgetMs?: number;
  readonly nativeScriptPath?: string;
  readonly cadScriptPath?: string;
  readonly tunnelClientPath?: string;
}
export interface ProductHostDescriptor {
  readonly endpoint: string;
  readonly token: string;
  readonly ownerId: string;
  readonly buildIdentity: string;
}

export function productConfigurationIdentity(config: ProductHostConfiguration): string {
  return createHash('sha256').update(JSON.stringify({ schemaVersion: config.schemaVersion, directory: config.directory, ownerId: config.ownerId, executable: config.executable, libraryRoot: config.libraryRoot, native: config.native ?? null, tunnel: config.tunnel ?? null, browser: config.browser ?? null, library: config.library ?? null, credentialHash: createHash('sha256').update(config.credential ?? '').digest('hex') })).digest('hex');
}
export function productRuntimeIdentity(entry: string, options: { requireManifest?: boolean } = {}): string {
  const directory = path.dirname(entry);
  const manifestFile = path.join(directory, 'product-runtime-manifest.json');
  if (existsSync(manifestFile)) {
    const bytes = readFileSync(manifestFile);
    const manifest = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: number; product?: string; version?: string; catalogVersion?: number; storeSchemaVersion?: number; entrypoint?: string; files?: { relativePath: string; sha256: string; sizeBytes: number }[] };
    if (manifest.schemaVersion !== 1 || manifest.product !== 'gotzji' || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.version)
      || manifest.catalogVersion !== 1 || manifest.storeSchemaVersion !== 1 || manifest.entrypoint !== 'product-server.mjs' || !Array.isArray(manifest.files) || manifest.files.length === 0
      || bytes.toString('utf8') !== `${JSON.stringify(manifest, null, 2)}\n`) throw new CoreError('PRODUCT_RUNTIME_MANIFEST_INVALID');
    const names = manifest.files.map((file) => file.relativePath);
    if (new Set(names).size !== names.length || ['product-server.mjs', 'fixture-worker.mjs', 'product-broker.mjs', 'product-runner.mjs'].some((name) => !names.includes(name))) throw new CoreError('PRODUCT_RUNTIME_INVENTORY_INVALID');
    const actualNames = readdirSync(directory).filter((name) => name !== 'product-runtime-manifest.json').sort();
    if (JSON.stringify([...names].sort()) !== JSON.stringify(actualNames)) throw new CoreError('PRODUCT_RUNTIME_INVENTORY_INVALID');
    for (const file of manifest.files) {
      const target = path.resolve(directory, file.relativePath); const relative = path.relative(directory, target);
      const info = lstatSync(target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || info.isSymbolicLink() || !info.isFile() || !/^[a-f0-9]{64}$/.test(file.sha256) || info.size !== file.sizeBytes || createHash('sha256').update(readFileSync(target)).digest('hex') !== file.sha256) throw new CoreError('PRODUCT_RUNTIME_CHANGED');
    }
    return createHash('sha256').update(bytes).digest('hex');
  }
  if (options.requireManifest) throw new CoreError('PRODUCT_RUNTIME_MANIFEST_REQUIRED');
  const digest = createHash('sha256');
  for (const name of readdirSync(directory).sort().filter((value) => /\.(js|mjs)$/.test(value))) { digest.update(name); digest.update(readFileSync(path.join(directory, name))); }
  return digest.digest('hex');
}

export function productRuntimeRequiresManifest(entry: string, argv: readonly string[]): boolean {
  const directory = path.dirname(entry);
  return argv.includes('--packaged') || path.basename(directory) === 'gotzji-core' || existsSync(path.join(directory, 'product-runtime-manifest.json'));
}

const MAX_SECRET_BYTES = 64 * 1024;
/** SHA-256 of the provider scripts this build ships (LF line ends, see .gitattributes); a test pins them to the files. */
export const PRODUCT_PROVIDER_SHA256 = { office: '4dddc9af44dc46e3e6a8c62a23652cdf48ff92515bd33d30e98c34ae25c69fbe', cad: '86f1594198735bc989df70b83e31af7dbe7ee19b2872f54fe4283bfc5d34b922' } as const;
const SECRET_PROVIDER_CODES: Readonly<Record<string, string>> = { POWERSHELL_SESSION_TIMEOUT: 'SECRET_PROVIDER_TIMEOUT', POWERSHELL_SESSION_UNAVAILABLE: 'SECRET_PROVIDER_UNAVAILABLE', POWERSHELL_SESSION_OUTPUT_LIMIT: 'SECRET_PROVIDER_OUTPUT_LIMIT', POWERSHELL_SESSION_INPUT_FAILED: 'SECRET_PROVIDER_INPUT_FAILED' };
/** Uses CurrentUser DPAPI without placing plaintext on a command line; one owned Windows PowerShell session serves every call. */
export function windowsProductSecretProtector(session?: WindowsPowerShellSession): ProductSecretProtector {
  if (process.platform !== 'win32') throw new CoreError('WINDOWS_SECRET_PROVIDER_REQUIRED');
  // DPAPI stays on Windows PowerShell, where System.Security loads.
  const provider = session ?? windowsPowerShellSession(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'dpapi');
  const transform = async (value: string, encrypt: boolean): Promise<string> => {
    if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new CoreError('SECRET_PAYLOAD_TOO_LARGE');
    let result: string;
    try { result = encrypt ? await provider.protect(Buffer.from(value, 'utf8').toString('base64')) : await provider.unprotect(value); }
    catch (error) { throw new CoreError(SECRET_PROVIDER_CODES[String((error as { code?: unknown }).code)] ?? 'SECRET_OWNER_OR_PROVIDER_DENIED'); }
    if (typeof result !== 'string') throw new CoreError('SECRET_OWNER_OR_PROVIDER_DENIED');
    if (result.length > MAX_SECRET_BYTES * 2) throw new CoreError('SECRET_PROVIDER_OUTPUT_LIMIT');
    return encrypt ? result : Buffer.from(result, 'base64').toString('utf8');
  };
  return { protect: (value) => transform(value, true), unprotect: (value) => transform(value, false) };
}

/** Explicit unpackaged E2E fixture only; never use for owner credentials. */
export function testOnlyProductSecretProtector(): ProductSecretProtector {
  return {
    protect: async (value: string): Promise<string> => Buffer.from(value, 'utf8').toString('base64'),
    unprotect: async (value: string): Promise<string> => Buffer.from(value, 'base64').toString('utf8'),
  };
}

function validateConfiguration(value: unknown, directory: string): ProductHostConfiguration {
  const config = value as Partial<ProductHostConfiguration> | null;
  if (!config || Object.keys(config).some((key) => !['schemaVersion', 'directory', 'ownerId', 'daemonSecret', 'mcpPathSecret', 'executable', 'libraryRoot', 'credential', 'authority', 'native', 'tunnel', 'browser', 'library'].includes(key)) || config.schemaVersion !== 1 || config.directory !== directory || !config.ownerId
    || !/^[0-9a-f]{64}$/.test(config.daemonSecret ?? '') || !/^[0-9a-f]{64}$/.test(config.mcpPathSecret ?? '')
    || !config.executable || !path.isAbsolute(config.executable) || !config.libraryRoot || !path.isAbsolute(config.libraryRoot)) {
    throw new CoreError('PRODUCT_CONFIGURATION_INVALID');
  }
  if (config.credential !== undefined && !/^[a-f0-9]{64}$/u.test(config.credential)) throw new CoreError('PRODUCT_CONFIGURATION_INVALID');
  if (config.tunnel && (!path.isAbsolute(config.tunnel.executable) || !/^[a-f0-9]{64}$/u.test(config.tunnel.executableSha256) || Object.keys(config.tunnel).some((key) => !['executable', 'executableSha256'].includes(key)))) throw new CoreError('PRODUCT_CONFIGURATION_INVALID');
  if (config.browser && (!path.isAbsolute(config.browser.executable) || !/^[a-f0-9]{64}$/u.test(config.browser.executableSha256) || Object.keys(config.browser).some((key) => !['executable', 'executableSha256'].includes(key)))) throw new CoreError('PRODUCT_CONFIGURATION_INVALID');
  if (config.library && (!path.isAbsolute(config.library.pythonExecutable) || !/^[a-f0-9]{64}$/u.test(config.library.pythonSha256) || Object.keys(config.library).some((key) => !['pythonExecutable', 'pythonSha256'].includes(key)))) throw new CoreError('PRODUCT_CONFIGURATION_INVALID');
  if (config.native) {
    const validPin = (pin: { scriptPath: string; scriptSha256: string }): boolean => typeof pin.scriptPath === 'string' && path.isAbsolute(pin.scriptPath) && /^[a-f0-9]{64}$/u.test(pin.scriptSha256);
    if (!validPin(config.native) || Object.keys(config.native).some((key) => !['scriptPath', 'scriptSha256', 'cad'].includes(key))) throw new CoreError('PRODUCT_CONFIGURATION_INVALID');
    if (config.native.cad && (!validPin(config.native.cad) || !path.isAbsolute(config.native.cad.executable) || !/^[a-f0-9]{64}$/u.test(config.native.cad.executableSha256)
      || Object.keys(config.native.cad).some((key) => !['scriptPath', 'scriptSha256', 'executable', 'executableSha256'].includes(key)))) throw new CoreError('PRODUCT_CONFIGURATION_INVALID');
  }
  return config as ProductHostConfiguration;
}

export async function readProductConfiguration(directory: string, protector = windowsProductSecretProtector()): Promise<ProductHostConfiguration> {
  const text = readFileSync(path.join(directory, 'product-host.sealed.json'), 'utf8');
  if (Buffer.byteLength(text) > MAX_SECRET_BYTES * 2) throw new CoreError('PRODUCT_CONFIGURATION_TOO_LARGE');
  const envelope = JSON.parse(text) as { schemaVersion?: number; protection?: string; payload?: string };
  if (envelope.schemaVersion !== 1 || envelope.protection !== 'windows-current-user-dpapi' || typeof envelope.payload !== 'string') throw new CoreError('PRODUCT_SECRET_ENVELOPE_INVALID');
  return validateConfiguration(JSON.parse(await protector.unprotect(envelope.payload)), directory);
}

export async function writeProductConfiguration(config: ProductHostConfiguration, protector = windowsProductSecretProtector(), exclusive = false): Promise<void> {
  validateConfiguration(config, config.directory);
  const text = JSON.stringify({ schemaVersion: 1, protection: 'windows-current-user-dpapi', payload: await protector.protect(JSON.stringify(config)) });
  const target = path.join(config.directory, 'product-host.sealed.json');
  if (exclusive) { writeFileSync(target, text, { flag: 'wx', mode: 0o600 }); return; }
  const temporary = path.join(config.directory, `product-host.candidate-${randomUUID()}.json`);
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, target);
}

const hostStartups = new Map<string, Promise<ProductHostDescriptor>>();
export type ProductHostAuthorityPersistence = Promise<{ readonly error?: unknown }>;
/** Observe the seal immediately so an early DPAPI failure cannot escape as an unhandled rejection. */
export function observeProductHostAuthorityPersistence(persistence: Promise<void>): ProductHostAuthorityPersistence {
  return persistence.then(() => ({}), (error: unknown) => ({ error }));
}
/** Release every owned startup resource even when an earlier close step fails. */
export async function cleanupProductHostStartup(
  closeListener: () => void | Promise<void>,
  closeCore: () => void,
  releaseOwnership: () => void,
): Promise<void> {
  try { await closeListener(); }
  finally {
    try { closeCore(); }
    finally { releaseOwnership(); }
  }
}
/** Keep background recovery and the signed endpoint behind the durable authority seal. */
export async function completeProductHostStartup(
  authorityPersistence: ProductHostAuthorityPersistence | undefined,
  startSupervisor: () => void,
  publishEndpoint: () => void,
  cleanupFailure: () => void | Promise<void> = () => undefined,
): Promise<void> {
  const authority = authorityPersistence ? await authorityPersistence : undefined;
  if (authority && 'error' in authority) {
    try { await cleanupFailure(); } catch { /* Preserve the original authority-seal failure. */ }
    throw authority.error;
  }
  startSupervisor();
  publishEndpoint();
}
/** Concurrent app projections share one provisioning/launch attempt per root. */
export function ensureGotzjiProductHost(options: ProductHostOptions): Promise<ProductHostDescriptor> {
  const directory = path.resolve(options.directory ?? path.join(process.env.LOCALAPPDATA ?? options.dataPath, 'gotzji', 'runtime'));
  const existing = hostStartups.get(directory); if (existing) return existing;
  const pending = bootGotzjiProductHost(options, directory).finally(() => { if (hostStartups.get(directory) === pending) hostStartups.delete(directory); });
  hostStartups.set(directory, pending); return pending;
}
/** Boot the independent host; window/client lifetime never owns its jobs. */
async function bootGotzjiProductHost(options: ProductHostOptions, directory: string): Promise<ProductHostDescriptor> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (options.packaged && (options.testOnlyInsecureSecretProtector || options.secretProtector)) throw new CoreError('PRODUCT_TEST_SECRET_PROVIDER_DENIED');
  const protector = options.testOnlyInsecureSecretProtector ? testOnlyProductSecretProtector() : options.secretProtector ?? windowsProductSecretProtector();
  const filename = path.join(directory, 'product-host.sealed.json');
  if (!existsSync(filename)) {
    const libraryRoot = path.resolve(options.libraryRoot ?? path.join(directory, 'workspace'));
    mkdirSync(libraryRoot, { recursive: true, mode: 0o700 });
    if (!options.libraryRoot) ensureProductControlDocuments(libraryRoot);
    const config: ProductHostConfiguration = { schemaVersion: 1, directory, ownerId: randomUUID(), daemonSecret: randomBytes(32).toString('hex'), mcpPathSecret: randomBytes(32).toString('hex'), executable: path.resolve(options.executable ?? path.join(os.homedir(), '.local', 'bin', 'claude.exe')), libraryRoot, credential: randomBytes(32).toString('hex') };
    try { await writeProductConfiguration(config, protector, true); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  let config = await readProductConfiguration(directory, protector);
  const initialIdentity = productConfigurationIdentity(config);
  if (config.libraryRoot === path.join(directory, 'workspace')) ensureProductControlDocuments(config.libraryRoot);
  if (!config.credential) config = { ...config, credential: randomBytes(32).toString('hex') };
  const officeCandidates = options.nativeScriptPath ? [options.nativeScriptPath] : options.packaged ? [path.join(options.resourcesPath, 'gotzji-native-office.ps1')] : [path.resolve(process.cwd(), 'apps/desktop/build/gotzji-native-office.ps1'), path.resolve(process.cwd(), 'build/gotzji-native-office.ps1')];
  const cadCandidates = options.cadScriptPath ? [options.cadScriptPath] : options.packaged ? [path.join(options.resourcesPath, 'gotzji-cad-session-provider.ps1')] : [path.resolve(process.cwd(), 'apps/desktop/build/gotzji-cad-session-provider.ps1'), path.resolve(process.cwd(), 'build/gotzji-cad-session-provider.ps1')];
  // An explicit development path is taken as found; a shipped script must have the bytes this build ships.
  config = reconcileProviderPins(config,
    shippedProvider(officeCandidates, options.nativeScriptPath ? undefined : PRODUCT_PROVIDER_SHA256.office),
    shippedProvider(cadCandidates, options.cadScriptPath ? undefined : PRODUCT_PROVIDER_SHA256.cad),
    discoverProductCadExecutable);
  if (!config.tunnel) {
    const candidates = options.tunnelClientPath ? [options.tunnelClientPath] : options.packaged ? [path.join(options.resourcesPath, 'tunnel-client', 'tunnel-client.exe')] : [path.resolve(process.cwd(), 'apps/desktop/build/tunnel-client/tunnel-client.exe'), path.resolve(process.cwd(), 'build/tunnel-client/tunnel-client.exe')];
    const filename = candidates.find((candidate) => existsSync(candidate));
    if (filename) {
      const pin = pinnedProductFile(filename);
      if (pin.scriptSha256 !== '1946de55a038313a9b9b2458d05fe1719fa9cf1f20a94dd5f38fc26a98bfdd42') throw new CoreError('CONNECTION_CLIENT_UNQUALIFIED');
      config = { ...config, tunnel: { executable: pin.scriptPath, executableSha256: pin.scriptSha256 } };
    }
  }
  if (!config.browser) {
    const executable = discoverRegisteredProductExecutable('chrome');
    if (executable) { const pin = pinnedProductFile(executable); config = { ...config, browser: { executable: pin.scriptPath, executableSha256: pin.scriptSha256 } }; }
  }
  if (!config.library) {
    const executable = discoverRegisteredProductExecutable('python');
    if (executable) { const pin = pinnedProductFile(executable); config = { ...config, library: { pythonExecutable: pin.scriptPath, pythonSha256: pin.scriptSha256 } }; }
  }
  // Publish a complete snapshot before any daemon can read it. Intermediate
  // native/tunnel updates never race the daemon's retained authority write.
  if (productConfigurationIdentity(config) !== initialIdentity) await writeProductConfiguration(config, protector);
  const developmentEntries = [fileURLToPath(new URL('./product-server.mjs', import.meta.url)), path.resolve(process.cwd(), 'packages/execution-core/dist/product-server.mjs'), path.resolve(process.cwd(), '../../packages/execution-core/dist/product-server.mjs')];
  const entry = options.hostEntryPath ?? (options.packaged ? path.join(options.resourcesPath, 'gotzji-core', 'product-server.mjs') : developmentEntries.find((candidate) => existsSync(candidate)));
  if (!entry || !existsSync(entry)) throw new CoreError('PRODUCT_HOST_RUNTIME_MISSING');
  const buildIdentity = productRuntimeIdentity(entry, { requireManifest: options.packaged });
  const configurationIdentity = productConfigurationIdentity(config);
  const descriptor = async (): Promise<ProductHostDescriptor | undefined> => {
    const readyFile = path.join(directory, 'product-endpoint.json');
    if (!existsSync(readyFile)) return undefined;
    let ready: { port?: number; pid?: number; identity?: ProcessIdentity; ownerId?: string; buildIdentity?: string; configurationIdentity?: string };
    try {
      const envelope = JSON.parse(readFileSync(readyFile, 'utf8')) as { body: string; mac: string };
      const expected = createHmac('sha256', config.daemonSecret).update(envelope.body).digest();
      const observed = Buffer.from(envelope.mac, 'hex');
      if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) throw new CoreError('HOST_ENDPOINT_IDENTITY_INVALID');
      ready = JSON.parse(envelope.body) as typeof ready;
    } catch (error) { if (error instanceof CoreError) throw error; return undefined; }
    if (!Number.isInteger(ready.port) || (ready.port ?? 0) < 1 || (ready.port ?? 0) > 65535 || !Number.isSafeInteger(ready.pid) || (ready.pid ?? 0) < 1 || ready.ownerId !== config.ownerId) return undefined;
    if (ready.identity) {
      const actual = options.testOnlyInsecureSecretProtector ? ready.identity : (await processIdentities([ready.pid!]))[ready.pid!];
      if (actual === 'unknown' || actual === undefined) throw new CoreError('PRODUCT_HOST_OWNER_UNKNOWN');
      if (!sameProcessIdentity(ready.identity, actual)) return undefined;
    }
    if (ready.configurationIdentity !== configurationIdentity) {
      // A signed retired endpoint is not a live-owner fence. Unknown/live
      // liveness retains the fence; only an absent OS PID permits new boot.
      try { process.kill(ready.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined; }
      throw new CoreError('HOST_CONFIGURATION_CHANGED');
    }
    const endpoint = `http://127.0.0.1:${ready.port}/rpc`;
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.daemonSecret}`, 'Content-Type': 'application/json', 'x-gotzji-build': buildIdentity }, body: JSON.stringify({ method: 'health', input: {} }), signal: AbortSignal.timeout(1_000), redirect: 'error' });
      const result = await response.json() as { ok?: boolean; value?: { product?: string; ownerId?: string } };
      if (response.ok && result.ok && result.value?.product === 'gotzji' && result.value.ownerId === config.ownerId) return { endpoint, token: config.daemonSecret, ownerId: config.ownerId, buildIdentity };
    } catch { /* An absent endpoint is not proof of a dead worker. Host ownership checks before launch. */ }
    return undefined;
  };
  const existing = await descriptor(); if (existing) return existing;
  if (!existsSync(config.executable)) throw new CoreError('GRACE_EXECUTABLE_NOT_FOUND');
  const incidentId = randomUUID(); const incidentPath = path.join(directory, `product-startup-${incidentId}.json`);
  let stderr = ''; let failed = false; let exitCode: number | null | undefined; let signal: string | null | undefined; let settledReady = false; const phases: string[] = [];
  const saveIncident = (phase: string): void => {
    phases.push(phase);
    try { writeFileSync(incidentPath, JSON.stringify({ schemaVersion: 1, product: 'gotzji', incidentId, ownerId: config.ownerId, recordedAt: new Date().toISOString(), phase, phases: [...phases], buildIdentity, configurationIdentity, exitCode: exitCode ?? null, signal: signal ?? null, stderr }), { mode: 0o600 }); } catch { /* Failure reporting must not mask the original startup failure. */ }
  };
  const stream = sanitizedStream((line) => {
    for (const secret of [config.daemonSecret, config.mcpPathSecret, config.credential].filter((value): value is string => !!value)) line = line.replaceAll(secret, '[REDACTED]');
    stderr = (stderr + line).slice(-16384);
  });
  const child = spawn(process.execPath, [entry, directory, ...(options.packaged ? ['--packaged'] : []), ...(options.testOnlyInsecureSecretProtector ? ['--test-only-insecure-secret-protector'] : [])], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...childEnvironment(), ELECTRON_RUN_AS_NODE: '1' } });
  child.stderr.on('data', (data: Buffer) => stream.write(data));
  child.stderr.once('end', () => { stream.end(); if (!settledReady) saveIncident('stderr-closed-before-ready'); });
  (child.stderr as typeof child.stderr & { unref?: () => void }).unref?.();
  child.once('error', () => { failed = true; saveIncident('spawn-error'); });
  child.once('exit', (code, observedSignal) => { exitCode = code; signal = observedSignal; if (!settledReady) { if (code !== 0) failed = true; saveIncident('exit-before-ready'); } });
  child.unref();
  const until = Date.now() + (options.startupBudgetMs ?? 15_000);
  while (Date.now() < until) { const value = await descriptor(); if (value) { settledReady = true; return value; } if (failed) throw new CoreError('PRODUCT_HOST_STARTUP_EXITED', 'Owned host exited before readiness', undefined, 'host-startup', 'Inspect the retained startup incident and verify installed runtime/provider prerequisites'); await new Promise((resolve) => setTimeout(resolve, 150)); }
  saveIncident('ready-timeout');
  throw new CoreError('PRODUCT_HOST_NOT_READY', 'Readiness budget expired; an absent endpoint does not prove a dead worker', undefined, 'host-startup', 'Inspect the retained startup incident and owner-process state before retrying');
}

type ProviderPin = { readonly scriptPath: string; readonly scriptSha256: string };
/**
 * The provider script found among the candidates, when its bytes are the expected ones. `undefined` when none is
 * present or it cannot be read now (an earlier pin is kept); `null` when it is present with other bytes (its pin is
 * dropped). No expected hash accepts the file as found.
 */
export function shippedProvider(candidates: readonly string[], expected: string | undefined): ProviderPin | null | undefined {
  const scriptPath = candidates.find((candidate) => existsSync(candidate));
  if (!scriptPath) return undefined;
  let pin: ProviderPin;
  try { pin = pinnedProductFile(scriptPath); } catch { return undefined; }
  return expected === undefined || pin.scriptSha256 === expected ? pin : null;
}
/**
 * Re-pin the provider scripts on every start, so a new build does not strand its own providers (incident I6). A
 * dropped script leaves its provider unavailable while the host still starts. ZWCAD is found again only when its
 * bytes changed; one that is no longer the qualified build leaves CAD unavailable. The pins are part of the core's
 * policy, so a change passes the upgrade fence.
 */
export function reconcileProviderPins(config: ProductHostConfiguration, office: ProviderPin | null | undefined, cad: ProviderPin | null | undefined, discoverExecutable: () => ProviderPin | undefined): ProductHostConfiguration {
  let next = config;
  if (office === null) next = Object.fromEntries(Object.entries(next).filter(([key]) => key !== 'native')) as unknown as ProductHostConfiguration;
  else if (office && (office.scriptPath !== next.native?.scriptPath || office.scriptSha256 !== next.native?.scriptSha256)) next = { ...next, native: { ...office, ...(next.native?.cad ? { cad: next.native.cad } : {}) } };
  if (!next.native || cad === undefined) return next;
  const withoutCad = { ...next, native: { scriptPath: next.native.scriptPath, scriptSha256: next.native.scriptSha256 } };
  if (cad === null) return withoutCad;
  const earlier = next.native.cad;
  let executable: { executable: string; executableSha256: string };
  // Kept unless ZWCAD is gone or has other bytes; an unreadable file (a passing lock) keeps the pin.
  if (earlier && existsSync(earlier.executable) && shippedProvider([earlier.executable], earlier.executableSha256) !== null) executable = { executable: earlier.executable, executableSha256: earlier.executableSha256 };
  else {
    const found = discoverExecutable();
    if (!found) return earlier ? withoutCad : next;
    executable = { executable: found.scriptPath, executableSha256: found.scriptSha256 };
  }
  const pinned = { ...cad, ...executable };
  return earlier && pinned.scriptPath === earlier.scriptPath && pinned.scriptSha256 === earlier.scriptSha256 && pinned.executable === earlier.executable && pinned.executableSha256 === earlier.executableSha256
    ? next : { ...next, native: { ...next.native, cad: pinned } };
}
function pinnedProductFile(filename: string): { scriptPath: string; scriptSha256: string } {
  const resolved = path.resolve(filename); const info = lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(resolved) !== resolved) throw new CoreError('NATIVE_PROVIDER_CHANGED');
  return { scriptPath: resolved, scriptSha256: createHash('sha256').update(readFileSync(resolved)).digest('hex') };
}

function discoverRegisteredProductExecutable(provider: 'chrome' | 'python'): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const program = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  const keys = provider === 'chrome' ? ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'] : ['HKCU\\Software\\Python\\PythonCore\\3.12\\InstallPath', 'HKLM\\Software\\Python\\PythonCore\\3.12\\InstallPath', 'HKCU\\Software\\Python\\PythonCore\\3.11\\InstallPath', 'HKLM\\Software\\Python\\PythonCore\\3.11\\InstallPath'];
  for (const key of keys) {
    try {
      const output = execFileSync(program, ['query', key, ...(provider === 'python' ? ['/v', 'ExecutablePath'] : ['/ve'])], { windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const filename = output.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/u)?.[1]?.trim().replace(/^"|"$/gu, '');
      if (filename && path.isAbsolute(filename) && path.basename(filename).toLowerCase() === `${provider === 'chrome' ? 'chrome' : 'python'}.exe`) return pinnedProductFile(filename).scriptPath;
    } catch { /* An absent provider remains unavailable. No PATH/provider fallback. */ }
  }
  return undefined;
}

/** Registry discovery reads metadata only; it never attaches to a user CAD process. */
/** The qualified ZWCAD 2025 build, pinned with the bytes that were checked (no second read). */
export function discoverProductCadExecutable(): ProviderPin | undefined {
  if (process.platform !== 'win32') return undefined;
  const registry = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  const readDefault = (key: string): string | undefined => {
    try { return execFileSync(registry, ['query', key, '/ve'], { windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/u)?.[1]?.trim(); } catch { return undefined; }
  };
  const clsid = readDefault('HKCR\\ZWCAD.Application.2025\\CLSID');
  if (!clsid || !/^\{[a-fA-F0-9-]{36}\}$/u.test(clsid)) return undefined;
  const command = readDefault(`HKCR\\CLSID\\${clsid}\\LocalServer32`);
  const executable = command?.match(/^(?:"([^"]+\.exe)"|(.+?\.exe))(?:\s|$)/iu)?.slice(1).find(Boolean);
  if (!executable || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'zwcad.exe') return undefined;
  try {
    const pin = pinnedProductFile(executable);
    // The first release enables the exact official ZWCAD 2025 build that was
    // qualified. Other installations remain unsupported until qualified.
    return pin.scriptSha256 === '0c2431a3b701bad4bbcbd67047dec6c31b9aecfbab998cbcf11f0a4b2b5366ca' ? pin : undefined;
  } catch { return undefined; }
}
