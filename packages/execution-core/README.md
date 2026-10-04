# gotzji neutral execution foundation

This is the isolated phase-0 foundation of the owner-selected lnwjud fork,
based on v5.7.3 / `cbc4b90d5ab80f52c24a31a7620515bf993e890d`.
It is not an installed Desktop product, a ChatGPT connector or a production Grace executor.
Upstream MIT notices and the existing app are preserved. Workspace package versions
remain aligned with upstream; foundation schema/policy revision is 1.

## Run

From the fork root with Node 24:

```powershell
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 --filter @gotzji/execution-core... build
corepack pnpm@10.15.0 --filter @gotzji/execution-core test
corepack pnpm@10.15.0 --filter @gotzji/execution-core qualify
```

The qualification command allocates a fresh private run beneath
`%LOCALAPPDATA%/gotzji/execution-core/qualification/`. It exercises two
host-enrolled *fixture* adapters, fixed file effects, a reopened host and backend
completion. Its sanitized output names the private run directory and result;
credentials, binding handles and leases are not printed. It preserves the database
and evidence for inspection. It registers no tunnel, logon task, schedule or service.

## Authority and flow

`prepare -> submit -> select -> resume -> supervisor observation -> result/cancel`.
`select` returns private adapter authority; model-visible outputs contain only `JobView`.
Adapters never select an owner, role, executable or shell. Host-only enrollment maps
two independent credentials to one owner. A task ID selects a job and grants no authority.

One SQLite file composes the native `GoalContinuationService` and
`SqliteGoalRepository` with enrollment, request/digest claims, private bindings,
worker records, held Library writer ownership, operation receipts and a projection
outbox. There is no second mutable job-status table. Public status derives from
native state and effect/cleanup evidence. Native delivery metadata cannot finish a job.

The native `GoalMutationFenceService` provides trusted task-state observation.
Its mutation-admission method requires a scheduled continuation; this host instead
combines native `validateGoalLease` with its own persistent writer/operation fence.
It creates no scheduled continuation as a workaround. Leases last 300 seconds and
renew every 30 seconds; external adapter reconnect never changes a live worker epoch.

The detached fixture worker has a private authenticated loopback endpoint and signed
durable identity observations. Reopening the host can verify the same epoch. Cancellation
is cooperative and verifies actual parent/child/grandchild exit; unknown ownership or
stopping retains the writer. No user-owned process is terminated by the host.

Only `fixture.write` and `fixture.hold` are registered. The first writes a fixed
per-job `result.txt` using exclusive creation; the host independently checks all bytes.
The second runs an owned child/grandchild tree for lifecycle qualification. Inputs
are bounded to 65,536 UTF-8 bytes, overflow is rejected explicitly, and native
checkpoints carry bounded summaries/hash references rather than truncating effects.
These fixed recipes do not establish production code/Office/CAD/browser capability.

Database disappearance/replacement, changed worker code/policy, stale generations,
foreign credentials/handles, unexpected effects and uncertain descendants fail closed.
The independent authority anchor prevents silently making a fresh store after loss.
No app-local Goal history or old probe job is migrated. App projections have no
reverse authority and app wiring remains a later integration gate.

## Remaining qualification

The real Grace broker, canonical named-role policies and workflow/skill first-call
proof belong to the next vertical slice. Normal spokes keep read/query grants;
Grace controls every real operation and performs saves/checks. Real adapter enrollment,
Desktop identities, dedicated lnwjud Library `/mcp` listener, tunnel recovery,
Plus/Pro calls, Office/CAD/browser actions, Windows restart, 1–2 hour endurance and
owner installation remain separate gates. Do not relabel fixture adapters as those proofs.

Product-task curation is explicit-only. This package captures operational evidence,
not whole ChatGPT transcripts, and never invokes a completion/startup curator.
