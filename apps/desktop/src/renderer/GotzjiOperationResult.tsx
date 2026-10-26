import type { ReactElement } from 'react';

interface FileReadResult {
  readonly kind: 'file-read'; readonly path: string; readonly content: string; readonly sha256: string;
}
interface FileWriteResult {
  readonly kind: 'file-write'; readonly path: string; readonly bytes: number; readonly sha256: string;
  readonly created: boolean; readonly originalRetained: boolean;
}
interface CommandResult {
  readonly kind: 'command'; readonly commandId: string; readonly elapsedMs: number; readonly outputBytes: number; readonly truncated: boolean;
}
export type OperationResult = FileReadResult | FileWriteResult | CommandResult;

export function operationResultMessage(error: string): string {
  if (error.includes('RESULT_EXPIRED')) return 'ระบบไม่เก็บผลลัพธ์ของงานนี้แล้ว ตรวจไฟล์ที่ส่งมอบไว้ในโครงการ';
  if (error.includes('ARTIFACT_CHANGED')) return 'ไฟล์หรือหลักฐานเปลี่ยนไปแล้ว ระบบจึงยังไม่แสดงเป็นผลที่ตรวจยืนยัน ตรวจไฟล์และสถานะงานก่อนทำต่อ';
  if (error.includes('RESULT_NOT_VERIFIED')) return 'ยังไม่มีผลที่ระบบตรวจยืนยันครบ เปิดสถานะงานและบันทึกเพื่อตรวจสาเหตุ';
  if (error.includes('HOST_CONNECTION_LOST')) return 'ยังติดต่อระบบเพื่ออ่านผลไม่ได้ ลองรีเฟรชแล้วอ่านผลของงานเดิมอีกครั้ง';
  return 'ยังอ่านผลลัพธ์ไม่ได้ เปิดรายละเอียดข้อผิดพลาดหรือตรวจบันทึกของงานนี้';
}

/** Presentation only. The same-job Core result API verifies the receipt and retained bytes first. */
export function operationResult(value: unknown, context: { readonly jobId: string; readonly projectId: string }): OperationResult | undefined {
  if (!context.jobId || !context.projectId || !record(value) || value.verifier !== 'host-product-receipt-v1'
    || value.projectId !== context.projectId || !hash(value.artifactHash) || !record(value.output)) return undefined;
  const output = value.output;
  if (value.operation === 'command.run') {
    if (output.operation !== value.operation || output.jobId !== context.jobId || output.state !== 'completed' || output.exitCode !== 0
      || typeof output.commandId !== 'string' || !output.commandId || !Number.isSafeInteger(output.elapsedMs) || Number(output.elapsedMs) < 0
      || !Number.isSafeInteger(output.outputBytes) || Number(output.outputBytes) < 0 || output.truncated !== undefined && typeof output.truncated !== 'boolean') return undefined;
    return { kind: 'command', commandId: output.commandId, elapsedMs: Number(output.elapsedMs), outputBytes: Number(output.outputBytes), truncated: output.truncated === true };
  }
  if (!['file.read', 'file.write'].includes(String(value.operation)) || output.operation !== value.operation || output.state !== 'completed'
    || output.projectId !== context.projectId || typeof output.path !== 'string' || !output.path
    || !hash(output.sha256)) return undefined;
  if (output.operation === 'file.read') return typeof output.content === 'string' ? { kind: 'file-read', path: output.path, content: output.content, sha256: output.sha256 } : undefined;
  if (!Number.isSafeInteger(output.bytes) || Number(output.bytes) < 0 || output.beforeSha256 !== null && !hash(output.beforeSha256)) return undefined;
  return { kind: 'file-write', path: output.path, bytes: Number(output.bytes), sha256: output.sha256, created: output.beforeSha256 === null,
    originalRetained: hash(output.beforeSha256) && record(value.before) && value.before.sha256 === output.beforeSha256 && typeof value.before.content === 'string' };
}

export function GotzjiOperationResult({ value, onLogs }: { readonly value: OperationResult; readonly onLogs: () => void }): ReactElement {
  if (value.kind === 'command') return <section aria-label="ผลลัพธ์คำสั่ง"><h4>คำสั่งจบแล้ว</h4><p>คำสั่ง: {value.commandId}</p><p>รหัสจบ: 0</p><p>ใช้เวลา {value.elapsedMs / 1000} วินาที</p>
    <p>เก็บบันทึก {value.outputBytes} ไบต์{value.truncated ? ' · บันทึกข้อความถูกจำกัดขนาด ไม่ใช่ข้อความทั้งหมดของโปรแกรม' : ''}</p><button onClick={onLogs}>อ่านบันทึกของงานนี้</button></section>;
  return <section aria-label="ผลลัพธ์ไฟล์"><h4>{value.kind === 'file-read' ? 'อ่านไฟล์แล้ว' : value.created ? 'สร้างไฟล์ใหม่แล้ว' : 'บันทึกไฟล์แล้ว'}</h4><p>ไฟล์ในโครงการ: {value.path}</p>
    {value.kind === 'file-read' ? <pre aria-label="เนื้อหาไฟล์ที่อ่านได้">{value.content || 'ไฟล์นี้ไม่มีข้อความ'}</pre> : <><p>บันทึก {value.bytes} ไบต์</p>{value.originalRetained && <p>มีสำเนาต้นฉบับในหลักฐานของงานนี้</p>}</>}
    <details><summary>รหัสตรวจไฟล์</summary><code>{value.sha256}</code></details>
  </section>;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
