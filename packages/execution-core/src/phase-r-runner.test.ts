import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { validationManager } from './phase-r-runner.mjs';

interface Fixture { root: string; child: ChildProcess; closed: Promise<void>; manager: ReturnType<typeof validationManager>; closeSeen: boolean }
const fixtures: Fixture[] = [];
async function fixture(validationMs = 600000): Promise<Fixture> {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'gotzji-validation-stop-'));
  const effectRoot = path.join(root, 'effects');
  await mkdir(effectRoot);
  const content = 'export function add(a,b){return a+b;}\n';
  await writeFile(path.join(effectRoot, 'result.txt'), content);
  const holder = { root, closeSeen: false } as Fixture;
  holder.manager = validationManager({ jobId: 'owned-stop-test', epoch: 'owned-stop-epoch', authorizationDigest: 'test', intentRevision: 0, effectRoot, grace: { expectedHash: createHash('sha256').update(content).digest('hex'), validationMs } }, root, {
    persist: () => undefined,
    finished: () => undefined,
    register: (_pid: number, child: ChildProcess) => {
      holder.child = child;
      holder.closed = new Promise<void>(resolve => child.once('close', () => { holder.closeSeen = true; resolve(); }));
    },
  });
  fixtures.push(holder);
  holder.manager.start();
  return holder;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    // The exact ChildProcess handle owns this fixture. Wait for its real close even when the tested stop is broken.
    if (!f.closeSeen && f.child.exitCode === null && f.child.signalCode === null) f.child.kill();
    await f.closed;
    if (path.dirname(f.root) !== await realpath(os.tmpdir()) || !path.basename(f.root).startsWith('gotzji-validation-stop-') || await realpath(f.root) !== f.root) throw new Error('Unexpected fixture root');
    await rm(f.root, { recursive: true, force: true });
  }
});

it('repeated stop settles after the owned validator exited by signal', async () => {
  const f = await fixture();
  await f.manager.stop();
  await f.closed;
  expect(f.child.exitCode).toBeNull();
  expect(f.child.signalCode).not.toBeNull();
  let settled = false;
  void f.manager.stop().then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(settled).toBe(true);
});

it('stop invoked between validator exit and close still waits for the owned close event', async () => {
  const f = await fixture();
  let duringExit: Promise<void> | undefined;
  f.child.once('exit', () => {
    duringExit = f.manager.stop().then(() => { expect(f.closeSeen).toBe(true); });
  });
  await f.manager.stop();
  await f.closed;
  expect(duringExit).toBeDefined();
  await duringExit;
});

it('stop after normal validator completion already settles without another close event', async () => {
  const f = await fixture(0);
  await f.closed;
  expect(f.child.exitCode).toBe(0);
  expect(f.child.signalCode).toBeNull();
  await f.manager.stop();
  expect(f.manager.status()).toMatchObject({ state: 'completed', exitCode: 0 });
});
