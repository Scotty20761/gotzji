import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { UNPACKAGED_E2E_PROCESS_BIRTH } from '../../../packages/execution-core/src/process-identity.mjs';
import { alive } from '../../../packages/execution-core/src/managed-worker.js';
import { childEnvironment } from '../../../packages/execution-core/src/product-security.mjs';
import { electronExecutablePath, terminateProcessTree } from './electron-runtime.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');

test('gotzji production entry exposes governed controls and denies inherited work IPC', async () => {
  const tempRoot = await realpath(os.tmpdir());
  const dataRoot = await realpath(await mkdtemp(path.join(tempRoot, 'gotzji-desktop-e2e-')));
  const relative = path.relative(tempRoot, dataRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(dataRoot).startsWith('gotzji-desktop-e2e-')) {
    throw new Error('Unexpected gotzji E2E cleanup root');
  }
  let app: ElectronApplication | undefined;
  let libraryProjectRoot: string | undefined;
  let projectFilesRoot: string | undefined;
  let lostAckFixturePath: string | undefined;
  let hostWasReady = false;
  const failures: unknown[] = [];
  const expectedHostExecutable = await realpath(electronExecutablePath(desktopRoot));
  try {
    app = await _electron.launch({
      executablePath: expectedHostExecutable,
      args: [mainEntry],
      cwd: desktopRoot,
      env: { ...process.env, GOTZJI_DATA_PATH: dataRoot, GOTZJI_E2E_MODE: '1' },
      timeout: 40_000,
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'gotzji', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('สั่งงานผ่านปลั๊กอิน ChatGPT', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Grace ผู้ช่วยส่วนตัว', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ตั้งค่า', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'บันทึกสด', exact: true })).toBeVisible();
    const observation = await page.evaluate(async () => {
      const result = await Promise.race([
        window.gotzji.hostStatus().then((value) => ({ kind: 'status' as const, value })).catch((error: unknown) => ({ kind: 'error' as const, value: error instanceof Error ? error.message : String(error) })),
        new Promise<{ kind: 'timeout'; value: null }>((resolve) => window.setTimeout(() => resolve({ kind: 'timeout', value: null }), 25_000)),
      ]);
      return { result, body: document.body.innerText };
    });
    const incidents = await Promise.all((await readdir(path.join(dataRoot, 'runtime'))).filter((name) => name.startsWith('product-startup-')).map(async (name) => readFile(path.join(dataRoot, 'runtime', name), 'utf8')));
    expect(observation.result, `${observation.body}\nSTATUS=${JSON.stringify(observation.result)}\nINCIDENTS=${incidents.join('\n')}`).toMatchObject({
      kind: 'status', value: { product: 'gotzji', state: 'ready', controller: 'chatgpt-plugin', automaticUpdates: false },
    });
    hostWasReady = true;
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await expect(page.getByText('ระบบในเครื่องพร้อมทำงาน', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c1-home.png') });
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

    libraryProjectRoot = await realpath(await mkdtemp(path.join(tempRoot, 'gotzji-library-panel-e2e-')));
    const libraryRelative = path.relative(tempRoot, libraryProjectRoot);
    if (!libraryRelative || libraryRelative.startsWith('..') || path.isAbsolute(libraryRelative) || !path.basename(libraryProjectRoot).startsWith('gotzji-library-panel-e2e-')) throw new Error('Unexpected Library panel fixture root');
    await page.evaluate(async (rootPath) => window.gotzji.request({ method: 'registerProject', input: { projectId: 'library-panel', displayName: 'Library route fixture', rootPath, kind: 'library' } }), libraryProjectRoot);
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
    await page.getByRole('button', { name: /^Library route fixture ·/ }).click();
    await expect(page.getByRole('heading', { name: 'ช่องทาง Library สำหรับ lnwjud', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'เชื่อมโครงการ Library นี้', exact: true })).toBeEnabled();

    projectFilesRoot = await realpath(await mkdtemp(path.join(tempRoot, 'gotzji-files-panel-e2e-')));
    const filesRelative = path.relative(tempRoot, projectFilesRoot);
    if (!filesRelative || filesRelative.startsWith('..') || path.isAbsolute(filesRelative) || !path.basename(projectFilesRoot).startsWith('gotzji-files-panel-e2e-')) throw new Error('Unexpected project files fixture root');
    await writeFile(path.join(projectFilesRoot, 'welcome.txt'), 'Original sample\n', 'utf8');
    await page.evaluate(async (rootPath) => window.gotzji.request({ method: 'registerProject', input: { projectId: 'files-panel', displayName: 'Project files fixture', rootPath, kind: 'project' } }), projectFilesRoot);
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
    await page.getByRole('button', { name: /^Project files fixture ·/ }).click();
    await expect(page.getByRole('heading', { name: 'ไฟล์ในโครงการ', exact: true })).toBeVisible();
    await page.getByText('เทียบความสามารถกับ lnwjud', { exact: true }).click();
    await page.getByLabel('ค้นหาเครื่องมืออ้างอิง', { exact: true }).fill('read_file');
    await expect(page.getByRole('row').filter({ has: page.getByText('read_file', { exact: true }) })).toContainText('รองรับบางส่วน');
    await page.getByText('เทียบความสามารถกับ lnwjud', { exact: true }).click();
    await page.getByRole('button', { name: 'อ่านโฟลเดอร์', exact: true }).click();
    await page.getByRole('button', { name: 'welcome.txt', exact: true }).click();
    await expect(page.getByRole('button', { name: 'อ่านโฟลเดอร์', exact: true })).toBeEnabled();
    await expect(page.getByLabel('เนื้อหาไฟล์', { exact: true }), await page.locator('body').innerText()).toHaveValue('Original sample\n');
    await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c1-files.png') });
    await page.getByLabel('เนื้อหาไฟล์', { exact: true }).fill('Edited through gotzji\n');
    await page.getByRole('button', { name: 'ตรวจการแก้ไข', exact: true }).click();
    await expect(page.getByRole('button', { name: 'บันทึกไฟล์', exact: true })).toBeEnabled();
    // Editing after preparation must make the old preparation unusable in the UI.
    await page.getByLabel('เนื้อหาไฟล์', { exact: true }).fill('Final verified sample\n');
    await expect(page.getByRole('button', { name: 'บันทึกไฟล์', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'ตรวจการแก้ไข', exact: true }).click();
    await page.getByRole('button', { name: 'บันทึกไฟล์', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^งาน [a-f0-9]{64}$/ })).toBeVisible();
    await expect.poll(() => readFile(path.join(projectFilesRoot!, 'welcome.txt'), 'utf8')).toBe('Final verified sample\n');
    await expect(page.getByText('เสร็จแล้ว', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();

    const firstJobHeading = await page.getByRole('heading', { name: /^งาน [a-f0-9]{64}$/ }).textContent();
    const firstJobId = firstJobHeading?.match(/[a-f0-9]{64}/u)?.[0];
    expect(firstJobId).toBeTruthy();
    await expect(page.locator('pre:visible')).toContainText('"path": "welcome.txt"');
    await expect(page.locator('pre:visible')).toContainText('1eb5f5d070d4535515a4636073d6d716a4f031b51a75255866e2723b37d6e443');

    // Exercise the same public component/IPC/Core port with one discarded acknowledgement.
    // The owned fixture imports the real component; no product fault hook or Core mock is installed.
    lostAckFixturePath = path.join(desktopRoot, 'dist', 'renderer', `gotzji-lost-ack-e2e-${randomBytes(8).toString('hex')}.js`);
    await build({ stdin: { resolveDir: path.join(desktopRoot, 'src', 'renderer'), sourcefile: 'lost-ack-fixture.tsx', loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client';
      import { GotzjiProjectFiles } from './GotzjiProjectFiles.tsx';
      const host = document.getElementById('root'); host.hidden = true;
      const root = document.createElement('div'); root.id = 'lost-ack-fixture'; document.body.append(root);
      let discard = true;
      const request = async (method, input) => {
        const result = await window.gotzji.request({ method, input });
        if (method === 'submit' && discard) {
          if (!result || typeof result.jobId !== 'string') throw new Error('Expected actual admitted job');
          discard = false; root.dataset.admittedJobId = result.jobId;
          throw new Error('LOST_ACK_AFTER_REAL_ADMISSION');
        }
        return result;
      };
      createRoot(root).render(<GotzjiProjectFiles projectId="files-panel" disabled={false} request={request} onJob={(id) => { root.dataset.observedJobId = id; }} />);
    ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: lostAckFixturePath, define: { 'process.env.NODE_ENV': '"production"' } });
    await page.addScriptTag({ url: pathToFileURL(lostAckFixturePath).href });
    await page.getByRole('button', { name: 'ไฟล์ใหม่', exact: true }).click();
    await page.getByLabel('ไฟล์ที่เลือก', { exact: true }).fill('new-file.txt');
    await page.getByLabel('เนื้อหาไฟล์', { exact: true }).fill('Created exactly once\n');
    await page.getByRole('button', { name: 'ตรวจการแก้ไข', exact: true }).click();
    await page.getByRole('button', { name: 'บันทึกไฟล์', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('LOST_ACK_AFTER_REAL_ADMISSION');
    const acceptedJobId = await page.locator('#lost-ack-fixture').getAttribute('data-admitted-job-id');
    expect(acceptedJobId).toMatch(/^[a-f0-9]{64}$/u);
    await page.getByRole('button', { name: 'บันทึกไฟล์', exact: true }).click();
    await expect(page.locator('#lost-ack-fixture')).toHaveAttribute('data-observed-job-id', acceptedJobId!);
    await page.evaluate(() => { document.getElementById('lost-ack-fixture')!.remove(); document.getElementById('root')!.hidden = false; });
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
    await page.getByRole('button').filter({ has: page.getByText(acceptedJobId!, { exact: true }) }).click();
    await expect(page.getByRole('heading', { name: `งาน ${acceptedJobId}`, exact: true })).toBeVisible();
    await expect(page.getByText('เสร็จแล้ว', { exact: true })).toBeVisible();
    await expect.poll(() => readFile(path.join(projectFilesRoot!, 'new-file.txt'), 'utf8')).toBe('Created exactly once\n');
    const createdJobs = await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} }));
    expect(Array.isArray(createdJobs)).toBe(true);
    expect((createdJobs as { jobId: string; projectId?: string }[]).filter((job) => job.projectId === 'files-panel')).toHaveLength(2);
    await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
    await expect(page.locator('pre:visible')).toContainText('"path": "new-file.txt"');
    await expect(page.locator('pre:visible')).toContainText('"state": "completed"');

    const git = (args: string[]): Promise<{ stdout: string; stderr: string }> => promisify(execFile)('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', ...args], {
      cwd: projectFilesRoot!, windowsHide: true,
      env: { ...childEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TEMPLATE_DIR: '', GIT_AUTHOR_NAME: 'Synthetic Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' },
    });
    await git(['init']); await git(['add', 'welcome.txt']); await git(['commit', '-m', 'Synthetic UI Git proof']);
    const indexBefore = await readFile(path.join(projectFilesRoot!, '.git', 'index'));
    await writeFile(path.join(projectFilesRoot!, 'welcome.txt'), 'Git UI change\n');
    await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
    await page.getByRole('button', { name: /^Project files fixture ·/ }).click();
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await page.getByRole('button', { name: 'อ่านสถานะ Git', exact: true }).click();
    await page.getByRole('button', { name: 'welcome.txt', exact: true }).click();
    await page.getByRole('button', { name: 'ดูความต่างของไฟล์', exact: true }).click();
    await expect(page.getByLabel('ความต่างของไฟล์', { exact: true })).toContainText('+Git UI change');
    await page.getByRole('button', { name: 'อ่านประวัติ Git', exact: true }).click();
    await expect(page.getByText('Synthetic UI Git proof', { exact: true })).toBeVisible();
    expect(await readFile(path.join(projectFilesRoot!, '.git', 'index'))).toEqual(indexBefore);

  } catch (error) { failures.push(error); }
  try {
    const selfStopped = await stopOwnedTestHost(dataRoot, expectedHostExecutable);
    if (hostWasReady) expect(selfStopped).toBe(true);
  } catch (error) { failures.push(error); }
  const closeResult = await Promise.allSettled([(async (): Promise<void> => {
    if (app) {
      const ownedAppProcess = app.process();
      const errors: unknown[] = [];
      try { await app.close(); } catch (error) { errors.push(error); }
      try { await terminateProcessTree(ownedAppProcess); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Owned Electron close failed');
    }
  })()]);
  const cleanup = await Promise.allSettled([
    expect.poll(async () => {
      try { await rm(dataRoot, { recursive: true, force: true }); return true; }
      catch { return false; }
    }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true),
    libraryProjectRoot ? rm(libraryProjectRoot, { recursive: true, force: true }) : undefined,
    projectFilesRoot ? rm(projectFilesRoot, { recursive: true, force: true }) : undefined,
    lostAckFixturePath ? rm(lostAckFixturePath, { force: true }) : undefined,
  ]);
  failures.push(...[...closeResult, ...cleanup].filter((item) => item.status === 'rejected').map((item) => item.reason));
  if (failures.length) throw new AggregateError(failures, 'Governed E2E assertions or owned fixture cleanup failed');

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
  const shutdownUrl = `http://127.0.0.1:${endpoint.port}/rpc`;
  const denied = await fetch(shutdownUrl, { method: 'POST', headers: { Authorization: 'Bearer invalid-e2e-token', 'Content-Type': 'application/json', 'x-gotzji-build': endpoint.buildIdentity }, body: JSON.stringify({ method: 'testOnlyE2eShutdown', input: { nonce: randomBytes(32).toString('hex') } }), signal: AbortSignal.timeout(1_000), redirect: 'error' });
  const deniedBody = await denied.json() as { error?: string };
  if (denied.status !== 403 || deniedBody.error !== 'AUTHORITY_DENIED') throw new Error('Gotzji E2E unauthenticated shutdown was accepted');
  const nonce = randomBytes(32).toString('hex');
  const shutdown = await fetch(shutdownUrl, { method: 'POST', headers: { Authorization: `Bearer ${daemonSecret}`, 'Content-Type': 'application/json', 'x-gotzji-build': endpoint.buildIdentity }, body: JSON.stringify({ method: 'testOnlyE2eShutdown', input: { nonce } }), signal: AbortSignal.timeout(1_000), redirect: 'error' });
  const receipt = await shutdown.json() as { ok?: boolean; value?: { accepted?: boolean; nonce?: string } };
  if (!shutdown.ok || !receipt.ok || receipt.value?.accepted !== true || receipt.value.nonce !== nonce) throw new Error('Gotzji E2E authenticated self-shutdown failed');
  // `alive` uses signal 0 only. It never terminates the PID; reuse or an
  // unverifiable probe stays non-false and therefore fails this cleanup proof.
  await expect.poll(() => alive(endpoint.pid), { timeout: 10_000, intervals: [50, 100, 250] }).toBe(false);
  return true;
}
