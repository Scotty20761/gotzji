import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '@lnwjud/shared';
import productPackage from '../package.json' with { type: 'json' };
import { gotzjiReleaseNotes } from '../src/renderer/gotzji-release-notes.js';
describe('owned gotzji version notes', () => {
  it('has non-empty Thai and English notes for the exact active product version', () => {
    expect(productPackage.version).toBe(APP_VERSION);
    const notes = gotzjiReleaseNotes(APP_VERSION); expect(notes).not.toBeNull(); expect(notes!.th.length).toBeGreaterThan(0); expect(notes!.en.length).toBeGreaterThan(0);
    expect([...notes!.th, ...notes!.en].every((entry) => entry.trim().length > 0 && !entry.includes('lnwjud 5.7.3'))).toBe(true);
  });
  it('keeps the upstream-numbered baseline unpublished and prepares meaningful owned v1 notes', () => {
    expect(gotzjiReleaseNotes('5.7.3')).toMatchObject({ status: 'development' }); expect(gotzjiReleaseNotes('1.0.0')!.th.join(' ')).toContain('Grace'); expect(gotzjiReleaseNotes('1.0.0')!.en.join(' ')).toContain('durable host');
  });
});
