import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { completeProductHostStartup, ensureGotzjiProductHost, productRuntimeIdentity, readProductConfiguration, windowsProductSecretProtector, writeProductConfiguration, type ProductHostConfiguration } from './product-host.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { productGraceProfile } from './grace-profile.js';

describe('private product enrollment storage', () => {
  it('publishes no supervisor or endpoint until the durable authority seal succeeds', async () => {
    let resolveSeal!: () => void; let rejectSeal!: (error: Error) => void;
    const events: string[] = [];
    const sealed = new Promise<void>((resolve, reject) => { resolveSeal = resolve; rejectSeal = reject; });
    const startup = completeProductHostStartup(sealed, () => events.push('supervisor'), () => events.push('endpoint'));
    await Promise.resolve(); expect(events).toEqual([]);
    resolveSeal(); await startup; expect(events).toEqual(['supervisor', 'endpoint']);

    const denied: string[] = [];
    const failedSeal = new Promise<void>((_resolve, reject) => { rejectSeal = reject; });
    const failed = completeProductHostStartup(failedSeal, () => denied.push('supervisor'), () => denied.push('endpoint'));
    rejectSeal(new Error('seal failed'));
    await expect(failed).rejects.toThrow('seal failed'); expect(denied).toEqual([]);
  });
  it('retains a redacted startup-exit incident and excludes inherited Node hooks from the daemon', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotzji-startup-failure-'));
    const entry = path.join(directory, 'intentional-startup-failure.mjs');
    writeFileSync(entry, "import{readFileSync}from'node:fs';import path from'node:path';const c=JSON.parse(JSON.parse(readFileSync(path.join(process.argv[2],'product-host.sealed.json'),'utf8')).payload);process.stderr.write('password='+c.daemonSecret+'\\nuri=http://127.0.0.1/mcp/'+c.mcpPathSecret+'\\ncredential='+c.credential+'\\nNODE_OPTIONS='+(process.env.NODE_OPTIONS??'absent')+'\\n');process.exit(1);");
    const protector = { protect: async (value: string): Promise<string> => value, unprotect: async (value: string): Promise<string> => value };
    const original = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = '--require deliberately-absent-hook.cjs';
    try {
      await expect(ensureGotzjiProductHost({ directory, dataPath: directory, resourcesPath: directory, packaged: false, executable: process.execPath, hostEntryPath: entry, secretProtector: protector, startupBudgetMs: 2000 })).rejects.toMatchObject({ code: 'PRODUCT_HOST_STARTUP_EXITED', layer: 'host-startup' });
    } finally { if (original === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = original; }
    const config = await readProductConfiguration(directory, protector);
    const incidentFile = readdirSync(directory).find((name) => /^product-startup-.+\.json$/u.test(name));
    expect(incidentFile).toBeDefined();
    const incident = readFileSync(path.join(directory, incidentFile!), 'utf8');
    expect(incident).not.toContain(config.daemonSecret); expect(incident).not.toContain(config.mcpPathSecret); expect(incident).not.toContain(config.credential);
    expect(incident).toContain('NODE_OPTIONS=absent'); expect(incident).toContain('REDACTED');
  });
  it('shares concurrent app bootstrap and publishes one complete native snapshot before daemon launch', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotzji-concurrent-host-'));
    const script = path.join(directory, 'office.ps1'); writeFileSync(script, 'owned native provider');
    const sealed: ProductHostConfiguration[] = [];
    const protector = { protect: async (value: string): Promise<string> => { await new Promise((resolve) => setTimeout(resolve, 15)); sealed.push(JSON.parse(value) as ProductHostConfiguration); return value; }, unprotect: async (value: string): Promise<string> => value };
    const options = { directory, dataPath: directory, resourcesPath: directory, packaged: false, nativeScriptPath: script, hostEntryPath: path.join(directory, 'absent-host.mjs'), secretProtector: protector };
    const calls = [ensureGotzjiProductHost(options), ensureGotzjiProductHost(options), ensureGotzjiProductHost(options)];
    expect(calls[1]).toBe(calls[0]); expect(calls[2]).toBe(calls[0]);
    const results = await Promise.allSettled(calls);
    expect(results.every((result) => result.status === 'rejected' && String(result.reason).includes('PRODUCT_HOST_RUNTIME_MISSING'))).toBe(true);
    expect(sealed).toHaveLength(2); expect(sealed[1]?.credential).toBe(sealed[0]?.credential);
    expect((await readProductConfiguration(directory, protector)).native?.scriptPath).toBe(script);
  });
  it('rejects public-style provider overrides and test runners in sealed product config', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotzji-config-proof-'));
    const config: ProductHostConfiguration = { schemaVersion: 1, directory, ownerId: 'owner', daemonSecret: 'a'.repeat(64), mcpPathSecret: 'b'.repeat(64), executable: path.join(directory, 'claude.exe'), libraryRoot: directory };
    const protector = { protect: async (value: string): Promise<string> => value, unprotect: async (value: string): Promise<string> => value };
    for (const forged of [{ ...config, testRunnerModule: 'caller.mjs' }, { ...config, native: { scriptPath: path.join(directory, 'office.ps1'), scriptSha256: 'c'.repeat(64), testRunnerModule: 'caller.mjs' } }]) {
      await expect(writeProductConfiguration(forged as ProductHostConfiguration, protector)).rejects.toThrow('PRODUCT_CONFIGURATION_INVALID');
    }
  });
  it('requires complete exact packaged inventory and rejects missing, empty or extra runtime files', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotzji-runtime-proof-'));
    const entry = path.join(directory, 'product-server.mjs');
    expect(() => productRuntimeIdentity(entry, { requireManifest: true })).toThrow('PRODUCT_RUNTIME_MANIFEST_REQUIRED');
    const filename = path.join(directory, 'product-runtime-manifest.json');
    const manifest = { schemaVersion: 1, product: 'gotzji', version: '1.0.0', catalogVersion: 1, storeSchemaVersion: 1, entrypoint: 'product-server.mjs', files: [] as { relativePath: string; sizeBytes: number; sha256: string }[] };
    const save = (): void => { writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`); };
    save(); expect(() => productRuntimeIdentity(entry, { requireManifest: true })).toThrow('PRODUCT_RUNTIME_MANIFEST_INVALID');
    for (const relativePath of ['product-server.mjs', 'fixture-worker.mjs', 'product-broker.mjs', 'product-runner.mjs']) {
      const content = `// ${relativePath}\n`; writeFileSync(path.join(directory, relativePath), content);
      manifest.files.push({ relativePath, sizeBytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
    }
    save(); expect(productRuntimeIdentity(entry, { requireManifest: true })).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(path.join(directory, 'foreign.mjs'), '// unexpected');
    expect(() => productRuntimeIdentity(entry, { requireManifest: true })).toThrow('PRODUCT_RUNTIME_INVENTORY_INVALID');
  });
  it('provides a fresh generic product profile without hardcoded user Library files', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotzji-control-policy-'));
    ensureProductControlDocuments(directory);
    const profile = productGraceProfile({ executable: process.execPath, libraryRoot: directory });
    expect(profile.recipe).toBe('product');
    expect(Object.keys(profile.documents)).toEqual(['rules', 'agents', 'workflow', 'index']);
    expect(readFileSync(path.join(directory, 'KNOWLEDGE_INDEX.md'), 'utf8')).toContain('not an Investment Library vault');
    ensureProductControlDocuments(directory);
  });
  it.runIf(process.platform === 'win32')('uses actual CurrentUser DPAPI and atomically retains owner/Unicode config without plaintext secrets', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotzji-dpapi-'));
    const config: ProductHostConfiguration = { schemaVersion: 1, directory, ownerId: 'test-owner', daemonSecret: 'a'.repeat(64), mcpPathSecret: 'b'.repeat(64), executable: path.join(directory, 'claude.exe'), libraryRoot: path.join(directory, 'งานทดสอบ') };
    const protector = windowsProductSecretProtector();
    await writeProductConfiguration(config, protector, true);
    const raw = readFileSync(path.join(directory, 'product-host.sealed.json'), 'utf8');
    expect(raw).not.toContain(config.daemonSecret); expect(raw).not.toContain('test-owner');
    expect(await readProductConfiguration(directory, protector)).toEqual(config);
    await writeProductConfiguration({ ...config, credential: 'c'.repeat(64) }, protector);
    expect((await readProductConfiguration(directory, protector)).credential).toBe('c'.repeat(64));
    await expect(readProductConfiguration(directory, { protect: async () => '', unprotect: async () => { throw new Error('foreign Windows owner'); } })).rejects.toThrow('foreign Windows owner');
  });
});
