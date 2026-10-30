import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserCdpBackend } from './browser-cdp-backend.js';
import { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from './task-ownership.js';

interface Peer { readonly tabId: string; readonly socket: Socket }
interface Command { readonly tabId: string; readonly method: string; readonly id: number; readonly params: unknown }

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { readonly failDomain?: string; readonly holdDomain?: string; readonly ignoreClose?: boolean } = {}): Promise<{
  readonly backend: BrowserCdpBackend;
  readonly protocol: NodeBrowserCdpProtocol;
  readonly commands: Command[];
  readonly peers: Peer[];
  readonly listRequests: () => number;
  readonly emit: (tabId: string, method: string, params: unknown) => void;
  readonly raw: (tabId: string, value: string) => void;
  readonly disconnect: (tabId: string) => void;
  readonly stopEndpoint: () => Promise<void>;
}> {
  const peers: Peer[] = [];
  const commands: Command[] = [];
  let listRequests = 0;
  const server = createServer((request, response) => {
    if (request.url !== '/json/list') { response.writeHead(404).end(); return; }
    listRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(['tab-a', 'tab-b', 'protected'].map((id) => ({
      id, title: id, url: id === 'protected' ? 'https://chatgpt.com/' : `http://127.0.0.1:${port}/${id}`,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}`,
    }))));
  });
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const tabId = request.url?.split('/').at(-1) ?? '';
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')}\r\n\r\n`);
    const peer = { tabId, socket };
    peers.push(peer);
    socket.on('close', () => { const index = peers.indexOf(peer); if (index >= 0) peers.splice(index, 1); });
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = (buffer[0] ?? 0) & 15;
        let size = (buffer[1] ?? 0) & 127;
        let offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (size > 2_097_152) { socket.destroy(); return; }
        const masked = ((buffer[1] ?? 0) & 128) !== 0;
        if (buffer.length < offset + (masked ? 4 : 0) + size) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const payload = Buffer.from(buffer.subarray(offset, offset + size));
        if (mask !== null) for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
        buffer = buffer.subarray(offset + size);
        if (opcode === 8) {
          if (options.ignoreClose !== true) socket.end(frame(payload, 8));
          continue;
        }
        if (opcode === 9) { socket.write(frame(payload, 10)); continue; }
        if (opcode !== 1) continue;
        const value: unknown = JSON.parse(payload.toString('utf8')) as unknown;
        if (!isRecord(value) || typeof value.id !== 'number' || typeof value.method !== 'string') continue;
        commands.push({ tabId, method: value.method, id: value.id, params: value.params });
        if (value.method === options.holdDomain) continue;
        socket.write(frame(Buffer.from(JSON.stringify(value.method === options.failDomain
          ? { id: value.id, error: { code: -1, message: 'provider private token=hidden' } }
          : { id: value.id, result: {} }))));
      }
    });
  });
  const port = await listen(server);
  const protocol = new NodeBrowserCdpProtocol({ port });
  const backend = new BrowserCdpBackend({ protocol });
  cleanups.push(async () => { for (const peer of peers) peer.socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  cleanups.push(async () => { await backend.close().catch(() => undefined); });
  const raw = (tabId: string, value: string): void => { for (const peer of peers.filter((candidate) => candidate.tabId === tabId)) peer.socket.write(frame(Buffer.from(value))); };
  return { backend, protocol, commands, peers, listRequests: () => listRequests, raw,
    emit: (tabId, method, params): void => raw(tabId, JSON.stringify({ method, params })),
    disconnect: (tabId): void => { for (const peer of peers.filter((candidate) => candidate.tabId === tabId)) peer.socket.destroy(); },
    stopEndpoint: (): Promise<void> => new Promise((resolve) => server.close(() => resolve())),
  };
}

function frame(payload: Buffer, opcode = 1): Buffer {
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65_536 ? 4 : 10);
  header[0] = 128 | opcode;
  header[1] = payload.length < 126 ? payload.length : payload.length < 65_536 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(payload.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); if (address === null || typeof address === 'string') reject(new Error('Fixture address unavailable')); else resolve(address.port); });
  });
}

const owner = (sessionId = 'session-a', workspaceId: string | undefined = 'workspace-a', clientId = 'client-a'): Record<string, unknown> => ({
  [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId, sessionId, ...(workspaceId === undefined ? {} : { workspaceId }) },
});
const start = (tabId = 'tab-a', parameters: Record<string, unknown> = {}): Record<string, unknown> => ({ action: 'debug_stream', tab_id: tabId, metadata: owner(), parameters: { operation: 'start', ...parameters } });
const owned = (streamId: string, operation = 'read', parameters: Record<string, unknown> = {}, metadata = owner()): Record<string, unknown> => ({ action: 'debug_stream', metadata, parameters: { operation, stream_id: streamId, ...parameters } });
function value(result: unknown): Record<string, unknown> { if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) throw new Error(`Expected successful result ${JSON.stringify(result)}`); return result.value; }
function id(result: unknown): string { const resultValue = value(result); if (typeof resultValue.stream_id !== 'string') throw new Error('Stream ID absent'); return resultValue.stream_id; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
async function until(predicate: () => boolean): Promise<void> { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture observation timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); } }

describe('retained browser streams through actual websocket channels', () => {
  it('retains only selected-tab Runtime, Log and Network events and sanitizes before retention', async () => {
    const f = await fixture();
    const streamId = id(await f.backend.execute(start()));
    expect(f.commands.map((command) => command.method)).toEqual(['Runtime.enable', 'Log.enable', 'Network.enable']);
    f.emit('tab-b', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'foreign tab' }] });
    f.emit('tab-a', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: '  ไทย 😀\r\n' }, { value: 'token=hidden Bearer privateValue' }, { value: { password: 'object-secret' }, type: 'object' }] });
    f.emit('tab-a', 'Log.entryAdded', { entry: { text: 'log text', level: 'warning', url: 'https://user:password@example.com/path?token=secret#fragment' } });
    f.emit('tab-a', 'Network.requestWillBeSent', { requestId: 'request-1', type: 'Fetch', request: { url: 'https://user:password@example.com/path?token=secret', method: 'POST', headers: { Authorization: 'private-header' }, postData: 'private-body' } });
    await untilAsync(async () => value(await f.backend.execute(owned(streamId))).latest_cursor === '3');
    const page = value(await f.backend.execute(owned(streamId)));
    expect(page.events).toHaveLength(3);
    const encoded = JSON.stringify(page);
    expect(encoded).toContain('  ไทย 😀\\r\\n');
    for (const secret of ['hidden', 'privateValue', 'object-secret', 'password@example', 'token=secret', 'fragment', 'private-header', 'private-body', 'foreign tab']) expect(encoded).not.toContain(secret);
    expect(page).toMatchObject({ state: 'active', gap: false, completeness: 'observed_since_subscription', history_before_subscription: 'unavailable' });
  });

  it('denies foreign identities and conflicting references without querying tabs or sending commands', async () => {
    const f = await fixture();
    const streamId = id(await f.backend.execute(start()));
    const requests = f.listRequests();
    for (const metadata of [owner('foreign-session'), owner('session-a', 'foreign-workspace'), owner('session-a', 'workspace-a', 'foreign-client')]) {
      for (const operation of ['read', 'status', 'close', 'reconnect']) expect(await f.backend.execute(owned(streamId, operation, {}, metadata))).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    }
    expect(await f.backend.execute({ ...owned(streamId, 'status'), tab_id: 'tab-b' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.listRequests()).toBe(requests);
    expect(f.commands).toHaveLength(3);
    expect(await f.backend.execute(owned(streamId, 'status', {}, owner('session-a', undefined)))).toMatchObject({ ok: true, value: { state: 'active' } });
  });

  it('requires trusted owner and explicit tab, and refuses protected account subscriptions', async () => {
    const f = await fixture();
    for (const input of [{ ...start(), metadata: {} }, { ...start(), metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'a' } } }, { ...start(), tab_id: undefined }, { ...start(), metadata: owner('bad\0owner') }, start('missing')]) expect(await f.backend.execute(input)).toMatchObject({ ok: false });
    expect(await f.backend.execute(start('protected'))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(f.peers).toHaveLength(0);
    expect(f.commands).toHaveLength(0);
    expect(await f.backend.execute({ ...start(), dry_run: true })).toMatchObject({ ok: true, value: { dry_run: true } });
    expect(f.peers).toHaveLength(0);
  });

  it('reports a stopped managed endpoint as a typed prerequisite failure', async () => {
    const f = await fixture();
    await f.stopEndpoint();
    expect(await f.backend.execute(start())).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    expect(f.peers).toHaveLength(0);
    expect(f.commands).toHaveLength(0);
  });

  it('closes observations when the selected tab later reaches a protected account page', async () => {
    const f = await fixture();
    const streamId = id(await f.backend.execute(start()));
    f.emit('tab-a', 'Runtime.executionContextCreated', { context: { origin: 'https://chatgpt.com', id: 1 } });
    f.emit('tab-a', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'private conversation' }] });
    await until(() => f.peers.length === 0);
    const result = await f.backend.execute(owned(streamId));
    expect(result).toMatchObject({ ok: true, value: { state: 'disconnected', gap: true, events: [] } });
    expect(JSON.stringify(result)).not.toContain('private conversation');
  });

  it('reports whole-event count and UTF-8 byte loss, stable cursors and insufficient page budget', async () => {
    const f = await fixture();
    const streamId = id(await f.backend.execute(start('tab-a', { max_events: 2, max_bytes: 600 })));
    for (const text of ['one', 'two', 'สาม 😀']) f.emit('tab-a', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: text }] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const tiny = value(await f.backend.execute(owned(streamId, 'read', { max_bytes: 1 })));
    expect(tiny).toMatchObject({ events: [], has_more: true, gap: true, dropped_events: 1, next_cursor: '0' });
    expect(tiny.required_bytes).toBeGreaterThan(1);
    const first = value(await f.backend.execute(owned(streamId, 'read', { limit: 1 })));
    expect(first).toMatchObject({ next_cursor: '2', latest_cursor: '3', has_more: true, gap: true });
    const second = value(await f.backend.execute(owned(streamId, 'read', { after_cursor: '2' })));
    expect(second).toMatchObject({ next_cursor: '3', has_more: false, gap: true, cursor_gap: false, completeness: 'partial_after_gap' });
    expect(second.retained_bytes).toBeLessThanOrEqual(600);
    expect(JSON.stringify(second)).toContain('สาม 😀');
    f.emit('tab-a', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'ก'.repeat(400) }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await f.backend.execute(owned(streamId, 'read', { after_cursor: '3' }))).toMatchObject({ ok: true, value: { gap: true, dropped_events: 2, next_cursor: '4', events: [] } });
    expect(await f.backend.execute(owned(streamId, 'read', { after_cursor: '5' }))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('keeps explicit reconnect gaps and closes only the selected owned channel', async () => {
    const f = await fixture();
    const first = id(await f.backend.execute(start()));
    const second = id(await f.backend.execute(start('tab-b')));
    f.disconnect('tab-a');
    await until(() => f.peers.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await f.backend.execute(owned(first, 'status'))).toMatchObject({ ok: true, value: { state: 'disconnected', gap: true } });
    expect(await f.backend.execute(owned(first, 'reconnect'))).toMatchObject({ ok: true, value: { state: 'active', gap: true } });
    expect(await f.backend.execute(owned(first, 'close'))).toMatchObject({ ok: true, value: { state: 'closed', gap: true } });
    await until(() => f.peers.length === 1);
    f.emit('tab-b', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'second stream survives' }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(JSON.stringify(await f.backend.execute(owned(second)))).toContain('second stream survives');
    expect(await f.backend.execute(owned(first, 'reconnect'))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('retains a clean observed interval after a confirmed intentional close', async () => {
    const f = await fixture();
    const streamId = id(await f.backend.execute(start()));
    expect(await f.backend.execute(owned(streamId, 'close'))).toMatchObject({ ok: true, value: { state: 'closed', gap: false, completeness: 'observed_since_subscription' } });
    await until(() => f.peers.length === 0);
  });

  it('closes failed setup and cancelled startup, preserving other streams', async () => {
    const failed = await fixture({ failDomain: 'Log.enable' });
    expect(await failed.backend.execute(start())).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await until(() => failed.peers.length === 0);
    expect(failed.commands.map((command) => command.method)).toEqual(['Runtime.enable', 'Log.enable']);
    const held = await fixture({ holdDomain: 'Network.enable' });
    const abort = new AbortController();
    const pending = held.backend.execute(start(), abort.signal);
    await until(() => held.commands.some((command) => command.method === 'Network.enable'));
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await until(() => held.peers.length === 0);
    expect(JSON.stringify(await failed.backend.execute(start()))).not.toContain('provider private');
  });

  it('reserves concurrent starts and waits for startup cancellation during host shutdown', async () => {
    const f = await fixture({ holdDomain: 'Log.enable' });
    const starts = Array.from({ length: 5 }, () => f.backend.execute(start()));
    await until(() => f.commands.filter((command) => command.method === 'Log.enable').length === 4);
    await f.backend.close();
    const results = await Promise.all(starts);
    expect(results.filter((result) => !result.ok && result.error.code === 'CONFLICT')).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.code === 'PROCESS_TIMEOUT')).toHaveLength(4);
    await until(() => f.peers.length === 0);
    expect(await f.backend.execute(start())).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
  });

  it('expires owned channels and refuses retained data after the TTL', async () => {
    const f = await fixture();
    const streamId = id(await f.backend.execute(start('tab-a', { ttl_seconds: 0.1 })));
    f.emit('tab-a', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'expires' }] });
    await until(() => f.peers.length === 0);
    expect(await f.backend.execute(owned(streamId, 'status'))).toMatchObject({ ok: true, value: { state: 'expired', retained_bytes: 0 } });
    expect(await f.backend.execute(owned(streamId))).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    expect(await f.backend.execute(owned(streamId, 'close'))).toMatchObject({ ok: true, value: { state: 'expired' } });
  });

  it('settles bounded pending commands when its channel closes', async () => {
    const f = await fixture({ holdDomain: 'Test.hold' });
    const channel = await f.protocol.openEventChannel('tab-a', () => undefined, () => undefined);
    const outcomes = Promise.allSettled(Array.from({ length: 40 }, () => channel.request('Test.hold', {})));
    await until(() => f.commands.length === 32);
    await channel.close();
    const settled = await outcomes;
    expect(settled.filter((entry) => entry.status === 'rejected')).toHaveLength(40);
    expect(settled.filter((entry) => entry.status === 'rejected' && entry.reason instanceof Error && entry.reason.message.includes('capacity'))).toHaveLength(8);
    await until(() => f.peers.length === 0);
  });

  it('quarantines unconfirmed channel closure without admitting replacements', async () => {
    const f = await fixture({ ignoreClose: true });
    const streams = await Promise.all(Array.from({ length: 4 }, async () => id(await f.backend.execute(start()))));
    const closed = await Promise.all(streams.map((streamId) => f.backend.execute(owned(streamId, 'close'))));
    expect(closed).toHaveLength(4);
    for (const result of closed) expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    const before = f.listRequests();
    expect(await f.backend.execute(start())).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.listRequests()).toBe(before);
    expect(await f.backend.execute(owned(streams[0] ?? '', 'status'))).toMatchObject({ ok: true, value: { state: 'cleanup_failed', gap: true } });
    f.disconnect('tab-a');
    await until(() => f.peers.length === 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await f.backend.execute(owned(streams[0] ?? '', 'status'))).toMatchObject({ ok: true, value: { state: 'closed' } });
    expect(await f.backend.execute(owned(streams[0] ?? '', 'reconnect'))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await f.backend.close();
  }, 10_000);

  it.each(['{invalid', JSON.stringify({ method: 'Runtime.consoleAPICalled', params: null }), JSON.stringify({ method: 'Runtime.consoleAPICalled', params: {} }), JSON.stringify({ method: 'Inspector.detached', params: { reason: 'target_closed' } }), 'x'.repeat(1_048_577)])('disconnects invalid complete frames and reports a gap', async (frameValue) => {
    const f = await fixture();
    const streamId = id(await f.backend.execute(start()));
    f.raw('tab-a', frameValue);
    await until(() => f.peers.length === 0);
    expect(await f.backend.execute(owned(streamId, 'status'))).toMatchObject({ ok: true, value: { state: 'disconnected', gap: true } });
  });
});

async function untilAsync(predicate: () => Promise<boolean>): Promise<void> { const deadline = Date.now() + 2000; while (!await predicate()) { if (Date.now() > deadline) throw new Error('Fixture observation timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); } }
