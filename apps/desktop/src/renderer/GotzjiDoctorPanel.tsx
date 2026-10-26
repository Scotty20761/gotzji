import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';
import { operationLabel, statusLabel } from './gotzji-job-status.js';

interface DiagnosticJob { readonly jobId: string; readonly status: string; readonly operation?: string; readonly blockerCode?: string; readonly summary?: string }
interface DiagnosticHolder { readonly jobId: string; readonly kind: string; readonly resource: string }
export interface DoctorReport { readonly generatedAt: string; readonly jobs: readonly DiagnosticJob[]; readonly holders: readonly DiagnosticHolder[] }
const statuses = ['queued', 'running', 'verifying', 'blocked', 'completed', 'cancelled', 'failed'];
const tabs = { overview: 'ภาพรวม', calls: 'การเรียกเครื่องมือ', results: 'ผลงาน', resources: 'ทรัพยากร' };
type Tab = keyof typeof tabs;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function jobId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }

/** Read only the existing app-only support report; never admit work or infer result validity. */
export function doctorReport(value: unknown): DoctorReport | undefined {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))
    || !Array.isArray(value.jobs) || value.jobs.length > 200 || !Array.isArray(value.holders)) return undefined;
  const jobs: DiagnosticJob[] = [];
  for (const item of value.jobs) {
    if (!record(item) || !jobId(item.jobId) || typeof item.status !== 'string' || !statuses.includes(item.status)
      || ['operation', 'blockerCode', 'summary'].some(key => item[key] !== undefined && typeof item[key] !== 'string')) return undefined;
    jobs.push({ jobId: item.jobId, status: item.status, ...(typeof item.operation === 'string' ? { operation: item.operation } : {}),
      ...(typeof item.blockerCode === 'string' ? { blockerCode: item.blockerCode } : {}), ...(typeof item.summary === 'string' ? { summary: item.summary } : {}) });
  }
  const holders: DiagnosticHolder[] = [];
  for (const item of value.holders) {
    if (!record(item) || !jobId(item.jobId) || !['writer', 'claim'].includes(String(item.kind)) || typeof item.resource !== 'string') return undefined;
    holders.push({ jobId: item.jobId, kind: String(item.kind), resource: item.resource });
  }
  return { generatedAt: value.generatedAt, jobs, holders };
}

const reasons: Readonly<Record<string, string>> = {
  RESOURCE_HELD: 'รออีกงานปล่อยทรัพยากร เปิดงานที่เกี่ยวข้องเพื่อตรวจสถานะ',
  PROJECT_POLICY_CHANGED: 'กติกาโครงการเปลี่ยน ต้องตรวจรายละเอียดงานใหม่ใน ChatGPT',
  COMMAND_DEPENDENCIES_CHANGED: 'ไฟล์ที่คำสั่งใช้เปลี่ยน ต้องตรวจและเตรียมคำขอใหม่ใน ChatGPT',
  NATIVE_SESSION_IN_USE: 'โปรแกรมมีงานเปิดอยู่ ตรวจงานเดิมก่อนเริ่มงานใหม่',
  NATIVE_SESSION_IDENTITY_UNVERIFIED: 'ยังยืนยันโปรแกรมที่งานนี้ใช้ไม่ได้ ตรวจผลก่อนเลือกทำต่อ',
  NATIVE_TERMINATION_UNVERIFIED: 'ยังยืนยันว่าโปรแกรมหยุดแล้วไม่ได้ ตรวจงานและโปรแกรมที่เกี่ยวข้อง',
};

export function GotzjiDoctorPanel({ request, disabled, onJob }: {
  readonly request: (method: GotzjiMethod, input: Record<string, unknown>) => Promise<unknown>;
  readonly disabled: boolean; readonly onJob: (jobId: string) => void;
}): ReactElement {
  const id = useId(); const generation = useRef(0);
  const [tab, setTab] = useState<Tab>('overview');
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    if (disabled) return;
    const current = ++generation.current; setLoading(true); setError(false); setReport(null);
    try {
      const value = doctorReport(await request('supportReport', {}));
      if (!value) throw new Error('SUPPORT_REPORT_INVALID');
      if (current === generation.current) setReport(value);
    } catch { if (current === generation.current) setError(true); }
    finally { if (current === generation.current) setLoading(false); }
  }, [request, disabled]);
  useEffect(() => { void load(); return (): void => { generation.current += 1; }; }, [load]);
  const open = (job: DiagnosticJob): ReactElement => <button aria-label={`เปิดงาน ${job.jobId}`} disabled={disabled} onClick={() => onJob(job.jobId)}>เปิดงาน {job.jobId.slice(0, 12)}</button>;
  const list = (jobs: readonly DiagnosticJob[]): ReactElement => <ul className="gotzji-diagnostic-jobs">{jobs.map(job => <li key={job.jobId}><strong>{operationLabel(job.operation)}</strong><p>{statusLabel(job.status)}</p>
    {['failed', 'blocked'].includes(job.status) && <p>{reasons[job.blockerCode ?? job.summary ?? ''] ?? 'เปิดงานเพื่อตรวจเหตุผล บันทึก และผลก่อนเลือกทำต่อ'}</p>}{open(job)}
    {(job.blockerCode || job.summary) && <details><summary>รายละเอียดจากระบบ</summary><p>{job.blockerCode ?? job.summary}</p></details>}
  </li>)}</ul>;
  const issues = report?.jobs.filter(job => job.status === 'failed' || job.status === 'blocked') ?? [];
  const completed = report?.jobs.filter(job => job.status === 'completed') ?? [];
  return <section aria-label="ข้อมูลตรวจระบบ" className="gotzji-doctor-panel">
    <div className="gotzji-section-heading"><div><h3>ข้อมูลตรวจระบบ</h3><p>อ่านสถานะและเปิดงานที่เกี่ยวข้องเพื่อตรวจต่อ</p></div><button disabled={disabled || loading} onClick={() => void load()}>อ่านข้อมูลตรวจระบบล่าสุด</button></div>
    <div role="tablist" aria-label="มุมมองตรวจระบบ" className="gotzji-tabs" onKeyDown={event => {
      const keys = Object.keys(tabs) as Tab[]; const index = keys.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : event.key === 'ArrowRight' ? (index + 1) % keys.length : event.key === 'ArrowLeft' ? (index + keys.length - 1) % keys.length : undefined;
      if (next === undefined) return; event.preventDefault(); const selected = keys[next]!; setTab(selected); document.getElementById(`${id}-${selected}`)?.focus();
    }}>{(Object.entries(tabs) as [Tab, string][]).map(([key, label]) => <button key={key} id={`${id}-${key}`} role="tab" tabIndex={tab === key ? 0 : -1} aria-selected={tab === key} aria-controls={`${id}-panel`} onClick={() => setTab(key)}>{label}</button>)}</div>
    {disabled ? <p role="status">รอระบบในเครื่องพร้อมก่อนอ่านข้อมูล</p> : loading ? <p role="status">กำลังอ่านข้อมูลตรวจระบบ…</p> : error ? <p role="alert">ยังอ่านข้อมูลตรวจระบบไม่ได้ ตรวจการเชื่อมต่อแล้วอ่านใหม่</p> : report && <><p role="status">อ่านข้อมูลล่าสุดแล้ว</p><p>ข้อมูล ณ {new Date(report.generatedAt).toLocaleString('th-TH')} · แสดงงานล่าสุดไม่เกิน 200 งาน</p></>}
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} tabIndex={0}>
      {!disabled && report && (tab === 'overview' ? <><h4>เรื่องที่ต้องตรวจ</h4>{issues.length ? list(issues) : <p>ไม่พบงานที่ล้มหรือรอแก้ไขในข้อมูลที่อ่านได้</p>}<p>สถานะการเชื่อมต่อและรายงานนี้ยังไม่ยืนยันว่าเครื่องมือทุกชนิดผ่านการใช้งานจริง</p></>
        : tab === 'calls' ? <><h4>กิจกรรมตามงาน</h4><p>แสดงเครื่องมือและสถานะของแต่ละงาน ประวัตินี้ไม่ครอบคลุมการอ่านโดยตรงทุกครั้ง</p>{report.jobs.length ? list(report.jobs) : <p>ยังไม่มีงานในข้อมูลที่อ่านได้</p>}</>
          : tab === 'results' ? <><h4>งานที่เสร็จแล้ว</h4><p>เปิดงานแล้วเลือกดูผลลัพธ์ ระบบจะตรวจหลักฐานที่ยังเก็บไว้ก่อนแสดงผล</p>{completed.length ? list(completed) : <p>ยังไม่มีงานที่เสร็จในข้อมูลที่อ่านได้</p>}</>
            : <><h4>งานที่ถือทรัพยากร</h4>{report.holders.length ? <ul>{report.holders.map((holder, index) => <li key={`${holder.jobId}:${holder.resource}:${index}`}><p>{holder.kind === 'writer' ? 'งานนี้ถือสิทธิ์เขียนโครงการ' : 'งานนี้กำลังใช้ทรัพยากรร่วม'}</p><button disabled={disabled} aria-label={`เปิดงาน ${holder.jobId}`} onClick={() => onJob(holder.jobId)}>เปิดงาน {holder.jobId.slice(0, 12)}</button><details><summary>รหัสทรัพยากรจากระบบ</summary><p>{holder.resource}</p></details></li>)}</ul> : <p>ไม่มีงานถือทรัพยากรในข้อมูลที่อ่านได้</p>}</>)}
    </div>
  </section>;
}
