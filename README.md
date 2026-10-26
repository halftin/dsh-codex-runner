# dsh-codex-runner

**在 DSH 中，把 Codex 接入你的工作流**

启动任务 · 后台执行 · 查询进度 · 追加指令 · 读取完整答复

[下载与安装](#下载与安装) · [开始使用](#开始使用) · [修改设置](#修改设置) · [使用文档](docs/README.md) · [English](README.en.md)

[![Version](https://img.shields.io/badge/version-0.5.0--rc.2-blue?style=flat)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-blue?style=flat)](#下载与安装)
[![Node.js: >=20](https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat)](package.json)
[![DSH compatibility](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2%20%3C0.3.0-lightgrey?style=flat)](package.json)
[![Model selection: beta](https://img.shields.io/badge/model_selection-beta-orange?style=flat)](#模型选档-beta)

**dsh-codex-runner** 是面向 Windows 的 DSH 插件，让 DSH 调用本机 Codex CLI 完成项目任务，并管理执行过程与结果。Codex 使用你的本地工作区和已有登录，DSH 负责规划、复查和后续推进

## 可以做什么

| 你想做的事 | 插件提供的能力 |
| --- | --- |
| 把项目任务交给 Codex | 在当前工作区启动任务，返回完整最终答复 |
| 运行耗时任务 | 支持后台执行，DSH 重启后仍可按运行 ID 查询或取消 |
| 执行中补充要求 | 向当前轮发送指令、中断当前轮，或排队追加下一轮 |
| 查看进展与历史 | 查询执行状态、账号额度和当前工作区的关联会话 |
| 管理权限与配置 | 原生设置页、完整配置编辑器和可编辑的字段注册表 |
| 按需启用增强功能 | 低额度暂停、额度恢复续跑和定时状态报告，明确说明额外 token 开销 |

## 下载与安装

需要 **Windows、Node 20 或更新版本、DSH，以及已安装并登录的 Codex CLI**。当前声明的 DSH 范围为 `>=0.2.0-rc.2 <0.3.0`；插件不包含 Codex CLI，也不代替 Codex 账号登录

| 获取方式 | 入口 | 版本 |
| --- | --- | --- |
| npm 包 | [dsh-codex-runner](https://www.npmjs.com/package/dsh-codex-runner/v/0.5.0-rc.2) | `0.5.0-rc.2`，预发布标签 `next` |
| `.tgz` 插件包 | [下载插件包](https://github.com/halftin/dsh-codex-runner/releases/download/v0.5.0-rc.2/dsh-codex-runner-0.5.0-rc.2.tgz) · [发行说明](https://github.com/halftin/dsh-codex-runner/releases/tag/v0.5.0-rc.2) | `v0.5.0-rc.2` |
| GitHub 仓库 | [halftin/dsh-codex-runner](https://github.com/halftin/dsh-codex-runner) | 标签 `v0.5.0-rc.2` 或开发分支 `main` |

**通过 DSH 界面安装：** 打开“插件 → 添加插件”，填写以下地址，安装后按提示启用插件或重启 DSH

```text
dsh-codex-runner@0.5.0-rc.2
```

**通过 CLI 安装：** 将 `<profile>` 替换为实际使用的 DSH profile

```text
dsh plugin --profile <profile> add dsh-codex-runner@0.5.0-rc.2
```

已有 `.tgz` 文件时，也可以直接安装本地包：

```text
dsh plugin --profile <profile> add ./dsh-codex-runner-0.5.0-rc.2.tgz
```

也可填写 `github:halftin/dsh-codex-runner#v0.5.0-rc.2` 安装此版本的源码。`main` 会随开发更新，`next` 会随新的预发布版本更新；上述命令固定安装 `0.5.0-rc.2`。通过 DSH 安装插件即可，无需另行执行 `npm install`。环境检查、可执行文件路径、安装排查和卸载方法见[安装文档](docs/installation.md)

## 开始使用

1. 在终端执行 `codex login`，完成 Codex 登录
2. 在 DSH 中选择项目工作区，运行 `codex_doctor()` 检查连接，再用 `codex_models()` 查看可用模型
3. 将任务交给 DSH，说明目标、范围和验收要求；运行时明确提供模型和思考强度

例如，可以向 DSH 提出：

> 请使用 Codex 修复当前项目中的这个问题，先确认可用模型和思考强度，再执行任务、运行相关检查并复查结果

需要直接调用工具时，可参考以下示例，将占位符替换为实际值：

```text
codex_run(prompt_file="task.md", label="task", model="<可用模型 ID>", effort="<支持的强度>", detach=true)
codex_status(run_id="<返回的运行 ID>")
codex_say(run_id="<运行 ID>", action="steer", message="补充要求")
codex_cancel(run_id="<运行 ID>")
```

`task.md` 是当前工作区中写好的任务文件。每次执行会返回唯一运行 ID，后续可准确查询、追加指令或取消。自动补全默认关闭，首次使用也需要明确选择模型和强度

完整工具列表、读取会话、任务续跑和状态含义见[工具与任务操作](docs/tools.md)

## 修改设置

打开 DSH 中该插件的详情页，修改设置后点击底部固定的 **保存** 按钮

| 设置内容 | 用途 |
| --- | --- |
| 模型与思考强度 | 设置自动补全启用时可使用的默认档位 |
| 沙箱与审批 | 控制 Codex 任务的访问权限和审批方式 |
| 低额度暂停与自动恢复 | 按需向 Codex 发送暂停或续跑消息，会产生额外模型 token 消耗 |
| 定时查询 Codex 状态 | 让 DSH 定期查询并报告进展，会消耗 DSH 模型 token |
| 高级设置 | 管理并发、历史保留、调试记录和本机 CLI 路径 |

高级设置末尾的 **编辑完整配置与注册表** 提供表格、注册表 JSON、配置 JSON 三个页签。它们共用编辑草稿，点击保存后才写入对应配置；刷新注册表会独立更新参考缓存

设置页与配置 JSON 共用当前 DSH profile，保存后用于后续任务；已经启动的 Codex 任务保留启动参数。插件界面跟随 DSH 的中英文语言设置

配置优先级、默认值、编辑器保存规则及 token 开销说明见[配置与注册表](docs/configuration.md)

### 模型选档 Beta

“自动补全模型和思考强度”默认关闭。启用后，代码可根据调用参数、任务类型和声明的证据执行选档规则；目前尚未证明它能准确判断所有任务的复杂度，也不承诺固定的 token 或额度节省

## 运行原理

```mermaid
flowchart LR
    User["用户"] <--> DSH["DSH：规划与验收"]
    DSH <--> Plugin["插件：启动、监测与控制"]
    Plugin <--> Codex["Codex CLI：本地工作区执行"]
```

插件通过 Codex App Server 或兼容 CLI 驱动执行任务。启动、进程监测、状态查询和本地记录由代码处理，不为这些机械操作单独调用模型；Codex 执行任务、DSH 复查结果及处理通知仍会产生相应模型用量

一次执行结束不等于用户目标已经完成，结果仍由 DSH 复查。提示词按 DSH 提交内容发送；执行记录保存在当前工作区，插件不复制登录凭据，也不自动回滚项目改动

额度恢复、通知、数据保留和故障排查见[运行说明](docs/runtime.md)

## 文档与反馈

[使用文档](docs/README.md) · [问题反馈](https://github.com/halftin/dsh-codex-runner/issues) · [源码](https://github.com/halftin/dsh-codex-runner)

当前版本为 `0.5.0-rc.2`。已在 Windows / Node 24 / DSH 0.2.1-rc.3 Web profile 完成使用假 CLI 的隔离验收；不同机器、桌面安装器及其他版本的覆盖边界见[支持范围](docs/installation.md#支持范围)

## 开源许可

[MIT](LICENSE)
