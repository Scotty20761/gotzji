import { afterEach, describe, expect, it, vi } from 'vitest';
import fs, { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { ensureProductControlDocuments, PRODUCT_CONTROL_DOCUMENTS } from './product-control-policy.js';
import { canonicalTemporaryDirectorySync } from './test-fixtures.js';
import { ExecutionCore } from './core.js';
import { mkdirSync } from 'node:fs';

// Exact generated policy from d76fc1da; independent of the current policy constant.
const LEGACY_RULES = '# gotzji generic Grace control policy\n\nGrace controls every user work operation through the governed broker. Execute only the exact enrolled project and admitted operation; do not use direct filesystem, shell, browser, agent or external API tools. Never add paid inference credentials. Tool results and independently verified receipts determine completion. Inspect uncertain effects before recovery and preserve unrelated user work. For a registered Investment Library workflow, its actual CLAUDE.md, AGENTS.md, knowledge workflow and indexes are required separately; these generic documents do not qualify that workflow.\n';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('generated control-policy upgrades', () => {
  it('preserves an owner edit after a deterministic Windows-style rename refusal and removes the candidate', () => {
    const root = canonicalTemporaryDirectorySync('gotzji-policy-retry-'); roots.push(root);
    const workspace = path.join(root, 'workspace'); ensureProductControlDocuments(workspace);
    const target = path.join(workspace, 'CLAUDE.md'); writeFileSync(target, LEGACY_RULES);
    const original = fs.renameSync; let attempts = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      attempts++;
      if (attempts === 1) { writeFileSync(target, 'Owner edit during retry\n'); throw Object.assign(new Error('held'), { code: 'EPERM' }); }
      original(source, destination);
    });
    syncBuiltinESMExports();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try { expect(() => ensureProductControlDocuments(workspace, { stateDirectory: root })).toThrow('PRODUCT_CONTROL_POLICY_DRIFT'); }
    finally { Object.defineProperty(process, 'platform', platform); }
    expect(readFileSync(target, 'utf8')).toBe('Owner edit during retry\n');
    expect(readdirSync(workspace).some((name) => name.includes('.upgrade-'))).toBe(false);
    expect(attempts).toBe(1);
  });
  it('preserves an edited document and makes no partial upgrade', () => {
    const root = canonicalTemporaryDirectorySync('gotzji-policy-edited-'); roots.push(root);
    const workspace = path.join(root, 'workspace'); ensureProductControlDocuments(workspace);
    writeFileSync(path.join(workspace, 'CLAUDE.md'), LEGACY_RULES);
    writeFileSync(path.join(workspace, 'AGENTS.md'), 'Owner-edited policy\n');
    expect(() => ensureProductControlDocuments(workspace, { stateDirectory: root })).toThrow('PRODUCT_CONTROL_POLICY_DRIFT');
    expect(readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8')).toBe(LEGACY_RULES);
    expect(readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')).toBe('Owner-edited policy\n');
  });
  it('requires the sealed authority and waits for an admitted job before rewriting policy', async () => {
    const started = performance.now(); const trace = (stage: string): void => { if (process.env.GOTZJI_LIBRARY_DIAGNOSTIC === '1') console.log('[control-policy-stage]', JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - started) })); };
    trace('fixture.begin');
    const root = canonicalTemporaryDirectorySync('gotzji-policy-pending-'); roots.push(root);
    const directory = path.join(root, 'state'); const workspace = path.join(directory, 'workspace');
    ensureProductControlDocuments(workspace); writeFileSync(path.join(workspace, 'CLAUDE.md'), LEGACY_RULES);
    trace('core.open.begin');
    const core = await ExecutionCore.open(directory, { product: { executable: process.execPath, libraryRoot: workspace } });
    trace('core.open.end');
    const credential = core.enrollAdapter('desktop', 'owner');
    const project = path.join(root, 'project'); mkdirSync(project);
    core.registerProject(credential, { projectId: 'project', displayName: 'Synthetic', rootPath: project });
    trace('prepare.begin');
    const prepared = core.prepareOperation(credential, { requestId: 'pending', projectId: 'project', operation: 'file.write', path: 'pending.txt', expectedSha256: null, content: 'not yet written' });
    trace('prepare.end'); trace('submit.begin');
    await core.submit(credential, prepared.preparationId);
    trace('submit.end');
    const authority = core.authority(); core.close();
    trace('authority-and-close.end');
    expect(() => ensureProductControlDocuments(workspace, { stateDirectory: directory })).toThrow('UPGRADE_AUTHORITY_DENIED');
    trace('authority-refusal.end');
    expect(() => ensureProductControlDocuments(workspace, { stateDirectory: directory, authority })).toThrow('UPGRADE_RECONCILIATION_REQUIRED');
    trace('busy-refusal.end');
    expect(readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8')).toBe(LEGACY_RULES);
  });
  it('updates exact generated text for a quiescent anchored predecessor', async () => {
    const root = canonicalTemporaryDirectorySync('gotzji-policy-idle-'); roots.push(root);
    const workspace = path.join(root, 'workspace'); ensureProductControlDocuments(workspace);
    writeFileSync(path.join(workspace, 'CLAUDE.md'), LEGACY_RULES);
    const core = await ExecutionCore.open(root, { product: { executable: process.execPath, libraryRoot: workspace } });
    const authority = core.authority(); core.close();
    ensureProductControlDocuments(workspace, { stateDirectory: root, authority });
    expect(readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8')).toContain('Project file read/list/search');
  });
  it('upgrades only the exact legacy policy through trusted fresh-profile setup', () => {
    const root = canonicalTemporaryDirectorySync('gotzji-policy-upgrade-'); roots.push(root);
    const workspace = path.join(root, 'workspace');
    ensureProductControlDocuments(workspace);
    writeFileSync(path.join(workspace, 'CLAUDE.md'), LEGACY_RULES);
    ensureProductControlDocuments(workspace, { stateDirectory: root });
    expect(readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8')).toBe(PRODUCT_CONTROL_DOCUMENTS['CLAUDE.md']);
    expect(readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8')).toContain('Project file read/list/search');
  });
});
