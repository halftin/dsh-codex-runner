# Configuration and registry

[Project home](../README.en.md) · [Documentation](README.en.md) · [中文](configuration.md)

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

## Configuration and registry editor

Advanced settings end with **Edit full configuration and registry**. The dialog contains **Table**, **Registry JSON**, and **Configuration JSON** tabs sharing the same draft. The searchable table covers all 29 plugin configuration fields, daily Codex registry fields, and catalog translations, with source, key, value, allowed range, and description/translation columns

Valid JSON and table edits synchronize when switching tabs. Edits remain drafts until Save. Configuration changes go to the current profile; field-rule differences go to `<DSH_HOME>/codex-runner/fields/overrides.json`, and Chinese translation overrides go to `<DSH_HOME>/codex-runner/i18n/zh-CN.user.json`. Clearing a configuration field or setting it to `null` removes its profile override and restores inherited defaults

The editor validates configuration and rules, checks revisions to avoid overwriting external changes, and preserves the dialog and draft on failure. If one destination saves and another fails, it reports the saved part rather than claiming complete success. Closing a dirty dialog requires confirmation. Narrow windows scroll inside the table while tabs and save actions remain available

The header shows the local Codex version, **Refresh registry**, and the last successful update time. Read-only `codexVersion` and `updatedAt` entries also appear in the registry JSON and table; unknown values are `null`. Refresh discovers native definitions without a model turn and updates the reference cache independently of Save. It preserves unsaved configuration and translation edits. Failure retains the last successful timestamp instead of inventing a new one

The bundled `lib/codex-registry.json` provides a self-contained fallback: 14 general pass-through fields and seven dedicated control fields, with English definitions and Chinese translations. External discovery failure falls back to matching cached data or this file. Valid user overrides remain in place; unreadable user files or unavailable editor services make registry editing read-only while Configuration JSON remains available. Refresh never rewrites the plugin's bundled registry

Restart DSH fully after updating host code or communication interfaces; refreshing a browser page alone cannot reload cached host modules. An unregistered editor endpoint can produce HTTP 404 even when the bundled registry exists. `DSH_HOME` may be a Windows directory junction; internal redirected registry paths remain checked

## Optional controls and token usage

Quota and common settings are shown directly; Advanced settings remain collapsible. Automatic model/effort completion has a grey beta badge, is off by default, and expands its selection-related controls only when enabled

The policy dialog includes task, evidence, downgrade/approval, quota, and advanced-JSON tabs, strict/balanced/economy presets, recommendation reset, preview, and validation. Invalid JSON or catalog values prevent saving. Changes are read by subsequent runs

Process monitoring, local logs, catalog/registry refresh, and ordinary status queries run in code without a separate model call. DSH's review of task results and delivered notifications can still use model tokens. Optional low-quota messages, recovery, repeated pause reminders, evidence preparation, and active status reporting may add model-token costs as explained by their controls

**Periodically query Codex status** maps to `statusPollingEnabled`, off by default. The interval is an integer from 15 to 120 minutes, default 30. It wakes DSH to query and briefly report active work, consuming DSH model tokens. Runs in the same session share one pending schedule; different workspace intervals use the shortest value. Completion, pause, or disabling the setting removes the schedule. Restart reconciliation prevents duplicate schedules. Polling supplements reply signals rather than replacing them

The pause-wait control edits seconds, with 0/30/60/120/300-second presets and custom input; JSON stores milliseconds. The debug-size control edits MiB while JSON stores bytes. Turning debug logging off disables its size control without erasing the chosen limit

## Language and manual translations

Chinese descriptions prefer user translations, then bundled Chinese text. The English interface uses English descriptions or original Codex text and does not show Chinese translation inputs. Native keys, model/effort IDs, and enum values stay unchanged

Maintain translations manually in the table or Registry JSON tab. No model call, translation session, or automatic translation tool is involved. Clearing an override restores bundled text. Model and reasoning-effort entries translate descriptions; registry settings support names and descriptions

Bundled defaults come from `lib/codex-registry.json` and are cached in `<DSH_HOME>/codex-runner/i18n/zh-CN.default.json`; overrides use `zh-CN.user.json` in the same directory. Values are single-line plain text of at most 200 characters. Corrupt user files fall back for display and must be repaired before saving; existing files and backups are not automatically deleted

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
