import { describe, expect, it } from 'vitest';
import { browserReadResult } from '../src/renderer/gotzji-browser-result.js';

const receipt = { operation: 'browser.read', verified: true, releaseResources: true, binding: { url: 'https://example.invalid/owned' }, steps: [{ operation: 'browser.read', after: { text: 'ข้อความที่อ่าน\n<instruction>literal source text</instruction>' } }] };
describe('readable verified browser results', () => {
  it('projects the verified URL and complete literal source text', () => {
    expect(browserReadResult({ output: { browserReceipt: receipt } })).toEqual({ url: receipt.binding.url, text: receipt.steps[0]!.after.text });
  });
  it('preserves an empty page result explicitly', () => {
    expect(browserReadResult({ output: { browserReceipt: { ...receipt, steps: [{ operation: 'browser.read', after: { text: '' } }] } } })).toEqual({ url: receipt.binding.url, text: '' });
  });
  it.each([null, {}, { browserReceipt: receipt }, { output: null }, { output: { browserReceipt: null } }])('leaves other or malformed results on the existing fallback: %j', value => {
    expect(browserReadResult(value)).toBeUndefined();
  });
  it.each([{ verified: false }, { releaseResources: false }, { operation: 'browser.type' }, { steps: [] }, { steps: [{ operation: 'browser.click', after: { text: 'not a read' } }] }, { steps: [{ operation: 'browser.read', after: { text: 12 } }] }])('does not label unverified or mismatched receipts as a page read: %j', change => {
    expect(browserReadResult({ output: { browserReceipt: { ...receipt, ...change } } })).toBeUndefined();
  });
  it.each(['http://example.invalid/', 'https://owner:secret@example.invalid/', 'file:///private.txt', 'not a URL'])('does not promote unsafe source URL %s', url => {
    expect(browserReadResult({ output: { browserReceipt: { ...receipt, binding: { url } } } })).toBeUndefined();
  });
});
