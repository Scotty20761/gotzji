const MAX_FRAME_BYTES = 1_048_576;
const MAX_HEADER_BYTES = 16_384;

export function encodeDapMessage(message: Readonly<Record<string, unknown>>): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error('DAP message exceeds its frame limit');
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, 'ascii'), payload]);
}

export class DapFrameDecoder {
  private buffer = Buffer.alloc(0);
  private length: number | null = null;

  public feed(chunk: Uint8Array): readonly Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    for (let offset = 0; offset < chunk.byteLength; offset += 65_536) {
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + 65_536)]);
      messages.push(...this.decode());
    }
    return messages;
  }

  private decode(): readonly Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    while (true) {
      if (this.length === null) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (this.buffer.byteLength > MAX_HEADER_BYTES) throw new Error('DAP header exceeds its limit');
          break;
        }
        if (end > MAX_HEADER_BYTES) throw new Error('DAP header exceeds its limit');
        const header = this.buffer.subarray(0, end).toString('ascii');
        const lengths = header.split('\r\n').filter((line) => /^content-length:/i.test(line));
        if (lengths.length !== 1) throw new Error('DAP frame requires exactly one Content-Length');
        const raw = lengths[0]?.slice('content-length:'.length).trim() ?? '';
        if (!/^\d+$/.test(raw)) throw new Error('DAP content length is invalid');
        const length = Number(raw);
        if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FRAME_BYTES) throw new Error('DAP content length exceeds its limit');
        this.length = length;
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.byteLength < this.length) break;
      const content = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.length));
      const message: unknown = JSON.parse(content);
      if (!isRecord(message)) throw new Error('DAP message must be an object');
      messages.push(message);
      this.buffer = this.buffer.subarray(this.length);
      this.length = null;
    }
    return messages;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
