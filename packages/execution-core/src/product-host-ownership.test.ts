import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { processIdentities, type ProcessIdentity } from './process-identity.mjs';
import { acquireProductHostOwnership } from './product-host-ownership.mjs';
import { canonicalTemporaryDirectorySync } from './test-fixtures.js';

const directories: string[] = [];
const secret = 'a'.repeat(64);
const current = (suffix: string): ProcessIdentity => ({ birth: `birth-${suffix}`, executable: path.resolve(`node-${suffix}.exe`) });
const reader = (identity: ProcessIdentity | null | 'unknown') => async (pids: readonly number[]): Promise<Record<number, ProcessIdentity | null | 'unknown'>> => Object.fromEntries(pids.map((pid) => [pid, identity]));
function directory(): string { const value = canonicalTemporaryDirectorySync('gotzji-product-owner-'); directories.push(value); return value; }
function legacyRow(root: string, pid: number): void {
  const database = new DatabaseSync(path.join(root, 'core.sqlite'), { timeout: 5000 });
  try { database.exec('CREATE TABLE gotzji_host_owners (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL)'); database.prepare('INSERT INTO gotzji_host_owners VALUES (?,?,?)').run('daemon', pid, 'legacy-nonce'); }
  finally { database.close(); }
}
function row(root: string): Record<string, unknown> | undefined {
  const database = new DatabaseSync(path.join(root, 'core.sqlite'), { readOnly: true, timeout: 5000 });
  try { return database.prepare(`SELECT owners.name,owners.pid,owners.nonce,identity.birth,identity.executable,identity.owner_mac
    FROM gotzji_host_owners AS owners LEFT JOIN gotzji_product_host_owner_identities AS identity
      ON identity.name=owners.name AND identity.pid=owners.pid AND identity.nonce=owners.nonce WHERE owners.name=?`).get('daemon') as Record<string, unknown> | undefined; }
  finally { database.close(); }
}
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe('product host OS identity ownership', () => {
  it.runIf(process.platform === 'win32')('proves the real current Windows process and retains one verified owner', async () => {
    const root = directory();
    const first = await acquireProductHostOwnership(root, secret);
    expect(first.status).toBe('acquired');
    const second = await acquireProductHostOwnership(root, secret);
    expect(second).toMatchObject({ status: 'owned', reason: 'HOST_OWNER_LIVE_VERIFIED', pid: process.pid });
    if (first.status === 'acquired') first.release();
  });

  it('treats a reused live PID with a different birth or executable as absent for the old scope', async () => {
    const root = directory(); let observed = current('old');
    const probe = async (pids: readonly number[]): Promise<Record<number, ProcessIdentity>> => Object.fromEntries(pids.map((pid) => [pid, observed]));
    const first = await acquireProductHostOwnership(root, secret, probe);
    expect(first.status).toBe('acquired');
    observed = current('reused');
    const replacement = await acquireProductHostOwnership(root, secret, probe);
    expect(replacement.status).toBe('acquired');
    if (first.status === 'acquired') first.release();
    expect(row(root)?.nonce).toBe(replacement.status === 'acquired' ? replacement.nonce : '');
    if (replacement.status === 'acquired') replacement.release();
  });

  it('fences a live legacy row whose exact identity was never recorded', async () => {
    const root = directory(); legacyRow(root, process.pid);
    const result = await acquireProductHostOwnership(root, secret, processIdentities);
    expect(result).toMatchObject({ status: 'unknown', reason: 'HOST_OWNER_LEGACY_LIVE_UNVERIFIED', pid: process.pid });
    expect(row(root)?.nonce).toBe('legacy-nonce');
  });

  it('recovers a legacy row only after the OS proves its PID absent', async () => {
    const root = directory(); legacyRow(root, 2_147_483_647);
    const identity = current('new');
    const result = await acquireProductHostOwnership(root, secret, async (pids) => Object.fromEntries(pids.map((pid) => [pid, pid === process.pid ? identity : null])));
    expect(result.status).toBe('acquired');
    expect(row(root)).toMatchObject({ pid: process.pid, birth: identity.birth });
    if (result.status === 'acquired') result.release();
  });

  it('keeps the legacy three-column owner table writable after identity migration', async () => {
    const root = directory(); const identity = current('migration');
    const migrated = await acquireProductHostOwnership(root, secret, reader(identity)); expect(migrated.status).toBe('acquired');
    if (migrated.status === 'acquired') migrated.release();
    const database = new DatabaseSync(path.join(root, 'core.sqlite'), { timeout: 5000 });
    try { database.prepare('INSERT INTO gotzji_host_owners VALUES (?,?,?)').run('daemon', 2_147_483_647, 'legacy-after-migration'); }
    finally { database.close(); }
    expect(row(root)).toMatchObject({ pid: 2_147_483_647, nonce: 'legacy-after-migration', birth: null });
  });

  it('uses every ownership field on release so a stale release cannot delete a replacement', async () => {
    const root = directory(); let observed = current('first');
    const probe = async (pids: readonly number[]): Promise<Record<number, ProcessIdentity>> => Object.fromEntries(pids.map((pid) => [pid, observed]));
    const first = await acquireProductHostOwnership(root, secret, probe); expect(first.status).toBe('acquired');
    observed = current('second');
    const second = await acquireProductHostOwnership(root, secret, probe); expect(second.status).toBe('acquired');
    if (first.status === 'acquired') first.release();
    expect(row(root)?.nonce).toBe(second.status === 'acquired' ? second.nonce : '');
    if (second.status === 'acquired') second.release();
  });

  it('allows only one winner when two callers race for an empty owner row', async () => {
    const root = directory(); const identity = current('race');
    const delayedProbe = async (pids: readonly number[]): Promise<Record<number, ProcessIdentity>> => { await new Promise((resolve) => setTimeout(resolve, 10)); return Object.fromEntries(pids.map((pid) => [pid, identity])); };
    const results = await Promise.all([acquireProductHostOwnership(root, secret, delayedProbe), acquireProductHostOwnership(root, secret, delayedProbe)]);
    expect(results.filter((result) => result.status === 'acquired')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'owned')).toHaveLength(1);
    for (const result of results) if (result.status === 'acquired') result.release();
  });

  it('fails closed when OS identity is unknown or a signed row has malformed identity or MAC', async () => {
    const root = directory(); const identity = current('valid');
    const first = await acquireProductHostOwnership(root, secret, reader(identity)); expect(first.status).toBe('acquired');
    expect(await acquireProductHostOwnership(root, secret, reader('unknown'))).toMatchObject({ status: 'unknown', reason: 'HOST_OWNER_IDENTITY_UNKNOWN' });
    const database = new DatabaseSync(path.join(root, 'core.sqlite'), { timeout: 5000 });
    try { database.prepare("UPDATE gotzji_product_host_owner_identities SET birth='' WHERE name=?").run('daemon'); }
    finally { database.close(); }
    expect(await acquireProductHostOwnership(root, secret, reader(identity))).toMatchObject({ status: 'unknown', reason: 'HOST_OWNER_RECORD_INVALID' });
    expect(row(root)?.birth).toBe('');

    const macRoot = directory();
    const macOwner = await acquireProductHostOwnership(macRoot, secret, reader(identity)); expect(macOwner.status).toBe('acquired');
    const macDatabase = new DatabaseSync(path.join(macRoot, 'core.sqlite'), { timeout: 5000 });
    try { macDatabase.prepare('UPDATE gotzji_product_host_owner_identities SET owner_mac=? WHERE name=?').run('0'.repeat(64), 'daemon'); }
    finally { macDatabase.close(); }
    expect(await acquireProductHostOwnership(macRoot, secret, reader(identity))).toMatchObject({ status: 'unknown', reason: 'HOST_OWNER_RECORD_INVALID' });
    expect(row(macRoot)?.owner_mac).toBe('0'.repeat(64));
  });
});
