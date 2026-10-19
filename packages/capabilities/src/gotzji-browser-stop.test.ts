import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';
import { startGotzjiOwnedBrowser, stopGotzjiOwnedBrowserProcess } from './gotzji-browser-provider-session.js';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const native = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFile: native.execFile, spawn: native.spawn }));

describe.skipIf(process.platform !== 'win32')('owned Windows browser close identity', () => {
  const root = { ProcessId: 100, ParentProcessId: 1, Start: 'owned-root-birth' };
  const child = { ProcessId: 101, ParentProcessId: 100, Start: 'owned-child-birth' };
  const independent = { ProcessId: 200, ParentProcessId: 1, Start: 'independent-birth' };
  beforeEach(() => { vi.useFakeTimers(); native.execFile.mockReset(); });
  const roots: string[] = [];
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    for (const root of roots.splice(0)) {
      if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('gotzji-browser-session-test-')) throw new Error('Owned mock session cleanup scope denied');
      await rm(root, { recursive: true, force: true });
    }
  });

  function fixture(snapshots: readonly (readonly typeof root[])[]): {
    session: { pid: number; pidBirth: string; protocol: NodeBrowserCdpProtocol };
    close: ReturnType<typeof vi.spyOn>;
  } {
    let index = 0;
    native.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
      const rows = snapshots[Math.min(index++, snapshots.length - 1)];
      callback(null, JSON.stringify(rows));
    });
    const protocol = new NodeBrowserCdpProtocol(); const close = vi.spyOn(protocol, 'requestBrowserClose').mockResolvedValue();
    return { session: { pid: 100, pidBirth: root.Start, protocol }, close };
  }
  it('checks ownership twice and requires captured root and descendants to be absent', async () => {
    const { session, close } = fixture([[root, child, independent], [independent]]); const ownership = vi.fn(async () => true);
    await expect(stopGotzjiOwnedBrowserProcess(session, ownership)).resolves.toEqual({ stopped: true, pid: 100 });
    expect(ownership).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce();
    expect(native.execFile).toHaveBeenCalledTimes(2);
    expect(native.execFile.mock.calls.every(call => call[0] === 'powershell.exe' && !JSON.stringify(call).includes('taskkill'))).toBe(true);
  });
  it('refuses to send close when ownership changes between census and dispatch', async () => {
    const { session, close } = fixture([[root, child]]); const ownership = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(stopGotzjiOwnedBrowserProcess(session, ownership)).rejects.toMatchObject({ code: 'BROWSER_TERMINATION_UNVERIFIED' });
    expect(close).not.toHaveBeenCalled();
  });
  it('refuses a reused root PID before any close command', async () => {
    const { session, close } = fixture([[{ ...root, Start: 'different-birth' }]]);
    await expect(stopGotzjiOwnedBrowserProcess(session, async () => true)).rejects.toMatchObject({ code: 'BROWSER_TERMINATION_UNVERIFIED' });
    expect(close).not.toHaveBeenCalled();
  });
  it('does not confuse a reused descendant PID with the captured owned process', async () => {
    const { session } = fixture([[root, child], [{ ...child, Start: 'new-independent-birth' }]]);
    await expect(stopGotzjiOwnedBrowserProcess(session, async () => true)).resolves.toMatchObject({ stopped: true });
  });
  it('retains failure when a captured child survives a successful close acknowledgement', async () => {
    const started = Date.now();
    const { session } = fixture([[root, child], [child]]); const result = stopGotzjiOwnedBrowserProcess(session, async () => true);
    const assertion = expect(result).rejects.toMatchObject({ code: 'BROWSER_TERMINATION_UNVERIFIED' });
    await vi.runAllTimersAsync(); await assertion; expect(Date.now() - started).toBe(20000);
  });
  it('keeps observing a natural close beyond five seconds and accepts proved absence at nine seconds', async () => {
    const { session, close } = fixture([[root, child]]); const started = Date.now();
    native.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => callback(null, JSON.stringify(Date.now() - started < 9000 ? [root, child] : [])));
    let settled = false;
    const pending = stopGotzjiOwnedBrowserProcess(session, async () => true).then(value => { settled = true; return value; }, (error: unknown) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(5001); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3999); expect(await pending).toEqual({ stopped: true, pid: 100 });
    expect(close).toHaveBeenCalledOnce();
  });
  it('clips the final native census and rejects an absence observed after the monotonic deadline', async () => {
    const { session } = fixture([[root, child]]); let elapsed = 0; let filtered = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    native.execFile.mockImplementation((_file: string, args: string[], options: { timeout: number }, callback: (error: null, stdout: string) => void) => {
      if (!args.some(arg => arg.includes(' -Filter '))) { callback(null, JSON.stringify([root, child])); return; }
      filtered++;
      if (filtered === 1) { elapsed = 19500; callback(null, JSON.stringify([root, child])); }
      else { expect(options.timeout).toBe(500); elapsed = 20001; callback(null, '[]'); }
    });
    const pending = stopGotzjiOwnedBrowserProcess(session, async () => true).then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));
    await vi.runAllTimersAsync(); expect(await pending).toMatchObject({ ok: false, error: { code: 'BROWSER_TERMINATION_UNVERIFIED' } });
    expect(filtered).toBe(2);
  });
  it('requires native absence even when the close request fails and preserves its cause', async () => {
    const { session, close } = fixture([[root], [root]]); const cause = new Error('Chrome browser close was rejected'); close.mockRejectedValue(cause);
    const assertion = expect(stopGotzjiOwnedBrowserProcess(session, async () => true)).rejects.toMatchObject({ code: 'BROWSER_TERMINATION_UNVERIFIED', cause });
    await vi.runAllTimersAsync(); await assertion;
  });
  it('fails closed when the native process census is unknown', async () => {
    const { session, close } = fixture([[root]]); native.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => callback(new Error('CIM unavailable')));
    await expect(stopGotzjiOwnedBrowserProcess(session, async () => true)).rejects.toMatchObject({ code: 'BROWSER_TERMINATION_UNVERIFIED' });
    expect(close).not.toHaveBeenCalled();
  });
  it('ignores an unrelated missing birth while discovering and polling its own tree', async () => {
    const unrelated = { ...independent, Start: '' };
    const { session } = fixture([[root, child, unrelated], [unrelated]]);
    await expect(stopGotzjiOwnedBrowserProcess(session, async () => true)).resolves.toMatchObject({ stopped: true });
    expect(native.execFile.mock.calls[1]![1]).toEqual(expect.arrayContaining([expect.stringContaining('ProcessId = 100 OR ProcessId = 101')]));
  });
  it('rejects a missing owned root birth before dispatch', async () => {
    const { session, close } = fixture([[{ ...root, Start: '' }, independent]]);
    await expect(stopGotzjiOwnedBrowserProcess(session, async () => true)).rejects.toMatchObject({ code: 'BROWSER_TERMINATION_UNVERIFIED' });
    expect(close).not.toHaveBeenCalled();
  });
  it('rejects a missing captured child birth rather than inventing ownership', async () => {
    const { session, close } = fixture([[root, { ...child, Start: '' }]]);
    await expect(stopGotzjiOwnedBrowserProcess(session, async () => true)).rejects.toMatchObject({ code: 'BROWSER_TERMINATION_UNVERIFIED' });
    expect(close).not.toHaveBeenCalled();
  });
  it('fails closed when a captured PID has unknown birth in the final census', async () => {
    const { session } = fixture([[root, child], [{ ...child, Start: '' }]]);
    await expect(stopGotzjiOwnedBrowserProcess(session, async () => true)).rejects.toMatchObject({ code: 'BROWSER_TERMINATION_UNVERIFIED' });
  });
  it('observes native absence without waiting for an unresponsive close socket', async () => {
    const { session, close } = fixture([[root, child], [independent]]); let aborted = false;
    close.mockImplementation((signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true })));
    await expect(stopGotzjiOwnedBrowserProcess(session, async () => true)).resolves.toMatchObject({ stopped: true });
    expect(aborted).toBe(true);
  }, 1000);
  it('settles an unresponsive close socket at the existing native absence deadline', async () => {
    const { session, close } = fixture([[root, child], [child]]); let aborted = false;
    close.mockImplementation((signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true })));
    const assertion = expect(stopGotzjiOwnedBrowserProcess(session, async () => true)).rejects.toMatchObject({ code: 'BROWSER_TERMINATION_UNVERIFIED' });
    await vi.runAllTimersAsync(); await assertion; expect(aborted).toBe(true);
  }, 1000);
  it('accepts independent native absence while the captured child exit event is still pending', async () => {
    const rootPath = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), 'gotzji-browser-session-test-'))); roots.push(rootPath);
    const profileParent = path.join(rootPath, 'gotzji'); await mkdir(profileParent);
    const executable = path.join(rootPath, 'chrome.exe'); await writeFile(executable, 'synthetic executable bytes; spawn is mocked');
    const childHandle = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null });
    native.spawn.mockImplementation((_executable: string, args: string[]) => {
      const profile = args.find(arg => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
      writeFileSync(path.join(profile, 'DevToolsActivePort'), '18411\n/devtools/browser/11111111-2222-4333-8444-555555555555');
      return childHandle;
    });
    fixture([[root], []]); vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    vi.spyOn(NodeBrowserCdpProtocol.prototype, 'requestBrowserClose').mockResolvedValue();
    const driver = await startGotzjiOwnedBrowser({ profileParent, chromeExecutable: executable, headless: true });
    await expect(driver.stop()).resolves.toEqual({ stopped: true, pid: 100 });
    expect(childHandle.exitCode).toBeNull(); expect(childHandle.signalCode).toBeNull();
  });
});
