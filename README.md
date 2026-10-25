# dsh-codex-runner

中文 | [English](README.en.md)

DSH 插件：运行 Codex CLI 任务，返回完整最终答复和运行状态，支持后台运行、准确查询、续跑、插话和取消。

当前为首个发布版本 `0.5.0-rc.2`，仅支持 Windows。需要 Node `>=20`、DSH `>=0.2.0-rc.2 <0.3.0` 和已登录的 Codex CLI。已在 Windows / Node 24.19.0 / DSH 0.2.1-rc.3 Web profile 完成隔离安装、设置保存、后台任务重启查询、取消和卸载验收；验收使用确定性假 CLI，未调用真实模型。最新版桌面安装器、其他 Windows 机器及 Node 20/22 未完成本轮实际验收，版本范围不表示其中每个版本都经过测试。Codex CLI 基线为 `0.160.1`；兼容驱动需要 `exec --json`、`exec resume` 与 `queue`，新驱动需要 App Server v2 协议。自动补全模型和思考强度仍为默认关闭的 beta 功能，尚未验证复杂度判断准确率或实际额度节省

## 安装

安装前准备：DSH、Node、Codex CLI；先在终端完成 `codex login`。CLI 不包含在插件包中。两个驱动均继承 Codex 用户配置，并显式传递本次主任务的模型、强度、审批和沙箱权限。原生子 agent 的启用、线程上限和默认模型/强度由 Codex 自身配置及模型调用决定，插件不再提供重复覆盖；MCP/插件等原生扩展也按 Codex 配置加载。

在支持的 DSH CLI 中，将插件安装到目标 profile：

```text
dsh plugin --profile <profile> add <发行包.tgz>
dsh --profile <profile> --dump-config
```

也可从 GitHub 仓库安装，使用固定 commit：

```text
dsh plugin --profile <profile> add github:halftin/dsh-codex-runner#<commit>
```

仓库根必须是本包的 package.json。提交 lib、drivers 等可运行 JS，不需要构建或 prepare 脚本。DSH 通过 dsh.bundle.patch 加入 profile 的 bundles 列表；单纯执行裸 pnpm 不保证激活该层。

桌面版可通过插件管理界面添加发行包，按该版本提示重启。不同 DSH 版本对 desktop profile 的 CLI 管理支持不同。不要把修改 pnpm store 路径或强杀安装进程当作通用安装步骤。

首次使用执行 `codex_doctor()`，查看 searched candidates、原生 exe、版本、CODEX_HOME、auth 和 App Server 握手结果。高级设置 `codexExecutable=""` 留空自动发现，填写时须为原生 Windows PE `.exe` 的绝对路径，拒绝 `.cmd/.bat/.ps1` 和改名脚本；`codexHome=""` 留空继承 CODEX_HOME，未设环境变量时使用 CLI 默认目录。两项只传入本次子进程，不修改宿主环境或认证文件。

发现顺序为 `codexExecutable → CODEX_EXE → Windows 标准 npm 全局路径 → ~/.local/bin → PATH → 常见安装目录`。常见目录包括自定义 npm prefix（环境变量或用户 npmrc）、pnpm、yarn、bun、Volta 包镜像、scoop、winget、用户 bin/Apps/Codex 便携目录及 Codex Desktop 的 CLI resources。npm 同时识别嵌套/提升的 Windows 平台包和旧 vendor 布局，支持 x64/arm64。自动发现的 shell shim 只解析静态目标或其 prefix，不能解析便明确报错，不执行 shim 或盲目换装；服务账户的 HOME/PATH 与交互用户不同时，可显式配置这两个路径。插件只支持 Windows，不安装 CLI、不改 PATH、不登录、不复制认证、不修改 CODEX_HOME 内容。

DSH 进程必须继承登录时使用的 CODEX_HOME；未设置时 CLI 使用用户目录下的 .codex。桌面端与终端使用不同目录时，doctor 会报告未登录。不要把 auth.json 复制进插件或发行包。

## 工具

| 工具 | 用途 |
|---|---|
| codex_run | 同步或后台执行一次任务 |
| codex_status | 查询进度、最终答复及终止原因 |
| codex_cancel | 请求所属 driver 停止该运行及其进程树 |
| codex_list | 列举当前工作目录最新 100 次运行 |
| codex_say | queue 下一轮追加；App Server 另支持 steer 当前轮转向与 interrupt 中断 |
| codex_config | 只读查询当前配置，报告逐字段来源和允许的配置键 |
| codex_doctor | 检查 CLI、命令能力和登录，不调用模型 |
| codex_quota_resume | 定时提醒调用的恢复检查；核对原会话、generation、账号和新鲜额度后续跑一次 |
| codex_sessions | 列举当前工作区的插件关联 Codex 会话 |
| codex_read | 分页读取答复、事件或 Codex 原生回合；读取不会启动模型 |
| codex_release | 确认后释放 stale/orphan 的占用，保留记录和进程 |
| codex_models | 读取模型目录、来源与 freshness，不启动模型 turn |
| codex_selection | 筛选当前工作区的推荐/实际选档审计 |
| codex_quota | 读取账号级额度、重置、来源和恢复状态 |
| codex_diagnose | 默认只读诊断；显式 probe=true 才发送 steer |

上述 15 个工具与 dsh.plugin.json 清单对应。Host 入口为 `./lib/index.js`，client 导出为 `./lib/client.js`；bundle 的包名、设置入口和 client 注册 ID 均为 `dsh-codex-runner`。

```text
codex_run(prompt_file="task.md", label="smoke", model="<可用模型 ID>", effort="<该模型支持的强度>")
codex_run(prompt_file="task.md", label="long-task", model="<可用模型 ID>", effort="<该模型支持的强度>", detach=true)
codex_status(run_id="<返回的 UUID>", wait_ms=30000)
codex_say(run_id="<UUID>", message="追加说明")
codex_cancel(run_id="<UUID>")
codex_run(prompt_file="next.md", label="resume-task", model="<可用模型 ID>", effort="<该模型支持的强度>", resume_thread="<thread_id>", continuation_of="<previous_run_id>")
```

先通过 `codex_models()` 查询当前可用模型和强度，再替换示例中的占位符。自动补全默认关闭；新任务和续跑均须提供模型与强度，也可通过明确的 `task_kind` 或已配置的证据选档提供。

每次运行都有唯一 run_id。label 可复用，但只表示该标签最新一次运行；需要准确定位时使用 run_id。label 仅允许 1–80 个 ASCII 字母、数字、下划线和连字符，以字母或数字开头，并排除 Windows 保留名称。

`codex_run` / `codex_status` 的 `ok` 只表示本轮执行结束。两者返回 `turn_status`、`process_status`、固定为 `unknown` 的 `task_state`，以及 `needs_dsh_decision` / `decision_reason`。正常完成仍需 DSH 读证据并验收；空回答标 `empty_answer`，子 agent 仍运行或状态未知标 `subagents_running`，不据此判断任务失败。`has_final_answer` 表示存在非空最终回答。codex_run / codex_status 完整返回最终回答原文，排除推理、工具输出和进度 commentary，不再按字符数截断或额外总结。后台通知保持有界。完整、脱敏后无需改写的短回答（不超过 500 字符），只有在回合匹配、进程已确认退出且无排队指令、未完成子任务或恢复流程时，才标记 answer_complete=true、requires_status_refresh=false，允许 DSH 直接验收；其他通知仍要求刷新状态，状态查询返回完整正文。通知延迟或与较新指令冲突时仍需刷新；通知预览或确实不完整的源数据通过 answer_truncated 标明，不能据此直接验收。工作过程可通过 codex_read 按需查询。

有 thread_id 且非用户取消时 `resumable=true`，包括正常 completed；DSH 可显式传入下一轮 prompt_file 和 resume_thread。`continuation_of` 仅记录前一 run_id 的审计关系，不触发续跑，也不限定下一轮方向。用户取消无需 DSH 决策；waiting_quota 返回 `automation=quota_resume`，保留现有额度恢复流程；其他情况默认 `automation=none`。插件不自动验收、continue 或 restart。

`handoff` 由代码按执行事实生成，包含 owner、action、dispatch 和 read_answer。仍在运行时 `await_run`；额度自动恢复时 `await_quota`；已有恢复后续运行时 `follow_successor` 并给出 run_id；用户停止时 `stopped`。孤儿或归属不明进程、未结束的子任务、异常额度恢复先交 DSH 核实，dispatch=blocked。正常结束交 DSH 验收（review_result），非预期中断交 DSH 修复续做（recover_task），dispatch=after_review 表示通过原任务语义及授权检查后可以派发，不代表任务已完成。`resumable` 仅表示有线程可用，不代替 handoff 的执行约束。

插件不再向 Codex 注入任务契约或工程纪律，提示词按 DSH 提交内容原样发送；选档证据也不改写任务提示词。任务目标、验收与续做由 DSH 负责：只要用户目标尚未完成，就应在原授权内修复中断、调整方案并继续推进；只有缺失的决定或权限确实阻塞任务才询问。代码不把一次回复或进程退出判断为任务完成。通知要求 DSH 刷新一次 codex_status 并按 handoff 推进，回答和错误证据足够时无需额外 codex_read。用户停止、额度等待及活动任务不因通知而被重复启动。插件在 admission 锁内拦截同一 Codex thread 的并发续跑，即使使用不同 label 或提高 maxConcurrent 也生效。

默认同一工作目录只允许 1 个运行，防止并发修改同一工作树。同步与后台共用完整配置 JSON 中的 defaultBudgetMs，默认 0（不限时）；单次调用 budget_ms 优先，0 可显式关闭默认时限。正数时限到期由驱动停止运行并保留中断证据，交 DSH 评估续做。取消后应检查 git status/diff，插件不会自动回滚任务修改。

后台任务可以跨 DSH 重启，重新启动后用 run_id 查询或取消。先取消活动任务再卸载；卸载插件不会自动回滚工作目录，也不会自动终止刻意独立运行的后台进程。

## 新驱动、插话与会话读取

默认使用 App Server；驱动选择控件已隐藏，可在高级设置的“编辑完整配置与注册表”中修改 `backend`。不支持与自定义 driverPath 同时使用。新驱动会查询当前账号的模型能力，拒绝未列出的模型/强度或服务档组合；交互审批请求默认拒绝，不能把无人值守执行当作有人会点击批准。

`codex_say(run_id="<UUID>", action="steer", message="补充要求")` 将指令交给活动回合，不保证正在执行的外部命令立即停止。`action="interrupt"` 请求中断该回合；真正取消整个运行使用 codex_cancel。返回 accepted/requested 代表协议已接受，后续结果仍需通过 codex_status 确认。兼容 exec 模式只支持 queue。

`codex_read(run_id="<UUID>", source="answer|turns|summary|events", offset=0, limit=12000)` 返回有界文本。answer 优先读取该 run 对应 App Server turn_id 的最终 assistant 回答，不会读成同一线程后续运行的回答；原生不可用或没有 turn_id 时回退 meta.lastMessage，exec 仅用 meta。read_source/fallback_reason/answer_truncated 标明来源和截断。summary 只返回 turn_status、decision_reason、回答长度/截断、subagents 和 quota，不读原生 thread、不返回回答。events 默认拒绝；只有当前 debugLogs=true 且该 run 启动时也启用了 debug 才能读。answer/events 使用字符偏移，可继续读取；turns 先完成当前页的字符分页，再使用 next_cursor 取下一页。活动回合内容可能变化。文件路径和原生线程 cwd 都校验工作区范围；不扫描其他工作区历史。日志被截断时会报告 truncated，不能把截断内容当成完整执行证据。

## 额度恢复（默认关闭）

设置页的“额度恢复后自动继续”对应 `autoResumeAfterQuota`。开启需要 App Server、DSH Schedule 和 StorageDomain、可恢复的原 DSH 会话，以及能通过 CLI 查询额度的 ChatGPT 登录。插件没有捆绑这些宿主服务或登录凭据；缺少时拒绝启动自动恢复任务。

当相关账户额度窗口使用量达到 95%，驱动请求 Codex 保存检查点并结束当前轮。暂停等待 `pauseGraceMs` 默认 0，表示不限等待；设为正数时，等待一轮后再催促一次，再等一轮仍未结束则请求强制中断，并记录没有确认检查点。进程终止不等于任务保存成功。多个窗口同时受限时取最晚恢复时间，再加 180 秒。驱动退出，释放工作区执行槽位；DSH 将固定的恢复检查指令投递到原会话。

如果两次轮询之间先收到协议明确的 usageLimitExceeded，立即重新查询额度；只有新的受限读数和有效恢复时间才允许自动排期。普通 rateLimitExceeded 不直接等同订阅额度耗尽。暂停过程中运行预算先到期时，仍保留额度等待状态，并标明检查点未确认。

到点必须再次核对额度及账号指纹：仍受限则重排；恢复时间未知、账号不可核验或变化、调度写入失败时报告 needs_attention。恢复沿用原 Codex thread，并带回暂停前已接受但未消费的排队消息。DSH 模型需要实际调用 codex_quota_resume，且 DSH 自身模型服务须可用；定时消息送达不等于任务已恢复。codex_status 的 recovery 分别报告排期、后续 run_id 和失败原因。

关闭开关会作废待恢复记录并删除对应提醒；取消旧 run_id 会沿恢复链请求取消后续运行。重复或过期提醒不会重复派发。工作区繁忙时每 5 分钟有界重试，最多 12 次，之后需要处理。DSH 关闭期间不执行；重启后由宿主持久化定时服务处理逾期任务。不会注册系统开机任务，也不会自动唤醒 Codex 桌面版中的开发聊天。卸载前应关闭该功能并取消等待任务；已投递的旧提醒即使残留，也无法通过已作废的恢复检查。

### 额度告警（默认关闭，0.4.0-rc.2）

“低额度提醒”开关与阈值滑块位于“额度恢复后自动继续”上方，两个开关互不影响。提醒关闭时仅禁用该行阈值滑块（0–20%，默认 5%）。

剩余额度达到提醒阈值时，App Server 向当前活动回合发送一次中文指令，要求保存进度并暂停。提醒本身不创建恢复排期；未开启自动继续时保持暂停，等待用户手动续跑。此功能需要可读取的账号额度，不需要 DSH Schedule/storage。运行 meta 的 `warning` 记录阈值、剩余额度和消息投递状态。

只有 `autoResumeAfterQuota=true` 才启用自动恢复流程，并要求 DSH Schedule/storage。单独开启自动继续时仍使用原有的额度耗尽判定；同时开启提醒时，也可在提醒触发的暂停后安排恢复；关闭自动继续后，即使提醒仍开启，也会作废待恢复排期。

## 有依据的模型选择

`selectionMode=legacy` 保留原任务类型规则；`manual` 要求每次明确传 model 和 effort；`evidence` 要求结构化 evidence：`files`、`acceptance`、`uncertainty`，可附 `plan_file`、接口/架构/并发/权限风险及 `failure_reason`。

插件核验文件属于工作区、计划存在并记录 SHA256；风险和验收描述属于调用方声明，返回值会与文件事实分开。机械/文档任务有明确计划且不确定性低时使用 luna/low；架构、接口、并发或权限决策使用 astra/xhigh；常规任务使用 sol；环境故障不会自动升级。范围缺失或不确定性高时先派发只调查、不实施的任务。文件数量本身不决定档位。

增强选档策略为 enforce 时，显式覆盖须写 override_reason；off 和 audit 不强制额外解释。所有模式仍受 maxEffortAllowed 限制。选档理由保存在 selection.json 和工具返回值中。这是可审计的启发式规则，并非能准确理解所有任务的分类器，也不承诺固定额度节省。

## 设置

插件介绍、设置控件和注册表编辑器随 DSH 的界面语言切换：中文界面显示中文，英文界面显示英文；模型标识、配置键和协议状态保留原始值。更新插件后完整重启 DSH，以重新读取插件元数据

优先级由低到高：代码默认 → DSH profile 配置 → 支持的单次参数。设置页控件与“编辑完整配置与注册表”编辑器共用同一份 profile 数据，由 DSH 原生配置服务保存；不再读取或写入独立的全局、工作区设置 JSON 文件。已有独立文件不迁移、不删除，也不会覆盖页面设置。运行记录和日志仍保存在各工作区的 `.codex-runner/logs/`。

保存后的 profile 值用于后续任务；“恢复默认”清除对应的 profile 覆盖，回落到代码默认值。安装模板不再重复写入默认设置。单次参数只作用于当次调用，不修改 profile，也不能绕过选档和权限校验。

```text
codex_config()
```

`codex_config` 无参数、只读，返回当前配置及 `field_sources`（`profile` 或 `defaults`）；修改持久化配置请使用插件设置页及其完整 JSON 编辑器。工具不提供 set/unset/reset/path 或 project/global scope。

设计原则：进程监测、日志、目录和额度接口查询由代码执行，不单独发起模型请求；DSH 接收任务结果、异常通知并判断用户目标，会消耗必要的模型 token。定时查询、额度自动恢复、低额度保存并暂停、增强选档均由用户主动选择。设置页明确标注可选增强的开销：额度恢复会唤醒 DSH 并续跑 Codex；保存检查点及超时再次催促可能增加 Codex token；证据选档所需信息可能增加 DSH token。通过工具交给 DSH 的翻译任务消耗 DSH token；手动编辑注册表与翻译不调用模型。独立复核目前只是强制策略的要求标记，插件不会为它自动启动额外模型任务。

主要默认值：defaultModel=gpt-6.1-sol、defaultEffort=high、maxEffortAllowed=xhigh、sandboxMode=workspace-write、approvalPolicy=never、maxConcurrent=1、defaultBudgetMs=0、retentionDays=0、retentionMaxRuns=0、debugLogs=false、debugMaxBytes=2097152、quotaWarning=false、quotaWarningThreshold=5。

审批策略的下拉选项和前后端校验统一读取 Codex 字段注册表；备用选项为 `never`、`on-request`，排除已退役的 `untrusted` 和已弃用的 `on-failure`。完整配置 JSON 使用相同校验，默认仍为 `never`。

沙箱模式的下拉选项和前后端校验也读取字段注册表，默认仍为 `workspace-write`。选择 `danger-full-access` 即使用完整访问模式；未登记的模式直接拒绝，不自动回退。未来模式若涉及新的 App Server 权限结构，仍需对应的协议适配。

“沙箱内网络”的表单、完整 JSON 和运行前校验读取注册表中的 `sandbox_workspace_write.network_access` 定义，并向两种驱动显式传递布尔值；关闭会发送 `false`，覆盖 Codex 原有的网络开启配置。

task_kind 规则：mechanical/docs → luna/low；review → sol/medium；implement → sol/high；architect/rework → astra/xhigh。显式 model/effort 优先。超过 maxEffortAllowed 需显式 unlock_effort=true。luna 不接受 ultra。

codexConfig 和 extraCodexConfig 使用同一白名单；后者是 k=v 数组，不是绕过保护策略的入口。可用键由 `codex_config()` 列出。无效的 profile 配置在运行前报告错误，不静默回落。

driver 随包包含，driverPath 仅保留在 JSON 配置中，不在设置页提供独立控件；它是受信任用户的覆盖设置，可通过“编辑完整配置与注册表”编辑。自定义 driver 必须实现当前 run-id、meta、heartbeat、取消和停止协议。同步与后台运行都注册持久通知记录；同步正常返回记录提交回执，避免重复通知。宿主关闭和调用通道断开归类为可检查的执行中断，不冒充用户取消。

## 数据与故障处理

运行文件位于 `<cwd>/.codex-runner/logs/runs/<run_id>/`：run.json、result.meta.json、result.hb.json、terminal.json、selection.json、pending-messages.json 等固定元数据。两种驱动的 meta.lastMessage 保存完整最终回答，不保留推理或进度正文；answerLength 保存字符数，不再设置 20000 字符保存上限。后台通知的 answer_preview 有界，完整正文由状态查询提供。默认均不产生 events.jsonl、answer.txt、result.err.log、result.jsonl。失败的 meta 保存脱敏 error/error_class/stderr_tail（最多 2048 UTF-8 字节）及 termination。

“记录调试事件”与容量上限合并为一行；容量以 MiB 编辑并提供预设，关闭开关时禁用容量控件但保留其值，恢复默认同时重置两项。JSON 中 debugMaxBytes 仍使用字节。debugLogs=true 仅为之后启动的 run 写 events.jsonl，debugMaxBytes 默认 2 MiB，达到上限即停止，省略 assistant 消息文本和 delta，不写完整 answer。U8 仅读 meta.error/meta.stderr_tail，不读旧日志或 debug。已登记工作区在插件加载、每天和新 run 前执行清理：安全终态 run 先删 debug/旧 bulk 日志，固定元数据按每个工作区 retentionDays 和 retentionMaxRuns 处理，两项默认均为 0，运行历史随工作区保留；0 天禁用按时间清理，0 条不设数量上限，超出任一限制后才检查是否可安全删除。无终态、任一执行 PID 存活、含符号链接/子目录、未解决 recovery 均保留；不清理 Codex 自有数据。未解决 quota 超过 30 天在 recovery 状态返回 retention_warning，须检查并显式取消后才能清理。默认兼容模式不因历史额度快照阻止新任务；开启自动恢复时，App Server 使用新鲜额度进行启动前检查和活动轮暂停。

未解决的额度等待和 needs_attention 记录保留，避免清理掉续跑证据；恢复链已结束或明确取消后，运行文件可以按通常保留策略清理。宿主中的 completed/cancelled 恢复索引保留 30 天，之后移除；未解决索引不会自动过期。数据目录、logs、runs 及具体运行目录不得使用重定向链接；工作区本身可以通过链接访问。此检查防止误配置和预先存在的目录重定向，不承诺抵御同一用户权限下并发替换文件的恶意进程。

旧 bulk 日志不做读取兼容或迁移；安全终态 run 的旧文件直接清理。异常消失的 driver 可能留下孤儿进程；插件会报告，需先核实归属再人工处理，避免 PID 复用误杀。

## 运行行为与可选功能

### 可靠性与长思考保护

| 工具 | 用途 |
| --- | --- |
| `codex_release` | `run_id` + `confirm=true` 仅释放 stale/orphan 的 admission 占用，不杀进程、不删除记录。 |

状态查询保留最后输出、事件和心跳时间等客观信息；不因长时间无输出标记“疑似停滞”、判定失败或中断任务。进程退出、连接故障、启动异常及心跳丢失仍由运行健康检测处理，并通知 DSH 判断后续行动。
额度暂停默认 `pauseGraceMs=0`，等待检查点与回合结束。设置页将“额度暂停等待”显示为单行，以秒编辑，提供 0/30/60/120/300 秒预设和自定义输入；JSON 中仍以毫秒保存，支持精确到 1 毫秒的秒数输入。显式设置非零值后，先等待一个间隔，再次催促保存进度，再等待一个间隔，仍未结束才请求 interrupt 并记录无确认强制中断。
显式 budget 仍是预算；无限期 detached 任务使用 `budget_ms=0`。
无终态记录不会按年龄删除；进程归属未知时保守保留占用。
`codex_config` 仅查询配置。策略、安全设置及其他持久化修改统一通过 profile 设置页或完整配置 JSON 编辑器保存。
关闭策略不改变已经运行中的任务。


### 动态模型目录

| 工具 | 用途 |
| --- | --- |
| `codex_models` | 只读列出模型、effort、service tier、默认值、来源和 freshness；可 refresh/include_hidden，不启动模型 turn。 |

目录在插件加载时异步刷新，首次 run 和 doctor 也会刷新。缓存位于 `$DSH_HOME/codex-runner/cache/model-catalog.json`，按 CLI 路径/版本、CODEX_HOME、账号身份隔离，有效期 24 小时。离线回退缓存或随包四模型目录，并明确标 stale。旧 fast 映射 priority；off 不传 tier。
`codexRunner` 服务通过宿主认证的 Connection 通道提供目录、额度和状态查询；新增 getEditorRegistry/saveEditorRegistry 仅供用户编辑窗口读取、预检和保存固定位置的注册表与翻译文件，不接受任意路径。插件 profile 配置仍由 DSH configForms 保存，不通过该通道写入。宿主缺少 Connection 时工具与 fallback 仍可用。


### 选档策略与审计

| 工具 | 用途 |
| --- | --- |
| `codex_selection` | 只读筛选当前工作区的推荐/实际选档、降级原因、策略版本和 run_id。 |

`selectionPolicy` 是 profile JSON，默认 off、require_approval=false，只读取当前 profile；缺失部分由代码默认值补齐。off 不应用增强规则；audit 只记录推荐和实际档位，不改变选档、不强制理由、不执行额度门禁或要求额外复核；enforce 才调整未显式指定的档位、校验覆盖理由并执行额度和降档规则，需要审批时返回 approval_required 且不启动 driver。当前没有逐次审批 UI，不能通过工具参数伪造批准。unlock_effort 只突破上限，不能绕过 floor。
模型顺序是默认策略角色顺序（luna/sol/6.1-sol/astra），不是目录性能事实。陌生模型与不同 floor 的强度关系不明时明确记录 comparison=unknown；enforce 拒绝。
每个新 run 都保存 selection.json；codex_list 显示 model/effort/downgrade；codex_read(source="selection") 有界读取，旧 run 返回 null。已有无策略设置不需迁移；由 profile 人工设置 mode=off 可关闭 floor，仍保留审计及显式覆盖理由。


### 设置页与策略弹窗

设置页直接展示额度和常用设置，仅高级设置保留折叠。全部展开时共 19 个常规设置行；自动补全默认关闭，其关联选档控件随开关展开或折叠；codexExecutable、codexHome 位于高级设置，各自使用左侧说明、右侧原生路径输入框的同行布局，窄屏自动换行；定时查询开关和间隔滑块在核心运行设置中合并显示。selectionPolicy 的模式直接在设置页编辑，关闭／仅审计／强制执行共用原有 JSON 字段；详细规则仍通过策略弹窗编辑。目录不可用时仍显示 fallback 和错误来源，可手动刷新。
页面分组、行顺序和默认折叠状态由 lib/client.js 中的 PAGE_LAYOUT 统一维护，不属于用户配置。
开关/下拉/滑块行使用插件内置的 Row（官方 primitives 目前没有导出行组件）；排版统一取 `TYPE_LABEL/TYPE_BODY/TYPE_HINT`，几何对齐官方 `SettingsValueField`。
选档策略弹窗包含任务、证据、降级/审批、额度和高级 JSON 五个 tab，提供严格/平衡/省额度预设、恢复推荐、预览和校验。低于推荐 floor 有文字警告；无效 JSON 或目录值阻止保存；关闭未保存修改需要确认。保存后下次 run 热读取；审批仍返回 approval_required，不提供逐次批准入口。


### 中英文显示与手动翻译

界面跟随 DSH 的语言设置。中文界面优先使用用户中文翻译，再使用内置中文；英文界面显示英文说明或 Codex 原文。模型标识、原生配置键和枚举值保持不变。模型和推理强度只翻译 description；settings 分组维护日常注册表字段的 name/description，默认覆盖 21 项配置字段。

翻译统一在“编辑完整配置与注册表”窗口的表格或注册表 JSON 中手动维护，不调用模型，不创建会话，也不提供模型翻译工具。保存只写用户覆盖；清空或删除用户翻译会恢复内置文本。界面草稿、保存前校验、冲突检测和损坏文件保护与其他注册表编辑共用。

默认翻译来自插件内的 `lib/codex-registry.json`，缓存同步至 `$DSH_HOME/codex-runner/i18n/zh-CN.default.json`；用户翻译位于同目录的 `zh-CN.user.json`，逐次读取。每个翻译值最多 200 字，只接受单行纯文本。损坏用户表会回退显示内置翻译，保存前需要手动修复。既有用户翻译和旧备份不会因功能移除而删除；未启用字段的翻译保留，重新启用时复用。

### 额度与诊断

| 工具 | 用途 |
| --- | --- |
| `codex_quota` | probe=none/fresh/active/both，返回账号级 5h/7d、采样时间、来源、warning、recovery 和探针延迟/错误。 |
| `codex_diagnose` | 汇总 driver/hb、事件、turn、只读进程树和额度证据；默认不 steer、不 kill、不重启。probe=true 才显式 steer，并标 intrusive。 |

fresh 只调用 account/read 和 account/rateLimits/read，不启动模型 turn；最多三分钟一次，refresh 不能绕过限频。失败保留最近数据并标 stale、账号面不可达；成功不代表推理链路正常。exec 只读最近 run，标 last-known/stale。codex_status 增加 quota_source/quota_sampled_at。
顶部额度条与工具共用数据源，显示账号级范围、剩余、重置、阈值和恢复。页面打开/手动刷新/终态事件时拉取；不做后台轮询或历史曲线。终态无内容事件通过现有 Connection 的认证只读 Fetch 路由送达，仅页面打开时订阅；事件通道不可用时保留手动刷新。主机用 fs.watch 观察自己启动的 run，卸载时关闭 watcher/stream。


### 原生 subagent 与高级设置

子 agent 的启用、会话线程上限及默认模型/强度完全继承 Codex，插件不提供对应控件或默认透传规则，也不代替模型拆分、调度子任务。子任务状态跟踪和 DSH 验收交接继续保留。独立的消息记录字段 agents.interrupt_message 仍只在完整配置 JSON 中提供，类型为布尔值；true/false 控制 Codex 是否记录模型可见的中断消息，省略或 null 清除该层覆盖并继承 Codex 配置。它不影响插件向 DSH 发送中断通知。
状态解析 CollabAgentToolCall/SubAgentActivity 及兼容命名，按子线程去重，codex_status.subagents 返回 count/running/completed/failed/unknown 和最多 32 条摘要，不收录子消息内容。仅父工具调用完成不能证明子 agent 完成；未知状态明确标 unknown。跟踪最多 512 个子身份，超过时标 truncated。
共享只读服务可 getSubagents(runId)；codex_read(turns) 保留原始 items，codex_sessions 仍只列插件父 run。插件不执行 spawn/fan-out；子任务的分工和并行策略由 Codex 自行决定。
高级设置补齐 maxConcurrent、retentionDays、retentionMaxRuns、debugLogs、debugMaxBytes、pauseGraceMs；运行时限 defaultBudgetMs 仅在完整配置 JSON 中提供。pauseGraceMs 默认 0，非零可能强制中断。

### 运行异常与完成决策提醒

插件管理的 detach run 每次 turn/completed 都产生 reply 信号，包括同一 run 的多个 turn；failed、spawn-error、killed、needs_attention、orphan/stale、非用户 interrupted/aborted，以及 waiting_quota/quota-blocked 也可见。用户取消/显式 interrupt 和单纯思考不发信号。同步 run 的工具结果就是信号，即使指定 always 也不重复发会话消息。直接 `codex exec/resume` 没有插件登记，不在范围内。

单次 `codex_run` 参数 `notify_on_complete=off|decision|always` 只控制额外唤醒：detach 默认 decision、sync 默认 off。off 不抑制可见信号；decision 仅在 needs_dsh_decision=true 时额外唤醒；always 对非用户取消回复/终态唤醒。支持被动会话投递的宿主适配器优先发送被动消息；当前插件接入的宿主服务为 schedule，因此以一次提醒同时承担可见性与按需唤醒，不创建第二条提醒。这种 fallback 有 DSH token 成本。

信号包含 run_id/标签、turn_id、turn_status、needs_dsh_decision、decision_reason、handoff、has_final_answer、最多 500 字的脱敏 answer 摘要、thread_id、quota（含恢复时间）；终态附有界错误摘要。DSH 按刷新后的 handoff 验收和推进原授权任务，不因一次回合结束或可修复失败而直接终止任务。宿主每 3 秒检查已登记 run，卸载停止，重新加载恢复；驱动已退出但 meta 仍写 running 时也按存活证据上报异常。离线或投递服务不可用时不能保证立即送达。

插件私有 `$DSH_HOME/codex-runner/notifier-runs/` 保存精确 run 指针，不使用 DSH storages；notified.json 保存 turn 回复序号游标和终态键，按 (run_id, turn_id, kind) 去重，连续失败的不同 turn 分别投递。meta 最多保留 64 条待投递回复摘要，已确认条目回收；积压满时停止派发已排队 turn 并进入 needs_attention，避免丢回复或无限增长。同步结果的 reply_signals 包含本轮摘要。notify-intent.json 在投递前写入；不确定的投递仅对账，不重复 create。失败写 notify-error.json，codex_status 暴露 notification 状态；未提交的后台回复和通知错误保留证据，不重放 Codex 工作。submitted 仅表示宿主接受通知，不表示 DSH 已执行或验收。

`statusPollingEnabled=false` 默认关闭主动查询；用户开启后，`statusPollingIntervalMinutes=30`（整数 15–120）决定查询间隔。只为仍活跃且原会话可投递的 run 建一次性 schedule；同会话多 run 合并，结束/暂停/关闭设置后删除。每到一次间隔唤醒 DSH 查询并简短报告；若查询时发现已结束或异常，则沿用同一 handoff 规则处理，不重复活动任务。开启才产生主动查询的模型 token 成本；它不能替代每次回复信号。私有 status-polling 目录保存指针和调度意图，重启对账，保持每会话最多一条待执行查询；多工作区间隔不同时取最短值。

“编辑完整配置与注册表”窗口默认显示五列表格（来源、键、值、值范围、说明与翻译），覆盖全部 29 个插件配置字段、日常 Codex 注册表字段及目录翻译，可搜索。配置值和翻译可在表格中编辑；“注册表 JSON”和“配置 JSON”页签共用草稿，切换时不会丢失修改。类型、枚举、兼容规则在注册表 JSON 中编辑。配置保存到当前 profile；注册表规则写入 fields/overrides.json，翻译写入 i18n/zh-CN.user.json，仅记录相对内置表的修改，不复制完整官方参考快照。`null` 或删除字段表示清除该字段的 profile 覆盖，回落到代码默认值。弹窗按 Esc 或点击遮罩可关闭，有未保存修改时会确认。保存会先预检注册表与配置，再保存 profile 和注册表；本地文件被其他位置修改时拒绝覆盖。两处保存有一处失败时保留窗口和草稿，并报告已经保存的部分，允许修正重试。窄窗口在表格内部横向滚动，页签和保存按钮始终可见。既有显式 `backend=exec` 配置保持生效。

注册表编辑区域上方显示本地 Codex 版本，并提供“刷新注册表”按钮及最后更新时间；表格中增加对应只读行，注册表 JSON 根字段为 `codexVersion` 和 `updatedAt`。元数据取自版本匹配的本地 Schema 快照，未知时为 `null`，不能手动伪造。刷新强制重新发现字段定义，不启动模型回合；未保存的配置和翻译保持，未修改的规则更新为新发现值，刷新失败时保留最近成功的快照时间并报告错误。

插件内独立的 `lib/codex-registry.json` 集中保存日常字段定义、规则和默认翻译；外部获取失败且无匹配缓存时直接回退到此文件，不依赖完整官方参考文件。有效用户覆盖继续保留；用户文件无法读取或编辑服务不可达时，注册表暂为只读，配置 JSON 仍可编辑，错误会继续显示。刷新只更新外部缓存和覆盖，不改写插件内置文件。

本地开发更新 `lib/index.js` 或通信接口后，需要完整退出并重新启动 DSH；仅刷新设置页面会更新前端，但不会重新载入已缓存的后端模块。编辑器接口未注册时会报告 HTTP 404 并提示重启，不代表内置注册表文件不存在。`DSH_HOME` 可为 Windows 目录联接，注册表先固定其真实根目录，再检查内部文件路径。

“自动补全模型和思考强度”使用 `autoModelAndEffort`，默认 false，关闭时折叠相关选档设置。关闭后需显式提供 model 与 effort，或由 task_kind / 证据选档提供。

设置页的默认模型、默认推理强度、模型选档策略、强度自治上限、沙箱模式和审批策略直接显示具体默认值，下拉列表不设“默认”选项；JSON 中这些字段为空字符串或 null 时清除该层覆盖，按配置优先级继承。

### 意外中断与 DSH 交接

启动失败、驱动退出未写终态、连接故障、预算/超时中断、异常进程存活、空回复、未消费的排队消息和子任务失败均保留事实交给 DSH。同步返回丢失时，通知器在驱动退出且同步结果等待窗口（10 秒）结束后补发；原宿主已退出或有停止记录时无需等待。注册记录缺失/损坏也使用独立保存的原会话身份通知。存活驱动超过 120 秒没有心跳、元数据缺失或启动卡住时发出一次检查通知，不因为模型长时间没有输出而杀任务。

异常通知要求 DSH 检查后继续未完成目标，不受完成提醒开关关闭影响。通知按运行/回合/事件去重；服务调用有超时，单个服务请求不能永久阻塞其他运行。通知提交前持久化意图，返回不确定时按标记核对，不重复启动模型。宿主/定时服务不可用时保留注册和错误证据，服务恢复后继续处理；回执仅代表通知已提交，无法保证宿主已经执行提醒或 DSH 已完成任务。明确取消、人工中断、额度等待与已有后续任务仍遵守各自交接规则，避免重复执行。

### Codex 字段注册表

官方字段参考、本地版本协议定义、兼容规则和用户翻译分层维护。初始化检查本地版本并更新快照；失败回退缓存，运行时修改 overrides.json 可适配普通字段增删、别名、类型及枚举变化。前后端配置校验读取同一日常注册表，默认包含 14 项通用透传字段和 7 项专用控制字段；完整参考定义及协议索引留在缓存中。exec 与 App Server 保留参数类型。通过高级设置末尾的“编辑完整配置与注册表”按钮维护配置、字段规则及翻译。表格、注册表 JSON、配置 JSON 共用当前窗口草稿，点击保存后才写入相应文件；刷新注册表会独立更新原生参考缓存，不调用模型。字段覆盖位于 `<DSH_HOME>/codex-runner/fields/overrides.json`，中文翻译位于 `<DSH_HOME>/codex-runner/i18n/zh-CN.user.json`


## 卸载

使用 DSH 插件管理界面或 `dsh plugin --profile <profile> remove dsh-codex-runner` 卸载。DSH 0.2.1-rc.3 可能保留该插件的 profile 覆盖条目，并提示 entry not found。如需清除残留，关闭目标 profile，备份其 `cordis.patch.yml`，只删除 `id: dsh-codex-runner` 的覆盖条目，再执行 `--dump-config` 检查。插件不会自行删除用户设置或工作区中的运行记录
