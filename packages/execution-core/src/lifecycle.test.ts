import { mkdir, writeFile, rm, stat, utimes, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { callWorker, stopWorker, alive } from './managed-worker.js';
import type { WorkerRow } from './store.js';
import type { GraceRegistration } from './grace-profile.js';
import type { TaskBinding } from './types.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
const { verifyFingerprint } = await import('./fingerprints.mjs');
const roots: string[] = [];
const cores: ExecutionCore[] = [];
async function fixture(grace = false, options: {now?:()=>Date} = {}): Promise<{root:string;core:ExecutionCore;credential:string;sourceFile:string;registration?:GraceRegistration}> {
  const root=await canonicalTemporaryDirectory('gotzji-lifecycle-'); roots.push(root);
  const sourceFile=path.join(root,'source.md'); await writeFile(sourceFile,'Original source\n');
  let registration: GraceRegistration | undefined;
  if (grace) {
    const library=path.join(root,'library'); await mkdir(path.join(library,'references'),{recursive:true});
    for (const file of ['CLAUDE.md','AGENTS.md','references/agent-knowledge-workflow.md','KNOWLEDGE_INDEX.md']) await writeFile(path.join(library,file),'Prepared canonical policy');
    registration={executable:process.execPath,libraryRoot:library,sourceFile,testDriver:fileURLToPath(new URL('./grace-test-driver.mjs',import.meta.url))};
  }
  const core=await ExecutionCore.open(root,{...options,...(registration?{grace:registration}:{})}); cores.push(core);
  const credential=core.enrollAdapter('review','owner');
  return {root,core,credential,sourceFile,...(registration?{registration}:{})};
}
function db(root:string):DatabaseSync { return new DatabaseSync(path.join(root,'core.sqlite'), { timeout: 5000 }); }
function worker(root:string,jobId:string):WorkerRow { const database=db(root); try{return database.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(jobId) as unknown as WorkerRow;} finally{database.close();} }
async function job(core:ExecutionCore,credential:string,id:string,operation:'fixture.hold'|'fixture.write'='fixture.hold'):Promise<TaskBinding> {
  const prepared=core.prepare(credential,{requestId:id,operation,text:'verified source'}); const created=await core.submit(credential,prepared.preparationId); return core.select(credential,created.jobId);
}
afterEach(async()=>{
  for(const root of roots.splice(0)) {
    const database=db(root); const workers=database.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]; database.close();
    for(const value of workers) await stopWorker(value);
    for(const core of cores.splice(0)) { try{core.close();}catch{/* detached */} }
    const absolute=path.resolve(root); if(path.dirname(absolute)!==await realpath(os.tmpdir())||!path.basename(absolute).startsWith('gotzji-lifecycle-')) throw new Error('Invalid fixture cleanup');
    await rm(absolute,{recursive:true,force:true});
  }
});
describe('lifecycle repairs retain authority while restoring control',()=>{
  it('serializes cross-instance start/cancel and admits the next job',async()=>{
    const f=await fixture(); const second=await ExecutionCore.open(f.root); cores.push(second); const binding=await job(f.core,f.credential,'first');
    await Promise.all([f.core.resume(f.credential,binding),second.cancel(f.credential,binding)]);
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'cancelled'});
    const next=await job(f.core,f.credential,'next'); expect(await f.core.resume(f.credential,next)).toMatchObject({status:'running'});
  });
  it('compensates a known pre-launch directory failure without leaving the writer held',async()=>{
    const f=await fixture(); const binding=await job(f.core,f.credential,'fail'); await writeFile(path.join(f.root,'workers'),'not a directory');
    await expect(f.core.resume(f.credential,binding)).rejects.toBeDefined();
    const database=db(f.root); expect(database.prepare('SELECT count(*) AS n FROM gotzji_writers').get()?.n).toBe(0); database.close();
  });
  it('reconciles a terminal writer with no worker only when no launch evidence exists',async()=>{
    const f=await fixture(); const binding=await job(f.core,f.credential,'cancel'); await f.core.cancel(f.credential,binding);
    const database=db(f.root); database.prepare('INSERT INTO gotzji_writers VALUES (?,?,?)').run(f.root,binding.jobId,'unlaunched-epoch'); database.close();
    expect(await f.core.cancel(f.credential,binding)).toMatchObject({status:'cancelled'});
  });
  it('recovers an active pre-launch writer reservation after the admitting host disappears',async()=>{
    const f=await fixture(); const binding=await job(f.core,f.credential,'interrupted-admission');
    const database=db(f.root); database.prepare('INSERT INTO gotzji_writers VALUES (?,?,?)').run(f.root,binding.jobId,'interrupted-no-launch'); database.close();
    expect(await f.core.resume(f.credential,binding)).toMatchObject({status:'running'});
  });
  it('retains an orphan writer if a launch manifest exists',async()=>{
    const f=await fixture(); const binding=await job(f.core,f.credential,'cancel'); await f.core.cancel(f.credential,binding);
    await mkdir(path.join(f.root,'workers','unknown-epoch'),{recursive:true}); await writeFile(path.join(f.root,'workers','unknown-epoch','config.json'),'{}');
    const database=db(f.root); database.prepare('INSERT INTO gotzji_writers VALUES (?,?,?)').run(f.root,binding.jobId,'unknown-epoch'); database.close();
    await expect(f.core.cancel(f.credential,binding)).rejects.toMatchObject({code:'WORKER_RECONCILIATION_REQUIRED'});
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'blocked'});
  });
  it('permits authenticated status/cancel after source drift while rejecting new effects',async()=>{
    const f=await fixture(true); const binding=await job(f.core,f.credential,'live'); await f.core.resume(f.credential,binding);
    await writeFile(f.sourceFile,'Changed source');
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'running'});
    await expect(f.core.resume(f.credential,binding)).rejects.toMatchObject({code:'GRACE_DEPENDENCIES_CHANGED'});
    expect(await f.core.cancel(f.credential,binding)).toMatchObject({status:'cancelled'});
    await expect(f.core.get('foreign',binding)).rejects.toMatchObject({code:'AUTHORITY_DENIED'});
  });
  it('reopens for control after drift without allowing submission/resume or another owner',async()=>{
    const f=await fixture(true); const binding=await job(f.core,f.credential,'live'); await f.core.resume(f.credential,binding); f.core.close(); await writeFile(f.sourceFile,'Changed source');
    const control=await ExecutionCore.openForControl(f.root); cores.push(control);
    expect(await control.get(f.credential,binding)).toMatchObject({status:'running'});
    await expect(control.resume(f.credential,binding)).rejects.toMatchObject({code:'CONTROL_ONLY'});
    expect(()=>control.prepare(f.credential,{requestId:'new',operation:'fixture.write',text:'x'})).toThrow('CONTROL_ONLY');
    expect(()=>control.select('foreign',binding.jobId)).toThrow('AUTHORITY_DENIED');
    expect(await control.cancel(f.credential,binding)).toMatchObject({status:'cancelled'});
  });
  it('proves stop before replacing an expired live worker and preserves its history',async()=>{
    let now=new Date(); const f=await fixture(false,{now:()=>now}); const binding=await job(f.core,f.credential,'expiry'); await f.core.resume(f.credential,binding);
    const old=worker(f.root,binding.jobId); const oldState=await callWorker(old,'status'); f.core.close(); now=new Date(now.getTime()+301000);
    const reopened=await ExecutionCore.open(f.root,{now:()=>now}); cores.push(reopened);
    expect(await reopened.get(f.credential,binding)).toMatchObject({status:'blocked',blockerCode:'LEASE_RECOVERY_REQUIRED'});
    expect(await reopened.resume(f.credential,binding)).toMatchObject({status:'running'});
    const replacement=worker(f.root,binding.jobId); expect(replacement.epoch).not.toBe(old.epoch); expect(replacement.generation).toBeGreaterThan(old.generation); expect(alive(oldState.pid)).toBe(false);
    const database=db(f.root); expect(database.prepare('SELECT reason FROM gotzji_worker_history WHERE epoch=?').get(old.epoch)?.reason).toBe('stopped'); database.close();
  });
  it('finishes a known expired file effect without rewriting it',async()=>{
    let now=new Date(); const f=await fixture(false,{now:()=>now}); const binding=await job(f.core,f.credential,'file','fixture.write'); await f.core.resume(f.credential,binding);
    const filename=path.join(f.root,'effects',binding.jobId,'result.txt'); const before=await stat(filename); now=new Date(now.getTime()+301000);
    expect(await f.core.resume(f.credential,binding)).toMatchObject({status:'completed'}); expect((await stat(filename)).mtimeMs).toBe(before.mtimeMs);
  });
  it('blocks unknown expired effects instead of replaying or releasing the writer',async()=>{
    let now=new Date(); const f=await fixture(false,{now:()=>now}); const binding=await job(f.core,f.credential,'file','fixture.write'); await f.core.resume(f.credential,binding);
    await writeFile(path.join(f.root,'effects',binding.jobId,'result.txt'),'Unexpected bytes'); now=new Date(now.getTime()+301000);
    await expect(f.core.resume(f.credential,binding)).rejects.toMatchObject({code:'EFFECT_RECONCILIATION_REQUIRED'});
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'blocked'});
  });
  it('continues later renewal after a completed artifact changes',async()=>{
    let now=new Date(); const f=await fixture(false,{now:()=>now}); const old=await job(f.core,f.credential,'old','fixture.write'); await f.core.resume(f.credential,old); await f.core.tick();
    const later=await job(f.core,f.credential,'later'); await f.core.resume(f.credential,later); const before=worker(f.root,later.jobId).last_renewed;
    await writeFile(path.join(f.root,'effects',old.jobId,'result.txt'),'Changed completed file'); now=new Date(now.getTime()+30001); await f.core.tick();
    expect(worker(f.root,later.jobId).last_renewed).toBeGreaterThan(before);
  });
  it('records an individual supervision failure but still renews later work',async()=>{
    let now=new Date(); const f=await fixture(false,{now:()=>now}); const old=await job(f.core,f.credential,'old','fixture.write'); await f.core.resume(f.credential,old); await f.core.tick();
    const later=await job(f.core,f.credential,'later'); await f.core.resume(f.credential,later); const before=worker(f.root,later.jobId).last_renewed;
    const database=db(f.root); try { database.prepare('UPDATE gotzji_claims SET goal_key=? WHERE id=?').run('unresolvable-old-job',old.jobId); } finally { database.close(); } now=new Date(now.getTime()+30001);
    await expect(f.core.tick()).rejects.toBeDefined(); expect(worker(f.root,later.jobId).last_renewed).toBeGreaterThan(before);
    const check=db(f.root); expect(check.prepare('SELECT code FROM gotzji_diagnostics WHERE job_id=?').get(old.jobId)).toBeDefined(); check.close();
  });
  it('invalidates cached content when mtime is restored',async()=>{
    const f=await fixture(); const original=await stat(f.sourceFile); const {createHash}=await import('node:crypto'); const expected=createHash('sha256').update(readFileSync(f.sourceFile)).digest('hex');
    verifyFingerprint(f.sourceFile,expected); await writeFile(f.sourceFile,'Modified source\n'); await utimes(f.sourceFile,original.atime,original.mtime);
    expect(()=>verifyFingerprint(f.sourceFile,expected)).toThrow('FILE_FINGERPRINT_CHANGED');
  });
  it('returns cleared progress after a previous supervision blocker is resolved',async()=>{
    const f=await fixture(); const binding=await job(f.core,f.credential,'cleared'); await f.core.resume(f.credential,binding);
    const database=db(f.root); database.prepare('INSERT INTO gotzji_diagnostics VALUES (?,?,?)').run(binding.jobId,'WORKER_RECONCILIATION_REQUIRED',new Date().toISOString()); database.close();
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'blocked'});
    expect(await f.core.resume(f.credential,binding)).toMatchObject({status:'running'});
  });
  it('never steals admission from a live process on timeout',async()=>{
    const f=await fixture(); const binding=await job(f.core,f.credential,'guard'); const database=db(f.root); database.prepare('INSERT INTO gotzji_mutation_guards VALUES (?,?,?)').run(binding.jobId,process.pid,'existing-owner'); database.close();
    await expect(f.core.resume(f.credential,binding)).rejects.toMatchObject({code:'MUTATION_BUSY'});
    const check=db(f.root); expect(check.prepare('SELECT nonce FROM gotzji_mutation_guards WHERE job_id=?').get(binding.jobId)?.nonce).toBe('existing-owner'); check.prepare('DELETE FROM gotzji_mutation_guards').run(); check.close();
  },15000);
  it('reclaims admission only after its recorded owner process is proved absent',async()=>{
    const f=await fixture(); const binding=await job(f.core,f.credential,'dead-guard');
    const child=spawn(process.execPath,['-e',''],{windowsHide:true,stdio:'ignore'}); const pid=child.pid!; await new Promise((resolve)=>child.once('exit',resolve));
    expect(alive(pid)).toBe(false);
    const database=db(f.root); database.prepare('INSERT INTO gotzji_mutation_guards VALUES (?,?,?)').run(binding.jobId,pid,'dead-owner'); database.close();
    expect(await f.core.resume(f.credential,binding)).toMatchObject({status:'running'});
  });
  it('replays only the inspected snapshot after expired-worker receipt loss, preserving history and bytes',async()=>{
    let now=new Date(); const f=await fixture(true,{now:()=>now});
    const preparation=f.core.prepareSourceSnapshot(f.credential,'snapshot'); const created=await f.core.submit(f.credential,preparation.preparationId); const binding=f.core.select(f.credential,created.jobId);
    await f.core.resume(f.credential,binding); const original=worker(f.root,binding.jobId);
    for(let n=0;n<100;n++){if((await callWorker(original,'status')).state==='done')break;await new Promise((resolve)=>setTimeout(resolve,30));}
    const filename=path.join(f.root,'effects',binding.jobId,'result.txt'); const before=await stat(filename);
    await rm(path.join(original.directory,'grace-runtime.json')); now=new Date(now.getTime()+301000);
    await f.core.resume(f.credential,binding); const replacement=worker(f.root,binding.jobId); expect(replacement.epoch).not.toBe(original.epoch);
    for(let n=0;n<100;n++){if((await callWorker(replacement,'status')).state==='done')break;await new Promise((resolve)=>setTimeout(resolve,30));}
    await f.core.tick(); expect(await f.core.get(f.credential,binding)).toMatchObject({status:'completed'}); expect((await stat(filename)).mtimeMs).toBe(before.mtimeMs);
    const database=db(f.root); expect(database.prepare('SELECT count(*) AS n FROM gotzji_recipe_history WHERE epoch=?').get(original.epoch)?.n).toBe(7); database.close();
  },15000);
  it('serializes mutation from two independently running Node processes',async()=>{
    const f=await fixture(); const binding=await job(f.core,f.credential,'process-race');
    const moduleUrl=new URL('../dist/index.js',import.meta.url).href;
    const script=`import {ExecutionCore} from ${JSON.stringify(moduleUrl)}; process.on('message',async (m)=>{ if(m.config){ globalThis.c=m.config; const core=await ExecutionCore.open(m.config.root); globalThis.core=core; process.send({ready:true}); } else if(m.go){ try { const result=await globalThis.core[globalThis.c.action](globalThis.c.credential,globalThis.c.binding); process.send({done:true,result}); } catch(e){process.send({done:true,error:e.code??e.message});} finally{globalThis.core.close();process.disconnect();} } });`;
    const clients=['resume','cancel'].map((action)=>{
      const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
      const ready=new Promise<void>((resolve,reject)=>{child.on('message',(m:unknown)=>{if((m as {ready?:boolean}).ready)resolve();});child.once('error',reject);});
      const result=new Promise<{error?:string;result?:{status:string}}>((resolve,reject)=>{child.on('message',(m:unknown)=>{if((m as {done?:boolean}).done)resolve(m as {error?:string;result?:{status:string}});});child.once('error',reject);});
      child.send({config:{root:f.root,credential:f.credential,binding,action}}); return {child,ready,result};
    });
    await Promise.all(clients.map((value)=>value.ready)); for(const value of clients)value.child.send({go:true}); const results=await Promise.all(clients.map((value)=>value.result));
    expect(results.every((value)=>!value.error)).toBe(true); expect(await f.core.get(f.credential,binding)).toMatchObject({status:'cancelled'});
    const next=await job(f.core,f.credential,'next'); expect(await f.core.resume(f.credential,next)).toMatchObject({status:'running'});
  },20000);
});
