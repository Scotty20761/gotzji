import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { GotzjiNativeError, nativeBytesDigest, nativeFileDigest, planGotzjiNativeOperation, type GotzjiNativeGrant, type GotzjiNativeOperation, type GotzjiNativeReceipt } from './gotzji-native-contract.js';
import { runGotzjiNativePowerShell } from './gotzji-native-adapter.js';

export interface GotzjiCadSessionOptions {
  readonly scriptPath: string;
  readonly scriptSha256: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly verifyGrant: (grant: GotzjiNativeGrant, digest: string, resourceKeys: readonly string[]) => Promise<boolean>;
  readonly runner?: (scriptPath: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
}
interface CadLine {
  readonly handle: string;
  readonly objectType: 'AcDbLine';
  readonly layer: string;
  readonly startPoint: readonly [number, number, number];
  readonly endPoint: readonly [number, number, number];
}
interface CadSessionResult {
  readonly native: { readonly before: CadLine; readonly after: CadLine; readonly unrelatedPreserved: true };
  readonly nativePid: number;
  readonly birth: string;
  readonly providerVersion: string;
  readonly owned: true;
  readonly closed: true;
  readonly originalSessionsPreserved: true;
  readonly unrelatedHash: string;
}

/** Fixed LINE actions in nonce/HWND/PID/birth-bound sessions; ambient COM is never used. */
export class GotzjiCadSessionAdapter {
  public constructor(private readonly options: GotzjiCadSessionOptions) {}

  public async execute(grant: GotzjiNativeGrant, input: unknown, signal?: AbortSignal): Promise<GotzjiNativeReceipt> {
    if (!grant.ownerId || !grant.projectId || !grant.jobId || !grant.operationId || !grant.proof) throw new GotzjiNativeError('NATIVE_AUTHORITY_DENIED');
    const plan = await planGotzjiNativeOperation(input, grant.rootPath);
    if (plan.provider !== 'cad') throw new GotzjiNativeError('CAD_SESSION_OPERATION_DENIED');
    if (path.extname(plan.input.filePath).toLowerCase() !== '.dwg') throw new GotzjiNativeError('CAD_SESSION_FORMAT_UNSUPPORTED', 'filePath');
    await this.authorize(grant, plan.digest, plan.resourceKeys, signal);
    const script = await this.pinnedFile(this.options.scriptPath, this.options.scriptSha256);
    const executable = await this.pinnedFile(this.options.executable, this.options.executableSha256);
    const runner = this.options.runner ?? runGotzjiNativePowerShell;
    const first = sessionResult(await runner(script, { ...plan.input, executable }, signal));
    if (first.native.before.handle.toUpperCase() !== (plan.input as Extract<GotzjiNativeOperation, { operation: 'cad.entity.inspect' | 'cad.entity.move' }>).handle.toUpperCase()) throw new GotzjiNativeError('CAD_SESSION_ENTITY_MISMATCH', 'handle', 'unknown');
    let after = first.native.after;
    let outputSha256: string | null = null;
    let reopened = false;
    if (plan.input.operation === 'cad.entity.move') {
      const operation = plan.input;
      if (!lineDisplaced(first.native.before, after, operation.displacement)) throw new GotzjiNativeError('CAD_SESSION_MOVE_UNVERIFIED', undefined, 'unknown');
      outputSha256 = await nativeFileDigest(operation.outputPath);
      try {
        await this.authorize(grant, plan.digest, plan.resourceKeys, signal);
        await this.pinnedFile(this.options.scriptPath, this.options.scriptSha256);
        await this.pinnedFile(this.options.executable, this.options.executableSha256);
      }
      catch (error) {
        throw new GotzjiNativeError(error instanceof GotzjiNativeError ? error.code : 'NATIVE_AUTHORITY_DENIED', undefined, 'unknown');
      }
      // Reopen in another newly owned native process after the saved session has exited.
      const second = sessionResult(await runner(script, { operation: 'cad.entity.inspect', filePath: operation.outputPath, expectedSha256: outputSha256, handle: operation.handle, executable }, signal));
      if (!sameLine(after, second.native.before) || first.unrelatedHash !== second.unrelatedHash) throw new GotzjiNativeError('CAD_SESSION_REOPEN_UNVERIFIED', undefined, 'unknown');
      if (outputSha256 !== await nativeFileDigest(operation.outputPath)) throw new GotzjiNativeError('CAD_SESSION_OUTPUT_CHANGED', 'outputPath', 'unknown');
      after = second.native.before;
      reopened = true;
    } else if (!sameLine(first.native.before, after)) throw new GotzjiNativeError('CAD_SESSION_READ_CHANGED', undefined, 'unknown');
    if (await nativeFileDigest(plan.input.filePath) !== plan.input.expectedSha256) throw new GotzjiNativeError('NATIVE_ORIGINAL_CHANGED', undefined, 'unknown');
    return { operation: plan.input.operation, provider: 'cad', providerVersion: first.providerVersion, nativePid: first.nativePid, sourceSha256: plan.input.expectedSha256, outputSha256, originalPreserved: true, savedAndReopened: reopened, unrelatedPreserved: true, verified: true, before: first.native.before, after };
  }

  private async authorize(grant: GotzjiNativeGrant, digest: string, resources: readonly string[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new GotzjiNativeError('NATIVE_CANCELLED_BEFORE_START');
    if (!await this.options.verifyGrant(grant, digest, resources)) throw new GotzjiNativeError('NATIVE_AUTHORITY_DENIED');
  }
  private async pinnedFile(filename: string, expected: string): Promise<string> {
    const actual = await realpath(filename);
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || actual.toLowerCase() !== path.resolve(filename).toLowerCase() || nativeBytesDigest(await readFile(actual)) !== expected) throw new GotzjiNativeError('NATIVE_PROVIDER_CHANGED');
    return actual;
  }
}

function sessionResult(value: unknown): CadSessionResult {
  if (!record(value) || value.owned !== true || value.closed !== true || value.originalSessionsPreserved !== true
    || !Number.isSafeInteger(value.nativePid) || Number(value.nativePid) < 1 || typeof value.birth !== 'string' || !/^\d{10,24}$/u.test(value.birth)
    || typeof value.providerVersion !== 'string' || !value.providerVersion.startsWith('25.') || typeof value.unrelatedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.unrelatedHash)
    || !record(value.native) || value.native.unrelatedPreserved !== true || !cadLine(value.native.before) || !cadLine(value.native.after)) throw new GotzjiNativeError('CAD_SESSION_OWNERSHIP_OR_RECEIPT_UNVERIFIED', undefined, 'unknown');
  return value as unknown as CadSessionResult;
}
function cadLine(value: unknown): value is CadLine {
  return record(value) && typeof value.handle === 'string' && /^[a-f0-9]{1,64}$/iu.test(value.handle) && value.objectType === 'AcDbLine'
    && typeof value.layer === 'string' && point(value.startPoint) && point(value.endPoint);
}
function point(value: unknown): value is readonly [number, number, number] { return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)); }
function sameLine(before: CadLine, after: CadLine): boolean { return lineDisplaced(before, after, [0, 0, 0]); }
function lineDisplaced(before: CadLine, after: CadLine, delta: readonly [number, number, number]): boolean {
  return before.handle.toUpperCase() === after.handle.toUpperCase() && before.objectType === after.objectType && before.layer === after.layer
    && before.startPoint.every((value, index) => Math.abs(value + delta[index]! - after.startPoint[index]!) < 1e-8)
    && before.endPoint.every((value, index) => Math.abs(value + delta[index]! - after.endPoint[index]!) < 1e-8);
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
