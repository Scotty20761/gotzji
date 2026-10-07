import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { GotzjiNativeError, nativeBytesDigest, nativeFileDigest, planGotzjiNativeOperation, type GotzjiNativeGrant, type GotzjiNativeReceipt } from './gotzji-native-contract.js';

export interface GotzjiNativeAdapterOptions {
  readonly scriptPath: string;
  readonly scriptSha256: string;
  readonly verifyGrant: (grant: GotzjiNativeGrant, digest: string, resourceKeys: readonly string[]) => Promise<boolean>;
  readonly runner?: (scriptPath: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
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
    const script = await this.providerScript();
    const value = await (this.options.runner ?? runGotzjiNativePowerShell)(script, plan.input, signal);
    if (!record(value) || value.verified !== true || value.operation !== plan.input.operation || value.provider !== plan.provider
      || value.originalPreserved !== true || value.sourceSha256 !== plan.input.expectedSha256 || typeof value.providerVersion !== 'string'
      || !Number.isInteger(value.nativePid) || Number(value.nativePid) < 1 || typeof value.savedAndReopened !== 'boolean' || typeof value.unrelatedPreserved !== 'boolean') throw new GotzjiNativeError('NATIVE_RECEIPT_INVALID', undefined, 'unknown');
    if (await nativeFileDigest(plan.input.filePath) !== plan.input.expectedSha256) throw new GotzjiNativeError('NATIVE_ORIGINAL_CHANGED', undefined, 'unknown');
    if ('outputPath' in plan.input && (value.savedAndReopened !== true || value.unrelatedPreserved !== true || value.outputSha256 !== await nativeFileDigest(plan.input.outputPath))) throw new GotzjiNativeError('NATIVE_PRESERVATION_FAILED', undefined, 'unknown');
    return value as unknown as GotzjiNativeReceipt;
  }
  private async providerScript(): Promise<string> {
    const script = await realpath(this.options.scriptPath);
    if (!(await lstat(this.options.scriptPath)).isFile() || (await lstat(this.options.scriptPath)).isSymbolicLink() || script.toLowerCase() !== path.resolve(this.options.scriptPath).toLowerCase() || nativeBytesDigest(await readFile(script)) !== this.options.scriptSha256) throw new GotzjiNativeError('NATIVE_PROVIDER_CHANGED');
    return script;
  }
}
export async function runGotzjiNativePowerShell(scriptPath: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  if (process.platform !== 'win32') throw new GotzjiNativeError('NATIVE_WINDOWS_REQUIRED');
  if (signal?.aborted) throw new GotzjiNativeError('NATIVE_CANCELLED_BEFORE_START');
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: gotzjiNativeChildEnvironment() });
    let stdout = ''; let interrupted = false;
    const stop = (): void => { interrupted = true; child.kill(); };
    const timer = setTimeout(stop, 120000);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString('utf8'); if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) stop(); });
    child.stderr.resume();
    child.stdin.on('error', () => { /* close/error yields a typed result */ });
    child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(new GotzjiNativeError('NATIVE_PROVIDER_START_FAILED')); });
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
    child.stdin.end(JSON.stringify(input), 'utf8');
  });
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
