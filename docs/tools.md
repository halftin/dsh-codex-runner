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
