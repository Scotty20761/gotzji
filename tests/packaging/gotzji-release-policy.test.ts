import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Standalone packaging policy has no generated TypeScript declaration.
import { createReleaseTrustDeclaration, validateReleaseTrustDeclaration } from '../../apps/desktop/scripts/release-trust-policy.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '../../apps/desktop');
const temporaryRoots: string[] = [];
const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
interface Artifact { name: string; sha256: string; sizeBytes: number }
interface RuntimeEntry extends Artifact { relativePath: string }
interface ReleaseDeclaration {
  product: string; platform: string;
  source: { repository: string };
  artifacts: Artifact[];
  build: {
    releaseTrust: ReturnType<typeof createReleaseTrustDeclaration>;
    signingCredentialConfigured: boolean;
    windowsAuthenticode: Array<{ name: string; sha256: string; status: string }>;
  };
}
interface ReleaseFixtureProvenance extends ReleaseDeclaration {
  schemaVersion: number; version: string; arch: string;
  source: { repository: string; commit: string; dirty: boolean };
  runtime: RuntimeEntry[];
  gotzjiCore: { manifest: { schemaVersion: number; product: string; version: string; catalogVersion: number; storeSchemaVersion: number; entrypoint: string; files: Array<{ relativePath: string; sha256: string; sizeBytes: number }> }; manifestSha256: string };
  capabilityBridge: { fileName: string; sha256: string; sizeBytes: number };
}
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function declaredProvenance(): ReleaseDeclaration {
  const artifacts = ['gotzji-Setup-5.7.3.exe', 'gotzji-Portable-5.7.3.exe'].map((name) => ({ name, sha256: digest(name), sizeBytes: name.length }));
  return {
    product: 'gotzji', platform: 'win32',
    source: { repository: 'https://github.com/Scotty20761/gotzji' },
    artifacts,
    build: {
      releaseTrust: createReleaseTrustDeclaration(),
      signingCredentialConfigured: false,
      windowsAuthenticode: artifacts.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, status: 'NotSigned' })),
    },
  };
}

async function releaseFixture(): Promise<{ root: string; provenance: ReleaseFixtureProvenance; setup: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gotzji-release-policy-')));
  temporaryRoots.push(root);
  const version = (JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { version: string }).version;
  const tunnelVersion = (JSON.parse(await readFile(path.join(desktopRoot, 'src/main/runtime-dependencies.json'), 'utf8')) as { tunnelClient: { version: string } }).tunnelClient.version;
  const bridgeBytes = await readFile(path.resolve(desktopRoot, '../../packages/capabilities/src/windows-capability-bridge.ps1'));
  const names = [`gotzji-Setup-${version}.exe`, `gotzji-Setup-${version}.exe.blockmap`, `gotzji-Portable-${version}.exe`, 'latest.yml', 'portable.yml'];
  const artifacts = await Promise.all(names.map(async (name) => {
    await writeFile(path.join(root, name), name);
    return { name, sha256: digest(name), sizeBytes: Buffer.byteLength(name) };
  }));
  const prefix = `tunnel-client-v${tunnelVersion}-windows-amd64`;
  const runtimePaths = [
    'gotzji.exe', 'gotzji-mcp-stdio.cmd', 'resources/licenses/lnwjud-MIT.txt',
    'resources/licenses/THIRD_PARTY_NOTICES.md', 'resources/licenses/Prompt-OFL.txt',
    'resources/licenses/dependencies/npm-NOTICES.txt', 'resources/licenses/dependencies/DEPENDENCY_LICENSES.json',
    'resources/windows-capability-bridge.ps1', 'resources/windows-capability-bridge.sha256', 'resources/windows-capability-bridge.integrity.json',
    'resources/windows-secret-migrator/lnwjud-windows-secret-migrator.exe', 'resources/windows-secret-migrator/lnwjud-windows-secret-migrator.sha256',
    'resources/runtime-tools/ripgrep/rg.exe', 'resources/runtime-tools/ripgrep/BUNDLED_RIPGREP.json',
    'resources/tunnel-client/tunnel-client.exe', 'resources/tunnel-client/BUNDLED_TUNNEL_CLIENT.json',
    `resources/tunnel-client/${prefix}-licenses.txt`, `resources/tunnel-client/${prefix}.spdx.json`,
    `resources/tunnel-client/tunnel-client-v${tunnelVersion}-provenance.sigstore.json`,
  ];
  const runtime = runtimePaths.map((relativePath) => ({
    name: path.posix.basename(relativePath), relativePath,
    sha256: relativePath.endsWith('windows-capability-bridge.ps1') ? digest(bridgeBytes) : digest(relativePath),
    sizeBytes: relativePath.endsWith('windows-capability-bridge.ps1') ? bridgeBytes.length : Buffer.byteLength(relativePath),
  }));
  const coreManifest = {
    schemaVersion: 1, product: 'gotzji', version, catalogVersion: 1, storeSchemaVersion: 1, entrypoint: 'product-server.mjs',
    files: ['product-server.mjs', 'product-broker.mjs', 'product-runner.mjs', 'fixture-worker.mjs']
      .map((relativePath) => ({ relativePath, sha256: digest(relativePath), sizeBytes: Buffer.byteLength(relativePath) })),
  };
  const coreManifestText = `${JSON.stringify(coreManifest, null, 2)}\n`;
  runtime.push(...coreManifest.files.map((entry) => ({ ...entry, name: entry.relativePath, relativePath: `resources/gotzji-core/${entry.relativePath}` })));
  runtime.push({ name: 'product-runtime-manifest.json', relativePath: 'resources/gotzji-core/product-runtime-manifest.json', sizeBytes: Buffer.byteLength(coreManifestText), sha256: digest(coreManifestText) });
  const provenance = {
    schemaVersion: 1, product: 'gotzji', version, platform: 'win32', arch: 'x64',
    source: { repository: 'https://github.com/Scotty20761/gotzji', commit: 'a'.repeat(40), dirty: false },
    build: {
      releaseTrust: createReleaseTrustDeclaration(), signingCredentialConfigured: false,
      windowsAuthenticode: artifacts.filter((artifact) => artifact.name.endsWith('.exe'))
        .map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, status: 'NotSigned' })),
    },
    artifacts, runtime,
    gotzjiCore: { manifest: coreManifest, manifestSha256: digest(coreManifestText) },
    capabilityBridge: { fileName: 'windows-capability-bridge.ps1', sha256: digest(bridgeBytes), sizeBytes: bridgeBytes.length },
  };
  await writeFixtureEvidence(root, provenance);
  return { root, provenance, setup: path.join(root, names[0]!) };
}

async function writeFixtureEvidence(root: string, provenance: {
  artifacts: Array<{ name: string; sha256: string }>;
  runtime: Array<{ relativePath: string; sha256: string }>;
}): Promise<void> {
  const text = `${JSON.stringify(provenance)}\n`;
  await writeFile(path.join(root, 'PROVENANCE.json'), text);
  await writeFile(path.join(root, 'SHA256SUMS.txt'), [
    ...provenance.artifacts.map((entry) => `${entry.sha256}  ${entry.name}`),
    `${digest(text)}  PROVENANCE.json`,
    ...provenance.runtime.map((entry) => `${entry.sha256}  installed/${entry.relativePath}`), '',
  ].join('\n'));
}

function verifyFixture(root: string): string {
  return execFileSync(process.execPath, [path.join(desktopRoot, 'scripts/verify-release-evidence.mjs')], {
    encoding: 'utf8', windowsHide: true, stdio: 'pipe',
    env: { ...process.env, LNWJUD_RELEASE_INSTALLER_DIRECTORY: root, LNWJUD_RELEASE_ARTIFACT_ONLY: '1', LNWJUD_RELEASE_PLATFORM: 'win32', LNWJUD_EXPECTED_COMMIT_SHA: 'a'.repeat(40), LNWJUD_REQUIRE_CLEAN_PROVENANCE: '1', LNWJUD_REQUIRE_WINDOWS_AUTHENTICODE: '0' },
  });
}

describe('gotzji owned unsigned release policy', () => {
  it('accepts declared unsigned artifacts bound to the owned repository and exact hashes', () => {
    const p = declaredProvenance();
    expect(validateReleaseTrustDeclaration(p)).toEqual(p.build.releaseTrust);
  });

  it.each(['missing declaration', 'upstream repository', 'automatic update', 'signing configured', 'invalid status', 'wrong artifact digest', 'missing observation'])(
    'rejects %s instead of relaxing the integrity/signing gate', (failure) => {
      const p = declaredProvenance();
      if (failure === 'missing declaration') p.build.releaseTrust = undefined;
      if (failure === 'upstream repository') p.source.repository = 'https://github.com/engasnm111/lnwjud';
      if (failure === 'automatic update') p.build.releaseTrust.automaticUpdatesEnabled = true;
      if (failure === 'signing configured') p.build.signingCredentialConfigured = true;
      if (failure === 'invalid status') p.build.windowsAuthenticode[0]!.status = 'HashMismatch';
      if (failure === 'wrong artifact digest') p.build.windowsAuthenticode[0]!.sha256 = 'a'.repeat(64);
      if (failure === 'missing observation') p.build.windowsAuthenticode.pop();
      expect(() => validateReleaseTrustDeclaration(p)).toThrow();
    },
  );

  it('isolates installer paths and preserves upstream licences', async () => {
    const config = await readFile(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
    const installer = await readFile(path.join(desktopRoot, 'build/installer.nsh'), 'utf8');
    expect(config).toContain('appId: com.scotty20761.gotzji');
    expect(config).toContain('owner: Scotty20761');
    expect(config).toContain('repo: gotzji');
    expect(config).toContain('to: licenses/lnwjud-MIT.txt');
    expect(config).toContain('to: licenses/dependencies');
    expect(config).toContain('to: licenses/THIRD_PARTY_NOTICES.md');
    expect(config).toContain('to: licenses/Prompt-OFL.txt');
    expect(installer).toContain('$SMPROGRAMS\\gotzji.lnk');
    expect(installer).not.toMatch(/\$(?:APPDATA|LOCALAPPDATA)\\lnwjud/);
    expect(installer).not.toContain('$SMPROGRAMS\\lnwjud.lnk');
  });

  it('runs the real verifier for declared unsigned release evidence and rejects changed artifact bytes', async () => {
    const f = await releaseFixture();
    expect(verifyFixture(f.root)).toContain('Release evidence verified for gotzji');
    await writeFile(f.setup, 'changed executable bytes');
    expect(() => verifyFixture(f.root)).toThrow(/Artifact SHA-256 mismatch/);
  });

  it('runs the real verifier and rejects incomplete runtime evidence even with self-consistent checksums', async () => {
    const f = await releaseFixture();
    f.provenance.runtime = f.provenance.runtime.filter((entry) => entry.relativePath !== 'resources/licenses/lnwjud-MIT.txt');
    await writeFixtureEvidence(f.root, f.provenance);
    expect(() => verifyFixture(f.root)).toThrow(/Runtime provenance is incomplete/);
  });
});
