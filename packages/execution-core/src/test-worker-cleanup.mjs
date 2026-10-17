import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const capabilityFile = 'synthetic-test-cleanup.json';
function verifyContext(config, directory, entrypoint) {
  const runtime = path.dirname(entrypoint);
  if (path.basename(runtime) === 'gotzji-core' || existsSync(path.join(runtime, 'product-runtime-manifest.json'))) throw new Error('TEST_CLEANUP_DENIED');
  // Native realpath expands 8.3 short names (hosted runners spell TEMP as RUNNER~1) and true case, so every operand compares in one spelling.
  const canonical = realpathSync.native(directory);
  const root = path.resolve(canonical, '../../..');
  if (path.dirname(root) !== realpathSync.native(os.tmpdir()) || !/^gotzji-library-[A-Za-z0-9]+$/u.test(path.basename(root))
    || canonical !== path.join(root, 'state', 'workers', path.basename(canonical))
    || config.operation !== 'grace.product-operation' || config.grace?.mode !== 'test-driver'
    || config.grace?.recipe !== 'product' || !config.grace.testDriver || !config.grace.testDriverHash
    || realpathSync.native(config.grace.libraryRoot) !== path.join(root, 'library') || JSON.parse(config.text).kind !== 'library') throw new Error('TEST_CLEANUP_DENIED');
}

export function issueSyntheticCleanupCapability(config, directory, entrypoint) {
  verifyContext(config, directory, entrypoint);
  if (existsSync(path.join(directory, capabilityFile)) && lstatSync(path.join(directory, capabilityFile)).isSymbolicLink()) throw new Error('TEST_CLEANUP_DENIED');
  const capability = randomBytes(32).toString('hex');
  const body = JSON.stringify({ jobId: config.jobId, epoch: config.epoch, capability, expiresAt: Date.now() + 10000 });
  writeFileSync(path.join(directory, capabilityFile), JSON.stringify({ body, mac: createHmac('sha256', config.token).update(body).digest('hex') }), { mode: 0o600 });
  return capability;
}

export function syntheticCleanupAuthorizer(config, directory, entrypoint) {
  const consumed = new Set();
  return (capability) => {
    try {
      verifyContext(config, directory, entrypoint);
      if (!/^[a-f0-9]{64}$/u.test(capability) || consumed.has(capability)) return false;
      const filename = path.join(directory, capabilityFile);
      if (lstatSync(filename).isSymbolicLink()) return false;
      const record = JSON.parse(readFileSync(filename, 'utf8'));
      if (typeof record.body !== 'string' || record.mac !== createHmac('sha256', config.token).update(record.body).digest('hex')) return false;
      const value = JSON.parse(record.body);
      if (value.capability !== capability || value.jobId !== config.jobId || value.epoch !== config.epoch
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < Date.now() || value.expiresAt > Date.now() + 10000) return false;
      const used = path.join(directory, `.synthetic-cleanup-used-${createHash('sha256').update(capability).digest('hex')}`);
      writeFileSync(used, '', { flag: 'wx', mode: 0o600 });
      unlinkSync(filename);
      consumed.add(capability);
      return true;
    } catch { return false; }
  };
}
