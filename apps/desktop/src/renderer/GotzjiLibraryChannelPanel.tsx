import { useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';
export function GotzjiLibraryChannelPanel({ projectId, disabled }: { readonly projectId: string; readonly disabled: boolean }): ReactElement {
  const [tunnelId, setTunnelId] = useState(''); const [organizationId, setOrganizationId] = useState(''); const [runtimeKey, setRuntimeKey] = useState('');
  const [status, setStatus] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function act(method: GotzjiMethod): Promise<void> {
    setBusy(true); setError(null);
    try { setStatus(await window.gotzji.request({ method, input: method === 'enrollLibraryChannel' ? { projectId } : method === 'configureLibraryConnection' ? { tunnelId: tunnelId.trim(), runtimeKey, ...(organizationId.trim() ? { organizationId: organizationId.trim() } : {}) } : {} })); }
    catch (value) { setError(value instanceof Error ? value.message : 'จัดการช่องทาง Library ไม่สำเร็จ'); }
    finally { if (method === 'configureLibraryConnection') setRuntimeKey(''); setBusy(false); }
  }
  return <section><h3>ช่องทาง Library สำหรับ lnwjud</h3><p>เชื่อมโครงการนี้เข้าประวัติงานชุดเดียวกับ gotzji โดยใช้การเชื่อมต่อ Library ของตัวเอง</p>
    <button disabled={busy || disabled || !projectId} onClick={() => void act('enrollLibraryChannel')}>เชื่อมโครงการ Library นี้</button>
    <details><summary>ตั้งค่าการเชื่อมต่อ Library แยก</summary><p>สร้าง Tunnel และ Runtime API key สำหรับช่องทางนี้ แล้วกรอกในแอปด้วยบัญชีของคุณ</p>
      <label>รหัส Tunnel<input value={tunnelId} disabled={busy || disabled} autoComplete="off" onChange={(event) => setTunnelId(event.target.value)} /></label>
      <label>Organization ID (เว้นว่างได้)<input value={organizationId} disabled={busy || disabled} autoComplete="off" onChange={(event) => setOrganizationId(event.target.value)} /></label>
      <label>Runtime API key ของช่องทาง Library<input type="password" value={runtimeKey} disabled={busy || disabled} autoComplete="off" onChange={(event) => setRuntimeKey(event.target.value)} /></label>
      <button disabled={busy || disabled || !tunnelId || !runtimeKey} onClick={() => void act('configureLibraryConnection')}>บันทึกการเชื่อมต่อ Library</button></details>
    <div className="gotzji-actions"><button disabled={busy || disabled} onClick={() => void act('startLibraryConnection')}>เริ่มเชื่อมต่อ Library</button><button disabled={busy} onClick={() => void act('stopLibraryConnection')}>หยุดการเชื่อมต่อ Library</button><button disabled={busy} onClick={() => void act('libraryChannelStatus')}>ตรวจช่องทาง Library</button></div>
    {error && <p role="alert">{error}</p>}{status !== null && <details><summary>สถานะช่องทาง Library</summary><pre>{JSON.stringify(status, null, 2)}</pre></details>}
  </section>;
}
