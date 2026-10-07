/* global process */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { childEnvironment } from './product-security.mjs';
const exec = promisify(execFile);
export function sameProcessIdentity(expected, actual) {
  return !!expected && !!actual && typeof actual === 'object' && expected.birth === actual.birth && expected.executable === actual.executable;
}
/** Read-only OS proof. A reused live PID with a different birth/executable is absent for this ownership scope. */
export async function processIdentities(values) {
  const pids = [...new Set(values)].filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 64);
  if (!pids.length) return {};
  if (process.platform !== 'win32') return Object.fromEntries(pids.map((pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return [pid, { birth: `${readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}:${fields[19]}`, executable: realpathSync(`/proc/${pid}/exe`) }];
    } catch (error) { return [pid, error.code === 'ENOENT' || error.code === 'ESRCH' ? null : 'unknown']; }
  }));
  const program = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$r=@{};foreach($n in @(${pids.join(',')})){try{$p=Get-Process -Id $n -ErrorAction Stop;$r[[string]$n]=@{birth=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.Path.ToLowerInvariant()}}catch{if(Get-Process -Id $n -ErrorAction SilentlyContinue){$r[[string]$n]='unknown'}else{$r[[string]$n]=$null}}};$r|ConvertTo-Json -Compress -Depth 3`;
  try { const result = await exec(program, ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, env: childEnvironment(), timeout: 5000, maxBuffer: 65536 }); return JSON.parse(result.stdout.trim()); }
  catch { return Object.fromEntries(pids.map((pid) => [pid, 'unknown'])); }
}
