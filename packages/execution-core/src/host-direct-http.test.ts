import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { testOnlyProductSecretProtector, writeProductConfiguration } from './product-host.js';
import { childEnvironment } from './product-security.mjs';
import { hash, type WorkerRow } from './store.js';
import { observeWorker, signed } from './managed-worker.js';

describe('ChatGPT production controller through real HTTP and durable worker', () => {
  it('writes, reads and runs the reviewed command without any usable Claude installation', async () => {
    const root = await canonicalTemporaryDirectory('gotzji-controller-http-');
    const directory = path.join(root, 'private', 'runtime'); const project = path.join(root, 'project');
    const libraryRoot = path.join(directory, 'workspace');
    await mkdir(project); ensureProductControlDocuments(libraryRoot);
    await writeFile(path.join(project, 'source.js'), 'export const proof = 42;\n');
    const config = { schemaVersion: 1 as const, directory, ownerId: 'controller-fixture', daemonSecret: 'a'.repeat(64), mcpPathSecret: 'b'.repeat(64), credential: 'c'.repeat(64), executable: path.join(root, 'no-claude-exists.exe'), libraryRoot };
    await writeProductConfiguration(config, testOnlyProductSecretProtector());
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/product-server.mjs', import.meta.url)), directory, '--test-only-insecure-secret-protector'], { env: childEnvironment(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const exited = once(child, 'exit'); let endpoint = ''; let workers: WorkerRow[] = [];
    const rpc = async (method: string, input: object = {}): Promise<Record<string, unknown>> => (await (await fetch(`${endpoint}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${config.daemonSecret}` }, body: JSON.stringify({ method, input }) })).json());
    const tool = async (name: string, input: object): Promise<Record<string, unknown>> => {
      const value = await (await fetch(`${endpoint}/mcp/${config.mcpPathSecret}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) })).json() as { result: { isError?: boolean; content: { text: string }[] } };
      if (value.result.isError) throw new Error(value.result.content[0]!.text); return JSON.parse(value.result.content[0]!.text);
    };
    try {
      for (let n = 0; n < 160; n++) {
        if (child.exitCode !== null) throw new Error(`Owned product host failed: ${stderr}`);
        try { endpoint = `http://127.0.0.1:${JSON.parse(JSON.parse(await readFile(path.join(directory, 'product-endpoint.json'), 'utf8')).body).port}`; break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      expect(endpoint).not.toBe(''); expect(((await rpc('health')).value as { controller: string }).controller).toBe('chatgpt-plugin');
      expect(await rpc('registerRecipe', { recipeId: 'synthetic-check', executable: process.execPath, args: ['--check', '${projectRoot}/source.js'], dependencies: ['${projectRoot}/source.js'], timeoutMs: 10000 })).toMatchObject({ ok: true });
      expect(await rpc('registerRecipe', { recipeId: 'synthetic-delivery', executable: process.execPath, args: ['--check', '${projectRoot}/source.js'], dependencies: ['${projectRoot}/source.js'], timeoutMs: 10000, delivery: true })).toMatchObject({ ok: true });
      expect(await rpc('registerProject', { projectId: 'project', displayName: 'Synthetic', rootPath: project, recipeIds: ['synthetic-check', 'synthetic-delivery'] })).toMatchObject({ ok: true });
      const execute = async (input: object): Promise<Record<string, unknown>> => {
        const preparation = await tool('gotzji_prepare_operation', input);
        const job = await tool('gotzji_submit', { preparationId: preparation.preparationId });
        for (let n = 0; n < 160; n++) {
          const status = await tool('gotzji_status', { jobId: job.jobId });
          if (status.status === 'completed') return { job, preparation, result: await tool('gotzji_result', { jobId: job.jobId }) };
          if (status.status === 'failed' || status.blockerCode) throw new Error(JSON.stringify(status));
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('DIRECT_JOB_DID_NOT_FINISH');
      };
      const write = { requestId: 'fresh-direct-write', projectId: 'project', operation: 'file.write', path: 'proof.txt', expectedSha256: null, content: 'Synthetic direct proof\n' };
      const written = await execute(write); expect(await readFile(path.join(project, 'proof.txt'), 'utf8')).toBe(write.content);
      expect((await tool('gotzji_submit', { preparationId: (written.preparation as { preparationId: string }).preparationId })).jobId).toBe((written.job as { jobId: string }).jobId);
      expect(await tool('gotzji_prepare_operation', write)).toMatchObject({ digest: (written.preparation as { digest: string }).digest });
      await execute({ requestId: 'fresh-direct-read', projectId: 'project', operation: 'file.read', path: 'proof.txt' });
      await execute({ requestId: 'fresh-direct-command', projectId: 'project', operation: 'command.run', commandId: 'synthetic-check' });
      expect(await tool('gotzji_read_file', { projectId: 'project', path: 'proof.txt' })).toMatchObject({ content: write.content, sha256: hash(write.content) });
      const appPreparation = await rpc('prepareOperation', { requestId: 'fresh-app-direct-read', projectId: 'project', operation: 'file.read', path: 'proof.txt' });
      expect(appPreparation).toMatchObject({ ok: false, error: { code: 'CHATGPT_START_REQUIRED' } });
      expect(await rpc('submit', { preparationId: (written.preparation as { preparationId: string }).preparationId })).toMatchObject({ ok: false, error: { code: 'CHATGPT_START_REQUIRED' } });
      await expect(tool('gotzji_prepare_operation', { requestId: 'delivery-not-granted', projectId: 'project', operation: 'command.run', commandId: 'synthetic-delivery' })).rejects.toThrow('DELIVERY_OWNER_ONLY');
      expect(await rpc('status', { jobId: (written.job as { jobId: string }).jobId })).toMatchObject({ ok: true, value: { status: 'completed' } });
      expect(await tool('gotzji_select_project', { projectId: 'project' })).toMatchObject({ projectId: 'project' });
      expect(await rpc('selectedProject')).toMatchObject({ ok: true, value: { projectId: 'project' } });
      expect(await tool('gotzji_save_project_memory', { projectId: 'project', expectedRevision: 0, memory: { summary: 'Verified local protocol fixture', decisions: ['ChatGPT starts work'], openQuestions: [], resultPaths: ['proof.txt'] } })).toMatchObject({ revision: 1 });
      expect(await tool('gotzji_project_context', {})).toMatchObject({ project: { projectId: 'project' }, memory: { revision: 1, summary: 'Verified local protocol fixture' } });
      const database = new DatabaseSync(path.join(directory, 'core.sqlite'), { readOnly: true });
      try { workers = [...database.prepare('SELECT * FROM gotzji_workers').all() as unknown as WorkerRow[], ...database.prepare('SELECT worker_json FROM gotzji_worker_history').all().map(row => JSON.parse(String(row.worker_json)) as WorkerRow)]; }
      finally { database.close(); }
      workers = [...new Map(workers.map(worker => [worker.epoch, worker])).values()];
      expect(workers).toHaveLength(3);
      for (const worker of workers) {
        expect(existsSync(path.join(worker.directory, 'claude-events.jsonl'))).toBe(false);
        expect(existsSync(path.join(worker.directory, 'grace-runtime.json'))).toBe(false);
        expect(signed<{ mode: string; generation: number; jobId: string; brokerReceipts: unknown[] }>(worker, 'controller-runtime.json')).toMatchObject({ executor: 'host-direct', mode: 'host-direct', generation: worker.generation, jobId: worker.job_id, brokerReceipts: expect.any(Array) });
        expect(JSON.parse(readFileSync(path.join(worker.directory, 'config.json'), 'utf8')).grace.executable).toBeUndefined();
      }
    } finally {
      if (endpoint && child.exitCode === null) await rpc('testOnlyE2eShutdown', { nonce: 'd'.repeat(64) });
      if (child.exitCode === null) await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
      if (child.exitCode === null) { child.kill(); await exited; }
      expect(() => process.kill(child.pid!, 0)).toThrow();
      for (const worker of workers) expect(await observeWorker(worker)).toBe('absent');
      const resolved = path.resolve(root); expect(path.basename(resolved)).toMatch(/^gotzji-controller-http-/u);
      await rm(resolved, { recursive: true, force: true });
    }
  }, 60000);
});
