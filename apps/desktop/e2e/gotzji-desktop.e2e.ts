import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { _electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { UNPACKAGED_E2E_PROCESS_BIRTH } from '../../../packages/execution-core/src/process-identity.mjs';
import { alive, observeWorker, stopWorker } from '../../../packages/execution-core/src/managed-worker.js';
import type { WorkerRow } from '../../../packages/execution-core/src/store.js';
import { childEnvironment } from '../../../packages/execution-core/src/product-security.mjs';
import { electronExecutablePath, terminateProcessTree } from './electron-runtime.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');

type GovernedFixture = {
  app: ElectronApplication;
  page: Page;
  temporaryProject(prefix: 'gotzji-library-panel-e2e-' | 'gotzji-files-panel-e2e-'): Promise<string>;
  rendererFixturePath(): string;
};

const test = base.extend<{ gotzji: GovernedFixture }>({
  // Playwright requires an object pattern; this Electron fixture has no browser-fixture dependency.
  // eslint-disable-next-line no-empty-pattern
  gotzji: async ({}, use) => {
    const tempRoot = await realpath(os.tmpdir());
    const dataRoot = await mkdtemp(path.join(tempRoot, 'gotzji-desktop-e2e-'));
    let dataRootVerified = false;
    const roots: string[] = [];
    const rendererFiles: string[] = [];
    let app: ElectronApplication | undefined;
    let ownedAppProcess: ChildProcess | undefined;
    let ownedUiPid: number | undefined;
    let hostWasReady = false;
    let launchAttempted = false;
    const failures: unknown[] = [];
    let expectedHostExecutable: string | undefined;
    try {
    const relative = path.relative(tempRoot, dataRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(dataRoot).startsWith('gotzji-desktop-e2e-')) throw new Error('Unexpected gotzji E2E cleanup root');
    dataRootVerified = true;
    if (await realpath(dataRoot) !== dataRoot) throw new Error('Owned data root was redirected');
    expectedHostExecutable = await realpath(electronExecutablePath(desktopRoot));
    launchAttempted = true;
    app = await _electron.launch({
      executablePath: expectedHostExecutable,
      args: [mainEntry],
      cwd: desktopRoot,
      env: { ...process.env, GOTZJI_DATA_PATH: dataRoot, GOTZJI_E2E_MODE: '1' },
      timeout: 40_000,
    });
    ownedAppProcess = app.process();
    ownedUiPid = await app.evaluate(() => process.pid);
    if (!Number.isInteger(ownedUiPid) || ownedUiPid < 1) throw new Error('Owned native UI identity unavailable');
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


      await use({
        app, page,
        temporaryProject: async (prefix) => {
          const root = await mkdtemp(path.join(tempRoot, prefix));
          const selected = path.relative(tempRoot, root);
          if (!selected || selected.startsWith('..') || path.isAbsolute(selected) || !path.basename(root).startsWith(prefix)) throw new Error('Unexpected owned project fixture root');
          roots.push(root);
          if (await realpath(root) !== root) throw new Error('Owned project fixture root was redirected');
          return root;
        },
        rendererFixturePath: () => {
          const selected = path.join(desktopRoot, 'dist', 'renderer', `gotzji-lost-ack-e2e-${randomBytes(8).toString('hex')}.js`);
          rendererFiles.push(selected); return selected;
        },
      });
    } catch (error) { failures.push(error); }
    // This fixture verifies UI actions, not graceful application shutdown. Force only
    // its own disposable UI; normal installed quit/recovery remains a separate gate.
    let uiAbsent = !launchAttempted;
    let hostAbsent = !launchAttempted;
    let workersAbsent = !launchAttempted;
    let launcherAbsent = !launchAttempted;
    if (ownedAppProcess) {
      // Preserve the live ancestry until the whole captured test tree is stopped,
      // including its per-profile crash reporter; killing only the UI can orphan it.
      try { await terminateProcessTree(ownedAppProcess); } catch (error) { failures.push(error); }
    }
    if (ownedUiPid !== undefined) {
      try { await expect.poll(() => alive(ownedUiPid), { timeout: 5_000, intervals: [50, 100, 250] }).toBe(false); uiAbsent = true; }
      catch (error) { failures.push(error); }
    }
    if (!uiAbsent && ownedAppProcess) {
      try { await terminateProcessTree(ownedAppProcess); } catch (error) { failures.push(error); }
      if (ownedUiPid !== undefined) {
        try { await expect.poll(() => alive(ownedUiPid), { timeout: 5_000, intervals: [50, 100, 250] }).toBe(false); uiAbsent = true; }
        catch (error) { failures.push(error); }
      }
    }
    // A live UI could respawn the host. Unknown absence retains every fixture root.
    if (uiAbsent && expectedHostExecutable && launchAttempted) {
      try { hostAbsent = await stopOwnedTestHost(dataRoot, expectedHostExecutable); }
      catch (error) { failures.push(error); }
      if (hostWasReady && !hostAbsent) failures.push(new Error('Owned ready host absence unproved'));
      // The supervisor must be absent before taking the worker census, or it can
      // replace a stopped generation after the test has already observed absence.
      if (hostAbsent) {
        try { await stopOwnedTestWorkers(dataRoot); workersAbsent = true; }
        catch (error) { failures.push(error); }
      }
    }
    if (ownedAppProcess && uiAbsent && hostAbsent) {
      try { await terminateProcessTree(ownedAppProcess); } catch (error) { failures.push(error); }
      try { await expect.poll(() => ownedAppProcess.exitCode !== null || ownedAppProcess.signalCode !== null, { timeout: 5_000, intervals: [50, 100, 250] }).toBe(true); launcherAbsent = true; }
      catch (error) { failures.push(error); }
    }
    const resourcesAbsent = uiAbsent && hostAbsent && workersAbsent && launcherAbsent;
    if (!resourcesAbsent) failures.push(new Error(`Owned fixture processes unproved; retained ${dataRoot}, ${roots.join(', ')}`));
    const cleanup = await Promise.allSettled([
      dataRootVerified && resourcesAbsent ? expect.poll(async () => {
        try { await rm(dataRoot, { recursive: true, force: true }); return true; }
        catch { return false; }
      }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true) : Promise.reject(new Error('Unverified data-root cleanup refused')),
      ...(resourcesAbsent ? roots.map((root) => rm(root, { recursive: true, force: true })) : []),
      ...(resourcesAbsent ? rendererFiles.map((file) => rm(file, { force: true })) : []),
    ]);
    failures.push(...cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason));
    if (failures.length) throw new AggregateError(failures, `Governed E2E setup or owned fixture cleanup failed:\n${failures.map((failure) => failure instanceof Error ? failure.stack ?? failure.message : String(failure)).join('\n')}`);
  },
});

test('gotzji entry, project search and file edit return canonical results', async ({ gotzji }, testInfo) => {
    const { page } = gotzji;
    const libraryProjectRoot = await gotzji.temporaryProject('gotzji-library-panel-e2e-');
    await page.evaluate(async (rootPath) => window.gotzji.request({ method: 'registerProject', input: { projectId: 'library-panel', displayName: 'Library route fixture', rootPath, kind: 'library' } }), libraryProjectRoot);
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
    await page.getByRole('button', { name: /^Library route fixture ·/ }).click();
    await expect(page.getByRole('heading', { name: 'ช่องทาง Library สำหรับ lnwjud', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'เชื่อมโครงการ Library นี้', exact: true })).toBeEnabled();

    const projectFilesRoot = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
    await writeFile(path.join(projectFilesRoot, 'welcome.txt'), 'Original sample\n', 'utf8');
    await writeFile(path.join(projectFilesRoot, 'many-matches.txt'), 'MATCH_LITERAL\n'.repeat(101), 'utf8');
    await page.evaluate(async (rootPath) => window.gotzji.request({ method: 'registerProject', input: { projectId: 'files-panel', displayName: 'Project files fixture', rootPath, kind: 'project' } }), projectFilesRoot);
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
    await page.getByRole('button', { name: /^Project files fixture ·/ }).click();
    await expect(page.getByRole('heading', { name: 'ไฟล์ในโครงการ', exact: true })).toBeVisible();
    await page.getByText('เทียบความสามารถกับ lnwjud', { exact: true }).click();
    await page.getByLabel('ค้นหาเครื่องมืออ้างอิง', { exact: true }).fill('read_file');
    await expect(page.getByRole('row').filter({ has: page.getByText('read_file', { exact: true }) })).toContainText('รองรับบางส่วน');
    await page.getByText('เทียบความสามารถกับ lnwjud', { exact: true }).click();
    await expect(page.getByLabel('ข้อความที่ต้องการค้นหา', { exact: true })).toBeVisible();
    await page.getByLabel('ข้อความที่ต้องการค้นหา', { exact: true }).fill('not-in-this-fixture');
    await page.getByRole('button', { name: 'ค้นหาในโครงการ', exact: true }).click();
    await expect(page.getByText('ไม่พบข้อความที่ค้นหา', { exact: true })).toBeVisible();
    await page.getByLabel('ข้อความที่ต้องการค้นหา', { exact: true }).fill('MATCH_LITERAL');
    await page.getByRole('button', { name: 'ค้นหาในโครงการ', exact: true }).click();
    await expect(page.getByText('ค้นหาได้บางส่วน ลองเลือกโฟลเดอร์ย่อยหรือข้อความที่เจาะจงขึ้น', { exact: true })).toBeVisible();
    await page.getByLabel('ข้อความที่ต้องการค้นหา', { exact: true }).fill('Original sample');
    await page.getByRole('button', { name: 'ค้นหาในโครงการ', exact: true }).click();
    await page.getByRole('button', { name: 'welcome.txt:1', exact: true }).click();
    await expect(page.getByLabel('เนื้อหาไฟล์', { exact: true })).toHaveValue('Original sample\n');
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
    await expect(page.getByText('เสร็จแล้ว', { exact: true })).toBeVisible({ timeout: testInfo.timeout });
    expect(await readFile(path.join(projectFilesRoot, 'welcome.txt'), 'utf8')).toBe('Final verified sample\n');
    await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();

    const firstJobHeading = await page.getByRole('heading', { name: /^งาน [a-f0-9]{64}$/ }).textContent();
    const firstJobId = firstJobHeading?.match(/[a-f0-9]{64}/u)?.[0];
    expect(firstJobId).toBeTruthy();
    await expect(page.locator('pre:visible')).toContainText('"path": "welcome.txt"');
    await expect(page.locator('pre:visible')).toContainText('1eb5f5d070d4535515a4636073d6d716a4f031b51a75255866e2723b37d6e443');

});

test('gotzji new file retries one real admission after a lost acknowledgement', async ({ gotzji }, testInfo) => {
    const { page } = gotzji;
    const projectFilesRoot = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
    await writeFile(path.join(projectFilesRoot, 'welcome.txt'), 'Original sample\n', 'utf8');
    await writeFile(path.join(projectFilesRoot, 'many-matches.txt'), 'MATCH_LITERAL\n'.repeat(101), 'utf8');
    await page.evaluate(async (rootPath) => window.gotzji.request({ method: 'registerProject', input: { projectId: 'files-panel', displayName: 'Project files fixture', rootPath, kind: 'project' } }), projectFilesRoot);
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
    await page.getByRole('button', { name: /^Project files fixture ·/ }).click();
    await expect(page.getByRole('heading', { name: 'ไฟล์ในโครงการ', exact: true })).toBeVisible();
    // Exercise the same public component/IPC/Core port with one discarded acknowledgement.
    // The owned fixture imports the real component; no product fault hook or Core mock is installed.
    const lostAckFixturePath = gotzji.rendererFixturePath();
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
      createRoot(root, { identifierPrefix: 'lost-ack-' }).render(<GotzjiProjectFiles projectId="files-panel" disabled={false} request={request} onJob={(id) => { root.dataset.observedJobId = id; }} />);
    ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: lostAckFixturePath, define: { 'process.env.NODE_ENV': '"production"' } });
    await page.addScriptTag({ url: pathToFileURL(lostAckFixturePath).href });
    const lostAck = page.locator('#lost-ack-fixture');
    await lostAck.getByRole('button', { name: 'ไฟล์ใหม่', exact: true }).click();
    await lostAck.getByLabel('ไฟล์ที่เลือก', { exact: true }).fill('new-file.txt');
    await lostAck.getByLabel('เนื้อหาไฟล์', { exact: true }).fill('Created exactly once\n');
    await lostAck.getByRole('button', { name: 'ตรวจการแก้ไข', exact: true }).click();
    await lostAck.getByRole('button', { name: 'บันทึกไฟล์', exact: true }).click();
    await expect(lostAck.getByRole('alert')).toContainText('LOST_ACK_AFTER_REAL_ADMISSION');
    const acceptedJobId = await page.locator('#lost-ack-fixture').getAttribute('data-admitted-job-id');
    expect(acceptedJobId).toMatch(/^[a-f0-9]{64}$/u);
    await lostAck.getByRole('button', { name: 'บันทึกไฟล์', exact: true }).click();
    await expect(page.locator('#lost-ack-fixture')).toHaveAttribute('data-observed-job-id', acceptedJobId!);
    await page.evaluate(() => { document.getElementById('lost-ack-fixture')!.remove(); document.getElementById('root')!.hidden = false; });
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
    await page.getByRole('button').filter({ has: page.getByText(acceptedJobId!, { exact: true }) }).click();
    await expect(page.getByRole('heading', { name: `งาน ${acceptedJobId}`, exact: true })).toBeVisible();
    await expect(page.getByText('เสร็จแล้ว', { exact: true })).toBeVisible({ timeout: testInfo.timeout });
    expect(await readFile(path.join(projectFilesRoot, 'new-file.txt'), 'utf8')).toBe('Created exactly once\n');
    const createdJobs = await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} }));
    expect(Array.isArray(createdJobs)).toBe(true);
    expect((createdJobs as { jobId: string; projectId?: string }[]).filter((job) => job.projectId === 'files-panel')).toHaveLength(1);
    await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
    await expect(page.locator('pre:visible')).toContainText('"path": "new-file.txt"');
    await expect(page.locator('pre:visible')).toContainText('"state": "completed"');

});

test('gotzji Git status, selected diff and history preserve the source index', async ({ gotzji }) => {
    const { page } = gotzji;
    const projectFilesRoot = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
    await writeFile(path.join(projectFilesRoot, 'welcome.txt'), 'Original sample\n', 'utf8');
    await writeFile(path.join(projectFilesRoot, 'many-matches.txt'), 'MATCH_LITERAL\n'.repeat(101), 'utf8');
    await page.evaluate(async (rootPath) => window.gotzji.request({ method: 'registerProject', input: { projectId: 'files-panel', displayName: 'Project files fixture', rootPath, kind: 'project' } }), projectFilesRoot);
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
    await page.getByRole('button', { name: /^Project files fixture ·/ }).click();
    await expect(page.getByRole('heading', { name: 'ไฟล์ในโครงการ', exact: true })).toBeVisible();
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
    await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c2-git.png') });
    expect(await readFile(path.join(projectFilesRoot!, '.git', 'index'))).toEqual(indexBefore);

});

test('gotzji workflow review and copy preserve project identity without submitting jobs', async ({ gotzji }) => {
  const { page } = gotzji;
  await page.getByRole('button', { name: 'เวิร์กโฟลว์', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'เริ่มงานกับ ChatGPT', exact: true })).toBeVisible();
  for (const title of ['ตรวจสอบโปรเจกต์', 'รีวิวโค้ด', 'ตรวจความพร้อมรีลีส', 'ตรวจการเชื่อมต่อ', 'ตรวจข้อมูล Excel/CSV', 'สร้างรายงานจากต้นแบบ']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${title}`) })).toBeDisabled();
  }
  const rootA = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  const rootB = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await writeFile(path.join(rootA, 'data.csv'), 'id,value\n1,original\n');
  await page.evaluate(async ([a, b]) => {
    await window.gotzji.request({ method: 'registerProject', input: { projectId: 'workflow-a', displayName: 'Workflow A', rootPath: a, kind: 'project' } });
    await window.gotzji.request({ method: 'registerProject', input: { projectId: 'workflow-b', displayName: 'Workflow B', rootPath: b, kind: 'project' } });
    // Keep the owner's global clipboard untouched while observing the actual UI's browser API call.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { Reflect.set(window, '__ownedWorkflowCopy', text); } } });
  }, [rootA, rootB]);
  await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
  await page.getByLabel('โครงการสำหรับเวิร์กโฟลว์', { exact: true }).selectOption('workflow-a');
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c1b-workflow-cards.png') });
  for (const journey of [
    { title: 'ตรวจสอบโปรเจกต์', id: 'project-check', fields: [] },
    { title: 'รีวิวโค้ด', id: 'code-review', fields: [['สาขาหรือรุ่นโค้ดที่ใช้เปรียบเทียบ', 'main']] },
    { title: 'ตรวจความพร้อมรีลีส', id: 'release-readiness', fields: [['รุ่นเป้าหมาย', '1.0.0']] },
    { title: 'ตรวจการเชื่อมต่อ', id: 'connection-check', fields: [['การเชื่อมต่อที่ต้องการตรวจ', 'ChatGPT']] },
    { title: 'ตรวจข้อมูล Excel/CSV', id: 'data-audit', fields: [['ไฟล์ข้อมูลในโครงการ', 'data.csv'], ['คอลัมน์คีย์', 'id']] },
  ] as const) {
    await page.getByRole('button', { name: new RegExp(`^${journey.title}`) }).click();
    for (const [label, value] of journey.fields) await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByRole('button', { name: 'ตรวจคำขอ', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ตรวจรายละเอียดก่อนส่ง', exact: true })).toBeVisible();
    await page.getByText('อ่านข้อความคำขอทั้งหมด', { exact: true }).click();
    await expect(page.getByLabel('คำขอสำหรับ ChatGPT', { exact: true })).toHaveValue(new RegExp(`"templateId": "${journey.id}"`));
    await expect(page.getByLabel('คำขอสำหรับ ChatGPT', { exact: true })).toHaveValue(/ห้ามรันคำสั่งใหม่/u);
  }
  await page.getByRole('button', { name: /^สร้างรายงานจากต้นแบบ/ }).click();
  await page.getByLabel('ไฟล์ข้อมูลในโครงการ', { exact: true }).fill('data.csv');
  await page.getByLabel('ไฟล์ต้นแบบในโครงการ', { exact: true }).fill('template.xlsx');
  await page.getByLabel('ไฟล์แมปในโครงการ', { exact: true }).fill('mapping.json');
  await page.getByLabel('ไฟล์ปลายทางใหม่ในโครงการ', { exact: true }).fill('reports/result.xlsx');
  await page.getByRole('button', { name: 'ตรวจคำขอ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ตรวจรายละเอียดก่อนส่ง', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'คัดลอกคำขอ', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('คัดลอกแล้ว');
  const copied = await page.evaluate(() => Reflect.get(window, '__ownedWorkflowCopy') as string);
  expect(copied).toContain('"projectId": "workflow-a"');
  expect(copied).toContain('"outputPath": "reports/result.xlsx"');
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c1b-review.png') });
  await page.getByLabel('ไฟล์ปลายทางใหม่ในโครงการ', { exact: true }).fill('../outside.xlsx');
  await expect(page.getByRole('button', { name: 'คัดลอกคำขอ', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'ตรวจคำขอ', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('ใช้ชื่อไฟล์ภายในโครงการ');
  await page.getByLabel('โครงการสำหรับเวิร์กโฟลว์', { exact: true }).selectOption('workflow-b');
  await expect(page.getByRole('heading', { name: 'ตรวจรายละเอียดก่อนส่ง', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^ตรวจสอบโปรเจกต์/ }).click();
  await page.getByRole('button', { name: 'ตรวจคำขอ', exact: true }).click();
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Synthetic clipboard denial'); } } }); });
  await page.getByRole('button', { name: 'คัดลอกคำขอ', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('คัดลอกไม่สำเร็จ');
  await page.getByText('อ่านข้อความคำขอทั้งหมด', { exact: true }).click();
  await expect(page.getByLabel('คำขอสำหรับ ChatGPT', { exact: true })).toHaveValue(/"projectId": "workflow-b"/u);
  expect(await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} }))).toEqual([]);
  expect(await readFile(path.join(rootA, 'data.csv'), 'utf8')).toBe('id,value\n1,original\n');
  expect(await readdir(rootA)).toEqual(['data.csv']);
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c1b-workflows.png') });
});

async function stopOwnedTestWorkers(dataRoot: string): Promise<void> {
  const runtime = path.join(dataRoot, 'runtime');
  const base = path.join(runtime, 'workers');
  const databasePath = path.join(runtime, 'core.sqlite');
  if (await realpath(databasePath) !== databasePath) throw new Error('Worker database cleanup scope denied');
  const census = (): WorkerRow[] => {
    // This private fixture may have a hot WAL after forced tree termination.
    // Opening read/write lets SQLite recover it; do not create a missing database.
    const db = new DatabaseSync(databasePath, { timeout: 5_000 });
    try { return db.prepare('SELECT * FROM gotzji_workers ORDER BY epoch').all() as unknown as WorkerRow[]; }
    catch (error) {
      const details = error as Error & { code?: string; errcode?: number; errstr?: string };
      throw new Error(`Owned worker census failed: ${details.message} (${details.code ?? ''}, ${details.errcode ?? ''}, ${details.errstr ?? ''})`, { cause: error });
    }
    finally { db.close(); }
  };
  const workers = census();
  for (const worker of workers) {
    const directory = path.resolve(worker.directory);
    if (path.dirname(directory) !== base || await realpath(directory) !== directory) throw new Error('Worker cleanup scope denied');
  }
  let directories: string[];
  try { directories = (await readdir(base)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') directories = []; else throw error; }
  if (JSON.stringify(directories) !== JSON.stringify(workers.map((worker) => path.basename(worker.directory)).sort())) throw new Error('Unrepresented worker directory; owned cleanup refused');
  const failures: unknown[] = [];
  for (const worker of workers) {
    try { if (!await stopWorker(worker) || await observeWorker(worker) !== 'absent') throw new Error('Owned test worker absence unproved'); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned E2E worker cleanup failed');
  if (JSON.stringify(census()) !== JSON.stringify(workers)) throw new Error('Worker census changed after host shutdown');
  for (const worker of workers) if (await observeWorker(worker) !== 'absent') throw new Error('Owned worker absence changed after cleanup');
}

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
  // The authenticated owned endpoint can outlive its process after an exact fixture fallback.
  if (alive(endpoint.pid) === false) return true;
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
