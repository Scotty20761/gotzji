/* global process, performance */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { childEnvironment } from './product-security.mjs';
const exec = promisify(execFile);
let windowsProbeFailureReported = false;
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
  const run = options.run ?? exec;
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
      const script = `$r=@{};foreach($n in @(${key})){try{$p=Get-Process -Id $n -ErrorAction Stop;$r[[string]$n]=@{birth=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.Path.ToLowerInvariant()}}catch{if(Get-Process -Id $n -ErrorAction SilentlyContinue){$r[[string]$n]='unknown'}else{$r[[string]$n]=$null}}};$r|ConvertTo-Json -Compress -Depth 3`;
      query = (async () => {
        const started = performance.now();
        try {
          const response = await run(program, ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, env: childEnvironment(), timeout: 5000, maxBuffer: 65536 });
          const parsed = JSON.parse(response.stdout.trim());
          const observed = Object.fromEntries(requested.map((pid) => {
            const value = parsed?.[pid];
            const proven = value && typeof value === 'object' && typeof value.birth === 'string' && value.birth && typeof value.executable === 'string' && value.executable;
            return [pid, value === null ? null : proven ? { birth: value.birth, executable: value.executable } : 'unknown'];
          }));
          if (observed[currentPid] && typeof observed[currentPid] === 'object') currentIdentity = observed[currentPid];
          return observed;
        } catch (error) {
          const code = /^[A-Z_]{1,40}$/u.test(error?.code ?? '') ? error.code : error?.killed ? 'KILLED' : 'INVALID_RESPONSE';
          try { options.onFailure?.({ code, elapsedMs: Math.round(performance.now() - started) }); }
          catch { /* Observational diagnostics cannot turn an unknown proof into a rejected query. */ }
          return Object.fromEntries(requested.map((pid) => [pid, 'unknown']));
        }
      })();
      pending.set(key, query);
      void query.then(() => { pending.delete(key); }, () => { pending.delete(key); });
    }
    return { ...retained, ...await query };
  };
}
