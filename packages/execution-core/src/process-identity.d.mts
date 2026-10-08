export interface ProcessIdentity { readonly birth: string; readonly executable: string }
export const UNPACKAGED_E2E_PROCESS_BIRTH: string;
export function sameProcessIdentity(expected: ProcessIdentity | null | undefined, actual: ProcessIdentity | null | 'unknown' | undefined): boolean;
export function processIdentities(values: readonly number[]): Promise<Record<number, ProcessIdentity | null | 'unknown'>>;
export type WindowsProcessIdentityExecutor = (executable: string, args: string[], options: {
  windowsHide: boolean; env: Record<string, string>; timeout: number; maxBuffer: number;
}) => Promise<{ stdout: string }>;
export function createWindowsProcessIdentityReader(options?: {
  currentPid?: number; programFiles?: string; systemRoot?: string;
  exists?: (filename: string) => boolean; run?: WindowsProcessIdentityExecutor;
  onFailure?: (failure: { code: string; elapsedMs: number }) => void;
}): typeof processIdentities;
