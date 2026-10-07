import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GotzjiConnectionService, productTunnelProfile, startProductTunnelBridge } from './product-connection.js';
import { windowsProductSecretProtector } from './product-host.js';
import { processIdentities, sameProcessIdentity } from './process-identity.mjs';

const exec = promisify(execFile);
const secret = 'b'.repeat(64);
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });
async function serve(handler: RequestListener): Promise<number> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address missing'); return address.port;
}
describe('owned Secure MCP Tunnel transport', () => {
  it('requires dedicated bearer authority and cannot expose the app RPC or redirect to arbitrary hosts', async () => {
    const paths: string[] = [];
    const port = await serve((request, response) => { paths.push(request.url ?? ''); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })); });
    const target = `http://127.0.0.1:${port}/mcp/${'a'.repeat(64)}`;
    const bridge = await startProductTunnelBridge(target, secret);
    try {
      const url = `http://127.0.0.1:${bridge.port}/mcp`;
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(403);
      const headers = { Authorization: `Bearer ${secret}` };
      expect((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://chatgpt.com' }, body: '{}' })).status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${bridge.port}/rpc`, { method: 'POST', headers, body: '{}' })).status).toBe(405);
      expect((await fetch(`http://127.0.0.1:${bridge.port}/.well-known/oauth-protected-resource/mcp`, { headers })).status).toBe(404);
      expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).toBe(200);
      expect(paths).toEqual([`/mcp/${'a'.repeat(64)}`]);
      await expect(startProductTunnelBridge('http://foreign.example/mcp/' + 'a'.repeat(64), secret)).rejects.toThrow('CONNECTION_TARGET_DENIED');
    } finally { await bridge.close(); }
  });
  it.runIf(process.platform === 'win32')('seals owner-only runtime credentials with actual DPAPI and projects no secret values', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotzji-connection-proof-'));
    const runtimeKey = 'owner-only-test-runtime-key';
    const options = { directory, ownerId: 'owner', executable: process.execPath, executableSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'), mcpTarget: (): string => `http://127.0.0.1:1/mcp/${'a'.repeat(64)}` };
    const service = new GotzjiConnectionService(options);
    expect(await service.status()).toMatchObject({ state: 'not-configured', configured: false });
    expect(await service.configure({ tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', runtimeKey })).toMatchObject({ state: 'stopped', configured: true });
    const raw = readFileSync(path.join(directory, 'product-tunnel.sealed.json'), 'utf8');
    expect(raw).not.toContain(runtimeKey); expect(raw).not.toContain('tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(JSON.stringify(await service.status())).not.toContain(runtimeKey);
    await expect(new GotzjiConnectionService({ ...options, ownerId: 'foreign' }).status()).rejects.toThrow('CONNECTION_OWNER_DENIED');
    await expect(service.configure({ tunnelId: 'invalid', runtimeKey })).rejects.toThrow('CONNECTION_CONFIGURATION_INVALID');
    const envelope = JSON.parse(raw) as { payload: string };
    const protector = windowsProductSecretProtector();
    const sealed = JSON.parse(await protector.unprotect(envelope.payload)) as Record<string, unknown>;
    // Unknown recorded liveness is retained as a fence; the service must never
    // claim ownership of the test runner process or terminate it.
    sealed.process = { pid: process.pid, executableSha256: options.executableSha256 };
    writeFileSync(path.join(directory, 'product-tunnel.sealed.json'), JSON.stringify({ schemaVersion: 1, payload: await protector.protect(JSON.stringify(sealed)) }));
    expect(await service.status()).toMatchObject({ state: 'reconciliation-required', errorCode: 'CONNECTION_PROCESS_UNKNOWN' });
    await expect(service.start()).rejects.toThrow('CONNECTION_RECONCILIATION_REQUIRED');
    await expect(service.stop()).rejects.toThrow('CONNECTION_PROCESS_UNKNOWN');
  }, 20000);
  const client = path.resolve('..', '..', 'apps', 'desktop', 'build', 'tunnel-client', 'tunnel-client.exe');
  it.runIf(process.platform === 'win32' && existsSync(client))('proves the official pinned client forwards both MCP and discovery auth from env references', async () => {
    expect(createHash('sha256').update(readFileSync(client)).digest('hex')).toBe('1946de55a038313a9b9b2458d05fe1719fa9cf1f20a94dd5f38fc26a98bfdd42');
    const observed: { pathname: string; method: string; authorized: boolean; headerKind: string }[] = [];
    const mcpPort = await serve((request, response) => {
      observed.push({ pathname: request.url ?? '', method: request.method ?? '', authorized: request.headers.authorization === `Bearer ${secret}`, headerKind: request.headers.authorization === undefined ? 'absent' : request.headers.authorization.startsWith('env:') ? 'unresolved-reference' : 'present' });
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.includes('.well-known')) { response.writeHead(404); response.end('{}'); return; }
      if (request.method !== 'POST') { response.writeHead(405); response.end('{}'); return; }
      let text = ''; request.on('data', (chunk) => { text += String(chunk); }); request.on('end', () => {
        if (!text) { response.writeHead(405); response.end('{}'); return; }
        const message = JSON.parse(text) as { id: unknown; method: string };
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'gotzji-auth-fixture', version: '1' } } : {} }));
      });
    });
    const cpPort = await serve((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ commands: [] })); });
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotzji-official-header-proof-'));
    const profile = path.join(directory, 'gotzji.json');
    const productionProfile = productTunnelProfile('tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mcpPort, path.join(directory, 'health.url')) as { control_plane: { base_url: string } };
    // Redirect only this isolated fixture's control plane. The service itself
    // has no control-plane URL override or renderer/model provider bypass.
    productionProfile.control_plane.base_url = `http://127.0.0.1:${cpPort}`;
    writeFileSync(profile, JSON.stringify(productionProfile));
    const environment = { ...process.env, CONTROL_PLANE_API_KEY: 'local-fixture-never-real-key', GOTZJI_TUNNEL_BRIDGE_AUTH: `Bearer ${secret}` };
    // Doctor is an actual official CLI contract check, with loopback-only test
    // targets. It does not prove any account/tunnel/ChatGPT acceptance.
    await exec(client, ['doctor', '--config', profile, '--explain'], { env: environment, windowsHide: true, timeout: 10000, maxBuffer: 131072 });
    observed.length = 0; // Doctor availability probes are separate from runtime MCP dispatch.
    const child = spawn(client, ['run', '--config', profile], { env: environment, windowsHide: true, stdio: 'ignore' });
    let identity;
    try {
      if (!child.pid) throw new Error('official client did not spawn');
      identity = (await processIdentities([child.pid]))[child.pid];
      const until = Date.now() + 5000;
      while (Date.now() < until && !observed.some((entry) => entry.pathname.includes('.well-known')) || Date.now() < until && !observed.some((entry) => entry.pathname === '/mcp')) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(observed.some((entry) => entry.pathname === '/mcp')).toBe(true);
      expect(observed.some((entry) => entry.pathname.includes('.well-known'))).toBe(true);
      expect(observed.filter((entry) => entry.method === 'POST' || entry.pathname.includes('.well-known'))).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'POST', authorized: true })]));
      expect(observed.filter((entry) => entry.method === 'POST' || entry.pathname.includes('.well-known')).every((entry) => entry.authorized), JSON.stringify(observed)).toBe(true);
    } finally {
      if (child.pid && identity && identity !== 'unknown' && sameProcessIdentity(identity, (await processIdentities([child.pid]))[child.pid])) child.kill();
      await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', () => resolve()); setTimeout(resolve, 2000); } });
    }
  }, 20000);
});
