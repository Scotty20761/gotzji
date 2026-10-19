import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { nativeDigest } from '@lnwjud/capabilities/gotzji-native-contract';
import { NodeBrowserCdpProtocol } from '@lnwjud/capabilities';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionCore } from './core.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { hash, type WorkerRow } from './store.js';
import { processIdentities } from './process-identity.mjs';
import { observeWorker, signed, stopWorker } from './managed-worker.js';
import { childEnvironment } from './product-security.mjs';
import { restoreTrustedProductBrowserEnrollment, verifyOwnedProductBrowserSession } from './product-browser-broker.mjs';
import type { TrustedProductBrowserSessionManifest } from './product-browser.js';

describe('owned synthetic browser provider through the full durable controller', () => {
  it.runIf(process.platform === 'win32').each([false, true])('binds the real owned provider process, verifies the artifact and retains replay after provider removal (direct=%s)', async (direct) => {
    const root = await canonicalTemporaryDirectory('gotzji-direct-browser-'); const state = path.join(root, 'state');
    const policy = path.join(root, 'policy'); const project = path.join(root, 'project'); const profilePath = path.join(root, 'gotzji', 'gotzji-browser-provider-fixture');
    await mkdir(project); await mkdir(profilePath, { recursive: true }); ensureProductControlDocuments(policy);
    const helper = path.join(root, 'owned-provider.mjs');
    const ownedExecutable = path.join(root, 'chrome.exe'); await copyFile(process.execPath, ownedExecutable);
    await writeFile(helper, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(path.join(profilePath, 'DevToolsActivePort'))},${JSON.stringify('12345\n/devtools/browser/synthetic-owned-test\n')});setInterval(()=>{},1000);`);
    const child: ChildProcess = spawn(ownedExecutable, [helper, '--remote-debugging-port=0', `--user-data-dir=${profilePath}`], { env: childEnvironment(), windowsHide: true, stdio: 'ignore' }); const closed = once(child, 'close');
    let core: ExecutionCore | undefined; let workers: WorkerRow[] = [];
    const cleanup = async (): Promise<void> => {
      for (const worker of workers) { if (!await stopWorker(worker) || await observeWorker(worker) !== 'absent') throw new Error(`OWNED_BROWSER_FIXTURE_RETAINED:${root}`); }
      core?.close(); if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; } expect(() => process.kill(child.pid!, 0)).toThrow();
      const target = path.resolve(root); if (path.dirname(target) !== await realpath(os.tmpdir()) || !path.basename(target).startsWith('gotzji-direct-browser-')) throw new Error('FIXTURE_CLEANUP_SCOPE_DENIED'); await rm(target, { recursive: true, force: true });
    };
    try {
      for (let n = 0; n < 100 && !existsSync(path.join(profilePath, 'DevToolsActivePort')); n++) await new Promise((resolve) => setTimeout(resolve, 20));
      const identity = (await processIdentities([child.pid!]))[child.pid!]; if (!identity || typeof identity !== 'object') throw new Error('OWNED_PROVIDER_IDENTITY_REQUIRED');
      const facts = JSON.parse((await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}' | Select-Object @{Name='birth';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 5000 })).stdout) as { birth: string };
      const executable = await realpath(ownedExecutable);
      const session: TrustedProductBrowserSessionManifest = { schemaVersion: 1, sessionId: 'owned-synthetic', owner: 'owner', projectId: 'project', pid: child.pid!, pidBirth: facts.birth, executable, executableSha256: hash(await readFile(executable)), profilePath, port: 12345, cdpBrowserContextId: 'owned-context', binding: { browserId: 'owned-browser', contextId: 'owned-context', profileId: nativeDigest(profilePath.toLowerCase()), tabId: 'owned-tab', providerTabId: 'owned-tab', url: 'http://127.0.0.1:12345/fixture', documentId: 'owned-document' }, allowedOrigins: ['http://127.0.0.1:12345'], fixtureMode: true };
      expect(await verifyOwnedProductBrowserSession(session)).toBe(true);
      const manifestPath = path.join(root, 'gotzji', 'browser-session.json'); await writeFile(manifestPath, JSON.stringify(session));
      const artifact = path.join(project, 'observed-browser-value.txt'); const transport = path.join(root, 'synthetic-transport.mjs');
      await writeFile(transport, `import {writeFileSync} from 'node:fs';let value='before';export const testTransport={binding:async()=>(${JSON.stringify(session.binding)}),inspect:async()=>({count:1,identity:'owned-input',tag:'INPUT',text:'',value,editable:true,enabled:true,visible:true,protected:false}),fill:async(_selector,text)=>{value=text;writeFileSync(${JSON.stringify(artifact)},value);},click:async()=>{throw new Error('UNUSED_TEST_ACTION');}};`);
      const product = direct ? { mode: 'host-direct' as const, libraryRoot: policy, testOnlyProviders: true as const } : { executable, libraryRoot: policy, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) };
      core = await ExecutionCore.open(state, { product, browserOptions: { session, manifestPath, manifestSha256: hash(JSON.stringify(session)), prerequisites: [{ path: transport, hash: hash(await readFile(transport)) }], verifyOwnedSession: verifyOwnedProductBrowserSession, testTransportModule: transport, deadlineMs: 20000 } });
      const credential = core.enrollAdapter('browser-fixture', 'owner'); core.registerProject(credential, { projectId: 'project', displayName: 'Owned synthetic browser', rootPath: project });
      const missingPage = vi.spyOn(NodeBrowserCdpProtocol.prototype, 'listTabs').mockResolvedValue([]);
      try {
        const restored = await restoreTrustedProductBrowserEnrollment(core.listProjects(credential)[0]!, { session, manifestPath, manifestSha256: hash(JSON.stringify(session)), prerequisites: [{ path: transport, hash: hash(await readFile(transport)) }] });
        expect(restored.cleanupOnly).toBe(true); expect(restored.publicBinding.sessionId).toBe(session.sessionId);
        await expect(restored.refresh()).rejects.toMatchObject({ code: 'BROWSER_SESSION_STOP_REQUIRED' });
      } finally { missingPage.mockRestore(); }
      const input = { requestId: 'owned-browser-effect', projectId: 'project', operation: 'browser.type' as const, sessionId: session.sessionId, tabId: session.binding.tabId, expectedUrl: session.binding.url, expectedDocumentId: session.binding.documentId, selector: '#owned-input', text: 'after' };
      const preparation = await core.prepareOperation(credential, input); const job = await core.submit(credential, preparation.preparationId); const binding = core.select(credential, job.jobId); await core.resume(credential, binding);
      const db = new DatabaseSync(path.join(state, 'core.sqlite'), { readOnly: true }); try { workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; } finally { db.close(); }
      for (let n = 0; n < 200; n++) { await core.tick(); if ((await core.get(credential, binding)).status === 'completed') break; await new Promise((resolve) => setTimeout(resolve, 50)); }
      expect(await core.get(credential, binding)).toMatchObject({ status: 'completed' }); expect(await readFile(artifact, 'utf8')).toBe('after');
      const result = await core.readOperationResult(credential, binding); expect(result.output).toMatchObject({ browserReceipt: { verified: true, releaseResources: true, binding: session.binding } });
      if (direct) { expect(signed(workers[0]!, 'controller-runtime.json')).toMatchObject({ executor: 'host-direct' }); expect(existsSync(path.join(workers[0]!.directory, 'claude-events.jsonl'))).toBe(false); }
      const authority = core.authority(); core.close(); core = undefined;
      child.kill(); await closed; expect(() => process.kill(child.pid!, 0)).toThrow(); await rm(manifestPath); await rm(transport);
      core = await ExecutionCore.open(state, { product: { mode: 'host-direct', libraryRoot: policy }, upgrade: { expectedPolicy: authority.policy, expectedAuthorityId: authority.authorityId } });
      const replay = await core.prepareOperation(credential, input); expect((await core.submit(credential, replay.preparationId)).jobId).toBe(job.jobId); expect(await core.readOperationResult(credential, core.select(credential, job.jobId))).toEqual(result);
      await expect(core.prepareOperation(credential, { ...input, text: 'conflicting' })).rejects.toThrow('REQUEST_DIGEST_CONFLICT'); expect(readFileSync(artifact, 'utf8')).toBe('after');
    } finally { await cleanup(); }
  }, 60000);
});
