import { useEffect, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';

interface Context {
  readonly memory: { readonly summary: string; readonly decisions: readonly string[]; readonly openQuestions: readonly string[]; readonly resultPaths: readonly string[] };
}
export function GotzjiProjectContext({ projectId, request }: {
  readonly projectId: string;
  readonly request: (method: GotzjiMethod, input: Record<string, unknown>) => Promise<unknown>;
}): ReactElement {
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    setContext(null); setError(false);
    void request('projectContext', { projectId }).then((value) => { if (!disposed) setContext(value as Context); })
      .catch(() => { if (!disposed) setError(true); });
    return (): void => { disposed = true; };
  }, [projectId, request, refresh]);
  return <section aria-label="บริบทโครงการ"><h3>ทำงานต่อกับ ChatGPT</h3>
    <p>เปิดแชตใหม่แล้วให้ ChatGPT อ่านบริบทโครงการที่เลือก ระบบจะส่งกติกาปัจจุบัน สรุปล่าสุด และประวัติงานของโครงการนี้ให้</p>
    <button onClick={() => setRefresh((value) => value + 1)}>อ่านบริบทล่าสุด</button>
    {error ? <p role="alert">ยังอ่านบริบทไม่ได้ กรุณารีเฟรชก่อนทำต่อ</p> : context === null ? <p>กำลังอ่านบริบท…</p> : <>
      <h4>สรุปล่าสุด</h4><p>{context.memory.summary || 'ยังไม่มีสรุปที่บันทึกไว้ เริ่มคุยใน ChatGPT เพื่อบันทึกบริบทของโครงการนี้'}</p>
      {context.memory.decisions.length > 0 && <><h4>ข้อที่ตกลงไว้</h4><ul>{context.memory.decisions.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
      {context.memory.openQuestions.length > 0 && <><h4>เรื่องที่ยังค้าง</h4><ul>{context.memory.openQuestions.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
      {context.memory.resultPaths.length > 0 && <><h4>ที่อยู่ผลงานที่บันทึกไว้</h4><ul>{context.memory.resultPaths.map((item, i) => <li key={i}>{item}</li>)}</ul><p>ตรวจไฟล์จริงก่อนใช้ สรุปบทสนทนาไม่ใช่หลักฐานว่างานเสร็จแล้ว</p></>}
    </>}
  </section>;
}
