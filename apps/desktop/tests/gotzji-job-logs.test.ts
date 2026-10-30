import { describe, expect, it } from 'vitest';
import { JobLogReader, MAX_LOG_CHARACTERS } from '../src/renderer/gotzji-job-logs.js';

describe('selected-job paged log reader', () => {
  it('serializes reads and advances only the selected job cursor', async () => {
    let release!: (value: unknown) => void;
    const calls: unknown[] = [];
    const reader = new JobLogReader('job-a', async (input) => { calls.push(input); return new Promise((resolve) => { release = resolve; }); });
    const first = reader.read();
    expect(await reader.read()).toBeUndefined();
    release({ text: 'first\n', nextCursor: 6 });
    expect(await first).toMatchObject({ text: 'first\n', cursor: 6 });
    const second = reader.read();
    expect(calls).toEqual([{ jobId: 'job-a', cursor: 0, limit: 8192 }, { jobId: 'job-a', cursor: 6, limit: 8192 }]);
    release({ text: 'next\n', nextCursor: 11 });
    expect(await second).toMatchObject({ text: 'first\nnext\n', cursor: 11 });
  });
  it('suppresses a late response after the selected view is closed', async () => {
    let release!: (value: unknown) => void;
    const reader = new JobLogReader('old-job', async () => new Promise((resolve) => { release = resolve; }));
    const pending = reader.read(); reader.close();
    release({ text: 'old job', nextCursor: 7 });
    expect(await pending).toBeUndefined();
    expect(await reader.read()).toBeUndefined();
    expect(reader.snapshot()).toMatchObject({ text: '', cursor: 0 });
  });
  it('retries the same cursor after a transport failure without duplicating prior text', async () => {
    const cursors: number[] = [];
    let fail = true;
    const reader = new JobLogReader('job-a', async ({ cursor }) => {
      cursors.push(cursor);
      if (fail) { fail = false; throw new Error('disconnected'); }
      return { text: 'ok', nextCursor: cursor + 2 };
    });
    await expect(reader.read()).rejects.toThrow('disconnected');
    expect(await reader.read()).toMatchObject({ text: 'ok', cursor: 2 });
    expect(cursors).toEqual([0, 0]);
  });
  it.each([{ text: 'x', nextCursor: 0 }, { text: 'x', nextCursor: -1 }, { text: 'x', nextCursor: 8193 }, { text: 1, nextCursor: 1 }, { text: 'x', nextCursor: 0.5 }])('retains its cursor after invalid response %j', async (value) => {
    const reader = new JobLogReader('job-a', async () => value);
    await expect(reader.read()).rejects.toThrow('LOG_RESPONSE_INVALID');
    expect(reader.snapshot()).toMatchObject({ text: '', cursor: 0 });
  });
  it('stops requesting once the canonical retention response says expired', async () => {
    let calls = 0;
    const reader = new JobLogReader('job-a', async () => { calls++; return { text: '', nextCursor: 0, expired: true }; });
    expect(await reader.read()).toMatchObject({ expired: true });
    expect(await reader.read()).toBeUndefined(); expect(calls).toBe(1);
  });
  it('bounds rendered text while retaining the actual cursor for later pages', async () => {
    const reader = new JobLogReader('job-a', async ({ cursor }) => ({ text: 'x'.repeat(8192), nextCursor: cursor + 8192 }));
    for (let page = 0; page < 40; page++) await reader.read();
    expect(reader.snapshot()).toMatchObject({ cursor: 327680, truncated: true });
    expect(reader.snapshot().text.length).toBe(MAX_LOG_CHARACTERS);
  });
});
