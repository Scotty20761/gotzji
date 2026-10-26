import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { _electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { processIdentities, sameProcessIdentity, UNPACKAGED_E2E_PROCESS_BIRTH } from '../../../packages/execution-core/src/process-identity.mjs';
import { alive, observeWorker, stopWorker } from '../../../packages/execution-core/src/managed-worker.js';
import type { WorkerRow } from '../../../packages/execution-core/src/store.js';
import { parseGitReadDiagnostic, type GitReadDiagnostic } from '../../../packages/execution-core/src/git-read-diagnostics.js';
import { childEnvironment, sanitizedStream } from '../../../packages/execution-core/src/product-security.mjs';
import { electronExecutablePath, terminateProcessTree } from './electron-runtime.js';
import { assertChromeRootsPreserved, independentChromeRoots, ownedChromeProcesses } from './gotzji-browser-runtime.js';
import { readProductConfiguration, testOnlyProductSecretProtector } from '../../../packages/execution-core/src/product-host.js';
import { startGotzjiOwnedBrowser, type GotzjiOwnedBrowserDriver } from '../../../packages/capabilities/src/gotzji-browser-provider-session.js';
import { ownedRootRemovalEvidence } from './owned-fixture-cleanup.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');

type GovernedFixture = {
  readonly dataRoot: string;
  beforeClose(action: () => Promise<void>): void;
  app: ElectronApplication;
  page: Page;
  temporaryProject(prefix: 'gotzji-library-panel-e2e-' | 'gotzji-files-panel-e2e-'): Promise<string>;
  rendererFixturePath(): string;
};

const test = base.extend<{ gotzji: GovernedFixture }>({
  // Playwright requires an object pattern; this Electron fixture has no browser-fixture dependency.
  // eslint-disable-next-line no-empty-pattern
  gotzji: async ({}, use) => {
    const systemTempRoot = await realpath(os.tmpdir());
    let tempRoot = systemTempRoot;
    if (process.env.GOTZJI_NATIVE_BROWSER_QUALIFICATION === '1') {
      const scopedParent = path.join(systemTempRoot, 'gotzji'); await mkdir(scopedParent, { recursive: true });
      if (await realpath(scopedParent) !== scopedParent) throw new Error('Native browser fixture parent was redirected');
      tempRoot = scopedParent; // Shared parent is retained; only this fixture's unique children are removed.
    }
    const additionalCleanup: Array<() => Promise<void>> = [];
    let additionalResourcesAbsent = true;
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
    const gitDiagnostics: GitReadDiagnostic[] = [];
    const diagnosticStream = sanitizedStream((line: string): void => { const value = parseGitReadDiagnostic(line); if (value && gitDiagnostics.length < 8) gitDiagnostics.push(value); });
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
    if (!ownedAppProcess.stderr) throw new Error('Owned Electron diagnostic pipe unavailable');
    ownedAppProcess.stderr.on('data', (chunk: Buffer) => diagnosticStream.write(chunk));
    ownedAppProcess.stderr.once('end', () => diagnosticStream.end());
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
    await page.exposeFunction('ownedTestRequest', async ({ method, input }: { method: string; input: Record<string, unknown> }): Promise<unknown> => {
      const config = await readProductConfiguration(path.join(dataRoot, 'runtime'), testOnlyProductSecretProtector());
      const envelope = JSON.parse(await readFile(path.join(dataRoot, 'runtime', 'product-endpoint.json'), 'utf8')) as { body: string; mac: string };
      const mac = createHmac('sha256', config.daemonSecret).update(envelope.body).digest('hex');
      if (mac !== envelope.mac) throw new Error('Owned test endpoint authentication failed');
      const endpoint = JSON.parse(envelope.body) as { port: number; ownerId: string };
      if (endpoint.ownerId !== config.ownerId || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new Error('Owned test endpoint changed');
      const tool = method === 'prepareOperation' ? 'gotzji_prepare_operation' : method === 'submit' ? 'gotzji_submit' : null;
      const response = await fetch(`http://127.0.0.1:${endpoint.port}${tool ? `/mcp/${config.mcpPathSecret}` : '/rpc'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.daemonSecret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(tool ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: input } } : { method: method === 'listJobs' ? 'list' : method === 'listCatalog' ? 'catalog' : method, input }),
        signal: AbortSignal.timeout(90000),
      });
      const value = await response.json();
      if (tool) { const result = JSON.parse(value.result.content[0].text); if (value.result.isError) throw new Error(JSON.stringify(result)); return result; }
      if (!value.ok) throw new Error(JSON.stringify(value.error));
      return value.value;
    });
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
        app, page, dataRoot, beforeClose: (action) => { additionalCleanup.push(action); },
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
    } catch (error) {
      failures.push(error);
      const budgetCode = error instanceof Error ? /\bGIT_(?:SNAPSHOT|VALIDATION)_BUDGET\b/u.exec(error.message)?.[0] : undefined;
      if (budgetCode) {
        try { await expect.poll(() => gitDiagnostics.some(value => value.code === budgetCode), { timeout: 2000, intervals: [20, 50, 100] }).toBe(true); }
        catch (cause) { failures.push(new Error('Owned Git budget diagnostic missing before shutdown', { cause })); }
      }
    }
    for (const close of additionalCleanup.reverse()) {
      try { await close(); } catch (error) { additionalResourcesAbsent = false; failures.push(error); }
    }
    // Keep SQLite coordination alive across the forced disposable-tree shutdown.
    // This historical read mark is released before taking the authoritative census.
    let workerDatabase: DatabaseSync | undefined;
    if (hostWasReady && dataRootVerified) {
      try {
        const databasePath = path.join(dataRoot, 'runtime', 'core.sqlite');
        if (await realpath(databasePath) !== databasePath) throw new Error('Worker database cleanup scope denied');
        workerDatabase = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
        workerDatabase.exec('BEGIN;');
        workerDatabase.prepare('SELECT COUNT(*) FROM gotzji_workers').get();
      } catch (error) { failures.push(error); }
    }
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
        try {
          if (!workerDatabase) throw new Error('Owned worker census connection unavailable');
          workerDatabase.exec('COMMIT;');
          await stopOwnedTestWorkers(dataRoot, workerDatabase); workersAbsent = true;
        }
        catch (error) { failures.push(error); }
      }
    }
    if (ownedAppProcess && uiAbsent && hostAbsent) {
      try { await terminateProcessTree(ownedAppProcess); } catch (error) { failures.push(error); }
      try { await expect.poll(() => ownedAppProcess.exitCode !== null || ownedAppProcess.signalCode !== null, { timeout: 5_000, intervals: [50, 100, 250] }).toBe(true); launcherAbsent = true; }
      catch (error) { failures.push(error); }
    }
    let databaseClosed = workerDatabase === undefined;
    if (workerDatabase) {
      try { workerDatabase.close(); databaseClosed = true; }
      catch (error) { failures.push(error); }
    }
    if (gitDiagnostics.length) console.info(JSON.stringify({ fixture: 'owned-git-budget-diagnostics', observations: gitDiagnostics }));
    const resourcesAbsent = uiAbsent && hostAbsent && workersAbsent && launcherAbsent && databaseClosed && additionalResourcesAbsent;
    if (!resourcesAbsent) failures.push(new Error(`Owned fixture processes unproved; retained ${dataRoot}, ${roots.join(', ')}`));
    let lastRootRemovalError: unknown;
    const cleanup = await Promise.allSettled([
      dataRootVerified && resourcesAbsent ? expect.poll(async () => {
        try { await rm(dataRoot, { recursive: true, force: true }); return true; }
        catch (error) { lastRootRemovalError = error; return false; }
      }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true).catch(async (cause: unknown): Promise<never> => {
        const evidence = await ownedRootRemovalEvidence(dataRoot, lastRootRemovalError);
        throw new Error(`Owned data-root removal failed: ${JSON.stringify(evidence)}`, { cause });
      }) : Promise.reject(new Error('Unverified data-root cleanup refused')),
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
    await page.evaluate(async (rootPath) => Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId: 'library-panel', displayName: 'Library route fixture', rootPath, kind: 'library' } }), libraryProjectRoot);
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
    await page.getByRole('button', { name: /^Library route fixture ·/ }).click();
    await expect(page.getByRole('heading', { name: 'ช่องทาง Library สำหรับ lnwjud', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'เชื่อมโครงการ Library นี้', exact: true })).toBeEnabled();

    const projectFilesRoot = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
    await writeFile(path.join(projectFilesRoot, 'welcome.txt'), 'Original sample\n', 'utf8');
    await writeFile(path.join(projectFilesRoot, 'many-matches.txt'), 'MATCH_LITERAL\n'.repeat(101), 'utf8');
    await page.evaluate(async (rootPath) => Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId: 'files-panel', displayName: 'Project files fixture', rootPath, kind: 'project' } }), projectFilesRoot);
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
    await page.getByRole('button', { name: /^Project files fixture ·/ }).click();
    await expect(page.getByRole('heading', { name: 'ไฟล์ในโครงการ', exact: true })).toBeVisible();
    await page.getByText('เทียบความสามารถกับ lnwjud', { exact: true }).click();
    await page.getByLabel('ค้นหาเครื่องมืออ้างอิง', { exact: true }).fill('read_file');
    await expect(page.getByRole('row').filter({ has: page.getByText('read_file', { exact: true }) })).toContainText('รองรับบางส่วน');
    await page.getByLabel('ค้นหาเครื่องมืออ้างอิง', { exact: true }).fill('checkpoint_goal_engineering');
    const aliasRow = page.getByRole('row').filter({ has: page.getByText('checkpoint_goal_engineering', { exact: true }) });
    await expect(aliasRow).toContainText('ยังต้องเชื่อม');
    await expect(aliasRow).toContainText('รายการจากชุดโปรแกรมต้นฉบับ');
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
    await page.getByRole('button', { name: 'คัดลอกงานแก้ไฟล์สำหรับ ChatGPT', exact: true }).click();
    expect(await readFile(path.join(projectFilesRoot, 'welcome.txt'), 'utf8')).toBe('Original sample\n');
    expect(await page.evaluate(async () => Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }))).toEqual([]);
    const job = await page.evaluate(async () => {
      const prepared = await Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input: { requestId: crypto.randomUUID(), projectId: 'files-panel', operation: 'file.write', path: 'welcome.txt', content: 'Final verified sample\n', expectedSha256: 'c756ad53baf0a71f68a515aee33a15929ecaf580870512686726b0d3686210ae' } });
      return Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId: prepared.preparationId } });
    });
    await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
    await page.getByLabel('รหัสงาน', { exact: true }).fill(job.jobId);
    await expect(page.getByRole('heading', { name: /^งาน [a-f0-9]{64}$/ })).toBeVisible();
    await expect(page.getByText('เสร็จแล้ว', { exact: true })).toBeVisible({ timeout: testInfo.timeout });
    expect(await readFile(path.join(projectFilesRoot, 'welcome.txt'), 'utf8')).toBe('Final verified sample\n');
    await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();

    const firstJobHeading = await page.getByRole('heading', { name: /^งาน [a-f0-9]{64}$/ }).textContent();
    const firstJobId = firstJobHeading?.match(/[a-f0-9]{64}/u)?.[0];
    expect(firstJobId).toBeTruthy();
    await expect(page.getByRole('heading', { name: 'บันทึกไฟล์แล้ว', exact: true })).toBeVisible();
    await expect(page.getByText('มีสำเนาต้นฉบับในหลักฐานของงานนี้', { exact: true })).toBeVisible();
    await page.getByRole('region', { name: 'ผลลัพธ์ไฟล์', exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'windows-ui-file-result.png') });
    await page.getByText('รายละเอียดการตรวจยืนยัน', { exact: true }).click();
    await expect(page.locator('pre:visible')).toContainText('"path": "welcome.txt"');
    await expect(page.locator('pre:visible')).toContainText('1eb5f5d070d4535515a4636073d6d716a4f031b51a75255866e2723b37d6e443');

});

test('gotzji same-job file result shows readable content and survives reselecting after reload', async ({ gotzji }) => {
  const { page } = gotzji; const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await writeFile(path.join(root, 'result.txt'), '<script>ข้อความจากไฟล์</script>\n', 'utf8');
  const jobId = await page.evaluate(async rootPath => {
    await window.gotzji.request({ method: 'registerProject', input: { projectId: 'read-result', displayName: 'โครงการผลอ่านไฟล์', rootPath } });
    const prepared = await Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input: { requestId: crypto.randomUUID(), projectId: 'read-result', operation: 'file.read', path: 'result.txt' } });
    const job = await Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId: prepared.preparationId } });
    return job.jobId as string;
  }, root);
  await expect.poll(async () => page.evaluate(async id => (await window.gotzji.request({ method: 'status', input: { jobId: id } }) as { status: string }).status, jobId)).toBe('completed');
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
    await page.getByLabel('รหัสงาน', { exact: true }).fill(jobId);
    await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
    const readable = page.getByRole('region', { name: 'ผลลัพธ์ไฟล์', exact: true });
    await expect(readable.getByRole('heading', { name: 'อ่านไฟล์แล้ว', exact: true })).toBeVisible();
    await expect(readable.getByLabel('เนื้อหาไฟล์ที่อ่านได้', { exact: true })).toHaveText('<script>ข้อความจากไฟล์</script>\n');
    await expect(readable.locator('script')).toHaveCount(0);
  }
  expect(await page.evaluate(() => window.gotzji.request({ method: 'listJobs', input: {} }))).toHaveLength(1);
  expect(await readFile(path.join(root, 'result.txt'), 'utf8')).toBe('<script>ข้อความจากไฟล์</script>\n');
});

test('gotzji live Tools search prepares a selected operation without starting work', async ({ gotzji }) => {
  const { page } = gotzji;
  const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await page.evaluate(async rootPath => window.gotzji.request({ method: 'registerProject', input: { projectId: 'tools-search', displayName: 'โครงการค้นหาเครื่องมือ', rootPath } }), root);
  await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
  await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
  await page.getByRole('button', { name: /^โครงการค้นหาเครื่องมือ ·/ }).click();
  const tools = page.getByRole('region', { name: 'เครื่องมือของเครื่องนี้', exact: true });
  await expect(tools).toBeVisible();
  await tools.getByLabel('ค้นหาเครื่องมือ', { exact: true }).fill('อ่านไฟล์');
  await expect(tools.getByText('file.read', { exact: true })).toBeVisible();
  await expect(tools.getByRole('row').filter({ hasText: 'file.write' })).toHaveCount(0);
  await tools.getByLabel('ค้นหาเครื่องมือ', { exact: true }).fill('FILE.READ');
  await tools.getByRole('button', { name: 'เตรียมคำสั่ง', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'เตรียมคำสั่งของโครงการ', exact: true })).toBeVisible();
  await expect(page.locator('select').filter({ has: page.locator('option[value="file.read"]') })).toHaveValue('file.read');
  await page.getByLabel('ไฟล์ในโครงการ', { exact: true }).fill('example.txt');
  await page.getByRole('button', { name: 'คัดลอกคำสั่งสำหรับ ChatGPT', exact: true }).click();
  const clipboard = await gotzji.app.evaluate(async ({ clipboard }) => clipboard.readText());
  expect(clipboard).toContain('"projectId": "tools-search"');
  expect(clipboard).toContain('"operation": "file.read"');
  expect(clipboard).toContain('"path": "example.txt"');
  await tools.getByLabel('ค้นหาเครื่องมือ', { exact: true }).fill('');
  await tools.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'windows-ui-c1-live-tools.png') });
  await tools.getByLabel('ประเภทเครื่องมือ', { exact: true }).selectOption('excel');
  await expect(tools.getByText('file.read', { exact: true })).toHaveCount(0);
  await tools.getByLabel('ความพร้อม', { exact: true }).selectOption('unavailable');
  const unavailable = tools.getByRole('row').filter({ has: page.getByText('excel', { exact: true }) });
  await expect(unavailable).toContainText('ยังเชื่อมและตรวจไม่ครบ');
  await unavailable.getByRole('button', { name: 'ตรวจตั้งค่าเครื่องมือ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ตั้งค่า', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.gotzji.request({ method: 'listJobs', input: {} }))).toEqual([]);
});

test('gotzji Tools filters retain full workflow identity and explain unavailable providers', async ({ gotzji }) => {
  const { page } = gotzji; const fixturePath = gotzji.rendererFixturePath();
  await build({ stdin: { resolveDir: path.join(desktopRoot, 'src', 'renderer'), sourcefile: 'tools-fixture.tsx', loader: 'tsx', contents: `
    import { useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { GotzjiToolsPanel } from './GotzjiToolsPanel.tsx';
    document.getElementById('root').hidden=true;
    const root=document.createElement('div');root.id='tools-proof';document.body.append(root);
    const workflow={name:'library.workflow',projectId:'library-a',workflowId:'report',workflowVersion:'2',state:'available',description:'รายงานภาษาไทย'};
    const catalog=[workflow,{...workflow,workflowVersion:'3'},
      {name:'command.recipe.unbound',recipeId:'unbound',state:'available',description:'Unbound recipe'},
      {name:'excel.range.read',state:'unsupported',reason:'NATIVE_PROVIDER_NOT_QUALIFIED',description:'Native Excel'},
      {name:'external.example',state:'future-state',reason:'NEW_REASON',description:'<script>unsafe</script>'}];
    function Proof(){const [selected,setSelected]=useState(true);const [disabled,setDisabled]=useState(false);const [entries,setEntries]=useState(catalog);const [library,setLibrary]=useState(false);return <>
      <button onClick={()=>setLibrary(!library)}>Toggle Library</button>
      <button onClick={()=>setSelected(!selected)}>Toggle project</button><button onClick={()=>setDisabled(!disabled)}>Toggle host</button><button onClick={()=>setEntries([])}>Empty catalog</button>
      <GotzjiToolsPanel catalog={entries} projectName={selected?'Project A':null} canBindRecipes={!library} disabled={disabled} onPrepare={row=>root.dataset.prepared=JSON.stringify(row)} onProject={()=>root.dataset.action='project'} onSettings={()=>root.dataset.action='settings'}/></>;}
    createRoot(root).render(<Proof/>);
  ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: fixturePath, define: { 'process.env.NODE_ENV': '"production"' } });
  await page.addScriptTag({ url: pathToFileURL(fixturePath).href });
  const proof = page.locator('#tools-proof');
  const search = proof.getByLabel('ค้นหาเครื่องมือ', { exact: true });
  await search.fill('unbound');
  await expect(proof.getByText('คำสั่งนี้ยังไม่ผูกกับโครงการที่เลือก', { exact: true })).toBeVisible();
  await proof.getByRole('button', { name: 'ผูกคำสั่งกับโครงการ', exact: true }).click();
  await expect(proof).toHaveAttribute('data-action', 'project');
  await proof.getByRole('button', { name: 'Toggle Library', exact: true }).click();
  await expect(proof.getByText('คำสั่งแบบนี้ใช้กับโครงการทั่วไป สำหรับ Library ให้เลือกเวิร์กโฟลว์ของโครงการ', { exact: true })).toBeVisible();
  await expect(proof.getByRole('button', { name: 'ผูกคำสั่งกับโครงการ', exact: true })).toHaveCount(0);
  await expect(proof.getByRole('button', { name: 'เลือกโครงการทั่วไป', exact: true })).toBeVisible();
  await search.fill('รายงานภาษาไทย');
  await expect(proof.getByRole('button', { name: 'เตรียมคำสั่ง', exact: true })).toHaveCount(2);
  await proof.getByRole('button', { name: 'เตรียมคำสั่ง', exact: true }).nth(1).click();
  await expect(proof).toHaveAttribute('data-prepared', JSON.stringify({ name: 'library.workflow', projectId: 'library-a', workflowId: 'report', workflowVersion: '3', state: 'available', description: 'รายงานภาษาไทย' }));
  await proof.getByRole('button', { name: 'Toggle host', exact: true }).click();
  await expect(proof.getByRole('button', { name: 'เตรียมคำสั่ง', exact: true }).first()).toBeDisabled();
  await proof.getByRole('button', { name: 'Toggle host', exact: true }).click();
  await proof.getByRole('button', { name: 'Toggle project', exact: true }).click();
  await expect(proof.getByRole('button', { name: 'เตรียมคำสั่ง', exact: true }).first()).toBeDisabled();
  await proof.getByRole('button', { name: 'เลือกโครงการ', exact: true }).click();
  await expect(proof).toHaveAttribute('data-action', 'project');
  await search.fill('');
  await proof.getByLabel('ประเภทเครื่องมือ', { exact: true }).selectOption('excel');
  await proof.getByLabel('ความพร้อม', { exact: true }).selectOption('unavailable');
  await expect(proof.getByText('ยังไม่มีตัวเชื่อมโปรแกรมที่ผ่านการตรวจสำหรับเครื่องมือนี้ ตรวจการติดตั้งและตัวเชื่อมในตั้งค่า', { exact: true })).toBeVisible();
  await proof.getByRole('button', { name: 'ตรวจตั้งค่าเครื่องมือ', exact: true }).click();
  await expect(proof).toHaveAttribute('data-action', 'settings');
  await search.fill('no-such-tool');
  await expect(proof.getByText('ไม่พบเครื่องมือที่ตรงกับตัวกรอง ลองเปลี่ยนคำค้นหรือเลือกทุกประเภท', { exact: true })).toBeVisible();
  await search.fill(''); await proof.getByLabel('ประเภทเครื่องมือ', { exact: true }).selectOption('other');
  await proof.getByText('รายละเอียดจากระบบ', { exact: true }).click();
  await expect(proof.getByText('<script>unsafe</script>', { exact: true })).toBeVisible();
  await expect(proof.locator('script')).toHaveCount(0);
  await proof.getByRole('button', { name: 'Empty catalog', exact: true }).click();
  await expect(proof.getByText('ยังไม่มีรายการจากระบบ ลองรีเฟรชหรือตรวจการเชื่อมต่อ', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.gotzji.request({ method: 'listJobs', input: {} }))).toEqual([]);
});

test('gotzji Tools browser preparation reads the current project session before copying', async ({ gotzji }) => {
  const { page } = gotzji; const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await page.evaluate(async rootPath => window.gotzji.request({ method: 'registerProject', input: { projectId: 'tools-browser', displayName: 'Tools browser fixture', rootPath } }), root);
  const fixturePath = gotzji.rendererFixturePath();
  await build({ stdin: { resolveDir: path.join(desktopRoot, 'src', 'renderer'), sourcefile: 'tools-browser-fixture.tsx', loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client'; import { GotzjiApp } from './GotzjiApp.tsx';
    document.getElementById('root').hidden=true;const root=document.createElement('div');root.id='tools-browser-proof';document.body.append(root);
    const calls=[];Reflect.set(root,'calls',calls);
    const request=async(method,input)=>{calls.push(method);
      if(method==='listCatalog')return [{name:'browser.read',state:'available',description:'Read current page'}];
      if(method==='browserSession')return {state:'ready',projectId:'tools-browser',sessionId:'session-current',tabId:'tab-current',expectedUrl:'https://example.org/',expectedDocumentId:'document-current',allowedOrigins:['https://example.org']};
      if(method==='prepareOperation'||method==='submit')throw new Error('Desktop started work');
      return window.gotzji.request({method,input});};
    createRoot(root,{identifierPrefix:'tools-browser-'}).render(<GotzjiApp requestPort={request}/>);
  ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty', '.webp': 'dataurl' }, outfile: fixturePath, define: { 'process.env.NODE_ENV': '"production"' } });
  await page.addScriptTag({ url: pathToFileURL(fixturePath).href });
  const appView = page.locator('#tools-browser-proof');
  await appView.getByRole('button', { name: 'โครงการ', exact: true }).click();
  await appView.getByRole('button', { name: /^Tools browser fixture ·/ }).click();
  await appView.getByRole('region', { name: 'เครื่องมือของเครื่องนี้', exact: true }).getByRole('button', { name: 'เตรียมคำสั่ง', exact: true }).click();
  await appView.getByRole('button', { name: 'คัดลอกคำสั่งสำหรับ ChatGPT', exact: true }).click();
  await expect(appView.getByText('คัดลอกแล้ว วางข้อความใน ChatGPT เพื่อเริ่มงาน', { exact: true })).toBeVisible();
  const clipboard = await gotzji.app.evaluate(async ({ clipboard }) => clipboard.readText());
  expect(clipboard).toContain('"operation": "browser.read"'); expect(clipboard).toContain('"sessionId": "session-current"');
  expect(clipboard).toContain('"projectId": "tools-browser"'); expect(clipboard).toContain('"expectedDocumentId": "document-current"');
  const calls = await page.evaluate(() => Reflect.get(document.getElementById('tools-browser-proof')!, 'calls')) as string[];
  expect(calls).not.toContain('prepareOperation'); expect(calls).not.toContain('submit');
});

test('gotzji new file retries one real admission after a lost acknowledgement', async ({ gotzji }, testInfo) => {
    const { page } = gotzji;
    const projectFilesRoot = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
    await writeFile(path.join(projectFilesRoot, 'welcome.txt'), 'Original sample\n', 'utf8');
    await writeFile(path.join(projectFilesRoot, 'many-matches.txt'), 'MATCH_LITERAL\n'.repeat(101), 'utf8');
    await page.evaluate(async (rootPath) => Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId: 'files-panel', displayName: 'Project files fixture', rootPath, kind: 'project' } }), projectFilesRoot);
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
      const request = (method, input) => {
        const pending = (async () => {
          const result = await Reflect.get(window, 'ownedTestRequest')({ method, input });
          if (method === 'submit' && discard) {
            if (!result || typeof result.jobId !== 'string') throw new Error('Expected actual admitted job');
            discard = false; root.dataset.admittedJobId = result.jobId;
            throw new Error('LOST_ACK_AFTER_REAL_ADMISSION');
          }
          return result;
        })();
        if (method === 'submit') Reflect.set(root, 'ownedSubmitPromise', pending);
        return pending;
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
    await waitForOwnedSubmission(page, 'lost-ack-fixture');
    expect(await page.locator('#lost-ack-fixture').getAttribute('data-observed-job-id')).toBe(acceptedJobId);
    await page.evaluate(() => { document.getElementById('lost-ack-fixture')!.remove(); document.getElementById('root')!.hidden = false; });
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
    await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
    await page.getByRole('button').filter({ has: page.getByText(acceptedJobId!, { exact: true }) }).click();
    await expect(page.getByRole('heading', { name: `งาน ${acceptedJobId}`, exact: true })).toBeVisible();
    await expect(page.getByText('เสร็จแล้ว', { exact: true })).toBeVisible({ timeout: testInfo.timeout });
    expect(await readFile(path.join(projectFilesRoot, 'new-file.txt'), 'utf8')).toBe('Created exactly once\n');
    const createdJobs = await page.evaluate(async () => Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }));
    expect(Array.isArray(createdJobs)).toBe(true);
    expect((createdJobs as { jobId: string; projectId?: string }[]).filter((job) => job.projectId === 'files-panel')).toHaveLength(1);
    await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'สร้างไฟล์ใหม่แล้ว', exact: true })).toBeVisible();
    await page.getByText('รายละเอียดการตรวจยืนยัน', { exact: true }).click();
    await expect(page.locator('pre:visible')).toContainText('"path": "new-file.txt"');
    await expect(page.locator('pre:visible')).toContainText('"state": "completed"');

});

test('gotzji Git status, selected diff and history preserve the source index', async ({ gotzji }) => {
    // Enclose fixture entry/materialization, the 90s read transport and owned teardown.
    test.setTimeout(180_000);
    const { page } = gotzji;
    const projectFilesRoot = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
    await writeFile(path.join(projectFilesRoot, 'welcome.txt'), 'Original sample\n', 'utf8');
    await writeFile(path.join(projectFilesRoot, 'many-matches.txt'), 'MATCH_LITERAL\n'.repeat(101), 'utf8');
    await page.evaluate(async (rootPath) => Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId: 'files-panel', displayName: 'Project files fixture', rootPath, kind: 'project' } }), projectFilesRoot);
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
    // Prove the 10,020-object case in the separately spawned real Core, through Desktop IPC.
    const objects = Array.from({ length: 10020 }, (_, index) => {
      const text = `Synthetic owned Desktop object ${index}`;
      const content = Buffer.from(`blob ${Buffer.byteLength(text)}\0${text}`);
      const hash = createHash('sha1').update(content).digest('hex');
      return { path: path.join(projectFilesRoot!, '.git', 'objects', hash.slice(0, 2), hash.slice(2)), content: deflateSync(content) };
    });
    await Promise.all([...new Set(objects.map((entry) => path.dirname(entry.path)))].map((directory) => mkdir(directory, { recursive: true })));
    for (let offset = 0; offset < objects.length; offset += 64) await Promise.all(objects.slice(offset, offset + 64).map((entry) => writeFile(entry.path, entry.content)));
    const started = performance.now();
    let readSettled = false;
    const pendingRead = page.evaluate(() => Reflect.get(window, 'ownedTestRequest')({ method: 'readProjectGit', input: { projectId: 'files-panel', view: 'status' } })).finally(() => { readSettled = true; });
    const controlProbe = page.evaluate(() => window.gotzji.hostStatus()).then((status) => {
      expect(status.state).toBe('ready'); expect(readSettled).toBe(false);
    });
    // Neither a failed control probe nor a failed read may abandon the other owned call.
    const [read, control] = await Promise.allSettled([pendingRead, controlProbe]);
    if (read.status === 'rejected' && control.status === 'rejected') throw new AggregateError([read.reason, control.reason], `Owned Git read and concurrent control failed: ${read.reason instanceof Error ? read.reason.message : String(read.reason)}; ${control.reason instanceof Error ? control.reason.message : String(control.reason)}`);
    if (read.status === 'rejected') throw read.reason;
    if (control.status === 'rejected') throw control.reason;
    const result = read.value;
    expect(result).toMatchObject({ view: 'status', truncated: false, entries: expect.arrayContaining([expect.objectContaining({ path: 'welcome.txt', kind: 'modified' })]) });
    console.info(JSON.stringify({ fixture: 'desktop-10020-objects', phase: 'read-completed', elapsedMs: Math.round(performance.now() - started) }));
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
    await Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId: 'workflow-a', displayName: 'Workflow A', rootPath: a, kind: 'project' } });
    await Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId: 'workflow-b', displayName: 'Workflow B', rootPath: b, kind: 'project' } });
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
  expect(await page.evaluate(async () => Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }))).toEqual([]);
  expect(await readFile(path.join(rootA, 'data.csv'), 'utf8')).toBe('id,value\n1,original\n');
  expect(await readdir(rootA)).toEqual(['data.csv']);
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c1b-workflows.png') });
});

async function stopOwnedTestWorkers(dataRoot: string, db: DatabaseSync): Promise<void> {
  const runtime = path.join(dataRoot, 'runtime');
  const base = path.join(runtime, 'workers');
  const census = (): WorkerRow[] => {
    try { return db.prepare('SELECT * FROM gotzji_workers ORDER BY epoch').all() as unknown as WorkerRow[]; }
    catch (error) {
      const details = error as Error & { code?: string; errcode?: number; errstr?: string };
      throw new Error(`Owned worker census failed: ${details.message} (${details.code ?? ''}, ${details.errcode ?? ''}, ${details.errstr ?? ''})`, { cause: error });
    }
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

test('gotzji live logs page the same command and selected cancellation preserves independent work', async ({ gotzji }, testInfo) => {
  const { page } = gotzji;
  const rootA = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  const rootB = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  const script = `import{existsSync,writeFileSync}from'node:fs';writeFileSync('started.txt','one',{flag:'wx'});process.stdout.write('PAGE_FIRST\\n'+'x'.repeat(8180)+'ภาษาไทย🌟'.repeat(500)+'\\nPAGE_END\\n');const timer=setInterval(()=>{if(existsSync('finish.flag')){clearInterval(timer);console.log('FINISHED_ONCE');}},50);`;
  await Promise.all([writeFile(path.join(rootA, 'job.mjs'), script), writeFile(path.join(rootB, 'job.mjs'), script)]);
  const ids = await page.evaluate(async ({ a, b, executable }) => {
    const recipe = await Reflect.get(window, 'ownedTestRequest')({ method: 'registerRecipe', input: { recipeId: 'owned-log-command', displayName: 'Owned log proof', executable, args: ['${projectRoot}/job.mjs'], dependencies: ['${projectRoot}/job.mjs'], timeoutMs: 60000, writeScope: 'project' } }) as { recipeId: string };
    const jobs: string[] = [];
    for (const [projectId, rootPath] of [['log-a', a], ['log-b', b]]) {
      await Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId, displayName: projectId, rootPath, kind: 'project', recipeIds: [recipe.recipeId] } });
      const prepared = await Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input: { requestId: crypto.randomUUID(), projectId, operation: 'command.run', commandId: recipe.recipeId } }) as { preparationId: string };
      const job = await Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId: prepared.preparationId } }) as { jobId: string };
      jobs.push(job.jobId);
    }
    return jobs;
  }, { a: rootA, b: rootB, executable: await realpath(process.execPath) });
  for (const jobId of ids) await expect.poll(async () => page.evaluate(async (id) => (await Reflect.get(window, 'ownedTestRequest')({ method: 'status', input: { jobId: id } }) as { status: string }).status, jobId), { timeout: testInfo.timeout }).toBe('running');
  await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
  await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
  await page.getByLabel('รหัสงาน', { exact: true }).fill(ids[0]!);
  await expect(page.getByRole('heading', { name: `งาน ${ids[0]}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'อ่านบันทึกต่อ', exact: true }).click();
  const viewer = page.getByRole('region', { name: 'ข้อความบันทึกของงานที่เลือก', exact: true });
  await expect(viewer.getByLabel('บันทึกของงาน', { exact: true })).toContainText('PAGE_FIRST');
  await expect(viewer.getByLabel('บันทึกของงาน', { exact: true })).toContainText('PAGE_END');
  expect((await viewer.getByLabel('บันทึกของงาน', { exact: true }).textContent())?.match(/PAGE_FIRST/gu)).toHaveLength(1);
  await expect(viewer.getByLabel('บันทึกของงาน', { exact: true })).toContainText('ภาษาไทย🌟'.repeat(500));
  await expect(viewer.getByLabel('บันทึกของงาน', { exact: true })).not.toContainText('\uFFFD');
  await viewer.getByRole('button', { name: 'พักการติดตาม', exact: true }).click();
  await expect(viewer.getByRole('status')).toContainText('พักการติดตามแล้ว');
  await viewer.getByLabel('กรองข้อความที่แสดง', { exact: true }).fill('PAGE_END');
  await expect(viewer.getByLabel('บันทึกของงาน', { exact: true })).toHaveText('PAGE_END');
  await viewer.getByLabel('กรองข้อความที่แสดง', { exact: true }).fill('missing-filter');
  await expect(viewer.getByText('ไม่พบข้อความที่ตรงกับตัวกรองในส่วนที่อ่านไว้', { exact: true })).toBeVisible();
  await viewer.getByLabel('กรองข้อความที่แสดง', { exact: true }).fill('PAGE_END');
  await viewer.getByRole('button', { name: 'อ่านบันทึกต่อ', exact: true }).click();
  await expect(viewer.getByRole('status')).toContainText('พักการติดตามแล้ว');
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c3a-live-logs.png') });
  await page.getByRole('button', { name: 'ดูสถานะและผลลัพธ์', exact: true }).click();
  await page.getByRole('button', { name: 'ยกเลิกงานนี้', exact: true }).click();
  const selected = page.locator('section').filter({ has: page.getByRole('heading', { name: `งาน ${ids[0]}`, exact: true }) });
  await expect(selected.getByText('ยกเลิกแล้ว', { exact: true })).toBeVisible({ timeout: testInfo.timeout });
  expect(await page.evaluate(async (id) => (await Reflect.get(window, 'ownedTestRequest')({ method: 'status', input: { jobId: id } }) as { status: string }).status, ids[1]!)).toBe('running');
  await writeFile(path.join(rootB, 'finish.flag'), 'finish owned job');
  await page.getByLabel('รหัสงาน', { exact: true }).fill(ids[1]!);
  const finished = page.locator('section').filter({ has: page.getByRole('heading', { name: `งาน ${ids[1]}`, exact: true }) });
  await expect(finished.getByText('เสร็จแล้ว', { exact: true })).toBeVisible({ timeout: testInfo.timeout });
  await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
  await expect(finished.getByRole('heading', { name: 'คำสั่งจบแล้ว', exact: true })).toBeVisible();
  await finished.getByText('รายละเอียดการตรวจยืนยัน', { exact: true }).click();
  await expect(finished.locator('pre:visible')).toContainText('"exitCode": 0');
  await finished.getByRole('button', { name: 'อ่านบันทึกของงานนี้', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'บันทึกสด', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: `งาน ${ids[1]}`, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'ข้อความบันทึกของงานที่เลือก', exact: true }).getByLabel('บันทึกของงาน', { exact: true })).toContainText('PAGE_FIRST');
  expect(await readFile(path.join(rootA, 'started.txt'), 'utf8')).toBe('one');
  expect(await readFile(path.join(rootB, 'started.txt'), 'utf8')).toBe('one');
  expect(await page.evaluate(async () => (await Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }) as unknown[]).length)).toBe(2);
});

test('gotzji owned fixture proves cleanup while its command is still running', async ({ gotzji }, testInfo) => {
  const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await writeFile(path.join(root, 'running.mjs'), `import{writeFileSync}from'node:fs';writeFileSync('started.txt','one',{flag:'wx'});console.log('OWNED_ACTIVE_COMMAND');setInterval(()=>undefined,100);`);
  const jobId = await gotzji.page.evaluate(async ({ rootPath, executable }) => {
    const recipe = await Reflect.get(window, 'ownedTestRequest')({ method: 'registerRecipe', input: { recipeId: 'owned-active-command', executable, args: ['${projectRoot}/running.mjs'], dependencies: ['${projectRoot}/running.mjs'], timeoutMs: 60000, writeScope: 'project' } }) as { recipeId: string };
    await Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId: 'active-cleanup', displayName: 'Owned active cleanup', rootPath, recipeIds: [recipe.recipeId] } });
    const preparation = await Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input: { requestId: crypto.randomUUID(), projectId: 'active-cleanup', operation: 'command.run', commandId: recipe.recipeId } }) as { preparationId: string };
    const job = await Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId: preparation.preparationId } }) as { jobId: string };
    return job.jobId;
  }, { rootPath: root, executable: await realpath(process.execPath) });
  await expect.poll(async () => {
    try { return await readFile(path.join(root, 'started.txt'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }, { timeout: testInfo.timeout }).toBe('one');
  expect(await gotzji.page.evaluate(async (id) => (await Reflect.get(window, 'ownedTestRequest')({ method: 'status', input: { jobId: id } }) as { status: string }).status, jobId)).toBe('running');
  // Deliberately leave this isolated command active. The shared fixture must stop
  // and independently prove every owned descendant absent before deleting roots.
});

test('gotzji guided project command prepares without effects and starts one reviewed command', async ({ gotzji }, testInfo) => {
  const { page } = gotzji;
  const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await writeFile(path.join(root, 'check.mjs'), `import{writeFileSync}from'node:fs';writeFileSync('started.txt','one',{flag:'wx'});writeFileSync('verified.txt','Verified by the reviewed command');console.log('ตรวจเสร็จแล้ว 🌟');`);
  const recipeId = await page.evaluate(async ({ rootPath, executable }) => {
    const recipe = await Reflect.get(window, 'ownedTestRequest')({ method: 'registerRecipe', input: { recipeId: 'guide-check', displayName: 'ตรวจโครงการตัวอย่าง', executable, args: ['${projectRoot}/check.mjs'], dependencies: ['${projectRoot}/check.mjs'], timeoutMs: 30000, writeScope: 'project' } }) as { recipeId: string };
    await Reflect.get(window, 'ownedTestRequest')({ method: 'registerRecipe', input: { recipeId: 'unbound-check', displayName: 'คำสั่งที่ไม่ผูกกับโครงการ', executable, args: ['${projectRoot}/check.mjs'], dependencies: ['${projectRoot}/check.mjs'], timeoutMs: 30000, writeScope: 'project' } });
    await Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId: 'guide-project', displayName: 'โครงการคำสั่งตัวอย่าง', rootPath, recipeIds: [recipe.recipeId] } });
    return recipe.recipeId;
  }, { rootPath: root, executable: await realpath(process.execPath) });
  await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
  await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
  await page.getByRole('button', { name: /^โครงการคำสั่งตัวอย่าง ·/u }).click();
  const commands = page.getByRole('region', { name: 'คำสั่งที่ผูกกับโครงการ', exact: true });
  await expect(commands.getByRole('heading', { name: 'คำสั่งสำหรับ ChatGPT', exact: true })).toBeVisible();
  await commands.getByRole('button', { name: 'คัดลอกคำสั่ง ตรวจโครงการตัวอย่าง', exact: true }).click();
  await expect(commands.getByRole('status')).toContainText('คัดลอกแล้ว');
  expect(await page.evaluate(async () => Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }))).toEqual([]);
  expect(await readdir(root)).toEqual(['check.mjs']);
  const job = await page.evaluate(async (commandId) => {
    const preparation = await Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input: { requestId: crypto.randomUUID(), projectId: 'guide-project', operation: 'command.run', commandId } });
    return Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId: preparation.preparationId } });
  }, recipeId);
  await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
  await page.getByLabel('รหัสงาน', { exact: true }).fill(job.jobId);
  const heading = page.getByRole('heading', { name: /^งาน [a-f0-9]{64}$/u });
  await expect(heading).toBeVisible();
  await expect(page.getByText('เสร็จแล้ว', { exact: true })).toBeVisible({ timeout: testInfo.timeout });
  expect(await readFile(path.join(root, 'started.txt'), 'utf8')).toBe('one');
  expect(await readFile(path.join(root, 'verified.txt'), 'utf8')).toBe('Verified by the reviewed command');
  await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'คำสั่งจบแล้ว', exact: true })).toBeVisible();
  await page.getByText('รายละเอียดการตรวจยืนยัน', { exact: true }).click();
  await expect(page.locator('pre:visible')).toContainText('"exitCode": 0');
  expect(await page.evaluate(async () => (await Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }) as unknown[]).length)).toBe(1);
});

test('gotzji Windows navigation follows lnwjud and retains the selected project and queue', async ({ gotzji }) => {
  const { page } = gotzji;
  const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await page.evaluate(async rootPath => {
    await window.gotzji.request({ method: 'registerProject', input: { projectId: 'windows-navigation', displayName: 'โครงการเมนู Windows', rootPath } });
    await window.gotzji.request({ method: 'selectProject', input: { projectId: 'windows-navigation' } });
  }, root);
  await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
  const navigation = page.getByRole('navigation');
  await expect(navigation.getByRole('button')).toHaveText(['หน้าแรก', 'โครงการ', 'เวิร์กโฟลว์', 'เครื่องมือ', 'Git', 'ประวัติงาน', 'บันทึกสด', 'ตั้งค่า', 'ตรวจระบบ']);
  await page.getByRole('button', { name: 'เปิดคิวงาน', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'คิวงาน', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'งานที่กำลังรอ', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'รายการงาน', exact: true }).click();
  await expect(page.getByLabel('รหัสงาน', { exact: true })).toBeVisible();
  for (const name of ['เวิร์กโฟลว์', 'บันทึกสด', 'โครงการ', 'หน้าแรก']) await navigation.getByRole('button', { name, exact: true }).click();
  await expect(page.getByText('โครงการที่เลือก: โครงการเมนู Windows', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('โครงการที่เลือก: โครงการเมนู Windows', { exact: true })).toBeVisible();
  expect(await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} }))).toEqual([]);
});

test('gotzji Windows folder selection opens current project instructions and canonical history', async ({ gotzji }) => {
  const { page, app } = gotzji;
  const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await writeFile(path.join(root, 'AGENTS.md'), 'กติกาปัจจุบันของโครงการ Windows\n');
  await writeFile(path.join(root, 'CLAUDE.md'), 'คำแนะนำเพิ่มเติมของโครงการ Windows\n');
  await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
  const rootInput = page.getByLabel('โฟลเดอร์โครงการ', { exact: true });
  await rootInput.fill(path.join(root, 'previous-selection'));
  await app.evaluate(({ dialog }) => {
    Reflect.set(globalThis, '__gotzjiOriginalOpenDialog', dialog.showOpenDialog);
    dialog.showOpenDialog = async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] });
  });
  try {
    await page.getByRole('button', { name: 'เลือกโฟลเดอร์โครงการ', exact: true }).click();
    await expect(rootInput).toHaveValue(path.join(root, 'previous-selection'));
    expect(await page.evaluate(async () => window.gotzji.request({ method: 'listProjects', input: {} }))).toEqual([]);
    await app.evaluate(({ dialog, BrowserWindow }, selectedRoot) => {
      dialog.showOpenDialog = async (...args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> => {
        Reflect.set(globalThis, '__gotzjiFolderDialogCall', { ownedWindow: args[0] === BrowserWindow.getAllWindows()[0], options: args.at(-1) });
        return { canceled: false, filePaths: [selectedRoot] };
      };
    }, root);
    await page.getByRole('button', { name: 'เลือกโฟลเดอร์โครงการ', exact: true }).click();
    await expect(rootInput).toHaveValue(root);
    expect(await app.evaluate(() => Reflect.get(globalThis, '__gotzjiFolderDialogCall'))).toEqual({ ownedWindow: true, options: { title: 'เลือกโฟลเดอร์โครงการ', properties: ['openDirectory'] } });
    expect(await page.evaluate(async () => window.gotzji.request({ method: 'listProjects', input: {} }))).toEqual([]);
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = Reflect.get(globalThis, '__gotzjiOriginalOpenDialog'); });
  }
  await page.getByLabel('รหัสโครงการ', { exact: true }).fill('windows-folder');
  await page.getByLabel('ชื่อโครงการ', { exact: true }).fill('โครงการเลือกด้วย Windows');
  await page.getByRole('button', { name: 'ลงทะเบียน', exact: true }).click();
  await expect(page.getByText('โครงการที่เลือก: โครงการเลือกด้วย Windows', { exact: true })).toBeVisible();
  const context = page.getByRole('region', { name: 'บริบทโครงการ', exact: true });
  await expect(context.getByRole('heading', { name: 'กติกาโครงการปัจจุบัน', exact: true })).toBeVisible();
  await context.getByText('AGENTS.md', { exact: true }).click();
  await expect(context.locator('pre').first()).toContainText('กติกาปัจจุบันของโครงการ Windows');
  await context.getByText('CLAUDE.md', { exact: true }).click();
  await expect(context.locator('pre').nth(1)).toContainText('คำแนะนำเพิ่มเติมของโครงการ Windows');
  expect(await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} }))).toEqual([]);
  const job = await page.evaluate(async () => {
    const prepared = await Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input: { requestId: 'windows-context-history', projectId: 'windows-folder', operation: 'file.read', path: 'AGENTS.md' } });
    return Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId: prepared.preparationId } });
  });
  await expect.poll(async () => page.evaluate(async jobId => (await window.gotzji.request({ method: 'status', input: { jobId } }) as { status: string }).status, job.jobId), { timeout: 15_000 }).toBe('completed');
  await context.getByRole('button', { name: 'อ่านบริบทล่าสุด', exact: true }).click();
  await expect(context.getByText('อ่านไฟล์โครงการ', { exact: true })).toBeVisible();
  await context.getByRole('button', { name: `เปิดงาน ${job.jobId}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `งาน ${job.jobId}`, exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'คิวงาน', exact: true }).click();
  await page.getByRole('tab', { name: 'รายการงาน', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'คิวงาน', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'รายการงาน', exact: true })).toBeFocused();
  await expect(page.getByLabel('รหัสงาน', { exact: true })).toHaveValue(job.jobId);
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'windows-ui-c1-worklog.png') });
  await page.reload();
  await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
  await expect(page.getByText('โครงการที่เลือก: โครงการเลือกด้วย Windows', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `เปิดงาน ${job.jobId}`, exact: true })).toBeVisible();
  expect((await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} })) as unknown[]).length).toBe(1);
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'windows-ui-c1-project.png') });
});

test('gotzji manual navigation wins when a project selection reply arrives late', async ({ gotzji }) => {
  const { page } = gotzji; const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await page.evaluate(async rootPath => window.gotzji.request({ method: 'registerProject', input: { projectId: 'late-selection', displayName: 'โครงการตอบกลับช้า', rootPath } }), root);
  const fixturePath = gotzji.rendererFixturePath();
  await build({ stdin: { resolveDir: path.join(desktopRoot, 'src', 'renderer'), sourcefile: 'project-navigation-fixture.tsx', loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client'; import { GotzjiApp } from './GotzjiApp.tsx';
    document.getElementById('root').hidden=true; const root=document.createElement('div');root.id='late-selection-proof';document.body.append(root);
    const request=async(method,input)=>{
      if(method==='selectProject')return new Promise(resolve=>{Reflect.set(root,'release',async()=>{resolve(await window.gotzji.request({method,input}));});});
      if(method==='prepareOperation'||method==='submit')throw new Error('Desktop started work');
      return window.gotzji.request({method,input});
    };
    createRoot(root,{identifierPrefix:'late-selection-'}).render(<GotzjiApp requestPort={request}/>);
  ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty', '.webp': 'dataurl' }, outfile: fixturePath, define: { 'process.env.NODE_ENV': '"production"' } });
  await page.addScriptTag({ url: pathToFileURL(fixturePath).href });
  const appView = page.locator('#late-selection-proof');
  await appView.getByRole('button', { name: 'โครงการ', exact: true }).click();
  await appView.getByRole('button', { name: /^โครงการตอบกลับช้า ·/u }).click();
  await appView.getByRole('navigation').getByRole('button', { name: 'Git', exact: true }).click();
  await expect(appView.getByRole('heading', { name: 'Git', exact: true })).toBeVisible();
  await page.evaluate(async () => Reflect.get(document.getElementById('late-selection-proof')!, 'release')());
  await expect(appView.getByText('โครงการที่เลือก: โครงการตอบกลับช้า', { exact: true })).toBeVisible();
  await expect(appView.getByRole('heading', { name: 'Git', exact: true })).toBeVisible();
  await expect(appView.getByRole('button', { name: 'อ่านสถานะ Git', exact: true })).toBeEnabled();
  expect(await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} }))).toEqual([]);
});

test('gotzji project context rejects late and wrong-project replies and labels bounded history', async ({ gotzji }) => {
  const { page } = gotzji; const fixturePath = gotzji.rendererFixturePath();
  await build({ stdin: { resolveDir: path.join(desktopRoot, 'src', 'renderer'), sourcefile: 'project-context-fixture.tsx', loader: 'tsx', contents: `
    import { useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { GotzjiProjectContext } from './GotzjiProjectContext.tsx';
    document.getElementById('root').hidden=true;
    const root=document.createElement('div');root.id='context-proof';document.body.append(root);
    let oldReply; let freshReads=0;
    const response=projectId=>({project:{projectId},instructions:[],memory:{summary:projectId+' notes',decisions:[],openQuestions:[],resultPaths:[]},jobs:[{jobId:'existing-job',status:'completed',requestedOperation:'file.read'}],historyTruncated:true});
    const request=async(method,input)=>{
      if(method!=='projectContext')throw new Error('Unexpected work request');
      if(input.projectId==='old')return new Promise(resolve=>{oldReply=resolve;});
      freshReads++; return response(freshReads===1?'fresh':'wrong');
    };
    function Proof(){const [id,setId]=useState('old');return <><button onClick={()=>setId('fresh')}>Switch project</button><button onClick={()=>oldReply(response('old'))}>Finish old reply</button><GotzjiProjectContext projectId={id} request={request} onJob={jobId=>root.dataset.job=jobId}/></>;}
    createRoot(root).render(<Proof/>);
  ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: fixturePath, define: { 'process.env.NODE_ENV': '"production"' } });
  await page.addScriptTag({ url: pathToFileURL(fixturePath).href });
  const proof = page.locator('#context-proof');
  await expect(proof.getByText('กำลังอ่านบริบท…', { exact: true })).toBeVisible();
  await proof.getByRole('button', { name: 'Switch project', exact: true }).click();
  await expect(proof.getByText('fresh notes', { exact: true })).toBeVisible();
  await expect(proof.getByText('แสดงเฉพาะ 25 งานล่าสุดของโครงการนี้', { exact: true })).toBeVisible();
  await proof.getByRole('button', { name: 'Finish old reply', exact: true }).click();
  await expect(proof.getByText('fresh notes', { exact: true })).toBeVisible();
  await expect(proof.getByText('old notes', { exact: true })).toHaveCount(0);
  await proof.getByRole('button', { name: 'เปิดงาน existing-job', exact: true }).click();
  await expect(proof).toHaveAttribute('data-job', 'existing-job');
  await proof.getByRole('button', { name: 'อ่านบริบทล่าสุด', exact: true }).click();
  await expect(proof.getByRole('alert')).toContainText('ยังอ่านบริบทไม่ได้');
  await expect(proof.getByText('wrong notes', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} }))).toEqual([]);
});

test('gotzji project selection survives page reload and Desktop cannot start new work', async ({ gotzji }) => {
  const { page } = gotzji;
  const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await writeFile(path.join(root, 'AGENTS.md'), 'Current selected-project instructions');
  await page.evaluate(async (rootPath) => window.gotzji.request({ method: 'registerProject', input: { projectId: 'continuation', displayName: 'โครงการที่ทำต่อ', rootPath } }), root);
  await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
  await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
  await page.getByRole('button', { name: /^โครงการที่ทำต่อ ·/u }).click();
  await page.reload();
  await expect(page.getByText('โครงการที่เลือก: โครงการที่ทำต่อ', { exact: true })).toBeVisible();
  const context = await page.evaluate(async () => window.gotzji.request({ method: 'projectContext', input: {} }));
  expect(context).toMatchObject({ project: { projectId: 'continuation' }, instructions: [{ content: 'Current selected-project instructions' }], jobs: [] });
  const refused = await page.evaluate(async () => {
    try { await window.gotzji.request({ method: 'prepareOperation', input: { requestId: crypto.randomUUID(), projectId: 'continuation', operation: 'file.read', path: 'AGENTS.md' } }); return 'unexpected'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  });
  expect(refused).toContain('CHATGPT_START_REQUIRED');
  expect(await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} }))).toEqual([]);
});

test('gotzji app archives and restores one project while retaining files, memory and canonical history', async ({ gotzji }, testInfo) => {
  const { page } = gotzji;
  const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await writeFile(path.join(root, 'AGENTS.md'), 'Current archive-project instructions\n');
  await writeFile(path.join(root, 'source.txt'), 'Original project file\n');
  await page.evaluate(async (rootPath) => window.gotzji.request({ method: 'registerProject', input: { projectId: 'archive-proof', displayName: 'โครงการเก็บและนำกลับ', rootPath } }), root);
  await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click();
  await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
  await page.getByRole('button', { name: /^โครงการเก็บและนำกลับ ·/u }).click();
  const prepared = await page.evaluate(async () => {
    await window.gotzji.request({ method: 'saveProjectMemory', input: { projectId: 'archive-proof', expectedRevision: 0, memory: { summary: 'สรุปก่อนเก็บโครงการ', decisions: ['ใช้ไฟล์เดิม'], openQuestions: ['ตรวจผลเมื่อเปิดกลับ'], resultPaths: ['verified.txt'] } } });
    const stale = await Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input: { requestId: 'archive-stale-preparation', projectId: 'archive-proof', operation: 'file.read', path: 'source.txt' } });
    const creation = await Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input: { requestId: 'archive-verified-output', projectId: 'archive-proof', operation: 'file.write', path: 'verified.txt', expectedSha256: null, content: 'One canonical result\n' } });
    const job = await Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId: creation.preparationId } });
    return { staleId: stale.preparationId as string, jobId: job.jobId as string };
  });
  await expect.poll(async () => page.evaluate(async (jobId) => {
    const status = await window.gotzji.request({ method: 'status', input: { jobId } }) as { status: string };
    return status.status;
  }, prepared.jobId), { timeout: testInfo.timeout }).toBe('completed');
  expect(await readFile(path.join(root, 'verified.txt'), 'utf8')).toBe('One canonical result\n');
  await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
  await page.getByRole('button', { name: 'เก็บโครงการ โครงการเก็บและนำกลับ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'โครงการที่เก็บไว้', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'จัดการโครงการ', exact: true })).toBeFocused();
  await expect(page.getByText('โครงการที่เลือก: โครงการเก็บและนำกลับ', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(async () => window.gotzji.request({ method: 'selectedProject', input: {} }))).toBeNull();
  expect(await page.evaluate(async () => window.gotzji.request({ method: 'listProjects', input: {} }))).toEqual([]);
  const retained = await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} })) as { jobId: string }[];
  expect(retained.map((job) => job.jobId)).toEqual([prepared.jobId]);
  expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('Original project file\n');
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c1-project-archived.png') });
  await page.reload();
  await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
  await page.getByRole('button', { name: 'นำโครงการ โครงการเก็บและนำกลับ กลับมาใช้', exact: true }).focus();
  await page.getByRole('button', { name: 'นำโครงการ โครงการเก็บและนำกลับ กลับมาใช้', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: /^โครงการเก็บและนำกลับ ·/u })).toBeVisible();
  await expect(page.getByRole('region', { name: 'จัดการโครงการ', exact: true })).toBeFocused();
  expect(await page.evaluate(async () => window.gotzji.request({ method: 'selectedProject', input: {} }))).toBeNull();
  const refused = await page.evaluate(async (preparationId) => {
    try { await Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId } }); return 'unexpected'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, prepared.staleId);
  expect(refused).toContain('PROJECT_LIFECYCLE_CHANGED');
  await page.getByRole('button', { name: /^โครงการเก็บและนำกลับ ·/u }).click();
  const context = await page.evaluate(async () => window.gotzji.request({ method: 'projectContext', input: {} }));
  expect(context).toMatchObject({ project: { projectId: 'archive-proof' }, memory: { revision: 1, summary: 'สรุปก่อนเก็บโครงการ', decisions: ['ใช้ไฟล์เดิม'], openQuestions: ['ตรวจผลเมื่อเปิดกลับ'], resultPaths: ['verified.txt'] }, instructions: [{ content: 'Current archive-project instructions\n' }], jobs: [{ jobId: prepared.jobId, status: 'completed' }] });
  await expect(page.evaluate(async () => window.gotzji.request({ method: 'readProjectFile', input: { projectId: 'archive-proof', path: 'verified.txt' } }))).resolves.toMatchObject({ content: 'One canonical result\n' });
  expect((await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} })) as unknown[]).length).toBe(1);
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c1-project-restored.png') });
});

test('gotzji owner approves one ChatGPT delivery request without starting it from Desktop', async ({ gotzji }) => {
  const { page } = gotzji;
  const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await writeFile(path.join(root, 'ship.mjs'), "import {appendFileSync} from 'node:fs';appendFileSync('delivered.txt','once\\n');console.log('delivered once');");
  const prepared = await page.evaluate(async ({ rootPath, executable }) => {
    await Reflect.get(window, 'ownedTestRequest')({ method: 'registerRecipe', input: { recipeId: 'ship-proof', displayName: 'ส่งผลงานทดสอบ', executable, args: ['${projectRoot}/ship.mjs'], dependencies: ['${projectRoot}/ship.mjs'], delivery: true } });
    await Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId: 'delivery-proof', displayName: 'โครงการส่งผลงาน', rootPath, recipeIds: ['ship-proof'] } });
    return Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input: { requestId: 'delivery-proof-once', projectId: 'delivery-proof', operation: 'command.run', commandId: 'ship-proof' } }) as Promise<{ preparationId: string; digest: string }>;
  }, { rootPath: root, executable: await realpath(process.execPath) });
  const panel = page.getByRole('region', { name: 'อนุมัติคำขอส่งมอบ' });
  await panel.getByRole('button', { name: 'อ่านคำขอส่งมอบล่าสุด', exact: true }).click();
  await expect(panel.getByText('โครงการส่งผลงาน · ship-proof', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'อนุมัติคำขอนี้', exact: true })).toBeDisabled();
  await panel.getByText('ตรวจโปรแกรม คำสั่ง และไฟล์ที่ตรึงไว้', { exact: true }).click();
  await expect(panel.getByText(`รหัสยืนยันรายละเอียด: ${prepared.digest}`, { exact: true })).toBeVisible();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'อนุมัติคำขอนี้', exact: true }).click();
  await expect(panel.getByText('อนุมัติแล้ว · ยังไม่ได้เริ่มงาน', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.gotzji.request({ method: 'listJobs', input: {} }))).toEqual([]);
  await page.evaluate(() => {
    Reflect.set(window, '__ownedDeliveryClipboardCalls', 0);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (): Promise<void> => { Reflect.set(window, '__ownedDeliveryClipboardCalls', Number(Reflect.get(window, '__ownedDeliveryClipboardCalls')) + 1); throw new Error('Owned clipboard denial'); } } });
  });
  await panel.getByRole('button', { name: 'คัดลอกคำสั่งกลับไป ChatGPT', exact: true }).click();
  await page.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'c2d-delivery-copy.png') });
  expect(await page.evaluate(() => Reflect.get(window, '__ownedDeliveryClipboardCalls'))).toBe(1);
  await expect(panel.getByRole('status')).toContainText('คัดลอกอัตโนมัติไม่ได้');
  await expect(panel.getByRole('textbox')).toHaveValue(new RegExp(prepared.preparationId));
  await expect(panel.getByLabel('ข้อความสำหรับ ChatGPT', { exact: true })).toHaveValue(new RegExp(prepared.preparationId));
  const job = await page.evaluate(preparationId => Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId } }) as Promise<{ jobId: string }>, prepared.preparationId);
  const replay = await page.evaluate(preparationId => Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId } }) as Promise<{ jobId: string }>, prepared.preparationId);
  expect(replay.jobId).toBe(job.jobId);
  await expect.poll(async () => {
    try { return await readFile(path.join(root, 'delivered.txt'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }, { timeout: 30000 }).toBe('once\n');
  await expect.poll(() => page.evaluate(jobId => window.gotzji.request({ method: 'result', input: { jobId } }).then(() => true).catch(() => false), job.jobId), { timeout: 20000 }).toBe(true);
  expect(await readFile(path.join(root, 'delivered.txt'), 'utf8')).toBe('once\n');
});

test('gotzji browser review retains synthetic renderer admission across hidden pages', async ({ gotzji }) => {
  const { page } = gotzji; const fixturePath = gotzji.rendererFixturePath();
  await build({ stdin: { resolveDir: desktopRoot, sourcefile: 'owned-browser-ui.tsx', loader: 'tsx', contents: `
    import React, { StrictMode, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { GotzjiBrowserPanel } from './src/renderer/GotzjiBrowserPanel.tsx';
    document.getElementById('root').hidden = true;
    const root = document.createElement('div'); root.id = 'browser-ui-proof'; document.body.append(root);
    const calls = []; const oldReplies = []; const admissions = new Map(); let loseAck = true;
    Reflect.set(root, 'calls', calls); Reflect.set(root, 'oldReplies', oldReplies); Reflect.set(root, 'documentId', 'document-a');
    const request = (method, input) => {
      calls.push({method,input});
      const pending = (async () => {
        if (method === 'browserSession') {
          if (!Reflect.get(root, 'inspectionReady')) return new Promise(resolve => oldReplies.push(resolve));
          return { state:'ready',projectId:'renderer-browser',sessionId:'session',tabId:'tab',expectedUrl:'https://example.org/',expectedDocumentId:Reflect.get(root,'documentId'),allowedOrigins:['https://example.org'] };
        }
        if (method === 'prepareOperation') return {preparationId:'preparation-'+calls.filter(entry=>entry.method==='prepareOperation').length};
        if (method === 'submit') {
          if (!admissions.has(input.preparationId)) admissions.set(input.preparationId,'c'.repeat(64));
          root.dataset.syntheticAdmissionCount=String(admissions.size);
          if (loseAck) {loseAck=false;throw new Error('OWNED_RENDERER_LOST_ACK');}
          return {jobId:admissions.get(input.preparationId)};
        }
        throw new Error('UNEXPECTED_RENDERER_METHOD');
      })();
      if (method==='submit') Reflect.set(root,'ownedSubmitPromise',pending);
      return pending;
    };
    function Harness(){const [visible,setVisible]=useState(true);return <div className="gotzji-app"><main>
      <button onClick={()=>setVisible(false)}>ซ่อนแผงทดสอบ</button><button onClick={()=>setVisible(true)}>แสดงแผงทดสอบ</button>
      <GotzjiBrowserPanel projectId="renderer-browser" projectName="Renderer browser fixture" visible={visible} disabled={false} request={request} onChanged={async()=>{}} onJob={id=>{root.dataset.observedJobId=id;}} />
    </main></div>;}
    createRoot(root,{identifierPrefix:'browser-renderer-'}).render(<StrictMode><Harness/></StrictMode>);
  ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: fixturePath, define: { 'process.env.NODE_ENV': '"production"' } });
  await page.addScriptTag({ url: pathToFileURL(fixturePath).href });
  const ui = page.locator('#browser-ui-proof'); const panel = ui.locator('.gotzji-browser-panel');
  await page.evaluate(() => Reflect.set(document.getElementById('browser-ui-proof')!, 'inspectionReady', true));
  await panel.getByRole('button', { name: 'ตรวจหน้าปัจจุบัน', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'ตรวจหน้าที่จะอ่าน', exact: true })).toBeVisible();
  await page.evaluate(() => { const root = document.getElementById('browser-ui-proof')!; const replies = Reflect.get(root, 'oldReplies') as Array<(value: object) => void>; for (const resolve of replies) resolve({ state: 'not-enrolled', projectId: 'renderer-browser' }); });
  await expect(panel.getByRole('status')).toContainText('พร้อมให้เลือกเครื่องมือเบราว์เซอร์');
  await panel.getByRole('button', { name: 'ตรวจหน้าที่จะอ่าน', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'ตรวจหน้าเว็บก่อนเริ่ม', exact: true })).toBeVisible();
  await expect(panel).toContainText('Renderer browser fixture'); await expect(panel).toContainText('https://example.org/');
  expect(await ui.getAttribute('data-synthetic-admission-count')).toBeNull();
  expect(await page.evaluate(async () => (await Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }) as unknown[]).length)).toBe(0);
  await ui.getByRole('button', { name: 'ซ่อนแผงทดสอบ', exact: true }).click(); await expect(panel).toBeHidden();
  await ui.getByRole('button', { name: 'แสดงแผงทดสอบ', exact: true }).click();
  await panel.getByRole('button', { name: 'เริ่มอ่านหน้านี้', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('ยืนยันงานเดิมอีกครั้ง');
  await ui.getByRole('button', { name: 'ซ่อนแผงทดสอบ', exact: true }).click(); await ui.getByRole('button', { name: 'แสดงแผงทดสอบ', exact: true }).click();
  await panel.getByRole('button', { name: 'ยืนยันงานอ่านเดิมอีกครั้ง', exact: true }).click();
  await waitForOwnedSubmission(page, 'browser-ui-proof');
  expect(await ui.getAttribute('data-observed-job-id')).toBe('c'.repeat(64)); expect(await ui.getAttribute('data-synthetic-admission-count')).toBe('1');
  const calls = await page.evaluate(() => Reflect.get(document.getElementById('browser-ui-proof')!, 'calls') as Array<{method:string;input:Record<string,unknown>}>);
  expect(calls.filter(entry=>entry.method==='submit').map(entry=>entry.input)).toEqual([{preparationId:'preparation-1'},{preparationId:'preparation-1'}]);
  expect(calls.filter(entry=>entry.method==='prepareOperation')).toHaveLength(1);
  expect(calls.find(entry=>entry.method==='prepareOperation')?.input).toMatchObject({projectId:'renderer-browser',operation:'browser.read',selector:'body',expectedDocumentId:'document-a'});
  await page.evaluate(() => Reflect.set(document.getElementById('browser-ui-proof')!, 'documentId', 'document-b'));
  await panel.getByRole('button', { name: 'ตรวจหน้าปัจจุบัน', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'ตรวจหน้าเว็บก่อนเริ่ม', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'ตรวจหน้าที่จะอ่าน', exact: true }).click();
  const preparations = await page.evaluate(() => (Reflect.get(document.getElementById('browser-ui-proof')!, 'calls') as Array<{method:string;input:Record<string,unknown>}>).filter(entry=>entry.method==='prepareOperation'));
  expect(preparations).toHaveLength(2); expect(preparations[1]!.input.expectedDocumentId).toBe('document-b');
  expect(preparations[1]!.input.requestId).not.toBe(preparations[0]!.input.requestId);
  expect(await ui.getAttribute('data-synthetic-admission-count')).toBe('1');
  expect(await page.evaluate(async () => (await Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }) as unknown[]).length)).toBe(0);
});

test('gotzji whole-app browser prompts survive navigation without creating modeled work', async ({ gotzji }) => {
  const { page } = gotzji; const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
  await page.evaluate(async rootPath => window.gotzji.request({ method: 'registerProject', input: { projectId: 'browser-navigation', displayName: 'Browser navigation fixture', rootPath } }), root);
  const fixturePath = gotzji.rendererFixturePath();
  await build({ stdin: { resolveDir: path.join(desktopRoot, 'src', 'renderer'), sourcefile: 'browser-navigation-fixture.tsx', loader: 'tsx', contents: `
    import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client';
    import { GotzjiApp } from './GotzjiApp.tsx';
    document.getElementById('root').hidden=true;
    const root=document.createElement('div');root.id='browser-app-proof';document.body.append(root);
    const calls=[];Reflect.set(root,'calls',calls);
    const request=async(method,input)=>{
      calls.push(method);
      if(method==='browserSession')return {state:'ready',projectId:'browser-navigation',sessionId:'model-session',tabId:'model-tab',expectedUrl:'https://example.org/',expectedDocumentId:'model-document',allowedOrigins:['https://example.org']};
      if(method==='prepareOperation'||method==='submit')throw new Error('Desktop started work');
      return window.gotzji.request({method,input});
    };
    createRoot(root,{identifierPrefix:'browser-app-'}).render(<StrictMode><GotzjiApp requestPort={request}/></StrictMode>);
  ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty', '.webp': 'dataurl' }, outfile: fixturePath, define: { 'process.env.NODE_ENV': '"production"' } });
  await page.addScriptTag({ url: pathToFileURL(fixturePath).href });
  const appView = page.locator('#browser-app-proof'); const panel = appView.locator('.gotzji-browser-panel');
  await appView.getByRole('button', { name: 'โครงการ', exact: true }).click();
  await appView.getByRole('button', { name: /^Browser navigation fixture ·/ }).click();
  await panel.getByRole('button', { name: 'คัดลอกงานอ่านหน้าเว็บสำหรับ ChatGPT', exact: true }).click();
  await appView.getByRole('button', { name: 'หน้าแรก', exact: true }).click(); await expect(panel).toBeHidden();
  await appView.getByRole('button', { name: 'เครื่องมือ', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'คัดลอกงานอ่านหน้าเว็บสำหรับ ChatGPT', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'เริ่มอ่านหน้านี้', exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => Reflect.get(document.getElementById('browser-app-proof')!, 'calls')) as string[];
  expect(calls).not.toContain('prepareOperation'); expect(calls).not.toContain('submit');
  expect(await page.evaluate(async () => window.gotzji.request({ method: 'listJobs', input: {} }))).toEqual([]);
});

test.describe('actual Windows Excel qualification', () => {
  test.skip(process.platform !== 'win32' || process.env.GOTZJI_NATIVE_EXCEL_QUALIFICATION !== '1', 'Explicit owned Excel qualification; synthetic and renderer checks are separate evidence');
  test('gotzji Excel worksheet discovery preserves the workbook, prepares a first cell and reads absolute/reversed ranges', async ({ gotzji }, testInfo) => {
    test.setTimeout(120000);
    const { page, dataRoot } = gotzji;
    const projectId = 'native-excel'; const sheetName = 'ข้อมูล ไทย'; const filename = 'ต้นฉบับ.xlsx';
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference='Stop'
      $app=Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\excel.exe' -ErrorAction SilentlyContinue
      [ordered]@{registered=(Test-Path -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\Excel.Application');executable=[string]$app.'(default)';existing=@(Get-CimInstance Win32_Process -Filter "Name='EXCEL.EXE'" | ForEach-Object {$_.ProcessId})} | ConvertTo-Json -Compress
    `], { windowsHide: true, timeout: 15000 });
    const prerequisites = JSON.parse(stdout) as { registered: boolean; executable: string; existing: number[] };
    expect(prerequisites.registered, 'Excel COM registration is required; this preflight creates no COM object').toBe(true);
    expect(path.basename(prerequisites.executable).toLowerCase()).toBe('excel.exe');
    expect(prerequisites.existing, 'Preserve every existing Excel session; do not run this qualification until the owner closes it').toEqual([]);
    const config = await readProductConfiguration(path.join(dataRoot, 'runtime'), testOnlyProductSecretProtector());
    expect(config.native, 'The fresh default host must pin the actual shipped Office provider').toBeDefined();
    expect(config.native!.scriptPath).toBe(path.join(desktopRoot, 'build', 'gotzji-native-office.ps1'));
    expect(config.native!.scriptSha256).toBe(createHash('sha256').update(await readFile(config.native!.scriptPath)).digest('hex'));
    const ExcelJS: typeof import('../../../packages/mcp-server/node_modules/exceljs/index.js') = createRequire(path.join(desktopRoot, '..', '..', 'packages', 'mcp-server', 'package.json'))('exceljs');
    const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName); const summary = workbook.addWorksheet('Summary');
    sheet.getCell('A1').value = 'ข้อมูลคงเดิม'; sheet.getCell('A2').value = 2; sheet.getCell('B2').value = 3;
    sheet.getCell('C2').value = { formula: 'SUM(A2:B2)', result: 5 }; sheet.getCell('D4').value = 'รักษาต้นฉบับ';
    summary.getCell('A1').value = 'Original summary';
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMw7jjzHwAFAAKHH+5aBwAAAABJRU5ErkJggg==', 'base64');
    sheet.addImage(workbook.addImage({ buffer: imageBytes, extension: 'png' }), 'A5:B6');
    const source = path.join(root, filename); await workbook.xlsx.writeFile(source);
    const original = await readFile(source); const sourceSha256 = createHash('sha256').update(original).digest('hex');
    let nativeJobId: string | undefined = undefined;
    const nativeJobIds = new Set<string>();
    const proveExcelAbsent = async (): Promise<void> => {
      for (const nativeJobId of nativeJobIds) {
        const journal = await readFile(path.join(dataRoot, 'runtime', 'effects', nativeJobId, 'native-process-identities.jsonl'), 'utf8');
        const identities = journal.trim().split(/\r?\n/u).map((line) => {
          const record = JSON.parse((JSON.parse(line) as { body: string }).body) as { provider: string; jobId: string; pid: number; birth: string; executable: string };
          expect(record).toMatchObject({ provider: 'office', jobId: nativeJobId });
          expect(Number.isSafeInteger(record.pid) && record.pid > 0).toBe(true);
          expect(record.birth).toMatch(/^\d+$/u); expect(path.basename(record.executable).toLowerCase()).toBe('excel.exe');
          return record;
        });
        expect(identities.length).toBeGreaterThan(0);
        for (let observation = 0; observation < 2; observation++) {
          const actual = await processIdentities(identities.map((identity) => identity.pid));
          for (const identity of identities) {
            expect(actual[identity.pid], 'Unknown process identity is not proof of Excel absence').not.toBe('unknown');
            expect(actual[identity.pid]).toBeDefined();
            expect(sameProcessIdentity(identity, actual[identity.pid])).toBe(false);
          }
        }
      }
    };
    gotzji.beforeClose(async () => {
      try {
        if (nativeJobId) {
          const job = await page.evaluate(async (jobId) => {
            const request = Reflect.get(window, 'ownedTestRequest');
            return { status: await request({ method: 'status', input: { jobId } }), logs: await request({ method: 'logs', input: { jobId, cursor: 0, limit: 8192 } }) };
          }, nativeJobId);
          const envelope = JSON.parse(await readFile(path.join(dataRoot, 'runtime', 'effects', nativeJobId, 'native-operation.json'), 'utf8')) as { body: string };
          const native = JSON.parse(envelope.body) as Record<string, unknown>;
          const cleanup = await readFile(path.join(dataRoot, 'runtime', 'effects', nativeJobId, 'native-cleanup-diagnostic.jsonl'), 'utf8');
          await writeFile(path.join(desktopRoot, '..', '..', '.local-artifacts', `c4-excel-native-${nativeJobId}.json`), JSON.stringify({ jobId: nativeJobId, ...job,
            cleanup: cleanup.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as unknown),
            native: { state: native.state, outcome: native.outcome, code: native.code, field: native.field, stopEvidence: native.stopEvidence, effectEvidence: native.effectEvidence } }, null, 2));
        }
      } finally { await proveExcelAbsent(); }
    });
    await page.evaluate(async ({ rootPath, projectId }) => Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId, displayName: 'Excel จริงของชุดทดสอบ', rootPath, kind: 'project' } }), { rootPath: root, projectId });
    const prepared = await page.evaluate(async (input) => Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input }), { projectId, requestId: 'excel-discovery', operation: 'excel.sheets.inspect', path: filename, expectedSha256: sourceSha256 });
    const admitted = await page.evaluate(async (preparationId) => Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId } }), prepared.preparationId);
    nativeJobId = admitted.jobId;
    nativeJobIds.add(admitted.jobId);
    await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
    await page.getByLabel('รหัสงาน', { exact: true }).fill(admitted.jobId);
    await expect(page.getByRole('heading', { name: `งาน ${admitted.jobId}`, exact: true })).toBeVisible();
    await expect(page.getByText('เสร็จแล้ว', { exact: true })).toBeVisible({ timeout: testInfo.timeout });
    await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
    const table = page.getByRole('region', { name: 'รายชื่อแผ่นงาน Excel', exact: true });
    await expect(table).toContainText('พบ 2 แผ่นงาน · แสดง 2 แผ่นงาน');
    await expect(table.getByRole('row').nth(1).getByRole('cell')).toHaveText([sheetName, 'A1:D4', '4', '4', `เตรียมอ่านเซลล์แรก A1 ใน ${sheetName}`]);
    await expect(table.getByRole('row').nth(2).getByRole('cell')).toHaveText(['Summary', 'A1', '1', '1', 'เตรียมอ่านเซลล์แรก A1 ใน Summary']);
    const result = await page.evaluate(async (jobId) => Reflect.get(window, 'ownedTestRequest')({ method: 'result', input: { jobId } }), admitted.jobId);
    expect(result.output.nativeReceipt).toMatchObject({ operation: 'excel.sheets.inspect', provider: 'excel', sourceSha256, outputSha256: null, originalPreserved: true, savedAndReopened: false, verified: true });
    await table.screenshot({ path: path.join(desktopRoot, '..', '..', '.local-artifacts', 'parity-c4-excel-sheets.png') });
    await table.getByRole('button', { name: `เตรียมอ่านเซลล์แรก A1 ใน ${sheetName}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'เตรียมคำสั่งของโครงการ', exact: true })).toBeVisible();
    await expect(page.getByLabel('เครื่องมือ', { exact: true })).toHaveValue('excel.range.read');
    await expect(page.getByLabel('ไฟล์ในโครงการ', { exact: true })).toHaveValue(filename);
    await expect(page.getByLabel('ชื่อแผ่นงาน', { exact: true })).toHaveValue(sheetName);
    await expect(page.getByLabel('ช่วงเซลล์ เช่น A1:B3', { exact: true })).toHaveValue('A1');
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string): Promise<void> => { Reflect.set(window, 'excelCopiedPrompt', text); } } }); });
    await page.getByRole('button', { name: 'คัดลอกคำสั่งสำหรับ ChatGPT', exact: true }).click();
    const prompt = await page.evaluate(() => Reflect.get(window, 'excelCopiedPrompt') as string);
    expect(JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2))).toMatchObject({ projectId, path: filename, expectedSha256: sourceSha256, operation: 'excel.range.read', sheet: sheetName, range: 'A1' });
    expect(await page.evaluate(async () => Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }))).toHaveLength(1);
    const replay = await page.evaluate(async (preparationId) => Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId } }), prepared.preparationId);
    expect(replay.jobId).toBe(admitted.jobId);
    await page.reload();
    await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
    await page.getByLabel('รหัสงาน', { exact: true }).fill(admitted.jobId);
    await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
    await expect(page.getByRole('region', { name: 'รายชื่อแผ่นงาน Excel', exact: true })).toContainText(sheetName);
    expect(await page.evaluate(async (jobId) => Reflect.get(window, 'ownedTestRequest')({ method: 'result', input: { jobId } }), admitted.jobId)).toEqual(result);
    expect(await page.evaluate(async () => Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }))).toHaveLength(1);
    await proveExcelAbsent();
    const rangeResults: unknown[] = [];
    const selections = [
      { requestId: 'excel-range-absolute', sheet: sheetName, range: '$A$1:$B$2', observed: sheetName, cells: [['A1', 'ข้อมูลคงเดิม'], ['B1', 'null'], ['A2', '2'], ['B2', '3']] },
      { requestId: 'excel-range-reversed', sheet: 'summary', range: '$B$2:$A$1', observed: 'Summary', cells: [['A1', 'Original summary']] },
    ];
    for (const selection of selections) {
      const rangePreparation = await page.evaluate(async (input) => Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input }),
        { projectId, requestId: selection.requestId, operation: 'excel.range.read', path: filename, expectedSha256: sourceSha256, sheet: selection.sheet, range: selection.range });
      const rangeJob = await page.evaluate(async (preparationId) => Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId } }), rangePreparation.preparationId);
      nativeJobId = rangeJob.jobId; nativeJobIds.add(rangeJob.jobId);
      await page.getByLabel('รหัสงาน', { exact: true }).fill(rangeJob.jobId);
      await expect(page.getByRole('heading', { name: `งาน ${rangeJob.jobId}`, exact: true })).toBeVisible();
      await expect(page.getByText('เสร็จแล้ว', { exact: true })).toBeVisible({ timeout: testInfo.timeout });
      await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
      const rangeTable = page.getByRole('region', { name: 'ผลการอ่านช่วงเซลล์ Excel', exact: true });
      await expect(rangeTable).toBeVisible();
      await expect(rangeTable.locator('dd')).toHaveText([filename, selection.sheet, selection.range, selection.observed]);
      await expect(rangeTable.getByRole('row')).toHaveCount(selection.cells.length + 1);
      for (const [address, value] of selection.cells) {
        await expect(rangeTable.getByRole('row').filter({ has: page.getByRole('cell', { name: address!, exact: true }) }).getByRole('cell')).toHaveText([address!, value!]);
      }
      const rangeResult = await page.evaluate(async (jobId) => Reflect.get(window, 'ownedTestRequest')({ method: 'result', input: { jobId } }), rangeJob.jobId);
      expect(rangeResult).toMatchObject({ nativeSelection: { sheet: selection.sheet, range: selection.range },
        output: { jobId: rangeJob.jobId, operation: 'excel.range.read', state: 'completed', nativeReceipt: {
          sourceSha256, outputSha256: null, originalPreserved: true, unrelatedPreserved: true, savedAndReopened: false, verified: true } } });
      expect((await page.evaluate(async (preparationId) => Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId } }), rangePreparation.preparationId)).jobId).toBe(rangeJob.jobId);
      await page.reload();
      await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
      await page.getByLabel('รหัสงาน', { exact: true }).fill(rangeJob.jobId);
      await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
      await expect(page.getByRole('region', { name: 'ผลการอ่านช่วงเซลล์ Excel', exact: true })).toContainText(selection.range);
      expect(await page.evaluate(async (jobId) => Reflect.get(window, 'ownedTestRequest')({ method: 'result', input: { jobId } }), rangeJob.jobId)).toEqual(rangeResult);
      expect(await readFile(source)).toEqual(original); await proveExcelAbsent(); rangeResults.push(rangeResult);
    }
    expect(await page.evaluate(async () => Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }))).toHaveLength(3);
    expect(await readFile(source)).toEqual(original);
    const reopened = new ExcelJS.Workbook(); await reopened.xlsx.readFile(source);
    expect(reopened.worksheets.map((value) => value.name)).toEqual([sheetName, 'Summary']);
    expect(reopened.getWorksheet(sheetName)!.getCell('C2').value).toEqual({ formula: 'SUM(A2:B2)', result: 5 });
    expect(reopened.getWorksheet('Summary')!.getCell('A1').value).toBe('Original summary');
    expect(Buffer.from(reopened.getImage(0).buffer!)).toEqual(imageBytes);
    await proveExcelAbsent();
    await testInfo.attach('actual-excel-receipt', { body: JSON.stringify({ jobId: admitted.jobId, sourceSha256, result }, null, 2), contentType: 'application/json' });
    await testInfo.attach('actual-excel-range-receipts', { body: JSON.stringify({ sourceSha256, results: rangeResults }, null, 2), contentType: 'application/json' });
  });
});

test.describe('actual Windows Chrome qualification', () => {
  test.skip(process.platform !== 'win32' || process.env.GOTZJI_NATIVE_BROWSER_QUALIFICATION !== '1', 'Explicit owned Chrome/network qualification; renderer CI is separate evidence');
  test('gotzji browser native read preserves independent Chrome and closes its own profiles', async ({ gotzji }, testInfo) => {
    test.setTimeout(90000);
    const { page, dataRoot } = gotzji; const projectId = 'native-browser';
    const referenceUrl = 'https://raw.githubusercontent.com/Scotty20761/gotzji/2a5a5401c6dadcf46c6f2f9ab63156a7cc4c8ddf/README.md';
    const priorRoots = await independentChromeRoots(); let control: GotzjiOwnedBrowserDriver | undefined;
    gotzji.beforeClose(async () => {
      const failures: unknown[] = [];
      try { await page.evaluate(async (id) => Reflect.get(window, 'ownedTestRequest')({ method: 'stopBrowserSession', input: { projectId: id } }), projectId); }
      catch (error) { failures.push(error); }
      if (control) {
        try { await control.stop(); control = undefined; }
        catch (error) {
          const failure = error as Error & { code?: string; cause?: Error };
          failures.push(new Error(`Owned Chrome control stop failed: ${failure.stack}; cause=${failure.cause?.stack ?? failure.message}`, { cause: error }));
        }
      }
      const checks = await Promise.allSettled([
        (async (): Promise<void> => { expect(await ownedChromeProcesses(dataRoot)).toEqual([]); expect(await ownedChromeProcesses(dataRoot)).toEqual([]); })(),
        assertChromeRootsPreserved(priorRoots),
      ]);
      for (const check of checks) if (check.status === 'rejected') failures.push(check.reason);
      if (failures.length) throw new AggregateError(failures, `Native Chrome cleanup failed: ${failures.map(error => error instanceof Error ? error.message : String(error)).join('; ')}`);
    });
    const config = await readProductConfiguration(path.join(dataRoot, 'runtime'), testOnlyProductSecretProtector());
    expect(config.browser, 'A privately pinned registered Chrome is required for this explicit native qualification').toBeDefined();
    control = await startGotzjiOwnedBrowser({ profileParent: path.join(dataRoot, 'control-browser'), chromeExecutable: config.browser!.executable, startUrl: referenceUrl, allowedOrigins: ['https://raw.githubusercontent.com'], headless: true });
    expect(await control.verifyOwnership()).toBe(true);
    const root = await gotzji.temporaryProject('gotzji-files-panel-e2e-'); await writeFile(path.join(root, 'preserve.txt'), 'Owned browser source remains unchanged');
    await page.evaluate(async ({ rootPath, id }) => Reflect.get(window, 'ownedTestRequest')({ method: 'registerProject', input: { projectId: id, displayName: 'Browser native fixture', rootPath, kind: 'project' } }), { rootPath: root, id: projectId });
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).click(); await page.getByRole('button', { name: 'โครงการ', exact: true }).click();
    await page.getByRole('button', { name: /^Browser native fixture ·/ }).click();
    const panel = page.locator('.gotzji-browser-panel');
    await panel.getByLabel('หน้าเริ่มต้น', { exact: true }).fill(referenceUrl);
    await panel.getByRole('button', { name: 'เปิดเบราว์เซอร์โครงการ', exact: true }).click();
    await expect(panel).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(panel.getByRole('status')).toContainText('พร้อมให้เลือกเครื่องมือเบราว์เซอร์');
    expect((await ownedChromeProcesses(dataRoot, 'product')).length).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'คัดลอกงานอ่านหน้าเว็บสำหรับ ChatGPT', exact: true }).click();
    expect(await page.evaluate(async () => (await window.gotzji.request({ method: 'listJobs', input: {} }) as unknown[]).length)).toBe(0);
    const admitted = await page.evaluate(async (projectId) => {
      const session = await Reflect.get(window, 'ownedTestRequest')({ method: 'browserSession', input: { projectId } });
      const preparation = await Reflect.get(window, 'ownedTestRequest')({ method: 'prepareOperation', input: { projectId, requestId: crypto.randomUUID(), operation: 'browser.read', selector: 'body', sessionId: session.sessionId, tabId: session.tabId, expectedUrl: session.expectedUrl, expectedDocumentId: session.expectedDocumentId } });
      return Reflect.get(window, 'ownedTestRequest')({ method: 'submit', input: { preparationId: preparation.preparationId } });
    }, projectId);
    await page.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
    await page.getByLabel('รหัสงาน', { exact: true }).fill(admitted.jobId);
    const heading = page.getByRole('heading', { name: /^งาน [a-f0-9]{64}$/u }); await expect(heading).toBeVisible();
    await expect(page.getByText('เสร็จแล้ว', { exact: true })).toBeVisible({ timeout: testInfo.timeout });
    const jobId = (await heading.textContent())!.replace('งาน ', '');
    await page.getByRole('button', { name: 'ดูผลลัพธ์', exact: true }).click();
    const readable = page.getByRole('region', { name: 'ผลการอ่านหน้าเว็บ', exact: true });
    await expect(readable.getByRole('heading', { name: 'อ่านหน้าเว็บสำเร็จ', exact: true })).toBeVisible();
    await expect(readable.locator('pre:visible')).toContainText('An open-source Windows MCP app controlled by ChatGPT through its gotzji plugin.');
    await expect(readable).toContainText(referenceUrl);
    await expect(readable.locator('details')).not.toHaveAttribute('open');
    const result = await page.evaluate(async (id) => Reflect.get(window, 'ownedTestRequest')({ method: 'result', input: { jobId: id } }), jobId);
    await page.getByRole('button', { name: 'เครื่องมือ', exact: true }).click(); await panel.getByRole('button', { name: 'ปิดเบราว์เซอร์โครงการ', exact: true }).click();
    await expect(panel).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'ปิดเบราว์เซอร์โครงการ', exact: true })).toBeDisabled();
    expect(await page.evaluate(async (id) => Reflect.get(window, 'ownedTestRequest')({ method: 'browserSession', input: { projectId: id } }), projectId)).toMatchObject({ state: 'not-enrolled' });
    expect(await ownedChromeProcesses(dataRoot, 'product')).toEqual([]); expect(await ownedChromeProcesses(dataRoot, 'product')).toEqual([]);
    expect(await control.verifyOwnership()).toBe(true); await assertChromeRootsPreserved(priorRoots);
    expect(await page.evaluate(async (id) => Reflect.get(window, 'ownedTestRequest')({ method: 'result', input: { jobId: id } }), jobId)).toEqual(result);
    expect(await page.evaluate(async () => (await Reflect.get(window, 'ownedTestRequest')({ method: 'listJobs', input: {} }) as unknown[]).length)).toBe(1);
    expect(await readFile(path.join(root, 'preserve.txt'), 'utf8')).toBe('Owned browser source remains unchanged');
  });
});

async function waitForOwnedSubmission(page: Page, elementId: 'lost-ack-fixture' | 'command-app-proof' | 'browser-ui-proof' | 'browser-app-proof'): Promise<void> {
  await page.evaluate(async (id) => {
    const root = document.getElementById(id);
    const pending = root ? Reflect.get(root, 'ownedSubmitPromise') as unknown : undefined;
    if (!pending || typeof pending !== 'object' || typeof Reflect.get(pending, 'then') !== 'function') throw new Error('Owned submit promise was not captured');
    await pending;
  }, elementId);
}

for (const oldReply of ['success', 'rejection'] as const) {
  test(`gotzji selected Excel result discards stale ${oldReply} and resets paging on selection and reload`, async ({ gotzji }) => {
    const { page } = gotzji; const fixturePath = gotzji.rendererFixturePath();
    await build({ stdin: { resolveDir: path.join(desktopRoot, 'src', 'renderer'), sourcefile: 'range-result-fixture.tsx', loader: 'tsx', contents: `
      import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client';
      import { GotzjiApp } from './GotzjiApp.tsx';
      document.getElementById('root').hidden=true;
      const root=document.createElement('div');root.id='range-result-app-proof';document.body.append(root);
      const ids=['1'.repeat(64),'2'.repeat(64)];const calls=[];const replies=[];const pending=[];
      Reflect.set(root,'calls',calls);Reflect.set(root,'replies',replies);Reflect.set(root,'pending',pending);
      const job=jobId=>({jobId,projectId:'range-display-fixture',requestedOperation:'excel.range.read',operation:'grace.product-operation',status:'completed'});
      Reflect.set(root,'resultFor',(jobId,label)=>({operation:'excel.range.read',projectId:'range-display-fixture',nativeSelection:{sheet:'Data',range:'$A$1:$A$101'},output:{
        jobId,operation:'excel.range.read',projectId:'range-display-fixture',path:'owned.xlsx',state:'completed',nativeReceipt:{operation:'excel.range.read',provider:'excel',verified:true,
          originalPreserved:true,unrelatedPreserved:true,outputSha256:null,savedAndReopened:false,sourceSha256:'a'.repeat(64),
          after:{selected:Array.from({length:101},(_,i)=>({sheet:'data',address:'A'+(i+1),value:label+'-'+(i+1),formula:label+'-'+(i+1),format:'General',bold:false}))}}}}));
      const request=(method,input)=>{
        calls.push({method,input});
        if(method==='listJobs')return Promise.resolve(ids.map(job));
        if(method==='status')return Promise.resolve(job(input.jobId));
        if(method==='result'){
          const value=new Promise((resolve,reject)=>replies.push({jobId:input.jobId,resolve,reject}));pending.push(value);return value;
        }
        if(['prepareOperation','submit','resume','cancel','reprioritize'].includes(method))throw new Error('UNEXPECTED_DISPLAY_MUTATION');
        return window.gotzji.request({method,input});
      };
      createRoot(root,{identifierPrefix:'range-result-app-'}).render(<StrictMode><GotzjiApp requestPort={request}/></StrictMode>);
    ` }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty', '.webp': 'dataurl' }, outfile: fixturePath, define: { 'process.env.NODE_ENV': '"production"' } });
    await page.addScriptTag({ url: pathToFileURL(fixturePath).href });
    const ui = page.locator('#range-result-app-proof');
    const table = ui.getByRole('region', { name: 'ผลการอ่านช่วงเซลล์ Excel', exact: true });
    const read = ui.getByRole('button', { name: 'ดูผลลัพธ์', exact: true });
    const first = '1'.repeat(64); const second = '2'.repeat(64);
    const select = async (id: string): Promise<void> => { await ui.getByRole('button', { name: new RegExp(id) }).click(); };
    const count = async (): Promise<number> => page.evaluate(() => (Reflect.get(document.getElementById('range-result-app-proof')!, 'replies') as unknown[]).length);
    const respond = async (index: number, kind: 'success' | 'rejection', label: string): Promise<void> => {
      await page.evaluate(async ({ index, kind, label }) => {
        const root = document.getElementById('range-result-app-proof')!;
        const replies = Reflect.get(root, 'replies') as Array<{ jobId: string; resolve(value: unknown): void; reject(error: Error): void }>;
        const makeResult = Reflect.get(root, 'resultFor') as (jobId: string, label: string) => unknown;
        const reply = replies[index]!;
        if (kind === 'success') reply.resolve(makeResult(reply.jobId, label)); else reply.reject(new Error(label));
        await (Reflect.get(root, 'pending') as Promise<unknown>[])[index]!.catch(() => undefined);
      }, { index, kind, label });
    };
    await ui.getByRole('button', { name: 'ประวัติงาน', exact: true }).click();
    await select(first); await read.click(); await expect.poll(count).toBe(1);
    await select(second); await read.click(); await expect.poll(count).toBe(2);
    await respond(1, 'success', 'CURRENT_SECOND'); await expect(table).toContainText('CURRENT_SECOND-1');
    await table.getByRole('button', { name: 'หน้าถัดไปของผลการอ่านช่วงเซลล์', exact: true }).click();
    await expect(table).toContainText('หน้า 2 จาก 2'); await expect(table).toContainText('CURRENT_SECOND-101');
    await respond(0, oldReply, 'STALE_FIRST');
    await expect(table).toContainText('CURRENT_SECOND-101'); await expect(ui).not.toContainText('STALE_FIRST');

    await select(first); await read.click(); await expect.poll(count).toBe(3);
    await respond(2, 'success', 'CURRENT_FIRST'); await expect(table).toContainText('หน้า 1 จาก 2');
    await expect(table).toContainText('CURRENT_FIRST-1');
    await table.getByRole('button', { name: 'หน้าถัดไปของผลการอ่านช่วงเซลล์', exact: true }).click();
    await expect(table).toContainText('หน้า 2 จาก 2');

    await read.click(); await expect.poll(count).toBe(4); await expect(table).toHaveCount(0);
    await read.click(); await expect.poll(count).toBe(5);
    await respond(4, 'success', 'NEWEST_SAME_JOB'); await expect(table).toContainText('หน้า 1 จาก 2');
    await expect(table).toContainText('NEWEST_SAME_JOB-1');
    await respond(3, oldReply, 'STALE_RELOAD');
    await expect(table).toContainText('NEWEST_SAME_JOB-1'); await expect(ui).not.toContainText('STALE_RELOAD');

    await table.getByRole('button', { name: 'หน้าถัดไปของผลการอ่านช่วงเซลล์', exact: true }).click();
    await read.click(); await expect.poll(count).toBe(6); await expect(table).toHaveCount(0);
    await respond(5, 'rejection', 'CURRENT_RESULT_FAILURE');
    await expect(ui.getByRole('alert')).toContainText('CURRENT_RESULT_FAILURE'); await expect(table).toHaveCount(0);
    const calls = await page.evaluate(() => Reflect.get(document.getElementById('range-result-app-proof')!, 'calls') as Array<{method:string}>);
    expect(calls.filter(call => ['prepareOperation','submit','resume','cancel','reprioritize'].includes(call.method))).toEqual([]);
    expect(await page.evaluate(async () => (await Reflect.get(window, 'ownedTestRequest')({ method:'listJobs', input:{} }) as unknown[]).length)).toBe(0);
  });
}
