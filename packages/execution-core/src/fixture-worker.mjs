// Qualification-only recipes. No model input can select an executable, path or shell.
import http from 'node:http';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configPath = process.argv[2];
const mode = process.argv[3] ?? 'worker';
if (mode !== 'worker') {
  let child;
  if (mode === 'child') {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), configPath, 'grandchild'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    child.on('message', (m) => process.send?.(m));
  }
  process.send?.({ pid: process.pid });
  process.on('message', async (m) => {
    if (m !== 'stop') return;
    if (child) { await new Promise((resolve) => { child.once('exit', resolve); child.send('stop'); }); }
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const directory = path.dirname(configPath);
  const descendants = [];
  let state = 'ready';
  let child;
  let stopping = false;
  const persist = (name, payload) => {
    const body = JSON.stringify(payload);
    const record = JSON.stringify({ body, mac: createHmac('sha256', config.token).update(body).digest('hex') });
    writeFileSync(path.join(directory, name + '.tmp'), record, { mode: 0o600 });
    renameSync(path.join(directory, name + '.tmp'), path.join(directory, name));
  };
  const snapshot = () => ({ epoch: config.epoch, pid: process.pid, state, descendants });
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${config.token}`) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...snapshot(), nonce: url.searchParams.get('nonce') }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/start' && state === 'ready') {
      state = 'running';
      persist('observation.json', snapshot());
      if (config.operation === 'fixture.write') {
        try {
          writeFileSync(path.join(config.effectRoot, 'result.txt'), config.text, { flag: 'wx' });
          state = 'done';
        } catch { state = 'failed'; }
        persist('observation.json', snapshot());
      } else if (config.operation === 'fixture.hold') {
        child = spawn(process.execPath, [fileURLToPath(import.meta.url), configPath, 'child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
        child.on('message', (m) => { if (Number.isInteger(m.pid)) { descendants.push(m.pid); persist('observation.json', snapshot()); } });
      } else { state = 'failed'; }
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/cancel' && !stopping) {
      stopping = true;
      if (child) {
        await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); child.send('stop'); } });
      }
      state = 'cancelled';
      persist('stopped.json', snapshot());
      res.end(JSON.stringify(snapshot()));
      server.close(() => process.exit(0));
      return;
    }
    res.writeHead(409).end();
  });
  server.listen(0, '127.0.0.1', () => {
    persist('ready.json', { epoch: config.epoch, pid: process.pid, port: server.address().port });
  });
}
