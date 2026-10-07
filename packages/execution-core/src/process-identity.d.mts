export interface ProcessIdentity { readonly birth: string; readonly executable: string }
export function sameProcessIdentity(expected: ProcessIdentity | null | undefined, actual: ProcessIdentity | null | 'unknown' | undefined): boolean;
export function processIdentities(values: readonly number[]): Promise<Record<number, ProcessIdentity | null | 'unknown'>>;
