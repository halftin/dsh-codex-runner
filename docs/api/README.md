# 通信 API

[文档目录](../README.md) · [English](README.en.md) · [中文 OpenAPI JSON](openapi.json) · [English OpenAPI JSON](openapi.en.json)

`openapi.json` 使用 OpenAPI 3.0.3，描述插件已实现的 8 个 POST 接口和 1 个 SSE 事件流。它不包含 `codex_run` 等 19 个 DSH 模型工具；工具用法见[工具与任务操作](../tools.md)

`openapi.json` 提供中文说明，`openapi.en.json` 提供完整英文说明，包括接口、字段、认证、错误和示例标题。两份文件的接口路径、字段键、校验约束和示例数据相同，导入其中一份即可；选择英文文档不会改变注册表中 `zh-CN` 翻译数据的含义

## 导入 Apipost

1. 打开“项目设置 → 导入/导出 → 导入项目（手动）”
2. 数据来源选择 **Swagger**，上传本目录的 `openapi.json`
3. 检查导入结果，应得到 **9 个接口**，分为模型目录、额度与子任务、注册表编辑、运行事件、实时输出五组
4. 将示例 `http://localhost` 改为实际 DSH Web 服务根地址，含端口与部署前缀
5. 使用有效的 DSH owner 浏览器会话，将完整 Cookie 请求头配置到 Apipost 的私有环境或请求头中

接口由 DSH 宿主挂载，并非插件自行监听的独立服务。未启用插件或宿主缺少 Connection Fetch 支持时，导入文档后仍可能请求到 404。Cookie 名称与宿主地址有关；请使用实际会话，不要硬编码名称，也不要把 Cookie 存入共享文档。该认证不使用 Codex 登录凭据

## 请求与响应

所有 POST 请求均需 `Content-Type: application/json`，使用以下封装。`rpcId` 必须是小写 UUID v4，`method` 必须与接口路径匹配

```json
{
  "type": "client-request",
  "rpcId": "11111111-1111-4111-8111-111111111111",
  "method": "codex-runner/getCatalog",
  "payload": { "refresh": false }
}
```

响应使用 `type=server-response`，并原样返回 `rpcId`。HTTP 200 可能包含 `result.ok=false` 的业务错误，不能仅按 HTTP 状态判断成功。JSON/封装不合法返回 400；Content-Type 不匹配返回 415；请求过大返回 413。宿主认证、权限和路由错误由 DSH 返回

## 注册表保存

先调用 `getEditorRegistry`，保留返回的**完整** `document` 和 `revision`，修改需要的字段后提交。`codexVersion`、`updatedAt` 为生成信息，必须保留原值

`saveEditorRegistry` 的文档示例使用 `preview=true`，只执行预检。确认后才改为 `false` 保存字段规则和中文翻译；它不保存当前 profile 的普通配置值。revision 占位符与空 fields 仅展示结构，不能直接拿来保存：遗漏内置字段会被解释为禁用，过期修订号会被拒绝

## 事件流

两个输出读取接口均支持可选 `runId`，不匹配时拒绝。`getOutput.item_records=true` 表示已有已确认的独立展示记录，可用于隐藏聚合卡片的重复正文；显示关闭时该字段可以省略。读取第 N 条事件使用 `after=N-1`；源输出序号与宿主聊天记录序号不同。

`getOutput` 使用 `sessionId` + `callId` 读取精确工具调用的输出；`after` 为排他序号，`limit` 为 1–200。显示关闭返回 `disabled`；历史未采集输出返回 `unavailable`。`getOutputResource` 使用相同关联及 `sequence`、字节 `offset`，单块最大 65536 字节，返回 base64 和完整文件 SHA-256。分块拼接后再解码 UTF-8，预览不等于完整内容。两个接口都不唤醒模型，不接受任意文件路径。

`GET /api/codex-runner/run-events` 返回 `text/event-stream`，先发送注释，再发送 `data: JSON` 变化通知。`status=output_changed` 表示输出或独立记录确认变化，其他值为终态状态；客户端按游标读取完整输出，并在重连后校准。每 15 秒发送保活注释。它不是模型输出流，不重放历史，也没有事件时必然返回数据的保证。使用 Apipost 的 Event Stream 功能或其他 SSE 客户端，避免把长连接等待当成接口故障

此文件按当前代码整理，动态的模型目录、字段参考与宿主认证细节仍以实际服务为准。示例均为合成数据，不含真实账号、路径或凭据
