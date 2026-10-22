import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';
import type { ProjectCommandOption } from './gotzji-project-commands.js';

type Props = {
  readonly projectId: string;
  readonly projectName: string;
  readonly commands: readonly ProjectCommandOption[];
  readonly disabled: boolean;
  readonly visible: boolean;
  readonly request: (method: GotzjiMethod, input: Record<string, unknown>) => Promise<unknown>;
  readonly onJob: (jobId: string) => void;
  readonly onSettings: () => void;
  readonly chatgptOnly?: boolean;
};
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function GotzjiProjectCommands({ projectId, projectName, commands, disabled, visible, request, onJob, onSettings, chatgptOnly = false }: Props): ReactElement {
  const [selectedId, setSelectedId] = useState('');
  const [priority, setPriority] = useState('1');
  const [preparationId, setPreparationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [admittedJobId, setAdmittedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const id = useId();
  useEffect(() => { mounted.current = true; return (): void => { mounted.current = false; }; }, []);
  const selected = commands.find((command) => command.recipeId === selectedId);
  const locked = disabled || busy;
  const clear = (): void => { requestId.current = null; setPreparationId(null); setAdmittedJobId(null); setError(null); };
  const act = async (action: () => Promise<void>): Promise<void> => {
    if (inFlight.current || disabled) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'COMMAND_REQUEST_FAILED'); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  if (chatgptOnly) return <section hidden={!visible} aria-label="คำสั่งที่ผูกกับโครงการ"><h3>คำสั่งสำหรับ ChatGPT</h3><p>โครงการ: {projectName}</p>
    <p>เลือกคำสั่งที่ผูกไว้ แล้วคัดลอกไปสั่งใน ChatGPT งานที่เริ่มแล้วจะปรากฏในประวัติของโครงการนี้</p>
    {commands.map((command) => <p key={command.recipeId}><button disabled={locked} onClick={() => void act(async () => {
      await navigator.clipboard.writeText(`อ่านบริบทโครงการ ${projectId} แล้วช่วยรันคำสั่ง ${command.recipeId} ในโครงการนี้ ตรวจผลและบันทึกสรุปเมื่อเสร็จ`);
      setSelectedId(command.recipeId);
    })}>คัดลอกคำสั่ง {command.title}</button></p>)}
    {commands.length === 0 && <button onClick={onSettings}>ตั้งค่าคำสั่งของโครงการ</button>}
    {selectedId && <p role="status">คัดลอกแล้ว วางข้อความใน ChatGPT เพื่อเริ่มงาน</p>}
    {error && <p role="alert">คัดลอกไม่สำเร็จ กรุณาลองอีกครั้ง</p>}
  </section>;
  return <section hidden={!visible} aria-label="คำสั่งที่ผูกกับโครงการ"><h3>รันคำสั่งของโครงการ</h3><p>โครงการ: {projectName}</p>
    <p>เลือกคำสั่งที่เจ้าของตรวจและผูกไว้แล้ว ระบบใช้โปรแกรม อาร์กิวเมนต์และขอบเขตเดิมจากการตั้งค่าโครงการ</p>
    {commands.length === 0 ? <p>ยังไม่มีคำสั่งที่พร้อมใช้และผูกกับโครงการนี้</p> : <>
      <label htmlFor={`${id}-command`}>คำสั่งของโครงการ</label><select id={`${id}-command`} disabled={locked} value={selectedId} onChange={(event) => { setSelectedId(event.target.value); clear(); }}><option value="">เลือกคำสั่ง</option>{commands.map((command) => <option key={command.recipeId} value={command.recipeId}>{command.title}{command.ownerOnly ? ' · คำสั่งส่งมอบ' : ''}</option>)}</select>
      <label htmlFor={`${id}-priority`}>ความสำคัญของคำสั่ง</label><select id={`${id}-priority`} disabled={locked} value={priority} onChange={(event) => { setPriority(event.target.value); clear(); }}>{['ต่ำ', 'ปกติ', 'สูง', 'เร่งด่วน'].map((label, index) => <option key={index} value={String(index)}>{label}</option>)}</select>
      <div className="gotzji-actions"><button disabled={locked || !selected || admittedJobId !== null} onClick={() => void act(async () => {
        if (!selected) return;
        requestId.current ??= crypto.randomUUID();
        const value = await request('prepareOperation', { requestId: requestId.current, projectId, operation: 'command.run', commandId: selected.recipeId, priority: Number(priority) });
        if (!record(value) || typeof value.preparationId !== 'string') throw new Error('COMMAND_PREPARATION_INVALID');
        if (mounted.current) setPreparationId(value.preparationId);
      })}>ตรวจและเตรียมคำสั่ง</button></div>
      {preparationId && selected && <div className="gotzji-command-review"><h4>ตรวจคำสั่งก่อนเริ่ม</h4><p>{selected.title} · {projectName}</p><p>ความสำคัญ: {['ต่ำ', 'ปกติ', 'สูง', 'เร่งด่วน'][Number(priority)]}</p>
        <p>{selected.ownerOnly ? 'คำสั่งส่งมอบนี้อาจส่งผลงานออกไปตามที่อนุมัติไว้ เจ้าของเป็นผู้เริ่มจากแอปทุกครั้ง' : 'ใช้รายละเอียดและขอบเขตของคำสั่งที่เจ้าของตรวจไว้เดิม'}</p>
        <button className="gotzji-primary" disabled={locked || admittedJobId !== null} onClick={() => void act(async () => {
          const value = await request('submit', { preparationId });
          if (!record(value) || typeof value.jobId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.jobId)) throw new Error('COMMAND_ADMISSION_UNCONFIRMED');
          if (mounted.current) { setAdmittedJobId(value.jobId); onJob(value.jobId); }
        })}>{selected.ownerOnly ? 'เริ่มคำสั่งส่งมอบนี้' : 'เริ่มคำสั่งนี้'}</button>
        <p>หากยังยืนยันการรับงานไม่ได้ ให้ลองด้วยรายการเดิม หรือดูประวัติงานก่อนเปลี่ยนคำสั่ง</p>
        {admittedJobId && <><p role="status">ยืนยันรับงานนี้แล้ว</p><div className="gotzji-actions"><button disabled={locked} onClick={() => onJob(admittedJobId)}>ดูงานที่รับแล้ว</button><button disabled={locked} onClick={clear}>เตรียมคำสั่งรอบใหม่</button></div></>}
      </div>}
    </>}
    {error && <div role="alert"><p>ดำเนินการไม่สำเร็จ ลองอีกครั้งด้วยรายการเดิมหรือตรวจรายละเอียด</p><details><summary>รายละเอียดข้อผิดพลาด</summary><pre>{error}</pre></details></div>}
    <button disabled={locked} onClick={onSettings}>ตั้งค่าคำสั่งที่หน้าโครงการ</button>
  </section>;
}
