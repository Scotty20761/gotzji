import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GotzjiNativeAdapter } from '@lnwjud/capabilities/gotzji-native-adapter';
import { GotzjiCadSessionAdapter } from '@lnwjud/capabilities/gotzji-cad-session-adapter';
import { nativeFileDigest, planGotzjiNativeOperation } from '@lnwjud/capabilities/gotzji-native-contract';
import { assertPreparedNativeAuthorization, productNativeResources } from './product-native.js';
import { replaceFileSync } from './product-security.mjs';

const active = new Map();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => { const a=Buffer.from(left); const b=Buffer.from(right); return a.length===b.length&&timingSafeEqual(a,b); };
/** Called only after product-broker has checked current database/lease/pre-work authority. */
export async function executePreparedNativeOperation(config, signal, options = {}) {
  const prepared = assertPreparedNativeAuthorization(config);
  const testRunner = config.nativeTestRunner ? await loadTestRunner(config) : options.testRunner;
  const key = config.owner + ':' + config.jobId + ':' + config.epoch + ':' + prepared.native.planDigest + ':' + digest(config.token);
  const inFlight = active.get(key); if (inFlight) return inFlight;
  if (testRunner && config.grace.mode !== 'test-driver') throw new Error('NATIVE_TEST_RUNNER_DENIED');
  if (config.grace.mode === 'claude' && typeof options.verifyLiveAuthority !== 'function') throw new Error('NATIVE_LIVE_AUTHORITY_REQUIRED');
  const assertLive = async () => { if (options.verifyLiveAuthority && await options.verifyLiveAuthority() !== true) throw typed('LIVE_AUTHORITY_DENIED', 'none'); };
  const execute = async () => {
    assertEffectRoot(config);
    const previous = readState(config);
    if (previous) {
      if (previous.state === 'completed' && previous.receipt) {
        if ('outputPath' in prepared.native.input && await nativeFileDigest(prepared.native.input.outputPath) !== previous.receipt.nativeReceipt?.outputSha256) throw typed('NATIVE_ARTIFACT_CHANGED', 'unknown');
        return previous.receipt;
      }
      if (previous.state === 'started' || previous.state === 'uncertain') throw typed('NATIVE_EFFECT_RECONCILIATION_REQUIRED', 'unknown');
    }
    const current = await planGotzjiNativeOperation(prepared.native.input, prepared.project.rootPath);
    if (current.digest !== prepared.native.planDigest || JSON.stringify(current.resourceKeys) !== JSON.stringify(prepared.native.adapterResourceKeys)
      || JSON.stringify(productNativeResources(prepared.project, current)) !== JSON.stringify(prepared.native.resourceKeys)) throw typed('NATIVE_RESOURCE_BINDING_DENIED', 'none');
    const proof = config.nativeAuthorization.mac;
    const grant = { ownerId: config.owner, projectId: prepared.project.projectId, jobId: config.jobId, operationId: prepared.native.planDigest, rootPath: prepared.project.rootPath, proof };
    const providerOptions = { scriptPath: prepared.native.scriptPath, scriptSha256: prepared.native.scriptSha256,
      verifyGrant: async (selected, intentDigest, resources) => {
        // This is a verification function, not an unconditional production grant.
        const authorized = assertPreparedNativeAuthorization(config);
        if (options.verifyLiveAuthority && await options.verifyLiveAuthority() !== true) return false;
        return selected.ownerId === config.owner && selected.projectId === authorized.project.projectId && selected.jobId === config.jobId
          && selected.operationId === authorized.native.planDigest && selected.rootPath === authorized.project.rootPath && equal(selected.proof, config.nativeAuthorization.mac)
          && intentDigest === authorized.native.planDigest && JSON.stringify(resources) === JSON.stringify(authorized.native.adapterResourceKeys);
      }, ...(testRunner ? { runner: testRunner } : {}) };
    if (prepared.input.operation.startsWith('cad.') && (!prepared.native.cad || prepared.native.provider !== 'cad-session')) throw typed('NATIVE_PROVIDER_NOT_CONFIGURED', 'none');
    const adapter = prepared.native.provider === 'cad-session' ? new GotzjiCadSessionAdapter({ ...providerOptions, ...prepared.native.cad }) : new GotzjiNativeAdapter(providerOptions);
    await assertLive();
    writeState(config, prepared, { state: 'started', outcome: 'unknown' });
    try {
      const nativeReceipt = await adapter.execute(grant, prepared.native.input, signal);
      try { await assertLive(); } catch { throw typed('LIVE_AUTHORITY_DENIED', 'unknown'); }
      const receipt = { operation: prepared.input.operation, projectId: prepared.project.projectId, path: prepared.input.path,
        ...(prepared.input.outputPath ? { outputPath: prepared.input.outputPath } : {}), state: 'completed', jobId: config.jobId, epoch: config.epoch,
        intentDigest: prepared.native.planDigest, scriptSha256: prepared.native.scriptSha256, resourceKeys: prepared.native.resourceKeys, nativeReceipt };
      writeState(config, prepared, { state: 'completed', outcome: 'verified', receipt });
      return receipt;
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'NATIVE_PROVIDER_FAILED';
      const outcome = error?.outcome === 'none' ? 'none' : 'unknown';
      writeState(config, prepared, { state: outcome === 'unknown' ? 'uncertain' : 'not-started', outcome, code,
        ...(typeof error?.field === 'string' ? { field: error.field } : {}) });
      throw typed(code, outcome);
    }
  };
  const promise = execute(); active.set(key, promise);
  try { return await promise; } finally { if (active.get(key) === promise) active.delete(key); }
}
export function readPreparedNativeState(config) { assertPreparedNativeAuthorization(config); assertEffectRoot(config); return readState(config); }
async function loadTestRunner(config) {
  if (config.grace.mode !== 'test-driver') throw new Error('NATIVE_TEST_RUNNER_DENIED');
  const binding = config.nativeTestRunner;
  const verify = () => {
    const info = lstatSync(binding.path);
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(binding.path) !== path.resolve(binding.path) || digest(readFileSync(binding.path)) !== binding.sha256) throw new Error('NATIVE_TEST_RUNNER_CHANGED');
  };
  verify();
  const module = await import(pathToFileURL(binding.path).href + '?sha256=' + binding.sha256);
  verify();
  if (typeof module.testRunner !== 'function') throw new Error('NATIVE_TEST_RUNNER_INVALID');
  return module.testRunner;
}
function assertEffectRoot(config) {
  if (!path.isAbsolute(config.effectRoot) || realpathSync(config.effectRoot) !== path.resolve(config.effectRoot) || !lstatSync(config.effectRoot).isDirectory() || lstatSync(config.effectRoot).isSymbolicLink()) throw new Error('NATIVE_EFFECT_ROOT_CHANGED');
}
function readState(config) {
  const filename=path.join(config.effectRoot,'native-operation.json'); if(!existsSync(filename)) return undefined;
  if(lstatSync(filename).isSymbolicLink()||realpathSync(filename)!==path.resolve(filename)) throw typed('NATIVE_EVIDENCE_INVALID','unknown');
  const envelope=JSON.parse(readFileSync(filename,'utf8'));
  if(typeof envelope.body!=='string'||typeof envelope.mac!=='string'||!equal(createHmac('sha256',config.token).update(envelope.body).digest('hex'),envelope.mac)) throw typed('NATIVE_EVIDENCE_INVALID','unknown');
  const state=JSON.parse(envelope.body);
  if(state.jobId!==config.jobId||state.epoch!==config.epoch||state.intentDigest!==JSON.parse(config.text).native.planDigest) throw typed('NATIVE_EVIDENCE_INVALID','unknown');
  return state;
}
function writeState(config, prepared, value) {
  const body=JSON.stringify({jobId:config.jobId,epoch:config.epoch,generation:config.generation,intentDigest:prepared.native.planDigest,resourceKeys:prepared.native.resourceKeys,scriptSha256:prepared.native.scriptSha256,...value});
  const record=JSON.stringify({body,mac:createHmac('sha256',config.token).update(body).digest('hex')});
  const temporary=path.join(config.effectRoot,'.native-'+randomUUID()+'.tmp'); writeFileSync(temporary,record,{flag:'wx',mode:0o600}); replaceFileSync(temporary,path.join(config.effectRoot,'native-operation.json'));
}
function typed(code,outcome) { const error=new Error(code); error.code=code; error.outcome=outcome; return error; }
