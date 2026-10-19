import { describe, expect, it } from 'vitest';
import { browserReadBinding, browserSessionProjection, browserSessionView } from '../src/renderer/gotzji-browser-session.js';
describe('project browser panel state', () => {
  const ready = { state: 'ready', projectId: 'project-a', sessionId: 'session', tabId: 'tab', expectedUrl: 'https://example.org/', expectedDocumentId: 'document', allowedOrigins: ['https://example.org'] };
  it.each([null, [], {}, { state: 'unknown' }, { state: 'unavailable' }, { ...ready, expectedDocumentId: '' }])('projects a malformed session as unverified: %j', value => {
    const projection = browserSessionProjection(value, 'project-a');
    expect(browserSessionView(projection)).toEqual({ label: 'ยังยืนยันหน้าต่างของโครงการไม่ได้ ตรวจหน้าปัจจุบันอีกครั้ง', canStop: false });
    expect(browserReadBinding(projection, 'project-a')).toBeNull();
  });
  it('preserves declared ready, stopping and unenrolled projections', () => {
    expect(browserSessionProjection(ready, 'project-a')).toEqual(ready);
    for (const state of ['stopping', 'stopped', 'not-enrolled']) expect(browserSessionProjection({ state }, 'project-a')).toEqual({ state });
  });
  it('binds a read only to the ready selected project and exact observed document', () => {
    expect(browserReadBinding(ready, 'project-a')).toEqual({ projectId: 'project-a', sessionId: 'session', tabId: 'tab', expectedUrl: 'https://example.org/', expectedDocumentId: 'document' });
    expect(browserReadBinding(ready, 'project-b')).toBeNull();
    for (const state of ['stopping', 'stopped', 'not-enrolled', 'unavailable']) expect(browserReadBinding({ ...ready, state }, 'project-a')).toBeNull();
    expect(browserReadBinding(null, 'project-a')).toBeNull();
  });
  it('rejects incomplete or credential-bearing/non-HTTPS page bindings and preserves changed document identity', () => {
    for (const key of ['sessionId', 'tabId', 'expectedUrl', 'expectedDocumentId']) expect(browserReadBinding({ ...ready, [key]: '' }, 'project-a')).toBeNull();
    for (const expectedUrl of ['http://example.org/', 'https://user:secret@example.org/', 'file:///private.txt', 'not-a-url']) expect(browserReadBinding({ ...ready, expectedUrl }, 'project-a')).toBeNull();
    expect(browserReadBinding({ ...ready, expectedDocumentId: 'new-document' }, 'project-a')?.expectedDocumentId).toBe('new-document');
    expect(browserReadBinding({ ...ready, expectedUrl: 'https://outside.example/' }, 'project-a')).toBeNull();
  });

  it('allows Stop while ready or stopping and says an unconfirmed close is not yet proven', () => {
    expect(browserSessionView({ state: 'ready' })).toEqual({ label: 'พร้อมให้เลือกเครื่องมือเบราว์เซอร์', canStop: true });
    expect(browserSessionView({ state: 'stopping', sessionId: 'session' })).toEqual({ label: 'ยังยืนยันไม่ได้ว่าเบราว์เซอร์ของโครงการปิดแล้ว กดปิดอีกครั้งเพื่อลองต่อ', canStop: true });
  });
  it('keeps Stop disabled once the session is stopped, unavailable or not enrolled', () => {
    expect(browserSessionView({ state: 'stopped' })).toEqual({ label: 'ยังไม่ได้เปิดเบราว์เซอร์', canStop: false });
    expect(browserSessionView({ state: 'unavailable', reason: 'BROWSER_SESSION_UNVERIFIED' })).toEqual({ label: 'ยังยืนยันหน้าต่างของโครงการไม่ได้ ตรวจหน้าปัจจุบันอีกครั้ง', canStop: false });
    expect(browserSessionView({ state: 'not-enrolled' }).canStop).toBe(false);
    expect(browserSessionView(null).canStop).toBe(false);
  });
});
