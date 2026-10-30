import { useEffect, useRef, useState, type ReactElement } from 'react';

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
interface NativeWriteResult { readonly kind: 'native-write'; readonly path: string; readonly sha256: string; readonly unavailable?: 'PROJECT_ARCHIVED' | 'ARTIFACT_TOO_LARGE' }
export type OperationResult = FileReadResult | FileWriteResult | CommandResult | NativeWriteResult;

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
  if (['excel.range.write', 'word.paragraph.write', 'powerpoint.shape.write', 'cad.entity.move'].includes(String(value.operation))) {
    if (output.operation !== value.operation || output.jobId !== context.jobId || output.projectId !== context.projectId || output.state !== 'completed'
      || typeof output.outputPath !== 'string' || !output.outputPath || /^(?:[A-Za-z]:|[/\\])|(?:^|[/\\])\.\.(?:[/\\]|$)|\0/u.test(output.outputPath)
      || !record(output.nativeReceipt) || output.nativeReceipt.verified !== true || output.nativeReceipt.originalPreserved !== true
      || output.nativeReceipt.unrelatedPreserved !== true || output.nativeReceipt.savedAndReopened !== true || !hash(output.nativeReceipt.outputSha256)) return undefined;
    if (value.nativeOutputCurrent !== undefined && value.nativeOutputCurrent !== false) return undefined;
    if (value.nativeOutputCurrent === false && value.nativeOutputReason !== 'PROJECT_ARCHIVED' && value.nativeOutputReason !== 'ARTIFACT_TOO_LARGE') return undefined;
    return { kind: 'native-write', path: output.outputPath, sha256: output.nativeReceipt.outputSha256,
      ...(value.nativeOutputCurrent === false ? { unavailable: value.nativeOutputReason as 'PROJECT_ARCHIVED' | 'ARTIFACT_TOO_LARGE' } : {}) };
  }
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

export function GotzjiOperationResult({ value, onLogs, readFile, exportNative, disabled = false }: { readonly value: OperationResult; readonly onLogs: () => void; readonly readFile?: (path: string) => Promise<unknown>; readonly exportNative?: () => Promise<{ readonly exported: boolean; readonly cancelled: boolean }>; readonly disabled?: boolean }): ReactElement {
  if (value.kind === 'command') return <section aria-label="ผลลัพธ์คำสั่ง"><h4>คำสั่งจบแล้ว</h4><p>คำสั่ง: {value.commandId}</p><p>รหัสจบ: 0</p><p>ใช้เวลา {value.elapsedMs / 1000} วินาที</p>
    <p>เก็บบันทึก {value.outputBytes} ไบต์{value.truncated ? ' · บันทึกข้อความถูกจำกัดขนาด ไม่ใช่ข้อความทั้งหมดของโปรแกรม' : ''}</p><button onClick={onLogs}>อ่านบันทึกของงานนี้</button></section>;
  if (value.kind === 'native-write') return <section aria-label="ผลงานจากโปรแกรม"><h4>{value.unavailable ? 'หลักฐานเดิมของผลงาน' : 'บันทึกผลงานเป็นสำเนาแล้ว'}</h4><p>ไฟล์ในโครงการ: {value.path}</p>
    {value.unavailable ? <p>ยังไม่ได้ตรวจไฟล์ปัจจุบัน · {value.unavailable === 'PROJECT_ARCHIVED' ? 'คืนโครงการจากที่เก็บถาวรและอ่านผลใหม่ก่อนบันทึก' : 'ไฟล์ใหญ่เกิน 16 MiB จึงบันทึกผ่านทางนี้ไม่ได้'}</p>
      : <><p>ระบบตรวจไฟล์อีกครั้งเมื่อบันทึกสำเนา ขนาดไม่เกิน 16 MiB และต้องเลือกชื่อไฟล์ใหม่ ไฟล์ในโครงการอาจเปลี่ยนหลังตรวจ</p>{exportNative && <NativeOutput exportNative={exportNative} disabled={disabled} />}</>}
    <details><summary>รหัสตรวจไฟล์</summary><code>{value.sha256}</code></details></section>;
  return <section aria-label="ผลลัพธ์ไฟล์"><h4>{value.kind === 'file-read' ? 'อ่านไฟล์แล้ว' : value.created ? 'สร้างไฟล์ใหม่แล้ว' : 'บันทึกไฟล์แล้ว'}</h4><p>ไฟล์ในโครงการ: {value.path}</p>
    {value.kind === 'file-read' ? <pre aria-label="เนื้อหาไฟล์ที่อ่านได้">{value.content || 'ไฟล์นี้ไม่มีข้อความ'}</pre> : <><p>บันทึก {value.bytes} ไบต์</p>{value.originalRetained && <p>มีสำเนาต้นฉบับในหลักฐานของงานนี้</p>}{readFile && <WrittenFile key={`${value.path}:${value.sha256}`} value={value} readFile={readFile} disabled={disabled} />}</>}
    <details><summary>รหัสตรวจไฟล์</summary><code>{value.sha256}</code></details>
  </section>;
}

function NativeOutput({ exportNative, disabled }: { readonly exportNative: () => Promise<{ readonly exported: boolean; readonly cancelled: boolean }>; readonly disabled: boolean }): ReactElement {
  const [message, setMessage] = useState<string | null>(null); const [loading, setLoading] = useState(false); const generation = useRef(0);
  useEffect(() => (): void => { generation.current += 1; }, []);
  async function save(): Promise<void> {
    const current = ++generation.current; setLoading(true); setMessage(null);
    try { const result = await exportNative(); if (generation.current === current) setMessage(result.exported ? 'บันทึกสำเนาที่ตรวจแล้ว' : 'ยกเลิกการบันทึก'); }
    catch (cause) {
      if (generation.current === current) {
        const error = cause instanceof Error ? cause.message : '';
        setMessage(error.includes('ARTIFACT_TOO_LARGE') ? 'ไฟล์ใหญ่เกิน 16 MiB จึงบันทึกผ่านทางนี้ไม่ได้' : error.includes('EEXIST') ? 'มีไฟล์ชื่อนี้อยู่แล้ว เลือกชื่อใหม่เพื่อรักษาไฟล์เดิม' : error.includes('NATIVE_OUTPUT_WRITE_INCOMPLETE') ? 'บันทึกไม่สำเร็จ ไฟล์ที่เลือกอาจไม่สมบูรณ์ โปรดตรวจไฟล์ก่อนใช้งาน' : operationResultMessage(error));
      }
    } finally { if (generation.current === current) setLoading(false); }
  }
  return <div><button disabled={disabled || loading} onClick={() => void save()}>บันทึกสำเนาผลงาน</button>{loading && <p role="status">กำลังตรวจและบันทึก…</p>}{message && <p role="status">{message}</p>}</div>;
}

function WrittenFile({ value, readFile, disabled }: { readonly value: FileWriteResult; readonly readFile: (path: string) => Promise<unknown>; readonly disabled: boolean }): ReactElement {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  useEffect(() => (): void => { generation.current += 1; }, []);
  async function open(): Promise<void> {
    const current = ++generation.current;
    setContent(null); setError(null); setLoading(true);
    try {
      const result = await readFile(value.path);
      if (generation.current !== current) return;
      if (!record(result) || typeof result.content !== 'string' || result.sha256 !== value.sha256) {
        setError('ไฟล์เปลี่ยนไปหรือยังตรวจรุ่นไม่ได้ เปิดโครงการเพื่อตรวจไฟล์ปัจจุบัน');
      } else setContent(result.content);
    } catch (cause) {
      if (generation.current === current) {
        const code = cause instanceof Error ? cause.message : '';
        setError(code.includes('FILE_NOT_FOUND') ? 'ไม่พบไฟล์ในโครงการ ตรวจว่าไฟล์ยังอยู่หรือไม่'
          : ['RESULT_EXPIRED', 'RESULT_NOT_VERIFIED', 'ARTIFACT_CHANGED', 'HOST_CONNECTION_LOST'].some(item => code.includes(item))
            ? operationResultMessage(code) : 'ยังเปิดผลงานไม่ได้ ตรวจสถานะงานและโครงการแล้วลองอีกครั้ง');
      }
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }
  return <div><button disabled={disabled || loading} onClick={() => void open()}>เปิดดูผลงาน</button>
    {loading && <p role="status">กำลังตรวจไฟล์…</p>}{error && <p role="alert">{error}</p>}
    {content !== null && <><p>เนื้อหาที่เปิดอ่านตรงกับผลงานของงานนี้ ณ ตอนที่เปิดอ่าน ไฟล์ในโครงการอาจเปลี่ยนภายหลัง</p><pre aria-label="เนื้อหาผลงานที่ตรวจแล้ว">{content || 'ไฟล์นี้ไม่มีข้อความ'}</pre></>}</div>;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
