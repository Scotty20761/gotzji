import { createServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { DapFrameDecoder, encodeDapMessage } from './dap-framing.js';
import { DapSessionService, type DebugOwner } from './dap-session-service.js';

const owner: DebugOwner = { clientId: 'fixture-client', sessionId: 'fixture-session', workspaceId: 'fixture-workspace' };

async function fixture(intercept?: (socket: Socket, message: Record<string, unknown>, send: (value: Record<string, unknown>) => void) => boolean): Promise<{ endpoint: string; sockets: Set<Socket>; requests: Record<string, unknown>[]; responses: Record<string, unknown>[]; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const requests: Record<string, unknown>[] = [];
  const responses: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const decoder = new DapFrameDecoder();
    let sequence = 0;
    let attach: Record<string, unknown> | undefined;
    const send = (value: Record<string, unknown>): boolean => socket.write(encodeDapMessage({ ...value, seq: ++sequence }));
    const respond = (message: Record<string, unknown>, body: unknown = {}): boolean => send({ type: 'response', request_seq: message.seq, command: message.command, success: true, body });
    socket.on('data', (chunk) => {
      for (const message of decoder.feed(chunk)) {
        if (message.type === 'response') { responses.push(message); continue; }
        requests.push(message);
        if (intercept?.(socket, message, send)) continue;
        if (message.command === 'initialize') respond(message, { supportsConfigurationDoneRequest: true });
        else if (message.command === 'attach') {
          attach = message;
          send({ type: 'event', event: 'initialized' });
        } else if (message.command === 'configurationDone') {
          respond(message);
          if (attach === undefined) throw new Error('Fixture attach missing');
          respond(attach);
          send({ type: 'event', event: 'output', body: { category: 'console', output: '  ไทย 😀\n  ' } });
        } else if (message.command === 'evaluate') send({ type: 'response', request_seq: message.seq, command: message.command, success: false, message: '  fixture ไทย error  ', body: { error: { id: 42, format: 'exact error 😀' } } });
        else respond(message, { fixture: true, command: message.command });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture port missing');
  return {
    endpoint: `tcp://127.0.0.1:${address.port}`,
    sockets, requests, responses,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
  };
}

describe('owned live DAP sessions', () => {
  it('initializes and attaches in protocol order, retaining exact output and response correlation', async () => {
    const setup = await fixture();
    const service = new DapSessionService();
    try {
      const attached = await service.attach(owner, { endpoint: setup.endpoint, configuration: { fixture: 'ไทย 😀' } });
      expect(attached).toMatchObject({ ok: true, value: { state: 'ready', workspaceId: owner.workspaceId } });
      if (!attached.ok) throw new Error('Fixture attach failed');
      expect(setup.requests.slice(0, 3).map((request) => request.command)).toEqual(['initialize', 'attach', 'configurationDone']);
      const stepped = await service.request(owner, attached.value.sessionId, 'next', { threadId: 1 });
      expect(stepped).toMatchObject({ ok: true, value: { response: { command: 'next', success: true, body: { fixture: true } } } });
      if (stepped.ok) expect(stepped.value.response.request_seq).toBe(setup.requests.at(-1)?.seq);
      const status = service.status(owner, attached.value.sessionId);
      expect(status).toMatchObject({ ok: true, value: { session: { connectionGap: false }, events: { gap: false, events: [expect.objectContaining({ value: expect.objectContaining({ event: 'initialized' }) }), expect.objectContaining({ value: expect.objectContaining({ event: 'output', body: { category: 'console', output: '  ไทย 😀\n  ' } }) })] } } });
      expect(await service.disconnect(owner, attached.value.sessionId)).toMatchObject({ ok: true, value: { state: 'disconnected', connectionGap: false, debuggeeState: 'unknown' } });
      expect(setup.requests.at(-1)).toMatchObject({ command: 'disconnect', arguments: { terminateDebuggee: false, suspendDebuggee: false, restart: false } });
    } finally { service.close(); await setup.close(); }
  });

  it.each(['clientId', 'sessionId', 'workspaceId'] as const)('denies foreign %s reads and control before sending any frame', async (field) => {
    const setup = await fixture();
    const service = new DapSessionService();
    try {
      const attached = await service.attach(owner, { endpoint: setup.endpoint });
      if (!attached.ok) throw new Error('Fixture attach failed');
      const foreign = { ...owner, [field]: 'foreign' };
      const before = setup.requests.length;
      expect(service.status(foreign, attached.value.sessionId)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(await service.request(foreign, attached.value.sessionId, 'next', { threadId: 1 })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(await service.disconnect(foreign, attached.value.sessionId)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(setup.requests).toHaveLength(before);
      expect(await service.request(owner, attached.value.sessionId, 'next', { threadId: 1 })).toMatchObject({ ok: true });
    } finally { service.close(); await setup.close(); }
  });

  it('returns adapter errors as errors with the complete response evidence', async () => {
    const setup = await fixture();
    const service = new DapSessionService();
    try {
      const attached = await service.attach(owner, { endpoint: setup.endpoint });
      if (!attached.ok) throw new Error('Fixture attach failed');
      const result = await service.request(owner, attached.value.sessionId, 'evaluate', { expression: 'fixture', context: 'watch' });
      expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { command: 'evaluate', adapterResponse: expect.any(String) } } });
      if (!result.ok) {
        const original = result.error.details?.adapterResponse;
        if (typeof original !== 'string') throw new Error('Adapter evidence missing');
        expect(JSON.parse(original)).toMatchObject({ command: 'evaluate', success: false, message: '  fixture ไทย error  ', body: { error: { id: 42, format: 'exact error 😀' } } });
      }
      expect(await service.request(owner, attached.value.sessionId, 'threads')).toMatchObject({ ok: true });
    } finally { service.close(); await setup.close(); }
  });

  it('cancels a pending command and closes only its owned socket with an explicit gap', async () => {
    const entered = Promise.withResolvers<void>();
    const setup = await fixture((_socket, message) => {
      if (message.command !== 'next') return false;
      entered.resolve();
      return true;
    });
    const service = new DapSessionService();
    const controller = new AbortController();
    try {
      const attached = await service.attach(owner, { endpoint: setup.endpoint });
      const other = await service.attach({ ...owner, sessionId: 'other-session' }, { endpoint: setup.endpoint });
      if (!attached.ok || !other.ok) throw new Error('Fixture attach failed');
      const pending = service.request(owner, attached.value.sessionId, 'next', { threadId: 1 }, controller.signal);
      await entered.promise;
      controller.abort();
      expect(await pending).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT', message: expect.stringContaining('outcome is unknown') } });
      expect(service.status(owner, attached.value.sessionId)).toMatchObject({ ok: true, value: { session: { state: 'disconnected', connectionGap: true } } });
      expect(await service.request({ ...owner, sessionId: 'other-session' }, other.value.sessionId, 'threads')).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(setup.sockets.size).toBe(1));
    } finally { service.close(); await setup.close(); }
  });

  it('rejects uncorrelated frames and unsupported reverse requests without launching code', async () => {
    const setup = await fixture((_socket, message, send) => {
      if (message.command === 'threads') {
        send({ type: 'request', command: 'runInTerminal', arguments: { args: ['never-execute'] } });
        send({ type: 'response', request_seq: message.seq, command: 'threads', success: true, body: { threads: [] } });
        return true;
      }
      if (message.command === 'next') {
        send({ type: 'response', request_seq: message.seq, command: 'different-command', success: true });
        return true;
      }
      return false;
    });
    const service = new DapSessionService();
    try {
      const attached = await service.attach(owner, { endpoint: setup.endpoint });
      if (!attached.ok) throw new Error('Fixture attach failed');
      expect(await service.request(owner, attached.value.sessionId, 'threads')).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(setup.responses).toContainEqual(expect.objectContaining({ type: 'response', command: 'runInTerminal', success: false })));
      expect(await service.request(owner, attached.value.sessionId, 'next', { threadId: 1 })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(service.status(owner, attached.value.sessionId)).toMatchObject({ ok: true, value: { session: { state: 'disconnected', connectionGap: true } } });
    } finally { service.close(); await setup.close(); }
  });

  it('supports ten attach/disconnect cycles without retaining live sockets or blocking restart', async () => {
    const setup = await fixture();
    const service = new DapSessionService();
    try {
      for (let index = 0; index < 10; index += 1) {
        const attached = await service.attach(owner, { endpoint: setup.endpoint });
        expect(attached.ok).toBe(true);
        if (!attached.ok) throw new Error('Fixture restart failed');
        expect((await service.disconnect(owner, attached.value.sessionId)).ok).toBe(true);
      }
      await vi.waitFor(() => expect(setup.sockets.size).toBe(0));
    } finally { service.close(); await setup.close(); }
  });

  it.each(['tcp://192.0.2.1:1234', 'tcp://localhost:1234', 'tcp://user:pass@127.0.0.1:1234', 'tcp://127.0.0.1:1234/path', 'tcp://127.0.0.1', 'ws://127.0.0.1:1234'])('rejects invalid endpoint %s before connection', async (endpoint) => {
    const service = new DapSessionService();
    try { expect(await service.attach(owner, { endpoint })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); }
    finally { service.close(); }
  });
});
