import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { processIdentities, sameProcessIdentity } from '../../../packages/execution-core/src/process-identity.mjs';
import { electronExecutablePath, terminateProcessTree } from './electron-runtime.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');

test('gotzji production entry exposes governed controls and denies inherited work IPC', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'gotzji-desktop-e2e-'));
  const relative = path.relative(os.tmpdir(), dataRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(dataRoot).startsWith('gotzji-desktop-e2e-')) {
    throw new Error('Unexpected gotzji E2E cleanup root');
  }
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({
      executablePath: electronExecutablePath(desktopRoot),
      args: [mainEntry],
      cwd: desktopRoot,
      env: { ...process.env, GOTZJI_DATA_PATH: dataRoot },
      timeout: 40_000,
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'gotzji', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Grace ดูแลงานของคุณ', { exact: true })).toBeVisible();
    const observation = await page.evaluate(async () => {
      const result = await Promise.race([
        window.gotzji.hostStatus().then((value) => ({ kind: 'status' as const, value })).catch((error: unknown) => ({ kind: 'error' as const, value: error instanceof Error ? error.message : String(error) })),
        new Promise<{ kind: 'timeout'; value: null }>((resolve) => window.setTimeout(() => resolve({ kind: 'timeout', value: null }), 25_000)),
      ]);
      return { result, body: document.body.innerText };
    });
    const incidents = await Promise.all((await readdir(path.join(dataRoot, 'runtime'))).filter((name) => name.startsWith('product-startup-')).map(async (name) => readFile(path.join(dataRoot, 'runtime', name), 'utf8')));
    expect(observation.result, `${observation.body}\nSTATUS=${JSON.stringify(observation.result)}\nINCIDENTS=${incidents.join('\n')}`).toMatchObject({
      kind: 'status', value: { product: 'gotzji', state: 'ready', controller: 'grace', automaticUpdates: false },
    });
    await expect(page.evaluate(() => ({
      process: typeof Reflect.get(window, 'process'),
      require: typeof Reflect.get(window, 'require'),
      governed: typeof window.gotzji.request,
    }))).resolves.toEqual({ process: 'undefined', require: 'undefined', governed: 'function' });
    const denied = await page.evaluate(async () => {
      try { await window.lnwjud.factoryReset(); return 'unexpected-success'; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    });
    expect(denied).toContain('GRACE_GOVERNED_OPERATION_REQUIRED');
    const browserWindow = await app.browserWindow(page);
    expect(await browserWindow.evaluate((window) => window.webContents.getLastWebPreferences().sandbox)).toBe(true);
  } finally {
    if (app) await terminateProcessTree(app.process());
    await stopOwnedTestHost(dataRoot);
    await expect.poll(async () => {
      try { await rm(dataRoot, { recursive: true, force: true }); return true; }
      catch { return false; }
    }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true);
  }
});

async function stopOwnedTestHost(dataRoot: string): Promise<void> {
  let endpoint: { pid: number; identity: { birth: string; executable: string } };
  try {
    const envelope = JSON.parse(await readFile(path.join(dataRoot, 'runtime', 'product-endpoint.json'), 'utf8')) as { body: string };
    endpoint = JSON.parse(envelope.body) as typeof endpoint;
  } catch { return; }
  const observed = (await processIdentities([endpoint.pid]))[endpoint.pid];
  if (observed == null) return;
  if (observed === 'unknown' || !sameProcessIdentity(endpoint.identity, observed)) throw new Error('Gotzji E2E host ownership changed');
  process.kill(endpoint.pid, 'SIGTERM');
  await expect.poll(async () => {
    const current = (await processIdentities([endpoint.pid]))[endpoint.pid];
    return current === undefined || current !== 'unknown' && !sameProcessIdentity(endpoint.identity, current);
  }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true);
}
