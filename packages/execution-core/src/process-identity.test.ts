import { describe, expect, it, vi } from 'vitest';
import { createWindowsProcessIdentityReader, type ProcessIdentity, type WindowsProcessIdentityExecutor } from './process-identity.mjs';

const identity = (birth: string): ProcessIdentity => ({ birth, executable: 'c:\\node.exe' });
const paths = { programFiles: 'C:\\Program Files', systemRoot: 'C:\\Windows', currentPid: 100 };

describe('Windows process identity probes', () => {
  it('prefers installed absolute PowerShell 7 and falls back only when it is absent', async () => {
    const modern = vi.fn<WindowsProcessIdentityExecutor>(async () => ({ stdout: JSON.stringify({ 101: identity('first') }) }));
    await createWindowsProcessIdentityReader({ ...paths, exists: () => true, run: modern })([101]);
    expect(modern.mock.calls[0]?.[0]).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    const legacy = vi.fn<WindowsProcessIdentityExecutor>(async () => ({ stdout: JSON.stringify({ 101: identity('first') }) }));
    await createWindowsProcessIdentityReader({ ...paths, exists: () => false, run: legacy })([101]);
    expect(legacy.mock.calls[0]?.[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('shares only an in-flight identical batch and re-probes a reused child PID afterwards', async () => {
    let complete!: (value: { stdout: string }) => void;
    const run = vi.fn(() => new Promise<{ stdout: string }>((resolve) => { complete = resolve; }));
    const read = createWindowsProcessIdentityReader({ ...paths, exists: () => true, run });
    const first = read([102, 101]);
    const second = read([101, 102]);
    expect(run).toHaveBeenCalledTimes(1);
    complete({ stdout: JSON.stringify({ 101: identity('old'), 102: identity('other') }) });
    expect(await first).toEqual(await second);
    const reused = read([101]);
    expect(run).toHaveBeenCalledTimes(2);
    complete({ stdout: JSON.stringify({ 101: identity('new') }) });
    expect((await reused)[101]).toEqual(identity('new'));
  });

  it('retains only the verified current process, keeping child and failed probes fresh', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ 100: identity('self'), 101: identity('child') }) }));
    const read = createWindowsProcessIdentityReader({ ...paths, exists: () => true, run });
    await read([100]);
    expect((await read([100]))[100]).toEqual(identity('self'));
    expect(run).toHaveBeenCalledTimes(1);
    await read([101]); await read([101]);
    expect(run).toHaveBeenCalledTimes(3);
    const failed = vi.fn(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    const failure = vi.fn();
    const unknown = createWindowsProcessIdentityReader({ ...paths, exists: () => true, run: failed, onFailure: failure });
    expect(await unknown([100, 101])).toEqual({ 100: 'unknown', 101: 'unknown' });
    expect(await unknown([100])).toEqual({ 100: 'unknown' });
    expect(failed).toHaveBeenCalledTimes(2);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'ETIMEDOUT' }));
  });

  it('keeps failed proof unknown even when its diagnostic observer throws', async () => {
    const run = vi.fn(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    const read = createWindowsProcessIdentityReader({ ...paths, exists: () => true, run, onFailure: () => { throw new Error('observer failure'); } });
    expect(await read([100, 101])).toEqual({ 100: 'unknown', 101: 'unknown' });
    expect(await read([100, 101])).toEqual({ 100: 'unknown', 101: 'unknown' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete identity output without caching it or converting uncertainty to absence', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ 100: { birth: 'missing-executable' }, 101: null }) }));
    const read = createWindowsProcessIdentityReader({ ...paths, exists: () => true, run });
    expect(await read([100, 101])).toEqual({ 100: 'unknown', 101: null });
    expect(await read([100])).toEqual({ 100: 'unknown' });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
