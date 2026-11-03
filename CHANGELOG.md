# Changelog

## 0.5.3-beta — 2026-11-03（预发行版）

- Codex 已完成的正文、命令和文件修改以独立聊天记录展示，保留 `codex：` 来源标识、折叠操作和按需读取完整内容；聚合卡片去重，宿主能力缺失时回退。
- 增加展示游标、持久化确认、崩溃窗口对账及多运行身份隔离；关闭显示暂停投递，恢复后追赶积压。
- 明确自主选档主开关：默认固定使用设置档位；开启后才接受模型/强度参数，预设策略从属于主开关。
- 修复默认关闭自主选档时额度自动恢复被拒绝的问题；内部恢复保留原档位并校验当前限制，补充协调器接入真实工具入口的离线回归。
- 输出按 runId 精确定位；客户端共享设置订阅、事件连接和运行游标，终态排空后停止查询，重连补读并对失败请求退避。变化通知不携带消息正文，原消息转发链路保持独立。
- 开发日志统一归档到源码目录 logs/；常用验证命令同时保留终端输出和独立日志，不改变工作区运行数据路径。
- 监督使用有界摘要并过滤原始增量；修复中等长度命令输出截断标记与 UTF-8 字节统计。
- 精简面向模型的重复说明，修正续跑选档条件和排他游标用法，保留授权、问答失效和避免重复执行的边界。
- 更新中英文运行、配置、工具及 API 文档；输出接口补充可选 runId 校验和 item_records 返回标志。
- 手机远程支持按用户要求移出交付范围并结项，不作为待办或发布阻塞。
- 2026-11-03：当前源码在 Node 24.22.2 下离线回归 43/43 通过，含 12 项额度恢复入口检查和 10 组输出订阅检查。最低支持版本 Node 22.23.4 的离线回归及真实 DSH Web 宿主/Chrome 双后端验收通过；模型输出使用确定性夹具。

## 0.5.0-rc.3 — 2026-10-25

- 选档改为两级从属：「DSH 自主选模型与推理强度」默认关闭，运行固定使用默认模型与默认推理强度，DSH 不传也不接受 model/effort；开启后由 DSH 事前选档，预设策略默认关闭，只有策略非关闭时才显示选档方式、强度自治上限、策略按钮与目录来源，策略行在主开关关闭时禁用
- 修正默认关闭自动补全后的调用示例、工具数量、沙箱权限和额度暂停说明；独立真实模型验收入口，增加无模型调用的预检及离线污染防护
- 收紧发行文件白名单，仅发布实际使用的注册表说明；CI 检查实际解包内容、相对导入和运行数据排除
- 简化设置页分组与注册表表格，移除重复说明和“已覆盖”状态；自动补全使用灰色 beta 标签、默认关闭，关联选档控件随开关显示，统一中英文说明的末尾标点

- 清理未使用导入、默认值变量、重复元数据读取及前端文案；移除无实际作用的 maxLogBytes 配置、驱动参数和旧 .detach.json 记录逻辑，后台启动保护测试改用当前 run 预留机制。

- 移除旧自动翻译入口及配套会话、剪贴板逻辑、翻译任务工具、状态接口与缺失/过期扫描；保留内置中英文显示、用户翻译覆盖和注册表手动编辑。

- 补齐自包含注册表 21 个字段的中文名称和说明，作为初始回退翻译；修复空白用户翻译遮蔽默认文本，以及中文表格直接显示英文原文的问题。表格随 DSH 界面语言切换，英文界面保留 Codex 原文，不展示中文翻译编辑框。

- 新增独立自包含的 lib/codex-registry.json，统一日常字段定义、兼容规则和默认翻译；外部发现、缓存或编辑器服务失败时回退内置数据，保留可读用户覆盖并保护不可读文件。移除分散的旧内置规则与翻译文件。

- 修复目录联接场景下原生 Schema 导出读取仍使用未解析根目录、误报 Field registry path escaped 的遗漏；补充完整原生适配器路径回归。

- 注册表编辑器新增 Codex 版本、刷新按钮和最后更新时间；JSON 与表格同步加入 codexVersion/updatedAt 只读信息，刷新保留未保存修改，失败保留上次成功时间。

- 修复 DSH_HOME 为 Windows 目录联接时注册表与编辑器误拒读取；保留内部路径重定向拦截，补充编辑接口未注册的重启提示和真实通信库回归测试。

- 将本地化区域整合进“修改注册表和完整配置”窗口；新增五列可编辑表格、注册表 JSON / 配置 JSON 页签、搜索与双向草稿同步，保存带校验、文件冲突检测及失败保留。

- 增强选档模式直接显示在设置页，复用 selectionPolicy.mode，默认关闭；仅审计不再调整选档或要求额外解释，强制执行才应用档位、额度和理由校验。
- 为额度恢复、低额度保存暂停、暂停催促、证据选档补充模型 token 开销说明，区分代码执行与模型处理。
- 后台通知在完整短回答、进程已验证结束且没有排队、子任务或恢复歧义时直接交付终态快照，减少重复状态查询；其他通知仍要求刷新状态。

- 配置统一为代码默认值、DSH profile 和单次参数；设置页与 JSON 编辑器共用同一数据源。移除全局、项目设置文件的读写及策略覆盖，codex_config 改为无参数只读查询，安装模板不再重复写入默认值。
- 设置页保存栏按实际滚动区域边界固定在底部，适配宿主内边距、窗口和侧栏尺寸变化；保留未保存、保存中、校验失败及写入失败提示。
- 恢复默认按钮始终显示，保存后清除对应 profile 覆盖；收紧折叠分组之间的间距，移除静默报告阈值及按无输出时间判断“疑似停滞”的逻辑。

- 移除原生 subagent 四项控件、专用配置、默认透传规则和模型强度专项校验，直接继承 Codex；清理设置分组和翻译，保留子任务状态监测与独立的中断消息字段。exec 驱动同步取消忽略用户配置的标志。

- 移除回传截断长度控件及 answerChars 配置，取消工具回传和驱动保存的字符数截断；完整传递最终回答原文，统一过滤过程消息。后台通知仍以轻量预览引导状态查询，工作过程按需读取。

- 运行时限统一为仅在完整配置 JSON 提供的 defaultBudgetMs，默认 0，同步与后台共用；单次 budget_ms 优先。移除三项旧预算字段、timeout_ms、两个设置行和插件层重复计时器。

- 移除放行完整访问控件、allowFullAccess 配置及额外校验；沙箱模式直接决定权限，danger-full-access 无需额外开关。

- 沙箱内网络接入字段注册表，统一布尔类型及 Schema 校验；关闭时显式发送 false，避免继承 Codex 的网络开启配置。

- 沙箱模式下拉框、表单与完整 JSON 校验、运行前校验统一读取字段注册表；保留 workspace-write 默认值，移除未知模式的静默回退。

- 审批策略下拉框、表单与完整 JSON 校验、运行前校验统一读取字段注册表；移除退役的 untrusted 选项和文案，通过数据规则排除弃用选项，保留 never 默认值。

- 移除原生线程旧键 agents.max_threads 和 V1 递归深度 agents.max_depth 的控件、插件配置及默认透传规则；保留当前会话线程上限，递归深度继承 Codex 配置。

- 将完整官方定义限制为参考缓存；日常注册表仅保留插件使用和明确启用的字段，默认 21 项配置字段。
- 无关配置不进入日常翻译范围；已有用户翻译保留，重新启用后复用。日常状态区分使用量与参考数量，不附带完整协议索引。
- 新增 Codex 字段注册表：官方配置参考、本地 CLI 协议导出、版本缓存、差异记录、热读兼容覆盖与独立用户翻译。
- 配置校验和参数编码由数据表驱动；前端加载同一校验定义，支持字段别名、版本范围及结构化值，减少日常字段适配中的代码修改。
- 本地化扩展到所有登记字段并增加分页；日常模型工具只返回注册表摘要，避免发送完整定义表。
- 本地化表新增 settings 分组，为 agents.interrupt_message 提供名称与说明，支持用户覆盖和手动编辑，保留原始配置键和布尔值。
- 原生中断消息移出设置页，仅在完整配置 JSON 中保留 agents.interrupt_message；修正为布尔类型，未设置时继承 Codex 配置。
- 移除 Codex 任务契约、默认/自定义前置文本和相关设置；DSH 提交的任务文本原样进入两个驱动，选档不再改写任务。
- DSH 侧明确要求检查用户目标并继续未完成工作；插件保留事实交接与明确停止/额度恢复边界。
- 同步运行纳入持久通知，宿主退出与调用通道断开不再误判用户取消；新增启动卡住、心跳失联、记录损坏与未消费排队消息检查。
- 通知 RPC 有超时，异常提醒不受完成提醒关闭影响；健康事件与回复分别去重，正常同步返回通过提交回执避免重复通知。
- 修复驱动退出后 running 元数据漏报、连续失败回合去重和未确认通知误记成功；通知故障可由状态查询诊断，未投递证据保留。
- 同一线程的并发续跑由 admission 锁拦截；配置超时与用户停止分开处理；额度恢复后续 run 在状态中明确交接。
- codex_read 锁定运行对应 turn，避免后续线程回答污染旧任务证据；新增中断、通知、恢复边界回归测试。

## 0.5.0-rc.2

- 返回事实与 DSH 决策交接：新增 turn_status、process_status、task_state=unknown、needs_dsh_decision、decision_reason、automation、has_final_answer、answer_truncated；completed 后可显式续跑，插件不自动验收/继续。
- 每次回复/终态产生可见信号；U8 失败终态统一 kind=failure，同一 run 只通知一次；补充 killed、needs_attention、非用户中断覆盖。
- 数据生命周期：默认移除 events.jsonl、answer.txt、result.err.log、result.jsonl；codex_read 原生 thread 优先，meta 回退；exec 只保留最终答案；debugLogs 默认关闭、有界。
- 主动查询：statusPollingEnabled 默认关闭，间隔 15–120 分钟默认 30；只对活跃 run 建查询，不自动 continue。
- Codex 安装发现：新增 codexExecutable/codexHome，扩展 npm/pnpm/Volta/scoop/winget/Desktop 候选，拒绝 shim，增强 codex_doctor 诊断。
- 修复 polling 到期先删后建、exec 第二轮空回答沿用、失败 turn 通知 meta 摘要、quota recovery 字段边界及控制组假绿。
- 设置页排版统一：自定义行（开关/下拉/滑块）改用官方 SettingsValueField 的 13px/500 标题与 12px 说明；修复把 `--dsw-font-*`（font 简写）当 `font-size` 用、导致整行回退继承 16px 的缺陷。
- 排版常量收口到 `TYPE_LABEL/TYPE_BODY/TYPE_HINT`，策略弹窗、完整配置弹窗和额度条复用同一套 13/12；行几何改为官方字段的 12px 内边距、无分隔线；“已覆盖”改用官方 `Tag`，恢复默认补 hover/focus 态。
- 选档策略的“高级 JSON”改为两空格缩进显示并关闭拼写检查；保存仍写紧凑串，解析兼容任意空白。
- 新增上游 `SettingsRow` 提案（[docs/upstream-settings-row.md](docs/upstream-settings-row.md)），为将来零自绘迁移留出接口。
- 设置页 39 行；真实长任务、U8/去重、真实 U9 repair 与安装 smoke 已验收。

## 0.5.0-rc.1

- Settings reads recover from a dedicated-channel HTTP 405 through authenticated Connection exact routes under /api, sharing the same read-only service and validation. Authorization failures are not retried.
- Fix optional client service lookup and wait for observable form-save completion before closing the policy dialog. Add 34-row interaction coverage and installed-library HTTP transport recovery tests; live host acceptance remains separate.
- Add strict offline schema coverage for all 16 tool factories; verify full 17-tool registration separately with the installed Cordis and schema compiler, without starting DSH.

### U0

- 统一进程归属证据与 admission 判定；新增 `codex_release`，只释放 stale/orphan 记录，不杀不删。
- 额度暂停默认等待检查点；`pauseGraceMs` 显式启用二次 steer / interrupt；stall 仅报告。
- 关闭和终版落盘故障仍完成 driver；轻量心跳、限频 meta、schedule 回滚与丢失提醒重排。
- 状态区分 running / not_found / needs_attention；共享设置校验；保护策略和安全配置。
- ceiling 仅同步通道且至少三条样本才应用；脱离单次最小值压短。

### U1

- 动态分页模型目录、隔离缓存和离线 fallback；逐模型校验 effort/tier，兼容 fast。
- 新增 codex_models 与认证只读 codexRunner 目录服务；测试使用 fake 目录，无模型 turn。
- U0 取消修复：taskkill 拒绝访问时通过原生进程快照终止本连接的后代并记录证据；exec/App Server 共用。

### U2

- profile selectionPolicy 默认 audit，执行 floor/证据/降级理由/审批门禁；全局和项目只能收紧策略。
- 每个 run 保存 selection.json，新增 codex_selection；列表及 codex_read(selection) 展示审计，旧 run 返回 null。
- EUI-NEO 原始 selection fixture 检查推荐 astra/xhigh、实际 sol/high 与 quota 理由。

### U3

- 设置页按契约分组，高级折叠；uiLayout 控制顺序/隐藏并可恢复。
- 策略 modal：五 tab、预设、预览、目录校验、未保存确认，configForms 保存热生效。
- 共享只读 catalog 连接及 fallback；保留原字段的编辑/重置能力。

### U4

- 中文 default/user 覆盖、热读取、损坏回退；原目录英文事实和 ID 保留。

### U5

- 新增 codex_quota/codex_diagnose，账号级窗口、来源/采样/缓存、限频、只读诊断。
- 顶部额度条共享服务，run 终态仅发送无内容刷新事件，无 UI 轮询；状态补充额度来源与采样时间。
- 进程树支持显式只读 inspect，默认诊断不会 steer 或终止进程。

### U6

- 七个原生 agents 当前/兼容配置键与类型校验，模型/effort 配对验证，保留继承默认。
- 原生活动去重、有界状态摘要与只读 getSubagents；保留 turns 原文及父 run 会话列表。
- 高级设置与 native 分组、诊断警告、布局支持；未新增插件级 fan-out。

### U8

- Always-on failure reminders for plugin-managed detached runs through the existing host schedule service, with no settings or UI rows added.
- Persist originating session, exact run registry, notification intent/result and bounded redacted diagnostics; deduplicate across polls, concurrent hosts and reloads. Ambiguous schedule results are reconciled, never automatically recreated.
- Exclude sync, success, user cancellation, quota waiting and live thinking. No automatic restart/kill or change to quota recovery. Fake schedules cover failure paths without model turns.

### Offline pre-acceptance / U9

- Align README version, 17-tool inventory and 34-row settings description with the package and manifest; current host/UI acceptance remains pending.
- Synchronize the local repair supervisor with the reviewed JSON-output classification and fail-closed history handling, retaining a portable workspace default. Include the original extra offline test unchanged.
- U9 validation uses self-tests and fake repair/verify calls only; no real repair, DSH operation or model turn.

## 0.4.0-rc.2

- Add opt-in low-quota warning: a switch plus a 0–20% slider (default 5%, measured as remaining quota).
- When enabled, the App Server driver steers a Chinese pause warning into the active turn, records `quota.remaining`/`quota.reason`/`warning.resumeAt`, and schedules DSH recovery at the latest quota reset time plus three minutes.
- Warning requires App Server and DSH Schedule/storage; enabling it also keeps the recovery chain alive when hard auto-resume is off.
- Add core, managed-run, quota-coordinator and client-form regression coverage for the warning path; bump client version metadata to 0.4.0-rc.2.

## 0.4.0-rc.1

- Add an optional App Server driver with active-turn steering, interruption and durable pending messages.
- Add opt-in quota pausing and DSH Schedule recovery with account checks, generation deduplication and cancellation.
- Add evidence-based model selection, workspace-scoped conversation reading and three native settings rows.
- Remove stale external execution-channel guidance; preserve exec compatibility as the default.
- Reject redirected run-store parents; recheck the recovery switch after quota I/O; expose recovery transport failures and retain unresolved recovery evidence.
- Expand protocol, lifecycle, quota, history and settings regression coverage. This remains a release candidate; consult the accompanying acceptance report for verified boundaries.

## 0.3.0-rc.1

- Give every execution its own UUID and directory; support exact run selection.
- Add codex_cancel, codex_list and codex_doctor.
- Reject protected configuration overrides and unsafe task labels.
- Handle spawn failures, apply hot settings to status, forward ceilingFile.
- Remove admission decisions based on historical quota snapshots.
- Limit concurrent workspace runs, background duration and diagnostic log size.
- Cancel through the owning driver; never kill an arbitrary PID from an old registry.
- Split offline and live tests; test the real driver with a deterministic fake CLI.
- Correct installed-path tests, default model, package hygiene and installation documentation.
- Initial release scope is Windows and DSH 0.2.0-rc.2; broader platform support is not claimed.
