/* global process, setTimeout */
import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GotzjiNativeAdapter, GotzjiNativeNoLaunchError } from '@lnwjud/capabilities/gotzji-native-adapter';
import { GotzjiCadSessionAdapter } from '@lnwjud/capabilities/gotzji-cad-session-adapter';
import { nativeFileDigest, planGotzjiNativeOperation } from '@lnwjud/capabilities/gotzji-native-contract';
import { assertPreparedNativeAuthorization, productNativeResources } from './product-native.js';
import { replaceFileSync } from './product-security.mjs';
import { processIdentities, sameProcessIdentity } from './process-identity.mjs';

const active = new Map();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => { const a=Buffer.from(left); const b=Buffer.from(right); return a.length===b.length&&timingSafeEqual(a,b); };
const PROCESS_JOURNAL = 'native-process-identities.jsonl';
/** Called only after product-broker has checked current database/lease/pre-work authority. */
export async function executePreparedNativeOperation(config, signal, options = {}) {
  const prepared = assertPreparedNativeAuthorization(config);
  const testRunner = config.nativeTestRunner ? await loadTestRunner(config) : options.testRunner;
  const key = config.owner + ':' + config.jobId + ':' + config.epoch + ':' + prepared.native.planDigest + ':' + digest(config.token);
  const inFlight = active.get(key); if (inFlight) return inFlight;
  if (testRunner && !(config.grace.mode === 'test-driver' || (config.grace.mode === 'host-direct' && config.grace.testOnlyProviders === true))) throw new Error('NATIVE_TEST_RUNNER_DENIED');
  if (['claude','host-direct'].includes(config.grace.mode) && typeof options.verifyLiveAuthority !== 'function') throw new Error('NATIVE_LIVE_AUTHORITY_REQUIRED');
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
    const processEvidence = nativeProcessEvidenceBinding(config, prepared);
    const beforeProviderSpawn = async (attempt) => { markNativeProviderDispatched(config, prepared, attempt); };
    const runner = testRunner ? async (script, input, providerSignal, evidence, beforeSpawn) => { await beforeSpawn?.(); return testRunner(script, input, providerSignal, evidence); } : undefined;
    const providerOptions = { scriptPath: prepared.native.scriptPath, scriptSha256: prepared.native.scriptSha256,
      processEvidence, beforeProviderSpawn,
      verifyGrant: async (selected, intentDigest, resources) => {
        // This is a verification function, not an unconditional production grant.
        const authorized = assertPreparedNativeAuthorization(config);
        if (options.verifyLiveAuthority && await options.verifyLiveAuthority() !== true) return false;
        return selected.ownerId === config.owner && selected.projectId === authorized.project.projectId && selected.jobId === config.jobId
          && selected.operationId === authorized.native.planDigest && selected.rootPath === authorized.project.rootPath && equal(selected.proof, config.nativeAuthorization.mac)
          && intentDigest === authorized.native.planDigest && JSON.stringify(resources) === JSON.stringify(authorized.native.adapterResourceKeys);
      }, ...(runner ? { runner } : {}) };
    if (prepared.input.operation.startsWith('cad.') && (!prepared.native.cad || prepared.native.provider !== 'cad-session')) throw typed('NATIVE_PROVIDER_NOT_CONFIGURED', 'none');
    const adapter = prepared.native.provider === 'cad-session' ? new GotzjiCadSessionAdapter({ ...providerOptions, ...prepared.native.cad }) : new GotzjiNativeAdapter(providerOptions);
    await assertLive();
    writeState(config, prepared, { state: 'started', outcome: 'unknown', dispatch: 'pre-dispatch', dispatchAttempt: 0 });
    try {
      const nativeReceipt = await adapter.execute(grant, prepared.native.input, signal);
      const stop = testRunner ? testDriverStopEvidence('none', prepared) : await inspectPreparedNativeStop(config, prepared, processEvidence);
      if (stop.stopEvidence.observed !== 'absent') throw typed('NATIVE_TERMINATION_UNVERIFIED', 'unknown', stop);
      try { await assertLive(); } catch { throw typed('LIVE_AUTHORITY_DENIED', 'unknown'); }
      const receipt = { operation: prepared.input.operation, projectId: prepared.project.projectId, path: prepared.input.path,
        ...(prepared.input.outputPath ? { outputPath: prepared.input.outputPath } : {}), state: 'completed', jobId: config.jobId, epoch: config.epoch,
        intentDigest: prepared.native.planDigest, scriptSha256: prepared.native.scriptSha256, resourceKeys: prepared.native.resourceKeys, nativeReceipt };
      const completedState = readState(config);
      writeState(config, prepared, { state: 'completed', outcome: 'verified', dispatch: 'dispatched', dispatchAttempt: completedState?.dispatchAttempt, receipt, stopEvidence: stop.stopEvidence, effectEvidence: stop.effectEvidence });
      return receipt;
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'NATIVE_PROVIDER_FAILED';
      const providerState = readState(config);
      const trustedNoLaunch = !testRunner && error instanceof GotzjiNativeNoLaunchError && providerState?.dispatch === 'dispatched'
        && providerState.dispatchAttempt === 1 && journalIsAbsent(processEvidence.journalPath);
      const stop = trustedNoLaunch ? stopResult('pre-dispatch', inspectNativeEffect(prepared), { reason: 'host-confirmed-first-spawn-no-launch', identityCount: 0,
        identityDigest: null, verifier: 'host-signed-pre-dispatch-v1' })
        : error?.stopEvidence && error?.effectEvidence ? { stopEvidence: error.stopEvidence, effectEvidence: error.effectEvidence, outcome: error.outcome }
          : testRunner ? testDriverStopEvidence(errorOutcome(error), prepared) : await inspectPreparedNativeStop(config, prepared, processEvidence, providerState);
      const outcome = stop.outcome === 'none' ? 'none' : 'unknown';
      writeState(config, prepared, { state: outcome === 'unknown' ? 'uncertain' : 'not-started', outcome, code,
        dispatch: trustedNoLaunch ? 'pre-dispatch' : providerState?.dispatch ?? 'pre-dispatch', dispatchAttempt: trustedNoLaunch ? 0 : providerState?.dispatchAttempt ?? 0,
        ...(typeof error?.field === 'string' ? { field: error.field } : {}), stopEvidence: stop.stopEvidence, effectEvidence: stop.effectEvidence });
      throw typed(code, outcome, stop);
    }
  };
  const promise = execute(); active.set(key, promise);
  try { return await promise; } finally { if (active.get(key) === promise) active.delete(key); }
}
export function readPreparedNativeState(config) { assertPreparedNativeAuthorization(config); assertEffectRoot(config); return readState(config); }
/** Re-check an already-started native operation without replaying its provider. Used by repeated stop after an
 * initially live/unknown Office or CAD identity has later disappeared. The signed state remains uncertain unless
 * process termination and the no-effect file conditions are both independently proven. */
export async function reconcilePreparedNativeStop(config) {
  const prepared = assertPreparedNativeAuthorization(config); assertEffectRoot(config);
  const previous = readState(config);
  const binding = nativeProcessEvidenceBinding(config, prepared);
  const stop = (config.grace.mode === 'test-driver' || (config.grace.mode === 'host-direct' && config.grace.testOnlyProviders === true)) ? testDriverStopEvidence(previous?.outcome, prepared, previous?.stopEvidence) : await inspectPreparedNativeStop(config, prepared, binding, previous);
  if (previous?.state !== 'completed') writeState(config, prepared, { state: stop.outcome === 'none' ? 'not-started' : 'uncertain', outcome: stop.outcome,
    dispatch: previous?.dispatch, dispatchAttempt: previous?.dispatchAttempt, code: previous?.code ?? 'NATIVE_TERMINATION_UNCONFIRMED', ...(typeof previous?.field === 'string' ? { field: previous.field } : {}), stopEvidence: stop.stopEvidence, effectEvidence: stop.effectEvidence });
  return previous?.state === 'completed' ? { ...stop, outcome: 'verified' } : stop;
}
function nativeProcessEvidenceBinding(config, prepared) {
  const publicBinding = { schemaVersion: 1, effectRoot: config.effectRoot, journalPath: path.join(config.effectRoot, PROCESS_JOURNAL), jobId: config.jobId,
    epoch: config.epoch, generation: config.generation, planDigest: prepared.native.planDigest, provider: prepared.native.provider };
  const evidenceKey = createHmac('sha256', Buffer.from(config.token, 'hex')).update('gotzji-native-process-evidence-v1\0').update(JSON.stringify(publicBinding)).digest('hex');
  return { ...publicBinding, evidenceKey };
}
function markNativeProviderDispatched(config, prepared, attempt) {
  assertPreparedNativeAuthorization(config); assertEffectRoot(config);
  const state = readState(config);
  if (!state || state.state !== 'started' || !['pre-dispatch','dispatched'].includes(state.dispatch)) throw typed('NATIVE_DISPATCH_BOUNDARY_INVALID', 'unknown');
  const previousAttempt = Number.isSafeInteger(state.dispatchAttempt) ? state.dispatchAttempt : 0;
  if (!Number.isSafeInteger(attempt) || attempt !== previousAttempt + 1) throw typed('NATIVE_DISPATCH_BOUNDARY_INVALID', 'unknown');
  writeState(config, prepared, { state: 'started', outcome: 'unknown', dispatch: 'dispatched', dispatchAttempt: attempt });
}
function journalIsAbsent(filename) { try { lstatSync(filename); return false; } catch (error) { return error?.code === 'ENOENT'; } }
async function inspectPreparedNativeStop(config, prepared, binding, providerState) {
  let journal;
  try { journal = readNativeIdentityJournal(binding); }
  catch (error) {
    const effectEvidence = inspectNativeEffect(prepared);
    if (safeEvidenceReason(error) === 'missing' && providerState?.dispatch === 'pre-dispatch') return stopResult('pre-dispatch', effectEvidence,
      { reason: 'signed-pre-dispatch', identityCount: 0, identityDigest: null, verifier: 'host-signed-pre-dispatch-v1' });
    return stopResult('unknown', effectEvidence, { reason: safeEvidenceReason(error), identityCount: 0, identityDigest: null });
  }
  let state = 'unknown';
  for (let attempt = 0; attempt < 50; attempt++) {
    let observed;
    try { observed = await processIdentities(journal.identities.map((identity) => identity.pid)); }
    catch { observed = Object.fromEntries(journal.identities.map((identity) => [identity.pid, 'unknown'])); }
    state = 'absent';
    for (const identity of journal.identities) {
      const current = observed[identity.pid];
      if (current === undefined || current === 'unknown') { state = state === 'alive' ? state : 'unknown'; continue; }
      if (sameProcessIdentity(identity, current)) state = 'alive';
    }
    if (state === 'absent' || (state === 'unknown' && attempt >= 2)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Read file effects only after the exact process observation. A provider that writes while its process is being
  // waited out must never receive a stale no-effect receipt.
  const effectEvidence = inspectNativeEffect(prepared);
  return stopResult(state, effectEvidence, { identityCount: journal.identities.length, identityDigest: journal.digest });
}
function readNativeIdentityJournal(binding) {
  const filename = binding.journalPath;
  if (!existsSync(filename)) throw evidenceError('missing');
  const expected = path.resolve(filename); const before = lstatSync(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || realpathSync(filename) !== expected || before.size < 1n || before.size > 1024n * 1024n) throw evidenceError('invalid-file');
  let descriptor; let bytes; let opened; let after;
  try {
    descriptor = openSync(filename, 'r'); opened = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(before, opened) || opened.nlink !== 1n) throw evidenceError('file-identity');
    bytes = readFileSync(descriptor); after = fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(opened, after) || after.nlink !== 1n) throw evidenceError('file-changed');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
  const final = lstatSync(filename, { bigint: true });
  if (!sameFileSnapshot(after, final) || final.nlink !== 1n || final.isSymbolicLink() || realpathSync(filename) !== expected) throw evidenceError('file-changed');
  const lines = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean);
  if (!lines.length || lines.length > 32) throw evidenceError('invalid-count');
  const identities = []; const invocations = new Set();
  for (const line of lines) {
    let envelope; let body;
    try { envelope = JSON.parse(line); body = JSON.parse(envelope.body); } catch { throw evidenceError('malformed'); }
    if (!envelope || typeof envelope.body !== 'string' || typeof envelope.mac !== 'string'
      || !equal(createHmac('sha256', Buffer.from(binding.evidenceKey, 'hex')).update(envelope.body).digest('hex'), envelope.mac)) throw evidenceError('mac');
    if (body?.schemaVersion !== 1 || body.recordType !== 'identity' || body.jobId !== binding.jobId || body.epoch !== binding.epoch
      || body.generation !== binding.generation || body.planDigest !== binding.planDigest || body.provider !== binding.provider
      || typeof body.invocationId !== 'string' || !/^[0-9a-f-]{36}$/u.test(body.invocationId) || invocations.has(body.invocationId)
      || !Number.isSafeInteger(body.pid) || body.pid < 1 || typeof body.birth !== 'string' || !body.birth || body.birth.length > 256
      || typeof body.executable !== 'string' || !path.isAbsolute(body.executable) || body.executable.includes('\0')) throw evidenceError('binding');
    invocations.add(body.invocationId); identities.push({ pid: body.pid, birth: body.birth, executable: process.platform === 'win32' ? body.executable.toLowerCase() : body.executable });
  }
  return { identities, digest: digest(bytes) };
}
function sameFileIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs; }
function sameFileSnapshot(left, right) { return sameFileIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs; }
function inspectNativeEffect(prepared) {
  const source = inspectFile(prepared.native.input.filePath, prepared.native.input.expectedSha256, false);
  const output = 'outputPath' in prepared.native.input ? inspectFile(prepared.native.input.outputPath, undefined, true) : 'not-applicable';
  return { source, output };
}
function inspectFile(filename, expected, absenceOnly) {
  try {
    const metadata = lstatSync(filename);
    if (metadata.isSymbolicLink() || !metadata.isFile() || realpathSync(filename) !== path.resolve(filename)) return 'unknown';
    if (absenceOnly) return 'present';
    return digest(readFileSync(filename)) === expected ? 'unchanged' : 'changed';
  } catch (error) { return error?.code === 'ENOENT' ? (absenceOnly ? 'absent' : 'missing') : 'unknown'; }
}
function stopResult(observed, effectEvidence, extra) {
  const stopEvidence = { schemaVersion: 1, observed, checkedAt: new Date().toISOString(), ...extra };
  const noEffect = ['absent','pre-dispatch'].includes(observed) && effectEvidence.source === 'unchanged' && ['absent','not-applicable'].includes(effectEvidence.output);
  return { outcome: noEffect ? 'none' : 'unknown', stopEvidence, effectEvidence };
}
function testDriverStopEvidence(outcome, prepared, previousStopEvidence) {
  const observed = previousStopEvidence?.observed === 'absent' || outcome === 'none' ? 'absent' : 'unknown';
  return stopResult(observed, inspectNativeEffect(prepared), { identityCount: previousStopEvidence?.identityCount ?? 0,
    identityDigest: previousStopEvidence?.identityDigest ?? null, verifier: 'test-driver' });
}
function errorOutcome(error) { return error?.outcome === 'none' ? 'none' : 'unknown'; }
function evidenceError(reason) { const error = new Error('NATIVE_PROCESS_EVIDENCE_INVALID'); error.evidenceReason = reason; return error; }
function safeEvidenceReason(error) { return typeof error?.evidenceReason === 'string' ? error.evidenceReason : 'unavailable'; }
async function loadTestRunner(config) {
  if (!(config.grace.mode === 'test-driver' || (config.grace.mode === 'host-direct' && config.grace.testOnlyProviders === true))) throw new Error('NATIVE_TEST_RUNNER_DENIED');
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
  const prepared=JSON.parse(config.text);
  if(state.jobId!==config.jobId||state.epoch!==config.epoch||state.generation!==config.generation||state.intentDigest!==prepared.native.planDigest
    ||state.scriptSha256!==prepared.native.scriptSha256||JSON.stringify(state.resourceKeys)!==JSON.stringify(prepared.native.resourceKeys)
    ||state.dispatch==='pre-dispatch'&&state.dispatchAttempt!==0||state.dispatch==='dispatched'&&(!Number.isSafeInteger(state.dispatchAttempt)||state.dispatchAttempt<1)) throw typed('NATIVE_EVIDENCE_INVALID','unknown');
  return state;
}
function writeState(config, prepared, value) {
  const body=JSON.stringify({jobId:config.jobId,epoch:config.epoch,generation:config.generation,intentDigest:prepared.native.planDigest,resourceKeys:prepared.native.resourceKeys,scriptSha256:prepared.native.scriptSha256,...value});
  const record=JSON.stringify({body,mac:createHmac('sha256',config.token).update(body).digest('hex')});
  const temporary=path.join(config.effectRoot,'.native-'+randomUUID()+'.tmp'); writeFileSync(temporary,record,{flag:'wx',mode:0o600}); replaceFileSync(temporary,path.join(config.effectRoot,'native-operation.json'));
}
function typed(code,outcome,details) { const error=new Error(code); error.code=code; error.outcome=outcome; if(details?.stopEvidence)error.stopEvidence=details.stopEvidence;if(details?.effectEvidence)error.effectEvidence=details.effectEvidence;return error; }
