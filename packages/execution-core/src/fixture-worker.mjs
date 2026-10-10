/* global process, setInterval, setTimeout, clearTimeout, URL */
// Model input selects only a sealed host-prepared operation, never a raw executable or shell.
import http from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokerCall } from './grace-broker.mjs';
import { launchGrace } from './grace-runtime.mjs';
import { validationManager } from './phase-r-runner.mjs';
import { productRunner } from './product-runner.mjs';
import { processIdentities } from './process-identity.mjs';
import { productNativeManager } from './product-native-manager.mjs';
import { productLibraryManager } from './product-library-manager.mjs';
import { productBrowserManager } from './product-browser-manager.mjs';
import { replaceFileSync } from './product-security.mjs';
import { syntheticCleanupAuthorizer } from './test-worker-cleanup.mjs';

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
    if (child) {
      await new Promise((resolve) => { child.once('close', resolve); child.send('stop'); });
      await new Promise((resolve) => process.send?.({ closedPid: child.pid }, resolve));
    }
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const directory = path.dirname(configPath);
  const authorizeSyntheticCleanup = syntheticCleanupAuthorizer(config, directory, fileURLToPath(import.meta.url));
  const descendants = [];
  const identities = {};
  const closedDescendants = [];
  const ownedChildren = new Map();
  const pendingIdentityProbes = new Set();
  let state = 'ready';
  let child;
  let stopping = false;
  let runtimeApproved = false;
  const persist = (name, payload) => {
    const body = JSON.stringify(payload);
    const record = JSON.stringify({ body, mac: createHmac('sha256', config.token).update(body).digest('hex') });
    const temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`);
    writeFileSync(temporary, record, { flag: 'wx', mode: 0o600 });
    try { replaceFileSync(temporary, path.join(directory, name)); }
    catch (error) { try { unlinkSync(temporary); } catch { /* preserve the original write failure */ } throw error; }
  };
  const snapshot = () => ({ epoch: config.epoch, pid: process.pid, state, descendants, identities, closedDescendants });
  function register(pid, ownedChild) {
    if (!descendants.includes(pid)) descendants.push(pid);
    const closedIndex = closedDescendants.indexOf(pid); if (closedIndex >= 0) closedDescendants.splice(closedIndex, 1);
    if (ownedChild) {
      ownedChildren.set(pid, ownedChild);
      ownedChild.once('close', () => { if (ownedChildren.get(pid) === ownedChild) { closedDescendants.push(pid); ownedChildren.delete(pid); persist('observation.json', snapshot()); } });
    }
    persist('observation.json', snapshot());
    const probe = processIdentities([pid]).then((values) => {
      if (ownedChild && (ownedChildren.get(pid) !== ownedChild || ownedChild.exitCode !== null || ownedChild.signalCode !== null)) return;
      if (values[pid] && typeof values[pid] === 'object') { identities[pid] = values[pid]; persist('observation.json', snapshot()); }
    });
    pendingIdentityProbes.add(probe); void probe.finally(() => pendingIdentityProbes.delete(probe));
  }
  let graceFinished=false;
  const native = productNativeManager(config, directory, {
    persist, finished: (receipt) => {
      if (!stopping && graceFinished) { state = receipt.state === 'completed' ? 'done' : 'failed'; persist('observation.json', snapshot()); }
    },
  });
  const library = productLibraryManager(config, directory, {
    persist, finished: (receipt) => {
      if (!stopping && graceFinished) { state = receipt.state === 'completed' ? 'done' : 'failed'; persist('observation.json', snapshot()); }
    },
  });
  const browser = productBrowserManager(config, directory, {
    persist, finished: (receipt) => {
      if (!stopping && graceFinished) { state = receipt.state === 'completed' ? 'done' : 'failed'; persist('observation.json', snapshot()); }
    },
  });
  const product = productRunner(config, directory, {
    persist, register,
    finished: (receipt) => {
      writeFileSync(path.join(config.effectRoot, 'result.txt'), JSON.stringify(receipt), { mode: 0o600 });
      if (!stopping && graceFinished) { state = receipt.state === 'completed' ? 'done' : 'failed'; persist('observation.json', snapshot()); }
    },
  });
  const validator=validationManager(config,directory,{
    persist,register,
    finished:(receipt)=>{if(!stopping&&graceFinished){state=receipt.state==='completed'?'done':'failed';persist('observation.json',snapshot());}}
  });
  const server = http.createServer(async (req, res) => {
    // Each control/bridge request is bounded. Do not make proved cancellation
    // wait for a client keep-alive socket to expire before this worker exits.
    res.setHeader('Connection','close');
    if (req.headers.authorization !== `Bearer ${config.token}`) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/synthetic-test-cleanup') {
      const nonce = url.searchParams.get('nonce');
      if (!authorizeSyntheticCleanup(nonce)) { res.writeHead(403).end(); return; }
      stopping = true;
      try {
        const exits = [];
        for (const owned of ownedChildren.values()) {
          if (owned.exitCode !== null || owned.signalCode !== null) continue;
          exits.push(new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('TEST_CHILD_STOP_UNVERIFIED')), 2000);
            owned.once('close', () => { clearTimeout(timeout); resolve(); });
            owned.kill('SIGTERM');
          }));
        }
        await Promise.all(exits);
        await Promise.allSettled([...pendingIdentityProbes]);
        const remaining = descendants.filter((pid) => {
          try { process.kill(pid, 0); return true; }
          catch (error) { return error.code !== 'ESRCH'; }
        });
        if (remaining.length) {
          const observed = await processIdentities(remaining);
          if (remaining.some((pid) => observed[pid] !== null && (!identities[pid] || observed[pid] === 'unknown' || observed[pid] === undefined
            || (observed[pid].birth === identities[pid].birth && observed[pid].executable === identities[pid].executable)))) throw new Error('TEST_CHILD_STOP_UNVERIFIED');
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ nonce, epoch: config.epoch, pid: process.pid }));
        server.close(() => process.exit(0));
      } catch { res.writeHead(409).end(); }
      return;
    }
    if (req.method === 'POST' && ['/broker', '/register-broker'].includes(url.pathname) && config.grace) {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('TOO_LARGE'); }
        const value = JSON.parse(body);
        if (url.pathname === '/register-broker') {
          if (!Number.isInteger(value.pid) || value.pid < 1) throw new Error('INVALID_PROCESS');
          register(value.pid); res.end('{}');
        } else {
           const kind = config.operation === 'grace.product-operation' ? JSON.parse(config.text).kind : undefined;
           const runner = kind === 'native' ? native : kind === 'library' ? library : kind === 'browser' ? browser : config.grace.recipe === 'product' ? product : validator;
           const result = await brokerCall(config, value.name, value.arguments, runtimeApproved && !stopping, runner);
          res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(result));
        }
      } catch (error) {
        const known=['RUNTIME_OR_TOOL_DENIED','ARGUMENTS_DENIED','PAYLOAD_DENIED','POLICY_DENIED','DELIVERY_AUTHORITY_DENIED','LIVE_AUTHORITY_DENIED','PREWORK_REQUIRED','SOURCE_READ_REQUIRED','SAVE_REQUIRED','REPRO_REQUIRED','EFFECT_UNKNOWN','DEPENDENCIES_CHANGED','OPERATION_DIGEST_CONFLICT','REPRO_NOT_VERIFIED','RUN_NOT_FOUND','PROJECT_ROOT_CHANGED','PROJECT_REGISTRATION_CHANGED','FILE_SCOPE_CHANGED','PRIVATE_RUNTIME_SCOPE_DENIED','FILE_VERSION_CONFLICT','COMMAND_DEPENDENCIES_CHANGED','OPERATION_NOT_STARTED','PROJECT_POLICY_CHANGED','FILE_NOT_FOUND','FILE_PERMISSION_DENIED','PATH_NOT_DIRECTORY'];
        const reason=known.includes(error?.message)?error.message:'BROKER_DENIED';
        const field = error?.field ?? (reason === 'FILE_VERSION_CONFLICT' ? 'expectedSha256' : reason === 'FILE_SCOPE_CHANGED' ? 'path' : undefined);
        persist('broker-error.json', { epoch: config.epoch, jobId: config.jobId, code: reason, ...(field ? { field } : {}), layer: 'grace-operation-broker' });
        res.writeHead(403,{'Content-Type':'application/json'}).end(JSON.stringify({error:{code:reason,...(field ? { field } : {})}}));
      }
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
        if (child.pid) register(child.pid, child);
        child.on('message', (m) => {
          if (Number.isInteger(m.pid) && m.pid !== child.pid) register(m.pid);
          if (Number.isInteger(m.closedPid) && descendants.includes(m.closedPid)) { closedDescendants.push(m.closedPid); persist('observation.json', snapshot()); }
        });
      } else if (config.operation.startsWith('grace.') && config.grace) {
        try {
          const ready = JSON.parse(JSON.parse(readFileSync(path.join(directory,'ready.json'),'utf8')).body);
          child = launchGrace(configPath, config, ready, {
            register,
            approve: (value) => { runtimeApproved = value; }, persist,
            finish: (receipt) => {
              graceFinished=!!receipt;
              if(config.grace.recipe==='product') {
                const operation = JSON.parse(config.text);
                 const run = operation.kind === 'native' ? native.status() : operation.kind === 'library' ? library.status() : operation.kind === 'browser' ? browser.status() : product.state();
                 state = !receipt ? 'failed' : !['native','library','browser'].includes(operation.kind) && operation.input.operation !== 'command.run' ? 'done' : !run ? 'failed' : run.state === 'completed' ? 'done' : ['failed','cancelled','uncertain'].includes(run.state) ? 'failed' : 'running';
                 // Best-effort abort only; a stop with proof still goes through /cancel, so a rejection here must not crash the worker.
                 if (!receipt) { if (operation.kind === 'library') void library.stop().catch(() => undefined); else if (operation.kind === 'browser') void browser.stop().catch(() => undefined); else void product.stop().catch(() => undefined); }
              } else if(config.grace.recipe==='code-check'){
                const run=validator.status();state=!receipt||!run?'failed':run.state==='completed'?'done':run.state==='failed'?'failed':'running';
                if(!receipt) void validator.stop().catch(() => undefined);
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
      // A stop that throws is refused like one that returns false: no receipt, and the worker stays alive for inspection.
      try {
        if (config.operation === 'grace.product-operation' && JSON.parse(config.text).kind === 'native' && !await native.stop()) { res.writeHead(409).end(); return; }
        if (config.operation === 'grace.product-operation' && JSON.parse(config.text).kind === 'library' && !await library.stop()) { res.writeHead(409).end(); return; }
        if (config.operation === 'grace.product-operation' && JSON.parse(config.text).kind === 'browser' && !await browser.stop()) { res.writeHead(409).end(); return; }
        if (config.grace?.recipe === 'product' && !['native','library','browser'].includes(JSON.parse(config.text).kind) && !await product.stop()) { res.writeHead(409).end(); return; }
        await validator.stop();
      } catch { res.writeHead(409).end(); return; }
      if (child) {
        await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); if (config.grace) child.kill(); else child.send('stop'); } });
      }
      await Promise.allSettled([...pendingIdentityProbes]);
      state = 'cancelled';
      persist('stopped.json', snapshot());
      res.end(JSON.stringify(snapshot()));
      server.close(() => process.exit(0));
      return;
    }
    res.writeHead(409).end();
  });
  server.listen(0, '127.0.0.1', async () => {
    const values = await processIdentities([process.pid]);
    if (values[process.pid] && typeof values[process.pid] === 'object') identities[process.pid] = values[process.pid];
    persist('ready.json', { epoch: config.epoch, pid: process.pid, port: server.address().port, ...(identities[process.pid] ? { identity: identities[process.pid] } : {}) });
  });
}
