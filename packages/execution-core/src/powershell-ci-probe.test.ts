import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createWindowsPowerShellSession } from './process-identity.mjs';
const { childEnvironment } = await import('./product-security.mjs') as { childEnvironment: () => Record<string, string> };

// Temporary CI diagnostic: Windows PowerShell 5.1 sessions answered locally but never on the hosted runner.
// Every variant runs at once with its own budget and reports reply time and stderr; nothing here asserts on CI timing.
const legacy = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const modern = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const BUDGET = 25_000;
const children: ChildProcess[] = [];

function raw(name: string, program: string, script: string, env: Record<string, string | undefined>, endInput: boolean): Promise<string> {
  const started = Date.now();
  const child = spawn(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let out = ''; let err = '';
  child.stdout.on('data', (data: Buffer) => { out += data.toString('utf8'); });
  child.stderr.on('data', (data: Buffer) => { err += data.toString('utf8'); });
  child.stdin.on('error', () => undefined);
  if (endInput) child.stdin.end();
  return new Promise((resolve) => {
    const finish = (state: string): void => { clearTimeout(timer); clearInterval(poll); resolve(`${name}: ${state} after ${Date.now() - started}ms out=${JSON.stringify(out.slice(0, 120))} err=${JSON.stringify(err.slice(0, 400))}`); };
    const timer = setTimeout(() => finish('NO REPLY'), BUDGET);
    const poll = setInterval(() => { if (out.includes('\n')) finish('reply'); }, 20);
    child.once('error', (error) => finish(`spawn error ${(error as NodeJS.ErrnoException).code ?? ''}`));
    child.once('exit', (code) => setTimeout(() => finish(`exit ${String(code)}`), 50));
  });
}

async function session(name: string, program: string, role: 'identity' | 'dpapi', shape: { env?: 'full'; encoded?: boolean }): Promise<string> {
  let err = ''; const started = Date.now();
  const instance = createWindowsPowerShellSession({ program, role, spawn: (command: string, args: readonly string[], options: { env?: Record<string, string> }) => {
    const script = args[args.length - 1] ?? '';
    const finalArgs = shape.encoded ? [...args.slice(0, -2), '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : [...args];
    const child = spawn(command, finalArgs, { ...options, ...(shape.env === 'full' ? { env: process.env } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    child.stderr?.on('data', (data: Buffer) => { err += data.toString('utf8'); });
    return child;
  } });
  try {
    const value = role === 'identity' ? await instance.identity([process.pid], BUDGET) : await instance.protect('cGxhaW4=', BUDGET);
    return `${name}: reply after ${Date.now() - started}ms ${String(JSON.stringify(value)).slice(0, 60)} err=${JSON.stringify(err.slice(0, 400))}`;
  } catch (error) {
    return `${name}: ${String((error as { code?: string }).code)} after ${Date.now() - started}ms err=${JSON.stringify(err.slice(0, 400))}`;
  } finally { instance.close(); }
}

it.runIf(process.platform === 'win32' && !!process.env.CI)('reports how Windows PowerShell answers on this runner', async () => {
  const reduced = childEnvironment();
  const preamble = "$null='probe';$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.WriteLine('preamble');[Console]::Out.Flush()";
  const results = await Promise.all([
    raw('P1 5.1 write, stdin open, reduced env', legacy, "[Console]::Out.WriteLine('alive');[Console]::Out.Flush()", reduced, false),
    raw('P2 5.1 write, stdin closed, reduced env', legacy, "[Console]::Out.WriteLine('alive');[Console]::Out.Flush()", reduced, true),
    raw('P3 5.1 write, stdin open, full env', legacy, "[Console]::Out.WriteLine('alive');[Console]::Out.Flush()", process.env, false),
    raw('P4 5.1 encoding preamble, stdin open, reduced env', legacy, preamble, reduced, false),
    raw('P5 5.1 Add-Type, stdin closed, reduced env', legacy, "Add-Type -AssemblyName System.Security;[Console]::Out.WriteLine('added');[Console]::Out.Flush()", reduced, true),
    raw('P6 5.1 Add-Type, stdin closed, full env', legacy, "Add-Type -AssemblyName System.Security;[Console]::Out.WriteLine('added');[Console]::Out.Flush()", process.env, true),
    session('S1 5.1 identity session as shipped', legacy, 'identity', {}),
    session('S2 5.1 identity session, full env', legacy, 'identity', { env: 'full' }),
    session('S3 5.1 identity session, encoded command', legacy, 'identity', { encoded: true }),
    session('S4 5.1 dpapi session as shipped', legacy, 'dpapi', {}),
    session('S5 5.1 dpapi session, full env, encoded command', legacy, 'dpapi', { env: 'full', encoded: true }),
    session('S6 7 identity session as shipped', modern, 'identity', {}),
  ]);
  console.log(['[ps-probe] parent stdin TTY=' + String(process.stdin.isTTY) + ' PSModulePath entries=' + String((process.env.PSModulePath ?? '').split(';').filter(Boolean).length), ...results.map((line) => '[ps-probe] ' + line)].join('\n'));
  for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
  for (const child of children) for (let n = 0; n < 100 && child.exitCode === null && child.signalCode === null; n++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(children.filter((child) => child.exitCode === null && child.signalCode === null)).toHaveLength(0);
}, 60_000);
