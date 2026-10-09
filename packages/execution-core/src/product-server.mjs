/* global process, URL, setImmediate */
import path from 'node:path';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ExecutionCore } from './core.js';
import { CoreError } from './types.js';
import { cleanupProductHostStartup, completeProductHostStartup, observeProductHostAuthorityPersistence, productConfigurationIdentity, productRuntimeIdentity, productRuntimeRequiresManifest, readProductConfiguration, testOnlyProductSecretProtector, writeProductConfiguration } from './product-host.js';
import { startProductHttp } from './product-http.js';
import { GotzjiConnectionService } from './product-connection.js';
import { ProductBrowserService, productBrowserPrerequisite } from './product-browser-service.js';
import { ProductLibraryChannel } from './product-library-channel.js';
import { acquireProductHostOwnership } from './product-host-ownership.mjs';
import { UNPACKAGED_E2E_PROCESS_BIRTH } from './process-identity.mjs';

const directory = path.resolve(process.argv[2]);
const entry = fileURLToPath(import.meta.url);
const packagedRuntime = productRuntimeRequiresManifest(entry, process.argv);
const testSecretFixture = process.argv.includes('--test-only-insecure-secret-protector');
if (packagedRuntime && testSecretFixture) throw new CoreError('PRODUCT_TEST_SECRET_PROVIDER_DENIED');
const runtimeOptions = { requireManifest: packagedRuntime };
const buildIdentity = productRuntimeIdentity(entry, runtimeOptions);
const manifestPath = path.join(path.dirname(entry), 'product-runtime-manifest.json');
const testSecretProtector = testSecretFixture ? testOnlyProductSecretProtector() : undefined;
let config = await readProductConfiguration(directory, testSecretProtector);
const testIdentityReader = testSecretFixture ? async (pids) => Object.fromEntries(pids.map((pid) => [pid, pid === process.pid ? { birth: UNPACKAGED_E2E_PROCESS_BIRTH, executable: realpathSync(process.execPath) } : 'unknown'])) : undefined;
const ownership = await acquireProductHostOwnership(directory, config.daemonSecret, testIdentityReader);
if (ownership.status !== 'acquired') {
  const incident = { schemaVersion: 1, product: 'gotzji', phase: 'ownership-denied', status: ownership.status, reason: ownership.reason, recordedAt: new Date().toISOString() };
  writeFileSync(path.join(directory, 'product-ownership-incident.json'), JSON.stringify(incident), { mode: 0o600 });
  process.stderr.write(JSON.stringify({ code: ownership.status === 'owned' ? 'PRODUCT_HOST_OWNER_ACTIVE' : 'PRODUCT_HOST_OWNER_UNKNOWN', layer: 'host-ownership' }) + '\n');
  process.exit(0);
}
process.once('exit', () => ownership.release());
if (!config.credential) {
  config = { ...config, credential: randomBytes(32).toString('hex') };
  await writeProductConfiguration(config, testSecretProtector);
}
const product = { executable: config.executable, libraryRoot: config.libraryRoot };
const nativeOptions = config.native ? { ...config.native, operations: ['excel.range.read', 'excel.range.write', 'word.paragraph.read', 'word.paragraph.write', 'powerpoint.shape.read', 'powerpoint.shape.write', ...(config.native.cad ? ['cad.entity.inspect', 'cad.entity.move'] : [])] } : undefined;
const libraryOptions = config.library;
const privateRuntimeRoots = [path.dirname(directory)];
let core;
let startupControlOnly = false;
try { core = await ExecutionCore.open(directory, { product, nativeOptions, libraryOptions, privateRuntimeRoots }); }
catch (error) {
  if (error?.code !== 'CORE_VERSION_OR_POLICY_CHANGED') throw error;
  // A sealed successful predecessor plus the anchored ledger authorizes only
  // quiescent profile migration. Unknown/live effects remain control-only.
  try {
    if (!config.authority) throw new CoreError('PRODUCT_UPGRADE_AUTHORITY_REQUIRED');
    core = await ExecutionCore.open(directory, { product, nativeOptions, libraryOptions, privateRuntimeRoots, upgrade: { expectedPolicy: config.authority.policy, expectedAuthorityId: config.authority.authorityId } });
  } catch {
    core = await ExecutionCore.openForControl(directory); startupControlOnly = true;
  }
}
if (!startupControlOnly) core.ensureAdapterEnrollment('gotzji-product', config.ownerId, config.credential);
else core.list(config.credential); // Verify the retained owner credential before exposing controls.
let authorityPersistence;
if (!startupControlOnly) {
  config = { ...config, authority: core.authority() };
  // CurrentUser DPAPI runs in a separate Windows PowerShell session. Let the independent
  // catalog/listener setup proceed while it seals the upgrade anchor, but do
  // not publish readiness until the durable write has succeeded.
  authorityPersistence = observeProductHostAuthorityPersistence(writeProductConfiguration(config, testSecretProtector));
}
const credential = config.credential;
// Fixed server-owned recipe; caller/project IPC cannot enroll executables or args.
if (!startupControlOnly) core.registerReviewedCommand(credential, { recipeId: 'node-check', displayName: 'Check selected project source.js syntax', executable: process.execPath, args: ['--check', '${projectRoot}/source.js'], dependencies: ['${projectRoot}/source.js'], timeoutMs: 120000 });
if (!startupControlOnly) {
  const projectScript = fileURLToPath(new URL('./product-project-script.mjs', import.meta.url));
  const corepackScript = [
    ...(process.platform === 'win32' ? [] : [path.join(path.dirname(process.execPath), 'corepack')]),
    path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ].map((candidate) => {
    try {
      const resolved = realpathSync(candidate);
      const info = lstatSync(resolved);
      return info.isFile() && !info.isSymbolicLink() ? resolved : undefined;
    } catch { return undefined; }
  }).find((candidate) => candidate !== undefined);
  if (corepackScript) for (const scriptName of ['build', 'test', 'lint', 'typecheck']) core.registerReviewedCommand(credential, {
    recipeId: `pnpm-${scriptName}`, displayName: `Run the selected project's reviewed pnpm ${scriptName} script`, executable: process.execPath,
    args: [projectScript, corepackScript, '${projectRoot}/package.json', scriptName], dependencies: [projectScript, corepackScript, '${projectRoot}/package.json'], timeoutMs: scriptName === 'test' ? 7_200_000 : 1_800_000,
  });
}
const configurationIdentity = productConfigurationIdentity(config);
const runtimeVersion = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).version : 'development';
const allowCurrentWork = () => { try { return !startupControlOnly && productRuntimeIdentity(entry, runtimeOptions) === buildIdentity; } catch { return false; } };
const controls = new Set(['health', 'list', 'inspectQueue', 'status', 'logs', 'result', 'cancel', 'settleJob', 'connectionStatus', 'stopConnection', 'browserSession', 'stopBrowserSession', 'libraryChannelStatus', 'stopLibraryConnection', ...(testSecretFixture ? ['testOnlyE2eShutdown'] : [])]);
let connection;
const browser = config.browser && !startupControlOnly ? new ProductBrowserService({ directory, ownerId: config.ownerId, credential, core, ...config.browser, prerequisite: productBrowserPrerequisite(path.join(path.dirname(entry), 'product-browser-broker.mjs')) }) : undefined;
const libraryChannel = new ProductLibraryChannel({ directory, ownerId: config.ownerId, primaryCredential: credential, core, version: runtimeVersion, allowWork: allowCurrentWork, ...(config.tunnel ? { tunnel: config.tunnel } : {}) });
const binding = (input) => {
  if (typeof input.jobId !== 'string' || !input.jobId) throw new CoreError('JOB_ID_REQUIRED');
  return core.select(credential, input.jobId);
};
const listener = await startProductHttp({ token: config.daemonSecret, mcpPathSecret: config.mcpPathSecret, version: runtimeVersion, rpc: async (method, input, surface, expectedBuild) => {
  let currentBuild = false;
  try { currentBuild = !startupControlOnly && productRuntimeIdentity(entry, runtimeOptions) === buildIdentity && (!expectedBuild || expectedBuild === buildIdentity); } catch { /* Reconciliation keeps authenticated controls available. */ }
  if (!currentBuild && !controls.has(method)) throw new CoreError('PRODUCT_BUILD_RECONCILIATION_REQUIRED');
  if (['owner', 'ownerId', 'credential', 'token', 'adapterId', ...(method === 'prepareOperation' && ['cad.entity.inspect', 'cad.entity.move'].includes(input.operation) ? [] : ['handle'])].some((key) => key in input)) throw new CoreError('CALLER_AUTHORITY_DENIED');
  switch (method) {
    case 'enrollLibraryChannel': if (surface !== 'app') throw new CoreError('LIBRARY_CHANNEL_ENROLLMENT_DENIED'); return libraryChannel.enroll(input.projectId);
    case 'libraryChannelStatus': if (surface !== 'app') throw new CoreError('LIBRARY_CHANNEL_ENROLLMENT_DENIED'); return libraryChannel.status();
    case 'configureLibraryConnection': if (surface !== 'app') throw new CoreError('LIBRARY_CHANNEL_ENROLLMENT_DENIED'); return libraryChannel.configure(input);
    case 'startLibraryConnection': if (surface !== 'app') throw new CoreError('LIBRARY_CHANNEL_ENROLLMENT_DENIED'); return libraryChannel.start();
    case 'stopLibraryConnection': if (surface !== 'app') throw new CoreError('LIBRARY_CHANNEL_ENROLLMENT_DENIED'); return libraryChannel.stop();
    case 'startBrowserSession': if (surface !== 'app' || !browser) throw new CoreError('BROWSER_ENROLLMENT_DENIED'); return browser.start(input);
    case 'browserSession': if (surface !== 'app') throw new CoreError('BROWSER_ENROLLMENT_DENIED'); return browser ? browser.inspect(input.projectId) : { state: 'unavailable', reason: 'BROWSER_PROVIDER_NOT_CONFIGURED' };
    case 'stopBrowserSession': if (surface !== 'app' || !browser) throw new CoreError('BROWSER_ENROLLMENT_DENIED'); return browser.stop(input.projectId);
    case 'authorizeLibraryDelivery': if (surface !== 'app') throw new CoreError('LIBRARY_DELIVERY_SCOPE_DENIED'); return { authorized: true, scope: input.scope, authorityDigest: core.authorizeLibraryDelivery(credential, core.selectLibraryJob(credential, input.projectId, input.jobId), input.scope) };
    case 'connectionStatus': if (surface !== 'app') throw new CoreError('CONNECTION_CONTROL_DENIED'); return connection ? connection.status() : { state: 'unavailable', configured: false, transport: 'openai-secure-mcp-tunnel', errorCode: 'CONNECTION_CLIENT_NOT_BUNDLED' };
    case 'configureConnection': if (surface !== 'app' || !connection) throw new CoreError('CONNECTION_CONTROL_DENIED'); return connection.configure(input);
    case 'startConnection': if (surface !== 'app' || !connection) throw new CoreError('CONNECTION_CONTROL_DENIED'); return connection.start();
    case 'stopConnection': if (surface !== 'app' || !connection) throw new CoreError('CONNECTION_CONTROL_DENIED'); return connection.stop();
    case 'health': return { product: 'gotzji', ownerId: config.ownerId, state: currentBuild ? 'ready' : 'control-only', controller: 'grace', automaticUpdates: false, buildIdentity, configurationIdentity };
    case 'testOnlyE2eShutdown': {
      if (!testSecretFixture || surface !== 'app' || typeof input.nonce !== 'string' || !/^[a-f0-9]{64}$/u.test(input.nonce) || Object.keys(input).length !== 1) throw new CoreError('METHOD_DENIED');
      setImmediate(() => { void cleanupProductHostStartup(() => listener.close(), () => core.close(), () => ownership.release()).finally(() => process.exit(0)); });
      return { accepted: true, nonce: input.nonce };
    }
    case 'registerProject': { if (surface !== 'app') throw new CoreError('PROJECT_REGISTRATION_DENIED'); const project = core.registerProject(credential, input); if (project.kind === 'library') core.enrollLibraryRoute(credential, { projectId: project.projectId, route: 'gotzji-library' }); return project; }
    case 'listProjects': return core.listProjects(credential).map((project) => ({ ...project, recipeIds: core.projectRecipeIds(credential, project) }));
    case 'registerRecipe': { if (surface !== 'app') throw new CoreError('RECIPE_REGISTRATION_DENIED'); const entry = core.registerReviewedCommand(credential, input); return { ...entry, review: core.recipeReview(credential, entry.recipeId) }; }
    case 'bindProjectRecipe': if (surface !== 'app') throw new CoreError('RECIPE_REGISTRATION_DENIED'); return core.bindProjectRecipe(credential, input);
    case 'catalog': { const session = browser?.projection(); return core.catalog(credential).map((entry) => entry.name.startsWith('browser.') && session?.state === 'ready' ? { ...entry, browserSession: session } : entry); }
    // Only the owner's app may start a delivery command (incident I5); every other surface prepares as Grace.
    case 'prepareOperation': return core.prepareOperation(credential, input, { ownerRun: surface === 'app' });
    case 'submit': return core.submit(credential, input.preparationId);
    case 'list': return core.list(credential);
    case 'inspectQueue': return core.inspectQueue(credential);
    case 'reprioritize': return core.reprioritize(credential, input);
    case 'status': return core.get(credential, binding(input));
    case 'logs': return core.logs(credential, binding(input), input.cursor ?? 0, input.limit ?? 4000);
    case 'result': return core.readOperationResult(credential, binding(input));
    case 'cancel': return core.cancel(credential, binding(input));
    case 'settleJob': if (surface !== 'app') throw new CoreError('JOB_SETTLEMENT_DENIED'); return core.settleBlockedJob(credential, binding(input), input.decision);
    case 'resume': return core.resume(credential, binding(input));
    default: throw new CoreError('METHOD_DENIED');
  }
} });
if (config.tunnel) connection = new GotzjiConnectionService({ directory, ownerId: config.ownerId, ...config.tunnel, mcpTarget: () => `http://127.0.0.1:${listener.port}/mcp/${config.mcpPathSecret}` });
const body = JSON.stringify({ port: listener.port, pid: process.pid, identity: { birth: ownership.birth, executable: ownership.executable }, ownerId: config.ownerId, buildIdentity, configurationIdentity });
await completeProductHostStartup(authorityPersistence, () => { if (!startupControlOnly) core.startSupervisor(); }, () => {
  writeFileSync(path.join(directory, 'product-endpoint.json'), JSON.stringify({ body, mac: createHmac('sha256', config.daemonSecret).update(body).digest('hex') }), { mode: 0o600 });
}, () => cleanupProductHostStartup(() => listener.close(), () => core.close(), () => ownership.release()));
if (connection && !startupControlOnly) void connection.restore();
if (browser) void browser.restore().catch(() => { /* Unknown native ownership remains unavailable; no ambient adoption. */ });
void libraryChannel.restore().catch(() => { /* Retained channel authority is inspected; no stock-profile fallback. */ });
// A normal window close never sends this signal. Explicit host shutdown leaves
// durable jobs for inspected ownership/effect recovery, rather than replaying.
process.once('SIGTERM', () => { void listener.close().then(() => { core.close(); process.exit(0); }); });
