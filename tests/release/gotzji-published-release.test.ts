import { describe, expect, it } from 'vitest';
// @ts-expect-error The canonical version script uses a standalone JavaScript helper.
import { publishedReleaseNotice, publishedReleaseVersion } from '../../scripts/published-release.mjs';

describe('gotzji published release documentation', () => {
  it('does not turn the source version into a published release', () => {
    const readme = '# gotzji\n## Current source version: v1.0.0\nNo official installer release has been published.';
    expect(publishedReleaseVersion(readme)).toBeNull();
    const notice = publishedReleaseNotice('1.0.0', publishedReleaseVersion(readme), 'https://github.com/Scotty20761/gotzji');
    expect(notice).toContain('source `v1.0.0`');
    expect(notice).toContain('ยังไม่มีรุ่นที่เผยแพร่อย่างเป็นทางการ');
    expect(notice).not.toContain('/releases/tag/');
  });

  it('preserves an actual published version when the source version changes', () => {
    const version = publishedReleaseVersion('Latest published release: **v1.0.0**');
    const notice = publishedReleaseNotice('1.0.1', version, 'https://github.com/Scotty20761/gotzji');
    expect(notice).toContain('source `v1.0.1`');
    expect(notice).toContain('public release `v1.0.0`');
    expect(notice).toContain('/releases/tag/v1.0.0');
    expect(notice).not.toContain('/releases/tag/v1.0.1');
  });
});
