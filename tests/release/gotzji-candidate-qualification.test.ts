import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone release tooling is JavaScript.
import { verifyCandidateQualification } from '../../scripts/verify-candidate-qualification.mjs';

function fixture(): { provenance: { product: string; platform: string; arch: string; version: string; source: { repository: string; commit: string; dirty: boolean }; gotzjiCore: { manifestSha256: string }; artifacts: Array<{ name: string; sha256: string }> }; pluginProvenance: { product: string; version: string; source: { commit: string; clean: boolean }; binding: { state: string; registeredAppIncluded: boolean }; archiveSha256: string }; qualification: { pluginArchiveSha256: string; schemaVersion: number; product: string; repository: string; sourceCommit: string; version: string; runtimeManifestSha256: string; artifacts: Array<{ name: string; sha256: string }>; gates: Array<Record<string, unknown>> } } {
  const artifacts = [{ name: 'gotzji-Setup-1.0.0.exe', sha256: 'b'.repeat(64) }, { name: 'gotzji-Portable-1.0.0.exe', sha256: 'c'.repeat(64) }];
  const provenance = { product: 'gotzji', platform: 'win32', arch: 'x64', version: '1.0.0', source: { repository: 'https://github.com/Scotty20761/gotzji', commit: 'a'.repeat(40), dirty: false }, gotzjiCore: { manifestSha256: 'd'.repeat(64) }, artifacts };
  const gates = Array.from({ length: 19 }, (_, index): Record<string, unknown> => ({ id: `G${String(index + 1).padStart(2, '0')}`, state: 'PASS', reviewer: 'fixture-not-a-real-acceptance', observedAt: '2026-01-01T00:00:00Z', evidence: [{ kind: 'candidate-acceptance', receiptSha256: 'e'.repeat(64) }] }));
  Object.assign(gates[13]!, { accountPlan: 'Pro', accountFingerprint: '1'.repeat(64) });
  Object.assign(gates[14]!, { state: 'NOT_REQUIRED', accountPlan: 'Plus', reviewer: 'owner', observedAt: '2026-10-17T00:46:08+07:00', decisionId: 'owner-plus-acceptance-not-required-2026-10-17', evidence: [{ kind: 'owner-decision', receiptSha256: 'a8c53c7c66714259d8bd02cd53f0dbdbffa1eb948769a3bd0d788f6fa5d86895' }] });
  Object.assign(gates[15]!, { meaningfulWorkSeconds: 3600, windowsRestartObserved: true, sameJobsRecovered: true, duplicateEffects: 0 });
  Object.assign(gates[18]!, { days: 3, acceptedJobs: 20, independentJobSessions: 2 });
  return { provenance, pluginProvenance: { product: 'gotzji-plugin', version: provenance.version, source: { commit: provenance.source.commit, clean: true }, binding: { state: 'unbound-template', registeredAppIncluded: false }, archiveSha256: 'f'.repeat(64) }, qualification: { pluginArchiveSha256: 'f'.repeat(64), schemaVersion: 1, product: 'gotzji', repository: 'https://github.com/Scotty20761/gotzji', sourceCommit: provenance.source.commit, version: provenance.version, runtimeManifestSha256: provenance.gotzjiCore.manifestSha256, artifacts: structuredClone(artifacts), gates } };
}

describe('candidate qualification declaration guard', () => {
  it('accepts an exact complete declaration without claiming post-publication G20', () => {
    const f = fixture(); const result = verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance);
    expect(result.acceptedGates).toHaveLength(18);
    expect(result.acceptedGates).not.toContain('G15');
    expect(result.notRequiredGates).toEqual(['G15']);
    expect(result.publicationVerification).toBe('G20_NOT_RUN');
  });
  it('rejects a missing external gate or a component substitute', () => {
    const f = fixture(); f.qualification.gates[12]!.state = 'BLOCKED_EXTERNAL';
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_GATE_NOT_ACCEPTED: G13');
    f.qualification.gates[12]!.state = 'PASS';
    f.qualification.gates[12]!.evidence = [{ kind: 'component-test', receiptSha256: 'e'.repeat(64) }];
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_GATE_NOT_ACCEPTED: G13');
  });
  it('requires the exact owner decision rather than inventing Plus acceptance', () => {
    for (const mutate of [
      (entry: Record<string, unknown>): void => { entry.state = 'PASS'; },
      (entry: Record<string, unknown>): void => { entry.state = 'BLOCKED_EXTERNAL'; },
      (entry: Record<string, unknown>): void => { entry.decisionId = 'some-other-waiver'; },
      (entry: Record<string, unknown>): void => { entry.reviewer = 'fixture-not-owner'; },
      (entry: Record<string, unknown>): void => { entry.accountPlan = 'Pro'; },
      (entry: Record<string, unknown>): void => { entry.observedAt = '2999-01-01T00:00:00Z'; },
      (entry: Record<string, unknown>): void => { entry.evidence = []; },
      (entry: Record<string, unknown>): void => { entry.evidence = [{ kind: 'candidate-acceptance', receiptSha256: 'e'.repeat(64) }]; },
      (entry: Record<string, unknown>): void => { entry.evidence = [{ kind: 'owner-decision', receiptSha256: 'e'.repeat(64) }]; },
    ]) {
      const f = fixture(); mutate(f.qualification.gates[14]!);
      expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_OWNER_DECISION_REQUIRED: G15');
    }
  });
  it('does not extend the Plus decision to any other gate or omit its row', () => {
    const f = fixture(); f.qualification.gates[12]!.state = 'NOT_REQUIRED';
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_GATE_NOT_ACCEPTED: G13');
    f.qualification.gates[12]!.state = 'PASS'; f.qualification.gates.splice(14, 1);
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_GATES_INCOMPLETE');
    const duplicate = fixture(); duplicate.qualification.gates[13]!.id = 'G15';
    expect(() => verifyCandidateQualification(duplicate.qualification, duplicate.provenance, duplicate.pluginProvenance)).toThrow('QUALIFICATION_GATE_DUPLICATE_OR_MISSING');
  });
  it('rejects modified runtime/artifact bytes and dirty source', () => {
    const f = fixture(); f.qualification.artifacts[0]!.sha256 = 'f'.repeat(64);
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_ARTIFACT_MISMATCH');
    f.qualification.artifacts[0]!.sha256 = 'b'.repeat(64); f.provenance.source.dirty = true;
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_CANDIDATE_MISMATCH');
  });
  it('rejects a plugin from different source, binding, version, or archive bytes', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>): void => { f.pluginProvenance.source.commit = '9'.repeat(40); },
      (f: ReturnType<typeof fixture>): void => { f.pluginProvenance.source.clean = false; },
      (f: ReturnType<typeof fixture>): void => { f.pluginProvenance.binding.state = 'provided-unverified'; },
      (f: ReturnType<typeof fixture>): void => { f.pluginProvenance.version = '1.0.1'; },
      (f: ReturnType<typeof fixture>): void => { f.qualification.pluginArchiveSha256 = '0'.repeat(64); },
    ]) {
      const f = fixture(); mutate(f);
      expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_PLUGIN_MISMATCH');
    }
  });
  it('still requires an actual Pro declaration and meaningful installed recovery', () => {
    const f = fixture(); f.qualification.gates[13]!.accountPlan = 'Plus';
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_PRO_ACCOUNT_REQUIRED');
    f.qualification.gates[13]!.accountPlan = 'Pro'; f.qualification.gates[13]!.accountFingerprint = 'invalid';
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_PRO_ACCOUNT_REQUIRED');
    f.qualification.gates[13]!.accountFingerprint = '1'.repeat(64); f.qualification.gates[15]!.windowsRestartObserved = false;
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_INSTALLED_RECOVERY_REQUIRED');
  });
  it('does not waive the accepted pilot or duplicate missing gates', () => {
    const f = fixture(); f.qualification.gates[18]!.acceptedJobs = 19;
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_PILOT_REQUIRED');
    f.qualification.gates[18]!.acceptedJobs = 20; f.qualification.gates[18]!.id = 'G01';
    expect(() => verifyCandidateQualification(f.qualification, f.provenance, f.pluginProvenance)).toThrow('QUALIFICATION_GATE_DUPLICATE_OR_MISSING');
  });
});
