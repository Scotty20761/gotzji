export interface BrowserReadBinding {
  readonly projectId: string; readonly sessionId: string; readonly tabId: string;
  readonly expectedUrl: string; readonly expectedDocumentId: string;
}
export function browserSessionProjection(value: unknown, projectId: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unavailable', reason: 'BROWSER_SESSION_UNVERIFIED' };
  const session = value as Record<string, unknown>;
  if (typeof session.state !== 'string' || !['ready', 'stopping', 'stopped', 'not-enrolled', 'unavailable'].includes(session.state)
    || (session.state === 'ready' && !browserReadBinding(session, projectId))) return { state: 'unavailable', reason: 'BROWSER_SESSION_UNVERIFIED' };
  return session;
}
export function browserReadBinding(session: Readonly<Record<string, unknown>> | null, projectId: string): BrowserReadBinding | null {
  if (!projectId || !session || session.state !== 'ready' || session.projectId !== projectId
    || ['sessionId', 'tabId', 'expectedUrl', 'expectedDocumentId'].some((key) => typeof session[key] !== 'string' || !session[key])) return null;
  try {
    const url = new URL(String(session.expectedUrl));
    if (url.protocol !== 'https:' || url.username || url.password || !Array.isArray(session.allowedOrigins) || !session.allowedOrigins.includes(url.origin)) return null;
  } catch { return null; }
  return { projectId, sessionId: String(session.sessionId), tabId: String(session.tabId), expectedUrl: String(session.expectedUrl), expectedDocumentId: String(session.expectedDocumentId) };
}
const messages: Readonly<Record<string, string>> = {
  BROWSER_PROVIDER_NOT_CONFIGURED: 'ยังไม่พบ Chrome ที่พร้อมใช้งาน ตรวจการตั้งค่าเบราว์เซอร์ก่อน',
  BROWSER_ENROLLMENT_DENIED: 'ยังเปิดเบราว์เซอร์ให้โครงการไม่ได้ ตรวจการตั้งค่าและลองใหม่',
  BROWSER_SESSION_UNVERIFIED: 'ยังยืนยันหน้าต่างของโครงการไม่ได้ ตรวจหน้าปัจจุบันอีกครั้ง',
  BROWSER_SESSION_STOP_REQUIRED: 'ปิดเบราว์เซอร์ของโครงการเดิมก่อนเปิดให้โครงการนี้',
  BROWSER_PROJECT_DENIED: 'เบราว์เซอร์นี้เป็นของอีกโครงการ เลือกโครงการเดิมเพื่อตรวจหรือปิด',
  BROWSER_SESSION_HAS_RETAINED_JOBS: 'ยังมีงานใช้เบราว์เซอร์นี้อยู่ ตรวจงานในประวัติก่อนปิด',
  BROWSER_DOCUMENT_CHANGED: 'หน้าเว็บเปลี่ยนแล้ว ตรวจหน้าปัจจุบันและเตรียมอ่านอีกครั้ง',
  BROWSER_BINDING_CHANGED: 'หน้าเว็บเปลี่ยนแล้ว ตรวจหน้าปัจจุบันและเตรียมอ่านอีกครั้ง',
  BROWSER_URL_SCOPE_DENIED: 'ใช้หน้าเว็บ HTTPS ภายในเว็บไซต์ที่อนุญาตให้โครงการนี้',
  BROWSER_TERMINATION_UNVERIFIED: 'ยังยืนยันการปิดหน้าต่างไม่ได้ กดปิดอีกครั้งเพื่อตรวจต่อ',
  HOST_CONNECTION_LOST: 'ยังยืนยันคำตอบไม่ได้ ลองตรวจสถานะหรือยืนยันคำขอเดิมอีกครั้ง',
};
export function browserPanelMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return Object.entries(messages).find(([code]) => text.includes(code))?.[1] ?? 'ทำรายการไม่สำเร็จ กรุณาตรวจหน้าปัจจุบันและลองอีกครั้ง';
}
/** A stopping projection retains the existing retry control until native absence is proved. */
export function browserSessionView(session: Readonly<Record<string, unknown>> | null): { readonly label: string; readonly canStop: boolean } {
  if (!session) return { label: '', canStop: false };
  if (session.state === 'ready') return { label: 'พร้อมให้เลือกเครื่องมือเบราว์เซอร์', canStop: true };
  if (session.state === 'stopping') return { label: 'ยังยืนยันไม่ได้ว่าเบราว์เซอร์ของโครงการปิดแล้ว กดปิดอีกครั้งเพื่อลองต่อ', canStop: true };
  if (session.state === 'not-enrolled' || session.state === 'stopped') return { label: 'ยังไม่ได้เปิดเบราว์เซอร์', canStop: false };
  return { label: browserPanelMessage(session.state === 'unavailable' && typeof session.reason === 'string' ? session.reason : 'BROWSER_SESSION_UNVERIFIED'), canStop: false };
}
