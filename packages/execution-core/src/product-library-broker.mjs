/* global Buffer, setTimeout */
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LibraryWorkflowAdapter } from './library-workflow-adapter.js';
import { digestLibraryValue } from './library-workflow-contract.js';
import { childEnvironment, replaceFileSync } from './product-security.mjs';
import { assertProductAuthority } from './product-broker.mjs';
import {
  appendContradictionRegistry, assembleAuditedMemo, assertFinalMemoBaseline, assertNavigationSnapshot, captureNavigationSnapshot,
  finalMemoPreflight, indiePrompt, factyPrompt, mammosPrompt, navigationEffects, parseIndieAtoms, verifyFinalMemoEvidence,
  writeCanonicalMemo, writeReservedAtom,
} from './product-library-final-memo.mjs';

const active = new Map();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => { const a=Buffer.from(left); const b=Buffer.from(right); return a.length===b.length&&timingSafeEqual(a,b); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const operationId = (stepId) => `library-step:${stepId}`;

export function assertPreparedLibraryAuthorization(config) {
  const prepared = JSON.parse(config.text);
  if (prepared?.kind !== 'library' || !config.libraryAuthorization || !config.grace) throw typed('LIBRARY_PREPARATION_REQUIRED','none');
  const { body, mac } = config.libraryAuthorization;
  if (typeof body !== 'string' || typeof mac !== 'string' || !equal(createHmac('sha256',config.token).update(body).digest('hex'),mac)) throw typed('LIBRARY_BINDING_INVALID','none');
  const binding = JSON.parse(body);
  if (binding.owner !== config.owner || binding.jobId !== config.jobId || binding.epoch !== config.epoch || binding.generation !== config.generation
    || binding.session !== config.session || binding.intentRevision !== config.intentRevision || binding.policy !== config.policy
    || binding.leaseDigest !== digest(config.lease) || binding.textDigest !== digest(config.text)) throw typed('LIBRARY_BINDING_INVALID','none');
  assertPreparedLibraryDependencies(config, prepared);
  return prepared;
}

export function assertPreparedLibraryDependencies(config, knownPrepared) {
  const prepared = knownPrepared ?? JSON.parse(config.text);
  if (prepared?.kind !== 'library') throw typed('LIBRARY_PREPARATION_REQUIRED','none');
  let navigationAfter; let effects=[];
  const db=new DatabaseSync(config.database,{readOnly:true});
  try{const row=db.prepare("SELECT phase FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:index'").get(config.jobId);if(row?.phase==='verified'){
    const value=readStepValue(config,'index');navigationAfter=value.navigationAfter;effects=value.navigationEffects??[];
  }}finally{db.close();}
  if(navigationAfter)assertNavigationSnapshot(prepared,navigationAfter);
  const evolved=new Map(effects.map((entry)=>[path.resolve(prepared.project.rootPath,entry.relativePath),entry.afterSha256]));
  const verify=(entry)=>{const expected=evolved.has(path.resolve(entry.path))?evolved.get(path.resolve(entry.path)):entry.hash;
    if(expected===null){if(existsSync(entry.path))throw typed('PROJECT_POLICY_CHANGED','none');return;}
    if(!existsSync(entry.path)||realpathSync(entry.path)!==entry.path||lstatSync(entry.path).isSymbolicLink()||digest(readFileSync(entry.path))!==expected)throw typed('PROJECT_POLICY_CHANGED','none');};
  for(const entry of Object.values(prepared.projectPolicies??{}))verify(entry);
  for(const entry of [...prepared.library.selectedSources,prepared.library.python])verify(entry);
  if(config.grace){
    for(const entry of [{path:config.grace.executable,hash:config.grace.executableHash},{path:config.grace.sourceFile,hash:config.grace.sourceHash},...Object.values(config.grace.documents??{}),...(config.grace.testDriver?[{path:config.grace.testDriver,hash:config.grace.testDriverHash}]:[])])verify(entry);
  }
  const expectedPolicies=Object.entries(prepared.projectPolicies??{}).filter(([name])=>name.startsWith('project_policy_')).map(([,entry])=>entry.path).sort();const actual=[];
  for(const directory of prepared.policyDirectories??[])for(const name of ['AGENTS.md','CLAUDE.md']){const filename=path.join(directory,name);if(existsSync(filename))actual.push(filename);}
  if(JSON.stringify(actual.sort())!==JSON.stringify(expectedPolicies))throw typed('PROJECT_POLICY_CHANGED','none');
  return true;
}

export async function executePreparedLibraryOperation(config, signal, options = {}) {
  const prepared = assertPreparedLibraryAuthorization(config);
  const testRunner = config.libraryTestRunner ? await loadTestRunner(config) : options.testRunner;
  if (testRunner && config.grace.mode !== 'test-driver') throw typed('LIBRARY_TEST_RUNNER_DENIED','none');
  if (config.grace.mode === 'claude' && typeof options.verifyLiveAuthority !== 'function') throw typed('LIBRARY_LIVE_AUTHORITY_REQUIRED','none');
  const key = `${config.owner}:${config.jobId}:${config.epoch}:${prepared.library.digest}:${digest(config.token)}`;
  const inFlight = active.get(key); if (inFlight) return inFlight;
  const execute = async () => {
    assertEffectRoot(config);
    const prior = readState(config);
    if (prior?.state === 'completed' && prior.receipt) return prior.receipt;
    if (prior?.state === 'uncertain') throw typed('LIBRARY_EFFECT_RECONCILIATION_REQUIRED','unknown');
    const selectedJob = { jobId: config.jobId, bindingDigest: digest(config.libraryAuthorization.body) };
    const completed = readCompletedReceipts(config, prepared);
    const adapter = new LibraryWorkflowAdapter(async (request) => createGrant(config, prepared, request, options));
    let lastOutput = null;
    writeState(config, prepared, { state:'running', outcome:'none', stepId:nextStep(prepared,completed)?.id ?? null });
    for (const step of prepared.library.ast.nodes) {
      if (completed.some((receipt) => receipt.stepId === step.id)) continue;
      if (signal.aborted) throw typed('LIBRARY_CANCELLED','none');
      let deliveryAuthority;
      if (step.effect === 'delivery') {
        deliveryAuthority = await waitForDeliveryAuthority(config, prepared, step, signal, options);
      }
      const grant = await adapter.authorizeStep(prepared.library, step.id, selectedJob, completed, deliveryAuthority);
      reserveStep(config, prepared, step, grant);
      writeState(config, prepared, { state:'running', outcome:'unknown', stepId:step.id, grantDigest:grant.grantDigest });
      let execution;
      try {
        const testExecution = testRunner ? await testRunner({ config:publicConfig(config), prepared, step, grant, completed:[...completed] }, signal) : undefined;
        execution = testExecution?.kind === 'library-test-use-built-in'
          ? await executeBuiltIn(config, prepared, step, completed, signal)
          : testRunner ? testExecution : await executeBuiltIn(config, prepared, step, completed, signal);
      } catch (error) {
        const outcome = error?.outcome === 'none' ? 'none' : 'unknown';
        markStep(config, step.id, outcome === 'none' ? 'failed' : 'uncertain', { code:safeCode(error), outcome });
        writeState(config, prepared, { state:outcome === 'none'?'failed':'uncertain', outcome, stepId:step.id, code:safeCode(error) });
        throw typed(safeCode(error),outcome);
      }
      const artifactDigest = persistStepArtifact(config, step, execution);
      const receipt = {
        preparationDigest:prepared.library.digest, sourceDigest:prepared.library.sourceScope.digest, jobId:config.jobId,
        stepId:step.id, operation:step.operation, grantDigest:grant.grantDigest,
        status:execution?.status === 'blocked' ? 'blocked' : 'completed', outputDigest:artifactDigest,
        obligations:[...step.requiredObligations],
        ...(step.requiresSpokeProof ? { spokeProof:{ kind:'runtime-spoke-receipt', actor:step.actor,
          invocationDigest:execution?.invocationDigest ?? digestLibraryValue({actor:step.actor,step:step.id,grant:grant.grantDigest}),
          artifactDigest:execution?.artifactDigest ?? artifactDigest,
          ...(execution?.delegatedBy==='grace'&&execution?.canonicalSpecSha256&&execution?.policyAdapterSha256?{delegatedBy:'grace',canonicalSpecSha256:execution.canonicalSpecSha256,policyAdapterSha256:execution.policyAdapterSha256}:{}),
          ...(step.actor === 'facty' ? { verdict:normalizeVerdict(execution?.verdict) } : {}) } } : {}),
      };
      adapter.verifyStepReceipt(prepared.library, step.id, selectedJob, grant, receipt);
      finishStep(config, step, grant, receipt);
      completed.push(receipt); lastOutput = execution;
      if (receipt.status === 'blocked' || receipt.spokeProof?.verdict === 'BLOCK') {
        const blocked = finalReceipt(config, prepared, completed, 'blocked', lastOutput);
        writeState(config, prepared, { state:'failed', outcome:'verified', stepId:step.id, code:'LIBRARY_FACTY_BLOCKED', receipt:blocked });
        return blocked;
      }
      writeState(config, prepared, { state:'running', outcome:'none', stepId:nextStep(prepared,completed)?.id ?? null });
    }
    const receipt = finalReceipt(config, prepared, completed, 'completed', lastOutput);
    writeState(config, prepared, { state:'completed', outcome:'verified', stepId:null, receipt });
    return receipt;
  };
  const promise = execute(); active.set(key,promise);
  try { return await promise; } finally { if(active.get(key)===promise) active.delete(key); }
}

export function readPreparedLibraryState(config) { const prepared=assertPreparedLibraryAuthorization(config); assertEffectRoot(config); return readState(config,prepared); }

async function createGrant(config, prepared, request, options) {
  await assertLive(config,prepared,options);
  const expiresAt = new Date(Date.now()+30_000).toISOString();
  const grantId = `grant-${request.stepId}-${randomUUID()}`;
  return { requestDigest:request.requestDigest, grantId, grantDigest:createHmac('sha256',config.token).update(JSON.stringify({request,grantId,expiresAt})).digest('hex'), expiresAt };
}
async function assertLive(config, prepared, options) {
  if (options.verifyLiveAuthority && await options.verifyLiveAuthority() !== true) throw typed('LIVE_AUTHORITY_DENIED','none');
  const db=new DatabaseSync(config.database,{timeout:5000});
  try {
    assertProductAuthority(db,config);
    const project=db.prepare('SELECT registration FROM gotzji_projects WHERE owner=? AND project_id=?').get(config.owner,prepared.project.projectId);
    if(!project||String(project.registration)!==JSON.stringify(prepared.project)) throw typed('PROJECT_REGISTRATION_CHANGED','none');
    const route=db.prepare('SELECT route FROM gotzji_library_routes WHERE adapter=? AND project_id=?').get(prepared.library.route.adapterId,prepared.project.projectId);
    if(!route||route.route!==prepared.library.route.route) throw typed('LIBRARY_ROUTE_AUTHORITY_DENIED','none');
    for(const resource of prepared.library.resources) if(!db.prepare('SELECT 1 FROM gotzji_resource_claims WHERE resource_key=? AND job_id=? AND epoch=?').get(resource,config.jobId,config.epoch)) throw typed('LIBRARY_RESOURCE_BINDING_DENIED','none');
  } finally { db.close(); }
  return true;
}
async function waitForDeliveryAuthority(config,prepared,step,signal,options){
  while(!signal.aborted){
    await assertLive(config,prepared,options);
    const db=new DatabaseSync(config.database,{readOnly:true});
    try { const row=db.prepare('SELECT digest FROM gotzji_library_delivery WHERE job_id=? AND scope=?').get(config.jobId,step.deliveryScope); if(row) return {scope:step.deliveryScope,authorityDigest:String(row.digest)}; }
    finally{db.close();}
    writeState(config,prepared,{state:'awaiting-delivery-authority',outcome:'none',stepId:step.id,scope:step.deliveryScope});
    await sleep(100);
  }
  writeState(config,prepared,{state:'cancelled',outcome:'none',stepId:step.id,scope:step.deliveryScope});
  throw typed('LIBRARY_CANCELLED','none');
}
function readCompletedReceipts(config,prepared){
  const db=new DatabaseSync(config.database,{readOnly:true});
  try{return prepared.library.ast.nodes.flatMap((step)=>{const row=db.prepare('SELECT phase,receipt FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(config.jobId,operationId(step.id));if(!row)return[];if(row.phase==='verified'&&typeof row.receipt==='string')return[JSON.parse(row.receipt).receipt];if(['started','uncertain'].includes(row.phase))throw typed('LIBRARY_EFFECT_RECONCILIATION_REQUIRED','unknown');return[];});}finally{db.close();}
}
function reserveStep(config,prepared,step,grant){
  const db=new DatabaseSync(config.database,{timeout:5000});try{db.exec('BEGIN IMMEDIATE;');assertProductAuthority(db,config);const id=operationId(step.id);const d=digestLibraryValue({preparation:prepared.library.digest,step:step.id,grant:grant.grantDigest});const prior=db.prepare('SELECT * FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(config.jobId,id);if(prior&&prior.digest!==d)throw typed('LIBRARY_STEP_DIGEST_CONFLICT','none');if(prior?.phase==='verified')throw typed('LIBRARY_STEP_REPLAY_CONFLICT','none');if(['started','uncertain'].includes(prior?.phase))throw typed('LIBRARY_EFFECT_RECONCILIATION_REQUIRED','unknown');db.prepare('INSERT INTO gotzji_recipe_operations VALUES (?,?,?,?,NULL) ON CONFLICT(job_id,operation_id) DO UPDATE SET phase=excluded.phase,receipt=NULL').run(config.jobId,id,d,'started');db.exec('COMMIT;');}catch(e){try{db.exec('ROLLBACK;');}catch{/* no open transaction */}throw e;}finally{db.close();}
}
function finishStep(config,step,grant,receipt){const db=new DatabaseSync(config.database,{timeout:5000});try{db.exec('BEGIN IMMEDIATE;');assertProductAuthority(db,config);const row=db.prepare('SELECT phase FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(config.jobId,operationId(step.id));if(row?.phase!=='started')throw typed('LIBRARY_STEP_FENCE_INVALID','unknown');db.prepare('UPDATE gotzji_recipe_operations SET phase=?,receipt=? WHERE job_id=? AND operation_id=?').run('verified',JSON.stringify({grant,receipt}),config.jobId,operationId(step.id));db.exec('COMMIT;');}catch(e){try{db.exec('ROLLBACK;');}catch{/* no open transaction */}throw e;}finally{db.close();}}
function markStep(config,stepId,phase,receipt){const db=new DatabaseSync(config.database,{timeout:5000});try{db.prepare('UPDATE gotzji_recipe_operations SET phase=?,receipt=? WHERE job_id=? AND operation_id=?').run(phase,JSON.stringify(receipt),config.jobId,operationId(stepId));}finally{db.close();}}
function persistStepArtifact(config,step,value){const content=JSON.stringify(value??null);const body=JSON.stringify({jobId:config.jobId,epoch:config.epoch,stepId:step.id,operation:step.operation,valueDigest:digest(content),value:value??null});const record=JSON.stringify({body,mac:createHmac('sha256',config.token).update(body).digest('hex')});writeFileSync(path.join(config.effectRoot,`library-step-${step.id}.json`),record,{flag:'wx',mode:0o600});return digest(content);}
function finalReceipt(config,prepared,receipts,state,lastOutput){return{operation:'library.workflow',projectId:prepared.project.projectId,workflowId:prepared.library.ast.workflowId,workflowVersion:prepared.library.ast.workflowVersion,route:prepared.library.route.route,state,jobId:config.jobId,epoch:config.epoch,intentDigest:prepared.library.digest,sourceDigest:prepared.library.sourceScope.digest,resourceKeys:prepared.library.resources,steps:receipts,lastOutputDigest:digestLibraryValue(lastOutput??null)};}
function nextStep(prepared,receipts){const done=new Set(receipts.map((r)=>r.stepId));return prepared.library.ast.nodes.find((step)=>!done.has(step.id));}

async function executeBuiltIn(config,prepared,step,completed,signal){
  const selected=prepared.library.selectedSources;
  if(step.operation==='library.memo.preflight'&&prepared.library.ast.workflowId==='library.final-memo'&&prepared.library.ast.workflowVersion===2) return {...finalMemoPreflight(prepared),files:selected.map((entry)=>({path:path.relative(prepared.project.rootPath,entry.path),sha256:entry.hash}))};
  if(step.operation==='library.source.read'||step.operation==='library.code.inspect'||step.operation==='library.memo.preflight') return {files:selected.map((entry)=>({path:path.relative(prepared.project.rootPath,entry.path),sha256:entry.hash,content:readFileSync(entry.path,'utf8')}))};
  if(step.operation==='library.code.apply'){
    if(selected.length!==1||typeof prepared.input.parameters.content!=='string'||typeof prepared.input.parameters.expectedSha256!=='string')throw typed('LIBRARY_CODE_PATCH_REQUIRED','none');
    const target=selected[0].path;const current=digest(readFileSync(target));if(current!==prepared.input.parameters.expectedSha256||current!==selected[0].hash)throw typed('LIBRARY_SOURCE_CHANGED','none');
    const temporary=`${target}.gotzji-${config.epoch}`;writeFileSync(temporary,prepared.input.parameters.content,{flag:'wx',mode:lstatSync(target).mode});renameSync(temporary,target);return{path:path.relative(prepared.project.rootPath,target),beforeSha256:current,afterSha256:digest(readFileSync(target))};
  }
  if(step.operation==='library.qa.audit-orphans') return runCommand(prepared.library.python.path,[path.join(prepared.project.rootPath,'scripts','audit_orphan_md.py'),'--quiet','--strict'],prepared.project.rootPath,signal);
  if(step.operation==='library.qa.validate') return runCommand(prepared.library.python.path,[path.join(prepared.project.rootPath,'scripts','validate.py'),'--strict','--quiet'],prepared.project.rootPath,signal);
  if(step.operation==='library.weekly-reading.select'){
    const result=await runCommand(prepared.library.python.path,[weeklyWrapper(config),'select'],prepared.project.rootPath,signal);let selected;try{selected=JSON.parse(result.stdout);}catch{throw typed('LIBRARY_WEEKLY_SELECTION_INVALID','none');}
    if(!Array.isArray(selected.articles)||!Number.isSafeInteger(selected.overflow))throw typed('LIBRARY_WEEKLY_SELECTION_INVALID','none');return selected;
  }
  if(step.operation==='library.weekly-reading.synthesize'){
    const selected=readStepValue(config,'select');if(!Array.isArray(selected?.articles))throw typed('LIBRARY_WEEKLY_SELECTION_INVALID','none');if(selected.articles.length===0)return{noOp:true,articleCount:0};
    const selectionFile=path.join(config.effectRoot,'weekly-selection.json');writeFileSync(selectionFile,JSON.stringify(selected),{flag:'wx',mode:0o600});
    const brief=await runCommand(prepared.library.python.path,[weeklyWrapper(config),'brief',selectionFile],prepared.project.rootPath,signal);
    const synthesis=await runCommand(config.grace.executable,['-p',brief.stdout,'--model','sonnet','--effort','medium','--output-format','text','--tools','','--permission-mode','dontAsk','--permission-prompts','none','--settings','{"disableAllHooks":true}','--no-session-persistence'],prepared.project.rootPath,signal,config.grace.executableHash);
    const bodyFile=path.join(config.effectRoot,'weekly-body.md');writeFileSync(bodyFile,synthesis.stdout,{flag:'wx',mode:0o600});
    const written=await runCommand(prepared.library.python.path,[weeklyWrapper(config),'write',selectionFile,bodyFile],prepared.project.rootPath,signal);let output;try{output=JSON.parse(written.stdout);}catch{throw typed('LIBRARY_WEEKLY_OUTPUT_INVALID','unknown');}
    return{...output,invocationDigest:digest(brief.stdout),artifactDigest:digest(readFileSync(output.path))};
  }
  if(step.operation==='library.weekly-reading.build') return runCommand(prepared.library.python.path,[path.join(prepared.project.rootPath,'scripts','build_reading_room.py')],prepared.project.rootPath,signal);
  if(step.operation==='library.weekly-reading.verify') return runCommand(prepared.library.python.path,[path.join(prepared.project.rootPath,'scripts','build_reading_room.py'),'--check'],prepared.project.rootPath,signal);
  if(['library.spoke.mammos','library.spoke.facty','library.spoke.indie'].includes(step.operation)) return invokeSpoke(config,prepared,step,completed,signal);
  if(step.operation==='library.memo.persist-audited'){
    const assembled=assembleAuditedMemo(prepared,readStepValue(config,'mammos'),readStepValue(config,'facty'));
    await runMemoPrivacyAudit(config,prepared,assembled.content,signal);
    return writeCanonicalMemo(prepared,assembled);
  }
  if(step.operation==='library.memo.pipeline'){
    const preflight=readStepValue(config,'preflight');assertFinalMemoBaseline(prepared,preflight,['pipeline']);
    const memo=readStepValue(config,'persist');
    try{const result=await runCommand(prepared.library.python.path,[path.join(prepared.project.rootPath,'scripts','pipeline_dashboard.py'),'--set',prepared.library.finalMemo.ticker,'--stage','📊 Memo ✅','--owner','Mammos','--next','✅ Decision (user)'],prepared.project.rootPath,signal);return{...result,memoSha256:memo.sha256};}
    catch{throw typed('LIBRARY_PIPELINE_GATEWAY_FAILED','unknown');}
  }
  if(step.operation==='library.memo.persist-atoms'){
    const memo=readStepValue(config,'persist');const atoms=parseIndieAtoms(readStepValue(config,'indie'));const written=[];
    for(const atom of atoms){
      let result;try{result=await runCommand(prepared.library.python.path,[path.join(prepared.project.rootPath,'scripts','save_atom.py'),'--reserve'],prepared.project.rootPath,signal);}catch{throw typed('LIBRARY_ATOM_GATEWAY_FAILED','unknown');}
      const match=/^(ATOM-[0-9]{4,})\s+(.+?)\s*$/u.exec(result.stdout.trim());if(!match)throw typed('LIBRARY_ATOM_RESERVATION_INVALID','unknown');
      const reservationPath=path.resolve(match[2]);if(!existsSync(reservationPath))throw typed('LIBRARY_ATOM_RESERVATION_INVALID','unknown');
      written.push(writeReservedAtom(prepared,{id:match[1],path:reservationPath,sha256:digest(readFileSync(reservationPath))},atom,memo));
    }
    return{atoms:written,memoSha256:memo.sha256};
  }
  if(step.operation==='library.memo.index'){
    const preflight=readStepValue(config,'preflight');assertFinalMemoBaseline(prepared,preflight,['outputsIndex','tickerIndex','knowledgeIndex','topicMap','contradictionRegistry']);assertNavigationSnapshot(prepared,preflight.navigationSnapshot);
    appendContradictionRegistry(prepared,preflight,parseIndieAtoms(readStepValue(config,'indie')),readStepValue(config,'atoms').atoms,readStepValue(config,'persist'));
    try{const result=await runCommand(prepared.library.python.path,[path.join(prepared.project.rootPath,'scripts','build_indexes_from_frontmatter.py'),'--no-web'],prepared.project.rootPath,signal);const navigationAfter=captureNavigationSnapshot(prepared);return{...result,memoSha256:readStepValue(config,'persist').sha256,navigationAfter,navigationEffects:navigationEffects(preflight.navigationSnapshot,navigationAfter)};}
    catch{throw typed('LIBRARY_INDEX_GATEWAY_FAILED','unknown');}
  }
  if(step.operation==='library.memo.verify'){
    const memo=readStepValue(config,'persist');const atoms=readStepValue(config,'atoms').atoms;const evidence=verifyFinalMemoEvidence(prepared,memo,atoms);
    try{
      await runCommand(prepared.library.python.path,[path.join(prepared.project.rootPath,'scripts','audit_orphan_md.py'),'--quiet','--strict'],prepared.project.rootPath,signal);
      await runCommand(prepared.library.python.path,[path.join(prepared.project.rootPath,'scripts','validate.py'),'--strict','--quiet'],prepared.project.rootPath,signal);
      await runMemoPrivacyAudit(config,prepared,readFileSync(path.join(prepared.project.rootPath,memo.path),'utf8'),signal);
    }catch(error){if(error?.code?.startsWith('LIBRARY_PRIVACY_'))throw error;throw typed('LIBRARY_CANONICAL_VERIFICATION_FAILED','none');}
    return evidence;
  }
  if(step.effect==='delivery') return runDelivery(config,prepared,step,signal);
  throw typed('LIBRARY_OPERATION_NOT_REGISTERED','none');
}
export function prepareCanonicalSpokePolicy(prepared,actor,effectRoot){
  if(!['mammos','facty','indie'].includes(actor))throw typed('LIBRARY_SPOKE_ROLE_DENIED','none');
  const descriptor=prepared.library.sourceScope.descriptors.find((entry)=>entry.id===`${actor}-agent`);
  if(!descriptor)throw typed('LIBRARY_CANONICAL_AGENT_MISSING','none');
  const sourcePath=path.join(prepared.project.rootPath,descriptor.relativePath);const bytes=readFileSync(sourcePath);
  if(digest(bytes)!==descriptor.sha256)throw typed('LIBRARY_CANONICAL_AGENT_CHANGED','none');
  const source=bytes.toString('utf8');const match=/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]+)$/u.exec(source);
  if(!match?.[1]?.trim())throw typed('LIBRARY_CANONICAL_AGENT_INVALID','none');
  const policy={ [actor]:{description:`Canonical ${actor} persona under a task-bound gotzji policy`,prompt:match[1],tools:[]} };
  const content=`${JSON.stringify(policy,null,2)}\n`;const policyPath=path.join(effectRoot,`agent-policy-${actor}.json`);
  if(existsSync(policyPath)){if(digest(readFileSync(policyPath))!==digest(content))throw typed('LIBRARY_SPOKE_POLICY_CHANGED','unknown');}
  else writeFileSync(policyPath,content,{flag:'wx',mode:0o600});
  return{path:policyPath,canonicalSpecSha256:descriptor.sha256,policyAdapterSha256:digest(content)};
}
async function invokeSpoke(config,prepared,step,completed,signal){
  const actor=step.actor;const evidence=prepared.library.selectedSources.map((entry)=>`## ${path.relative(prepared.project.rootPath,entry.path)}\n${readFileSync(entry.path,'utf8')}`).join('\n\n');
  const prior=completed.map((receipt)=>`${receipt.stepId}:${receipt.outputDigest}`).join('\n');
  const policy=prepared.library.ast.workflowId==='library.final-memo'&&prepared.library.ast.workflowVersion===2?prepareCanonicalSpokePolicy(prepared,actor,config.effectRoot):undefined;
  const rolePrompt=prepared.library.ast.workflowId==='library.final-memo'&&prepared.library.ast.workflowVersion===2
    ? actor==='mammos'?mammosPrompt(prepared):actor==='facty'?factyPrompt(prepared,readStepValue(config,'mammos')):indiePrompt(prepared,readStepValue(config,'persist'))
    : `Act as ${actor} for one task-bound Investment Library workflow. Use only the supplied evidence. Return Markdown only. ${actor==='facty'?'Start with VERDICT: PASS, CAVEATS, or BLOCK.':''}`;
  const prompt=`${rolePrompt}\nWorkflow: ${prepared.library.ast.workflowId}\nParameters: ${JSON.stringify(prepared.input.parameters)}\nPrior receipts:\n${prior}\nEvidence:\n${evidence}`;
  const args=['-p',prompt,'--output-format','text','--tools','','--permission-mode','dontAsk','--permission-prompts','none','--setting-sources','user','--settings','{"disableAllHooks":true}',...(policy?['--agents',policy.path,'--agent',actor]:[]),'--no-session-persistence'];
  const result=await runCommand(config.grace.executable,args,prepared.project.rootPath,signal,config.grace.executableHash);
  const content=result.stdout;if(Buffer.byteLength(content,'utf8')>512*1024)throw typed('LIBRARY_SPOKE_OUTPUT_TOO_LARGE','none');const artifactDigest=digest(content);writeFileSync(path.join(config.effectRoot,`${actor}.md`),content,{flag:'wx',mode:0o600});
  const verdict=actor==='facty'?(/^VERDICT:\s*(PASS|CAVEATS|BLOCK)/im.exec(content)?.[1]??'BLOCK'):undefined;
  return{actor,...(policy?{delegatedBy:'grace',canonicalSpecSha256:policy.canonicalSpecSha256,policyAdapterSha256:policy.policyAdapterSha256}:{}),invocationDigest:digest(prompt),artifactDigest,content,...(actor==='indie'?{atoms:parseIndieAtoms(content)}:{}),...(verdict?{verdict}:{}),exitCode:result.exitCode};
}
async function runDelivery(config,prepared,step,signal){
  if(step.deliveryScope==='commit') {
    const paths=prepared.library.ast.workflowId==='library.weekly-reading'?[path.relative(prepared.project.rootPath,readStepValue(config,'synthesize').path),'team-outputs/reading-digest/covered.json','inputs/Dashboards/Reading-Room/Reading-room-dashboard.html']:prepared.library.selectedSources.map((entry)=>path.relative(prepared.project.rootPath,entry.path));
    await runCommand('git',['add','--',...paths],prepared.project.rootPath,signal);
    return runCommand('git',['commit','--only','-m',`gotzji: ${prepared.library.ast.workflowId} ${config.jobId.slice(0,12)}`,'--',...paths],prepared.project.rootPath,signal);
  }
  if(step.deliveryScope==='push') return runCommand('git',['push'],prepared.project.rootPath,signal);
  if(step.deliveryScope==='deploy') return runDeploy(config,prepared,signal);
  if(step.deliveryScope==='user-delivery'&&prepared.library.ast.workflowId==='library.final-memo'){
    const verified=readStepValue(config,'verify');const content=readFileSync(path.join(prepared.project.rootPath,verified.path),'utf8');
    return{scope:'user-delivery',path:verified.path,sha256:verified.sha256,verdict:verified.verdict,atomPaths:verified.atomPaths,content};
  }
  throw typed('LIBRARY_DELIVERY_EXECUTOR_NOT_REGISTERED','none');
}
async function runMemoPrivacyAudit(config,prepared,content,signal){
  const directory=path.join(config.effectRoot,'memo-privacy');mkdirSync(directory,{recursive:true,mode:0o700});const target=path.join(directory,'memo.md');
  if(existsSync(target)){if(digest(readFileSync(target))!==digest(content))throw typed('LIBRARY_PRIVACY_STAGING_CHANGED','unknown');}
  else writeFileSync(target,content,{flag:'wx',mode:0o600});
  try{return await runCommand(prepared.library.python.path,[path.join(prepared.project.rootPath,'scripts','audit_portfolio_private.py'),'--check','--public-only','--public-root',directory,'--json'],prepared.project.rootPath,signal);}
  catch{throw typed('LIBRARY_PRIVACY_GATE_FAILED','none');}
}
async function runDeploy(config,prepared,signal){const controller=path.join(prepared.project.rootPath,'inputs','Dashboards','Investing-Library-Hub','deploy_hub.py');await runCommand(prepared.library.python.path,[controller,'request','--reason',`gotzji-${config.jobId.slice(0,12)}`],prepared.project.rootPath,signal);for(let i=0;i<360;i++){if(signal.aborted)throw typed('LIBRARY_CANCELLED','unknown');try{return await runCommand(prepared.library.python.path,[controller,'live-verify'],prepared.project.rootPath,signal);}catch{await sleep(5000);}}throw typed('LIBRARY_DEPLOY_VERIFICATION_TIMEOUT','unknown');}
function weeklyWrapper(config){const binding=config.libraryWrapper;if(!binding||typeof binding.path!=='string'||!path.isAbsolute(binding.path)||!existsSync(binding.path)||lstatSync(binding.path).isSymbolicLink()||realpathSync(binding.path)!==path.resolve(binding.path)||digest(readFileSync(binding.path))!==binding.sha256)throw typed('LIBRARY_WEEKLY_WRAPPER_CHANGED','none');return binding.path;}
function readStepValue(config,stepId){const filename=path.join(config.effectRoot,`library-step-${stepId}.json`);if(!existsSync(filename)||lstatSync(filename).isSymbolicLink())throw typed('LIBRARY_STEP_ARTIFACT_MISSING','unknown');const envelope=JSON.parse(readFileSync(filename,'utf8'));if(typeof envelope.body!=='string'||typeof envelope.mac!=='string'||!equal(createHmac('sha256',config.token).update(envelope.body).digest('hex'),envelope.mac))throw typed('LIBRARY_STEP_ARTIFACT_INVALID','unknown');const body=JSON.parse(envelope.body);if(body.jobId!==config.jobId||body.epoch!==config.epoch||body.stepId!==stepId||body.valueDigest!==digest(JSON.stringify(body.value??null)))throw typed('LIBRARY_STEP_ARTIFACT_INVALID','unknown');return body.value;}
function runCommand(executable,args,cwd,signal,expectedHash){return new Promise((resolve,reject)=>{if(expectedHash&&digest(readFileSync(executable))!==expectedHash){reject(typed('DEPENDENCIES_CHANGED','none'));return;}const child=spawn(executable,args,{cwd,env:childEnvironment(),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';let settled=false;const done=(error,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(value);};const abort=()=>{child.kill();done(typed('LIBRARY_CANCELLED','unknown'));};signal.addEventListener('abort',abort,{once:true});child.stdout.on('data',(chunk)=>{stdout+=chunk;});child.stderr.on('data',(chunk)=>{stderr+=chunk;});child.once('error',()=>done(typed('LIBRARY_COMMAND_LAUNCH_FAILED','none')));child.once('close',(code)=>{if(code===0)done(null,{exitCode:0,stdout,stderrDigest:digest(stderr)});else done(typed('LIBRARY_COMMAND_FAILED','none'));});});}
async function loadTestRunner(config){if(config.grace.mode!=='test-driver')throw typed('LIBRARY_TEST_RUNNER_DENIED','none');const binding=config.libraryTestRunner;const verify=()=>{const info=lstatSync(binding.path);if(!info.isFile()||info.isSymbolicLink()||realpathSync(binding.path)!==path.resolve(binding.path)||digest(readFileSync(binding.path))!==binding.sha256)throw typed('LIBRARY_TEST_RUNNER_CHANGED','none');};verify();const module=await import(pathToFileURL(binding.path).href+'?sha256='+binding.sha256);verify();if(typeof module.executeLibraryStep!=='function')throw typed('LIBRARY_TEST_RUNNER_INVALID','none');return module.executeLibraryStep;}
function publicConfig(config){return{jobId:config.jobId,epoch:config.epoch,owner:config.owner,intentRevision:config.intentRevision};}
function assertEffectRoot(config){if(!path.isAbsolute(config.effectRoot)||realpathSync(config.effectRoot)!==path.resolve(config.effectRoot)||!lstatSync(config.effectRoot).isDirectory()||lstatSync(config.effectRoot).isSymbolicLink())throw typed('LIBRARY_EFFECT_ROOT_CHANGED','unknown');}
function readState(config){const filename=path.join(config.effectRoot,'library-operation.json');if(!existsSync(filename))return undefined;if(lstatSync(filename).isSymbolicLink()||realpathSync(filename)!==path.resolve(filename))throw typed('LIBRARY_EVIDENCE_INVALID','unknown');const envelope=JSON.parse(readFileSync(filename,'utf8'));if(typeof envelope.body!=='string'||typeof envelope.mac!=='string'||!equal(createHmac('sha256',config.token).update(envelope.body).digest('hex'),envelope.mac))throw typed('LIBRARY_EVIDENCE_INVALID','unknown');const state=JSON.parse(envelope.body);if(state.jobId!==config.jobId||state.epoch!==config.epoch||state.intentDigest!==JSON.parse(config.text).library.digest)throw typed('LIBRARY_EVIDENCE_INVALID','unknown');return state;}
function writeState(config,prepared,value){const body=JSON.stringify({jobId:config.jobId,epoch:config.epoch,generation:config.generation,intentDigest:prepared.library.digest,resourceKeys:prepared.library.resources,...value});const record=JSON.stringify({body,mac:createHmac('sha256',config.token).update(body).digest('hex')});const temporary=path.join(config.effectRoot,`.library-${randomUUID()}.tmp`);writeFileSync(temporary,record,{flag:'wx',mode:0o600});replaceFileSync(temporary,path.join(config.effectRoot,'library-operation.json'));}
function normalizeVerdict(value){return value==='PASS'||value==='CAVEATS'||value==='BLOCK'?value:'BLOCK';}
function safeCode(error){return typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)?error.code:typeof error?.message==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.message)?error.message:'LIBRARY_EXECUTION_FAILED';}
function typed(code,outcome){const error=new Error(code);error.code=code;error.outcome=outcome;return error;}
