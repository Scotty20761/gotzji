import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatGitReadDiagnostic, parseGitReadDiagnostic, writeGitReadDiagnostic } from './git-read-diagnostics.js';
const valid = { schemaVersion: 1, code: 'GIT_SNAPSHOT_BUDGET', phase: 'objects', elapsedMs: 25001, phaseStartsMs: { census: 0, metadata: 1200, config: 1210, 'object-directories': 1230, objects: 1250 }, totalObjects: 10023, copiedObjects: 8000, copiedBytes: 500000, ioThreads: 16 };
describe('private Git read budget diagnostics', () => {
  it('keeps an asynchronous broken diagnostic pipe from replacing the original budget refusal', async () => {
    const script = `
      import { Writable } from 'node:stream';
      import * as diagnostics from ${JSON.stringify(new URL('./git-read-diagnostics.ts', import.meta.url).href)};
      const sink = new Writable({ write(_chunk, _encoding, callback) { setImmediate(() => callback(Object.assign(new Error('owned closed pipe'), { code: 'EPIPE' }))); } });
      const write = diagnostics.writeGitReadDiagnostic;
      write(${JSON.stringify(valid)}, sink);
      await new Promise(resolve => setTimeout(resolve, 20));
      process.stdout.write('GIT_SNAPSHOT_BUDGET');
    `;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { timeout: 3000, windowsHide: true });
    expect(result.stdout).toBe('GIT_SNAPSHOT_BUDGET');
  });
  it('writes only validated records and absorbs synchronous sink refusal', () => {
    const chunks: string[] = [];
    const sink = new Writable({ write(chunk, _encoding, callback): void { chunks.push(chunk.toString()); callback(); } });
    writeGitReadDiagnostic(valid, sink);
    writeGitReadDiagnostic({ ...valid, token: 'PRIVATE_TOKEN' }, sink);
    expect(chunks).toEqual([formatGitReadDiagnostic(valid)]);
    vi.spyOn(sink, 'write').mockImplementation(() => { throw new Error('owned synchronous refusal'); });
    expect(() => writeGitReadDiagnostic(valid, sink)).not.toThrow();
  });
  it('removes temporary error listeners after asynchronous write failure', async () => {
    const sink = new Writable({ write(_chunk, _encoding, callback): void { setImmediate(() => callback(Object.assign(new Error('owned closed pipe'), { code: 'EPIPE' }))); } });
    writeGitReadDiagnostic(valid, sink);
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
    expect(sink.listenerCount('error')).toBe(0);
    expect(sink.destroyed).toBe(true);
  });
  it('round trips only bounded phase, counts, bytes, elapsed and numeric pool configuration', () => {
    const line = formatGitReadDiagnostic(valid); expect(line).toContain('[gotzji-git-read-budget] ');
    expect(parseGitReadDiagnostic(line!)).toEqual(valid); expect(line).not.toContain('filePath');
  });
  it.each([{ path: 'PRIVATE_PATH' }, { projectId: 'PRIVATE_PROJECT' }, { token: 'PRIVATE_TOKEN' }, { phase: 'PRIVATE_PHASE' }, { elapsedMs: Infinity }, { copiedObjects: 10024 }, { ioThreads: -1 }, { phaseStartsMs: { objects: 25002 } }, { phaseStartsMs: { private: 1 } }])('rejects private or invalid fields instead of forwarding them: %j', change => {
    expect(formatGitReadDiagnostic({ ...valid, ...change })).toBeUndefined();
  });
  it('rejects arbitrary stderr, malformed JSON, oversized lines and an undeclared budget code', () => {
    expect(parseGitReadDiagnostic('private arbitrary stderr')).toBeUndefined();
    expect(parseGitReadDiagnostic('[gotzji-git-read-budget] {')).toBeUndefined();
    expect(parseGitReadDiagnostic('[gotzji-git-read-budget] ' + 'x'.repeat(2048))).toBeUndefined();
    expect(formatGitReadDiagnostic({ ...valid, code: 'PRIVATE_CODE' })).toBeUndefined();
  });
});
