# gotzji — development and qualification

## Current source version: v5.7.3

Latest published release: **none**. The source is being developed toward gotzji v1.0.0. No official gotzji executable has been released. Historical lnwjud documentation is retained under docs/upstream/ and is not a description of gotzji's shipped features.

## App and jobs

The desktop is a client of one independent local host. Closing the window does not transfer ownership or create another job engine. The host uses a native Goal ledger and stores request, operation, job, worker epoch, receipts and retained logs. Grace controls work; the app and ChatGPT inspect and cancel the same selected job.

A project is registered locally. Model-visible tools cannot choose executables or enroll another owner. Reviewed command IDs resolve to server-owned executable, arguments and dependency hashes. Policies and file versions are checked before an effect. Writes preserve originals or create a backup. Conflicting project/document/provider resources wait; uncertain termination preserves its fence.

The configured Claude subscription is the work provider. Provider quota exhaustion records a waiting reason and retry time rather than repeatedly spawning work or switching to a paid inference API.

## Connections

The local app configures its own OpenAI Secure MCP Tunnel, independent of lnwjud. A dedicated runtime API key requires Tunnels Read + Use. Enter it in the app; never paste it into a chat or issue. The host protects credentials with Windows CurrentUser DPAPI. Tunnel transport uses authenticated loopback forwarding. Project enrollment and connection configuration are absent from ChatGPT's tool catalog.

The personal plugin requires actual account/workspace consent and qualification. Plus and Pro are separate acceptance records; documentation or a local HTTP test does not accept either account. Public ChatGPT directory submission is a separate later target.

## Build and private candidate

Use the commands in README.md. Expected local build output is apps/desktop/dist/installers/gotzji-Setup-5.7.3.exe and apps/desktop/dist/installers/gotzji-Portable-5.7.3.exe; those paths do not imply published or qualified artifacts.

The intended release is Windows x64, official unsigned, with SHA-256, complete runtime inventory and upstream/third-party notices. Automatic updates are disabled. Native Office/CAD software is an external licensed prerequisite. The packaged app must include its own host/runtime; installed-user absence of Node/pnpm/.NET still requires a clean-machine check.

## Acceptance

Follow .github/RELEASE_CHECKLIST.md. Full v1 requires real Grace work, useful concurrent jobs, all required providers/Library workflows, both accounts, exact installed 1–2 hour interruption/reboot tests, migration/rollback, and the accepted pilot. Component/source tests have their own scope. Never promote a developer fixture or an upstream release into gotzji release evidence.

### Session resilience / แนวทางสำหรับผู้ปฏิบัติการ

Use the selected job ID to inspect status, read bounded logs, retrieve a verified result, resume inspected work or cancel only that job. A closed app window or ChatGPT session does not own the worker. Reopen gotzji, select the same job and inspect its last progress before submitting anything again. If the host, provider or Windows session was interrupted, keep uncertain resources fenced until gotzji reports a verified effect or an action-required reason.

Connection and host listeners bind to loopback addresses with operating-system-assigned ports. Diagnostics and incident records are private, bounded and redacted; review them before sharing. A successful health response, observer exit or child command does not prove the workflow, artifact or delivery completed.

## Security and operational model

Retain LICENSE and THIRD_PARTY_NOTICES.md. The original project is https://github.com/engasnm111/lnwjud; the owned fork is https://github.com/Scotty20761/gotzji. Source releases must exclude private databases, credentials, profiles, provider logs, Library content and native fixture outputs.

## MCP control catalog

The host advertises the definitions in packages/execution-core/src/product-http.ts. gotzji_tools returns current operation availability and prerequisites; the upstream ToolRegistry catalog is not exposed by gotzji.

| Tool | Mode | Purpose |
|---|---|---|
| gotzji_health | READ | Host/readiness |
| gotzji_projects | READ | Enrolled projects |
| gotzji_tools | READ | Current operation availability |
| gotzji_prepare_operation | WORK | Prepare typed work |
| gotzji_submit | WORK | Admit prepared work |
| gotzji_jobs | READ | Select owner jobs |
| gotzji_queue | READ | Queue and blockers |
| gotzji_reprioritize | CONTROL | Change waiting priority |
| gotzji_status | READ | Selected job status |
| gotzji_logs | READ | Paged redacted logs |
| gotzji_result | READ | Verified selected result |
| gotzji_resume | CONTROL | Inspect/rejoin selected work |
| gotzji_cancel | CONTROL | Cancel selected owned work |

Project/recipe/connection enrollment stays in the local app. Neither raw workspace_list nor a general shell is inherited into this catalog.
