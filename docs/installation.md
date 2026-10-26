# 安装与环境

[项目首页](../README.md) · [文档目录](README.md) · [English](installation.en.md)

## 支持范围

当前为首个发布版本 `0.5.0-rc.2`，仅支持 Windows。需要 Node `>=20`、DSH `>=0.2.0-rc.2 <0.3.0` 和已登录的 Codex CLI。已在 Windows / Node 24.19.0 / DSH 0.2.1-rc.3 Web profile 完成隔离安装、设置保存、后台任务重启查询、取消和卸载验收；验收使用确定性假 CLI，未调用真实模型。最新版桌面安装器、其他 Windows 机器及 Node 20/22 未完成本轮实际验收，版本范围不表示其中每个版本都经过测试。Codex CLI 基线为 `0.160.1`；兼容驱动需要 `exec --json`、`exec resume` 与 `queue`，新驱动需要 App Server v2 协议。自动补全模型和思考强度仍为默认关闭的 beta 功能，尚未验证复杂度判断准确率或实际额度节省

## 安装方法

安装前准备：DSH、Node、Codex CLI；先在终端完成 `codex login`。CLI 不包含在插件包中。两个驱动均继承 Codex 用户配置，并显式传递本次主任务的模型、强度、审批和沙箱权限。原生子 agent 的启用、线程上限和默认模型/强度由 Codex 自身配置及模型调用决定，插件不再提供重复覆盖；MCP/插件等原生扩展也按 Codex 配置加载。

在 DSH“插件 → 添加插件”中输入 `dsh-codex-runner@0.5.0-rc.2`，或使用支持的 DSH CLI 安装到目标 profile：

```text
dsh plugin --profile <profile> add dsh-codex-runner@0.5.0-rc.2
```

npm 上此版本使用 `next` 预发布标签；固定版本号可避免后续更新改变安装内容。无需在项目中额外执行 `npm install`

也可从 [GitHub Releases 下载 `.tgz`](https://github.com/halftin/dsh-codex-runner/releases/download/v0.5.0-rc.2/dsh-codex-runner-0.5.0-rc.2.tgz)，再安装本地文件：

```text
dsh plugin --profile <profile> add ./dsh-codex-runner-0.5.0-rc.2.tgz
dsh --profile <profile> --dump-config
```

也可从 GitHub 仓库安装，使用发行标签或固定 commit：

```text
dsh plugin --profile <profile> add github:halftin/dsh-codex-runner#v0.5.0-rc.2
```

仓库根必须是本包的 package.json。提交 lib、drivers 等可运行 JS，不需要构建或 prepare 脚本。DSH 通过 dsh.bundle.patch 加入 profile 的 bundles 列表；单纯执行裸 pnpm 不保证激活该层。

桌面版可通过插件管理界面添加发行包，按该版本提示重启。不同 DSH 版本对 desktop profile 的 CLI 管理支持不同。不要把修改 pnpm store 路径或强杀安装进程当作通用安装步骤。

首次使用执行 `codex_doctor()`，查看 searched candidates、原生 exe、版本、CODEX_HOME、auth 和 App Server 握手结果。高级设置 `codexExecutable=""` 留空自动发现，填写时须为原生 Windows PE `.exe` 的绝对路径，拒绝 `.cmd/.bat/.ps1` 和改名脚本；`codexHome=""` 留空继承 CODEX_HOME，未设环境变量时使用 CLI 默认目录。两项只传入本次子进程，不修改宿主环境或认证文件。

发现顺序为 `codexExecutable → CODEX_EXE → Windows 标准 npm 全局路径 → ~/.local/bin → PATH → 常见安装目录`。常见目录包括自定义 npm prefix（环境变量或用户 npmrc）、pnpm、yarn、bun、Volta 包镜像、scoop、winget、用户 bin/Apps/Codex 便携目录及 Codex Desktop 的 CLI resources。npm 同时识别嵌套/提升的 Windows 平台包和旧 vendor 布局，支持 x64/arm64。自动发现的 shell shim 只解析静态目标或其 prefix，不能解析便明确报错，不执行 shim 或盲目换装；服务账户的 HOME/PATH 与交互用户不同时，可显式配置这两个路径。插件只支持 Windows，不安装 CLI、不改 PATH、不登录、不复制认证、不修改 CODEX_HOME 内容。

DSH 进程必须继承登录时使用的 CODEX_HOME；未设置时 CLI 使用用户目录下的 .codex。桌面端与终端使用不同目录时，doctor 会报告未登录。不要把 auth.json 复制进插件或发行包。

## 卸载

使用 DSH 插件管理界面或 `dsh plugin --profile <profile> remove dsh-codex-runner` 卸载。DSH 0.2.1-rc.3 可能保留该插件的 profile 覆盖条目，并提示 entry not found。如需清除残留，关闭目标 profile，备份其 `cordis.patch.yml`，只删除 `id: dsh-codex-runner` 的覆盖条目，再执行 `--dump-config` 检查。插件不会自行删除用户设置或工作区中的运行记录
