/* global fetch, AbortSignal */
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { tools, SERVER } from './grace-broker.mjs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const readyEnvelope = JSON.parse(readFileSync(path.join(path.dirname(process.argv[2]), 'ready.json'), 'utf8'));
// This bridge's file is private; the endpoint independently checks the per-worker credential.
const ready = JSON.parse(readyEnvelope.body);
if (ready.epoch !== config.epoch || createHmac('sha256',config.token).update(readyEnvelope.body).digest('hex') !== readyEnvelope.mac || !Number.isInteger(ready.port) || ready.port<1 || ready.port>65535) throw new Error('Worker binding invalid');
const endpoint = `http://127.0.0.1:${ready.port}`;
const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
await fetch(endpoint + '/register-broker', { method: 'POST', headers, body: JSON.stringify({ pid: process.pid }), signal: AbortSignal.timeout(5000) });
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: SERVER, version: '5.7.3' } };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools: tools(config) };
    else if (request.method === 'tools/call') {
      const response = await fetch(endpoint + '/broker', { method: 'POST', headers, body: JSON.stringify({ name: request.params?.name, arguments: request.params?.arguments }), signal: AbortSignal.timeout(15000) });
      const value = await response.json();
      if (!response.ok) {result={isError:true,content:[{type:'text',text:value.error?.code??'BROKER_DENIED'}]};}
      else
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } else throw new Error('METHOD_DENIED');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32602, message: 'Task-bound broker denied the request' } }) + '\n');
  }
}
