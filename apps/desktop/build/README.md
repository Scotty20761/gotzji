# Desktop build resources

This directory contains source build resources used by Electron Builder, including the retained upstream application icons and the isolated gotzji NSIS include file. The upstream MIT notice is included in packaged resources.

The MCP stdio launcher files (`gotzji-mcp-stdio.cmd` and `gotzji-mcp-stdio.sh`) are **generated artifacts**, not source files. `pnpm build` / `pnpm package:windows` regenerates them before packaging. They are intentionally ignored by Git so stale local bundles and machine-specific build content cannot become part of the public source tree.

Current Windows packaging uses:

- `build/icon.ico` for the Windows executable, installer, and uninstaller branding.
- `build/icon.png` as an application image resource.
- `signAndEditExecutable: true` so Electron Builder can apply executable metadata/icon editing.
- x64 NSIS, per-user installation, with a user-selectable installation directory.
- `deleteAppDataOnUninstall: false`, so uninstalling the application preserves gotzji user data by default. Explicit removal is restricted to gotzji directories; lnwjud data is never removed.
- `com.scotty20761.gotzji`, `gotzji.exe` and `Scotty20761/gotzji` isolate installer, shortcuts and release metadata from lnwjud.
- Official gotzji Windows artifacts use the declared `official-unsigned` trust policy. Authenticode observations, clean source provenance and SHA-256 verification remain mandatory. Automatic checks, downloads and installation are disabled; updates use manually verified release files.

Do not hand-edit generated stdio bundles. Change their source under `apps/cli/` or the launcher generator script, rebuild, and verify the resulting package instead.
