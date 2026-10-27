import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';

type Connection = { state: string; configured: boolean; tunnelId?: string; errorCode?: string };
const states: Record<string, string> = { 'not-configured': 'ยังไม่ได้ตั้งค่า', stopped: 'หยุดอยู่', connecting: 'กำลังเชื่อมต่อ', ready: 'เชื่อมต่อพร้อมใช้งาน', unavailable: 'ยังไม่พร้อม', 'reconciliation-required': 'ต้องตรวจการเชื่อมต่อเดิม' };
export function GotzjiConnectionPanel({ disabled, requestPort, visible = true, surfaceKey }: { readonly disabled: boolean; readonly requestPort?: (method: GotzjiMethod, input: Record<string, unknown>) => Promise<unknown>; readonly visible?: boolean; readonly surfaceKey?: string }): ReactElement {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [tunnelId, setTunnelId] = useState(''); const [runtimeKey, setRuntimeKey] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const generation = useRef(0); const actionInFlight = useRef(false);
  const visibleRef = useRef(visible); const pollEpoch = useRef(0); const pollNow = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    const changed = visibleRef.current !== visible;
    visibleRef.current = visible; setRuntimeKey('');
    if (changed) { pollEpoch.current++; setConnection(null); setPollError(null); }
    if (visible) pollNow.current();
  }, [visible, surfaceKey]);
  const currentError = pollError ?? connection?.errorCode;
  const request = useCallback(async (method: GotzjiMethod, input: Record<string, unknown> = {}): Promise<Connection> => {
    const result = await (requestPort ? requestPort(method, input) : window.gotzji.request({ method, input }));
    if (result === null || typeof result !== 'object' || !('state' in result) || typeof result.state !== 'string'
      || !('configured' in result) || typeof result.configured !== 'boolean'
      || ('tunnelId' in result && result.tunnelId !== undefined && typeof result.tunnelId !== 'string')
      || ('errorCode' in result && result.errorCode !== undefined && typeof result.errorCode !== 'string')) throw new Error('CONNECTION_RESPONSE_INVALID');
    return result as Connection;
  }, [requestPort]);
  useEffect(() => {
    let active = true; let polling = false;
    const update = (): void => {
      if (!visibleRef.current || actionInFlight.current || polling) return;
      polling = true;
      const selected = ++generation.current; const epoch = pollEpoch.current;
      void request('connectionStatus').then(value => {
        if (active && visibleRef.current && pollEpoch.current === epoch && generation.current === selected && !actionInFlight.current) { setConnection(value); setPollError(null); }
      }).catch(() => {
        if (active && visibleRef.current && pollEpoch.current === epoch && generation.current === selected && !actionInFlight.current) { setConnection(null); setPollError('ตรวจสถานะการเชื่อมต่อไม่สำเร็จ'); }
      }).finally((): void => { polling = false; if (active && visibleRef.current && pollEpoch.current !== epoch && !actionInFlight.current) update(); });
    };
    pollNow.current = update; update(); const timer = setInterval(update, 5000);
    return (): void => { active = false; generation.current++; pollNow.current = (): void => undefined; clearInterval(timer); };
  }, [request]);
  useEffect(() => { void window.gotzji.connectionSetupDefaults().then((defaults) => { if (defaults.tunnelId) setTunnelId(defaults.tunnelId); if (defaults.organizationId) setOrganizationId(defaults.organizationId); }).catch(() => undefined); }, []);
  async function act(method: GotzjiMethod): Promise<void> {
    if (actionInFlight.current) return;
    actionInFlight.current = true; const selected = ++generation.current; setBusy(true); setError(null); setPollError(null);
    try {
      const value = await request(method, method === 'configureConnection' ? { tunnelId: tunnelId.trim(), runtimeKey, ...(organizationId.trim() ? { organizationId: organizationId.trim() } : {}) } : {});
      if (generation.current === selected) setConnection(value);
    } catch (value) {
      if (generation.current === selected) { setConnection(null); setError(value instanceof Error ? value.message : 'เชื่อมต่อไม่สำเร็จ'); }
    } finally {
      actionInFlight.current = false;
      if (method === 'configureConnection') setRuntimeKey('');
      setBusy(false);
    }
  }
  const state = connection?.state ?? 'unavailable';
  return <section><h3>เชื่อมต่อ ChatGPT</h3><p>{Object.hasOwn(states, state) ? states[state] : 'กำลังตรวจ'} · OpenAI Secure MCP Tunnel</p>
    {connection?.tunnelId && <p>{connection.tunnelId}</p>}
    {currentError && <p role="alert">{connectionErrorMessage(currentError)}</p>}
    {error && <p role="alert">ผลคำสั่งก่อนหน้า: {connectionErrorMessage(error)}</p>}
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

function connectionErrorMessage(error: string): string {
  return error.includes('CONNECTION_RUNTIME_KEY_INVALID') ? 'กุญแจที่บันทึกไว้มีรูปแบบไม่ถูกต้อง กรุณากรอก Runtime API key ของ gotzji โดยตรงในแอป แล้วบันทึกใหม่' : error;
}
