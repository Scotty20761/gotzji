# gotzji

An open-source Windows MCP app for ChatGPT, with Grace controlling typed operations and durable workflows. Derived from [lnwjud](https://github.com/engasnm111/lnwjud); upstream MIT copyright and third-party notices are retained.

## Current source version: v5.7.3

The source retains the upstream version baseline while gotzji is being qualified. The release target is **gotzji v1.0.0**. No official gotzji installer release has been published. Source/test, installed app, actual ChatGPT and provider acceptance are separate records.

## Product design

- One independently owned local host and native Goal ledger serve the app and MCP. App views cannot launch another job engine.
- Grace executes user work through a task-bound typed broker and the existing Claude subscription. No paid inference API fallback is introduced.
- Enrolled projects, reviewed server recipes, exact-byte edits, durable logs/results, explicit job selection and selective cancellation.
- Independent jobs use resource-aware scheduling; conflicting project, document and interactive resources wait.
- Private state and credentials stay on the local machine. Original lnwjud data and jobs are not silently adopted.

## Development

Use Node.js 24 and Corepack pnpm 10.15.0. Work on `dev`; `main` is reserved for verified merges.

```powershell
corepack pnpm@10.15.0 install
corepack pnpm@10.15.0 --filter @gotzji/execution-core build
corepack pnpm@10.15.0 --filter @gotzji/execution-core bundle:host
corepack pnpm@10.15.0 --filter @lnwjud/desktop build
```

Remaining internal @lnwjud package names preserve upstream compatibility and do not identify the installed product. A configured official Claude CLI/subscription and licensed native applications are provider prerequisites. Missing or unqualified providers are reported instead of exposing raw fallback tools.

## Qualification and release

The v1 target includes files/code/commands, browser, Excel, Word, PowerPoint, ZWCAD 2025 and governed Investment Library integration, with separate ChatGPT Plus/Pro acceptance and installed 1–2 hour recovery tests. Components awaiting end-to-end qualification remain explicitly unavailable in the catalog; source presence is not a runtime pass.

The owner selected **official unsigned** Windows distribution. Setup and Portable candidates must report NotSigned and match complete SHA-256/runtime provenance. Automatic updates are disabled; manual updates require verified files and compatible state handling. Public v1 release follows real qualification and publishes the same tested bytes.

Do not publish local databases, credentials, tunnel/browser profiles, raw model/provider logs, private Library content or native fixture outputs.

## Attribution

- Original: [engasnm111/lnwjud](https://github.com/engasnm111/lnwjud).
- Licence: [MIT](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
- [Historical upstream README](docs/upstream/README-v5.7.3.md) documents the original project. Its downloads, support and feature claims belong to upstream.

The current [MCP control catalog](FULL_README.md#mcp-control-catalog) and [release process](docs/development/RELEASE_PROCESS.md) document the owned app path.
