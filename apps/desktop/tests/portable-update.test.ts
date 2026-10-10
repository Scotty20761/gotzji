import { describe, expect, it, vi } from 'vitest';
import {
  PORTABLE_UPDATE_CHANNEL,
  PORTABLE_UPDATE_FEED_URL,
  AUTOMATIC_UPDATES_ENABLED,
  configureUpdaterForDistribution,
  configureUpdaterForPlatform,
  currentPortableExecutablePath,
  detectWindowsDistribution,
  detectUpdaterDistribution,
  portableReplacementScript,
  preparePortableReplacement,
  launchPortableReplacement,
  usesElectronUpdaterInstall,
} from '../src/main/portable-update.js';

describe('gotzji manual update policy', () => {
  it('disables automatic updating for every packaged distribution', () => {
    expect(AUTOMATIC_UPDATES_ENABLED).toBe(false);
    expect(detectUpdaterDistribution(true, 'win32', {})).toBe('unsupported');
    expect(detectUpdaterDistribution(true, 'win32', { PORTABLE_EXECUTABLE_FILE: 'C:\\gotzji.exe' })).toBe('unsupported');
    expect(detectUpdaterDistribution(true, 'darwin', {})).toBe('unsupported');
    expect(detectUpdaterDistribution(true, 'linux', { APPIMAGE: '/tmp/gotzji.AppImage' })).toBe('unsupported');
    expect(detectUpdaterDistribution(true, 'linux', {})).toBe('unsupported');
    expect(detectUpdaterDistribution(true, 'freebsd', {})).toBe('unsupported');
    expect(detectUpdaterDistribution(false, 'darwin', {})).toBe('unsupported');
  });

  it('rejects every automatic installation path even when the caller supplies a supported distribution', () => {
    expect(usesElectronUpdaterInstall('installer')).toBe(false);
    expect(usesElectronUpdaterInstall('macos')).toBe(false);
    expect(usesElectronUpdaterInstall('linux-appimage')).toBe(false);
    expect(usesElectronUpdaterInstall('portable')).toBe(false);
    expect(usesElectronUpdaterInstall('unsupported')).toBe(false);
  });

  it('distinguishes electron-builder portable launches from installed builds', () => {
    expect(detectWindowsDistribution(true, { PORTABLE_EXECUTABLE_FILE: 'C:\\Tools\\lnwjud-Portable-4.11.0.exe' }, 'win32')).toBe('portable');
    expect(detectWindowsDistribution(true, {}, 'win32')).toBe('installer');
    expect(detectWindowsDistribution(false, { PORTABLE_EXECUTABLE_FILE: 'C:\\Tools\\lnwjud.exe' }, 'win32')).toBe('installer');
    expect(detectWindowsDistribution(true, { PORTABLE_EXECUTABLE_FILE: '/tmp/lnwjud' }, 'linux')).toBe('installer');
  });

  it('never configures a feed for unsigned installer or portable builds', () => {
    const setFeedURL = vi.fn();
    const installerUpdater = { disableDifferentialDownload: false, setFeedURL };
    configureUpdaterForDistribution(installerUpdater, 'installer');
    expect(setFeedURL).not.toHaveBeenCalled();
    expect(installerUpdater.disableDifferentialDownload).toBe(false);

    const portableSetFeedURL = vi.fn();
    const portableUpdater = { disableDifferentialDownload: false, setFeedURL: portableSetFeedURL };
    configureUpdaterForDistribution(portableUpdater, 'portable');
    expect(portableUpdater.disableDifferentialDownload).toBe(false);
    expect(portableSetFeedURL).not.toHaveBeenCalled();
    expect(PORTABLE_UPDATE_FEED_URL).toBe('https://github.com/Scotty20761/gotzji/releases/latest/download/');
    expect(PORTABLE_UPDATE_CHANNEL).toBe('portable');
  });

  it('leaves the Linux updater inert', () => {
    const updater = { disableDifferentialDownload: false, setFeedURL: vi.fn() };
    configureUpdaterForPlatform(updater, 'linux-appimage');
    expect(updater.disableDifferentialDownload).toBe(false);
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  });

  it('rejects automatic portable replacement before accessing files or starting a process', async () => {
    await expect(preparePortableReplacement({ downloadedFile: 'missing.exe', currentExecutablePath: 'missing-current.exe' }))
      .rejects.toThrow('official-unsigned');
    expect(() => launchPortableReplacement({ scriptPath: 'missing.ps1', sourcePath: 'missing.exe', targetPath: 'missing-current.exe', powershellPath: 'missing-powershell.exe' }))
      .toThrow('official-unsigned');
  });

  it('replaces the outer portable executable path rather than Electron temporary extraction path', () => {
    expect(currentPortableExecutablePath({ PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\lnwjud-portable.exe' }, 'C:\\Temp\\lnwjud.exe')).toBe('D:\\Apps\\lnwjud-portable.exe');
    expect(currentPortableExecutablePath({}, 'C:\\Program Files\\lnwjud\\lnwjud.exe')).toBe('C:\\Program Files\\lnwjud\\lnwjud.exe');
  });

  it('uses a wait, rollback backup, in-place replacement, restart, and script self-cleanup for portable installs', () => {
    const script = portableReplacementScript();
    expect(script).toContain('Get-Process -Id $CurrentPid');
    expect(script).toContain('$Target.gotzji-update-backup');
    expect(script).toContain('Move-Item -LiteralPath $Target -Destination $backup -Force');
    expect(script).toContain('Move-Item -LiteralPath $Source -Destination $Target -Force');
    expect(script).toContain('Move-Item -LiteralPath $backup -Destination $Target -Force');
    expect(script).toContain('Start-Process -FilePath $Target');
    expect(script).toContain('Remove-Item -LiteralPath $PSCommandPath');
  });
});
