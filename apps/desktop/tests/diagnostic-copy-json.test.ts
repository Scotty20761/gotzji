import { describe, expect, it } from 'vitest';
import { diagnosticCopyJson } from '../src/renderer/features/ui/diagnostic-copy-json.js';

describe('Doctor diagnostic clipboard timestamps', () => {
  it('keeps all recorded fields and absolute instants, showing Bangkok offset ISO time', () => {
    const source = { operationId: 'op1', observedAt: '2026-10-11T03:38:55.879Z',
      nested: { sampledAt: '2026-12-31T18:30:00.000Z', elapsedMs: 55 },
      url: 'https://test.invalid/2026-10-11T03:38:55.879Z' };
    const copied = JSON.parse(diagnosticCopyJson(source));
    expect(copied).toEqual({ ...source,
      observedAt: '2026-10-11T10:38:55.879+07:00',
      nested: { sampledAt: '2027-01-01T01:30:00.000+07:00', elapsedMs: 55 } });
    expect(Date.parse(copied.observedAt)).toBe(Date.parse(source.observedAt));
    expect(source.observedAt).toBe('2026-10-11T03:38:55.879Z');
  });
});
