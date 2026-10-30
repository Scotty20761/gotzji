import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileActor } from '@lnwjud/application';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }));

import { UpgradeRuntimeService } from './upgrade-runtime.js';

const actor: FileActor = { clientId: 'diagnostic-test', clientName: 'diagnostic-test' };
afterEach(() => { vi.unstubAllEnvs(); spawn.mockReset(); });

describe('diagnostic child environment', () => {
  it('removes credential-like variables when a service query starts a child process', async () => {
    vi.stubEnv('GOTZJI_TEST_API_KEY', 'fixture-secret');
    vi.stubEnv('GOTZJI_TEST_PASSWORD', 'fixture-secret');
    vi.stubEnv('GOTZJI_TEST_ORDINARY', 'retained');
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    const runtime = new UpgradeRuntimeService({ platform: 'linux' }, actor);
    await expect(runtime.execute('service_context', { service: 'fixture.service' })).resolves.toMatchObject({ ok: true, value: { executed: true } });
    expect(spawn).toHaveBeenCalledOnce();
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe('systemctl');
    expect(args).toEqual(['--user', 'status', 'fixture.service', '--no-pager', '--plain']);
    expect(options.env.GOTZJI_TEST_ORDINARY).toBe('retained');
    expect(options.env.GOTZJI_TEST_API_KEY).toBeUndefined();
    expect(options.env.GOTZJI_TEST_PASSWORD).toBeUndefined();
  });
});
