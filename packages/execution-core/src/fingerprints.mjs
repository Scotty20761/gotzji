import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
const verified = new Map();
function identity(filename) {
  const value = statSync(filename, { bigint: true });
  return [value.dev,value.ino,value.size,value.birthtimeNs,value.mtimeNs,value.ctimeNs].join(':');
}
export function verifyFingerprint(filename, expected) {
  if (realpathSync(filename) !== filename) throw new Error('FILE_FINGERPRINT_CHANGED');
  const before = identity(filename);
  const cached = verified.get(filename);
  if (cached?.identity === before && cached.hash === expected) return;
  const hash = createHash('sha256').update(readFileSync(filename)).digest('hex');
  if (hash !== expected || before !== identity(filename)) throw new Error('FILE_FINGERPRINT_CHANGED');
  verified.set(filename,{ identity:before,hash });
}
