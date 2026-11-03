# 工具与任务操作

[项目首页](../README.md) · [文档目录](README.md) · [English](tools.en.md)

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
| codex_capabilities | 查询精确运行的后端能力、限制及监督收件状态 |
| codex_stream | 按排他序号读取完整业务输出，不依赖调试日志 |
| codex_questions | 读取原请求、问题选项、生命周期及回答来源 |
| codex_answer | 按 interaction_id 向仍有效的原连接提交结构化答案 |

上述 19 个工具与 dsh.plugin.json 清单对应。Host 入口为 `./lib/index.js`，client 导出为 `./lib/client.js`；bundle 的包名、设置入口和 client 注册 ID 均为 `dsh-codex-runner`。

主动监督默认开启；原生 Agent inbox 可用时，`codex_run` 自动后台返回并标记 `supervision_active=true`，让 DSH 在任务期间接收新增输出。关闭监督后恢复显式 `detach` 的原行为。输出显示与模型监督使用独立游标；仅显示不会唤醒模型。详见[运行说明](runtime.md)。

```text
codex_capabilities(run_id="<UUID>")
codex_stream(run_id="<UUID>", after=0, limit=100)
codex_questions(run_id="<UUID>")
codex_answer(run_id="<UUID>", interaction_id="<interaction UUID>", response={"answers":{"<question ID>":{"answers":["选择或自由文本"]}}})
```

四个新工具严格限定当前会话与工作区。`codex_stream` 的大内容保留完整 JSON 资源，预览必须明确视为不完整。`codex_answer` 只回答已授权的任务选择，缺少用户信息时询问用户；权限审批不自动批准。问题 ID 必须原样复制自 `codex_questions`，包括异步问题的 JSON 字符串 ID。原生问题回复原 RPC；异步问题采用官方关联用户消息，投递到活动回合或同线程下一回合。`submitted` 表示完成投递，`submission` 区分原连接写入与活动/下一回合接收；不证明模型采用。`resolved` 仅用于服务端 RPC 结束。exec 不支持结构化问答。

```text
codex_run(prompt_file="task.md", label="smoke")                                              # 主开关关闭：默认档位
codex_run(prompt_file="task.md", label="smoke", model="<可用模型>", effort="<支持强度>")        # 开启主开关后
codex_run(prompt_file="task.md", label="long-task", detach=true)
codex_status(run_id="<返回的 UUID>", wait_ms=30000)
codex_say(run_id="<UUID>", message="追加说明")
codex_cancel(run_id="<UUID>")
codex_run(prompt_file="next.md", label="resume-task", continue_run_id="<previous_run_id>")
```

先通过 `codex_models()` 查询当前可用模型和强度。选档归属由设置里的「DSH 自主选模型与推理强度」决定：默认关闭时每次运行固定使用默认模型与默认推理强度，必须省略 model/effort（传了会被拒绝）；开启后由 DSH 按任务目标事前判断，新任务和续跑均显式提供 model 与 effort，只有预设策略不是关闭时才允许任务类型、证据或默认值补全。不要因 5H 额度、成本或等待时间擅自降档；不可用时报告或暂停。

每次运行都有唯一 run_id。label 可复用，但只表示该标签最新一次运行；需要准确定位时使用 run_id。label 仅允许 1–80 个 ASCII 字母、数字、下划线和连字符，以字母或数字开头，并排除 Windows 保留名称。

`codex_run` / `codex_status` 的 `ok` 只表示本轮执行结束。两者返回 `turn_status`、`process_status`、固定为 `unknown` 的 `task_state`，以及 `needs_dsh_decision` / `decision_reason`。正常完成仍需 DSH 读证据并验收；空回答标 `empty_answer`，子 agent 仍运行或状态未知标 `subagents_running`，不据此判断任务失败。`has_final_answer` 表示存在非空最终回答。codex_run / codex_status 完整返回最终回答原文，排除推理、工具输出和进度 commentary，不再按字符数截断或额外总结。后台通知保持有界。完整、脱敏后无需改写的短回答（不超过 500 字符），只有在回合匹配、进程已确认退出且无排队指令、未完成子任务或恢复流程时，才标记 answer_complete=true、requires_status_refresh=false，允许 DSH 直接验收；其他通知仍要求刷新状态，状态查询返回完整正文。通知延迟或与较新指令冲突时仍需刷新；通知预览或确实不完整的源数据通过 answer_truncated 标明，不能据此直接验收。工作过程可通过 codex_read 按需查询。

有 thread_id 且非用户取消时 `resumable=true`，包括正常 completed；DSH 可显式传入下一轮 prompt_file 和 resume_thread。`continuation_of` 仅记录前一 run_id 的审计关系，不触发续跑，也不限定下一轮方向。用户取消无需 DSH 决策；waiting_quota 返回 `automation=quota_resume`，保留现有额度恢复流程；其他情况默认 `automation=none`。插件不自动验收、continue 或 restart。

`handoff` 由代码按执行事实生成，包含 owner、action、dispatch 和 read_answer。仍在运行时 `await_run`；额度自动恢复时 `await_quota`；已有恢复后续运行时 `follow_successor` 并给出 run_id；用户停止时 `stopped`。孤儿或归属不明进程、未结束的子任务、异常额度恢复先交 DSH 核实，dispatch=blocked。正常结束提供结果复核入口（review_result），非预期中断提供恢复操作入口（recover_task），这些兼容字段不构成必须继续任务的指令，dispatch=after_review 表示通过原任务语义及授权检查后可以派发，不代表任务已完成。`resumable` 仅表示有线程可用，不代替 handoff 的执行约束。

任务正文按 DSH 提交的 prompt_file 原样发送，不拼接任务契约、工程纪律或选档说明，也不要求固定标题、Markdown/JSON 模板。DSH 根据用户指令决定任务目标、方法、验收、是否续跑及正文；插件通知仅解释执行状态、可用操作和授权边界，不要求持续推进、失败后调整方案或固定汇报格式。工具说明和通知仍进入 DSH 上下文，因此不承诺对生成过程完全没有影响。状态快照可能过期时用 codex_status，内容不全时用 codex_read。用户停止、额度等待及活动任务的防重复约束保留；同一 Codex thread 的并发续跑仍受 admission 锁保护。

默认同一工作目录只允许 1 个运行，防止并发修改同一工作树。同步与后台共用完整配置 JSON 中的 defaultBudgetMs，默认 0（不限时）；单次调用 budget_ms 优先，0 可显式关闭默认时限。正数时限到期由驱动停止运行并保留中断证据，交 DSH 评估续做。取消后应检查 git status/diff，插件不会自动回滚任务修改。

后台任务可以跨 DSH 重启，重新启动后用 run_id 查询或取消。先取消活动任务再卸载；卸载插件不会自动回滚工作目录，也不会自动终止刻意独立运行的后台进程。

## 新驱动、插话与会话读取

默认使用 App Server；驱动选择控件已隐藏，可在高级设置的“编辑完整配置与注册表”中修改 `backend`。不支持与自定义 driverPath 同时使用。新驱动会查询当前账号的模型能力，拒绝未列出的模型/强度或服务档组合；交互审批请求默认拒绝，不能把无人值守执行当作有人会点击批准。

`codex_say(run_id="<UUID>", action="steer", message="补充要求")` 将指令交给活动回合，不保证正在执行的外部命令立即停止。`action="interrupt"` 请求中断该回合；真正取消整个运行使用 codex_cancel。返回 accepted/requested 代表协议已接受，后续结果仍需通过 codex_status 确认。兼容 exec 模式只支持 queue。

`codex_read(run_id="<UUID>", source="answer|turns|summary|events", offset=0, limit=12000)` 返回有界文本。answer 优先读取该 run 对应 App Server turn_id 的最终 assistant 回答，不会读成同一线程后续运行的回答；原生不可用或没有 turn_id 时回退 meta.lastMessage，exec 仅用 meta。read_source/fallback_reason/answer_truncated 标明来源和截断。summary 只返回 turn_status、decision_reason、回答长度/截断、subagents 和 quota，不读原生 thread、不返回回答。events 默认拒绝；只有当前 debugLogs=true 且该 run 启动时也启用了 debug 才能读。answer/events 使用字符偏移，可继续读取；turns 先完成当前页的字符分页，再使用 next_cursor 取下一页。活动回合内容可能变化。文件路径和原生线程 cwd 都校验工作区范围；不扫描其他工作区历史。日志被截断时会报告 truncated，不能把截断内容当成完整执行证据。


例外属于已启用功能的运行协议：额度告警/恢复触发时会向 Codex 追加保存检查点并暂停的消息；异步问答答案会包装原问题关联信息。这些消息不是初始任务正文模板。关闭选档策略不会关闭上述独立功能。事前按任务选档及不因额度擅自降档的用户要求仍保留在工具说明中；代码保证不自动换档及拒绝明确的非任务降档类别，不能判定模型隐藏的动机。


## 继续原会话与逐回合换档

run_id 标识一次执行，thread_id 标识持久的 Codex 会话。使用 `codex_run(continue_run_id="<上一 run_id>", prompt_file="next.md", label="next-step")`，插件自动解析原线程并记录 continuation_of。它适用于正常追问，不限于中断恢复。每次生成新的 run_id，但 thread_id 保持相同；自主选档关闭时省略 model/effort，使用配置默认值；开启时显式提供本轮选档，换档不要求另开会话。

continue_run_id 不得与 resume_thread 或 continuation_of 同用。源运行必须属于当前工作区和 DSH 会话，后端与配置相同；活动中、状态未确定、已停止或额度阻塞时拒绝，不偷偷新建线程。原 resume_thread 入口继续兼容。不提供两种继续选择器时才新建独立线程。是否复用由 DSH 根据用户任务语义决定，插件不自动归组，也不强制拆分。

返回 thread_action=created|continued，摘要显示 conversation=，区分新运行和新会话。活动期间 codex_say 仍按当前档位排队/插话，不支持换档；回合结束后用 codex_run 继续并选择新档位。进程重启不等于会话历史丢失，保留历史也不等于缓存必然命中。


### 可选官方宿主管理

`codex_run` 新增可选布尔参数 `host_managed`，默认 false。true 使用官方 subagent 服务的注册、激活准入、结果收集和显式清理；仍使用原工具入口、原 prompt_file、选档规则和输出卡片。必须有当前存活 DSH Agent 和 subagents 服务；不可用时直接报错，不静默回退或另起任务。

这是生命周期选择：宿主正常关闭、插件卸载或官方显式中断会取消受管理运行；默认后台模式不变，仍可跨宿主重启。它不是 profile 设置，不透传给 Codex。再次续跑可继续传 host_managed=true，每轮有新的 run_id/官方子任务 ID，Codex thread_id 可以相同。

完成通知继续由插件负责，官方 delivery 固定 caller。`codex_status` / `codex_list` 返回 host_subagent 身份和收集状态；catalog=plugin、native_catalog=false 明确表示不是官方原生侧栏目录。原生目录与官方完成通知耦合，本轮未接入。崩溃后的官方 activation 恢复及额度自动恢复后继的管理继承未实现，手动新运行应明确传参。


`codex_stream.after` 是排他的输出事件序号。要读取摘要 `seq=N` 对应的完整事件，使用 `after=N-1, limit=1`。独立展示记录的 `outputSeq` 就是该源序号，宿主聊天记录的 `seq` 则是另一套排序编号。大事件引用完整 JSON 资源，摘要不能视为完整输出。
