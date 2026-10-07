import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { hash, type WorkerRow } from './store.js';
import { callWorker, stopWorker, signed } from './managed-worker.js';
import { processIdentities, sameProcessIdentity } from './process-identity.mjs';
import type { ProductNativeInput } from './product-native.js';
import type { TaskBinding } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

interface Fixture { root: string; core: ExecutionCore; credential: string }
const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-native-core-');
  const libraryRoot = path.join(root, 'library'); await mkdir(path.join(libraryRoot, 'references'), { recursive: true });
  for (const file of ['CLAUDE.md','AGENTS.md','KNOWLEDGE_INDEX.md','references/agent-knowledge-workflow.md']) await writeFile(path.join(libraryRoot, file), 'Explicit no-model core fixture policy\n');
  const scriptPath = path.join(root, 'fixture-provider.ps1'); await writeFile(scriptPath, 'test-only provider; never execute as PowerShell');
  const runner = path.join(root, 'test-native-runner.mjs');
  await writeFile(runner, `import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';const hash=x=>createHash('sha256').update(x).digest('hex');export async function testRunner(_script,input){await new Promise(resolve=>setTimeout(resolve,400));if(input.range==='Z1')throw Object.assign(new Error('NATIVE_TERMINATION_UNVERIFIED'),{code:'NATIVE_TERMINATION_UNVERIFIED',outcome:'unknown'});let outputSha256=null;if(input.outputPath){writeFileSync(input.outputPath,'preserved-fixture-output');outputSha256=hash(readFileSync(input.outputPath));}return{operation:input.operation,provider:input.operation.split('.')[0],providerVersion:'explicit-no-model-fixture',nativePid:process.pid,sourceSha256:hash(readFileSync(input.filePath)),outputSha256,originalPreserved:true,savedAndReopened:!!input.outputPath,unrelatedPreserved:true,verified:true,before:{fixture:'original'},after:{fixture:'changed'}};}`);
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: { executable: process.execPath, libraryRoot, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs', import.meta.url)) }, nativeOptions: { scriptPath, scriptSha256: hash(await readFile(scriptPath)), testRunnerModule: runner, operations: ['excel.range.read','excel.range.write'] } });
  const credential = core.enrollAdapter('native-fixture', 'owner');
  for (const projectId of ['one','two']) { const project = path.join(root, projectId); await mkdir(project); await writeFile(path.join(project, 'source.xlsx'), 'original fixture bytes'); await writeFile(path.join(project, 'AGENTS.md'), 'Actual selected project native rule\n'); core.registerProject(credential, { projectId, displayName: projectId, rootPath: project }); }
  const f = { root, core, credential }; fixtures.push(f); return f;
}
async function job(f: Fixture, input: ProductNativeInput): Promise<TaskBinding> {
  const prep = await f.core.prepareOperation(f.credential, input); const result = await f.core.submit(f.credential, prep.preparationId); return f.core.select(f.credential, result.jobId);
}
async function until(f: Fixture, check: () => Promise<boolean>): Promise<void> {
  for (let count = 0; count < 150; count++) { try { await f.core.tick(); } catch { /* inspect the independently projected state */ } if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error(JSON.stringify(await f.core.list(f.credential)));
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite')); const workers = db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; db.close();
    for (const worker of workers) {
      if (await stopWorker(worker)) continue;
      // The synthetic runner never starts a native application. For this
      // injected uncertain case only, tear down our authenticated Node root
      // after matching its real OS birth/executable; never kill stale children.
      const config = JSON.parse(await readFile(path.join(worker.directory, 'config.json'), 'utf8'));
      if (config.grace.mode !== 'test-driver' || !config.nativeTestRunner) throw new Error('Unexpected production fixture');
      const observed = await callWorker(worker, 'status'); const ready = signed<{ identity: { birth: string; executable: string } }>(worker, 'ready.json');
      if (!sameProcessIdentity(ready?.identity, (await processIdentities([observed.pid]))[observed.pid])) throw new Error('Fixture root identity changed');
      process.kill(observed.pid);
    }
    f.core.close(); await rm(f.root, { recursive: true, force: true });
  }
});
describe('native operations through Grace and the shared Goal (explicit no-model runner)', () => {
  it('seals a typed native operation, runs Grace broker pre-work, verifies original/output and retains one replayable result', async () => {
    const f = await fixture();
    const input: ProductNativeInput = { requestId: 'native-write', projectId: 'one', operation: 'excel.range.write', path: 'source.xlsx', outputPath: 'output.xlsx', sheet: 'Sheet1', range: 'A1', values: [['new']] };
    const binding = await job(f, input); await f.core.resume(f.credential, binding);
    await until(f, async () => (await f.core.get(f.credential, binding)).status === 'completed');
    expect(await readFile(path.join(f.root, 'one', 'source.xlsx'), 'utf8')).toBe('original fixture bytes');
    expect(await f.core.readOperationResult(f.credential, binding)).toMatchObject({ operation: 'excel.range.write', output: { nativeReceipt: { providerVersion: 'explicit-no-model-fixture', originalPreserved: true, savedAndReopened: true } } });
    const repeated = await f.core.prepareOperation(f.credential, input);
    expect((await f.core.submit(f.credential, repeated.preparationId)).jobId).toBe(binding.jobId);
    await expect(f.core.prepareOperation(f.credential, { ...input, values: [['different']] })).rejects.toMatchObject({ code: 'REQUEST_DIGEST_CONFLICT' });
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'));
    expect(db.prepare('SELECT COUNT(*) AS count FROM goals').get()?.count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims').get()?.count).toBe(0); db.close();
  }, 20000);
  it('holds global UI/document/provider locks atomically across independent projects', async () => {
    const f = await fixture(); const first = await job(f, { requestId: 'first', projectId: 'one', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'A1' });
    const second = await job(f, { requestId: 'second', projectId: 'two', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'A1' });
    await f.core.resume(f.credential, first);
    expect(await f.core.resume(f.credential, second)).toMatchObject({ status: 'queued', waitingReason: 'RESOURCE_HELD', blockingResource: 'globalui:windows', blockingJob: first.jobId });
    await until(f, async () => (await f.core.get(f.credential, second)).status === 'completed');
  }, 20000);
  it('retains every resource on uncertain native effects and refuses fabricated provider/script/grant arguments', async () => {
    const f = await fixture();
    await expect(f.core.prepareOperation(f.credential, { requestId: 'forged', projectId: 'one', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'A1', scriptPath: 'caller.ps1' } as never)).rejects.toMatchObject({ code: 'NATIVE_INPUT_INVALID' });
    const binding = await job(f, { requestId: 'uncertain', projectId: 'one', operation: 'excel.range.read', path: 'source.xlsx', sheet: 'Sheet1', range: 'Z1' });
    await f.core.resume(f.credential, binding);
    await until(f, async () => (await f.core.get(f.credential, binding)).status === 'blocked');
    expect(await f.core.get(f.credential, binding)).toMatchObject({ blockerCode: 'NATIVE_TERMINATION_UNVERIFIED' });
    const db = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite')); expect(Number(db.prepare('SELECT COUNT(*) AS count FROM gotzji_resource_claims WHERE job_id=?').get(binding.jobId)?.count)).toBeGreaterThanOrEqual(4); db.close();
  }, 20000);
});
