# Communication API

[Documentation](../README.en.md) · [中文](README.md) · [English OpenAPI JSON](openapi.en.json) · [中文 OpenAPI JSON](openapi.json)

`openapi.en.json` uses OpenAPI 3.0.3 and describes six implemented POST operations and one SSE stream. It includes English operation, field, authentication, and error descriptions, along with English example titles. It does not define HTTP endpoints for the 15 DSH model tools; see [Tools and task operations](../tools.en.md)

`openapi.json` is the Chinese edition. Both editions have identical endpoint paths, field keys, validation constraints, and example data; import either one. The documentation language does not change the meaning of the registry's `zh-CN` translation data

## Import into Apipost

1. Open project settings, manual project import, and choose **Swagger**
2. Upload `openapi.en.json` and confirm that **seven operations** were imported, grouped under Model catalog, Quota and subagents, Registry editing, and Run events
3. Replace `http://localhost` with the actual DSH Web base URL, including the port and any deployment prefix
4. Configure the full Cookie header of a valid DSH owner browser session in a private Apipost environment

DSH hosts and authenticates these routes; the plugin does not start an independent HTTP server. Disabled plugins or missing Connection Fetch support can produce 404. The cookie name is authority-dependent. Use the real session rather than hardcoding a name, do not share credentials in documentation, and do not substitute Codex authentication for the DSH session

## Requests and errors

POST bodies use `application/json` and a `client-request` envelope containing `type`, `rpcId`, `method`, and the operation's `payload`. `rpcId` is a lowercase UUID v4; `method` must match the endpoint. Sending the payload alone is invalid

```json
{
  "type": "client-request",
  "rpcId": "11111111-1111-4111-8111-111111111111",
  "method": "codex-runner/getCatalog",
  "payload": { "refresh": false }
}
```

Responses echo `rpcId` inside a `server-response` envelope. HTTP 200 can still contain a business error with `result.ok=false`; inspect `result.error`. Invalid JSON/envelopes use 400, unsupported content types use 415, and oversized bodies use 413. DSH owns authentication, permission, and routing errors

## Registry writes and SSE

Read `getEditorRegistry` first, then preserve its complete `document` and current `revision`. Keep generated `codexVersion` and `updatedAt` unchanged. The save example uses `preview=true`, which validates without writing rule/translation files. Set it to false only after reviewing the preview. Placeholder revisions and empty field maps are illustrative, not a usable replacement for the document; omitted bundled fields are treated as disabled

Registry writes do not save ordinary profile settings. A stale revision is returned as a business error rather than HTTP 409

`run-events` uses `text/event-stream`: an initial comment is followed by terminal-event JSON in `data:` frames. It is neither model output nor a history replay, and an idle connection may receive no events. Use an SSE-capable client, such as Apipost's Event Stream request

Examples are synthetic. Actual catalogs, schemas, and host authentication remain authoritative
