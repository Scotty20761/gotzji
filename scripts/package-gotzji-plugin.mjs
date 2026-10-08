/* global Buffer, console, process */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSourceRoot = path.join(repositoryRoot, 'plugins', 'gotzji');
const defaultOutputDirectory = path.join(repositoryRoot, '.local-artifacts', 'gotzji-plugin');
const execFileAsync = promisify(execFile);
const registeredAppIdPattern = /^plugin_asdk_app_[A-Za-z0-9_-]{16,128}$/u;
const registeredAppIdSearch = /plugin_asdk_app_[A-Za-z0-9_-]{16,128}/gu;
const allowedSourceFiles = Object.freeze([
  'LICENSE',
  'README_TH.md',
  'app-binding.template.json',
  'plugin.json',
  'skills/gotzji-workflow/SKILL.md',
]);
const forbiddenContentPatterns = Object.freeze([
  { code: 'API_CREDENTIAL', expression: new RegExp(`(?:${['CONTROL', 'PLANE', 'API', 'KEY'].join('_')}|${['OPENAI', 'API', 'KEY'].join('_')})\\s*[:=]\\s*[^<\\s]{8,}`, 'iu') },
  { code: 'API_TOKEN', expression: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { code: 'TUNNEL_ID', expression: /\btunnel_[a-z0-9]{20,}\b/gu },
  { code: 'PRIVATE_WORKSPACE_PATH', expression: /(?:[A-Za-z]:\\Users\\|E:\\Investment Library|inputs[\\/]Personal)/iu },
  { code: 'OWNER_OR_WORKSPACE_ID', expression: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu },
]);

export async function buildGotzjiPluginPackage(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ?? defaultSourceRoot);
  const outputDirectory = path.resolve(options.outputDirectory ?? defaultOutputDirectory);
  const personal = options.personal === true || typeof options.appId === 'string';
  const appId = options.appId?.trim();

  if (personal && !appId) throw new Error('PERSONAL_BINDING_REQUIRES_REGISTERED_APP_ID');
  if (!personal && appId) throw new Error('GENERIC_PACKAGE_CANNOT_HAVE_APP_ID');
  if (appId && !registeredAppIdPattern.test(appId)) throw new Error('REGISTERED_APP_ID_INVALID');

  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('PLUGIN_SOURCE_ROOT_INVALID');
  const canonicalSourceRoot = await realpath(sourceRoot);
  if (within(sourceRoot, outputDirectory) || within(outputDirectory, sourceRoot)) {
    throw new Error('PLUGIN_OUTPUT_MUST_BE_SEPARATE_FROM_SOURCE');
  }
  await mkdir(outputDirectory, { recursive: true });
  const outputStat = await lstat(outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error('PLUGIN_OUTPUT_ROOT_INVALID');
  const canonicalOutputDirectory = await realpath(outputDirectory);
  if (within(canonicalSourceRoot, canonicalOutputDirectory) || within(canonicalOutputDirectory, canonicalSourceRoot)) {
    throw new Error('PLUGIN_OUTPUT_MUST_BE_SEPARATE_FROM_SOURCE');
  }

  const discovered = await enumerateFiles(canonicalSourceRoot);
  assertExactFileSet(discovered.map((entry) => entry.relativePath));
  const sourceFiles = new Map();
  for (const entry of discovered) {
    sourceFiles.set(entry.relativePath, await readFile(entry.absolutePath));
  }
  const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  if (typeof rootPackage.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(rootPackage.version)) {
    throw new Error('ROOT_PACKAGE_VERSION_INVALID');
  }
  const version = rootPackage.version;
  validateSourceContracts(sourceFiles, version);
  validateSensitiveContent(sourceFiles, undefined);

  const payload = new Map(sourceFiles);
  const pluginManifest = JSON.parse(payload.get('plugin.json').toString('utf8'));
  pluginManifest.version = version;
  if (personal) {
    pluginManifest.extensions['com.openai'].apps = './.app.json';
    const appTemplate = JSON.parse(payload.get('app-binding.template.json').toString('utf8'));
    appTemplate.apps.gotzji.id = appId;
    payload.set('.app.json', jsonBytes(appTemplate));
    payload.delete('app-binding.template.json');
  } else {
    delete pluginManifest.extensions['com.openai'].apps;
  }
  payload.set('plugin.json', jsonBytes(pluginManifest));
  validateSensitiveContent(payload, appId);

  const bindingState = personal ? 'provided-unverified' : 'unbound-template';
  const packageManifest = {
    schemaVersion: 1,
    package: 'gotzji',
    version,
    binding: {
      state: bindingState,
      registeredAppIncluded: personal,
      connectionVerified: false,
    },
    distribution: {
      sourcePublic: !personal,
      publicationStatus: 'not-published',
      publicReleaseQualified: false,
      personalBindingMayBePublished: false,
    },
    installBehavior: {
      executesCode: false,
      hooks: false,
      scheduler: false,
      bundledMcpServer: false,
      paidInference: false,
    },
    skills: ['skills/gotzji-workflow/SKILL.md'],
    sourceInventory: inventory(sourceFiles),
    packageFiles: inventory(payload),
  };
  payload.set('PACKAGE_MANIFEST.json', jsonBytes(packageManifest));
  const sums = inventory(payload).map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n';
  payload.set('SHA256SUMS.txt', Buffer.from(sums, 'utf8'));
  const sourceState = personal ? undefined : await resolveSourceState(options);

  const archiveKind = personal ? 'personal' : 'unbound';
  const archiveName = `gotzji-plugin-${version}-${archiveKind}.zip`;
  const archivePath = path.join(canonicalOutputDirectory, archiveName);
  const archiveBytes = createStoredZip(payload);
  const archiveSha256 = digest(archiveBytes);
  const temporaryPath = `${archivePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, archiveBytes, { flag: 'wx' });
  try {
    await rm(archivePath, { force: true });
    await rename(temporaryPath, archivePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  const checksumPath = `${archivePath}.sha256`;
  await writeFile(checksumPath, `${archiveSha256}  ${archiveName}\n`, 'utf8');
  let provenancePath;
  if (!personal) {
    provenancePath = path.join(canonicalOutputDirectory, 'PLUGIN_PROVENANCE.json');
    const provenance = {
      schemaVersion: 1,
      product: 'gotzji-plugin',
      version,
      packageFile: archiveName,
      checksumFile: `${archiveName}.sha256`,
      archiveSha256,
      source: {
        repository: 'https://github.com/Scotty20761/gotzji',
        commit: sourceState.commit,
        clean: sourceState.clean,
      },
      binding: {
        state: 'unbound-template',
        registeredAppIncluded: false,
        connectionVerified: false,
      },
      publicReleaseQualified: false,
      inventory: inventory(payload),
    };
    await writeFile(provenancePath, jsonBytes(provenance));
  }

  return {
    archivePath,
    checksumPath,
    provenancePath,
    archiveSha256,
    bindingState,
    connectionVerified: false,
    version,
    files: [...payload.keys()].sort(),
  };
}

export async function verifyGotzjiPluginPackage(options) {
  const archivePath = path.resolve(options.archivePath);
  const checksumPath = path.resolve(options.checksumPath ?? `${archivePath}.sha256`);
  const provenancePath = path.resolve(options.provenancePath ?? path.join(path.dirname(archivePath), 'PLUGIN_PROVENANCE.json'));
  const sourceRoot = path.resolve(options.sourceRoot ?? defaultSourceRoot);
  const archiveName = path.basename(archivePath);
  await Promise.all([
    assertRegularFile(archivePath, 'PLUGIN_ARCHIVE_FILE_INVALID'),
    assertRegularFile(checksumPath, 'PLUGIN_CHECKSUM_FILE_INVALID'),
    assertRegularFile(provenancePath, 'PLUGIN_PROVENANCE_FILE_INVALID'),
  ]);
  const archiveBytes = await readFile(archivePath);
  if (archiveBytes.byteLength > 16 * 1024 * 1024) throw new Error('PLUGIN_ARCHIVE_TOO_LARGE');
  const archiveSha256 = digest(archiveBytes);
  const externalChecksum = await readFile(checksumPath, 'utf8');
  if (externalChecksum !== `${archiveSha256}  ${archiveName}\n`) throw new Error('EXTERNAL_ARCHIVE_CHECKSUM_MISMATCH');

  const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const expectedVersion = rootPackage.version;
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  validateExternalProvenance(provenance, { archiveName, archiveSha256, expectedVersion, expectedSourceCommit: options.expectedSourceCommit, expectedCleanSource: options.expectedCleanSource });
  const entries = parseStoredZip(archiveBytes);
  assertExactUnboundPackageFileSet([...entries.keys()]);
  validateSensitiveContent(entries, undefined);
  validateInternalChecksums(entries);

  const pluginManifest = parseJsonFile(entries, 'plugin.json');
  validatePackagedPluginManifest(pluginManifest, expectedVersion);
  const packageManifest = parseJsonFile(entries, 'PACKAGE_MANIFEST.json');
  validatePackageManifest(packageManifest, entries, expectedVersion);

  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('PLUGIN_SOURCE_ROOT_INVALID');
  const canonicalSourceRoot = await realpath(sourceRoot);
  const discovered = await enumerateFiles(canonicalSourceRoot);
  assertExactFileSet(discovered.map((entry) => entry.relativePath));
  const sourceFiles = new Map();
  for (const entry of discovered) sourceFiles.set(entry.relativePath, await readFile(entry.absolutePath));
  validateSourceContracts(sourceFiles, expectedVersion);
  validateSensitiveContent(sourceFiles, undefined);
  if (!sameInventory(packageManifest.sourceInventory, inventory(sourceFiles))) throw new Error('SOURCE_INVENTORY_MISMATCH');
  if (!sameInventory(provenance.inventory, inventory(entries))) throw new Error('PROVENANCE_INVENTORY_MISMATCH');

  return {
    archivePath,
    checksumPath,
    provenancePath,
    archiveSha256,
    sourceCommit: provenance.source.commit,
    cleanSource: provenance.source.clean,
    bindingState: 'unbound-template',
    connectionVerified: false,
    publicReleaseQualified: false,
    version: expectedVersion,
    files: [...entries.keys()].sort(stableCompare),
  };
}

async function assertRegularFile(filePath, errorCode) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(errorCode);
}

async function enumerateFiles(root) {
  const found = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const absolutePath = path.join(directory, name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error('PLUGIN_SOURCE_SYMLINK_DENIED');
      const relativePath = safeRelative(root, absolutePath);
      if (info.isDirectory()) await visit(absolutePath);
      else if (info.isFile()) found.push({ absolutePath, relativePath });
      else throw new Error('PLUGIN_SOURCE_SPECIAL_FILE_DENIED');
    }
  }
  await visit(root);
  return found.sort((a, b) => stableCompare(a.relativePath, b.relativePath));
}

function safeRelative(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('PLUGIN_SOURCE_PATH_ESCAPE');
  }
  const portable = relative.split(path.sep).join('/');
  if (portable.includes('\\') || portable.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('PLUGIN_SOURCE_PATH_INVALID');
  }
  return portable;
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertExactFileSet(paths) {
  const actual = [...paths].sort();
  if (JSON.stringify(actual) !== JSON.stringify([...allowedSourceFiles].sort())) {
    throw new Error('PLUGIN_SOURCE_FILE_SET_INVALID');
  }
}

function assertExactUnboundPackageFileSet(paths) {
  const expected = [
    'LICENSE',
    'PACKAGE_MANIFEST.json',
    'README_TH.md',
    'SHA256SUMS.txt',
    'app-binding.template.json',
    'plugin.json',
    'skills/gotzji-workflow/SKILL.md',
  ].sort(stableCompare);
  if (JSON.stringify([...paths].sort(stableCompare)) !== JSON.stringify(expected)) {
    throw new Error('UNBOUND_PLUGIN_FILE_SET_INVALID');
  }
}

function validateSourceContracts(files, expectedVersion) {
  const manifest = parseJsonFile(files, 'plugin.json');
  if (manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
    || manifest.name !== 'gotzji'
    || manifest.license !== 'MIT'
    || manifest.repository !== 'https://github.com/Scotty20761/gotzji'
    || manifest.extensions?.['com.openai']?.apps !== undefined
    || manifest.extensions?.['com.openai']?.hooks !== undefined
    || manifest.mcpServers !== undefined) {
    throw new Error('PLUGIN_PORTABLE_MANIFEST_INVALID');
  }
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) throw new Error('PLUGIN_SOURCE_VERSION_MISMATCH');
  const template = parseJsonFile(files, 'app-binding.template.json');
  if (Object.keys(template).join(',') !== 'apps'
    || Object.keys(template.apps ?? {}).join(',') !== 'gotzji'
    || Object.keys(template.apps?.gotzji ?? {}).sort().join(',') !== 'id,required'
    || template.apps.gotzji.id !== 'REGISTERED_MCP_TECHNICAL_ID'
    || template.apps.gotzji.required !== true) {
    throw new Error('PLUGIN_APP_BINDING_TEMPLATE_INVALID');
  }
  const skill = (files.get('skills/gotzji-workflow/SKILL.md')?.toString('utf8') ?? '').replace(/\r\n/gu, '\n');
  if (!skill.startsWith('---\nname: gotzji-workflow\ndescription: ')
    || !skill.includes('gotzji_prepare_operation')
    || !skill.includes('gotzji_result')
    || !skill.includes('Grace')) {
    throw new Error('PLUGIN_SKILL_CONTRACT_INVALID');
  }
}

function validatePackagedPluginManifest(manifest, expectedVersion) {
  if (manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
    || manifest.name !== 'gotzji'
    || manifest.version !== expectedVersion
    || manifest.license !== 'MIT'
    || manifest.repository !== 'https://github.com/Scotty20761/gotzji'
    || manifest.extensions?.['com.openai']?.apps !== undefined
    || manifest.extensions?.['com.openai']?.hooks !== undefined
    || manifest.mcpServers !== undefined) {
    throw new Error('UNBOUND_PLUGIN_MANIFEST_INVALID');
  }
}

function validatePackageManifest(manifest, entries, expectedVersion) {
  if (manifest?.schemaVersion !== 1
    || manifest.package !== 'gotzji'
    || manifest.version !== expectedVersion
    || manifest.binding?.state !== 'unbound-template'
    || manifest.binding?.registeredAppIncluded !== false
    || manifest.binding?.connectionVerified !== false
    || manifest.distribution?.sourcePublic !== true
    || manifest.distribution?.publicationStatus !== 'not-published'
    || manifest.distribution?.publicReleaseQualified !== false
    || manifest.distribution?.personalBindingMayBePublished !== false
    || manifest.installBehavior?.executesCode !== false
    || manifest.installBehavior?.hooks !== false
    || manifest.installBehavior?.scheduler !== false
    || manifest.installBehavior?.bundledMcpServer !== false
    || manifest.installBehavior?.paidInference !== false
    || JSON.stringify(manifest.skills) !== JSON.stringify(['skills/gotzji-workflow/SKILL.md'])) {
    throw new Error('PACKAGE_MANIFEST_CONTRACT_INVALID');
  }
  const packagePayload = new Map(entries);
  packagePayload.delete('PACKAGE_MANIFEST.json');
  packagePayload.delete('SHA256SUMS.txt');
  if (!sameInventory(manifest.packageFiles, inventory(packagePayload))) throw new Error('PACKAGE_INVENTORY_MISMATCH');
}

function validateInternalChecksums(entries) {
  const checksumBytes = entries.get('SHA256SUMS.txt');
  if (!checksumBytes) throw new Error('INTERNAL_CHECKSUMS_MISSING');
  const lines = checksumBytes.toString('utf8').split('\n');
  if (lines.at(-1) !== '') throw new Error('INTERNAL_CHECKSUMS_FORMAT_INVALID');
  lines.pop();
  const expectedNames = [...entries.keys()].filter((name) => name !== 'SHA256SUMS.txt').sort(stableCompare);
  if (lines.length !== expectedNames.length) throw new Error('INTERNAL_CHECKSUM_COUNT_INVALID');
  const observedNames = [];
  for (const line of lines) {
    const match = /^([a-f0-9]{64})[ ]{2}([^\r\n]+)$/u.exec(line);
    if (!match) throw new Error('INTERNAL_CHECKSUMS_FORMAT_INVALID');
    const [, expectedDigest, name] = match;
    if (!safeArchivePath(name) || name === 'SHA256SUMS.txt' || observedNames.includes(name)) throw new Error('INTERNAL_CHECKSUM_PATH_INVALID');
    const bytes = entries.get(name);
    if (!bytes || digest(bytes) !== expectedDigest) throw new Error('INTERNAL_CHECKSUM_MISMATCH');
    observedNames.push(name);
  }
  if (JSON.stringify(observedNames.sort(stableCompare)) !== JSON.stringify(expectedNames)) throw new Error('INTERNAL_CHECKSUM_FILE_SET_INVALID');
}

function validateExternalProvenance(provenance, expected) {
  const expectedCommit = expected.expectedSourceCommit?.toLowerCase();
  if (provenance?.schemaVersion !== 1
    || provenance.product !== 'gotzji-plugin'
    || provenance.version !== expected.expectedVersion
    || provenance.packageFile !== expected.archiveName
    || provenance.checksumFile !== `${expected.archiveName}.sha256`
    || provenance.archiveSha256 !== expected.archiveSha256
    || provenance.source?.repository !== 'https://github.com/Scotty20761/gotzji'
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(provenance.source?.commit ?? '')
    || typeof provenance.source?.clean !== 'boolean'
    || provenance.binding?.state !== 'unbound-template'
    || provenance.binding?.registeredAppIncluded !== false
    || provenance.binding?.connectionVerified !== false
    || provenance.publicReleaseQualified !== false) {
    throw new Error('PLUGIN_PROVENANCE_INVALID');
  }
  if (expectedCommit !== undefined && provenance.source.commit !== expectedCommit) throw new Error('PLUGIN_PROVENANCE_COMMIT_MISMATCH');
  if (expected.expectedCleanSource !== undefined && provenance.source.clean !== expected.expectedCleanSource) throw new Error('PLUGIN_PROVENANCE_CLEAN_STATE_MISMATCH');
}

function sameInventory(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseJsonFile(files, name) {
  try {
    return JSON.parse(files.get(name)?.toString('utf8') ?? '');
  } catch {
    throw new Error(`PLUGIN_JSON_INVALID:${name}`);
  }
}

function validateSensitiveContent(files, allowedAppId) {
  let allowedAppIdOccurrences = 0;
  for (const [name, bytes] of files) {
    const content = bytes.toString('utf8');
    for (const rule of forbiddenContentPatterns) {
      rule.expression.lastIndex = 0;
      if (rule.expression.test(content)) throw new Error(`SENSITIVE_VALUE_DETECTED:${rule.code}`);
    }
    const ids = content.match(registeredAppIdSearch) ?? [];
    for (const id of ids) {
      if (allowedAppId && name === '.app.json' && id === allowedAppId) allowedAppIdOccurrences += 1;
      else throw new Error('UNEXPECTED_REGISTERED_APP_ID');
    }
  }
  if (allowedAppId && allowedAppIdOccurrences !== 1) throw new Error('REGISTERED_APP_BINDING_COUNT_INVALID');
}

function inventory(files) {
  return [...files.entries()]
    .sort(([a], [b]) => stableCompare(a, b))
    .map(([filePath, bytes]) => ({ path: filePath, bytes: bytes.byteLength, sha256: digest(bytes) }));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function resolveSourceState(options) {
  if (options.sourceCommit !== undefined || options.cleanSource !== undefined) {
    const commit = options.sourceCommit?.trim().toLowerCase();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit ?? '') || typeof options.cleanSource !== 'boolean') {
      throw new Error('SOURCE_STATE_INPUT_INVALID');
    }
    return { commit, clean: options.cleanSource };
  }
  try {
    const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, windowsHide: true }),
      execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: repositoryRoot, windowsHide: true }),
    ]);
    const commit = commitOutput.trim().toLowerCase();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit)) throw new Error('SOURCE_COMMIT_INVALID');
    return { commit, clean: statusOutput.trim().length === 0 };
  } catch {
    throw new Error('SOURCE_STATE_CAPTURE_FAILED');
  }
}

function parseStoredZip(bytes) {
  if (bytes.byteLength < 22) throw new Error('PLUGIN_ARCHIVE_TRUNCATED');
  const endOffset = bytes.byteLength - 22;
  if (bytes.readUInt32LE(endOffset) !== 0x06054b50 || bytes.readUInt16LE(endOffset + 20) !== 0) throw new Error('PLUGIN_ARCHIVE_EOCD_INVALID');
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries === 0 || totalEntries > 64
    || centralOffset + centralSize !== endOffset) throw new Error('PLUGIN_ARCHIVE_DIRECTORY_INVALID');

  const entries = new Map();
  let centralCursor = centralOffset;
  let expectedLocalEnd = 0;
  let totalBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (centralCursor + 46 > endOffset || bytes.readUInt32LE(centralCursor) !== 0x02014b50) throw new Error('PLUGIN_ARCHIVE_CENTRAL_ENTRY_INVALID');
    const flags = bytes.readUInt16LE(centralCursor + 8);
    const method = bytes.readUInt16LE(centralCursor + 10);
    const expectedCrc = bytes.readUInt32LE(centralCursor + 16);
    const compressedSize = bytes.readUInt32LE(centralCursor + 20);
    const uncompressedSize = bytes.readUInt32LE(centralCursor + 24);
    const nameLength = bytes.readUInt16LE(centralCursor + 28);
    const extraLength = bytes.readUInt16LE(centralCursor + 30);
    const commentLength = bytes.readUInt16LE(centralCursor + 32);
    const diskStart = bytes.readUInt16LE(centralCursor + 34);
    const localOffset = bytes.readUInt32LE(centralCursor + 42);
    const centralEnd = centralCursor + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > endOffset || flags !== 0x0800 || method !== 0 || compressedSize !== uncompressedSize
      || uncompressedSize > 2 * 1024 * 1024 || extraLength !== 0 || commentLength !== 0 || diskStart !== 0) {
      throw new Error('PLUGIN_ARCHIVE_ENTRY_CONTRACT_INVALID');
    }
    const name = bytes.subarray(centralCursor + 46, centralCursor + 46 + nameLength).toString('utf8');
    if (!safeArchivePath(name) || entries.has(name)) throw new Error('PLUGIN_ARCHIVE_PATH_INVALID');
    if (localOffset !== expectedLocalEnd || localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('PLUGIN_ARCHIVE_LOCAL_ENTRY_INVALID');
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + localCompressedSize;
    const localName = bytes.subarray(localNameStart, localNameStart + localNameLength).toString('utf8');
    if (localFlags !== flags || localMethod !== method || localCrc !== expectedCrc
      || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize
      || localExtraLength !== 0 || localName !== name || dataEnd > centralOffset) {
      throw new Error('PLUGIN_ARCHIVE_LOCAL_ENTRY_MISMATCH');
    }
    const contents = bytes.subarray(dataStart, dataEnd);
    if (crc32(contents) !== expectedCrc) throw new Error('PLUGIN_ARCHIVE_CRC_MISMATCH');
    entries.set(name, Buffer.from(contents));
    totalBytes += contents.byteLength;
    if (totalBytes > 8 * 1024 * 1024) throw new Error('PLUGIN_ARCHIVE_CONTENT_TOO_LARGE');
    expectedLocalEnd = dataEnd;
    centralCursor = centralEnd;
  }
  if (centralCursor !== endOffset || expectedLocalEnd !== centralOffset) throw new Error('PLUGIN_ARCHIVE_LAYOUT_INVALID');
  return entries;
}

function safeArchivePath(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 240
    && !name.includes('\\')
    && !name.startsWith('/')
    && !/^[A-Za-z]:/u.test(name)
    && name.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function createStoredZip(files) {
  const entries = [...files.entries()].sort(([a], [b]) => stableCompare(a, b));
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(contents.byteLength, 18);
    local.writeUInt32LE(contents.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(contents.byteLength, 20);
    central.writeUInt32LE(contents.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.byteLength + nameBytes.byteLength + contents.byteLength;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArguments(argv, environment) {
  let mode = 'build';
  let personal = false;
  let appId;
  let outputDirectory;
  let archivePath;
  let checksumPath;
  let provenancePath;
  let sourceRoot;
  let sourceCommit;
  let cleanSource;
  let expectedSourceCommit;
  let expectedCleanSource;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--personal') personal = true;
    else if (argument === '--app-id') appId = argv[++index];
    else if (argument === '--output-dir') outputDirectory = argv[++index];
    else if (argument === '--source-commit') sourceCommit = argv[++index];
    else if (argument === '--clean-source') cleanSource = parseBoolean(argv[++index]);
    else if (argument === '--verify') { mode = 'verify'; archivePath = argv[++index]; }
    else if (argument === '--checksum') checksumPath = argv[++index];
    else if (argument === '--provenance') provenancePath = argv[++index];
    else if (argument === '--source-root') sourceRoot = argv[++index];
    else if (argument === '--expected-source-commit') expectedSourceCommit = argv[++index];
    else if (argument === '--expected-clean-source') expectedCleanSource = parseBoolean(argv[++index]);
    else throw new Error('PLUGIN_PACKAGE_ARGUMENT_INVALID');
    if (argument !== '--personal' && !argv[index]) throw new Error('PLUGIN_PACKAGE_ARGUMENT_VALUE_MISSING');
  }
  if (mode === 'verify') {
    if (!archivePath || personal || appId || outputDirectory || sourceCommit !== undefined || cleanSource !== undefined) throw new Error('PLUGIN_VERIFY_ARGUMENT_INVALID');
    return { mode, archivePath, checksumPath, provenancePath, sourceRoot, expectedSourceCommit, expectedCleanSource };
  }
  const environmentAppId = environment.GOTZJI_REGISTERED_APP_ID?.trim();
  if (appId && environmentAppId && appId !== environmentAppId) throw new Error('REGISTERED_APP_ID_CONFLICT');
  appId ??= environmentAppId;
  sourceCommit ??= environment.GOTZJI_PLUGIN_SOURCE_COMMIT?.trim();
  if (cleanSource === undefined && environment.GOTZJI_PLUGIN_SOURCE_CLEAN !== undefined) cleanSource = parseBoolean(environment.GOTZJI_PLUGIN_SOURCE_CLEAN);
  return { mode, personal: personal || appId !== undefined, appId, outputDirectory, sourceCommit, cleanSource };
}

async function main() {
  const options = parseArguments(process.argv.slice(2), process.env);
  const result = options.mode === 'verify'
    ? await verifyGotzjiPluginPackage(options)
    : await buildGotzjiPluginPackage(options);
  console.log(JSON.stringify(result, null, 2));
}

function parseBoolean(value) {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('PLUGIN_BOOLEAN_ARGUMENT_INVALID');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'PLUGIN_PACKAGE_FAILED');
    process.exitCode = 1;
  });
}
