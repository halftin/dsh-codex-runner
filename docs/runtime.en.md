# Runtime, quota, and troubleshooting

[Project home](../README.en.md) · [Documentation](README.en.md) · [中文](runtime.md)

## Automatic quota recovery — off by default

**Resume automatically after quota recovery** maps to `autoResumeAfterQuota`. It requires App Server, DSH Schedule and StorageDomain services, a recoverable original DSH session, and an authenticated account whose quota the CLI can query. Missing dependencies prevent automatic recovery from starting

When a relevant quota window reaches 95% usage, the driver requests a checkpoint and an end to the current turn. `pauseGraceMs=0` waits indefinitely. A positive interval sends one extra reminder after waiting once, then requests forced interruption after another interval and records that the checkpoint was not confirmed. Process termination does not prove that progress was saved

When several windows are exhausted, recovery uses the latest reset time plus 180 seconds. The driver exits and frees the workspace slot. DSH receives a fixed recovery-check instruction in the original session. A protocol `usageLimitExceeded` triggers a fresh quota query before scheduling; ordinary `rateLimitExceeded` alone does not establish subscription-quota exhaustion

At recovery time, the account fingerprint and fresh quota are checked again. Continued exhaustion reschedules the check. Unknown reset times, changed/unverifiable accounts, or scheduling failures produce `needs_attention`. Resumption reuses the Codex thread and carries accepted but unconsumed queued messages forward. DSH must actually call `codex_quota_resume`; reminder delivery alone does not mean that work resumed. Recovery status reports scheduling, successor run IDs, and failures

Disabling recovery invalidates pending records and deletes reminders. Cancelling an old run follows its recovery chain and requests cancellation of successors. Duplicate or stale checks do not dispatch twice. A busy workspace is retried every five minutes, at most 12 times. Recovery does not run while DSH is closed; persistent host scheduling handles overdue checks after restart. It creates no OS startup task and does not wake a Codex Desktop development chat

Recovery messages can consume model tokens in DSH and Codex. Before uninstalling, disable recovery and cancel waiting tasks

## Low-quota pause — off by default

**Save progress and pause at low quota** has an independent switch and a 0–20% threshold, default 5%. Turning it off disables the threshold control while retaining its value

At the threshold, App Server sends one instruction to the active turn asking Codex to save progress and pause. This consumes a small amount of Codex model tokens. It needs readable account quota but does not require DSH scheduling/storage. The run's `warning` metadata records the threshold, remaining quota, and delivery state

The warning alone does not create a recovery schedule. With automatic recovery off, the task stays paused for manual continuation. With recovery enabled, a warning-induced pause can also schedule resumption. Disabling automatic recovery invalidates pending recovery even if low-quota warnings remain enabled

## Data, diagnostics, and retention

Run files live in `<cwd>/.codex-runner/logs/runs/<run_id>/`: `run.json`, `result.meta.json`, `result.hb.json`, `terminal.json`, `selection.json`, `pending-messages.json`, and related metadata. Both drivers retain the complete final answer in `meta.lastMessage` without reasoning/progress bodies or the former 20,000-character cap. Failures keep redacted error details and a stderr tail of at most 2048 UTF-8 bytes

By default, no bulk `events.jsonl`, `answer.txt`, `result.err.log`, or `result.jsonl` is produced. Enabling debug logging affects new runs only; it records bounded diagnostic events without full answers or assistant deltas. At `debugMaxBytes`, logging stops and the task continues

Cleanup runs at plugin load, daily, and before new runs. Safe terminal runs first lose debug/legacy bulk files, then become eligible for age/count retention. Both retention limits default to zero. Missing terminal evidence, live/unknown process ownership, redirected paths, subdirectories, and unresolved recovery prevent unsafe deletion. Codex's own data is not cleaned. Recovery unresolved for more than 30 days reports `retention_warning` and needs inspection/explicit cancellation; completed/cancelled host recovery indexes expire after 30 days

The workspace itself may be reached through a link, but runtime data directories must not redirect elsewhere. These checks address misconfiguration and existing redirections, not hostile concurrent replacement by another process with the same user permissions

Long periods without output are not treated as proof of a stuck model, task failure, or grounds for killing it. Health checks still report process exit, connection problems, startup failures, and missing heartbeats. `codex_release(run_id="<UUID>", confirm=true)` releases only stale/orphan admission ownership; it does not kill a process or delete evidence

## Replies, notifications, and handoff

Every detached `turn/completed`, including repeated turns in one run, produces a reply signal. Failures, abnormal interruptions, orphan/stale states, and quota waits retain execution facts. User cancellation, explicit interruption, and mere ongoing thought do not generate the same wakeup. Synchronous tool results serve as their own reply signals. Unregistered direct CLI runs are outside this mechanism

Per-call `notify_on_complete=off|decision|always` controls additional wakeups, defaulting to `decision` for detached runs and `off` for synchronous runs. A host adapter with passive delivery can use it; the current integration uses DSH scheduling as the fallback, which can consume DSH model tokens even when no second reminder is created

Signals include run/turn identity, execution and decision facts, handoff, a redacted answer preview of at most 500 characters, thread identity, quota/reset facts, and bounded error details. A three-second local monitor reconciles registered runs, including after reload. Delivery is deduplicated by run, turn, and event. Persistent delivery intent and bounded pending previews avoid duplicate scheduling; uncertain submissions are reconciled rather than replaying Codex work. A full queue enters `needs_attention` instead of dropping replies or growing indefinitely

Notifier pointers live in `<DSH_HOME>/codex-runner/notifier-runs/`; polling has its own private pointer/scheduling directory. `submitted` means that the host accepted a notification, not that DSH executed it or accepted the task result. Offline/unavailable host services cannot guarantee immediate delivery

Startup failures, missing terminal metadata, lost connections, budget interruption, empty answers, unconsumed queued instructions, and subagent failures are handed to DSH for review and authorized recovery. If a synchronous result is lost, notification fallback waits for driver exit and the ten-second result-delivery window unless the host has already stopped. Abnormal reminders do not depend on completion-wakeup settings. User stops, quota waits, and existing successor work still block duplicate dispatch

## Native subagents

Subagent enablement, concurrency/thread limits, and default model/effort inherit Codex configuration. The plugin does not spawn a fan-out itself. It observes native child activity, deduplicates child identities, and reports bounded running/completed/failed/unknown summaries. Parent tool completion alone does not establish child completion. Tracking is limited to 512 child identities, with at most 32 summary entries and explicit truncation

`agents.interrupt_message` is an independent optional setting for recording model-visible interruption messages; omitted/`null` inherits Codex configuration. It does not control plugin interruption notifications to DSH

## Model catalog and field registry

`codex_models` reads models, efforts, service tiers, defaults, source, and freshness without starting a turn. Refresh starts asynchronously on plugin load and is also used by the first run and doctor. The 24-hour cache at `<DSH_HOME>/codex-runner/cache/model-catalog.json` is separated by CLI path/version, Codex home, and account. Offline reads fall back to cached data or the bundled four-model catalog and are marked stale. The legacy `fast` service tier maps to `priority`; `off` omits it

Catalog, quota, and editor services use the host-authenticated Connection channel. Editor calls operate only on fixed plugin locations, not arbitrary paths. DSH configuration forms still own profile writes. Tools and fallback data remain useful when Connection services are unavailable

Field definitions, local protocol references, compatibility rules, and user translations are maintained separately. Generic configuration preserves value types in both drivers; sandbox, approval, model, and reasoning controls cannot be bypassed through generic keys or aliases. Complete reference schemas remain in the cache rather than bloating the daily registry editor
