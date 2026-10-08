import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
const { childEnvironment } = await import('./product-security.mjs') as { childEnvironment: () => Record<string, string> };

// Temporary CI diagnostic, round 2. Round 1 showed Windows PowerShell 5.1 hangs past 25 s at its first module-loaded
// cmdlet (Add-Type) with the reduced child environment and answers in about 2 s with the full one. This round adds one
// variable group at a time to find the missing one, and checks .NET-only scripts that load no module. Names only, no values.
const legacy = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const BUDGET = 25_000;
const children: ChildProcess[] = [];

function run(name: string, script: string, env: Record<string, string | undefined>): Promise<string> {
  const started = Date.now();
  const child = spawn(legacy, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let out = ''; let err = '';
  child.stdout.on('data', (data: Buffer) => { out += data.toString('utf8'); });
  child.stderr.on('data', (data: Buffer) => { err += data.toString('utf8'); });
  child.stdin.on('error', () => undefined);
  child.stdin.end();
  return new Promise((resolve) => {
    const finish = (state: string): void => { clearTimeout(timer); clearInterval(poll); resolve(`${name}: ${state} after ${Date.now() - started}ms out=${JSON.stringify(out.trim().slice(0, 40))} err=${JSON.stringify(err.slice(0, 160))}`); };
    const timer = setTimeout(() => finish('NO REPLY'), BUDGET);
    const poll = setInterval(() => { if (out.includes('\n')) finish('reply'); }, 20);
    child.once('error', (error) => finish(`spawn error ${(error as NodeJS.ErrnoException).code ?? ''}`));
    child.once('exit', (code) => setTimeout(() => finish(`exit ${String(code)}`), 50));
  });
}

it.runIf(process.platform === 'win32' && !!process.env.CI)('reports which environment Windows PowerShell 5.1 needs on this runner', async () => {
  const reduced = childEnvironment();
  const kept = new Set(Object.keys(reduced).map((key) => key.toUpperCase()));
  const missing = Object.keys(process.env).filter((key) => !kept.has(key.toUpperCase())).sort();
  const pick = (...names: string[]): Record<string, string | undefined> => ({ ...reduced, ...Object.fromEntries(Object.keys(process.env).filter((key) => names.includes(key.toUpperCase())).map((key) => [key, process.env[key]])) });
  const without = (...names: string[]): Record<string, string | undefined> => Object.fromEntries(Object.entries(process.env).filter(([key]) => !names.includes(key.toUpperCase())));
  const addType = "Add-Type -AssemblyName System.Security;[Console]::Out.WriteLine('added');[Console]::Out.Flush()";
  const results = await Promise.all([
    run('V0 reduced', addType, reduced),
    run('V1 reduced + PSModulePath', addType, pick('PSMODULEPATH')),
    run('V2 reduced + SystemDrive', addType, pick('SYSTEMDRIVE')),
    run('V3 reduced + user and computer names', addType, pick('COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'USERDNSDOMAIN', 'LOGONSERVER')),
    run('V4 reduced + processor and OS', addType, pick('PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'OS')),
    run('V5 reduced + ComSpec', addType, pick('COMSPEC')),
    run('V6 reduced + shared folders', addType, pick('ALLUSERSPROFILE', 'PUBLIC', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'PROGRAMW6432', 'DRIVERDATA')),
    run('V7 full minus PSModulePath', addType, without('PSMODULEPATH')),
    run('V8 full', addType, process.env),
    run('V9 reduced, .NET assembly load', "[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');$s=[Security.Cryptography.DataProtectionScope]::CurrentUser;[Console]::Out.WriteLine([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([byte[]](1,2,3),$null,$s)).Length);[Console]::Out.Flush()", reduced),
    run('V10 reduced, .NET process identity', "$p=[Diagnostics.Process]::GetProcessById($PID);[Console]::Out.WriteLine($p.StartTime.ToUniversalTime().Ticks.ToString()+' '+$p.MainModule.FileName.Length);[Console]::Out.Flush()", reduced),
    run('V11 reduced, Get-Process cmdlet', "$p=Get-Process -Id $PID;[Console]::Out.WriteLine($p.Id);[Console]::Out.Flush()", reduced),
  ]);
  console.log(['[ps-probe2] missing from reduced env: ' + missing.join(','), ...results.map((line) => '[ps-probe2] ' + line)].join('\n'));
  for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
  for (const child of children) for (let n = 0; n < 100 && child.exitCode === null && child.signalCode === null; n++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(children.filter((child) => child.exitCode === null && child.signalCode === null)).toHaveLength(0);
}, 60_000);
