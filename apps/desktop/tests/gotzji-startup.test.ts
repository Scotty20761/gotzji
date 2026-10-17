import { describe, expect, it, vi } from 'vitest';
import { gotzjiStartupController } from '../src/main/gotzji-startup.js';

describe('isolated owner Windows logon startup', () => {
  it('writes only the packaged gotzji host-only launcher and verifies owner startup state', () => {
    let enabled = false;
    const setter = vi.fn((value: { openAtLogin: boolean }): void => { enabled = value.openAtLogin; });
    const api = { getLoginItemSettings: vi.fn(() => ({ openAtLogin: enabled, executableWillLaunchAtLogin: enabled })), setLoginItemSettings: setter };
    const controller = gotzjiStartupController(api, { packaged: true, platform: 'win32', executable: 'C:\\Programs\\gotzji\\gotzji.exe' });
    expect(controller.setEnabled(true)).toMatchObject({ available: true, enabled: true, mode: 'inspect-and-resume' });
    expect(setter).toHaveBeenCalledWith({ name: 'gotzji', openAtLogin: true, path: 'C:\\Programs\\gotzji\\gotzji.exe', args: ['--gotzji-host-only'] });
    expect(controller.setEnabled(false).enabled).toBe(false);
  });
  it('does not register developer, other-platform or original lnwjud startup', () => {
    const setter = vi.fn(); const getter = vi.fn(() => ({ openAtLogin: false }));
    for (const options of [{ packaged: false, platform: 'win32', executable: 'C:\\dev\\electron.exe' }, { packaged: true, platform: 'linux', executable: '/gotzji' }, { packaged: true, platform: 'win32', executable: 'C:\\Programs\\lnwjud\\lnwjud.exe' }]) {
      const controller = gotzjiStartupController({ getLoginItemSettings: getter, setLoginItemSettings: setter }, options);
      expect(controller.status()).toMatchObject({ available: false, enabled: false }); expect(() => controller.setEnabled(true)).toThrow('GOTZJI_STARTUP_UNAVAILABLE');
    }
    expect(setter).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  });
});
