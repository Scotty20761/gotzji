import { describe, expect, it } from 'vitest';
import { startProductHttp } from './product-http.js';
import { CoreError } from './types.js';
import { request as httpRequest } from 'node:http';
import { libraryCatalog } from './product-library.js';

describe('governed product HTTP and MCP boundary', () => {
  it('keeps registration off MCP and rejects credentialless, forged host and browser-origin calls', async () => {
    const calls: string[] = [];
    const host = await startProductHttp({ token: 'private-owner-token', mcpPathSecret: 'private-tunnel-path', rpc: async (method) => { calls.push(method); return { method }; } });
    const rpc = `http://127.0.0.1:${host.port}/rpc`;
    try {
      expect((await fetch(rpc, { method: 'POST', body: '{}' })).status).toBe(403);
      const headers = { Authorization: 'Bearer private-owner-token', 'Content-Type': 'application/json' };
      expect((await fetch(rpc, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: '{}' })).status).toBe(403);
      const forgedHostStatus = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(rpc, { method: 'POST', headers: { ...headers, Host: 'foreign.example' } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
        request.on('error', reject); request.end('{}');
      });
      expect(forgedHostStatus).toBe(403);
      const mcp = `http://127.0.0.1:${host.port}/mcp/private-tunnel-path`;
      const response = await fetch(mcp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) });
      const list = await response.json() as { result: { tools: { name: string; inputSchema: object }[] } };
      expect(list.result.tools.map((tool) => tool.name)).not.toContain('registerProject');
      expect(list.result.tools.map((tool) => tool.name)).toContain('gotzji_cancel');
      const denied = await fetch(mcp, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'registerProject', arguments: {} } }) });
      expect((await denied.json()).result.isError).toBe(true);
      expect(calls).toEqual([]);
      const registered = await fetch(rpc, { method: 'POST', headers, body: JSON.stringify({ method: 'registerProject', input: { projectId: 'test', displayName: 'Test', rootPath: 'C:/test' } }) });
      expect((await registered.json()).ok).toBe(true);
      expect(calls).toEqual(['registerProject']);
      expect(list.result.tools.map((tool) => tool.name).filter((name) => /settle/iu.test(name))).toEqual([]);
      for (const name of ['settleJob', 'gotzji_settleJob', 'gotzji_settle']) {
        const settleOverMcp = await fetch(mcp, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: { jobId: 'job', decision: 'no-effect' } } }) });
        expect((await settleOverMcp.json()).result.isError).toBe(true);
      }
      const invalidDecision = await fetch(rpc, { method: 'POST', headers, body: JSON.stringify({ method: 'settleJob', input: { jobId: 'job', decision: 'released' } }) });
      expect((await invalidDecision.json()).ok).not.toBe(true);
      const settled = await fetch(rpc, { method: 'POST', headers, body: JSON.stringify({ method: 'settleJob', input: { jobId: 'job', decision: 'no-effect' } }) });
      expect((await settled.json()).ok).toBe(true);
      expect(calls).toEqual(['registerProject', 'settleJob']);
      // Owner-approved recipes (incident I7): app only, typed, never a model tool.
      expect(list.result.tools.map((tool) => tool.name).filter((name) => /recipe/iu.test(name))).toEqual([]);
      for (const name of ['registerRecipe', 'bindProjectRecipe', 'gotzji_registerRecipe']) {
        const overMcp = await fetch(mcp, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name, arguments: { recipeId: 'phase-tests', executable: 'C:/Python/python.exe', args: [], dependencies: [], projectId: 'test' } } }) });
        expect((await overMcp.json()).result.isError).toBe(true);
      }
      const app = async (method: string, input: Record<string, unknown>): Promise<boolean> => (await (await fetch(rpc, { method: 'POST', headers, body: JSON.stringify({ method, input }) })).json() as { ok: boolean }).ok;
      expect(await app('registerRecipe', { recipeId: 'bad id', executable: 'C:/Python/python.exe', args: [], dependencies: [] })).toBe(false);
      expect(await app('registerRecipe', { recipeId: 'phase-tests', executable: 'C:/Python/python.exe', args: [7], dependencies: [] })).toBe(false);
      expect(await app('registerRecipe', { recipeId: 'phase-tests', executable: 'C:/Python/python.exe', args: ['-I'], dependencies: [], shell: true })).toBe(false);
      expect(await app('registerRecipe', { recipeId: 'phase-tests', executable: 'C:/Python/python.exe', args: ['-I'], dependencies: [], writeScope: 'workspace' })).toBe(false);
      expect(await app('registerRecipe', { recipeId: 'phase-tests', displayName: 'Phase 2 checks', executable: 'C:/Python/python.exe', args: ['-I'], dependencies: [], timeoutMs: 600000, writeScope: 'project' })).toBe(true);
      expect(await app('bindProjectRecipe', { projectId: 'test', recipeId: 'phase-tests', extra: true })).toBe(false);
      expect(await app('bindProjectRecipe', { projectId: 'test', recipeId: 'phase-tests' })).toBe(true);
      expect(calls).toEqual(['registerProject', 'settleJob', 'registerRecipe', 'bindProjectRecipe']);
    } finally { await host.close(); }
  });

  it('enforces every advertised action schema, including CAD entity handles, before app or MCP dispatch', async () => {
    const calls: { method: string; input: Record<string, unknown> }[] = [];
    const host = await startProductHttp({ token: 'owner', mcpPathSecret: 'tunnel', rpc: async (method, input) => { calls.push({ method, input }); return { accepted: true }; } });
    const common = { requestId: 'request', projectId: 'project' };
    const cases = [
      { operation: 'file.read', path: 'source.txt' }, { operation: 'file.write', path: 'source.txt', content: 'after', expectedSha256: 'a'.repeat(64) },
      { operation: 'command.run', commandId: 'node-check' }, { operation: 'excel.range.read', path: 'book.xlsx', sheet: 'Sheet1', range: 'A1' },
      { operation: 'excel.range.write', path: 'book.xlsx', sheet: 'Sheet1', range: 'A1', values: [['after']], outputPath: 'after.xlsx' },
      { operation: 'word.paragraph.read', path: 'doc.docx', paragraph: 1 }, { operation: 'word.paragraph.write', path: 'doc.docx', paragraph: 1, text: 'after', outputPath: 'after.docx' },
      { operation: 'powerpoint.shape.read', path: 'deck.pptx', slide: 1, shape: 'Title' }, { operation: 'powerpoint.shape.write', path: 'deck.pptx', slide: 1, shape: 'Title', text: 'after', outputPath: 'after.pptx' },
      { operation: 'cad.entity.inspect', path: 'drawing.dwg', handle: 'A1' }, { operation: 'cad.entity.move', path: 'drawing.dwg', handle: 'A1', displacement: [1, 2, 3], outputPath: 'after.dwg' },
    ];
    try {
      for (const operation of cases) {
        const input = { ...common, ...operation };
        const response = await fetch(`http://127.0.0.1:${host.port}/mcp/tunnel`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gotzji_prepare_operation', arguments: input } }) });
        expect((await response.json()).result.isError).toBe(false);
        for (const forged of [{ ...input, scriptPath: 'caller-provider.ps1' }, { ...input, owner: 'foreign' }, { ...input, priority: 4 }, { ...input, dependsOn: ['not-a-job-id'] }]) {
          const denied = await fetch(`http://127.0.0.1:${host.port}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify({ method: 'prepareOperation', input: forged }) });
          expect((await denied.json())).toMatchObject({ ok: false, error: { code: 'PRODUCT_SCHEMA_INVALID' } });
        }
      }
      expect(calls).toHaveLength(cases.length);
      const list = await (await fetch(`http://127.0.0.1:${host.port}/mcp/tunnel`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json();
      expect(list.result.tools.find((entry: { name: string }) => entry.name === 'gotzji_prepare_operation').inputSchema.oneOf).toHaveLength(cases.length + 6 + libraryCatalog().length);
    } finally { await host.close(); }
  });

  it('preserves tool call identity and typed errors without exposing unknown exception contents', async () => {
    const host = await startProductHttp({ token: 'owner', mcpPathSecret: 'tunnel', rpc: async (_method, input) => {
      if (input.jobId === 'typed') throw new CoreError('JOB_FOREIGN_OWNER', 'Select an enrolled owner job');
      throw new Error('password=do-not-expose');
    } });
    try {
      for (const [id, jobId, expected] of [[13, 'typed', 'JOB_FOREIGN_OWNER'], [14, 'unknown', 'PRODUCT_REQUEST_INVALID']] as const) {
        const response = await fetch(`http://127.0.0.1:${host.port}/mcp/tunnel`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'gotzji_status', arguments: { jobId } } }) });
        const result = await response.json();
        expect(result.id).toBe(id); expect(result.result.isError).toBe(true);
        expect(result.result.content[0].text).toContain(expected);
        expect(JSON.stringify(result)).not.toContain('do-not-expose');
      }
    } finally { await host.close(); }
  });
  it('accepts Browser and canonical Library variants while denying provider, scope and step forgery', async () => {
    let admitted = 0;
    const host = await startProductHttp({ token: 'owner', mcpPathSecret: 'tunnel', rpc: async () => { admitted++; return { accepted: true }; } });
    const base = { requestId: 'request', projectId: 'project' };
    const binding = { sessionId: 'owned-session', tabId: 'selected-tab', expectedUrl: 'https://example.org/', expectedDocumentId: 'selected-loader' };
    const inputs: Record<string, unknown>[] = [
      ...['browser.read', 'browser.query'].map((operation) => ({ ...base, ...binding, operation, selector: 'h1' })),
      { ...base, ...binding, operation: 'browser.type', selector: '#text', text: 'after' }, { ...base, ...binding, operation: 'browser.click', selector: '#button', postSelector: '#status', expectedPostText: 'done' },
      { ...base, ...binding, operation: 'browser.navigate', url: 'https://example.org/next' }, { ...base, ...binding, operation: 'browser.workflow', steps: [{ operation: 'browser.navigate', url: 'https://example.org/next' }, { operation: 'browser.read', selector: 'h1' }] },
      ...libraryCatalog().map((workflow) => ({ ...base, operation: 'library.workflow', workflowId: workflow.id, workflowVersion: workflow.version, parameters: Object.fromEntries(workflow.requiredParameters.map((name) => [name, name === 'expectedSha256' ? 'a'.repeat(64) : name === 'paths' ? '["source.md"]' : name === 'ticker' ? 'NVDA' : 'owned-input'])) })),
      { ...base, operation: 'file.write', path: 'new.txt', expectedSha256: null, content: 'new content' },
    ];
    const call = async (input: Record<string, unknown>): Promise<{ ok: boolean }> => (await (await fetch(`http://127.0.0.1:${host.port}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify({ method: 'prepareOperation', input }) })).json());
    try {
      for (const input of inputs) { expect((await call(input)).ok).toBe(true); for (const field of ['port', 'profilePath', 'manifestPath', 'scope', 'grant', 'testTransportModule']) expect((await call({ ...input, [field]: 'forged' })).ok).toBe(false); }
      expect((await call({ ...base, ...binding, operation: 'browser.workflow', steps: [{ operation: 'javascript.evaluate', expression: 'steal()' }] })).ok).toBe(false);
      expect(admitted).toBe(inputs.length);
    } finally { await host.close(); }
  });

  it('replays incidents I4 and I5: model tools need no lease proof, and no instruction text can request delivery', async () => {
    const calls: string[] = [];
    const host = await startProductHttp({ token: 'owner', mcpPathSecret: 'tunnel', rpc: async (method) => { calls.push(method); return { accepted: true }; } });
    const mcp = `http://127.0.0.1:${host.port}/mcp/tunnel`;
    const tool = async (id: number, name: string, args: Record<string, unknown>): Promise<boolean> => (await (await fetch(mcp, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) })).json() as { result: { isError?: boolean } }).result.isError === true;
    try {
      const list = await (await fetch(mcp, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json() as { result: { tools: { name: string; inputSchema: object }[] } };
      const fields = list.result.tools.flatMap((entry) => [...JSON.stringify(entry.inputSchema).matchAll(/"([A-Za-z]+)":\{/gu)].map((match) => match[1]!));
      // I4: lnwjud refused shell and edit calls that lacked a goal-lease proof; no model tool here carries or needs one.
      expect(fields.filter((field) => /lease|proof/iu.test(field))).toEqual([]);
      expect(await tool(2, 'gotzji_status', { jobId: 'job', goalLease: 'lease-from-another-call' })).toBe(true);
      expect(await tool(3, 'gotzji_status', { jobId: 'job' })).toBe(false);
      // I5: lnwjud read "Do not commit, push, release, or deploy." as a deploy task. Here no model tool names a delivery
      // scope, owner delivery authority stays on the app surface, and instruction text has no field to arrive in.
      expect(fields.filter((field) => /scope|deliver|deploy|release/iu.test(field))).toEqual([]);
      expect(list.result.tools.map((entry) => entry.name).filter((name) => /authori|deliver|deploy/iu.test(name))).toEqual([]);
      for (const [index, sentence] of ['Do not commit, push, release, or deploy.', 'PLAN ONLY: write documentation for later Official release. Do not build, publish, or promote anything.', 'Commit the fix and deploy to production.'].entries()) {
        expect(await tool(10 + index, 'gotzji_prepare_operation', { requestId: `instruction-${index}`, projectId: 'project', operation: 'file.read', path: 'notes.md', instruction: sentence })).toBe(true);
        expect(await tool(20 + index, 'authorizeLibraryDelivery', { projectId: 'project', jobId: 'job', scope: 'deploy', reason: sentence })).toBe(true);
      }
      expect(calls).toEqual(['status']);
    } finally { await host.close(); }
  });
});
