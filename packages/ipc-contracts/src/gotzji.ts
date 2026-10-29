/** Secrets and adapter binding handles deliberately do not cross the preload boundary. */
export const gotzjiIpcChannels = {
  hostStatus: 'gotzji:host-status',
  pickProjectFolder: 'gotzji:pick-project-folder',
  request: 'gotzji:request',
  connectionSetupDefaults: 'gotzji:connection-setup-defaults',
  openConnectionSetup: 'gotzji:open-connection-setup',
  startupStatus: 'gotzji:startup-status',
  setStartup: 'gotzji:set-startup',
  exportSupportReport: 'gotzji:export-support-report',
  exportJobLogs: 'gotzji:export-job-logs',
  exportNativeOutput: 'gotzji:export-native-output',
} as const;

export const gotzjiMethods = [
  'listDeliveryApprovals', 'deliveryApproval', 'decideDeliveryApproval',
  'selectProject', 'selectedProject', 'projectContext', 'saveProjectMemory',
  'readProjectFile', 'listProjectFiles', 'searchProjectFiles', 'readProjectGit',
  'listProjects', 'listManagedProjects', 'setProjectArchived', 'registerProject', 'registerRecipe', 'bindProjectRecipe', 'supportReport', 'listCatalog', 'prepareOperation', 'submit',
  'listJobs', 'activeJobs', 'status', 'logs', 'result', 'cancel', 'settleJob', 'resume', 'inspectQueue', 'reprioritize',
  'connectionStatus', 'configureConnection', 'startConnection', 'stopConnection', 'recoverConnection',
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
  readonly controller: 'chatgpt-plugin';
  readonly automaticUpdates: false;
}
export interface GotzjiRequest {
  readonly method: GotzjiMethod;
  readonly input: Readonly<Record<string, unknown>>;
}
export type GotzjiProjectFolderSelection = { readonly cancelled: true } | { readonly cancelled: false; readonly path: string };
export interface GotzjiApi {
  /** Local directory selection only; enrollment requires an explicit registerProject request. */
  pickProjectFolder(): Promise<GotzjiProjectFolderSelection>;
  hostStatus(): Promise<GotzjiHostStatus>;
  request(request: GotzjiRequest): Promise<unknown>;
  connectionSetupDefaults(): Promise<{ tunnelId?: string; organizationId?: string }>;
  openConnectionSetup(page: 'tunnels' | 'keys' | 'connectors'): Promise<void>;
  startupStatus(): Promise<{ available: boolean; enabled: boolean; mode: 'inspect-and-resume'; reason?: string }>;
  setStartup(enabled: boolean): Promise<{ available: boolean; enabled: boolean; mode: 'inspect-and-resume'; reason?: string }>;
  /** Saves the owner's support report where the owner chooses; nothing is uploaded. */
  exportSupportReport(): Promise<{ readonly exported: boolean; readonly cancelled: boolean }>;
  /** Saves up to the first 64 KiB of one canonical job's retained logs to an owner-selected file. */
  exportJobLogs(jobId: string): Promise<{ readonly exported: boolean; readonly cancelled: boolean }>;
  /** Saves a verified native output snapshot from the selected job, without accepting a source path. */
  exportNativeOutput(jobId: string): Promise<{ readonly exported: boolean; readonly cancelled: boolean }>;
}
