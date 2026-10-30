import { describe, expect, it } from 'vitest';
import { decodeUtf8LogPage } from './utf8-log-page.js';

describe('UTF-8 log framing with byte cursors', () => {
  it.each([4, 5, 8, 8192])('reconstructs Thai and emoji at the %i-byte boundary', (limit) => {
    const expected = 'x'.repeat(8191) + 'ภาษาไทย🌟'.repeat(30) + 'END';
    const source = Buffer.from(expected);
    let cursor = 0; let actual = '';
    while (cursor < source.length) {
      const page = decodeUtf8LogPage(source.subarray(cursor, cursor + limit + 3), limit, true);
      expect(page.byteLength).toBeGreaterThan(0);
      expect(page.byteLength).toBeLessThanOrEqual(limit);
      actual += page.text; cursor += page.byteLength;
    }
    expect(cursor).toBe(source.length);
    expect(actual).toBe(expected);
    expect(actual).not.toContain('\uFFFD');
  });
  it('leaves a temporarily incomplete live character at the same byte cursor', () => {
    const bytes = Buffer.from('ภ');
    expect(decodeUtf8LogPage(bytes.subarray(0, 2), 8192, false)).toEqual({ text: '', byteLength: 0 });
    expect(decodeUtf8LogPage(bytes, 8192, false)).toEqual({ text: 'ภ', byteLength: 3 });
  });
  it('supports tiny ASCII pages but explicitly refuses a budget smaller than one complete character', () => {
    expect(decodeUtf8LogPage(Buffer.from('ab'), 1, false)).toEqual({ text: 'a', byteLength: 1 });
    expect(() => decodeUtf8LogPage(Buffer.from('ภ'), 1, false)).toThrow(expect.objectContaining({ code: 'LOG_LIMIT_TOO_SMALL', field: 'limit' }));
  });
  it('preserves replacement decoding for genuinely incomplete final bytes', () => {
    expect(decodeUtf8LogPage(Buffer.from('🌟').subarray(0, 2), 8192, true)).toEqual({ text: '\uFFFD', byteLength: 2 });
    expect(decodeUtf8LogPage(Buffer.from([0xff, 0x61]), 8192, true)).toEqual({ text: '\uFFFDa', byteLength: 2 });
  });
  it('does not read beyond an empty page', () => {
    expect(decodeUtf8LogPage(Buffer.alloc(0), 8192, false)).toEqual({ text: '', byteLength: 0 });
  });
});
