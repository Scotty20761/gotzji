import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LibraryWorkflowAdapter } from './library-workflow-adapter.js';
import { LIBRARY_WORKFLOW_REGISTRY } from './library-workflow-registry.js';
import { digestLibraryValue, type LibraryRouteAuthority, type LibraryRouteKind, type LibraryWorkflowDefinition, type LibraryWorkflowInput, type LibraryWorkflowPreparation } from './library-workflow-contract.js';
import { discoverPolicies } from './product-projects.js';
import { CoreError, type FileFingerprint, type RegisteredProject } from './types.js';
import { hash } from './store.js';

export interface ProductLibraryInput extends LibraryWorkflowInput {
  readonly operation: 'library.workflow'; readonly priority?: number; readonly dependsOn?: readonly string[];
}
export interface TrustedLibraryOptions {
  readonly pythonExecutable: string;
  readonly pythonSha256: string;
  readonly testRunnerModule?: string;
}
export interface PreparedLibraryOperation {
  readonly kind: 'library'; readonly input: ProductLibraryInput; readonly project: RegisteredProject;
  readonly projectPolicies: Readonly<Record<string, FileFingerprint>>; readonly policyDirectories: readonly string[];
  readonly library: LibraryWorkflowPreparation & {
    readonly resources: readonly string[];
    readonly selectedSources: readonly FileFingerprint[];
    readonly python: FileFingerprint;
    readonly finalMemo?: {
      readonly ticker: string;
      readonly period: string;
      readonly targetRelativePath: string;
      readonly cardRelativePath: string;
      readonly filingRelativePaths: readonly string[];
      readonly earningsRelativePaths: readonly string[];
    };
  };
}
export function libraryRoute(owner: string, adapterId: string, authorityId: string, project: RegisteredProject, route: LibraryRouteKind): LibraryRouteAuthority {
  if (project.kind !== 'library' || !['gotzji-library','lnwjud-library'].includes(route)) throw new CoreError('LIBRARY_ROUTE_AUTHORITY_DENIED');
  return { route, adapterId, ownerId: owner, authorityId, projectId: project.projectId, catalogId: route === 'gotzji-library' ? 'gotzji.library.v1' : 'lnwjud.library.v1' };
}
export const RUNNABLE_LIBRARY_WORKFLOWS = new Set(['library.read:1','library.code-qa:2','library.weekly-reading:2','library.memo-review:1','library.final-memo:2']);
export function prepareLibraryOperation(project: RegisteredProject, input: ProductLibraryInput, route: LibraryRouteAuthority, options: TrustedLibraryOptions): PreparedLibraryOperation {
  if (!input || Object.keys(input).some((key) => !['operation','requestId','projectId','workflowId','workflowVersion','parameters','priority','dependsOn'].includes(key)) || input.operation !== 'library.workflow') throw new CoreError('LIBRARY_INPUT_INVALID');
  if (!RUNNABLE_LIBRARY_WORKFLOWS.has(`${input.workflowId}:${input.workflowVersion}`)) throw new CoreError('LIBRARY_EXECUTOR_NOT_REGISTERED');
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 3)) throw new CoreError('LIBRARY_INPUT_INVALID', undefined, 'priority');
  const adapter = new LibraryWorkflowAdapter(async () => { throw new Error('PREPARATION_NEVER_GRANTS_EXECUTION'); });
  const prepared = adapter.prepare(project.rootPath, route, { requestId: input.requestId, projectId: input.projectId, workflowId: input.workflowId, workflowVersion: input.workflowVersion, parameters: input.parameters });
  let selected: string[] = [];
  if (input.parameters.paths !== undefined) {
    if (typeof input.parameters.paths !== 'string') throw new CoreError('LIBRARY_INPUT_INVALID', undefined, 'paths');
    try { selected = JSON.parse(input.parameters.paths) as string[]; } catch { throw new CoreError('LIBRARY_INPUT_INVALID', 'Use a JSON array of relative source paths', 'paths'); }
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > 20 || selected.some((filename) => typeof filename !== 'string' || path.isAbsolute(filename))) throw new CoreError('LIBRARY_INPUT_INVALID', undefined, 'paths');
  }
  const finalMemo = input.workflowId === 'library.final-memo' && input.workflowVersion === 2
    ? prepareFinalMemoScope(project.rootPath, input.parameters, selected)
    : undefined;
  if (finalMemo) selected = finalMemo.selected;
  const selectedSources = selected.map((filename): FileFingerprint => {
    const target = path.resolve(project.rootPath, filename); const relative = path.relative(project.rootPath, target);
    if (/\.pdf$/iu.test(filename)) throw new CoreError('LIBRARY_PDF_PROVIDER_REQUIRED', 'PDF evidence requires the canonical NotebookLM provider before this workflow can run', 'paths');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(target) || lstatSync(target).isSymbolicLink() || realpathSync(target) !== target || !lstatSync(target).isFile() || !/\.(md|txt|js|ts|mjs|py|json)$/u.test(filename)) throw new CoreError('LIBRARY_SOURCE_SCOPE_DENIED', undefined, 'paths');
    const bytes = readFileSync(target); if (bytes.length > 65536 || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new CoreError('LIBRARY_SOURCE_FORMAT_DENIED');
    return { path: target, hash: hash(bytes) };
  });
  const python = { path: realpathSync(options.pythonExecutable), hash: options.pythonSha256 };
  if (hash(readFileSync(python.path)) !== python.hash) throw new CoreError('LIBRARY_EXECUTOR_CHANGED');
  const policies = discoverPolicies(project.rootPath, selectedSources.map((entry) => path.dirname(entry.path)));
  const workflowPolicies = Object.fromEntries(prepared.sourceScope.descriptors.map((entry) => [`library_policy_${entry.id}`, { path: path.join(project.rootPath, entry.relativePath), hash: entry.sha256 }]));
  return { kind: 'library', input: { ...input, parameters: prepared.input.parameters }, project, projectPolicies: { ...policies.projectPolicies, ...workflowPolicies }, policyDirectories: policies.policyDirectories,
    library: { ...prepared, resources: [`project:${project.resourceKey}`, `library-vault:${project.resourceKey}`, ...(prepared.ast.nodes.some((entry) => entry.actor !== 'grace') ? ['global:library-roster-writer'] : [])], selectedSources, python,
      ...(finalMemo ? { finalMemo: finalMemo.metadata } : {}) } };
}
export function libraryCatalog(): readonly LibraryWorkflowDefinition[] { return LIBRARY_WORKFLOW_REGISTRY.filter((entry) => RUNNABLE_LIBRARY_WORKFLOWS.has(`${entry.id}:${entry.version}`)); }
export function signLibraryBinding(config: { owner: string; jobId: string; epoch: string; generation: number; session: string; intentRevision: number; policy: string; token: string; lease: string; text: string }): { body: string; mac: string } {
  const body = JSON.stringify({ owner: config.owner, jobId: config.jobId, epoch: config.epoch, generation: config.generation, session: config.session, intentRevision: config.intentRevision, policy: config.policy, leaseDigest: hash(config.lease), textDigest: hash(config.text) });
  return { body, mac: createHmac('sha256', config.token).update(body).digest('hex') };
}
export function libraryPreparationDigest(prepared: PreparedLibraryOperation): string { return digestLibraryValue(prepared.library); }

export function verifiedLibraryNavigationEvolution(
  prepared: PreparedLibraryOperation,
  database: DatabaseSync,
  jobId: string,
  worker: { readonly epoch: string; readonly token: string },
  effectRoot: string,
): ReadonlyMap<string, string | null> | null {
  if (prepared.library.ast.workflowId !== 'library.final-memo' || prepared.library.ast.workflowVersion !== 2) return null;
  const row = database.prepare("SELECT phase,receipt FROM gotzji_recipe_operations WHERE job_id=? AND operation_id='library-step:index'").get(jobId) as { phase?: string; receipt?: string } | undefined;
  if (!row) return null;
  if (row.phase !== 'verified' || typeof row.receipt !== 'string') throw new CoreError('LIBRARY_NAVIGATION_RECEIPT_INVALID');
  const stored = JSON.parse(row.receipt) as { receipt?: { stepId?: string; operation?: string; status?: string } };
  if (stored.receipt?.stepId !== 'index' || stored.receipt.operation !== 'library.memo.index' || stored.receipt.status !== 'completed') throw new CoreError('LIBRARY_NAVIGATION_RECEIPT_INVALID');
  const readStep = (stepId: string): Record<string, unknown> => {
    const filename = path.join(effectRoot, `library-step-${stepId}.json`);
    if (!existsSync(filename) || lstatSync(filename).isSymbolicLink() || realpathSync(filename) !== filename) throw new CoreError('LIBRARY_NAVIGATION_RECEIPT_INVALID');
    const envelope = JSON.parse(readFileSync(filename, 'utf8')) as { body?: string; mac?: string };
    if (typeof envelope.body !== 'string' || typeof envelope.mac !== 'string'
      || createHmac('sha256', worker.token).update(envelope.body).digest('hex') !== envelope.mac) throw new CoreError('LIBRARY_NAVIGATION_RECEIPT_INVALID');
    const body = JSON.parse(envelope.body) as { jobId?: string; epoch?: string; stepId?: string; valueDigest?: string; value?: Record<string, unknown> };
    if (body.jobId !== jobId || body.epoch !== worker.epoch || body.stepId !== stepId || body.valueDigest !== hash(JSON.stringify(body.value ?? null)) || !body.value) throw new CoreError('LIBRARY_NAVIGATION_RECEIPT_INVALID');
    return body.value;
  };
  const preflight = readStep('preflight'); const index = readStep('index');
  const before = preflight.navigationSnapshot; const after = index.navigationAfter; const effects = index.navigationEffects;
  if (!isNavigationSnapshot(before) || !isNavigationSnapshot(after) || !Array.isArray(effects)) throw new CoreError('LIBRARY_NAVIGATION_RECEIPT_INVALID');
  const expectedEffects = navigationDiff(before, after);
  if (JSON.stringify(effects) !== JSON.stringify(expectedEffects) || JSON.stringify(captureNavigation(prepared.project.rootPath)) !== JSON.stringify(after)) throw new CoreError('LIBRARY_NAVIGATION_CHANGED');
  return new Map(expectedEffects.map((entry) => [path.resolve(prepared.project.rootPath, entry.relativePath), entry.afterSha256]));
}

function captureNavigation(root: string): Record<string, string | null> {
  const files = ['KNOWLEDGE_INDEX.md', 'knowledge-base/index.md', 'knowledge-base/topic-map.md', 'knowledge-base/contradiction-registry.md'];
  for (const directory of ['indexes', 'indexes/tickers', 'indexes/themes', 'indexes/authors']) {
    const absolute = path.join(root, directory); if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.md')) files.push(`${directory}/${entry.name}`);
  }
  return Object.fromEntries([...new Set(files)].sort().map((relative) => {
    const target = path.resolve(root, relative); const scoped = path.relative(root, target);
    if (!scoped || scoped.startsWith('..') || path.isAbsolute(scoped)) throw new CoreError('LIBRARY_NAVIGATION_SCOPE_INVALID');
    if (!existsSync(target)) return [relative, null];
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || realpathSync(target) !== target) throw new CoreError('LIBRARY_NAVIGATION_SCOPE_INVALID');
    return [relative, hash(readFileSync(target))];
  }));
}

function isNavigationSnapshot(value: unknown): value is Record<string, string | null> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([name, sha256]) => {
    return /^(?:KNOWLEDGE_INDEX\.md|knowledge-base\/(?:index|topic-map|contradiction-registry)\.md|indexes\/(?:INDEX_[^/]+|(?:tickers|themes|authors)\/[^/]+)\.md)$/u.test(name)
      && (sha256 === null || /^[a-f0-9]{64}$/u.test(String(sha256)));
  });
}

function navigationDiff(before: Record<string, string | null>, after: Record<string, string | null>): { relativePath: string; beforeSha256: string | null; afterSha256: string | null }[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter((name) => before[name] !== after[name])
    .map((relativePath) => ({ relativePath, beforeSha256: before[relativePath] ?? null, afterSha256: after[relativePath] ?? null }));
}

function prepareFinalMemoScope(
  root: string,
  parameters: Readonly<Record<string, string | number | boolean>>,
  requested: readonly string[],
): { readonly selected: string[]; readonly metadata: NonNullable<PreparedLibraryOperation['library']['finalMemo']> } {
  if (typeof parameters.ticker !== 'string') throw new CoreError('LIBRARY_MEMO_TICKER_REQUIRED', undefined, 'ticker');
  const ticker = parameters.ticker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/u.test(ticker)) throw new CoreError('LIBRARY_MEMO_TICKER_INVALID', undefined, 'ticker');
  const period = parameters.evidencePeriod === undefined ? bangkokPeriod() : parameters.evidencePeriod;
  if (typeof period !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) throw new CoreError('LIBRARY_MEMO_PERIOD_INVALID', 'Use YYYY-MM', 'evidencePeriod');
  const card = `team-outputs/cards/${ticker}/Company Overview.md`;
  const filings = matchingRelativeFiles(root, 'team-outputs/filings', (name) => name.toUpperCase().startsWith(`${ticker}_`) && name.endsWith('.md'), 4);
  const earnings = matchingRelativeFiles(root, 'team-outputs/earnings', (name) => {
    const upper = name.toUpperCase(); return (upper.startsWith(`${ticker}-`) || upper.startsWith(`${ticker}_`)) && name.endsWith('.md');
  }, 4);
  const missing = [!existsSync(path.join(root, card)) ? 'Company Card' : '', filings.length === 0 ? 'Filing' : '', earnings.length === 0 ? 'Earnings' : ''].filter(Boolean);
  if (missing.length > 0) throw new CoreError('LIBRARY_MEMO_DEPENDENCY_GAP', `Missing required canonical input(s): ${missing.join(', ')}`, 'ticker');
  const targetRelativePath = `team-outputs/memos/${ticker}_memo_${period}.md`;
  if (!existsSync(path.join(root, 'team-outputs', 'memos')) || !lstatSync(path.join(root, 'team-outputs', 'memos')).isDirectory()) throw new CoreError('LIBRARY_MEMO_DEPENDENCY_GAP', 'Canonical memo directory is missing', 'ticker');
  if (existsSync(path.join(root, targetRelativePath))) throw new CoreError('LIBRARY_CANONICAL_MEMO_EXISTS', 'The canonical monthly memo already exists; select a refresh workflow instead of overwriting it', 'evidencePeriod');
  const indexes = ['indexes/INDEX_outputs.md', `indexes/tickers/${ticker}.md`, 'knowledge-base/index.md', 'knowledge-base/topic-map.md', 'knowledge-base/contradiction-registry.md'];
  if (indexes.some((entry) => !existsSync(path.join(root, entry)))) throw new CoreError('LIBRARY_MEMO_DEPENDENCY_GAP', 'Canonical output and ticker indexes are required', 'ticker');
  const research = matchingRelativeFiles(root, 'team-outputs/research-reports', (name) => name.toUpperCase().includes(ticker) && name.endsWith('.md'), 4);
  const prior = matchingRelativeFiles(root, 'team-outputs/memos', (name) => name.toUpperCase().startsWith(`${ticker}_MEMO_`) && name.endsWith('.md'), 1);
  const selected = [...new Set([...indexes, card, ...filings, ...earnings, ...research, ...prior, ...requested.map((entry) => entry.replaceAll('\\', '/'))])];
  if (selected.length > 20) throw new CoreError('LIBRARY_SOURCE_SCOPE_TOO_LARGE', 'Select at most 20 frozen sources', 'paths');
  return { selected, metadata: { ticker, period, targetRelativePath, cardRelativePath: card, filingRelativePaths: filings, earningsRelativePaths: earnings } };
}

function matchingRelativeFiles(root: string, directory: string, accept: (name: string) => boolean, limit: number): string[] {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute) || !lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink() || realpathSync(absolute) !== absolute) return [];
  return readdirSync(absolute, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.isSymbolicLink() && accept(entry.name))
    .map((entry) => `${directory}/${entry.name}`).sort((left, right) => right.localeCompare(left)).slice(0, limit);
}

function bangkokPeriod(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const year = parts.find((entry) => entry.type === 'year')?.value; const month = parts.find((entry) => entry.type === 'month')?.value;
  if (!year || !month) throw new CoreError('LIBRARY_CLOCK_UNAVAILABLE');
  return `${year}-${month}`;
}
