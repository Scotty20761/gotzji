import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGotzjiPluginPackage, verifyGotzjiPluginPackage } from '../../scripts/package-gotzji-plugin.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const canonicalSource = path.join(repositoryRoot, 'plugins', 'gotzji');
const version = (JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version: string }).version;
const sourceCommit = '1'.repeat(40);

describe('gotzji Agent Plugin package', () => {
  it.each(['LF', 'CRLF'])('accepts %s skill headers while preserving the exact signed source bytes', async (lineEnding) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-plugin-line-endings-'));
    try {
      const sourceRoot = path.join(root, 'source');
      await cp(canonicalSource, sourceRoot, { recursive: true });
      const relativePath = 'skills/gotzji-workflow/SKILL.md';
      const skillPath = path.join(sourceRoot, relativePath);
      const normalized = (await readFile(skillPath, 'utf8')).replace(/\r\n/gu, '\n');
      const sourceBytes = Buffer.from(lineEnding === 'CRLF' ? normalized.replace(/\n/gu, '\r\n') : normalized);
      await writeFile(skillPath, sourceBytes);
      const result = await buildGotzjiPluginPackage({ sourceRoot, outputDirectory: path.join(root, 'output'), sourceCommit, cleanSource: true });
      const entries = readStoredZip(await readFile(result.archivePath));
      expect(entries.get(relativePath)).toEqual(sourceBytes);
      expect(jsonEntry(entries, 'PACKAGE_MANIFEST.json').sourceInventory).toContainEqual({
        path: relativePath, bytes: sourceBytes.length, sha256: sha256(sourceBytes),
      });
      await expect(verifyGotzjiPluginPackage({ sourceRoot, archivePath: result.archivePath, checksumPath: result.checksumPath, provenancePath: result.provenancePath })).resolves.toMatchObject({ connectionVerified: false });
      await writeFile(skillPath, Buffer.concat([sourceBytes, Buffer.from('\nChanged after packaging.\n')]));
      await expect(verifyGotzjiPluginPackage({ sourceRoot, archivePath: result.archivePath, checksumPath: result.checksumPath, provenancePath: result.provenancePath })).rejects.toThrow('SOURCE_INVENTORY_MISMATCH');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds a deterministic public source package that is explicitly unbound', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-plugin-generic-'));
    try {
      const outputDirectory = path.join(root, 'output');
      const first = await buildGotzjiPluginPackage({ outputDirectory, sourceCommit, cleanSource: true });
      const firstBytes = await readFile(first.archivePath);
      const second = await buildGotzjiPluginPackage({ outputDirectory, sourceCommit, cleanSource: true });
      const secondBytes = await readFile(second.archivePath);
      expect(first.archivePath).toBe(path.join(outputDirectory, `gotzji-plugin-${version}-unbound.zip`));
      expect(first.archiveSha256).toBe(sha256(firstBytes));
      expect(await readFile(first.checksumPath, 'utf8')).toBe(`${first.archiveSha256}  gotzji-plugin-${version}-unbound.zip\n`);
      expect(second.archiveSha256).toBe(first.archiveSha256);
      expect(secondBytes).toEqual(firstBytes);
      expect(first.provenancePath).toBe(path.join(outputDirectory, 'PLUGIN_PROVENANCE.json'));
      const provenance = JSON.parse(await readFile(first.provenancePath!, 'utf8')) as Record<string, unknown>;
      expect(provenance).toMatchObject({
        schemaVersion: 1,
        product: 'gotzji-plugin',
        version,
        packageFile: `gotzji-plugin-${version}-unbound.zip`,
        archiveSha256: first.archiveSha256,
        source: { repository: 'https://github.com/Scotty20761/gotzji', commit: sourceCommit, clean: true },
        binding: { state: 'unbound-template', registeredAppIncluded: false, connectionVerified: false },
        publicReleaseQualified: false,
      });
      expect(JSON.stringify(provenance)).not.toMatch(/[A-Za-z]:\\|plugin_asdk_app_|tunnel_[a-z0-9]{20,}/u);
      await expect(verifyGotzjiPluginPackage({
        archivePath: first.archivePath,
        checksumPath: first.checksumPath,
        provenancePath: first.provenancePath,
        expectedSourceCommit: sourceCommit,
        expectedCleanSource: true,
      })).resolves.toMatchObject({
        archiveSha256: first.archiveSha256,
        sourceCommit,
        cleanSource: true,
        bindingState: 'unbound-template',
        connectionVerified: false,
        publicReleaseQualified: false,
        version,
      });
      expect(await readFile(first.archivePath)).toEqual(secondBytes);

      const entries = readStoredZip(firstBytes);
      expect([...entries.keys()].sort()).toEqual([
        'LICENSE',
        'PACKAGE_MANIFEST.json',
        'README_TH.md',
        'SHA256SUMS.txt',
        'app-binding.template.json',
        'plugin.json',
        'skills/gotzji-workflow/SKILL.md',
      ].sort());
      const plugin = jsonEntry(entries, 'plugin.json');
      expect(plugin).toMatchObject({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'gotzji',
        version,
        license: 'MIT',
      });
      expect((plugin.extensions as Record<string, Record<string, unknown>>)['com.openai']).not.toHaveProperty('apps');
      expect(entries.has('.app.json')).toBe(false);
      const archiveText = [...entries.values()].map((bytes) => bytes.toString('utf8')).join('\n');
      expect(archiveText).not.toMatch(new RegExp(`${'plugin_'}${'asdk_app_'}[A-Za-z0-9_-]{16,}`, 'u'));

      const appTemplate = jsonEntry(entries, 'app-binding.template.json');
      expect(appTemplate).toEqual({ apps: { gotzji: { id: 'REGISTERED_MCP_TECHNICAL_ID', required: true } } });
      const packageManifest = jsonEntry(entries, 'PACKAGE_MANIFEST.json');
      expect(packageManifest).toMatchObject({
        version,
        binding: { state: 'unbound-template', registeredAppIncluded: false, connectionVerified: false },
        distribution: { sourcePublic: true, publicationStatus: 'not-published', publicReleaseQualified: false, personalBindingMayBePublished: false },
        installBehavior: { executesCode: false, hooks: false, scheduler: false, bundledMcpServer: false, paidInference: false },
        skills: ['skills/gotzji-workflow/SKILL.md'],
      });
      expect((packageManifest.sourceInventory as Array<{ path: string }>).map((entry) => entry.path).sort()).toEqual([
        'LICENSE',
        'README_TH.md',
        'app-binding.template.json',
        'plugin.json',
        'skills/gotzji-workflow/SKILL.md',
      ].sort());
      verifyInternalChecksums(entries);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates a separate personal package only from an explicit registered technical ID', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-plugin-personal-'));
    const appId = `${'plugin_'}${'asdk_app_'}${'b'.repeat(32)}`;
    try {
      const result = await buildGotzjiPluginPackage({ personal: true, appId, outputDirectory: path.join(root, 'output') });
      expect(result.archivePath).toContain(`gotzji-plugin-${version}-personal.zip`);
      expect(result.bindingState).toBe('provided-unverified');
      expect(result.connectionVerified).toBe(false);
      const entries = readStoredZip(await readFile(result.archivePath));
      expect(entries.has('app-binding.template.json')).toBe(false);
      expect(jsonEntry(entries, '.app.json')).toEqual({ apps: { gotzji: { id: appId, required: true } } });
      const plugin = jsonEntry(entries, 'plugin.json');
      expect((plugin.extensions as Record<string, Record<string, unknown>>)['com.openai']).toMatchObject({ apps: './.app.json' });
      expect(jsonEntry(entries, 'PACKAGE_MANIFEST.json')).toMatchObject({
        binding: { state: 'provided-unverified', registeredAppIncluded: true, connectionVerified: false },
        distribution: { sourcePublic: false, personalBindingMayBePublished: false },
      });
      verifyInternalChecksums(entries);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing and forged personal bindings without emitting an archive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-plugin-binding-negative-'));
    try {
      await expect(buildGotzjiPluginPackage({ personal: true, outputDirectory: path.join(root, 'missing') }))
        .rejects.toThrow('PERSONAL_BINDING_REQUIRES_REGISTERED_APP_ID');
      for (const appId of ['asdk_app_1234567890abcdef', 'plugin_asdk_app_short', 'plugin_asdk_app_../../owner', 'plugin_asdk_app_abc defghijklmnop']) {
        await expect(buildGotzjiPluginPackage({ personal: true, appId, outputDirectory: path.join(root, 'forged') }))
          .rejects.toThrow('REGISTERED_APP_ID_INVALID');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects source credentials, private binding files, symlinks and overlapping output paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-plugin-security-'));
    try {
      const credentialSource = path.join(root, 'credential-source');
      await cp(canonicalSource, credentialSource, { recursive: true });
      const readmePath = path.join(credentialSource, 'README_TH.md');
      const keyName = ['CONTROL', 'PLANE', 'API', 'KEY'].join('_');
      await writeFile(readmePath, `${await readFile(readmePath, 'utf8')}\n${keyName}=not-a-real-secret-value\n`, 'utf8');
      await expect(buildGotzjiPluginPackage({ sourceRoot: credentialSource, outputDirectory: path.join(root, 'credential-output') }))
        .rejects.toThrow('SENSITIVE_VALUE_DETECTED:API_CREDENTIAL');

      const privateBindingSource = path.join(root, 'private-binding-source');
      await cp(canonicalSource, privateBindingSource, { recursive: true });
      await writeFile(path.join(privateBindingSource, '.app.json'), JSON.stringify({ apps: {} }), 'utf8');
      await expect(buildGotzjiPluginPackage({ sourceRoot: privateBindingSource, outputDirectory: path.join(root, 'private-output') }))
        .rejects.toThrow('PLUGIN_SOURCE_FILE_SET_INVALID');

      const symlinkSource = path.join(root, 'symlink-source');
      await cp(canonicalSource, symlinkSource, { recursive: true });
      await symlink(root, path.join(symlinkSource, 'skills', 'linked-outside'), 'junction');
      await expect(buildGotzjiPluginPackage({ sourceRoot: symlinkSource, outputDirectory: path.join(root, 'symlink-output') }))
        .rejects.toThrow('PLUGIN_SOURCE_SYMLINK_DENIED');

      await expect(buildGotzjiPluginPackage({ sourceRoot: canonicalSource, outputDirectory: path.join(canonicalSource, 'generated') }))
        .rejects.toThrow('PLUGIN_OUTPUT_MUST_BE_SEPARATE_FROM_SOURCE');
      await rm(path.join(canonicalSource, 'generated'), { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('verifies existing bytes and rejects tampered evidence, source, paths, credentials and personal mappings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-plugin-verifier-'));
    try {
      const baseline = await buildGotzjiPluginPackage({ outputDirectory: path.join(root, 'baseline'), sourceCommit, cleanSource: true });

      const checksumCase = await cloneEvidence(root, 'checksum', baseline);
      await writeFile(checksumCase.checksumPath, `${'0'.repeat(64)}  ${path.basename(checksumCase.archivePath)}\n`, 'utf8');
      await expect(verifyGotzjiPluginPackage({ ...checksumCase, expectedSourceCommit: sourceCommit, expectedCleanSource: true }))
        .rejects.toThrow('EXTERNAL_ARCHIVE_CHECKSUM_MISMATCH');

      const changedBytesCase = await cloneEvidence(root, 'changed-bytes', baseline);
      const changedBytes = await readFile(changedBytesCase.archivePath);
      changedBytes[0] = changedBytes[0]! ^ 0xff;
      await writeFile(changedBytesCase.archivePath, changedBytes);
      await expect(verifyGotzjiPluginPackage({ ...changedBytesCase, expectedSourceCommit: sourceCommit, expectedCleanSource: true }))
        .rejects.toThrow('EXTERNAL_ARCHIVE_CHECKSUM_MISMATCH');

      const internalCase = await cloneEvidence(root, 'internal-sum', baseline);
      const internalBytes = replaceStoredEntrySameLength(await readFile(internalCase.archivePath), 'SHA256SUMS.txt', (value) => {
        const text = value.toString('utf8');
        return Buffer.from(`${text[0] === '0' ? '1' : '0'}${text.slice(1)}`, 'utf8');
      });
      await updateExternalEvidence(internalCase, internalBytes);
      await expect(verifyGotzjiPluginPackage({ ...internalCase, expectedSourceCommit: sourceCommit, expectedCleanSource: true }))
        .rejects.toThrow('INTERNAL_CHECKSUM_MISMATCH');

      const credentialCase = await cloneEvidence(root, 'credential', baseline);
      const credentialBytes = replaceStoredEntrySameLength(await readFile(credentialCase.archivePath), 'app-binding.template.json', (value) => {
        const original = 'REGISTERED_MCP_TECHNICAL_ID';
        const replacement = `${'sk-'}${'a'.repeat(20)}${' '.repeat(original.length - 23)}`;
        return Buffer.from(value.toString('utf8').replace(original, replacement), 'utf8');
      });
      await updateExternalEvidence(credentialCase, credentialBytes);
      await expect(verifyGotzjiPluginPackage({ ...credentialCase, expectedSourceCommit: sourceCommit, expectedCleanSource: true }))
        .rejects.toThrow('SENSITIVE_VALUE_DETECTED:API_TOKEN');

      const pathCase = await cloneEvidence(root, 'path-escape', baseline);
      const pathBytes = renameStoredEntrySameLength(await readFile(pathCase.archivePath), 'LICENSE', '../evil');
      await updateExternalEvidence(pathCase, pathBytes);
      await expect(verifyGotzjiPluginPackage({ ...pathCase, expectedSourceCommit: sourceCommit, expectedCleanSource: true }))
        .rejects.toThrow('PLUGIN_ARCHIVE_PATH_INVALID');

      const changedSource = path.join(root, 'changed-source');
      await cp(canonicalSource, changedSource, { recursive: true });
      await writeFile(path.join(changedSource, 'README_TH.md'), `${await readFile(path.join(changedSource, 'README_TH.md'), 'utf8')}\nchanged\n`, 'utf8');
      await expect(verifyGotzjiPluginPackage({
        archivePath: baseline.archivePath, checksumPath: baseline.checksumPath, provenancePath: baseline.provenancePath, sourceRoot: changedSource,
      })).rejects.toThrow('SOURCE_INVENTORY_MISMATCH');

      const wrongVersionSource = path.join(root, 'wrong-version-source');
      await cp(canonicalSource, wrongVersionSource, { recursive: true });
      const wrongManifestPath = path.join(wrongVersionSource, 'plugin.json');
      const wrongManifest = JSON.parse(await readFile(wrongManifestPath, 'utf8')) as { version: string };
      wrongManifest.version = '9.9.9';
      await writeFile(wrongManifestPath, `${JSON.stringify(wrongManifest, null, 2)}\n`, 'utf8');
      await expect(verifyGotzjiPluginPackage({
        archivePath: baseline.archivePath, checksumPath: baseline.checksumPath, provenancePath: baseline.provenancePath, sourceRoot: wrongVersionSource,
      })).rejects.toThrow('PLUGIN_SOURCE_VERSION_MISMATCH');

      const linkedSource = path.join(root, 'linked-source');
      await cp(canonicalSource, linkedSource, { recursive: true });
      await symlink(root, path.join(linkedSource, 'skills', 'outside'), 'junction');
      await expect(verifyGotzjiPluginPackage({
        archivePath: baseline.archivePath, checksumPath: baseline.checksumPath, provenancePath: baseline.provenancePath, sourceRoot: linkedSource,
      })).rejects.toThrow('PLUGIN_SOURCE_SYMLINK_DENIED');

      const appId = `${'plugin_'}${'asdk_app_'}${'c'.repeat(32)}`;
      const personal = await buildGotzjiPluginPackage({ personal: true, appId, outputDirectory: path.join(root, 'personal') });
      const personalProvenance = JSON.parse(await readFile(baseline.provenancePath!, 'utf8')) as Record<string, unknown>;
      personalProvenance.packageFile = path.basename(personal.archivePath);
      personalProvenance.checksumFile = path.basename(personal.checksumPath);
      personalProvenance.archiveSha256 = personal.archiveSha256;
      const personalProvenancePath = path.join(root, 'personal', 'PLUGIN_PROVENANCE.json');
      await writeFile(personalProvenancePath, `${JSON.stringify(personalProvenance, null, 2)}\n`, 'utf8');
      await expect(verifyGotzjiPluginPackage({
        archivePath: personal.archivePath,
        checksumPath: personal.checksumPath,
        provenancePath: personalProvenancePath,
        expectedSourceCommit: sourceCommit,
        expectedCleanSource: true,
      })).rejects.toThrow('UNBOUND_PLUGIN_FILE_SET_INVALID');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('packages only the owned workflow skill and keeps job identity and evidence boundaries explicit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-plugin-skill-'));
    try {
      const result = await buildGotzjiPluginPackage({ outputDirectory: path.join(root, 'output') });
      const entries = readStoredZip(await readFile(result.archivePath));
      const skills = [...entries.keys()].filter((name) => name.startsWith('skills/') && name.endsWith('/SKILL.md'));
      expect(skills).toEqual(['skills/gotzji-workflow/SKILL.md']);
      const skill = entries.get(skills[0]!)?.toString('utf8') ?? '';
      for (const tool of ['gotzji_health', 'gotzji_projects', 'gotzji_tools', 'gotzji_prepare_operation', 'gotzji_submit', 'gotzji_jobs', 'gotzji_queue', 'gotzji_reprioritize', 'gotzji_status', 'gotzji_logs', 'gotzji_result', 'gotzji_resume', 'gotzji_cancel']) {
        expect(skill).toContain(tool);
      }
      expect(skill).toContain('stable `requestId`');
      expect(skill).toContain('exact `jobId`');
      expect(skill).toContain('Grace owns every effect');
      expect(skill).toContain('Request curation only when the user explicitly asks');
      expect(skill).not.toContain('lnwjud');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function readStoredZip(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= bytes.byteLength && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    expect(method).toBe(0);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries.set(name, bytes.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

interface PackageEvidencePaths {
  readonly archivePath: string;
  readonly checksumPath: string;
  readonly provenancePath: string;
}

async function cloneEvidence(
  root: string,
  name: string,
  source: { readonly archivePath: string; readonly checksumPath: string; readonly provenancePath?: string },
): Promise<PackageEvidencePaths> {
  if (!source.provenancePath) throw new Error('fixture provenance missing');
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  const archivePath = path.join(directory, path.basename(source.archivePath));
  const checksumPath = `${archivePath}.sha256`;
  const provenancePath = path.join(directory, 'PLUGIN_PROVENANCE.json');
  await Promise.all([
    cp(source.archivePath, archivePath),
    cp(source.checksumPath, checksumPath),
    cp(source.provenancePath, provenancePath),
  ]);
  return { archivePath, checksumPath, provenancePath };
}

async function updateExternalEvidence(evidence: PackageEvidencePaths, archiveBytes: Buffer): Promise<void> {
  const archiveSha256 = sha256(archiveBytes);
  await writeFile(evidence.archivePath, archiveBytes);
  await writeFile(evidence.checksumPath, `${archiveSha256}  ${path.basename(evidence.archivePath)}\n`, 'utf8');
  const provenance = JSON.parse(await readFile(evidence.provenancePath, 'utf8')) as { archiveSha256: string };
  provenance.archiveSha256 = archiveSha256;
  await writeFile(evidence.provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
}

function replaceStoredEntrySameLength(bytes: Buffer, targetName: string, transform: (value: Buffer) => Buffer): Buffer {
  const output = Buffer.from(bytes);
  const entry = findLocalEntry(output, targetName);
  const original = output.subarray(entry.dataStart, entry.dataEnd);
  const replacement = transform(Buffer.from(original));
  if (replacement.byteLength !== original.byteLength) throw new Error('fixture replacement length changed');
  replacement.copy(output, entry.dataStart);
  const crc = crc32ForTest(replacement);
  output.writeUInt32LE(crc, entry.localOffset + 14);
  const central = findCentralEntry(output, targetName);
  output.writeUInt32LE(crc, central + 16);
  return output;
}

function renameStoredEntrySameLength(bytes: Buffer, targetName: string, replacementName: string): Buffer {
  if (Buffer.byteLength(targetName) !== Buffer.byteLength(replacementName)) throw new Error('fixture name length changed');
  const output = Buffer.from(bytes);
  const entry = findLocalEntry(output, targetName);
  Buffer.from(replacementName, 'utf8').copy(output, entry.nameStart);
  const central = findCentralEntry(output, targetName);
  Buffer.from(replacementName, 'utf8').copy(output, central + 46);
  return output;
}

function findLocalEntry(bytes: Buffer, targetName: string): { localOffset: number; nameStart: number; dataStart: number; dataEnd: number } {
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + size;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (name === targetName) return { localOffset: offset, nameStart, dataStart, dataEnd };
    offset = dataEnd;
  }
  throw new Error(`fixture entry not found: ${targetName}`);
}

function findCentralEntry(bytes: Buffer, targetName: string): number {
  const endOffset = bytes.byteLength - 22;
  let offset = bytes.readUInt32LE(endOffset + 16);
  while (offset + 46 <= endOffset && bytes.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === targetName) return offset;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`fixture central entry not found: ${targetName}`);
}

const crcTableForTest = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32ForTest(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTableForTest[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function jsonEntry(entries: Map<string, Buffer>, name: string): Record<string, unknown> {
  const bytes = entries.get(name);
  expect(bytes, name).toBeDefined();
  return JSON.parse(bytes?.toString('utf8') ?? '') as Record<string, unknown>;
}

function verifyInternalChecksums(entries: Map<string, Buffer>): void {
  const sums = entries.get('SHA256SUMS.txt')?.toString('utf8').trim().split(/\r?\n/u) ?? [];
  expect(sums.length).toBe(entries.size - 1);
  for (const line of sums) {
    const match = /^([a-f0-9]{64})[ ]{2}(.+)$/u.exec(line);
    expect(match).not.toBeNull();
    const bytes = entries.get(match?.[2] ?? '');
    expect(bytes, match?.[2]).toBeDefined();
    expect(sha256(bytes ?? Buffer.alloc(0))).toBe(match?.[1]);
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
