import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductBrowserService } from './product-browser-service.js';
import type { ExecutionCore } from './core.js';
import type { TrustedProductBrowserEnrollment } from './product-browser.js';
import type { RegisteredProject } from './types.js';

const broker = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn(async () => true) }));
vi.mock('./product-browser-broker.mjs', () => ({ createTrustedProductBrowserEnrollment: broker.create, verifyOwnedProductBrowserSession: broker.verify }));
const roots: string[] = [];
async function fixture(): Promise<{ service: ProductBrowserService; stop: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; protect: ReturnType<typeof vi.fn>; stored: () => Promise<unknown>; order: string[] }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gotzji-browser-service-')); roots.push(directory);
  const order: string[] = [];
  const stop = vi.fn(async () => { order.push('stop'); return { stopped: true as const, pid: 101 }; });
  const clear = vi.fn(() => { order.push('clear'); });
  const publicBinding = { sessionId: 'session', tabId: 'tab', expectedUrl: 'https://example.com/', expectedDocumentId: 'document', allowedOrigins: ['https://example.com'] };
  const options = { session: { schemaVersion: 1 as const, sessionId: 'session', owner: 'owner', projectId: 'project', pid: 101, pidBirth: 'birth', executable: 'fixture-chrome', executableSha256: 'hash', profilePath: directory, port: 1234, cdpBrowserContextId: 'context', binding: { browserId: 'browser', contextId: 'context', profileId: 'profile', tabId: 'tab', providerTabId: 'tab', url: 'https://example.com/', documentId: 'document' }, allowedOrigins: ['https://example.com'], fixtureMode: false }, manifestPath: path.join(directory, 'manifest'), manifestSha256: 'hash', prerequisites: [{ path: 'fixture', hash: 'hash' }], verifyOwnedSession: async (): Promise<boolean> => true };
  const enrollment: TrustedProductBrowserEnrollment = { options, publicBinding, stop, refresh: async () => ({ options, publicBinding }) };
  broker.create.mockResolvedValue(enrollment);
  // The service uses only these four Core methods; this test isolates sequencing, not native browser ownership.
  const project: RegisteredProject = { projectId: 'project', owner: 'owner', displayName: 'Fixture', rootPath: directory, resourceKey: 'fixture-project', recipeIds: [] };
  const core: Pick<ExecutionCore, 'listProjects' | 'enrollBrowserSession' | 'list' | 'clearBrowserSession'> = { listProjects: () => [project], enrollBrowserSession: async () => undefined, list: async () => [], clearBrowserSession: clear };
  const protect = vi.fn(async (value: string): Promise<string> => value);
  const service = new ProductBrowserService({ directory, ownerId: 'owner', credential: 'credential', executable: 'fixture', executableSha256: 'hash', prerequisite: { path: 'fixture', hash: 'hash' }, core: core as ExecutionCore, protector: { protect, unprotect: async (value: string): Promise<string> => value } });
  await service.start({ projectId: 'project', startUrl: 'https://example.com/' });
  const stored = async (): Promise<unknown> => JSON.parse(JSON.parse(await readFile(path.join(directory, 'product-browser.sealed.json'), 'utf8')).payload);
  return { service, stop, clear, protect, stored, order };
}
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('browser service termination authority', () => {
  it('keeps enrollment and sealed state when stop fails, then retries that same session', async () => {
    const f = await fixture(); const before = await f.stored();
    f.stop.mockRejectedValueOnce(Object.assign(new Error('unverified'), { code: 'BROWSER_TERMINATION_UNVERIFIED' }));
    await expect(f.service.stop('project')).rejects.toMatchObject({ code: 'BROWSER_TERMINATION_UNVERIFIED' });
    expect(f.clear).not.toHaveBeenCalled();
    expect(f.service.projection()).toMatchObject({ state: 'stopping', sessionId: 'session' });
    expect(await f.service.start({ projectId: 'project', startUrl: 'https://example.com/' })).toMatchObject({ state: 'stopping', sessionId: 'session' });
    expect(await f.service.inspect('project')).toMatchObject({ state: 'stopping', sessionId: 'session' });
    expect(broker.verify).not.toHaveBeenCalled();
    expect(await f.stored()).toEqual(before);
    expect(await f.service.stop('project')).toEqual({ state: 'stopped', projectId: 'project' });
    expect(f.stop).toHaveBeenCalledTimes(2);
    expect(f.clear).toHaveBeenCalledExactlyOnceWith('credential', 'session');
    expect(f.order).toEqual(['stop', 'clear']);
    expect(f.service.projection()).toEqual({ state: 'not-enrolled' });
    expect(await f.stored()).toEqual({ schemaVersion: 1, ownerId: 'owner', stopped: true });
    expect(broker.create).toHaveBeenCalledTimes(1);
  });
  it('retains state if new work prevents clear after the browser has stopped', async () => {
    const f = await fixture(); const before = await f.stored();
    f.clear.mockImplementationOnce(() => { f.order.push('clear'); throw Object.assign(new Error('busy'), { code: 'BROWSER_SESSION_IN_USE' }); });
    f.stop.mockResolvedValueOnce({ stopped: true, pid: 101 }).mockRejectedValueOnce(new Error('Cannot stop an exited browser twice'));
    await expect(f.service.stop('project')).rejects.toMatchObject({ code: 'BROWSER_SESSION_IN_USE' });
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(['clear']);
    expect(await f.stored()).toEqual(before);
    expect(f.service.projection()).toMatchObject({ state: 'stopping', sessionId: 'session' });
    expect(await f.service.stop('project')).toMatchObject({ state: 'stopped' });
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.clear).toHaveBeenLastCalledWith('credential', 'session');
    expect(broker.create).toHaveBeenCalledTimes(1);
  });
  it('retries terminal persistence without repeating proven stop or catalog clear', async () => {
    const f = await fixture(); const before = await f.stored();
    f.protect.mockRejectedValueOnce(new Error('protected write unavailable'));
    f.stop.mockResolvedValueOnce({ stopped: true, pid: 101 }).mockRejectedValueOnce(new Error('Cannot stop twice'));
    await expect(f.service.stop('project')).rejects.toThrow('protected write unavailable');
    expect(f.service.projection()).toMatchObject({ state: 'stopping', sessionId: 'session' });
    expect(await f.stored()).toEqual(before);
    expect(await f.service.stop('project')).toMatchObject({ state: 'stopped' });
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.clear).toHaveBeenCalledTimes(1);
    expect(await f.stored()).toEqual({ schemaVersion: 1, ownerId: 'owner', stopped: true });
  });
});
