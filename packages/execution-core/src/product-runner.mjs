/* global process, Buffer, setTimeout, clearTimeout */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { childEnvironment, sanitizedStream, assertProductDependencies } from './product-security.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** One host-reviewed command; stdout is progress, never completion evidence. */
export function productRunner(config, directory, callbacks) {
  let child;
  let receipt;
  let deadline;
  let startedAt;
  let timedOut = false;
  let cancelled = false;
  let outputBytes = 0;
  let stdout; let stderr;
  const operation = config.grace?.recipe === 'product' ? JSON.parse(config.text) : null;
  const persist = () => callbacks.persist('product-run.json', receipt);
  const state = () => receipt;
  function append(stream, value) {
    const chunk = Buffer.from(value, 'utf8');
    // Keep storage/control bounded even when a provider produces excessive output.
    const accepted = chunk.subarray(0, Math.max(0, 1024 * 1024 - outputBytes));
    outputBytes += accepted.length;
    if (accepted.length) appendFileSync(path.join(directory, 'product.stdout'), accepted, { mode: 0o600 });
    receipt = { ...receipt, elapsedMs: Date.now() - startedAt, lastProgressAt: new Date().toISOString(), outputBytes, lastStream: stream, truncated: outputBytes >= 1024 * 1024 };
    persist();
  }
  async function stop(timingOut = false) {
    timedOut ||= timingOut;
    cancelled ||= !timingOut;
    if (child && child.exitCode === null) {
      // The spawned ChildProcess still owns this live PID. Windows tree stop is
      // scoped to that owned child, never to a process name or another job.
      if (process.platform === 'win32') {
        const stopped = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, timeout: 5000, stdio: 'ignore' });
        if (stopped.status !== 0) { receipt = { ...receipt, state: 'uncertain', reason: 'TERMINATION_UNCONFIRMED' }; persist(); return false; }
      }
      else child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('close', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) {
        receipt = { ...receipt, state: 'uncertain', reason: 'TERMINATION_UNCONFIRMED' }; persist();
        return false;
      }
    }
    return true;
  }
  return {
    state, stop,
    start: () => {
      if (receipt) return receipt;
      const command = operation.command;
      assertProductDependencies(config);
      if (!command || hash(readFileSync(command.executable)) !== command.executableHash) throw new Error('COMMAND_DEPENDENCIES_CHANGED');
      startedAt = Date.now();
      receipt = { epoch: config.epoch, jobId: config.jobId, operation: 'command.run', commandId: command.commandId, commandFingerprint: hash(JSON.stringify(command)), state: 'running', exitCode: null, elapsedMs: 0, lastProgressAt: new Date().toISOString(), outputBytes: 0 };
      persist();
      const env = childEnvironment();
      child = spawn(command.executable, command.args, { cwd: operation.project.rootPath, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.pid) callbacks.register(child.pid, child);
      stdout = sanitizedStream((text) => append('stdout', text)); stderr = sanitizedStream((text) => append('stderr', text));
      child.stdout.on('data', (chunk) => stdout.write(chunk));
      child.stderr.on('data', (chunk) => stderr.write(chunk));
      deadline = setTimeout(() => { void stop(true); }, command.timeoutMs);
      child.once('error', () => {
        clearTimeout(deadline);
        receipt = { ...receipt, state: 'failed', reason: 'COMMAND_LAUNCH_FAILED', exitCode: -1, elapsedMs: Date.now() - startedAt, lastProgressAt: new Date().toISOString() };
        persist(); callbacks.finished(receipt);
      });
      child.once('close', (code) => {
        stdout.end(); stderr.end();
        clearTimeout(deadline);
        receipt = { ...receipt, state: receipt.state === 'uncertain' ? 'uncertain' : timedOut ? 'failed' : cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed', ...(timedOut ? { reason: 'COMMAND_TIMED_OUT' } : {}), exitCode: code ?? -1, elapsedMs: Date.now() - startedAt, lastProgressAt: new Date().toISOString() };
        persist(); callbacks.finished(receipt);
      });
      return receipt;
    },
  };
}
