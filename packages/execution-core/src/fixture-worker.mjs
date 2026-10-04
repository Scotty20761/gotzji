// Qualification-only recipes. No model input can select an executable, path or shell.
import http from 'node:http';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokerCall } from './grace-broker.mjs';
import { launchGrace } from './grace-runtime.mjs';
import { validationManager } from './phase-r-runner.mjs';

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
  let runtimeApproved = false;
  const persist = (name, payload) => {
    const body = JSON.stringify(payload);
    const record = JSON.stringify({ body, mac: createHmac('sha256', config.token).update(body).digest('hex') });
    writeFileSync(path.join(directory, name + '.tmp'), record, { mode: 0o600 });
    renameSync(path.join(directory, name + '.tmp'), path.join(directory, name));
  };
  const snapshot = () => ({ epoch: config.epoch, pid: process.pid, state, descendants });
  let graceFinished=false;
  const validator=validationManager(config,directory,{
    persist,register:(pid)=>{descendants.push(pid);persist('observation.json',snapshot());},
    finished:(receipt)=>{if(!stopping&&graceFinished){state=receipt.state==='completed'?'done':'failed';persist('observation.json',snapshot());}}
  });
  const server = http.createServer(async (req, res) => {
    // Each control/bridge request is bounded. Do not make proved cancellation
    // wait for a client keep-alive socket to expire before this worker exits.
    res.setHeader('Connection','close');
    if (req.headers.authorization !== `Bearer ${config.token}`) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && ['/broker', '/register-broker'].includes(url.pathname) && config.grace) {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('TOO_LARGE'); }
        const value = JSON.parse(body);
        if (url.pathname === '/register-broker') {
          if (!Number.isInteger(value.pid) || value.pid < 1) throw new Error('INVALID_PROCESS');
          descendants.push(value.pid); persist('observation.json', snapshot()); res.end('{}');
        } else {
          const result = await brokerCall(config, value.name, value.arguments, runtimeApproved && !stopping, validator);
          res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(result));
        }
      } catch (error) { const known=['RUNTIME_OR_TOOL_DENIED','ARGUMENTS_DENIED','PAYLOAD_DENIED','POLICY_DENIED','DELIVERY_AUTHORITY_DENIED','LIVE_AUTHORITY_DENIED','PREWORK_REQUIRED','SOURCE_READ_REQUIRED','SAVE_REQUIRED','REPRO_REQUIRED','EFFECT_UNKNOWN','DEPENDENCIES_CHANGED','OPERATION_DIGEST_CONFLICT','REPRO_NOT_VERIFIED','RUN_NOT_FOUND'];const reason=known.includes(error?.message)?error.message:'BROKER_DENIED';res.writeHead(403,{'Content-Type':'application/json'}).end(JSON.stringify({error:{code:reason}})); }
      return;
    }
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
      } else if (config.operation.startsWith('grace.') && config.grace) {
        try {
          const ready = JSON.parse(JSON.parse(readFileSync(path.join(directory,'ready.json'),'utf8')).body);
          child = launchGrace(configPath, config, ready, {
            register: (pid) => { descendants.push(pid); persist('observation.json', snapshot()); },
            approve: (value) => { runtimeApproved = value; }, persist,
            finish: (receipt) => {
              graceFinished=!!receipt;
              if(config.grace.recipe==='code-check'){
                const run=validator.status();state=!receipt||!run?'failed':run.state==='completed'?'done':run.state==='failed'?'failed':'running';
                if(!receipt) void validator.stop();
              } else state=receipt?'done':'failed';
              persist('observation.json',snapshot());
            },
          });
        } catch { state = 'failed'; }
      } else { state = 'failed'; }
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/cancel' && !stopping) {
      stopping = true;
      await validator.stop();
      if (child) {
        await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); if (config.grace) child.kill(); else child.send('stop'); } });
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
