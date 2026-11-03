# Runtime, quota, and troubleshooting

[Project home](../README.en.md) · [Documentation](README.en.md) · [中文](runtime.md)

## Live output, questions and supervision

The JSON-only `autoAnswerQuestions` setting defaults to true and controls automatic question handling independently. With supervision off, `codex-runner-questions` notifications contain no ordinary output and do not advance its model cursor. With supervision on, the same question is delivered once through the shared scheduler. This is normal task conversation usage, not continuous monitoring or zero model usage. Terminal state takes priority over simultaneous questions: queued notifications are withdrawn; already consumed input cannot be recalled, but stale answers are rejected. Interruption notices require checking current state and prohibit replaying uncertain answers or resuming user-cancelled work. Manual answers remain available.

Both switches are on by default. Independent chat records are appended when each item completes; once the first record appears, the aggregate node stops displaying its body. When the required host API is unavailable, aggregate display falls back to completed items for exec and deltas for App Server. Display nodes only read stored output; they do not add model context or invoke a model. Reopening replays records, and disabling display hides ordinary output. HTML and unknown structures use safe text fallbacks without executing scripts. Large content is explicitly a preview with a complete resource download.

Capture is independent of `debugLogs`. Each run stores `output.jsonl`, the complete-line commit index `output.idx`, `output-state.json`, and large parameters in `output-<sequence>.json`. These are business history subject to run retention; disabling display or supervision does not delete them. `interactions.json` retains request/connection identities and lifecycle. `supervision-state.json` records delivery and provider-request receipts. Each display node owns its own cursor.

Supervision uses the original DSH Agent. Ordinary events batch over 1.5 seconds with at least five seconds between ordinary deliveries in a session; questions and errors take priority. New supervised runs detach automatically. `modelCursor` advances only when the batch enters an actual Agent model request, which proves inclusion, not understanding or adoption. Turning supervision off withdraws unconsumed inbox input; already consumed input retains an uncertainty diagnostic. Uncertain deliveries are not replayed after restart, and persisted questions cannot restore a lost response connection.

Raw deltas advance only the read cursor and do not trigger supervision messages. Item snapshots and other milestones are delivered as bounded summaries. Command output up to 520 UTF-16 code units is retained in full; longer output keeps the first 320 and last 200 with `truncated=true`. `outputBytes` reports the original UTF-8 byte count.

Independent `plugin:codex-runner/item` records use data version 2, while the separate durable cursor file uses version 1. Records contain bounded previews and source output sequences for full-content reads. See [the record format and recovery protocol](runtime.md#每个-codex-item-的独立展示记录). The saved desktop screenshot `.capture/look-final.png` from 2026-11-02 shows prose, collapsed commands and a final answer; it does not establish restart durability, phone synchronization or complete interactive acceptance.

On 2026-11-02, `npm run verify` passed all 41 offline checks on Node 24.22.2. Regression coverage includes command-preview boundaries for both backends, UTF-8 byte counts, delta suppression and completed-item notification coordination. This run adds no real-model, Electron interaction, restart-persistence or phone acceptance claims.

DSH may answer authorized task choices and asks the user for missing information. Native questions remain available regardless of either switch. Duplicate and late answers are rejected; the first valid submission wins. Permissions and unsupported requests are not automatically approved. DSH 0.2.1-rc.3's question contract and native composer lack secret-input support; secret-marked requests are withheld from the ordinary composer with an explicit diagnostic.

App Server keeps original RPC responses for `request_user_input`. For async `agentMessage.questions`, it uses the official `send_user_message_question_reply` user-message envelope, correlated by original item ID and question index. Delivery uses `turn/steer` during an active turn or `turn/start` on the same thread after normal completion, never a second tool result. Both paths were verified with real Codex 0.160.1 and 0.165.0 adopting unique answer markers. Pending async questions survive normal turn boundaries; the driver retains its connection and reports `awaiting_async_answers`. Answers, user dismissal, cancellation, budget expiry and connection failure end the wait as appropriate. Uncertain delivery is never replayed; disconnect or owner restart invalidates questions. Dismissal is local and sends no fabricated answer. Exec questions remain unsupported. No new settings or changes to user Codex configuration are required.

Real browser checks cover safe text fallbacks for Markdown/code, image/audio/file metadata and unknown widgets, plus byte-exact downloads of long Unicode JSON payloads. The user has confirmed the delivery scope: pass media file locations/resource references and metadata actually supplied by Codex to DSH, without playback; pass widget HTML source as data, without executing it. Both delivery gaps are resolved under that scope. Parameters beyond a preview remain readable in the run's resource directory. Receiving a location does not establish that media bytes were read or an external URL is accessible. Secret-question input remains a separate host limitation.

Verified versions are Windows, DSH 0.2.1-rc.3 and Codex 0.160.1. A deterministic model adapter in the real host validated supervision answers and controls. Real Codex validated both output backends and steering, queueing and interruption effects. Real DSH `deepseek-account/deepseek-flash` answered an original request and steered a controlled fake Codex run. A separate test with both models real verified intermediate reading and steering that changed the final Codex answer. An additional real dual-model async question test passed: DSH answered and Codex adopted the unique marker in the next turn of the same thread. Active-turn delivery was separately verified with real Codex and a test answerer. Agents Anywhere bridge-next 2.0.2 handles native questions but does not project this custom card's incremental output; on 2026-11-02, the user removed phone remote support (display, resource synchronization and answer return) from the backlog and acceptance requirements. This improvement is marked complete within the agreed delivery scope; this scope closure makes no new claim of successful phone testing.

## Automatic quota recovery — off by default

Recovery retains the paused task's saved model and reasoning effort even if configured defaults change while waiting. Both `model_source` and `effort_source` report `recovery`. This internal path does not let ordinary tool arguments bypass the autonomy switch. The current model catalog, effort cap and active selection policy still apply, as do current sandbox and approval settings. Missing, unavailable or disallowed selections lead to `needs_attention`, without switching tiers. Evidence policy uses the original saved claims and stage; missing required evidence stops recovery.

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

Startup failures, missing terminal metadata, lost connections, budget interruption, empty answers, unconsumed queued instructions, and subagent failures are reported to DSH with available recovery operations. Whether to continue and how to handle the task remain governed by user instructions; the notification prescribes no workflow or report format. If a synchronous result is lost, notification fallback waits for driver exit and the ten-second result-delivery window unless the host has already stopped. Abnormal reminders do not depend on completion-wakeup settings. User stops, quota waits, and existing successor work still block duplicate dispatch

## Native subagents

Subagent enablement, concurrency/thread limits, and default model/effort inherit Codex configuration. The plugin does not spawn a fan-out itself. It observes native child activity, deduplicates child identities, and reports bounded running/completed/failed/unknown summaries. Parent tool completion alone does not establish child completion. Tracking is limited to 512 child identities, with at most 32 summary entries and explicit truncation

`agents.interrupt_message` is an independent optional setting for recording model-visible interruption messages; omitted/`null` inherits Codex configuration. It does not control plugin interruption notifications to DSH

## Model catalog and field registry

`codex_models` reads models, efforts, service tiers, defaults, source, and freshness without starting a turn. Refresh starts asynchronously on plugin load and is also used by the first run and doctor. The 24-hour cache at `<DSH_HOME>/codex-runner/cache/model-catalog.json` is separated by CLI path/version, Codex home, and account. Offline reads fall back to cached data or the bundled four-model catalog and are marked stale. The legacy `fast` service tier maps to `priority`; `off` omits it

Catalog, quota, and editor services use the host-authenticated Connection channel. Editor calls operate only on fixed plugin locations, not arbitrary paths. DSH configuration forms still own profile writes. Tools and fallback data remain useful when Connection services are unavailable

Field definitions, local protocol references, compatibility rules, and user translations are maintained separately. Generic configuration preserves value types in both drivers; sandbox, approval, model, and reasoning controls cannot be bypassed through generic keys or aliases. Complete reference schemas remain in the cache rather than bloating the daily registry editor


Before delivery, the notifier coordinates with supervision by run_id. A terminal run withdraws unconsumed supervision/question input before its reliable outcome notice. A normal-turn notice waits for a pending valid question/progress batch to enter a model request and pauses new batches for that run until notification delivery. delivery_context reports the output cursor and previous input state, never semantic understanding or completion. Consumed or uncertain input cannot be recalled, so the outcome notice remains and a single model call is not guaranteed. Durable notification intents, event-marker deduplication and no replay of uncertain delivery remain unchanged.


Opt-in host_managed=true uses provider `codex-runner`, official caller delivery and private single-use argument bindings. Native Codex model/effort are not advertised as DSH AgentOptions. Existing workspace locks and identity checks remain, with the official activation-tree pool adding admission control. host-subagent.json records collection receipts and run.json retains the identity mapping; neither proves that an activation remains resident after restart. Teardown retains direct internal status/cancel capabilities rather than depending on the potentially unloaded tool registry, and waits for unpublished startup cancellation and published-run cleanup. The plugin still cleans the actual driver/process tree. Native catalog integration, replacement of completion notices and crash restoration are not implemented.


## Independent item records

The host plugin tails each run's committed output once per second. Completed agent messages, command executions and file changes become separate `plugin:codex-runner/item` records with data version 2. Both App Server and exec item names are supported. Each record retains runId, callId, sessionId and outputSeq; host-assigned seq determines its position among DSH messages. Continuations that share a Codex thread still have separate run identities.

Text previews are limited to 8 KiB at UTF-8 boundaries; commands and path summaries are limited to 1 KiB. Full content stays in the run directory and is read on demand. Independent records are ignorable, non-surface host events: display alone does not enter model context or invoke a model. Supervision and explicit output reads use separate paths.

Delivery writes a pending intent, appends the record, flushes the host session, then commits the cursor. After an uncertain delivery, replay reconciles the exact run/call/session/output sequence before retrying. A per-run lock prevents concurrent delivery. Cursor version 1 is separate from record data version 2. Completed historical runs with no cursor are not backfilled on startup, avoiding insertion at the end of today's chat. Runs already being tracked drain committed output on completion.

When the host append API is unavailable, diagnostics are written and aggregate display remains available. Once independent records exist, aggregate content is hidden to avoid duplicates. Turning display off pauses delivery and hides existing records; enabling it catches up in batches of at most 100 output events per run. Display settings use a shared subscription to committed host settings. Full-content reads require the original session/workspace and matching run identity. Retention may remove the source output while host records remain.

The snapshot/replay API used for uncertain-delivery recovery is deprecated in the tested host; compatibility is capability-dependent. Existing API probes and offline tests do not establish full Electron interaction or persistence acceptance for this candidate. Phone remote support is closed out of the delivery scope, not a pending item.

## Model-facing text

Tool definitions, supervision messages, question notifications and result handoffs describe current operations. They retain authorization, permission and execution-ownership boundaries. To inspect a summarized event at sequence N, use `codex_stream(after=N-1, limit=1)`. Changing model/effort for a continuation requires DSH model autonomy; otherwise omit both parameters. Release notes and this documentation are not injected into model prompts.

### Display invalidation and shared reads

Aggregate consumers of one run share a reader and exclusive cursor; independent items share identity/status checks. SSE carries only output or record-confirmation invalidations. Initial reads, reconnects and window focus calibrate mounted runs and read durable output by cursor. Notifications are coalesced. Requests with runId use direct lookup while retaining sessionId/callId checks; older callers without runId use the compatibility lookup.

Terminal runs drain remaining output before stopping periodic reads. Active runs perform fallback checks every 30 seconds with an event connection, or every 5 seconds without it. Failed requests back off from 5 to 60 seconds. Disabling display pauses reads; enabling resumes them. A shared event connection reconnects automatically and is released when its last consumer unmounts.

`npm run log -- scripts/test-output-subscriptions.mjs` checks lookup cost, shared cursors, terminal drain, settings changes, stale responses, reconnect catch-up, backoff and invalidation delivery. Output capture, independent host-record writes and DSH model supervision retain their existing paths.
