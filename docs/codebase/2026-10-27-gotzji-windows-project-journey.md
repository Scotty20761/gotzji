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
