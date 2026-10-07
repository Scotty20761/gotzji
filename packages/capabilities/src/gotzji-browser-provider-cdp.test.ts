import { describe, expect, it, vi, type Mock } from 'vitest';
import type { BrowserCdpProtocol } from './browser-cdp-backend.js';
import { GotzjiBrowserCdpTransport } from './gotzji-browser-provider-cdp.js';

const session = { browserId: 'owned-chrome', contextId: 'process-start-1', profileId: 'owned-profile', tabId: 'selected', providerTabId: 'selected', cdpBrowserContextId: '' };
function fixture(): { protocol: BrowserCdpProtocol; owns: Mock<() => Promise<boolean>>; transport: GotzjiBrowserCdpTransport } {
  const protocol: BrowserCdpProtocol = {
    status: vi.fn(async () => ({ ready: true, port: 9223 })), listTabs: vi.fn(async () => [{ id: 'selected', title: 'fixture', url: 'http://127.0.0.1:1234/fixture', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/selected' }]),
    newTab: vi.fn(), closeTab: vi.fn(), request: vi.fn(async (_tab, method) => {
      if (method === 'Target.getTargetInfo') return { result: { targetInfo: { targetId: 'selected', type: 'page' } } };
      if (method === 'Page.getFrameTree') return { result: { frameTree: { frame: { loaderId: 'loader-1', url: 'http://127.0.0.1:1234/fixture' } } } };
      return { result: { result: { value: { count: 1, identity: 'note', tag: 'INPUT', text: '', value: 'original', editable: true, enabled: true, visible: true, protected: false } } } };
    }),
  };
  const owns = vi.fn(async () => true); return { protocol, owns, transport: new GotzjiBrowserCdpTransport(protocol, session, owns) };
}
describe('gotzji owned CDP transport', () => {
  it('checks explicit context/profile/process authority and loader identity; never creates or adopts a tab', async () => {
    const f = fixture(); expect(await f.transport.binding()).toMatchObject({ browserId: session.browserId, contextId: session.contextId, profileId: session.profileId, tabId: session.tabId, providerTabId: session.providerTabId, documentId: 'loader-1' });
    expect(f.owns).toHaveBeenCalledTimes(3); expect(f.protocol.newTab).not.toHaveBeenCalled(); expect(f.protocol.closeTab).not.toHaveBeenCalled();
    expect(vi.mocked(f.protocol.request).mock.calls.every((call) => call[0] === 'selected')).toBe(true);
  });
  it('does not access CDP when exact process ownership is unverified', async () => {
    const f = fixture(); f.owns.mockResolvedValue(false); await expect(f.transport.binding()).rejects.toMatchObject({ code: 'BROWSER_SESSION_UNVERIFIED' }); expect(f.protocol.request).not.toHaveBeenCalled(); expect(f.protocol.listTabs).not.toHaveBeenCalled();
  });
  it('does not choose another tab when selected tab disappeared', async () => {
    const f = fixture(); vi.mocked(f.protocol.listTabs).mockResolvedValue([{ id: 'other', title: 'user tab', url: 'https://site.invalid', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/other' }]);
    await expect(f.transport.binding()).rejects.toMatchObject({ code: 'BROWSER_TAB_MISSING' }); expect(f.protocol.request).not.toHaveBeenCalled();
  });
  it('fails closed on changed native browser context', async () => {
    const f = fixture(); vi.mocked(f.protocol.request).mockResolvedValue({ result: { targetInfo: { targetId: 'selected', type: 'page', browserContextId: 'another-context' } } });
    await expect(f.transport.binding()).rejects.toMatchObject({ code: 'BROWSER_SESSION_UNVERIFIED' });
  });
  it('encodes text and selector as data in an internally authored native action', async () => {
    const f = fixture(); await f.transport.fill('#note', 'literal "; stealSecrets(); //', 'note');
    const call = vi.mocked(f.protocol.request).mock.calls.find((args) => args[1] === 'Runtime.evaluate')!;
    expect(call[2].expression).toContain(JSON.stringify('literal "; stealSecrets(); //')); expect(call[2]).toMatchObject({ returnByValue: true, awaitPromise: false });
  });
});
