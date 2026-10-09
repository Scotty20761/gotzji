import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createWindowsPowerShellSession, createWindowsProcessIdentityReader, windowsPowerShellSession, type ProcessIdentity, type WindowsPowerShellSession, type WindowsProcessIdentityExecutor } from './process-identity.mjs';

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


type Request = { id: number; op: string; pids?: number[]; value?: string };
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
