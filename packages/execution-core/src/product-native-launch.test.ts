import { spawn, type ChildProcess } from 'node:child_process';
/* global setTimeout */
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { processIdentities, sameProcessIdentity, type ProcessIdentity } from './process-identity.mjs';

let qualificationRoot = path.resolve(process.env.LOCALAPPDATA ?? process.cwd(), 'gotzji', 'qualification');
interface OwnedHelper { readonly child: ChildProcess; identity?: ProcessIdentity }
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
async function waitFor<T>(read: () => Promise<T | undefined>, attempts = 200): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) { const value = await read(); if (value !== undefined) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error('Synthetic native launch fixture timed out');
}
async function registerHelper(child: ChildProcess): Promise<OwnedHelper> {
  const helper: OwnedHelper = { child }; helpers.push(helper);
  helper.identity = await waitFor(async () => { const value = (await processIdentities([child.pid!]))[child.pid!]; return value && value !== 'unknown' ? value : undefined; });
  return helper;
}
async function stopHelper(helper: OwnedHelper): Promise<void> {
  if (!helper.identity) throw new Error('Synthetic helper identity was not captured');
  if (helper.child.exitCode === null) { try { helper.child.kill(); } catch { /* exact child already ended */ } }
  await waitFor(async () => !sameProcessIdentity(helper.identity, (await processIdentities([helper.child.pid!]))[helper.child.pid!]) ? true : undefined);
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
    await writeFile(launcher, `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${csharp}\n'@\n$launch=[GotzjiCadSessionWindow]::LaunchInKillJob(${quote(process.execPath)},@(${quote(fixture)}),${quote(root)})\n@{pid=$launch.Pid;birth=[string]$launch.Birth;executable=$launch.Executable}|ConvertTo-Json -Compress|Set-Content -LiteralPath ${quote(identityFile)} -Encoding UTF8\nwhile(-not(Test-Path -LiteralPath ${quote(approval)})){Start-Sleep -Milliseconds 20}\n$launch.Resume()\nwhile($true){Start-Sleep -Seconds 1}\n`);
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = await registerHelper(spawn(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',launcher], { windowsHide: true, stdio: 'ignore' }));
    const identity = await waitFor(async () => { try { const value=JSON.parse((await readFile(identityFile, 'utf8')).replace(/^\uFEFF/u,'')) as { pid: number; birth: string; executable: string }; return { ...value, executable: value.executable.toLowerCase() }; } catch { return undefined; } });
    expect(await readFile(identityFile, 'utf8')).toContain(String(identity.pid));
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(approval, 'resume'); await waitFor(async () => { try { return await readFile(marker, 'utf8'); } catch { return undefined; } });
    const descendantPid = await waitFor(async () => { try { const value = Number(await readFile(descendantFile, 'utf8')); return Number.isSafeInteger(value) && value > 0 ? value : undefined; } catch { return undefined; } });
    const before = await processIdentities([identity.pid, descendantPid]);
    expect(sameProcessIdentity(identity, before[identity.pid])).toBe(true); expect(before[descendantPid]).not.toBeNull();
    await stopHelper(helper); helpers.splice(helpers.indexOf(helper), 1);
    await waitFor(async () => {
      const current = await processIdentities([identity.pid, descendantPid]);
      const childGone = !sameProcessIdentity(identity, current[identity.pid]);
      const descendantGone = current[descendantPid] === null || (typeof before[descendantPid] === 'object' && !sameProcessIdentity(before[descendantPid] as ProcessIdentity, current[descendantPid]));
      return childGone && descendantGone ? true : undefined;
    });
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); roots.splice(roots.indexOf(root), 1);
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
    const helper = await registerHelper(spawn(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',probe], { windowsHide: true, stdio: 'ignore' }));
    await waitFor(async () => helper.child.exitCode !== null ? true : undefined); await stopHelper(helper); helpers.splice(helpers.indexOf(helper), 1);
    expect(helper.child.exitCode).toBe(17); expect(await readFile(ownerFile, 'utf8')).toBe('owner bytes must remain exact'); expect(await readFile(journal, 'utf8')).toBe('owner bytes must remain exact');
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); roots.splice(roots.indexOf(root), 1);
  }, 20_000);
});
