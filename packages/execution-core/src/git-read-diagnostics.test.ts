import { describe, expect, it } from 'vitest';
import { formatGitReadDiagnostic, parseGitReadDiagnostic } from './git-read-diagnostics.js';
const valid = { schemaVersion: 1, code: 'GIT_SNAPSHOT_BUDGET', phase: 'objects', elapsedMs: 25001, phaseStartsMs: { census: 0, metadata: 1200, config: 1210, 'object-directories': 1230, objects: 1250 }, totalObjects: 10023, copiedObjects: 8000, copiedBytes: 500000, ioThreads: 16 };
describe('private Git read budget diagnostics', () => {
  it('round trips only bounded phase, counts, bytes, elapsed and numeric pool configuration', () => {
    const line = formatGitReadDiagnostic(valid); expect(line).toContain('[gotzji-git-read-budget] ');
    expect(parseGitReadDiagnostic(line!)).toEqual(valid); expect(line).not.toContain('filePath');
  });
  it.each([{ path: 'PRIVATE_PATH' }, { projectId: 'PRIVATE_PROJECT' }, { token: 'PRIVATE_TOKEN' }, { phase: 'PRIVATE_PHASE' }, { elapsedMs: Infinity }, { copiedObjects: 10024 }, { ioThreads: -1 }, { phaseStartsMs: { objects: 25002 } }, { phaseStartsMs: { private: 1 } }])('rejects private or invalid fields instead of forwarding them: %j', change => {
    expect(formatGitReadDiagnostic({ ...valid, ...change })).toBeUndefined();
  });
  it('rejects arbitrary stderr, malformed JSON, oversized lines and an undeclared budget code', () => {
    expect(parseGitReadDiagnostic('private arbitrary stderr')).toBeUndefined();
    expect(parseGitReadDiagnostic('[gotzji-git-read-budget] {')).toBeUndefined();
    expect(parseGitReadDiagnostic('[gotzji-git-read-budget] ' + 'x'.repeat(2048))).toBeUndefined();
    expect(formatGitReadDiagnostic({ ...valid, code: 'PRIVATE_CODE' })).toBeUndefined();
  });
});
