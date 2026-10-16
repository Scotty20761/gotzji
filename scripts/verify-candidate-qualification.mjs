import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const sha = /^[a-f0-9]{64}$/u;
const gates = Array.from({ length: 19 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`);
// Owner scope decision, not evidence that Plus was tested or is equivalent to Pro.
const plusDecision = { id: 'owner-plus-acceptance-not-required-2026-10-17',
  observedAt: '2026-10-17T00:46:08+07:00',
  receiptSha256: 'a8c53c7c66714259d8bd02cd53f0dbdbffa1eb948769a3bd0d788f6fa5d86895' };

/** Validates a reviewed acceptance declaration; it does not generate runtime evidence. */
export function verifyCandidateQualification(qualification, provenance, pluginProvenance) {
  if (qualification?.schemaVersion !== 1 || qualification.product !== 'gotzji'
    || qualification.repository !== 'https://github.com/Scotty20761/gotzji'
    || provenance?.product !== 'gotzji' || provenance.platform !== 'win32' || provenance.arch !== 'x64'
    || !/^[a-f0-9]{40}$/u.test(qualification.sourceCommit)
    || provenance.source?.repository !== 'https://github.com/Scotty20761/gotzji'
    || provenance.source?.dirty !== false || qualification.sourceCommit !== provenance.source?.commit
    || qualification.version !== provenance.version || !sha.test(qualification.runtimeManifestSha256)
    || qualification.runtimeManifestSha256 !== provenance.gotzjiCore?.manifestSha256) throw new Error('QUALIFICATION_CANDIDATE_MISMATCH');
  if (pluginProvenance?.product !== 'gotzji-plugin' || pluginProvenance.version !== qualification.version
    || pluginProvenance.source?.commit !== qualification.sourceCommit || pluginProvenance.source?.clean !== true
    || pluginProvenance.binding?.state !== 'unbound-template' || pluginProvenance.binding?.registeredAppIncluded !== false
    || !sha.test(qualification.pluginArchiveSha256) || qualification.pluginArchiveSha256 !== pluginProvenance.archiveSha256) throw new Error('QUALIFICATION_PLUGIN_MISMATCH');
  if (!Array.isArray(qualification.artifacts) || !Array.isArray(provenance.artifacts)
    || qualification.artifacts.length !== provenance.artifacts.length) throw new Error('QUALIFICATION_ARTIFACT_MISMATCH');
  for (const artifact of provenance.artifacts) {
    const accepted = qualification.artifacts.filter((item) => item.name === artifact.name);
    if (accepted.length !== 1 || !sha.test(accepted[0].sha256) || accepted[0].sha256 !== artifact.sha256) throw new Error('QUALIFICATION_ARTIFACT_MISMATCH');
  }
  if (!Array.isArray(qualification.gates) || qualification.gates.length !== gates.length) throw new Error('QUALIFICATION_GATES_INCOMPLETE');
  for (const id of gates) {
    const matching = qualification.gates.filter((entry) => entry.id === id);
    if (matching.length !== 1) throw new Error('QUALIFICATION_GATE_DUPLICATE_OR_MISSING');
    const entry = matching[0];
    if (id === 'G15') {
      if (entry.state !== 'NOT_REQUIRED' || entry.decisionId !== plusDecision.id
        || entry.reviewer !== 'owner' || entry.accountPlan !== 'Plus'
        || entry.observedAt !== plusDecision.observedAt || Date.parse(entry.observedAt) > Date.now()
        || !Array.isArray(entry.evidence) || entry.evidence.length !== 1
        || entry.evidence[0]?.kind !== 'owner-decision'
        || entry.evidence[0]?.receiptSha256 !== plusDecision.receiptSha256) throw new Error('QUALIFICATION_OWNER_DECISION_REQUIRED: G15');
      continue;
    }
    if (entry.state !== 'PASS' || typeof entry.reviewer !== 'string' || !entry.reviewer.trim()
      || !Number.isFinite(Date.parse(entry.observedAt)) || Date.parse(entry.observedAt) > Date.now()
      || !Array.isArray(entry.evidence) || entry.evidence.length === 0
      || entry.evidence.some((item) => item.kind !== 'candidate-acceptance' || !sha.test(item.receiptSha256))) throw new Error(`QUALIFICATION_GATE_NOT_ACCEPTED: ${id}`);
  }
  const pro = qualification.gates.find((entry) => entry.id === 'G14');
  if (pro.accountPlan !== 'Pro' || !sha.test(pro.accountFingerprint)) throw new Error('QUALIFICATION_PRO_ACCOUNT_REQUIRED');
  const endurance = qualification.gates.find((entry) => entry.id === 'G16');
  if (!Number.isFinite(endurance.meaningfulWorkSeconds) || endurance.meaningfulWorkSeconds < 3600
    || endurance.windowsRestartObserved !== true || endurance.sameJobsRecovered !== true
    || endurance.duplicateEffects !== 0) throw new Error('QUALIFICATION_INSTALLED_RECOVERY_REQUIRED');
  const pilot = qualification.gates.find((entry) => entry.id === 'G19');
  if (!Number.isInteger(pilot.days) || pilot.days < 3 || !Number.isInteger(pilot.acceptedJobs) || pilot.acceptedJobs < 20
    || !Number.isInteger(pilot.independentJobSessions) || pilot.independentJobSessions < 2) throw new Error('QUALIFICATION_PILOT_REQUIRED');
  return { product: 'gotzji', version: qualification.version, sourceCommit: qualification.sourceCommit,
    runtimeManifestSha256: qualification.runtimeManifestSha256, acceptedGates: gates.filter((id) => id !== 'G15'),
    notRequiredGates: ['G15'], publicationVerification: 'G20_NOT_RUN' };
}

async function main() {
  if (process.argv.length !== 5) throw new Error('Usage: node scripts/verify-candidate-qualification.mjs <QUALIFICATION.json> <PROVENANCE.json> <PLUGIN_PROVENANCE.json>');
  const qualification = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const provenance = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const pluginProvenance = JSON.parse(await readFile(process.argv[4], 'utf8'));
  const result = verifyCandidateQualification(qualification, provenance, pluginProvenance);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
