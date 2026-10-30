export interface BufferedEvent<T> {
  readonly cursor: string;
  readonly value: T;
}

export interface EventPage<T> {
  readonly events: readonly BufferedEvent<T>[];
  readonly nextCursor: string;
  readonly latestCursor: string;
  readonly earliestCursor: string | null;
  readonly hasMore: boolean;
  readonly gap: boolean;
  readonly droppedEvents: number;
  readonly retainedBytes: number;
  readonly payloadBytes: number;
  readonly requiredBytes: number | null;
}

interface RetainedEvent<T> {
  readonly cursor: number;
  readonly value: T;
  readonly bytes: number;
}

export class BoundedEventBuffer<T> {
  private readonly events: RetainedEvent<T>[] = [];
  private bytes = 0;
  private cursor = 0;
  private dropped = 0;
  private lastDroppedCursor = 0;

  public constructor(private readonly maxEvents = 1_000, private readonly maxBytes = 1_048_576) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2_097_152) throw new Error('Event retention limits are invalid');
  }

  public push(value: T): boolean {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Event must contain JSON data');
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (this.cursor === Number.MAX_SAFE_INTEGER) throw new Error('Event cursor capacity exceeded');
    this.cursor += 1;
    if (bytes > this.maxBytes) {
      this.dropped += 1;
      this.lastDroppedCursor = this.cursor;
      return false;
    }
    this.events.push({ cursor: this.cursor, value: structuredClone(value), bytes });
    this.bytes += bytes;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const removed = this.events.shift();
      if (removed === undefined) break;
      this.bytes -= removed.bytes;
      this.dropped += 1;
      this.lastDroppedCursor = Math.max(this.lastDroppedCursor, removed.cursor);
    }
    return true;
  }

  public read(after = '0', limit = 100, maxBytes = 65_536): EventPage<T> {
    if (!/^(?:0|[1-9]\d*)$/.test(after)) throw new Error('Event cursor is invalid');
    const cursor = Number(after);
    if (!Number.isSafeInteger(cursor) || cursor > this.cursor || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2_097_152) throw new Error('Event query bounds are invalid');
    const selected: BufferedEvent<T>[] = [];
    let bytes = 0;
    let next = cursor;
    let hasMore = false;
    let requiredBytes: number | null = null;
    for (const event of this.events) {
      if (event.cursor <= cursor) continue;
      if (selected.length === limit || bytes + event.bytes > maxBytes) {
        hasMore = true;
        if (selected.length === 0) requiredBytes = event.bytes;
        break;
      }
      selected.push({ cursor: String(event.cursor), value: structuredClone(event.value) });
      bytes += event.bytes;
      next = event.cursor;
    }
    if (!hasMore) next = this.cursor;
    return {
      events: selected,
      nextCursor: String(next),
      latestCursor: String(this.cursor),
      earliestCursor: this.events[0] === undefined ? null : String(this.events[0].cursor),
      hasMore,
      gap: cursor < this.lastDroppedCursor,
      droppedEvents: this.dropped,
      retainedBytes: this.bytes,
      payloadBytes: bytes,
      requiredBytes,
    };
  }
}
