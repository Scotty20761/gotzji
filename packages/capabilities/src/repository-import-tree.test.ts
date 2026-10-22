import { describe, expect, it } from 'vitest';
import { validateRepositoryImportTree } from './repository-import-tree.js';

const oid = 'a'.repeat(40);
const blob = (name: string, mode = '100644'): string => `${mode} blob ${oid}\t${name}\0`;
const tree = (...records: string[]): Uint8Array => Buffer.from(records.join(''), 'utf8');

describe('repository import Git tree validation', () => {
  it('accepts regular UTF-8 ASCII files and executable blobs', () => {
    expect(validateRepositoryImportTree(tree(blob('README.md'), blob('src/main.ts'), blob('.github/workflows/test.yml'), blob('bin/tool.sh', '100755')))).toMatchObject({ ok: true, value: { fileCount: 4 } });
  });
  it.each([
    ['symlink', '120000', 'README.md'],
    ['submodule', '160000', 'component'],
    ['unknown mode', '100664', 'README.md'],
    ['git metadata', '100644', '.git/config'],
    ['git modules', '100644', '.gitmodules'],
    ['path traversal', '100644', 'src/../secret'],
    ['Windows device', '100644', 'data/CON.txt'],
    ['ADS colon', '100644', 'readme:evil'],
    ['invalid separator', '100644', 'src\\secret'],
    ['trailing dot', '100644', 'file.'],
    ['trailing space', '100644', 'file '],
    ['control code', '100644', 'bad\nname'],
  ])('refuses %s', (_label, mode, filename) => {
    expect(validateRepositoryImportTree(tree(blob(filename, mode)))).toMatchObject({ ok: false });
  });
  it('refuses case-insensitive and file/directory collisions before checkout', () => {
    expect(validateRepositoryImportTree(tree(blob('Foo.ts'), blob('foo.ts')))).toMatchObject({ ok: false });
    expect(validateRepositoryImportTree(tree(blob('src'), blob('src/main.ts')))).toMatchObject({ ok: false });
    expect(validateRepositoryImportTree(tree(blob('SRC/main.ts'), blob('src/other.ts')))).toMatchObject({ ok: false });
  });
  it('rejects missing NULs, hidden binary names, malformed OIDs and excessive entries', () => {
    expect(validateRepositoryImportTree(Buffer.from(`100644 blob ${oid}\tREADME.md`))).toMatchObject({ ok: false });
    expect(validateRepositoryImportTree(Buffer.from([0xff, 0])).ok).toBe(false);
    expect(validateRepositoryImportTree(tree(`100644 blob abc\tREADME.md\0`))).toMatchObject({ ok: false });
    expect(validateRepositoryImportTree(tree(blob('a'), blob('b')), { maxFiles: 1 })).toMatchObject({ ok: false });
  });
});