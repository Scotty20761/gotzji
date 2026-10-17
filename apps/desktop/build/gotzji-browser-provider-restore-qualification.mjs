import { URL } from 'node:url';
/* global process, console */
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createTrustedProductBrowserEnrollment, restoreTrustedProductBrowserEnrollment } from '../../../packages/execution-core/dist/product-browser-broker.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex'); const output = path.join(process.argv[2], randomUUID());
await mkdir(output, { recursive: true }); const projectRoot = path.join(output, 'project'); await mkdir(projectRoot);
await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Owned session restore qualification\nOnly native metadata and about:blank are approved. No user/browser-profile adoption.\n');
const repoRoot = await realpath(new URL('../../../', import.meta.url));
const names = ['packages/capabilities/dist/gotzji-browser-provider-policy.js', 'packages/capabilities/dist/gotzji-browser-provider-cdp.js', 'packages/capabilities/dist/gotzji-browser-provider-session.js', 'packages/execution-core/dist/product-browser.js', 'packages/execution-core/dist/product-browser-broker.mjs'];
const prerequisites = await Promise.all(names.map(async name => ({ path: path.join(repoRoot, name), hash: hash(await readFile(path.join(repoRoot, name))) })));
const executable = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const project = { projectId: 'browser-restore-proof', displayName: 'Owned restore fixture', owner: 'component-test-owner', rootPath: await realpath(projectRoot), resourceKey: randomUUID(), recipeIds: [] };
const created = await createTrustedProductBrowserEnrollment(project, { profileParent: output, chromeExecutable: executable, executableSha256: hash(await readFile(executable)),
  allowedOrigins: ['https://nodejs.org'], prerequisites, deadlineMs: 120000, headless: true });
let summary; let restored;
try {
  const serialized = JSON.parse(JSON.stringify(created.options));
  restored = await restoreTrustedProductBrowserEnrollment(project, serialized);
  assert.deepEqual(restored.publicBinding, created.publicBinding); assert.equal(restored.options.session.pid, created.options.session.pid);
  const denied = [];
  for (const change of [{ pidBirth: 'wrong-birth' }, { pid: 1 }, { profilePath: 'C:/Users/example/AppData/Local/Google/Chrome/User Data' }]) {
    try { await restoreTrustedProductBrowserEnrollment(project, { ...serialized, session: { ...serialized.session, ...change } }); assert.fail('forged persisted ownership must fail'); }
    catch (error) { assert.ok(['BROWSER_MANIFEST_CHANGED', 'BROWSER_SESSION_UNVERIFIED'].includes(error.code)); denied.push(error.code); }
  }
  const refreshed = await restored.refresh(); assert.equal(refreshed.publicBinding.expectedDocumentId, created.publicBinding.expectedDocumentId); assert.notEqual(refreshed.options.manifestPath, created.options.manifestPath);
  summary = { scope: 'actual-owned-Chrome-enrollment-serialized-restoration-and-safe-control-with-same-PID-NOT-actual-host-restart-or-Windows-reboot', session: restored.options.session,
    publicBinding: restored.publicBinding, sameOwnedPidAndBirth: true, immutableManifestRefresh: true, denied, prerequisites };
} catch (error) { summary = { scope: 'failed-owned-session-restore-qualification', code: error.code, message: error.message, privateStack: error.stack }; process.exitCode = 1; }
finally { try { summary.termination = await (restored ?? created).stop(); } catch (error) { summary.termination = { stopped: false, code: error.code }; process.exitCode = 1; } }
const json = JSON.stringify(summary, null, 2) + '\n'; await writeFile(path.join(output, 'browser-restore-summary.json'), json, { mode: 0o600 });
console.log(JSON.stringify({ output, summarySha256: hash(json), scope: summary.scope, passed: process.exitCode !== 1, termination: summary.termination }));
