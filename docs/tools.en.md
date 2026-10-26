# Tools and task operations

[Project home](../README.en.md) · [Documentation](README.en.md) · [中文](tools.md)

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
