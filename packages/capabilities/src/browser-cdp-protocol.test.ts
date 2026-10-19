import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';

describe('NodeBrowserCdpProtocol readiness', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('distinguishes a missing browser executable from a stopped browser', async (): Promise<void> => {
    const missing = new NodeBrowserCdpProtocol({
      platform: 'linux',
      chromeExecutable: '/opt/chromium',
      executableExists: (): boolean => false,
    });
    await expect(missing.status()).resolves.toMatchObject({
      ready: false,
      browserInstalled: false,
      readinessReason: 'browser_not_installed',
    });

    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response('', { status: 503 })));
    const stopped = new NodeBrowserCdpProtocol({
      platform: 'linux',
      chromeExecutable: '/opt/chromium',
      executableExists: (): boolean => true,
    });
    await expect(stopped.status()).resolves.toMatchObject({
      ready: false,
      browserInstalled: true,
      readinessReason: 'browser_not_running',
    });
  });

  it('fails closed on an unsupported host before launching a configured browser', async (): Promise<void> => {
    const browser = new NodeBrowserCdpProtocol({
      platform: 'freebsd',
      chromeExecutable: '/opt/chromium',
      executableExists: (): boolean => true,
    });
    await expect(browser.launch(undefined)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_PLATFORM' },
    });
  });

  it('reports a ready local CDP endpoint separately from installation state', async (): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response('{}', { status: 200 })));
    const browser = new NodeBrowserCdpProtocol({
      platform: 'darwin',
      chromeExecutable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      executableExists: (): boolean => true,
      port: 9223,
    });
    await expect(browser.status()).resolves.toEqual({
      ready: true,
      port: 9223,
      browserInstalled: true,
      readinessReason: 'browser_ready',
    });
  });
});


describe('owned browser-root close protocol', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) {
      if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('gotzji-browser-close-')) throw new Error('Close fixture scope denied');
      await rm(root, { recursive: true, force: true });
    }
  });
  async function fixture(contents = '18411\n/devtools/browser/11111111-2222-4333-8444-555555555555\n'): Promise<NodeBrowserCdpProtocol> {
    const root = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), 'gotzji-browser-close-'))); roots.push(root);
    await writeFile(path.join(root, 'DevToolsActivePort'), contents);
    return new NodeBrowserCdpProtocol({ port: 18411, profileDir: root });
  }
  function socket(reply: unknown, closeBeforeSend = false): { urls: string[]; sent: unknown[] } {
    const urls: string[] = []; const sent: unknown[] = [];
    class OwnedSocket extends EventTarget {
      public constructor(url: string) { super(); urls.push(String(url)); queueMicrotask(() => this.dispatchEvent(new Event(closeBeforeSend ? 'close' : 'open'))); }
      public send(text: string): void {
        sent.push(JSON.parse(text));
        queueMicrotask(() => this.dispatchEvent(reply === 'close-after-send' ? new Event('close') : new MessageEvent('message', { data: JSON.stringify(reply) })));
      }
      public close(): void { this.dispatchEvent(new Event('close')); }
    }
    vi.stubGlobal('WebSocket', OwnedSocket);
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => { throw new Error('Page/tab lookup must not run'); }));
    return { urls, sent };
  }
  it('closes the exact owned browser socket without requiring any live page', async () => {
    const driver = await fixture(); const observed = socket({ id: 1, result: {} });
    await driver.requestBrowserClose();
    expect(observed.urls).toEqual(['ws://127.0.0.1:18411/devtools/browser/11111111-2222-4333-8444-555555555555']);
    expect(observed.sent).toEqual([{ id: 1, method: 'Browser.close', params: {} }]); expect(fetch).not.toHaveBeenCalled();
  });
  it('settles close after dispatch promptly so native absence can be checked', async () => {
    const driver = await fixture(); const observed = socket('close-after-send');
    await driver.requestBrowserClose(); expect(observed.sent).toHaveLength(1);
  });
  it('rejects a socket closed before dispatch', async () => {
    const driver = await fixture(); const observed = socket('close-after-send', true);
    await expect(driver.requestBrowserClose()).rejects.toThrow(); expect(observed.sent).toHaveLength(0);
  });
  it('rejects a CDP error rather than treating its envelope as acknowledgement', async () => {
    const driver = await fixture(); socket({ id: 1, error: { code: -32601, message: 'Method denied' } });
    await expect(driver.requestBrowserClose()).rejects.toThrow('Chrome browser close was rejected');
  });
  it.each([{ id: 1 }, { id: 1, result: null }, { id: 1, result: {}, error: {} }])('rejects malformed close acknowledgement %j', async (reply) => {
    const driver = await fixture(); socket(reply);
    await expect(driver.requestBrowserClose()).rejects.toThrow('Chrome browser close was rejected');
  });
  it('rejects a closed page socket promptly for an ordinary request', async () => {
    const driver = await fixture(); socket('close-after-send');
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => Response.json([{ id: 'owned-page', title: '', url: 'https://example.invalid/', webSocketDebuggerUrl: 'ws://127.0.0.1:18411/devtools/page/owned-page' }])));
    await expect(driver.request('owned-page', 'Runtime.evaluate', {})).rejects.toThrow('Chrome CDP socket closed before a response');
  });
  it.each(['18412\n/devtools/browser/abc\n', '18411\n/devtools/page/abc\n', '18411\nws://outside.invalid/devtools/browser/abc\n', '18411\n/devtools/browser/abc?other=1\n', '18411\n'])('rejects unbound coordination %s', async (contents) => {
    const driver = await fixture(contents); const observed = socket({ id: 1, result: {} });
    await expect(driver.requestBrowserClose()).rejects.toThrow(); expect(observed.urls).toEqual([]);
  });
  it('does not dispatch an already cancelled close', async () => {
    const driver = await fixture(); const observed = socket({ id: 1, result: {} }); const controller = new AbortController(); controller.abort();
    await expect(driver.requestBrowserClose(controller.signal)).rejects.toThrow(); expect(observed.sent).toHaveLength(0);
  });
});
