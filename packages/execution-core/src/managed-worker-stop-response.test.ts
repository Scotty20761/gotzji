import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callWorker, signed, stopWorker } from './managed-worker.js';
import { processIdentities, type ProcessIdentity } from './process-identity.mjs';
import type { WorkerRow } from './store.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

// A real protocol fixture, not a native app. The private IPC barrier is the only
// way to publish a valid stopped receipt and let its actual root/child exit.
const protocolWorker = String.raw`
import {spawn} from 'node:child_process';import {createServer} from 'node:http';
import {writeFileSync,existsSync} from 'node:fs';import {createHmac} from 'node:crypto';import path from 'node:path';
const [directory,token,epoch,identityUrl,reply]=process.argv.slice(1);
const identityModule=await import(identityUrl);
const probeChildren=[];const probeCloses=[];
let session;
if(process.platform==='win32'){
 const modern=path.join(process.env.ProgramFiles??'C:/Program Files','PowerShell','7','pwsh.exe');
 const legacy=path.join(process.env.SystemRoot??'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 session=identityModule.createWindowsPowerShellSession({program:existsSync(modern)?modern:legacy,spawn:(...args)=>{
  const child=spawn(...args);probeChildren.push(child.pid);process.send({kind:'probe-child',pid:child.pid});
  probeCloses.push(new Promise(resolve=>child.once('close',()=>{process.send({kind:'probe-closed',pid:child.pid});resolve();})));return child;
 }});
}
const reader=session?identityModule.createWindowsProcessIdentityReader({session}):identityModule.processIdentities;
const child=spawn(process.execPath,['-e',"process.on('message',()=>process.exit(0));process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
const childClose=new Promise(resolve=>child.once('close',resolve));
let releasing=false,server,identity;
const sign=(name,value)=>{const body=JSON.stringify(value);writeFileSync(path.join(directory,name),JSON.stringify({body,mac:createHmac('sha256',token).update(body).digest('hex')}));};
const observation=()=>({epoch,pid:process.pid,state:'running',descendants:[child.pid],identities:identity});
async function release(){if(releasing)return;releasing=true;try{
 if(!identity){child.kill();await childClose;session?.close();await Promise.all(probeCloses);process.exit(0);}
 sign('stopped.json',{...observation(),state:'cancelled'});process.send({kind:'proof-written'});
 child.send('close');await childClose;process.send({kind:'descendant-closed',pid:child.pid});
 server.close(()=>process.exit(0));
}catch{process.send({kind:'fixture-error'});process.exit(1);}}
process.on('message',message=>{if(message==='release')void release();});
process.on('disconnect',()=>{void release();});
await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
identity=await reader([process.pid,child.pid]);session?.close();await Promise.all(probeCloses);
if(!identity[process.pid]||typeof identity[process.pid]!=='object'||!identity[child.pid]||typeof identity[child.pid]!=='object')throw new Error('FIXTURE_IDENTITY_UNPROVED');
server=createServer((req,res)=>{
 if(req.headers.authorization!=='Bearer '+token){res.writeHead(403).end();return;}
 const url=new URL(req.url,'http://127.0.0.1');
 if(req.method==='GET'&&url.pathname==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...observation(),nonce:url.searchParams.get('nonce')}));return;}
 if(req.method==='POST'&&url.pathname==='/cancel'){res.writeHead(Number(reply),{'Content-Type':'application/json'}).end(JSON.stringify(observation()));return;}
 res.writeHead(409).end();
});
server.listen(0,'127.0.0.1',()=>{sign('ready.json',{epoch,pid:process.pid,port:server.address().port,identity:identity[process.pid]});process.send({kind:'ready',descendant:child.pid,probeChildren});});
`;

interface ProtocolFixture {
  directory: string;
  worker: WorkerRow;
  child: ChildProcess;
  close: Promise<void>;
  closed: boolean;
  descendant?: number | undefined;
  probes: Set<number>;
  closedProbes: Set<number>;
  events: string[];
  pending: Set<Promise<unknown>>;
  restore?: (() => void) | undefined;
}
const fixtures: ProtocolFixture[] = [];
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned protocol fixture still pending; retained')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function fixture(reply = 200): Promise<ProtocolFixture> {
  const directory = await canonicalTemporaryDirectory('gotzji-stop-response-');
  const worker: WorkerRow = { directory, token: 'owned-stop-response-token', epoch: 'owned-stop-response-epoch', job_id: 'owned-job', session: 'owned-session', lease: 'owned-lease', generation: 1, launch_state: 'running', last_renewed: 0 };
  const child = spawn(process.execPath, ['--input-type=module', '-e', protocolWorker, directory, worker.token, worker.epoch, new URL('./process-identity.mjs', import.meta.url).href, String(reply)], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let close!: () => void;
  const f: ProtocolFixture = { directory, worker, child, close: new Promise<void>((resolve) => { close = resolve; }), closed: false, probes: new Set(), closedProbes: new Set(), events: [], pending: new Set() };
  fixtures.push(f);
  child.once('close', () => { f.closed = true; f.events.push('root-closed'); close(); });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => reject(new Error('Owned protocol worker closed before ready')));
    child.on('message', (message: { kind?: string; pid?: number; descendant?: number }) => {
      if (message.kind === 'ready') { f.descendant = message.descendant; resolve(); }
      else if (message.kind === 'probe-child' && message.pid) f.probes.add(message.pid);
      else if (message.kind === 'probe-closed' && message.pid) f.closedProbes.add(message.pid);
      else if (message.kind) f.events.push(message.kind);
    });
  });
  await bounded(ready, 10000);
  expect((await callWorker(worker, 'status')).pid).toBe(child.pid);
  return f;
}
function track<T>(f: ProtocolFixture, promise: Promise<T>): Promise<T> {
  f.pending.add(promise); void promise.then(() => f.pending.delete(promise), () => f.pending.delete(promise)); return promise;
}
async function envelope(f: ProtocolFixture, value: object, invalidMac = false): Promise<void> {
  const body = JSON.stringify(value);
  await writeFile(path.join(f.directory, 'stopped.json'), JSON.stringify({ body, mac: invalidMac ? 'invalid' : createHmac('sha256', f.worker.token).update(body).digest('hex') }));
}
afterEach(async () => {
  for (const f of fixtures) { f.restore?.(); f.restore = undefined; if (!f.closed && f.child.connected) f.child.send('release'); }
  for (const f of fixtures.splice(0)) {
    try {
      await bounded(Promise.allSettled([...f.pending]), 4000);
      await bounded(f.close, 4000);
      const pids = [f.child.pid, f.descendant, ...f.probes].filter((pid): pid is number => Number.isInteger(pid));
      const identities = await bounded(processIdentities(pids), 3000);
      const absent = pids.every((pid) => identities[pid] === null);
      process.stderr.write(`[stop-response-cleanup] ${JSON.stringify({ pids, identities, absent, rootClosed: f.closed, probeCloseEvents: [...f.closedProbes], events: f.events })}\n`);
      expect(absent).toBe(true); expect(f.closedProbes).toEqual(f.probes);
      await rm(f.directory, { recursive: true, force: true });
    } catch (error) {
      // Only the retained, creator-owned process is a cleanup target. Its child exits on IPC disconnect.
      if (!f.closed) { f.child.kill(); await bounded(f.close, 1000).catch(() => undefined); }
      process.stderr.write('[stop-response-cleanup] {"uncertain":true,"fixtureRetained":true}\n'); throw error;
    }
  }
});

describe('stop control responses preserve the independent proof boundary', () => {
  it.each(['accepted', 'lost'] as const)('waits after an actual %s response until signed proof and owned exits', async (kind) => {
    const f = await fixture();
    const ready = signed<{ port: number; pid: number; identity: ProcessIdentity }>(f.worker, 'ready.json');
    expect(ready?.pid).toBe(f.child.pid); expect(f.closed).toBe(false); expect(signed(f.worker, 'stopped.json')).toBeUndefined();
    const originalFetch = globalThis.fetch; let settled = false, observed = false;
    let checkpoint!: (status: number) => void;
    const delivered = new Promise<number>((resolve) => { checkpoint = resolve; });
    f.restore = (): void => { globalThis.fetch = originalFetch; };
    globalThis.fetch = async (input, init): Promise<Response> => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const response = await originalFetch(input, init);
      if (!observed && url.origin === `http://127.0.0.1:${ready?.port}` && url.pathname === '/cancel' && init?.method === 'POST') {
        observed = true; setImmediate(() => checkpoint(response.status));
        // Labelled fault after a real response; no OS identity or receipt is mocked.
        if (kind === 'lost') throw new TypeError('CONTROLLED_REPLY_DELIVERY_LOST');
      }
      return response;
    };
    try {
      const stopping = track(f, stopWorker(f.worker)); void stopping.then(() => { settled = true; }, () => { settled = true; });
      const status = await delivered;
      expect(status).toBe(200); expect(settled).toBe(false); expect(f.closed).toBe(false); expect(signed(f.worker, 'stopped.json')).toBeUndefined();
      f.events.push('pending-before-release'); f.child.send('release');
      expect(await stopping).toBe(true); await f.close;
      expect(f.events).toContain('proof-written'); expect(f.events).toContain('descendant-closed');
      expect(signed(f.worker, 'stopped.json')).toMatchObject({ state: 'cancelled', pid: ready?.pid });
      process.stderr.write(`[stop-response-barrier] ${JSON.stringify({ kind, status, pendingBeforeRelease: true, result: true, events: f.events })}\n`);
    } finally { f.restore(); f.restore = undefined; }
  }, 20000);
  it.each(['mac', 'epoch', 'state', 'root', 'live'] as const)('retains %s evidence checks after an actual typed refusal', async (kind) => {
    const f = await fixture(409);
    const observed = await callWorker(f.worker, 'status');
    const receipt = { ...observed, state: 'cancelled', ...(kind === 'epoch' ? { epoch: 'wrong' } : {}), ...(kind === 'state' ? { state: 'running' } : {}), ...(kind === 'root' ? { pid: process.pid } : {}) };
    await envelope(f, receipt, kind === 'mac');
    const stopping = track(f, stopWorker(f.worker));
    if (kind === 'mac' || kind === 'epoch') await expect(stopping).rejects.toMatchObject({ code: kind === 'mac' ? 'WORKER_EVIDENCE_INVALID' : 'WORKER_EPOCH_INVALID' });
    else expect(await stopping).toBe(false);
    expect(f.closed).toBe(false);
    expect((await readFile(path.join(f.directory, 'stopped.json'), 'utf8')).length).toBeGreaterThan(0);
  }, 20000);
});
