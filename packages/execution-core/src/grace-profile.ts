import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { hash } from './store.js';
import { CoreError } from './types.js';
/** Host-selected registration. This configuration is never accepted in model arguments. */
export interface GraceRegistration {
  readonly executable: string;
  readonly libraryRoot: string;
  readonly sourceFile: string;
  readonly testDriver?: string;
}
export interface GraceProfile {
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
  const documents = Object.fromEntries([
    ['rules', 'CLAUDE.md'], ['agents', 'AGENTS.md'],
    ['workflow', 'references/agent-knowledge-workflow.md'], ['index', 'KNOWLEDGE_INDEX.md'],
  ].map(([key, file]) => {
    if (!key || !file) throw new CoreError('GRACE_PROFILE_INVALID');
    const filename = realpathSync(path.join(libraryRoot, file));
    return [key, { path: filename, hash: hash(readFileSync(filename)) }];
  }));
  const testDriver = registration.testDriver ? realpathSync(registration.testDriver) : null;
  return { mode: testDriver ? 'test-driver' : 'claude', executable, executableHash: hash(readFileSync(executable)), libraryRoot,
    sourceFile, sourceHash: hash(readFileSync(sourceFile)), documents, testDriver,
    testDriverHash: testDriver ? hash(readFileSync(testDriver)) : null };
}
export function assertGraceProfile(profile: GraceProfile): void {
  for (const entry of [{ path: profile.executable, hash: profile.executableHash }, { path: profile.sourceFile, hash: profile.sourceHash }, ...Object.values(profile.documents), ...(profile.testDriver && profile.testDriverHash ? [{ path: profile.testDriver, hash: profile.testDriverHash }] : [])]) {
    if (realpathSync(entry.path) !== entry.path || hash(readFileSync(entry.path)) !== entry.hash) throw new CoreError('GRACE_DEPENDENCIES_CHANGED');
  }
}
