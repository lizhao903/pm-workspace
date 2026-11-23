# PMW 外部插件开发者指南（草案 v0.1）

> 2026-11-13 · 面向第三方插件开发者（以及替你写代码的 AI agent）的实操指南。
>
> **能力边界（先看，别误解）**：P1-a 起已经能装进真实 PMW（需 PMW ≥ 0.3.0）：本地目录 / `pack` 的 tar.gz / GitHub Release，安装后子进程运行、前端运行时加载、设置页可启停/卸载。**未实现（P1-b）**：源码构建、Windows 命名管道；事件投递、高风险权限装后授权、升级/回滚、市场索引发现、HTTP/WS 代理、开发者目录、可选 ed25519 签名已实现（2026-11）。本文讲 PMW 自己的外部插件（PMW Plugin 2.0），与 [docs/dsh-plugin-adaptation.md](dsh-plugin-adaptation.md)（把 PMW 整体包成 DSH 插件）是两件事。
>
> 配套：规范 [docs/plugin-spec-v2.md](plugin-spec-v2.md)、Schema [docs/plugin-manifest-v2.schema.json](plugin-manifest-v2.schema.json)、方案 [docs/plugin-community-plan.md](plugin-community-plan.md)、工具包 [`plugin-sdk/`](../plugin-sdk/README.md)（以上 P0 同批交付）、内置插件 API 1.x [docs/plugin-api.md](plugin-api.md)。

---

## 1. 读者与前置

**适合你**：想给 PMW 加一个功能（今日卡片、工作台模块、设置分节、命令……），愿意用 Go 或 TypeScript 写代码，接受“第三方插件默认不可信、权限逐项确认（高风险装后单独授权）”。
**不适合你**：想改 PMW 内核、往主库加表、绕开宿主直读 PMW 的 SQLite/凭证——这些一律不允许。

| 前置 | 说明 |
|---|---|
| GitHub 账号 | 插件以 GitHub 仓库 + Release 分发；发布走 Actions；索引 PR 要用 |
| Go 1.22+ | 后端 sidecar 模板与构建（模板 `go.mod` 最低 1.22；PMW 主仓自用 1.25，不影响插件；协议语言无关） |
| Node 22+ | 前端 ESM 构建（React 19 由宿主提供；演示模板只用 JS 语法子集，可先不装 Node） |
| Python 3.9+ | 跑 `plugin-sdk/.../scripts/pmw_plugin.py`（只用标准库，不联网） |
| `plugin-sdk/` | skill、模板、校验脚本、hello-world 示例（本仓库或分发副本） |
| AI coding agent（可选） | DSH / Claude Code / Cursor；装 §2.1 的 skill 后按第 10 节 prompt 生成 |

**不需要**读 PMW 内核代码、不需要把 PMW 源码一起编译、不需要理解 `internal/plugin` 的第一方实现。你只需要遵守三份契约：**清单 v2 + `pmw-plugin-rpc/1` 协议 + 前端 ESM 契约**。

版本口径：清单 `manifest_version: 2`；宿主 API `api: ">=2.0.0 <3.0.0"`；PMW 应用 `pmw: ">=0.3.0 <1.0.0"`。第一方 1.x 的字段（`core`、`adopts`、`table_prefix`）在 v2 外部插件里**禁止出现**。

---

## 2. 10 分钟上手

目标：装好 skill，让 agent（或你自己）产出一个能通过 `validate` + `self-test` + `pack` 的骨架，拿到 `dist/<id>-<version>-<os>-<arch>.tar.gz` 与 `SHA256SUMS`。

### 2.1 第 1 步：安装开发者 skill

在 PMW 仓库根目录执行（`--dest DIR` 显式装到 `DIR/pmw-plugin-builder`；缺省按脚本顺序自动选）：

```bash
bash plugin-sdk/install-skill.sh --dest ~/.dsh/skills
# 或 Claude Code： bash plugin-sdk/install-skill.sh --dest ~/.claude/skills
# 或跨 agent：   bash plugin-sdk/install-skill.sh --dest .agents/skills
```

支持的位置（按 `plugin-sdk/install-skill.sh` 实际顺序；`--dest` 可覆盖）：

| 位置 | 适用 |
|---|---|
| `~/.dsh/skills/` | 当前用户所有 DSH 会话（脚本默认首选） |
| `~/.claude/skills/` | Claude Code 用户技能目录 |
| `~/.agents/skills/` | 当前用户跨 agent |
| `<repo>/.agents/skills/` | 当前 PMW 仓库的跨 agent 技能根（排在用户目录之后） |
| `--dest DIR` | 显式指定，装到 `DIR/pmw-plugin-builder` |

装好后 agent 里应出现 `pmw-plugin-builder`，它会引导按 `init → 实现 → validate → self-test → pack → install-check → 发布检查` 走。

### 2.2 第 2 步：让 AI agent 生成插件

把 [§10.2 生成插件 prompt](#102-生成插件-prompt) 的槽位填好发给 agent。最小示例：

```text
按 pmw-plugin-builder skill 给我做一个 PMW 外部插件：id 用 hello_world，
在今日页加一张“你好”卡片，数据只要一句本地固定文案，不要任何权限。
验收：validate、self-test、pack 全部通过。非目标：不发布、不接网络。
```

agent 会先读 skill 与 spec，再调 `pmw_plugin.py init`。**不要让它跳过 skill 自带的校验命令。**

### 2.3 第 3 步：自己跑一遍校验与打包

在 PMW 仓库根目录（子命令语义见 [docs/plugin-spec-v2.md](plugin-spec-v2.md) 与 `plugin-sdk/`；**具体 flag 以 `pmw_plugin.py --help` 及各子命令 `--help` 为准**，脚本有出入时以脚本为准并反馈维护者）：

```bash
# 0) 定义脚本路径（后续命令复用）
PMW_PLUGIN=plugin-sdk/skill/pmw-plugin-builder/scripts/pmw_plugin.py

# 1) 生成骨架（写 plugin.json、后端/前端源码、Makefile、CI 模板）
python3 "$PMW_PLUGIN" init ./pmw-plugin-hello-world \
  --id=hello_world --name="Hello World" --owner=your-github-name

# 2) 补产物：init 默认已用 Go 构建三平台后端（用了 --no-build 就先 make build-all）；前端入口用 make web 生成
cd ./pmw-plugin-hello-world && make web && cd ..

# 3) 校验清单：schema/语义/权限理由/平台 entry/文件存在
python3 "$PMW_PLUGIN" validate ./pmw-plugin-hello-world

# 4) 自检：临时目录生成样例 → validate → pack → 解包检查，退出码 0/1
python3 "$PMW_PLUGIN" self-test

# 5) 打包：dist/<id>-<version>-<os>-<arch>.tar.gz 与 SHA256SUMS
python3 "$PMW_PLUGIN" pack ./pmw-plugin-hello-world

# 6) 探测宿主（P0 阶段预期“不支持外部插件”，退出码 0，不算失败）
python3 "$PMW_PLUGIN" install-check ./pmw-plugin-hello-world --pmw-url http://127.0.0.1:7796
```

验收标准：`validate`/`self-test` 退出码 0；`dist/` 有当前平台压缩包与 `SHA256SUMS`，`shasum -a 256 -c SHA256SUMS` 通过；包内顶层是 `plugin.json`、`bin/`、`web/`、`assets/`、`LICENSE`（不含 `docs/`、`Makefile` 等源码文件）。

---

## 3. 插件仓库目录与职责

一个 GitHub 仓库 = 一个插件包；发布产物与源码仓库同构（构建生成物除外）：

```text
pmw-plugin-weather-card/          # 源码仓库（GitHub 仓库根）
├── plugin.json                   # 唯一清单，manifest_version: 2
├── main.go / go.mod              # 后端源码（纯标准库，模板生成）
├── migrations/0001_init.sql      # 可选，SQL；只作用于插件自己的库
├── assets/icon.svg               # 图标，包内相对路径
├── bin/<id>-<os>-<arch>          # 构建产物：各平台 sidecar（Windows 加 .exe）
├── web/entry.ts → web/entry.js   # 前端源码构建为运行时 ESM；web/style.css 为作用域样式
├── README.md                     # 安装、权限、配置说明（模板生成在仓库根）
├── CHANGELOG.md                  # 版本变更（模板生成，Keep a Changelog 风格）
├── LICENSE                       # SPDX 许可证全文；不允许“无许可证”分发
├── Makefile / scripts/pmw_plugin.py  # 构建入口与本地校验/打包工具
└── .github/workflows/release.yml # 三平台构建 + SHA256SUMS + Release
```

| 路径 | 进源码仓库 | 进发布产物 | 职责 |
|---|---|---|---|
| `plugin.json` | 是 | 是 | 唯一清单：id、版本、兼容范围、权限与理由、`provides`、`runtime` |
| `bin/<id>-<os>-<arch>` | 可选（建议不提交） | 是 | 预编译 sidecar；按 `GOOS-GOARCH` 命名 |
| `web/entry.js`、`web/*.css` | 可选（建议构建生成） | 是 | 运行时 ESM 与样式；不许自带 React |
| `assets/icon.svg` | 是 | 是 | 插件图标，`plugin.json` 的 `icon` 指向它 |
| `migrations/*.sql` | 是 | 是 | 只对插件自己的 SQLite 生效；升级前宿主备份 |
| `README.md`、`CHANGELOG.md` | 是 | 否 | 面向用户与评审的说明、变更记录 |
| `LICENSE` | 是 | 是 | SPDX 许可证；Release 资产也带 |
| `Makefile`、`scripts/pmw_plugin.py`、`.github/workflows/` | 是 | 否 | 构建与发布入口（模板生成） |
| `SHA256SUMS` | 否（生成） | 是 | 发布时生成，安装时校验 |
| `SHA256SUMS.sig` | 否（生成） | 可选（**P2**） | ed25519 签名；`verified` 信任等级要求 |

安装产物只含 `plugin.json`、平台二进制、`web/`（入口 + 相对 import 的 chunk + 样式）、`assets/`、`migrations/`（若有）、`LICENSE`、`SHA256SUMS`；安装记录固定到 **release tag + commit SHA + 每个资产 SHA-256**，不跟分支漂移。

---

## 4. 开发循环

**P0（现在就能做）**：`改代码/清单 → make build（本地平台） → validate → self-test → pack → 检查 dist`。没有热加载、没有宿主可装，页面效果无法端到端验证；前端靠 mock `ctx` 的单测，后端靠 mock `host.*` 的协议单测。每次改完清单都重跑 `validate`：清单内的一致性问题（权限缺理由、平台 entry 缺失、`provides` 前缀/条件不满足等）会在这里被拦下；`provides` 与代码里真实注册是否一致属于运行时行为，`validate` 查不了，要靠宿主启用校验或评审确认。

**P1 后（待实现）**：

| 能力 | 形态 | 状态 |
|---|---|---|
| 本地开发目录直装 | `pmw --plugin-dev-dir <path>`（P1 flag，开发者模式，启动时重新加载） | 待实现 |
| 装到测试实例 | 设置 → 插件 →「外部插件」：GitHub Release / 本地 tar.gz / 本地目录；测试实例 `scripts/dev-instance.sh`（`127.0.0.1:7796`，团队共用、带日常数据，**禁止 reset**） | P1-a 已实现 |
| 查看日志/失败原因 | 插件管理页展示 `failed` 原因 + 宿主收集的 stderr | 待实现 |
| 升级/回滚 | 新版本资产 → 迁移 → 失败回滚，保留最近 2 个版本 | 待实现 |

P1 验收路径（届时按此自测）：安装 → 启用 → 目标页面出现 → 越权返回 `permission_denied` → 停用 → 卸载（默认保留数据）→ 升级 → 回滚。

---

## 5. 清单与权限要点

**规范全文见 [docs/plugin-spec-v2.md](plugin-spec-v2.md) 第 4 节，字段的静态规则由 [docs/plugin-manifest-v2.schema.json](plugin-manifest-v2.schema.json) 定义。** 下面是团队基线里逐字一致的 `plugin.json` 起点：

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
  "homepage": "https://github.com/owner/repo",
  "repository": "https://github.com/owner/repo",
  "publisher": { "id": "github:owner", "key": "<ed25519 公钥 base64，可选>" },
  "icon": "assets/icon.svg",
  "provides": {
    "modules": ["hello_world"],
    "settings": ["hello_world"],
    "today_cards": ["hello_world_tip"],
    "commands": ["hello_world.say_hi"],
    "skills": ["sk_hello_world"],
    "agent_tools": ["hello_world_search"],
    "object_types": ["hello_world_note"]
  },
  "permissions": ["network:localhost", "objects:read", "objects:write"],
  "permissions_reason": {
    "network:localhost": "读取本机演示服务",
    "objects:read": "展示当前任务标题",
    "objects:write": "把生成的笔记建成对象"
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

> 例中的 `publisher.key` 是占位符，不符合 schema 的 44 字符 base64 规则；不签名就删掉 key（`publisher` 只留 `id`，见 spec 附录 A），要签名就填真实 ed25519 公钥（`SHA256SUMS.sig` 是 P2 能力）。

必记规则：

- 必填：`manifest_version,id,name,version,api,pmw,license,repository,permissions,permissions_reason,runtime`；有 `description` 时至少 1 字。
- `id` 匹配 `^[a-z][a-z0-9_]{1,23}$`（最短 2 字符），不能是内核保留字（以 `internal/plugin/manifest.go` 的 `ReservedIDs` 为准，如 `today`、`tasks`、`objects`、`plugins`、`incidents`），也不能与内置插件 id 冲突（`browser`、`domains`、`etf`、`im`、`jobs`、`projects`、`recording`、`sop`、`terminal`、`trade`、`tts`、`video`），**全局唯一、发布后不改**；建议 `作者_功能` 前缀降低冲突。
- `version` 用 SemVer；`api`/`pmw` 用现有版本范围语法（`>=` `>` `<=` `<` `=` `^` `~`，空格分隔），**不支持 `||`、`*`、`x`、预发布标签**。
- **每个权限项都必须在 `permissions_reason` 有中文理由（1–80 字）**，说清“为什么需要”，不是复述权限名；缺理由清单非法。
- `repository` 只接受 `github.com` 的 https 仓库；`license` 用 SPDX 标识；`icon`、`runtime.*.entry`、`styles` 都是包内相对路径（不以 `/` 开头、不含反斜杠、不含 `..`）。
- 外部插件**禁止** `adopts`、`table_prefix`、`core`；`provides` 只允许 `modules, settings, object_types, connectors, skills, agent_tools, sop_nodes, today_cards, commands, search, schedule_actions`。
- `runtime.backend` 与 `runtime.web` 至少有一个；**有 `modules` 必须有 `runtime.web`**；`connectors` 必须至少声明一项 `network:*`；`subscribes` 非空必须有 `events:subscribe`，反之亦然。
- `runtime.backend.entry` 按 `^(darwin|linux|windows)-(amd64|arm64)$` 给；`health_timeout_ms` 允许 100–60000，默认 10000；发布检查强制 **darwin-arm64 + linux-amd64**，建议同时出 windows-amd64。

### 5.1 权限清单（v2）

隐式能力（不用写进 `permissions`，写进去反而非法）：`store:plugin`（宿主给的独立 SQLite）、`log:write`；另外自己的设置（`host.settings.*`）、数据/缓存目录、发布 `emits` 里声明的事件、`host.i18n` 也不需要额外权限。可申请的是：

| 权限 | 能做什么 | 风险 |
|---|---|---|
| `objects:read` / `objects:write` | 读内核对象；写只能建/改本插件创建的对象 | 普通 |
| `events:subscribe` | 订阅内核事件；事件类型写进清单 `subscribes` | 普通 |
| `fs:read:project` / `fs:write:project`、`fs:read:attachments` / `fs:write:attachments` | 读写项目目录 / 附件目录 | 普通 |
| `fs:read:any` / `fs:write:any` | 读写本机任意路径 | **高** |
| `network:localhost` / `network:im` / `network:media-platforms` / `network:github` / `network:market-data` / `network:model` / `network:exchanges` | 访问对应域名白名单 | 普通（`network:exchanges` 是否升高风险待 P1 安全评审） |
| `network:any` | 访问任意外网地址 | **高** |
| `process:spawn` | 起子进程 | **高** |
| `secrets:<scope>` | 取凭证保险箱对应范围，如 `secrets:im` | 普通 |
| `agent:run` | 调模型 / Agent / Claude Code | 普通 |
| `notify` / `schedule` / `artifacts:write` / `audit:write` | 通知、定时、产出物、审计写入 | 普通 |

高风险权限（`fs:write:any`、`network:any`、`process:spawn`）**安装/升级都不授予**：安全预览单独标出，装完在插件设置里由用户本人逐项单独申请 + 二次确认后才授予，可随时收回，未授予期间相关调用返回 `permission_denied`。**v0.1 外部插件一律不授予 `trade:live`（实盘）**，评审也不接受申请。未声明的能力不是“插件自觉不用”，而是 RPC 层直接返回 `permission_denied`。

---

## 6. 后端开发规范

后端是**独立子进程（sidecar）**，不是 Go `.so`、不是进程内 JS：宿主拉起进程，插件启动后连回宿主。第三方代码永不进 PMW 主进程（宿主侧 `internal/pluginhost` 计划新增，P1）。

### 6.1 协议：`pmw-plugin-rpc/1`

- JSON-RPC 2.0 + **换行分帧**；macOS/Linux 用 Unix domain socket，Windows 用 named pipe。
- 宿主是 socket server；插件是 client，启动后连接 `PMW_PLUGIN_SOCKET`（带 `PMW_PLUGIN_TOKEN`）。
- 握手（10s 内）：插件发 `plugin.hello`（`protocol`、`plugin_id`、`plugin_version`、`token`、`api`、可选 `capabilities`）→ 宿主回 `host.welcome`（`protocol`、`host`、`plugin`、`limits`、已授予 `permissions`）；协议/token/id/api 任一不符即失败，插件退出非 0，由宿主标记 `failed`。
- 单条消息 ≤ **8 MiB**（二进制走 base64）；HTTP 内联正文默认 ≤ **1 MiB**，超出走流式；每插件每方向并发请求默认 **8**；普通宿主调用超时 **30s**（`agent.run` 另配）；超限返回 `validation` / `rate_limited`。完整帧格式、方法参数与超时表见 spec 第 7 节与 [plugin-sdk 的 references/backend.md](../plugin-sdk/skill/pmw-plugin-builder/references/backend.md)（P0 同批交付）。

### 6.2 环境变量（白名单，宿主注入）

```text
PMW_PLUGIN_ID              PMW_PLUGIN_VERSION        PMW_PLUGIN_API_VERSION
PMW_PLUGIN_SOCKET          PMW_PLUGIN_TOKEN          PMW_PLUGIN_DATA_DIR
PMW_PLUGIN_CACHE_DIR       PMW_PLUGIN_LOG_LEVEL      PMW_PLUGIN_OS
PMW_PLUGIN_ARCH
```

工作目录 = 插件包目录。**不继承**宿主的 vault/凭证/DB 路径变量；不要探测白名单外的环境变量。

### 6.3 方法表

Host → Plugin（命名空间 `plugin.*`）：`plugin.activate`、`plugin.deactivate`、`plugin.health`、`plugin.http.request`、`plugin.http.upgrade`、`plugin.event.deliver`、`plugin.job.run`、`plugin.sop_node.execute`、`plugin.schedule_action.run`、`plugin.command.run`、`plugin.skill.invoke`、`plugin.agent_tool.call`、`plugin.permission_changed`。

Plugin → Host（命名空间 `host.*`，按权限放行）：

| 分组 | 方法 |
|---|---|
| 对象/联系人/会话 | `host.objects.get/list/create/update`、`host.contacts.*`、`host.conversations.*` |
| 数据 | `host.store.query`、`host.store.exec` |
| 事件/HTTP | `host.events.publish`、`host.http.request` |
| 凭证/文件 | `host.secrets.get/set/delete`、`host.fs.read/list/write` |
| Agent/通知/调度 | `host.agent.run`、`host.notify`、`host.schedules.enqueue` |
| 产出/审计/设置/i18n | `host.artifacts.add`、`host.audit.record`、`host.settings.get/set`、`host.i18n` |

**协议是规范，SDK 是助手**：P0 模板给最小 Go 骨架（`plugin-sdk/skill/pmw-plugin-builder/assets/templates/main.go.tmpl`）；正式 Go SDK（`plugin-sdk/go`）计划新增（P1）；Node/Python 也可按协议实现（P4）。不要直连宿主内部接口或自造方法名。`host.store.*` 只允许在宿主分配的私有库上执行：单条语句、参数走 `args`，禁止 `ATTACH`/跨库引用/事务控制，运行时不要 `exec` DDL（迁移只走清单 `migrations`）。

### 6.4 生命周期与错误

`activate`（≤10s）→ 首次健康检查（≤5s，失败只告警）→ 运行（每 30s 复查，连续 3 次失败杀进程）；停用先 `deactivate`（≤10s），再 SIGTERM，5s 后 SIGKILL。运行中崩溃按 1s/2s/4s 自动重启，最多 3 次；超过上限记 `last_error` 并停止，等用户手动启用。插件仍应把关键状态落库，不要依赖自动恢复。

错误码分两层，每条都必须带用户可读 `message`（不得把凭证、路径、SQL 原文回给前端）：

- JSON-RPC 层：`parse_error`（-32700）、`invalid_request`（-32600）、`method_not_found`（-32601）、`invalid_params`（-32602）、`internal_error`（-32603）。
- 业务层：`permission_denied`（-32001，未声明/未确认）、`not_found`（-32002）、`validation`（-32003，参数不合法/超限/SQL 被拒）、`conflict`（-32004，版本/id/迁移冲突）、`rate_limited`（-32005，退避重试）、`unavailable`（-32006，有限重试）、`internal`（-32007）。

### 6.5 数据目录、迁移与日志

- 数据只放 `PMW_PLUGIN_DATA_DIR` / `PMW_PLUGIN_CACHE_DIR`（这两个目录内读写不需要 `fs:*`）；**插件不得在安装目录写文件**（安装目录按只读约定，OS 级只读 P1-b 再收紧）；读写走 `host.store.query` / `host.store.exec`。**不能**直连内核库、不能拿 `table_prefix`、不能读 vault（除非声明对应 `fs:*` 权限并经 `host.fs.*`）。
- `migrations/*.sql` 只作用于插件自己的库；已应用的迁移文件**不许改**，只能追加。P1-a 没有迁移前备份/失败回滚（P1-b 补），破坏性迁移（删列/删表）必须在评审里单独说明并先让用户备份。
- 日志写 stderr，由宿主按 `PMW_PLUGIN_LOG_LEVEL` 收集到 `<data>/external-plugins/logs/<id>.log`（P1-a 无轮转/限速）；结构化、带 `plugin_id`；**禁止打印 token、密钥、用户隐私字段**。

---

## 7. 前端开发规范

前端是**运行时 ESM**，由宿主 `import()` 加载，不是构建期打包进 PMW 的 bundle。

- 入口 `web/entry.js`（ESM）**同步调用一次** `window.__PMW_PLUGIN__.register({ id, api, activate(ctx), deactivate() })`；`api` 必须与清单一致，宿主校验兼容后才登记；重复注册、id 不符、api 不兼容直接拒绝。
- 宿主注入 import map：`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime` 指向宿主同一份 **React 19**。**插件 bundle 不许自带 React/ReactDOM，也不许从 CDN 加载。**
- 加载路径：`import(/* @vite-ignore */ '/api/plugins/external/<id>/web/<web_entry>?v=<version>')`；资源同源 `/api/plugins/external/<id>/web/*`；样式走 `runtime.web.styles`；图标 `/api/plugins/external/<id>/icon`。入口之外只允许相对 import 同目录 chunk。
- 停用即 unregister + 卸载模块（页面刷新兜底）；前端异常不影响外壳。

`ctx` 能力（字段名以 spec 第 8 节为准）：

| 成员 | 用途 | 注意 |
|---|---|---|
| `ctx.id` / `ctx.version` / `ctx.apiVersion` | 插件与宿主版本信息 | 只读 |
| `ctx.slots.register(key, spec, Component)` | 注册槽位 | key 只能是 `module` / `settings.section` / `today.card` / `command` / `object.section`；返回 disposable |
| `ctx.ui` | 宿主组件与 `--pmw-*` 主题 token | **P1-b 才提供**；P1-a 只有主题变量（`ctx.theme`）可用 |
| `ctx.host.call(method, params)` | 调 `plugin.*`（本插件后端）或有限的 `host.*`（objects/settings/notify） | 权限按「声明 + 授予」校验；但同页恶意 JS 不是 broker 能硬隔离的，见下方边界说明 |
| `ctx.permissions.has(perm)` | 当前**已授予**的权限（安装确认的非高风险项 + 已单独授权项） | 只用于展示/降级，**不是授权依据** |
| `ctx.i18n` / `ctx.theme` | `{lang,t}`、`{mode,resolved,subscribe}` | 不硬编码中文；只用 token |
| `ctx.notify(payload)` / `ctx.openExternal(url)` | 发通知（需 `notify`）、打开 http(s) 外链 | 不要刷屏；不能打开本地文件/自定义协议 |

槽位与 `provides` 一一对应：`module`↔`modules`、`settings.section`↔`settings`、`today.card`↔`today_cards`、`command`↔`commands`、`object.section`↔`object_types`。扩展点 id 必须挂在插件自己的命名空间（module/settings 用 `<id>` 或 `<id>_...`，command 用 `<id>.<动作>`）。每个槽位渲染在该插件的错误边界内，组件抛错只影响这一块。

> **安全边界（P1-a 诚实说明）**：外部插件前端与宿主同页执行，没有 iframe/Worker 隔离；broker 拦的是未声明/未授予的能力，不能阻止同页恶意 JS 直接 `fetch` 本机 API 或借 URL 里的 id 调别的插件。硬隔离属 P2/P3。

硬约束：

- CSS 必须挂在 `[data-pmw-plugin="<id>"]` 下；禁止全局选择器、禁止覆盖 `html`/`body`、禁止读别的插件 DOM/CSS；颜色用 `--pmw-*` token，字面色只用于插画。
- 文案走 `ctx.i18n`，中英文案齐备；可访问性：键盘可达、对比度、按钮有可读标签。
- 禁止：加载远程脚本/字体/图片、`data:`/`blob:` 可执行脚本、`eval`/`new Function`/`setTimeout(string)`/`document.write`、往 `document.body` 追加第二个应用、把插件状态写进别的插件/内核。
- 构建：ESM 输出、上述 4 个共享模块全部 external、不自带路由；`web/` 是构建产物，源码位置自定（模板给出现成构建配置）。

---

## 8. 测试要求

**必须做（P0 就能做）**：

1. 清单/骨架自检：`validate` + `self-test` + `pack` 全绿，产物解包内容正确。
2. 后端单测：协议帧编解码、`plugin.hello`/`host.welcome` 握手、正常 `host.*` 调用、权限缺失返回 `permission_denied`、超时与 8 MiB 上限处理。
3. 前端单测：mock `ctx`（slots/host.call/i18n/theme），覆盖注册、卸载清理、空数据/错误态、权限降级。
4. 安全用例：未声明权限、路径越界（`../`、绝对路径）、超限请求、非法版本范围。

**P1 后补（待实现）**：手工验收——安装 → 启用 → 页面出现 → 权限拒绝提示 → 停用 → 卸载（默认保留数据）→ 升级 → 回滚；崩溃自动重启后状态恢复；重启 PMW 后启用状态与前端资源仍正确。

---

## 9. 发布流程

1. **版本 bump**：改 `plugin.json` 的 `version`（SemVer）+ `CHANGELOG.md`（Keep a Changelog：Added/Changed/Fixed/Security），tag 与清单版本一致。破坏性变更升 MAJOR，写清迁移步骤。
2. **本地门禁**：`validate` → `self-test` → `pack`，解包自检 + `SHA256SUMS` 校验。
3. **CI 平台矩阵**（`.github/workflows/release.yml`）：spec 强制 `darwin-arm64` + `linux-amd64`，建议同时出 `windows-amd64`；静态链接（`CGO_ENABLED=0`）优先；前端构建；每平台调 `pack`。
4. **校验和**：生成 `SHA256SUMS`（覆盖每个平台压缩包）；P2 起可选 ed25519 签名 `SHA256SUMS.sig`，私钥放 CI secret，**永不进仓库**。
5. **打 tag + Release**：tag `v<X.Y.Z>`（不可变，不改已发布 tag）；资产 = 各平台 `.tar.gz` + `SHA256SUMS`（+ `.sig`）；说明写权限变化、兼容范围、验证方式。
6. **索引 PR（P3 待实现）**：向社区索引仓库提 PR，附仓库、版本、权限与理由、许可证、`validate`/`self-test` 记录；索引格式 v1 见 spec 第 11 节。
7. **发布后验证**：重新下载 Release 资产 → `shasum -a 256 -c SHA256SUMS` → 解包确认 `plugin.json` 与二进制版本一致。

P1-a 起产物可以直接安装（PMW ≥ 0.3.0）；签名、索引、高风险授权仍属后续阶段，但“可发布包 + 权限声明”已是安装链路真正消费的输入，先把版本、commit、SHA-256 固定下来仍然必要。

---

## 10. 五类 prompt（可直接复制）

> skill 里的 `plugin-sdk/skill/pmw-plugin-builder/references/prompts.md` 收录了同类提示词的精简版（措辞不同）；需要最完整版本时以本节为准，两者有实质冲突以 spec 为准并反馈维护者。

### 10.1 系统提示 prompt

**用途**：给 AI coding agent 的常驻角色约束，粘在会话开头或 agent 的 system prompt。它规定“先读什么、能做什么、绝对不能做什么”。

```text
你是 PMW 外部插件开发者。PMW 是 Go 单体 + React 19 的本机应用；外部插件 = 独立子进程 + 运行时 ESM，不是编译进内核的第一方插件。

开始写代码前按顺序读：
1) docs/plugin-spec-v2.md（清单、权限、pmw-plugin-rpc/1、前端契约的唯一事实来源）
2) docs/plugin-manifest-v2.schema.json
3) plugin-sdk/skill/pmw-plugin-builder/SKILL.md 与 references/
4) docs/plugin-developer-guide.md（流程与检查清单）

硬性规则，违反任何一条就停下来说明，不要绕过：
- 清单只有 plugin.json，manifest_version 必须是 2；api = ">=2.0.0 <3.0.0"；pmw 建议 ">=0.3.0 <1.0.0"；id 匹配 ^[a-z][a-z0-9_]{1,23}$ 且不是内核保留字。
- permissions 只列真正需要的；每一项都要在 permissions_reason 写 1–80 字中文理由。高风险权限（fs:write:any、network:any、process:spawn）不得为图省事申请；v0.1 一律不申请 trade:live。
- 后端独立进程，只通过 pmw-plugin-rpc/1（JSON-RPC 2.0 + 换行分帧，Unix socket/named pipe）通信；握手 plugin.hello -> host.welcome；只调用宿主暴露的 host.* 方法。禁止直连内核 SQLite、读 vault、读白名单外环境变量、自己开网关。
- 数据只放 PMW_PLUGIN_DATA_DIR，读写走 host.store.query / host.store.exec；migrations/*.sql 只作用于插件自己的库。
- 前端 web/entry.js 是 ESM，调用 window.__PMW_PLUGIN__.register({ id, api, activate(ctx), deactivate() })；React/ReactDOM 由宿主 import map 提供，禁止打包或 CDN 引入；禁止远程脚本、eval/new Function、改 document.body、读别的插件 DOM。
- CSS 必须挂在 [data-pmw-plugin="<id>"] 下，只用 --pmw-* token；文案走 ctx.i18n，不硬编码中文。
- 不允许自造宿主 API、RPC 方法、权限名、清单字段。spec 没有但确实需要的，停下来报告缺什么，不要发明。
- 当前 P1-a：可以生成、validate、self-test、pack，并安装到 PMW ≥ 0.3.0（设置→插件→外部插件）。P1-b 的签名/WS/索引尚未实现，不要声称这些已完成。

每步输出：改了哪些文件、跑了哪条命令、退出码、下一步。
```

**使用示例**：把上面整段粘进 agent 的 system prompt；或作为对话第一段，紧跟一句“按这个规则，帮我实现天气卡片插件”。

### 10.2 生成插件 prompt

**用途**：从一句需求生成**完整可校验**的插件包。槽位必须填满，空槽会导致 agent 自己加权限、加字段。

```text
把下面需求实现为一个 PMW 外部插件，产出可通过 validate/self-test/pack 的完整插件包。

【目标】<一句话：用户能感知到什么>
【插件 id】<^[a-z][a-z0-9_]{1,23}$，非内核保留字，建议 作者_功能>
【页面位置】<模块页 / 设置分节 / 今日卡片 / 命令面板 / 对象详情区块，选一个或多个>
【数据与权限】<要读写什么；按最小权限列出 permissions 与逐项 permissions_reason>
【验收】<可观察结果 + 必须通过的命令>
【非目标】<明确不做的事，例如不联网、不做设置页、不发布>

执行要求：
1. 先跑 pmw_plugin.py init 生成骨架，再改代码，不要手写目录结构。
2. plugin.json 按 docs/plugin-spec-v2.md 第 4 节；provides 只列真实注册的扩展点，并与后端/前端注册代码逐一对应。
3. 后端（Go 模板）：启动后连 PMW_PLUGIN_SOCKET，发 plugin.hello、收 host.welcome；实现 plugin.activate/deactivate/health；数据访问只走 host.* 方法与 PMW_PLUGIN_DATA_DIR，每次调用都能对上声明的 permissions。
4. 前端（TS 模板）：构建出 web/entry.js；window.__PMW_PLUGIN__.register 注册；槽位 key 只用 module / settings.section / today.card / command / object.section；CSS 限定在 [data-pmw-plugin="<id>"]；复用宿主 --pmw-* token 与 ctx.i18n。
5. 写测试：后端覆盖正常路径 + 权限缺失；前端覆盖注册/卸载 + 空数据。
6. 完成后贴出 validate、self-test、pack 的命令与输出，列出 dist/ 文件。
7. 若 install-check 报“当前 PMW 版本不支持外部插件”，这是 P0 的正常结果，不要伪造安装成功。

输出顺序：目录树 -> plugin.json -> 后端代码 -> 前端代码 -> 测试 -> 三份校验输出 -> 未决问题。
```

**使用示例**（填好的版本见 [§14 附录](#14-附录给今日页加一张天气卡片完整走查)）：

```text
【目标】今日页出现一张天气卡片，显示当前城市温度和是否下雨
【插件 id】weather_card
【页面位置】今日卡片
【数据与权限】请求公开天气 API；权限 network:any（理由：天气 API 不在现有 network 组内）
【验收】validate、self-test、pack 退出码 0；卡片在没有数据时自动隐藏
【非目标】不做设置页、不做定位、不发布
```

### 10.3 评审插件 prompt

**用途**：提交前自检，或维护者评审索引 PR。要求**带证据**，输出分级结论，不许“感觉可以”。

```text
你是 PMW 外部插件的评审者。只读材料：plugin.json、源码、README、CHANGELOG、CI 配置、发布产物与 SHA256SUMS。依据 docs/plugin-spec-v2.md 和 docs/plugin-developer-guide.md 第 11 节检查清单。

逐项检查，每条给证据（文件:行号 或 命令输出）：
1. 清单：manifest_version=2；必填字段齐全；id 格式且非保留字；version 是 SemVer；api/pmw 范围写法合法；没有 adopts/table_prefix/core；provides 与代码注册一致；runtime 平台 entry 存在且与 bin/ 一致。
2. 权限：逐条核对 permissions_reason（1–80 字、说清用途）；是否最小权限；高风险权限是否真必要；是否存在未声明就调用的 host.*；是否申请 trade:live（红线，直接拒绝）。
3. 安全红线：硬编码密钥/token；静默外传数据；直连内核 DB/vault；后门或挖矿；混淆/压缩后端二进制；远程脚本/eval；绕过 broker 的旁路。
4. 协议：只用 pmw-plugin-rpc/1 的方法；错误码在 parse_error/invalid_request/method_not_found/invalid_params/internal_error 与 permission_denied/not_found/validation/conflict/rate_limited/unavailable/internal 内；有握手 10s、8 MiB、1 MiB 内联上限与超时意识；崩溃/退出可恢复。
5. 数据：迁移只动插件自己的库；升级有备份/回滚考虑；卸载默认保留数据的行为正确。
6. 前端：window.__PMW_PLUGIN__.register 正确；不自带 React；CSS 作用域；错误边界；i18n；可访问性；不改 document.body、不读别的插件 DOM。
7. 体验与文档：README 能照着跑；CHANGELOG 有本次变更；LICENSE 是 SPDX；权限理由普通用户能懂。
8. 发布：CI 覆盖 darwin-arm64 + linux-amd64（建议含 windows-amd64）；SHA256SUMS 与产物一致；Release 说明完整；索引条目字段齐全。

输出格式（按严重度分组，每条含证据与修复建议）：
- 必须修：会导致装不上、越权、数据损坏或触碰红线的
- 建议修：影响体验/可维护性的
- 观察：需要与 spec 对齐但当前无法判定的
不要修改文件；不要为了让评审通过而放宽任何规则。
```

**使用示例**：把插件仓库路径和上面整段一起发给 agent，补一句“逐条核对，`必须修` 里的问题直接给 patch，但不要改 `plugin.json` 的权限声明之外的文件”。

### 10.4 发布插件 prompt

**用途**：从本地通过校验的代码到 GitHub Release + 索引 PR。强调不可变 tag、三平台、校验和、签名占位。

```text
给 PMW 外部插件 <id> 发布版本 v<X.Y.Z>。当前已通过 validate/self-test/pack。

执行步骤：
1. 版本：更新 plugin.json 的 version；在 CHANGELOG.md 写条目（Added/Changed/Fixed/Security，破坏性变更标注 BREAKING 与迁移步骤）。
2. 构建：确认 .github/workflows/release.yml 覆盖 darwin-arm64、linux-amd64、windows-amd64；Go 静态构建（CGO_ENABLED=0），前端产出 web/；每平台跑 pmw_plugin.py pack。
3. 校验和：生成 SHA256SUMS；若 P2 签名可用，用 ed25519 生成 SHA256SUMS.sig（私钥只在 CI secret，不提交）。
4. 打 tag：git tag v<X.Y.Z> 并推送；tag 不可变，不许重打或覆盖 Release 资产。
5. Release：上传各平台 .tar.gz + SHA256SUMS（+ .sig）；说明包含版本、兼容范围（api/pmw）、权限变化、验证命令。
6. 索引 PR（P3 流程）：按索引格式 v1 生成条目（id、标题/描述、repository、categories、该版本的 api/pmw、source.tag/commit、各平台资产 URL+sha256、permissions）；附 validate/self-test 结果、LICENSE、权限理由。
7. 验证：重新下载 Release 资产，shasum -a 256 -c SHA256SUMS，解包检查 plugin.json 版本。

禁止：改写已发布 tag；上传未校验产物；把私钥/secret 写进仓库或日志；跳过 CHANGELOG。
输出：Release 链接、资产清单与 SHA-256、索引 PR 链接、遗留风险。
```

**使用示例**：“按发布 prompt 给 weather_card 发 v0.1.0；三平台都出，先不签名（P2 未做）；索引 PR 只生成条目文本，不实际提 PR。”

### 10.5 升级 / 兼容 prompt

**用途**：宿主 API 升版或插件自身大版本升级时，保证兼容、可回滚、用户可感知。

```text
把 PMW 外部插件 <id> 从 <旧版本> 升级到 <新版本>，并处理与宿主 API 的兼容。

1. 兼容判断：对照 docs/plugin-spec-v2.md 第 9 节的 API 版本策略。宿主加字段/加扩展点 = MINOR；删字段/改语义/改签名 = MAJOR。按需更新 plugin.json 的 api 范围与 pmw 范围，不要无条件放宽到新 MAJOR。
2. 破坏性变更：在 CHANGELOG.md 标 BREAKING，写清旧版本用户如何迁移；弃用接口至少保留两个 MINOR 并给替代写法。
3. 数据迁移：只追加 migrations/*.sql，不改已应用文件；先在旧数据副本上跑一遍；升级前备份、失败自动回滚；回滚保留最近 2 个版本。
4. 前端兼容：ctx/slots 变化用兼容分支；不要为兼容旧宿主而引入远程代码或自带 React。
5. 权限：新增权限必须同步 permissions_reason 并在发布说明里单独列出（用户升级时确认非高风险新增项；高风险项不随升级授予，需装后单独申请）；不得借升级偷偷扩权。
6. 验证：validate/self-test/pack 全绿；用旧数据样本跑迁移；演练停用/回滚；检查依赖插件的版本范围。
7. 输出：兼容性结论（哪些宿主版本可用）、迁移步骤、回滚步骤、对用户的影响说明、需要维护者确认的新增权限。
```

**使用示例**：“把 weather_card 从 0.1.0 升到 0.2.0：新增设置分节，权限不变；宿主 api 仍是 >=2.0.0 <3.0.0；按升级 prompt 给出迁移与回滚步骤，不实际打 tag。”

---

## 11. 提交前检查清单

- [ ] `validate` 退出码 0；`self-test` 退出码 0；`pack` 产物通过 `SHA256SUMS` 校验
- [ ] `plugin.json`：`manifest_version: 2`；必填字段齐全；`api`/`pmw` 范围合法；没有 `adopts`/`table_prefix`/`core`
- [ ] `id` 符合 `^[a-z][a-z0-9_]{1,23}$`、非内核保留字、发布后不改
- [ ] 每个权限都在 `permissions_reason` 有 1–80 字中文理由；没有多申请；没有 `trade:live`
- [ ] `provides` 与后端/前端真实注册一致；有 `modules` 时 `runtime.web` 存在
- [ ] `runtime.backend.entry` 覆盖目标平台且文件存在（发布至少 darwin-arm64 + linux-amd64）
- [ ] 迁移只作用于插件自己的库，已应用文件没改；升级/回滚路径已想清楚
- [ ] 前端：`window.__PMW_PLUGIN__.register` 正确；无自带 React/CDN/远程脚本/`eval`；CSS 作用域；错误边界；i18n；可访问性
- [ ] 无硬编码密钥/token；敏感数据走 `host.secrets.*`；日志不打印隐私字段
- [ ] 源码仓库不含构建产物，未提交混淆/压缩的后端二进制
- [ ] README（安装/权限/配置）、CHANGELOG、LICENSE（SPDX）齐全
- [ ] CI 三平台构建 + `SHA256SUMS`；tag 与 Release 资产一致
- [ ] 索引 PR（P3）条目字段完整、权限与清单一致

---

## 12. 常见错误与排查

| 症状 | 常见原因 | 处理 |
|---|---|---|
| 页面白屏 / React hooks 报错 | 插件 bundle 自带了 React/ReactDOM | 构建时把 `react`、`react-dom`、`react-dom/client`、`react/jsx-runtime` 标为 external，交给宿主 import map |
| 宿主页面样式被改 | CSS 未加作用域，写了 `html`/`body`/全局选择器 | 所有样式挂到 `[data-pmw-plugin="<id>"]`，主题只用 `--pmw-*` token |
| 调用返回 `permission_denied` | 权限没写进清单，或安装了但没确认/没单独授权 | 补 `permissions` + `permissions_reason`，重装/升级时确认非高风险项；高风险权限到插件设置里单独申请 + 二次确认 |
| GitHub 历史里出现密钥 | 把 token/API key 写进源码或配置 | 立即吊销并轮换；改走 `host.secrets.get`，权限声明 `secrets:<scope>` |
| 插件启动即 `failed`，日志报迁移错 | SQL 语法错/改了已应用的迁移/破坏性操作 | 在旧库副本上复现；只能追加新迁移；升级前宿主备份，失败回滚 |
| 安装报 id 冲突或非法 | 用了内核保留字（`today`、`tasks`、`settings`…）或已被占用 | 换 `作者_功能` 形式的 id；发布后不可改 |
| Windows 上找不到二进制/路径错 | 清单里用了反斜杠或盘符；entry 名不匹配 `.exe` | 清单路径统一 `/`；`GOOS-GOARCH.exe` 命名；Go 里用 `filepath.Join` |
| `install-check` 说“不支持外部插件” | 目标 PMW < 0.3.0 或未开启外部插件 | 正常现象，不是插件问题；升级到支持版本（≥0.3.0）再装，退出码 0 即通过 |
| `validate` 报 `provides` 与代码不一致 | 注册了扩展点但没写清单，或反之 | 以清单为准补齐/删除注册代码，再跑 `validate` |
| 范围写法报错 | 用了 `\|\|`、`*`、`x` 或预发布标签 | 改成 `>=2.0.0 <3.0.0` 这类空格分隔范围 |
| RPC 超时/消息过大 | 单条消息 >8 MiB、内联正文 >1 MiB 或调用 >30s | 分批/流式，压缩传输，避免一次返回大数组 |
| 停用后定时器/监听还在 | `deactivate()` 没清理自己创建的资源 | 在 `deactivate` 里清理 timer、订阅、worker；宿主只撤注册，不替你清私有资源 |
| 评审被拒：提交了混淆/压缩的后端二进制 | 把构建产物（尤其混淆后的二进制）提交进源码仓库 | 源码仓库只放源码与 CI 配置，产物由 Actions 生成；这是评审红线 |

---

## 13. FAQ

- **必须会 Go / Node 吗？** 协议是规范，语言无关；但 P0 模板与首个 SDK 是 Go + TypeScript。你至少要能用其中一种产出预编译二进制 / ESM。Node/Python SDK 计划 P4。
- **现在能把插件装进 PMW 吗？** 能（P1-a）：PMW ≥ 0.3.0，在 设置 → 插件 → 外部插件 里选来源（GitHub URL / 本地目录 / tar.gz + 可选 sha256）→ 解析预览 → 确认权限 → 安装/启用。`install-check` 会先探测宿主能力；目标太老或没开外部插件时如实提示。
- **能直接 import PMW 的 Go 包 / 直连 SQLite 吗？** 不能。第三方代码不链接内核、不进主进程，也不承诺内核 ABI；所有能力都经 `pmw-plugin-rpc/1` 的 `host.*` 方法按权限代理。
- **前端能带 npm 依赖吗？** 可以打进 ESM bundle，但要自己承担体积与许可证；`react`/`react-dom` 必须 external。不允许加载远程脚本或 CDN。
- **需要签名吗？** P1 先用 SHA-256 + 公开源码 + 权限确认；签名（ed25519、`SHA256SUMS.sig`）是 **P2**，`verified` 信任等级要求签名验证通过。
- **插件升级会丢数据吗？** 不会因升级本身丢数据：插件有独立 SQLite，升级保留；迁移前备份，失败回滚旧版本。除非你的迁移自己删数据（评审会重点看）。
- **id 能改吗？能中文/大写吗？** 不能改，一经发布全局唯一；只能小写字母、数字、下划线，且不能是内核保留字。
- **谁来评审、多久？** P3 起走索引 PR + 维护者评审，第一版只收 `community` 级别；不接受无 SPDX 许可证的包（`official` 例外），本期不做插件内购/计费；评审 SLA 未定（见社区方案开放问题）。
- **为什么还要按发布流程走？** 发布链路（版本、commit、SHA-256、权限声明）是安装与信任的基础：P1-a 的安装器会固定 tag/commit/资产哈希并按清单确认权限；后续签名、索引、评审都建立在这套不可变产物上。

---

## 14. 附录：给今日页加一张天气卡片（完整走查）

目标产物：一个 `weather_card` 插件，从 prompt 到可发布包。以下命令均在 PMW 仓库根目录执行。

**① 输入需求（§10.2 填好槽位）**：目标 = 今日卡片；权限 = `network:any`（天气 API 不在现有 network 组，属高风险）；验收 = 三件套通过；非目标 = 设置页/定位/发布。

**② 生成骨架**

```bash
PMW_PLUGIN=plugin-sdk/skill/pmw-plugin-builder/scripts/pmw_plugin.py
python3 "$PMW_PLUGIN" init ./pmw-plugin-weather-card \
  --id=weather_card --name="天气卡片" --owner=your-github-name
```

生成后改三处：

- `plugin.json`：`provides.today_cards: ["weather_card_today"]`；`permissions: ["network:any"]`；理由“请求公开天气 API，展示今日温度与是否下雨”；`runtime` 平台 entry 与 CI 构建目标一致。
- 后端：实现 `plugin.activate/deactivate/health`；今日卡片取数走插件自己的 HTTP 接口——前端请求 `/api/plugins/weather_card/api/today`（宿主经 `plugin.http.request` 转发，P1 设计），后端再用 `host.http.request` 出网（受 `network:any` 约束），失败返回 `unavailable` 并在前端隐藏卡片。
- 前端：`window.__PMW_PLUGIN__.register` 注册；今日卡片组件用 `ctx.slots.register('today.card', { key: 'weather_card_today', title: '天气' }, WeatherCard)`，空数据时返回 `null`；样式限定 `[data-pmw-plugin="weather_card"]`。

> 演示用插件建议先用 `network:localhost` 接本机 mock（低风险、好评审）；真要接公网天气 API 再用 `network:any`，安装时不授予、启用后需在插件设置里单独申请 + 二次确认。

**③ 本地三件套**

```bash
cd ./pmw-plugin-weather-card && make web && cd ..
python3 "$PMW_PLUGIN" validate ./pmw-plugin-weather-card   # 预期退出码 0
python3 "$PMW_PLUGIN" self-test                             # 预期退出码 0
python3 "$PMW_PLUGIN" pack ./pmw-plugin-weather-card        # 产出 dist/
python3 "$PMW_PLUGIN" install-check ./pmw-plugin-weather-card --pmw-url http://127.0.0.1:7796
```

`install-check` 在支持外部插件的宿主（PMW ≥ 0.3.0，P1-a）上的预期输出：

```text
[install-check] 目标 PMW：http://127.0.0.1:7796
[install-check] 宿主已支持外部插件（检测到外部插件 API，api_version=2.0.0）。
[install-check] 本地安装：走「设置 → 插件 → 从 GitHub 安装」，或开发者模式链接本地目录。
[install-check] 已生成可发布包：
  dist/weather_card-0.1.0-darwin-arm64.tar.gz（sha256 …）
[install-check] 下一步：按 references/release.md 发布到 GitHub Release。
[install-check] 结论：插件 weather_card v0.1.0 本地校验通过，宿主已支持外部插件，可以进入安装流程。
```

目标 PMW 太老（< 0.3.0）或没开启外部插件时，会如实报“不支持”，仍退出码 0（不算插件问题）：

```text
[install-check] 未发现外部插件 API：当前 PMW 版本不支持外部插件（需要 >= 0.3.0）。
[install-check] 结论：插件 weather_card v0.1.0 本地校验通过，等待宿主支持（退出码 0，不算失败）。
```

如果 `--pmw-url` 连不上（`--timeout` 默认 3 秒），会走另一个分支，同样退出码 0：

```text
[install-check] 目标 PMW：http://127.0.0.1:7796
[install-check] 无法连接 http://127.0.0.1:7796（<超时/拒绝连接原因>）。请确认 PMW 已启动、--pmw-url 端口正确；没连上不算插件问题。
[install-check] 已生成可发布包：
  dist/weather_card-0.1.0-darwin-arm64.tar.gz（sha256 …）
[install-check] 下一步：按 references/release.md 发布到 GitHub Release。
[install-check] 结论：插件 weather_card v0.1.0 本地校验通过，等待宿主支持（退出码 0，不算失败）。
```

**④ 检查 dist**

```text
dist/weather_card-0.1.0-darwin-arm64.tar.gz   # pack 默认当前平台；CI 出三平台
dist/SHA256SUMS                                # shasum -a 256 -c 必须 OK
$ tar -tzf dist/weather_card-0.1.0-darwin-arm64.tar.gz
plugin.json  bin/  web/entry.js  web/style.css  assets/icon.svg  LICENSE
```

**签名（可选，建议发布者做）**：用 `plugin-sdk/skill/pmw-plugin-builder/scripts/sign_release.sh`：
```bash
scripts/sign_release.sh gen-key publisher.pem        # 私钥 0600，不进仓库/CI 日志
# 把打印出的 public key 填进 plugin.json 的 publisher.key，重新 pack/Release
scripts/sign_release.sh sign publisher.pem SHA256SUMS   # 产出 SHA256SUMS.sig，随 Release 上传
```
GitHub 来源的插件：清单声明了 `publisher.key` 时，PMW 会强制校验 `SHA256SUMS.sig`，通过才标 `verified`；缺签名/签名不匹配会拒绝安装。首次验签会 TOFU 绑定 `publisher.id -> key`，换 key 会被拒（需人工清理 `plugin_publisher_keys`）。本地目录/离线包无法证明来源，仍标 `community`。

**⑤ 发布（P0 可走完；安装等 P1）**：`v0.1.0` tag → Actions 构建全部声明平台（模板默认三平台）→ Release 上传各平台 `.tar.gz` + `SHA256SUMS` → 说明写“需要 `network:any`，无其它权限；api 2.0.x”。P2 加 `SHA256SUMS.sig`。

**⑥ P3 索引条目（待实现）**：字段含 id、多语言 title/description、repository、categories、versions（version、api、pmw、source.tag/commit、各平台资产 URL+sha256、permissions），完整格式与校验见 spec 第 11 节；本文附录不再展开。

**⑦ P1 之后的手工验收（待实现）**：装到测试实例（`scripts/dev-instance.sh`，`127.0.0.1:7796`）→ 安装时不授予 `network:any` → 启用后在插件设置里单独申请 + 二次确认 → 今日页出现卡片 → 断网时卡片隐藏且无报错 → 停用卡片消失 → 卸载默认保留数据。全部通过才算这个示例真正收尾。

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
