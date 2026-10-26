# Windows navigation and selected project journey

Status2026-10-27: implemented on dev; full Desktop unit suite and the six applicable Electron journeys pass. Complete Electron verification remains RED on two other cases. No package, installed app, actual ChatGPT account or release qualification is claimed.

## Delivered behavior

- Nine top-level pages follow the pinned lnwjudv5.8.7 order. Queue is retained as a Work Log tab and a Home entry, with loading/failure states, keyboard tab controls and the same selected job.
- A trusted local `pickProjectFolder` preload/IPC method opens an Electron directory-only dialog owned by the current window. It accepts no renderer options or input, returns only cancelled/path, never calls Core and never enrolls or starts work. Cancellation retains the form's previous path. Registration remains an explicit owner action through the existing contract.
- Project context displays current AGENTS.md/CLAUDE.md separately from saved notes, existing canonical project jobs and the25-job history bound. Selecting a history entry opens its exact job; disposed or wrong-project responses cannot become current context.
- A late project-selection reply no longer redirects an owner who already opened another page. Existing selected-project persistence and archive/restore behavior remain intact.
- Atlas, exact Grace portrait, existing controller/history/approval authority and manual update/version policy remain unchanged. New work still starts from ChatGPT.

## Verification

Baseline: `6e983493f38809e53bfa3dc1a131f3099710936a`. No timeout, Git budget, cancellation/termination proof, fixture cleanup logic or assertions were relaxed.

| Check | Observed result |
|---|---|
| IPC contracts, execution Core and Desktop builds | exit0; Desktop main/preload and renderer rebuilt from the source |
| Scoped ESLint and Desktop typecheck | exit0 |
| Complete Desktop Vitest |143files passed;959tests passed,2explicit skips; exit0 |
| Trusted no-input picker boundary |16/16 in existing desktop boundary file; untrusted/extra input denied; cancel/select paths covered |
| First full Electron run |15passed,1failed,2skipped; actual late-selection navigation race discovered |
| Controlled late-selection regression |actual RED then GREEN after the minimal conditional navigation correction |
| Original Git plus delayed-selection focused run |2/2passed; actual10,020-object read completed in59,630ms with index preservation |
| Final complete Electron run |16passed,2failed,2explicit native skips; exit1 |
| Six packet journeys in that final run |all pass: nine-page/queue navigation, directory/project/instructions/history, late selection, modeled stale/wrong/truncated context, selected-project reload and archive/restore |
| Two-axis source review |Standards:0hard violations,1nonblocking row-rendering heuristic; Spec:0material findings, final delta rechecked |

Reproduction uses `corepack pnpm@10.15.0 --filter @lnwjud/desktop test` and `corepack pnpm@10.15.0 --filter @lnwjud/desktop exec playwright test --config playwright.gotzji.config.ts`. Local logs: `.local-artifacts/windows-ui-c1-desktop-tests-20261027.log` and `windows-ui-c1-electron-tests-20261027.log`. Local owned screenshots: `windows-ui-c1-project.png` and `windows-ui-c1-worklog.png` in that directory.

The folder dialog response is controlled inside the isolated owned Electron test app; this qualifies renderer/preload/trusted-main/Electron-dialog wiring, not manually clicking an OS dialog. The bounded-history and stale/wrong context case models the documented public response; it is not proof of26actual executed jobs. Ordinary instructions and one canonical history job are exercised against the real isolated Core. Excel/Chrome actual-program cases remain explicitly skipped without their opt-in flags.

## Retained failures and remaining acceptance

- Final Git failure is `GIT_SNAPSHOT_BUDGET`, not the repaired navigation race. Existing diagnostics show phase `objects`,60,005ms,10,023objects,7,280copied/370,565bytes,16I/O threads. The preceding focused actual case passed; that does not qualify the later full run or explain the slowdown. Whole-vault validation/index regeneration overlapped the final run; this is a possible confound, not a proven cause.
- Git and workflow teardown additionally reported EBUSY on Chromium's `ui/declarative_performance_observer.db`. Initial navigation runs also retained UI/SQLite files. Old roots were preserved. Read-only Restart Manager/CIM checks after the first incidents found no current owner, which cannot establish the historical cause. Later successful teardown is non-reproduction, not a cleanup fix.
- Full Electron/release verification remains open. Complete later Windows interactions, all provider/native parity, guided setup, web/iPhone companion, exact installed/actual-ChatGPT and release gates remain separate work. This packet cannot justify merge, installation or release promotion.
# Live Tools continuation — successor fbd1d4517387

The source-keyed desktop release resumed the owner's active all-phase scope. The first meaningful receiver work added a real Electron Tools journey and observed its RED at the missing live catalog region, then emitted the source-matched ACK. No duplicate chat, Goal, scheduler, CI watcher or installed-profile adoption was created.

The live catalog now supports Thai/English search, category/readiness filters, selected-project workflow filtering, explicit unavailable-provider explanations and setting links. Direct file tools lead to the existing file browser. Other rows open the existing ChatGPT request form without admitting work. Registered recipes retain their identity when navigating to project binding; Library projects explicitly require their workflows or selection of an ordinary project. The pinned 294-name reference remains separate from host declarations and native/installed acceptance.

Browser request copying reads and validates the current project's browser session through the existing read API, with a changed-project guard. An initial reviewer statement that real catalog rows never contain browserSession was corrected: product-server.mjs enriches ready rows. This change improves freshness/context checks; the missing-catalog-session test is a modeled boundary, not proof that every previous real request failed.

Verification: the complete Desktop suite returned exit 0, 959 passed/2 skipped across 143 files. Renderer build, scoped ESLint and typecheck passed; the final post-review typecheck/lint/diff check is recorded by the continuation. Three new Electron cases cover the actual host catalog/copy/no-job journey, modeled unavailable/empty/unknown/readiness/Library/full-workflow identity, and modeled fresh-browser-session copying without prepareOperation/submit. The latest real Tools case passed 1/1 and the other two cases passed 2/2. An intervening combined run returned 1 with all first-case behavior assertions complete but EBUSY removing ui/declarative_performance_observer.db, then two passing cases. Earlier cleanup also reported core.sqlite-shm EBUSY. These are retained failures with cause UNKNOWN; later clean teardown is non-reproduction, not a cleanup fix. No deadline, containment or process-absence check was weakened. Screenshot: ignored .local-artifacts/windows-ui-c1-live-tools.png, visually inspected after generation.

Two-axis review: Standards 0 hard violations/1 nonblocking duplicated classification heuristic. Spec found unbound-recipe/Library prerequisite gaps; corrections were separately implemented and read back by the reviewer with no remaining material defect in the packet. Native execution, installed adoption, actual Pro, broader Windows workflows/results/input/settings/Doctor, companion and release remain open in the same all-phase scope. Root continues the next available packet after preserving this source milestone.

## Readable same-job file and command results — continuation

The next accepted Windows packet uses the existing result request and Core verifier. It renders escaped file text, distinguishes a created file from a replacement, reports a retained original only when the returned original snapshot matches, and shows command ID/exit 0/measured duration/bounded log size. Its log button retains the same selected job. Unsupported result types explicitly lack a summary and retain collapsed raw details. Expired, changed, unverified and unavailable results have ordinary Thai explanations plus expandable original errors. No artifact-open/download, job-input producer, storage schema, IPC route or effect authority was added.

The public projection tests were RED before each implemented slice: missing module, write projection, command projection, quiet command optional field, and error-message function. Final focused result/browser/Excel tests passed 35/35 (six new cases), exit 0. Final typecheck, scoped ESLint, renderer build and diff check returned 0. Real affected file edit/create/command cases passed; the new actual file-read job survived reload/reselection without duplication, and both stale Excel response cases passed (3/3 together). The command-to-same-job-log case passed after correcting two test assumptions: the existing heading is 'งาน <id>' and its initial bounded log page need not contain the final PAGE_END marker. Earlier assertions on full log paging remain intact.

Complete 24-case Electron run returned exit 1:20 passed/2 failed/2 native skips. Both failures occurred before the case body at host PRODUCT_HOST_NOT_READY / ready-timeout (empty stderr, no endpoint), not at a result or Tools assertion. Roots gotzji-desktop-e2e-evUe0w and gotzji-desktop-e2e-yoRylc were retained because process absence was not established by the fixture; no cleanup condition/deadline was weakened. A later read-only process census found no host command line for either exact root (only the probe itself matched). This does not establish the historical startup cause. The 10,020-object Git journey completed this time in 26,341ms; this is non-reproduction of the old budget failure, not a causal performance repair.

Standards review:0 hard violations/0 heuristics. Spec review and its final error/fallback delta read-back:0 material findings. Both are independent read-only collaborators; root owns all edits and tests. A generated file-result screenshot was inspected; the final full-run screenshot scrolls the result into view. Current actual native Excel/Chrome qualification is a separate explicit owned-fixture command; record its terminal outcome separately. The previous full Desktop959/2skip receipt belongs to the Tools milestone; it is not relabelled as a full965-case result after these six tests were added.

## Post-mortem — ZIP directory records falsely blocked native Excel edits

### Summary
The accepted C4 Excel write qualification changed one cell in a new workbook copy but blocked with NATIVE_MEDIA_PRESERVATION_FAILED. Media-Snapshot counted an empty ZIP directory as a media payload. Skipping directory records fixes the false alarm while retaining all real payload checks. Owner: Image; tracker: existing issue10/C4; fix: current dev diff above0f53df90.

### Symptom and root cause
Two actual governed writes ended blocked/uncertain with source unchanged, output present and owned Excel absent. In apps/desktop/build/gotzji-native-office.ps1, Media-Snapshot selected every entry under xl/media/, including xl/media/ itself. ExcelJS emitted that zero-byte directory entry; Excel SaveAs omitted it. The source census therefore contained an empty-directory hash plus one image while the output census contained only the identical image. Comparing these sorted arrays raised the preservation error after save/reopen. Source and output image1.png both contain70bytes and hash9519e7335a2d5ee89d788be7ba1b748a34f6d0ec60ce75a30e87f0ecd863db96. The PNG did not change.

### Fix
Media-Snapshot now skips only ZIP entry names ending '/'. It still hashes/counts zero-byte files, media files and the macro payloads recognized by the existing extension guard. Original hash, unrelated data/structure, native ownership, save/reopen and current output-hash checks remain unchanged. PRODUCT_PROVIDER_SHA256.office is updated to the actual shipped script057a38cd742bbc46ce2133b58eb50177711c89767e9fc6c48d0d7afe1f98372d; no profile, version or installed runtime was changed.

### How it was found and why it slipped through
The first actual write reached the preservation error. A second fresh owned fixture captured source/output archives before cleanup and failed at the same code. ZIP member/hash/size comparison falsified image re-encoding and isolated container-directory membership. Independent Spec review read the diagnostic ZIP pair and confirmed it. Earlier actual Excel checks exercised read/discovery only; default CI skips explicit native qualification. Those paths did not exercise Excel's save-time ZIP rewrite.

### Validation and limits
Original public Electron/native repro now passes, exit0 in51.2s, with the actual shipped default provider after a full Desktop rebuild. Independent ExcelJS read-back verifies the new A1 value, preserved SUM(A2:B2) formula/result5, unchanged other worksheet, exact image bytes, unchanged source bytes, current output SHA, native save/reopen receipt and same preparation replay ID. Owned Excel absence is checked after every job. Core product-host tests15/15 and Desktop build pass0; scoped lint/diff checks are recorded separately. Standards and Spec reviews report0hard/material findings. This qualifies this current Windows Excel fixture, not every workbook, macro format, Word/PowerPoint/CAD route, installed app or actual ChatGPT caller.

### Follow-up
Image continues broader C4 provider/object qualification under issue10. Retain prior RED archives and receipts; do not turn the later GREEN into a claim that old uncertain jobs were safely replayed. The transient E2E ready-timeout/EBUSY/Git-budget investigations remain separate and unresolved.

## Hosted Windows CI fixture correction — validated source packet

Summary: exact0f53df90 push run40385345726 failed in job121792018599, Desktop Test Shard (Windows,2/2). The secret-decryption release case expected 'secret decrypt failed' but received 'Timed out waiting for the lnwjud tunnel lock critical section'. The exact failed-job excerpt is retained in ignored .local-artifacts/ci-0f53df90-job-121792018599-failure.json. No blind CI rerun was used.

Root cause at the test seam: this case injects a fake owner PID, fake executable and failing secret reader, yet implicitly selected the host Windows mutex helper before reaching the injected failure. Native helper acquisition failure masked the behavior the case intended to prove. A deterministic RED with PATH confined to an empty owned fixture returned 'spawn powershell.exe ENOENT' before decryption. The actual cause of the hosted helper startup delay remains UNKNOWN; this correction does not claim to repair native startup.

Fix: the case explicitly selects the existing portable lock platform and computes the matching profile directory. It retains the empty-PATH condition, asserts decryption is called exactly once, and still verifies the real ownership file and in-memory handle are cleared. Production mutex code/deadlines remain unchanged. Existing Windows native mutex and TypeScript/PowerShell publisher tests remain separate.

Validation: focused original regression GREEN1/1, then complete tunnel-controller/tunnel-lock/session-resilience acceptance94/94 on this Windows host, exit0. Typecheck, scoped ESLint and diff check return0. Independent Standards/Spec reviewers found0material issues and explicitly scoped this to the fixture dependency correction. New hosted CI is not yet confirmed. Old33507856 is pushSUCCESS/PRcancelled;0f53df90 is pushFAILURE/PRcancelled, with terminal watcher receipts. Neither is relabelled all-green.
