import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProcessTreeTerminator, WindowsProcessTree } from '@lnwjud/process';
import { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';
import { assertGotzjiBrowserUrlScope, GotzjiBrowserProviderError, validateGotzjiBrowserScope } from './gotzji-browser-provider-policy.js';
import { nativeDigest } from './gotzji-native-contract.js';

export interface GotzjiOwnedBrowserDriver {
  readonly pid: number;
  readonly port: number;
  readonly profilePath: string;
  readonly browserId: string;
  readonly contextId: string;
  readonly profileId: string;
  readonly startUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly fixtureMode: boolean;
  readonly protocol: NodeBrowserCdpProtocol;
  verifyOwnership(): Promise<boolean>;
  stop(): Promise<{ readonly stopped: true; readonly pid: number }>;
}
/** Private standalone provider composition: new empty profile only; never reads/adopts user browser state. */
export async function startGotzjiOwnedBrowser(options: {
  readonly profileParent: string;
  readonly chromeExecutable: string;
  readonly fixtureUrl?: string;
  readonly startUrl?: string;
  readonly allowedOrigins?: readonly string[];
  readonly headless?: boolean;
}, signal?: AbortSignal): Promise<GotzjiOwnedBrowserDriver> {
  if (Object.keys(options).some((key) => !['profileParent', 'chromeExecutable', 'fixtureUrl', 'startUrl', 'allowedOrigins', 'headless'].includes(key))) throw new GotzjiBrowserProviderError('BROWSER_INPUT_INVALID');
  if (!path.isAbsolute(options.profileParent) || !path.isAbsolute(options.chromeExecutable)
    || !/(?:^|[\\/])gotzji(?:[\\/]|$)/iu.test(options.profileParent)
    || /(?:Google[\\/]Chrome|Microsoft[\\/]Edge)[\\/]User Data/iu.test(options.profileParent)) throw new GotzjiBrowserProviderError('BROWSER_PROFILE_SCOPE_DENIED');
  let startUrl = options.startUrl ?? 'about:blank';
  let allowedOrigins = options.allowedOrigins ? [...options.allowedOrigins] : [];
  const fixtureMode = options.fixtureUrl !== undefined;
  if (fixtureMode) {
    const url = new URL(options.fixtureUrl!);
    if (options.startUrl !== undefined || options.allowedOrigins !== undefined || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new GotzjiBrowserProviderError('BROWSER_FIXTURE_SCOPE_DENIED');
    startUrl = url.href; allowedOrigins = [url.origin];
  }
  validateGotzjiBrowserScope({ allowedOrigins, fixtureMode });
  assertGotzjiBrowserUrlScope(startUrl, { allowedOrigins, fixtureMode });
  if (signal?.aborted) throw new GotzjiBrowserProviderError('BROWSER_CANCELLED');
  await mkdir(options.profileParent, { recursive: true });
  const parent = await realpath(options.profileParent);
  if ((await lstat(options.profileParent)).isSymbolicLink() || path.resolve(parent).toLowerCase() !== path.resolve(options.profileParent).toLowerCase()) throw new GotzjiBrowserProviderError('BROWSER_PROFILE_SCOPE_DENIED');
  const executable = await realpath(options.chromeExecutable);
  if (!(await lstat(executable)).isFile() || path.basename(executable).toLowerCase() !== 'chrome.exe') throw new GotzjiBrowserProviderError('BROWSER_EXECUTABLE_UNSUPPORTED');
  const profilePath = await mkdtemp(path.join(parent, 'gotzji-browser-provider-'));
  const contextId = randomUUID();
  const child = spawn(executable, ['--remote-debugging-port=0', `--user-data-dir=${profilePath}`, '--no-first-run', '--no-default-browser-check',
    ...(options.headless === true ? ['--headless=new', '--window-size=1024,768'] : []), startUrl],
  { shell: false, windowsHide: true, stdio: 'ignore' });
  let launchError = false;
  child.once('error', () => { launchError = true; });
  const terminator = process.platform === 'win32' ? new WindowsProcessTree({ taskkill: (selectedPid): Promise<number | null> => new Promise((resolve, reject) => {
    execFile('taskkill', ['/PID', String(selectedPid), '/T', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Owned browser tree stop failed (${String(error.code)}): ${stdout} ${stderr}`)); else resolve(0);
    });
  }) }) : createProcessTreeTerminator();
  const pid = child.pid;
  const coordination = path.join(profilePath, 'DevToolsActivePort');
  try {
    let contents = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new GotzjiBrowserProviderError('BROWSER_CANCELLED');
      if (pid === undefined || launchError || !alive(child)) throw new GotzjiBrowserProviderError('BROWSER_START_FAILED');
      try { contents = await readFile(coordination, 'utf8'); if (/^\d+\r?\n\/devtools\/browser\/[a-f0-9-]+/u.test(contents)) break; } catch { /* Only the fresh owned profile coordination file is probed. */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    const port = Number(contents.split(/\r?\n/u)[0]);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !contents.includes('/devtools/browser/')) throw new GotzjiBrowserProviderError('BROWSER_START_TIMEOUT');
    const protocol = new NodeBrowserCdpProtocol({ port, profileDir: profilePath, chromeExecutable: executable });
    const verifyOwnership = async (): Promise<boolean> => {
      if (!alive(child) || launchError || child.pid !== pid) return false;
      try { return await readFile(coordination, 'utf8') === contents; } catch { return false; }
    };
    if (!await verifyOwnership() || !(await protocol.status(signal)).ready) throw new GotzjiBrowserProviderError('BROWSER_SESSION_UNVERIFIED');
    return { pid: pid!, port, profilePath, browserId: `gotzji-owned-chrome:${contextId}`, contextId,
      profileId: nativeDigest(profilePath.toLowerCase()), startUrl, allowedOrigins: Object.freeze(allowedOrigins), fixtureMode, protocol, verifyOwnership,
      stop: async (): Promise<{ readonly stopped: true; readonly pid: number }> => {
        if (!await verifyOwnership()) throw new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown');
        if (process.platform === 'win32') {
          const tabs = await protocol.listTabs();
          if (tabs.length < 1) throw new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown');
          const stopped = await stopGotzjiOwnedBrowserProcess({ pid: pid!, protocol, tabId: tabs[0]!.id }, verifyOwnership);
          if (alive(child)) throw new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown');
          return stopped;
        }
        try { await terminator.stop(child, pid!); } catch (cause) { const error = new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown'); error.cause = cause; throw error; }
        if (alive(child)) throw new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown');
        return { stopped: true, pid: pid! };
      } };
  } catch (error) {
    if (pid !== undefined && alive(child)) {
      try { await terminator.stop(child, pid); } catch { throw new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown'); }
    }
    throw error instanceof GotzjiBrowserProviderError ? error : new GotzjiBrowserProviderError('BROWSER_START_FAILED');
  }
}
function alive(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode === null; }
/** Restored sessions use a pinned PID birth, never an ambient process. Host checks job/resource ownership before this control action. */
export async function stopGotzjiOwnedBrowserProcess(session: { readonly pid: number; readonly pidBirth?: string; readonly tabId: string; readonly protocol: NodeBrowserCdpProtocol },
  verifyOwnedSession: () => Promise<boolean>): Promise<{ readonly stopped: true; readonly pid: number }> {
  if (process.platform !== 'win32' || typeof verifyOwnedSession !== 'function' || !Number.isSafeInteger(session.pid) || session.pid < 1 || !session.tabId || !await verifyOwnedSession()) throw new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown');
  const prior = await windowsProcessSnapshot(); const root = prior.find((entry) => entry.pid === session.pid);
  if (!root || (session.pidBirth !== undefined && root.start !== session.pidBirth)) throw new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown');
  const owned = new Map<number, string>([[root.pid, root.start]]); let changed = true;
  while (changed) { changed = false; for (const entry of prior) if (owned.has(entry.parent) && !owned.has(entry.pid)) { owned.set(entry.pid, entry.start); changed = true; } }
  if (!await verifyOwnedSession()) throw new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown');
  try { await session.protocol.request(session.tabId, 'Browser.close', {}); } catch { /* A closed response socket is resolved only by native inspection below. */ }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = await windowsProcessSnapshot();
    if (!current.some((entry) => owned.get(entry.pid) === entry.start)) return { stopped: true, pid: session.pid };
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown');
}
async function windowsProcessSnapshot(): Promise<readonly { pid: number; parent: number; start: string }[]> {
  return new Promise((resolve, reject) => {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name="Start";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown')); return; }
      try {
        const rows = JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number; Start: string }[];
        if (!Array.isArray(rows) || rows.some((row) => !Number.isSafeInteger(row.ProcessId) || typeof row.Start !== 'string' || !row.Start)) throw new Error('Invalid native process identity census');
        resolve(rows.map((row) => ({ pid: row.ProcessId, parent: row.ParentProcessId, start: row.Start })));
      } catch { reject(new GotzjiBrowserProviderError('BROWSER_TERMINATION_UNVERIFIED', 'unknown')); }
    });
  });
}
