/* global AbortSignal, Buffer, process, setTimeout */
import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GotzjiBrowserProvider, planGotzjiBrowserOperation, validateGotzjiBrowserScope, assertGotzjiBrowserUrlScope } from '@lnwjud/capabilities/gotzji-browser-provider-policy';
import { GotzjiBrowserCdpTransport } from '@lnwjud/capabilities/gotzji-browser-provider-cdp';
import { startGotzjiOwnedBrowser, stopGotzjiOwnedBrowserProcess } from '@lnwjud/capabilities/gotzji-browser-provider-session';
import { NodeBrowserCdpProtocol } from '@lnwjud/capabilities';
import { nativeDigest, nativeFileDigest } from '@lnwjud/capabilities/gotzji-native-contract';
import { assertPreparedBrowserAuthorization, productBrowserResources } from './product-browser.js';
import { replaceFileSync } from './product-security.mjs';

const active = new Map();
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };

/** App-only trusted composition. Host must check canonical active/uncertain context claims before calling stop(). */
export async function createTrustedProductBrowserEnrollment(project, launch) {
  if (!project?.owner || !project.projectId || !project.resourceKey || !await pinned(launch.chromeExecutable, launch.executableSha256)
    || !Array.isArray(launch.prerequisites) || !launch.prerequisites.length) throw typed('BROWSER_PREREQUISITE_CHANGED', 'none');
  for (const entry of launch.prerequisites) if (!await pinned(entry.path, entry.hash)) throw typed('BROWSER_PREREQUISITE_CHANGED', 'none');
  const driver = await startGotzjiOwnedBrowser({ profileParent: launch.profileParent, chromeExecutable: launch.chromeExecutable,
    allowedOrigins: launch.allowedOrigins, ...(launch.startUrl === undefined ? {} : { startUrl: launch.startUrl }), ...(launch.headless === undefined ? {} : { headless: launch.headless }) });
  let selected;
  const refresh = async () => {
    const session = await captureOwnedProductBrowserSession(driver, project.owner, project.projectId, selected);
    if (session.executableSha256 !== launch.executableSha256) throw typed('BROWSER_PREREQUISITE_CHANGED', 'none');
    const manifestPath = path.join(path.dirname(driver.profilePath), 'browser-manifest-' + randomUUID() + '.json');
    const manifest = JSON.stringify(session); writeFileSync(manifestPath, manifest, { flag: 'wx', mode: 0o600 });
    const options = { session, manifestPath, manifestSha256: hash(manifest), prerequisites: launch.prerequisites.map(entry => ({ ...entry })),
      verifyOwnedSession: async value => value.sessionId === driver.contextId && await driver.verifyOwnership() && await verifyOwnedProductBrowserSession(value),
      ...(launch.deadlineMs === undefined ? {} : { deadlineMs: launch.deadlineMs }) };
    const publicBinding = { sessionId: session.sessionId, tabId: session.binding.tabId, expectedUrl: session.binding.url, expectedDocumentId: session.binding.documentId, allowedOrigins: [...session.allowedOrigins] };
    return { options, publicBinding };
  };
  try {
    const candidates = (await driver.protocol.listTabs()).filter(tab => tab.url === driver.startUrl);
    if (candidates.length !== 1) throw typed('BROWSER_TAB_MISSING', 'none'); selected = candidates[0].id;
    let initial;
    for (let attempt = 0; attempt < 20; attempt++) { try { initial = await refresh(); break; } catch (error) { if (error.code !== 'BROWSER_DOCUMENT_CHANGED') throw error; await new Promise(resolve => setTimeout(resolve, 100)); } }
    if (!initial) throw typed('BROWSER_NAVIGATION_TIMEOUT', 'none');
    return { ...initial, refresh, stop: driver.stop };
  } catch (error) { try { await driver.stop(); } catch { throw typed('BROWSER_TERMINATION_UNVERIFIED', 'unknown'); } throw error; }
}

/** Only privately persisted, owner-validated enrollment may be restored. Never launches or adopts a browser. */
export async function restoreTrustedProductBrowserEnrollment(project, options) {
  if (!options?.session || options.session.owner !== project?.owner || options.session.projectId !== project?.projectId
    || !Array.isArray(options.prerequisites) || !options.prerequisites.length) throw typed('BROWSER_SESSION_UNVERIFIED', 'none');
  await assertPins({ browser: options });
  if (!await verifyOwnedProductBrowserSession(options.session)) throw typed('BROWSER_SESSION_UNVERIFIED', 'none');
  const session = options.session;
  const protocol = new NodeBrowserCdpProtocol({ port: session.port, profileDir: session.profilePath, chromeExecutable: session.executable });
  const own = async value => value.owner === project.owner && value.projectId === project.projectId && value.sessionId === session.sessionId && await verifyOwnedProductBrowserSession(value);
  const transport = new GotzjiBrowserCdpTransport(protocol, { browserId: session.binding.browserId, contextId: session.binding.contextId, profileId: session.binding.profileId,
    tabId: session.binding.tabId, providerTabId: session.binding.providerTabId, cdpBrowserContextId: session.cdpBrowserContextId }, async () => own(session));
  if (JSON.stringify(await transport.binding()) !== JSON.stringify(session.binding)) throw typed('BROWSER_DOCUMENT_CHANGED', 'none');
  const publicBinding = value => ({ sessionId: value.session.sessionId, tabId: value.session.binding.tabId, expectedUrl: value.session.binding.url,
    expectedDocumentId: value.session.binding.documentId, allowedOrigins: [...value.session.allowedOrigins] });
  const restored = { ...options, verifyOwnedSession: own };
  const refresh = async () => {
    await assertPins({ browser: options }); if (!await own(session)) throw typed('BROWSER_SESSION_UNVERIFIED', 'none');
    const latest = { ...session, binding: await transport.binding() }; assertGotzjiBrowserUrlScope(latest.binding.url, latest);
    const manifestPath = path.join(path.dirname(options.manifestPath), 'browser-manifest-' + randomUUID() + '.json');
    const body = JSON.stringify(latest); writeFileSync(manifestPath, body, { flag: 'wx', mode: 0o600 });
    const next = { ...options, session: latest, manifestPath, manifestSha256: hash(body), verifyOwnedSession: own };
    return { options: next, publicBinding: publicBinding(next) };
  };
  return { options: restored, publicBinding: publicBinding(restored), refresh,
    stop: () => stopGotzjiOwnedBrowserProcess({ pid: session.pid, pidBirth: session.pidBirth, tabId: session.binding.tabId, protocol }, async () => { await assertPins({ browser: options }); return own(session); }) };
}

/** Trusted host helper for a fresh driver it already owns. Returned native facts are then pinned in a private manifest. */
export async function captureOwnedProductBrowserSession(driver, owner, projectId, tabId) {
  if (!driver || typeof driver.verifyOwnership !== 'function' || !await driver.verifyOwnership() || !owner || !projectId || !tabId) throw typed('BROWSER_SESSION_UNVERIFIED', 'none');
  const native = await processIdentity(driver.pid);
  if (!native || native.pid !== driver.pid || typeof native.birth !== 'string' || typeof native.executable !== 'string') throw typed('BROWSER_SESSION_UNVERIFIED', 'none');
  const target = await driver.protocol.request(tabId, 'Target.getTargetInfo', { targetId: tabId });
  if (target?.result?.targetInfo?.targetId !== tabId || target.result.targetInfo.type !== 'page') throw typed('BROWSER_TAB_MISSING', 'none');
  const cdpBrowserContextId = target.result.targetInfo.browserContextId ?? '';
  const transport = new GotzjiBrowserCdpTransport(driver.protocol, { browserId: driver.browserId, contextId: driver.contextId, profileId: driver.profileId, tabId, providerTabId: tabId, cdpBrowserContextId }, driver.verifyOwnership);
  const binding = await transport.binding();
  const session = { schemaVersion: 1, sessionId: driver.contextId, owner, projectId, pid: driver.pid, pidBirth: native.birth,
    executable: native.executable, executableSha256: await nativeFileDigest(native.executable), profilePath: driver.profilePath, port: driver.port, cdpBrowserContextId, binding, allowedOrigins: [...driver.allowedOrigins], fixtureMode: driver.fixtureMode };
  if (!await driver.verifyOwnership() || !await verifyOwnedProductBrowserSession(session)) throw typed('BROWSER_SESSION_UNVERIFIED', 'none');
  return session;
}

/** Exact host-enrolled PID birth, executable bytes, private blank profile and coordination port. No ambient browser adoption. */
export async function verifyOwnedProductBrowserSession(session) {
  if (process.platform !== 'win32' || !session || !Number.isSafeInteger(session.pid) || session.pid < 1) return false;
  try {
    validateGotzjiBrowserScope(session); assertGotzjiBrowserUrlScope(session.binding.url, session);
    const profile = realpathSync(session.profilePath);
    if (profile !== path.resolve(session.profilePath) || lstatSync(profile).isSymbolicLink() || !lstatSync(profile).isDirectory()
      || !/(?:^|[\\/])gotzji(?:[\\/]|$)/i.test(profile) || !path.basename(profile).startsWith('gotzji-browser-provider-')
      || nativeDigest(profile.toLowerCase()) !== session.binding.profileId || !await pinned(session.executable, session.executableSha256)) return false;
    const portFile = path.join(profile, 'DevToolsActivePort');
    if (lstatSync(portFile).isSymbolicLink() || Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]) !== session.port) return false;
    const native = await processIdentity(session.pid);
    if (!native || native.pid !== session.pid || native.birth !== session.pidBirth || typeof native.executable !== 'string'
      || path.resolve(native.executable).toLowerCase() !== path.resolve(session.executable).toLowerCase() || typeof native.commandLine !== 'string') return false;
    const profiles = [...native.commandLine.matchAll(/(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir=(?:"([^"]+)"|([^\s"]+)))(?=\s|$)/g)].map(match => match[1] ?? match[2] ?? match[3]);
    return profiles.length === 1 && path.resolve(profiles[0]).toLowerCase() === profile.toLowerCase()
      && /(?:^|\s)--remote-debugging-port=0(?:\s|$)/.test(native.commandLine);
  } catch { return false; }
}
export async function executePreparedBrowserOperation(config, signal, options = {}) {
  const prepared = assertPreparedBrowserAuthorization(config);
  if (typeof options.verifyLiveAuthority !== 'function' || typeof options.verifyOwnedSession !== 'function') throw typed('BROWSER_LIVE_AUTHORITY_REQUIRED', 'none');
  const testTransport = config.browserTestTransport ? await loadTestTransport(config) : options.testTransport;
  if (testTransport && config.grace.mode !== 'test-driver') throw typed('BROWSER_TEST_TRANSPORT_DENIED', 'none');
  const key = config.owner + ':' + config.jobId + ':' + config.epoch + ':' + prepared.browser.planDigest + ':' + hash(config.token);
  if (active.has(key)) return active.get(key);
  const assertLive = async () => {
    assertPreparedBrowserAuthorization(config);
    await assertPins(prepared);
    if (await options.verifyLiveAuthority() !== true) throw typed('LIVE_AUTHORITY_DENIED', 'none');
    if (await options.verifyOwnedSession(prepared.browser.session) !== true || (!testTransport && options.verifyOwnedSession !== verifyOwnedProductBrowserSession && !await verifyOwnedProductBrowserSession(prepared.browser.session))) throw typed('BROWSER_SESSION_UNVERIFIED', 'none');
  };
  const execute = async () => {
    assertEffectRoot(config);
    const previous = readState(config);
    if (previous?.state === 'completed' && previous.receipt) { await assertLive(); return previous.receipt; }
    if (previous?.state === 'started' || previous?.state === 'uncertain') throw typed('BROWSER_EFFECT_RECONCILIATION_REQUIRED', 'unknown');
    const plan = planGotzjiBrowserOperation(prepared.browser.input, nativeDigest);
    if (plan.digest !== prepared.browser.planDigest || JSON.stringify(plan.resourceKeys) !== JSON.stringify(prepared.browser.adapterResourceKeys)
      || JSON.stringify(productBrowserResources(prepared.project, plan)) !== JSON.stringify(prepared.browser.resourceKeys)) throw typed('BROWSER_RESOURCE_BINDING_DENIED', 'none');
    await assertLive();
    const session = prepared.browser.session;
    const transport = testTransport ?? new GotzjiBrowserCdpTransport(new NodeBrowserCdpProtocol({ port: session.port, profileDir: session.profilePath, chromeExecutable: session.executable }),
      { browserId: session.binding.browserId, contextId: session.binding.contextId, profileId: session.binding.profileId, tabId: session.binding.tabId, providerTabId: session.binding.providerTabId, cdpBrowserContextId: session.cdpBrowserContextId }, async () => { await assertLive(); return true; });
    const grant = { ownerId: config.owner, projectId: prepared.project.projectId, jobId: config.jobId, operationId: prepared.browser.planDigest, rootPath: prepared.project.rootPath, proof: config.browserAuthorization.mac };
    const provider = new GotzjiBrowserProvider(transport, nativeDigest, async (selected, intentDigest, resources) => {
      const authorized = assertPreparedBrowserAuthorization(config);
      await assertLive();
      return selected.ownerId === config.owner && selected.projectId === authorized.project.projectId && selected.jobId === config.jobId && selected.operationId === authorized.browser.planDigest
        && selected.rootPath === authorized.project.rootPath && equal(selected.proof, config.browserAuthorization.mac)
        && intentDigest === authorized.browser.planDigest && JSON.stringify(resources) === JSON.stringify(authorized.browser.adapterResourceKeys);
    }, { allowedOrigins: session.allowedOrigins, fixtureMode: session.fixtureMode });
    const bounded = AbortSignal.timeout(prepared.browser.deadlineMs);
    const operationSignal = signal ? AbortSignal.any([signal, bounded]) : bounded;
    writeState(config, { state: 'started', outcome: 'unknown' });
    options.onProgress?.({ phase: 'browser_provider_started', at: new Date().toISOString() });
    try {
      const browserReceipt = await provider.execute(grant, plan.input, operationSignal);
      try { await assertLive(); } catch { throw typed('LIVE_AUTHORITY_DENIED', 'unknown'); }
      const receipt = { operation: prepared.input.operation, projectId: prepared.project.projectId, sessionId: prepared.input.sessionId, tabId: prepared.input.tabId,
        state: 'completed', jobId: config.jobId, epoch: config.epoch, intentDigest: prepared.browser.planDigest, manifestSha256: prepared.browser.manifestSha256,
        resourceKeys: prepared.browser.resourceKeys, browserReceipt, finishedAt: new Date().toISOString() };
      writeState(config, { state: 'completed', outcome: 'verified', receipt }); return receipt;
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'BROWSER_PROVIDER_FAILED';
      const outcome = error?.effect === 'none' || error?.outcome === 'none' ? 'none' : 'unknown';
      writeState(config, { state: outcome === 'unknown' ? 'uncertain' : 'not-started', outcome, code }); throw typed(code, outcome);
    }
  };
  const promise = execute(); active.set(key, promise);
  try { return await promise; } finally { if (active.get(key) === promise) active.delete(key); }
}
export function readPreparedBrowserState(config) { assertPreparedBrowserAuthorization(config); assertEffectRoot(config); return readState(config); }
async function assertPins(prepared) {
  const browser = prepared.browser;
  if (!await pinned(browser.manifestPath, browser.manifestSha256) || nativeDigest(JSON.parse(readFileSync(browser.manifestPath, 'utf8'))) !== nativeDigest(browser.session)) throw typed('BROWSER_MANIFEST_CHANGED', 'none');
  if (!await pinned(browser.session.executable, browser.session.executableSha256)) throw typed('BROWSER_PREREQUISITE_CHANGED', 'none');
  for (const entry of browser.prerequisites) if (!await pinned(entry.path, entry.hash)) throw typed('BROWSER_PREREQUISITE_CHANGED', 'none');
}
async function pinned(filename, expected) { try { return typeof filename === 'string' && path.isAbsolute(filename) && typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected) && realpathSync(filename) === path.resolve(filename) && lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink() && await nativeFileDigest(filename) === expected; } catch { return false; } }
async function loadTestTransport(config) {
  if (config.grace.mode !== 'test-driver') throw typed('BROWSER_TEST_TRANSPORT_DENIED', 'none');
  const binding = config.browserTestTransport;
  if (!await pinned(binding.path, binding.sha256)) throw typed('BROWSER_TEST_TRANSPORT_CHANGED', 'none');
  const module = await import(pathToFileURL(binding.path).href + '?sha256=' + binding.sha256);
  if (!await pinned(binding.path, binding.sha256) || typeof module.testTransport !== 'object' || !module.testTransport) throw typed('BROWSER_TEST_TRANSPORT_CHANGED', 'none');
  return module.testTransport;
}
function assertEffectRoot(config) { if (!path.isAbsolute(config.effectRoot) || realpathSync(config.effectRoot) !== path.resolve(config.effectRoot) || !lstatSync(config.effectRoot).isDirectory() || lstatSync(config.effectRoot).isSymbolicLink()) throw typed('BROWSER_EFFECT_ROOT_CHANGED', 'none'); }
function readState(config) {
  const filename = path.join(config.effectRoot, 'browser-operation.json'); if (!existsSync(filename)) return undefined;
  if (lstatSync(filename).isSymbolicLink() || realpathSync(filename) !== path.resolve(filename)) throw typed('BROWSER_EVIDENCE_INVALID', 'unknown');
  let envelope;
  try { envelope = JSON.parse(readFileSync(filename, 'utf8')); } catch { throw typed('BROWSER_EVIDENCE_INVALID', 'unknown'); }
  if (typeof envelope.body !== 'string' || typeof envelope.mac !== 'string' || !equal(createHmac('sha256', config.token).update(envelope.body).digest('hex'), envelope.mac)) throw typed('BROWSER_EVIDENCE_INVALID', 'unknown');
  let state; try { state = JSON.parse(envelope.body); } catch { throw typed('BROWSER_EVIDENCE_INVALID', 'unknown'); }
  if (state.jobId !== config.jobId || state.epoch !== config.epoch || state.generation !== config.generation || state.intentDigest !== JSON.parse(config.text).browser.planDigest
    || state.authorizationMac !== config.browserAuthorization.mac) throw typed('BROWSER_EVIDENCE_INVALID', 'unknown');
  return state;
}
function writeState(config, value) {
  const prepared = assertPreparedBrowserAuthorization(config);
  const body = JSON.stringify({ jobId: config.jobId, epoch: config.epoch, generation: config.generation, intentDigest: prepared.browser.planDigest,
    authorizationMac: config.browserAuthorization.mac, resourceKeys: prepared.browser.resourceKeys, ...value });
  const envelope = JSON.stringify({ body, mac: createHmac('sha256', config.token).update(body).digest('hex') });
  const temporary = path.join(config.effectRoot, '.browser-' + randomUUID() + '.tmp'); writeFileSync(temporary, envelope, { flag: 'wx', mode: 0o600 }); replaceFileSync(temporary, path.join(config.effectRoot, 'browser-operation.json'));
}
async function processIdentity(pid) {
  const script = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object @{Name='pid';Expression={$_.ProcessId}},@{Name='birth';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},@{Name='executable';Expression={$_.ExecutablePath}},@{Name='commandLine';Expression={$_.CommandLine}} | ConvertTo-Json -Compress`;
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => { try { resolve(error ? null : JSON.parse(stdout)); } catch { resolve(null); } }));
}
function typed(code, outcome) { const error = new Error(code); error.code = code; error.outcome = outcome; return error; }
