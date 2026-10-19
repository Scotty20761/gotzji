import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalTemporaryDirectory } from './test-fixtures.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { testOnlyProductSecretProtector, writeProductConfiguration } from './product-host.js';
import { childEnvironment } from './product-security.mjs';

describe('direct reads through the actual product server', () => {
  it('serves all three MCP tools without starting a Grace job', async ({ signal }) => {
    const root = await canonicalTemporaryDirectory('gotzji-direct-http-');
    const directory = path.join(root, 'private', 'runtime');
    const project = path.join(root, 'project');
    const libraryRoot = path.join(directory, 'workspace');
    await mkdir(project);
    ensureProductControlDocuments(libraryRoot);
    await writeFile(path.join(project, 'note.txt'), 'hello\n');
    for (let index = 1; index <= 20; index++) await writeFile(path.join(project, `note-${String(index).padStart(2, '0')}.txt`), Array.from({ length: 40 }, (_, line) => `Synthetic fixture ${index}, line ${line + 1}: alpha beta gamma delta epsilon.`).join('\n') + '\n');
    const config = { schemaVersion: 1 as const, directory, ownerId: 'synthetic-owner', daemonSecret: 'a'.repeat(64), mcpPathSecret: 'b'.repeat(64), credential: 'c'.repeat(64), executable: process.execPath, libraryRoot };
    await writeProductConfiguration(config, testOnlyProductSecretProtector());
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/product-server.mjs', import.meta.url)), directory, '--test-only-insecure-secret-protector'], { env: childEnvironment(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const exited = once(child, 'exit');
    let endpoint = '';
    try {
      endpoint = await new Promise<string>((resolve, reject) => {
        let settled = false;
        let reading = false;
        let dirty = false;
        const finish = (error?: Error, value?: string): void => {
          if (settled) return;
          settled = true; watcher.close(); child.off('exit', failed); signal.removeEventListener('abort', aborted);
          if (error) reject(error); else resolve(value!);
        };
        const failed = (): void => finish(new Error(`Owned host exited before endpoint publication: ${stderr}`));
        const aborted = (): void => finish(new Error(`Owned host did not publish readiness before the existing test deadline: ${stderr}`));
        const inspect = async (): Promise<void> => {
          if (settled) return;
          if (reading) { dirty = true; return; }
          reading = true;
          try {
            const envelope = JSON.parse(await readFile(path.join(directory, 'product-endpoint.json'), 'utf8')) as { body: string };
            const value = JSON.parse(envelope.body) as { port: number; pid: number; ownerId: string };
            if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || value.pid !== child.pid || value.ownerId !== config.ownerId) throw new Error('Owned endpoint identity mismatch');
            finish(undefined, `http://127.0.0.1:${value.port}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) finish(error instanceof Error ? error : new Error(String(error)));
          } finally { reading = false; if (dirty && !settled) { dirty = false; void inspect(); } }
        };
        const watcher = watch(directory, () => { void inspect(); });
        watcher.once('error', (error) => finish(error));
        child.once('exit', failed); signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted(); else if (child.exitCode !== null) failed(); else void inspect();
      });
      const rpc = async (method: string, input: object): Promise<{ ok: boolean; value: unknown }> => (await (await fetch(`${endpoint}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${config.daemonSecret}` }, body: JSON.stringify({ method, input }) })).json()) as { ok: boolean; value: unknown };
      const tool = async (name: string, input: object): Promise<{ result: { isError: boolean; structuredContent?: unknown; content: { text: string }[] } }> => (await (await fetch(`${endpoint}/mcp/${config.mcpPathSecret}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) })).json()) as { result: { isError: boolean; structuredContent?: unknown; content: { text: string }[] } };
      expect((await rpc('registerProject', { projectId: 'project', displayName: 'Synthetic', rootPath: project })).ok).toBe(true);
      const read = await tool('gotzji_read_file', { projectId: 'project', path: 'note.txt' });
      expect(read.result.isError).toBe(false);
      expect(JSON.parse(read.result.content[0]!.text)).toMatchObject({ content: 'hello\n', sha256: '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03' });
      expect(read.result.structuredContent).toEqual(JSON.parse(read.result.content[0]!.text));
      expect((await tool('gotzji_list_files', { projectId: 'project' })).result.isError).toBe(false);
      expect((await tool('gotzji_search_files', { projectId: 'project', query: 'hello' })).result.isError).toBe(false);
      const readTimes: number[] = [];
      for (let index = 1; index <= 20; index++) {
        const started = performance.now();
        const observed = await tool('gotzji_read_file', { projectId: 'project', path: `note-${String(index).padStart(2, '0')}.txt` });
        readTimes.push(performance.now() - started);
        expect(observed.result.isError).toBe(false);
        expect(JSON.parse(observed.result.content[0]!.text).content).toContain(`Synthetic fixture ${index}, line 1:`);
      }
      if (process.env.GOTZJI_READ_BENCH_RESULT) {
        const sorted = [...readTimes].sort((a, b) => a - b);
        await writeFile(process.env.GOTZJI_READ_BENCH_RESULT, JSON.stringify({ route: 'actual-product-server-MCP', samples: 20, medianMs: (sorted[9]! + sorted[10]!) / 2, p95Ms: sorted[18], timesMs: readTimes, jobs: (await rpc('list', {})).value }, null, 2));
      }
      await link(path.join(directory, 'product-host.sealed.json'), path.join(project, 'private-alias.json'));
      const denied = await tool('gotzji_read_file', { projectId: 'project', path: 'private-alias.json' });
      expect(denied.result.isError).toBe(true);
      expect(denied.result.structuredContent).toBeUndefined();
      expect(JSON.parse(denied.result.content[0]!.text)).toMatchObject({ error: { code: 'FILE_LINK_SCOPE_DENIED' } });
      expect((await tool('gotzji_prepare_operation', { requestId: 'legacy-alias', projectId: 'project', operation: 'file.read', path: 'private-alias.json' })).result.isError).toBe(true);
      for (const name of ['gotzji_read_file', 'gotzji_list_files', 'gotzji_search_files']) {
        expect((await tool(name, { projectId: 'project', path: 'note.txt', query: 'hello', commandId: 'forged' })).result.isError).toBe(true);
      }
      const catalog = await rpc('catalog', {});
      expect(catalog.value).toEqual(expect.arrayContaining([{ name: 'file.read.direct', state: 'available', description: expect.any(String), controller: 'host' }]));
      expect(await rpc('list', {})).toEqual({ ok: true, value: [] });
    } finally {
      if (endpoint && child.exitCode === null) await fetch(`${endpoint}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${config.daemonSecret}` }, body: JSON.stringify({ method: 'testOnlyE2eShutdown', input: { nonce: 'd'.repeat(64) } }) }).catch(() => undefined);
      if (child.exitCode === null) await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) { child.kill(); await exited; }
      expect(() => process.kill(child.pid!, 0)).toThrow();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});
