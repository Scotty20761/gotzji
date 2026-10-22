import { describe, expect, it } from 'vitest';
import { parseRepositoryImportRequest } from './repository-import-contract.js';

const baseline = {
  workspaceId: 'workspace-1',
  requestId: 'dab2a2bf-4f7e-4fae-bd68-01f9bc3d6a27',
  url: 'https://github.com/example/example.git',
  destination: 'imports/example',
  commit: 'a'.repeat(40),
} as const;

describe('repository import contract', () => {
  it('accepts only the bounded typed input with exact commit and clean HTTPS origin', () => {
    expect(parseRepositoryImportRequest(baseline)).toEqual({
      ok: true,
      value: baseline,
    });
    expect(parseRepositoryImportRequest({ ...baseline, commit: 'B'.repeat(64) })).toMatchObject({
      ok: true, value: { commit: 'b'.repeat(64) },
    });
  });

  it.each([
    'http://github.com/example/repo.git',
    'https://user:token@github.com/example/repo.git',
    'https://github.com/example/repo.git?access_token=secret',
    'https://github.com/example/repo.git#fragment',
    'https://github.com/example/repo.git\n',
    'https://github.com:444/example/repo.git',
    'https://github.com/%2e%2e/hidden.git',
    'https://127.0.0.1/private',
    'https://localhost/private',
    'https://example.com\\evil.test/path',
  ])('refuses unsafe URL %s', (url) => {
    expect(parseRepositoryImportRequest({ ...baseline, url })).toMatchObject({ ok: false });
  });

  it.each(['', '.', '..', '../outside', '/absolute', 'C:\\escape', 'folder/../escape', 'folder//escape', 'folder/.git', 'folder/CON', 'folder/a.', 'folder/a:stream', 'folder/a\\b', 'folder/LPT1.txt'])('refuses an unsafe destination %s', (destination) => {
    expect(parseRepositoryImportRequest({ ...baseline, destination })).toMatchObject({ ok: false });
  });

  it('refuses short commit hashes, extra parameters and non-UUID request identifiers without preserving secrets', () => {
    for (const candidate of [
      { ...baseline, commit: 'abcdef' },
      { ...baseline, requestId: 'my-task' },
      { ...baseline, secretToken: 'should-never-enter-state' },
      { ...baseline, url: { href: 'https://github.com/repo.git', password: 'secret' } },
    ]) {
      const result = parseRepositoryImportRequest(candidate);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('secret');
    }
  });
});
