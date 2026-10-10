import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Standalone distribution tooling uses JavaScript.
import { collectDependencyNotices } from '../../scripts/collect-dependency-notices.mjs';

const roots: string[] = [];
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(licenseFile = true): Promise<{ root: string; directory: string; content: string; census: { MIT: Array<{ name: string; versions: string[]; paths: string[]; license: string }> } }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gotzji-notices-'))); roots.push(root);
  const directory = path.join(root, 'node_modules', 'fixture'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'MIT' }));
  const content = 'Copyright fixture. Permission notice for a disposable test package.';
  if (licenseFile) await writeFile(path.join(directory, 'LICENSE'), content);
  return { root, directory, content, census: { MIT: [{ name: 'fixture', versions: ['1.0.0'], paths: [directory], license: 'MIT' }] } };
}

describe('dependency redistribution notices', () => {
  it('retains exact texts and hashes without publishing local paths', async () => {
    const f = await fixture(); const result = await collectDependencyNotices(f.root, f.census);
    expect(result.notices).toContain(f.content);
    expect(result.manifest.packages[0].files[0].sha256).toBe(sha(f.content));
    expect(JSON.stringify(result.manifest)).not.toContain(f.directory);
    expect(result.manifest.noticesSha256).toBe(sha(result.notices));
  });
  it('refuses missing notice text rather than interpreting MIT metadata as a full notice', async () => {
    const f = await fixture(false);
    await expect(collectDependencyNotices(f.root, f.census)).rejects.toThrow('LICENSE_TEXT_MISSING');
  });
  it('rejects a mismatched package version and paths outside the checked-out source', async () => {
    const f = await fixture();
    f.census.MIT[0]!.versions = ['2.0.0'];
    await expect(collectDependencyNotices(f.root, f.census)).rejects.toThrow('LICENSE_PACKAGE_IDENTITY_CHANGED');
    const outside = await fixture(); f.census.MIT[0]!.paths = [outside.directory];
    await expect(collectDependencyNotices(f.root, f.census)).rejects.toThrow('LICENSE_PACKAGE_OUTSIDE_REPOSITORY');
  });
  it('accepts only an exact pinned override and rejects changed override bytes', async () => {
    const f = await fixture(false);
    const override = { name: 'fixture', version: '1.0.0', license: 'MIT', fileName: 'fixture-MIT.txt', content: f.content, sha256: sha(f.content), evidenceKind: 'upstream-commit-license', source: 'fixture-only', sourceCommit: 'a'.repeat(40) };
    expect((await collectDependencyNotices(f.root, f.census, [override])).manifest.packages).toHaveLength(1);
    await expect(collectDependencyNotices(f.root, f.census, [{ ...override, content: f.content + 'changed' }])).rejects.toThrow('LICENSE_OVERRIDE_CHANGED');
  });
  it('retains a real license section from a README without copying unrelated instructions', async () => {
    const f = await fixture(false); const notice = 'Copyright fixture\n' + 'Permission test text '.repeat(20);
    await writeFile(path.join(f.directory, 'README.md'), '# Intro\nRun unrelated instructions.\n## License\n' + notice + '\n## Development\nDo not distribute this prose.');
    const result = await collectDependencyNotices(f.root, f.census);
    expect(result.notices).toContain(notice.trim());
    expect(result.notices).not.toContain('Run unrelated instructions');
    expect(result.notices).not.toContain('Do not distribute this prose');
  });
});
