# 0.5.3-beta 候选版记录

日期：2026-11-03（Asia/Shanghai）。版本为 `0.5.3-beta`，用户已完成 README 编辑并授权发布。本记录描述测试证据，渠道发布状态以 GitHub Release、npm 和市场目录为准。

## 本次证据

- 中英文 OpenAPI 3.0.3 验证通过：9 个操作、50 个 Schema、105 项契约检查；无真实模型调用或用户 profile 写入。
- 本地 `0.5.3-beta` 候选包解包检查通过：73 个文件、156 个相对导入，无运行或私有数据。此包仍包含用户尚未编辑的 README，提交前需重新打包检查最终版本。

- 2026-11-03（Asia/Shanghai），Windows / Node 24.22.2：额度恢复和输出订阅修复后的 `npm run verify` 43/43 通过。
- 输出订阅专项 10 组通过：60 条历史下 20 次精确查询只读取 20 次 run.json、不扫描目录；共享游标、终态排空、静默历史记录、设置切换、过期响应、失败退避、重连补读、文件事件与消息正文隔离均有覆盖。真实模型转发未在本轮重新验收；当前候选的宿主/浏览器证据见下文。
- 本轮中英文 OpenAPI 再次通过 105 项契约检查，新增说明 output_changed 通知、保活与游标补读语义。验证日志统一写入本地 logs/，不随 Git 或发行包交付。
- `test-quota-entry.mjs` 的 12 项检查通过：真实恢复协调器接入真实工具入口，替代宿主持久化、额度查询与最终进程启动。覆盖默认模式恢复、档位保留、当前目录与策略限制、调用隔离、取消和重复唤醒；未进行真实账号额度耗尽/恢复验收。
- 独立记录覆盖身份隔离、字节截断、游标恢复、投递窗口对账、并发锁、终态排空、显示开关与能力缺失回退。
- 监督覆盖摘要边界、UTF-8 字节数、增量不触发模型通知，以及问答/终态通知协调。
- `.capture/look-final.png` 为已有桌面展示截图，不能单独证明本候选的完整交互与重启持久化。
- 手机远程支持按用户要求移出范围，事项已结项，不再列为待办。

## 提交前衔接

### 2026-11-03 最低版本与当前候选宿主验收

- Windows x64 / Node 22.23.4：从 Node 官方来源取得运行时并核对 SHA-256；完整离线回归 43/43、候选解包检查及 DSH CLI 入口均通过。
- 同一 Node 22.23.4 下，真实 DSH 0.2.1-rc.3 Web profile 安装当前 `0.5.3-beta` 包，12 项宿主检查通过，覆盖 19 工具注册、原生会话/问答/监督控制、设置持久化、注册表读写、驱动执行、宿主重启与取消、卸载后仍可启动。
- 真实 Chrome 无头浏览器验证 App Server 和 exec 两种后端：独立聊天记录、实时更新、显示开关、模拟网络断开后补读、最终答案、终态短窗口内无新增输出查询、记录身份无重复、刷新后恢复最终答案。浏览器未捕获未处理异常。更长时段的终态静默由确定性时钟回归覆盖。
- DSH 模型适配器和 Codex 协议输出均为确定性夹具，真实付费模型调用为 0；这是当前候选的真实宿主/Web 浏览器验收，不代表 Electron 桌面端或真实模型服务验收。
- 被测压缩包 SHA-256：`e1c388ce2391c9fd932e749600d7bef77611f21a8c0ee086ab9c581d16578fbb`。本地证据归档于 `logs/release-0.5.3-beta-2026-11-03/`，包含验收 JSON、Node 22 回归日志和两个后端截图；不随发行包交付。
- 首轮旧验收夹具仍发送原始 delta 来触发监督，导致监督断言失败。夹具已按当前完成项摘要契约修正，并显式开启测试所需的自主选档；未放宽插件行为或跳过断言，随后在 Node 22.23.4 完整重跑通过。

2026-11-03：用户已完成 README 编辑。中英文 README 已加入固定版本下载徽章、npm 安装方式和市场入口；市场收录状态单独注明。三张图片已加入 Git 与发行包白名单。最终包为 76 个文件、156 个相对导入，README 及图片与源码逐字节一致；版本、安装、OpenAPI 和洁净度检查通过。GitHub 与 npm 发布使用同一份压缩包，渠道可用性在发布后验证。

## 历史验收

以下保留原版本和日期，其宿主/模型/浏览器结果不自动升级为本候选新增功能的验收。

### 0.5.0-rc.3 候选版验收

验收日期：2026-10-25

## 已验证范围

- Windows，Node 24.19.0，官方 DSH CLI 0.2.1-rc.3 的 Web profile
- 临时 DSH_HOME/profile，使用官方 `dsh plugin ... add <tgz>` 安装实际发行包
- profile 配置组合与 15 个工具注册
- 原生 Settings 服务保存后立即影响插件运行，并在宿主重启后保留
- 实际浏览器打开插件设置页，通过保存按钮写入设置
- 配置 JSON 修改同步到表格；配置和注册表通过实际 owner Connection 保存并重新读取
- 1280 与 375 像素宽度的完整配置编辑器显示
- 真实 App Server driver 对接确定性假 CLI，完成同步任务；后台任务跨宿主重启后可查询、取消并到达终态
- 官方卸载移除依赖、bundle 和全部插件工具，宿主仍可重新启动
- `npm run verify`、发行路径检查、实际 tgz 解包加载、文件白名单与相对导入检查

## 测试边界

本次未调用真实 Codex 或 DSH 模型，不使用现有用户的登录信息或 profile。Web 测试仅通过官方 `credentialOnboarding: false` 配置关闭首次账户引导，浏览器使用独立临时数据目录。此配置不属于插件设置，也不会写入用户环境。

本次没有覆盖最新版桌面安装器、其他 Windows 机器、代理网络或 Node 20/22 的实际运行。项目保留 Node 20/22/24 CI 矩阵，但未在本次本地验收中将其全部执行。历史桌面版 0.2.1-rc.2 的结果不代替当前桌面发行包验收。

预设选档策略标为 beta；DSH 自主选档默认关闭，默认使用固定档位。已验证规则可执行、输入校验和留痕；未证明任务复杂度判断准确率或净 token/额度节省，不将这些效果作为候选版承诺。

## 卸载残留

DSH 0.2.1-rc.3 的官方卸载会保留设置页生成的 profile 覆盖条目。随后可能提示 `patch: entry "dsh-codex-runner" not found`，但已确认插件工具不再注册，宿主仍可启动。

如需清除残留，关闭目标 profile，备份其 `cordis.patch.yml`，只删除 `id: dsh-codex-runner` 的覆盖条目，然后执行 `--dump-config` 检查。插件不在卸载时自行删除用户配置。

## 复现

在独立临时目录安装测试宿主，不要指向现用 DSH_HOME：

```text
npm install --prefix <临时目录>/host --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.3
npm run verify
npm pack --pack-destination <临时目录>
node scripts/check-package.mjs <发行包解包后的 package 目录>
node scripts/test-dsh-package.mjs <临时目录>/host <候选版.tgz>
```

包含实际浏览器交互时，使用已安装的 Chrome/Chromium：

```powershell
$env:DSH_ACCEPT_BROWSER_MODULE = Join-Path (Get-Location) 'scripts/test-dsh-browser.mjs'
# 自动发现 Chrome；非标准安装可设置 CHROME_PATH
node scripts/test-dsh-package.mjs <临时目录>/host <候选版.tgz>
Remove-Item Env:DSH_ACCEPT_BROWSER_MODULE
```

脚本输出临时证据目录，包含配置快照、验收结果、发行包 SHA256 和浏览器截图。完整实际模型验证使用独立的 `npm run test:live`；`--check` 仅预检，不发起模型回合，省略它会消耗 Codex 额度。
