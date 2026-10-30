import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
/* global process, console */
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createTrustedProductBrowserEnrollment, executePreparedBrowserOperation, readPreparedBrowserState } from '../../../packages/execution-core/dist/product-browser-broker.mjs';
import { prepareProductBrowserOperation, signPreparedBrowserOperation } from '../../../packages/execution-core/dist/product-browser.js';
import { NodeBrowserCdpProtocol } from '../../../packages/capabilities/dist/browser-cdp-protocol.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const output = path.join(process.argv[2], randomUUID()); await mkdir(output, { recursive: true });
const projectRoot = path.join(output, 'project'); const effectRoot = path.join(output, 'effects'); await mkdir(projectRoot); await mkdir(effectRoot);
await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Explicit public browser qualification\nOnly anonymous read/navigation of https://nodejs.org is approved. Never log in or send personal data.\n');
const repoRoot = await realpath(new URL('../../../', import.meta.url));
const prerequisiteNames = ['packages/capabilities/dist/gotzji-browser-provider-policy.js', 'packages/capabilities/dist/gotzji-browser-provider-cdp.js', 'packages/capabilities/dist/browser-cdp-protocol.js', 'packages/execution-core/dist/product-browser.js', 'packages/execution-core/dist/product-browser-broker.mjs'];
const prerequisites = await Promise.all(prerequisiteNames.map(async name => ({ path: path.join(repoRoot, name), hash: hash(await readFile(path.join(repoRoot, name))) })));
const executable = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const project = { projectId: 'public-browser-proof', displayName: 'Anonymous Node documentation', owner: 'component-test-owner', rootPath: await realpath(projectRoot), resourceKey: randomUUID(), recipeIds: [] };
const enrollment = await createTrustedProductBrowserEnrollment(project, { profileParent: output, chromeExecutable: executable, executableSha256: hash(await readFile(executable)),
  allowedOrigins: ['https://nodejs.org'], prerequisites, deadlineMs: 120000, headless: true });
let summary;
try {
  assert.equal(enrollment.publicBinding.expectedUrl, 'about:blank');
  const input = { requestId: 'https-native-navigation', projectId: project.projectId, operation: 'browser.workflow', ...enrollment.publicBinding,
    steps: [{ operation: 'browser.navigate', url: 'https://nodejs.org/api/url.html' }, { operation: 'browser.read', selector: 'h1' }] };
  delete input.allowedOrigins; // Public callers cannot supply or broaden the host-enrolled origin scope.
  const prepared = await prepareProductBrowserOperation(project, input, enrollment.options);
  const binding = { operation: 'grace.product-operation', owner: project.owner, jobId: randomUUID(), epoch: randomUUID(), generation: 1, session: randomUUID(), intentRevision: 0,
    authorizationDigest: 'a'.repeat(64), policy: 'b'.repeat(64), token: 'c'.repeat(64), lease: 'explicit-https-component-test-lease', effectRoot, database: path.join(output, 'test-core.sqlite'), text: JSON.stringify(prepared), grace: { mode: 'test-driver' } };
  const config = { ...binding, browserAuthorization: signPreparedBrowserOperation(binding, prepared) }; let authorityChecks = 0;
  const receipt = await executePreparedBrowserOperation(config, undefined, { verifyLiveAuthority: async () => { authorityChecks++; return true; }, verifyOwnedSession: enrollment.options.verifyOwnedSession });
  assert.equal(receipt.browserReceipt.initialBinding.url, 'about:blank'); assert.equal(receipt.browserReceipt.binding.url, 'https://nodejs.org/api/url.html');
  assert.notEqual(receipt.browserReceipt.initialBinding.documentId, receipt.browserReceipt.binding.documentId); assert.match(receipt.browserReceipt.steps[1].after.text, /^Node\.js /);
  const refreshed = await enrollment.refresh(); assert.equal(refreshed.publicBinding.expectedDocumentId, receipt.browserReceipt.binding.documentId); assert.notEqual(refreshed.options.manifestPath, enrollment.options.manifestPath);
  const denied = [];
  const common = { requestId: 'scope-denial', projectId: project.projectId, operation: 'browser.navigate', sessionId: refreshed.publicBinding.sessionId, tabId: refreshed.publicBinding.tabId,
    expectedUrl: refreshed.publicBinding.expectedUrl, expectedDocumentId: refreshed.publicBinding.expectedDocumentId, url: 'https://example.org/' };
  try { await prepareProductBrowserOperation(project, common, refreshed.options); assert.fail('unapproved origin must be rejected'); } catch (error) { assert.equal(error.code, 'BROWSER_ORIGIN_SCOPE_DENIED'); denied.push(error.code); }
  const session = refreshed.options.session; const protocol = new NodeBrowserCdpProtocol({ port: session.port, profileDir: session.profilePath, chromeExecutable: session.executable });
  const image = await protocol.request(session.binding.tabId, 'Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, 'native-public-doc.png'), Buffer.from(image.result.data, 'base64'));
  summary = { scope: 'actual-owned-Chrome-HTTPS-navigation-and-read-through-signed-private-browser-broker-with-test-authority-NOT-real-Grace-HTTP-IPC-or-installed-v1', startUrl: 'about:blank', approvedOrigins: ['https://nodejs.org'],
    session, initialBinding: receipt.browserReceipt.initialBinding, finalBinding: receipt.browserReceipt.binding, receipt, authorityChecks, denied,
    manifestBeforeSha256: enrollment.options.manifestSha256, manifestAfterSha256: refreshed.options.manifestSha256, immutableManifestVersioning: true,
    signedEvidenceSha256: hash(await readFile(path.join(effectRoot, 'browser-operation.json'))), signedState: readPreparedBrowserState(config), prerequisites };
} catch (error) { summary = { scope: 'failed-owned-browser-HTTPS-qualification', code: error.code, message: error.message, privateStack: error.stack }; process.exitCode = 1; }
finally { try { summary.termination = await enrollment.stop(); } catch (error) { summary.termination = { stopped: false, code: error.code }; process.exitCode = 1; } }
const json = JSON.stringify(summary, null, 2) + '\n'; await writeFile(path.join(output, 'browser-web-summary.json'), json, { mode: 0o600 });
console.log(JSON.stringify({ output, summarySha256: hash(json), scope: summary.scope, passed: process.exitCode !== 1, termination: summary.termination }));
