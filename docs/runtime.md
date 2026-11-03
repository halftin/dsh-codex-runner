# 运行、额度与故障处理

[项目首页](../README.md) · [文档目录](README.md) · [English](runtime.en.md)

## 实时输出、问答与主动监督

默认开启的 JSON 配置 `autoAnswerQuestions` 独立控制自动问答。关闭监督时只投递 `codex-runner-questions` 通知，不带普通输出、不推进输出读取游标；开启监督时合并为一次通知，避免重复唤醒。问题处理属于正常任务交互用量，不是持续监督，也不代表零模型调用。与中断同时出现时，终态检查优先；未消费的问题通知撤回，已消费的通知不能撤回但旧回答会被拒绝。中断通知提醒 DSH 重新检查问题与运行状态，不自动重发答案或恢复用户取消的运行。手动回答入口不受自动问答设置影响。

两个开关默认均开启。独立聊天节点在每个 item 完成时追加；出现首条独立记录后，聚合节点停止展示正文。能力缺失时回退聚合展示：exec 提供已完成的消息项，App Server 支持 delta。展示节点只读取保存的输出，不写入模型上下文或调用模型；页面重开从头补读，关闭显示清空普通输出。HTML 和未知结构采用安全文本回退，不执行源脚本；长内容明确标为预览并提供完整资源下载。

采集独立于 `debugLogs`，运行目录新增 `output.jsonl`、提交完整行的 `output.idx`、`output-state.json`，大参数保存为 `output-<sequence>.json`。这些是业务历史，按运行保留策略处理，关闭显示或监督不会删除。`interactions.json` 保存原请求、连接身份和状态；`supervision-state.json` 保存监督投递与请求收件证据。显示游标在各卡片内独立维护。

主动监督使用原 DSH Agent：普通事件以 1.5 秒窗口合并、同会话普通投递至少间隔 5 秒，问题和异常优先。原始 delta 只推进读取游标，不触发模型通知；item 快照等里程碑以有界摘要投递。命令输出不超过 520 个 UTF-16 代码单元时完整保留，超过时保留前 320 和后 200 并标记 truncated；outputBytes 为原文的 UTF-8 字节数。开启时新任务自动后台返回，避免原工具阻塞决策。批次进入实际 Agent 模型请求才推进 `modelCursor`；这表示请求包含该输入，不证明模型理解或采用。关闭时撤回未消费的 inbox 输入，无法撤回的输入保留诊断；重启后不确定的投递禁止自动重放。原请求已经断开不能用保存的数据恢复响应。

普通任务选择可在已有授权内由 DSH 回答，缺少信息时交给用户。原生问答入口不受两个开关影响；重复或迟到答案拒绝，首个有效提交获准。权限审批和不支持的请求不会自动批准。DSH 0.2.1-rc.3 的问答契约和原生输入组件没有保密输入支持；`isSecret` 请求不送入普通输入框，保留明确诊断。

App Server 的原生 `request_user_input` 继续使用原 RPC 回答；`request_user_input_async` 的 `agentMessage.questions` 则使用官方 `send_user_message_question_reply` 用户消息格式，关联原 itemId 和问题下标。活动回合通过 `turn/steer` 投递，回合正常结束后通过同线程 `turn/start` 投递，不向已返回 accepted 的工具调用伪造第二个结果。Codex 0.160.1 和 0.165.0 的两种投递均已由真实模型采用随机答案验证。待答异步问题跨正常回合保留，驱动保持连接并显示 `awaiting_async_answers`；回答、用户取消、运行取消、预算截止或连接失败后按实际状态处理。不确定投递禁止重放，连接断开或宿主重启后问题失效。取消问题只关闭本地待答状态，不发送虚构答案。exec 问答仍不支持。无需新增配置项，也未改变用户 Codex 配置。

真实浏览器已验证 Markdown/代码文本、图片/音频/文件元数据、未知组件的安全文本回退，以及长中文完整 JSON 下载和字节一致性。用户已确认特殊内容的交付标准：媒体将 Codex 实际提供的文件位置/资源引用和元数据传给 DSH，无需播放；交互组件将 HTML 源码作为数据传给 DSH，无需执行组件。按此范围，两项交付缺口已解决。完整参数超出预览时保存在任务资源目录，DSH 可继续读取；仅收到位置不代表已读取媒体字节，也不保证外部 URL 可访问。保密问题输入仍是单独的宿主限制。

已验证环境为 Windows、DSH 0.2.1-rc.3、Codex 0.160.1。真实宿主中的确定性模型适配器已验证监督问答与控制；真实 Codex 已验证两后端输出及插话、排队和打断效果。真实 DSH `deepseek-account/deepseek-flash` 已在受控场景中完成原请求回答及后续转向（模拟 Codex），并在两端真实模型的测试中读取 Codex 中间输出、转向原任务且改变最终答案。追加真实双模型异步问答验收已通过：DSH 模型回答后，Codex 在同线程下一回合准确采用唯一答案；活动回合投递另由真实 Codex 加测试回答器验证。Agents Anywhere bridge-next 2.0.2 可接原生问答，但没有投影本插件自定义卡片增量的通路；2026-11-02 按用户要求，手机远程支持（显示、资源同步与回答回传）已从待办及验收条件移除，本轮按现有交付范围标记完成。此为范围结项，不新增手机实测通过的声明。

## 额度恢复（默认关闭）

设置页的“额度恢复后自动继续”对应 `autoResumeAfterQuota`。开启需要 App Server、DSH Schedule 和 StorageDomain、可恢复的原 DSH 会话，以及能通过 CLI 查询额度的 ChatGPT 登录。插件没有捆绑这些宿主服务或登录凭据；缺少时拒绝启动自动恢复任务。

当相关账户额度窗口使用量达到 95%，驱动请求 Codex 保存检查点并结束当前轮。暂停等待 `pauseGraceMs` 默认 0，表示不限等待；设为正数时，等待一轮后再催促一次，再等一轮仍未结束则请求强制中断，并记录没有确认检查点。进程终止不等于任务保存成功。多个窗口同时受限时取最晚恢复时间，再加 180 秒。驱动退出，释放工作区执行槽位；DSH 将固定的恢复检查指令投递到原会话。

如果两次轮询之间先收到协议明确的 usageLimitExceeded，立即重新查询额度；只有新的受限读数和有效恢复时间才允许自动排期。普通 rateLimitExceeded 不直接等同订阅额度耗尽。暂停过程中运行预算先到期时，仍保留额度等待状态，并标明检查点未确认。

到点必须再次核对额度及账号指纹：仍受限则重排；恢复时间未知、账号不可核验或变化、调度写入失败时报告 needs_attention。恢复沿用原 Codex thread，并带回暂停前已接受但未消费的排队消息。DSH 模型需要实际调用 codex_quota_resume，且 DSH 自身模型服务须可用；定时消息送达不等于任务已恢复。codex_status 的 recovery 分别报告排期、后续 run_id 和失败原因。

关闭开关会作废待恢复记录并删除对应提醒；取消旧 run_id 会沿恢复链请求取消后续运行。重复或过期提醒不会重复派发。工作区繁忙时每 5 分钟有界重试，最多 12 次，之后需要处理。DSH 关闭期间不执行；重启后由宿主持久化定时服务处理逾期任务。不会注册系统开机任务，也不会自动唤醒 Codex 桌面版中的开发聊天。卸载前应关闭该功能并取消等待任务；已投递的旧提醒即使残留，也无法通过已作废的恢复检查。

自动恢复沿用暂停任务已保存的模型与推理强度，不受等待期间默认档位变化影响；返回的 `model_source`、`effort_source` 为 `recovery`。这是内部恢复通道，不允许普通工具调用绕过自主选档开关。恢复仍校验当前模型目录、强度上限及生效的选档策略，并使用当前沙箱和审批设置。原档位缺失、不可用或不符合当前限制时进入 `needs_attention`，不自动换档；证据策略使用原运行保存的声明与阶段，缺少所需证据时停止恢复。

## 低额度暂停（默认关闭）

“低额度提醒”开关与阈值滑块位于“额度恢复后自动继续”上方，两个开关互不影响。提醒关闭时仅禁用该行阈值滑块（0–20%，默认 5%）。

剩余额度达到提醒阈值时，App Server 向当前活动回合发送一次中文指令，要求保存进度并暂停。提醒本身不创建恢复排期；未开启自动继续时保持暂停，等待用户手动续跑。此功能需要可读取的账号额度，不需要 DSH Schedule/storage。运行 meta 的 `warning` 记录阈值、剩余额度和消息投递状态。

只有 `autoResumeAfterQuota=true` 才启用自动恢复流程，并要求 DSH Schedule/storage。单独开启自动继续时仍使用原有的额度耗尽判定；同时开启提醒时，也可在提醒触发的暂停后安排恢复；关闭自动继续后，即使提醒仍开启，也会作废待恢复排期。

## 数据与故障处理

运行文件位于 `<cwd>/.codex-runner/logs/runs/<run_id>/`：run.json、result.meta.json、result.hb.json、terminal.json、selection.json、pending-messages.json 等固定元数据。两种驱动的 meta.lastMessage 保存完整最终回答，不保留推理或进度正文；answerLength 保存字符数，不再设置 20000 字符保存上限。后台通知的 answer_preview 有界，完整正文由状态查询提供。默认均不产生 events.jsonl、answer.txt、result.err.log、result.jsonl。失败的 meta 保存脱敏 error/error_class/stderr_tail（最多 2048 UTF-8 字节）及 termination。

“记录调试事件”与容量上限合并为一行；容量以 MiB 编辑并提供预设，关闭开关时禁用容量控件但保留其值，恢复默认同时重置两项。JSON 中 debugMaxBytes 仍使用字节。debugLogs=true 仅为之后启动的 run 写 events.jsonl，debugMaxBytes 默认 2 MiB，达到上限即停止，省略 assistant 消息文本和 delta，不写完整 answer。通知器仅读 meta.error/meta.stderr_tail，不读旧日志或 debug。已登记工作区在插件加载、每天和新 run 前执行清理：安全终态 run 先删 debug/旧 bulk 日志，固定元数据按每个工作区 retentionDays 和 retentionMaxRuns 处理，两项默认均为 0，运行历史随工作区保留；0 天禁用按时间清理，0 条不设数量上限，超出任一限制后才检查是否可安全删除。无终态、任一执行 PID 存活、含符号链接/子目录、未解决 recovery 均保留；不清理 Codex 自有数据。未解决 quota 超过 30 天在 recovery 状态返回 retention_warning，须检查并显式取消后才能清理。默认兼容模式不因历史额度快照阻止新任务；开启自动恢复时，App Server 使用新鲜额度进行启动前检查和活动轮暂停。

未解决的额度等待和 needs_attention 记录保留，避免清理掉续跑证据；恢复链已结束或明确取消后，运行文件可以按通常保留策略清理。宿主中的 completed/cancelled 恢复索引保留 30 天，之后移除；未解决索引不会自动过期。数据目录、logs、runs 及具体运行目录不得使用重定向链接；工作区本身可以通过链接访问。此检查防止误配置和预先存在的目录重定向，不承诺抵御同一用户权限下并发替换文件的恶意进程。

旧 bulk 日志不做读取兼容或迁移；安全终态 run 的旧文件直接清理。异常消失的 driver 可能留下孤儿进程；插件会报告，需先核实归属再人工处理，避免 PID 复用误杀。

## 可靠性与长思考保护

| 工具 | 用途 |
| --- | --- |
| `codex_release` | `run_id` + `confirm=true` 仅释放 stale/orphan 的 admission 占用，不杀进程、不删除记录。 |

状态查询保留最后输出、事件和心跳时间等客观信息；不因长时间无输出标记“疑似停滞”、判定失败或中断任务。进程退出、连接故障、启动异常及心跳丢失仍由运行健康检测处理，并通知 DSH 判断后续行动。
额度暂停默认 `pauseGraceMs=0`，等待检查点与回合结束。设置页将“额度暂停等待”显示为单行，以秒编辑，提供 0/30/60/120/300 秒预设和自定义输入；JSON 中仍以毫秒保存，支持精确到 1 毫秒的秒数输入。显式设置非零值后，先等待一个间隔，再次催促保存进度，再等待一个间隔，仍未结束才请求 interrupt 并记录无确认强制中断。
显式 budget 仍是预算；无限期 detached 任务使用 `budget_ms=0`。
无终态记录不会按年龄删除；进程归属未知时保守保留占用。
`codex_config` 仅查询配置。策略、安全设置及其他持久化修改统一通过 profile 设置页或完整配置 JSON 编辑器保存。
关闭策略不改变已经运行中的任务。

## 动态模型目录

| 工具 | 用途 |
| --- | --- |
| `codex_models` | 只读列出模型、effort、service tier、默认值、来源和 freshness；可 refresh/include_hidden，不启动模型 turn。 |

目录在插件加载时异步刷新，首次 run 和 doctor 也会刷新。缓存位于 `$DSH_HOME/codex-runner/cache/model-catalog.json`，按 CLI 路径/版本、CODEX_HOME、账号身份隔离，有效期 24 小时。离线回退缓存或随包四模型目录，并明确标 stale。旧 fast 映射 priority；off 不传 tier。
`codexRunner` 服务通过宿主认证的 Connection 通道提供目录、额度和状态查询；新增 getEditorRegistry/saveEditorRegistry 仅供用户编辑窗口读取、预检和保存固定位置的注册表与翻译文件，不接受任意路径。插件 profile 配置仍由 DSH configForms 保存，不通过该通道写入。宿主缺少 Connection 时工具与 fallback 仍可用。

## 额度与诊断

| 工具 | 用途 |
| --- | --- |
| `codex_quota` | probe=none/fresh/active/both，返回账号级 5h/7d、采样时间、来源、warning、recovery 和探针延迟/错误。 |
| `codex_diagnose` | 汇总 driver/hb、事件、turn、只读进程树和额度证据；默认不 steer、不 kill、不重启。probe=true 才显式 steer，并标 intrusive。 |

fresh 只调用 account/read 和 account/rateLimits/read，不启动模型 turn；最多三分钟一次，refresh 不能绕过限频。失败保留最近数据并标 stale、账号面不可达；成功不代表推理链路正常。exec 只读最近 run，标 last-known/stale。codex_status 增加 quota_source/quota_sampled_at。
顶部额度条与工具共用数据源，显示账号级范围、剩余、重置、阈值和恢复。页面打开/手动刷新/终态事件时拉取；不做后台轮询或历史曲线。终态无内容事件通过现有 Connection 的认证只读 Fetch 路由送达，仅页面打开时订阅；事件通道不可用时保留手动刷新。主机用 fs.watch 观察自己启动的 run，卸载时关闭 watcher/stream。

## 原生 subagent 与高级设置

子 agent 的启用、会话线程上限及默认模型/强度完全继承 Codex，插件不提供对应控件或默认透传规则，也不代替模型拆分、调度子任务。子任务状态跟踪和 DSH 验收交接继续保留。独立的消息记录字段 agents.interrupt_message 仍只在完整配置 JSON 中提供，类型为布尔值；true/false 控制 Codex 是否记录模型可见的中断消息，省略或 null 清除该层覆盖并继承 Codex 配置。它不影响插件向 DSH 发送中断通知。
状态解析 CollabAgentToolCall/SubAgentActivity 及兼容命名，按子线程去重，codex_status.subagents 返回 count/running/completed/failed/unknown 和最多 32 条摘要，不收录子消息内容。仅父工具调用完成不能证明子 agent 完成；未知状态明确标 unknown。跟踪最多 512 个子身份，超过时标 truncated。
共享只读服务可 getSubagents(runId)；codex_read(turns) 保留原始 items，codex_sessions 仍只列插件父 run。插件不执行 spawn/fan-out；子任务的分工和并行策略由 Codex 自行决定。
高级设置补齐 maxConcurrent、retentionDays、retentionMaxRuns、debugLogs、debugMaxBytes、pauseGraceMs；运行时限 defaultBudgetMs 仅在完整配置 JSON 中提供。pauseGraceMs 默认 0，非零可能强制中断。

## 运行异常与完成决策提醒

插件管理的 detach run 每次 turn/completed 都产生 reply 信号，包括同一 run 的多个 turn；failed、spawn-error、killed、needs_attention、orphan/stale、非用户 interrupted/aborted，以及 waiting_quota/quota-blocked 也可见。用户取消/显式 interrupt 和单纯思考不发信号。同步 run 的工具结果就是信号，即使指定 always 也不重复发会话消息。直接 `codex exec/resume` 没有插件登记，不在范围内。

单次 `codex_run` 参数 `notify_on_complete=off|decision|always` 只控制额外唤醒：detach 默认 decision、sync 默认 off。off 不抑制可见信号；decision 仅在 needs_dsh_decision=true 时额外唤醒；always 对非用户取消回复/终态唤醒。支持被动会话投递的宿主适配器优先发送被动消息；当前插件接入的宿主服务为 schedule，因此以一次提醒同时承担可见性与按需唤醒，不创建第二条提醒。这种 fallback 有 DSH token 成本。

信号包含 run_id/标签、turn_id、turn_status、needs_dsh_decision、decision_reason、handoff、has_final_answer、最多 500 字的脱敏 answer 摘要、thread_id、quota（含恢复时间）；终态附有界错误摘要。handoff 提供状态与可用操作，不指示 DSH 必须持续推进或修复；是否继续、如何处理结果由用户指令决定，回合结束不等同于任务完成。宿主每 3 秒检查已登记 run，卸载停止，重新加载恢复；驱动已退出但 meta 仍写 running 时也按存活证据上报异常。离线或投递服务不可用时不能保证立即送达。

插件私有 `$DSH_HOME/codex-runner/notifier-runs/` 保存精确 run 指针，不使用 DSH storages；notified.json 保存 turn 回复序号游标和终态键，按 (run_id, turn_id, kind) 去重，连续失败的不同 turn 分别投递。meta 最多保留 64 条待投递回复摘要，已确认条目回收；积压满时停止派发已排队 turn 并进入 needs_attention，避免丢回复或无限增长。同步结果的 reply_signals 包含本轮摘要。notify-intent.json 在投递前写入；不确定的投递仅对账，不重复 create。失败写 notify-error.json，codex_status 暴露 notification 状态；未提交的后台回复和通知错误保留证据，不重放 Codex 工作。submitted 仅表示宿主接受通知，不表示 DSH 已执行或验收。

`statusPollingEnabled=false` 默认关闭主动查询；用户开启后，`statusPollingIntervalMinutes=30`（整数 15–120）决定查询间隔。只为仍活跃且原会话可投递的 run 建一次性 schedule；同会话多 run 合并，结束/暂停/关闭设置后删除。每到一次间隔唤醒 DSH 查询并简短报告；若查询时发现已结束或异常，则沿用同一 handoff 规则处理，不重复活动任务。开启才产生主动查询的模型 token 成本；它不能替代每次回复信号。私有 status-polling 目录保存指针和调度意图，重启对账，保持每会话最多一条待执行查询；多工作区间隔不同时取最短值。

“编辑完整配置与注册表”窗口默认显示五列表格（来源、键、值、值范围、说明与翻译），覆盖全部 31 个插件配置字段、日常 Codex 注册表字段及目录翻译，可搜索。配置值和翻译可在表格中编辑；“注册表 JSON”和“配置 JSON”页签共用草稿，切换时不会丢失修改。类型、枚举、兼容规则在注册表 JSON 中编辑。配置保存到当前 profile；注册表规则写入 fields/overrides.json，翻译写入 i18n/zh-CN.user.json，仅记录相对内置表的修改，不复制完整官方参考快照。`null` 或删除字段表示清除该字段的 profile 覆盖，回落到代码默认值。弹窗按 Esc 或点击遮罩可关闭，有未保存修改时会确认。保存会先预检注册表与配置，再保存 profile 和注册表；本地文件被其他位置修改时拒绝覆盖。两处保存有一处失败时保留窗口和草稿，并报告已经保存的部分，允许修正重试。窄窗口在表格内部横向滚动，页签和保存按钮始终可见。既有显式 `backend=exec` 配置保持生效。

注册表编辑区域上方显示本地 Codex 版本，并提供“刷新注册表”按钮及最后更新时间；表格中增加对应只读行，注册表 JSON 根字段为 `codexVersion` 和 `updatedAt`。元数据取自版本匹配的本地 Schema 快照，未知时为 `null`，不能手动伪造。刷新强制重新发现字段定义，不启动模型回合；未保存的配置和翻译保持，未修改的规则更新为新发现值，刷新失败时保留最近成功的快照时间并报告错误。

插件内独立的 `lib/codex-registry.json` 集中保存日常字段定义、规则和默认翻译；外部获取失败且无匹配缓存时直接回退到此文件，不依赖完整官方参考文件。有效用户覆盖继续保留；用户文件无法读取或编辑服务不可达时，注册表暂为只读，配置 JSON 仍可编辑，错误会继续显示。刷新只更新外部缓存和覆盖，不改写插件内置文件。

本地开发更新 `lib/index.js` 或通信接口后，需要完整退出并重新启动 DSH；仅刷新设置页面会更新前端，但不会重新载入已缓存的后端模块。编辑器接口未注册时会报告 HTTP 404 并提示重启，不代表内置注册表文件不存在。`DSH_HOME` 可为 Windows 目录联接，注册表先固定其真实根目录，再检查内部文件路径。

「DSH 自主选模型与推理强度」（`autoModelAndEffort`）默认 false：每次运行固定使用 `defaultModel`/`defaultEffort`，DSH 不参与选档，传入 model/effort 会被拒绝，预设策略整体不参与运行。开启后由 DSH 按任务目标事前明确选择 model 与 effort；`selectionPolicy.mode=off` 时不套用 task_kind、证据或默认档位，audit/enforce 才启用策略，且策略控件随主开关与策略模式显示或隐藏。额度、等待或成本不能触发擅自降档。

设置页的默认模型、默认推理强度、模型选档策略、强度自治上限、沙箱模式和审批策略直接显示具体默认值，下拉列表不设“默认”选项；JSON 中这些字段为空字符串或 null 时清除该层覆盖，按配置优先级继承。

## 意外中断与 DSH 交接

启动失败、驱动退出未写终态、连接故障、预算/超时中断、异常进程存活、空回复、未消费的排队消息和子任务失败均保留事实交给 DSH。同步返回丢失时，通知器在驱动退出且同步结果等待窗口（10 秒）结束后补发；原宿主已退出或有停止记录时无需等待。注册记录缺失/损坏也使用独立保存的原会话身份通知。存活驱动超过 120 秒没有心跳、元数据缺失或启动卡住时发出一次检查通知，不因为模型长时间没有输出而杀任务。

异常通知提供事实，由 DSH 依用户指令判断后续动作，不受完成提醒开关关闭影响。通知按运行/回合/事件去重；服务调用有超时，单个服务请求不能永久阻塞其他运行。通知提交前持久化意图，返回不确定时按标记核对，不重复启动模型。宿主/定时服务不可用时保留注册和错误证据，服务恢复后继续处理；回执仅代表通知已提交，无法保证宿主已经执行提醒或 DSH 已完成任务。明确取消、人工中断、额度等待与已有后续任务仍遵守各自交接规则，避免重复执行。


通知器在投递前与监督器按 run_id 协调：真正终态先撤回尚未消费的监督/问答输入，再投递可靠的结果或异常通知。普通回合通知遇到尚未消费的有效问答/监督批次时暂缓，并暂停该运行的新增批次，让已有输入先进入模型请求；通知投递后恢复批次。结束事实附带 delivery_context（输出读取游标、先前输入状态），不把投递回执视为模型已理解或已处理。已经消费或投递不确定的输入无法撤回，结束通知仍保留；因此不保证只有一次模型调用。通知原有持久意图、事件标记去重和不确定投递不重试规则保持不变。


可选 host_managed=true 使用 provider `codex-runner`、官方 caller delivery 与一次性私有参数绑定；不把 Codex model/effort 冒充为 DSH AgentOptions。工作区锁与原运行身份校验仍由插件负责，官方并发池额外约束激活树。运行目录新增 host-subagent.json，run.json 保存官方身份映射；这些是历史回执，不证明重启后 activation 仍存在。停止期间直接使用插件内部状态/取消能力，不依赖可能已卸载的 tools 注册表，等待启动中取消及已发布运行清理。实际驱动和进程树清理仍由插件执行。原生目录、官方完成通知替换与崩溃恢复不在本轮实现范围。

## 每个 Codex item 的独立展示记录

宿主插件进程中的 `lib/session-records.js` 每秒增量读取各 run 的 `output.jsonl`/`output.idx`。`agentMessage`、`commandExecution`、`fileChange` 在 `item/completed` 时各追加一条固定类型 `plugin:codex-runner/item` 记录；兼容 exec 的 `item.completed` 和 snake_case item 类型。不追加 delta 或未知类型。此服务由 `lib/index.js` 启停，独立于监督、问答、Schedule 和 driver 子进程；`supervisionEnabled=false` 不影响展示。运行结束后排空已提交输出再停止扫描，卸载等待正在进行的投递结束。

仅使用动态 `import('@deepseek-ai/dsh-session')` 并检查 `typeof appendPluginRecord === 'function'`，不依赖安装路径。会话通过 `agents.get(sessionId).session` 或 `sessions.get(sessionId)` 取得，并核对会话 ID、工作目录。包或函数不可用时写入运行目录的 `session-records-diagnostic.json`，保留原单节点展示。该 API 追加的是 `ignorable: true` 的非 surface 记录，不写 user/assistant 消息，不进入模型请求或 compaction；展示代码不调用模型，也不改变监督逻辑。宿主 API 属于实验接口，后续版本仍需能力探测。

记录 data 的格式如下（宿主另行赋予真实 `seq`）：

```json
{
  "version": 2,
  "runId": "当前运行 UUID",
  "callId": "原 codex_run 调用 ID",
  "sessionId": "原 DSH 会话 ID",
  "outputSeq": 12,
  "itemId": "item ID",
  "threadId": "Codex thread ID",
  "turnId": "Codex turn ID",
  "type": "agentMessage",
  "completedAt": "output 记录的接收时间",
  "text": "最多 8 KiB UTF-8 正文预览",
  "truncated": false
}
```

命令另带至多 1 KiB 的 `command`、可用时的 `exitCode`；文件变更另带至多 1 KiB 的 `paths` 摘要。操作类始终提供读取完整内容的入口，保留源记录中未投影的字段。长文本在 UTF-8 字符边界截断。客户端点击「读取完整内容」后按 `outputSeq` 调用 `getOutput`，大资源继续通过 `getOutputResource` 分块读取；所有请求仍校验 sessionId/callId，并额外核对 runId。完整输出保存在运行目录，不写入会话日志。

`session-records.json` 保存 version、runId/callId/sessionId、已处理的 output `cursor`、已确认记录数 `count`、`lastRecordSeq` 和投递中的 `pending.outputSeq`。每个 run 使用独立锁：先持久化 pending，再 append，等待 `sessions.flush(session)`，最后原子保存游标。若在 append 与保存游标之间崩溃，恢复时通过会话 `snapshotEvents()` 对账相同三项身份和 outputSeq；已存在的记录只确认游标，未存在的才重新追加。缺少对账 API、游标损坏或 flush 失败时保留诊断和 pending，不盲目重复追加；恢复后的正常扫描会重试对账。`snapshotEvents()` 是当前宿主仍提供但已标记 deprecated 的接口，此处仅在未确认投递恢复时使用。首次加载扫描现有 sessions/agents；会话恢复的 `session/created` 与新 run 登记均能重建 tailer，无需监督 watcher。

客户端注册独立的 `codex-runner-item` Definition，仅按固定事件类型匹配，以真实 seq 为锚点、沿用宿主的回合分组，自然与 DSH 消息交错；正文和折叠操作复用原 `CodexOutputItem`。刷新通过记录重建节点。共享订阅按 sessionId/callId 保存已有记录的 runId，重放和 `getOutput.item_records` 都可通知聚合卡片隐藏正文并停止聚合轮询，避免同一内容出现两遍。节点卸载不会清除去重标记。缺少客户端 Conversation registry 时仍显示聚合卡片。多个 run 即使续用同一 Codex thread，也拥有各自 runId/callId、游标和节点。

`streamOutputEnabled=false` 时不追加记录、不推进游标、不显示已有 item；重新开启后追上积压。客户端共享宿主已保存设置的订阅，不再逐个 run 每秒检查显示开关；首次身份检查完成前以及检查失败时隐藏记录正文。积压恢复时按追加时的真实 seq 排序，不把节点回插到离线期间的历史时间；每轮每个 run 最多处理 100 个输出事件。未完成 item 在首条独立记录出现后等待完成才展示。输出目录已被保留策略清除或原会话工作目录不可用时，按需读取和显示授权检查不可用，节点暂时隐藏，记录本身仍由宿主保存。

2026-11-02 收尾回归：Node 24.22.2，`npm run verify` **41/41 通过**。修复命令摘要在 321～520 个代码单元范围丢失尾部却未标截断的问题，补充两种后端的边界及 UTF-8 字节数验证。通知协调与问答通知测试已对齐“delta 不触发监督、完成快照触发摘要”的契约，保留撤回、去重及不确定投递检查。本次为离线回归，不新增真实模型、Electron 交互、重启持久化或手机验收结论。

离线验证：`node scripts/test-session-records.mjs` 覆盖构造/字节截断、重启和投递窗口对账、并发锁、终态排空、关闭/恢复、能力缺失回退；`node scripts/test-item-record-display.mjs` 覆盖 seq、重放、身份隔离、订阅去重、共享读取与节点选择。`node scripts/probe-session-records.mjs <已有 npm 宿主目录>` 只加载本地宿主包，在 detached Session 中验证 API、ignorable、非 surface、重放及模型消息不变；不安装、不启动 Agent、不写真实会话。已在本地已有 0.2.1-rc.3 包验证该探针，模型调用为 0。此结果不等同于 Electron UI、手机同步或真实宿主持久化验收。2026-11-02 保存的 `.capture/look-final.png` 可见桌面中的 Codex 正文、折叠命令与最终回答，作为展示效果证据；单张截图不能证明重启持久化、跨设备同步或完整交互验收。


## 面向模型的文本

工具说明、监督通知、问答通知和结果交接只描述当前操作，保留授权、审批及运行归属边界。读取摘要序号 N 对应的完整事件时使用 `codex_stream(after=N-1, limit=1)`。续跑时只有自主选档开启才传入 model/effort，关闭时省略。发行记录和使用文档不会自动注入模型提示词。

### 展示变化通知与共享读取

同一运行的聚合展示共享一个读取器和排他游标，独立 item 共享身份/状态检查。显示设置使用宿主订阅；SSE 只通知输出或记录确认变化，不传输正文。首次读取、重连、窗口重新获得焦点时校准，随后按游标补读；多个通知合并处理。带 runId 的输出和资源请求直接定位记录，仍核对 sessionId/callId；旧记录缺少 runId 时才使用兼容查询。

终态先排空剩余输出再停止定时查询。活动运行在事件连接正常时每 30 秒补偿检查，事件不可用时每 5 秒检查；请求失败从 5 秒退避至最多 60 秒。设置关闭时暂停查询，开启后恢复读取；断线重连重新校准已挂载记录。多个展示消费者共享一个事件连接，最后一个消费者卸载时释放订阅。

`npm run log -- scripts/test-output-subscriptions.mjs` 验证精确查询成本、共享游标、终态排空、设置切换、过期响应、重连补读、失败退避与事件通知。输出采集、独立聊天记录写入和 DSH 模型监督通知保持原有链路。
