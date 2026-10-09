export interface ProcessIdentity { readonly birth: string; readonly executable: string }
export const UNPACKAGED_E2E_PROCESS_BIRTH: string;
export function sameProcessIdentity(expected: ProcessIdentity | null | undefined, actual: ProcessIdentity | null | 'unknown' | undefined): boolean;
export function processIdentities(values: readonly number[]): Promise<Record<number, ProcessIdentity | null | 'unknown'>>;
export type WindowsProcessIdentityExecutor = (executable: string, args: string[], options: {
  windowsHide: boolean; env: Record<string, string>; timeout: number; maxBuffer: number;
}) => Promise<{ stdout: string }>;
export function createWindowsProcessIdentityReader(options?: {
  currentPid?: number; programFiles?: string; systemRoot?: string;
  exists?: (filename: string) => boolean; run?: WindowsProcessIdentityExecutor; session?: WindowsPowerShellSession;
  onFailure?: (failure: { code: string; elapsedMs: number }) => void;
}): typeof processIdentities;
/** One owned PowerShell per role and program; identity and DPAPI never share one. Failures reject with a POWERSHELL_SESSION_* code. */
export interface WindowsPowerShellSession {
  identity(pids: readonly number[], timeoutMs?: number): Promise<Record<string, unknown>>;
  protect(base64: string, timeoutMs?: number): Promise<string>;
  unprotect(base64: string, timeoutMs?: number): Promise<string>;
  close(): void;
}
export function createWindowsPowerShellSession(options: {
  program: string; role?: 'identity' | 'dpapi'; idleMs?: number; outputLimit?: number; startupMs?: number;
  spawn?: (command: string, args: readonly string[], options: object) => import('node:child_process').ChildProcess;
}): WindowsPowerShellSession;
export function windowsPowerShellSession(program: string, role?: 'identity' | 'dpapi'): WindowsPowerShellSession;
