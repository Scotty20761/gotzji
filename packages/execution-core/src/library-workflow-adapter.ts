import {
  assertLibraryRoute, assertLibraryStepReceipt, digestLibraryValue, libraryCancellationPlan,
  loadLibraryPolicy, validateLibraryWorkflow, type LibraryCancellationPlan,
  type LibraryDeliveryAuthority, type LibraryOperationGrantRequest, type LibraryRouteAuthority,
  type LibrarySelectedJobAuthority, type LibraryStepReceipt, type LibraryWorkflowInput,
  type LibraryWorkflowPreparation, type VerifiedLibraryOperationGrant, type VerifiedOperationGrant,
} from './library-workflow-contract.js';
import { libraryWorkflow } from './library-workflow-registry.js';

const ID = /^[a-zA-Z0-9_.-]{1,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class LibraryWorkflowAdapter {
  readonly #verifiedOperationGrant: VerifiedOperationGrant;

  public constructor(verifiedOperationGrant: VerifiedOperationGrant) {
    if (typeof verifiedOperationGrant !== 'function') throw new Error('VERIFIED_OPERATION_GRANT_REQUIRED');
    this.#verifiedOperationGrant = verifiedOperationGrant;
  }

  public prepare(projectRoot: string, route: LibraryRouteAuthority, input: LibraryWorkflowInput): LibraryWorkflowPreparation {
    assertLibraryRoute(route);
    if (!ID.test(input.requestId) || input.projectId !== route.projectId) throw new Error('LIBRARY_REQUEST_AUTHORITY_DENIED');
    const definition = libraryWorkflow(input.workflowId, input.workflowVersion);
    const keys = Object.keys(input.parameters);
    if (keys.some((key) => !definition.allowedParameters.includes(key))
      || definition.requiredParameters.some((key) => !Object.hasOwn(input.parameters, key))) throw new Error('LIBRARY_WORKFLOW_INPUT_INVALID');
    for (const [key, value] of Object.entries(input.parameters)) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'string' && value.length > (key === 'content' ? 65_536 : 10_000))
        || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('LIBRARY_WORKFLOW_INPUT_INVALID');
    }
    const sourceScope = loadLibraryPolicy(projectRoot, definition.sources);
    const ast = validateLibraryWorkflow(definition);
    const normalizedInput = { ...input, parameters: Object.fromEntries(Object.entries(input.parameters).sort(([a], [b]) => a.localeCompare(b))) };
    const digest = digestLibraryValue({ input: normalizedInput, route, sourceDigest: sourceScope.digest, ast });
    return { input: normalizedInput, route: { ...route }, sourceScope, ast, digest };
  }

  public async authorizeStep(
    preparation: LibraryWorkflowPreparation,
    stepId: string,
    selectedJob: LibrarySelectedJobAuthority,
    completedReceipts: readonly LibraryStepReceipt[],
    deliveryAuthority?: LibraryDeliveryAuthority,
  ): Promise<VerifiedLibraryOperationGrant> {
    assertLibraryRoute(preparation.route);
    if (!ID.test(selectedJob.jobId) || !SHA256.test(selectedJob.bindingDigest)) throw new Error('LIBRARY_SELECTED_JOB_AUTHORITY_REQUIRED');
    const step = preparation.ast.nodes.find((entry) => entry.id === stepId);
    if (!step) throw new Error('LIBRARY_STEP_NOT_FOUND');
    const receipts = new Map(completedReceipts.map((receipt) => [receipt.stepId, receipt]));
    const dependencyReceiptDigests: string[] = [];
    for (const dependency of step.dependsOn) {
      const receipt = receipts.get(dependency);
      if (!receipt || receipt.status !== 'completed') throw new Error('LIBRARY_DEPENDENCY_RECEIPT_REQUIRED');
      const dependencyStep = preparation.ast.nodes.find((entry) => entry.id === dependency);
      if (!dependencyStep) throw new Error('LIBRARY_DEPENDENCY_INVALID');
      if (receipt.preparationDigest !== preparation.digest || receipt.sourceDigest !== preparation.sourceScope.digest
        || receipt.jobId !== selectedJob.jobId || receipt.operation !== dependencyStep.operation) throw new Error('LIBRARY_DEPENDENCY_RECEIPT_MISMATCH');
      dependencyReceiptDigests.push(digestLibraryValue(receipt));
      if (dependencyStep.requiresSpokeProof) {
        const proof = receipt.spokeProof;
        if (!proof || proof.kind !== 'runtime-spoke-receipt' || proof.actor !== dependencyStep.actor
          || !SHA256.test(proof.invocationDigest) || !SHA256.test(proof.artifactDigest)) throw new Error('LIBRARY_RUNTIME_SPOKE_PROOF_REQUIRED');
        if (dependencyStep.actor === 'facty' && proof.verdict === 'BLOCK') throw new Error('LIBRARY_FACTY_BLOCKED');
      }
    }
    if (preparation.ast.workflowId === 'library.final-memo' && preparation.ast.workflowVersion >= 2 && step.effect === 'delivery') {
      const facty = receipts.get('facty'); const proof = facty?.spokeProof;
      if (!facty || facty.status !== 'completed' || facty.operation !== 'library.spoke.facty'
        || !proof || proof.actor !== 'facty' || !['PASS', 'CAVEATS'].includes(proof.verdict ?? '')) throw new Error('LIBRARY_FACTY_BLOCKED');
    }
    if (step.effect === 'delivery') {
      if (!deliveryAuthority || deliveryAuthority.scope !== step.deliveryScope || !SHA256.test(deliveryAuthority.authorityDigest)) throw new Error('LIBRARY_DELIVERY_AUTHORITY_REQUIRED');
    } else if (deliveryAuthority) throw new Error('LIBRARY_DELIVERY_AUTHORITY_INVALID');
    const base = {
      preparationDigest: preparation.digest, sourceDigest: preparation.sourceScope.digest,
      ownerId: preparation.route.ownerId, authorityId: preparation.route.authorityId,
      adapterId: preparation.route.adapterId, route: preparation.route.route,
      selectedJobId: selectedJob.jobId, selectedJobBindingDigest: selectedJob.bindingDigest,
      workflowId: preparation.ast.workflowId, workflowVersion: preparation.ast.workflowVersion,
      stepId: step.id, operation: step.operation, effect: step.effect,
      dependencyReceiptDigests,
      ...(deliveryAuthority ? { deliveryAuthority } : {}),
    };
    const request: LibraryOperationGrantRequest = { requestDigest: digestLibraryValue(base), ...base };
    const grant = await this.#verifiedOperationGrant(request);
    if (!grant || grant.requestDigest !== request.requestDigest || !ID.test(grant.grantId)
      || !SHA256.test(grant.grantDigest) || !Number.isFinite(Date.parse(grant.expiresAt))
      || Date.parse(grant.expiresAt) <= Date.now()) throw new Error('VERIFIED_OPERATION_GRANT_INVALID');
    return grant;
  }

  public verifyStepReceipt(
    preparation: LibraryWorkflowPreparation,
    stepId: string,
    selectedJob: LibrarySelectedJobAuthority,
    grant: VerifiedLibraryOperationGrant,
    receipt: LibraryStepReceipt,
  ): void {
    const step = preparation.ast.nodes.find((entry) => entry.id === stepId);
    if (!step) throw new Error('LIBRARY_STEP_NOT_FOUND');
    if (receipt.jobId !== selectedJob.jobId) throw new Error('LIBRARY_STEP_RECEIPT_MISMATCH');
    assertLibraryStepReceipt(preparation, step, grant, receipt);
  }

  public cancellationPlan(preparation: LibraryWorkflowPreparation, selectedStepId: string): LibraryCancellationPlan {
    return libraryCancellationPlan(preparation.ast, selectedStepId);
  }
}
