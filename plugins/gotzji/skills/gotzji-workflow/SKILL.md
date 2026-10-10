---
name: gotzji-workflow
description: Use gotzji when the user asks Grace to work on an enrolled Windows project, or asks to inspect, continue, retrieve, reprioritize, or cancel a durable gotzji job.
---

# gotzji workflow

Use the registered `gotzji_*` MCP tools as the only control surface for gotzji work. Grace owns every effect through gotzji's single durable job authority.

## Select the exact authority

1. Call `gotzji_health`, then `gotzji_projects` and `gotzji_tools` when the project or available operation is not already established in the current conversation.
2. Use only a project returned by `gotzji_projects`. If the required project or provider is absent, ask the user to enroll or configure it in the local gotzji app.
3. Give each new user request a stable `requestId`. Preserve the returned `preparationId` and `jobId` in the conversation. When the user refers to existing work without an exact ID, call `gotzji_jobs` and have them select the intended job. A job mentioned by the user must be selected by its exact `jobId`; never infer the newest job.

## Start controlled work

1. Call `gotzji_prepare_operation` with the enrolled `projectId`, stable `requestId`, one operation reported by `gotzji_tools`, and only that operation's typed fields.
2. Explain the prepared scope when it materially affects user data or delivery.
3. Call `gotzji_submit` once with the returned `preparationId`. Treat the returned `jobId` as the durable identity for every later action.
4. Keep independent jobs independent. Use declared dependencies when one job requires another job's verified result.

## Observe and finish

- Call `gotzji_status` for the exact `jobId`. Queued, running, blocked, waiting, and unknown are not completion.
- Call `gotzji_queue` when the user needs queue order or blocker details. Use `gotzji_reprioritize` only for an explicitly selected waiting job.
- Call `gotzji_logs` with the same `jobId` and follow its cursor in bounded pages. Logs describe activity; they do not prove delivery.
- Call `gotzji_result` only for the selected job after `gotzji_status` reports terminal completion. Report the verified result and its actual delivery boundary separately from job progress.
- Call `gotzji_resume` with the same `jobId` to inspect or rejoin admitted work. Do not prepare or submit a replacement for live or recoverable work.
- Call `gotzji_cancel` only when the user asks to cancel that exact `jobId`, then report the returned termination evidence.

## Boundaries

- Keep project enrollment, connection setup, tunnel credentials, recipe registration, and provider configuration in the local gotzji app.
- Keep all work under Grace and the existing gotzji job authority. Use no general filesystem, shell, raw MCP, alternate job engine, or stock-connector fallback.
- State evidence at its observed level: packaged source, connected app, accepted request, active progress, verified result, and delivered artifact are distinct facts.
- Do not claim commit, push, deployment, publication, account acceptance, or user delivery unless the selected job's verified result records that scope.
- Request curation only when the user explicitly asks for it.
