import path from 'node:path';

export interface GotzjiStartupStatus { readonly available: boolean; readonly enabled: boolean; readonly mode: 'inspect-and-resume'; readonly reason?: string }
export interface GotzjiLoginItemApi {
  getLoginItemSettings(options: { path: string; args: string[] }): { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean };
  setLoginItemSettings(options: { name: string; openAtLogin: boolean; path: string; args: string[] }): void;
}
/** One owner logon launcher; it starts the existing product host, never a scheduler. */
export function gotzjiStartupController(api: GotzjiLoginItemApi, options: { packaged: boolean; platform: string; executable: string }): { status(): GotzjiStartupStatus; setEnabled(enabled: boolean): GotzjiStartupStatus } {
  const available = options.packaged && options.platform === 'win32' && path.win32.isAbsolute(options.executable) && path.win32.basename(options.executable).toLowerCase() === 'gotzji.exe';
  const status = (): GotzjiStartupStatus => {
    if (!available) return { available: false, enabled: false, mode: 'inspect-and-resume', reason: 'INSTALLED_WINDOWS_PRODUCT_REQUIRED' };
    const current = api.getLoginItemSettings({ path: options.executable, args: ['--gotzji-host-only'] });
    return { available: true, enabled: current.openAtLogin && current.executableWillLaunchAtLogin !== false, mode: 'inspect-and-resume' };
  };
  return { status, setEnabled: (enabled): GotzjiStartupStatus => {
    if (!available || typeof enabled !== 'boolean') throw new Error('GOTZJI_STARTUP_UNAVAILABLE');
    api.setLoginItemSettings({ name: 'gotzji', openAtLogin: enabled, path: options.executable, args: ['--gotzji-host-only'] });
    return status();
  } };
}
