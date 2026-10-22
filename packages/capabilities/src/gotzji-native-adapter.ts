import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { GotzjiNativeError, isExcelSheetsSnapshot, nativeBytesDigest, nativeFileDigest, planGotzjiNativeOperation, type GotzjiNativeGrant, type GotzjiNativeReceipt } from './gotzji-native-contract.js';

export interface GotzjiNativeAdapterOptions {
  readonly scriptPath: string;
  readonly scriptSha256: string;
  readonly verifyGrant: (grant: GotzjiNativeGrant, digest: string, resourceKeys: readonly string[]) => Promise<boolean>;
  readonly processEvidence?: GotzjiNativeProcessEvidenceBinding;
  readonly beforeProviderSpawn?: (attempt: number) => Promise<void>;
  readonly runner?: GotzjiNativeRunner;
}
export interface GotzjiNativeProcessEvidenceBinding {
  readonly schemaVersion: 1;
  readonly effectRoot: string;
  readonly journalPath: string;
  readonly jobId: string;
  readonly epoch: string;
  readonly generation: number;
  readonly planDigest: string;
  readonly provider: 'office' | 'cad-session';
  readonly evidenceKey: string;
}
export interface GotzjiNativeProcessInvocation extends GotzjiNativeProcessEvidenceBinding {
  readonly invocationId: string;
}
export type GotzjiNativeRunner = (scriptPath: string, input: unknown, signal?: AbortSignal, processEvidence?: GotzjiNativeProcessInvocation, beforeSpawn?: () => Promise<void>) => Promise<unknown>;
export type GotzjiNativeProcessStarter = (command: string, args: readonly string[], environment: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
export class GotzjiNativeNoLaunchError extends GotzjiNativeError {
  public readonly confirmedNoProviderProcess = true;
  public constructor(public readonly noLaunchReason: 'synchronous-spawn-throw' | 'spawn-error-no-pid') { super('NATIVE_PROVIDER_START_FAILED'); }
}
export interface GotzjiNativeDiscovery {
  readonly provider: 'excel' | 'word' | 'powerpoint' | 'cad';
  readonly installed: boolean;
  readonly registered: boolean;
  readonly executable: string;
  readonly version: string | null;
  readonly state: 'installed-unqualified' | 'action-required' | 'unavailable';
  readonly reason: string;
  readonly activeProcessCount: number;
}
export class GotzjiNativeAdapter {
  private dispatchAttempt = 0;
  public constructor(private readonly options: GotzjiNativeAdapterOptions) {}
  public async discover(): Promise<readonly GotzjiNativeDiscovery[]> {
    const script = await this.providerScript();
    const value = await (this.options.runner ?? runGotzjiNativePowerShell)(script, { operation: 'discover' });
    if (!Array.isArray(value) || value.some((item: unknown) => !record(item) || !['excel', 'word', 'powerpoint', 'cad'].includes(String(item.provider))
      || typeof item.installed !== 'boolean' || typeof item.registered !== 'boolean' || typeof item.executable !== 'string'
      || !['installed-unqualified', 'action-required', 'unavailable'].includes(String(item.state)) || typeof item.reason !== 'string'
      || (item.version !== null && typeof item.version !== 'string') || !Number.isSafeInteger(item.activeProcessCount))) throw new GotzjiNativeError('NATIVE_DISCOVERY_INVALID');
    return value as GotzjiNativeDiscovery[];
  }
  public async execute(grant: GotzjiNativeGrant, input: unknown, signal?: AbortSignal): Promise<GotzjiNativeReceipt> {
    if (!grant.ownerId || !grant.projectId || !grant.jobId || !grant.operationId || !grant.proof) throw new GotzjiNativeError('NATIVE_AUTHORITY_DENIED');
    const plan = await planGotzjiNativeOperation(input, grant.rootPath);
    if (!await this.options.verifyGrant(grant, plan.digest, plan.resourceKeys)) throw new GotzjiNativeError('NATIVE_AUTHORITY_DENIED');
    if (signal?.aborted) throw new GotzjiNativeError('NATIVE_CANCELLED_BEFORE_START');
    const processEvidence = this.invocation(plan.digest);
    const script = await this.providerScript();
    const value = await (this.options.runner ?? runGotzjiNativePowerShell)(script, plan.input, signal, processEvidence, this.dispatchBoundary());
    if (!record(value) || value.verified !== true || value.operation !== plan.input.operation || value.provider !== plan.provider
      || value.originalPreserved !== true || value.sourceSha256 !== plan.input.expectedSha256 || typeof value.providerVersion !== 'string'
      || !Number.isInteger(value.nativePid) || Number(value.nativePid) < 1 || typeof value.savedAndReopened !== 'boolean' || typeof value.unrelatedPreserved !== 'boolean') throw new GotzjiNativeError('NATIVE_RECEIPT_INVALID', undefined, 'unknown');
    if (await nativeFileDigest(plan.input.filePath) !== plan.input.expectedSha256) throw new GotzjiNativeError('NATIVE_ORIGINAL_CHANGED', undefined, 'unknown');
    if (plan.input.operation === 'excel.sheets.inspect' && (value.outputSha256 !== null || value.savedAndReopened !== false || value.unrelatedPreserved !== true
      || !isExcelSheetsSnapshot(value.before) || !isExcelSheetsSnapshot(value.after) || JSON.stringify(value.before) !== JSON.stringify(value.after))) throw new GotzjiNativeError('NATIVE_RECEIPT_INVALID', undefined, 'unknown');
    if ('outputPath' in plan.input && (value.savedAndReopened !== true || value.unrelatedPreserved !== true || value.outputSha256 !== await nativeFileDigest(plan.input.outputPath))) throw new GotzjiNativeError('NATIVE_PRESERVATION_FAILED', undefined, 'unknown');
    return value as unknown as GotzjiNativeReceipt;
  }
  private async providerScript(): Promise<string> {
    const script = await realpath(this.options.scriptPath);
    if (!(await lstat(this.options.scriptPath)).isFile() || (await lstat(this.options.scriptPath)).isSymbolicLink() || script.toLowerCase() !== path.resolve(this.options.scriptPath).toLowerCase() || nativeBytesDigest(await readFile(script)) !== this.options.scriptSha256) throw new GotzjiNativeError('NATIVE_PROVIDER_CHANGED');
    return script;
  }
  private invocation(planDigest: string): GotzjiNativeProcessInvocation | undefined {
    const binding = this.options.processEvidence;
    if (!binding) {
      if (!this.options.runner) throw new GotzjiNativeError('NATIVE_PROCESS_EVIDENCE_REQUIRED');
      return undefined;
    }
    if (binding.schemaVersion !== 1 || binding.planDigest !== planDigest || !path.isAbsolute(binding.effectRoot)
      || binding.provider !== 'office'
      || path.dirname(binding.journalPath).toLowerCase() !== binding.effectRoot.toLowerCase()
      || path.basename(binding.journalPath) !== 'native-process-identities.jsonl' || !/^[a-f0-9]{64}$/u.test(binding.evidenceKey)) throw new GotzjiNativeError('NATIVE_PROCESS_EVIDENCE_INVALID');
    return { ...binding, invocationId: randomUUID() };
  }
  private dispatchBoundary(): (() => Promise<void>) | undefined {
    return this.options.beforeProviderSpawn ? async (): Promise<void> => this.options.beforeProviderSpawn!(++this.dispatchAttempt) : undefined;
  }
}
export async function runGotzjiNativePowerShell(scriptPath: string, input: unknown, signal?: AbortSignal, processEvidence?: GotzjiNativeProcessInvocation, beforeSpawn?: () => Promise<void>, startProcess: GotzjiNativeProcessStarter = startGotzjiNativePowerShell): Promise<unknown> {
  if (process.platform !== 'win32') throw new GotzjiNativeError('NATIVE_WINDOWS_REQUIRED');
  if (!beforeSpawn) throw new GotzjiNativeError('NATIVE_DISPATCH_BOUNDARY_REQUIRED');
  // This is the final no-launch cancellation point. Once the trusted callback returns, the helper is spawned even if
  // cancellation races the callback; its registered listener plus the immediate check below then stop that exact child.
  if (signal?.aborted) throw new GotzjiNativeError('NATIVE_CANCELLED_BEFORE_START');
  await beforeSpawn();
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = startProcess(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], gotzjiNativeChildEnvironment()); }
    catch { reject(new GotzjiNativeNoLaunchError('synchronous-spawn-throw')); return; }
    let stdout = ''; let interrupted = false; let spawned = false;
    const stop = (): void => { interrupted = true; child.kill(); };
    const timer = setTimeout(stop, 120000);
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString('utf8'); if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) stop(); });
    child.stderr.resume();
    child.stdin.on('error', () => { /* close/error yields a typed result */ });
    child.once('spawn', () => { spawned = true; });
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      const noProcess = !spawned && !Number.isSafeInteger(child.pid) && ['ENOENT','EACCES'].includes(error.code ?? '');
      reject(noProcess ? new GotzjiNativeNoLaunchError('spawn-error-no-pid') : new GotzjiNativeError('NATIVE_PROVIDER_START_FAILED'));
    });
    child.once('close', () => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (interrupted) { reject(new GotzjiNativeError('NATIVE_TERMINATION_UNVERIFIED', undefined, 'unknown')); return; }
      try {
        const result: unknown = JSON.parse(stdout);
        if (!record(result)) throw new Error();
        if (result.ok !== true) {
          const code = record(result.error) && typeof result.error.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(result.error.code) ? result.error.code : 'NATIVE_PROVIDER_FAILED';
          const field = record(result.error) && typeof result.error.field === 'string' && /^[a-z][a-z0-9-]{0,79}$/u.test(result.error.field) ? result.error.field : undefined;
          reject(new GotzjiNativeError(code, field, record(result.error) && result.error.outcome === 'unknown' ? 'unknown' : 'none')); return;
        }
        resolve(result.value);
      } catch { reject(new GotzjiNativeError('NATIVE_PROVIDER_RESPONSE_INVALID', undefined, 'unknown')); }
    });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdin.end(JSON.stringify({ request: input, ...(processEvidence ? { processEvidence } : {}) }), 'utf8');
  });
}
function startGotzjiNativePowerShell(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { windowsHide: true, stdio: 'pipe', shell: false, env: environment });
}
export function gotzjiNativeChildEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'localappdata', 'appdata', 'homedrive', 'homepath', 'username', 'userdomain', 'programfiles', 'programfiles(x86)', 'programdata', 'commonprogramfiles', 'commonprogramfiles(x86)', 'comspec', 'os', 'pathext', 'processor_architecture', 'number_of_processors', 'sessionname']);
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(base).filter(([key]) => allowed.has(key.toLowerCase())));
  const systemRoot = base.SystemRoot ?? base.SYSTEMROOT ?? 'C:\\Windows';
  environment.PATH = `${path.join(systemRoot, 'System32')};${systemRoot}`;
  // An Electron/Node parent may inherit PowerShell 7's module path. This worker
  // is intentionally Windows PowerShell 5.1 and uses only its system modules.
  environment.PSModulePath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return environment;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
