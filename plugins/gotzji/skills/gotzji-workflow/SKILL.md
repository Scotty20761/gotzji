---
name: gotzji-workflow
description: Use gotzji for work on an enrolled Windows project, or to inspect, continue, retrieve, reprioritize, or cancel a durable gotzji job.
---

# gotzji workflow

Use the registered `gotzji_*` MCP tools as the control surface for gotzji work. The owner's current ChatGPT account and conversation control reasoning and call typed operations; the gotzji Windows host executes supported work through one durable job authority. Beyond that ChatGPT account, normal work adds no Claude, Grace, Codex, local/secondary inference backend, provider login, subscription, model, external inference API, or second execution backend.

## Select the exact authority

1. Call `gotzji_health`, then `gotzji_project_context` on a new chat or reconnect. Show the selected project's name. Its current instruction files, saved conversation notes and canonical recent jobs have separate provenance; saved notes never override instructions or prove a result.
2. Use the selected project for continuation. When the user's request names another enrolled project, select it with `gotzji_select_project`, then read its context. If selection is missing or ambiguous, inspect `gotzji_projects` and ask which project to use. If the required project or provider is absent, ask the user to enroll or configure it in the local gotzji app. Inspect `gotzji_tools` before new work unless its current response is already established and the catalog or scope has not changed.
3. Use only an operation currently returned by `gotzji_tools`. If a model-dependent Investment Library workflow is absent, report it as unsupported pending an explicit ChatGPT orchestration contract; do not infer support from a recipe, historical job, or compatibility identifier.
4. Give each new user request a stable `requestId`. Reuse that `requestId` for retries and preserve the returned `preparationId` and `jobId` in the conversation. When the user refers to existing work without an exact ID, call `gotzji_jobs` and have them select the intended job. A job mentioned by the user must be selected by its exact `jobId`; never infer the newest job.

## Read project state

- Use `gotzji_read_file`, `gotzji_list_files`, or `gotzji_search_files` only when the selected project and current catalog advertise the required read.
- Keep every path within the enrolled project and report bounded or incomplete coverage exactly as returned.

## Start controlled work

Before preparing an effect, read the selected project's current instructions through its scoped read tools. Inspect the root listing for `AGENTS.md`, `CLAUDE.md`, or another declared project entry file and follow the applicable references. These files describe project rules; the gotzji host remains the executor. Proceed only with the user's authorized scope and the project's delivery/privacy requirements established.

1. Call `gotzji_prepare_operation` with the enrolled `projectId`, stable `requestId`, one operation reported by `gotzji_tools`, and only that operation's typed fields. The operation must be executable by the host without an assumed hidden worker or model.
2. Explain the prepared scope when it materially affects user data or delivery.
3. Call `gotzji_submit` once with the returned `preparationId`. Treat the returned `jobId` as the durable identity for every later action.
4. Keep independent jobs independent. Use declared dependencies when one job requires another job's verified result.

## Observe and finish

- Call `gotzji_status` for the exact `jobId` and keep inspecting that same job until it is terminal or needs the user's action. Queued, running, blocked, waiting, and unknown are not completion.
- Call `gotzji_queue` when the user needs queue order or blocker details. Use `gotzji_reprioritize` only for an explicitly selected waiting job.
- Call `gotzji_logs` with the same `jobId` and follow its cursor in bounded pages. Logs describe activity; they do not prove delivery.
- Call `gotzji_result` only for the selected job after `gotzji_status` reports terminal completion. Report the verified result and its actual delivery boundary separately from job progress.
- Call `gotzji_resume` with the same `jobId` to inspect or rejoin admitted work. Do not prepare or submit a replacement for live or recoverable work.
- Call `gotzji_cancel` only when the user asks to cancel that exact `jobId`, then report the returned termination evidence.
- At a meaningful checkpoint or before ending the work, save a concise project summary, decisions, open questions and result references with `gotzji_save_project_memory`. Use the revision from the latest context. On `PROJECT_MEMORY_CONFLICT`, reread and reconcile the newer notes before saving. Reference actual job IDs and files; retrieve full history/results when the bounded context is incomplete. This records conversation context without changing job status or delivery evidence.

## Boundaries

- Keep project enrollment, connection setup, tunnel credentials and recipe registration in the local gotzji app.
- Start new work through ChatGPT. Desktop prepares copyable prompts and observes existing jobs; its controls may select projects, configure the host, cancel/rejoin existing jobs or settle uncertain effects. A copied prompt has not started a job.
- Route effects through the typed gotzji catalog and existing durable authority. Preserve owner, project, scope, policy, version, delivery and recovery checks; never bypass them with general filesystem, shell, raw MCP, another job engine or a stock connector.
- Keep reasoning and decisions in the current ChatGPT conversation. When additional reasoning is required, perform it here and call the next supported typed host operation; if no explicit continuation contract exists, report the workflow as unsupported rather than skipping an analysis, audit, persistence or delivery obligation.
- State evidence at its observed level: packaged source, connected app, accepted request, active progress, verified result, and delivered artifact are distinct facts.
- Do not claim commit, push, deployment, publication, account acceptance, or user delivery unless the selected job's verified result records that scope.
