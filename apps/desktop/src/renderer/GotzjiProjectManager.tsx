import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';

export interface ManagedProject {
  readonly projectId: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly archivedAt: string | null;
}
interface Props {
  readonly projects: readonly ManagedProject[] | null;
  readonly selectedProjectId: string;
  readonly disabled: boolean;
  readonly request: (method: GotzjiMethod, input: Record<string, unknown>) => Promise<unknown>;
  readonly select: (projectId: string) => void;
  readonly changed: () => Promise<void>;
}

function failure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : '';
  if (message.includes('PROJECT_BUSY')) return 'โครงการนี้ยังมีงานค้างอยู่ เปิดประวัติงานเพื่อตรวจหรือยกเลิกงานก่อนเก็บโครงการค่ะ';
  if (message.includes('PROJECT_ARCHIVED')) return 'โครงการนี้ถูกเก็บไว้แล้ว รีเฟรชรายการหรือนำกลับมาใช้ก่อนค่ะ';
  return 'เปลี่ยนสถานะโครงการไม่ได้ ลองอีกครั้งค่ะ';
}

/** Project configuration shares the parent's canonical refresh and never starts work. */
export function GotzjiProjectManager({ projects, selectedProjectId, disabled, request, select, changed }: Props): ReactElement {
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const section = useRef<HTMLElement>(null);
  useEffect(() => { mounted.current = true; return (): void => { mounted.current = false; }; }, []);

  const archive = async (project: ManagedProject, archived: boolean): Promise<void> => {
    if (pending.current || disabled) return;
    pending.current = true; setChanging(true); setError(null); setNotice(null);
    try {
      await request('setProjectArchived', { projectId: project.projectId, archived });
      await changed();
      if (mounted.current) {
        setNotice(archived ? 'เก็บโครงการแล้ว ไฟล์และประวัติเดิมยังอยู่ค่ะ' : 'นำโครงการกลับมาแล้ว เลือกโครงการเมื่อต้องการทำต่อค่ะ');
        section.current?.focus();
      }
    } catch (cause) { if (mounted.current) setError(failure(cause)); }
    finally { pending.current = false; if (mounted.current) setChanging(false); }
  };
  const active = projects?.filter((project) => project.archivedAt === null) ?? [];
  const archived = projects?.filter((project) => project.archivedAt !== null) ?? [];
  return <section ref={section} tabIndex={-1} aria-busy={changing} aria-label="จัดการโครงการ"><h3>โครงการที่ลงทะเบียน</h3>
    {notice !== null && <p role="status">{notice}</p>}
    {error !== null && <div role="alert">{error}<button disabled={changing} onClick={() => setError(null)}>ปิด</button></div>}
    {projects === null ? <p role="status">กำลังอ่านรายชื่อโครงการ</p> : active.length === 0 ? <p>ยังไม่มีโครงการที่ใช้งานอยู่</p> : active.map((project) => <div key={project.projectId}>
      <button disabled={disabled || changing} aria-current={selectedProjectId === project.projectId ? 'true' : undefined} onClick={() => select(project.projectId)}>{project.displayName} · {project.rootPath}</button>
      <button disabled={disabled || changing} aria-label={`เก็บโครงการ ${project.displayName}`} onClick={() => { void archive(project, true); }}>เก็บโครงการ</button>
    </div>)}
    {archived.length > 0 && <><h4>โครงการที่เก็บไว้</h4><p>ไฟล์และประวัติเดิมยังอยู่ นำกลับมาใช้ได้เมื่อพร้อมค่ะ</p>{archived.map((project) => <div key={project.projectId}>
      <p>{project.displayName} · {project.rootPath}</p><button disabled={disabled || changing} aria-label={`นำโครงการ ${project.displayName} กลับมาใช้`} onClick={() => { void archive(project, false); }}>นำกลับมาใช้</button>
    </div>)}</>}
  </section>;
}
