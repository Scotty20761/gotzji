import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { JobLogReader, type JobLogSnapshot } from './gotzji-job-logs.js';

type Props = {
  readonly jobId: string;
  readonly visible: boolean;
  readonly request: (method: 'logs', input: Readonly<Record<string, unknown>>) => Promise<unknown>;
};

export function GotzjiJobLogs({ jobId, visible, request }: Props): ReactElement {
  const [snapshot, setSnapshot] = useState<JobLogSnapshot>({ text: '', cursor: 0, expired: false, truncated: false });
  const [paused, setPaused] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const mounted = useRef(true);
  const pausedRef = useRef(false);
  const visibleRef = useRef(visible);
  const readAction = useRef<() => void>(() => undefined);
  const filterId = useId();
  useEffect(() => { mounted.current = true; return (): void => { mounted.current = false; }; }, []);
  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => {
    const reader = new JobLogReader(jobId, (input) => request('logs', { ...input }));
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      if (!active || inFlight) return;
      inFlight = true; setReading(true);
      try {
        const value = await reader.read();
        if (active && value) { setSnapshot(value); setError(null); }
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : 'LOG_READ_FAILED'); pausedRef.current = true; setPaused(true); }
      } finally { inFlight = false; if (active) setReading(false); }
    };
    readAction.current = (): void => { void read(); };
    const poll = async (): Promise<void> => {
      if (visibleRef.current && !pausedRef.current && !reader.snapshot().expired) await read();
      if (active) timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
    return (): void => { active = false; reader.close(); clearTimeout(timer); readAction.current = (): void => undefined; };
  }, [jobId, request]);
  const shown = filter ? snapshot.text.split('\n').filter((line) => line.includes(filter)).join('\n') : snapshot.text;
  return <section hidden={!visible} className="gotzji-job-logs" aria-busy={reading} aria-label="ข้อความบันทึกของงานที่เลือก">
    <h3>ข้อความจากงานนี้</h3><p>อ่านจากงานเดิม การติดตามบันทึกไม่เริ่มงานใหม่</p>
    <div className="gotzji-actions"><button disabled={snapshot.expired} aria-pressed={paused} onClick={() => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); }}>{paused ? 'ติดตามต่อ' : 'พักการติดตาม'}</button>
      <button disabled={reading || snapshot.expired} onClick={() => readAction.current()}>อ่านบันทึกต่อ</button>
      <button disabled={exporting || snapshot.expired || !snapshot.text} onClick={() => {
        setExporting(true); setExportMessage('');
        void window.gotzji.exportJobLogs(jobId).then(value => { if (mounted.current) setExportMessage(value.exported ? 'บันทึกช่วงต้นของงานแล้ว' : 'ยกเลิกการบันทึก'); })
          .catch(() => { if (mounted.current) setExportMessage('บันทึกไม่สำเร็จ ตรวจว่าระบบยังเก็บข้อความของงานนี้ แล้วลองใหม่'); })
          .finally(() => { if (mounted.current) setExporting(false); });
      }}>บันทึกข้อความงานลงไฟล์</button></div>
    <p>บันทึกช่วงต้นของงานได้สูงสุด 64 KiB จากรหัสงานนี้ ตัวกรองบนหน้าจอไม่เปลี่ยนไฟล์ที่บันทึก</p>
    {exportMessage && <p role="status">{exportMessage}</p>}
    <p role="status">{snapshot.expired ? 'บันทึกหมดอายุแล้ว สถานะและประวัติของงานยังอยู่' : paused ? 'พักการติดตามแล้ว' : 'กำลังติดตามงานนี้'}</p>
    {error && <div role="alert"><p>อ่านบันทึกไม่สำเร็จ พักการติดตามไว้แล้ว คุณลองอ่านต่อจากตำแหน่งเดิมได้</p><details><summary>รายละเอียดข้อผิดพลาด</summary><pre>{error}</pre></details></div>}
    {snapshot.truncated && <p>แสดงข้อความช่วงล่าสุดในหน้าต่างนี้ บันทึกที่ระบบยังเก็บรักษายังคงอยู่กับงานเดิม</p>}
    <label htmlFor={filterId}>กรองข้อความที่แสดง</label><input id={filterId} value={filter} onChange={(event) => setFilter(event.target.value)} />
    {shown ? <pre className="gotzji-log-output" aria-label="บันทึกของงาน">{shown}</pre> : <p>{filter ? 'ไม่พบข้อความที่ตรงกับตัวกรองในส่วนที่อ่านไว้' : snapshot.expired ? 'ระบบไม่เก็บข้อความของงานนี้แล้ว' : 'ยังไม่มีข้อความในส่วนที่อ่านไว้'}</p>}
  </section>;
}
