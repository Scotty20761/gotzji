import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';

type Connection = { state: string; configured: boolean; tunnelId?: string; errorCode?: string };
const states: Record<string, string> = { 'not-configured': 'ยังไม่ได้ตั้งค่า', stopped: 'หยุดอยู่', connecting: 'กำลังเชื่อมต่อ', ready: 'เชื่อมต่อพร้อมใช้งาน', unavailable: 'ยังไม่พร้อม', 'reconciliation-required': 'ต้องตรวจการเชื่อมต่อเดิม' };
export function GotzjiConnectionPanel({ disabled }: { readonly disabled: boolean }): ReactElement {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [tunnelId, setTunnelId] = useState(''); const [runtimeKey, setRuntimeKey] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const request = useCallback(async (method: GotzjiMethod, input: Record<string, unknown> = {}): Promise<void> => {
    const result = await window.gotzji.request({ method, input });
    if (result === null || typeof result !== 'object' || !('state' in result)) throw new Error('CONNECTION_RESPONSE_INVALID');
    setConnection(result as Connection);
  }, []);
  useEffect(() => { void request('connectionStatus').catch(() => undefined); const timer = setInterval(() => void request('connectionStatus').catch(() => undefined), 5000); return (): void => clearInterval(timer); }, [request]);
  useEffect(() => { void window.gotzji.connectionSetupDefaults().then((defaults) => { if (defaults.tunnelId) setTunnelId(defaults.tunnelId); if (defaults.organizationId) setOrganizationId(defaults.organizationId); }).catch(() => undefined); }, []);
  async function act(method: GotzjiMethod): Promise<void> {
    setBusy(true); setError(null);
    try { await request(method, method === 'configureConnection' ? { tunnelId: tunnelId.trim(), runtimeKey, ...(organizationId.trim() ? { organizationId: organizationId.trim() } : {}) } : {}); }
    catch (value) { setError(value instanceof Error ? value.message : 'เชื่อมต่อไม่สำเร็จ'); }
    finally { if (method === 'configureConnection') setRuntimeKey(''); setBusy(false); }
  }
  return <section><h3>เชื่อมต่อ ChatGPT</h3><p>{states[connection?.state ?? 'unavailable'] ?? 'กำลังตรวจ'} · OpenAI Secure MCP Tunnel</p>
    {connection?.tunnelId && <p>{connection.tunnelId}</p>}{(error ?? connection?.errorCode) && <p role="alert">{error ?? connection?.errorCode}</p>}
    <p>สร้างการเชื่อมต่อสำหรับ gotzji ในหน้า OpenAI Tunnels แล้วเพิ่มใน ChatGPT ด้วยบัญชีของคุณ</p>
    <div className="gotzji-actions"><button onClick={() => void window.gotzji.openConnectionSetup('tunnels')}>เปิดหน้า OpenAI Tunnels</button><button onClick={() => void window.gotzji.openConnectionSetup('keys')}>เปิดหน้า Runtime API keys</button><button onClick={() => void window.gotzji.openConnectionSetup('connectors')}>เปิดการเชื่อมต่อใน ChatGPT</button></div>
    <details open={!connection?.configured}><summary>ตั้งค่าการเชื่อมต่อของ gotzji</summary><label>รหัส Tunnel<input autoComplete="off" disabled={busy || disabled} value={tunnelId} onChange={(event) => setTunnelId(event.target.value)} placeholder="tunnel_…" /></label>
      <label>Organization ID (เว้นว่างได้)<input autoComplete="off" disabled={busy || disabled} value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="org-…" /></label>
      <label>Runtime API key<input type="password" autoComplete="off" disabled={busy || disabled} value={runtimeKey} onChange={(event) => setRuntimeKey(event.target.value)} /></label>
      <p>ใช้รหัสสำหรับ gotzji โดยให้สิทธิ์ Tunnels Read และ Use</p>
      <p>กรอกในแอปนี้เท่านั้น ข้อมูลถูกป้องกันด้วยบัญชี Windows ของคุณ</p><button disabled={busy || disabled || !tunnelId || !runtimeKey} onClick={() => void act('configureConnection')}>บันทึกการเชื่อมต่อ</button></details>
    <div className="gotzji-actions"><button disabled={busy || disabled || !connection?.configured} onClick={() => void act('startConnection')}>เชื่อมต่อ</button>
      <button disabled={busy || !connection?.configured} onClick={() => void act('stopConnection')}>หยุดการเชื่อมต่อ</button><button disabled={busy} onClick={() => void act('connectionStatus')}>ตรวจสถานะ</button></div>
  </section>;
}
