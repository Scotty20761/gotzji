import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { gotzjiIpcChannels, ipcChannels } from '@lnwjud/ipc-contracts';
import { assertGotzjiInheritedChannel } from '../src/main/gotzji-desktop-boundary.js';
import { registerGotzjiIpcHandlers } from '../src/main/gotzji-desktop-ipc.js';
import { GotzjiHostClient } from '../src/main/gotzji-host-client.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe('gotzji desktop governed boundary', () => {
  it('blocks all inherited work routes including hidden read, native goal, shell, tunnel, updater and bypass settings', () => {
    for (const channel of [
      ipcChannels.startProcess, ipcChannels.stopProcess, ipcChannels.startMcp, ipcChannels.restartMcp,
      ipcChannels.getGitDiff, ipcChannels.setGoalPonytailMode, ipcChannels.addWorkspace,
      ipcChannels.restoreCheckpoint, ipcChannels.startTunnel, ipcChannels.startRemoteMcp,
      ipcChannels.setUnrestrictedMode, ipcChannels.setUserSettings, ipcChannels.factoryReset,
      ipcChannels.installUpdate, ipcChannels.checkForUpdates, ipcChannels.runDoctor,
      ipcChannels.launchManagedBrowser, ipcChannels.openExternalSetupPage, 'hidden:raw-native-goal',
    ]) expect(() => assertGotzjiInheritedChannel(channel)).toThrow('GRACE_GOVERNED_OPERATION_REQUIRED');
    expect(() => assertGotzjiInheritedChannel(ipcChannels.getDashboard)).not.toThrow();
  });

  it('sends only selected project/job requests through the private authenticated host and projects no secrets', async () => {
    const calls: { authorization?: string; input: Record<string, unknown>; method: string }[] = [];
    const endpoint = await serve(async (request, response) => {
      let text = ''; for await (const chunk of request) text += String(chunk);
      const body = JSON.parse(text) as { method: string; input: Record<string, unknown> };
      calls.push({ ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }), ...body });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, value: body.method === 'health' ? { state: 'ready' } : { jobId: body.input.jobId, status: 'running' } }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'private-secret', ownerId: 'owner-one' }));
    const handlers = new Map<string, (event: { trusted: boolean }, payload?: unknown) => Promise<unknown>>();
    registerGotzjiIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, client, (event) => {
      if (!event.trusted) throw new Error('UNTRUSTED_RENDERER');
    });
    const invoke = handlers.get(gotzjiIpcChannels.request)!;
    await expect(invoke({ trusted: true }, { method: 'status', input: { jobId: 'job-one' } })).resolves.toEqual({ jobId: 'job-one', status: 'running' });
    const status = await handlers.get(gotzjiIpcChannels.hostStatus)!({ trusted: true });
    expect(JSON.stringify(status)).not.toContain('private-secret');
    expect(status).toMatchObject({ product: 'gotzji', ownerId: 'owner-one', state: 'ready', automaticUpdates: false });
    expect(calls[0]).toEqual({ authorization: 'Bearer private-secret', method: 'status', input: { jobId: 'job-one' } });
    await expect(invoke({ trusted: false }, { method: 'cancel', input: { jobId: 'job-one' } })).rejects.toThrow('UNTRUSTED_RENDERER');
    await expect(invoke({ trusted: true }, { method: 'cancel', input: {} })).rejects.toThrow('jobId');
    await expect(invoke({ trusted: true }, { method: 'cancel', input: { jobId: 'job-one', owner: 'other-owner' } })).rejects.toThrow('CALLER_AUTHORITY_DENIED');
    await expect(invoke({ trusted: true }, { method: 'native_goal_start', input: {} })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    await expect(invoke({ trusted: true }, { method: 'reprioritize', input: { jobId: 'job-one', priority: 9 } })).rejects.toThrow('priority');
    await expect(invoke({ trusted: true }, { method: 'inspectQueue', input: { owner: 'foreign-owner' } })).rejects.toThrow('CALLER_AUTHORITY_DENIED');
    await expect(invoke({ trusted: true }, { method: 'registerProject', input: { projectId: 'project', displayName: 'Project', rootPath: 'C:\\project', commands: [{ executable: 'C:\\Windows\\cmd.exe', args: ['/c', 'anything'] }] } })).rejects.toThrow('arguments');
    expect(calls).toHaveLength(2);
  });

  it('preserves control-only health and sends the selected build identity privately', async () => {
    let build: string | string[] | undefined;
    const endpoint = await serve(async (request, response) => {
      build = request.headers['x-gotzji-build'];
      response.end(JSON.stringify({ ok: true, value: { state: 'control-only', reason: 'HOST_BUILD_CHANGED' } }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'private-secret', ownerId: 'owner-one', buildIdentity: 'build-one' }));
    await expect(client.status()).resolves.toEqual({ product: 'gotzji', state: 'control-only', ownerId: 'owner-one', errorCode: 'HOST_BUILD_CHANGED', controller: 'grace', automaticUpdates: false });
    expect(build).toBe('build-one');
  });
  it('allows typed CAD entity handles while retaining the private authority-handle fence', async () => {
    const requests: unknown[] = [];
    const endpoint = await serve(async (request, response) => {
      let text = ''; for await (const chunk of request) text += String(chunk); requests.push(JSON.parse(text));
      response.end(JSON.stringify({ ok: true, value: { preparationId: 'prepared' } }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'secret', ownerId: 'owner' }));
    for (const operation of ['cad.entity.inspect', 'cad.entity.move']) await expect(client.request({ method: 'prepareOperation', input: { requestId: 'cad-one', projectId: 'project', operation, path: 'drawing.dwg', handle: 'A1' } })).resolves.toEqual({ preparationId: 'prepared' });
    await expect(client.request({ method: 'status', input: { jobId: 'job', handle: 'private-binding' } })).rejects.toThrow('CALLER_AUTHORITY_DENIED');
    await expect(client.request({ method: 'prepareOperation', input: { requestId: 'file-one', projectId: 'project', operation: 'file.read', handle: 'private-binding' } })).rejects.toThrow('CALLER_AUTHORITY_DENIED');
    await expect(client.request({ method: 'configureConnection', input: { tunnelId: 'tunnel_' + 'a'.repeat(32), runtimeKey: 'owner-entered-runtime-key', mcpUrl: 'http://caller/mcp' } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    expect(requests).toHaveLength(2);
  });

  it('maps control history/catalog methods and cannot redirect a private credential to another host', async () => {
    const methods: string[] = [];
    const endpoint = await serve(async (request, response) => {
      let text = ''; for await (const chunk of request) text += String(chunk);
      methods.push((JSON.parse(text) as { method: string }).method);
      response.end(JSON.stringify({ ok: true, value: [] }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'secret', ownerId: 'owner' }));
    await client.request({ method: 'listJobs', input: {} });
    await client.request({ method: 'listCatalog', input: {} });
    expect(methods).toEqual(['list', 'catalog']);
    const redirected = new GotzjiHostClient(async () => ({ endpoint: 'https://example.com', token: 'secret', ownerId: 'owner' }));
    await expect(redirected.request({ method: 'listJobs', input: {} })).rejects.toThrow('HOST_DESCRIPTOR_DENIED');
  });

  it('retains typed host denials and transport loss never issues cancellation or resubmission', async () => {
    const seen: string[] = [];
    const endpoint = await serve(async (request, response) => {
      let text = ''; for await (const chunk of request) text += String(chunk);
      seen.push((JSON.parse(text) as { method: string }).method);
      response.end(JSON.stringify({ ok: false, error: { code: 'PROJECT_NOT_REGISTERED', field: 'projectId', privateDetail: 'private-token' } }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'secret', ownerId: 'owner' }));
    await expect(client.request({ method: 'prepareOperation', input: { requestId: 'request-one', projectId: 'missing', operation: 'file.read' } })).rejects.toThrow('PROJECT_NOT_REGISTERED: projectId');
    const offline = new GotzjiHostClient(async () => ({ endpoint, token: 'secret', ownerId: 'owner' }), async () => { throw new Error('private-token'); });
    await expect(offline.request({ method: 'status', input: { jobId: 'job-one' } })).rejects.toThrow('HOST_CONNECTION_LOST');
    expect(seen).toEqual(['prepareOperation']);
  });
});

async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>): Promise<string> {
  const server = http.createServer((request, response) => { void handler(request, response); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Invalid test address');
  return `http://127.0.0.1:${address.port}/rpc`;
}
