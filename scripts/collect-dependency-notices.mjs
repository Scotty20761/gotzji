import console from 'node:console';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const LICENSE_NAMES = /^(?:licen[sc]e|copying|notice|copyright)(?:[._-].*)?$/iu;

export async function collectDependencyNotices(repositoryRoot, census, overrides = []) {
  const root = await realpath(repositoryRoot);
  if (!census || typeof census !== 'object' || Array.isArray(census)) throw new Error('LICENSE_CENSUS_INVALID');
  const records = [];
  const seen = new Set();
  for (const [declaredLicense, packages] of Object.entries(census)) {
    if (!Array.isArray(packages) || !packages.length) throw new Error('LICENSE_CENSUS_INVALID');
    for (const pkg of packages) {
      if (!pkg?.name || !Array.isArray(pkg.paths) || !pkg.paths.length || !Array.isArray(pkg.versions) || pkg.license !== declaredLicense) throw new Error('LICENSE_PACKAGE_INVALID');
      for (const packagePath of pkg.paths) {
        const directory = await realpath(packagePath);
        const relative = path.relative(root, directory);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('LICENSE_PACKAGE_OUTSIDE_REPOSITORY');
        const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (metadata.name !== pkg.name || !pkg.versions.includes(metadata.version)) throw new Error('LICENSE_PACKAGE_IDENTITY_CHANGED');
        const identity = `${metadata.name}@${metadata.version}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const licenseFiles = [];
        for (const filename of (await readdir(directory)).filter((name) => LICENSE_NAMES.test(name)).sort()) {
          const target = path.join(directory, filename);
          const info = await lstat(target);
          if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 1024 * 1024) throw new Error('LICENSE_FILE_INVALID');
          const content = await readFile(target, 'utf8');
          licenseFiles.push({ name: filename, sha256: digest(content), content });
        }
        if (!licenseFiles.length) {
          const readmeName = (await readdir(directory)).find((name) => /^readme(?:\.md|\.markdown|\.txt)?$/iu.test(name));
          if (readmeName) {
            const target = path.join(directory, readmeName);
            const info = await lstat(target);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('LICENSE_FILE_INVALID');
            const readme = await readFile(target, 'utf8');
            const section = /^(#{1,6})\s+Licen[sc]e\s*\r?\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/imu.exec(readme)?.[2]?.trim();
            if (section && section.length >= 200 && /copyright/iu.test(section)) licenseFiles.push({ name: `${readmeName}#License`, sha256: digest(section), content: section });
          }
        }
        if (!licenseFiles.length) {
          const override = overrides.find((entry) => entry.name === metadata.name && entry.version === metadata.version && entry.license === declaredLicense);
          if (override) {
            if (!/^[a-f0-9]{64}$/u.test(override.sha256) || digest(override.content) !== override.sha256) throw new Error('LICENSE_OVERRIDE_CHANGED');
            licenseFiles.push({ name: override.fileName, sha256: override.sha256, content: override.content,
              evidenceKind: override.evidenceKind, source: override.source, sourceCommit: override.sourceCommit });
          }
        }
        if (!licenseFiles.length) throw new Error(`LICENSE_TEXT_MISSING: ${identity}`);
        records.push({ name: metadata.name, version: metadata.version, license: declaredLicense, files: licenseFiles });
      }
    }
  }
  if (!records.length) throw new Error('LICENSE_CENSUS_EMPTY');
  records.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const notices = records.map((entry) => `## ${entry.name}@${entry.version} (${entry.license})\n\n${entry.files.map((file) => `### ${file.name}\n\n${file.content}`).join('\n\n')}`).join('\n\n');
  const manifest = { schemaVersion: 1, product: 'gotzji', packages: records.map(({ name, version, license, files }) => ({ name, version, license, files: files.map((file) => ({ name: file.name, sha256: file.sha256, ...(file.evidenceKind ? { evidenceKind: file.evidenceKind, source: file.source, sourceCommit: file.sourceCommit } : {}) })) })), noticesSha256: digest(notices + '\n') };
  return { notices: notices + '\n', manifest };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const censusPath = process.argv[2];
  if (!censusPath) throw new Error('Usage: node scripts/collect-dependency-notices.mjs <pnpm-licenses-json>');
  const overrideRoot = path.join(root, 'third-party/license-overrides');
  const declarations = JSON.parse(await readFile(path.join(overrideRoot, 'manifest.json'), 'utf8'));
  if (declarations.schemaVersion !== 1 || !Array.isArray(declarations.packages)) throw new Error('LICENSE_OVERRIDE_MANIFEST_INVALID');
  const overrides = await Promise.all(declarations.packages.map(async (entry) => {
    if (!/^[a-zA-Z0-9_.-]+\.txt$/u.test(entry.fileName) || !['upstream-commit-license', 'publisher-metadata-and-standard-license'].includes(entry.evidenceKind)) throw new Error('LICENSE_OVERRIDE_MANIFEST_INVALID');
    const filename = path.join(overrideRoot, entry.fileName);
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('LICENSE_OVERRIDE_REDIRECTED');
    return { ...entry, content: await readFile(filename, 'utf8') };
  }));
  const result = await collectDependencyNotices(root, JSON.parse(await readFile(censusPath, 'utf8')), overrides);
  const output = path.join(root, 'apps/desktop/build/licenses');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'npm-NOTICES.txt'), result.notices, 'utf8');
  await writeFile(path.join(output, 'DEPENDENCY_LICENSES.json'), JSON.stringify(result.manifest, null, 2) + '\n', 'utf8');
  console.log(`Collected actual license texts for ${result.manifest.packages.length} production package versions.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
