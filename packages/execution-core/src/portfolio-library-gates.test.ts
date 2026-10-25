import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { portfolioAuthority, verifyPortfolioBuild, verifyPortfolioBundleIntegrity } from './product-library-broker.mjs';

const roots: string[] = [];
const header = 'as_of_date,source,ticker,shares,avg_cost,total_cost,market_value,last_price,status';
const row = '2026-01-12,synthetic_fixture,TEST,2.2500000,54.8667,123.45,126.00,56.0000,open';
const expectedState = {
  as_of: '2026-01-12',
  reconciliation: {
    open_positions: { expected: 1, computed: 1, status: 'pass' },
    phantom_open_positions: [],
    positions: [{
      ticker: 'TEST', expected_shares: 2.2500000, computed_shares: 2.2500000,
      share_delta: 0, share_tolerance: 0.00002, expected_cost: 123.45,
      computed_cost: 123.45, cost_delta: 0, status: 'pass',
    }],
  },
};
function fixture(): { root: string; prepared: { project: { projectId: string; kind: string; rootPath: string }; library: { ast: { workflowId: string; workflowVersion: number } } } } {
  const root = mkdtempSync(path.join(tmpdir(), 'gotzji-portfolio-gates-'));
  roots.push(root);
  mkdirSync(path.join(root, 'data', 'build'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'broker_snapshot.csv'), [header, row, ''].join('\n'));
  writeFileSync(path.join(root, 'data', 'build', 'portfolio-state.json'), JSON.stringify(expectedState));
  const bundle = path.join(root, 'private-dist', 'site', 'inputs', 'Dashboards', 'Portfolio', 'data');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(bundle, 'portfolio-state.json'), JSON.stringify(expectedState));
  const prepared = {
    project: { projectId: 'investment-library', kind: 'library', rootPath: root },
    library: { ast: { workflowId: 'library.portfolio-build', workflowVersion: 1 } },
  };
  return { root, prepared };
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('private Portfolio reconciliation must fail closed', () => {
  it('only accepts a matched independent broker count and as-of date', () => {
    const { prepared } = fixture();
    expect(portfolioAuthority(prepared)).toEqual({ asOf: '2026-01-12', positions: 1 });
    expect(verifyPortfolioBuild(prepared)).toMatchObject({
      asOf: '2026-01-12', openPositions: 1, build: 'verified',
    });
  });

  it('rejects an unchanged old build or phantom holding', () => {
    const { root, prepared } = fixture();
    writeFileSync(path.join(root, 'data', 'build', 'portfolio-state.json'),
      JSON.stringify({ ...expectedState, as_of: '2026-10-21' }));
    expect(() => verifyPortfolioBuild(prepared)).toThrow('PORTFOLIO_RECONCILIATION_NOT_PROVEN');
    writeFileSync(path.join(root, 'data', 'build', 'portfolio-state.json'),
      JSON.stringify({ ...expectedState, reconciliation: {
        ...expectedState.reconciliation, phantom_open_positions: [{ ticker: 'GHOST' }],
      } }));
    expect(() => verifyPortfolioBuild(prepared)).toThrow('PORTFOLIO_RECONCILIATION_NOT_PROVEN');
  });

  it('rejects a stale private bundle even when its as-of date matches', () => {
    const { root, prepared } = fixture();
    expect(verifyPortfolioBundleIntegrity(prepared)).toEqual({ asOf: '2026-01-12' });
    const file = path.join(root, 'private-dist', 'site', 'inputs', 'Dashboards', 'Portfolio', 'data', 'portfolio-state.json');
    writeFileSync(file, JSON.stringify({ ...expectedState, summary: { fakeTotal: 999.99 } }));
    expect(() => verifyPortfolioBundleIntegrity(prepared)).toThrow('PORTFOLIO_RELEASE_BUNDLE_DRIFT');
  });

  it('rejects duplicate broker rows and foreign Library identity', () => {
    const { root, prepared } = fixture();
    writeFileSync(path.join(root, 'data', 'broker_snapshot.csv'), [header, row, row, ''].join('\n'));
    expect(() => portfolioAuthority(prepared)).toThrow('PORTFOLIO_SNAPSHOT_INCOMPLETE');
    expect(() => portfolioAuthority({
      ...prepared, project: { ...prepared.project, projectId: 'another-library' },
    })).toThrow('PORTFOLIO_LIBRARY_SCOPE_DENIED');
  });
});
