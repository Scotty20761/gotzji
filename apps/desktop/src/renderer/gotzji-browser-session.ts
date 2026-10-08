/** Panel text for a project browser projection, and whether Stop may be pressed (ready, or stopping after an unconfirmed close). */
export function browserSessionView(session: Readonly<Record<string, unknown>> | null): { readonly label: string; readonly canStop: boolean } {
  if (!session) return { label: '', canStop: false };
  if (session.state === 'ready') return { label: 'พร้อมให้เลือกเครื่องมือเบราว์เซอร์', canStop: true };
  if (session.state === 'stopping') return { label: 'ยังยืนยันไม่ได้ว่าเบราว์เซอร์ของโครงการปิดแล้ว กดปิดอีกครั้งเพื่อลองต่อ', canStop: true };
  return { label: String(session.reason ?? 'ยังไม่ได้เปิดเบราว์เซอร์'), canStop: false };
}
