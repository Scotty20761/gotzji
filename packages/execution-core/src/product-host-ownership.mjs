/* global process */
import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { processIdentities, sameProcessIdentity } from './process-identity.mjs';

const ownerName = 'daemon';
const maximumAttempts = 5;

function validSecret(value) { return typeof value === 'string' && value.length > 0; }
function validIdentity(value) {
  return !!value && typeof value === 'object'
    && typeof value.birth === 'string' && value.birth.length > 0 && value.birth.length <= 256 && !value.birth.includes('\0')
    && typeof value.executable === 'string' && value.executable.length > 0 && value.executable.length <= 32768 && !value.executable.includes('\0');
}
function ownerBody(value) {
  return JSON.stringify({ schemaVersion: 1, name: ownerName, pid: value.pid, nonce: value.nonce, birth: value.birth, executable: value.executable });
}
function ownerMac(key, value) { return createHmac('sha256', key).update(ownerBody(value)).digest('hex'); }
function sameMac(left, right) {
  if (typeof left !== 'string' || !/^[0-9a-f]{64}$/u.test(left) || typeof right !== 'string' || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function openOwnerDatabase(directory) {
  const database = new DatabaseSync(path.join(directory, 'core.sqlite'), { timeout: 5000 });
  try {
    database.exec(`PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS gotzji_host_owners (
        name TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        nonce TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gotzji_product_host_owner_identities (
        name TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        birth TEXT NOT NULL,
        executable TEXT NOT NULL,
        owner_mac TEXT NOT NULL
      );`);
    database.exec('COMMIT;');
    return database;
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* transaction did not open */ }
    database.close();
    throw error;
  }
}
function ownerRow(database) {
  return database.prepare(`SELECT owners.name,owners.pid,owners.nonce,identity.birth,identity.executable,identity.owner_mac
    FROM gotzji_host_owners AS owners
    LEFT JOIN gotzji_product_host_owner_identities AS identity
      ON identity.name=owners.name AND identity.pid=owners.pid AND identity.nonce=owners.nonce
    WHERE owners.name=?`).get(ownerName);
}
function rowSnapshot(value) {
  if (!value) return null;
  return { name: value.name, pid: value.pid, nonce: value.nonce, birth: value.birth, executable: value.executable, owner_mac: value.owner_mac };
}
function sameRow(left, right) { return JSON.stringify(rowSnapshot(left)) === JSON.stringify(rowSnapshot(right)); }
function classifyRow(value, key) {
  if (!value) return { kind: 'absent' };
  if (value.name !== ownerName || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== 'string' || value.nonce.length === 0) return { kind: 'invalid', pid: value.pid };
  const legacy = value.birth === null && value.executable === null && value.owner_mac === null;
  if (legacy) return { kind: 'legacy', pid: value.pid };
  if (!validIdentity(value) || !sameMac(value.owner_mac, ownerMac(key, value))) return { kind: 'invalid', pid: value.pid };
  return { kind: 'signed', pid: value.pid, identity: { birth: value.birth, executable: value.executable } };
}
function readLegacyFile(directory, key) {
  const filename = path.join(directory, 'daemon-owner.json');
  if (!existsSync(filename)) return { kind: 'absent', fingerprint: null };
  try {
    if (lstatSync(filename).isSymbolicLink()) return { kind: 'invalid', fingerprint: 'invalid' };
    const bytes = readFileSync(filename);
    const record = JSON.parse(bytes.toString('utf8'));
    if (typeof record?.body !== 'string') return { kind: 'invalid', fingerprint: bytes.toString('base64') };
    const expected = createHmac('sha256', key).update(record.body).digest('hex');
    if (!sameMac(record.mac, expected)) return { kind: 'invalid', fingerprint: bytes.toString('base64') };
    const value = JSON.parse(record.body);
    if (!Number.isSafeInteger(value?.pid) || value.pid <= 0) return { kind: 'invalid', fingerprint: bytes.toString('base64') };
    return { kind: 'present', pid: value.pid, fingerprint: bytes.toString('base64') };
  } catch { return { kind: 'invalid', fingerprint: 'invalid' }; }
}
function sameLegacyFile(left, right) { return left.kind === right.kind && left.pid === right.pid && left.fingerprint === right.fingerprint; }
function observation(values, pid) {
  const value = values?.[pid];
  if (value === null || value === 'unknown' || validIdentity(value)) return value;
  return 'unknown';
}
function unknown(reason, pid) { return { status: 'unknown', reason, ...(Number.isSafeInteger(pid) ? { pid } : {}) }; }

export async function acquireProductHostOwnership(directory, key, reader = processIdentities) {
  if (!validSecret(key) || typeof reader !== 'function') return unknown('HOST_OWNER_AUTHORITY_INVALID');
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    const initialDatabase = openOwnerDatabase(directory);
    let previous;
    try { previous = rowSnapshot(ownerRow(initialDatabase)); } finally { initialDatabase.close(); }
    const classified = classifyRow(previous, key);
    if (classified.kind === 'invalid') return unknown('HOST_OWNER_RECORD_INVALID', classified.pid);
    const legacy = previous ? { kind: 'absent', fingerprint: null } : readLegacyFile(directory, key);
    if (legacy.kind === 'invalid') return unknown('HOST_OWNER_LEGACY_RECORD_INVALID');
    const pids = [process.pid];
    if (classified.pid && classified.pid !== process.pid) pids.push(classified.pid);
    if (legacy.pid && legacy.pid !== process.pid && !pids.includes(legacy.pid)) pids.push(legacy.pid);
    let values;
    try { values = await reader(pids); } catch { values = {}; }
    const priorObservation = classified.pid ? observation(values, classified.pid) : null;
    if (classified.kind === 'signed') {
      if (priorObservation === 'unknown') return unknown('HOST_OWNER_IDENTITY_UNKNOWN', classified.pid);
      if (priorObservation !== null && sameProcessIdentity(classified.identity, priorObservation)) return { status: 'owned', reason: 'HOST_OWNER_LIVE_VERIFIED', pid: classified.pid };
    } else if (classified.kind === 'legacy' && priorObservation !== null) {
      return unknown(priorObservation === 'unknown' ? 'HOST_OWNER_IDENTITY_UNKNOWN' : 'HOST_OWNER_LEGACY_LIVE_UNVERIFIED', classified.pid);
    }
    const legacyObservation = legacy.pid ? observation(values, legacy.pid) : null;
    if (legacy.kind === 'present' && legacyObservation !== null) {
      return unknown(legacyObservation === 'unknown' ? 'HOST_OWNER_IDENTITY_UNKNOWN' : 'HOST_OWNER_LEGACY_LIVE_UNVERIFIED', legacy.pid);
    }
    const currentIdentity = observation(values, process.pid);
    if (!validIdentity(currentIdentity)) return unknown('CURRENT_PROCESS_IDENTITY_UNKNOWN', process.pid);
    const nonce = randomBytes(24).toString('hex');
    const candidate = { pid: process.pid, nonce, birth: currentIdentity.birth, executable: currentIdentity.executable };
    const mac = ownerMac(key, candidate);
    const database = openOwnerDatabase(directory);
    let committed = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      const currentRow = rowSnapshot(ownerRow(database));
      const currentLegacy = currentRow ? { kind: 'absent', fingerprint: null } : readLegacyFile(directory, key);
      if (!sameRow(previous, currentRow) || !sameLegacyFile(legacy, currentLegacy)) { database.exec('ROLLBACK;'); continue; }
      let changed;
      if (previous) {
        changed = database.prepare('UPDATE gotzji_host_owners SET pid=?,nonce=? WHERE name=? AND pid=? AND nonce=?')
          .run(candidate.pid, candidate.nonce, ownerName, previous.pid, previous.nonce);
      } else {
        changed = database.prepare('INSERT INTO gotzji_host_owners VALUES (?,?,?)').run(ownerName, candidate.pid, candidate.nonce);
      }
      if (Number(changed.changes) !== 1) { database.exec('ROLLBACK;'); continue; }
      database.prepare(`INSERT INTO gotzji_product_host_owner_identities (name,pid,nonce,birth,executable,owner_mac) VALUES (?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce,birth=excluded.birth,executable=excluded.executable,owner_mac=excluded.owner_mac`)
        .run(ownerName, candidate.pid, candidate.nonce, candidate.birth, candidate.executable, mac);
      database.exec('COMMIT;'); committed = true;
    } catch (error) {
      try { database.exec('ROLLBACK;'); } catch { /* transaction did not open */ }
      throw error;
    } finally { database.close(); }
    if (!committed) continue;
    return {
      status: 'acquired', pid: candidate.pid, birth: candidate.birth, executable: candidate.executable, nonce: candidate.nonce,
      release: () => {
        const releaseDatabase = openOwnerDatabase(directory);
        try {
          releaseDatabase.exec('BEGIN IMMEDIATE;');
          const released = releaseDatabase.prepare(`DELETE FROM gotzji_host_owners
            WHERE name=? AND pid=? AND nonce=? AND EXISTS (
              SELECT 1 FROM gotzji_product_host_owner_identities
              WHERE name=? AND pid=? AND nonce=? AND birth=? AND executable=? AND owner_mac=?
            )`).run(ownerName, candidate.pid, candidate.nonce, ownerName, candidate.pid, candidate.nonce, candidate.birth, candidate.executable, mac);
          if (Number(released.changes) === 1) releaseDatabase.prepare('DELETE FROM gotzji_product_host_owner_identities WHERE name=? AND pid=? AND nonce=?').run(ownerName, candidate.pid, candidate.nonce);
          releaseDatabase.exec('COMMIT;');
        } catch (error) {
          try { releaseDatabase.exec('ROLLBACK;'); } catch { /* transaction did not open */ }
          throw error;
        } finally { releaseDatabase.close(); }
      },
    };
  }
  return unknown('HOST_OWNER_CHANGED');
}
