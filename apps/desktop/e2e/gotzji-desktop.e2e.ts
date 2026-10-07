import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { processIdentities, sameProcessIdentity, UNPACKAGED_E2E_PROCESS_BIRTH } from '../../../packages/execution-core/src/process-identity.mjs';
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
  let hostWasReady = false;
  const expectedHostExecutable = await realpath(electronExecutablePath(desktopRoot));
  try {
    const providerFixture = path.join(dataRoot, 'claude.exe');
    await writeFile(providerFixture, 'gotzji E2E provider path fixture\n', { flag: 'wx' });
    const providerExecutable = await realpath(providerFixture);
    app = await _electron.launch({
      executablePath: expectedHostExecutable,
      args: [mainEntry],
      cwd: desktopRoot,
      env: { ...process.env, GOTZJI_DATA_PATH: dataRoot, GOTZJI_E2E_MODE: '1', GOTZJI_E2E_PROVIDER_EXECUTABLE: providerExecutable },
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
    hostWasReady = true;
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
    try {
      const selfStopped = await stopOwnedTestHost(dataRoot, expectedHostExecutable);
      if (hostWasReady) expect(selfStopped).toBe(true);
    }
    finally {
      if (app) await terminateProcessTree(app.process());
      await expect.poll(async () => {
        try { await rm(dataRoot, { recursive: true, force: true }); return true; }
        catch { return false; }
      }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true);
    }
  }
});

async function stopOwnedTestHost(dataRoot: string, expectedExecutable: string): Promise<boolean> {
  let endpoint: { pid: number; port: number; buildIdentity: string; identity: { birth: string; executable: string }; ownerId: string };
  let daemonSecret = '';
  try {
    const runtime = path.join(dataRoot, 'runtime');
    const sealed = JSON.parse(await readFile(path.join(runtime, 'product-host.sealed.json'), 'utf8')) as { schemaVersion?: number; protection?: string; payload?: string };
    if (sealed.schemaVersion !== 1 || sealed.protection !== 'windows-current-user-dpapi' || typeof sealed.payload !== 'string') throw new Error('Gotzji E2E host config envelope changed');
    const config = JSON.parse(Buffer.from(sealed.payload, 'base64').toString('utf8')) as { directory?: string; daemonSecret?: string; ownerId?: string };
    if (config.directory !== runtime || typeof config.daemonSecret !== 'string' || config.daemonSecret.length !== 64 || typeof config.ownerId !== 'string') throw new Error('Gotzji E2E host config changed');
    daemonSecret = config.daemonSecret;
    const envelope = JSON.parse(await readFile(path.join(runtime, 'product-endpoint.json'), 'utf8')) as { body: string; mac: string };
    const expectedMac = createHmac('sha256', config.daemonSecret).update(envelope.body).digest();
    const actualMac = Buffer.from(envelope.mac, 'hex');
    if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) throw new Error('Gotzji E2E endpoint authentication changed');
    endpoint = JSON.parse(envelope.body) as typeof endpoint;
    if (endpoint.ownerId !== config.ownerId || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/u.test(endpoint.buildIdentity) || endpoint.identity.birth !== UNPACKAGED_E2E_PROCESS_BIRTH || endpoint.identity.executable.toLowerCase() !== expectedExecutable.toLowerCase()) throw new Error('Gotzji E2E endpoint identity changed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const observed = (await processIdentities([endpoint.pid]))[endpoint.pid];
  if (observed == null) return false;
  if (observed === 'unknown' || observed.executable.toLowerCase() !== expectedExecutable.toLowerCase()) throw new Error('Gotzji E2E host ownership changed');
  const shutdownUrl = `http://127.0.0.1:${endpoint.port}/rpc`;
  const denied = await fetch(shutdownUrl, { method: 'POST', headers: { Authorization: 'Bearer invalid-e2e-token', 'Content-Type': 'application/json', 'x-gotzji-build': endpoint.buildIdentity }, body: JSON.stringify({ method: 'testOnlyE2eShutdown', input: { nonce: randomBytes(32).toString('hex') } }), signal: AbortSignal.timeout(1_000), redirect: 'error' });
  const deniedBody = await denied.json() as { error?: string };
  if (denied.status !== 403 || deniedBody.error !== 'AUTHORITY_DENIED') throw new Error('Gotzji E2E unauthenticated shutdown was accepted');
  const nonce = randomBytes(32).toString('hex');
  const shutdown = await fetch(shutdownUrl, { method: 'POST', headers: { Authorization: `Bearer ${daemonSecret}`, 'Content-Type': 'application/json', 'x-gotzji-build': endpoint.buildIdentity }, body: JSON.stringify({ method: 'testOnlyE2eShutdown', input: { nonce } }), signal: AbortSignal.timeout(1_000), redirect: 'error' });
  const receipt = await shutdown.json() as { ok?: boolean; value?: { accepted?: boolean; nonce?: string } };
  if (!shutdown.ok || !receipt.ok || receipt.value?.accepted !== true || receipt.value.nonce !== nonce) throw new Error('Gotzji E2E authenticated self-shutdown failed');
  await expect.poll(async () => {
    const current = (await processIdentities([endpoint.pid]))[endpoint.pid];
    return current === undefined || current !== 'unknown' && !sameProcessIdentity(observed, current);
  }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true);
  return true;
}
