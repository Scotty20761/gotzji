import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processIdentities, sameProcessIdentity, type ProcessIdentity } from './process-identity.mjs';
import { GotzjiConnectionService, type ProductConnectionOptions } from './product-connection.js';

// Incident 2026-10-29: a tunnel client started by a host that has since exited kept forwarding to
// that host's dead bridge, and every later host reported CONNECTION_PREDECESSOR_ACTIVE forever.
// Real Windows processes stand in for the client: a compiled executable that sleeps until killed.
const exec = promisify(execFile);
const protector = { protect: async (value: string): Promise<string> => value, unprotect: async (value: string): Promise<string> => value };
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
type Recorded = { readonly pid: number; readonly identity: ProcessIdentity };
let root = ''; let client = ''; let foreignClient = '';
const spawned: ChildProcess[] = [];

beforeAll(async () => {
  if (process.platform !== 'win32') return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gotzji-reclaim-')));
  const source = path.join(root, 'fake-tunnel-client.cs');
  writeFileSync(source, 'class FakeTunnelClient { static void Main() { System.Threading.Thread.Sleep(-1); } }\n');
  client = path.join(root, 'fake-tunnel-client.exe');
  const csc = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await exec(csc, ['/nologo', '/target:exe', `/out:${client}`, source], { windowsHide: true, timeout: 60_000 });
  // The same bytes at another path stand in for lnwjud's own tunnel client.
  foreignClient = path.join(root, 'lnwjud-tunnel-client.exe');
  copyFileSync(client, foreignClient);
}, 90_000);

afterAll(async () => {
  for (const child of spawned) if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([once(child, 'exit'), sleep(2000)]); }
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function live(executable: string): Promise<Recorded> {
  const child = spawn(executable, [], { windowsHide: true, stdio: 'ignore' }); spawned.push(child);
  if (!child.pid) throw new Error('fixture process did not spawn');
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = (await processIdentities([child.pid]))[child.pid];
    if (value && value !== 'unknown') return { pid: child.pid, identity: value };
    await sleep(100);
  }
  throw new Error('fixture process identity was not observed');
}
async function exited(): Promise<Recorded> {
  const host = await live(client); const child = spawned.at(-1)!;
  child.kill(); await once(child, 'exit');
  return host;
}
const alive = async (recorded: Recorded): Promise<boolean> => sameProcessIdentity(recorded.identity, (await processIdentities([recorded.pid]))[recorded.pid]);
async function currentHost(): Promise<Recorded> { return { pid: process.pid, identity: (await processIdentities([process.pid]))[process.pid] as ProcessIdentity }; }

async function connection(record: { predecessor: Recorded; creator?: Recorded; executableSha256?: string }, extra: Partial<ProductConnectionOptions> = {}): Promise<{ directory: string; service: GotzjiConnectionService }> {
  const directory = mkdtempSync(path.join(root, 'runtime-'));
  const options: ProductConnectionOptions = { directory, ownerId: 'owner', executable: client, executableSha256: sha256(client), mcpTarget: (): string => `http://127.0.0.1:1/mcp/${'a'.repeat(64)}`, protector };
  await new GotzjiConnectionService(options).configure({ tunnelId: `tunnel_${'a'.repeat(32)}`, runtimeKey: 'sk-reclaim-fixture-runtime-key' });
  const file = path.join(directory, 'product-tunnel.sealed.json');
  const sealed = JSON.parse((JSON.parse(readFileSync(file, 'utf8')) as { payload: string }).payload) as Record<string, unknown>;
  sealed.desiredActive = true;
  sealed.process = { pid: record.predecessor.pid, identity: record.predecessor.identity, executableSha256: record.executableSha256 ?? options.executableSha256, ...(record.creator ? { spawnedBy: record.creator } : {}) };
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, payload: JSON.stringify(sealed) }));
  return { directory, service: new GotzjiConnectionService({ ...options, ...extra }) };
}
const incident = (directory: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(directory, 'gotzji-tunnel', 'predecessor-reclaim.json'), 'utf8')) as Record<string, unknown>;
const recordedPid = (directory: string): number | undefined => (JSON.parse((JSON.parse(readFileSync(path.join(directory, 'product-tunnel.sealed.json'), 'utf8')) as { payload: string }).payload) as { process?: { pid: number } }).process?.pid;

describe.runIf(process.platform === 'win32')('proof-gated predecessor tunnel reclaim', () => {
  it('reclaims a tunnel whose creating host has exited, records why, and connects in its place', async () => {
    const predecessor = await live(client); const creator = await exited();
    const { directory, service } = await connection({ predecessor, creator }, { host: await currentHost() });
    writeFileSync(path.join(directory, 'product-host-exit.json'), JSON.stringify({ schemaVersion: 1, pid: creator.pid, birth: creator.identity.birth, exitCode: 0, recordedAt: '2026-10-29T15:00:00.000Z' }));
    expect(await service.status()).toMatchObject({ state: 'reconciliation-required', errorCode: 'CONNECTION_PREDECESSOR_ACTIVE' });
    try {
      await service.restore();
      expect(await alive(predecessor)).toBe(false);
      expect(await service.status()).toMatchObject({ state: 'connecting' });
      expect(recordedPid(directory)).not.toBe(predecessor.pid);
      // The incident's -32603 came from a client forwarding to a dead bridge; the successor's bridge answers.
      const profile = JSON.parse(readFileSync(path.join(directory, 'gotzji-tunnel', 'gotzji.json'), 'utf8')) as { mcp: { server_urls: { url: string }[] } };
      expect((await fetch(profile.mcp.server_urls[0]!.url, { method: 'POST', body: '{}' })).status).toBe(403);
      expect(incident(directory)).toMatchObject({ outcome: 'reclaimed', predecessor: { pid: predecessor.pid }, creator: { pid: creator.pid }, creatorExit: { exitCode: 0 } });
    } finally { await service.stop(); }
  }, 60_000);

  it.each([
    ['ownership-unproven', 'the host has not proven machine ownership'],
    ['creator-unknown', 'the record predates creator tracking'],
    ['creator-alive', 'the creating host is still running'],
    ['executable-mismatch', 'the recorded client fingerprint differs'],
    ['executable-mismatch', 'the process is lnwjud\'s own tunnel client'],
  ] as const)('touches nothing when %s (%s)', async (reason, situation) => {
    const foreign = situation.includes('lnwjud');
    const predecessor = await live(foreign ? foreignClient : client);
    const creator = situation.includes('predates') ? undefined : situation.includes('still running') ? await live(client) : await exited();
    const { directory, service } = await connection({ predecessor, ...(creator ? { creator } : {}), ...(situation.includes('fingerprint') ? { executableSha256: 'b'.repeat(64) } : {}) },
      situation.includes('ownership') ? {} : { host: await currentHost() });
    await service.restore();
    expect(await alive(predecessor)).toBe(true);
    expect(recordedPid(directory)).toBe(predecessor.pid);
    expect(await service.status()).toMatchObject({ state: 'reconciliation-required', errorCode: 'CONNECTION_PREDECESSOR_ACTIVE' });
    expect(incident(directory)).toMatchObject({ outcome: 'refused', reason, predecessor: { pid: predecessor.pid } });
  }, 60_000);

  it('never starts a successor when the predecessor\'s termination cannot be proven', async () => {
    const predecessor = await live(client); const creator = await exited();
    // The reader keeps reporting the killed predecessor, so its end is never observed.
    const stale = async (pids: readonly number[]): Promise<Record<number, ProcessIdentity | null | 'unknown'>> => {
      const values = await processIdentities([...pids]);
      return Object.fromEntries(pids.map((pid) => [pid, pid === predecessor.pid ? predecessor.identity : values[pid]!]));
    };
    const { directory, service } = await connection({ predecessor, creator }, { host: await currentHost(), identityReader: stale });
    await service.restore();
    expect(recordedPid(directory)).toBe(predecessor.pid);
    // The signal was sent, so the record does not claim that nothing was touched.
    expect(incident(directory)).toMatchObject({ outcome: 'kill-unverified', reason: 'termination-unverified' });
  }, 60_000);

  it('touches nothing when the creating host cannot be observed or is this host itself', async () => {
    for (const [reason, unobservable] of [['creator-unproven', true], ['creator-alive', false]] as const) {
      const predecessor = await live(client); const host = await currentHost();
      const creator = unobservable ? await exited() : host;
      const reader = async (pids: readonly number[]): Promise<Record<number, ProcessIdentity | null | 'unknown'>> => {
        const values = await processIdentities([...pids]);
        return Object.fromEntries(pids.map((pid) => [pid, unobservable && pid === creator.pid ? 'unknown' : values[pid]!]));
      };
      const { directory, service } = await connection({ predecessor, creator }, { host, identityReader: reader });
      await service.restore();
      expect(await alive(predecessor)).toBe(true);
      expect(incident(directory)).toMatchObject({ outcome: 'refused', reason });
    }
  }, 60_000);

  it('lets the owner recover a legacy record in one action, with identity proof', async () => {
    const predecessor = await live(client);
    const { directory, service } = await connection({ predecessor }, { host: await currentHost() });
    await service.restore();
    expect(await alive(predecessor)).toBe(true);
    try {
      expect(await service.recover()).toMatchObject({ state: 'connecting' });
      expect(await alive(predecessor)).toBe(false);
      expect(recordedPid(directory)).not.toBe(predecessor.pid);
    } finally { await service.stop(); }
  }, 60_000);

  it('refuses one-action recovery of lnwjud\'s tunnel client', async () => {
    const predecessor = await live(foreignClient);
    const { service } = await connection({ predecessor }, { host: await currentHost() });
    await expect(service.recover()).rejects.toThrow('CONNECTION_PROCESS_OWNER_DENIED');
    expect(await alive(predecessor)).toBe(true);
  }, 60_000);
});
