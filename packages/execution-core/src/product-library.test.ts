import { access, cp, mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { closeSync, fstatSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOwnedTestLifetime, finishOwnedTest, type OwnedTestLifetime } from '../test-support/owned-test-lifetime.js';
import { ExecutionCore } from './core.js';
import { hash, type WorkerRow } from './store.js';
import { alive, signed, stopWorker } from './managed-worker.js';
import type { ProductRegistration } from './grace-profile.js';
import type { TaskBinding } from './types.js';
import type { ProductLibraryInput } from './product-library.js';
import { libraryWorkflow } from './library-workflow-registry.js';
const { createTestFixtureLifecycle, waitForFixture } = await import('./test-fixture-lifecycle.mjs');
const { productBrokerCall } = await import('./product-broker.mjs');
const { assertPreparedLibraryDependencies, executePreparedLibraryOperation } = await import('./product-library-broker.mjs');
const { issueSyntheticCleanupCapability } = await import('./test-worker-cleanup.mjs');

interface FixtureLifecycle { run<T>(operation:(signal:AbortSignal)=>Promise<T>):Promise<T>; own(label:string,close:()=>Promise<void>|void):void; close():Promise<void> }
interface Fixture { root:string; library:string; core:ExecutionCore; credential:string; profile:ProductRegistration; libraryTestRunner?:string; bindings:TaskBinding[]; lifecycle:OwnedTestLifetime }
const fixtures:Fixture[]=[];
let testLifetime:OwnedTestLifetime;
beforeEach(()=>{testLifetime=createOwnedTestLifetime();});
function ownBody<Arguments extends unknown[]>(body:(...args:Arguments)=>Promise<void>):(...args:Arguments)=>Promise<void>{return(...args):Promise<void>=>testLifetime.run(()=>body(...args));}

interface LibraryTestDiagnostic { requestId:'response-loss'|'cancel-wait'; stage:string; started:number; events:number; root?:string }
const libraryTestDiagnostics:LibraryTestDiagnostic[]=[];
function libraryTestDiagnostic(requestId:LibraryTestDiagnostic['requestId']):LibraryTestDiagnostic|undefined{
  if(process.env.GOTZJI_LIBRARY_DIAGNOSTIC!=='1')return undefined;
  const value={requestId,stage:'start',started:performance.now(),events:0};libraryTestDiagnostics.push(value);libraryTestDiagnosticRecord(value,'start');return value;
}
function libraryTestDiagnosticRecord(value:LibraryTestDiagnostic,event:'start'|'begin'|'end'|'snapshot',detail:Record<string,unknown>={}):void{
  try{
    if(value.events++>=32)return;
    const record={tag:'gotzji-library-diagnostic',version:1,requestId:value.requestId,stage:value.stage,event,elapsedMs:Math.round(performance.now()-value.started),...detail};
    const encoded=JSON.stringify(record);console.error(encoded.length<=8192?encoded:JSON.stringify({...record,snapshot:undefined,truncated:true}));
  }catch{/* Observation must not replace the original test or cleanup error. */}
}
function libraryTestDiagnosticPhase<T>(value:LibraryTestDiagnostic|undefined,stage:'fixture'|'submit'|'resume'|'until'|'cancel',operation:()=>Promise<T>):Promise<T>{
  if(!value)return operation();
  value.stage=stage;libraryTestDiagnosticRecord(value,'begin');
  try{return operation().then((result)=>{libraryTestDiagnosticRecord(value,'end',{outcome:'returned'});return result;},(error:unknown)=>{libraryTestDiagnosticRecord(value,'end',{outcome:'threw'});throw error;});}
  catch(error){libraryTestDiagnosticRecord(value,'end',{outcome:'threw'});throw error;}
}
function libraryTestDiagnosticFile(directory:string,name:string):Record<string,unknown>{
  let handle:number|undefined;let record:Record<string,unknown>={name};
  try{
    handle=openSync(path.join(directory,name),'r');const metadata=fstatSync(handle);
    record={name,exists:true,sizeBytes:metadata.size,mtimeMs:Math.round(metadata.mtimeMs)};
    if(!metadata.isFile()||(name==='config.json'||name==='lost-effect.txt')||metadata.size>8192)return record;
    const bytes=Buffer.alloc(Math.min(metadata.size,8192));const length=readSync(handle,bytes,0,bytes.length,0);
    const envelope=JSON.parse(bytes.subarray(0,length).toString('utf8')) as Record<string,unknown>;
    const body=(typeof envelope.body==='string'?JSON.parse(envelope.body):envelope) as Record<string,unknown>;
    record.stateVerification='unverified-diagnostic-read';
    for(const key of ['state','phase','outcome','code'])if(typeof body[key]==='string'&&/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(body[key] as string))record[key]=body[key];
    if(Number.isSafeInteger(body.pid)&&Number(body.pid)>0)record.pid=body.pid;
    for(const key of ['descendants','closedDescendants'])if(Array.isArray(body[key]))record[key+'Count']=(body[key] as unknown[]).length;
    return record;
  }catch{return{...record,availability:'missing-or-unavailable'};}
  finally{if(handle!==undefined)try{closeSync(handle);}catch{/* Diagnostic handle only. */}}
}
function libraryTestDiagnosticSnapshot(value:LibraryTestDiagnostic):void{
  const snapshot:Record<string,unknown>={fixture:value.root?path.basename(value.root):'not-recorded'};let database:DatabaseSync|undefined;
  try{
    if(value.root){
      snapshot.applyMarker=libraryTestDiagnosticFile(path.join(value.root,'library'),'lost-effect.txt');
      database=new DatabaseSync(path.join(value.root,'state','core.sqlite'),{readOnly:true,timeout:0});database.exec('PRAGMA query_only=ON;');
      const claim=database.prepare('SELECT id,request_id,goal_id FROM gotzji_claims WHERE request_id=? LIMIT 1').get(value.requestId) as {id:string;request_id:string;goal_id:string|null}|undefined;
      snapshot.claim=claim?{jobId:claim.id,requestId:claim.request_id,goalId:claim.goal_id}:null;
      if(claim){
        snapshot.goal=database.prepare('SELECT status,revision FROM goals WHERE id=? LIMIT 1').get(claim.goal_id);
        snapshot.operation=database.prepare('SELECT phase FROM gotzji_operations WHERE job_id=? LIMIT 1').get(claim.id);
        snapshot.steps=database.prepare('SELECT operation_id,phase FROM gotzji_recipe_operations WHERE job_id=? ORDER BY operation_id LIMIT 12').all(claim.id);
        snapshot.writerPresent=!!database.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=? LIMIT 1').get(claim.id);
        snapshot.resourcePresent=!!database.prepare('SELECT 1 FROM gotzji_resource_claims WHERE job_id=? LIMIT 1').get(claim.id);
        const worker=database.prepare('SELECT directory,launch_state FROM gotzji_workers WHERE job_id=? LIMIT 1').get(claim.id) as {directory:string;launch_state:string}|undefined;
        snapshot.workerPresent=!!worker;
        if(worker){
          const relative=path.relative(value.root,worker.directory);snapshot.workerLaunchState=worker.launch_state;
          if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)){
            snapshot.workerDirectory=relative;snapshot.workerFiles=['config.json','ready.json','observation.json','stopped.json','broker-error.json','library-progress.json','grace-runtime.json'].map((name)=>libraryTestDiagnosticFile(worker.directory,name));
          }else snapshot.workerDirectory='outside-fixture';
        }
        snapshot.effectFiles=['library-operation.json','library-step-apply.json','library-step-validate.json'].map((name)=>libraryTestDiagnosticFile(path.join(value.root!,'state','effects',claim.id),name));
      }
    }
  }catch{snapshot.database='busy-or-unavailable';}
  finally{if(database)try{database.close();}catch{/* Diagnostic connection only. */}}
  libraryTestDiagnosticRecord(value,'snapshot',{snapshot});
}

const policies=['CLAUDE.md','AGENTS.md','references/agent-knowledge-workflow.md','KNOWLEDGE_INDEX.md'];
async function fixture(runner=false,finalFailure?:'pipeline'|'atom-after-write'|'omit-index',direct=false,diagnostic?:LibraryTestDiagnostic,barrier?:{readonly reached:(root:string)=>void;readonly wait:Promise<void>},parentLifetime:OwnedTestLifetime=testLifetime):Promise<Fixture>{
  const lifecycle=createOwnedTestLifetime(parentLifetime.signal);
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'gotzji-library-')));const library=path.join(root,'library');
  if(diagnostic)diagnostic.root=root;
  if(barrier){barrier.reached(root);await barrier.wait;}
  await mkdir(path.join(library,'references'),{recursive:true});
  for(const filename of policies) await writeFile(path.join(library,filename),`Policy ${filename}\n`);
  await mkdir(path.join(library,'.claude','skills','karpathy-guidelines'),{recursive:true});
  await mkdir(path.join(library,'.claude','skills','debug-mantra'),{recursive:true});
  for(const directory of ['scripts/lib','.claude/agents','Team','indexes/tickers','team-outputs/cards/TEST','team-outputs/filings','team-outputs/earnings','team-outputs/memos','team-outputs/research-reports','knowledge-base/atoms']) await mkdir(path.join(library,directory),{recursive:true});
  for(const filename of ['.claude/skills/karpathy-guidelines/SKILL.md','.claude/skills/debug-mantra/SKILL.md','scripts/audit_orphan_md.py','scripts/validate.py']) await writeFile(path.join(library,filename),'fixture\n');
  for(const filename of ['references/source-priority.md','references/index-wiring-map.md','references/workflow-memo.md','Team/memo.md','Team/fact-check.md','.claude/agents/mammos.md','.claude/agents/facty.md','.claude/agents/indie.md','user-profile.md','scripts/lib/pipeline_parse.py','scripts/lib/control_lock.py','scripts/lib/process_lease.py','scripts/lib/source_siblings.py','scripts/lib/design_export.py','scripts/lib/asset_bump.py','scripts/lib/streaming_files.py']) await writeFile(path.join(library,filename),`Policy ${filename}\n`);
  for(const actor of ['mammos','facty','indie']) await writeFile(path.join(library,'.claude','agents',`${actor}.md`),`---\nname: ${actor}\ndescription: fixture ${actor}\n---\n\n# Canonical ${actor}\nFollow the frozen fixture role.\n`);
  await writeFile(path.join(library,'scripts/lib/ticker_company_map.json'),'{}\n');
  await writeFile(path.join(library,'indexes/INDEX_outputs.md'),'outputs\n');await writeFile(path.join(library,'indexes/tickers/TEST.md'),'ticker\n');
  await writeFile(path.join(library,'knowledge-base/index.md'),'atoms\n');await writeFile(path.join(library,'knowledge-base/topic-map.md'),'topics\n');
  await writeFile(path.join(library,'knowledge-base/contradiction-registry.md'),'# Contradictions\n');
  await writeFile(path.join(library,'pipeline.md'),'## Active Pipeline\n| Ticker | Stage | Owner | Last Update | Next Action | Notes |\n|---|---|---|---|---|---|\n| TEST | 📇 Card ✅ | Pumpkin | 2026-10-01 | Memo | |\n');
  await writeFile(path.join(library,'team-outputs/cards/TEST/Company Overview.md'),'---\ntype: card\ntickers: [TEST]\n---\nCard evidence\n');
  await writeFile(path.join(library,'team-outputs/filings/TEST_10-Q_2026.md'),'---\ntype: filing\ntickers: [TEST]\n---\nFiling evidence\n');
  await writeFile(path.join(library,'team-outputs/earnings/TEST-Q2-2026-earnings.md'),'---\ntype: earnings\ntickers: [TEST]\n---\nEarnings evidence\n');
  const pipelineScript=finalFailure==='pipeline'?'process.exit(9);':`const fs=require('node:fs');const path=require('node:path');const file=path.join(process.cwd(),'pipeline.md');const lines=fs.readFileSync(file,'utf8').split('\\n');const i=lines.findIndex(line=>line.startsWith('| TEST |'));if(i<0)process.exit(7);lines[i]='| TEST | 📊 Memo ✅ | Mammos | 2026-10-07 | ✅ Decision (user) | |';fs.writeFileSync(file,lines.join('\\n'));`;
  const atomScript=`const fs=require('node:fs');const path=require('node:path');const dir=path.join(process.cwd(),'knowledge-base','atoms');const id='ATOM-9000';const target=path.join(dir,id+'-pending.md');fs.writeFileSync(target,'reserved',{flag:'wx'});${finalFailure==='atom-after-write'?'process.exit(8);':`process.stdout.write(id+' '+target+'\\n');`}`;
  const indexScript=finalFailure==='omit-index'?`process.exit(0);`:`const fs=require('node:fs');const path=require('node:path');const root=process.cwd();const memo='TEST_memo_2026-10.md';fs.writeFileSync(path.join(root,'KNOWLEDGE_INDEX.md'),'Policy KNOWLEDGE_INDEX.md\\nMemo count: 1\\n');fs.writeFileSync(path.join(root,'indexes','INDEX_outputs.md'),memo+'\\n');fs.writeFileSync(path.join(root,'indexes','tickers','TEST.md'),memo+'\\n');const atoms=fs.readdirSync(path.join(root,'knowledge-base','atoms')).filter(x=>x.startsWith('ATOM-')).map(x=>x.split('-').slice(0,2).join('-'));fs.writeFileSync(path.join(root,'knowledge-base','index.md'),atoms.join('\\n')+'\\n');fs.writeFileSync(path.join(root,'knowledge-base','topic-map.md'),atoms.join('\\n')+'\\n');`;
  await writeFile(path.join(library,'scripts/pipeline_dashboard.py'),pipelineScript);await writeFile(path.join(library,'scripts/save_atom.py'),atomScript);await writeFile(path.join(library,'scripts/build_indexes_from_frontmatter.py'),indexScript);
  await writeFile(path.join(library,'scripts/audit_portfolio_private.py'),'process.stdout.write("{\\"status\\":\\"pass\\"}\\n");\n');
  await writeFile(path.join(library,'scripts/audit_orphan_md.py'),'process.exit(0);\n');await writeFile(path.join(library,'scripts/validate.py'),'process.exit(0);\n');
  await writeFile(path.join(library,'source.md'),'Original source\n');
  const profile:ProductRegistration=direct?{mode:'host-direct',libraryRoot:library,...(runner?{testOnlyProviders:true as const}:{})}:{executable:process.execPath,libraryRoot:library,testDriver:fileURLToPath(new URL('./grace-test-driver.mjs',import.meta.url))};
  let testRunnerModule:string|undefined;
  if(runner){
    testRunnerModule=path.join(root,'library-test-runner.mjs');
    await writeFile(testRunnerModule,`import {createHash} from 'node:crypto';import {writeFileSync} from 'node:fs';import path from 'node:path';const sha=x=>createHash('sha256').update(x).digest('hex');export async function executeLibraryStep({config,prepared,step},signal){if(signal.aborted)throw Object.assign(new Error('LIBRARY_CANCELLED'),{code:'LIBRARY_CANCELLED',outcome:'none'});const binding=prepared.library.spokePolicies?.[step.actor];const spoke=binding?{delegatedBy:'grace',...binding}:{};if(prepared.input.parameters.intent==='response-loss'&&step.id==='apply'){writeFileSync(path.join(prepared.project.rootPath,'lost-effect.txt'),'once',{flag:'wx'});throw Object.assign(new Error('LOST_RESPONSE'),{code:'LOST_RESPONSE',outcome:'unknown'});}if(prepared.library.ast.workflowId==='library.final-memo'){if(step.id==='mammos'){const content="---\\ntitle: TEST memo\\ndate: 2026-10-07\\ntype: memo\\ntickers: [TEST]\\nrelated:\\n  - '[[team-outputs/cards/TEST/Company Overview.md]]'\\n---\\n\\n# TEST Memo\\n\\n## 🔄 Handoff\\n\\n- **To:** Facty\\n- **Stage transition:** Memo to audit\\n- **INDEX consulted:** ticker\\n- **Sources used:** card filing earnings\\n- **Key inputs to use:** thesis\\n- **Open questions:** none\\n- **Pipeline action:** decision\\n- **Index action:** generated\\n";return{...spoke,content,invocationDigest:sha('mammos invocation'),artifactDigest:sha(content)};}if(step.id==='facty'){const content=prepared.input.requestId==='memo-block'?'VERDICT: BLOCK\\n\\nUnsupported claim.':'VERDICT: PASS\\n\\nFrozen evidence reconciles.';return{...spoke,content,verdict:prepared.input.requestId==='memo-block'?'BLOCK':'PASS',invocationDigest:sha('facty invocation'),artifactDigest:sha(content)};}if(step.id==='indie'){const content=JSON.stringify({atoms:[{topic:'Demand',thesis:'bull',confidence:'high',content:'อุปสงค์มีหลักฐานรองรับจาก memo ที่ผ่านการตรวจสอบแล้ว'}]});return{...spoke,content,atoms:JSON.parse(content).atoms,invocationDigest:sha('indie invocation'),artifactDigest:sha(content)};}return{kind:'library-test-use-built-in'};}return{stepId:step.id,value:'verified-'+step.id,...(step.actor==='mammos'||step.actor==='facty'?{invocationDigest:'a'.repeat(64),artifactDigest:'b'.repeat(64),...(step.actor==='facty'?{verdict:'PASS'}:{})}:{})};}`);
  }
  const core=await ExecutionCore.open(path.join(root,'state'),{product:profile,libraryOptions:{pythonExecutable:process.execPath,pythonSha256:hash(await readFile(process.execPath)),...(testRunnerModule?{testRunnerModule}:{})}});
  const credential=core.enrollAdapter('desktop','owner');core.registerProject(credential,{projectId:'library',displayName:'Library',rootPath:library,kind:'library'});core.enrollLibraryRoute(credential,{projectId:'library',route:'gotzji-library'});
  const value={root,library,core,credential,profile,libraryTestRunner:testRunnerModule,bindings:[],lifecycle};fixtures.push(value);lifecycle.signal.throwIfAborted();return value;
}
async function submit(f:Fixture,input:ProductLibraryInput):Promise<TaskBinding>{f.lifecycle.signal.throwIfAborted();const p=f.core.prepareOperation(f.credential,input);const job=await f.core.submit(p.preparationId?f.credential:f.credential,p.preparationId);const binding=f.core.selectLibraryJob(f.credential,input.projectId,job.jobId);f.bindings.push(binding);f.lifecycle.signal.throwIfAborted();return binding;}
async function until(f:Fixture,predicate:()=>Promise<boolean>|boolean):Promise<void>{await f.lifecycle.run(async(signal)=>waitForFixture(signal,async()=>{try{await f.core.tick();}catch{/* blocker asserted by caller */}return await predicate()?true:undefined;}));}
function queryDatabase<T>(f:Fixture,read:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'),{timeout:5000});try{return read(db);}finally{db.close();}}
function codeInput(requestId:string,intent:string):ProductLibraryInput{return{requestId,projectId:'library',operation:'library.workflow',workflowId:'library.code-qa',workflowVersion:2,parameters:{intent,paths:JSON.stringify(['source.md']),expectedSha256:'0'.repeat(64),content:'Changed\n'}};}
function memoInput(requestId:string):ProductLibraryInput{return{requestId,projectId:'library',operation:'library.workflow',workflowId:'library.final-memo',workflowVersion:2,parameters:{ticker:'TEST',evidencePeriod:'2026-10'}};}
async function present(filename:string):Promise<boolean>{try{await access(filename);return true;}catch{return false;}}
async function cleanupSyntheticWorker(worker:WorkerRow):Promise<void>{
  if(await stopWorker(worker))return;
  const config=JSON.parse(await readFile(path.join(worker.directory,'config.json'),'utf8'));
  if(config.epoch!==worker.epoch||config.jobId!==worker.job_id||config.token!==worker.token)throw new Error('Fixture cleanup identity changed');
  const ready=signed<{pid:number;port:number}>(worker,'ready.json');if(!ready)throw new Error('Fixture cleanup ready record missing');
  const capability=issueSyntheticCleanupCapability(config,worker.directory,fileURLToPath(new URL('./fixture-worker.mjs',import.meta.url)));
  const response=await fetch(`http://127.0.0.1:${ready.port}/synthetic-test-cleanup?nonce=${capability}`,{method:'POST',headers:{Authorization:`Bearer ${worker.token}`},signal:AbortSignal.timeout(10000)});
  if(!response.ok){
    const body=await response.json().catch(()=>undefined) as {error?:{code?:unknown;stage?:unknown;reason?:unknown}}|undefined;
    const code=typeof body?.error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/u.test(body.error.code)?body.error.code:'UNKNOWN';
    const stage=['authorization','owned-children','identity-probes','descendant-proof'].includes(String(body?.error?.stage))?String(body!.error!.stage):'unknown';
    const reason=['context','runtime','temp-parent','fixture-path','driver','library-root','operation','capability','record','mac','binding-expiry','binding-capability','binding-job','binding-epoch','expiry-invalid','expiry-expired','expiry-future','consume'].includes(String(body?.error?.reason))?String(body!.error!.reason):'unknown';
    throw new Error(`Fixture cleanup refused: ${worker.directory} (HTTP ${response.status}; ${code}; ${stage}; ${reason})`);
  }
  const result=await response.json() as {nonce:string;pid:number;epoch:string};
  if(result.nonce!==capability||result.pid!==ready.pid||result.epoch!==worker.epoch)throw new Error('Fixture cleanup response changed');
  for(let attempt=0;attempt<100;attempt++){if(alive(ready.pid)===false)return;await new Promise((resolve)=>setTimeout(resolve,20));}
  throw new Error('Fixture cleanup termination unverified: '+worker.directory);
}
async function closeLibraryFixtures(lifetime:OwnedTestLifetime):Promise<void>{
  await finishOwnedTest(lifetime,()=>undefined,()=>[fixtures.splice(0)],async(batch)=>{
  const failures:Error[]=[];
  for(const f of batch){
    const fixtureFailures:unknown[]=[];
    try{await f.lifecycle.close();}catch(error){fixtureFailures.push(error);}
    let workers:WorkerRow[]=[];
    try{workers=queryDatabase(f,(db)=>db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[]);}catch(error){fixtureFailures.push(error);}
    for(const worker of workers){try{await cleanupSyntheticWorker(worker);}catch(error){fixtureFailures.push(error);}}
    try{f.core.close();}catch{/* already closed */}
    if(fixtureFailures.length===0){
      try{await rm(f.root,{recursive:true,force:true});}catch(error){failures.push(new Error('Fixture removal failed: '+f.root,{cause:error}));}
    }else{
      failures.push(new Error('Fixture evidence retained: '+f.root,{cause:new AggregateError(fixtureFailures,'Fixture cleanup failed')}));
    }
  }
  if(failures.length)throw new AggregateError(failures,failures.map((error)=>error.message).join('\n'));
  });
}
afterEach(async()=>{
  try{for(const diagnostic of libraryTestDiagnostics.splice(0)){try{libraryTestDiagnosticSnapshot(diagnostic);}catch{/* Always run the original cleanup. */}}}
  catch{/* Diagnostics must never prevent the original cleanup. */}
  await closeLibraryFixtures(testLifetime);
});

describe('P7 Library runtime',()=>{
  it('drains the actual Library fixture body before closing its core and removing its root',ownBody(async()=>{
    const lifetime=createOwnedTestLifetime();let release!:()=>void;let reached!:(root:string)=>void;let bodyDrained=false;let cleaned=false;let continued=false;
    const gate=new Promise<void>((resolve)=>{release=resolve;});const registered=new Promise<string>((resolve)=>{reached=resolve;});
    const body=lifetime.run(async()=>{try{const f=await fixture(false,undefined,false,undefined,{reached,wait:gate},lifetime);continued=true;expect(f.core.authority().authorityId).toBeTruthy();}finally{bodyDrained=true;}}).then(()=>undefined,(error:unknown)=>error);
    let cleanup:Promise<void>|undefined;
    try{
      const root=await Promise.race([registered,body.then(()=>{throw new Error('Library fixture barrier was not reached');})]);
      cleanup=closeLibraryFixtures(lifetime).then(()=>{cleaned=true;});
      await new Promise<void>((resolve)=>setImmediate(resolve));expect(cleaned).toBe(false);
      release();const outcome=await body;await cleanup;expect(outcome).toBe(lifetime.signal.reason);expect(continued).toBe(false);expect(bodyDrained).toBe(true);
      await expect(access(root)).rejects.toMatchObject({code:'ENOENT'});
      if(process.env.GOTZJI_LIBRARY_DIAGNOSTIC==='1')console.log('[library-fixture-drain]',JSON.stringify({root,bodyDrained,cleaned,continued}));
    }finally{
      release();await Promise.allSettled([body,...(cleanup?[cleanup]:[])]);await closeLibraryFixtures(lifetime);await lifetime.close();
    }
  }));

  it('drains an aborted fixture wait before closing its query handle',ownBody(async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'gotzji-library-lifecycle-'));const databasePath=path.join(root,'query.sqlite');const lifecycle=createTestFixtureLifecycle() as FixtureLifecycle;const db=new DatabaseSync(databasePath);let drained=false;let closed=false;
    try{
      const wait=lifecycle.run(async(signal:AbortSignal)=>new Promise<void>((resolve)=>{
        signal.addEventListener('abort',()=>setTimeout(()=>{db.prepare('SELECT 1').get();drained=true;resolve();},10),{once:true});
      }));
      lifecycle.own('fixture query handle',()=>{if(!drained)throw new Error('query handle closed before wait drained');db.close();closed=true;});
      const cleanup=lifecycle.close();const stalled=new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('fixture cleanup did not drain')),250));
      await expect(Promise.race([cleanup,stalled])).resolves.toBeUndefined();await expect(wait).resolves.toBeUndefined();expect(closed).toBe(true);
      await rm(root,{recursive:true,force:true});await expect(access(databasePath)).rejects.toMatchObject({code:'ENOENT'});
    }finally{if(!closed)db.close();await rm(root,{recursive:true,force:true});}
  }));

  it('refuses Library admission after its fixture parent has already closed',ownBody(async()=>{
    const parent=createOwnedTestLifetime();const f=await fixture(false,undefined,false,undefined,undefined,parent);await parent.close();
    const input:ProductLibraryInput={requestId:'aborted-before-submit',projectId:'library',operation:'library.workflow',workflowId:'library.read',workflowVersion:1,parameters:{paths:'["source.md"]'}};
    let outcome:unknown;try{await submit(f,input);}catch(error){outcome=error;}
    const claims=queryDatabase(f,(db)=>Number(db.prepare('SELECT COUNT(*) AS count FROM gotzji_claims').get()!.count));const workers=queryDatabase(f,(db)=>Number(db.prepare('SELECT COUNT(*) AS count FROM gotzji_workers').get()!.count));
    if(process.env.GOTZJI_LIBRARY_DIAGNOSTIC==='1')console.log('[library-submit-abort]',JSON.stringify({stage:'before-admission',root:f.root,claims,workers,bindings:f.bindings.length}));
    expect(outcome).toBe(parent.signal.reason);expect(claims).toBe(0);expect(workers).toBe(0);expect(f.bindings).toHaveLength(0);
  }));

  it('retains the admitted binding and stops caller continuation when its fixture parent closes during submission',ownBody(async()=>{
    const parent=createOwnedTestLifetime();const f=await fixture(false,undefined,false,undefined,undefined,parent);
    const input:ProductLibraryInput={requestId:'aborted-during-submit',projectId:'library',operation:'library.workflow',workflowId:'library.read',workflowVersion:1,parameters:{paths:'["source.md"]'}};
    const canonicalSubmit=f.core.submit;f.core.submit=async(...args:Parameters<ExecutionCore['submit']>):ReturnType<ExecutionCore['submit']>=>{const job=await canonicalSubmit.apply(f.core,args);await parent.close();return job;};
    let outcome:unknown;let continued=false;
    try{await submit(f,input);continued=true;}catch(error){outcome=error;}finally{f.core.submit=canonicalSubmit;}
    const claims=queryDatabase(f,(db)=>Number(db.prepare('SELECT COUNT(*) AS count FROM gotzji_claims').get()!.count));const workers=queryDatabase(f,(db)=>Number(db.prepare('SELECT COUNT(*) AS count FROM gotzji_workers').get()!.count));
    if(process.env.GOTZJI_LIBRARY_DIAGNOSTIC==='1')console.log('[library-submit-abort]',JSON.stringify({stage:'after-admission',root:f.root,claims,workers,bindings:f.bindings.length,continued}));
    expect(outcome).toBe(parent.signal.reason);expect(continued).toBe(false);expect(claims).toBe(1);expect(workers).toBe(0);expect(f.bindings).toHaveLength(1);
  }));

  it('retains synchronous wait and resource failures without an unhandled rejection',ownBody(async()=>{
    const lifecycle=createTestFixtureLifecycle() as FixtureLifecycle;const waitFailure=new Error('synchronous wait failure');const closeFailure=new Error('query close failure');const unhandled:unknown[]=[];
    const onUnhandled=(reason:unknown):void=>{unhandled.push(reason);};process.on('unhandledRejection',onUnhandled);
    try{
      expect(()=>lifecycle.run(()=>{throw waitFailure;})).not.toThrow();
      lifecycle.own('fixture query handle',()=>{throw closeFailure;});
      await new Promise((resolve)=>setTimeout(resolve,0));expect(unhandled).toEqual([]);
      let cleanupError:unknown;try{await lifecycle.close();}catch(error){cleanupError=error;}
      expect(cleanupError).toBeInstanceOf(AggregateError);
      expect((cleanupError as AggregateError).errors.map((error)=>error.cause)).toEqual([waitFailure,closeFailure]);
    }finally{process.off('unhandledRejection',onUnhandled);}
  }));

  it('reports typed dependency gaps and refuses direct PDF evidence without the canonical provider',ownBody(async()=>{
    const missing=await fixture();await rm(path.join(missing.library,'team-outputs/cards/TEST/Company Overview.md'));
    expect(()=>missing.core.prepareOperation(missing.credential,memoInput('memo-missing-card'))).toThrow('LIBRARY_MEMO_DEPENDENCY_GAP');
    const pdf=await fixture();await writeFile(path.join(pdf.library,'evidence.pdf'),'not a real PDF');const base=memoInput('memo-pdf');const input={...base,parameters:{...base.parameters,paths:JSON.stringify(['evidence.pdf'])}};
    expect(()=>pdf.core.prepareOperation(pdf.credential,input)).toThrow('LIBRARY_PDF_PROVIDER_REQUIRED');
  }));

  it('binds the pipeline lock lease dependency and refuses stale replay after its bytes change',ownBody(async()=>{
    expect(libraryWorkflow('library.final-memo',2).sources).toContainEqual({id:'process-lease',relativePath:'scripts/lib/process_lease.py'});
    const f=await fixture(true);const preparation=f.core.prepareOperation(f.credential,memoInput('memo-lease-drift'));
    await writeFile(path.join(f.library,'scripts/lib/process_lease.py'),'changed valid Python dependency\n');
    const job=await f.core.submit(f.credential,preparation.preparationId);const binding=f.core.selectLibraryJob(f.credential,'library',job.jobId);f.bindings.push(binding);await f.core.resume(f.credential,binding);
    await until(f,()=>queryDatabase(f,(db)=>!!db.prepare('SELECT 1 FROM gotzji_diagnostics WHERE job_id=?').get(binding.jobId)));
    expect(queryDatabase(f,(db)=>(db.prepare('SELECT code FROM gotzji_diagnostics WHERE job_id=?').get(binding.jobId) as {code:string}).code)).toMatch(/(?:LIBRARY_SOURCE_CHANGED|PROJECT_POLICY_CHANGED|DEPENDENCIES_CHANGED|BROKER_DENIED|EFFECT_RECONCILIATION_REQUIRED)/u);
    await expect(f.core.resume(f.credential,binding)).rejects.toThrow();expect(await present(path.join(f.library,'team-outputs/memos/TEST_memo_2026-10.md'))).toBe(false);
  }),30000);

  it('runs the canonical final memo chain in order and delivers only after explicit user authority',ownBody(async()=>{
    const f=await fixture(true);const binding=await submit(f,memoInput('memo-success'));await f.core.resume(f.credential,binding);
    try{await until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:verify' AND phase='verified'").get(binding.jobId)));}
    catch{throw new Error(`memo did not reach verify: ${JSON.stringify(await f.core.get(f.credential,binding))}`);}
    expect((await f.core.get(f.credential,binding)).status).not.toBe('completed');
    const rows=queryDatabase(f,(db)=>db.prepare('SELECT operation_id,phase FROM gotzji_recipe_operations WHERE job_id=? ORDER BY rowid').all(binding.jobId) as {operation_id:string;phase:string}[]);
    expect(rows.map((row)=>row.operation_id).filter((id)=>id.startsWith('library-step:'))).toEqual(['library-step:preflight','library-step:mammos','library-step:facty','library-step:persist','library-step:pipeline','library-step:indie','library-step:atoms','library-step:index','library-step:verify']);
    f.core.authorizeLibraryDelivery(f.credential,binding,'user-delivery');await until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:deliver' AND phase='verified'").get(binding.jobId)));
    await until(f,async()=> (await f.core.get(f.credential,binding)).status==='completed');
    const memo=await readFile(path.join(f.library,'team-outputs/memos/TEST_memo_2026-10.md'),'utf8');expect(memo).toContain('## 🛡 Facty Audit');expect(memo).toContain('VERDICT: PASS');
    const atoms=(await readdir(path.join(f.library,'knowledge-base/atoms'))).filter((name)=>name.startsWith('ATOM-'));expect(atoms).toHaveLength(1);expect(await readFile(path.join(f.library,'knowledge-base/atoms',atoms[0]),'utf8')).toContain('TEST_memo_2026-10.md');
    f.core.close();f.core=await ExecutionCore.open(path.join(f.root,'state'),{product:f.profile,libraryOptions:{pythonExecutable:process.execPath,pythonSha256:hash(await readFile(process.execPath)),...(f.libraryTestRunner?{testRunnerModule:f.libraryTestRunner}:{})}});
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'completed'});expect((await f.core.readOperationResult(f.credential,binding)).output).toMatchObject({workflowId:'library.final-memo',workflowVersion:2,state:'completed'});
  }),60000);

  it('treats Facty BLOCK as terminal before canonical writes or user delivery',ownBody(async()=>{
    const f=await fixture(true);const binding=await submit(f,memoInput('memo-block'));await f.core.resume(f.credential,binding);await until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:facty' AND phase='verified'").get(binding.jobId)));
    expect(await present(path.join(f.library,'team-outputs/memos/TEST_memo_2026-10.md'))).toBe(false);expect((await readdir(path.join(f.library,'knowledge-base/atoms'))).filter((name)=>name.startsWith('ATOM-'))).toHaveLength(0);
    expect(queryDatabase(f,(db)=>db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:persist'").get(binding.jobId))).toBeUndefined();
  }),60000);

  it('fails closed on changed frozen evidence and on missing canonical index writeback',ownBody(async()=>{
    const stale=await fixture(true);const input=memoInput('memo-stale');const preparation=stale.core.prepareOperation(stale.credential,input);await writeFile(path.join(stale.library,'team-outputs/filings/TEST_10-Q_2026.md'),'changed after prepare\n');
    const job=await stale.core.submit(stale.credential,preparation.preparationId);const binding=stale.core.selectLibraryJob(stale.credential,'library',job.jobId);await stale.core.resume(stale.credential,binding);await until(stale,()=>queryDatabase(stale,(db)=>!!db.prepare('SELECT 1 FROM gotzji_diagnostics WHERE job_id=?').get(binding.jobId)));expect(queryDatabase(stale,(db)=>(db.prepare('SELECT code FROM gotzji_diagnostics WHERE job_id=?').get(binding.jobId) as {code:string}).code)).toMatch(/(?:BROKER_DENIED|LIBRARY_SOURCE_CHANGED|PROJECT_POLICY_CHANGED|DEPENDENCIES_CHANGED|EFFECT_RECONCILIATION_REQUIRED)/u);
    expect(await present(path.join(stale.library,'team-outputs/memos/TEST_memo_2026-10.md'))).toBe(false);
    const missing=await fixture(true,'omit-index');const missingBinding=await submit(missing,memoInput('memo-no-index'));await missing.core.resume(missing.credential,missingBinding);await until(missing,()=>queryDatabase(missing,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:verify' AND phase='failed'").get(missingBinding.jobId)));
    expect(await present(path.join(missing.library,'team-outputs/memos/TEST_memo_2026-10.md'))).toBe(true);
  }),90000);

  it('retains uncertain ownership after a lost atom-gateway response and never allocates a duplicate',ownBody(async()=>{
    const f=await fixture(true,'atom-after-write');const binding=await submit(f,memoInput('memo-lost-atom'));await f.core.resume(f.credential,binding);await until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:atoms' AND phase='uncertain'").get(binding.jobId)));
    const before=(await readdir(path.join(f.library,'knowledge-base/atoms'))).filter((name)=>name.startsWith('ATOM-'));expect(before).toEqual(['ATOM-9000-pending.md']);
    expect(queryDatabase(f,(db)=>db.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=?').get(binding.jobId))).toBeDefined();
    await expect(f.core.resume(f.credential,binding)).rejects.toThrow();const after=(await readdir(path.join(f.library,'knowledge-base/atoms'))).filter((name)=>name.startsWith('ATOM-'));expect(after).toEqual(before);
    const worker=queryDatabase(f,(db)=>db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow);
    const ready=signed<{pid:number;port:number}>(worker,'ready.json')!;const denied=await fetch(`http://127.0.0.1:${ready.port}/synthetic-test-cleanup?nonce=${'0'.repeat(64)}`,{method:'POST',headers:{Authorization:'Bearer wrong'},signal:AbortSignal.timeout(3000)});expect(denied.status).toBe(403);
    const forged=await fetch(`http://127.0.0.1:${ready.port}/synthetic-test-cleanup?nonce=${'1'.repeat(64)}`,{method:'POST',headers:{Authorization:`Bearer ${worker.token}`},signal:AbortSignal.timeout(3000)});expect(forged.status).toBe(403);expect(await forged.json()).toEqual({error:{code:'TEST_CLEANUP_DENIED',stage:'authorization',reason:'record'}});expect(alive(ready.pid)).toBe(true);
    const writerBefore=queryDatabase(f,(db)=>db.prepare('SELECT * FROM gotzji_writers WHERE job_id=?').get(binding.jobId));const jobBefore=queryDatabase(f,(db)=>db.prepare('SELECT status,lease_generation,lease_token_hash,lease_owner_session_id FROM goals').all());const claimsBefore=queryDatabase(f,(db)=>db.prepare('SELECT * FROM gotzji_resource_claims WHERE job_id=?').all(binding.jobId));const uncertainBefore=queryDatabase(f,(db)=>db.prepare("SELECT * FROM gotzji_recipe_operations WHERE job_id=? AND phase='uncertain'").all(binding.jobId));
    await cleanupSyntheticWorker(worker);expect(alive(ready.pid)).toBe(false);expect(await present(path.join(worker.directory,'stopped.json'))).toBe(false);
    expect(queryDatabase(f,(db)=>db.prepare('SELECT * FROM gotzji_writers WHERE job_id=?').get(binding.jobId))).toEqual(writerBefore);expect(queryDatabase(f,(db)=>db.prepare('SELECT status,lease_generation,lease_token_hash,lease_owner_session_id FROM goals').all())).toEqual(jobBefore);expect(queryDatabase(f,(db)=>db.prepare('SELECT * FROM gotzji_resource_claims WHERE job_id=?').all(binding.jobId))).toEqual(claimsBefore);expect(queryDatabase(f,(db)=>db.prepare("SELECT * FROM gotzji_recipe_operations WHERE job_id=? AND phase='uncertain'").all(binding.jobId))).toEqual(uncertainBefore);
  }),60000);

  it('reports the cleanup refusal stage while preserving a separately owned live descendant',ownBody(async()=>{
    const f=await fixture(true,'atom-after-write');const binding=await submit(f,memoInput('cleanup-refusal-stage'));await f.core.resume(f.credential,binding);
    await until(f,()=>queryDatabase(f,db=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:atoms' AND phase='uncertain'").get(binding.jobId)));
    const worker=queryDatabase(f,db=>db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow);
    const ready=signed<{pid:number;port:number}>(worker,'ready.json')!;
    const child=spawn(process.execPath,['-e',"process.on('message',()=>process.exit(0));process.on('disconnect',()=>process.exit(0));process.send('ready');setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    try{
      await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('message',()=>resolve());});
      const registration=await fetch(`http://127.0.0.1:${ready.port}/register-broker`,{method:'POST',headers:{Authorization:`Bearer ${worker.token}`},body:JSON.stringify({pid:child.pid}),signal:AbortSignal.timeout(3000)});
      expect(registration.ok).toBe(true);await registration.text();
      await until(f,()=>!!signed<{identities:Record<number,unknown>}>(worker,'observation.json')?.identities[child.pid!]);
      await expect(cleanupSyntheticWorker(worker)).rejects.toThrow(/HTTP 409; TEST_CHILD_STOP_UNVERIFIED; descendant-proof/u);
      expect(alive(child.pid!)).toBe(true);expect(alive(ready.pid)).toBe(true);expect(await present(path.join(worker.directory,'stopped.json'))).toBe(false);
    }finally{
      if(child.connected)child.send('close');else if(child.exitCode===null&&child.signalCode===null)child.kill();
      await closed;if(child.pid)expect(alive(child.pid)).toBe(false);
    }
    await cleanupSyntheticWorker(worker);expect(alive(ready.pid)).toBe(false);
    expect(queryDatabase(f,db=>db.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=?').get(binding.jobId))).toBeDefined();
  }),60000);

  it('rejects an unexpected navigation mutation after the signed index receipt',ownBody(async()=>{
    const f=await fixture(true);const binding=await submit(f,memoInput('memo-nav-drift'));await f.core.resume(f.credential,binding);
    {
      await until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:verify' AND phase='verified'").get(binding.jobId)));
      await writeFile(path.join(f.library,'indexes/tickers/TEST.md'),'unexpected external mutation\n');
      f.core.authorizeLibraryDelivery(f.credential,binding,'user-delivery');await until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_diagnostics WHERE job_id=? AND code='LIBRARY_NAVIGATION_CHANGED'").get(binding.jobId)));
      // The drift is caught before delivery, a recorded no-effect failure: the worker must record it and stay alive for an owned stop, not crash.
      const worker=queryDatabase(f,(db)=>db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow);await until(f,()=>signed<{state:string}>(worker,'library-progress.json')?.state==='failed');
      expect(signed<{code?:string}>(worker,'library-progress.json')?.code).toBe('LIBRARY_NAVIGATION_CHANGED');expect(alive(signed<{pid:number}>(worker,'ready.json')!.pid)).toBe(true);expect(await stopWorker(worker)).toBe(true);
      expect(queryDatabase(f,(db)=>db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:deliver'").get(binding.jobId))).toBeUndefined();
    }
  }),60000);

  it.each([false,true])('runs frozen Library read with observed receipts (direct=%s)',ownBody(async(direct:boolean)=>{
    const f=await fixture(false,undefined,direct);const binding=await submit(f,{requestId:'read-one',projectId:'library',operation:'library.workflow',workflowId:'library.read',workflowVersion:1,parameters:{paths:JSON.stringify(['source.md'])}});
    await f.core.resume(f.credential,binding);await until(f,async()=> (await f.core.get(f.credential,binding)).status==='completed');
    const result=await f.core.readOperationResult(f.credential,binding);expect(result.output).toMatchObject({state:'completed',workflowId:'library.read',route:'gotzji-library'});
    expect((result.output as {steps:unknown[]}).steps).toHaveLength(1);
    if (!direct) {
      const authority = f.core.authority(); f.core.close(); await rm(path.join(f.library, 'source.md'));
      f.profile = { mode: 'host-direct', libraryRoot: f.library };
      f.core = await ExecutionCore.open(path.join(f.root, 'state'), { product: f.profile, upgrade: { expectedPolicy: authority.policy, expectedAuthorityId: authority.authorityId } });
      const input: ProductLibraryInput = { requestId: 'read-one', projectId: 'library', operation: 'library.workflow', workflowId: 'library.read', workflowVersion: 1, parameters: { paths: JSON.stringify(['source.md']) } };
      const replay = f.core.prepareOperation(f.credential, input); expect((await f.core.submit(f.credential, replay.preparationId)).jobId).toBe(binding.jobId);
      expect(await f.core.readOperationResult(f.credential, f.core.select(f.credential, binding.jobId))).toEqual(result);
      expect(() => f.core.prepareOperation(f.credential, { ...input, parameters: { paths: '["conflicting.md"]' } })).toThrow('REQUEST_DIGEST_CONFLICT');
    }
  }),20000);

  it('runs direct built-in code apply, real QA and explicitly granted delivery to an owned local bare repository', ownBody(async () => {
    const f = await fixture(false, undefined, true);
    const hooks = path.join(f.root, 'empty-hooks'); const remote = path.join(f.root, 'owned-bare-remote'); await mkdir(hooks);
    const git = (args: string[], cwd = f.library): string => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
    git(['-c', `init.templateDir=${hooks}`, 'init', '--bare', remote]); git(['-c', `init.templateDir=${hooks}`, 'init', '-b', 'main']);
    git(['config', 'user.name', 'Synthetic fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.hooksPath', hooks]); git(['config', 'core.autocrlf', 'false']);
    git(['add', '--', 'source.md']); git(['commit', '--only', '-m', 'Owned fixture initial state', '--', 'source.md']); git(['remote', 'add', 'origin', remote]); git(['push', '-u', 'origin', 'main']);
    for (const file of ['audit_orphan_md.py', 'validate.py']) await writeFile(path.join(f.library, 'scripts', file), "const fs=require('node:fs');if(fs.readFileSync('source.md','utf8')!=='Changed\\n')process.exit(9);process.stdout.write('observed changed source\\n');\n");
    const input = codeInput('direct-real-code-qa', 'owner supplied exact edit'); input.parameters.expectedSha256 = hash(await readFile(path.join(f.library, 'source.md')));
    const binding = await submit(f, input); await f.core.resume(f.credential, binding);
    await until(f, async () => {
      if (queryDatabase(f, db => !!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:validate' AND phase='verified'").get(binding.jobId))) return true;
      const status = await f.core.get(f.credential, binding);
      if (status.status === 'blocked' || status.status === 'failed') throw new Error(JSON.stringify({ status, apply: queryDatabase(f, db => db.prepare("SELECT phase FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:apply'").get(binding.jobId)), content: await readFile(path.join(f.library, 'source.md'), 'utf8') }));
      return false;
    });
    expect(await readFile(path.join(f.library, 'source.md'), 'utf8')).toBe('Changed\n');
    const worker = queryDatabase(f, db => db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow);
    expect(signed(worker, 'controller-runtime.json')).toMatchObject({ executor: 'host-direct' });
    expect(await present(path.join(worker.directory, 'claude-events.jsonl'))).toBe(false);
    expect(queryDatabase(f, db => db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:commit' AND phase='verified'").get(binding.jobId))).toBeUndefined();
    const proofDatabase = path.join(f.root, 'owned-proof-copy.sqlite'); const sourceDatabase = new DatabaseSync(path.join(f.root, 'state', 'core.sqlite'), { readOnly: true });
    try { await backup(sourceDatabase, proofDatabase); } finally { sourceDatabase.close(); }
    const config = JSON.parse(await readFile(path.join(worker.directory, 'config.json'), 'utf8'));
    const proofEffects = path.join(f.root, 'owned-proof-effects'); await cp(config.effectRoot, proofEffects, { recursive: true });
    f.core.authorizeLibraryDelivery(f.credential, binding, 'commit');
    await until(f, () => queryDatabase(f, db => !!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:commit' AND phase='verified'").get(binding.jobId)));
    expect(git(['--git-dir', remote, 'show', 'refs/heads/main:source.md'])).toBe('Original source\n');
    f.core.authorizeLibraryDelivery(f.credential, binding, 'push'); await until(f, async () => (await f.core.get(f.credential, binding)).status === 'completed');
    expect(git(['--git-dir', remote, 'show', 'refs/heads/main:source.md'])).toBe('Changed\n');
    expect((await f.core.readOperationResult(f.credential, binding)).output).toMatchObject({ state: 'completed', workflowId: 'library.code-qa' });
    expect(await stopWorker(worker)).toBe(true);
    const proofConfig = { ...config, database: proofDatabase, effectRoot: proofEffects };
    const proof = new DatabaseSync(proofDatabase); const file = path.join(proofEffects, 'library-step-apply.json'); const artifact = readFileSync(file, 'utf8');
    const row = proof.prepare("SELECT * FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:apply'").get(binding.jobId)!;
    const reset = (): void => { proof.prepare("INSERT OR REPLACE INTO gotzji_recipe_operations VALUES (?,?,?,?,?)").run(row.job_id, row.operation_id, row.digest, row.phase, row.receipt); writeFileSync(file, artifact); writeFileSync(path.join(f.library, 'source.md'), 'Changed\n'); };
    const signedArtifact = (change: Record<string, unknown>, valueChange?: Record<string, unknown>): void => {
      const body = JSON.parse(JSON.parse(artifact).body); Object.assign(body, change);
      if (valueChange) { Object.assign(body.value, valueChange); body.valueDigest = hash(JSON.stringify(body.value)); const wrapper = JSON.parse(String(row.receipt)); wrapper.receipt.outputDigest = body.valueDigest; proof.prepare("UPDATE gotzji_recipe_operations SET receipt=? WHERE job_id=? AND operation_id='library-step:apply'").run(JSON.stringify(wrapper), binding.jobId); }
      const text = JSON.stringify(body); writeFileSync(file, JSON.stringify({ body: text, mac: createHmac('sha256', worker.token).update(text).digest('hex') }));
    };
    try {
      expect(assertPreparedLibraryDependencies(proofConfig)).toBe(true);
      const countercases: (() => void)[] = [
        (): void => proof.prepare("DELETE FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:apply'").run(binding.jobId),
        (): void => proof.prepare("UPDATE gotzji_recipe_operations SET phase='started' WHERE job_id=? AND operation_id='library-step:apply'").run(binding.jobId),
        (): void => proof.prepare("UPDATE gotzji_recipe_operations SET digest=? WHERE job_id=? AND operation_id='library-step:apply'").run('f'.repeat(64), binding.jobId),
        (): void => unlinkSync(file), (): void => writeFileSync(file, JSON.stringify({ body: JSON.parse(artifact).body, mac: '0'.repeat(64) })),
        (): void => signedArtifact({ epoch: 'foreign-epoch' }), (): void => signedArtifact({ operation: 'library.source.read' }),
        (): void => signedArtifact({}, { path: 'unapproved.md' }), (): void => signedArtifact({}, { afterSha256: '0'.repeat(64) }),
        (): void => writeFileSync(path.join(f.library, 'source.md'), 'Original source\n'), (): void => writeFileSync(path.join(f.library, 'source.md'), 'third independent bytes\n'),
      ];
      for (const countercase of countercases) {
        reset(); countercase(); expect(() => assertPreparedLibraryDependencies(proofConfig)).toThrow('LIBRARY_EFFECT_RECONCILIATION_REQUIRED');
        expect(Number(proof.prepare('SELECT COUNT(*) AS count FROM gotzji_writers WHERE job_id=?').get(binding.jobId)?.count)).toBe(1);
      }
      reset(); const unknownPolicy = path.join(f.root, 'owned-policy-drift'); writeFileSync(unknownPolicy, 'changed');
      expect(() => assertPreparedLibraryDependencies({ ...proofConfig, grace: { ...proofConfig.grace, documents: { ...proofConfig.grace.documents, addedPolicy: { path: unknownPolicy, hash: '0'.repeat(64) } } } })).toThrow('LIBRARY_EFFECT_RECONCILIATION_REQUIRED');
      const protectedInput = { ...input, requestId: 'policy-overlap', parameters: { ...input.parameters, paths: '["CLAUDE.md"]', expectedSha256: hash(await readFile(path.join(f.library, 'CLAUDE.md'))) } };
      expect(() => f.core.prepareOperation(f.credential, protectedInput)).toThrow('LIBRARY_SOURCE_POLICY_OVERLAP');
    } finally { reset(); proof.close(); }
  }), 30000);

  it('waits at each delivery boundary and resumes only after explicit enrolled-route authority',ownBody(async()=>{
    const f=await fixture(true);const input=codeInput('delivery-wait','normal');input.parameters.expectedSha256=hash(await readFile(path.join(f.library,'source.md')));
    const binding=await submit(f,input);await f.core.resume(f.credential,binding);
    await until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:validate' AND phase='verified'").get(binding.jobId)));
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'running'});
    f.core.authorizeLibraryDelivery(f.credential,binding,'commit');
    await until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:commit' AND phase='verified'").get(binding.jobId)));
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'running'});
    f.core.authorizeLibraryDelivery(f.credential,binding,'push');
    await until(f,async()=> (await f.core.get(f.credential,binding)).status==='completed');
    expect((await f.core.readOperationResult(f.credential,binding)).output).toMatchObject({state:'completed',workflowId:'library.code-qa'});
  }),25000);

  it('takes its next delivery step after a status call went unanswered between steps: the worker was busy, not lost',ownBody(async()=>{
    const f=await fixture(true);const input=codeInput('delivery-busy','normal');input.parameters.expectedSha256=hash(await readFile(path.join(f.library,'source.md')));
    const binding=await submit(f,input);await f.core.resume(f.credential,binding);
    await until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:validate' AND phase='verified'").get(binding.jobId)));
    const worker=queryDatabase(f,(db)=>db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow);
    const ready=path.join(worker.directory,'ready.json');const proof=await readFile(ready);
    // Restore the status channel even if a tick throws, so teardown can still stop this worker.
    await writeFile(ready,'{}');try{for(let n=0;n<3;n++)await f.core.tick();}finally{await writeFile(ready,proof);}
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'running'});
    f.core.authorizeLibraryDelivery(f.credential,binding,'commit');f.core.authorizeLibraryDelivery(f.credential,binding,'push');
    await until(f,async()=> (await f.core.get(f.credential,binding)).status==='completed');
  }),25000);

  it('allows the same owned job to be selected through an explicitly enrolled legacy Library route',ownBody(async()=>{
    const f=await fixture();const binding=await submit(f,{requestId:'cross-route',projectId:'library',operation:'library.workflow',workflowId:'library.read',workflowVersion:1,parameters:{paths:JSON.stringify(['source.md'])}});
    const legacy=f.core.enrollAdapter('legacy','owner');f.core.enrollLibraryRoute(legacy,{projectId:'library',route:'lnwjud-library'});
    const legacyBinding=f.core.selectLibraryJob(legacy,'library',binding.jobId);expect(legacyBinding.jobId).toBe(binding.jobId);
    const foreign=f.core.enrollAdapter('foreign','stranger');expect(()=>f.core.selectLibraryJob(foreign,'library',binding.jobId)).toThrow('LIBRARY_ROUTE_AUTHORITY_DENIED');
  }));

  it('rejects forged binding, wrong owner, expired lease and changed policy before another effect',ownBody(async()=>{
    const f=await fixture(true);const input=codeInput('authority','normal');input.parameters.expectedSha256=hash(await readFile(path.join(f.library,'source.md')));const binding=await submit(f,input);await f.core.resume(f.credential,binding);
    await until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:validate' AND phase='verified'").get(binding.jobId)));
    const worker=queryDatabase(f,(db)=>db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow);const config=JSON.parse(await readFile(path.join(worker.directory,'config.json'),'utf8'));
    await expect(executePreparedLibraryOperation({...config,libraryAuthorization:{...config.libraryAuthorization,mac:'0'.repeat(64)}},new AbortController().signal,{verifyLiveAuthority:()=>true})).rejects.toThrow('LIBRARY_BINDING_INVALID');
    await expect(executePreparedLibraryOperation({...config,owner:'stranger'},new AbortController().signal,{verifyLiveAuthority:()=>true})).rejects.toThrow('LIBRARY_BINDING_INVALID');
    queryDatabase(f,(db)=>db.prepare("UPDATE goals SET lease_expires_at='2000-01-01T00:00:00.000Z'").run());expect(()=>productBrokerCall(config,'operation_status',{},true,{status:()=>({})})).toThrow('LIVE_AUTHORITY_DENIED');
    queryDatabase(f,(db)=>db.prepare('UPDATE goals SET lease_expires_at=?').run(new Date(Date.now()+300000).toISOString()));await writeFile(path.join(f.library,'CLAUDE.md'),'changed\n');expect(()=>productBrokerCall(config,'operation_status',{},true,{status:()=>({})})).toThrow('PROJECT_POLICY_CHANGED');
  }),20000);

  it('retains the writer and marks uncertainty after a lost response',ownBody(async()=>{
    const diagnostic=libraryTestDiagnostic('response-loss');const f=await libraryTestDiagnosticPhase(diagnostic,'fixture',()=>fixture(true,undefined,false,diagnostic));const input=codeInput('response-loss','response-loss');input.parameters.expectedSha256=hash(await readFile(path.join(f.library,'source.md')));
    const lost=await libraryTestDiagnosticPhase(diagnostic,'submit',()=>submit(f,input));await libraryTestDiagnosticPhase(diagnostic,'resume',()=>f.core.resume(f.credential,lost));
    await libraryTestDiagnosticPhase(diagnostic,'until',()=>until(f,async()=> (await f.core.get(f.credential,lost)).status==='blocked'));
    expect(queryDatabase(f,(db)=>db.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=?').get(lost.jobId))).toBeDefined();expect(await readFile(path.join(f.library,'lost-effect.txt'),'utf8')).toBe('once');
  }),30000);

  it('cancels before delivery without retaining the writer',ownBody(async()=>{
    const diagnostic=libraryTestDiagnostic('cancel-wait');const f=await libraryTestDiagnosticPhase(diagnostic,'fixture',()=>fixture(true,undefined,false,diagnostic));const input=codeInput('cancel-wait','normal');input.parameters.expectedSha256=hash(await readFile(path.join(f.library,'source.md')));
    const waiting=await libraryTestDiagnosticPhase(diagnostic,'submit',()=>submit(f,input));await libraryTestDiagnosticPhase(diagnostic,'resume',()=>f.core.resume(f.credential,waiting));
    await libraryTestDiagnosticPhase(diagnostic,'until',()=>until(f,()=>queryDatabase(f,(db)=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:validate' AND phase='verified'").get(waiting.jobId))));
    expect(await libraryTestDiagnosticPhase(diagnostic,'cancel',()=>f.core.cancel(f.credential,waiting))).toMatchObject({status:'cancelled'});expect(queryDatabase(f,(db)=>db.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=?').get(waiting.jobId))).toBeUndefined();
  }),30000);
});
