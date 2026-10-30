# gotzji ↔ lnwjud C0 parity inventory

Generated 2026-10-30 from `dev` at `f791b3839c45`. Machine-readable rows: [`gotzji-c0-parity.json`](gotzji-c0-parity.json).

## How it was made

1. A deterministic script read the upstream baseline (294 lnwjud 5.8.7 definitions), the 5.8.6 runtime and adapter captures, and the gotzji authority surface: product host RPC methods, ChatGPT-facing gotzji tools, Core operations, ExecutionCore methods, renderer files, ledger headings, CI receipts and every gotzji test title.
2. Nine read-only agents, one per tool family plus one for screens and one for lnwjud failures, mapped each row from that digest at low effort.
3. Every `path:line` the agents cited (603) was then checked against the source head: the file exists, the line is inside it, and a cited test title is the test at that line. One wrong line number was corrected; it is listed under `corrections` in the JSON.

Evidence states are the agents' claims under those checks, not an independent review. Every `DEVELOPMENT_VERIFIED` row rests on a recorded pass for an earlier head, so it can become `STALE` if a later commit changed that path. No row is `INSTALLED_VERIFIED` or `ACTUAL_CHATGPT_VERIFIED` yet.

## Tools by family

| Family | Rows | DEVELOPMENT_VERIFIED | SOURCE_ONLY | BLOCKED | PLANNED |
|---|---:|---:|---:|---:|---:|
| files-core | 53 | 13 | 8 | 0 | 32 |
| code-intel | 27 | 0 | 1 | 0 | 26 |
| git-process | 47 | 8 | 5 | 0 | 34 |
| goals-sessions | 41 | 0 | 12 | 0 | 29 |
| ui-office | 53 | 5 | 11 | 1 | 36 |
| agents-delegation | 26 | 0 | 0 | 0 | 26 |
| mcp-tools-skills | 47 | 3 | 12 | 0 | 32 |
| **all** | **294** | **29** | **49** | **1** | **215** |

Mapping kinds: none 215, partial 62, grouped 11, intentionally-different 3, exact 3.

Rows with `DEVELOPMENT_VERIFIED`: `workspace_list`, `workspace_register`, `workspace_info`, `workspace_tree`, `read_file`, `search_text`, `write_file`, `edit_file`, `project_test`, `project_lint`, `project_typecheck`, `project_build`, `file_dialog`, `git_status`, `git_diff`, `git_log`, `git`, `process_start`, `process_status`, `process_logs`, `process_stop`, `dom_cdp`, `office`, `dom_snapshot`, `render_excel_preview`, `office_excel`, `recipe_list`, `recipe_run`, `recipe_catalog`.

Blocked: `office_word` (the Word identity window recorded in the product ledger).

## Screens and actions

77 rows across 15 upstream pages: DEVELOPMENT_VERIFIED 49, SOURCE_ONLY 12, PLANNED 16. Desktop never admits new work; workflow, tool and command rows prepare a request or a prompt for ChatGPT, as recorded in the product ledger.

## lnwjud failures turned into gotzji tests

Source: 57453 recorded lnwjud calls, joined by call ID. Counts only; no paths or messages were kept.

| Class | Result codes | Calls | gotzji coverage | Proposed test |
|---|---|---:|---|---|
| conflict/ownership | CONFLICT | 775 | covered-by-test | edit through ChatGPT after an external change is refused with FILE_VERSION_CONFLICT and leaves the file unchanged |
| missing file or workspace | FILE_NOT_FOUND, WORKSPACE_NOT_FOUND | 693 | covered-by-test | reading a deleted file or a removed project returns a typed not-found error, never an empty success |
| invalid input | INVALID_INPUT, FILE_TOO_LARGE | 529 | covered-by-test | a malformed gotzji tool call returns INVALID_REQUEST naming the field and admits no job |
| internal error and unclassified errors | INTERNAL_ERROR, ERROR | 347 | handled-in-source-untested | an unexpected Core exception is reported as a server fault, distinct from invalid input, with the call identity kept |
| preflight and policy gates | ENGINEERING_PREFLIGHT_REQUIRED, ENGINEERING_POLICY_CHANGED, PERMISSION_REQUIRED | 200 | covered-by-test | submit without owner approval, or after a policy edit, is refused and tells ChatGPT the single next step |
| git state | GIT_NOT_REPOSITORY | 85 | covered-by-test | Git status on a non-repository project returns GIT_REPOSITORY_REQUIRED quickly, and the Git page shows it as not a repository |
| permission and path scope | PERMISSION_DENIED, PATH_OUTSIDE_WORKSPACE | 107 | covered-by-test | absolute, traversal and junction paths are refused as out of project scope without revealing outside names |
| timeouts and lost completions | PROCESS_TIMEOUT, startedNeverCompleted | 20 | covered-by-test | every started gotzji call ends in a recorded terminal state, including after a deadline expires |
| missing executables and processes | EXECUTABLE_NOT_FOUND, PROCESS_NOT_FOUND | 12 | covered-by-test | a reviewed command whose executable was removed after registration fails before launch with a typed missing-executable refusal |
