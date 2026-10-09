import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CoreError } from './types.js';
import { libraryCatalog } from './product-library.js';

export type ProductRpc = (method: string, input: Record<string, unknown>, surface: 'app' | 'mcp', expectedBuild?: string) => Promise<unknown>;
export const PRODUCT_MCP_TOOLS = [
  { name: 'gotzji_health', method: 'health', readOnly: true, description: 'Inspect the gotzji host control availability. This does not start a model turn.' },
  { name: 'gotzji_projects', method: 'listProjects', readOnly: true, description: 'List projects already enrolled by the owner in the gotzji app.' },
  { name: 'gotzji_tools', method: 'catalog', readOnly: true, description: 'List typed operations and provider readiness.' },
  { name: 'gotzji_prepare_operation', method: 'prepareOperation', readOnly: false, description: 'Prepare a typed Grace-controlled file, reviewed command, native object or registered Library workflow in an enrolled project.' },
  { name: 'gotzji_submit', method: 'submit', readOnly: false, description: 'Submit a prepared request and return its durable job identity promptly.' },
  { name: 'gotzji_jobs', method: 'list', readOnly: true, description: 'List this owner’s jobs; select the intended job explicitly.' },
  { name: 'gotzji_queue', method: 'inspectQueue', readOnly: true, description: 'Inspect queue order and the selected owner’s blocking resources, jobs and dependencies.' },
  { name: 'gotzji_reprioritize', method: 'reprioritize', readOnly: false, description: 'Change a selected waiting job’s priority without preempting active work.' },
  { name: 'gotzji_status', method: 'status', readOnly: true, description: 'Inspect a selected job without starting or repeating work.' },
  { name: 'gotzji_logs', method: 'logs', readOnly: true, description: 'Read a selected job’s bounded paged logs using a cursor.' },
  { name: 'gotzji_result', method: 'result', readOnly: true, description: 'Retrieve verified results for the selected job.' },
  { name: 'gotzji_resume', method: 'resume', readOnly: false, description: 'Inspect and resume a selected admitted job without submitting it again.' },
  { name: 'gotzji_cancel', method: 'cancel', readOnly: false, description: 'Cancel only the explicitly selected owner job and inspect its termination result.' },
] as const;
const ALLOWED_APP_METHODS = new Set(['health', 'registerProject', 'registerRecipe', 'bindProjectRecipe', 'listProjects', 'catalog', 'prepareOperation', 'submit', 'list', 'inspectQueue', 'reprioritize', 'status', 'logs', 'result', 'cancel', 'settleJob', 'resume', 'connectionStatus', 'configureConnection', 'startConnection', 'stopConnection', 'startBrowserSession', 'browserSession', 'stopBrowserSession', 'authorizeLibraryDelivery', 'enrollLibraryChannel', 'libraryChannelStatus', 'configureLibraryConnection', 'startLibraryConnection', 'stopLibraryConnection', 'testOnlyE2eShutdown']);
type Schema = Record<string, unknown>;
const text = { type: 'string', minLength: 1 };
const priority = { type: 'integer', minimum: 0, maximum: 3 };
const objectSchema = (properties: Record<string, Schema>, required: readonly string[]): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const operationFields: Record<string, readonly string[]> = {
  'file.read': ['path'], 'file.write': ['path', 'expectedSha256', 'content'], 'command.run': ['commandId'],
  'excel.range.read': ['path', 'sheet', 'range'], 'excel.range.write': ['path', 'sheet', 'range', 'values', 'outputPath'],
  'word.paragraph.read': ['path', 'paragraph'], 'word.paragraph.write': ['path', 'paragraph', 'text', 'outputPath'],
  'powerpoint.shape.read': ['path', 'slide', 'shape'], 'powerpoint.shape.write': ['path', 'slide', 'shape', 'text', 'outputPath'],
  'cad.entity.inspect': ['path', 'handle'], 'cad.entity.move': ['path', 'handle', 'displacement', 'outputPath'],
};
const fields: Record<string, Schema> = {
  path: text, outputPath: text, expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, content: { type: 'string' }, commandId: text,
  sheet: text, range: text, values: { type: 'array', minItems: 1, items: { type: 'array', minItems: 1, items: { type: ['string', 'number', 'boolean', 'null'] } } },
  paragraph: { type: 'integer', minimum: 1 }, text: { type: 'string' }, slide: { type: 'integer', minimum: 1 }, shape: text, handle: text,
  displacement: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
};
/** One advertised schema is enforced on both app and MCP before core dispatch. */
export function productControlSchema(method: string): Schema {
  if (method === 'testOnlyE2eShutdown') return objectSchema({ nonce: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['nonce']);
  if (method === 'startBrowserSession') return objectSchema({ projectId: text, startUrl: text, allowedOrigins: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: text } }, ['projectId', 'startUrl']);
  if (['browserSession', 'stopBrowserSession'].includes(method)) return objectSchema({ projectId: text }, ['projectId']);
  if (method === 'authorizeLibraryDelivery') return objectSchema({ projectId: text, jobId: text, scope: { type: 'string', enum: ['commit', 'push', 'deploy', 'user-delivery'] } }, ['projectId', 'jobId', 'scope']);
  if (method === 'enrollLibraryChannel') return objectSchema({ projectId: text }, ['projectId']);
  if (['configureConnection', 'configureLibraryConnection'].includes(method)) return objectSchema({ tunnelId: { type: 'string', pattern: '^tunnel_[a-z0-9]{32}$' }, runtimeKey: { type: 'string', minLength: 20, maxLength: 1024 }, organizationId: { type: 'string', pattern: '^org[-_][A-Za-z0-9_-]{1,160}$' } }, ['tunnelId', 'runtimeKey']);
  if (method === 'prepareOperation') {
    const common = {
    requestId: { ...text, pattern: '^[a-zA-Z0-9_-]{1,100}$' }, projectId: { ...text, pattern: '^[a-zA-Z0-9_-]{1,64}$' }, priority,
    dependsOn: { type: 'array', items: { type: 'string', pattern: '^[a-f0-9]{64}$' }, maxItems: 8, uniqueItems: true },
    };
    const basic = Object.entries(operationFields).map(([operation, required]) => objectSchema({ ...common, operation: { type: 'string', const: operation },
    ...Object.fromEntries([...required, ...(operation.startsWith('file.') || operation === 'command.run' ? [] : ['expectedSha256'])].map((field) => [field, fields[field]!])),
    ...(operation === 'file.write' ? { expectedSha256: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' } } : {}),
    }, ['requestId', 'projectId', 'operation', ...required]));
    const step = (operation: string): Schema => objectSchema({ operation: { type: 'string', const: operation }, ...(operation === 'browser.navigate' ? { url: text } : { selector: text }), ...(operation === 'browser.type' ? { text: fields.text! } : operation === 'browser.click' ? { postSelector: text, expectedPostText: fields.text! } : {}) }, ['operation', ...(operation === 'browser.navigate' ? ['url'] : ['selector']), ...(operation === 'browser.type' ? ['text'] : operation === 'browser.click' ? ['postSelector', 'expectedPostText'] : [])]);
    const browser = ['browser.read', 'browser.query', 'browser.type', 'browser.click', 'browser.navigate', 'browser.workflow'].map((operation) => {
      const variant = operation === 'browser.workflow' ? { steps: { type: 'array', minItems: 1, maxItems: 20, items: { oneOf: ['browser.read', 'browser.query', 'browser.type', 'browser.click', 'browser.navigate'].map(step) } } } : (step(operation).properties as Record<string, Schema>);
      return objectSchema({ ...common, operation: { type: 'string', const: operation }, sessionId: text, tabId: text, expectedUrl: text, expectedDocumentId: text, ...variant }, ['requestId', 'projectId', 'operation', 'sessionId', 'tabId', 'expectedUrl', 'expectedDocumentId', ...(operation === 'browser.workflow' ? ['steps'] : (step(operation).required as string[]).filter((key) => key !== 'operation'))]);
    });
    const library = libraryCatalog().map((workflow) => objectSchema({ ...common, operation: { type: 'string', const: 'library.workflow' }, workflowId: { type: 'string', const: workflow.id }, workflowVersion: { type: 'integer', const: workflow.version }, parameters: objectSchema(Object.fromEntries(workflow.allowedParameters.map((field) => [field, field === 'force' ? { type: 'boolean' } : field === 'expectedSha256' ? fields.expectedSha256! : field === 'content' ? fields.content! : text])), workflow.requiredParameters) }, ['requestId', 'projectId', 'operation', 'workflowId', 'workflowVersion', 'parameters']));
    return { oneOf: [...basic, ...browser, ...library] };
  }
  if (method === 'registerProject') return objectSchema({ projectId: { ...text, pattern: '^[a-zA-Z0-9_-]{1,64}$' }, displayName: { ...text, maxLength: 200 }, rootPath: text, kind: { type: 'string', enum: ['project', 'library'] }, recipeIds: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' } } }, ['projectId', 'displayName', 'rootPath']);
  if (method === 'registerRecipe') return objectSchema({ recipeId: { ...text, pattern: '^[a-zA-Z0-9_-]{1,64}$' }, displayName: { ...text, maxLength: 200 }, executable: { ...text, maxLength: 4096 }, args: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 4096 } }, dependencies: { type: 'array', maxItems: 64, items: { ...text, maxLength: 4096 } }, timeoutMs: { type: 'integer', minimum: 100, maximum: 7200000 } }, ['recipeId', 'executable', 'args', 'dependencies']);
  if (method === 'bindProjectRecipe') return objectSchema({ projectId: text, recipeId: { ...text, pattern: '^[a-zA-Z0-9_-]{1,64}$' } }, ['projectId', 'recipeId']);
  if (method === 'submit') return objectSchema({ preparationId: text }, ['preparationId']);
  if (method === 'reprioritize') return objectSchema({ jobId: text, priority }, ['jobId', 'priority']);
  if (['status', 'result', 'cancel', 'resume'].includes(method)) return objectSchema({ jobId: text }, ['jobId']);
  if (method === 'settleJob') return objectSchema({ jobId: text, decision: { type: 'string', enum: ['effect-present', 'no-effect'] } }, ['jobId', 'decision']);
  if (method === 'logs') return objectSchema({ jobId: text, cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8192 } }, ['jobId']);
  return objectSchema({}, []);
}
function accepts(schema: Schema, value: unknown): boolean {
  if (Array.isArray(schema.oneOf)) return schema.oneOf.filter((variant: Schema) => accepts(variant, value)).length === 1;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  const matches = (type: string): boolean => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? record(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (Array.isArray(schema.type) ? !schema.type.some(matches) : typeof schema.type === 'string' && !matches(schema.type)) return false;
  if (typeof value === 'string' && (typeof schema.minLength === 'number' && value.length < schema.minLength || typeof schema.maxLength === 'number' && value.length > schema.maxLength || typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value))) return false;
  if (typeof value === 'number' && (typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum)) return false;
  if (Array.isArray(value) && (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems || schema.uniqueItems === true && new Set(value.map((item: unknown) => JSON.stringify(item))).size !== value.length || record(schema.items) && !value.every((item: unknown) => accepts(schema.items as Schema, item)))) return false;
  if (record(value) && record(schema.properties)) {
    const properties = schema.properties as Record<string, Schema>;
    if (Array.isArray(schema.required) && schema.required.some((key: string) => !Object.hasOwn(value, key))) return false;
    if (Object.entries(value).some(([key, item]) => !Object.hasOwn(properties, key) ? schema.additionalProperties === false : !accepts(properties[key]!, item))) return false;
  }
  return true;
}
function assertInput(method: string, input: Record<string, unknown>): void { if (!accepts(productControlSchema(method), input)) throw new CoreError('PRODUCT_SCHEMA_INVALID'); }
function secretEqual(expected: string, observed: string | undefined): boolean { const a = Buffer.from(expected); const b = Buffer.from(observed ?? ''); return a.length === b.length && timingSafeEqual(a, b); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeError(error: unknown): { code: string; reason?: string; field?: string; layer?: string; action?: string } {
  if (error instanceof CoreError) return { code: error.code, ...(error.reason ? { reason: error.reason } : {}), ...('field' in error && typeof error.field === 'string' ? { field: error.field } : {}), ...('layer' in error && typeof error.layer === 'string' ? { layer: error.layer } : {}), ...('action' in error && typeof error.action === 'string' ? { action: error.action } : {}) };
  return { code: 'PRODUCT_REQUEST_INVALID' };
}

export async function startProductHttp(options: { token: string; mcpPathSecret: string; version?: string; serverName?: string; inputSchema?: (method: string) => Schema; rpc: ProductRpc }): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    const reply = (status: number, body: unknown): void => { response.writeHead(status); response.end(JSON.stringify(body)); };
    const host = request.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host)) { reply(403, { error: 'HOST_DENIED' }); return; }
    const surface = request.url === '/rpc' ? 'app' : secretEqual(`/mcp/${options.mcpPathSecret}`, request.url) ? 'mcp' : undefined;
    if (!surface || (surface === 'app' && !secretEqual(`Bearer ${options.token}`, request.headers.authorization))) { reply(403, { error: 'AUTHORITY_DENIED' }); return; }
    if (request.headers.origin && !(surface === 'mcp' && request.headers.origin === 'https://chatgpt.com')) { reply(403, { error: 'ORIGIN_DENIED' }); return; }
    if (request.method !== 'POST') { reply(405, { error: 'METHOD_DENIED' }); return; }
    let requestId: unknown = null;
    let isToolCall = false;
    try {
      let body = ''; for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body) > 1024 * 1024) throw new CoreError('REQUEST_TOO_LARGE'); }
      const parsed: unknown = JSON.parse(body); if (!record(parsed)) throw new CoreError('INVALID_REQUEST');
      if (surface === 'app') {
        if (typeof parsed.method !== 'string' || !ALLOWED_APP_METHODS.has(parsed.method) || !record(parsed.input)) throw new CoreError('METHOD_DENIED');
        assertInput(parsed.method, parsed.input);
        reply(200, { ok: true, value: await options.rpc(parsed.method, parsed.input, surface, typeof request.headers['x-gotzji-build'] === 'string' ? request.headers['x-gotzji-build'] : undefined) }); return;
      }
      const { id, method, params } = parsed;
      requestId = id ?? null;
      if (parsed.jsonrpc !== '2.0' || typeof method !== 'string' || id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') throw new CoreError('MCP_REQUEST_INVALID');
      if (id === undefined && method.startsWith('notifications/')) { response.writeHead(202); response.end(); return; }
      if (method === 'initialize') { reply(200, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: options.serverName ?? 'gotzji', version: options.version ?? 'development' }, instructions: 'Use enrolled projects and explicit job IDs. Every work operation is controlled by Grace. Status/log/result polling never submits a new job.' } }); return; }
      if (method === 'ping') { reply(200, { jsonrpc: '2.0', id, result: {} }); return; }
      if (method === 'tools/list') { reply(200, { jsonrpc: '2.0', id, result: { tools: PRODUCT_MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: options.inputSchema?.(tool.method) ?? productControlSchema(tool.method), annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.method === 'cancel', idempotentHint: true, openWorldHint: false } })) } }); return; }
      if (method !== 'tools/call' || !record(params) || !record(params.arguments)) throw new CoreError('MCP_METHOD_DENIED');
      isToolCall = true;
      const tool = PRODUCT_MCP_TOOLS.find((entry) => entry.name === params.name); if (!tool) throw new CoreError('MCP_TOOL_DENIED');
      assertInput(tool.method, params.arguments);
      if (options.inputSchema && !accepts(options.inputSchema(tool.method), params.arguments)) throw new CoreError('PRODUCT_SCHEMA_INVALID');
      const value = await options.rpc(tool.method, params.arguments, surface);
      reply(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } });
    } catch (error) { reply(200, surface === 'app' ? { ok: false, error: safeError(error) } : isToolCall
      ? { jsonrpc: '2.0', id: requestId, result: { content: [{ type: 'text', text: JSON.stringify({ error: safeError(error) }) }], isError: true } }
      : { jsonrpc: '2.0', error: { code: -32602, message: safeError(error).code }, id: requestId }); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
