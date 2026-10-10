import type { AuthorizedBrowserWorkerConfig, TrustedProductBrowserSessionManifest, TrustedProductBrowserLaunchOptions, TrustedProductBrowserEnrollment } from './product-browser.js';
import type { RegisteredProject } from './types.js';
import type { GotzjiBrowserTransport } from '@lnwjud/capabilities/gotzji-browser-provider-policy';
import type { GotzjiOwnedBrowserDriver } from '@lnwjud/capabilities/gotzji-browser-provider-session';
export function captureOwnedProductBrowserSession(driver: GotzjiOwnedBrowserDriver, owner: string, projectId: string, tabId: string): Promise<TrustedProductBrowserSessionManifest>;
export function createTrustedProductBrowserEnrollment(project: RegisteredProject, launch: TrustedProductBrowserLaunchOptions): Promise<TrustedProductBrowserEnrollment>;
export function restoreTrustedProductBrowserEnrollment(project: RegisteredProject, options: Omit<import('./product-browser.js').TrustedProductBrowserOptions, 'verifyOwnedSession'>): Promise<TrustedProductBrowserEnrollment>;
export function verifyOwnedProductBrowserSession(session: TrustedProductBrowserSessionManifest): Promise<boolean>;
export function executePreparedBrowserOperation(config: AuthorizedBrowserWorkerConfig, signal?: AbortSignal, options?: {
  readonly verifyLiveAuthority?: () => boolean | Promise<boolean>;
  readonly verifyOwnedSession?: (session: TrustedProductBrowserSessionManifest) => boolean | Promise<boolean>;
  readonly testTransport?: GotzjiBrowserTransport;
  readonly onProgress?: (progress: { readonly phase: string; readonly at: string }) => void;
}): Promise<unknown>;
export function readPreparedBrowserState(config: AuthorizedBrowserWorkerConfig): unknown;
