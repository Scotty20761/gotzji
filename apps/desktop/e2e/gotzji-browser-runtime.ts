import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
export interface ChromeProcess { readonly pid: number; readonly parent: number; readonly birth: string; readonly name: string }
async function census(scope?: string, rootsOnly = false): Promise<ChromeProcess[]> {
  if (process.platform !== 'win32') throw new Error('NATIVE_CHROME_WINDOWS_REQUIRED');
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const filter = scope ? `$_.CommandLine -and $_.CommandLine.IndexOf(${quote(scope + path.sep)},[StringComparison]::OrdinalIgnoreCase) -ge 0` : '$true';
  const rootFilter = rootsOnly ? " -and $_.Name -eq 'chrome.exe' -and $_.CommandLine -notmatch '--type='" : '';
  const script = `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='chrome_crashpad_handler.exe'" | Where-Object { (${filter})${rootFilter} } | Select-Object @{Name='pid';Expression={$_.ProcessId}},@{Name='parent';Expression={$_.ParentProcessId}},@{Name='birth';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},@{Name='name';Expression={$_.Name}}); ConvertTo-Json -InputObject $rows -Compress`;
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.some(row => !row || !Number.isSafeInteger(row.pid) || row.pid < 1 || !Number.isSafeInteger(row.parent) || typeof row.birth !== 'string' || !row.birth)) throw new Error('NATIVE_CHROME_CENSUS_UNKNOWN');
  return rows as ChromeProcess[];
}
export async function ownedChromeProcesses(dataRoot: string, part: 'all' | 'product' = 'all'): Promise<ChromeProcess[]> {
  const temporaryRoot = await realpath(os.tmpdir()); const relative = path.relative(temporaryRoot, dataRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(dataRoot).startsWith('gotzji-desktop-e2e-') || await realpath(dataRoot) !== dataRoot) throw new Error('NATIVE_CHROME_FIXTURE_SCOPE_DENIED');
  const scope = part === 'product' ? path.join(dataRoot, 'runtime', 'browser-sessions') : dataRoot;
  const resolved = await realpath(scope).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (resolved !== undefined && resolved !== scope) throw new Error('NATIVE_CHROME_FIXTURE_SCOPE_DENIED');
  return census(scope);
}
export async function independentChromeRoots(): Promise<ChromeProcess[]> { return census(undefined, true); }
export async function assertChromeRootsPreserved(before: readonly ChromeProcess[]): Promise<void> {
  const after = await independentChromeRoots();
  if (before.some(prior => !after.some(current => current.pid === prior.pid && current.birth === prior.birth))) throw new Error('INDEPENDENT_CHROME_ROOT_CHANGED');
}
