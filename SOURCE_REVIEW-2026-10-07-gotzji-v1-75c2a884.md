# gotzji v1 source review — checkpoint 75c2a884

Fixed point: `1a54696341a5c4d10dd6f52ebb60ef82f4a780ae`  
Reviewed checkpoint: `75c2a884`  
Diff: `git diff 1a54696341a5c4d10dd6f52ebb60ef82f4a780ae...75c2a884`

This record preserves the independent review findings before remediation. It is not a release-readiness claim.

## Standards — raw findings

1. **Hard: incomplete legacy/product E2E split.** `apps/desktop/package.json`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/main.tsx`, and `apps/desktop/src/main/main.ts` switched only the main bundle. The preload still exposed `window.gotzji`, selecting `GotzjiApp` while the legacy main registered no gotzji IPC. This conflicted with `CONTRIBUTING.md`'s regression-test requirement.
2. **Hard: provider-reset retry lacked regression coverage.** `packages/execution-core/src/core.ts` deletes an expired provider limit and relaunches the same job, but `packages/execution-core/src/product.test.ts` stopped before reset and did not prove relaunch or completion.
3. **Hard: contributor and release policies conflicted.** CI/release workflows selected Windows-only gotzji v1 while `CONTRIBUTING.md` still required native Windows, macOS, and Linux package validation before any public release.
4. **Judgement: duplicated code / shotgun surgery.** `apps/desktop/package.json` duplicated the esbuild invocation to flip one build flag while product selection also depended on preload and renderer behavior.
5. **Judgement: repeated switches / divergent change.** `packages/execution-core/src/core.ts` repeats native/library/browser branches across resource selection, receipt verification, reconciliation, and cleanup.

Standards summary: three hard findings and two judgement-call smells. The worst hard issue was that the compatibility E2E lane did not exercise the surface it claimed to cover.

## Spec — raw findings

1. **P3/G05 partial: general-project code QA was only syntax checking.** The accepted plan requires reviewed background commands and normal build/test/lint/typecheck workflows. `packages/execution-core/src/product-server.mjs` registered only `node-check`; the typed `command.run` schema did not make those workflows discoverable or runnable. Library `code-qa:2` is vault-specific.
2. **P7/G13 partial: final-memo v2 did not execute canonical named spokes.** The registry fingerprinted the Mammos, Facty, and Indie files, but `packages/execution-core/src/product-library-broker.mjs` launched plain `claude -p` with a hand-authored role prompt, empty tools, no `--agents`, no `--agent`, and no canonical agent-body binding. The runtime-spoke hashes proved subprocess output, not Mammos → Grace → Facty → Indie execution.
3. **Acceptance boundary: source/component proof only.** The checkpoint did not establish actual Plus/Pro, installed/reboot/endurance, clean-machine, pilot, or G01–G20 acceptance.

Spec summary: three findings. The worst issue was that G05 and G13 appeared in catalog/receipts without the required production recipe and canonical-spoke execution paths.

## Scrutinize — checkpoint findings

**Intent:** turn the owner-maintained fork into one Windows x64 gotzji app and personal MCP plugin, governed by one durable Grace authority, while preserving exact evidence and explicit release gates.

**Simpler alternative:** retain the neutral core and existing provider adapters with thin app/plugin transports. A second scheduler, raw shell catalog, app-local job engine, paid inference provider, or copied stock connector adds risk without satisfying the accepted scope.

**Trace:** app IPC and MCP enter `product-server.mjs`, select the enrolled owner/project, prepare a typed operation, submit one durable claim, acquire server-derived resources, launch the governed worker, verify provider/artifact receipts, then project status/result. Release assets flow from exact source/build identity through runtime/plugin inventories, candidate qualification, and unchanged-byte collection. At `75c2a884`, those paths were interrupted at E2E product selection, general-project command enrollment, and canonical role dispatch. Provider-reset continuation and Windows atomic receipt replacement also required changed-claims verification.

**Checkpoint verdict:** **fix-then-ship for source review**. Catalog and spoke receipts overstated the runnable production path; external G01–G20 gates remained separate and unaccepted.
