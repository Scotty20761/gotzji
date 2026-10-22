import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';

interface DeliveryRequest {
  readonly preparationId: string;
  readonly digest: string;
  readonly decision: 'pending' | 'approved';
  readonly expiresAt: string;
  readonly project: { readonly projectId: string; readonly displayName: string; readonly rootPath: string };
  readonly request: { readonly requestId: string; readonly commandId: string };
  readonly command: { readonly executable: string; readonly executableHash: string; readonly args: readonly string[]; readonly dependencies: readonly { readonly path: string; readonly hash: string }[] };
  readonly projectPolicies: Readonly<Record<string, { readonly path: string; readonly hash: string }>>;
}
export function GotzjiDeliveryApprovals({ request, disabled }: {
  readonly request: (method: GotzjiMethod, input: Record<string, unknown>) => Promise<unknown>;
  readonly disabled: boolean;
}): ReactElement {
  const promptId = useId();
  const [items, setItems] = useState<readonly DeliveryRequest[] | null>(null);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [manualPrompt, setManualPrompt] = useState('');
  const mounted = useRef(true);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const load = useCallback(async (): Promise<void> => {
    const current = ++generation.current;
    const value = await request('listDeliveryApprovals', {}) as readonly DeliveryRequest[];
    if (mounted.current && current === generation.current) { setItems(value); setReviewed(new Set()); setError(false); }
  }, [request]);
  useEffect(() => {
    mounted.current = true;
    if (!disabled) void load().catch(() => { if (mounted.current) setError(true); });
    return (): void => { mounted.current = false; generation.current++; };
  }, [disabled, load]);
  const act = async (action: () => Promise<void>): Promise<void> => {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(false); setMessage('');
    try { await action(); } catch { if (mounted.current) setError(true); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const decide = (item: DeliveryRequest, decision: 'approved' | 'rejected'): void => {
    void act(async () => {
      await request('decideDeliveryApproval', { preparationId: item.preparationId, expectedDigest: item.digest, decision });
      await load();
      if (mounted.current) setMessage(decision === 'approved' ? 'อนุมัติคำขอนี้แล้ว ยังไม่ได้เริ่มงาน กลับไปให้ ChatGPT ส่งคำขอเดิม' : 'ไม่อนุมัติคำขอนี้ งานยังไม่ได้เริ่ม');
    });
  };
  return <section aria-label="อนุมัติคำขอส่งมอบ"><h3>คำขอส่งมอบที่รอคุณตรวจ</h3>
    <p>ChatGPT เตรียมคำขอไว้ให้คุณตรวจ การอนุมัติที่นี่ไม่เริ่มงาน ให้ ChatGPT ส่งคำขอเดิมหลังอนุมัติ ห้ามอนุมัติหากรายละเอียดไม่ตรงกับที่คุณต้องการ</p>
    <button disabled={disabled || busy} onClick={() => void act(load)}>อ่านคำขอส่งมอบล่าสุด</button>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">อ่านหรือบันทึกคำขอไม่สำเร็จ กรุณาอ่านรายการล่าสุดก่อนทำต่อ หากคำสั่งหรือกติกาเปลี่ยน ให้ ChatGPT เตรียมคำขอใหม่</p>}
    {disabled ? <p>ต้องเชื่อมต่อระบบในเครื่องก่อนตรวจคำขอ</p> : items === null ? <p>กำลังอ่านคำขอ…</p> : items.length === 0 ? <p>ไม่พบคำขอส่งมอบที่รอตรวจจากข้อมูลล่าสุด</p> : <ul>{items.map(item => <li key={item.preparationId}>
      <h4>{item.project.displayName} · {item.request.commandId}</h4>
      <p>โครงการ: {item.project.rootPath}</p><p>คำขอ: {item.request.requestId}</p><p>ใช้ได้ถึง: {new Date(item.expiresAt).toLocaleString('th-TH')}</p>
      <details><summary>ตรวจโปรแกรม คำสั่ง และไฟล์ที่ตรึงไว้</summary>
        <p>โปรแกรม: {item.command.executable}</p><pre>{item.command.args.join('\n')}</pre>
        <p>SHA-256 โปรแกรม: {item.command.executableHash}</p>
        <ul>{[...item.command.dependencies, ...Object.values(item.projectPolicies)].map((file, index) => <li key={index}>{file.path}<br />SHA-256: {file.hash}</li>)}</ul>
        <p>รหัสยืนยันรายละเอียด: {item.digest}</p>
      </details>
      {item.decision === 'pending' ? <>
        <label><input type="checkbox" disabled={busy} checked={reviewed.has(item.preparationId)} onChange={event => setReviewed(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.preparationId); else next.delete(item.preparationId); return next; })} />ตรวจโครงการ คำสั่ง และไฟล์แล้ว ตรงกับสิ่งที่ต้องการส่งมอบ</label>
        <button disabled={disabled || busy || !reviewed.has(item.preparationId)} onClick={() => decide(item, 'approved')}>อนุมัติคำขอนี้</button>
        <button disabled={disabled || busy} onClick={() => decide(item, 'rejected')}>ไม่อนุมัติคำขอนี้</button>
      </> : <><p>อนุมัติแล้ว · ยังไม่ได้เริ่มงาน</p><button disabled={disabled || busy} onClick={() => void act(async () => {
        const prompt = `ตรวจสถานะคำขอส่งมอบ ${item.preparationId} ผ่าน gotzji_delivery_request ถ้ายังได้รับอนุมัติ ให้ส่ง preparationId เดิมผ่าน gotzji_submit และติดตามงานเดิม ห้ามเตรียมหรือส่งคำขอใหม่แทน`;
        try { await navigator.clipboard.writeText(prompt); if (mounted.current) { setManualPrompt(''); setMessage('คัดลอกแล้ว กลับไปส่งให้ ChatGPT เพื่อเริ่มงานตามคำขอเดิม'); } }
        catch { if (mounted.current) { setManualPrompt(prompt); setMessage('คัดลอกอัตโนมัติไม่ได้ เลือกข้อความด้านล่างแล้วคัดลอกไปยัง ChatGPT'); } }
      })}>คัดลอกคำสั่งกลับไป ChatGPT</button></>}
    </li>)}</ul>}
    {manualPrompt && <><label htmlFor={promptId}>ข้อความสำหรับ ChatGPT</label><textarea id={promptId} readOnly value={manualPrompt} /></>}
  </section>;
}
