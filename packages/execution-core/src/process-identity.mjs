/* global process */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { childEnvironment } from './product-security.mjs';
const exec = promisify(execFile);
let windowsCurrentIdentity;
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
  // The current PID cannot be reused while this module is alive. Retaining its
  // exact first OS birth/executable avoids repeated PowerShell startup without
  // caching identities for child PIDs that can exit and be reused.
  const requested = windowsCurrentIdentity ? pids.filter((pid) => pid !== process.pid) : pids;
  const retained = windowsCurrentIdentity && pids.includes(process.pid) ? { [process.pid]: windowsCurrentIdentity } : {};
  if (!requested.length) return retained;
  const program = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$r=@{};foreach($n in @(${requested.join(',')})){try{$p=Get-Process -Id $n -ErrorAction Stop;$r[[string]$n]=@{birth=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.Path.ToLowerInvariant()}}catch{if(Get-Process -Id $n -ErrorAction SilentlyContinue){$r[[string]$n]='unknown'}else{$r[[string]$n]=$null}}};$r|ConvertTo-Json -Compress -Depth 3`;
  try {
    const result = await exec(program, ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, env: childEnvironment(), timeout: 5000, maxBuffer: 65536 });
    const observed = { ...retained, ...JSON.parse(result.stdout.trim()) };
    if (pids.includes(process.pid) && observed[process.pid] && typeof observed[process.pid] === 'object') windowsCurrentIdentity = observed[process.pid];
    return observed;
  }
  catch { return { ...retained, ...Object.fromEntries(requested.map((pid) => [pid, 'unknown'])) }; }
}
