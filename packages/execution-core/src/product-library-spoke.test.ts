import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Standalone worker boundary is JavaScript.
import { prepareCanonicalSpokePolicy } from './product-library-broker.mjs';
// @ts-expect-error Standalone policy builder is JavaScript.
import { canonicalSpokePolicy } from './product-library-spoke-policy.mjs';
import { assertLibraryStepReceipt } from './library-workflow-contract.js';

const roots: string[] = [];
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('canonical Library spoke policy', () => {
  it('loads the frozen canonical persona body into an explicit named-agent policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-spoke-policy-')); roots.push(root);
    const effects = path.join(root, 'effects'); const agents = path.join(root, '.claude', 'agents');
    await mkdir(effects); await mkdir(agents, { recursive: true });
    const source = '---\nname: mammos\ndescription: memo\n---\n\n# Canonical Mammos\nUse the house memo contract.\n';
    await writeFile(path.join(agents, 'mammos.md'), source);
    const expectedPolicy = canonicalSpokePolicy(source, 'mammos').policyAdapterSha256;
    const prepared = { project: { rootPath: root }, library: { spokePolicies: { mammos: { canonicalSpecSha256: sha(source), policyAdapterSha256: expectedPolicy } }, sourceScope: { descriptors: [{ id: 'mammos-agent', relativePath: '.claude/agents/mammos.md', sha256: sha(source) }] } } };
    const result = prepareCanonicalSpokePolicy(prepared, 'mammos', effects);
    const policy = JSON.parse(await readFile(result.path, 'utf8'));
    expect(policy.mammos).toMatchObject({ tools: [], prompt: expect.stringContaining('# Canonical Mammos') });
    expect(result).toMatchObject({ canonicalSpecSha256: sha(source), policyAdapterSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await writeFile(path.join(agents, 'mammos.md'), `${source}changed\n`);
    expect(() => prepareCanonicalSpokePolicy(prepared, 'mammos', effects)).toThrow('LIBRARY_CANONICAL_AGENT_CHANGED');
  });
  it('rejects a well-formed but wrong canonical spoke hash', () => {
    const preparation = {
      digest: sha('preparation'), sourceScope: { digest: sha('sources') }, ast: { workflowId: 'library.final-memo', workflowVersion: 2 },
      spokePolicies: { mammos: { canonicalSpecSha256: sha('canonical mammos'), policyAdapterSha256: sha('canonical policy') } },
    } as never;
    const step = { id: 'mammos', operation: 'library.spoke.mammos', actor: 'mammos', requiresSpokeProof: true, requiredObligations: [], dependsOn: [], effect: 'write', cancellation: 'stop-owned' } as never;
    const grant = { grantDigest: sha('grant') } as never;
    const receipt = { preparationDigest: sha('preparation'), sourceDigest: sha('sources'), stepId: 'mammos', operation: 'library.spoke.mammos', grantDigest: sha('grant'), status: 'completed', outputDigest: sha('output'), obligations: [],
      spokeProof: { kind: 'runtime-spoke-receipt', actor: 'mammos', delegatedBy: 'grace', invocationDigest: sha('invoke'), artifactDigest: sha('artifact'), canonicalSpecSha256: sha('wrong but valid'), policyAdapterSha256: sha('canonical policy') } };
    expect(() => assertLibraryStepReceipt(preparation, step, grant, receipt as never)).toThrow('LIBRARY_CANONICAL_SPOKE_PROOF_REQUIRED');
    receipt.spokeProof.canonicalSpecSha256 = sha('canonical mammos');
    expect(() => assertLibraryStepReceipt(preparation, step, grant, receipt as never)).not.toThrow();
  });
});
