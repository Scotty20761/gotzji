import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';

interface Props {
  readonly projectId: string;
  readonly disabled: boolean;
  readonly request: (method: GotzjiMethod, input: Record<string, unknown>) => Promise<unknown>;
  readonly onCommands: () => void;
  readonly onApprovals: () => void;
}
type View = 'status' | 'diff' | 'log';
interface Result { view: View; entries?: Record<string, unknown>[]; patch?: string; truncated: boolean }
const kinds: Record<string, string> = { modified: 'แก้ไข', added: 'เพิ่ม', untracked: 'ไฟล์ใหม่', deleted: 'ลบ', renamed: 'เปลี่ยนชื่อ', copied: 'คัดลอก', unmerged: 'รอแก้ข้อขัดแย้ง' };
const explanations: Record<string, string> = {
  GIT_REPOSITORY_REQUIRED: 'โครงการนี้ยังไม่มีคลัง Git ของตัวเอง',
  GIT_LAYOUT_UNSUPPORTED: 'คลังนี้ใช้โครงสร้าง Git แบบเชื่อมหรือแชร์ ซึ่งยังต้องตรวจเพิ่มเติม',
  GIT_PRIVATE_RUNTIME_OVERLAP: 'โครงการนี้มีพื้นที่ข้อมูลส่วนตัวของระบบอยู่ภายใน จึงยังเปิดมุมมอง Git ทั้งคลังไม่ได้',
  GIT_NETWORK_ROOT_DENIED: 'เลือกคลัง Git ในโฟลเดอร์ของเครื่องนี้เพื่อเปิดมุมมองนี้',
  GIT_OUTPUT_LIMIT: 'ข้อมูลเกินขนาดที่แสดงได้ กรุณาเลือกดูไฟล์ที่เล็กลง',
  GIT_OBJECT_BYTES_LIMIT: 'ข้อมูล Git เกินขนาดที่มุมมองนี้รองรับในรุ่นนี้',
  GIT_OBJECT_COPY_BUDGET: 'เตรียมข้อมูล Git ไม่เสร็จในเวลาที่กำหนด กรุณาลองใหม่ภายหลัง',
  GIT_SNAPSHOT_BUDGET: 'ตรวจและเตรียมข้อมูล Git ไม่เสร็จในเวลาที่กำหนด กรุณาลองใหม่ภายหลัง',
  GIT_VALIDATION_BUDGET: 'ยังตรวจข้อมูล Git ได้ไม่ครบในรอบนี้ กรุณาลองใหม่เมื่อคลังว่างจากงานอื่น',
  GIT_REPOSITORY_CHANGED: 'ข้อมูล Git เปลี่ยนระหว่างอ่าน กรุณาอ่านใหม่',
  GIT_READ_FAILED: 'อ่านคลัง Git ไม่สำเร็จ ตรวจสิทธิ์โฟลเดอร์แล้วลองใหม่',
};
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function GotzjiGitPanel({ projectId, disabled, request, onCommands, onApprovals }: Props): ReactElement {
  const [path, setPath] = useState('');
  const [staged, setStaged] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return (): void => { mounted.current = false; }; }, []);
  const locked = disabled || busy;
  async function read(view: View): Promise<void> {
    setBusy(true); setError(null); setResult(null);
    try {
      const value = await request('readProjectGit', { projectId, view, ...(view === 'diff' ? { path, staged } : {}) });
      if (!record(value) || value.projectId !== projectId || value.view !== view || typeof value.truncated !== 'boolean'
        || (view === 'diff' ? typeof value.patch !== 'string' : !Array.isArray(value.entries) || value.entries.some((item: unknown) => !record(item) || (view === 'status' ? typeof item.path !== 'string' || typeof item.kind !== 'string' : ['hash', 'author', 'date', 'subject'].some((key) => typeof item[key] !== 'string'))))) throw new Error('ข้อมูล Git ไม่สมบูรณ์ กรุณาอ่านใหม่');
      if (mounted.current) setResult(value as unknown as Result);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : 'อ่าน Git ไม่สำเร็จ';
      if (mounted.current) setError(explanations[code] ?? code);
    } finally { if (mounted.current) setBusy(false); }
  }
  return <section className="gotzji-git-panel" aria-busy={busy}>
    <h3>Git ของโครงการ</h3><p>ดูสิ่งที่เปลี่ยนและประวัติของโครงการที่เลือก ข้อมูลจะแสดงตามการอ่านครั้งล่าสุด</p>
    <div className="gotzji-actions"><button disabled={locked} onClick={() => void read('status')}>อ่านสถานะ Git</button><button disabled={locked} onClick={() => void read('log')}>อ่านประวัติ Git</button></div>
    <label>ไฟล์ที่ต้องการดูความต่าง<input disabled={locked} value={path} onChange={(event) => { setPath(event.target.value); setResult(null); }} placeholder="src/example.ts" /></label>
    <label className="gotzji-git-checkbox"><input type="checkbox" disabled={locked} checked={staged} onChange={(event) => { setStaged(event.target.checked); setResult(null); }} />ดูส่วนที่เตรียมบันทึกแล้ว</label>
    <button disabled={locked || !path} onClick={() => void read('diff')}>ดูความต่างของไฟล์</button>
    {busy && <p role="status">กำลังอ่าน Git…</p>}{error && <p role="alert">{error}</p>}
    {result?.truncated && <p role="status">ข้อมูลที่แสดงเป็นบางส่วน มีเนื้อหาเกินขนาดที่แสดงได้</p>}
    {result?.view === 'status' && (result.entries?.length ? <ul>{result.entries.map((entry, index) => <li key={`${String(entry.path)}:${index}`}><button disabled={locked} onClick={() => { setPath(String(entry.path)); setStaged(false); setResult(null); }}>{String(entry.path)}</button> · {kinds[String(entry.kind)] ?? String(entry.kind)}</li>)}</ul> : <p>ไม่มีไฟล์ที่เปลี่ยนในสถานะที่อ่านได้</p>)}
    {result?.view === 'diff' && <pre aria-label="ความต่างของไฟล์">{result.patch || 'ไม่มีความต่างในส่วนที่เลือก'}</pre>}
    {result?.view === 'log' && <><p>แสดงประวัติล่าสุดไม่เกิน 20 รายการ</p>{result.entries?.length ? <ol>{result.entries.map((entry, index) => <li key={`${String(entry.hash)}:${index}`}><strong>{String(entry.subject)}</strong><p>{String(entry.author)} · {String(entry.date)} · <code>{String(entry.hash).slice(0, 12)}</code></p></li>)}</ol> : <p>ไม่มีประวัติในข้อมูลที่อ่านได้</p>}</>}
    <p className="gotzji-muted">การบันทึก ส่งโค้ด และจัดการสาขาต้องใช้คำสั่งที่คุณตรวจและผูกกับโครงการก่อน ChatGPT เตรียมงาน ส่วนคำสั่งที่ระบุว่าเป็นการส่งมอบต้องให้คุณตรวจและอนุมัติคำขอแต่ละครั้ง</p>
    <div className="gotzji-actions"><button disabled={locked} onClick={onCommands}>ดูคำสั่งของโครงการ</button><button disabled={locked} onClick={onApprovals}>ตรวจคำขอส่งมอบ</button></div>
  </section>;
}
