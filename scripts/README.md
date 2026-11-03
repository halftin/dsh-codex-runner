# Verification

Use Windows and Node 22.23.4 or newer. `npm run verify` runs the tracked offline
tests in separate processes with deterministic fake Codex. No installation,
credentials, model requests, historical `tasks/` files, or user profiles are
required. `npm run test:stage1` runs the settings and contract subset.

`npm test`, `npm run verify` and `npm run test:stage1` also save console output
under the repository's `logs/` directory and print its absolute path. Each run
uses a timestamp and unique suffix, preserves the child exit code, and keeps
output visible in the terminal. For another Node script use, for example,
`npm run log -- scripts/test-quota-entry.mjs`. Direct `node scripts/...` commands
remain console-only. Read the printed file with `Get-Content -LiteralPath <path>`.

Historical root-level `.log` files are archived in `logs/` with their original
names. This directory is ignored by Git, excluded from the package file list,
and has no automatic deletion. These are development/acceptance logs; production
task records remain under each workspace's `.codex-runner/logs/`. Logs may contain
private task content; redact them before sharing.

Repository fixtures must be synthetic and independent of personal workspaces.
`fixtures/synthetic-selection.json` deliberately models an invalid quota-based
downgrade; its paths and hash are placeholders, not captured project evidence.
Local implementation diaries and retired display experiments are archived under
the ignored `.local-dev/` directory. Keep reusable tests, host/browser probes and
document generators in Git; keep their generated evidence outside Git. Run
`node scripts/check-git-clean.mjs` after staging to check the actual index.

`test-quota-entry.mjs` connects the real recovery coordinator to the real tool
entry. Host persistence, quota transport and process launch are substitutes;
it checks selection continuity, current restrictions and external-call isolation.

`test-output-subscriptions.mjs` checks constant-cost exact lookup, shared cursors,
terminal drain and idle history, setting changes, stale responses, reconnect
catch-up and backoff. It exercises real filesystem invalidations and uses a
deterministic clock and browser substitutes for client lifecycle checks.

The following checks are separate and never counted as offline acceptance:

For current independent-message browser acceptance, set `DSH_ACCEPT_BROWSER_MODULE`
to the absolute path of `scripts/host-candidate-browser-probe.mjs` before running
`test-dsh-package.mjs`. It uses an isolated real DSH Web profile and headless Chrome,
with deterministic model transports, and checks both backends, committed display
settings, network reconnection, final answers, terminal idle reads and reload.

- `npm run test:live -- --check`: actual Codex login, handshake and model catalog;
  no model turn. Set `CODEX_HOME` explicitly when needed. Omit `--check` to start
  one real Codex model turn. The script refuses the offline fixture environment.
- `node scripts/probe-codex-capabilities.mjs`: actual CLI and version-matched
  protocol export, temporary registry cache, no model turn. A failed latest web
  reference refresh is recorded separately from local protocol export.
- `node scripts/test-live-questions.mjs blocking|async`: actual Codex model
  question acceptance, unique response marker checked in the final answer.
  Blocking uses the native experimental Plan collaboration mode; async uses
  Default. Native RPC and async message answers use separate response paths.
- `node scripts/acceptance-async-reply.mjs active|next-turn`: real Codex async
  questions must continue before answering and adopt a unique answer marker.
  Verifies the official correlated user-message envelope using the production
  driver. Set `CODEX_HOME` explicitly and optionally `CODEX_EXE` for another
  native version. No DSH model participates in this diagnostic.
- `node scripts/test-live-output.mjs exec|app-server`: one actual model turn;
  verifies intermediate output before completion with debug logging disabled.
- `node scripts/test-live-controls.mjs steer|queue|interrupt`: actual Codex with
  a scripted controller; checks effects separately from RPC receipts. This does
  not prove a real DSH model chose the intervention.
- `npm run test:host -- <isolated-host-prefix> <package.tgz>`: install a packed
  candidate into a temporary real DSH profile. First install the host with
  `npm install --prefix <isolated-host-prefix> --ignore-scripts --no-audit
  --no-fund @deepseek-ai/dsh@0.2.1-rc.3`. Codex is fake and the model adapter in
  `host-path-probe.mjs` is deterministic. Set `DSH_ACCEPT_BROWSER_MODULE` to the
  absolute path of `scripts/test-dsh-browser.mjs` for headless Chrome checks;
  optionally set `CHROME_PATH`. Screenshots at 375px are not phone acceptance.
  `host-supervision-probe.mjs` also tests native model-request receipts, automatic
  detach, question answering, steering, queueing and interrupting the same run.
  Its model adapter is deterministic; no external DSH model is called.
- Optional real DSH model probe in that same package test: set
  `DSH_ACCEPT_REAL_PROVIDER`, `DSH_ACCEPT_REAL_MODEL`, and
  `DSH_ACCEPT_CREDENTIAL_SOURCE` to an existing DSH credential file. Only the
  native DeepSeek account records/API-key reference are read into memory; no
  credential is copied to the temporary profile or written back to the source.
  The native provider enforces request origins. The test requires the requested
  model in the actual catalog, then asks it to answer and steer a fake Codex run.
  This remains separate from real Codex backend acceptance and phone tests.
  Set `DSH_ACCEPT_REAL_CODEX=1` and `DSH_ACCEPT_CODEX_HOME` as well to test real
  DSH-to-Codex steering. Add `DSH_ACCEPT_REAL_SCENARIO=blocking` for original RPC
  answers or `DSH_ACCEPT_REAL_SCENARIO=async` for correlated async answers with
  both models real. Failures, including quota exhaustion, are not passes.
  Add `DSH_ACCEPT_QUESTION_ONLY=1` to verify real async answering with supervision
  disabled: the question receipt advances, while the output model cursor stays 0.
- `npm run test:openapi`: installs validators into a temporary directory, so it
  may need network access when the pinned validators are not cached. It checks
  both OpenAPI documents, actual output/resources, and all nine routes.
- `node scripts/test-plugin-metadata.mjs <installed-app.asar>`: version-specific
  real desktop metadata consumers. Transport scripts requiring `DSH_TEST_RUNTIME`
  also target extracted desktop versions; they are not generic CI tests.

`npm pack --pack-destination <temporary-directory>` creates the candidate.
Unpack it and run `node scripts/check-package.mjs <unpacked-package>` to check
the actual runtime files. Tests and implementation records are tracked in Git
but excluded from the published package. Never count host fixture tests as
real-model or Agents Anywhere phone verification.


`test-selection-independence.mjs` verifies that the main switch off always uses the configured defaults and rejects explicit model/effort, that the main switch on with policy off requires an explicit pair, and that preset rules run only when both the switch and a policy are enabled; it also covers non-task downgrade rejection, supported capabilities, user caps and legacy quota-action pausing. It uses a simulated driver/catalog/quota, not a real DSH model. It is included in the default offline verification suite. Browser package acceptance also checks that policy controls follow the main switch; the pure-display probe explicitly disables automatic question handling to isolate display-only model usage.


Conversation acceptance: `node scripts/acceptance-conversation.mjs app-server` (or `exec`) makes three real Codex turns using Sol/low, Luna/low, then Sol/medium. Set CODEX_HOME explicitly if needed. Only the first prompt contains a random marker; subsequent turns must recover it from the same thread. Evidence is written under a fresh temporary directory. This invokes real models and is excluded from offline verification. Cache preservation is not inferred from history retention.

For both real DSH and Codex, use the existing package acceptance environment with `DSH_ACCEPT_REAL_SCENARIO=conversation`. It tests a natural-language follow-up (either supported continuation selector is valid), followed by an explicit continue_run_id call. This verifies usability in a controlled scenario, not the frequency of spontaneous thread reuse across engineering tasks. `test-conversation-continuation.mjs` covers the offline exec boundary cases, while test-return-handling covers App Server model/effort changes.

`node scripts/test-notification-coordination.mjs` 验证监督与通知的终态撤回、回合排序、消费不确定性、RPC 竞争和重启去重；使用隔离的宿主接口替身，不计作真实模型验收。定时查询互斥覆盖见 test-reply-signals、test-client-controls，真实浏览器入口 test-dsh-browser 也覆盖设置禁用、恢复和保存值保留。


官方子任务服务复用实验（不注册发行版工具，不修改日常 profile）：

```powershell
$env:DSH_ACCEPT_SEAM='1'
node scripts/test-dsh-package.mjs <isolated-host-prefix> <candidate.tgz>
Remove-Item Env:DSH_ACCEPT_SEAM
```

`host-seam-probe.mjs` 通过真实宿主公开 subagents API 注册临时 provider，先测试接口契约，再包装正式 codex_run/status/say/questions/answer/cancel 工具。提供方绑定表只在实验进程中保存选档和来源，不是已完成的生产适配。模型为确定性适配器，Codex 为模拟进程；不得标记为真实模型验收。输出 seam-experiment.json、seam-restart.json 与整体 acceptance.json；只保留临时目录中的受控证据。旧实施过程和失败记录仅作本地归档，不作为当前验收依据。


正式宿主管理接入验收：设置 `DSH_ACCEPT_HOST_MANAGED=1` 后运行现有 `test-dsh-package.mjs <isolated-host-prefix> <candidate.tgz>`，随后清除该环境变量。`host-managed-probe.mjs` 覆盖真实宿主的同步收集、续跑换档、监督/输出/插话、原请求问答、exec 输出/取消、目录映射和无官方重复通知；宿主重启后验证受管理任务已取消、默认后台任务仍存活。使用确定性模型与模拟 Codex，不计真实模型或手机验收。离线 `test-host-subagent.mjs` 进入默认回归，覆盖私有绑定、准入拒绝、身份/参数保留、回执、重复清理和启动中卸载等待。
