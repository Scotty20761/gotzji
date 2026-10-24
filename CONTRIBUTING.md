# Contributing to lnwjud

Thanks for helping improve gotzji. The current v1 release target is the owner-maintained Windows x64 app and personal MCP plugin. The retained upstream packages still contain cross-platform code, so changes should preserve local-first behavior, explicit trust boundaries, platform-specific capability gates, and deterministic verification without claiming macOS/Linux release support that v1 does not publish.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- For a large feature or architectural change, open an issue first and describe the intended behavior and compatibility impact.
- Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not the public issue tracker.
- Never commit credentials, private keys, local databases, user logs, machine-specific secrets, or private project data.

## Development environment

Day-to-day development and the official gotzji v1 release gate run on Windows x64. Retained macOS/Linux source tests remain useful compatibility checks, but their native packages are a later release track and are not required or published by the Windows-only v1 workflow.

Required for source development:

- Node.js 24.x
- Git
- Corepack
- pnpm 10.15.0 (pinned by the repository)

Install dependencies from the repository root:

```powershell
corepack pnpm@10.15.0 install --frozen-lockfile
```

Do not silently upgrade the package manager or rewrite the lockfile for an unrelated change.

## Making changes

- Make changes directly on `dev`; do not create a new development branch. Keep
  `main` for the checked `dev -> main` pull request and release history.
- Keep each change focused and reviewable before it is included in that pull request.
- Preserve workspace/path/security boundaries; do not bypass permission checks to make a test pass.
- Avoid hard-coded developer paths, usernames, tokens, ports, or machine-specific assumptions.
- Add or update tests for behavior changes and regressions.
- Keep tool catalog, version metadata, README, and release documentation synchronized when your change affects them. Show only the three newest versions in `README.md` and `FULL_README.md`; preserve older release highlights in [`RELEASE_NOTES.md`](RELEASE_NOTES.md).
- Do not bump versions or create release tags unless the change is explicitly a release-preparation change.

## Verification

Run the smallest relevant tests while developing. Before requesting review for a substantial change, run the checks that cover the affected packages.

Common commands:

```powershell
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:integration
corepack pnpm@10.15.0 test:e2e
corepack pnpm@10.15.0 test:packaging
corepack pnpm@10.15.0 docs:tools:check
git diff --check
```

The authoritative release gate is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1
```

Release verification is intentionally heavier than normal development checks; do not repeatedly run it while iterating on a small change. Pull-request/non-main CI uses the same gate with `-SkipWindowsPackaging` to avoid rebuilding NSIS/Portable artifacts that cannot be published from a PR.

For an actual release, follow the canonical [release process](docs/development/RELEASE_PROCESS.md). In particular, prepare on `dev`, wait for the required PR check, merge through branch protection, wait for the full exact-SHA `main` CI artifact, and only then create the `vX.Y.Z` tag. Never tag first and hope CI catches up later.

## Pull requests

A good pull request should include:

- What changed and why.
- User-visible behavior or compatibility impact.
- Security/trust-boundary implications, if any.
- Tests run and their results.
- Screenshots for meaningful desktop UI changes.
- Migration or rollback notes when storage/schema behavior changes.

By contributing, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
