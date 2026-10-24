import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const capabilityFile = 'synthetic-test-cleanup.json';
function denied(reason) { throw Object.assign(new Error('TEST_CLEANUP_DENIED'), { cleanupReason: reason }); }
function verifyContext(config, directory, entrypoint) {
  const runtime = path.dirname(entrypoint);
  if (path.basename(runtime) === 'gotzji-core' || existsSync(path.join(runtime, 'product-runtime-manifest.json'))) denied('runtime');
  // Native realpath expands 8.3 short names (hosted runners spell TEMP as RUNNER~1) and true case, so every operand compares in one spelling.
  const canonical = realpathSync.native(directory);
  const root = path.resolve(canonical, '../../..');
  if (path.dirname(root) !== realpathSync.native(os.tmpdir())) denied('temp-parent');
  if (!/^gotzji-library-[A-Za-z0-9]+$/u.test(path.basename(root)) || canonical !== path.join(root, 'state', 'workers', path.basename(canonical))) denied('fixture-path');
  if (config.operation !== 'grace.product-operation' || config.grace?.mode !== 'test-driver' || config.grace?.recipe !== 'product' || !config.grace.testDriver || !config.grace.testDriverHash) denied('driver');
  if (realpathSync.native(config.grace.libraryRoot) !== path.join(root, 'library')) denied('library-root');
  if (JSON.parse(config.text).kind !== 'library') denied('operation');
}

export function issueSyntheticCleanupCapability(config, directory, entrypoint) {
  verifyContext(config, directory, entrypoint);
  if (existsSync(path.join(directory, capabilityFile)) && lstatSync(path.join(directory, capabilityFile)).isSymbolicLink()) throw new Error('TEST_CLEANUP_DENIED');
  const capability = randomBytes(32).toString('hex');
  const body = JSON.stringify({ jobId: config.jobId, epoch: config.epoch, capability, expiresAt: Date.now() + 10000 });
  writeFileSync(path.join(directory, capabilityFile), JSON.stringify({ body, mac: createHmac('sha256', config.token).update(body).digest('hex') }), { mode: 0o600 });
  return capability;
}

export function syntheticCleanupAuthorizer(config, directory, entrypoint, onDenied = () => {}) {
  const consumed = new Set();
  return (capability) => {
    let stage = 'context';
    const refuse = (reason = stage) => { try { onDenied(reason); } catch { /* Diagnostics cannot change authorization. */ } return false; };
    try {
      verifyContext(config, directory, entrypoint);
      stage = 'capability';
      if (!/^[a-f0-9]{64}$/u.test(capability) || consumed.has(capability)) return refuse();
      stage = 'record';
      const filename = path.join(directory, capabilityFile);
      if (lstatSync(filename).isSymbolicLink()) return refuse();
      const record = JSON.parse(readFileSync(filename, 'utf8'));
      stage = 'mac';
      if (typeof record.body !== 'string' || record.mac !== createHmac('sha256', config.token).update(record.body).digest('hex')) return refuse();
      const value = JSON.parse(record.body);
      stage = 'binding-expiry';
      if (value.capability !== capability || value.jobId !== config.jobId || value.epoch !== config.epoch
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < Date.now() || value.expiresAt > Date.now() + 10000) return refuse();
      stage = 'consume';
      const used = path.join(directory, `.synthetic-cleanup-used-${createHash('sha256').update(capability).digest('hex')}`);
      writeFileSync(used, '', { flag: 'wx', mode: 0o600 });
      unlinkSync(filename);
      consumed.add(capability);
      return true;
    } catch (error) { return refuse(error.cleanupReason ?? stage); }
  };
}
