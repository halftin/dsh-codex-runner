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
| `codex_capabilities` | Read exact-run backend capabilities, limitations and supervision receipts |
| `codex_stream` | Read captured output after an exclusive sequence, independently of debug logs |
| `codex_questions` | Read original requests, options, lifecycle and answer sources |
| `codex_answer` | Answer a pending RPC or correlated async question |

These 19 tools match `dsh.plugin.json`. The host entry is `lib/index.js`, and the client entry is `lib/client.js`. The bundle, configuration scope, and client registration use `dsh-codex-runner`

Supervision is on by default. When the native Agent inbox is available, `codex_run` automatically detaches and returns `supervision_active=true`, allowing DSH to receive progress during execution. Turning supervision off restores explicit `detach` behavior. Display and model reading have independent cursors; display alone does not invoke the model. See [Runtime](runtime.en.md).

```text
codex_capabilities(run_id="<UUID>")
codex_stream(run_id="<UUID>", after=0, limit=100)
codex_questions(run_id="<UUID>")
codex_answer(run_id="<UUID>", interaction_id="<interaction UUID>", response={"answers":{"<question ID>":{"answers":["choice or free text"]}}})
```

All four tools require the current session and workspace. Large output retains a complete JSON resource; previews are incomplete. Answer only authorized task choices, ask for missing information, and never automatically approve permissions. Copy question IDs exactly from `codex_questions`, including JSON-string IDs for async questions. Native requests use original RPC responses; async questions use the official correlated user-message envelope in the active or next turn of the same thread. `submitted` means delivered; `submission` distinguishes connection writes from active/next-turn acceptance, without claiming model adoption. `resolved` is reserved for server RPC resolution. Exec has no structured question support.

```text
codex_run(prompt_file="task.md", label="task")                                              # autonomy off: defaults
codex_run(prompt_file="task.md", label="task", model="<available model>", effort="<effort>") # autonomy on
codex_run(prompt_file="task.md", label="long-task", detach=true)
codex_status(run_id="<returned UUID>", wait_ms=30000)
codex_say(run_id="<UUID>", message="Additional instructions")
codex_cancel(run_id="<UUID>")
codex_run(prompt_file="next.md", label="follow-up", continue_run_id="<previous_run_id>")
```

Use `codex_models()` to see available models and efforts. The "Let DSH choose model and reasoning effort" setting decides who selects: when it is off (the default) every run uses the configured default model and effort, so omit model/effort — passing them is rejected. When it is on, DSH assesses the task before dispatch and supplies model and effort for new and resumed runs; task rules, evidence and defaults apply only when the preset policy is not off. Quota, cost or waiting time must not cause unilateral downgrades; report or pause when the appropriate choice is unavailable

Each run has a unique `run_id`. A label points to its most recent run, so use the UUID for exact queries. Labels accept 1–80 ASCII letters, digits, underscores, or hyphens, must start with a letter or digit, and cannot be Windows reserved names

An `ok` result from `codex_run` or `codex_status` means the current execution ended, not that the user's goal was achieved. Results include `turn_status`, `process_status`, `task_state=unknown`, `needs_dsh_decision`, and `decision_reason`. DSH owns review, acceptance, and further work. Empty answers and unresolved subagents are reported as facts rather than automatically classified as task failure

Both tools return the complete final answer, excluding reasoning, tool output, and progress commentary. They do not impose an extra character limit or model-generated summary. Background notifications remain bounded. A verified, complete, redacted short answer of at most 500 characters can be delivered with `answer_complete=true` and `requires_status_refresh=false` only when the turn matches, processes have exited, and there are no pending instructions, unresolved subagents, or recovery ambiguity. Otherwise DSH refreshes status. Delayed notifications or newer instructions can still require a refresh

With a thread ID and no user cancellation, `resumable=true` can also be returned after a normally completed turn. `continuation_of` records an audit relationship; it does not launch work or determine its direction

The structured `handoff` contains `owner`, `action`, `dispatch`, and `read_answer`. It distinguishes active work, quota waits, existing successor runs, user stops, process/subagent checks, result review, and recovery. `dispatch=after_review` permits dispatch only after DSH checks task meaning and authorization. Thread availability does not override a dispatch block

Task prompts are sent as submitted by DSH. The plugin does not inject a separate engineering-discipline document or rewrite prompts from selection evidence. Notifications describe execution state, available operations and authorization boundaries; they do not prescribe task steps, automatic continuation or report format. User instructions govern task decisions and prompt content. Tool descriptions still enter DSH context and can influence generation; unchanged transport does not imply zero influence. Concurrent continuation of the same Codex thread is blocked even with different labels or a higher workspace concurrency limit

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


Enabled quota warning/recovery may send checkpoint-and-pause messages during a run. Async answers use a correlated question-reply envelope. Neither mechanism imposes a template on the initial task prompt. User-requested pre-dispatch selection and no unilateral quota-driven downgrades remain in tool descriptions; code prevents automatic substitution and rejects explicit non-task downgrade categories, but cannot inspect hidden model reasoning.


## Continue a conversation and choose the next turn's model

A run ID identifies one execution, while a thread ID identifies the persistent Codex conversation. `codex_run(continue_run_id="<previous_run_id>", prompt_file="next.md", label="next-step")` resolves the original thread and records `continuation_of`. This works for normal follow-up, not only interruption recovery. Each call creates a new run ID; the thread remains the same. With autonomy off, omit model/effort to use the configured defaults. With autonomy on, supply the selection for this call; switching it does not require a new conversation.

`continue_run_id` is mutually exclusive with `resume_thread` and `continuation_of`. The original run must belong to the current workspace and DSH session and use the configured backend. Active, unresolved, stopped or quota-blocked states reject instead of silently creating a fresh conversation. Existing direct `resume_thread` remains supported. With neither continuation selector, a fresh thread is created. Task semantics determine whether DSH reuses or separates conversations; no automatic grouping is imposed.

`thread_action=created|continued` and `conversation=` in summaries distinguish thread creation from a new run. For an active run, `codex_say` still queues or steers text using the current model/effort; it cannot switch tiers. After completion, use `codex_run` to continue with a new choice. The process may restart while the persisted thread survives. History retention is not a cache-hit guarantee.


### Optional official host ownership

`codex_run` accepts `host_managed`, an optional boolean defaulting to false. True uses the official subagent service for registration, activation admission, result collection and explicit cleanup. The existing tool, prompt file, model-selection rules and output card remain. It requires the exact live DSH Agent and the subagent service; unavailable admission fails without silently falling back or starting another run.

This changes lifecycle ownership: graceful host shutdown, plugin unload or an explicit official interrupt cancels managed work. Default detached runs retain their restart-survival behavior. This is a per-call parameter, not a profile setting or native Codex option. Pass it again on continuation to manage the next run; new run/child identities may share the original Codex thread.

Plugin completion notifications remain authoritative; official delivery is fixed to caller. `codex_status` and `codex_list` return host_subagent identity and collection receipts, with catalog=plugin and native_catalog=false. Native external catalog membership is coupled to official completion notices and is not enabled here. Crash restoration of official activations and ownership inheritance by quota-resume successors are not implemented.


For `codex_stream`, `after` is an exclusive output-event sequence. To inspect the complete event summarized with `seq=N`, use `after=N-1, limit=1`. The plugin record's `outputSeq` is this same source sequence; the host chat `seq` is a separate ordering number. Large payloads refer to a full JSON resource; a summary is not the full output.
