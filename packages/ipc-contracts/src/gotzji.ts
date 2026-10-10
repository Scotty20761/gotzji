/** Secrets and adapter binding handles deliberately do not cross the preload boundary. */
export const gotzjiIpcChannels = {
  hostStatus: 'gotzji:host-status',
  request: 'gotzji:request',
  connectionSetupDefaults: 'gotzji:connection-setup-defaults',
  openConnectionSetup: 'gotzji:open-connection-setup',
  startupStatus: 'gotzji:startup-status',
  setStartup: 'gotzji:set-startup',
  exportSupportReport: 'gotzji:export-support-report',
} as const;

export const gotzjiMethods = [
  'listProjects', 'registerProject', 'registerRecipe', 'bindProjectRecipe', 'supportReport', 'listCatalog', 'prepareOperation', 'submit',
  'listJobs', 'status', 'logs', 'result', 'cancel', 'settleJob', 'resume', 'inspectQueue', 'reprioritize',
  'connectionStatus', 'configureConnection', 'startConnection', 'stopConnection',
  'startBrowserSession', 'browserSession', 'stopBrowserSession', 'authorizeLibraryDelivery',
  'enrollLibraryChannel', 'libraryChannelStatus', 'configureLibraryConnection', 'startLibraryConnection', 'stopLibraryConnection',
] as const;
export type GotzjiMethod = typeof gotzjiMethods[number];
export interface GotzjiHostStatus {
  readonly product: 'gotzji';
  readonly state: 'ready' | 'control-only' | 'unavailable';
  readonly ownerId: string | null;
  readonly errorCode?: string;
  readonly errorLayer?: string;
  readonly action?: string;
  readonly controller: 'grace';
  readonly automaticUpdates: false;
}
export interface GotzjiRequest {
  readonly method: GotzjiMethod;
  readonly input: Readonly<Record<string, unknown>>;
}
export interface GotzjiApi {
  hostStatus(): Promise<GotzjiHostStatus>;
  request(request: GotzjiRequest): Promise<unknown>;
  connectionSetupDefaults(): Promise<{ tunnelId?: string; organizationId?: string }>;
  openConnectionSetup(page: 'tunnels' | 'keys' | 'connectors'): Promise<void>;
  startupStatus(): Promise<{ available: boolean; enabled: boolean; mode: 'inspect-and-resume'; reason?: string }>;
  setStartup(enabled: boolean): Promise<{ available: boolean; enabled: boolean; mode: 'inspect-and-resume'; reason?: string }>;
  /** Saves the owner's support report where the owner chooses; nothing is uploaded. */
  exportSupportReport(): Promise<{ readonly exported: boolean; readonly cancelled: boolean }>;
}
