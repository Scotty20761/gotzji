import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';
import { browserPanelMessage, browserReadBinding, browserSessionProjection, browserSessionView } from './gotzji-browser-session.js';
type Request = (method: GotzjiMethod, input: Record<string, unknown>) => Promise<unknown>;
const defaultRequest: Request = (method, input) => window.gotzji.request({ method, input });
interface Props {
  readonly projectId: string; readonly projectName?: string; readonly disabled: boolean; readonly visible?: boolean;
  readonly onChanged: () => Promise<void>; readonly onJob: (jobId: string) => void; readonly request?: Request;
  readonly chatgptOnly?: boolean;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function GotzjiBrowserPanel({ projectId, projectName = projectId, disabled, visible = true, onChanged, onJob, request = defaultRequest, chatgptOnly = false }: Props): ReactElement {
  const [startUrl, setStartUrl] = useState(''); const [origins, setOrigins] = useState('');
  const [session, setSession] = useState<Record<string, unknown> | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [preparation, setPreparation] = useState<string | null>(null); const [jobId, setJobId] = useState<string | null>(null);
  const requestId = useRef<string | undefined>(undefined); const inFlight = useRef(false); const mounted = useRef(false); const sequence = useRef(0);
  const binding = browserReadBinding(session, projectId); const bindingKey = JSON.stringify(binding); const view = browserSessionView(session);
  const locked = busy || disabled;
  function receive(value: unknown): void {
    setSession(browserSessionProjection(value, projectId));
  }
  useEffect(() => { mounted.current = true; return (): void => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    const turn = ++sequence.current;
    if (projectId) void request('browserSession', { projectId }).then((value) => {
      if (mounted.current && sequence.current === turn) receive(value);
    }).catch((cause: unknown) => { if (mounted.current && sequence.current === turn) { setSession(null); setError(browserPanelMessage(cause)); } });
    return (): void => { sequence.current++; };
  }, [projectId, request]);
  useEffect(() => { requestId.current = undefined; setPreparation(null); setJobId(null); }, [bindingKey]);
  async function act(method: 'startBrowserSession' | 'browserSession' | 'stopBrowserSession'): Promise<void> {
    if (inFlight.current || disabled || !projectId) return;
    inFlight.current = true; const turn = ++sequence.current; setBusy(true); setError(null);
    try {
      const value = await request(method, { projectId, ...(method === 'startBrowserSession' ? { startUrl, ...(origins.trim() ? { allowedOrigins: origins.split(',').map((entry) => entry.trim()).filter(Boolean) } : {}) } : {}) });
      if (mounted.current && sequence.current === turn) receive(value);
      await onChanged();
    } catch (cause) {
      if (mounted.current && sequence.current === turn) {
        setError(browserPanelMessage(cause));
        if (method === 'stopBrowserSession') {
          setSession((prior) => prior ? { ...prior, state: 'stopping' } : prior);
          try { const current = await request('browserSession', { projectId }); if (mounted.current && sequence.current === turn) receive(current); } catch { /* Keep the explicit unconfirmed-close projection. */ }
        }
      }
    } finally { inFlight.current = false; if (mounted.current && sequence.current === turn) setBusy(false); }
  }
  async function prepareRead(): Promise<void> {
    if (inFlight.current || disabled || !binding || preparation || jobId) return;
    inFlight.current = true; const turn = ++sequence.current; setBusy(true); setError(null);
    const stableId = requestId.current ?? crypto.randomUUID(); requestId.current = stableId;
    try {
      if (chatgptOnly) {
        await navigator.clipboard.writeText(`อ่านบริบทโครงการ ${projectId} แล้วตรวจหน้าเบราว์เซอร์ปัจจุบันและอ่านเนื้อหาผ่าน gotzji ตรวจรหัสแท็บและที่อยู่จริงก่อนเริ่ม: ${binding.expectedUrl}`);
        return;
      }
      const value = await request('prepareOperation', { requestId: stableId, ...binding, operation: 'browser.read', selector: 'body', priority: 1 });
      if (!record(value) || typeof value.preparationId !== 'string' || !value.preparationId) throw new Error('BROWSER_PREPARATION_INVALID');
      if (mounted.current && sequence.current === turn) setPreparation(value.preparationId);
    } catch (cause) { if (mounted.current && sequence.current === turn) setError(browserPanelMessage(cause)); }
    finally { inFlight.current = false; if (mounted.current && sequence.current === turn) setBusy(false); }
  }
  async function submitRead(): Promise<void> {
    if (inFlight.current || disabled || !preparation || jobId) return;
    inFlight.current = true; const turn = ++sequence.current; setBusy(true); setError(null);
    try {
      const value = await request('submit', { preparationId: preparation });
      if (!record(value) || typeof value.jobId !== 'string' || !value.jobId) throw new Error('BROWSER_ADMISSION_INVALID');
      if (mounted.current && sequence.current === turn) { setJobId(value.jobId); onJob(value.jobId); }
    } catch (cause) { if (mounted.current && sequence.current === turn) setError(`${browserPanelMessage(cause)} ยืนยันงานเดิมอีกครั้งได้โดยไม่เตรียมงานใหม่`); }
    finally { inFlight.current = false; if (mounted.current && sequence.current === turn) setBusy(false); }
  }
  function newRound(): void { requestId.current = undefined; setPreparation(null); setJobId(null); setError(null); }
  return <section className="gotzji-browser-panel" hidden={!visible} aria-busy={busy}><h3>เบราว์เซอร์ของโครงการ</h3><p>เปิดหน้าต่างของโครงการนี้เพื่อให้ ChatGPT เรียกเครื่องมือกับหน้าที่คุณเลือก หากต้องลงชื่อเข้าใช้ ให้คุณกรอกในหน้าต่างนั้นเอง</p>
    <label>หน้าเริ่มต้น<input value={startUrl} placeholder="https://เว็บไซต์ที่ต้องการ" disabled={locked} onChange={(event) => setStartUrl(event.target.value)} /></label>
    <label>เว็บไซต์เพิ่มเติมที่อนุญาต (เว้นว่างได้)<input value={origins} disabled={locked} onChange={(event) => setOrigins(event.target.value)} placeholder="https://example.org, https://another.example" /></label>
    {session && <p role="status">{view.label} {binding?.expectedUrl ?? ''}</p>}
    {error && <p role="alert">{error}</p>}<div className="gotzji-actions"><button disabled={locked || !projectId || !startUrl.trim()} onClick={() => void act('startBrowserSession')}>เปิดเบราว์เซอร์โครงการ</button>
      <button disabled={locked || !projectId} onClick={() => void act('browserSession')}>ตรวจหน้าปัจจุบัน</button><button disabled={locked || !projectId || !view.canStop} onClick={() => void act('stopBrowserSession')}>ปิดเบราว์เซอร์โครงการ</button></div>
    {binding && <div className="gotzji-browser-read"><h4>อ่านหน้าปัจจุบัน</h4><p>อ่านเนื้อหาทั้งหน้าของ {projectName} และเก็บผลไว้ในประวัติงาน</p>
      {!preparation && !jobId && <button disabled={locked} onClick={() => void prepareRead()}>{chatgptOnly ? 'คัดลอกงานอ่านหน้าเว็บสำหรับ ChatGPT' : 'ตรวจหน้าที่จะอ่าน'}</button>}
      {preparation && <div><h4>ตรวจหน้าเว็บก่อนเริ่ม</h4><p>โครงการ: {projectName}</p><p>หน้าเว็บ: {binding.expectedUrl}</p><p>อ่านเนื้อหาทั้งหน้า โดยไม่กรอกข้อความหรือคลิกปุ่มบนเว็บ</p>
        {!jobId ? <button disabled={locked} onClick={() => void submitRead()}>{error ? 'ยืนยันงานอ่านเดิมอีกครั้ง' : 'เริ่มอ่านหน้านี้'}</button> : <><p role="status">ยืนยันรับงานอ่านนี้แล้ว</p><button disabled={locked} onClick={() => onJob(jobId)}>ดูงานอ่านนี้</button><button disabled={locked} onClick={newRound}>เตรียมอ่านรอบใหม่</button></>}
      </div>}
    </div>}
  </section>;
}
