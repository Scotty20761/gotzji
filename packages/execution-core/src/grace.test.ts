import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { callWorker, stopWorker } from './managed-worker.js';
import type { GraceRegistration } from './grace-profile.js';
import type { WorkerRow } from './store.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
const { brokerCall } = await import('./grace-broker.mjs');
const { approvedStartup } = await import('./grace-runtime.mjs');
interface Fixture { root: string; core: ExecutionCore; credential: string; profile: GraceRegistration; jobId: string; handle: string; worker: WorkerRow; config: Record<string, unknown> }
const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const root = await canonicalTemporaryDirectory('gotzji-grace-');
  const library = path.join(root,'library'); await mkdir(path.join(library,'references'), { recursive:true });
  for (const file of ['CLAUDE.md','AGENTS.md','references/agent-knowledge-workflow.md','KNOWLEDGE_INDEX.md']) await writeFile(path.join(library,file), `Prepared policy ${file}\n`);
  const sourceFile = path.join(root,'public-source.md'); await writeFile(sourceFile, 'Original source\r\nภาษาไทย\r\n');
  const profile = { executable: process.execPath, libraryRoot: library, sourceFile, testDriver: fileURLToPath(new URL('./grace-test-driver.mjs',import.meta.url)) };
  const state = path.join(root,'state'); const core = await ExecutionCore.open(state,{ grace:profile });
  const credential = core.enrollAdapter('gotzji','owner');
  const prepared = core.prepareSourceSnapshot(credential,'snapshot'); const job = await core.submit(credential,prepared.preparationId);
  const binding = core.select(credential,job.jobId); await core.resume(credential,binding);
  const database = new DatabaseSync(path.join(state,'core.sqlite'), { timeout: 5000 });
  const worker = database.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(job.jobId) as unknown as WorkerRow; database.close();
  const config = JSON.parse(await readFile(path.join(worker.directory,'config.json'),'utf8')) as Record<string,unknown>;
  const f = { root,core,credential,profile,jobId:job.jobId,handle:binding.handle,worker,config }; fixtures.push(f);
  for (let n=0;n<100;n++) { const observation = await callWorker(worker,'status'); if (observation.state==='done') return f; if (observation.state==='failed') throw new Error('test driver failed'); await new Promise((resolve)=>setTimeout(resolve,30)); }
  throw new Error('test driver did not settle');
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await stopWorker(f.worker); try { f.core.close(); } catch { /* already detached */ } await rm(f.root,{ recursive:true,force:true }); } });
describe('Grace broker joins the neutral authority (explicit no-model driver)', () => {
  it('runs pre-work/read/save/real check and independently completes the same native Goal', async () => {
    const f = await fixture(); await f.core.tick();
    expect(await f.core.result(f.credential,{jobId:f.jobId,handle:f.handle})).toMatchObject({status:'completed',operation:'grace.read-save-check'});
    const original = await readFile(f.profile.sourceFile); const saved = await readFile(path.join(f.root,'state','effects',f.jobId,'result.txt'));
    expect(saved.equals(original)).toBe(true);
  });
  it('rejects source paths, roles, commands, batch requests and unknown tool names before effects', async () => {
    const f = await fixture(); const output = path.join(f.root,'state','effects',f.jobId,'result.txt'); const before = await stat(output);
    for (const [name,args] of [['read_source',{path:'elsewhere'}],['save_result',{sourceHash:'x',role:'Grace'}],['check_result',{command:'powershell'}],['batch',{calls:[]}],['Write',{path:'elsewhere',text:'x'}]]) expect(()=>brokerCall(f.config,name,args,true)).toThrow();
    expect((await stat(output)).mtimeMs).toBe(before.mtimeMs);
  });
  it('rejects a changed payload without poisoning the valid operation claim', async () => {
    const f = await fixture(); expect(()=>brokerCall(f.config,'save_result',{sourceHash:'wrong'},true)).toThrow('PAYLOAD_DENIED');
    const config = f.config as {grace:{sourceHash:string}};
    expect(brokerCall(f.config,'save_result',{sourceHash:config.grace.sourceHash},true)).toMatchObject({duplicate:true});
  });
  it('reconciles save/check retries without rewriting or spawning another verifier', async () => {
    const f = await fixture(); const before = await stat(path.join(f.root,'state','effects',f.jobId,'result.txt'));
    const receipt = brokerCall(f.config,'check_result',{},true); expect(brokerCall(f.config,'check_result',{},true)).toEqual(receipt);
    const config = f.config as {grace:{sourceHash:string}}; brokerCall(f.config,'save_result',{sourceHash:config.grace.sourceHash},true);
    expect((await stat(path.join(f.root,'state','effects',f.jobId,'result.txt'))).mtimeMs).toBe(before.mtimeMs);
  });
  it('rejects a revoked native Goal even with the original private credential', async () => {
    const f = await fixture(); await f.core.cancel(f.credential,{jobId:f.jobId,handle:f.handle});
    expect(()=>brokerCall(f.config,'read_source',{},true)).toThrow('LIVE_AUTHORITY_DENIED');
  });
  it('rejects stale generation/session and unapproved runtime', async () => {
    const f = await fixture();
    expect(()=>brokerCall({...f.config,generation:999},'read_source',{},true)).toThrow('LIVE_AUTHORITY_DENIED');
    expect(()=>brokerCall({...f.config,session:'external-session'},'read_source',{},true)).toThrow('LIVE_AUTHORITY_DENIED');
    expect(()=>brokerCall(f.config,'read_source',{},false)).toThrow('RUNTIME_OR_TOOL_DENIED');
  });
  it('rejects missing canonical pre-work receipt before reading the source', async () => {
    const f = await fixture(); const database = new DatabaseSync(path.join(f.root,'state','core.sqlite'), { timeout: 5000 });
    database.prepare('DELETE FROM gotzji_recipe_operations WHERE operation_id=?').run('policy:workflow'); database.close();
    expect(()=>brokerCall(f.config,'read_source',{},true)).toThrow('PREWORK_REQUIRED');
    await expect(f.core.tick()).rejects.toMatchObject({code:'GRACE_OPERATION_EVIDENCE_REQUIRED'});
  });
  it('detects source changes before a broker read and preserves the saved original', async () => {
    const f = await fixture(); await writeFile(f.profile.sourceFile,'Changed source');
    expect(()=>brokerCall(f.config,'read_source',{},true)).toThrow('DEPENDENCIES_CHANGED');
    expect((await readFile(path.join(f.root,'state','effects',f.jobId,'result.txt'),'utf8'))).toContain('ภาษาไทย');
  });
  it('does not accept a forged check receipt as completion', async () => {
    const f = await fixture(); const database = new DatabaseSync(path.join(f.root,'state','core.sqlite'), { timeout: 5000 });
    database.prepare('UPDATE gotzji_recipe_operations SET receipt=? WHERE operation_id=?').run(JSON.stringify({exitCode:0,sha256:'forged',verifierHash:'forged'}),'check_result'); database.close();
    await expect(f.core.tick()).rejects.toMatchObject({code:'GRACE_CHECK_EVIDENCE_REQUIRED'});
  });
  it('retains the writer when cancellation discovers an unexpected Grace file effect', async () => {
    const f=await fixture(); await writeFile(path.join(f.root,'state','effects',f.jobId,'result.txt'),'Unexpected effect');
    await expect(f.core.cancel(f.credential,{jobId:f.jobId,handle:f.handle})).rejects.toMatchObject({code:'EFFECT_RECONCILIATION_REQUIRED'});
    expect(await f.core.get(f.credential,{jobId:f.jobId,handle:f.handle})).toMatchObject({status:'blocked'});
  },15000);
  it('rejects invalid lease expiry and a revised native user intent', async () => {
    const f=await fixture(); const database=new DatabaseSync(path.join(f.root,'state','core.sqlite'), { timeout: 5000 });
    try {
      database.prepare("UPDATE goals SET lease_expires_at='invalid'").run();
      expect(()=>brokerCall(f.config,'read_source',{},true)).toThrow('LIVE_AUTHORITY_DENIED');
      database.prepare('UPDATE goals SET lease_expires_at=?,user_intent_revision=user_intent_revision+1').run(new Date(Date.now()+300000).toISOString());
      expect(()=>brokerCall(f.config,'read_source',{},true)).toThrow('LIVE_AUTHORITY_DENIED');
    } finally { database.close(); }
  });
  it('denies startup with ambient tools or API-key auth before broker approval', () => {
    const tools=['read_policy','read_source','save_result','check_result'].map((name)=>'mcp__gotzji_task__'+name);
    expect(approvedStartup({type:'system',subtype:'init',tools,apiKeySource:'none'})).toBe(true);
    expect(approvedStartup({type:'system',subtype:'init',tools:[...tools,'Bash'],apiKeySource:'none'})).toBe(false);
    expect(approvedStartup({type:'system',subtype:'init',tools,apiKeySource:'api-key'})).toBe(false);
  });
});
