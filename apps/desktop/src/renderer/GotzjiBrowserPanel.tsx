import { useEffect, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';
import { browserSessionView } from './gotzji-browser-session.js';
export function GotzjiBrowserPanel({ projectId, disabled, onChanged }: { readonly projectId: string; readonly disabled: boolean; readonly onChanged: () => Promise<void> }): ReactElement {
  const [startUrl, setStartUrl] = useState('https://example.org/'); const [origins, setOrigins] = useState('');
  const [session, setSession] = useState<Record<string, unknown> | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const view = browserSessionView(session);
  function readSession(): void { void window.gotzji.request({ method: 'browserSession', input: { projectId } }).then((value) => { if (value && typeof value === 'object') setSession(value as Record<string, unknown>); }).catch(() => undefined); }
  useEffect(() => { setSession(null); if (projectId) readSession(); }, [projectId]);
  async function act(method: GotzjiMethod): Promise<void> {
    setBusy(true); setError(null);
    try {
      const value = await window.gotzji.request({ method, input: { projectId, ...(method === 'startBrowserSession' ? { startUrl, ...(origins.trim() ? { allowedOrigins: origins.split(',').map((entry) => entry.trim()).filter(Boolean) } : {}) } : {}) } });
      if (value && typeof value === 'object') setSession(value as Record<string, unknown>); await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : 'จัดการเบราว์เซอร์ไม่สำเร็จ');
      // A failed stop may leave the session stopping; show that instead of the stale ready view.
      if (method === 'stopBrowserSession') readSession();
    }
    finally { setBusy(false); }
  }
  return <section><h3>เบราว์เซอร์ของโครงการ</h3><p>เปิดหน้าต่างของโครงการนี้เพื่อให้ Grace ทำงานกับหน้าที่คุณเลือก หากต้องลงชื่อเข้าใช้ ให้คุณกรอกในหน้าต่างนั้นเอง</p>
    <label>หน้าเริ่มต้น<input value={startUrl} disabled={busy || disabled} onChange={(event) => setStartUrl(event.target.value)} /></label>
    <label>เว็บไซต์เพิ่มเติมที่อนุญาต (เว้นว่างได้)<input value={origins} disabled={busy || disabled} onChange={(event) => setOrigins(event.target.value)} placeholder="https://example.org, https://another.example" /></label>
    {session && <p>{view.label} {String(session.expectedUrl ?? '')}</p>}
    {error && <p role="alert">{error}</p>}<div className="gotzji-actions"><button disabled={busy || disabled || !projectId} onClick={() => void act('startBrowserSession')}>เปิดเบราว์เซอร์โครงการ</button>
      <button disabled={busy || !projectId} onClick={() => void act('browserSession')}>ตรวจหน้าปัจจุบัน</button><button disabled={busy || !projectId || !view.canStop} onClick={() => void act('stopBrowserSession')}>ปิดเบราว์เซอร์โครงการ</button></div>
  </section>;
}
