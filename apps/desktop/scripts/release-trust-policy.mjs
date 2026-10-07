import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

export const productIdentity = Object.freeze(JSON.parse(await readFile(
  new URL('../src/main/gotzji-product-identity.json', import.meta.url), 'utf8',
)));

export function createReleaseTrustDeclaration() {
  return {
    policy: productIdentity.releaseTrustPolicy,
    publisher: productIdentity.publisher,
    repositoryUrl: productIdentity.repositoryUrl,
    automaticUpdatesEnabled: productIdentity.automaticUpdatesEnabled,
  };
}

/** Unsigned is an explicit owner policy; hash, runtime and provenance checks still run. */
export function validateReleaseTrustDeclaration(provenance) {
  const actual = provenance?.build?.releaseTrust;
  const expected = createReleaseTrustDeclaration();
  if (!actual || Object.keys(expected).some((key) => actual[key] !== expected[key])) {
    throw new Error('The gotzji release trust declaration is missing or differs from the owned product policy');
  }
  if (provenance.product !== productIdentity.name || provenance.source?.repository !== productIdentity.repositoryUrl) {
    throw new Error('The gotzji product or source repository does not match the owned release identity');
  }
  if (provenance.platform === 'win32') {
    if (provenance.build?.signingCredentialConfigured !== false) {
      throw new Error('The gotzji official-unsigned Windows policy requires signing credentials to be absent');
    }
    const artifacts = provenance.artifacts?.filter((entry) => entry?.name?.endsWith('.exe'));
    const signatures = provenance.build?.windowsAuthenticode;
    if (!Array.isArray(artifacts) || artifacts.length !== 2 || !Array.isArray(signatures) || signatures.length !== 2) {
      throw new Error('The gotzji unsigned declaration requires Authenticode observations for Setup and Portable');
    }
    for (const artifact of artifacts) {
      const signature = signatures.find((entry) => entry?.name === artifact.name);
      if (!signature || signature.status !== 'NotSigned' || signature.sha256 !== artifact.sha256
        || signature.signerCertificateSha1 !== undefined || signature.signerSubject !== undefined) {
        throw new Error(`The gotzji official-unsigned policy requires exact-byte NotSigned evidence for ${artifact.name}`);
      }
    }
  }
  return actual;
}
