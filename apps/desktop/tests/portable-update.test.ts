import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PORTABLE_UPDATE_CHANNEL,
  PORTABLE_UPDATE_FEED_URL,
  AUTOMATIC_UPDATES_ENABLED,
  configureUpdaterForDistribution,
  configureUpdaterForPlatform,
  createLinuxAppImageRollback,
  restoreLinuxAppImageIfMissing,
  currentPortableExecutablePath,
  detectWindowsDistribution,
  detectUpdaterDistribution,
  portableReplacementScript,
  preparePortableReplacement,
  launchPortableReplacement,
  usesElectronUpdaterInstall,
  waitsForNativeInstallAcceptance,
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
    expect(waitsForNativeInstallAcceptance('macos')).toBe(true);
    expect(waitsForNativeInstallAcceptance('linux-appimage')).toBe(true);
    expect(waitsForNativeInstallAcceptance('installer')).toBe(false);
    expect(waitsForNativeInstallAcceptance('portable')).toBe(false);
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

  it('retains a working rollback after a Linux AppImage native move deletes the original', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-appimage-'));
    try {
      const current = path.join(root, 'lnwjud-5.8.1-x64.AppImage');
      const downloaded = path.join(root, 'lnwjud-5.8.2-x64.AppImage');
      await writeFile(current, 'old-working-app');
      await writeFile(downloaded, 'new-app');
      const { backupPath } = await createLinuxAppImageRollback(current, downloaded);
      await unlink(current); // AppImageUpdater.doInstall() unlinks before its mv.
      expect(await restoreLinuxAppImageIfMissing(current, backupPath)).toBe(true);
      expect(await readFile(current, 'utf8')).toBe('old-working-app');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing Linux AppImage inputs before native installation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-appimage-'));
    try {
      const current = path.join(root, 'lnwjud.AppImage');
      const downloaded = path.join(root, 'update.AppImage');
      await writeFile(current, 'old');
      await expect(createLinuxAppImageRollback(current, downloaded)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // File symlinks require Windows privilege; this is a Linux installation contract.
  it.skipIf(process.platform === 'win32')('rejects symlinked Linux AppImage inputs before native installation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-appimage-'));
    try {
      const current = path.join(root, 'lnwjud.AppImage');
      const downloaded = path.join(root, 'update.AppImage');
      await writeFile(current, 'old');
      await symlink(current, downloaded);
      await expect(createLinuxAppImageRollback(current, downloaded)).rejects.toThrow('regular files');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
