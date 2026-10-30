import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import { startProductHttp } from './product-http.js';

describe('project continuation on the existing owner ledger', () => {
  it('shares selection across adapters, isolates owners and projects, and reads current instructions after reopening', async () => {
    const root = await canonicalTemporaryDirectory('gotzji-context-');
    if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith('gotzji-context-')) throw new Error('FIXTURE_SCOPE_DENIED');
    const state = path.join(root, 'state'); const policy = path.join(root, 'policy');
    ensureProductControlDocuments(policy);
    const options = { product: { mode: 'host-direct' as const, libraryRoot: policy } };
    let core = await ExecutionCore.open(state, options);
    let host: Awaited<ReturnType<typeof startProductHttp>> | undefined;
    try {
      const app = core.enrollAdapter('desktop', 'owner'); const chat = core.enrollAdapter('chatgpt', 'owner');
      const foreign = core.enrollAdapter('foreign', 'other-owner');
      for (const projectId of ['alpha', 'beta']) {
        const folder = path.join(root, projectId); await mkdir(folder);
        await writeFile(path.join(folder, 'AGENTS.md'), `Current instructions for ${projectId}`);
        core.registerProject(app, { projectId, displayName: projectId, rootPath: folder });
      }
      expect(core.selectedProject(chat)).toBeNull();
      await expect(core.projectContext(chat)).rejects.toThrow('PROJECT_SELECTION_REQUIRED');
      expect(() => core.selectProject(foreign, 'alpha')).toThrow('PROJECT_NOT_REGISTERED');
      core.selectProject(app, 'alpha');
      expect(core.selectedProject(chat)?.projectId).toBe('alpha');
      const memory = { summary: 'ทำต่อจากงานเดิม', decisions: ['ChatGPT controls work'], openQuestions: ['Check next result'], resultPaths: ['report.md'] };
      expect(core.saveProjectMemory(chat, { projectId: 'alpha', expectedRevision: 0, memory }).revision).toBe(1);
      expect(() => core.saveProjectMemory(chat, { projectId: 'alpha', expectedRevision: 0, memory })).toThrow('PROJECT_MEMORY_CONFLICT');
      expect(() => core.saveProjectMemory(chat, { projectId: 'alpha', expectedRevision: 9, memory })).toThrow('PROJECT_MEMORY_CONFLICT');
      expect(() => core.saveProjectMemory(foreign, { projectId: 'alpha', expectedRevision: 1, memory })).toThrow('PROJECT_NOT_REGISTERED');
      expect((await core.projectContext(chat, 'beta')).memory.revision).toBe(0);
      expect(core.selectedProject(chat)?.projectId).toBe('alpha');
      expect(core.saveProjectMemory(chat, { projectId: 'alpha', expectedRevision: 1, memory: { ...memory, summary: 'new summary' } }).revision).toBe(2);
      core.close(); core = await ExecutionCore.open(state, options);
      await writeFile(path.join(root, 'alpha', 'AGENTS.md'), 'Owner changed instructions');
      const context = await core.projectContext(chat);
      expect(context.project.projectId).toBe('alpha');
      expect(context.memory).toMatchObject({ revision: 2, summary: 'new summary', resultPaths: ['report.md'] });
      expect(context.instructions).toMatchObject([{ path: 'AGENTS.md', content: 'Owner changed instructions' }]);
      expect(context.jobs).toEqual([]); expect(context.historyTruncated).toBe(false);
      expect(await readFile(path.join(root, 'alpha', 'AGENTS.md'), 'utf8')).toBe('Owner changed instructions');

      const calls: string[] = [];
      host = await startProductHttp({ token: 'owner-token', mcpPathSecret: 'context', rpc: async (method, input) => {
        calls.push(method);
        if (method === 'selectProject') return core.selectProject(chat, String(input.projectId));
        if (method === 'projectContext') return core.projectContext(chat, input.projectId as string | undefined);
        if (method === 'saveProjectMemory') return core.saveProjectMemory(chat, input as Parameters<ExecutionCore['saveProjectMemory']>[1]);
        throw new Error('Unexpected method');
      } });
      const call = async (name: string, args: object): Promise<{ isError: boolean; content: { text: string }[] }> => (await (await fetch(`http://127.0.0.1:${host!.port}/mcp/context`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
      expect((await call('gotzji_project_context', {})).isError).toBe(false);
      expect((await call('gotzji_select_project', { projectId: 'beta' })).isError).toBe(false);
      expect(JSON.parse((await call('gotzji_project_context', {})).content[0].text).project.projectId).toBe('beta');
      expect((await call('gotzji_save_project_memory', { projectId: 'beta', expectedRevision: 0, memory: { ...memory, instructions: 'forged' } })).isError).toBe(true);
      expect(calls).toEqual(['projectContext', 'selectProject', 'projectContext']);
      expect(await core.list(chat)).toEqual([]);
    } finally {
      await host?.close(); core.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
