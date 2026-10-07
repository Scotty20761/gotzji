# Windows packaging

The current v5.7.3 packaging contract targets the isolated gotzji Windows x64 app. Source baseline 5.7.3 is not an official gotzji release. No macOS/Linux/ARM64 release is claimed.

Expected local candidate paths:
- apps/desktop/dist/installers/gotzji-Setup-5.7.3.exe
- apps/desktop/dist/installers/gotzji-Portable-5.7.3.exe

Use corepack pnpm@10.15.0 package:windows from a clean owned source checkpoint. The canonical script builds the host and app, bundles native runtime helpers and preserves upstream/third-party notices. Build prerequisites include Node/Corepack and the .NET SDK where the native secret migrator requires it. Installed-user absence of those build tools requires a separate clean-machine qualification.

The owned release policy is official-unsigned: Setup and Portable report NotSigned, and both exact artifacts must match complete SHA-256/provenance/runtime evidence. This policy does not claim SmartScreen publisher trust. Automatic updates remain disabled. Keep private candidate files separate from publication until .github/RELEASE_CHECKLIST.md is satisfied; publish the same qualified bytes without rebuilding.

The independent host inventory includes its entrypoint, workers, brokers, schema/catalog code and all dependencies. Missing, extra or changed runtime files fail verification. OpenAI's pinned tunnel client retains its license/SPDX/provenance. Office/CAD are licensed external prerequisites, not redistributed applications.

Historical packaging instructions belong to docs/upstream/PACKAGING_WINDOWS-v5.7.3.md. Never use original lnwjud credentials, data, update feeds or job authority for gotzji qualification.
