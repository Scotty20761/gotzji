import { gotzjiIpcChannels, type GotzjiProjectFolderSelection } from '@lnwjud/ipc-contracts';
import { createHash } from 'node:crypto';
import type { GotzjiHostClient } from './gotzji-host-client.js';
import type { GotzjiStartupStatus } from './gotzji-startup.js';

export interface GotzjiIpcRegistrar<Event> {
  handle(channel: string, handler: (event: Event, payload?: unknown) => Promise<unknown>): void;
}
export function registerGotzjiIpcHandlers<Event>(
  registrar: GotzjiIpcRegistrar<Event>,
  client: GotzjiHostClient,
  assertTrusted: (event: Event) => void,
  connectionSetup?: { readonly defaults: () => { tunnelId?: string; organizationId?: string }; readonly open: (page: 'tunnels' | 'keys' | 'connectors') => Promise<void> },
  startup?: { readonly status: () => GotzjiStartupStatus; readonly setEnabled: (enabled: boolean) => GotzjiStartupStatus },
  supportReport?: { readonly save: (content: string) => Promise<{ readonly exported: boolean; readonly cancelled: boolean }> },
  projectFolder?: { readonly pick: () => Promise<GotzjiProjectFolderSelection> },
  jobLogs?: { readonly save: (jobId: string, content: string) => Promise<{ readonly exported: boolean; readonly cancelled: boolean }> },
  nativeOutput?: { readonly save: (jobId: string, filename: string, content: Buffer) => Promise<{ readonly exported: boolean; readonly cancelled: boolean }> },
): void {
  registrar.handle(gotzjiIpcChannels.pickProjectFolder, async (event, payload) => {
    assertTrusted(event);
    if (payload !== undefined && payload !== null) throw new Error('INVALID_GOTZJI_REQUEST');
    if (!projectFolder) throw new Error('PROJECT_FOLDER_PICKER_UNAVAILABLE');
    return projectFolder.pick();
  });
  registrar.handle(gotzjiIpcChannels.hostStatus, async (event, payload) => {
    assertTrusted(event);
    if (payload !== undefined && payload !== null) throw new Error('INVALID_GOTZJI_REQUEST');
    return client.status();
  });
  registrar.handle(gotzjiIpcChannels.request, async (event, payload) => {
    assertTrusted(event);
    return client.request(payload);
  });
  registrar.handle(gotzjiIpcChannels.connectionSetupDefaults, async (event, payload) => {
    assertTrusted(event);
    if (payload !== undefined && payload !== null) throw new Error('INVALID_GOTZJI_REQUEST');
    return connectionSetup?.defaults() ?? {};
  });
  registrar.handle(gotzjiIpcChannels.openConnectionSetup, async (event, payload) => {
    assertTrusted(event);
    if (!connectionSetup || typeof payload !== 'string' || !['tunnels', 'keys', 'connectors'].includes(payload)) throw new Error('CONNECTION_SETUP_DENIED');
    await connectionSetup.open(payload as 'tunnels' | 'keys' | 'connectors');
  });
  registrar.handle(gotzjiIpcChannels.startupStatus, async (event, payload) => {
    assertTrusted(event); if (payload !== undefined && payload !== null) throw new Error('INVALID_GOTZJI_REQUEST');
    return startup?.status() ?? { available: false, enabled: false, mode: 'inspect-and-resume', reason: 'INSTALLED_WINDOWS_PRODUCT_REQUIRED' };
  });
  // Main fetches the report from the host and writes the file the owner chooses; the renderer never handles its content.
  registrar.handle(gotzjiIpcChannels.exportSupportReport, async (event, payload) => {
    assertTrusted(event); if (payload !== undefined && payload !== null) throw new Error('INVALID_GOTZJI_REQUEST');
    if (!supportReport) throw new Error('SUPPORT_REPORT_UNAVAILABLE');
    return supportReport.save(`${JSON.stringify(await client.request({ method: 'supportReport', input: {} }), null, 2)}\n`);
  });
  registrar.handle(gotzjiIpcChannels.exportJobLogs, async (event, payload) => {
    assertTrusted(event);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).join(',') !== 'jobId'
      || !('jobId' in payload) || typeof payload.jobId !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.jobId)) throw new Error('INVALID_GOTZJI_REQUEST');
    if (!jobLogs) throw new Error('JOB_LOG_EXPORT_UNAVAILABLE');
    let cursor = 0; let content = '';
    for (let page = 0; page < 8; page++) {
      const value = await client.request({ method: 'logs', input: { jobId: payload.jobId, cursor, limit: 8192 } });
      if (value === null || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string'
        || !('nextCursor' in value) || !Number.isSafeInteger(value.nextCursor) || Number(value.nextCursor) < cursor
        || Number(value.nextCursor) - cursor > 8192 || Buffer.byteLength(value.text, 'utf8') > 8192
        || 'expired' in value && value.expired !== undefined && typeof value.expired !== 'boolean') throw new Error('LOG_RESPONSE_INVALID');
      if ('expired' in value && value.expired === true) throw new Error('RESULT_EXPIRED');
      if (!value.text.length) { if (value.nextCursor !== cursor) throw new Error('LOG_RESPONSE_INVALID'); break; }
      if (value.nextCursor === cursor) throw new Error('LOG_RESPONSE_INVALID');
      content += value.text; cursor = Number(value.nextCursor);
    }
    if (!content) throw new Error('JOB_LOG_EMPTY');
    return jobLogs.save(payload.jobId, content);
  });
  registrar.handle(gotzjiIpcChannels.exportNativeOutput, async (event, payload) => {
    assertTrusted(event);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).join(',') !== 'jobId'
      || !('jobId' in payload) || typeof payload.jobId !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.jobId)) throw new Error('INVALID_GOTZJI_REQUEST');
    if (!nativeOutput) throw new Error('NATIVE_OUTPUT_UNAVAILABLE');
    const value = await client.readNativeOutput(payload.jobId);
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !('jobId' in value) || value.jobId !== payload.jobId
      || !('filename' in value) || typeof value.filename !== 'string' || !value.filename || value.filename.length > 255 || /[\\/\0]/u.test(value.filename) || ['.', '..'].includes(value.filename)
      || !('sha256' in value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
      || !('base64' in value) || typeof value.base64 !== 'string' || value.base64.length > Math.ceil((16 * 1024 * 1024) / 3) * 4) throw new Error('NATIVE_OUTPUT_INVALID');
    const bytes = Buffer.from(value.base64, 'base64');
    if (bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== value.base64 || createHash('sha256').update(bytes).digest('hex') !== value.sha256) throw new Error('NATIVE_OUTPUT_INVALID');
    return nativeOutput.save(payload.jobId, value.filename, bytes);
  });
  registrar.handle(gotzjiIpcChannels.setStartup, async (event, payload) => {
    assertTrusted(event); if (!startup || typeof payload !== 'boolean') throw new Error('GOTZJI_STARTUP_UNAVAILABLE');
    return startup.setEnabled(payload);
  });
}
