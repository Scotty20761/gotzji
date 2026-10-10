import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibraryWorkflowAdapter } from './library-workflow-adapter.js';
import {
  digestLibraryValue, loadLibraryPolicy, validateLibraryWorkflow,
  type LibraryOperationGrantRequest, type LibraryRouteAuthority,
  type LibraryStepReceipt, type LibraryWorkflowDefinition,
  type VerifiedOperationGrant,
} from './library-workflow-contract.js';
import { LIBRARY_WORKFLOW_REGISTRY, libraryWorkflow } from './library-workflow-registry.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const route: LibraryRouteAuthority = {
  route: 'gotzji-library', adapterId: 'gotzji-library-adapter', ownerId: 'owner-one',
  authorityId: 'neutral-authority', projectId: 'investment-library', catalogId: 'gotzji.library.v1',
};
const job = { jobId: 'job-one', bindingDigest: sha('binding') };

function fixture(definition: LibraryWorkflowDefinition): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gotzji-library-contract-'));
  for (const source of definition.sources) {
    const filename = path.join(root, source.relativePath);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, `source:${source.id}\n`);
  }
  return root;
}

function grantAuthority(seen: LibraryOperationGrantRequest[]): VerifiedOperationGrant {
  return async (request: LibraryOperationGrantRequest) => {
    seen.push(request);
    return { requestDigest: request.requestDigest, grantId: `grant-${seen.length}`, grantDigest: sha(JSON.stringify(request)), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  };
}

function receipt(preparationDigest: string, sourceDigest: string, stepId: string, operation: string, grantDigest: string, obligations: LibraryStepReceipt['obligations'], extra: Partial<LibraryStepReceipt> = {}): LibraryStepReceipt {
  return { preparationDigest, sourceDigest, jobId: job.jobId, stepId, operation, grantDigest, status: 'completed', outputDigest: sha(`output:${stepId}`), obligations, ...extra };
}

describe('Library workflow contracts (no-model dry run)', () => {
  it('uses a closed registry with separated delivery and the real Mammos -> Grace -> Facty chain', () => {
    for (const definition of LIBRARY_WORKFLOW_REGISTRY) expect(validateLibraryWorkflow(definition).nodes).toHaveLength(definition.steps.length);
    const operations = LIBRARY_WORKFLOW_REGISTRY.flatMap((definition) => definition.steps.map((entry) => entry.operation));
    expect(operations.some((operation) => /exec|shell|batch|mcp_call/.test(operation))).toBe(false);
    const weekly = libraryWorkflow('library.weekly-reading', 1);
    expect(weekly.steps.find((entry) => entry.id === 'build')).toMatchObject({ effect: 'write' });
    expect(weekly.steps.find((entry) => entry.id === 'deploy')).toMatchObject({ effect: 'delivery', deliveryScope: 'deploy', dependsOn: ['commit'] });
    const memo = libraryWorkflow('library.final-memo', 1);
    expect(memo.steps.map((entry) => [entry.id, entry.actor, entry.dependsOn])).toEqual([
      ['preflight', 'grace', []], ['mammos', 'mammos', ['preflight']],
      ['persist', 'grace', ['mammos']], ['facty', 'facty', ['persist']],
      ['deliver', 'grace', ['facty']],
    ]);
    const canonical = libraryWorkflow('library.final-memo', 2);
    expect(canonical.steps.map((entry) => [entry.id, entry.actor, entry.dependsOn])).toEqual([
      ['preflight', 'grace', []], ['mammos', 'mammos', ['preflight']],
      ['facty', 'facty', ['mammos']], ['persist', 'grace', ['facty']],
      ['pipeline', 'grace', ['persist']], ['indie', 'indie', ['persist']],
      ['atoms', 'grace', ['pipeline', 'indie']], ['index', 'grace', ['atoms']],
      ['verify', 'grace', ['index']], ['deliver', 'grace', ['verify']],
    ]);
    expect(canonical.steps.find((entry) => entry.id === 'persist')?.dependsOn).toEqual(['facty']);
    expect(canonical.steps.find((entry) => entry.id === 'indie')?.requiresSpokeProof).toBe(true);
  });

  it('reads current project policy bytes at preparation time and changes the source digest on drift', () => {
    const definition = libraryWorkflow('library.code-qa', 1);
    const root = fixture(definition);
    const first = loadLibraryPolicy(root, definition.sources);
    writeFileSync(path.join(root, 'CLAUDE.md'), 'changed current policy\n');
    const second = loadLibraryPolicy(root, definition.sources);
    expect(first.descriptors.find((entry) => entry.id === 'rules')?.sha256).not.toBe(second.descriptors.find((entry) => entry.id === 'rules')?.sha256);
    expect(first.digest).not.toBe(second.digest);
    expect(first.descriptors.every((entry) => !Object.hasOwn(entry, 'content'))).toBe(true);
  });

  it('rejects the stock route and requires a verified operation-grant callback plus selected-job authority', async () => {
    expect(() => new LibraryWorkflowAdapter(undefined as never)).toThrow('VERIFIED_OPERATION_GRANT_REQUIRED');
    const definition = libraryWorkflow('library.code-qa', 1);
    const root = fixture(definition);
    const adapter = new LibraryWorkflowAdapter(async () => { throw new Error('must not run'); });
    expect(() => adapter.prepare(root, { ...route, route: 'lnwjud-stock', catalogId: 'lnwjud.library.v1' } as unknown as LibraryRouteAuthority, {
      requestId: 'request-one', workflowId: definition.id, workflowVersion: 1, projectId: route.projectId, parameters: { intent: 'check' },
    })).toThrow('LIBRARY_ROUTE_AUTHORITY_DENIED');
    const prepared = adapter.prepare(root, route, { requestId: 'request-one', workflowId: definition.id, workflowVersion: 1, projectId: route.projectId, parameters: { intent: 'check' } });
    await expect(adapter.authorizeStep(prepared, 'inspect', { jobId: 'job-one', bindingDigest: 'not-a-digest' }, [])).rejects.toThrow('LIBRARY_SELECTED_JOB_AUTHORITY_REQUIRED');
  });

  it('binds grants to route, source, job and dependency receipts and requires explicit delivery authority', async () => {
    const seen: LibraryOperationGrantRequest[] = [];
    const adapter = new LibraryWorkflowAdapter(grantAuthority(seen));
    const definition = libraryWorkflow('library.weekly-reading', 1);
    const prepared = adapter.prepare(fixture(definition), route, { requestId: 'weekly-one', workflowId: definition.id, workflowVersion: 1, projectId: route.projectId, parameters: {} });
    const selectGrant = await adapter.authorizeStep(prepared, 'select', job, []);
    const selectReceipt = receipt(prepared.digest, prepared.sourceScope.digest, 'select', 'library.weekly-reading.select', selectGrant.grantDigest, ['index-first', 'source-priority']);
    adapter.verifyStepReceipt(prepared, 'select', job, selectGrant, selectReceipt);
    await adapter.authorizeStep(prepared, 'build', job, [selectReceipt]);
    expect(seen[1]).toMatchObject({ route: 'gotzji-library', selectedJobId: job.jobId, sourceDigest: prepared.sourceScope.digest, operation: 'library.weekly-reading.build' });
    expect(seen[1]?.dependencyReceiptDigests).toEqual([digestLibraryValue(selectReceipt)]);
    await expect(adapter.authorizeStep(prepared, 'deploy', job, [])).rejects.toThrow('LIBRARY_DEPENDENCY_RECEIPT_REQUIRED');
  });

  it('requires runtime spoke proof and a non-BLOCK Facty receipt before memo delivery', async () => {
    const adapter = new LibraryWorkflowAdapter(grantAuthority([]));
    const definition = libraryWorkflow('library.final-memo', 1);
    const prepared = adapter.prepare(fixture(definition), route, { requestId: 'memo-one', workflowId: definition.id, workflowVersion: 1, projectId: route.projectId, parameters: { ticker: 'TEST' } });
    const mammosGrant = { requestDigest: sha('request'), grantId: 'mammos-grant', grantDigest: sha('mammos-grant'), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const missingProof = receipt(prepared.digest, prepared.sourceScope.digest, 'mammos', 'library.spoke.mammos', mammosGrant.grantDigest, ['source-priority', 'privacy-boundary']);
    expect(() => adapter.verifyStepReceipt(prepared, 'mammos', job, mammosGrant, missingProof)).toThrow('LIBRARY_RUNTIME_SPOKE_PROOF_REQUIRED');
    const blockedFacty = receipt(prepared.digest, prepared.sourceScope.digest, 'facty', 'library.spoke.facty', sha('facty-grant'), ['facty-audit', 'source-priority', 'privacy-boundary'], {
      spokeProof: { kind: 'runtime-spoke-receipt', actor: 'facty', invocationDigest: sha('facty-invocation'), artifactDigest: sha('memo'), verdict: 'BLOCK' },
    });
    await expect(adapter.authorizeStep(prepared, 'deliver', job, [blockedFacty], { scope: 'user-delivery', authorityDigest: sha('owner delivery') })).rejects.toThrow('LIBRARY_FACTY_BLOCKED');
  });

  it('computes a cancellation closure without cancelling prerequisites or unrelated steps', () => {
    const adapter = new LibraryWorkflowAdapter(grantAuthority([]));
    const definition = libraryWorkflow('library.weekly-reading', 1);
    const prepared = adapter.prepare(fixture(definition), route, { requestId: 'weekly-cancel', workflowId: definition.id, workflowVersion: 1, projectId: route.projectId, parameters: {} });
    expect(adapter.cancellationPlan(prepared, 'build')).toEqual({
      selectedStepId: 'build', stopOwned: ['build'], revokeFuture: ['verify', 'commit', 'deploy'], preserve: ['select'],
    });
  });
});
