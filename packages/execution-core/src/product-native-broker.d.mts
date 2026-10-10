import type { AuthorizedNativeWorkerConfig } from './product-native.js';
import type { GotzjiNativeAdapterOptions } from '@lnwjud/capabilities/gotzji-native-adapter';
export function executePreparedNativeOperation(config: AuthorizedNativeWorkerConfig, signal?: AbortSignal, options?: { readonly testRunner?: GotzjiNativeAdapterOptions['runner']; readonly verifyLiveAuthority?: () => boolean | Promise<boolean> }): Promise<unknown>;
export function readPreparedNativeState(config: AuthorizedNativeWorkerConfig): unknown;
