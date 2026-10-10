import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { assertProductDependencies } from './product-security.mjs';
const digest = (value) => createHash('sha256').update(value).digest('hex');
export const PRODUCT_TOOLS = ['read_policy', 'execute_operation', 'operation_status'];
export function productTools(config) {
  return PRODUCT_TOOLS.map((name) => ({ name, description: name === 'read_policy' ? 'Read current canonical pre-work supplied by the host.' : name === 'execute_operation' ? 'Execute the exact host-prepared operation in the selected project. Cannot choose another path, command or payload.' : 'Read the observed operation state; running is not completed.', inputSchema: { type: 'object', properties: name === 'read_policy' ? { document: { type: 'string', enum: Object.keys(config.grace.documents) } } : {}, required: name === 'read_policy' ? ['document'] : [], additionalProperties: false }, annotations: { readOnlyHint: name !== 'execute_operation', destructiveHint: false, idempotentHint: true } }));
}
export function assertProductAuthority(database, config) {
  const worker = database.prepare('SELECT * FROM gotzji_workers WHERE job_id=?').get(config.jobId);
  const claim = database.prepare('SELECT * FROM gotzji_claims WHERE id=?').get(config.jobId);
  const goal = claim && database.prepare('SELECT * FROM goals WHERE id=?').get(claim.goal_id);
  const writer = database.prepare('SELECT 1 FROM gotzji_writers WHERE job_id=? AND epoch=?').get(config.jobId, config.epoch);
  const operation = database.prepare('SELECT * FROM gotzji_operations WHERE job_id=?').get(config.jobId);
  const authorization = database.prepare('SELECT * FROM gotzji_authorized_jobs WHERE job_id=?').get(config.jobId);
  const expiry = Date.parse(goal?.lease_expires_at);
  if (!worker || !claim || !goal || !writer || claim.policy !== config.policy || claim.input !== JSON.stringify({ requestId: JSON.parse(config.text).input.requestId, operation: 'grace.product-operation', text: config.text }) || operation?.phase !== 'started' || worker.epoch !== config.epoch || worker.generation !== config.generation || goal.status !== 'active' || goal.owner_client_id !== config.owner || goal.lease_owner_session_id !== config.session || goal.user_intent_revision !== config.intentRevision || goal.lease_generation !== config.generation || goal.lease_token_hash !== digest(config.lease) || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('LIVE_AUTHORITY_DENIED');
  if (!authorization || authorization.owner !== config.owner || authorization.intent_digest !== claim.digest || authorization.boundary !== 'local' || authorization.policy !== config.policy || authorization.authorization_digest !== config.authorizationDigest || authorization.intent_revision !== goal.user_intent_revision) throw new Error('DELIVERY_AUTHORITY_DENIED');
  const prepared = JSON.parse(config.text);
  const resources = prepared.kind === 'native' ? prepared.native.resourceKeys : prepared.kind === 'library' ? prepared.library.resources : [];
  for (const resource of resources) {
    if (!database.prepare('SELECT 1 FROM gotzji_resource_claims WHERE resource_key=? AND job_id=? AND epoch=?').get(resource, config.jobId, config.epoch)) throw new Error(prepared.kind === 'library' ? 'LIBRARY_RESOURCE_BINDING_DENIED' : 'NATIVE_RESOURCE_BINDING_DENIED');
  }
  return claim;
}
function targetIsCurrent(operation, config) {
  if (realpathSync(operation.project.rootPath) !== operation.project.rootPath) throw new Error('PROJECT_ROOT_CHANGED');
  const target = path.resolve(operation.project.rootPath, operation.input.path);
  const relative = path.relative(operation.project.rootPath, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || target !== operation.target) throw new Error('FILE_SCOPE_CHANGED');
  for (const root of config.privateRuntimeRoots ?? []) { const protectedRoot=path.resolve(root); const protectedRelative=path.relative(protectedRoot,target); if(!protectedRelative||(!protectedRelative.startsWith('..')&&!path.isAbsolute(protectedRelative))) throw new Error('PRIVATE_RUNTIME_SCOPE_DENIED'); }
  if(operation.beforeSha256===null){const parent=path.dirname(target);if(realpathSync(parent)!==parent||lstatSync(parent).isSymbolicLink()||!lstatSync(parent).isDirectory())throw new Error('FILE_SCOPE_CHANGED');}
  else if(realpathSync(target)!==target||lstatSync(target).isSymbolicLink())throw new Error('FILE_SCOPE_CHANGED');
  return target;
}
export function productBrokerCall(config, name, args, runtimeApproved, runner) {
  if (!runtimeApproved || !PRODUCT_TOOLS.includes(name)) throw new Error('RUNTIME_OR_TOOL_DENIED');
  if (!args || Array.isArray(args) || Object.keys(args).sort().join(',') !== (name === 'read_policy' ? 'document' : '')) throw new Error('ARGUMENTS_DENIED');
  const operation = JSON.parse(config.text);
  assertProductDependencies(config);
  const database = new DatabaseSync(config.database, { timeout: 5000 });
  try {
    database.exec('BEGIN IMMEDIATE;');
    const claim = assertProductAuthority(database, config);
    const project = database.prepare('SELECT registration FROM gotzji_projects WHERE owner=? AND project_id=?').get(config.owner, operation.project.projectId);
    if (!project || String(project.registration) !== JSON.stringify(operation.project)) throw new Error('PROJECT_REGISTRATION_CHANGED');
    const id = name === 'read_policy' ? 'policy:' + args.document : name;
    if (name !== 'read_policy') for (const document of Object.keys(config.grace.documents)) {
      if (!database.prepare('SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=? AND phase=?').get(config.jobId, 'policy:' + document, 'verified')) throw new Error('PREWORK_REQUIRED');
    }
    const payloadDigest = digest(JSON.stringify({ name, args, intent: claim.digest, epoch: config.epoch }));
    const previous = database.prepare('SELECT * FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(config.jobId, id);
    if (previous && previous.digest !== payloadDigest) throw new Error('OPERATION_DIGEST_CONFLICT');
    let result;
    if (name === 'read_policy') {
      const document = config.grace.documents[args.document];
      if (!document) throw new Error('POLICY_DENIED');
      const bytes = readFileSync(document.path);
      if (digest(bytes) !== document.hash) throw new Error('DEPENDENCIES_CHANGED');
      result = { document: args.document, sha256: document.hash, content: bytes.toString('utf8') };
    } else if (name === 'operation_status') {
      if (!database.prepare('SELECT 1 FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=? AND phase=?').get(config.jobId, 'execute_operation', 'verified')) throw new Error('OPERATION_NOT_STARTED');
      result = ['native','library','browser'].includes(operation.kind) ? runner.status() : operation.input.operation === 'command.run' ? runner.state() : JSON.parse(readFileSync(path.join(config.effectRoot, 'result.txt'), 'utf8'));
    } else if (previous?.phase === 'verified' && previous.receipt) result = JSON.parse(previous.receipt);
    else {
      database.prepare('INSERT OR IGNORE INTO gotzji_recipe_operations VALUES (?,?,?,?,NULL)').run(config.jobId, id, payloadDigest, 'reserved');
      if (operation.kind === 'native' || operation.kind === 'library' || operation.kind === 'browser') {
        if (previous?.phase === 'started' && !runner.status()) throw new Error('NATIVE_EFFECT_RECONCILIATION_REQUIRED');
        database.prepare('UPDATE gotzji_recipe_operations SET phase=? WHERE job_id=? AND operation_id=?').run('started', config.jobId, id);
        result = runner.start();
      } else if (operation.input.operation === 'command.run') {
        if (previous?.phase === 'started' && !runner.state()) throw new Error('EFFECT_UNKNOWN');
        database.prepare('UPDATE gotzji_recipe_operations SET phase=? WHERE job_id=? AND operation_id=?').run('started', config.jobId, id);
        result = runner.start();
      } else {
        const target = targetIsCurrent(operation,config);
        // A read returns exactly the bytes whose hash matched the prepared version; reading again could return another version.
        const observed = existsSync(target) ? readFileSync(target) : null;
        const current = observed ? digest(observed) : null;
        if (previous?.phase === 'started' && operation.input.operation === 'file.write' && current === operation.afterSha256) {
          // The exact approved target proves a lost write response; never write twice.
        } else if (current !== operation.beforeSha256) throw new Error('FILE_VERSION_CONFLICT');
        database.prepare('UPDATE gotzji_recipe_operations SET phase=? WHERE job_id=? AND operation_id=?').run('started', config.jobId, id);
        if (operation.input.operation === 'file.write' && current !== operation.afterSha256) {
          if(operation.beforeSha256===null) writeFileSync(target,operation.input.content,{flag:'wx',mode:0o600});
          else {
            const before = path.join(config.effectRoot, 'before.bin');
            if (!existsSync(before)) writeFileSync(before, readFileSync(target), { flag: 'wx', mode: 0o600 });
            if (lstatSync(before).isSymbolicLink() || digest(readFileSync(before)) !== operation.beforeSha256) throw new Error('EFFECT_UNKNOWN');
            const temporary = target + '.gotzji-' + config.epoch;
            try { writeFileSync(temporary, operation.input.content, { flag: 'wx', mode: lstatSync(target).mode }); renameSync(temporary, target); }
            catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error; }
          }
        }
        const bytes = operation.input.operation === 'file.read' ? observed : readFileSync(target);
        result = { operation: operation.input.operation, projectId: operation.project.projectId, path: operation.input.path, sha256: digest(bytes), beforeSha256: operation.beforeSha256, ...(operation.input.operation === 'file.read' ? { content: bytes.toString('utf8') } : { bytes: bytes.length }), state: 'completed' };
        writeFileSync(path.join(config.effectRoot, 'result.txt'), JSON.stringify(result), { mode: 0o600 });
      }
    }
    database.prepare('INSERT INTO gotzji_recipe_operations VALUES (?,?,?,?,?) ON CONFLICT(job_id,operation_id) DO UPDATE SET phase=excluded.phase,receipt=excluded.receipt').run(config.jobId, id, payloadDigest, 'verified', JSON.stringify(result));
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* no open transaction */ }
    if (['ENOENT','EACCES','EPERM','ENOTDIR'].includes(error?.code)) {
      const typed = new Error(error.code === 'ENOENT' ? 'FILE_NOT_FOUND' : error.code === 'ENOTDIR' ? 'PATH_NOT_DIRECTORY' : 'FILE_PERMISSION_DENIED');
      typed.field = 'path'; typed.layer = 'filesystem'; typed.action = 'Check access and the selected path before preparing again';
      throw typed;
    }
    throw error;
  } finally { database.close(); }
}
