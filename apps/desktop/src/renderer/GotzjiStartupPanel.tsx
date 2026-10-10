import { useEffect, useState, type ReactElement } from 'react';
type Startup = { available: boolean; enabled: boolean; mode: 'inspect-and-resume'; reason?: string };
export function GotzjiStartupPanel(): ReactElement {
  const [status, setStatus] = useState<Startup | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { void window.gotzji.startupStatus().then(setStatus).catch(() => setError('อ่านการตั้งค่าเริ่มระบบไม่สำเร็จ')); }, []);
  return <section><h3>กลับมาทำงานหลังลงชื่อเข้าใช้ Windows</h3><p>เปิดระบบเดิมเพื่อตรวจงาน กระบวนการ และผลที่บันทึกไว้ก่อนทำต่อ</p>
    {status?.available ? <label><input type="checkbox" checked={status.enabled} onChange={(event) => { void window.gotzji.setStartup(event.target.checked).then(setStatus).catch(() => setError('ตั้งค่าเริ่มระบบไม่สำเร็จ')); }} />เปิดระบบ gotzji เมื่อคุณลงชื่อเข้าใช้ Windows</label> : <p>ตั้งค่าได้ใน gotzji รุ่นที่ติดตั้งบน Windows</p>}
    {error && <p role="alert">{error}</p>}</section>;
}
