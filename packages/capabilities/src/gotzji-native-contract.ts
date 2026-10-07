import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export type GotzjiNativeProvider = 'excel' | 'word' | 'powerpoint' | 'cad';
export type GotzjiNativeOperation =
  | { readonly operation: 'excel.range.read'; readonly filePath: string; readonly expectedSha256: string; readonly sheet: string; readonly range: string }
  | { readonly operation: 'excel.range.write'; readonly filePath: string; readonly expectedSha256: string; readonly outputPath: string; readonly sheet: string; readonly range: string; readonly values: readonly (readonly (string | number | boolean | null)[])[] }
  | { readonly operation: 'word.paragraph.read'; readonly filePath: string; readonly expectedSha256: string; readonly paragraph: number }
  | { readonly operation: 'word.paragraph.write'; readonly filePath: string; readonly expectedSha256: string; readonly outputPath: string; readonly paragraph: number; readonly text: string }
  | { readonly operation: 'powerpoint.shape.read'; readonly filePath: string; readonly expectedSha256: string; readonly slide: number; readonly shape: string }
  | { readonly operation: 'powerpoint.shape.write'; readonly filePath: string; readonly expectedSha256: string; readonly outputPath: string; readonly slide: number; readonly shape: string; readonly text: string }
  | { readonly operation: 'cad.entity.inspect'; readonly filePath: string; readonly expectedSha256: string; readonly handle: string }
  | { readonly operation: 'cad.entity.move'; readonly filePath: string; readonly expectedSha256: string; readonly outputPath: string; readonly handle: string; readonly displacement: readonly [number, number, number] };

export interface GotzjiNativeGrant {
  readonly ownerId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly operationId: string;
  readonly rootPath: string;
  readonly proof: string;
}
export interface GotzjiNativePlan {
  readonly input: GotzjiNativeOperation;
  readonly digest: string;
  readonly resourceKeys: readonly string[];
  readonly provider: GotzjiNativeProvider;
}
export interface GotzjiNativeReceipt {
  readonly operation: GotzjiNativeOperation['operation'];
  readonly provider: GotzjiNativeProvider;
  readonly providerVersion: string;
  readonly nativePid: number;
  readonly sourceSha256: string;
  readonly outputSha256: string | null;
  readonly originalPreserved: true;
  readonly savedAndReopened: boolean;
  readonly unrelatedPreserved: boolean;
  readonly verified: true;
  readonly before: unknown;
  readonly after: unknown;
}
export class GotzjiNativeError extends Error {
  public constructor(public readonly code: string, public readonly field?: string, public readonly outcome: 'none' | 'unknown' = 'none') {
    super(field === undefined ? code : `${code}: ${field}`); this.name = 'GotzjiNativeError';
  }
}
export function nativeDigest(input: unknown): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
export async function planGotzjiNativeOperation(value: unknown, rootPath: string): Promise<GotzjiNativePlan> {
  if (!record(value) || typeof value.operation !== 'string') throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'operation');
  const operation = value.operation;
  const schemas: Record<string, readonly string[]> = {
    'excel.range.read': ['sheet', 'range'], 'excel.range.write': ['sheet', 'range', 'values', 'outputPath'],
    'word.paragraph.read': ['paragraph'], 'word.paragraph.write': ['paragraph', 'text', 'outputPath'],
    'powerpoint.shape.read': ['slide', 'shape'], 'powerpoint.shape.write': ['slide', 'shape', 'text', 'outputPath'],
    'cad.entity.inspect': ['handle'], 'cad.entity.move': ['handle', 'displacement', 'outputPath'],
  };
  const fields = schemas[operation];
  if (!fields || Object.keys(value).some((key) => !['operation', 'filePath', 'expectedSha256', ...fields].includes(key))) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'operation');
  if (typeof value.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.expectedSha256)) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'expectedSha256');
  if (typeof value.filePath !== 'string' || !path.isAbsolute(value.filePath)) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'filePath');
  const root = await realpath(rootPath);
  const source = await realpath(value.filePath);
  if (!within(root, source) || source.toLowerCase() !== path.resolve(value.filePath).toLowerCase() || !(await lstat(value.filePath)).isFile() || (await lstat(value.filePath)).isSymbolicLink()) throw new GotzjiNativeError('NATIVE_SCOPE_DENIED', 'filePath');
  if (await nativeFileDigest(source) !== value.expectedSha256) throw new GotzjiNativeError('NATIVE_FILE_VERSION_CONFLICT', 'expectedSha256');
  const provider = operation.split('.')[0] as GotzjiNativeProvider;
  const extensions: Record<GotzjiNativeProvider, readonly string[]> = { excel: ['.xlsx', '.xlsm'], word: ['.docx'], powerpoint: ['.pptx'], cad: ['.dwg', '.dxf'] };
  if (!extensions[provider].includes(path.extname(source).toLowerCase())) throw new GotzjiNativeError('NATIVE_FORMAT_UNSUPPORTED', 'filePath');
  let output: string | undefined;
  if (fields.includes('outputPath')) {
    if (typeof value.outputPath !== 'string' || !path.isAbsolute(value.outputPath)) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'outputPath');
    const parent = await realpath(path.dirname(value.outputPath));
    output = path.join(parent, path.basename(value.outputPath));
    if (!within(root, output) || output.toLowerCase() === source.toLowerCase() || path.extname(output).toLowerCase() !== path.extname(source).toLowerCase()) throw new GotzjiNativeError('NATIVE_SCOPE_DENIED', 'outputPath');
    try { await lstat(output); throw new GotzjiNativeError('NATIVE_OUTPUT_EXISTS', 'outputPath'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (provider === 'excel') {
    requiredText(value, 'sheet', 128);
    if (typeof value.range !== 'string' || !/^\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?$/u.test(value.range)) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'range');
    if (operation.endsWith('write') && (!Array.isArray(value.values) || value.values.length < 1 || value.values.length > 1000 || value.values.some((row: unknown) => !Array.isArray(row) || row.length < 1 || row.length > 100 || row.some((cell: unknown) => cell !== null && typeof cell !== 'string' && typeof cell !== 'boolean' && !(typeof cell === 'number' && Number.isFinite(cell)))))) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'values');
  }
  if (provider === 'word' && (!Number.isSafeInteger(value.paragraph) || Number(value.paragraph) < 1 || Number(value.paragraph) > 10000)) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'paragraph');
  if (provider === 'powerpoint') {
    if (!Number.isSafeInteger(value.slide) || Number(value.slide) < 1 || Number(value.slide) > 10000) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'slide');
    requiredText(value, 'shape', 256);
  }
  if (fields.includes('text')) {
    if (typeof value.text !== 'string' || value.text.length > 32768 || /[\r\n\0]/u.test(value.text)) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'text');
  }
  if (provider === 'cad') {
    if (typeof value.handle !== 'string' || !/^[a-fA-F0-9]{1,16}$/u.test(value.handle)) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'handle');
    if (operation.endsWith('move') && (!Array.isArray(value.displacement) || value.displacement.length !== 3 || value.displacement.some((coordinate: unknown) => typeof coordinate !== 'number' || !Number.isFinite(coordinate) || Math.abs(coordinate) > 1e6))) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', 'displacement');
  }
  const normalized = { ...value, filePath: source, ...(output === undefined ? {} : { outputPath: output }) } as unknown as GotzjiNativeOperation;
  return { input: normalized, digest: nativeDigest(normalized), provider, resourceKeys: [`native-provider:${provider}`, `native-document:${nativeDigest(source.toLowerCase())}`, ...(output === undefined ? [] : [`native-document:${nativeDigest(output.toLowerCase())}`]), ...(provider === 'cad' ? ['native-interactive:windows'] : [])] };
}
export function nativeBytesDigest(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export async function nativeFileDigest(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(filePath)) digest.update(bytes as Buffer);
  return digest.digest('hex');
}
function requiredText(value: Record<string, unknown>, field: string, max: number): void { if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > max || value[field].includes('\0')) throw new GotzjiNativeError('NATIVE_INPUT_INVALID', field); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function within(root: string, target: string): boolean { const relative = path.relative(root, target); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
