import { describe, expect, it } from 'vitest';
import { DapFrameDecoder, encodeDapMessage } from './dap-framing.js';

describe('DAP byte framing', () => {
  it('correlates complete messages after arbitrary byte splits including Unicode', () => {
    const first = { seq: 1, type: 'event', event: 'output', body: { output: '  ไทย 😀\n' } };
    const second = { seq: 2, type: 'response', request_seq: 5, success: false, command: 'evaluate', message: 'fixture error' };
    const wire = Buffer.concat([encodeDapMessage(first), encodeDapMessage(second)]);
    const decoder = new DapFrameDecoder();
    const received: unknown[] = [];
    for (let offset = 0; offset < wire.byteLength; offset += 3) received.push(...decoder.feed(wire.subarray(offset, offset + 3)));
    expect(received).toEqual([first, second]);
    const header = encodeDapMessage(first).subarray(0, encodeDapMessage(first).indexOf('\r\n\r\n')).toString('ascii');
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(JSON.stringify(first), 'utf8')}`);
  });

  it.each([
    'Content-Length: -1\r\n\r\n{}',
    'Content-Length: 1048577\r\n\r\n',
    'Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}',
    'Content-Type: application/json\r\n\r\n{}',
    'Content-Length: 4\r\n\r\nnull',
    'Content-Length: 2\r\n\r\n[]',
    'Content-Length: 1\r\n\r\n{',
  ])('rejects malformed frames without treating them as adapter success', (wire) => {
    expect(() => new DapFrameDecoder().feed(Buffer.from(wire))).toThrow();
  });

  it('rejects malformed UTF-8 and oversized incomplete headers', () => {
    const invalid = Buffer.concat([Buffer.from('Content-Length: 9\r\n\r\n'), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])]);
    expect(() => new DapFrameDecoder().feed(invalid)).toThrow();
    expect(() => new DapFrameDecoder().feed(Buffer.alloc(16_385, 65))).toThrow();
  });

  it('accepts complete bounded frames delivered together in a larger network chunk', () => {
    const frame = { seq: 1, type: 'event', event: 'output', body: { output: 'x'.repeat(900_000) } };
    const wire = Buffer.concat([encodeDapMessage(frame), encodeDapMessage({ ...frame, seq: 2 })]);
    expect(new DapFrameDecoder().feed(wire)).toEqual([frame, { ...frame, seq: 2 }]);
  });
});
