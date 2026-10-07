/* global process, Buffer */
import { Redactor } from '@lnwjud/audit';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import path from 'node:path';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const replaceWaitCell = new Int32Array(new SharedArrayBuffer(4));
/** Preserve the old receipt while Windows releases a transient file handle. */
export function replaceFileSync(temporary, target, options = {}) {
  const rename = options.rename ?? renameSync;
  const platform = options.platform ?? process.platform;
  const wait = options.wait ?? ((milliseconds) => { Atomics.wait(replaceWaitCell, 0, 0, milliseconds); });
  for (let attempt = 0; ; attempt += 1) {
    try { rename(temporary, target); return; }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 19) throw error;
      wait(25);
    }
  }
}
/** Deliberately excludes unknown variables, NODE_OPTIONS and provider secrets. */
export function childEnvironment(source = process.env) {
  const allowed = new Set(['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','HOME','LANG','LC_ALL','APPDATA','LOCALAPPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','XDG_SESSION_TYPE','DBUS_SESSION_BUS_ADDRESS','XDG_CURRENT_DESKTOP','XDG_CONFIG_HOME','XDG_DATA_HOME'].map((name) => name.toLowerCase()));
  const result = Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined));
  if (process.versions.electron) result.ELECTRON_RUN_AS_NODE = '1';
  return result;
}
/** Redact complete decoded lines so secrets split across chunks never escape. */
export function sanitizedStream(emit) {
  const redactor = new Redactor(); const decoder = new StringDecoder('utf8');
  let pending = ''; let discarding = false;
  const redact = (line) => { try { return JSON.stringify(redactor.redact(JSON.parse(line))) + (line.endsWith('\n') ? '\n' : ''); } catch { return redactor.redactText(line); } };
  function consume(text, ending = false) {
    pending += text;
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'); const line = pending.slice(0, end + 1); pending = pending.slice(end + 1);
      if (!discarding && Buffer.byteLength(line) <= 65536) emit(redact(line));
      else if (!discarding) emit('[REDACTED: oversized output line]\n');
      discarding = false;
    }
    if (Buffer.byteLength(pending) > 65536) { if (!discarding) emit('[REDACTED: oversized output line]\n'); pending = ''; discarding = true; }
    if (ending && pending) { if (!discarding) emit(redact(pending)); pending = ''; }
  }
  return { write: (chunk) => consume(decoder.write(chunk)), end: () => consume(decoder.end(), true) };
}
export function assertProductDependencies(config) {
  const operation = JSON.parse(config.text);
  const expected = Object.entries(operation.projectPolicies ?? {}).filter(([name]) => name.startsWith('project_policy_')).map(([,value]) => value);
  const actual = [];
  for (const directory of operation.policyDirectories ?? []) for (const name of ['AGENTS.md','CLAUDE.md']) {
    const filename = path.join(directory, name); if (existsSync(filename)) actual.push(filename);
  }
  if (actual.length !== expected.length || actual.some((filename) => !expected.some((entry) => entry.path === filename))) throw new Error('PROJECT_POLICY_CHANGED');
  for (const entry of expected) if (!existsSync(entry.path) || realpathSync(entry.path) !== entry.path || lstatSync(entry.path).isSymbolicLink() || hash(readFileSync(entry.path)) !== entry.hash) throw new Error('PROJECT_POLICY_CHANGED');
  for (const entry of Object.values(operation.projectPolicies ?? {})) if (!existsSync(entry.path) || realpathSync(entry.path) !== entry.path || lstatSync(entry.path).isSymbolicLink() || hash(readFileSync(entry.path)) !== entry.hash) throw new Error('PROJECT_POLICY_CHANGED');
  if (operation.command) for (const entry of [{ path: operation.command.executable, hash: operation.command.executableHash }, ...operation.command.dependencies]) {
    if (!existsSync(entry.path) || realpathSync(entry.path) !== entry.path || lstatSync(entry.path).isSymbolicLink() || hash(readFileSync(entry.path)) !== entry.hash) throw new Error('COMMAND_DEPENDENCIES_CHANGED');
  }
  if (operation.kind === 'library') for (const entry of [...operation.library.selectedSources, operation.library.python]) {
    if (!existsSync(entry.path) || realpathSync(entry.path) !== entry.path || lstatSync(entry.path).isSymbolicLink() || hash(readFileSync(entry.path)) !== entry.hash) throw new Error('LIBRARY_SOURCE_CHANGED');
  }
}
