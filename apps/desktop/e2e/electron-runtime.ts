import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';

export function electronExecutablePath(desktopRoot: string, platform: NodeJS.Platform = process.platform): string {
  const executable = platform === 'win32' ? ['electron.exe']
    : platform === 'darwin' ? ['Electron.app', 'Contents', 'MacOS', 'Electron']
      : ['electron'];
  return path.join(desktopRoot, 'node_modules', 'electron', 'dist', ...executable);
}

// POSIX launchers use detached:true so cleanup owns this process group only.
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
      killer.once('error', reject);
      killer.once('close', () => resolve());
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const onExit = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('Timed out terminating E2E Electron process'));
    }, 10_000);
    child.once('exit', onExit);
  });
}

export async function terminateOwnedElectronProcess(child: ChildProcess, devToolsPort: number, timeoutMs = 10_000): Promise<void> {
  await terminateProcessTree(child);
  const deadline = Date.now() + timeoutMs;
  while (await loopbackPortReachable(devToolsPort)) {
    if (Date.now() >= deadline) {
      throw new Error(`DevTools port ${devToolsPort} remains reachable after owned Electron process ${child.pid ?? 'unknown'} stopped (exitCode=${String(child.exitCode)}, signalCode=${String(child.signalCode)}); refusing to terminate an unknown port owner`);
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
  }
}

function loopbackPortReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
