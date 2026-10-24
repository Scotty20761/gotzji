import { describe, expect, it } from 'vitest';
import { BoundedEventBuffer } from './bounded-event-buffer.js';

describe('bounded event retention', () => {
  it('retains exact JSON and UTF-8 data across pages without exposing mutable state', () => {
    const buffer = new BoundedEventBuffer<{ text: string; values: number[] }>(10, 1_000);
    const value = { text: '  ไทย 😀\n  ', values: [1, 2] };
    buffer.push(value);
    value.values.push(3);
    buffer.push({ text: 'second', values: [] });
    const first = buffer.read('0', 1);
    expect(first).toMatchObject({ events: [{ cursor: '1', value: { text: '  ไทย 😀\n  ', values: [1, 2] } }], nextCursor: '1', hasMore: true, gap: false });
    first.events[0]?.value.values.push(4);
    expect(buffer.read('0', 1).events).toEqual([{ cursor: '1', value: { text: '  ไทย 😀\n  ', values: [1, 2] } }]);
    expect(buffer.read(first.nextCursor)).toMatchObject({ events: [{ cursor: '2', value: { text: 'second', values: [] } }], hasMore: false, nextCursor: '2' });
  });

  it('bounds a stream of 10000 events and reports overflow with usable continuation', () => {
    const buffer = new BoundedEventBuffer<{ text: string }>(100, 5_000);
    for (let index = 0; index < 10_000; index += 1) buffer.push({ text: `${index} ไทย😀` });
    const first = buffer.read('0', 40, 5_000);
    expect(first.events).toHaveLength(40);
    expect(first.gap).toBe(true);
    expect(first.retainedBytes).toBeLessThanOrEqual(5_000);
    expect(first.droppedEvents).toBe(9_900);
    const second = buffer.read(first.nextCursor, 100, 5_000);
    expect(second.events).toHaveLength(60);
    expect(second.gap).toBe(false);
    expect(second.nextCursor).toBe('10000');
    expect(second.events.at(-1)?.value).toEqual({ text: '9999 ไทย😀' });
  });

  it('reports oversized events and insufficient query budget without truncating JSON', () => {
    const buffer = new BoundedEventBuffer<{ text: string }>(10, 100);
    expect(buffer.push({ text: 'x'.repeat(100) })).toBe(false);
    buffer.push({ text: 'ไทย 😀' });
    const tooSmall = buffer.read('0', 10, 1);
    expect(tooSmall).toMatchObject({ events: [], gap: true, hasMore: true, nextCursor: '0', droppedEvents: 1, requiredBytes: expect.any(Number) });
    expect(buffer.read('0', 10, 100)).toMatchObject({ events: [{ cursor: '2', value: { text: 'ไทย 😀' } }], gap: true, hasMore: false, nextCursor: '2' });
    expect(buffer.read('2')).toMatchObject({ events: [], gap: false, nextCursor: '2' });
  });

  it.each(['-1', '1.5', '01', '9007199254740992', '1'])('rejects invalid or future cursors %s', (cursor) => {
    expect(() => new BoundedEventBuffer().read(cursor)).toThrow();
  });
});
