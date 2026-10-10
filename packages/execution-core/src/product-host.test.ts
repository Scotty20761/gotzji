import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanupProductHostStartup, completeProductHostStartup, ensureGotzjiProductHost, observeProductHostAuthorityPersistence, PRODUCT_PROVIDER_SHA256, productRuntimeIdentity, productRuntimeRequiresManifest, readProductConfiguration, reconcileProviderPins, shippedProvider, windowsProductSecretProtector, writeProductConfiguration, type ProductHostConfiguration } from './product-host.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { productGraceProfile } from './grace-profile.js';
import { canonicalTemporaryDirectorySync } from './test-fixtures.js';
import type { WindowsPowerShellSession } from './process-identity.mjs';

const execFileAsync = promisify(execFile);

describe('private product enrollment storage', () => {
  it('publishes no supervisor or endpoint until the durable authority seal succeeds', async () => {
    let resolveSeal!: () => void; let rejectSeal!: (error: Error) => void;
    const events: string[] = [];
    const sealed = observeProductHostAuthorityPersistence(new Promise<void>((resolve, reject) => { resolveSeal = resolve; rejectSeal = reject; }));
    const startup = completeProductHostStartup(sealed, () => events.push('supervisor'), () => events.push('endpoint'));
    await Promise.resolve(); expect(events).toEqual([]);
    resolveSeal(); await startup; expect(events).toEqual(['supervisor', 'endpoint']);

    const denied: string[] = [];
    const failedSeal = observeProductHostAuthorityPersistence(new Promise<void>((_resolve, reject) => { rejectSeal = reject; }));
    rejectSeal(new Error('seal failed'));
    await Promise.resolve();
    const failed = completeProductHostStartup(failedSeal, () => denied.push('supervisor'), () => denied.push('endpoint'), () => denied.push('cleanup'));
    await expect(failed).rejects.toThrow('seal failed'); expect(denied).toEqual(['cleanup']);
  });
  it('releases core and ownership when listener cleanup fails', async () => {
    const events: string[] = [];
    await expect(cleanupProductHostStartup(
      () => { events.push('listener'); throw new Error('listener close failed'); },
      () => events.push('core'),
      () => events.push('ownership'),
    )).rejects.toThrow('listener close failed');
    expect(events).toEqual(['listener', 'core', 'ownership']);

    events.length = 0;
    await expect(cleanupProductHostStartup(
      () => events.push('listener'),
      () => { events.push('core'); throw new Error('core close failed'); },
      () => events.push('ownership'),
    )).rejects.toThrow('core close failed');
    expect(events).toEqual(['listener', 'core', 'ownership']);
  });
  it('retains a redacted startup-exit incident and excludes inherited Node hooks from the daemon', async () => {
    const directory = canonicalTemporaryDirectorySync('gotzji-startup-failure-');
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
  it('re-pins shipped provider scripts on every start and drops only a script present with other bytes (incident I6)', () => {
    const directory = canonicalTemporaryDirectorySync('gotzji-provider-pins-');
    try {
      const office = path.join(directory, 'office.ps1'); const cad = path.join(directory, 'cad.ps1'); const exe = path.join(directory, 'zwcad.exe');
      writeFileSync(office, 'office v2'); writeFileSync(cad, 'cad v2'); writeFileSync(exe, 'zwcad');
      const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
      const base: ProductHostConfiguration = { schemaVersion: 1, directory, ownerId: 'owner', daemonSecret: 'a'.repeat(64), mcpPathSecret: 'b'.repeat(64), executable: exe, libraryRoot: directory };
      const zwcad = { executable: exe, executableSha256: sha('zwcad') };
      const earlier = { ...base, native: { scriptPath: office, scriptSha256: sha('office v1'), cad: { scriptPath: cad, scriptSha256: sha('cad v1'), ...zwcad } } };
      // A new build's scripts replace the older pins; ZWCAD's own pin is kept, not rediscovered.
      const upgraded = reconcileProviderPins(earlier, shippedProvider([office], sha('office v2')), shippedProvider([cad], sha('cad v2')), () => { throw new Error('rediscovered'); });
      expect(upgraded.native).toEqual({ scriptPath: office, scriptSha256: sha('office v2'), cad: { scriptPath: cad, scriptSha256: sha('cad v2'), ...zwcad } });
      expect(reconcileProviderPins(upgraded, shippedProvider([office], sha('office v2')), shippedProvider([cad], sha('cad v2')), () => undefined)).toBe(upgraded);
      // A script present with other bytes drops only its own pin, and the host still starts without that provider.
      expect(shippedProvider([cad], sha('cad v3'))).toBeNull();
      expect(reconcileProviderPins(upgraded, shippedProvider([office], sha('office v2')), null, () => undefined).native).toEqual({ scriptPath: office, scriptSha256: sha('office v2') });
      expect(reconcileProviderPins(upgraded, null, undefined, () => undefined).native).toBeUndefined();
      // An absent or unreadable script keeps the earlier pin.
      expect(shippedProvider([path.join(directory, 'absent.ps1')], sha('x'))).toBeUndefined();
      expect(shippedProvider([directory], sha('x'))).toBeUndefined();
      expect(reconcileProviderPins(upgraded, undefined, undefined, () => undefined)).toBe(upgraded);
      // A first CAD pin also pins ZWCAD.
      expect(reconcileProviderPins({ ...base, native: { scriptPath: office, scriptSha256: sha('office v2') } }, undefined, shippedProvider([cad], sha('cad v2')), () => ({ scriptPath: exe, scriptSha256: sha('zwcad') })).native?.cad)
        .toEqual({ scriptPath: cad, scriptSha256: sha('cad v2'), ...zwcad });
      // An updated ZWCAD is found again when it is the qualified build, and leaves CAD unavailable when it is not.
      writeFileSync(exe, 'zwcad v2');
      expect(reconcileProviderPins(upgraded, undefined, shippedProvider([cad], sha('cad v2')), () => ({ scriptPath: exe, scriptSha256: sha('zwcad v2') })).native?.cad)
        .toEqual({ scriptPath: cad, scriptSha256: sha('cad v2'), executable: exe, executableSha256: sha('zwcad v2') });
      expect(reconcileProviderPins(upgraded, undefined, shippedProvider([cad], sha('cad v2')), () => undefined).native).toEqual({ scriptPath: office, scriptSha256: sha('office v2') });
      // A ZWCAD reinstalled elsewhere is found again.
      const moved = path.join(directory, 'zwcad-moved.exe'); writeFileSync(moved, 'zwcad'); rmSync(exe);
      expect(reconcileProviderPins(upgraded, undefined, shippedProvider([cad], sha('cad v2')), () => ({ scriptPath: moved, scriptSha256: sha('zwcad') })).native?.cad)
        .toEqual({ scriptPath: cad, scriptSha256: sha('cad v2'), executable: moved, executableSha256: sha('zwcad') });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('replaces an earlier provider pin when the provider script on disk changed (incident I6)', async () => {
    const directory = canonicalTemporaryDirectorySync('gotzji-provider-repin-');
    try {
      const script = path.join(directory, 'office.ps1'); writeFileSync(script, 'office v1');
      const protector = { protect: async (value: string): Promise<string> => value, unprotect: async (value: string): Promise<string> => value };
      const options = { directory, dataPath: directory, resourcesPath: directory, packaged: false, nativeScriptPath: script, hostEntryPath: path.join(directory, 'absent-host.mjs'), secretProtector: protector };
      await expect(ensureGotzjiProductHost(options)).rejects.toThrow('PRODUCT_HOST_RUNTIME_MISSING');
      // A new build replaced the script; the next start pins the new bytes instead of keeping the first pin forever.
      writeFileSync(script, 'office v2');
      await expect(ensureGotzjiProductHost(options)).rejects.toThrow('PRODUCT_HOST_RUNTIME_MISSING');
      expect((await readProductConfiguration(directory, protector)).native?.scriptSha256).toBe(createHash('sha256').update('office v2').digest('hex'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('ships the hashes of the provider scripts this build packages', () => {
    const build = fileURLToPath(new URL('../../../apps/desktop/build/', import.meta.url));
    const sha = (name: string): string => createHash('sha256').update(readFileSync(path.join(build, name))).digest('hex');
    expect(PRODUCT_PROVIDER_SHA256).toEqual({ office: sha('gotzji-native-office.ps1'), cad: sha('gotzji-cad-session-provider.ps1') });
  });
  it('shares concurrent app bootstrap and publishes one complete native snapshot before daemon launch', async () => {
    const directory = canonicalTemporaryDirectorySync('gotzji-concurrent-host-');
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
    const directory = canonicalTemporaryDirectorySync('gotzji-config-proof-');
    const config: ProductHostConfiguration = { schemaVersion: 1, directory, ownerId: 'owner', daemonSecret: 'a'.repeat(64), mcpPathSecret: 'b'.repeat(64), executable: path.join(directory, 'claude.exe'), libraryRoot: directory };
    const protector = { protect: async (value: string): Promise<string> => value, unprotect: async (value: string): Promise<string> => value };
    for (const forged of [{ ...config, testRunnerModule: 'caller.mjs' }, { ...config, native: { scriptPath: path.join(directory, 'office.ps1'), scriptSha256: 'c'.repeat(64), testRunnerModule: 'caller.mjs' } }]) {
      await expect(writeProductConfiguration(forged as ProductHostConfiguration, protector)).rejects.toThrow('PRODUCT_CONFIGURATION_INVALID');
    }
  });
  it('rejects the unpackaged E2E secret fixture in packaged startup', async () => {
    const directory = canonicalTemporaryDirectorySync('gotzji-packaged-secret-proof-');
    await expect(ensureGotzjiProductHost({ directory, dataPath: directory, resourcesPath: directory, packaged: true, testOnlyInsecureSecretProtector: true }))
      .rejects.toMatchObject({ code: 'PRODUCT_TEST_SECRET_PROVIDER_DENIED' });
    await expect(ensureGotzjiProductHost({ directory, dataPath: directory, resourcesPath: directory, packaged: true, secretProtector: { protect: async (value) => value, unprotect: async (value) => value } }))
      .rejects.toMatchObject({ code: 'PRODUCT_TEST_SECRET_PROVIDER_DENIED' });
  });
  it('classifies an installed gotzji-core child as packaged without trusting its argv', () => {
    const root = canonicalTemporaryDirectorySync('gotzji-runtime-classification-');
    expect(productRuntimeRequiresManifest(path.join(root, 'gotzji-core', 'product-server.mjs'), [])).toBe(true);
    expect(productRuntimeRequiresManifest(path.join(root, 'dist', 'product-server.mjs'), [])).toBe(false);
    expect(productRuntimeRequiresManifest(path.join(root, 'dist', 'product-server.mjs'), ['--packaged'])).toBe(true);
  });
  it.runIf(process.platform === 'win32')('rejects missing or malformed installed runtime manifests before reading config or opening authority', async () => {
    const compiled = fileURLToPath(new URL('../dist', import.meta.url));
    for (const manifest of ['missing','malformed'] as const) {
      const root = canonicalTemporaryDirectorySync(`gotzji-installed-order-${manifest}-`);
      try {
        const runtime = path.join(root, 'gotzji-core');
        const state = path.join(root, 'state');
        cpSync(compiled, runtime, { recursive: true });
        rmSync(path.join(runtime, 'product-runtime'), { recursive: true, force: true });
        const manifestPath = path.join(runtime, 'product-runtime-manifest.json');
        if (manifest === 'malformed') writeFileSync(manifestPath, '{}\n');
        mkdirSync(state);
        const config: ProductHostConfiguration = { schemaVersion: 1, directory: state, ownerId: 'installed-order-proof', daemonSecret: 'a'.repeat(64), mcpPathSecret: 'b'.repeat(64), executable: process.execPath, libraryRoot: path.join(state, 'workspace'), credential: 'c'.repeat(64) };
        await writeProductConfiguration(config, windowsProductSecretProtector(), true);
        const sealed = readFileSync(path.join(state, 'product-host.sealed.json'));
        await expect(execFileAsync(process.execPath, [path.join(runtime, 'product-server.mjs'), state], { windowsHide: true, timeout: 5000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' } }))
          .rejects.toBeDefined();
        expect(readFileSync(path.join(state, 'product-host.sealed.json'))).toEqual(sealed);
        for (const name of ['core.sqlite','authority.json','daemon-owner.json','product-endpoint.json','product-ownership-incident.json']) expect(existsSync(path.join(state, name))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  it('requires complete exact packaged inventory and rejects missing, empty or extra runtime files', () => {
    const directory = canonicalTemporaryDirectorySync('gotzji-runtime-proof-');
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
    const directory = canonicalTemporaryDirectorySync('gotzji-control-policy-');
    ensureProductControlDocuments(directory);
    const profile = productGraceProfile({ executable: process.execPath, libraryRoot: directory });
    expect(profile.recipe).toBe('product');
    expect(Object.keys(profile.documents)).toEqual(['rules', 'agents', 'workflow', 'index']);
    expect(readFileSync(path.join(directory, 'KNOWLEDGE_INDEX.md'), 'utf8')).toContain('not an Investment Library vault');
    ensureProductControlDocuments(directory);
  });
  it.runIf(process.platform === 'win32')('keeps the secret provider codes and byte encoding over the shared PowerShell session', async () => {
    const fail = (code: string): (() => Promise<string>) => async (): Promise<string> => { throw Object.assign(new Error(code), { code }); };
    const session = (overrides: Partial<WindowsPowerShellSession>): WindowsPowerShellSession => ({ identity: async (): Promise<Record<string, unknown>> => ({}), close: (): void => undefined, protect: async (value: string): Promise<string> => `sealed:${value}`, unprotect: async (value: string): Promise<string> => Buffer.from(value.replace(/^sealed:/u, ''), 'base64').toString('base64'), ...overrides });
    const roundtrip = windowsProductSecretProtector(session({}));
    const sealed = await roundtrip.protect('งานลับ'); expect(sealed).toBe(`sealed:${Buffer.from('งานลับ', 'utf8').toString('base64')}`);
    expect(await roundtrip.unprotect(sealed)).toBe('งานลับ');
    await expect(windowsProductSecretProtector(session({ protect: fail('POWERSHELL_SESSION_TIMEOUT') })).protect('x')).rejects.toMatchObject({ code: 'SECRET_PROVIDER_TIMEOUT' });
    await expect(windowsProductSecretProtector(session({ unprotect: fail('POWERSHELL_SESSION_DENIED') })).unprotect('x')).rejects.toMatchObject({ code: 'SECRET_OWNER_OR_PROVIDER_DENIED' });
    await expect(windowsProductSecretProtector(session({ protect: fail('POWERSHELL_SESSION_EXITED') })).protect('x')).rejects.toMatchObject({ code: 'SECRET_OWNER_OR_PROVIDER_DENIED' });
    for (const [code, expected] of [['POWERSHELL_SESSION_UNAVAILABLE', 'SECRET_PROVIDER_UNAVAILABLE'], ['POWERSHELL_SESSION_INPUT_FAILED', 'SECRET_PROVIDER_INPUT_FAILED'], ['POWERSHELL_SESSION_OUTPUT_LIMIT', 'SECRET_PROVIDER_OUTPUT_LIMIT'], ['POWERSHELL_SESSION_REQUEST_INVALID', 'SECRET_OWNER_OR_PROVIDER_DENIED']] as const) {
      await expect(windowsProductSecretProtector(session({ unprotect: fail(code) })).unprotect('x')).rejects.toMatchObject({ code: expected });
    }
    await expect(windowsProductSecretProtector(session({ protect: async () => 'a'.repeat(64 * 1024 * 2 + 1) })).protect('x')).rejects.toMatchObject({ code: 'SECRET_PROVIDER_OUTPUT_LIMIT' });
    await expect(windowsProductSecretProtector(session({ protect: async () => 42 as unknown as string })).protect('x')).rejects.toMatchObject({ code: 'SECRET_OWNER_OR_PROVIDER_DENIED' });
    await expect(windowsProductSecretProtector(session({})).protect('a'.repeat(64 * 1024 + 1))).rejects.toMatchObject({ code: 'SECRET_PAYLOAD_TOO_LARGE' });
  });
  it.runIf(process.platform === 'win32')('uses actual CurrentUser DPAPI and atomically retains owner/Unicode config without plaintext secrets', async () => {
    const directory = canonicalTemporaryDirectorySync('gotzji-dpapi-');
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
