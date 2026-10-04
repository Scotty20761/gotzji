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
export interface GraceProfile {
  readonly recipe: 'source-snapshot' | 'code-check';
  readonly expectedContent: string | null;
  readonly expectedHash: string;
  readonly validationMs: number;
  readonly mode: 'claude' | 'test-driver';
  readonly executable: string;
  readonly executableHash: string;
  readonly sourceFile: string;
  readonly sourceHash: string;
  readonly documents: Readonly<Record<string, { path: string; hash: string }>>;
  readonly libraryRoot: string;
  readonly testDriver: string | null;
  readonly testDriverHash: string | null;
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
  for (const entry of [{ path: profile.executable, hash: profile.executableHash }, { path: profile.sourceFile, hash: profile.sourceHash }, ...Object.values(profile.documents), ...(profile.testDriver && profile.testDriverHash ? [{ path: profile.testDriver, hash: profile.testDriverHash }] : [])]) {
    try { verifyFingerprint(entry.path, entry.hash); } catch { throw new CoreError('GRACE_DEPENDENCIES_CHANGED'); }
  }
}
