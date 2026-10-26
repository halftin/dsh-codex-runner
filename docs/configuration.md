# 配置与注册表

[项目首页](../README.md) · [文档目录](README.md) · [English](configuration.en.md)

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

## 设置页与策略弹窗

设置页直接展示额度和常用设置，仅高级设置保留折叠。全部展开时共 19 个常规设置行；自动补全默认关闭，其关联选档控件随开关展开或折叠；codexExecutable、codexHome 位于高级设置，各自使用左侧说明、右侧原生路径输入框的同行布局，窄屏自动换行；定时查询开关和间隔滑块在核心运行设置中合并显示。selectionPolicy 的模式直接在设置页编辑，关闭／仅审计／强制执行共用原有 JSON 字段；详细规则仍通过策略弹窗编辑。目录不可用时仍显示 fallback 和错误来源，可手动刷新。
页面分组、行顺序和默认折叠状态由 lib/client.js 中的 PAGE_LAYOUT 统一维护，不属于用户配置。
开关/下拉/滑块行使用插件内置的 Row（官方 primitives 目前没有导出行组件）；排版统一取 `TYPE_LABEL/TYPE_BODY/TYPE_HINT`，几何对齐官方 `SettingsValueField`。
选档策略弹窗包含任务、证据、降级/审批、额度和高级 JSON 五个 tab，提供严格/平衡/省额度预设、恢复推荐、预览和校验。低于推荐 floor 有文字警告；无效 JSON 或目录值阻止保存；关闭未保存修改需要确认。保存后下次 run 热读取；审批仍返回 approval_required，不提供逐次批准入口。

## Codex 字段注册表

官方字段参考、本地版本协议定义、兼容规则和用户翻译分层维护。初始化检查本地版本并更新快照；失败回退缓存，运行时修改 overrides.json 可适配普通字段增删、别名、类型及枚举变化。前后端配置校验读取同一日常注册表，默认包含 14 项通用透传字段和 7 项专用控制字段；完整参考定义及协议索引留在缓存中。exec 与 App Server 保留参数类型。通过高级设置末尾的“编辑完整配置与注册表”按钮维护配置、字段规则及翻译。表格、注册表 JSON、配置 JSON 共用当前窗口草稿，点击保存后才写入相应文件；刷新注册表会独立更新原生参考缓存，不调用模型。字段覆盖位于 `<DSH_HOME>/codex-runner/fields/overrides.json`，中文翻译位于 `<DSH_HOME>/codex-runner/i18n/zh-CN.user.json`

## 中英文显示与手动翻译

界面跟随 DSH 的语言设置。中文界面优先使用用户中文翻译，再使用内置中文；英文界面显示英文说明或 Codex 原文。模型标识、原生配置键和枚举值保持不变。模型和推理强度只翻译 description；settings 分组维护日常注册表字段的 name/description，默认覆盖 21 项配置字段。

翻译统一在“编辑完整配置与注册表”窗口的表格或注册表 JSON 中手动维护，不调用模型，不创建会话，也不提供模型翻译工具。保存只写用户覆盖；清空或删除用户翻译会恢复内置文本。界面草稿、保存前校验、冲突检测和损坏文件保护与其他注册表编辑共用。

默认翻译来自插件内的 `lib/codex-registry.json`，缓存同步至 `$DSH_HOME/codex-runner/i18n/zh-CN.default.json`；用户翻译位于同目录的 `zh-CN.user.json`，逐次读取。每个翻译值最多 200 字，只接受单行纯文本。损坏用户表会回退显示内置翻译，保存前需要手动修复。既有用户翻译和旧备份不会因功能移除而删除；未启用字段的翻译保留，重新启用时复用。

## 有依据的模型选择（Beta）

`selectionMode=legacy` 保留原任务类型规则；`manual` 要求每次明确传 model 和 effort；`evidence` 要求结构化 evidence：`files`、`acceptance`、`uncertainty`，可附 `plan_file`、接口/架构/并发/权限风险及 `failure_reason`。

插件核验文件属于工作区、计划存在并记录 SHA256；风险和验收描述属于调用方声明，返回值会与文件事实分开。机械/文档任务有明确计划且不确定性低时使用 luna/low；架构、接口、并发或权限决策使用 astra/xhigh；常规任务使用 sol；环境故障不会自动升级。范围缺失或不确定性高时先派发只调查、不实施的任务。文件数量本身不决定档位。

增强选档策略为 enforce 时，显式覆盖须写 override_reason；off 和 audit 不强制额外解释。所有模式仍受 maxEffortAllowed 限制。选档理由保存在 selection.json 和工具返回值中。这是可审计的启发式规则，并非能准确理解所有任务的分类器，也不承诺固定额度节省。

## 选档策略与审计

| 工具 | 用途 |
| --- | --- |
| `codex_selection` | 只读筛选当前工作区的推荐/实际选档、降级原因、策略版本和 run_id。 |

`selectionPolicy` 是 profile JSON，默认 off、require_approval=false，只读取当前 profile；缺失部分由代码默认值补齐。off 不应用增强规则；audit 只记录推荐和实际档位，不改变选档、不强制理由、不执行额度门禁或要求额外复核；enforce 才调整未显式指定的档位、校验覆盖理由并执行额度和降档规则，需要审批时返回 approval_required 且不启动 driver。当前没有逐次审批 UI，不能通过工具参数伪造批准。unlock_effort 只突破上限，不能绕过 floor。
模型顺序是默认策略角色顺序（luna/sol/6.1-sol/astra），不是目录性能事实。陌生模型与不同 floor 的强度关系不明时明确记录 comparison=unknown；enforce 拒绝。
每个新 run 都保存 selection.json；codex_list 显示 model/effort/downgrade；codex_read(source="selection") 有界读取，旧 run 返回 null。已有无策略设置不需迁移；由 profile 人工设置 mode=off 可关闭 floor，仍保留审计及显式覆盖理由。
