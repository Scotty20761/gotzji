import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { hash } from './store.js';
import { CoreError } from './types.js';
import { verifyFingerprint } from './fingerprints.mjs';
/** Host-selected registration. This configuration is never accepted in model arguments. */
export interface GraceRegistration {
  readonly executable: string;
  readonly libraryRoot: string;
  readonly sourceFile: string;
  readonly testDriver?: string;
  readonly recipe?: 'source-snapshot' | 'code-check';
  readonly expectedContent?: string;
  readonly validationMs?: number;
}
export interface ProductGraceRegistration {
  readonly executable: string;
  readonly libraryRoot: string;
  readonly testDriver?: string;
}
/** Trusted host-only selection. Provider fixtures are never accepted from product config or MCP. */
export interface HostDirectRegistration {
  readonly mode: 'host-direct';
  readonly libraryRoot: string;
  readonly testOnlyProviders?: true;
}
export type ProductRegistration = ProductGraceRegistration | HostDirectRegistration;
export interface GraceProfile {
  readonly recipe: 'source-snapshot' | 'code-check' | 'product';
  readonly expectedContent: string | null;
  readonly expectedHash: string;
  readonly validationMs: number;
  readonly mode: 'claude' | 'test-driver' | 'host-direct';
  readonly testOnlyProviders?: true;
  readonly executable?: string;
  readonly executableHash?: string;
  readonly sourceFile: string;
  readonly sourceHash: string;
  readonly documents: Readonly<Record<string, { path: string; hash: string }>>;
  readonly libraryRoot: string;
  readonly testDriver: string | null;
  readonly testDriverHash: string | null;
}
export function productGraceProfile(registration: ProductRegistration): GraceProfile {
  if ('mode' in registration && registration.mode === 'host-direct') {
    const libraryRoot = realpathSync(registration.libraryRoot);
    const documents = Object.fromEntries([['rules','CLAUDE.md'],['agents','AGENTS.md'],['workflow','references/agent-knowledge-workflow.md'],['index','KNOWLEDGE_INDEX.md']].map(([key, relative]) => {
      const filename = realpathSync(path.join(libraryRoot, relative!));
      return [key!, { path: filename, hash: hash(readFileSync(filename)) }];
    }));
    const sourceFile = documents.rules!.path; const sourceHash = documents.rules!.hash;
    return { recipe: 'product', mode: 'host-direct', libraryRoot, documents, sourceFile, sourceHash, expectedContent: null, expectedHash: sourceHash, validationMs: 0, testDriver: null, testDriverHash: null, ...(registration.testOnlyProviders ? { testOnlyProviders: true } : {}) };
  }
  if (!('executable' in registration)) throw new CoreError('PRODUCT_PROFILE_INVALID');
  const profile = graceProfile({ ...registration, sourceFile: path.join(registration.libraryRoot, 'CLAUDE.md') });
  return { ...profile, recipe: 'product' };
}
export function graceProfile(registration: GraceRegistration): GraceProfile {
  const libraryRoot = realpathSync(registration.libraryRoot);
  const executable = realpathSync(registration.executable);
  const sourceFile = realpathSync(registration.sourceFile);
  const recipe = registration.recipe ?? 'source-snapshot';
  const expectedContent = recipe === 'code-check' ? registration.expectedContent : null;
  if (recipe === 'code-check' && expectedContent !== 'export function add(a, b) { return a + b; }\n') throw new CoreError('CODE_RECIPE_NOT_REGISTERED');
  if (recipe === 'code-check' && readFileSync(sourceFile,'utf8') !== 'export function add(a, b) { return a - b; }\n') throw new CoreError('CODE_SOURCE_NOT_REGISTERED');
  const validationMs = registration.validationMs ?? 25;
  if (!Number.isInteger(validationMs) || validationMs < 0 || validationMs > 600000) throw new CoreError('CODE_VALIDATION_BUDGET_INVALID');
  const documents = Object.fromEntries([
    ['rules', 'CLAUDE.md'], ['agents', 'AGENTS.md'],
    ['workflow', 'references/agent-knowledge-workflow.md'], ['index', 'KNOWLEDGE_INDEX.md'],
    ...(recipe === 'code-check' ? [['engineering','.claude/skills/karpathy-guidelines/SKILL.md'],['debug','.claude/skills/debug-mantra/SKILL.md']] : []),
  ].map(([key, file]) => {
    if (!key || !file) throw new CoreError('GRACE_PROFILE_INVALID');
    const filename = realpathSync(path.join(libraryRoot, file));
    return [key, { path: filename, hash: hash(readFileSync(filename)) }];
  }));
  const testDriver = registration.testDriver ? realpathSync(registration.testDriver) : null;
  return { recipe, expectedContent: expectedContent ?? null, expectedHash: hash(expectedContent ?? readFileSync(sourceFile)), validationMs, mode: testDriver ? 'test-driver' : 'claude', executable, executableHash: hash(readFileSync(executable)), libraryRoot,
    sourceFile, sourceHash: hash(readFileSync(sourceFile)), documents, testDriver,
    testDriverHash: testDriver ? hash(readFileSync(testDriver)) : null };
}
export function assertGraceProfile(profile: GraceProfile): void {
  for (const entry of profileDependencies(profile)) {
    try { verifyFingerprint(entry.path, entry.hash); } catch { throw new CoreError('GRACE_DEPENDENCIES_CHANGED'); }
  }
}
export function profileDependencies(profile: GraceProfile): readonly { path: string; hash: string }[] {
  return [...(profile.mode === 'host-direct' ? [] : [{ path: profile.executable!, hash: profile.executableHash! }]), { path: profile.sourceFile, hash: profile.sourceHash }, ...Object.values(profile.documents), ...(profile.testDriver && profile.testDriverHash ? [{ path: profile.testDriver, hash: profile.testDriverHash }] : [])];
}
export function testProviderProfile(profile: Pick<GraceProfile, 'mode' | 'testOnlyProviders'> | null): boolean {
  return profile?.mode === 'test-driver' || (profile?.mode === 'host-direct' && profile.testOnlyProviders === true);
}
