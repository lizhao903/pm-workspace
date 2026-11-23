# 清单 v2（plugin.json）参考

> 状态：**草案 v0.1**。宿主安装器（`internal/pluginhost`，P1）与 `docs/plugin-spec-v2.md` 是最终依据；
> 本文是 `pmw-plugin-builder` skill 的速查，字段名、权限名、错误语义与规范保持一致。
> 本 skill 的 `validate` 实现了下面所有可以静态判定的规则。

## 1. 清单长什么样

包根必须有且只有一份 `plugin.json`，顶层 `additionalProperties: false`。
一个最小可发布的清单（和 `assets/templates/plugin.json.tmpl` 生成的一致）：

```json
{
  "manifest_version": 2,
  "id": "hello_world",
  "name": "Hello World",
  "description": "一句话说明",
  "version": "0.1.0",
  "api": ">=2.0.0 <3.0.0",
  "pmw": ">=0.3.0 <1.0.0",
  "license": "MIT",
  "homepage": "https://github.com/owner/pmw-plugin-hello",
  "repository": "https://github.com/owner/pmw-plugin-hello",
  "publisher": { "id": "github:owner" },
  "icon": "assets/icon.svg",
  "provides": {
    "modules": ["hello_world"],
    "settings": ["hello_world"],
    "today_cards": ["hello_world_tip"],
    "commands": ["hello_world.say_hi"]
  },
  "permissions": ["objects:read", "notify"],
  "permissions_reason": {
    "objects:read": "在模块页和今日卡片里展示最近对象标题",
    "notify": "点「打个招呼」时发一条演示通知"
  },
  "runtime": {
    "backend": {
      "kind": "process",
      "protocol": "pmw-plugin-rpc/1",
      "entry": {
        "darwin-arm64": "bin/hello_world-darwin-arm64",
        "linux-amd64": "bin/hello_world-linux-amd64",
        "windows-amd64": "bin/hello_world-windows-amd64.exe"
      },
      "health_timeout_ms": 10000
    },
    "web": { "entry": "web/entry.js", "styles": ["web/style.css"] }
  }
}
```

## 2. 字段逐项

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `manifest_version` | int | 是 | 固定 `2`。和 `api` 是两件事：它表示清单结构版本 |
| `id` | string | 是 | `^[a-z][a-z0-9_]{1,23}$`；全局唯一；不能是内核保留字（见 §3）；不能和内置插件 id 冲突（`browser domains etf im jobs projects recording sop terminal trade tts video`）；发布后不改 |
| `name` | string | 是 | 显示名，插件管理页用 |
| `description` | string | 否 | 一句话说明 |
| `version` | string | 是 | SemVer `MAJOR.MINOR.PATCH`，不支持预发布/`v` 前缀；升级、依赖匹配用 |
| `api` | string | 是 | 宿主外部插件 API 范围，必须包含 `2.0.0`，例 `>=2.0.0 <3.0.0` |
| `pmw` | string | 是 | PMW 产品版本范围，例 `>=0.3.0 <1.0.0` |
| `license` | string | 是 | SPDX 标识（`MIT`、`Apache-2.0`…）；包内必须有 `LICENSE` |
| `homepage` | string | 否 | 项目主页 URL |
| `repository` | string | 是 | v0.1 只接受 `https://github.com/<owner>/<repo>` |
| `publisher` | object | 否 | `{ "id": "github:owner", "key": "<ed25519 公钥 base64>" }`；没有 `key` 即未签名 `community` |
| `icon` | string | 否 | 包内相对路径（如 `assets/icon.svg`），不允许远程 URL；≤ 256 KiB |
| `provides` | object | 否 | 注册的扩展点 id，按分组；规则见 §4 |
| `permissions` | string[] | 是 | 申请的可选权限，可为 `[]`；隐式权限不写；见 `permissions-security.md` |
| `permissions_reason` | object | 是 | 每项权限一条 1–80 字中文理由，缺一项即非法；没有权限写 `{}` |
| `runtime` | object | 是 | `backend` / `web` 至少一个；子字段见 §5 |
| `depends` | object | 否 | 强依赖：`{ "插件 id": "版本范围" }`；目标必须是外部插件 |
| `optional_depends` | object | 否 | 弱依赖：装了就联动，没装也能用 |
| `emits` | string[] | 否 | 本插件发布的事件，必须以 `<id>.` 开头 |
| `subscribes` | string[] | 否 | 订阅的事件；非空必须声明 `events:subscribe` 权限，反之声明了就必须有订阅 |
| `migrations` | string | 否 | 插件私有库的 SQL 迁移目录（包内相对路径），只作用于宿主分配的私有库 |

### 禁止的 v1 字段

| v1 字段 | v2 做法 |
|---|---|
| `core` | 用 `api` + `pmw` |
| `adopts` | 外部插件不能认领内核已有对象类型/路由 |
| `table_prefix` | 外部插件没有内核表前缀；数据只能进私有库，经 `host.store.*` 访问 |
| `icons` | v0.1 只有单一 `icon` 文件 |

未知顶层字段直接报错，不静默忽略。

## 3. 版本范围语法

与 `internal/plugin/semver.go` 的 `ParseRange` 一致：

| 写法 | 意思 |
|---|---|
| `>=2.0.0 <3.0.0` | 空格分隔，同时满足 |
| `^2.0.0` | `>=2.0.0 <3.0.0`；`^0.3.0` 是 `>=0.3.0 <0.4.0` |
| `~2.0.0` | `>=2.0.0 <2.1.0` |
| `2.0.0` | 精确版本 |

不支持 `||`、`*`、`x`、预发布标签、`v` 前缀。比较运算符可以省略后两段（`>=1.2` 按 `>=1.2.0` 处理），
但 `^`、`~`、精确版本必须写全三段。清单里推荐写全。

## 4. `provides` 分组

| 键 | 值规则 | 对应前端槽位（`frontend.md`） |
|---|---|---|
| `modules` | `^[a-z][a-z0-9_]*$`；有它必须有 `runtime.web` | `module` |
| `settings` | 同上 | `settings.section` |
| `object_types` | 等于 `<id>` 或以 `<id>_` 开头 | `object.section` |
| `connectors` | 全局命名空间（不加前缀）；至少声明一项 `network:*` 权限 | 无（后端） |
| `skills` | 以 `sk_` 开头 | 无（后端） |
| `agent_tools` | 以 `<id>_` 开头 | 无（后端） |
| `sop_nodes` | 以 `<id>_` 开头，目录评审单独说明 | 无（后端） |
| `today_cards` | 以 `<id>_` 开头 | `today.card` |
| `commands` | `<id>.<动作>` | `command` |
| `search` | `^[a-z][a-z0-9_]*$` | 无（后端） |
| `schedule_actions` | 以 `<id>_` 开头，目录评审单独说明 | 无（后端） |

规则：清单里列出的 id 必须由代码真的注册（前端槽位/后端 handler）；**代码注册了但没在清单列出，宿主拒绝注册**。
两份清单（文件 + 代码）不一致是评审重点。

## 5. `runtime`

### backend（子进程 + `pmw-plugin-rpc/1`）

| 字段 | 必填 | 规则 |
|---|---|---|
| `kind` | 是 | 固定 `process` |
| `protocol` | 是 | 固定 `pmw-plugin-rpc/1` |
| `entry` | 是 | 平台键 → 包内相对路径；键匹配 `^(darwin\|linux\|windows)-(amd64\|arm64)$`；至少一项；Windows 值允许 `.exe` |
| `health_timeout_ms` | 否 | 健康检查超时，默认 10000，范围 100–60000 |

平台键和 CI 构建矩阵对应；发布检查强制每个 Release 至少覆盖 `darwin-arm64` + `linux-amd64`（建议加 `windows-amd64`）。
源码仓库本地开发只需当前平台产物；安装包只带目标平台那一个二进制，但清单可以列多个平台。

### web（运行时 ESM）

| 字段 | 必填 | 规则 |
|---|---|---|
| `entry` | 是 | ESM 入口，包内相对路径，例 `web/entry.js` |
| `styles` | 否 | 额外样式文件，包内相对路径 |

入口之外的相对 import 允许（chunk 要一起打包/发布）；裸模块只能 import import map 里的 `react` 系列。

## 6. 校验规则（`pmw_plugin.py validate` 做了什么）

1. **JSON**：可解析、UTF-8、顶层对象、无未知/禁止字段。
2. **必填与类型**：见 §2；`manifest_version` 必须严格等于整数 2。
3. **id**：正则 + 内核保留字（照抄 `internal/plugin/manifest.go` 的 `ReservedIDs`）+ 内置插件 id 冲突。
4. **版本**：`version` SemVer；`api`/`pmw` 范围语法；`api` 必须包含宿主 API `2.0.0`。
5. **权限**：枚举（含 `secrets:<scope>`）+ 重复检查；隐式权限报错；`trade:live` 给警告（v0.1 不授予、评审不接受，`--strict` 下失败）；
   `permissions_reason` 与 `permissions` 一一对应，理由 1–80 字（无中文给警告）。
6. **provides**：分组键白名单、值正则、前缀规则、每组内唯一；`modules` → `runtime.web`；
   `connectors` → 至少一项 `network:*`。
7. **runtime**：至少一个形态；backend 的 kind/protocol/entry 平台与文件；web 的入口/样式文件；
   `health_timeout_ms` 范围。
8. **一致性**：`subscribes` ↔ `events:subscribe`；`depends` 目标不是内置插件；`migrations` 目录。
9. **文件存在**：清单引用的 icon、web 入口与样式、后端二进制、迁移目录都必须真的在包里。
   安装/解包后的目录用 `validate --platform <goos>-<goarch>` 只检查目标平台。
10. **包级提示**：缺 `LICENSE`、缺 `README.md` 给警告。

`--strict` 把警告也当错误。发布/CI 用严格模式。

## 7. 内核保留字（照抄代码，勿手改）

`api admin agent agent_providers agents artifacts audits categories connectors contacts conversations core counts dict_items dictionaries events fs health hooks incident incidents kernel knowledge_bases library links notifications objects object_types plugins revisions runs schedules sessions settings shortcut_groups shortcuts skills stakeholders stats tags tasks today webhooks workspaces`

代码与 `docs/plugin-api.md` 1.4 的文档表完全一致（44 个），以代码为准。

## 8. 常见错误

| 报错 | 原因 / 修法 |
|---|---|
| `是内核保留字` | 换 id；不要用 `settings`、`plugins`、`tasks` 这类名字 |
| `is 未知字段` | 清掉 v1 字段（`core`/`adopts`/`table_prefix`/`icons`）或拼写错误 |
| `api 不包含当前宿主插件 API 版本` | 写 `>=2.0.0 <3.0.0` |
| `权限 X 缺少中文理由` | 每个权限在 `permissions_reason` 补一条 1–80 字理由 |
| `provides.modules 不为空时必须提供前端入口` | 加 `runtime.web`，或删 `modules` |
| `文件不存在：bin/...` | 先 `make build-all`；或删掉没构建的平台入口 |
| `subscribes 非空时必须声明 events:subscribe 权限` | 补权限 + `permissions_reason`，或删订阅 |
