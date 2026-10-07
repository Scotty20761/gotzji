import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { ProductLibraryChannel } from './product-library-channel.js';
import { libraryCatalog } from './product-library.js';

describe('dedicated Library channel over the existing authority', () => {
  it('enrolls a separate adapter in one ledger, exposes only Library preparations and never borrows primary native preparations', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'gotzji-library-channel-')); const directory = path.join(base, 'runtime'); const projectRoot = path.join(base, 'library');
    mkdirSync(directory); mkdirSync(projectRoot); ensureProductControlDocuments(projectRoot); writeFileSync(path.join(projectRoot, 'source.txt'), 'owned selected Library input');
    const core = await ExecutionCore.open(directory, { product: { executable: process.execPath, libraryRoot: projectRoot }, libraryOptions: { pythonExecutable: process.execPath, pythonSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') } });
    const credential = 'a'.repeat(64); core.ensureAdapterEnrollment('gotzji-product', 'owner', credential);
    core.registerProject(credential, { projectId: 'library', displayName: 'Library fixture', rootPath: projectRoot, kind: 'library' }); core.enrollLibraryRoute(credential, { projectId: 'library', route: 'gotzji-library' });
    const channel = new ProductLibraryChannel({ directory, ownerId: 'owner', primaryCredential: credential, core, version: '5.7.3', allowWork: (): boolean => true, protector: { protect: async (value): Promise<string> => value, unprotect: async (value): Promise<string> => value } });
    try {
      const status = await channel.enroll('library'); expect(JSON.stringify(status)).not.toContain(credential);
      const state = JSON.parse(JSON.parse(readFileSync(path.join(directory, 'product-lnwjud-library.sealed.json'), 'utf8')).payload) as { credential: string; mcpPathSecret: string; projectIds: string[] };
      expect(state.credential).not.toBe(credential); expect(state.projectIds).toEqual(['library']);
      const endpoint = JSON.parse(JSON.parse(readFileSync(path.join(directory, 'product-lnwjud-library-endpoint.json'), 'utf8')).body) as { port: number };
      type Reply = { result: { serverInfo?: { name: string }; tools?: { name: string; inputSchema: { oneOf: { properties: { operation: { const: string } } }[] } }[]; isError?: boolean; content?: { text: string }[] } };
      const call = async (method: string, params?: unknown): Promise<Reply> => (await (await fetch(`http://127.0.0.1:${endpoint.port}/mcp/${state.mcpPathSecret}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }) })).json()) as Reply;
      const initialize = await call('initialize'); expect(initialize.result.serverInfo!.name).toBe('gotzji-lnwjud-library');
      const health = await call('tools/call', { name: 'gotzji_health', arguments: {} }); expect(JSON.parse(health.result.content![0]!.text).authorityId).toBe(core.authority().authorityId);
      const listed = await call('tools/list'); const prepare = listed.result.tools!.find((entry) => entry.name === 'gotzji_prepare_operation')!;
      expect(prepare.inputSchema.oneOf).toHaveLength(libraryCatalog().length); expect(prepare.inputSchema.oneOf.every((entry: { properties: { operation: { const: string } } }) => entry.properties.operation.const === 'library.workflow')).toBe(true);
      const prepared = await call('tools/call', { name: 'gotzji_prepare_operation', arguments: { requestId: 'library-read', projectId: 'library', operation: 'library.workflow', workflowId: 'library.read', workflowVersion: 1, parameters: { paths: '["source.txt"]' } } }); expect(prepared.result.isError).toBe(false);
      const denied = await call('tools/call', { name: 'gotzji_prepare_operation', arguments: { requestId: 'native-forged', projectId: 'library', operation: 'file.read', path: 'source.txt' } }); expect(denied.result.isError).toBe(true);
      const primaryPreparation = core.prepareOperation(credential, { requestId: 'primary-file', projectId: 'library', operation: 'file.read', path: 'source.txt' });
      const foreignSubmit = await call('tools/call', { name: 'gotzji_submit', arguments: { preparationId: primaryPreparation.preparationId } }); expect(foreignSubmit.result.isError).toBe(true);
      expect(await core.list(credential)).toEqual([]); expect(await core.list(state.credential)).toEqual([]);
    } finally { await channel.close(); core.close(); }
  });
});
