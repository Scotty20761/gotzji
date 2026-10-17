import type { LnwjudApi, GotzjiApi } from '@lnwjud/ipc-contracts';

declare global {
  interface Window {
    readonly lnwjud: LnwjudApi;
    readonly gotzji: GotzjiApi;
  }
}

export {};
