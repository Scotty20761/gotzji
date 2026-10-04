import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { alive } from './managed-worker.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import type { GraceRegistration } from './grace-profile.js';
import { acquireHostOwnership, hashJavaScriptClosure } from './phase-r-host-identity.mjs';
const fixtures: { root: string; core: ExecutionCore }[] = [];
afterEach(async () => {
  for (const {root,core} of fixtures.splice(0)) {
    core.close();
    if (!path.resolve(root).startsWith(path.join(os.tmpdir(),'gotzji-phase-r-'))) throw new Error('Unexpected fixture root');
    await rm(root,{recursive:true,force:true});
  }
});
async function codeFixture(validationMs=25,now?:()=>Date):Promise<{root:string;core:ExecutionCore;credential:string;registration:GraceRegistration}>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gotzji-phase-r-'));
 const libraryRoot=path.join(root,'library');
 for(const file of ['CLAUDE.md','AGENTS.md','KNOWLEDGE_INDEX.md','references/agent-knowledge-workflow.md','.claude/skills/karpathy-guidelines/SKILL.md','.claude/skills/debug-mantra/SKILL.md']){await mkdir(path.dirname(path.join(libraryRoot,file)),{recursive:true});await writeFile(path.join(libraryRoot,file),'# Fixed unit-test policy. No alternate tools.\n');}
 const sourceFile=path.join(root,'source.mjs');await writeFile(sourceFile,'export function add(a, b) { return a - b; }\n');
 const registration={executable:process.execPath,libraryRoot,sourceFile,testDriver:fileURLToPath(new URL('./grace-test-driver.mjs',import.meta.url)),recipe:'code-check' as const,expectedContent:'export function add(a, b) { return a + b; }\n',validationMs};
 const core=await ExecutionCore.open(path.join(root,'core'),{grace:registration,...(now?{now}:{})});fixtures.push({root,core});
 const credential=core.enrollAdapter('gotzji','owner');
 return {root,core,credential,registration};
}
async function waitFor(fn:()=>Promise<boolean>):Promise<void>{for(let n=0;n<200;n++){if(await fn()) return;await new Promise((r)=>setTimeout(r,20));}throw new Error('condition not observed');}
const sha256=(value:string):string=>createHash('sha256').update(value).digest('hex');
function nextLine(child:ChildProcessWithoutNullStreams):Promise<string>{return new Promise((resolve,reject)=>{let buffer='';const onData=(chunk:Buffer):void=>{buffer+=chunk.toString('utf8');const end=buffer.indexOf('\n');if(end>=0){cleanup();resolve(buffer.slice(0,end));}};const onExit=():void=>{cleanup();reject(new Error('child exited before writing a line'));};const cleanup=():void=>{child.stdout.off('data',onData);child.off('exit',onExit);};child.stdout.on('data',onData);child.once('exit',onExit);});}
async function jsonLine(child:ChildProcessWithoutNullStreams,request:unknown):Promise<Record<string,unknown>>{
 const line=nextLine(child);child.stdin.write(`${JSON.stringify(request)}\n`);return JSON.parse(await line) as Record<string,unknown>;
}
it('denies a requested deployment before any prepared job or code effect',async()=>{
 const f=await codeFixture();expect(()=>f.core.prepareCodeChange(f.credential,'denied','deploy')).toThrow('DELIVERY_SCOPE_DENIED');
 const db=new DatabaseSync(path.join(f.root,'core','core.sqlite'));try{expect(db.prepare('SELECT COUNT(*) n FROM gotzji_preparations').get()?.n).toBe(0);}finally{db.close();}
});
it('real code repair and asynchronous command produce native gate evidence and the final artifact',async()=>{
 const f=await codeFixture();const p=f.core.prepareCodeChange(f.credential,'actual-code');const job=await f.core.submit(f.credential,p.preparationId);const binding=f.core.select(f.credential,job.jobId);
 await f.core.resume(f.credential,binding);
 try{
  await waitFor(async()=>{await f.core.tick();return (await f.core.get(f.credential,binding)).status==='completed';});
  const view=await f.core.get(f.credential,binding);expect(view.progress?.state).toBe('completed');expect(view.progress?.checks).toBeGreaterThan(5);expect(view.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.core.readCodeResult(f.credential,binding)).toMatchObject({content:f.registration.expectedContent});
  const db=new DatabaseSync(path.join(f.root,'core','core.sqlite'));try{const goal=db.prepare('SELECT engineering_metadata_json FROM goals').get();expect(JSON.parse(String(goal?.engineering_metadata_json)).gates[0].status).toBe('passed');expect(db.prepare('SELECT COUNT(*) n FROM gotzji_outbox WHERE job_id=?').get(job.jobId)?.n).toBe(1);}finally{db.close();}
 }finally{await f.core.cancel(f.credential,binding);}
},10000);
it('observer closure and retry preserve the live command and exactly one effect/job',async()=>{
 const f=await codeFixture(1200);const p=f.core.prepareCodeChange(f.credential,'same-code');const job=await f.core.submit(f.credential,p.preparationId);const binding=f.core.select(f.credential,job.jobId);
 await f.core.resume(f.credential,binding);
 let reopened:ExecutionCore|undefined;
 try{
  await waitFor(async()=>{const view=await f.core.get(f.credential,binding);return !!view.progress&&view.progress.state==='running'&&view.progress.checks>=0;});
  f.core.close();reopened=await ExecutionCore.open(path.join(f.root,'core'),{grace:f.registration});
  const again=reopened.prepareCodeChange(f.credential,'same-code');expect((await reopened.submit(f.credential,again.preparationId)).jobId).toBe(job.jobId);
  await reopened.resume(f.credential,binding);
  await waitFor(async()=>{await reopened!.tick();return (await reopened!.get(f.credential,binding)).status==='completed';});
  const db=new DatabaseSync(path.join(f.root,'core','core.sqlite'));try{expect(db.prepare('SELECT COUNT(*) n FROM gotzji_workers WHERE job_id=?').get(job.jobId)?.n).toBe(1);expect(db.prepare('SELECT COUNT(*) n FROM gotzji_claims').get()?.n).toBe(1);}finally{db.close();}
  const logs=reopened.logs(f.credential,binding,0,80);expect(Buffer.byteLength(logs.text)).toBeLessThanOrEqual(80);expect(logs.nextCursor).toBeGreaterThan(0);
 }finally{if(reopened){await reopened.cancel(f.credential,binding);reopened.close();}else{await f.core.cancel(f.credential,binding);}}
},10000);
it('returns the host-authorized delivery boundary with the canonical selected job', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'gotzji-phase-r-'));
  const core=await ExecutionCore.open(root); fixtures.push({root,core});
  const credential=core.enrollAdapter('gotzji','owner');
  const prepared=core.prepare(credential,{requestId:'local-job',operation:'fixture.write',text:'approved local output'});
  const job=await core.submit(credential,prepared.preparationId);
  expect(await core.get(credential,core.select(credential,job.jobId))).toHaveProperty('deliveryBoundary','local');
});
it('a changed authorization record cannot launch the requested local effect',async()=>{
 const f=await codeFixture();const p=f.core.prepareCodeChange(f.credential,'tampered');const job=await f.core.submit(f.credential,p.preparationId);const binding=f.core.select(f.credential,job.jobId);
 const db=new DatabaseSync(path.join(f.root,'core','core.sqlite'));try{db.prepare('UPDATE gotzji_authorized_jobs SET boundary=? WHERE job_id=?').run('deploy',job.jobId);}finally{db.close();}
 await expect(f.core.resume(f.credential,binding)).rejects.toThrow('DELIVERY_AUTHORITY_DENIED');
 const after=new DatabaseSync(path.join(f.root,'core','core.sqlite'));try{expect(after.prepare('SELECT COUNT(*) n FROM gotzji_workers').get()?.n).toBe(0);}finally{after.close();}
});
it('cancellation stops the owned validation command and preserves the cancelled job',async()=>{
 const f=await codeFixture(3000);const p=f.core.prepareCodeChange(f.credential,'cancel-code');const job=await f.core.submit(f.credential,p.preparationId);const binding=f.core.select(f.credential,job.jobId);
 await f.core.resume(f.credential,binding);
 await waitFor(async()=>!!(await f.core.get(f.credential,binding)).progress);
 const db=new DatabaseSync(path.join(f.root,'core','core.sqlite'));let directory='';try{directory=String(db.prepare('SELECT directory FROM gotzji_workers WHERE job_id=?').get(job.jobId)?.directory);}finally{db.close();}
 expect((await f.core.cancel(f.credential,binding)).status).toBe('cancelled');
 const stopped=JSON.parse(JSON.parse(await readFile(path.join(directory,'stopped.json'),'utf8')).body) as {descendants:number[]};
 expect(stopped.descendants.every((pid)=>alive(pid)===false)).toBe(true);
 expect((await f.core.get(f.credential,binding)).status).toBe('cancelled');
},10000);

it('rejects native gate evidence when the observed run is rebound to another goal',async()=>{
 const f=await codeFixture();const p=f.core.prepareCodeChange(f.credential,'goal-bound-code');const job=await f.core.submit(f.credential,p.preparationId);const binding=f.core.select(f.credential,job.jobId);
 await f.core.resume(f.credential,binding);
 try{
  await waitFor(async()=>((await f.core.get(f.credential,binding)).progress?.state==='completed'));
  const db=new DatabaseSync(path.join(f.root,'core','core.sqlite'));try{db.prepare('UPDATE gotzji_claims SET goal_id=? WHERE id=?').run('foreign-goal',job.jobId);}finally{db.close();}
  await expect(f.core.tick()).rejects.toMatchObject({code:'INVALID_INPUT',reason:'job_binding_mismatch'});
  expect((await f.core.get(f.credential,binding)).status).toBe('blocked');
 }finally{await f.core.cancel(f.credential,binding);}
},10000);

it('rejects a signed command receipt that does not match the registered validator recipe',async()=>{
 const f=await codeFixture(3000);const p=f.core.prepareCodeChange(f.credential,'recipe-bound-code');const job=await f.core.submit(f.credential,p.preparationId);const binding=f.core.select(f.credential,job.jobId);
 await f.core.resume(f.credential,binding);
 try{
  await waitFor(async()=>((await f.core.get(f.credential,binding)).progress?.state==='running'));
  const db=new DatabaseSync(path.join(f.root,'core','core.sqlite'));let worker:{directory:string;token:string;epoch:string};try{worker=db.prepare('SELECT directory,token,epoch FROM gotzji_workers WHERE job_id=?').get(job.jobId) as unknown as typeof worker;}finally{db.close();}
  const filename=path.join(worker.directory,'validation.json');
  const envelope=JSON.parse(await readFile(filename,'utf8')) as {body:string;mac:string};
  const receipt=JSON.parse(envelope.body) as {authorizationDigest:string;command:string;commandFingerprint:string;runId:string};
  receipt.command=`${process.execPath} unregistered-validator.mjs`;
  receipt.commandFingerprint=sha256(receipt.command);
  receipt.runId=sha256(`${job.jobId}\0${worker.epoch}\0${receipt.authorizationDigest}\0${receipt.command}`);
  const body=JSON.stringify(receipt);await writeFile(filename,JSON.stringify({body,mac:createHmac('sha256',worker.token).update(body).digest('hex')}));
  await expect(f.core.get(f.credential,binding)).rejects.toThrow('COMMAND_RECEIPT_INVALID');
 }finally{await f.core.cancel(f.credential,binding);}
},10000);

it('recovers an expired completed code worker only after proving the old process stopped',async()=>{
 let clock=Date.now();const f=await codeFixture(25,()=>new Date(clock));const p=f.core.prepareCodeChange(f.credential,'expired-complete');const job=await f.core.submit(f.credential,p.preparationId);const binding=f.core.select(f.credential,job.jobId);
 await f.core.resume(f.credential,binding);
 await waitFor(async()=>((await f.core.get(f.credential,binding)).progress?.state==='completed'));
 const db=new DatabaseSync(path.join(f.root,'core','core.sqlite'));let directory='';try{directory=String(db.prepare('SELECT directory FROM gotzji_workers WHERE job_id=?').get(job.jobId)?.directory);}finally{db.close();}
 clock+=301000;await f.core.tick();
 expect((await f.core.get(f.credential,binding)).status).toBe('completed');
 const stopped=JSON.parse(JSON.parse(await readFile(path.join(directory,'stopped.json'),'utf8')).body) as {pid:number;descendants:number[]};
 expect([stopped.pid,...stopped.descendants].every((pid)=>alive(pid)===false)).toBe(true);
},10000);

it('replays only the read-only validation path after an expired partial code run is stopped',async()=>{
 let clock=Date.now();const f=await codeFixture(1500,()=>new Date(clock));const p=f.core.prepareCodeChange(f.credential,'expired-partial');const job=await f.core.submit(f.credential,p.preparationId);const binding=f.core.select(f.credential,job.jobId);
 await f.core.resume(f.credential,binding);
 await waitFor(async()=>((await f.core.get(f.credential,binding)).progress?.state==='running'));
 const db=new DatabaseSync(path.join(f.root,'core','core.sqlite'));let old:{epoch:string;directory:string};try{old=db.prepare('SELECT epoch,directory FROM gotzji_workers WHERE job_id=?').get(job.jobId) as unknown as typeof old;}finally{db.close();}
 clock+=301000;await f.core.tick();
 await waitFor(async()=>{await f.core.tick();return (await f.core.get(f.credential,binding)).status==='completed';});
 const after=new DatabaseSync(path.join(f.root,'core','core.sqlite'));try{expect(after.prepare('SELECT reason FROM gotzji_worker_history WHERE epoch=?').get(old.epoch)?.reason).toBe('stopped');expect(after.prepare('SELECT epoch FROM gotzji_workers WHERE job_id=?').get(job.jobId)?.epoch).not.toBe(old.epoch);}finally{after.close();}
 const stopped=JSON.parse(JSON.parse(await readFile(path.join(old.directory,'stopped.json'),'utf8')).body) as {pid:number;descendants:number[]};
 expect([stopped.pid,...stopped.descendants].every((pid)=>alive(pid)===false)).toBe(true);
},15000);

it('keeps a real nonzero validator result blocked instead of replaying it as an interruption',async()=>{
 let clock=Date.now();const f=await codeFixture(5000,()=>new Date(clock));const p=f.core.prepareCodeChange(f.credential,'failed-validation');const job=await f.core.submit(f.credential,p.preparationId);const binding=f.core.select(f.credential,job.jobId);
 await f.core.resume(f.credential,binding);
 try{
  await waitFor(async()=>((await f.core.get(f.credential,binding)).progress?.state==='running'));
  const verifier=fileURLToPath(new URL('./phase-r-validator.mjs',import.meta.url));const sourceHash=sha256(await readFile(f.registration.sourceFile,'utf8'));const actual=spawnSync(process.execPath,[verifier,f.registration.sourceFile,sourceHash,'0'],{windowsHide:true,encoding:'utf8'});expect(actual.status).toBe(1);expect(actual.stdout).toContain('CODE_ASSERTION_FAILED');
  const db=new DatabaseSync(path.join(f.root,'core','core.sqlite'));let worker:{directory:string;token:string};try{worker=db.prepare('SELECT directory,token FROM gotzji_workers WHERE job_id=?').get(job.jobId) as unknown as typeof worker;}finally{db.close();}
  const filename=path.join(worker.directory,'validation.json');const envelope=JSON.parse(await readFile(filename,'utf8')) as {body:string;mac:string};const receipt=JSON.parse(envelope.body) as Record<string,unknown>;receipt.state='failed';receipt.exitCode=actual.status;receipt.lastProgressAt=new Date().toISOString();const body=JSON.stringify(receipt);await writeFile(filename,JSON.stringify({body,mac:createHmac('sha256',worker.token).update(body).digest('hex')}));
  expect((await f.core.get(f.credential,binding)).progress).toMatchObject({state:'failed'});
  clock+=301000;
  await expect(f.core.tick()).rejects.toThrow('VALIDATION_FAILED');
  expect((await f.core.get(f.credential,binding)).status).toBe('blocked');
 }finally{await f.core.cancel(f.credential,binding);}
},15000);

it('admits two concurrent frontends to one owner-bound daemon without replacing live identity',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gotzji-phase-r-host-'));const directory=path.join(root,'core');let daemonPid:number|undefined;const frontends:ChildProcessWithoutNullStreams[]=[];
 try{
  const libraryRoot=path.join(root,'library');for(const file of ['CLAUDE.md','AGENTS.md','KNOWLEDGE_INDEX.md','references/agent-knowledge-workflow.md','.claude/skills/karpathy-guidelines/SKILL.md','.claude/skills/debug-mantra/SKILL.md']){await mkdir(path.dirname(path.join(libraryRoot,file)),{recursive:true});await writeFile(path.join(libraryRoot,file),'# Fixed host admission policy.\n');}
  const sourceFile=path.join(root,'source.mjs');await writeFile(sourceFile,'export function add(a, b) { return a - b; }\n');
  const registration={executable:process.execPath,libraryRoot,sourceFile,testDriver:fileURLToPath(new URL('./grace-test-driver.mjs',import.meta.url)),recipe:'code-check' as const,expectedContent:'export function add(a, b) { return a + b; }\n',validationMs:25};
  const bootstrap=await ExecutionCore.open(directory,{grace:registration});const credential=bootstrap.enrollAdapter('gotzji','owner');bootstrap.close();
  const daemonSecret=randomBytes(32).toString('hex');const configPath=path.join(root,'host.json');await writeFile(configPath,JSON.stringify({...registration,directory,credential,daemonSecret}));
  const frontend=fileURLToPath(new URL('../dist/phase-r-frontend.mjs',import.meta.url));
  for(let n=0;n<2;n++) frontends.push(spawn(process.execPath,[frontend,configPath],{stdio:['pipe','pipe','pipe'],windowsHide:true}));
  const responses=await Promise.all(frontends.map((child,index)=>jsonLine(child,{jsonrpc:'2.0',id:index+1,method:'initialize',params:{protocolVersion:'2025-11-25'}})));
  expect(responses.every((response)=>!response.error)).toBe(true);
  const readyEnvelope=JSON.parse(await readFile(path.join(directory,'daemon-ready.json'),'utf8')) as {body:string;mac:string};expect(readyEnvelope.mac).toBe(createHmac('sha256',daemonSecret).update(readyEnvelope.body).digest('hex'));
  const ready=JSON.parse(readyEnvelope.body) as {pid:number;ownerNonce?:string;sourceHash?:string;configurationHash?:string};daemonPid=ready.pid;expect(ready.ownerNonce).toMatch(/^[a-f0-9]{48}$/);expect(ready.sourceHash).toMatch(/^[a-f0-9]{64}$/);expect(ready.configurationHash).toMatch(/^[a-f0-9]{64}$/);
  const ownerDb=new DatabaseSync(path.join(directory,'core.sqlite'));try{expect(ownerDb.prepare('SELECT pid,nonce FROM gotzji_host_owners WHERE name=?').get('daemon')).toEqual({pid:ready.pid,nonce:ready.ownerNonce});}finally{ownerDb.close();}expect(alive(ready.pid)).toBe(true);
  const changedDb=new DatabaseSync(path.join(directory,'core.sqlite'));try{changedDb.prepare('UPDATE gotzji_meta SET policy=?').run('changed-policy');}finally{changedDb.close();}
  const changed=spawn(process.execPath,[frontend,configPath],{stdio:['pipe','pipe','pipe'],windowsHide:true});frontends.push(changed);let changedError='';changed.stderr.on('data',(chunk:Buffer)=>{changedError+=chunk.toString('utf8');});await once(changed,'exit');expect(changed.exitCode).not.toBe(0);expect(changedError).toContain('HOST_BUILD_CHANGED');
 }finally{
  for(const child of frontends){child.stdin.end();if(child.exitCode===null) await Promise.race([once(child,'exit'),new Promise((resolve)=>setTimeout(resolve,2000))]);if(child.exitCode===null) child.kill();}
  if(daemonPid&&alive(daemonPid)===true){process.kill(daemonPid);await waitFor(async()=>alive(daemonPid!)===false);}
  await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 }
},20000);

it('serializes competing stale-owner reclaimers and treats an incomplete legacy owner as transient contention',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gotzji-phase-r-host-'));const database=new DatabaseSync(path.join(root,'core.sqlite'));database.exec("CREATE TABLE gotzji_host_owners (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL); INSERT INTO gotzji_host_owners VALUES ('daemon',2147483647,'dead-owner');");database.close();
 const key=randomBytes(32).toString('hex'),barrier=path.join(root,'start');const helper=pathToFileURL(fileURLToPath(new URL('../dist/phase-r-host-identity.mjs',import.meta.url))).href;
 const probe="import{existsSync}from'node:fs';const{acquireHostOwnership}=await import(process.argv[1]);const [root,key,barrier]=process.argv.slice(2);process.stdout.write('waiting\\n');while(!existsSync(barrier))await new Promise(r=>setTimeout(r,5));const owner=acquireHostOwnership(root,key);process.stdout.write((owner?'acquired':'denied')+'\\n');if(owner){await new Promise(r=>setTimeout(r,1000));owner.release();}";
 const children=[0,1].map(()=>spawn(process.execPath,['--input-type=module','-e',probe,helper,root,key,barrier],{stdio:['pipe','pipe','pipe'],windowsHide:true}));
 try{
  await Promise.all(children.map((child)=>nextLine(child)));const outcomes=children.map((child)=>nextLine(child));await writeFile(barrier,'go');expect((await Promise.all(outcomes)).sort()).toEqual(['acquired','denied']);await Promise.all(children.map((child)=>once(child,'exit')));
  const check=new DatabaseSync(path.join(root,'core.sqlite'));try{expect(check.prepare('SELECT COUNT(*) n FROM gotzji_host_owners').get()?.n).toBe(0);}finally{check.close();}
  await writeFile(path.join(root,'daemon-owner.json'),'{');expect(acquireHostOwnership(root,key)).toBeNull();await rm(path.join(root,'daemon-owner.json'));const recovered=acquireHostOwnership(root,key);expect(recovered).not.toBeNull();recovered?.release();
 }finally{for(const child of children) if(child.exitCode===null) child.kill();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
},15000);

it('changes the host closure identity when a loaded dependency byte changes',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gotzji-phase-r-host-'));try{const entry=path.join(root,'entry.mjs'),dependency=path.join(root,'dependency.mjs');await writeFile(entry,"export { value } from './dependency.mjs';\n");await writeFile(dependency,'export const value = 1;\n');const before=hashJavaScriptClosure([pathToFileURL(entry)]);await writeFile(dependency,'export const value = 2;\n');expect(hashJavaScriptClosure([pathToFileURL(entry)])).not.toBe(before);}finally{await rm(root,{recursive:true,force:true});}
});
