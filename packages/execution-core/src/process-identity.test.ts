import { describe, expect, it, vi } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { createWindowsPowerShellSession, createWindowsProcessIdentityReader, windowsPowerShellSession, processIdentityDiagnostics, type ProcessIdentity, type WindowsPowerShellSession, type WindowsProcessIdentityExecutor } from './process-identity.mjs';

const identity = (birth: string): ProcessIdentity => ({ birth, executable: 'c:\\node.exe' });
const paths = { programFiles: 'C:\\Program Files', systemRoot: 'C:\\Windows', currentPid: 100 };
const exec = promisify(execFile);
const within = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('owned fixture deadline')), milliseconds); })]); }
  finally { clearTimeout(timer); }
};

const windowsPrograms = process.platform === 'win32' ? [...new Set([
  path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  ...(process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, 'pwsh.exe')),
].filter((program) => existsSync(program)))] : [];

/** Own every real child and wait for its close event even when an assertion fails. */
async function withNodeIdentity(action: (child: ChildProcess, pid: number, own: (start: () => ChildProcess) => ChildProcess, onCleanup: (close: () => void) => void) => Promise<void>, budgetMs = 29_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  const remaining = (reserve: number): number => Math.max(1, deadline - performance.now() - reserve);
  const owned: { child?: ChildProcess; closed?: Promise<unknown[]> }[] = [];
  const closeHooks: (() => void)[] = [];
  let closing = false;
  const own = (start: () => ChildProcess): ChildProcess => {
    if (closing) throw new Error('owned fixture is closing');
    const item: typeof owned[number] = {}; owned.push(item);
    const child = start(); item.child = child; item.closed = new Promise((resolve) => child.once('close', (...result) => resolve(result)));
    // Observe startup errors immediately, including an executable that never gets a PID.
    child.on('error', () => undefined);
    return child;
  };
  let failure: unknown; const cleanupFailures: unknown[] = [];
  const child = own(() => spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(259)); process.stdout.write("ready\\n")'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  try {
    await within(once(child.stdout!, 'data'), Math.min(5000, remaining(4000)));
    expect(child.pid).toBeGreaterThan(0);
    await within(action(child, child.pid!, own, (close) => { closeHooks.push(close); }), Math.min(20_000, remaining(4000)));
  } catch (error) { failure = error;
  } finally {
    closing = true;
    for (const close of closeHooks) { try { close(); } catch (error) { cleanupFailures.push(error); } }
    try { child.stdin?.end(); } catch (error) { cleanupFailures.push(error); }
    await Promise.all(owned.map(async (item) => {
      if (!item.child || !item.closed) return;
      try {
        let result: unknown[];
        try { result = await within(item.closed, 2000); }
        catch (error) { item.child.kill(); result = await within(item.closed, 2000); cleanupFailures.push(error); }
        const [code, signal] = result;
        expect(code).toBe(item.child === child ? 259 : 0); expect(signal).toBeNull();
        if (item.child.pid) expect(() => process.kill(item.child!.pid!, 0)).toThrow();
        console.info(JSON.stringify({ resource: item.child === child ? 'owned-node' : 'owned-powershell', pid: item.child.pid, exitCode: code, signal, closed: true, absent: true }));
      } catch (error) { cleanupFailures.push(error); }
    }));
  }
  if (cleanupFailures.length) throw new AggregateError(failure ? [failure, ...cleanupFailures] : cleanupFailures, 'owned fixture failed with cleanup diagnostics');
  if (failure) throw failure;
}

describe.each(windowsPrograms)('actual Windows identity script: %s', (program) => {
  it.each(['one-shot', 'session'] as const)('ignores Get-Process.Path startup DLL in the actual %s script', async (mode) => {
    await withNodeIdentity(async (child, pid, own, onCleanup) => {
      const runOwned = async (args: readonly string[], options: object): Promise<{ stdout: string }> => {
        let running!: ReturnType<typeof exec>;
        own(() => { running = exec(program, [...args], options); return running.child; });
        return { stdout: (await running).stdout.toString() };
      };
      // Retain actual HasExited/StartTime for this owned Node; only the faulty Path observation changes.
      const wrapper = `function Get-Process {[CmdletBinding()]param([int]$Id);$p=Microsoft.PowerShell.Management\\Get-Process -Id $Id -ErrorAction Stop;[pscustomobject]@{HasExited=$p.HasExited;StartTime=$p.StartTime;Path='C:\\Windows\\System32\\ntdll.dll'}};`;
      const session = createWindowsPowerShellSession({ program, spawn: (command, args, options) => {
        const actual = [...args]; actual[actual.length - 1] = wrapper + actual[actual.length - 1];
        return own(() => spawn(command, actual, options));
      } });
      onCleanup(() => session.close());
      const read = createWindowsProcessIdentityReader({ currentPid: process.pid, exists: () => false, session, ...(mode === 'one-shot' ? { run: async (_command: string, args: readonly string[], options: object): Promise<{ stdout: string }> => {
        const actual = [...args]; actual[actual.length - 1] = wrapper + actual[actual.length - 1];
        return runOwned(actual, options);
      } } : {}) });
      try {
        const first = (await read([pid]))[pid];
        expect(first).toMatchObject({ executable: process.execPath.toLowerCase() });
        expect(first).toMatchObject({ birth: expect.stringMatching(/^\d+$/u) });
        const expectedBirth = (await runOwned(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Microsoft.PowerShell.Management\\Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)`], { windowsHide: true, timeout: 5000, maxBuffer: 65536 })).stdout.trim();
        expect(first).toMatchObject({ birth: expectedBirth });
        expect((await read([pid]))[pid]).toEqual(first);
        console.info(JSON.stringify({ resource: 'owned-node-identity', mode, program, pid, identity: first }));
        const closed = once(child, 'close'); child.stdin!.end(); await within(closed, 2000);
        expect((await read([pid]))[pid]).toBeNull();
      } finally { session.close(); }
    });
  }, 30_000);

  it.each(['time', 'image', 'pre-wait', 'post-wait'] as const)('keeps a real nonsignaled handle unknown on diagnostic %s failure and closes it', async (failure) => {
    await withNodeIdentity(async (_child, pid, own) => {
      let script = '';
      await createWindowsProcessIdentityReader({ exists: () => false, run: async (_command, args) => { script = args.at(-1)!; return { stdout: '{}' }; } })([pid]);
      // Diagnostic copies use actual read-only handles; forced statuses do not qualify native ACL failures.
      script = script.replace('public static class GotzjiProcessIdentityNative {', 'public static class GotzjiProcessIdentityNative { public static int Opened; public static int Closed; public static uint FailureWait;');
      script = script.replace('try {\n      uint before', 'Opened++; try {\n      uint before');
      script = script.replace('finally { CloseHandle(process); }', 'finally { if (CloseHandle(process)) Closed++; }');
      script = script.replace('return WaitForSingleObject(process, 0) == 0 ? null', 'FailureWait = WaitForSingleObject(process, 0); return FailureWait == 0 ? null');
      if (failure === 'time') script = script.replace('!GetProcessTimes(process, out created, out exited, out kernel, out user)', '!(GetProcessTimes(process, out created, out exited, out kernel, out user) && false)');
      else if (failure === 'image') script = script.replace('!QueryFullProcessImageName(process, 0, image, ref length)', '!(QueryFullProcessImageName(process, 0, image, ref length) && false)');
      else script = script.replace(`uint ${failure === 'pre-wait' ? 'before' : 'after'} = WaitForSingleObject(process, 0);`, `uint ${failure === 'pre-wait' ? 'before' : 'after'} = 0xffffffff;`);
      script = script.replace('$r|ConvertTo-Json -Compress -Depth 3', '@{result=$r;diagnostics=[GotzjiProcessIdentityNative]::Diagnostics;opened=[GotzjiProcessIdentityNative]::Opened;closed=[GotzjiProcessIdentityNative]::Closed;wait=[GotzjiProcessIdentityNative]::FailureWait}|ConvertTo-Json -Compress -Depth 3');
      let running!: ReturnType<typeof exec>;
      own(() => { running = exec(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 65536 }); return running.child; });
      const result: unknown = JSON.parse((await running).stdout.toString().trim());
      expect(result).toMatchObject({ result: { [pid]: 'unknown' }, opened: 1, closed: 1 });
      const reason = { time: /^PROCESS_TIMES_\d+$/u, image: /^PROCESS_IMAGE_\d+$/u, 'pre-wait': /^WAIT_BEFORE_4294967295$/u, 'post-wait': /^WAIT_AFTER_4294967295$/u }[failure];
      expect(result).toMatchObject({ diagnostics: { [pid]: expect.stringMatching(reason) } });
      if (failure === 'time' || failure === 'image') expect(result).toMatchObject({ wait: 258 });
      console.info(JSON.stringify({ resource: 'native-diagnostic-handle', program, failure, pid, result }));
    }, 14_000);
  }, 15_000);
});

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


type Request = { id: number; op: string; pids?: number[]; value?: string | undefined };
type Reply = Record<string, unknown> | 'silent' | 'garbage' | 'overflow';
/** Fake PowerShell processes: JSON identity lines or tab-separated DPAPI lines, answered by `answer`. */
function fakePowerShell(answer: (request: Request, line: string) => Reply): { spawn: ReturnType<typeof vi.fn>; children: { killed: boolean; ended: boolean; stdout: PassThrough; exit: () => void }[] } {
  const children: { killed: boolean; ended: boolean; stdout: PassThrough; exit: () => void }[] = [];
  const start = vi.fn(() => {
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const state = { killed: false, ended: false, stdout, exit: (): void => undefined };
    const child = Object.assign(new EventEmitter(), { stdin, stdout, unref: (): void => undefined, kill: (): boolean => { state.killed = true; queueMicrotask(() => child.emit('exit', 1)); return true; } });
    state.exit = (): void => { child.emit('exit', 0); }; children.push(state);
    let pending = '';
    stdin.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        const fields = line.split('\t');
        const request: Request = line.startsWith('{') ? JSON.parse(line) as Request : { id: Number(fields[0]), op: fields[1] ?? '', value: fields[2] };
        const reply = answer(request, line);
        if (reply === 'overflow') stdout.write('x'.repeat(2048));
        else if (reply !== 'silent') stdout.write(reply === 'garbage' ? 'not json\n' : `${JSON.stringify(reply)}\n`);
      }
    });
    stdin.on('finish', () => { state.ended = true; });
    return child as unknown as ChildProcess;
  });
  return { spawn: start, children };
}
const ok = (request: { id: number }): Reply => ({ id: request.id, ok: true, result: { 101: identity('first') } });

describe('owned Windows PowerShell session', () => {
  it('binds bounded unknown diagnostics to the same reply without changing identity values', async () => {
    let code = 'OPEN_PROCESS_5';
    const fake = fakePowerShell(request => ({ id: request.id, ok: true, result: { 101: 'unknown', 102: null }, diagnostics: { 101: code, 102: 'STALE_5', 999: 'FOREIGN_5' } }));
    const session = createWindowsPowerShellSession({ program: 'pwsh.exe', spawn: fake.spawn });
    const read = createWindowsProcessIdentityReader({ ...paths, exists: () => true, session });
    try {
      const first = await read([101, 102]);
      expect(first).toEqual({ 101: 'unknown', 102: null });
      expect(processIdentityDiagnostics(first)).toEqual({ 101: 'OPEN_PROCESS_5' });
      code = 'WAIT_AFTER_4294967295'; const second = await read([101, 102]);
      expect(processIdentityDiagnostics(second)).toEqual({ 101: 'WAIT_AFTER_4294967295' });
      expect(processIdentityDiagnostics(first)).toEqual({ 101: 'OPEN_PROCESS_5' });
      expect(JSON.stringify(first)).toBe('{"101":"unknown","102":null}');
      code = 'PRIVATE path/token'; const unsafe = await read([101, 102]);
      expect(processIdentityDiagnostics(unsafe)).toEqual({});
    } finally { session.close(); }
  });
  it('serves each role from one started process and sends DPAPI payloads as tab-separated data, never JSON', async () => {
    const lines: string[] = [];
    const identityFake = fakePowerShell((request) => ok(request));
    const identitySession = createWindowsPowerShellSession({ program: 'pwsh.exe', spawn: identityFake.spawn });
    expect(await identitySession.identity([101])).toEqual({ 101: identity('first') });
    expect(await identitySession.identity([101])).toEqual({ 101: identity('first') });
    expect(identityFake.spawn).toHaveBeenCalledTimes(1);
    const dpapiFake = fakePowerShell((request, line) => { lines.push(line); return { id: request.id, ok: true, result: 'cGF5bG9hZA==' }; });
    const dpapiSession = createWindowsPowerShellSession({ program: 'powershell.exe', role: 'dpapi', spawn: dpapiFake.spawn });
    expect(await dpapiSession.protect('cGxhaW4=')).toBe('cGF5bG9hZA==');
    expect(await dpapiSession.unprotect('cGF5bG9hZA==')).toBe('cGF5bG9hZA==');
    expect(dpapiFake.spawn).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['1\tprotect\tcGxhaW4=', '2\tunprotect\tcGF5bG9hZA==']);
    identitySession.close(); dpapiSession.close(); await new Promise((resolve) => setImmediate(resolve));
    expect([identityFake.children[0]?.ended, dpapiFake.children[0]?.ended]).toEqual([true, true]);
  });

  it('rejects invalid input and the wrong role without starting a process', async () => {
    const fake = fakePowerShell((request) => ok(request));
    const identitySession = createWindowsPowerShellSession({ program: 'pwsh.exe', spawn: fake.spawn });
    const dpapiSession = createWindowsPowerShellSession({ program: 'powershell.exe', role: 'dpapi', spawn: fake.spawn });
    for (const pids of [[], [0], [1.5], [2 ** 31], Array.from({ length: 65 }, (_, index) => index + 1)]) await expect(identitySession.identity(pids)).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_REQUEST_INVALID' });
    await expect(identitySession.protect('cGxhaW4=')).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_REQUEST_INVALID' });
    await expect(dpapiSession.identity([101])).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_REQUEST_INVALID' });
    await expect(dpapiSession.unprotect('cGxh\n1\tprotect\taW4=')).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_REQUEST_INVALID' });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('routes concurrent replies by id and fails every outstanding request when the process exits', async () => {
    const held: Request[] = [];
    const fake = fakePowerShell((request) => { held.push(request); return 'silent'; });
    const session = createWindowsPowerShellSession({ program: 'pwsh.exe', spawn: fake.spawn });
    const first = session.identity([101]); const second = session.identity([102]);
    await new Promise((resolve) => setImmediate(resolve));
    const stdout = fake.children[0]!.stdout;
    stdout.write(`${JSON.stringify({ id: held[1]!.id, ok: true, result: { 102: identity('second') } })}\n`);
    stdout.write(`${JSON.stringify({ id: held[0]!.id, ok: true, result: { 101: identity('first') } })}\n`);
    expect(await first).toEqual({ 101: identity('first') }); expect(await second).toEqual({ 102: identity('second') });
    const third = session.identity([103]); const fourth = session.identity([104]);
    await new Promise((resolve) => setImmediate(resolve));
    fake.children[0]!.exit();
    await expect(third).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_EXITED' }); await expect(fourth).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_EXITED' });
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    session.close();
  });

  it('ends the session on a timeout, malformed, unmatched or oversized reply, and starts a fresh one for the next request', async () => {
    let mode: 'silent' | 'garbage' | 'unmatched' | 'overflow' | 'ok' = 'silent';
    const fake = fakePowerShell((request) => mode === 'unmatched' ? { id: request.id + 1000, ok: true, result: {} } : mode === 'ok' ? ok(request) : mode);
    const session = createWindowsPowerShellSession({ program: 'pwsh.exe', spawn: fake.spawn, outputLimit: 1024, startupMs: 0 });
    await expect(session.identity([101], 20)).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_TIMEOUT' });
    mode = 'garbage'; await expect(session.identity([101])).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_INVALID_RESPONSE' });
    mode = 'unmatched'; await expect(session.identity([101])).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_INVALID_RESPONSE' });
    mode = 'overflow'; await expect(session.identity([101])).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_OUTPUT_LIMIT' });
    mode = 'ok'; expect(await session.identity([101])).toEqual({ 101: identity('first') });
    expect(fake.spawn).toHaveBeenCalledTimes(5);
    expect(fake.children.slice(0, 4).map((child) => child.killed)).toEqual([true, true, true, true]);
    session.close();
  });

  it('gives a starting session time to start, then holds later requests to their own budget', async () => {
    const held: Request[] = [];
    const fake = fakePowerShell((request) => { held.push(request); return 'silent'; });
    const session = createWindowsPowerShellSession({ program: 'powershell.exe', spawn: fake.spawn, startupMs: 2000 });
    // The first reply arrives after the request's own budget but within the start allowance: a slow start is not a hang.
    const first = session.identity([101], 30);
    await new Promise((resolve) => setTimeout(resolve, 120));
    fake.children[0]!.stdout.write(`${JSON.stringify({ id: held[0]!.id, ok: true, result: { 101: identity('first') } })}\n`);
    expect(await first).toEqual({ 101: identity('first') });
    // Once the session has answered, a silent request times out on its own budget.
    const started = performance.now();
    await expect(session.identity([102], 30)).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    session.close();
  });

  it('reports a start without pipes as unavailable without an uncaught error', async () => {
    const start = vi.fn(() => { const child = Object.assign(new EventEmitter(), { stdin: null, stdout: null, unref: (): void => undefined, kill: (): boolean => true }); queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }))); return child as unknown as ChildProcess; });
    const session = createWindowsPowerShellSession({ program: 'pwsh.exe', spawn: start });
    await expect(session.identity([101])).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_UNAVAILABLE' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps the session for a refused operation and closes stdin only once idle', async () => {
    const fake = fakePowerShell((request) => request.op === 'unprotect' ? { id: request.id, ok: false } : { id: request.id, ok: true, result: 'Y2lwaGVy' });
    const session = createWindowsPowerShellSession({ program: 'powershell.exe', role: 'dpapi', spawn: fake.spawn, idleMs: 10 });
    await expect(session.unprotect('bm90LXByb3RlY3RlZA==')).rejects.toMatchObject({ code: 'POWERSHELL_SESSION_DENIED' });
    expect(await session.protect('cGxhaW4=')).toBe('Y2lwaGVy');
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fake.children[0]).toMatchObject({ killed: false, ended: true });
    expect(await session.protect('cGxhaW4=')).toBe('Y2lwaGVy');
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    session.close();
  });

  it('shares one session per role and program, identity by default, so DPAPI never queues behind identity', () => {
    const program = 'C:\\shared-session-probe\\powershell.exe';
    expect(windowsPowerShellSession(program)).toBe(windowsPowerShellSession(program, 'identity'));
    expect(windowsPowerShellSession(program, 'dpapi')).toBe(windowsPowerShellSession(program, 'dpapi'));
    expect(windowsPowerShellSession(program, 'dpapi')).not.toBe(windowsPowerShellSession(program));
  });

  it('maps session failures to unknown identity through the reader', async () => {
    const failing = { identity: vi.fn(async () => { throw Object.assign(new Error('POWERSHELL_SESSION_TIMEOUT'), { code: 'POWERSHELL_SESSION_TIMEOUT' }); }) } as unknown as WindowsPowerShellSession;
    const failure = vi.fn();
    expect(await createWindowsProcessIdentityReader({ ...paths, exists: () => true, session: failing, onFailure: failure })([100, 101])).toEqual({ 100: 'unknown', 101: 'unknown' });
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'POWERSHELL_SESSION_TIMEOUT' }));
  });

  // Budget = the sessions' own bounds for one cold start each (5 s identity, 10 s DPAPI) plus warm requests; locally it runs in about a second.
  it.runIf(process.platform === 'win32')('answers real identity and DPAPI from one Windows PowerShell per role and ends them on close', async () => {
    const program = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const started: number[] = [];
    const spawnCounted = (command: string, args: readonly string[], options: object): ChildProcess => { const child = spawn(command, [...args], options); started.push(child.pid ?? 0); return child; };
    const identitySession = createWindowsPowerShellSession({ program, spawn: spawnCounted });
    const dpapiSession = createWindowsPowerShellSession({ program, role: 'dpapi', spawn: spawnCounted });
    const own = await identitySession.identity([process.pid]);
    expect(own[process.pid]).toMatchObject({ executable: process.execPath.toLowerCase() });
    expect(await identitySession.identity([process.pid])).toEqual(own);
    const plain = Buffer.from('ข้อความลับ secret', 'utf8').toString('base64');
    expect(await dpapiSession.unprotect(await dpapiSession.protect(plain))).toBe(plain);
    expect(started).toHaveLength(2);
    identitySession.close(); dpapiSession.close();
    for (const pid of started) {
      for (let attempt = 0; attempt < 100; attempt++) { try { process.kill(pid, 0); } catch { break; } await new Promise((resolve) => setTimeout(resolve, 20)); }
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 30_000);
});
