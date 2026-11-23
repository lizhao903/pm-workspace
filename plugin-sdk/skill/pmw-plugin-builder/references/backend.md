# 后端协议 `pmw-plugin-rpc/1` 参考

> 状态：**P1-a 已实现**（`internal/pluginhost/`、`pmw-plugin-rpc/1`、子进程/握手/broker 已可用；签名、事件投递、WS 等仍 P1-b）。本文是
> `docs/plugin-spec-v2.md` 第 7 节的开发速查 + Go 模板说明，两者冲突时以规范为准。
> 协议是规范，SDK 是助手：任何语言都可以实现，Go 模板只是最省事的起点。

## 1. 进程模型

- 每个**启用**的外部插件是一个子进程，由宿主拉起；宿主进程内不加载第三方代码。
- IPC：
  - macOS / Linux：Unix domain socket，路径在 `PMW_PLUGIN_SOCKET`（绝对路径，短路径，见 §9）；
  - Windows：命名管道 `\\.\pipe\pmw-plugin-<id>-<random>`，同样在 `PMW_PLUGIN_SOCKET`。
- **宿主是 server**，插件进程启动后主动连上来；socket/管道对外不可达。
- 工作目录 = 插件安装目录（只读）；插件不得在安装目录写文件。
- 插件想持久化：`PMW_PLUGIN_DATA_DIR`（SQLite 与用户数据）、`PMW_PLUGIN_CACHE_DIR`（可重新生成）。
  独立 SQLite 只能通过 `host.store.query/exec` 访问，**不能**直连内核库、拿不到 `table_prefix`。
- stdout/stderr 由宿主收集、脱敏后进插件日志；日志写 stderr，不要写 stdout 当协议通道。

### 环境变量（白名单，宿主注入）

| 变量 | 含义 |
|---|---|
| `PMW_PLUGIN_ID` | 插件 id，必须和清单一致 |
| `PMW_PLUGIN_VERSION` | 插件版本 |
| `PMW_PLUGIN_API_VERSION` | 宿主外部 API 版本（`2.0.0`） |
| `PMW_PLUGIN_SOCKET` | 要连接的 socket / 命名管道 |
| `PMW_PLUGIN_TOKEN` | 本次实例的一次性握手令牌，常量时间比较 |
| `PMW_PLUGIN_DATA_DIR` | 插件数据目录 |
| `PMW_PLUGIN_CACHE_DIR` | 插件缓存目录（可删） |
| `PMW_PLUGIN_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `PMW_PLUGIN_OS` / `PMW_PLUGIN_ARCH` | 等价 `GOOS` / `GOARCH` |

不含宿主的 vault/凭证/DB 路径等变量；不要假设其它环境变量存在。

## 2. 分帧与 JSON-RPC 2.0

- **换行分帧**：每条消息是 UTF-8 JSON 文本 + `\n`；一行一个完整 JSON-RPC 2.0 对象。
- 不允许批量数组（v0.1）。
- 双向：双方都可以发 request；响应必须带请求的 `id`；notification 不带 `id`、不回复。
- 未知方法回 `method_not_found`（-32601）；未知字段忽略（向前兼容）；未知 notification 忽略。
- 二进制正文一律 base64（`body_b64` / `data_b64`）。
- 单条消息（含 base64 后）≤ **8 MiB**；超限回 `validation`（"消息过大"），对端可关闭连接。
- 一条连接只服务一个插件实例；断开即视为插件不可用（宿主走崩溃恢复流程）。

请求 / 响应示例：

```json
{"jsonrpc":"2.0","id":"pmw-1","method":"host.objects.list","params":{"limit":3}}
{"jsonrpc":"2.0","id":"pmw-1","result":{"items":[{"id":"obj_1","title":"示例任务"}]}}
{"jsonrpc":"2.0","method":"plugin.permission_changed","params":{"permissions":["objects:read"]}}
```

`id` 用字符串或数字都行，响应必须原样带回；插件实现里建议统一用字符串。

## 3. 握手

插件连上后**先发且只发一条** `plugin.hello`（request，10 秒内完成）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `protocol` | string | 固定 `pmw-plugin-rpc/1` |
| `plugin_id` | string | 必须等于 `PMW_PLUGIN_ID` |
| `plugin_version` | string | 插件版本 |
| `token` | string | 必须等于 `PMW_PLUGIN_TOKEN` |
| `api` | string | 清单 `api` 字段原文，例 `>=2.0.0 <3.0.0` |
| `capabilities` | string[] | 可选能力（如 `http.stream`、`ws`），不支持就传 `[]` |

宿主校验通过后回 `host.welcome`（result）：

```json
{
  "protocol": "pmw-plugin-rpc/1",
  "host": { "pmw_version": "0.3.0", "api_version": "2.0.0", "os": "darwin", "arch": "arm64" },
  "plugin": { "id": "hello_world", "version": "0.1.0" },
  "limits": { "max_message_bytes": 8388608, "max_concurrent_requests": 8, "default_timeout_ms": 30000 },
  "permissions": ["objects:read", "notify"]
}
```

`permissions` 是用户**已授予**的权限（安装确认的非高风险项 + 装后单独授权的项；未授予的不出现）；它只用于展示/降级，不能替代服务端强制。

握手失败（协议版本不符、token 不符、id 不符、`api` 范围不含宿主 `ExternalAPIVersion`、首帧不是
`plugin.hello`）：宿主回 JSON-RPC error（`unavailable` 或 `validation`）后关闭连接并终止插件，
本次启用失败。插件应以非 0 退出码退出并打印原因。

握手成功后宿主发 `plugin.activate`；插件初始化完成再回结果，之后进入健康检查与运行。

## 4. 生命周期

```text
spawn → connect → plugin.hello / host.welcome → plugin.activate(≤10s)
      → plugin.health(超时 health_timeout_ms) → 运行
停用：前端 unregister → plugin.deactivate(≤10s) → SIGTERM → 5s → SIGKILL
崩溃：宿主按 1s / 2s / 4s 退避自动重启，最多 3 次；超过上限记 last_error 并停止，等用户手动启用
```

- `plugin.activate` 只做登记和轻量初始化，不做重活；10 秒内必须返回。
- `plugin.deactivate` 之后插件应尽快退出；宿主超时后 SIGTERM，再 5 秒 SIGKILL。
- 运行中崩溃会自动重启（最多 3 次），但插件应把关键状态落库；超过上限后宿主停止重启，等用户重新启用。
- 宿主重启后，已启用的插件重新走启用流程。
- 健康检查：宿主发 `plugin.health`，超时用清单 `health_timeout_ms`（默认 10s，最大 60s）；
  返回 `{ "status": "degraded", "detail": "..." }` 表示不健康。

## 5. Host → Plugin 方法

| 方法 | 类型 | 参数（要点） | 结果 | 说明 |
|---|---|---|---|---|
| `plugin.activate` | request | `{ reason, permissions }` | `{ ok }` | 启用；≤10s |
| `plugin.deactivate` | request | `{ reason, deadline_ms }` | `{ ok }` | 停用；≤10s，之后 SIGTERM/SIGKILL |
| `plugin.health` | request | `{ nonce? }` | `{ status: "ok"\|"degraded", detail? }` | 健康检查 |
| `plugin.http.request` | request | `{ request_id, method, path, query, headers, body_b64?, remote_addr?, stream? }` | `{ stream, status, headers, body_b64? }` | 宿主代理 `/api/plugins/external/<id>/api/*`（已实现；流式再用 `host.http.chunk/end`，seq 从 0 递增） |
| `plugin.http.upgrade` | request | `{ request_id, path, query, headers, protocols? }` | `{ stream_id }` | WebSocket 升级（P2） |
| `plugin.event.deliver` | request | `{ event: { type, at, payload } }` | `{ ok }` | 投递订阅事件；需要 `events:subscribe`（宿主异步投递，5s 超时） |
| `plugin.job.run` | request | `{ job, scheduled_at? }` | `{ ok }` | 宿主按 activate 时登记的后台任务调度 |
| `plugin.sop_node.execute` | request | `{ kind, params, context }` | `{ outputs }` | SOP 节点执行 |
| `plugin.schedule_action.run` | request | `{ kind, payload }` | `{ result }` | 定时任务动作 |
| `plugin.command.run` | request | `{ command, args? }` | `{ result }` | 命令面板命令（后端部分） |
| `plugin.skill.invoke` | request | `{ skill, input }` | `{ output }` | 技能调用 |
| `plugin.agent_tool.call` | request | `{ tool, arguments }` | `{ content }` | Agent 工具调用 |
| `plugin.permission_changed` | notification | `{ permissions }` | 无 | 权限授予/收回；立刻按新集合降级 |

只实现清单 `provides` 里声明过的扩展点对应的方法；其余方法不必实现，宿主不会调用（未知方法回
`method_not_found` 即可）。

## 6. Plugin → Host 方法

| 方法 | 参数（要点） | 结果 | 所需权限 |
|---|---|---|---|
| `host.objects.get` | `{ type, id }` | 对象 | `objects:read` |
| `host.objects.list` | `{ type?, query?, limit?, cursor? }` | `{ items, next_cursor? }` | `objects:read` |
| `host.objects.create` | `{ type, props, owner_id? }` | `{ id, revision }` | `objects:write`（来源记本插件） |
| `host.objects.update` | `{ id, props?, status? }` | `{ id, revision }` | `objects:write`（仅本插件创建的对象） |
| `host.contacts.get` / `list` | `{ id }` / `{ query?, limit?, cursor? }` | 联系人 / `{ items, next_cursor? }` | `objects:read` |
| `host.conversations.get` / `list` | `{ id }` / `{ limit?, cursor? }` | 会话 / `{ items, next_cursor? }` | `objects:read` |
| `host.store.query` | `{ sql, args? }` | `{ columns, rows }` | 隐式 `store:plugin`；只读、单条语句 |
| `host.store.exec` | `{ sql, args? }` | `{ rows_affected, last_insert_id? }` | 隐式 `store:plugin`；单条语句 |
| `host.events.publish` | `{ type, payload }` | `{ ok }` | 类型必须在 `emits` 里（已实现，经宿主事件总线分发） |
| `host.http.chunk` / `host.http.end` | `{ request_id, seq, data_b64? }` | `{ ok }` | 流式 HTTP 响应块/结束（seq 从 0 递增） |
| `host.ws.send` / `host.ws.close` | `{ stream_id, ... }` | `{ ok }` | WebSocket 回帧/关闭 |
| `host.http.request` | `{ method, url, headers?, body_b64?, timeout_ms?, stream? }` | 内联或流式（§6） | `network:<group>`（按域名匹配） |
| `host.secrets.get` / `set` / `delete` | `{ scope, value? }` | `{ value }` / `{ ok }` | `secrets:<scope>`（只能碰自己声明的 scope） |
| `host.fs.read` | `{ path, offset?, length? }` | `{ data_b64, eof }` | 对应 `fs:read:*`，路径必须在允许目录内 |
| `host.fs.list` | `{ path }` | `{ entries: [{ name, type, size? }] }` | `fs:read:*` |
| `host.fs.write` | `{ path, data_b64, mode? }` | `{ bytes }` | `fs:write:*`；`fs:write:any` 才允许任意路径 |
| `host.agent.run` | `{ prompt, preset_id?, tools?, timeout_ms? }` | `{ run_id, status, summary, result }` | `agent:run`；超时另配 |
| `host.notify` | `{ kind, title, body, level? }` | `{ id }` | `notify` |
| `host.schedules.enqueue` | `{ action, at, payload }` | `{ schedule_id }` | `schedule` |
| `host.artifacts.add` | `{ path, title, run_id? }` | `{ artifact_id }` | `artifacts:write` |
| `host.audit.record` | `{ action, detail }` | `{ id }` | `audit:write` |
| `host.settings.get` / `set` | `{ key }` / `{ key, value }` | `{ value }` / `{ ok }` | 隐式（本插件设置） |
| `host.i18n` | `{ key, lang?, vars? }` | `{ text }` | 隐式 |

### `host.store.*` 安全规则

只允许在宿主分配的私有库上执行；禁止 `ATTACH`/`DETACH`、跨库引用、事务控制语句（v0.1）、
DDL 之外的多语句拼接；参数一律走 `args`，宿主拒绝字符串拼接检测到的多语句。
**迁移走清单 `migrations` 目录**，不在运行时 `exec` DDL。

### 流式 HTTP / WS

普通 HTTP 代理默认内联：正文 ≤ 1 MiB（设计值）时一次带 `body_b64`。需要流式时：

| 场景 | 流程 |
|---|---|
| 宿主代理插件出网 `host.http.request` | request 先回 `{ stream_id, status, headers }`；插件随后发通知 `host.http.chunk { stream_id, seq, data_b64 }`，结束发 `host.http.end { stream_id }` |
| 宿主转发请求进插件 `plugin.http.request` | 同上，通知名为 `plugin.http.chunk` / `plugin.http.end` |
| WebSocket `plugin.http.upgrade` | 回 `{ stream_id }` 后双向用 `plugin.http.ws_message { stream_id, data_b64 }`，关闭用 `plugin.http.ws_close`（P2） |

`stream_id` 由发起响应的一方分配；`seq` 从 0 起严格递增；结束后不复用。

## 7. 错误码

| 名字 | JSON-RPC code | 何时用 | 可重试 |
|---|---|---|---|
| `parse_error` | -32700 | 帧不是合法 JSON | 否 |
| `invalid_request` | -32600 | 不是合法 JSON-RPC 2.0 对象 | 否 |
| `method_not_found` | -32601 | 方法未实现/拼错 | 否 |
| `invalid_params` | -32602 | 参数缺失/类型错 | 否 |
| `internal_error` | -32603 | JSON-RPC 层内部错误 | 视情况 |
| `permission_denied` | -32001 | 未声明或未确认 | 否（用户授权后） |
| `not_found` | -32002 | 对象/记录/文件不存在 | 否 |
| `validation` | -32003 | 参数语义不合法（含消息过大、SQL 被拒） | 否 |
| `conflict` | -32004 | 版本/id/迁移冲突 | 否 |
| `rate_limited` | -32005 | 并发/频率超限 | 是（退避） |
| `unavailable` | -32006 | 插件/宿主/依赖不可用、握手中断 | 是（有限） |
| `internal` | -32007 | 业务内部错误 | 视情况 |

每条错误必须带用户可读的 `message`（中文，可脱敏）；`data` 可以带字段路径、权限名等细节。
不得把凭证、绝对路径、SQL 原文回给前端。

`permission_denied` 的 `data`（设计）：`{ "permission": "objects:write", "declared": false, "granted": false }`。

## 8. 超时、大小与并发限额

| 项 | 默认 | 可配置 |
|---|---|---|
| 握手（首帧到 welcome） | 10s | 否 |
| `plugin.activate` | 10s | 否 |
| `plugin.deactivate` | 10s，之后 SIGTERM；再 5s SIGKILL | 否 |
| 健康检查超时 | 清单 `health_timeout_ms`（默认 10000，最大 60000） | 清单 |
| 宿主→插件动作超时 | 30s | 宿主 |
| `host.agent.run` 超时 | 另配（按 Agent 运行配置） | 宿主 |
| 单条消息 | 8 MiB | 宿主 |
| 每插件并发 in-flight 请求 | 8（每个方向） | 宿主 |
| 崩溃重启退避 | 1s / 2s / 4s，最多 3 次 | 宿主 |
| HTTP 内联正文上限 | 1 MiB（设计值） | 宿主 |

插件实现建议：给每个 `host.*` 调用包 `context.WithTimeout`（模板用 30s），不要无限等待。

## 9. 平台差异（Go 模板已处理）

| 平台 | 连接方式 | 注意 |
|---|---|---|
| macOS | `net.Dial("unix", PMW_PLUGIN_SOCKET)` | Unix socket 路径上限约 104 字节，宿主会放短路径；插件按环境变量原样连，不要拼路径 |
| Linux | 同上 | 路径上限约 108 字节 |
| Windows | 命名管道 `\\\\.\\pipe\\...` | Go 标准库没有专门 API；模板用 `os.OpenFile(sock, os.O_RDWR, 0)`（内部是 `CreateFile`），不需要 `go-winio`。连接会阻塞到宿主实例可用，模板在启动时直接连 |

构建：纯标准库、`CGO_ENABLED=0`，可以在 macOS 上交叉编译 Linux/Windows；模板的
`make build-all` 会一次构建发布矩阵。

## 10. Go 模板说明

模板 `assets/templates/main.go.tmpl` 结构（约 600 行，可整体替换，但保留握手/健康检查/退出）：

| 部分 | 作用 |
|---|---|
| `dialHost()` | 按平台连 `PMW_PLUGIN_SOCKET` |
| `rpcConn` | 换行分帧、请求/响应匹配、并发上限 8、写锁 |
| `hello()` | 发 `plugin.hello`，校验 `host.welcome` 的协议与 id |
| `server.handlers()` | `plugin.activate/deactivate/health/event.deliver/command.run/permission_changed` |
| `demoStoreQuery()` | `host.store.query` 示例（`SELECT 1 AS ok`，隐式权限） |
| `demoObjectsList()` | `host.objects.list` 示例（需要 `objects:read`；失败只告警，不阻断激活） |
| `handleCommand()` | `plugin.command.run` → `{ "result": "..." }`，顺带演示读对象 |
| `rpcErrorf()` | 语义错误名 → JSON-RPC 整数码 |

约定：

- **只实现清单 `provides` 声明过的东西**；模板生成后按需增删 handler。
- 权限失败要**优雅降级**：记日志、返回可用状态，不要循环重试（用户可能在设置里收回权限）。
- 不要在 `activate` 里做网络/磁盘重活；需要后台任务用宿主调度（`host.schedules.enqueue`，
  需要 `schedule` 权限）或 activate 后自己起 goroutine（记得在 deactivate 里停）。
- 日志写 stderr，`slog` 文本格式即可；不要在日志里打印 token。

## 11. 本地联调（P1-b 未实现部分之外都可装）

宿主还不支持外部插件，可以用一个最小 mock host 手工验证协议：

1. `make build` 构建本机二进制；
2. 起一个 Unix socket server（Python/Go 都行），把路径通过 `PMW_PLUGIN_SOCKET` 传给插件；
3. 按 §3 回应 `plugin.hello`，再依次发 `plugin.activate`、`plugin.health`、`plugin.command.run`；
4. 插件发来的 `host.store.query` / `host.objects.list` 要回一个合法 result，否则 activate 里会打警告；
5. 发 `plugin.deactivate`，确认插件退出码为 0。

`plugin-sdk` 的 `self-test` 不跑这一段（它只验证模板/清单/打包工具链）；协议回归建议单独写
mock host 脚本，放 CI 的 smoke job。**不要**为了本地联调在插件里硬编码 socket 路径或 token。
