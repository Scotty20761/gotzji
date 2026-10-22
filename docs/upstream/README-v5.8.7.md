<p align="center">
  <img src="assets/logo/logo-256x256.png" width="160" alt="lnwjud logo" />
</p>

<h1 align="center">lnwjud</h1>

<p align="center">
  <strong>Cross-platform local AI-agent runtime and MCP gateway</strong><br />
  <em>294 total tool definitions for local files, Git, processes, Windows automation, WSL, browser control, durable goal continuation, Engineering Harness, native Goal automation, context capsules, indexing, observability, Office semantic automation, ECC integration, and extensibility; 282 are advertised by default and all 294 when Codex delegation plus Agent Swarm is enabled.</em>
</p>

<p align="center">
  <em>อ่านที่เหลือใน Readme ได้เลยครับ ติดปัญหาทักมาได้ใน <a href="https://url.in.th/rEZiG"><strong>Line</strong></a> ได้ตลอดครับ / กำลังพัฒนาให้เรื่อยๆครับ ท่านที่ถามหาช่องสนับสนุนค่ากาแฟ แปะลิงก์ไว้ให้แล้วครับ ขอบคุณครับ — <a href="https://easydonate.app/abcz"><strong>Donate</strong></a></em>
</p>

<p align="center">
  <a href="https://github.com/engasnm111/lnwjud/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/engasnm111/lnwjud" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-24.x-339933" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-294%20tools-6f42c1" />
</p>

<h2 align="center">Download lnwjud</h2>
<p align="center">Choose your platform and download the current v5.8.6 release directly.</p>

<table align="center">
  <tr>
    <td align="center" width="33%">
      <a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-Setup-5.8.6.exe">
        <img src="assets/download/download-windows.svg" width="300" alt="Download lnwjud for Windows" />
      </a><br />
      <sub><a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-Portable-5.8.6.exe">Portable x64</a></sub>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.8.6-arm64.dmg">
        <img src="assets/download/download-macos.svg" width="300" alt="Download lnwjud for macOS" />
      </a><br />
      <sub><a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.8.6-x64.dmg">Intel x64 DMG</a> · <a href="docs/INSTALL_MACOS.md">Install guide</a></sub>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.8.6-x64.deb">
        <img src="assets/download/download-linux.svg" width="300" alt="Download lnwjud for Linux" />
      </a><br />
      <sub><a href="https://github.com/engasnm111/lnwjud/releases/latest/download/lnwjud-5.8.6-x64.AppImage">x64 AppImage</a> · <a href="docs/INSTALL_LINUX.md">Other architectures</a></sub>
    </td>
  </tr>
</table>

<p align="center"><a href="https://github.com/engasnm111/lnwjud/releases/latest"><strong>View all release files →</strong></a></p>

---

## Current published version: v5.8.6

## Current source version: v5.8.7

### What's new in v5.8.7

- **Tunnel Reset All Settings / persistent alias (candidate):** Reconcile only the verified stopped `lnwjud` local runtime alias before factory reset, preserving profile, health and logs around the official `tunnel-client runtimes rm` operation. Refuse running, foreign or unverifiable Tunnel ownership; never delete remote tunnels or unrelated aliases. Reset is accepted only after the native alias is verified absent. Crash-interruption and full release gates remain under validation.
- **External MCP direct invocation:** Fix direct `mcp_call` results from content-only child servers by omitting the outer mandatory structured-output schema. Playwright, Context7 and codebase-memory-mcp were tested through the newly installed v5.8.7 development runtime; direct responses now succeed without falsifying `structuredContent`.


- **Issue #208 — guarded Git import:** Added a five-field, exact-commit HTTPS import contract, native Windows create-only staging and no-replace publication, NTFS identity checks and fail-closed ambiguous-state recovery. Security validation and official release acceptance remain pending; the owner authorized solo-development review.
- **Native stage worktree validation (candidate):** Before re-pinning the NTFS stage identity for no-replace publication, verify trusted Git HEAD against the requested SHA, reject modified tracked or unexpected untracked files, and refuse Git index flags that conceal changes (`assume-unchanged` / `skip-worktree`). A Windows regression first reproduced publication of a concealed modification and then passed after the fix (5/5). Disposable HTTPS exact-commit and standard-mode MCP import also passed on the prior candidate. Concurrent same-user tamper races and official security/release acceptance remain unverified.
- **Issue #209 — write safety:** Added strict create-only handling, workspace writer leases and path preflight with global managed-writer admission; cross-root native lifecycle acceptance remains pending.
- **Issue #209 — stale lease recovery (candidate):** An explicitly confirmed `recoverAbandoned` request from another session of the same client may rotate a writer lease after 60 seconds of inactivity, even before expiry. Generation fencing rejects prior credentials; live or unverifiable in-flight and globally managed writers block recovery. Pre-migration unknown activity remains fail-closed. Focused regression checks pass; official release validation is still pending.
- **Writer process startup safety (candidate):** If a managed process is rejected before spawning (such as a missing executable, invalid input or failed containment preparation), its writer reservation is released because no child exists. Once a child has spawned, the existing native verified-zero-active termination rule remains mandatory. Regression reproduced before the fix; all 35 process tests and package typecheck pass. This is not a claim that every import security finding is resolved.
- **MCP connector identity and diagnostics:** Preserve a host-supplied exact app mention without assuming one universal plugin name; retain direct-vs-batch child results and distinguish host-approval-adapter denial from unavailable approval. A host rejection before dispatch is outside the connector and is not bypassed.
- **Scheduled Task truthfulness:** Show the difference between an enabled native hourly task and a verified continuation claim. The previous native task was disabled by the user; no duplicate or hidden worker was created.
- **ภาษาไทย:** เพิ่ม Git import ที่ระบุ Commit ตรงและตรวจ Native Identity, ป้องกันการเขียนทับและจัดการ Writer Lease, รักษา Connector ID ตามที่ ChatGPT ส่งมาจริง พร้อมแสดงการปฏิเสธสิทธิ์อย่างตรงไปตรงมา ทั้งหมดเป็น Candidate สำหรับทดสอบในเครื่องก่อนผ่าน Security Validation และ Official Release ไม่ได้ทำให้ Scheduled Task ทำงานต่อเนื่องระหว่างรอบ

### What's new in v5.8.6

- **Engineering Gate checkpoint compatibility (Issue #198):** Add `checkpoint_goal_engineering` with the same strict schema, Goal handler, lease/revision checks and evidence validation as `checkpoint_goal`. It follows the canonical tool's availability, so disabling `checkpoint_goal` disables both names.
- **Connector verification:** After the v5.8.6 update, a fresh connector session advertised both checkpoint tools with the Engineering fields. Direct calls to both names and `get_goal` readback confirmed persistence. Connector display names are chosen by each user.
- **ภาษาไทย:** หลังอัปเดตเป็น v5.8.6 ตรวจใน connector session ใหม่แล้วพบเครื่องมือ checkpoint ทั้งสองชื่อพร้อมฟิลด์ Engineering และเรียกโดยตรงพร้อมอ่านข้อมูลที่บันทึกผ่าน `get_goal` ได้ ชื่อที่แสดงของ connector ขึ้นอยู่กับการตั้งค่าของผู้ใช้แต่ละคน

### What's new in v5.8.5

- **Engineering Harness audit routing (Issue #194):** Keep Full Audit requests and read-only reviews of existing deployments or release history in the local review workflow. Explicit deploy, release, commit, push, PR and merge requests retain their matching delivery scope and gates.
- **Existing Engineering Goals:** Reconcile workflow classification, gate contracts and source scope from the lease-acquired Goal snapshot. Preserve compatible findings, task tracking and proof; revalidate scope-dependent checks when the requested source scope changes.
- **Modern MCP HTTP inventory and schema evidence:** Notify subscribed clients when host tool availability changes, then serve the current tools/list on the next request. `tool_describe` reports a SHA-256 digest from the active ToolRegistry schema and identifies remote connector schema as unavailable.
- **ภาษาไทย:** แยก Full Audit และการตรวจประวัติ deployment/release แบบอ่านอย่างเดียวออกจากคำสั่งปล่อยงาน, reconcile metadata ของ Goal เดิมจาก snapshot ที่ acquire ภายใต้ lease, แจ้ง MCP client เมื่อ tool availability เปลี่ยน และแสดง digest ของ local schema โดยไม่อ้างว่าอ่าน schema ของ connector ภายนอกได้

#### Earlier highlights — v5.8.4

- **Durable MCP Shell results (Issue #193):** Preserve exact client/session/workspace ownership when a modern HTTP request or legacy MCP transport is replaced. Authorized owners can retrieve retained task status, stdout/stderr and terminal receipts; foreign owners remain denied.
- **Checked workflows and recovery:** Execute reviewed recipe steps only when requested, evaluate each step under current permissions and Goal leases, and distinguish unavailable provider evidence from completed work. Workspace indexing and context reporting retain explicit error/completeness states.
- **Agent Swarm:** Fix non-interactive Codex CLI waiting for extra stdin and keep monitoring spawned agents after a start request ends. Verified with real local child-process fixtures; hosted Codex results still depend on account quota and provider availability.
- **Tool and native provider contracts:** Synchronize all 285 declared MCP tools (273 default), improve truthful Doctor readiness and native media lifecycle boundaries. macOS/Linux capabilities remain subject to platform permissions and target-native verification.
- **ภาษาไทย:** แก้การอ่านผล Shell หลัง reconnect ตามสิทธิ์เจ้าของ ตรวจ Goal Lease ระหว่างรัน Workflow และแก้ Agent Swarm รอ stdin โดยไม่อ้างว่าบริการหรือฟีเจอร์ทุกแพลตฟอร์มพร้อมใช้เมื่อยังขาดสิทธิ์หรือ Provider

### Earlier release highlights — v5.8.0

**v5.7.4** primarily fixed oversized native approval dialogs. **v5.8.0** adds six review-first workflows, richer Doctor evidence, CSV/XLSX data tasks, Git explorer upgrades, a consistent Desktop UI, more reliable Secure MCP Tunnel startup, and controlled dependency maintenance.

- **Six bilingual workflows:** Project Check, Code Review, Release Readiness, Connection Check, Data Audit, and Template Report. Required inputs are validated before preparing a draft; a preview never silently launches a Goal, scheduler, or AI worker.
- **MCP Call History:** retained audit-backed calls with bounded pagination, tool/Goal filters, outcomes, and server p50/p95 when samples exist. Transport/Tunnel timing is still `unknown` where no trusted sample exists; only Goals with attributable calls appear in the Goal filter.
- **Goal Results and checkpoints:** inspect meaningful progress, completed steps, recorded checks, actual mutation receipts and verifiable file artifacts. Result filters exclude Goals without evidence; verification is not inferred from a Goal's completed status.
- **Process Resources:** display measured Windows working-set RAM and lifetime-average CPU for verified Goal-owned child processes; separately show the Desktop main process. Refresh while viewing, suppress Goals without measured resources, and never substitute zero for unavailable measurements.
- **Context Economy observability:** show real transport-scoped MCP HTTP ledger hits and context bytes, explicitly not per-Goal totals. Shared services are not cancelled with a Goal; owned-task cancellation stays permission- and identity-checked.
- **Safer restore and audit visibility:** result and restore flows preserve workspace scope, exact checkpoint/Goal revision checks, verified current file hashes, and explicit user confirmation.
- **CSV/XLSX data workflows:** typed audit and comparison of tabular data plus template-based report creation with readback. Preserve source files by default; native Office actions remain dependent on platform/provider support.
- **Git explorer and diffs:** show individual untracked files in new folders, not merely folder counts. Expand/collapse the tree, search and filter files, retain code/diff navigation, and show safe text/image previews or bounded binary metadata.
- **Desktop controls and typography:** shared inputs, filters, buttons and responsive searchable dropdowns across Settings/Tools/Doctor/Git; menus anchor **below their fields only**, reserve outer scrolling room and scroll internally for long lists. Options wrap when long, compact options remain compact. Restore Prompt/previous Git text sizing and improve validation/loading feedback.
- **Command Prism status visual:** replace the plain golden orb with a faceted prism, using actual MCP states (gold = ready, blue = working, red = stopped/offline). A reserved neutral gray visual does not claim a new backend state. Workflow cards receive matching restrained line icons.
- **Modal and layout fixes:** correct shared-button CSS precedence so close glyphs stay visible in What's New, Tool Detail, and the guided Tunnel screen. Increase close targets, preserve keyboard access, and separate search fields from actions.
- **Work Log and Doctor UX:** default Work Log to all workspaces; improve workspace/session filters, loading states, long labels, goal descriptions and meaningful empty states. Doctor Goal selectors show only entries that have relevant results for each tab.
- **Secure MCP Tunnel reliability:** do not reconnect over a matching managed runtime before a 45-second elapsed readiness grace period. Keep Tunnel identity, ownership protection, health polling and retry backoff; this avoids premature repeated `connect` calls but does not guarantee a fixed startup time.
- **Bundled native runtime:** update the verified target-native `tunnel-client` to **0.0.16** and preserve native payload preparation for installation on supported platforms.
- **Dependency updates and delivery checks:** use one managed dependency-update PR with conditional branch cleanup rather than duplicate updates. Keep functional tests and exact-commit target-native CI/build gates; Windows community artifacts can remain unsigned when no signing certificate exists, with SHA-256/provenance checks required.

**ภาษาไทย — ต่างจาก 5.7.4:** เพิ่มเทมเพลต 6 แบบ, ประวัติ MCP และผลงาน Goal ที่มีหลักฐาน, RAM/CPU จริงของโปรเซสที่ตรวจเจ้าของได้, Context Economy แบบรวมระดับ Transport, ตรวจ CSV/XLSX, Git tree/preview ที่ครบขึ้น, UI และ dropdown กลาง, กากบาท Modal ขนาดชัดเจน, Work Log ที่กรองง่ายขึ้น, แก้ Tunnel reconnect ก่อนพร้อม และอัปเดต tunnel-client 0.0.16 พร้อมการทดสอบ/แพ็กเกจตาม SHA จริง ค่าไม่ทราบจะไม่แสดงเป็น 0 หรืออ้างว่าสำเร็จโดยไม่มีข้อมูล

Latest published release: **v5.8.6**. The download buttons above point directly to the verified v5.8.6 assets. The release was published after the exact tagged main commit passed the target-native release gates.

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for previous releases and the complete release history.

## Install

### Windows 10 / 11

1. Open [GitHub Releases](https://github.com/engasnm111/lnwjud/releases/latest).
2. Download `lnwjud-Setup-<version>.exe` for the normal installer, or `lnwjud-Portable-<version>.exe` if you prefer a portable executable.
3. Launch lnwjud, add the project/workspace you want to use, then configure the MCP connection method you need.

Community Windows artifacts may be unsigned when production code-signing credentials are not configured. Release verification still checks the declared signing mode, SHA-256 manifests, runtime provenance, and packaged-app smoke evidence; verify the release assets if Windows shows an unknown-publisher warning.

Windows-only features such as WSL, Registry, Windows Sandbox, Windows OCR and Outlook/COM remain available only where the Windows provider is supported.

### macOS 13+

Download the artifact that matches the Mac architecture (`arm64` for Apple silicon or `x64` for Intel). Do not swap architectures just because both filenames contain the word “Mac”. Computers remain unusually literal about this.

See [Install lnwjud on macOS](docs/INSTALL_MACOS.md) for DMG/ZIP installation, permissions, MCP launcher paths, Gatekeeper/signing expectations, and troubleshooting.

### Linux

Choose the release artifact that matches the Linux architecture and package type. Ubuntu 24.04 LTS x64 is the primary Linux release target; arm64 remains architecture-specific and evidence-gated.

See [Install lnwjud on Linux](docs/INSTALL_LINUX.md) for AppImage/DEB installation, Wayland/X11 behavior, secure storage, MCP, and platform limits.

### Local data vs workspace metadata

Installed lnwjud keeps per-user runtime data outside your source repository: `%APPDATA%\lnwjud` on Windows, `~/Library/Application Support/lnwjud` on macOS, and `$XDG_DATA_HOME/lnwjud` (or `~/.local/share/lnwjud`) on Linux unless `LNWJUD_DATA_PATH` is explicitly set. A workspace may contain `.lnwjud/project-profile.json` for project-scoped policy such as Ponytail or Engineering Harness mode/profile; `.lnwjud/` is local metadata and is ignored by this repository.

### Engineering Harness (opt-in)

Engineering Harness is **Off by default**. Enable it in **Settings → Engineering Harness** when you want lnwjud to turn a substantive coding request into a durable, risk-based workflow instead of treating every request the same way.

- **Presets:** Standard, **Senior** (recommended), Strict, or Custom.
- **Scope:** coding projects/tasks by default, with an optional per-workspace On/Off + preset override.
- **Policy precedence:** explicit workspace/project opt-out wins; project policy can strengthen a preset but cannot silently weaken an explicit user opt-out.
- **Durability:** `engineering_start_task` reuses the existing durable Goal authority. Requirement changes increment the Goal intent revision and stale only affected Engineering gates instead of resetting proven work.
- **Evidence:** required checks remain Pending/Running/Failed/Stale until observed evidence satisfies them. Host-observed mechanical checks are not replaced by a model assertion.
- **Enforcement:** first-party development mutations such as guarded file edits, Git, shell/process/project commands, verification, Codex/Agent Swarm and worktree operations require the current `engineeringTask` binding when Harness is active. Existing permission, Active Project, recovery, Full Bypass and rolling `goalLease` rules still apply independently.
- **Advisory boundary:** external `mcp_call`, general Office/web/native-UI routes are not mechanically Engineering-guarded in v5.7.0; their existing security/permission controls remain authoritative.
- **No hidden writes:** project assessment and the Settings project-profile preview do not write repository files, commit, push, deploy, or create a Scheduled Task by themselves.

For the Thai setup and workflow guide, see [docs/USAGE_TH.md](docs/USAGE_TH.md#8a-engineering-harness--senior-coding-workflow).

## What can lnwjud do?

lnwjud exposes **294 tool definitions** through one local runtime and MCP gateway. The default advertised set is 282; all 294 are available when Codex delegation plus Agent Swarm is enabled.

| Area | Examples |
| --- | --- |
| Workspace & files | read/search/edit files, paging, full scans, project indexing, recovery trash |
| Git | status, diff, history, blame, guarded Git mutations |
| Processes | shell, managed processes, durable background tasks, Goal-owned native automation, logs, cancellation |
| MCP | local HTTP/stdio MCP, External MCP discovery/describe/call, live tool availability |
| Development | test, lint, typecheck, build, affected-test context, Codex integration |
| Browser | managed Chrome/CDP, DOM inspection, Set-of-Marks, screenshots |
| Recovery | backups, checkpoints, restore, crash/session recovery, durable-goal state |
| Observability | Work Log, Live Logs, Doctor, incident reports, trace/audit metadata |
| Native capabilities | UI/input/media/Office/scheduler providers when the current OS supports them |
| Windows-specific | WSL, Registry, Windows Sandbox, Windows Event Log/OCR, Outlook/COM |

For the complete generated catalog, see [MCP Tool Catalog](docs/mcp/MCP_TOOL_CATALOG.md). For the broader capability explanation, see [lnwjud capabilities](docs/LNWJUD_CAPABILITIES.md).

## Platform compatibility

lnwjud composes providers for the detected host instead of instantiating a Windows provider everywhere and hoping for the best.

| Feature | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Core MCP / files / Git / processes | ✅ | ✅ | ✅ |
| External MCP | ✅ | ✅ | ✅ |
| OpenAI Secure MCP Tunnel client | target-native | target-native | target-native |
| Remote MCP with ngrok | ✅ | ✅ | ✅ |
| Managed browser / CDP | dependency-gated | dependency-gated | dependency-gated |
| Native PDF text provider | dependency-gated | dependency-gated | dependency-gated |
| Automatic Poppler install | Windows x64 | hidden | hidden |
| WSL / Registry / Windows Sandbox | ✅ | unsupported | unsupported |
| Outlook COM | ✅ | unsupported | unsupported |

The authoritative matrix is [Native platform support contract](docs/architecture/PLATFORM_SUPPORT.md).

## MCP connection choices

- **Local MCP:** use the packaged stdio launcher or Desktop loopback MCP endpoint directly. The Local transport starts the local listener without ngrok, a public URL, or Remote MCP OAuth.
- **Remote MCP via ngrok + OAuth:** remains the default/backward-compatible Remote MCP transport. lnwjud owns the protected loopback OAuth gateway and ngrok child runtime.
- **Remote MCP via Cloudflare:** opt-in for a Cloudflare Tunnel/reverse proxy that you manage. lnwjud provides a stable local OAuth-gateway target and verifies the configured public HTTPS origin; it does not claim to create or manage the Cloudflare tunnel.
- **Remote MCP via Custom URL:** opt-in for another externally managed HTTPS reverse proxy. No ngrok token/install is required; the public origin must route to the stable local protected gateway.
- **OpenAI Secure MCP Tunnel:** separate outbound-only OpenAI tunnel path using the verified target-native bundled `tunnel-client`. One lnwjud tunnel endpoint is intended to serve multiple simultaneous ChatGPT chats/workspaces; do not create one tunnel/profile per chat. v4.62.0 explicitly gives the tunnel transport 32 active MCP-request slots so normal multi-chat tool fan-out does not hit tunnel-client's lower default ceiling. If several physical lnwjud hosts (for example Mac + Windows) must be independently selectable, give each host a distinct Tunnel ID/ChatGPT connection: HTTP replicas sharing one Tunnel ID are work-sharing replicas, so a request goes to whichever replica polls it first rather than to a chat-selected host.
- **External MCP servers:** lnwjud can discover supported Cursor/Claude Desktop/custom MCP definitions and keep child MCP servers separate from the first-party catalog.

See the [Thai usage guide](docs/USAGE_TH.md) and [full expanded README](FULL_README.md) for the long-form setup and architecture notes.

## Durable goals + scheduled continuation / Goal แบบทำงานต่อเนื่อง

lnwjud can keep long-running work alive across chat turns with a **durable goal** plus the bundled `lnwjud-scheduled-continuation` skill. The intended model is simple: one stable goal, one recurring Native ChatGPT Scheduled Task, periodic checkpoints, and an explicit finish only when the work is genuinely complete.

lnwjud สามารถทำงานยาวข้ามหลายรอบแชทได้ด้วย **durable goal** ร่วมกับสกิล `lnwjud-scheduled-continuation` แนวทางที่ควรใช้คือ: 1 งาน = 1 goal ที่ใช้ `goalKey` เดิม, มี Native ChatGPT Scheduled Task แบบ recurring เพียง 1 ตัว, บันทึก checkpoint ระหว่างทาง และปิด goal เมื่อทุกอย่างเสร็จจริงเท่านั้น

The scheduled continuation should be a **Native ChatGPT Scheduled Task running in cloud mode every 1 hour**. It is a watchdog that wakes the workflow back up; the durable goal remains the source of truth for plan state, progress, blockers, evidence, and tracked background tasks. Do not create a new goal or timer on every wake.

ตัว Scheduled Task ควรเป็น **Native ChatGPT Scheduled Task ที่รันบน cloud ทุก 1 ชั่วโมง** มีหน้าที่ปลุกงานกลับมาทำต่อเท่านั้น ส่วนสถานะจริงของงานให้ยึด durable goal เป็นหลัก ห้ามสร้าง goal ใหม่หรือตัวตั้งเวลาใหม่ทุกครั้งที่ถูกปลุก

### Recommended prompt — English

```text
@lnwjud

Workspace:
C:\path\to\my-project

Continue this task until it is genuinely complete. Do not stop only because the current chat turn ends.

- Use the lnwjud-scheduled-continuation skill.
- Create or resume the same durable goal using one stable goalKey. Treat that Durable Goal as the authoritative task state and never create duplicate goals for the same job. When plan or step progress changes, use update_goal_plan so the Watcher-visible plan stays current.
- Create exactly one recurring Native ChatGPT Scheduled Task, run it in cloud mode every 1 hour, and reuse that same scheduled continuation for this goal.
- Checkpoint immediately after every meaningful milestone, and refresh active progress at least every 10 minutes when sustained work has no natural milestone. Persist current phase, step status, next action, blockers, evidence, tracked background tasks, and reconstruction-grade resumeContext: changed files, exact commands/results, decisions, failed attempts, pending validation, resume prerequisites, state facts, and artifacts. A checkpoint records progress; it is not a reason to stop useful work.
- When the scheduled task wakes the workflow, claim the continuation for the same goal and resume from the latest checkpoint instead of starting over.
- If CI, build, test, deployment, or another process is still running, keep tracking the same task until its terminal result is known. If a failure is fixable, inspect the exact failure, diagnose it, repair it, and run the relevant validation in the same turn instead of stopping at a status report.
- Do not finish the goal while any planned step, acceptance criterion, required Engineering gate/review finding, blocker, or blocking task remains unresolved. Reconcile stale duplicate/superseded/abandoned goals instead of leaving finished work Active in Watcher.
- When the work is truly complete, cancel the scheduled continuation, make the exact Native ChatGPT Scheduled Task non-runnable, then call finish_goal with final evidence and read get_goal to confirm a terminal state before reporting completion.
```

### Prompt แนะนำ — ภาษาไทย

```text
@lnwjud

Workspace:
C:\path\to\my-project

ทำงานนี้ต่อเนื่องจนเสร็จจริง ห้ามหยุดกลางทางเพียงเพราะแชทจบรอบ

- ใช้สกิล lnwjud-scheduled-continuation
- สร้างหรือ resume durable goal เดิมด้วย goalKey ที่คงที่ และให้ Durable Goal เป็น state หลักของงาน ห้ามสร้าง goal ซ้ำสำหรับงานเดียวกัน เมื่อ plan หรือสถานะ step เปลี่ยน ให้ใช้ update_goal_plan เพื่อให้ plan/progress ที่ Watcher แสดงเป็นปัจจุบัน
- สร้าง Native ChatGPT Scheduled Task แบบ recurring เพียง 1 ตัว ให้รันบน cloud ทุก 1 ชั่วโมง และใช้ scheduled continuation ตัวเดิมกับ goal นี้ไปตลอด
- หลัง milestone สำคัญทุกครั้งให้ checkpoint ทันที และถ้าทำงานต่อเนื่องโดยไม่มี milestone ตามธรรมชาติให้ refresh อย่างน้อยทุก 10 นาที โดยบันทึก current phase, step status, next action, blockers, evidence, tracked background task และ resumeContext ที่สร้างงานต่อได้จริง เช่นไฟล์ที่เปลี่ยน, คำสั่งและผลลัพธ์, การตัดสินใจ, failed attempts, pending validation, prerequisites, state facts และ artifacts การ checkpoint คือการบันทึก progress ไม่ใช่เหตุผลให้หยุดทำงาน
- เมื่อ scheduled task ปลุกขึ้นมา ให้ claim continuation ของ goal เดิม แล้วทำงานต่อจาก checkpoint ล่าสุด ห้ามเริ่มงานใหม่ตั้งแต่ต้น
- หากมี CI, build, test, deploy หรือ process ที่ยังรันอยู่ ให้ติดตาม task เดิมจนได้ terminal result ถ้าความล้มเหลวนั้นแก้ได้ ให้เปิดผลล้มเหลวจริง วิเคราะห์ root cause แก้ และรัน validation ที่เกี่ยวข้องต่อใน turn เดิม ห้ามหยุดแค่รายงานสถานะ
- ห้าม finish goal หากยังมี step, acceptance criterion, Engineering gate/review finding ที่จำเป็น, blocker หรือ blocking task ที่ยังไม่เสร็จ และให้ reconcile goal ซ้ำ/ถูกแทนที่/ถูก abandon ที่งานจบแล้วแทนการปล่อยค้าง Active ใน Watcher
- เมื่อทุกอย่างเสร็จจริง ให้ cancel scheduled continuation, ทำให้ Native ChatGPT Scheduled Task ตัวเดิมไม่สามารถรันต่อได้ แล้วค่อย finish_goal พร้อม final evidence จากนั้นเรียก get_goal ยืนยันว่าเป็น terminal ก่อนรายงานว่าเสร็จ
```

### Goal lifecycle / วงจรของ Goal

1. **Start / resume — `run_goal`**
   - English: Use one stable `goalKey`; resume the existing goal instead of creating a duplicate.
   - ไทย: ใช้ `goalKey` เดิมสำหรับงานเดียวกัน ถ้ามี goal อยู่แล้วให้ resume ห้ามสร้างซ้ำ

2. **Checkpoint — `checkpoint_goal`**
   - English: Save meaningful progress: current phase, completed/pending steps, next action, blockers, evidence, and tracked background tasks. A checkpoint records progress; it is **not** an instruction to stop working.
   - ไทย: บันทึกความคืบหน้าที่สำคัญ เช่น phase, step ที่เสร็จ/ค้าง, งานถัดไป, blocker, evidence และ task ที่กำลังรันอยู่ การ checkpoint คือการเซฟสถานะ ไม่ใช่การสั่งให้หยุดงาน

3. **Prepare + wake — `prepare_scheduled_continuation` / `claim_scheduled_continuation`**
   - English: Keep exactly one hourly Native ChatGPT recurring task for the goal. Every wake resumes the same durable goal from its latest checkpoint.
   - ไทย: ให้มี scheduled task แบบรายชั่วโมงเพียง 1 ตัวต่อ goal และทุกครั้งที่ถูกปลุกให้กลับมาทำ goal เดิมต่อจาก checkpoint ล่าสุด

4. **Stop watchdog — `cancel_scheduled_continuation`**
   - English: Once the goal is genuinely terminal, make the exact recurring Native ChatGPT task non-runnable so a completed job is not awakened again.
   - ไทย: เมื่องานจบจริง ให้ปิด scheduled continuation และทำให้ task ตัวเดิมรันต่อไม่ได้ เพื่อไม่ให้ปลุกงานที่เสร็จแล้วขึ้นมาอีก

5. **Finish — `finish_goal`**
   - English: Finish only after all planned steps are complete, blockers are cleared, blocking tasks are terminal, acceptance criteria are satisfied, and scheduled continuation cleanup is complete. Record final evidence instead of merely declaring success in chat.
   - ไทย: ปิด goal หลังจากทุก step เสร็จ, blocker ถูกเคลียร์, blocking task จบแล้ว, acceptance criteria ผ่านครบ และ cleanup ตัวตั้งเวลาเรียบร้อย พร้อมบันทึกหลักฐานสุดท้าย

### v5 Goal state / สถานะ Goal ใน v5

- **Plan + Watcher projection:** `get_goal_plan` projects the authoritative plan; `update_goal_plan` changes that same durable plan and keeps the plan/progress shown by Watcher aligned with real step state instead of creating a second planner.
- **Freshness + reconstruction:** call `checkpoint_goal` immediately after meaningful step/task/blocker/commit/push/CI/package milestones, and at least every 10 minutes during sustained work without a natural milestone. Meaningful checkpoints carry reconstruction-grade `resumeContext`; a short summary alone is not enough for reliable resume.
- **Acceptance:** `update_goal_acceptance` records explicit completion evidence. `finish_goal(status=completed)` is rejected while any criterion is still pending or blocked; Engineering Harness goals must also satisfy their required gates and blocking review findings.
- **Newest intent wins:** `revise_goal_intent` increments `userIntentRevision`; stale checkpoints or delivery receipts from older accepted user intent are fenced/retired rather than replayed.
- **Context Capsule:** `create_context_capsule` stores a bounded immutable objective/decision/result summary for compact/resume or handoff. It stores task state, not private chain-of-thought, and does not drive ChatGPT through browser/DOM automation.
- **Pressure + iteration:** `context_pressure` reports a local estimate when exact provider usage is unavailable, while `advance_goal_iteration` is explicitly bounded by `maxIterations` and can stop when no new evidence appears.
- **Completion hygiene:** after watchdog cleanup and `finish_goal`, read `get_goal` and confirm a terminal status before reporting completion. Reconcile stale duplicate, superseded, or abandoned Goal cards when authoritative evidence shows they no longer represent live work; completed work must not remain Active in Watcher.

ภาษาไทยแบบสั้น: v5 แยก **plan / acceptance / user intent / context capsule / bounded iteration** ออกจากกันชัดเจน โดย Durable Goal ยังเป็น source of truth เพียงชุดเดียว ถ้าผู้ใช้เปลี่ยนคำสั่งใหม่ งานเก่าต้องแพ้ revision ใหม่ และ Context Capsule ใช้เก็บสรุปสถานะเพื่อกลับมาทำต่อ ไม่ใช่เก็บ chain-of-thought หรือใช้ browser ไปสร้างแชทใหม่เอง

### Short prompt — English

```text
Use lnwjud-scheduled-continuation. Create or resume one durable goal for this job, keep exactly one Native ChatGPT Scheduled Task running in cloud mode every 1 hour, and resume from the latest checkpoint until the goal is genuinely complete. Checkpoint every meaningful milestone, never duplicate the goal or timer, and when all steps are complete with no blockers or blocking tasks left, cancel the scheduled continuation first and then finish_goal with final evidence.
```

### Prompt แบบสั้น — ภาษาไทย

```text
ใช้สกิล lnwjud-scheduled-continuation สร้างหรือ resume durable goal เดิมสำหรับงานนี้ และสร้าง Native ChatGPT Scheduled Task บน cloud แบบ recurring ทุก 1 ชั่วโมงเพียง 1 ตัว เพื่อกลับมาทำงานต่อจาก checkpoint ล่าสุดจน goal เสร็จจริง ระหว่างทางให้ checkpoint ทุก milestone สำคัญ ห้ามสร้าง goal หรือตัวตั้งเวลาซ้ำ และเมื่อทุก step เสร็จ ไม่มี blocker หรือ blocking task ค้าง ให้ปิด scheduled continuation ก่อน แล้ว finish_goal พร้อมหลักฐานสุดท้าย
```

This pattern is especially useful for long CI/release jobs, multi-stage refactors, deployments, packaging, migrations, or any task where “continue later” should be backed by durable state rather than wishful thinking.

รูปแบบนี้เหมาะกับงาน CI/Release ที่ใช้เวลานาน, refactor หลายขั้น, deploy, packaging, migration หรืองานใดก็ตามที่ต้องทำต่อหลายรอบ เพราะคำว่า “เดี๋ยวมาทำต่อ” ถ้าไม่มี state เก็บไว้ก็เป็นระบบ persistence ที่น่าเชื่อถือพอ ๆ กับกระดาษโน้ตที่ติดหน้าพัดลม

## Documentation

- [Full expanded README / historical detail](FULL_README.md)
- [คู่มือใช้งานภาษาไทย](docs/USAGE_TH.md)
- [macOS installation](docs/INSTALL_MACOS.md)
- [Linux installation](docs/INSTALL_LINUX.md)
- [Platform support matrix](docs/architecture/PLATFORM_SUPPORT.md)
- [Complete capabilities](docs/LNWJUD_CAPABILITIES.md)
- [MCP Tool Catalog](docs/mcp/MCP_TOOL_CATALOG.md)
- [Tool contract](docs/architecture/TOOL_CONTRACT.md)
- [Release process](docs/development/RELEASE_PROCESS.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Security boundary

lnwjud is intentionally powerful because it operates on the local machine. Tool availability does **not** bypass Active Project scope, permission policy, mutation approval, recovery, host OS permissions, or platform capability gates. Unknown/unsupported platforms and missing native providers should fail closed rather than silently substituting a different OS implementation.

## Community

ติดปัญหา อยากแชร์วิธีใช้ หรือเจอบัค สามารถเข้ากลุ่มพูดคุยได้ที่ [Line](https://url.in.th/rEZiG).

## License

[MIT](LICENSE)
