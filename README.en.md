# dsh-codex-runner

[中文](README.md) | English

A DSH plugin for running Codex CLI tasks, returning complete final answers and execution status, and managing background runs, continuation, steering, and cancellation

The initial release is `0.5.0-rc.2`, for **Windows only**. It requires Node `>=20`, DSH `>=0.2.0-rc.2 <0.3.0`, and an authenticated Codex CLI installation. Isolated acceptance covered installation, settings persistence, background-run queries after a host restart, cancellation, and uninstall on Windows / Node 24.19.0 / DSH 0.2.1-rc.3 Web profile. These checks used a deterministic fake CLI without real model calls. The latest Desktop installer, other Windows machines, and Node 20/22 were not exercised in that acceptance run; the declared version range does not imply that every included version was tested

The Codex CLI baseline is `0.160.1`. The compatibility driver requires `exec --json`, `exec resume`, and `queue`; the default driver requires App Server v2. Automatic model and reasoning-effort selection is an optional **beta**, disabled by default. Its task-complexity accuracy and actual quota savings have not been demonstrated

## Installation

Install DSH, Node, and Codex CLI first, then run `codex login` in a terminal. The plugin does not bundle Codex CLI, install it, change `PATH`, sign you in, or copy credentials

Install an archive into the intended DSH profile:

```text
dsh plugin --profile <profile> add <release.tgz>
dsh --profile <profile> --dump-config
```

Alternatively, install a fixed commit from the GitHub repository:

```text
dsh plugin --profile <profile> add github:halftin/dsh-codex-runner#<commit>
```

The repository root contains the installable `package.json`; no build or prepare step is required. DSH activates the bundle through `dsh.bundle.patch`. Installing a dependency with bare pnpm does not necessarily activate the bundle

Desktop users can add the archive through plugin management and restart when prompted. Desktop-profile management from the CLI varies by DSH version

Run `codex_doctor()` first to inspect executable discovery, CLI capabilities, the login state, `CODEX_HOME`, and the App Server handshake. This does not start a model turn

In Advanced settings, leave **Codex executable** empty for automatic discovery, or provide the absolute path to a native Windows PE `.exe`. `.cmd`, `.bat`, `.ps1`, and renamed scripts are rejected. Leave **Codex home** empty to inherit `CODEX_HOME`, or the CLI default if that environment variable is unset. These values affect child processes without changing the host environment or authentication files

Discovery checks the configured executable, `CODEX_EXE`, standard npm locations, `~/.local/bin`, `PATH`, and common npm-prefix, pnpm, yarn, bun, Volta, scoop, winget, user-bin, portable, and Codex Desktop locations. Windows x64 and arm64 layouts are recognized. Shell shims are inspected only for static native targets; they are not executed as a fallback

DSH must inherit the same `CODEX_HOME` used for login. Without that variable, the CLI normally uses `.codex` in the user directory. Desktop and terminal environments or service accounts may differ; configure the two paths explicitly if necessary. Never put `auth.json` in the plugin or release archive

Both drivers inherit Codex user configuration and explicitly pass the selected model, reasoning effort, approval policy, and sandbox permissions for the main task. Native subagent enablement, thread limits, default models, and reasoning settings remain owned by Codex. Native MCP servers and other extensions also follow Codex configuration

## Tools

| Tool | Purpose |
| --- | --- |
| `codex_run` | Execute one task synchronously or in the background |
| `codex_status` | Query progress, the final answer, and termination reasons |
| `codex_cancel` | Ask the owning driver to stop its run and child process tree |
| `codex_list` | List the latest 100 runs in the current workspace |
| `codex_say` | Queue a follow-up; App Server also supports active-turn steering and interruption |
| `codex_config` | Read effective settings, per-field sources, and allowed configuration keys |
| `codex_doctor` | Check CLI discovery, capabilities, login, and handshake without a model turn |
| `codex_quota_resume` | Validate a scheduled recovery check and resume its existing authorized task once |
| `codex_sessions` | List plugin-associated Codex sessions in the current workspace |
| `codex_read` | Read paginated answers, events, or native turns without starting a model |
| `codex_release` | Release a confirmed stale/orphan admission reservation without killing processes or deleting records |
| `codex_models` | Read the model catalog, capabilities, source, and freshness |
| `codex_selection` | Query recommended and actual model-selection audit records |
| `codex_quota` | Read account quota windows, reset times, sources, and recovery status |
| `codex_diagnose` | Read diagnostics; only explicit `probe=true` sends a steering message |

These 15 tools match `dsh.plugin.json`. The host entry is `lib/index.js`, and the client entry is `lib/client.js`. The bundle, configuration scope, and client registration use `dsh-codex-runner`

```text
codex_run(prompt_file="task.md", label="task", model="<available model ID>", effort="<supported effort>")
codex_run(prompt_file="task.md", label="long-task", model="<available model ID>", effort="<supported effort>", detach=true)
codex_status(run_id="<returned UUID>", wait_ms=30000)
codex_say(run_id="<UUID>", message="Additional instructions")
codex_cancel(run_id="<UUID>")
codex_run(prompt_file="next.md", label="follow-up", model="<available model ID>", effort="<supported effort>", resume_thread="<thread_id>", continuation_of="<previous_run_id>")
```

Use `codex_models()` to replace the model and effort placeholders. Automatic completion is disabled by default: supply model and effort for both new and resumed runs, or provide them through an explicit `task_kind` or configured evidence selection

Each run has a unique `run_id`. A label points to its most recent run, so use the UUID for exact queries. Labels accept 1–80 ASCII letters, digits, underscores, or hyphens, must start with a letter or digit, and cannot be Windows reserved names

An `ok` result from `codex_run` or `codex_status` means the current execution ended, not that the user's goal was achieved. Results include `turn_status`, `process_status`, `task_state=unknown`, `needs_dsh_decision`, and `decision_reason`. DSH owns review, acceptance, and further work. Empty answers and unresolved subagents are reported as facts rather than automatically classified as task failure

Both tools return the complete final answer, excluding reasoning, tool output, and progress commentary. They do not impose an extra character limit or model-generated summary. Background notifications remain bounded. A verified, complete, redacted short answer of at most 500 characters can be delivered with `answer_complete=true` and `requires_status_refresh=false` only when the turn matches, processes have exited, and there are no pending instructions, unresolved subagents, or recovery ambiguity. Otherwise DSH refreshes status. Delayed notifications or newer instructions can still require a refresh

With a thread ID and no user cancellation, `resumable=true` can also be returned after a normally completed turn. `continuation_of` records an audit relationship; it does not launch work or determine its direction

The structured `handoff` contains `owner`, `action`, `dispatch`, and `read_answer`. It distinguishes active work, quota waits, existing successor runs, user stops, process/subagent checks, result review, and recovery. `dispatch=after_review` permits dispatch only after DSH checks task meaning and authorization. Thread availability does not override a dispatch block

Task prompts are sent as submitted by DSH. The plugin does not inject a separate engineering-discipline document or rewrite prompts from selection evidence. Notifications ask DSH to review the result and continue unfinished authorized work while respecting user stops, active runs, and quota recovery. Concurrent continuation of the same Codex thread is blocked even with different labels or a higher workspace concurrency limit

By default, one run is admitted per workspace. Synchronous and detached tasks share `defaultBudgetMs=0`, meaning no time limit; a per-call `budget_ms` overrides it, including an explicit zero. A positive budget stops execution at expiry and preserves interruption evidence. Cancellation does not roll back file changes; review `git status` and diffs afterward

Detached tasks can survive a DSH restart and remain queryable/cancellable by `run_id`. Cancel active work before uninstalling. Uninstall does not roll back the workspace or automatically stop deliberately independent background processes

## Drivers, steering, and conversation reading

App Server is the default backend. Change `backend` through **Edit full configuration and registry** in Advanced settings; there is no separate backend control. App Server cannot be combined with a custom `driverPath`. Model, effort, and service-tier combinations are checked against the current account's catalog. Interactive approval requests are rejected by default in unattended execution

```text
codex_say(run_id="<UUID>", action="steer", message="Revise the current approach")
codex_say(run_id="<UUID>", action="interrupt")
codex_read(run_id="<UUID>", source="answer", offset=0, limit=12000)
```

Steering targets the active turn but does not guarantee that an external command stops immediately. Interruption targets a turn; `codex_cancel` cancels the entire run. An accepted/requested response acknowledges the request, so confirm the outcome with `codex_status`. Compatibility `exec` mode supports queueing only

`codex_read` supports `answer`, `turns`, `summary`, `events`, and `selection`. Answer reads target the run's own App Server turn rather than a later answer in the same thread, falling back to `meta.lastMessage` when native reading is unavailable. `summary` returns execution facts, subagents, and quota without reading a native thread or returning the answer. Events require debug logging both now and when the run started

Answers and events use character offsets. Native turns use character pagination within a page followed by `next_cursor` for the next page. Responses identify sources, fallback reasons, and truncation; active-turn content may change. File paths and native thread working directories are workspace-checked; other workspaces are not scanned

## Automatic quota recovery — off by default

**Resume automatically after quota recovery** maps to `autoResumeAfterQuota`. It requires App Server, DSH Schedule and StorageDomain services, a recoverable original DSH session, and an authenticated account whose quota the CLI can query. Missing dependencies prevent automatic recovery from starting

When a relevant quota window reaches 95% usage, the driver requests a checkpoint and an end to the current turn. `pauseGraceMs=0` waits indefinitely. A positive interval sends one extra reminder after waiting once, then requests forced interruption after another interval and records that the checkpoint was not confirmed. Process termination does not prove that progress was saved

When several windows are exhausted, recovery uses the latest reset time plus 180 seconds. The driver exits and frees the workspace slot. DSH receives a fixed recovery-check instruction in the original session. A protocol `usageLimitExceeded` triggers a fresh quota query before scheduling; ordinary `rateLimitExceeded` alone does not establish subscription-quota exhaustion

At recovery time, the account fingerprint and fresh quota are checked again. Continued exhaustion reschedules the check. Unknown reset times, changed/unverifiable accounts, or scheduling failures produce `needs_attention`. Resumption reuses the Codex thread and carries accepted but unconsumed queued messages forward. DSH must actually call `codex_quota_resume`; reminder delivery alone does not mean that work resumed. Recovery status reports scheduling, successor run IDs, and failures

Disabling recovery invalidates pending records and deletes reminders. Cancelling an old run follows its recovery chain and requests cancellation of successors. Duplicate or stale checks do not dispatch twice. A busy workspace is retried every five minutes, at most 12 times. Recovery does not run while DSH is closed; persistent host scheduling handles overdue checks after restart. It creates no OS startup task and does not wake a Codex Desktop development chat

Recovery messages can consume model tokens in DSH and Codex. Before uninstalling, disable recovery and cancel waiting tasks

### Low-quota pause — off by default

**Save progress and pause at low quota** has an independent switch and a 0–20% threshold, default 5%. Turning it off disables the threshold control while retaining its value

At the threshold, App Server sends one instruction to the active turn asking Codex to save progress and pause. This consumes a small amount of Codex model tokens. It needs readable account quota but does not require DSH scheduling/storage. The run's `warning` metadata records the threshold, remaining quota, and delivery state

The warning alone does not create a recovery schedule. With automatic recovery off, the task stays paused for manual continuation. With recovery enabled, a warning-induced pause can also schedule resumption. Disabling automatic recovery invalidates pending recovery even if low-quota warnings remain enabled

## Evidence-based model selection — beta

`selectionMode` accepts `legacy` for task-kind rules, `manual` for explicit model and effort, and `evidence` for structured scope and risk information. Evidence requires `files`, `acceptance`, and `uncertainty`, with optional `plan_file`, interface/architecture/concurrency/security risks, and `failure_reason`

The plugin verifies workspace file membership and plan existence, and records the plan's SHA256. Risk, uncertainty, and acceptance descriptions are caller claims, kept separate from verified filesystem facts. Mechanical/documentation work with a plan and declared low uncertainty can select luna/low; declared architectural, interface, concurrency, or security decisions select astra/xhigh. Ordinary work selects sol; environment failures alone do not justify escalation. Missing scope or high uncertainty selects an investigation stage without rewriting the prompt. File count alone does not determine the tier

These are auditable heuristics, not a proven general task-complexity classifier or a guarantee of quota savings

| Task kind | Default role |
| --- | --- |
| `mechanical`, `docs` | luna / low |
| `review` | sol / medium |
| `implement` | sol / high |
| `architect`, `rework` | astra / xhigh |

Explicit model/effort values take priority. All modes remain subject to `maxEffortAllowed`; explicit `unlock_effort=true` can exceed that cap but cannot bypass an enforced floor. Luna does not accept ultra

`selectionPolicy` is stored in the current profile. Its default mode is `off`, and `require_approval=false`. `audit` records recommended and actual selections without changing them, requiring override reasons, enforcing quota gates, or requesting extra reviews. `enforce` applies floors to unspecified values, checks override and downgrade reasons, and enforces configured quota rules. If approval is required, it returns `approval_required` without starting a driver; there is no per-run approval UI

The default luna/sol/6.1-sol/astra order is a policy role order, not a catalog-reported benchmark ranking. Unknown model comparisons are recorded as `comparison=unknown` and rejected when enforcement needs an ordering. Selection reasons are stored in `selection.json`, returned by tools, and queryable with `codex_selection` and `codex_read(source="selection")`

## Settings

Plugin introductions, controls, and the registry editor follow DSH's interface language: Chinese in the Chinese interface and English in the English interface. Model IDs, configuration keys, enum values, and protocol status codes retain their original spelling. Fully restart DSH after updating the plugin so package metadata is read again

Controls and the full JSON editor share the current DSH profile. Precedence is **code defaults → profile settings → supported per-call parameters**. Saving settings affects subsequent tasks and relevant future scheduling checks, not an already launched model turn. `codex_config()` is read-only. Old global/project settings files are neither read nor migrated/deleted

Important defaults:

| Setting | Default |
| --- | --- |
| `defaultModel` | `gpt-6.1-sol` |
| `defaultEffort` | `high` |
| `maxEffortAllowed` | `xhigh` |
| `autoModelAndEffort` | `false` |
| `sandboxMode` | `workspace-write` |
| `approvalPolicy` | `never` |
| `maxConcurrent` | `1` |
| `defaultBudgetMs` | `0` — no time limit |
| `retentionDays`, `retentionMaxRuns` | `0` — no age/count limit |
| `debugLogs` | `false` |
| `debugMaxBytes` | `2097152` — 2 MiB |
| `quotaWarning` | `false` |
| `quotaWarningThreshold` | `5` |
| `autoResumeAfterQuota` | `false` |
| `statusPollingEnabled` | `false` |
| `statusPollingIntervalMinutes` | `30` |
| `pauseGraceMs` | `0` — wait indefinitely |

Approval and sandbox dropdowns and validation read the Codex field registry. Fallback approval values are `never` and `on-request`; retired `untrusted` and deprecated `on-failure` are excluded. Fallback sandbox values are `workspace-write`, `read-only`, and `danger-full-access`. Unknown values are rejected rather than silently replaced. Selecting `danger-full-access` directly enables unrestricted access; there is no second full-access switch. New native sandbox modes may still require driver protocol adaptation

The workspace-network switch reads `sandbox_workspace_write.network_access` and explicitly sends `true` or `false` to both drivers, so disabling it overrides a Codex configuration that previously enabled network access

`codexConfig` and `extraCodexConfig` share an allowlist; the latter is an array of `k=v` strings, not a policy bypass. Use `codex_config()` to inspect allowed keys. Invalid profile values fail before execution instead of silently reverting

Drivers are bundled. The trusted-user `driverPath` override is JSON-only; custom drivers must implement the current run-ID, metadata, heartbeat, cancellation, and stopping protocol

### Configuration and registry editor

Advanced settings end with **Edit full configuration and registry**. The dialog contains **Table**, **Registry JSON**, and **Configuration JSON** tabs sharing the same draft. The searchable table covers all 29 plugin configuration fields, daily Codex registry fields, and catalog translations, with source, key, value, allowed range, and description/translation columns

Valid JSON and table edits synchronize when switching tabs. Edits remain drafts until Save. Configuration changes go to the current profile; field-rule differences go to `<DSH_HOME>/codex-runner/fields/overrides.json`, and Chinese translation overrides go to `<DSH_HOME>/codex-runner/i18n/zh-CN.user.json`. Clearing a configuration field or setting it to `null` removes its profile override and restores inherited defaults

The editor validates configuration and rules, checks revisions to avoid overwriting external changes, and preserves the dialog and draft on failure. If one destination saves and another fails, it reports the saved part rather than claiming complete success. Closing a dirty dialog requires confirmation. Narrow windows scroll inside the table while tabs and save actions remain available

The header shows the local Codex version, **Refresh registry**, and the last successful update time. Read-only `codexVersion` and `updatedAt` entries also appear in the registry JSON and table; unknown values are `null`. Refresh discovers native definitions without a model turn and updates the reference cache independently of Save. It preserves unsaved configuration and translation edits. Failure retains the last successful timestamp instead of inventing a new one

The bundled `lib/codex-registry.json` provides a self-contained fallback: 14 general pass-through fields and seven dedicated control fields, with English definitions and Chinese translations. External discovery failure falls back to matching cached data or this file. Valid user overrides remain in place; unreadable user files or unavailable editor services make registry editing read-only while Configuration JSON remains available. Refresh never rewrites the plugin's bundled registry

Restart DSH fully after updating host code or communication interfaces; refreshing a browser page alone cannot reload cached host modules. An unregistered editor endpoint can produce HTTP 404 even when the bundled registry exists. `DSH_HOME` may be a Windows directory junction; internal redirected registry paths remain checked

### Optional controls and token usage

Quota and common settings are shown directly; Advanced settings remain collapsible. Automatic model/effort completion has a grey beta badge, is off by default, and expands its selection-related controls only when enabled

The policy dialog includes task, evidence, downgrade/approval, quota, and advanced-JSON tabs, strict/balanced/economy presets, recommendation reset, preview, and validation. Invalid JSON or catalog values prevent saving. Changes are read by subsequent runs

Process monitoring, local logs, catalog/registry refresh, and ordinary status queries run in code without a separate model call. DSH's review of task results and delivered notifications can still use model tokens. Optional low-quota messages, recovery, repeated pause reminders, evidence preparation, and active status reporting may add model-token costs as explained by their controls

**Periodically query Codex status** maps to `statusPollingEnabled`, off by default. The interval is an integer from 15 to 120 minutes, default 30. It wakes DSH to query and briefly report active work, consuming DSH model tokens. Runs in the same session share one pending schedule; different workspace intervals use the shortest value. Completion, pause, or disabling the setting removes the schedule. Restart reconciliation prevents duplicate schedules. Polling supplements reply signals rather than replacing them

The pause-wait control edits seconds, with 0/30/60/120/300-second presets and custom input; JSON stores milliseconds. The debug-size control edits MiB while JSON stores bytes. Turning debug logging off disables its size control without erasing the chosen limit

### Language and manual translations

Chinese descriptions prefer user translations, then bundled Chinese text. The English interface uses English descriptions or original Codex text and does not show Chinese translation inputs. Native keys, model/effort IDs, and enum values stay unchanged

Maintain translations manually in the table or Registry JSON tab. No model call, translation session, or automatic translation tool is involved. Clearing an override restores bundled text. Model and reasoning-effort entries translate descriptions; registry settings support names and descriptions

Bundled defaults come from `lib/codex-registry.json` and are cached in `<DSH_HOME>/codex-runner/i18n/zh-CN.default.json`; overrides use `zh-CN.user.json` in the same directory. Values are single-line plain text of at most 200 characters. Corrupt user files fall back for display and must be repaired before saving; existing files and backups are not automatically deleted

## Data, diagnostics, and retention

Run files live in `<cwd>/.codex-runner/logs/runs/<run_id>/`: `run.json`, `result.meta.json`, `result.hb.json`, `terminal.json`, `selection.json`, `pending-messages.json`, and related metadata. Both drivers retain the complete final answer in `meta.lastMessage` without reasoning/progress bodies or the former 20,000-character cap. Failures keep redacted error details and a stderr tail of at most 2048 UTF-8 bytes

By default, no bulk `events.jsonl`, `answer.txt`, `result.err.log`, or `result.jsonl` is produced. Enabling debug logging affects new runs only; it records bounded diagnostic events without full answers or assistant deltas. At `debugMaxBytes`, logging stops and the task continues

Cleanup runs at plugin load, daily, and before new runs. Safe terminal runs first lose debug/legacy bulk files, then become eligible for age/count retention. Both retention limits default to zero. Missing terminal evidence, live/unknown process ownership, redirected paths, subdirectories, and unresolved recovery prevent unsafe deletion. Codex's own data is not cleaned. Recovery unresolved for more than 30 days reports `retention_warning` and needs inspection/explicit cancellation; completed/cancelled host recovery indexes expire after 30 days

The workspace itself may be reached through a link, but runtime data directories must not redirect elsewhere. These checks address misconfiguration and existing redirections, not hostile concurrent replacement by another process with the same user permissions

Long periods without output are not treated as proof of a stuck model, task failure, or grounds for killing it. Health checks still report process exit, connection problems, startup failures, and missing heartbeats. `codex_release(run_id="<UUID>", confirm=true)` releases only stale/orphan admission ownership; it does not kill a process or delete evidence

### Replies, notifications, and handoff

Every detached `turn/completed`, including repeated turns in one run, produces a reply signal. Failures, abnormal interruptions, orphan/stale states, and quota waits retain execution facts. User cancellation, explicit interruption, and mere ongoing thought do not generate the same wakeup. Synchronous tool results serve as their own reply signals. Unregistered direct CLI runs are outside this mechanism

Per-call `notify_on_complete=off|decision|always` controls additional wakeups, defaulting to `decision` for detached runs and `off` for synchronous runs. A host adapter with passive delivery can use it; the current integration uses DSH scheduling as the fallback, which can consume DSH model tokens even when no second reminder is created

Signals include run/turn identity, execution and decision facts, handoff, a redacted answer preview of at most 500 characters, thread identity, quota/reset facts, and bounded error details. A three-second local monitor reconciles registered runs, including after reload. Delivery is deduplicated by run, turn, and event. Persistent delivery intent and bounded pending previews avoid duplicate scheduling; uncertain submissions are reconciled rather than replaying Codex work. A full queue enters `needs_attention` instead of dropping replies or growing indefinitely

Notifier pointers live in `<DSH_HOME>/codex-runner/notifier-runs/`; polling has its own private pointer/scheduling directory. `submitted` means that the host accepted a notification, not that DSH executed it or accepted the task result. Offline/unavailable host services cannot guarantee immediate delivery

Startup failures, missing terminal metadata, lost connections, budget interruption, empty answers, unconsumed queued instructions, and subagent failures are handed to DSH for review and authorized recovery. If a synchronous result is lost, notification fallback waits for driver exit and the ten-second result-delivery window unless the host has already stopped. Abnormal reminders do not depend on completion-wakeup settings. User stops, quota waits, and existing successor work still block duplicate dispatch

### Native subagents

Subagent enablement, concurrency/thread limits, and default model/effort inherit Codex configuration. The plugin does not spawn a fan-out itself. It observes native child activity, deduplicates child identities, and reports bounded running/completed/failed/unknown summaries. Parent tool completion alone does not establish child completion. Tracking is limited to 512 child identities, with at most 32 summary entries and explicit truncation

`agents.interrupt_message` is an independent optional setting for recording model-visible interruption messages; omitted/`null` inherits Codex configuration. It does not control plugin interruption notifications to DSH

### Model catalog and field registry

`codex_models` reads models, efforts, service tiers, defaults, source, and freshness without starting a turn. Refresh starts asynchronously on plugin load and is also used by the first run and doctor. The 24-hour cache at `<DSH_HOME>/codex-runner/cache/model-catalog.json` is separated by CLI path/version, Codex home, and account. Offline reads fall back to cached data or the bundled four-model catalog and are marked stale. The legacy `fast` service tier maps to `priority`; `off` omits it

Catalog, quota, and editor services use the host-authenticated Connection channel. Editor calls operate only on fixed plugin locations, not arbitrary paths. DSH configuration forms still own profile writes. Tools and fallback data remain useful when Connection services are unavailable

Field definitions, local protocol references, compatibility rules, and user translations are maintained separately. Generic configuration preserves value types in both drivers; sandbox, approval, model, and reasoning controls cannot be bypassed through generic keys or aliases. Complete reference schemas remain in the cache rather than bloating the daily registry editor

## Uninstall

Use DSH plugin management or:

```text
dsh plugin --profile <profile> remove dsh-codex-runner
```

DSH 0.2.1-rc.3 may retain the plugin's profile override and report `entry not found` after uninstall. To remove that residue, close the intended profile, back up its `cordis.patch.yml`, remove only the `id: dsh-codex-runner` override entry, and verify with `--dump-config`. The plugin does not automatically delete user settings or workspace run records

## License

[MIT](LICENSE)
