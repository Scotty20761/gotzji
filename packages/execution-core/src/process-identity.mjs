/* global process, performance, setTimeout, clearTimeout */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { childEnvironment } from './product-security.mjs';
const exec = promisify(execFile);
export const WINDOWS_IDENTITY_STARTUP_MS = 20_000;
export const PROCESS_IDENTITY_REQUEST_MS = 5_000;
let windowsProbeFailureReported = false;
const identityDiagnostics = new WeakMap();
/** Observational codes belong to this exact result object and never change its identity proof. */
export function processIdentityDiagnostics(observation) { return { ...identityDiagnostics.get(observation) }; }
function retainIdentityDiagnostics(observation, details) {
  if (!observation || typeof observation !== 'object' || !details || typeof details !== 'object' || Array.isArray(details)) return;
  const selected = Object.entries(details).slice(0, 64).filter(([pid, code]) => /^[1-9]\d{0,9}$/u.test(pid) && Object.hasOwn(observation, pid) && observation[pid] === 'unknown'
    && typeof code === 'string' && code.length <= 80 && /^(?:(?:OPEN_PROCESS|PROCESS_TIMES|PROCESS_IMAGE|PROCESS_IMAGE_EMPTY|WAIT_BEFORE|WAIT_AFTER|EXCEPTION)_\d{1,10}|PROBE_(?:POWERSHELL_SESSION_[A-Z_]+|ENOENT|EACCES|EPERM|EPIPE|ETIMEDOUT|KILLED|INVALID_RESPONSE))$/u.test(code));
  if (selected.length) identityDiagnostics.set(observation, Object.freeze(Object.fromEntries(selected)));
}
const windowsReader = createWindowsProcessIdentityReader({ onFailure: ({ code, elapsedMs }) => {
  if (!windowsProbeFailureReported) {
    windowsProbeFailureReported = true;
    process.emitWarning(`Windows process identity probe failed: ${code}; elapsedMs=${elapsedMs}`, { code: 'WINDOWS_IDENTITY_PROBE_FAILED' });
  }
} });
export const UNPACKAGED_E2E_PROCESS_BIRTH = 'gotzji-unpackaged-e2e-fixture';
export function sameProcessIdentity(expected, actual) {
  return !!expected && !!actual && typeof actual === 'object' && expected.birth === actual.birth && expected.executable === actual.executable;
}
/** Read-only OS proof. A reused live PID with a different birth/executable is absent for this ownership scope. */
export async function processIdentities(values) {
  const pids = [...new Set(values)].filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 64);
  if (!pids.length) return {};
  if (process.platform === 'linux') return Object.fromEntries(pids.map((pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return [pid, { birth: `${readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}:${fields[19]}`, executable: realpathSync(`/proc/${pid}/exe`) }];
    } catch (error) { return [pid, error.code === 'ENOENT' || error.code === 'ESRCH' ? null : 'unknown']; }
  }));
  if (process.platform === 'darwin') return Object.fromEntries(await Promise.all(pids.map(async (pid) => {
    try {
      const result = await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { env: childEnvironment(), timeout: 5000, maxBuffer: 32768 });
      const line = result.stdout.trim();
      const match = /^(.{24})\s+(.+)$/u.exec(line);
      if (!match) return [pid, 'unknown'];
      const started = new Date(match[1]);
      if (Number.isNaN(started.getTime())) return [pid, 'unknown'];
      let executable = match[2].trim();
      if (!path.isAbsolute(executable)) {
        if (pid === process.pid) executable = process.execPath;
        else {
          const files = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { env: childEnvironment(), timeout: 5000, maxBuffer: 32768 });
          executable = files.stdout.split(/\r?\n/u).find((entry) => entry.startsWith('n/'))?.slice(1) ?? '';
        }
      }
      if (!path.isAbsolute(executable)) return [pid, 'unknown'];
      return [pid, { birth: started.toISOString(), executable: realpathSync(executable) }];
    } catch {
      try { process.kill(pid, 0); return [pid, 'unknown']; }
      catch (probe) { return [pid, probe.code === 'ESRCH' ? null : 'unknown']; }
    }
  })));
  if (process.platform !== 'win32') return Object.fromEntries(pids.map((pid) => [pid, 'unknown']));
  return windowsReader(pids);
}

/** OS proof stays fresh for child PIDs; only identical in-flight queries share a result. */
export function createWindowsProcessIdentityReader(options = {}) {
  const currentPid = options.currentPid ?? process.pid;
  const modern = path.win32.join(options.programFiles ?? process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  const legacy = path.win32.join(options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const program = (options.exists ?? existsSync)(modern) ? modern : legacy;
  // A one-shot executor stays injectable for tests; production reuses one owned identity session per program, resolved at query time.
  const run = options.run;
  const pending = new Map();
  let currentIdentity;
  return async (values) => {
    const pids = [...new Set(values)].filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 64);
    const requested = pids.filter((pid) => pid !== currentPid || !currentIdentity).sort((a, b) => a - b);
    const retained = currentIdentity && pids.includes(currentPid) ? { [currentPid]: currentIdentity } : {};
    if (!requested.length) return retained;
    const key = requested.join(',');
    let query = pending.get(key);
    if (!query) {
      const script = `${WINDOWS_IDENTITY_HELPER}\n${identityLoop(key)};$r|ConvertTo-Json -Compress -Depth 3`;
      query = (async () => {
        const started = performance.now();
        try {
          const parsed = run
            ? JSON.parse((await run(program, ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, env: childEnvironment(), timeout: PROCESS_IDENTITY_REQUEST_MS, maxBuffer: 65536 })).stdout.trim())
            : await (options.session ?? windowsPowerShellSession(program)).identity(requested);
          const observed = Object.fromEntries(requested.map((pid) => {
            const value = parsed?.[pid];
            const proven = value && typeof value === 'object' && typeof value.birth === 'string' && value.birth && typeof value.executable === 'string' && value.executable;
            return [pid, value === null ? null : proven ? { birth: value.birth, executable: value.executable } : 'unknown'];
          }));
          retainIdentityDiagnostics(observed, processIdentityDiagnostics(parsed));
          if (observed[currentPid] && typeof observed[currentPid] === 'object') currentIdentity = observed[currentPid];
          return observed;
        } catch (error) {
          const code = /^[A-Z_]{1,40}$/u.test(error?.code ?? '') ? error.code : error?.killed ? 'KILLED' : 'INVALID_RESPONSE';
          try { options.onFailure?.({ code, elapsedMs: Math.round(performance.now() - started) }); }
          catch { /* Observational diagnostics cannot turn an unknown proof into a rejected query. */ }
          const observed = Object.fromEntries(requested.map((pid) => [pid, 'unknown']));
          retainIdentityDiagnostics(observed, Object.fromEntries(requested.map(pid => [pid, `PROBE_${code}`])));
          return observed;
        }
      })();
      pending.set(key, query);
      void query.then(() => { pending.delete(key); }, () => { pending.delete(key); });
    }
    const observed = await query; const result = { ...retained, ...observed };
    retainIdentityDiagnostics(result, processIdentityDiagnostics(observed));
    return result;
  };
}

// Image and creation time belong to one handle, never Get-Process.Path's transient startup MainModule.
// A zero wait proves exit; failures remain unknown. Exit code 259 alone cannot prove that a process is live.
const WINDOWS_IDENTITY_HELPER = `Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
public static class GotzjiProcessIdentityNative {
  public static readonly Hashtable Diagnostics = new Hashtable();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", EntryPoint="QueryFullProcessImageNameW", ExactSpelling=true, CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static object Unknown(int pid, string stage, long code) { Diagnostics[pid.ToString(CultureInfo.InvariantCulture)] = stage + "_" + code.ToString(CultureInfo.InvariantCulture); return "unknown"; }
  static object FailedQuery(IntPtr process, int pid, string stage, long code) { return WaitForSingleObject(process, 0) == 0 ? null : Unknown(pid, stage, code); }
  public static object Read(int pid) {
    Diagnostics.Remove(pid.ToString(CultureInfo.InvariantCulture));
    IntPtr process = OpenProcess(0x1000 | 0x00100000, false, pid);
    if (process == IntPtr.Zero) { int code = Marshal.GetLastWin32Error(); return pid > 0 && code == 87 ? null : Unknown(pid, "OPEN_PROCESS", code); }
    try {
      uint before = WaitForSingleObject(process, 0);
      if (before == 0) return null;
      if (before != 258) return Unknown(pid, "WAIT_BEFORE", before);
      long created, exited, kernel, user;
      if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) return FailedQuery(process, pid, "PROCESS_TIMES", Marshal.GetLastWin32Error());
      uint length = 32768; StringBuilder image = new StringBuilder((int)length);
      if (!QueryFullProcessImageName(process, 0, image, ref length)) return FailedQuery(process, pid, "PROCESS_IMAGE", Marshal.GetLastWin32Error());
      uint after = WaitForSingleObject(process, 0);
      if (after == 0) return null;
      if (after != 258) return Unknown(pid, "WAIT_AFTER", after);
      if (length == 0) return Unknown(pid, "PROCESS_IMAGE_EMPTY", 0);
      return new Hashtable { { "birth", DateTime.FromFileTimeUtc(created).Ticks.ToString(CultureInfo.InvariantCulture) }, { "executable", image.ToString().ToLowerInvariant() } };
    } catch { return FailedQuery(process, pid, "EXCEPTION", 0); }
    finally { CloseHandle(process); }
  }
}
'@`;
function identityLoop(source) {
  return `$r=@{};[GotzjiProcessIdentityNative]::Diagnostics.Clear();foreach($v in @(${source})){try{$r[[string]$v]=[GotzjiProcessIdentityNative]::Read([int]$v)}catch{$r[[string]$v]='unknown'}}`;
}
// One owned PowerShell per role and program answers fixed requests over its own pipes, so a proof or a protected
// write no longer pays a cold PowerShell start. It receives data only, never script text, and it ends on stdin EOF,
// so it cannot outlive its parent. Identity and DPAPI never share a session, so neither can spend the other's
// budget, and identity sessions carry no DPAPI code. The marker lets a process census find any session that remains.
const SESSION_PREAMBLE = ["$null='gotzji-powershell-session'", "$ErrorActionPreference='Stop'", '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)'];
const SESSION_SCRIPTS = {
  identity: [...SESSION_PREAMBLE, `${WINDOWS_IDENTITY_HELPER}\n`,
    `while($null -ne ($line=[Console]::In.ReadLine())){$id=$null;try{$q=$line|ConvertFrom-Json;$id=[int64]$q.id;${identityLoop('$q.pids')};$o=@{id=$id;ok=$true;result=$r;diagnostics=[GotzjiProcessIdentityNative]::Diagnostics.Clone()}}catch{$o=@{id=$id;ok=$false}};[Console]::Out.WriteLine(($o|ConvertTo-Json -Compress -Depth 5));[Console]::Out.Flush()}`].join(';'),
  // Secrets never pass through a cmdlet, where module logging could record them: tab-separated requests, and
  // replies assembled by concatenation ([char]34 is a double quote). A failed System.Security load ends the session.
  dpapi: [...SESSION_PREAMBLE, 'Add-Type -AssemblyName System.Security', '$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser', '$d=[char]34',
    "while($null -ne ($line=[Console]::In.ReadLine())){$id='null';try{$parts=$line.Split([char]9,3);$id=[string][int64]::Parse($parts[0]);$bytes=[Convert]::FromBase64String($parts[2]);"
      + "if($parts[1] -eq 'protect'){$out=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope)}elseif($parts[1] -eq 'unprotect'){$out=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope)}else{throw 'operation'};"
      + "$reply='{'+$d+'id'+$d+':'+$id+','+$d+'ok'+$d+':true,'+$d+'result'+$d+':'+$d+[Convert]::ToBase64String($out)+$d+'}'}catch{$reply='{'+$d+'id'+$d+':'+$id+','+$d+'ok'+$d+':false}'};[Console]::Out.WriteLine($reply);[Console]::Out.Flush()}"].join(';'),
};
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const sessions = new Map();
export function windowsPowerShellSession(program, role = 'identity') {
  const key = `${role}:${program}`;
  let session = sessions.get(key);
  if (!session) { session = createWindowsPowerShellSession({ program, role }); sessions.set(key, session); }
  return session;
}
export function createWindowsPowerShellSession(options) {
  const role = options.role ?? 'identity';
  const script = SESSION_SCRIPTS[role];
  if (!script) throw new Error('POWERSHELL_SESSION_ROLE_INVALID');
  const start = options.spawn ?? spawn;
  const idleMs = options.idleMs ?? 15_000;
  const outputLimit = options.outputLimit ?? 262_144;
  // Windows PowerShell can take seconds to start on a cold or loaded machine. Requests sent before a session's first
  // reply also get this allowance; otherwise a slow start times out, restarts cold and never answers.
  const startupMs = options.startupMs ?? WINDOWS_IDENTITY_STARTUP_MS;
  const waiting = new Map();
  let child; let buffer = ''; let next = 1; let idle; let answered = false;
  const failure = (code) => Object.assign(new Error(code), { code });
  const fail = (code) => { for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(failure(code)); } waiting.clear(); };
  // Any anomaly ends this session and fails every outstanding request, so no reply can be matched to a later one.
  const stop = (code) => {
    const current = child; child = undefined; buffer = ''; clearTimeout(idle);
    if (current) { try { current.kill(); } catch { /* already exited */ } }
    fail(code);
  };
  const release = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { if (!waiting.size && child) { const current = child; child = undefined; current.stdin.end(); } }, idleMs);
    idle.unref?.();
  };
  const launch = () => {
    const current = start(options.program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: childEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] });
    // Listeners first: a failed spawn (EMFILE) can lack pipes and still emit 'error' on the next tick.
    current.on('error', () => { if (child === current) stop('POWERSHELL_SESSION_UNAVAILABLE'); });
    current.once('exit', () => { if (child === current) stop('POWERSHELL_SESSION_EXITED'); });
    if (!current.stdin || !current.stdout) { try { current.kill(); } catch { /* never started */ } throw failure('POWERSHELL_SESSION_UNAVAILABLE'); }
    current.stdin.on('error', () => { if (child === current) stop('POWERSHELL_SESSION_INPUT_FAILED'); });
    current.stdout.on('error', () => { if (child === current) stop('POWERSHELL_SESSION_UNAVAILABLE'); });
    // Unreferenced handles never keep the parent alive; each pending request's timer does until it is answered.
    current.unref(); current.stdin.unref?.(); current.stdout.unref?.();
    current.stdout.setEncoding('utf8');
    current.stdout.on('data', (data) => {
      if (child !== current) return;
      buffer += data;
      if (buffer.length > outputLimit) { stop('POWERSHELL_SESSION_OUTPUT_LIMIT'); return; }
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        let reply;
        try { reply = JSON.parse(line); } catch { stop('POWERSHELL_SESSION_INVALID_RESPONSE'); return; }
        const entry = waiting.get(reply?.id);
        if (!entry) { stop('POWERSHELL_SESSION_INVALID_RESPONSE'); return; }
        waiting.delete(reply.id); clearTimeout(entry.timer); answered = true;
        if (reply.ok === true) { if (role === 'identity') retainIdentityDiagnostics(reply.result, reply.diagnostics); entry.resolve(reply.result); } else entry.reject(failure('POWERSHELL_SESSION_DENIED'));
      }
      if (!waiting.size) release();
    });
    buffer = ''; answered = false; child = current;
  };
  const send = (line, timeoutMs) => new Promise((resolve, reject) => {
    clearTimeout(idle);
    try { if (!child) launch(); } catch { reject(failure('POWERSHELL_SESSION_UNAVAILABLE')); return; }
    const id = next++;
    waiting.set(id, { resolve, reject, timer: setTimeout(() => stop('POWERSHELL_SESSION_TIMEOUT'), timeoutMs + (answered ? 0 : startupMs)) });
    child.stdin.write(`${line(id)}\n`);
  });
  const invalid = () => Promise.reject(failure('POWERSHELL_SESSION_REQUEST_INVALID'));
  const dpapi = (operation, value, timeoutMs) => role !== 'dpapi' || typeof value !== 'string' || !BASE64.test(value) ? invalid() : send((id) => `${id}\t${operation}\t${value}`, timeoutMs);
  return {
    identity: (pids, timeoutMs = PROCESS_IDENTITY_REQUEST_MS) => role !== 'identity' || !Array.isArray(pids) || !pids.length || pids.length > 64 || !pids.every((pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff)
      ? invalid() : send((id) => JSON.stringify({ id, pids: [...pids] }), timeoutMs),
    protect: (value, timeoutMs = 10_000) => dpapi('protect', value, timeoutMs),
    unprotect: (value, timeoutMs = 10_000) => dpapi('unprotect', value, timeoutMs),
    // A busy child is killed so its late reply can never reach anyone; an idle one ends on stdin EOF.
    close: () => {
      const current = child; child = undefined; clearTimeout(idle); const busy = waiting.size > 0;
      fail('POWERSHELL_SESSION_CLOSED');
      if (current) { if (busy) { try { current.kill(); } catch { /* already exited */ } } else current.stdin.end(); }
    },
  };
}
