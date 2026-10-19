export const MAX_LOG_CHARACTERS = 262144;
export interface JobLogSnapshot {
  readonly text: string;
  readonly cursor: number;
  readonly expired: boolean;
  readonly truncated: boolean;
}
type LogRequest = (input: { readonly jobId: string; readonly cursor: number; readonly limit: number }) => Promise<unknown>;

/** A view cursor only; the existing Core owns the job, retained output and authority. */
export class JobLogReader {
  #value: JobLogSnapshot = { text: '', cursor: 0, expired: false, truncated: false };
  #closed = false;
  #reading = false;
  constructor(private readonly jobId: string, private readonly request: LogRequest) {}
  snapshot(): JobLogSnapshot { return { ...this.#value }; }
  close(): void { this.#closed = true; }
  async read(): Promise<JobLogSnapshot | undefined> {
    if (this.#closed || this.#reading || this.#value.expired) return undefined;
    this.#reading = true;
    try {
      const value = await this.request({ jobId: this.jobId, cursor: this.#value.cursor, limit: 8192 });
      if (this.#closed) return undefined;
      if (value === null || typeof value !== 'object') throw new Error('LOG_RESPONSE_INVALID');
      const page = value as { text?: unknown; nextCursor?: unknown; expired?: unknown };
      if (typeof page.text !== 'string' || page.text.length > 8192 || !Number.isSafeInteger(page.nextCursor)
        || Number(page.nextCursor) < this.#value.cursor || Number(page.nextCursor) - this.#value.cursor > 8192
        || page.text.length > 0 && Number(page.nextCursor) === this.#value.cursor
        || page.expired !== undefined && typeof page.expired !== 'boolean') throw new Error('LOG_RESPONSE_INVALID');
      if (page.expired === true) {
        this.#value = { ...this.#value, text: '', expired: true };
      } else {
        const combined = this.#value.text + page.text;
        const truncated = this.#value.truncated || combined.length > MAX_LOG_CHARACTERS;
        let text = combined.slice(-MAX_LOG_CHARACTERS);
        // Never start the rendered window in the middle of a UTF-16 surrogate pair.
        if (text.length && text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff) text = text.slice(1);
        this.#value = { text, cursor: Number(page.nextCursor), expired: false, truncated };
      }
      return this.snapshot();
    } catch (error) { if (!this.#closed) throw error; return undefined; }
    finally { this.#reading = false; }
  }
}
