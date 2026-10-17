import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { electronExecutablePath, terminateOwnedElectronProcess, terminateProcessTree } from '../e2e/electron-runtime.js';

describe('E2E Electron runtime', () => {
  it.each([
    ['win32', ['electron.exe']],
    ['linux', ['electron']],
    ['darwin', ['Electron.app', 'Contents', 'MacOS', 'Electron']],
  ] as const)('resolves the %s distribution under a checkout containing spaces', (platform, executable) => {
    const desktopRoot = path.resolve('checkout with spaces', 'apps', 'desktop');
    expect(electronExecutablePath(desktopRoot, platform)).toBe(
      path.join(desktopRoot, 'node_modules', 'electron', 'dist', ...executable),
    );
  });

  it('terminates an owned live process and permits repeated cleanup', async () => {
    const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000);'], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture did not start')), 5_000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('message', () => { clearTimeout(timer); resolve(); });
      });
      await terminateProcessTree(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await terminateProcessTree(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) await terminateProcessTree(child);
    }
  });

  it('fails closed without selecting an unrelated process that reuses the stopped child port', async () => {
    const first = await startHttpFixture();
    const port = first.port;
    await terminateProcessTree(first.child);
    const unrelated = await startHttpFixture(port);
    try {
      await expect(terminateOwnedElectronProcess(first.child, port, 150)).rejects.toThrow('refusing to terminate an unknown port owner');
      expect((await fetch(`http://127.0.0.1:${port}/json/version`)).ok).toBe(true);
      expect(unrelated.child.exitCode).toBeNull();
    } finally {
      await terminateProcessTree(unrelated.child);
    }
  });
});

async function startHttpFixture(port = 0): Promise<{ child: ReturnType<typeof spawn>; port: number }> {
  const source = "const http=require('node:http');const requested=Number(process.argv[1]);const server=http.createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end('{}');});server.listen(requested,'127.0.0.1',()=>process.send({port:server.address().port}));setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ['-e', source, String(port)], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  try {
    const observed = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP fixture did not start')), 5_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('message', (message: unknown) => {
        clearTimeout(timer);
        const value = (message as { port?: unknown }).port;
        if (!Number.isSafeInteger(value) || Number(value) < 1) reject(new Error('HTTP fixture returned an invalid port'));
        else resolve(Number(value));
      });
    });
    return { child, port: observed };
  } catch (error) {
    await terminateProcessTree(child).catch(() => undefined);
    throw error;
  }
}
