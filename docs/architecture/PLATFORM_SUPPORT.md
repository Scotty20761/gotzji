# Native platform support contract

Status: gotzji v1.0 source and qualification contract. Windows x64 is the current
distribution target, with one private official-unsigned candidate that remains
unpublished. macOS and Linux currently receive portable source-contract checks
only; no native gotzji package on those platforms is qualified or published.
Historical v4.62.2 cross-platform coverage is retained as the implementation
baseline and future qualification map, not as a statement of current artifacts.

## Decision rules

1. A provider is composed only when it belongs to the detected host platform.
   A Windows provider is never instantiated on macOS or Linux and then allowed
   to fail at execution time.
2. `native` means the capability has a first-party provider and a release gate
   for that platform. `dependency_gated` means the provider is valid but a
   permission, desktop session, optional runtime, or external application must
   be detected before it is reported ready. `unsupported` means the operation
   is not exposed as a misleading substitute on that host.
3. Readiness must distinguish `ready`, `needs_setup`, `blocked`, `disabled`,
   `unsupported`, and `unknown`. Unsupported is not an unavailable dependency,
   and neither is allowed to masquerade as ready.
4. A target-native executable is included only with a pinned version, official
   URL, SHA-256, executable-bit check, `--version` smoke test, and packaged-path
   test. Release mode never falls back to an unverified system executable.
5. Windows-only behavior that has no safe equivalent is cut from the foreign
   platform surface. It remains available on Windows with its existing contract.

## Support matrix

| Host | Architecture | Tier | Release baseline | Desktop/session gate |
| --- | --- | --- | --- | --- |
| Windows 10/11 | x64 | current candidate target | gotzji v1.0.0 private Setup and Portable; official unsigned and unpublished | Interactive Windows desktop |
| macOS 13+ | arm64 | source contract only | Native DMG/ZIP qualification deferred; no current gotzji artifact | Accessibility/Screen Recording as needed |
| macOS 13+ | x64 | source contract only | Native DMG/ZIP qualification deferred; no current gotzji artifact | Accessibility/Screen Recording as needed |
| Ubuntu 24.04 LTS | x64 | source contract only | Native AppImage/DEB qualification deferred; no current gotzji artifact | GNOME Wayland and X11 smoke remain future acceptance gates |
| Linux | arm64 | preview source contract | Target-native artifact/runtime qualification deferred | Wayland/X11 session-specific gates |
| Other OS/architectures | any | unsupported | No release artifact | Fail closed with `unsupported_platform` |

Future Linux package acceptance starts with Ubuntu 24.04 LTS, GNOME Wayland,
and X11; KDE Wayland remains a future smoke target. Current Linux CI evidence is
source-contract evidence only. Headless source support for portable MCP and
dependency-gated capabilities is not evidence of a qualified desktop package.

## Capability disposition matrix

The capability names below are the complete local capability set in
`packages/capabilities/src/index.ts`. The platform column describes source
composition and provider disposition. It is not an assertion that an optional
dependency is installed or that a native package is currently distributed.

| Tool/capability | Windows | macOS | Linux | Notes |
| --- | --- | --- | --- | --- |
| `shell` | native | native | native | Neutral argv-only process provider |
| `dom_cdp` | dependency_gated | dependency_gated | dependency_gated | Browser installation, CDP profile, and running state are separate |
| `accessibility` | native | dependency_gated | dependency_gated | Win UI Automation; AXUIElement; AT-SPI |
| `input_event` | native | dependency_gated | dependency_gated | Host input permission/session required |
| `vision` | native | dependency_gated | dependency_gated | OCR/media provider and display permission are explicit |
| `window` | native | dependency_gated | dependency_gated | Win32; AppKit/CoreGraphics; X11/desktop APIs |
| `health` | native | native | native | Portable provider aggregation |
| `system_info` | native | native | native | Portable read-only probes |
| `notification` | native | dependency_gated | dependency_gated | Native notification center or desktop portal |
| `file_dialog` | native | native | dependency_gated | Electron dialog; Linux desktop session may be absent |
| `clipboard` | native | dependency_gated | dependency_gated | Electron/host permission and session checks |
| `web_fetch` | native | native | native | Existing network policy and bounded HTTP(S) contract |
| `audio` | native | dependency_gated | dependency_gated | Host capture/output permission and backend |
| `screen_record` | native | dependency_gated | dependency_gated | Screen Recording permission; portal/PipeWire on Wayland |
| `office` | native | dependency_gated | dependency_gated | Microsoft COM remains Windows-only; app/schema support is probed |
| `scheduler` | native | dependency_gated | dependency_gated | macOS LaunchAgents and Linux per-user systemd timers; no cron alias |
| `wsl_exec` | native | unsupported | unsupported | WSL2 and `wsl.exe` are Windows-only |
| `wsl_fs` | native | unsupported | unsupported | No raw `\\wsl$` or foreign path emulation |

The following upgrade-catalog and diagnostic names are platform-sensitive even
though they are not in the local capability array:

| Tool/feature | Windows | macOS | Linux | Disposition rule |
| --- | --- | --- | --- | --- |
| `tunnel-client` | native | dependency_gated | dependency_gated | Bundle only verified target-native official release bytes |
| `registry_context` | native | unsupported | unsupported | Windows Registry has no portable equivalent |
| `windows_environment` | native | unsupported | unsupported | Windows-specific environment/registry view is not renamed as generic info |
| `windows_sandbox` | native | unsupported | unsupported | Windows Sandbox is not emulated with a process or container alias |
| `sandbox_exec` | dependency_gated | unsupported | unsupported | Windows Sandbox execution has no safe portable equivalent; the Windows-only surface is cut elsewhere |
| `event_log_context` | native | native | dependency_gated | Event Log, Unified Log, or journal provider must be probed |
| `service_context` | native | dependency_gated | dependency_gated | Windows services, launchd, or systemd only when the host provider exists |
| `office_ppt` | native | dependency_gated | dependency_gated | Unsupported application/action pairs fail explicitly |
| `office_outlook` | native | unsupported | unsupported | Outlook COM automation is Windows-only |
| `pdf_provider_installer` | native | unsupported | unsupported | Windows-specific provider installer/remediation is not shown elsewhere |

## Bundled tunnel-client contract

The official release source is [openai/tunnel-client releases](https://github.com/openai/tunnel-client/releases).
The build pipeline must resolve a concrete release asset for each target tuple,
record its version, URL, SHA-256, and provenance, then stage it under the
packaged application resources. The launcher must use the staged executable and
fail closed when the artifact is missing, has the wrong hash, lacks the
executable bit, or fails `--version`.

| Target | Required release evidence | Product state when no asset exists |
| --- | --- | --- |
| Windows x64 | Official Windows asset + hash + packaged smoke | supported only after evidence |
| macOS arm64/x64 | Official macOS asset + hash + executable smoke | dependency_gated; no system fallback |
| Linux x64 | Official Linux asset + hash + executable smoke | dependency_gated; no system fallback |
| Linux arm64 | Official arm64 asset + hash + package smoke | preview until production target-native evidence is complete |

The inherited CI workflow retains the topology for producing SHA-scoped Windows,
macOS, and Linux evidence bundles. For gotzji v1, only the private Windows x64
candidate has been built and verified; the multi-platform tag publication path
is not authorized. Each deferred target must first produce target-host package,
signature, startup, permission, and recovery evidence for the exact source SHA.

Secure Tunnel continues to target the running Desktop loopback HTTP MCP. The
packaged direct-stdio launcher is a separate local transport and must not be
used as a hidden tunnel fallback. API keys are protected by the host secret
provider; profiles contain references, not plaintext credentials.

## Windows-only features that are intentionally cut elsewhere

These are not renamed, approximated, or reported as ready on macOS/Linux:

- WSL execution and WSL path translation;
- Windows Registry and Windows-specific environment views;
- Windows Sandbox and Windows-only sandbox remediations;
- Win32-only UI fields/actions and Windows PDF provider installation;
- Microsoft Office COM and Outlook COM actions;
- PowerShell/DPAPI-specific secret code, `.cmd`/`.bat` launch assumptions, and
  Windows service/task-scheduler semantics.

Generic process, filesystem, network, path, environment, diagnostics, and
logging tools use host-neutral providers. A missing host provider returns
`unsupported_platform` or a precise `dependency_gated` reason; it never creates
a fake Windows-shaped result.

## Permission and privacy boundary

Electron renderer sandbox/navigation security remains enabled on all desktop
targets. Native helpers receive only bounded, validated requests and return
structured results; they do not receive API keys or arbitrary shell strings.
Accessibility, Screen Recording, Microphone, Automation, Keychain/secret-store,
portal, and browser permissions are opt-in, observable, and revocable. No
permission prompt grants MCP mutation approval by itself.

This contract is versioned with the tool registry. Any new platform-sensitive
tool must add a row here, a composition/readiness test, a failure disposition,
and packaging evidence before it can be advertised.
