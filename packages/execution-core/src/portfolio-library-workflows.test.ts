import { describe, expect, it } from 'vitest';
import { validateLibraryWorkflow } from './library-workflow-contract.js';
import { libraryWorkflow } from './library-workflow-registry.js';
import {
  assertHostDirectLibraryWorkflow, libraryCatalog, prepareLibraryOperation,
  type ProductLibraryInput, type TrustedLibraryOptions,
} from './product-library.js';
import type { LibraryRouteAuthority } from './library-workflow-contract.js';
import type { RegisteredProject } from './types.js';

const workflows = [
  'library.portfolio-build',
  'library.portfolio-private-deploy',
  'library.portfolio-production-verify',
] as const;

describe('gotzji private Portfolio host-direct Library contracts', () => {
  it('registers each workflow without requiring Claude or a generic shell recipe', () => {
    const available = libraryCatalog('host-direct').map(workflow => workflow.id);
    for (const id of workflows) {
      expect(available).toContain(id);
      expect(() => assertHostDirectLibraryWorkflow(id, 1)).not.toThrow();
      const definition = libraryWorkflow(id, 1);
      expect(definition.privacy).toBe('private');
      expect(definition.allowedParameters).toEqual([]);
      expect(definition.requiredParameters).toEqual([]);
      expect(() => validateLibraryWorkflow(definition)).not.toThrow();
      expect(definition.steps.every(step => step.actor === 'grace')).toBe(true);
      expect(definition.sources.map(source => source.relativePath)).toEqual(expect.arrayContaining([
        'data/broker_snapshot.csv',
        'inputs/sources/portfolio_manual_additions.csv',
        'scripts/pf_daily_refresh.py',
        'scripts/deploy_private_portfolio.py',
        'scripts/audit_portfolio_private.py',
      ]));
    }
  });

  it('requires explicit owner delivery authority for private deployment', () => {
    const nodes = libraryWorkflow('library.portfolio-private-deploy', 1).steps;
    expect(nodes.map(node => node.id)).toEqual(['build', 'verify', 'deploy', 'verify-live']);
    expect(nodes.find(node => node.id === 'deploy')).toMatchObject({
      effect: 'delivery', deliveryScope: 'deploy', dependsOn: ['verify'],
    });
    expect(nodes.find(node => node.id === 'verify-live')).toMatchObject({
      effect: 'read', dependsOn: ['deploy'],
    });
    for (const id of ['library.portfolio-build', 'library.portfolio-production-verify']) {
      expect(libraryWorkflow(id, 1).steps.some(step => step.effect === 'delivery')).toBe(false);
    }
  });

  it('rejects other Library project identities before source discovery', () => {
    const input: ProductLibraryInput = {
      operation: 'library.workflow',
      requestId: 'portfolio-test',
      projectId: 'unapproved-library',
      workflowId: 'library.portfolio-private-deploy',
      workflowVersion: 1,
      parameters: {},
    };
    const project = { projectId: 'unapproved-library', kind: 'library' } as RegisteredProject;
    const route = {} as LibraryRouteAuthority;
    const options = {} as TrustedLibraryOptions;
    expect(() => prepareLibraryOperation(project, input, route, options))
      .toThrow('PORTFOLIO_LIBRARY_SCOPE_DENIED');
  });

  it('rejects model-supplied arguments instead of exposing arbitrary execution', () => {
    const project = { projectId: 'investment-library', kind: 'library' } as RegisteredProject;
    const route = {} as LibraryRouteAuthority;
    const options = {} as TrustedLibraryOptions;
    const input: ProductLibraryInput = {
      operation: 'library.workflow',
      requestId: 'portfolio-untrusted',
      projectId: 'investment-library',
      workflowId: 'library.portfolio-build',
      workflowVersion: 1,
      parameters: { command: 'wrangler deploy' },
    };
    expect(() => prepareLibraryOperation(project, input, route, options))
      .toThrow('PORTFOLIO_LIBRARY_SCOPE_DENIED');
  });
});
