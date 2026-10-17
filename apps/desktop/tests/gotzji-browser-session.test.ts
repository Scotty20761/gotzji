import { describe, expect, it } from 'vitest';
import { browserSessionView } from '../src/renderer/gotzji-browser-session.js';
describe('project browser panel state', () => {
  it('allows Stop while ready or stopping and says an unconfirmed close is not yet proven', () => {
    expect(browserSessionView({ state: 'ready' })).toEqual({ label: 'พร้อมให้เลือกเครื่องมือเบราว์เซอร์', canStop: true });
    expect(browserSessionView({ state: 'stopping', sessionId: 'session' })).toEqual({ label: 'ยังยืนยันไม่ได้ว่าเบราว์เซอร์ของโครงการปิดแล้ว กดปิดอีกครั้งเพื่อลองต่อ', canStop: true });
  });
  it('keeps Stop disabled once the session is stopped, unavailable or not enrolled', () => {
    expect(browserSessionView({ state: 'stopped' })).toEqual({ label: 'ยังไม่ได้เปิดเบราว์เซอร์', canStop: false });
    expect(browserSessionView({ state: 'unavailable', reason: 'BROWSER_SESSION_UNVERIFIED' })).toEqual({ label: 'BROWSER_SESSION_UNVERIFIED', canStop: false });
    expect(browserSessionView({ state: 'not-enrolled' }).canStop).toBe(false);
    expect(browserSessionView(null).canStop).toBe(false);
  });
});
