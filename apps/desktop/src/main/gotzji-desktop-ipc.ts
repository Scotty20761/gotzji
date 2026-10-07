import { gotzjiIpcChannels } from '@lnwjud/ipc-contracts';
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
): void {
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
  registrar.handle(gotzjiIpcChannels.setStartup, async (event, payload) => {
    assertTrusted(event); if (!startup || typeof payload !== 'boolean') throw new Error('GOTZJI_STARTUP_UNAVAILABLE');
    return startup.setEnabled(payload);
  });
}
