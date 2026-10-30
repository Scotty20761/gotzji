# Portfolio Library Workflows for Gotzji

**Status (2026-10-25): Source implemented; focused Vitest and execution-core TypeScript build passed; full local test suite timed out; installed app and private release NOT qualified.**

Three host-direct `library.workflow` entries have been added to Gotzji's existing execution core: `library.portfolio-build:1`, `library.portfolio-private-deploy:1`, and `library.portfolio-production-verify:1`.

Each accepts `parameters: {}` only and is restricted to the enrolled Library project ID `investment-library`. Project type is NOT changed. The pipeline uses the real Investment Library Dime fill source, broker snapshot and existing `pf_daily_refresh.py`, `pf_reconcile.py`, `deploy_private_portfolio.py`, and `audit_portfolio_private.py` rules. Nothing places brokerage orders or edits Yahoo Finance.

Build runs `pf_daily_refresh.py --build-only`, fails when the canonical reconciler rejects a result, and independently checks as-of, count, per-ticker broker shares/cost targets and phantom positions. Deploy is a separate `deliveryScope: deploy` step after that gate; the owner must grant delivery for the selected job in Gotzji Worklog. It invokes the canonical `pf_daily_refresh.py --force` only and makes nonzero/ambiguous effects non-retryable until inspected. Production verification compares local snapshot, generated state, private release receipt, bundled state and a fresh Cloudflare Access challenge via the existing privacy audit; authenticated owner browser verification is still necessary to claim live holdings parity.

Changed source: `packages/execution-core/src/library-workflow-registry.ts`, `product-library.ts`, `product-library-broker.mjs`. New tests: `portfolio-library-workflows.test.ts`, `portfolio-library-gates.test.ts`.

## Acceptance still required

1. Focused Vitest passed 8/8, core TypeScript build exited 0. Local full core suite passed product (39), product-library (22), native-core (18), then timed out after 900 s with `GIT_VALIDATION_BUDGET` warnings; diagnose this runner and require exact-SHA CI before release.
2. Inspect changed-files scope, perform approved Git delivery, build a new Gotzji desktop/host distribution, qualify installed Plugin registration.
3. Prove fresh job receipts for build, blocked deploy without owner authorization, approved deploy with Private Access, and separate owner-authenticated Production verification.

Do **not** claim three workflows appear in the currently installed Gotzji Plugin until its live catalog confirms that fact.

2026-10-25 execution follow-up: Regression fixtures now use entirely synthetic TEST positions, shares, and costs (no private portfolio holdings). The verifier rejects non-exempt failing ticker rows and compares the full generated portfolio-state.json bytes with its private release bundle, even when the as-of dates match. A new regression test rejects same-date bundle drift. CI on GitHub runs on dev pushes but cannot validate unpushed changes.

Later same-day verification: lnwjud recovered enough to run focused tests (8/8 PASS) and execution-core TypeScript build (exit 0). The full core suite timed out at 900 seconds after 79 further tests had passed; it is **not** a full-suite pass. The previous transient quota and Git guards cleared sufficiently to stage exactly six project files on `dev`; `git diff --cached --check` exited 0. This evidence does not qualify an installed Gotzji binary, Plugin catalog exposure, owner-approved Cloudflare delivery, or authenticated Portfolio production. Previous queued Gotzji Library file writes are independent and not prerequisites.
