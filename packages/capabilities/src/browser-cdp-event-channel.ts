import type { BrowserCdpEventChannel } from './browser-cdp-backend.js';

const MAX_FRAME_BYTES = 1_048_576;
const MAX_PENDING = 32;
const COMMAND_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;

export class BrowserCdpChannelCleanupError extends Error {
  public constructor(public readonly channel: BrowserCdpEventChannel) {
    super('Browser subscription channel closure was not confirmed');
  }
}

export function openBrowserCdpEventChannel(
  url: string,
  onEvent: (method: string, params: unknown) => void,
  onDisconnected: (closureConfirmed: boolean) => void,
  signal?: AbortSignal,
): Promise<BrowserCdpEventChannel> {
  if (signal?.aborted === true) return Promise.reject(new Error('Browser subscription was cancelled'));
  const channel = new CdpEventChannel(url, onEvent, onDisconnected);
  return channel.open(signal);
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

class CdpEventChannel implements BrowserCdpEventChannel {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingCommand>();
  private sequence = 0;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveClose: (() => void) | null = null;
  private rejectClose: ((error: Error) => void) | null = null;
  private rejectOpen: ((error: Error) => void) | null = null;
  private resolveOpen: (() => void) | null = null;

  public constructor(url: string, private readonly onEvent: (method: string, params: unknown) => void, private readonly onDisconnected: (closureConfirmed: boolean) => void) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('open', this.onOpen);
    this.socket.addEventListener('message', this.onMessage);
    this.socket.addEventListener('error', this.onError);
    this.socket.addEventListener('close', this.onClose);
  }

  public async open(signal?: AbortSignal): Promise<BrowserCdpEventChannel> {
    const abort = (): void => { this.fail(new Error('Browser subscription was cancelled')); };
    const timer = setTimeout(() => this.fail(new Error('Browser subscription connection timed out')), COMMAND_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => { this.resolveOpen = resolve; this.rejectOpen = reject; });
      if (signal?.aborted === true) throw new Error('Browser subscription was cancelled');
      return this;
    } catch (error) {
      try { await this.close(); } catch { throw new BrowserCdpChannelCleanupError(this); }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.resolveOpen = null;
      this.rejectOpen = null;
    }
  }

  public request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closing || this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser subscription channel is closed'));
    if (signal?.aborted === true) return Promise.reject(new Error('Browser subscription command was cancelled'));
    if (this.pending.size >= MAX_PENDING || this.sequence === 2_147_483_647) return Promise.reject(new Error('Browser subscription command capacity exceeded'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const settleError = (error: Error): void => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(error);
      };
      const abort = (): void => settleError(new Error('Browser subscription command was cancelled'));
      const timer = setTimeout(() => settleError(new Error('Browser subscription command timed out')), COMMAND_TIMEOUT_MS);
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch { settleError(new Error('Browser subscription command could not be sent')); }
    });
  }

  public close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.rejectCommands(new Error('Browser subscription channel closed'));
    this.rejectOpen?.(new Error('Browser subscription channel closed'));
    const closing = new Promise<void>((resolve, reject) => { this.resolveClose = resolve; this.rejectClose = reject; });
    this.closePromise = closing;
    this.closeTimer = setTimeout(() => this.failClose(), CLOSE_TIMEOUT_MS);
    try { this.socket.close(); } catch { this.failClose(); }
    return closing;
  }

  private readonly onOpen = (): void => { this.resolveOpen?.(); };

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.closing || this.closed) return;
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data, 'utf8') > MAX_FRAME_BYTES) {
      this.fail(new Error('Browser subscription frame is invalid'));
      return;
    }
    let value: unknown;
    try { value = JSON.parse(event.data) as unknown; } catch { this.fail(new Error('Browser subscription frame is invalid')); return; }
    if (!isRecord(value)) { this.fail(new Error('Browser subscription frame is invalid')); return; }
    if (value.id !== undefined) {
      if (!Number.isSafeInteger(value.id) || typeof value.id !== 'number' || value.id < 1) { this.fail(new Error('Browser subscription response is invalid')); return; }
      const command = this.pending.get(value.id);
      if (command === undefined) return;
      this.pending.delete(value.id);
      command.cleanup();
      if (isRecord(value.error)) command.reject(new Error('Browser subscription domain request failed'));
      else if (isRecord(value.result)) command.resolve(value.result);
      else { command.reject(new Error('Browser subscription response is invalid')); this.fail(new Error('Browser subscription response is invalid')); }
      return;
    }
    if (typeof value.method !== 'string' || !isRecord(value.params)) { this.fail(new Error('Browser subscription event is invalid')); return; }
    if (value.method === 'Inspector.detached') { this.fail(new Error('Browser subscription detached')); return; }
    try { this.onEvent(value.method, value.params); } catch { this.fail(new Error('Browser subscription event could not be retained')); }
  };

  private readonly onError = (): void => { this.fail(new Error('Browser subscription socket failed')); };

  private readonly onClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.rejectOpen?.(new Error('Browser subscription socket closed'));
    this.rejectCommands(new Error('Browser subscription socket closed'));
    this.socket.removeEventListener('open', this.onOpen);
    this.socket.removeEventListener('message', this.onMessage);
    this.socket.removeEventListener('error', this.onError);
    this.socket.removeEventListener('close', this.onClose);
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.resolveClose?.();
    this.resolveClose = null;
    this.rejectClose = null;
    this.onDisconnected(true);
  };

  private fail(error: Error): void {
    this.onDisconnected(false);
    this.rejectOpen?.(error);
    this.rejectCommands(error);
    void this.close().catch(() => undefined);
  }

  private rejectCommands(error: Error): void {
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
  }

  private failClose(): void {
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.closePromise = null;
    const reject = this.rejectClose;
    this.resolveClose = null;
    this.rejectClose = null;
    this.onDisconnected(false);
    reject?.(new Error('Browser subscription channel closure was not confirmed'));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
