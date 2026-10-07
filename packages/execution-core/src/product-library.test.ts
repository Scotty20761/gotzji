import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { hash, type WorkerRow } from './store.js';
import { stopWorker } from './managed-worker.js';
import type { ProductGraceRegistration } from './grace-profile.js';
import type { TaskBinding } from './types.js';
import type { ProductLibraryInput } from './product-library.js';
const { productBrokerCall } = await import('./product-broker.mjs');
const { executePreparedLibraryOperation } = await import('./product-library-broker.mjs');

interface Fixture { root:string; library:string; core:ExecutionCore; credential:string; profile:ProductGraceRegistration; libraryTestRunner?:string; bindings:TaskBinding[] }
const fixtures:Fixture[]=[];
const policies=['CLAUDE.md','AGENTS.md','references/agent-knowledge-workflow.md','KNOWLEDGE_INDEX.md'];
async function fixture(runner=false,finalFailure?:'pipeline'|'atom-after-write'|'omit-index'):Promise<Fixture>{
  const root=await mkdtemp(path.join(os.tmpdir(),'gotzji-library-'));const library=path.join(root,'library');
  await mkdir(path.join(library,'references'),{recursive:true});
  for(const filename of policies) await writeFile(path.join(library,filename),`Policy ${filename}\n`);
  await mkdir(path.join(library,'.claude','skills','karpathy-guidelines'),{recursive:true});
  await mkdir(path.join(library,'.claude','skills','debug-mantra'),{recursive:true});
  for(const directory of ['scripts/lib','.claude/agents','Team','indexes/tickers','team-outputs/cards/TEST','team-outputs/filings','team-outputs/earnings','team-outputs/memos','team-outputs/research-reports','knowledge-base/atoms']) await mkdir(path.join(library,directory),{recursive:true});
  for(const filename of ['.claude/skills/karpathy-guidelines/SKILL.md','.claude/skills/debug-mantra/SKILL.md','scripts/audit_orphan_md.py','scripts/validate.py']) await writeFile(path.join(library,filename),'fixture\n');
  for(const filename of ['references/source-priority.md','references/index-wiring-map.md','references/workflow-memo.md','Team/memo.md','Team/fact-check.md','.claude/agents/mammos.md','.claude/agents/facty.md','.claude/agents/indie.md','user-profile.md','scripts/lib/pipeline_parse.py','scripts/lib/control_lock.py','scripts/lib/source_siblings.py','scripts/lib/design_export.py','scripts/lib/asset_bump.py','scripts/lib/streaming_files.py']) await writeFile(path.join(library,filename),`Policy ${filename}\n`);
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
  const profile={executable:process.execPath,libraryRoot:library,testDriver:fileURLToPath(new URL('./grace-test-driver.mjs',import.meta.url))};
  let testRunnerModule:string|undefined;
  if(runner){
    testRunnerModule=path.join(root,'library-test-runner.mjs');
    await writeFile(testRunnerModule,`import {createHash} from 'node:crypto';import {writeFileSync} from 'node:fs';import path from 'node:path';const sha=x=>createHash('sha256').update(x).digest('hex');export async function executeLibraryStep({config,prepared,step},signal){if(signal.aborted)throw Object.assign(new Error('LIBRARY_CANCELLED'),{code:'LIBRARY_CANCELLED',outcome:'none'});const binding=prepared.library.spokePolicies?.[step.actor];const spoke=binding?{delegatedBy:'grace',...binding}:{};if(prepared.input.parameters.intent==='response-loss'&&step.id==='apply'){writeFileSync(path.join(prepared.project.rootPath,'lost-effect.txt'),'once',{flag:'wx'});throw Object.assign(new Error('LOST_RESPONSE'),{code:'LOST_RESPONSE',outcome:'unknown'});}if(prepared.library.ast.workflowId==='library.final-memo'){if(step.id==='mammos'){const content="---\\ntitle: TEST memo\\ndate: 2026-10-07\\ntype: memo\\ntickers: [TEST]\\nrelated:\\n  - '[[team-outputs/cards/TEST/Company Overview.md]]'\\n---\\n\\n# TEST Memo\\n\\n## 🔄 Handoff\\n\\n- **To:** Facty\\n- **Stage transition:** Memo to audit\\n- **INDEX consulted:** ticker\\n- **Sources used:** card filing earnings\\n- **Key inputs to use:** thesis\\n- **Open questions:** none\\n- **Pipeline action:** decision\\n- **Index action:** generated\\n";return{...spoke,content,invocationDigest:sha('mammos invocation'),artifactDigest:sha(content)};}if(step.id==='facty'){const content=prepared.input.requestId==='memo-block'?'VERDICT: BLOCK\\n\\nUnsupported claim.':'VERDICT: PASS\\n\\nFrozen evidence reconciles.';return{...spoke,content,verdict:prepared.input.requestId==='memo-block'?'BLOCK':'PASS',invocationDigest:sha('facty invocation'),artifactDigest:sha(content)};}if(step.id==='indie'){const content=JSON.stringify({atoms:[{topic:'Demand',thesis:'bull',confidence:'high',content:'อุปสงค์มีหลักฐานรองรับจาก memo ที่ผ่านการตรวจสอบแล้ว'}]});return{...spoke,content,atoms:JSON.parse(content).atoms,invocationDigest:sha('indie invocation'),artifactDigest:sha(content)};}return{kind:'library-test-use-built-in'};}return{stepId:step.id,value:'verified-'+step.id,...(step.actor==='mammos'||step.actor==='facty'?{invocationDigest:'a'.repeat(64),artifactDigest:'b'.repeat(64),...(step.actor==='facty'?{verdict:'PASS'}:{})}:{})};}`);
  }
  const core=await ExecutionCore.open(path.join(root,'state'),{product:profile,libraryOptions:{pythonExecutable:process.execPath,pythonSha256:hash(await readFile(process.execPath)),...(testRunnerModule?{testRunnerModule}:{})}});
  const credential=core.enrollAdapter('desktop','owner');core.registerProject(credential,{projectId:'library',displayName:'Library',rootPath:library,kind:'library'});core.enrollLibraryRoute(credential,{projectId:'library',route:'gotzji-library'});
  const value={root,library,core,credential,profile,libraryTestRunner:testRunnerModule,bindings:[]};fixtures.push(value);return value;
}
async function submit(f:Fixture,input:ProductLibraryInput):Promise<TaskBinding>{const p=f.core.prepareOperation(f.credential,input);const job=await f.core.submit(p.preparationId?f.credential:f.credential,p.preparationId);const binding=f.core.selectLibraryJob(f.credential,input.projectId,job.jobId);f.bindings.push(binding);return binding;}
async function until(f:Fixture,predicate:()=>Promise<boolean>|boolean):Promise<void>{for(let i=0;i<250;i++){try{await f.core.tick();}catch{/* blocker asserted by caller */}if(await predicate())return;await new Promise((resolve)=>setTimeout(resolve,25));}throw new Error('library state did not settle');}
function codeInput(requestId:string,intent:string):ProductLibraryInput{return{requestId,projectId:'library',operation:'library.workflow',workflowId:'library.code-qa',workflowVersion:2,parameters:{intent,paths:JSON.stringify(['source.md']),expectedSha256:'0'.repeat(64),content:'Changed\n'}};}
function memoInput(requestId:string):ProductLibraryInput{return{requestId,projectId:'library',operation:'library.workflow',workflowId:'library.final-memo',workflowVersion:2,parameters:{ticker:'TEST',evidencePeriod:'2026-10'}};}
async function present(filename:string):Promise<boolean>{try{await access(filename);return true;}catch{return false;}}
afterEach(async()=>{for(const f of fixtures.splice(0)){const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'));const workers=db.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[];db.close();for(const worker of workers)await stopWorker(worker);try{f.core.close();}catch{/* already closed */}await rm(f.root,{recursive:true,force:true});}});

describe('P7 Library runtime',()=>{
  it('reports typed dependency gaps and refuses direct PDF evidence without the canonical provider',async()=>{
    const missing=await fixture();await rm(path.join(missing.library,'team-outputs/cards/TEST/Company Overview.md'));
    expect(()=>missing.core.prepareOperation(missing.credential,memoInput('memo-missing-card'))).toThrow('LIBRARY_MEMO_DEPENDENCY_GAP');
    const pdf=await fixture();await writeFile(path.join(pdf.library,'evidence.pdf'),'not a real PDF');const base=memoInput('memo-pdf');const input={...base,parameters:{...base.parameters,paths:JSON.stringify(['evidence.pdf'])}};
    expect(()=>pdf.core.prepareOperation(pdf.credential,input)).toThrow('LIBRARY_PDF_PROVIDER_REQUIRED');
  });

  it('runs the canonical final memo chain in order and delivers only after explicit user authority',async()=>{
    const f=await fixture(true);const binding=await submit(f,memoInput('memo-success'));await f.core.resume(f.credential,binding);
    const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'));
    try{await until(f,()=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:verify' AND phase='verified'").get(binding.jobId));}
    catch{throw new Error(`memo did not reach verify: ${JSON.stringify(await f.core.get(f.credential,binding))}`);}
    expect((await f.core.get(f.credential,binding)).status).not.toBe('completed');
    const rows=db.prepare('SELECT operation_id,phase FROM gotzji_recipe_operations WHERE job_id=? ORDER BY rowid').all(binding.jobId) as {operation_id:string;phase:string}[];
    expect(rows.map((row)=>row.operation_id).filter((id)=>id.startsWith('library-step:'))).toEqual(['library-step:preflight','library-step:mammos','library-step:facty','library-step:persist','library-step:pipeline','library-step:indie','library-step:atoms','library-step:index','library-step:verify']);
    f.core.authorizeLibraryDelivery(f.credential,binding,'user-delivery');await until(f,()=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:deliver' AND phase='verified'").get(binding.jobId));
    await until(f,async()=> (await f.core.get(f.credential,binding)).status==='completed');
    const memo=await readFile(path.join(f.library,'team-outputs/memos/TEST_memo_2026-10.md'),'utf8');expect(memo).toContain('## 🛡 Facty Audit');expect(memo).toContain('VERDICT: PASS');
    const atoms=(await readdir(path.join(f.library,'knowledge-base/atoms'))).filter((name)=>name.startsWith('ATOM-'));expect(atoms).toHaveLength(1);expect(await readFile(path.join(f.library,'knowledge-base/atoms',atoms[0]),'utf8')).toContain('TEST_memo_2026-10.md');
    db.close();f.core.close();f.core=await ExecutionCore.open(path.join(f.root,'state'),{product:f.profile,libraryOptions:{pythonExecutable:process.execPath,pythonSha256:hash(await readFile(process.execPath)),...(f.libraryTestRunner?{testRunnerModule:f.libraryTestRunner}:{})}});
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'completed'});expect((await f.core.readOperationResult(f.credential,binding)).output).toMatchObject({workflowId:'library.final-memo',workflowVersion:2,state:'completed'});
  },60000);

  it('treats Facty BLOCK as terminal before canonical writes or user delivery',async()=>{
    const f=await fixture(true);const binding=await submit(f,memoInput('memo-block'));await f.core.resume(f.credential,binding);const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'));await until(f,()=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:facty' AND phase='verified'").get(binding.jobId));
    expect(await present(path.join(f.library,'team-outputs/memos/TEST_memo_2026-10.md'))).toBe(false);expect((await readdir(path.join(f.library,'knowledge-base/atoms'))).filter((name)=>name.startsWith('ATOM-'))).toHaveLength(0);
    expect(db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:persist'").get(binding.jobId)).toBeUndefined();db.close();
  },60000);

  it('fails closed on changed frozen evidence and on missing canonical index writeback',async()=>{
    const stale=await fixture(true);const input=memoInput('memo-stale');const preparation=stale.core.prepareOperation(stale.credential,input);await writeFile(path.join(stale.library,'team-outputs/filings/TEST_10-Q_2026.md'),'changed after prepare\n');
    const job=await stale.core.submit(stale.credential,preparation.preparationId);const binding=stale.core.selectLibraryJob(stale.credential,'library',job.jobId);await stale.core.resume(stale.credential,binding);const staleDb=new DatabaseSync(path.join(stale.root,'state','core.sqlite'));await until(stale,()=>!!staleDb.prepare('SELECT 1 FROM gotzji_diagnostics WHERE job_id=?').get(binding.jobId));expect((staleDb.prepare('SELECT code FROM gotzji_diagnostics WHERE job_id=?').get(binding.jobId) as {code:string}).code).toMatch(/(?:BROKER_DENIED|LIBRARY_SOURCE_CHANGED|PROJECT_POLICY_CHANGED|DEPENDENCIES_CHANGED|EFFECT_RECONCILIATION_REQUIRED)/u);staleDb.close();
    expect(await present(path.join(stale.library,'team-outputs/memos/TEST_memo_2026-10.md'))).toBe(false);
    const missing=await fixture(true,'omit-index');const missingBinding=await submit(missing,memoInput('memo-no-index'));await missing.core.resume(missing.credential,missingBinding);const missingDb=new DatabaseSync(path.join(missing.root,'state','core.sqlite'));await until(missing,()=>!!missingDb.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:verify' AND phase='failed'").get(missingBinding.jobId));missingDb.close();
    expect(await present(path.join(missing.library,'team-outputs/memos/TEST_memo_2026-10.md'))).toBe(true);
  },90000);

  it('retains uncertain ownership after a lost atom-gateway response and never allocates a duplicate',async()=>{
    const f=await fixture(true,'atom-after-write');const binding=await submit(f,memoInput('memo-lost-atom'));await f.core.resume(f.credential,binding);const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'));await until(f,()=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:atoms' AND phase='uncertain'").get(binding.jobId));
    const before=(await readdir(path.join(f.library,'knowledge-base/atoms'))).filter((name)=>name.startsWith('ATOM-'));expect(before).toEqual(['ATOM-9000-pending.md']);
    expect(db.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=?').get(binding.jobId)).toBeDefined();
    await expect(f.core.resume(f.credential,binding)).rejects.toThrow();const after=(await readdir(path.join(f.library,'knowledge-base/atoms'))).filter((name)=>name.startsWith('ATOM-'));expect(after).toEqual(before);db.close();
  },60000);

  it('rejects an unexpected navigation mutation after the signed index receipt',async()=>{
    const f=await fixture(true);const binding=await submit(f,memoInput('memo-nav-drift'));await f.core.resume(f.credential,binding);const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'));
    await until(f,()=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:verify' AND phase='verified'").get(binding.jobId));
    await writeFile(path.join(f.library,'indexes/tickers/TEST.md'),'unexpected external mutation\n');
    f.core.authorizeLibraryDelivery(f.credential,binding,'user-delivery');await until(f,()=>!!db.prepare("SELECT 1 FROM gotzji_diagnostics WHERE job_id=? AND code='LIBRARY_NAVIGATION_CHANGED'").get(binding.jobId));
    expect(db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:deliver'").get(binding.jobId)).toBeUndefined();db.close();
  },60000);

  it('runs a frozen read workflow end to end with real host receipts and no model-selected effect',async()=>{
    const f=await fixture();const binding=await submit(f,{requestId:'read-one',projectId:'library',operation:'library.workflow',workflowId:'library.read',workflowVersion:1,parameters:{paths:JSON.stringify(['source.md'])}});
    await f.core.resume(f.credential,binding);await until(f,async()=> (await f.core.get(f.credential,binding)).status==='completed');
    const result=await f.core.readOperationResult(f.credential,binding);expect(result.output).toMatchObject({state:'completed',workflowId:'library.read',route:'gotzji-library'});
    expect((result.output as {steps:unknown[]}).steps).toHaveLength(1);
  },20000);

  it('waits at each delivery boundary and resumes only after explicit enrolled-route authority',async()=>{
    const f=await fixture(true);const input=codeInput('delivery-wait','normal');input.parameters.expectedSha256=hash(await readFile(path.join(f.library,'source.md')));
    const binding=await submit(f,input);await f.core.resume(f.credential,binding);
    const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'));
    await until(f,()=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:validate' AND phase='verified'").get(binding.jobId));
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'running'});
    f.core.authorizeLibraryDelivery(f.credential,binding,'commit');
    await until(f,()=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:commit' AND phase='verified'").get(binding.jobId));
    expect(await f.core.get(f.credential,binding)).toMatchObject({status:'running'});
    f.core.authorizeLibraryDelivery(f.credential,binding,'push');
    await until(f,async()=> (await f.core.get(f.credential,binding)).status==='completed');
    expect((await f.core.readOperationResult(f.credential,binding)).output).toMatchObject({state:'completed',workflowId:'library.code-qa'});db.close();
  },25000);

  it('allows the same owned job to be selected through an explicitly enrolled legacy Library route',async()=>{
    const f=await fixture();const binding=await submit(f,{requestId:'cross-route',projectId:'library',operation:'library.workflow',workflowId:'library.read',workflowVersion:1,parameters:{paths:JSON.stringify(['source.md'])}});
    const legacy=f.core.enrollAdapter('legacy','owner');f.core.enrollLibraryRoute(legacy,{projectId:'library',route:'lnwjud-library'});
    const legacyBinding=f.core.selectLibraryJob(legacy,'library',binding.jobId);expect(legacyBinding.jobId).toBe(binding.jobId);
    const foreign=f.core.enrollAdapter('foreign','stranger');expect(()=>f.core.selectLibraryJob(foreign,'library',binding.jobId)).toThrow('LIBRARY_ROUTE_AUTHORITY_DENIED');
  });

  it('rejects forged binding, wrong owner, expired lease and changed policy before another effect',async()=>{
    const f=await fixture(true);const input=codeInput('authority','normal');input.parameters.expectedSha256=hash(await readFile(path.join(f.library,'source.md')));const binding=await submit(f,input);await f.core.resume(f.credential,binding);
    const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'));await until(f,()=>!!db.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:validate' AND phase='verified'").get(binding.jobId));
    const worker=db.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(binding.jobId) as unknown as WorkerRow;const config=JSON.parse(await readFile(path.join(worker.directory,'config.json'),'utf8'));
    await expect(executePreparedLibraryOperation({...config,libraryAuthorization:{...config.libraryAuthorization,mac:'0'.repeat(64)}},new AbortController().signal,{verifyLiveAuthority:()=>true})).rejects.toThrow('LIBRARY_BINDING_INVALID');
    await expect(executePreparedLibraryOperation({...config,owner:'stranger'},new AbortController().signal,{verifyLiveAuthority:()=>true})).rejects.toThrow('LIBRARY_BINDING_INVALID');
    db.prepare("UPDATE goals SET lease_expires_at='2000-01-01T00:00:00.000Z'").run();expect(()=>productBrokerCall(config,'operation_status',{},true,{status:()=>({})})).toThrow('LIVE_AUTHORITY_DENIED');
    db.prepare('UPDATE goals SET lease_expires_at=?').run(new Date(Date.now()+300000).toISOString());await writeFile(path.join(f.library,'CLAUDE.md'),'changed\n');expect(()=>productBrokerCall(config,'operation_status',{},true,{status:()=>({})})).toThrow('PROJECT_POLICY_CHANGED');db.close();
  },20000);

  it('retains the writer and marks uncertainty after a lost response, while cancellation before delivery is clean',async()=>{
    const f=await fixture(true);let input=codeInput('response-loss','response-loss');input.parameters.expectedSha256=hash(await readFile(path.join(f.library,'source.md')));const lost=await submit(f,input);await f.core.resume(f.credential,lost);
    await until(f,async()=> (await f.core.get(f.credential,lost)).status==='blocked');
    const db=new DatabaseSync(path.join(f.root,'state','core.sqlite'));expect(db.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=?').get(lost.jobId)).toBeDefined();expect(await readFile(path.join(f.library,'lost-effect.txt'),'utf8')).toBe('once');
    const secondRoot=await fixture(true);input=codeInput('cancel-wait','normal');input.parameters.expectedSha256=hash(await readFile(path.join(secondRoot.library,'source.md')));const waiting=await submit(secondRoot,input);await secondRoot.core.resume(secondRoot.credential,waiting);
    const secondDb=new DatabaseSync(path.join(secondRoot.root,'state','core.sqlite'));await until(secondRoot,()=>!!secondDb.prepare("SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:validate' AND phase='verified'").get(waiting.jobId));
    expect(await secondRoot.core.cancel(secondRoot.credential,waiting)).toMatchObject({status:'cancelled'});expect(secondDb.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=?').get(waiting.jobId)).toBeUndefined();db.close();secondDb.close();
  },30000);
});
