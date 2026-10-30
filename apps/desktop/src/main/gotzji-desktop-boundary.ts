import { ipcChannels } from '@lnwjud/ipc-contracts';
import { GotzjiHostError } from './gotzji-host-client.js';

// Only inert local view metadata survives the inherited API. Provider reads are user work too.
const metadataChannels = new Set<string>([
  ipcChannels.getDashboard, ipcChannels.listWorkspaces, ipcChannels.listProcesses,
  ipcChannels.getTunnelStatus, ipcChannels.getRemoteMcpStatus, ipcChannels.getToolCatalog,
  ipcChannels.getLogSnapshot, ipcChannels.getUpdateStatus, ipcChannels.getInstallActivity,
]);
export function assertGotzjiInheritedChannel(channel: string): void {
  if (!metadataChannels.has(channel)) throw new GotzjiHostError('GRACE_GOVERNED_OPERATION_REQUIRED');
}
