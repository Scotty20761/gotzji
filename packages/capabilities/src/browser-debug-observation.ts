export interface BrowserDebugObservation {
  readonly kind: 'console' | 'network';
  readonly source: string;
  readonly received_at: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export function isProtectedBrowserUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') || hostname === 'chat.openai.com' || hostname.endsWith('.chat.openai.com');
  } catch { return false; }
}

export function observesProtectedBrowserPage(method: string, params: unknown): boolean {
  if (!isRecord(params)) return false;
  if (method === 'Runtime.executionContextCreated' && isRecord(params.context) && typeof params.context.origin === 'string') return isProtectedBrowserUrl(params.context.origin);
  if (method === 'Network.requestWillBeSent' && isRecord(params.request) && typeof params.request.url === 'string') return isProtectedBrowserUrl(params.request.url);
  if (method === 'Network.responseReceived' && isRecord(params.response) && typeof params.response.url === 'string') return isProtectedBrowserUrl(params.response.url);
  return false;
}

export function browserDebugObservation(method: string, params: unknown): BrowserDebugObservation | null {
  if (!isRecord(params)) return null;
  const data: Record<string, unknown> = {};
  if (method === 'Runtime.consoleAPICalled') {
    if (typeof params.type !== 'string' || !Array.isArray(params.args)) return invalidObservation();
    data.level = safeText(params.type);
    data.arguments = params.args.slice(0, 100).map(safeArgument);
    data.arguments_omitted = Math.max(0, params.args.length - 100);
    putNumber(data, 'timestamp', params.timestamp);
  } else if (method === 'Runtime.exceptionThrown') {
    if (!isRecord(params.exceptionDetails)) return invalidObservation();
    const details = params.exceptionDetails;
    if (typeof details.text !== 'string') return invalidObservation();
    data.text = safeText(details.text);
    if (isRecord(details.exception)) {
      data.exception = safeArgument(details.exception);
      putText(data, 'exception_text', details.exception.description);
    }
    putUrl(data, 'url', details.url);
    putNumber(data, 'line_number', details.lineNumber);
    putNumber(data, 'column_number', details.columnNumber);
  } else if (method === 'Log.entryAdded') {
    if (!isRecord(params.entry) || typeof params.entry.text !== 'string') return invalidObservation();
    data.text = safeText(params.entry.text);
    putText(data, 'level', params.entry.level);
    putText(data, 'source', params.entry.source);
    putUrl(data, 'url', params.entry.url);
    putNumber(data, 'line_number', params.entry.lineNumber);
  } else if (method === 'Network.requestWillBeSent') {
    if (!isRecord(params.request) || typeof params.request.url !== 'string' || typeof params.request.method !== 'string') return invalidObservation();
    putText(data, 'request_id', params.requestId);
    putUrl(data, 'url', params.request.url);
    putText(data, 'method', params.request.method);
    putText(data, 'resource_type', params.type);
    data.headers_retained = false;
    data.body_retained = false;
  } else if (method === 'Network.responseReceived') {
    if (!isRecord(params.response) || typeof params.response.url !== 'string' || typeof params.response.status !== 'number') return invalidObservation();
    putText(data, 'request_id', params.requestId);
    putUrl(data, 'url', params.response.url);
    putNumber(data, 'status', params.response.status);
    putText(data, 'mime_type', params.response.mimeType);
    putText(data, 'resource_type', params.type);
    data.headers_retained = false;
    data.body_retained = false;
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    if (typeof params.requestId !== 'string') return invalidObservation();
    putText(data, 'request_id', params.requestId);
    putNumber(data, 'encoded_data_length', params.encodedDataLength);
    putText(data, 'error_text', params.errorText);
    if (typeof params.canceled === 'boolean') data.cancelled = params.canceled;
  } else {
    return null;
  }
  return { kind: method.startsWith('Network.') ? 'network' : 'console', source: method, received_at: new Date().toISOString(), data };
}

function safeArgument(value: unknown): unknown {
  if (!isRecord(value)) return { type: 'unknown' };
  if (typeof value.value === 'string') return safeText(value.value);
  if (typeof value.value === 'number' && Number.isFinite(value.value)) return value.value;
  if (typeof value.value === 'boolean' || value.value === null) return value.value;
  const description = value.type === 'string' && typeof value.description === 'string' ? safeText(value.description) : undefined;
  return { type: typeof value.type === 'string' ? safeText(value.type) : 'unknown', ...(description === undefined ? {} : { description }), object_properties_retained: false };
}

function safeText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeUrl(url))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]')
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|credential)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, '[redacted]');
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol}[redacted]`;
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, '[redacted]');
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
}

function putText(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'string') target[key] = safeText(value);
}

function putUrl(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'string') target[key] = safeUrl(value);
}

function putNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidObservation(): never { throw new Error('Browser observation event is invalid'); }
