import { spawn, type ChildProcess } from 'node:child_process';
/* global setTimeout */
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { processIdentities, sameProcessIdentity, type ProcessIdentity } from './process-identity.mjs';

let qualificationRoot = path.resolve(process.env.LOCALAPPDATA ?? process.cwd(), 'gotzji', 'qualification');
interface OwnedHelper { readonly child: ChildProcess; readonly terminal: Promise<void>; identity?: ProcessIdentity; spawnError?: Error; stdout: string; stderr: string }
const roots: string[] = []; const helpers: OwnedHelper[] = [];
afterEach(async () => {
  let cleanupProved = true;
  for (const helper of helpers.splice(0)) {
    try { await stopHelper(helper); } catch { cleanupProved = false; }
  }
  if (!cleanupProved) throw new Error(`Synthetic helper absence unproved; retained roots: ${roots.join(', ')}`);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const embeddedCSharp = (source: string): string => {
  const value = /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1];
  if (!value) throw new Error('Embedded native helper source missing');
  return value;
};
const journalHelper = (source: string): string => /public static class GotzjiNativeEvidenceJournal \{[\s\S]*?\n\}\n(?=public static class Gotzji)/u.exec(embeddedCSharp(source))?.[0] ?? '';
const helperIdentityTimeoutMs = 5_000;
// The prior CI run exhausted the 5s identity-file wait after 6.57s total with stderr discarded. This bounded allowance keeps phase/exit diagnostics available on loaded hosts.
const nativeLaunchReadyTimeoutMs = 12_000;
function observeHelper(child: ChildProcess, tracked = true): OwnedHelper {
  let resolveTerminal!: () => void;
  const helper: OwnedHelper = { child, terminal: new Promise<void>((resolve) => { resolveTerminal = resolve; }), stdout: '', stderr: '' };
  const append = (current: string, chunk: unknown): string => (current + String(chunk)).slice(-4_096);
  child.stdout?.on('data', (chunk: unknown) => { helper.stdout = append(helper.stdout, chunk); });
  child.stderr?.on('data', (chunk: unknown) => { helper.stderr = append(helper.stderr, chunk); });
  child.once('error', (error) => { helper.spawnError = error; });
  child.once('close', () => resolveTerminal());
  if (tracked) helpers.push(helper);
  return helper;
}
function readHelperPhase(helper: OwnedHelper): string | undefined {
  const phases = [...helper.stdout.matchAll(/^\[fixture-phase\](.+)$/gmu)];
  return phases.at(-1)?.[1]?.trim() || undefined;
}
function isProcessIdentity(value: unknown): value is ProcessIdentity {
  return value !== null && typeof value === 'object' && typeof (value as ProcessIdentity).birth === 'string' && typeof (value as ProcessIdentity).executable === 'string';
}
function provesProcessAbsent(expected: ProcessIdentity, actual: unknown): boolean {
  return actual === null || (isProcessIdentity(actual) && !sameProcessIdentity(expected, actual));
}
function readinessError(label: string, reason: string, helper: OwnedHelper | undefined, phase: string): Error {
  const exit = helper ? `${helper.child.exitCode ?? 'running'}/${helper.child.signalCode ?? 'no-signal'}` : 'not-observed';
  const stderr = helper?.stderr.trim() || '<empty>';
  const spawn = helper?.spawnError?.message ? `; spawn=${helper.spawnError.message}` : '';
  return new Error(`${label} ${reason}; phase=${phase}; exit=${exit}${spawn}; stderr=${stderr}`);
}
async function waitFor<T>(label: string, read: () => Promise<T | undefined>, options: { timeoutMs: number; helper?: OwnedHelper; phase?: () => Promise<string | undefined>; allowExit?: boolean }): Promise<T> {
  const deadline = Date.now() + options.timeoutMs; let phase = 'not-published';
  while (Date.now() < deadline) {
    phase = (await options.phase?.()) ?? phase;
    if (options.helper?.spawnError) { await Promise.race([options.helper.terminal,new Promise((resolve)=>setTimeout(resolve,250))]); throw readinessError(label, 'failed to spawn', options.helper, phase); }
    if (!options.allowExit && options.helper && (options.helper.child.exitCode !== null || options.helper.child.signalCode !== null)) { await Promise.race([options.helper.terminal,new Promise((resolve)=>setTimeout(resolve,250))]); phase = (await options.phase?.()) ?? phase; throw readinessError(label, 'exited before readiness', options.helper, phase); }
    const value = await read(); if (value !== undefined) return value;
    const delay = new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    await (options.helper && !options.allowExit ? Promise.race([delay, options.helper.terminal]) : delay);
  }
  phase = (await options.phase?.()) ?? phase;
  throw readinessError(label, `timed out after ${options.timeoutMs}ms`, options.helper, phase);
}
async function registerHelper(helper: OwnedHelper): Promise<OwnedHelper> {
  helper.identity = await waitFor('PowerShell helper identity', async () => { const value = (await processIdentities([helper.child.pid!]))[helper.child.pid!]; return value && value !== 'unknown' ? value : undefined; }, { timeoutMs: helperIdentityTimeoutMs, helper });
  return helper;
}
async function stopHelper(helper: OwnedHelper): Promise<void> {
  if (!helper.identity) throw new Error('Synthetic helper identity was not captured');
  if (helper.child.exitCode === null) { try { helper.child.kill(); } catch { /* exact child already ended */ } }
  await waitFor('PowerShell helper absence', async () => provesProcessAbsent(helper.identity!, (await processIdentities([helper.child.pid!]))[helper.child.pid!]) ? true : undefined, { timeoutMs: helperIdentityTimeoutMs, helper, allowExit: true });
}
async function stopTrackedHelper(helper: OwnedHelper): Promise<void> {
  await stopHelper(helper);
  const index = helpers.indexOf(helper); if (index >= 0) helpers.splice(index, 1);
}

describe('Windows native suspended launch ownership', () => {
  it.runIf(process.platform === 'win32')('persists identity before resume and closes the exact child plus descendant with its job owner', async () => {
    await mkdir(qualificationRoot, { recursive: true }); qualificationRoot = await realpath(qualificationRoot);
    const root = await realpath(await mkdtemp(path.join(qualificationRoot, 'native-job-launch-'))); roots.push(root);
    const provider = await readFile(fileURLToPath(new URL('../../../apps/desktop/build/gotzji-cad-session-provider.ps1', import.meta.url)), 'utf8');
    const csharp = embeddedCSharp(provider);
    expect(csharp).toContain('LaunchInKillJob'); expect(csharp).toContain('0x0002000D');
    const marker = path.join(root, 'child-started.txt'); const descendantFile = path.join(root, 'descendant.txt');
    const identityFile = path.join(root, 'identity.json'); const approval = path.join(root, 'resume.txt');
    const fixture = path.join(root, 'fixture.mjs'); const descendant = path.join(root, 'descendant.mjs'); const launcher = path.join(root, 'launcher.ps1');
    await writeFile(descendant, 'setInterval(()=>{},1000);');
    await writeFile(fixture, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');const child=spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true});writeFileSync(${JSON.stringify(descendantFile)},String(child.pid));setInterval(()=>{},1000);`);
    await writeFile(launcher, `$ErrorActionPreference='Stop'\nfunction Write-Phase([string]$value){[Console]::Out.WriteLine('[fixture-phase]'+$value);[Console]::Out.Flush()}\ntry{\nWrite-Phase 'add-type:start'\nAdd-Type -TypeDefinition @'\n${csharp}\n'@\nWrite-Phase 'add-type:complete'\nWrite-Phase 'launch:start'\n$launch=[GotzjiCadSessionWindow]::LaunchInKillJob(${quote(process.execPath)},@(${quote(fixture)}),${quote(root)})\nWrite-Phase 'launch:complete'\n@{pid=$launch.Pid;birth=[string]$launch.Birth;executable=$launch.Executable}|ConvertTo-Json -Compress|Set-Content -LiteralPath ${quote(identityFile)} -Encoding UTF8\nWrite-Phase 'identity:written'\nwhile(-not(Test-Path -LiteralPath ${quote(approval)})){Start-Sleep -Milliseconds 20}\nWrite-Phase 'resume:start'\n$launch.Resume()\nWrite-Phase 'resumed'\nwhile($true){Start-Sleep -Seconds 1}\n}catch{Write-Phase ('failed:'+$_.Exception.Message);[Console]::Error.WriteLine(($_|Out-String));exit 17}\n`);
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = observeHelper(spawn(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',launcher], { windowsHide: true, stdio: ['ignore','pipe','pipe'] }));
    try {
      await registerHelper(helper);
      const identity = await waitFor('suspended child identity', async () => { try { const value=JSON.parse((await readFile(identityFile, 'utf8')).replace(/^\uFEFF/u,'')) as { pid: number; birth: string; executable: string }; return { ...value, executable: value.executable.toLowerCase() }; } catch { return undefined; } }, { timeoutMs: nativeLaunchReadyTimeoutMs, helper, phase: async () => readHelperPhase(helper) });
      expect(await readFile(identityFile, 'utf8')).toContain(String(identity.pid));
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(approval, 'resume'); await waitFor('resumed child marker', async () => { try { return await readFile(marker, 'utf8'); } catch { return undefined; } }, { timeoutMs: helperIdentityTimeoutMs, helper, phase: async () => readHelperPhase(helper) });
      const descendantPid = await waitFor('descendant identity', async () => { try { const value = Number(await readFile(descendantFile, 'utf8')); return Number.isSafeInteger(value) && value > 0 ? value : undefined; } catch { return undefined; } }, { timeoutMs: helperIdentityTimeoutMs, helper, phase: async () => readHelperPhase(helper) });
      const before = await processIdentities([identity.pid, descendantPid]);const descendantIdentity=before[descendantPid];
      expect(sameProcessIdentity(identity, before[identity.pid])).toBe(true);if(!isProcessIdentity(descendantIdentity))throw new Error(`Descendant identity unproved: ${String(descendantIdentity)}`);
      await stopTrackedHelper(helper);
      await waitFor('job-owned child and descendant absence', async () => {
        const current = await processIdentities([identity.pid, descendantPid]);
        const childGone = provesProcessAbsent(identity, current[identity.pid]);
        const descendantGone = provesProcessAbsent(descendantIdentity, current[descendantPid]);
        return childGone && descendantGone ? true : undefined;
      }, { timeoutMs: helperIdentityTimeoutMs });
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); roots.splice(roots.indexOf(root), 1);
    } finally {
      if (helpers.includes(helper)) await stopTrackedHelper(helper);
    }
  }, 20_000);
  it.runIf(process.platform === 'win32')('refuses a hard-linked identity journal before changing owner bytes', async () => {
    await mkdir(qualificationRoot, { recursive: true }); qualificationRoot = await realpath(qualificationRoot);
    const root = await realpath(await mkdtemp(path.join(qualificationRoot, 'native-journal-link-'))); roots.push(root);
    const effectRoot = path.join(root, 'effects'); await mkdir(effectRoot);
    const ownerFile = path.join(root, 'owner.txt'); const journal = path.join(effectRoot, 'native-process-identities.jsonl');
    await writeFile(ownerFile, 'owner bytes must remain exact'); await link(ownerFile, journal);
    const cadProvider = await readFile(fileURLToPath(new URL('../../../apps/desktop/build/gotzji-cad-session-provider.ps1', import.meta.url)), 'utf8');
    const officeProvider = await readFile(fileURLToPath(new URL('../../../apps/desktop/build/gotzji-native-office.ps1', import.meta.url)), 'utf8');
    expect(journalHelper(cadProvider)).toBe(journalHelper(officeProvider));
    const probe = path.join(root, 'journal-probe.ps1');
    await writeFile(probe, `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${embeddedCSharp(cadProvider)}\n'@\ntry{[GotzjiNativeEvidenceJournal]::Append(${quote(journal)},${quote(effectRoot)},"forbidden mutation"+[Environment]::NewLine);exit 0}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 17}\n`);
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = observeHelper(spawn(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',probe], { windowsHide: true, stdio: ['ignore','pipe','pipe'] }));
    try {
      await registerHelper(helper); await helper.terminal; await stopTrackedHelper(helper);
      expect(helper.child.exitCode).toBe(17); expect(await readFile(ownerFile, 'utf8')).toBe('owner bytes must remain exact'); expect(await readFile(journal, 'utf8')).toBe('owner bytes must remain exact');
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); roots.splice(roots.indexOf(root), 1);
    } finally {
      if (helpers.includes(helper)) await stopTrackedHelper(helper);
    }
  }, 20_000);

  it.runIf(process.platform === 'win32')('waits for delayed readiness and reports an early helper exit with its last phase', async () => {
    let delayed: string | undefined; setTimeout(() => { delayed = 'published'; }, 30);
    await expect(waitFor('delayed publication', async () => delayed, { timeoutMs: 500, phase: async () => 'publish:waiting' })).resolves.toBe('published');
    const helper = observeHelper(spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(17),20)'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] }), false);
    try {
      await expect(waitFor('early exit probe', async () => undefined, { timeoutMs: 1_000, helper, phase: async () => 'launch:start' })).rejects.toThrow(/early exit probe exited before readiness; phase=launch:start; exit=17\/no-signal/u);
    } finally {
      if (helper.child.exitCode === null) { helper.child.kill(); await helper.terminal; }
    }
  });

  it('never treats an unknown process identity as proof of absence', () => {
    const expected:ProcessIdentity={birth:'expected-birth',executable:'expected.exe'};
    expect(provesProcessAbsent(expected,'unknown')).toBe(false);expect(provesProcessAbsent(expected,undefined)).toBe(false);
    expect(provesProcessAbsent(expected,null)).toBe(true);expect(provesProcessAbsent(expected,{birth:'other-birth',executable:'expected.exe'})).toBe(true);
  });
});
