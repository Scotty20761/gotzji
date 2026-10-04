import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyFingerprint } from './fingerprints.mjs';
export const SERVER = 'gotzji_task';
export const TOOL_NAMES = ['read_policy', 'read_source', 'save_result', 'check_result'];
export const FULL_TOOLS = TOOL_NAMES.map((name) => `mcp__${SERVER}__${name}`);
export const CODE_TOOLS = ['read_policy','read_source','check_before','apply_change','start_validation','validation_status'];
export function toolNames(config){return config?.grace?.recipe==='code-check'?CODE_TOOLS:TOOL_NAMES;}
export function fullTools(config){return toolNames(config).map((name)=>`mcp__${SERVER}__${name}`);}
export function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function assertProfile(profile) {
  for (const entry of [{ path: profile.executable, hash: profile.executableHash }, { path: profile.sourceFile, hash: profile.sourceHash }, ...Object.values(profile.documents), ...(profile.testDriver ? [{ path: profile.testDriver, hash: profile.testDriverHash }] : [])]) {
    try { verifyFingerprint(entry.path, entry.hash); } catch { throw new Error('DEPENDENCIES_CHANGED'); }
  }
}
export function tools(config) {
  return toolNames(config).map((name) => ({ name, description: {
    read_policy: 'Read one current canonical prepared policy document. Read rules, agents, workflow and index before the source.',
    read_source: 'Read the one host-prepared public project source after canonical pre-work.',
    save_result: 'Grace-controlled save of the exact prepared source snapshot in the private job output.',
    check_result: 'Run the server-selected native verifier and record its real exit/output receipt.',
    check_before:'Reproduce the host-selected safe source bug with the real validator before editing.',
    apply_change:'Apply only the host-authorized repair bytes to this private project after baseline reproduction.',
    start_validation:'Start the registered asynchronous semantic/property validator and return its durable run ID immediately.',
    validation_status:'Read the current host-observed validator state. Pending is not completed; the supervisor verifies the terminal result.',
  }[name], inputSchema: { type: 'object', properties: name === 'read_policy' ? { document: { type: 'string', enum: config?.grace ? Object.keys(config.grace.documents) : ['rules','agents','workflow','index'] } } : name === 'save_result' ? { sourceHash: { type: 'string' } } : name==='apply_change'?{sourceHash:{type:'string'},content:{type:'string'}}:{}, required: name === 'read_policy' ? ['document'] : name === 'save_result' ? ['sourceHash'] : name==='apply_change'?['sourceHash','content']:[], additionalProperties: false },
    annotations: { readOnlyHint: ['read_policy','read_source','validation_status'].includes(name), destructiveHint: false, idempotentHint: true } }));
}
function keys(argumentsValue, expected) {
  if (!argumentsValue || Array.isArray(argumentsValue) || Object.keys(argumentsValue).sort().join(',') !== expected) throw new Error('ARGUMENTS_DENIED');
}
/** Trusted host broker; the Claude process never has a database/native-file tool. */
export function brokerCall(config, name, args, runtimeApproved, validatorManager) {
  if (!runtimeApproved || !toolNames(config).includes(name)) throw new Error('RUNTIME_OR_TOOL_DENIED');
  // Reject malformed model arguments before expensive dependency hashing and
  // before reserving anything. Valid shapes still require the full live gate.
  if (name === 'read_policy') {
    keys(args,'document');
    if (!Object.hasOwn(config.grace.documents,args.document)) throw new Error('POLICY_DENIED');
  } else if (name === 'save_result' || name === 'apply_change') {
    keys(args,name==='apply_change'?'content,sourceHash':'sourceHash');
    if (args.sourceHash !== config.grace.sourceHash) throw new Error('PAYLOAD_DENIED');
    if(name==='apply_change'&&args.content!==config.grace.expectedContent) throw new Error('PAYLOAD_DENIED');
  } else keys(args,'');
  assertProfile(config.grace);
  const database = new DatabaseSync(config.database, { timeout: 5000 });
  try {
    database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
    const worker = database.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(config.jobId);
    const claim = database.prepare('SELECT * FROM gotzji_claims WHERE id=?').get(config.jobId);
    const goal = claim && database.prepare('SELECT * FROM goals WHERE id=?').get(claim.goal_id);
    const writer = database.prepare('SELECT * FROM gotzji_writers WHERE job_id=? AND epoch=?').get(config.jobId, config.epoch);
    const operation = database.prepare('SELECT * FROM gotzji_operations WHERE job_id=?').get(config.jobId);
    const expiry = Date.parse(goal?.lease_expires_at);
    const authorization=database.prepare('SELECT * FROM gotzji_authorized_jobs WHERE job_id=?').get(config.jobId);
    if (!worker || !goal || !writer || claim.policy !== config.policy || operation?.phase !== 'started' || worker.epoch !== config.epoch || worker.generation !== config.generation ||
        goal.status !== 'active' || goal.owner_client_id !== config.owner || goal.lease_owner_session_id !== config.session ||
        goal.user_intent_revision !== config.intentRevision || goal.lease_generation !== config.generation || goal.lease_token_hash !== digest(config.lease) || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('LIVE_AUTHORITY_DENIED');
    if(!authorization||authorization.owner!==config.owner||authorization.intent_digest!==claim?.digest||authorization.boundary!=='local'||authorization.policy!==config.policy||authorization.authorization_digest!==config.authorizationDigest||authorization.intent_revision!==goal?.user_intent_revision) throw new Error('DELIVERY_AUTHORITY_DENIED');
    const id = name === 'read_policy' ? `policy:${args?.document}` : name;
    if (name !== 'read_policy') {
      for (const document of Object.keys(config.grace.documents)) if (!database.prepare('SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=? AND phase=?').get(config.jobId, `policy:${document}`, 'verified')) throw new Error('PREWORK_REQUIRED');
    }
    if (['save_result','check_result','check_before','apply_change','start_validation','validation_status'].includes(name)) {
      if (!database.prepare('SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=? AND phase=?').get(config.jobId, 'read_source', 'verified')) throw new Error('SOURCE_READ_REQUIRED');
    }
    if (name === 'check_result' && !database.prepare('SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=? AND phase=?').get(config.jobId, 'save_result', 'verified')) throw new Error('SAVE_REQUIRED');
    if(name==='apply_change'&&!database.prepare('SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=? AND phase=?').get(config.jobId,'check_before','verified')) throw new Error('REPRO_REQUIRED');
    if(['start_validation','validation_status'].includes(name)&&!database.prepare('SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=? AND phase=?').get(config.jobId,'apply_change','verified')) throw new Error('SAVE_REQUIRED');
    const payloadDigest = digest(JSON.stringify({ name, args, intent: claim.digest, policy: claim.policy, generation: config.generation }));
    const previous = database.prepare('SELECT * FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(config.jobId, id);
    if (previous && previous.digest !== payloadDigest) throw new Error('OPERATION_DIGEST_CONFLICT');
    database.prepare('INSERT OR IGNORE INTO gotzji_recipe_operations VALUES (?,?,?,?,NULL)').run(config.jobId, id, payloadDigest, 'reserved');
    database.exec('COMMIT;');
    let result;
    if (name === 'read_policy') {
      const source = config.grace.documents[args.document];
      const bytes = readFileSync(source.path);
      if (digest(bytes) !== source.hash) throw new Error('DEPENDENCIES_CHANGED');
      result = { document: args.document, sha256: source.hash, content: bytes.toString('utf8') };
    } else if (name === 'read_source') {
      const bytes = readFileSync(config.grace.sourceFile);
      if (digest(bytes) !== config.grace.sourceHash) throw new Error('DEPENDENCIES_CHANGED');
      result = { sha256: config.grace.sourceHash, content: bytes.toString('utf8') };
    }
    else if(config.grace.recipe==='code-check'){
      const target=path.join(config.effectRoot,'result.txt');
      if(realpathSync(config.effectRoot)!==config.effectRoot) throw new Error('EFFECT_ROOT_CHANGED');
      if(name==='check_before'){
        const verifier=fileURLToPath(new URL('./phase-r-validator.mjs',import.meta.url));
        const observed=spawnSync(process.execPath,[verifier,config.grace.sourceFile,config.grace.sourceHash,'0'],{windowsHide:true,shell:false,encoding:'utf8',timeout:10000});
        if(observed.status!==1||!observed.stdout.includes('CODE_ASSERTION_FAILED')) throw new Error('REPRO_NOT_VERIFIED');
        result={exitCode:1,reason:'CODE_ASSERTION_FAILED',sourceHash:config.grace.sourceHash};
      } else if(name==='apply_change'){
        const duplicate=existsSync(target);
        if(duplicate&&(lstatSync(target).isSymbolicLink()||digest(readFileSync(target))!==config.grace.expectedHash)) throw new Error('EFFECT_UNKNOWN');
        database.prepare('UPDATE gotzji_recipe_operations SET phase=? WHERE job_id=? AND operation_id=?').run('started',config.jobId,id);
        if(!duplicate) writeFileSync(target,args.content,{flag:'wx',mode:0o600});
        result={sha256:digest(readFileSync(target)),duplicate};
      } else {
        if(!validatorManager) throw new Error('RUNNER_NOT_REGISTERED');
        if(!existsSync(target)||lstatSync(target).isSymbolicLink()||digest(readFileSync(target))!==config.grace.expectedHash) throw new Error('EFFECT_UNKNOWN');
        if(name==='start_validation') result=validatorManager.start();
        else {const current=validatorManager.status();if(!current) throw new Error('RUN_NOT_FOUND');result={runId:current.runId,state:current.state,elapsedMs:current.elapsedMs,checks:current.checks};}
      }
    } else {
      const target = path.join(config.effectRoot, 'result.txt');
      if (realpathSync(config.effectRoot) !== config.effectRoot) throw new Error('EFFECT_ROOT_CHANGED');
      if (name === 'save_result') {
        if (args.sourceHash !== config.grace.sourceHash) throw new Error('PAYLOAD_DENIED');
        const duplicate = existsSync(target);
        if (duplicate && (lstatSync(target).isSymbolicLink() || digest(readFileSync(target)) !== config.grace.sourceHash)) throw new Error('EFFECT_UNKNOWN');
        const bytes = readFileSync(config.grace.sourceFile);
        if (digest(bytes) !== config.grace.sourceHash) throw new Error('DEPENDENCIES_CHANGED');
        database.prepare('UPDATE gotzji_recipe_operations SET phase=? WHERE job_id=? AND operation_id=?').run('started', config.jobId, id);
        if (!duplicate) writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        result = { sha256: digest(readFileSync(target)), duplicate };
      } else {
        if (!existsSync(target) || lstatSync(target).isSymbolicLink() || digest(readFileSync(target)) !== config.grace.sourceHash) throw new Error('EFFECT_UNKNOWN');
        if (previous?.phase === 'verified' && previous.receipt) result = JSON.parse(previous.receipt);
        else {
          if (previous?.phase === 'started') throw new Error('CHECK_RECONCILIATION_REQUIRED');
          const verifier = fileURLToPath(new URL('./grace-verifier.mjs', import.meta.url));
          database.prepare('UPDATE gotzji_recipe_operations SET phase=? WHERE job_id=? AND operation_id=?').run('started', config.jobId, id);
          const command = spawnSync(process.execPath, [verifier, config.effectRoot, config.grace.sourceHash], { windowsHide: true, timeout: 10000, encoding: 'utf8', shell: false });
          if (command.status !== 0) throw new Error('CHECK_FAILED');
          const observed = JSON.parse(command.stdout);
          if (observed.sha256 !== config.grace.sourceHash) throw new Error('CHECK_FAILED');
          result = { ...observed, exitCode: command.status, verifierHash: digest(readFileSync(verifier)), recipe: 'node-source-snapshot-check-v1' };
        }
      }
    }
    database.prepare('UPDATE gotzji_recipe_operations SET phase=?,receipt=? WHERE job_id=? AND operation_id=?').run('verified', JSON.stringify(result), config.jobId, id);
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* no open reservation */ }
    throw error;
  } finally { database.close(); }
}
