import { gotzjiMethods, type GotzjiHostStatus, type GotzjiMethod, type GotzjiRequest } from '@lnwjud/ipc-contracts';

/** Main-process private enrollment. Never return this descriptor to a renderer. */
export interface GotzjiHostDescriptor {
  readonly endpoint: string;
  readonly token: string;
  readonly ownerId: string;
  readonly buildIdentity?: string;
}
export type GotzjiHostDiscovery = () => Promise<GotzjiHostDescriptor>;

export class GotzjiHostError extends Error {
  public constructor(public readonly code: string, public readonly field?: string) {
    super(field === undefined ? code : `${code}: ${field}`);
    this.name = 'GotzjiHostError';
  }
}

export function parseGotzjiRequest(value: unknown): GotzjiRequest {
  if (!record(value) || Object.keys(value).some((key) => key !== 'method' && key !== 'input')
    || typeof value.method !== 'string' || !gotzjiMethods.includes(value.method as GotzjiMethod) || !record(value.input)) {
    throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  }
  const input = value.input;
  // Authority comes from private host enrollment, never from a renderer payload.
  if (Object.keys(input).some((key) => ['owner', 'ownerId', 'credential', 'token', 'adapterId', ...(value.method === 'prepareOperation' && ['cad.entity.inspect', 'cad.entity.move'].includes(String(input.operation)) ? [] : ['handle'])].includes(key))) {
    throw new GotzjiHostError('CALLER_AUTHORITY_DENIED');
  }
  const method = value.method as GotzjiMethod;
  if (method === 'listManagedProjects' && Object.keys(input).length > 0) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  if (method === 'setProjectArchived') {
    requiredText(input, 'projectId');
    if (typeof input.archived !== 'boolean' || Object.keys(input).some((key) => key !== 'projectId' && key !== 'archived')) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  }
  if (method === 'listDeliveryApprovals' && Object.keys(input).length > 0) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  if (method === 'deliveryApproval' || method === 'decideDeliveryApproval') {
    requiredText(input, 'preparationId');
    const allowed = method === 'deliveryApproval' ? ['preparationId'] : ['preparationId', 'expectedDigest', 'decision'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
    if (method === 'decideDeliveryApproval' && (typeof input.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedDigest) || !['approved', 'rejected'].includes(String(input.decision)))) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  }
  if (method === 'selectedProject' && Object.keys(input).length > 0) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  if (method === 'selectProject' || method === 'projectContext') {
    if (Object.keys(input).some((key) => key !== 'projectId')) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
    if (method === 'selectProject' || input.projectId !== undefined) requiredText(input, 'projectId');
  }
  if (method === 'saveProjectMemory') {
    requiredText(input, 'projectId');
    if (Object.keys(input).some((key) => !['projectId', 'expectedRevision', 'memory'].includes(key)) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 || !record(input.memory)) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  }
    if (method === 'readProjectGit') {
      requiredText(input, 'projectId');
      const allowed = input.view === 'diff' ? ['projectId', 'view', 'path', 'staged'] : ['projectId', 'view'];
      if (!['status', 'diff', 'log'].includes(String(input.view)) || Object.keys(input).some((key) => !allowed.includes(key))) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
      if (input.view === 'diff') { requiredText(input, 'path'); if (input.staged !== undefined && typeof input.staged !== 'boolean') throw new GotzjiHostError('INVALID_GOTZJI_REQUEST'); }
    }
  if (['readProjectFile', 'listProjectFiles', 'searchProjectFiles'].includes(method)) {
    requiredText(input, 'projectId');
    const allowed = method === 'searchProjectFiles' ? ['projectId', 'path', 'query'] : ['projectId', 'path'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
    if (method === 'readProjectFile' || input.path !== undefined) requiredText(input, 'path');
    if (method === 'searchProjectFiles') requiredText(input, 'query');
  }
  if (['startBrowserSession', 'browserSession', 'stopBrowserSession', 'authorizeLibraryDelivery'].includes(method)) {
    requiredText(value.input, 'projectId');
    const allowed = method === 'startBrowserSession' ? ['projectId', 'startUrl', 'allowedOrigins'] : method === 'authorizeLibraryDelivery' ? ['projectId', 'jobId', 'scope'] : ['projectId'];
    if (Object.keys(value.input).some((key) => !allowed.includes(key))) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
    if (method === 'startBrowserSession') { requiredText(value.input, 'startUrl'); if (value.input.allowedOrigins !== undefined && (!Array.isArray(value.input.allowedOrigins) || value.input.allowedOrigins.some((entry: unknown) => typeof entry !== 'string') || value.input.allowedOrigins.length > 8)) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST'); }
    if (method === 'authorizeLibraryDelivery') { requiredText(value.input, 'jobId'); if (!['commit', 'push', 'deploy', 'user-delivery'].includes(String(value.input.scope))) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST'); }
  }
  if (method === 'enrollLibraryChannel') { requiredText(value.input, 'projectId'); if (Object.keys(value.input).some((key) => key !== 'projectId')) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST'); }
  if (['connectionStatus', 'startConnection', 'stopConnection', 'libraryChannelStatus', 'startLibraryConnection', 'stopLibraryConnection'].includes(method) && Object.keys(value.input).length > 0) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  if (['configureConnection', 'configureLibraryConnection'].includes(method)) {
    if (Object.keys(value.input).some((key) => !['tunnelId', 'runtimeKey', 'organizationId'].includes(key)) || typeof value.input.tunnelId !== 'string' || !/^tunnel_[a-z0-9]{32}$/u.test(value.input.tunnelId) || typeof value.input.runtimeKey !== 'string' || value.input.runtimeKey.length < 20 || value.input.runtimeKey.length > 1024 || /[\r\n\0]/u.test(value.input.runtimeKey) || value.input.organizationId !== undefined && (typeof value.input.organizationId !== 'string' || !/^org[-_][A-Za-z0-9_-]{1,160}$/u.test(value.input.organizationId))) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  }
  if (['status', 'logs', 'result', 'cancel', 'settleJob', 'resume'].includes(method)) requiredText(value.input, 'jobId');
  if (method === 'registerRecipe') {
    requiredText(value.input, 'recipeId'); requiredText(value.input, 'executable');
    const strings = (item: unknown): boolean => Array.isArray(item) && item.every((entry) => typeof entry === 'string');
    if (Object.keys(value.input).some((key) => !['recipeId', 'displayName', 'executable', 'args', 'dependencies', 'timeoutMs', 'writeScope', 'delivery'].includes(key)) || !strings(value.input.args) || !strings(value.input.dependencies)
      || (value.input.timeoutMs !== undefined && !Number.isSafeInteger(value.input.timeoutMs)) || (value.input.writeScope !== undefined && value.input.writeScope !== 'project') || (value.input.delivery !== undefined && value.input.delivery !== true)) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  }
  if (method === 'bindProjectRecipe') {
    requiredText(value.input, 'projectId'); requiredText(value.input, 'recipeId');
    if (Object.keys(value.input).some((key) => key !== 'projectId' && key !== 'recipeId')) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  }
  if (method === 'settleJob' && (!['effect-present', 'no-effect'].includes(String(value.input.decision)) || Object.keys(value.input).some((key) => key !== 'jobId' && key !== 'decision'))) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  if (method === 'prepareOperation') {
    requiredText(value.input, 'projectId');
    requiredText(value.input, 'requestId');
    requiredText(value.input, 'operation');
  }
  if (method === 'submit') requiredText(value.input, 'preparationId');
  if (method === 'reprioritize') {
    requiredText(value.input, 'jobId');
    if (Object.keys(value.input).some((key) => key !== 'jobId' && key !== 'priority') || !Number.isInteger(value.input.priority) || Number(value.input.priority) < 0 || Number(value.input.priority) > 3) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST', 'priority');
  }
  if ((method === 'inspectQueue' || method === 'supportReport') && Object.keys(value.input).length > 0) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
  if (method === 'registerProject') {
    if (Object.keys(value.input).some((key) => !['projectId', 'displayName', 'rootPath', 'kind', 'recipeIds'].includes(key))) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST', 'arguments');
    requiredText(value.input, 'projectId');
    requiredText(value.input, 'displayName');
    requiredText(value.input, 'rootPath');
    if (value.input.kind !== undefined && value.input.kind !== 'project' && value.input.kind !== 'library') throw new GotzjiHostError('INVALID_GOTZJI_REQUEST', 'kind');
    if (value.input.recipeIds !== undefined && (!Array.isArray(value.input.recipeIds) || value.input.recipeIds.some((recipe: unknown) => typeof recipe !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(recipe)) || new Set(value.input.recipeIds).size !== value.input.recipeIds.length)) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST', 'recipeIds');
  }
  return { method, input: value.input };
}

export class GotzjiHostClient {
  public constructor(private readonly discover: GotzjiHostDiscovery, private readonly transport: typeof fetch = fetch) {}

  public async status(): Promise<GotzjiHostStatus> {
    try {
      const descriptor = await this.descriptor();
      const health = await this.call(descriptor, 'health', {});
      if (!record(health) || health.controller !== 'chatgpt-plugin') throw new GotzjiHostError('HOST_CONTROLLER_MISMATCH');
      const controlOnly = record(health) && health.state === 'control-only';
      return { product: 'gotzji', state: controlOnly ? 'control-only' : 'ready', ownerId: descriptor.ownerId, controller: 'chatgpt-plugin', automaticUpdates: false,
        ...(controlOnly ? { errorCode: record(health) && typeof health.reason === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(health.reason) ? health.reason : 'HOST_BUILD_RECONCILIATION_REQUIRED' } : {}) };
    } catch (error) {
      const startup = record(error) && error.layer === 'host-startup';
      return { product: 'gotzji', state: 'unavailable', ownerId: null, errorCode: safeErrorCode(error), ...(startup ? { errorLayer: 'host-startup', action: 'ตรวจบันทึกการเริ่มระบบและโปรแกรมที่จำเป็นก่อนลองเปิดระบบอีกครั้ง' } : {}), controller: 'chatgpt-plugin', automaticUpdates: false };
    }
  }

  public async request(value: unknown): Promise<unknown> {
    const request = parseGotzjiRequest(value);
    return this.call(await this.descriptor(), request.method, request.input);
  }
  /** Only trusted main-process export calls this; it is not a renderer request method. */
  public async readNativeOutput(jobId: string): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/u.test(jobId)) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST');
    return this.call(await this.descriptor(), 'readNativeOutput', { jobId });
  }

  private async descriptor(): Promise<GotzjiHostDescriptor> {
    const descriptor = await this.discover();
    let endpoint: URL;
    try { endpoint = new URL(descriptor.endpoint); } catch { throw new GotzjiHostError('HOST_DESCRIPTOR_DENIED'); }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
      || !descriptor.token || !descriptor.ownerId) throw new GotzjiHostError('HOST_DESCRIPTOR_DENIED');
    return descriptor;
  }

  private async call(descriptor: GotzjiHostDescriptor, method: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    let response: Response;
    const hostMethod = method === 'listCatalog' ? 'catalog' : method === 'listJobs' ? 'list' : method;
    try {
      response = await this.transport(new URL('/rpc', descriptor.endpoint), {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${descriptor.token}`, ...(descriptor.buildIdentity === undefined ? {} : { 'x-gotzji-build': descriptor.buildIdentity }) },
        body: JSON.stringify({ method: hostMethod, input }),
        // A control-call timeout never cancels or resubmits an independently owned job.
        // Git has independent bounded validation/config/copy/command phases plus owned-copy cleanup.
        // Browser stop waits for native absence; synchronous resume encloses worker startup and its status handshake.
        signal: AbortSignal.timeout(hostMethod === 'readProjectGit' ? 90_000 : hostMethod === 'supportReport' || hostMethod === 'stopBrowserSession' || hostMethod === 'resume' ? 60_000 : 10_000),
      });
    } catch {
      throw new GotzjiHostError('HOST_CONNECTION_LOST');
    }
    if (!response.ok) throw new GotzjiHostError(response.status === 401 || response.status === 403 ? 'HOST_AUTH_REQUIRED' : 'HOST_RESPONSE_FAILED');
    const value: unknown = hostMethod === 'readNativeOutput'
      ? await readBoundedNativeResponse(response)
      : await response.json().catch(() => { throw new GotzjiHostError('HOST_RESPONSE_INVALID'); });
    if (!record(value)) throw new GotzjiHostError('HOST_RESPONSE_INVALID');
    if (value.ok === false && record(value.error)) {
      const data = record(value.error.data) ? value.error.data : value.error;
      const code = typeof data.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(data.code) ? data.code : 'HOST_OPERATION_DENIED';
      const field = typeof data.field === 'string' && /^[a-zA-Z][a-zA-Z0-9_.]{0,79}$/u.test(data.field) ? data.field : undefined;
      throw new GotzjiHostError(code, field);
    }
    if (value.ok !== true || !Object.hasOwn(value, 'value')) throw new GotzjiHostError('HOST_RESPONSE_INVALID');
    return value.value;
  }
}

async function readBoundedNativeResponse(response: Response): Promise<unknown> {
  // Base64 expands the 16 MiB snapshot; the allowance covers JSON metadata and escaped filenames.
  const limit = Math.ceil((16 * 1024 * 1024) / 3) * 4 + 4096;
  if (!response.body) throw new GotzjiHostError('HOST_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new GotzjiHostError('HOST_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))) as unknown;
  } catch (error) {
    if (error instanceof GotzjiHostError) throw error;
    throw new GotzjiHostError('HOST_RESPONSE_INVALID');
  } finally { reader.releaseLock(); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requiredText(input: Record<string, unknown>, field: string): void {
  if (typeof input[field] !== 'string' || !input[field].trim()) throw new GotzjiHostError('INVALID_GOTZJI_REQUEST', field);
}
function safeErrorCode(error: unknown): string {
  if (error instanceof GotzjiHostError) return error.code;
  if (record(error) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(error.code)) return error.code;
  return 'HOST_UNAVAILABLE';
}
