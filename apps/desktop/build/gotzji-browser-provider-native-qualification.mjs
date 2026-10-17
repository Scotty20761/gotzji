import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
/* global process, console, AbortController */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startGotzjiOwnedBrowser } from '../../../packages/capabilities/dist/gotzji-browser-provider-session.js';
import { GotzjiBrowserCdpTransport, createGotzjiBrowserCdpProvider } from '../../../packages/capabilities/dist/gotzji-browser-provider-cdp.js';

const output = path.join(process.argv[2], randomUUID());
const fixtureUrl = process.argv[3];
await mkdir(output, { recursive: true });
const driver = await startGotzjiOwnedBrowser({ profileParent: output, chromeExecutable: 'C:/Program Files/Google/Chrome/Application/chrome.exe', fixtureUrl, headless: true });
let summary;
try {
  const tabs = (await driver.protocol.listTabs()).filter(tab => tab.url === fixtureUrl);
  assert.equal(tabs.length, 1, 'exact new owned fixture tab must be unique');
  const targetInfo = await driver.protocol.request(tabs[0].id, 'Target.getTargetInfo', { targetId: tabs[0].id });
  const session = { browserId: driver.browserId, contextId: driver.contextId, profileId: driver.profileId, tabId: tabs[0].id, providerTabId: tabs[0].id, cdpBrowserContextId: targetInfo.result.targetInfo.browserContextId ?? '' };
  const transport = new GotzjiBrowserCdpTransport(driver.protocol, session, driver.verifyOwnership);
  let binding;
  const readyDeadline = Date.now() + 10000;
  while (Date.now() < readyDeadline) {
    try { binding = await transport.binding(); if ((await transport.inspect('#note')).count === 1) break; }
    catch (error) { if (!['BROWSER_DOCUMENT_CHANGED', 'BROWSER_OBJECT_MISSING'].includes(error.code)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(binding, 'selected native page must become ready before any action');
  const grant = { ownerId: 'component-test-owner', projectId: 'owned-fixture', jobId: randomUUID(), operationId: randomUUID(), rootPath: output, proof: randomUUID() };
  let accepted;
  const grantChecks = [];
  const verify = async (supplied, digest, resources) => {
    const passed = JSON.stringify(supplied) === JSON.stringify(grant) && digest === accepted?.digest && JSON.stringify(resources) === JSON.stringify(accepted.resourceKeys);
    grantChecks.push({ operationDigest: digest, resourceKeys: resources, passed }); return passed;
  };
  const provider = createGotzjiBrowserCdpProvider(driver.protocol, session, driver.verifyOwnership, verify);
  const execute = async (input, supplied = grant, signal) => { accepted = provider.prepare(input); return provider.execute(supplied, input, signal); };
  const read = { operation: 'browser.query', binding, selector: '#note' };
  const query = await execute(read); assert.equal(query.steps[0].after.value, 'original');
  const type = { operation: 'browser.type', binding, selector: '#note', text: 'gotzji standalone native ผ่าน CDP' };
  const denied = [];
  const refusal = async (input, supplied, signal, code) => { try { await execute(input, supplied, signal); assert.fail('expected refusal'); } catch (error) { assert.equal(error.code, code); denied.push({ code: error.code, effect: error.effect, releaseResources: error.releaseResources }); } };
  await refusal(type, { ...grant, proof: 'wrong-test-proof' }, undefined, 'NATIVE_AUTHORITY_DENIED');
  const controller = new AbortController(); controller.abort();
  await refusal(type, grant, controller.signal, 'BROWSER_CANCELLED');
  await refusal({ ...read, selector: '#secret' }, grant, undefined, 'BROWSER_WAITING_FOR_USER');
  await refusal({ ...read, binding: { ...binding, documentId: 'wrong-loader' } }, grant, undefined, 'BROWSER_DOCUMENT_CHANGED');
  assert.equal((await transport.inspect('#note')).value, 'original');
  const typed = await execute(type);
  const clicked = await execute({ operation: 'browser.click', binding, selector: '#apply', postSelector: '#result', expectedPostText: `Applied: ${type.text}` });
  const workflow = await execute({ operation: 'browser.workflow', binding, steps: [
    { operation: 'browser.type', selector: '#note', text: 'gotzji native complete workflow 20761' },
    { operation: 'browser.click', selector: '#apply', postSelector: '#result', expectedPostText: 'Applied: gotzji native complete workflow 20761' },
    { operation: 'browser.read', selector: '#preserved' },
  ] });
  assert.equal(workflow.steps[2].after.text, 'Unrelated content preserved: fixture-keep-20761');
  const version = await driver.protocol.request(session.tabId, 'Browser.getVersion', {});
  const nativeWindow = await driver.protocol.request(session.tabId, 'Browser.getWindowForTarget', { targetId: session.tabId });
  const image = await driver.protocol.request(session.tabId, 'Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, 'native-workflow.png'), Buffer.from(image.result.data, 'base64'));
  // Fault injection acts on a second owned tab; the completed workflow tab remains unchanged.
  const faultTab = await driver.protocol.newTab(fixtureUrl);
  const faultSession = { ...session, tabId: faultTab.id, providerTabId: faultTab.id };
  const faultTransport = new GotzjiBrowserCdpTransport(driver.protocol, faultSession, driver.verifyOwnership);
  const faultBinding = await faultTransport.binding();
  const faultProtocol = { status: driver.protocol.status.bind(driver.protocol), listTabs: driver.protocol.listTabs.bind(driver.protocol), newTab: driver.protocol.newTab.bind(driver.protocol), closeTab: driver.protocol.closeTab.bind(driver.protocol), request: async (...args) => {
    const response = await driver.protocol.request(...args);
    if (args[1] === 'Runtime.evaluate' && args[2].expression.includes('"action":"fill"')) throw new Error('injected native response loss');
    return response;
  } };
  const faultProvider = createGotzjiBrowserCdpProvider(faultProtocol, faultSession, driver.verifyOwnership, verify);
  const faultInput = { operation: 'browser.type', binding: faultBinding, selector: '#note', text: 'native effect inspected after response loss' };
  accepted = faultProvider.prepare(faultInput);
  let unknown;
  try { await faultProvider.execute(grant, faultInput); assert.fail('expected injected response loss'); } catch (error) { unknown = { code: error.code, effect: error.effect, releaseResources: error.releaseResources }; }
  assert.deepEqual(unknown, { code: 'BROWSER_PROVIDER_FAILED', effect: 'unknown', releaseResources: false });
  const inspected = await faultTransport.inspect('#note'); assert.equal(inspected.value, faultInput.text);
  try { await faultProvider.execute(grant, faultInput); assert.fail('uncertain effect must not replay'); } catch (error) { assert.equal(error.code, 'BROWSER_RECONCILIATION_REQUIRED'); }
  const sourceNames = ['policy', 'cdp', 'session'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, createHash('sha256').update(await readFile(new URL(`../../../packages/capabilities/src/gotzji-browser-provider-${name}.ts`, import.meta.url))).digest('hex')])));
  summary = { scope: 'real-standalone-Chrome-native-component-with-test-grant-NOT-Grace-ChatGPT-or-installed-v1', mode: 'owned-blank-profile-headless-Chrome-rendered-DOM', pid: driver.pid, port: driver.port, profilePath: driver.profilePath, providerVersion: version.result.product, nativeWindow: nativeWindow.result, session, binding, sourceHashes, query, typed, clicked, workflow, denied, unknown, unknownEffectInspected: inspected.value, unknownReplayDenied: true, grantChecks, originalUserBrowserUntouched: true };
} catch (error) {
  summary = { scope: 'failed-component-native-qualification', error: { code: error.code, message: error.message, stack: error.stack }, pid: driver.pid, profilePath: driver.profilePath };
  process.exitCode = 1;
} finally {
  try { const termination = await driver.stop(); if (summary) summary.termination = termination; }
  catch (error) { summary = { ...summary, termination: { stopped: false, code: error.code, cause: String(error.cause), innerCause: String(error.cause?.cause) } }; process.exitCode = 1; }
}
const json = JSON.stringify(summary, null, 2) + '\n';
await writeFile(path.join(output, 'native-browser-summary.json'), json);
console.log(JSON.stringify({ output, summarySha256: createHash('sha256').update(json).digest('hex'), nativeStandaloneVerified: process.exitCode !== 1, termination: summary.termination, scope: summary.scope }));
