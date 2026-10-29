import http from 'node:http';
import { createHash } from 'node:crypto';
import { GIT_SNAPSHOT_BUDGET_MS, GIT_COMMAND_BUDGET_MS } from '../../../packages/execution-core/src/git-read-policy.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gotzjiIpcChannels, ipcChannels } from '@lnwjud/ipc-contracts';
import { assertGotzjiInheritedChannel } from '../src/main/gotzji-desktop-boundary.js';
import { registerGotzjiIpcHandlers } from '../src/main/gotzji-desktop-ipc.js';
import { GotzjiHostClient, parseGotzjiRequest } from '../src/main/gotzji-host-client.js';

const servers: http.Server[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe('gotzji desktop governed boundary', () => {
  it('accepts only an argument-free active-job read from the desktop', () => {
    expect(parseGotzjiRequest({ method: 'activeJobs', input: {} })).toEqual({ method: 'activeJobs', input: {} });
    expect(() => parseGotzjiRequest({ method: 'activeJobs', input: { ownerId: 'foreign' } })).toThrow('CALLER_AUTHORITY_DENIED');
    expect(() => parseGotzjiRequest({ method: 'activeJobs', input: { projectId: 'other' } })).toThrow('INVALID_GOTZJI_REQUEST');
  });
  it('accepts a native snapshot at the 16 MiB transport boundary', async () => {
    const jobId = 'a'.repeat(64); const bytes = Buffer.alloc(16 * 1024 * 1024, 0xa5);
    const expected = { jobId, filename: 'output.xlsx', sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
    const transport: typeof fetch = async () => new Response(JSON.stringify({ ok: true, value: expected }));
    const client = new GotzjiHostClient(async () => ({ endpoint: 'http://127.0.0.1:1/rpc', token: 'secret', ownerId: 'owner' }), transport);
    expect(await client.readNativeOutput(jobId)).toEqual(expected);
  });
  it('stops an oversized native output response before consuming the entire stream', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const transport: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller): void { if (sent++ < 32) controller.enqueue(chunk); else controller.close(); },
      cancel(): void { cancelled = true; },
    }));
    const client = new GotzjiHostClient(async () => ({ endpoint: 'http://127.0.0.1:1/rpc', token: 'secret', ownerId: 'owner' }), transport);
    await expect(client.readNativeOutput('a'.repeat(64))).rejects.toMatchObject({ code: 'HOST_RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(32);
  });
  it('saves a verified native snapshot at the 16 MiB IPC boundary', async () => {
    const jobId = 'a'.repeat(64); const bytes = Buffer.alloc(16 * 1024 * 1024, 0xa5);
    const client = new GotzjiHostClient(async () => null);
    vi.spyOn(client, 'readNativeOutput').mockResolvedValue({ jobId, filename: 'output.xlsx', sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') });
    const save = vi.fn().mockResolvedValue({ exported: true, cancelled: false });
    const handlers = new Map<string, (event: object, payload?: unknown) => Promise<unknown>>();
    registerGotzjiIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, client, () => {}, undefined, undefined, undefined, undefined, undefined, { save });
    await expect(handlers.get('gotzji:export-native-output')!({}, { jobId })).resolves.toEqual({ exported: true, cancelled: false });
    expect(save).toHaveBeenCalledTimes(1);
    const [savedJob, filename, saved] = save.mock.calls[0] as [string, string, Buffer];
    expect(savedJob).toBe(jobId);
    expect(filename).toBe('output.xlsx');
    expect(saved.length).toBe(bytes.length);
    expect(createHash('sha256').update(saved).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
  it('exports only the verified snapshot of one selected native job through a trusted save dialog', async () => {
    const jobId = 'a'.repeat(64); const bytes = Buffer.from([0, 255, 1, 128, 65]);
    const client = new GotzjiHostClient(async () => null);
    const read = vi.spyOn(client, 'readNativeOutput').mockResolvedValue({ jobId, filename: 'output.xlsx', sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') });
    const save = vi.fn().mockResolvedValueOnce({ exported: false, cancelled: true }).mockResolvedValueOnce({ exported: true, cancelled: false });
    const handlers = new Map<string, (event: { trusted: boolean }, payload?: unknown) => Promise<unknown>>();
    registerGotzjiIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, client,
      event => { if (!event.trusted) throw new Error('UNTRUSTED_RENDERER'); }, undefined, undefined, undefined, undefined, undefined, { save });
    const exportOutput = handlers.get('gotzji:export-native-output')!;
    await expect(exportOutput({ trusted: false }, { jobId })).rejects.toThrow('UNTRUSTED_RENDERER');
    await expect(exportOutput({ trusted: true }, { jobId, path: 'other.xlsx' })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    expect(read).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    await expect(exportOutput({ trusted: true }, { jobId })).resolves.toEqual({ exported: false, cancelled: true });
    await expect(exportOutput({ trusted: true }, { jobId })).resolves.toEqual({ exported: true, cancelled: false });
    expect(save).toHaveBeenCalledWith(jobId, 'output.xlsx', bytes);
    read.mockResolvedValueOnce({ jobId, filename: '../other.xlsx', sha256: '0'.repeat(64), base64: bytes.toString('base64') });
    await expect(exportOutput({ trusted: true }, { jobId })).rejects.toThrow('NATIVE_OUTPUT_INVALID');
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('chooses a local project directory only for a trusted no-input desktop request', async () => {
    const client = new GotzjiHostClient(async () => null);
    const handlers = new Map<string, (event: { trusted: boolean }, payload?: unknown) => Promise<unknown>>();
    const pick = vi.fn().mockResolvedValueOnce({ cancelled: true }).mockResolvedValueOnce({ cancelled: false, path: 'C:\\Owned Project' });
    registerGotzjiIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, client,
      event => { if (!event.trusted) throw new Error('UNTRUSTED_RENDERER'); }, undefined, undefined, undefined, { pick });
    const choose = handlers.get('gotzji:pick-project-folder')!;
    await expect(choose({ trusted: false })).rejects.toThrow('UNTRUSTED_RENDERER');
    await expect(choose({ trusted: true }, { path: 'C:\\other', properties: ['openFile'] })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    expect(pick).not.toHaveBeenCalled();
    await expect(choose({ trusted: true })).resolves.toEqual({ cancelled: true });
    await expect(choose({ trusted: true })).resolves.toEqual({ cancelled: false, path: 'C:\\Owned Project' });
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it('accepts only explicit project archive state and keeps management inputs free of caller authority', () => {
    expect(parseGotzjiRequest({ method: 'listManagedProjects', input: {} })).toEqual({ method: 'listManagedProjects', input: {} });
    for (const archived of [true, false]) {
      const input = { projectId: 'owned-project', archived };
      expect(parseGotzjiRequest({ method: 'setProjectArchived', input })).toEqual({ method: 'setProjectArchived', input });
      expect(() => parseGotzjiRequest({ method: 'setProjectArchived', input: { ...input, ownerId: 'other' } })).toThrow('CALLER_AUTHORITY_DENIED');
    }
    for (const input of [{ projectId: 'owned-project' }, { projectId: 'owned-project', archived: 'true' }, { archived: true }, { projectId: 'owned-project', archived: true, deleteFiles: true }]) {
      expect(() => parseGotzjiRequest({ method: 'setProjectArchived', input })).toThrow('INVALID_GOTZJI_REQUEST');
    }
    expect(() => parseGotzjiRequest({ method: 'listManagedProjects', input: { projectId: 'owned-project' } })).toThrow('INVALID_GOTZJI_REQUEST');
  });
  it('lets synchronous resume enclose cold worker startup and still aborts only that control call at sixty seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds: number): AbortSignal => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new Error('deadline')), milliseconds); return controller.signal;
    });
    const calls: unknown[] = [];
    const transport: typeof fetch = async (_url, options): Promise<Response> => new Promise((resolve, reject) => {
      const request = JSON.parse(String(options?.body)) as { method: string; input: { jobId: string } }; calls.push(request);
      const responseTimer = request.input.jobId === 'stalled' ? undefined : setTimeout(() => resolve(new Response(JSON.stringify({ ok: true, value: { jobId: request.input.jobId, state: 'running' } }))), 40_000);
      options?.signal?.addEventListener('abort', () => { clearTimeout(responseTimer); reject(options.signal?.reason); }, { once: true });
    });
    const client = new GotzjiHostClient(async () => ({ endpoint: 'http://127.0.0.1:1/rpc', token: 'secret', ownerId: 'owner' }), transport);
    const requests = Promise.allSettled([client.request({ method: 'resume', input: { jobId: 'same-job' } }), client.request({ method: 'status', input: { jobId: 'same-job' } })]);
    await vi.advanceTimersByTimeAsync(40_000);
    const [resume, ordinary] = await requests;
    expect(resume).toEqual({ status: 'fulfilled', value: { jobId: 'same-job', state: 'running' } });
    expect(ordinary).toMatchObject({ status: 'rejected', reason: { code: 'HOST_CONNECTION_LOST' } });
    let settled = false;
    const stalled = client.request({ method: 'resume', input: { jobId: 'stalled' } }).then(() => 'unexpected', (error: unknown) => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(59_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await stalled).toMatchObject({ code: 'HOST_CONNECTION_LOST' });
    expect(calls).toEqual([{ method: 'resume', input: { jobId: 'same-job' } }, { method: 'status', input: { jobId: 'same-job' } }, { method: 'resume', input: { jobId: 'stalled' } }]);
  });
  it('encloses bounded Git completion without delaying ordinary controls or retrying a stalled read', async () => {
    vi.useFakeTimers(); const timeouts: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds: number): AbortSignal => {
      timeouts.push(milliseconds); const controller = new AbortController(); setTimeout(() => controller.abort(new Error('deadline')), milliseconds); return controller.signal;
    });
    const calls: string[] = [];
    const transport: typeof fetch = async (_url, options): Promise<Response> => new Promise((resolve, reject) => {
      const request = JSON.parse(String(options?.body)) as { method: string; input: { projectId?: string; jobId?: string } }; calls.push(request.method);
      const value = request.method === 'stopBrowserSession' ? { state: 'stopped', projectId: request.input.projectId } : request.method === 'status' ? { status: 'running' } : { view: 'status', entries: [], truncated: false };
      const delay = request.input.jobId === 'fast' ? 1 : request.method === 'readProjectGit' ? 85_000 : 12_000;
      const responseTimer = request.input.projectId === 'stalled' ? undefined : setTimeout(() => resolve(new Response(JSON.stringify({ ok: true, value }))), delay);
      options?.signal?.addEventListener('abort', () => { clearTimeout(responseTimer); reject(options.signal?.reason); }, { once: true });
    });
    const client = new GotzjiHostClient(async () => ({ endpoint: 'http://127.0.0.1:1/rpc', token: 'secret', ownerId: 'owner' }), transport);
    let gitSettled = false;
    const slowGit = client.request({ method: 'readProjectGit', input: { projectId: 'repo', view: 'status' } }).finally(() => { gitSettled = true; });
    const fastStatus = client.request({ method: 'status', input: { jobId: 'fast' } });
    const requests = Promise.allSettled([slowGit, client.request({ method: 'status', input: { jobId: 'slow' } }), client.request({ method: 'stopBrowserSession', input: { projectId: 'repo' } })]);
    await vi.advanceTimersByTimeAsync(1); expect(await fastStatus).toEqual({ status: 'running' }); expect(gitSettled).toBe(false);
    expect(timeouts).toEqual([90_000, 10_000, 10_000, 60_000]);
    expect(timeouts[0]).toBeGreaterThan(GIT_SNAPSHOT_BUDGET_MS + GIT_COMMAND_BUDGET_MS + 10_000);
    await vi.advanceTimersByTimeAsync(84_999);
    const [git, control, browserStop] = await requests;
    expect(git).toEqual({ status: 'fulfilled', value: { view: 'status', entries: [], truncated: false } });
    expect(control).toMatchObject({ status: 'rejected', reason: { code: 'HOST_CONNECTION_LOST' } });
    expect(browserStop).toEqual({ status: 'fulfilled', value: { state: 'stopped', projectId: 'repo' } });
    let settled = false; let browserSettled = false;
    const stalled = client.request({ method: 'readProjectGit', input: { projectId: 'stalled', view: 'status' } }).then(() => 'unexpected-success', (error: unknown) => error).finally(() => { settled = true; });
    const stalledStop = client.request({ method: 'stopBrowserSession', input: { projectId: 'stalled' } }).then(() => 'unexpected-success', (error: unknown) => error).finally(() => { browserSettled = true; });
    await vi.advanceTimersByTimeAsync(59_999); expect(settled).toBe(false); expect(browserSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await stalledStop).toMatchObject({ code: 'HOST_CONNECTION_LOST' }); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await stalled).toMatchObject({ code: 'HOST_CONNECTION_LOST' });
    expect(calls).toEqual(['readProjectGit', 'status', 'status', 'stopBrowserSession', 'readProjectGit', 'stopBrowserSession']);
  });
  it('accepts only typed project Git views and denies raw arguments or caller identity', () => {
    const input = { projectId: 'selected-project', view: 'diff', path: 'note.txt', staged: true };
    expect(parseGotzjiRequest({ method: 'readProjectGit', input })).toEqual({ method: 'readProjectGit', input });
    for (const extra of [{ args: ['push'] }, { view: 'push' }, { staged: 'yes' }]) expect(() => parseGotzjiRequest({ method: 'readProjectGit', input: { ...input, ...extra } })).toThrow('INVALID_GOTZJI_REQUEST');
    expect(() => parseGotzjiRequest({ method: 'readProjectGit', input: { ...input, ownerId: 'spoofed' } })).toThrow('CALLER_AUTHORITY_DENIED');
  });
  it('allows project-scoped read tools through the product boundary without renderer authority', () => {
    for (const method of ['readProjectFile', 'listProjectFiles', 'searchProjectFiles']) {
      const input = { projectId: 'selected-project', path: 'notes.txt', ...(method === 'searchProjectFiles' ? { query: 'needle' } : {}) };
      expect(parseGotzjiRequest({ method, input })).toEqual({ method, input });
      expect(() => parseGotzjiRequest({ method, input: { ...input, ownerId: 'spoofed' } })).toThrow('CALLER_AUTHORITY_DENIED');
      expect(() => parseGotzjiRequest({ method, input: { ...input, shell: 'other-command' } })).toThrow('INVALID_GOTZJI_REQUEST');
      expect(() => parseGotzjiRequest({ method, input: { path: 'notes.txt' } })).toThrow('projectId');
    }
  });

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
      response.end(JSON.stringify({ ok: true, value: body.method === 'health' ? { state: 'ready', controller: 'chatgpt-plugin' } : { jobId: body.input.jobId, status: 'running' } }));
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
    expect(status).toMatchObject({ product: 'gotzji', ownerId: 'owner-one', state: 'ready', controller: 'chatgpt-plugin', automaticUpdates: false });
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

  it('refuses to label an old Claude-controlled host as the ChatGPT plugin controller', async () => {
    const endpoint = await serve(async (_request, response) => {
      response.end(JSON.stringify({ ok: true, value: { state: 'ready', controller: 'grace' } }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'private-secret', ownerId: 'owner-one' }));
    await expect(client.status()).resolves.toMatchObject({ state: 'unavailable', errorCode: 'HOST_CONTROLLER_MISMATCH' });
  });

  it('exports the owner support report through main into a file the owner chooses (incident I8)', async () => {
    const calls: { method: string; input: Record<string, unknown> }[] = [];
    const endpoint = await serve(async (request, response) => {
      let text = ''; for await (const chunk of request) text += String(chunk);
      calls.push(JSON.parse(text) as { method: string; input: Record<string, unknown> });
      response.end(JSON.stringify({ ok: true, value: { schemaVersion: 1, jobs: [] } }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'secret', ownerId: 'owner' }));
    const handlers = new Map<string, (event: { trusted: boolean }, payload?: unknown) => Promise<unknown>>(); const saved: string[] = [];
    registerGotzjiIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, client, (event) => { if (!event.trusted) throw new Error('UNTRUSTED_RENDERER'); },
      undefined, undefined, { save: async (content) => { saved.push(content); return { exported: true, cancelled: false }; } });
    const exportReport = handlers.get(gotzjiIpcChannels.exportSupportReport)!;
    await expect(exportReport({ trusted: true })).resolves.toEqual({ exported: true, cancelled: false });
    expect(JSON.parse(saved[0]!)).toEqual({ schemaVersion: 1, jobs: [] });
    await expect(exportReport({ trusted: false })).rejects.toThrow('UNTRUSTED_RENDERER');
    await expect(exportReport({ trusted: true }, { jobId: 'job' })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    await expect(handlers.get(gotzjiIpcChannels.request)!({ trusted: true }, { method: 'supportReport', input: { projectId: 'project' } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    expect(calls).toEqual([{ method: 'supportReport', input: {} }]);
  });

  it('exports only bounded canonical logs for the exact job through a trusted owner-selected save', async () => {
    const calls: { method: string; input: Record<string, unknown> }[] = []; let mode: 'normal' | 'expired' | 'oversized' | 'full' = 'normal';
    const endpoint = await serve(async (request, response) => {
      let text = ''; for await (const chunk of request) text += String(chunk);
      const call = JSON.parse(text) as { method: string; input: Record<string, unknown> }; calls.push(call);
      const cursor = Number(call.input.cursor);
      response.end(JSON.stringify({ ok: true, value: mode === 'expired' ? { text: '', nextCursor: cursor, expired: true }
        : mode === 'oversized' ? { text: 'x'.repeat(8193), nextCursor: cursor + 8193 }
          : mode === 'full' ? { text: 'x'.repeat(8192), nextCursor: cursor + 8192 }
            : { text: cursor === 0 ? 'retained first page\n' : '', nextCursor: cursor === 0 ? 20 : cursor } }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'secret', ownerId: 'owner' }));
    const handlers = new Map<string, (event: { trusted: boolean }, payload?: unknown) => Promise<unknown>>(); const saved: { jobId: string; content: string }[] = [];
    registerGotzjiIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, client, event => { if (!event.trusted) throw new Error('UNTRUSTED_RENDERER'); },
      undefined, undefined, undefined, undefined, { save: async (jobId, content) => { saved.push({ jobId, content }); return { exported: true, cancelled: false }; } });
    const exportLogs = handlers.get(gotzjiIpcChannels.exportJobLogs)!; const jobId = 'a'.repeat(64);
    await expect(exportLogs({ trusted: true }, { jobId })).resolves.toEqual({ exported: true, cancelled: false });
    expect(saved).toEqual([{ jobId, content: 'retained first page\n' }]);
    expect(calls).toEqual([{ method: 'logs', input: { jobId, cursor: 0, limit: 8192 } }, { method: 'logs', input: { jobId, cursor: 20, limit: 8192 } }]);
    await expect(exportLogs({ trusted: false }, { jobId })).rejects.toThrow('UNTRUSTED_RENDERER');
    for (const payload of [null, {}, { jobId: '../foreign' }, { jobId, path: 'outside.txt' }, { jobId, text: 'renderer substitute' }, { jobId, cursor: 0 }]) await expect(exportLogs({ trusted: true }, payload)).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    expect(calls).toHaveLength(2); mode = 'expired';
    await expect(exportLogs({ trusted: true }, { jobId })).rejects.toThrow('RESULT_EXPIRED');
    expect(saved).toHaveLength(1);
    mode = 'oversized';
    await expect(exportLogs({ trusted: true }, { jobId })).rejects.toThrow('LOG_RESPONSE_INVALID');
    expect(saved).toHaveLength(1);
    calls.length = 0; mode = 'full';
    await expect(exportLogs({ trusted: true }, { jobId })).resolves.toEqual({ exported: true, cancelled: false });
    expect(calls).toHaveLength(8); expect(saved[1]).toEqual({ jobId, content: 'x'.repeat(65536) });
    expect(calls.every(call => call.method === 'logs' && call.input.jobId === jobId)).toBe(true);
  });

  it('preserves control-only health and sends the selected build identity privately', async () => {
    let build: string | string[] | undefined;
    const endpoint = await serve(async (request, response) => {
      build = request.headers['x-gotzji-build'];
      response.end(JSON.stringify({ ok: true, value: { state: 'control-only', controller: 'chatgpt-plugin', reason: 'HOST_BUILD_CHANGED' } }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'private-secret', ownerId: 'owner-one', buildIdentity: 'build-one' }));
    await expect(client.status()).resolves.toEqual({ product: 'gotzji', state: 'control-only', ownerId: 'owner-one', errorCode: 'HOST_BUILD_CHANGED', controller: 'chatgpt-plugin', automaticUpdates: false });
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

  it('sends an owner settlement only for the selected job with one of the two named decisions', async () => {
    const requests: unknown[] = [];
    const endpoint = await serve(async (request, response) => {
      let text = ''; for await (const chunk of request) text += String(chunk); requests.push(JSON.parse(text));
      response.end(JSON.stringify({ ok: true, value: { status: 'cancelled' } }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'secret', ownerId: 'owner' }));
    await expect(client.request({ method: 'settleJob', input: { jobId: 'job', decision: 'effect-present' } })).resolves.toEqual({ status: 'cancelled' });
    await expect(client.request({ method: 'settleJob', input: { jobId: 'job', decision: 'released' } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    await expect(client.request({ method: 'settleJob', input: { jobId: 'job', decision: 'no-effect', projectId: 'other' } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    await expect(client.request({ method: 'settleJob', input: { decision: 'no-effect' } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    expect(requests).toEqual([{ method: 'settleJob', input: { jobId: 'job', decision: 'effect-present' } }]);
  });

  it('sends an owner recipe approval and project binding only with their known fields', async () => {
    const requests: unknown[] = [];
    const endpoint = await serve(async (request, response) => {
      let text = ''; for await (const chunk of request) text += String(chunk); requests.push(JSON.parse(text));
      response.end(JSON.stringify({ ok: true, value: { accepted: true } }));
    });
    const client = new GotzjiHostClient(async () => ({ endpoint, token: 'secret', ownerId: 'owner' }));
    const recipe = { recipeId: 'phase-tests', displayName: 'Phase 2 checks', executable: 'C:/Python/python.exe', args: ['-I', '${projectRoot}/validation/test_phase2.py'], dependencies: ['${projectRoot}/validation/test_phase2.py'], timeoutMs: 600000, writeScope: 'project', delivery: true };
    await expect(client.request({ method: 'registerRecipe', input: recipe })).resolves.toEqual({ accepted: true });
    await expect(client.request({ method: 'registerRecipe', input: { ...recipe, shell: true } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    await expect(client.request({ method: 'registerRecipe', input: { ...recipe, writeScope: 'workspace' } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    await expect(client.request({ method: 'registerRecipe', input: { ...recipe, delivery: false } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    await expect(client.request({ method: 'registerRecipe', input: { ...recipe, args: [1] } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    await expect(client.request({ method: 'registerRecipe', input: { ...recipe, executable: '' } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    await expect(client.request({ method: 'bindProjectRecipe', input: { projectId: 'project', recipeId: 'phase-tests' } })).resolves.toEqual({ accepted: true });
    await expect(client.request({ method: 'bindProjectRecipe', input: { projectId: 'project', recipeId: 'phase-tests', args: ['-c'] } })).rejects.toThrow('INVALID_GOTZJI_REQUEST');
    expect(requests).toEqual([{ method: 'registerRecipe', input: recipe }, { method: 'bindProjectRecipe', input: { projectId: 'project', recipeId: 'phase-tests' } }]);
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
