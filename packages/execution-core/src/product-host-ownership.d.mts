import type { ProcessIdentity } from './process-identity.mjs';

export type ProductHostOwnershipResult =
  | { readonly status: 'acquired'; readonly pid: number; readonly birth: string; readonly executable: string; readonly nonce: string; readonly release: () => void }
  | { readonly status: 'owned' | 'unknown'; readonly reason: string; readonly pid?: number };

export function acquireProductHostOwnership(
  directory: string,
  key: string,
  reader?: (pids: readonly number[]) => Promise<Record<number, ProcessIdentity | null | 'unknown'>>,
): Promise<ProductHostOwnershipResult>;
