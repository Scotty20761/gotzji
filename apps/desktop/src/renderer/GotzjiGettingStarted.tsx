import { useState, type ReactElement } from 'react';

interface Props {
  readonly hostState: 'ready' | 'control-only' | 'unavailable' | null;
  readonly projectName: string | null;
  readonly projectKnown: boolean;
  readonly connectionState: string | null;
  readonly openProjects: () => void;
  readonly openSettings: () => void;
  readonly openDoctor: () => void;
}

/** Live local prerequisites; only an actual caller can establish ChatGPT acceptance. */
export function GotzjiGettingStarted({ hostState, projectName, projectKnown, connectionState, openProjects, openSettings, openDoctor }: Props): ReactElement {
  const [notice, setNotice] = useState<string | null>(null);
  const ready = hostState === 'ready' && projectKnown && projectName !== null && connectionState === 'ready';
  async function copyTrial(): Promise<void> {
    try {
      await navigator.clipboard.writeText('เรียก gotzji_health แล้วบอกเฉพาะว่าระบบพร้อมหรือไม่ โดยไม่เริ่มงานใหม่');
      setNotice('คัดลอกแล้ว วางใน ChatGPT เพื่อทดลองด้วยตัวเอง');
    } catch { setNotice('คัดลอกไม่สำเร็จ ลองอีกครั้ง'); }
  }
  return <section aria-label="เริ่มใช้งาน gotzji"><h3>เริ่มใช้งาน</h3>
    <ol>
      <li>{hostState === 'ready' ? 'ระบบในเครื่องพร้อม' : 'ระบบในเครื่องยังไม่พร้อม'} <button onClick={openDoctor}>ตรวจระบบ</button></li>
      <li>{!projectKnown ? 'ยังอ่านสถานะโครงการไม่ได้' : projectName === null ? 'ยังไม่พบโครงการที่เลือก' : `โครงการที่เลือก: ${projectName}`} <button onClick={openProjects}>เลือกโครงการ</button></li>
      <li>{connectionState === 'ready' ? 'เชื่อมต่อในเครื่องพร้อม' : connectionState === null ? 'ยังไม่ทราบสถานะการเชื่อมต่อ' : 'การเชื่อมต่อในเครื่องยังไม่พร้อม'} <button onClick={openSettings}>ตั้งค่าการเชื่อมต่อ</button></li>
      <li>ยังไม่ได้ยืนยันการเรียกจาก ChatGPT · คัดลอกคำสั่งไปทดลองใน ChatGPT แล้วตรวจผลที่ได้รับ <button disabled={!ready} onClick={() => void copyTrial()}>คัดลอกคำสั่งทดสอบ</button></li>
    </ol>{notice && <p role="status">{notice}</p>}
  </section>;
}
