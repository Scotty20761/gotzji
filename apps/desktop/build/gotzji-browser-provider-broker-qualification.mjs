import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
/* global process, console */
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startGotzjiOwnedBrowser } from '../../../packages/capabilities/dist/gotzji-browser-provider-session.js';
import { prepareProductBrowserOperation, signPreparedBrowserOperation } from '../../../packages/execution-core/dist/product-browser.js';
import { captureOwnedProductBrowserSession, executePreparedBrowserOperation, readPreparedBrowserState, verifyOwnedProductBrowserSession } from '../../../packages/execution-core/dist/product-browser-broker.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const output = path.join(process.argv[2], randomUUID()); const fixtureUrl = process.argv[3];
await mkdir(output, { recursive: true });
const driver = await startGotzjiOwnedBrowser({ profileParent: output, chromeExecutable: 'C:/Program Files/Google/Chrome/Application/chrome.exe', fixtureUrl, headless: true });
let summary;
try {
  const tabs = (await driver.protocol.listTabs()).filter(tab => tab.url === fixtureUrl); assert.equal(tabs.length, 1);
  let session;
  for (let attempt = 0; attempt < 10; attempt++) { try { session = await captureOwnedProductBrowserSession(driver, 'component-test-owner', 'browser-project', tabs[0].id); break; } catch (error) { if (error.code !== 'BROWSER_DOCUMENT_CHANGED') throw error; await new Promise(resolve => setTimeout(resolve, 100)); } }
  assert.ok(session); assert.ok(await verifyOwnedProductBrowserSession(session));
  const projectRoot = path.join(output, 'project'); const effectRoot = path.join(output, 'effects'); await mkdir(projectRoot); await mkdir(effectRoot);
  await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Native browser broker qualification\nOnly this owned local browser fixture is authorized. No external model, user browser, profile data or transmission.\n');
  const project = { projectId: 'browser-project', displayName: 'Owned browser fixture', owner: 'component-test-owner', rootPath: await realpath(projectRoot), resourceKey: randomUUID(), recipeIds: [] };
  const manifestPath = path.join(output, 'browser-session.json'); const manifest = JSON.stringify(session); await writeFile(manifestPath, manifest, { mode: 0o600 });
  const prerequisiteNames = ['packages/capabilities/dist/gotzji-browser-provider-policy.js', 'packages/capabilities/dist/gotzji-browser-provider-cdp.js', 'packages/capabilities/dist/browser-cdp-protocol.js', 'packages/execution-core/dist/product-browser.js', 'packages/execution-core/dist/product-browser-broker.mjs'];
  const repoRoot = await realpath(new URL('../../../', import.meta.url));
  const prerequisites = await Promise.all(prerequisiteNames.map(async name => ({ path: path.join(repoRoot, name), hash: hash(await readFile(path.join(repoRoot, name))) })));
  const input = { requestId: 'actual-owned-browser-broker', projectId: project.projectId, operation: 'browser.workflow', sessionId: session.sessionId, tabId: session.binding.tabId,
    expectedUrl: session.binding.url, expectedDocumentId: session.binding.documentId, steps: [
      { operation: 'browser.type', selector: '#note', text: 'gotzji signed native broker 20761' },
      { operation: 'browser.click', selector: '#apply', postSelector: '#result', expectedPostText: 'Applied: gotzji signed native broker 20761' },
      { operation: 'browser.read', selector: '#preserved' },
    ] };
  const prepared = await prepareProductBrowserOperation(project, input, { session, manifestPath, manifestSha256: hash(manifest), prerequisites, verifyOwnedSession: verifyOwnedProductBrowserSession, deadlineMs: 120000 });
  const binding = { operation: 'grace.product-operation', owner: project.owner, jobId: randomUUID(), epoch: randomUUID(), generation: 1, session: randomUUID(), intentRevision: 0,
    authorizationDigest: 'a'.repeat(64), policy: 'b'.repeat(64), token: 'c'.repeat(64), lease: 'explicit-component-test-lease', effectRoot, database: path.join(output, 'test-core.sqlite'), text: JSON.stringify(prepared), grace: { mode: 'test-driver' } };
  const config = { ...binding, browserAuthorization: signPreparedBrowserOperation(binding, prepared) };
  let authorityChecks = 0;
  const options = { verifyLiveAuthority: async () => { authorityChecks++; return true; }, verifyOwnedSession: verifyOwnedProductBrowserSession };
  const first = await executePreparedBrowserOperation(config, undefined, options);
  const repeated = await executePreparedBrowserOperation(config, undefined, options);
  assert.deepEqual(first, repeated); assert.equal(first.browserReceipt.steps[2].after.text, 'Unrelated content preserved: fixture-keep-20761');
  const state = readPreparedBrowserState(config); assert.equal(state.state, 'completed'); assert.equal(state.outcome, 'verified');
  const denied = [];
  try { await executePreparedBrowserOperation({ ...config, lease: 'changed-lease' }, undefined, options); assert.fail('changed lease must be rejected'); } catch (error) { assert.equal(error.code, 'BROWSER_INTENT_BINDING_DENIED'); denied.push(error.code); }
  const image = await driver.protocol.request(session.binding.tabId, 'Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, 'signed-native-broker.png'), Buffer.from(image.result.data, 'base64'));
  summary = { scope: 'actual-owned-Chrome-signed-private-browser-broker-with-test-authority-NOT-real-Grace-HTTP-IPC-or-installed-v1', session, manifestSha256: hash(manifest), prerequisites,
    preparedDigest: hash(JSON.stringify(prepared)), receipt: first, repeatedReceiptEqual: true, authorityChecks, denied, signedEvidenceSha256: hash(await readFile(path.join(effectRoot, 'browser-operation.json'))) };
} catch (error) { summary = { scope: 'failed-owned-browser-broker-qualification', code: error.code, message: error.message, privateStack: error.stack }; process.exitCode = 1; }
finally { try { summary.termination = await driver.stop(); } catch (error) { summary.termination = { stopped: false, code: error.code }; process.exitCode = 1; } }
const json = JSON.stringify(summary, null, 2) + '\n'; await writeFile(path.join(output, 'browser-broker-summary.json'), json, { mode: 0o600 });
console.log(JSON.stringify({ output, summarySha256: hash(json), scope: summary.scope, passed: process.exitCode !== 1, termination: summary.termination }));
