import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');

function section(config: string, start: string, end: string): string {
  const startIndex = config.indexOf(`${start}:`);
  const endIndex = config.indexOf(`\n${end}:`, startIndex + start.length + 1);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return config.slice(startIndex, endIndex);
}

describe('Secure Tunnel packaging and legacy stdio launcher generation', () => {
  it('does not ship the unsupported packaged stdio launcher or a duplicate Node runtime/CJS entry', async () => {
    const config = await readFile(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
    const mac = section(config, 'mac', 'linux');
    const linux = config.slice(config.indexOf('linux:'));
    expect(config).not.toContain('build/gotzji-mcp-stdio');
    expect(config).not.toContain('to: gotzji-mcp-stdio');
    expect(mac).toContain('arch:');
    expect(mac).toContain('- x64');
    expect(mac).toContain('- arm64');
    expect(linux).toContain('target: AppImage');
    expect(linux).toContain('target: deb');
    expect(config).not.toContain('lnwjud-mcp-stdio.cjs');
    expect(config).not.toContain('lnwjud-node.exe');
  });

  it('retains the legacy Windows launcher generator semantics without shipping the result', async () => {
    const launcher = await readFile(path.join(desktopRoot, 'build', 'gotzji-mcp-stdio.cmd'), 'utf8');
    expect(launcher).toContain('set "BASE=%~dp0"');
    expect(launcher).toContain('set "APP=%BASE%gotzji.exe"');
    expect(launcher).toContain('"%APP%" --mcp-stdio %*');
    expect(launcher).not.toContain('NODE_EXE');
    expect(launcher).not.toContain('lnwjud-mcp-stdio.cjs');
    expect(launcher).not.toContain('powershell');
  });

  it('retains the legacy POSIX launcher generator semantics without shipping the result', async () => {
    const launcherPath = path.join(desktopRoot, 'build', 'gotzji-mcp-stdio.sh');
    const launcher = await readFile(launcherPath, 'utf8');
    expect(launcher).toContain('#!/bin/sh');
    expect(launcher).toContain('exec "$APP" --mcp-stdio "$@"');
    expect(launcher).toContain('gotzji.app/Contents/MacOS/gotzji');
    expect(launcher).toContain('$BASE/MacOS/gotzji');
    expect(launcher).toContain('$BASE/../MacOS/gotzji');
    expect(launcher).toContain('../lib/gotzji/gotzji');
    expect(launcher).not.toContain('node ');
    await access(launcherPath);
  });
});
