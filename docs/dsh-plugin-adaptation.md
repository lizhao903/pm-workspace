# PMW 按 DSH 插件要求改造：现状、差距与分阶段方案

> 2026-11-11 · 分析对象：当前工作区（HEAD `4e505e78`）· 目标宿主：本机 Desktop 版 DeepSeek Harness（dsh，profile `desktop`，Web GUI `http://127.0.0.1:49766`）
>
> 本文回答一个问题：**PMW（一人之下）现在这套 Go 单体 + React SPA + 自有插件体系，如果要按 DSH 插件的要求调整，需要做哪些工作。**
> 数据来源：PMW 仓库代码与 `docs/plugin-api.md`；DSH 侧通过 `cordis_inspect_*` 现场核实 + 随包插件文档（`@deepseek-ai/dsh-agent-preset` 的 cordis-plugin-development / cordis-composition-reference skills）。文中 DSH 的 Slot、Service、包名都是当前安装版的实测值。

---

## 0. 结论摘要

1. **不要把 PMW 重写成 DSH 原生插件。** PMW 是 Go 14.5 万行 + 前端 12.5 万行、约 580 条 HTTP 路由、21 个 MCP 工具的成品应用；全量用 TypeScript/Cordis 重写是 6–12 人月级别，且会丢掉 SQLite、执行器、连接器等内核资产。**正确的形态是「DSH 插件包装 PMW」**：DSH 负责安装、启停、配置、Agent 工具和 UI 入口，PMW 的 Go 二进制作为受管子进程（sidecar）继续跑自己的单二进制。
2. **DSH 完全接得住这个形态。** Host 插件有 `subprocess`（拉起/终止/等待退出，服务释放时统一清理）、`webServer`（同源 HTTP 路由）、`tools`（注册 Agent 工具）等服务；Client 有一个**真正的顶层主面板 seat**：`main` 这个 keyed slot，配合 `sidebar.panellist` 的图标，可以挂一个完整的中央页面（不是只能做装饰），另外还有 `settings.section`、`conversation.view`、`sidebar.right.pane.tab`、`shell.overlay` 等增量位置。
3. **推荐路线：配置型 MCP 插件（1–2 天）→ Host 管 sidecar（1–2 周）→ Client 主面板（约 1 周）→ 原生 UI 渐进迁移（数周起）。** 前两步就能让 DSH 里的 Agent 直接读写 PMW 的任务/文档/IM；第三步让用户从 DSH 侧边栏一键打开完整 PMW 界面。
4. **代价最大、也最不紧急的是「原生 UI 迁移」**：PMW 前端没有 i18n（中文硬编码 17,150 处）、149 个文件依赖 `react-router`、主题变量体系（`--bg/--panel/--text` + `html[data-theme]`）与 DSH 的 `--dsw-alias-*` token 不兼容。整页 iframe 是低成本的过渡形态，但 **DSH 实践明确不推荐用 iframe 承载插件页面**，只能作为过渡/逃生舱，需要产品上明确接受。
5. **改造量的大头不在 PMW 内核，而在「新增一个 DSH 插件包」**。PMW 仓库真正需要改的只有少数几处运行时能力（就绪输出、动态端口、受管数据目录、关闭自更新、可选的本地鉴权），其余都是包装层、构建脚本和文档。

---

## 1. PMW 现状（分析依据）

### 1.1 量级与进程模型

| 项 | 现状 | 证据 |
|---|---|---|
| 后端 | Go 1.25，459 个非测试文件 / 145,275 行；`modernc.org/sqlite`、`coder/websocket`、`creack/pty`、MCP Go SDK | `go.mod`；`find cmd internal -name '*.go' ! -name '*_test.go'` |
| 前端 | React 19 + react-router 8 + TanStack Query 5，953 个文件 / 约 12.5 万行 ts·tsx·css，vite 8 | `frontend/package.json`、`frontend/vite.config.ts` |
| 交付 | **单二进制**：`cmd/pmw` 把 vite 产物 `//go:embed all:dist` 进可执行文件，同一进程提供 API + 前端静态资源 | `cmd/pmw/main.go:5`、`internal/webui/embed.go:24-25` |
| 数据 | SQLite 单文件（默认 `./data/pm.db`）+ 附件目录 + 凭证保险箱主密钥（macOS 钥匙串或 `vault.key`） | `cmd/pmw/main.go`（`--db`、`vault.Open`） |
| 监听 | 默认 `127.0.0.1:7777`，可加一组 HTTPS 监听；端口由 `--addr`/`--tls-addr` 指定 | `cmd/pmw/main.go` 参数表 |
| 生命周期 | SIGINT/SIGTERM 优雅退出（5s 收尾）；自更新用 `syscall.Exec` 原地重启；macOS 用 LaunchAgent 常驻 | `cmd/pmw/main.go:120-140,470-500`、`internal/selfupdate`、`scripts/install-autostart.sh` |
| 安全 | 默认只听回环；无登录、无 API token；CORS 只在 `--dev` 下放开；终端 WS 握手校验本机/`--public-url` 的 Origin | `internal/api/server.go:50,182-205,593-605` |
| 观测 | `GET /api/health`（只证明进程活着，不查库）、`GET /api/stats`（查库）；启动时向 stdout 打印 `产品工作台已启动: http://…` | `internal/api/misc.go:7-10`、`cmd/pmw/main.go:483-487` |

### 1.2 模块与 API 面

- 内核 Go 包 27 个：`internal/{api,store,agent,runner,schedule,connector,vault,audit,events,notify,plugin,plugins,...}`；`internal/api` 137 个文件，`m.HandleFunc` 模式路由 **229 条**；10 个第一方插件再贡献 **352 条**，合计约 **580 条** HTTP 路由（另有 SSE/WS 与未匹配该模式的注册）。
- 实时面：全局 SSE `GET /api/events`；流式接口 `POST /api/objects/{id}/run`、`POST /api/agent/chat`、`/api/agent/debug` 等；终端 WebSocket `GET /api/terminal/sessions/{id}/ws`。
- 前端 7 个内核模块（今日、任务、文档、联系人、会话、运行、设置）+ 10 个产品插件（projects、im、sop、video、trade、recording、browser、terminal、domains、etf）+ 1 个开发示例 hello；插件代码约占前端 50%。

### 1.3 PMW 自有「插件体系」与 DSH 插件是两套东西

PMW 的插件是**编译进同一个二进制的第一方功能包**：清单是 `internal/plugins/<id>/plugin.json`（`id/name/version/provides/emits/subscribes/permissions/migrations/table_prefix` 等），生命周期是安装（跑迁移、装前备份库）→ 启用 → 停用 → 升级 → 卸载（默认保留数据）；扩展点有 11 个清单组 + 7 个运行时注册表（模块、设置分节、对象类型、连接器、技能/Agent 工具、SOP 节点、今日卡片、命令、事件订阅、定时任务动作等）。见 `docs/plugin-api.md`。

**注意：这套插件体系不是 DSH 插件。** 它解决的是「一个二进制内如何按需启用功能」，而 DSH 插件解决的是「一个 Node/Cordis 宿主里如何安装第三方功能包」。本次改造**不需要**把 PMW 的 10 个插件改写成 DSH 插件（那是路线 E），而是把 **PMW 整体**包成 DSH 插件。

### 1.4 已有的 DSH 触点（方向相反）

PMW 已经把 DSH 当成**执行器**接进来了：`--dsh-bin` / `DSH_BIN`、`internal/runner/dsh.go` 用 `dsh --profile headless --patch … --json -` 跑任务，事件映射、沙箱档位映射、MCP 回写（`pmw-run`）都已落地；`cmd/pmw-mcp` 是给 Claude Code / DSH 用的瘦客户端 MCP 服务（`--api`、`--actor`、`--agent-owner`，21 个 `pmw_*` 工具）。详见 `docs/deepseek-harness.md`、`docs/mcp.md`。

这次要做的是**反向**：让 DSH 能安装、启动、使用 PMW。已有的 `pmw-mcp` 工具清单可以直接复用，是整条改造里最便宜的第一步。

---

## 2. DSH 插件模型与硬性要求

### 2.1 四种可交付形态

| 形态 | 是什么 | 适合承载 |
|---|---|---|
| **bundle（配置型）** | 一个 npm 包，`package.json` 声明 `dsh.bundle.patch`，patch 里 `insert` 已有插件行 | 接 MCP server、改已有插件配置、启停 shipped 插件 |
| **Host 插件** | `index.js` 导出 `apply(ctx, config)`（或 Service class），在 Node 宿主进程里跑，可用 `ctx.subprocess`/`tools`/`webServer`/`credentials`/`storage` 等服务 | 进程管理、Agent 工具、同源 HTTP 路由、凭证 |
| **Client 插件** | `package.json` 声明 `dsh.client` + 导出 `./client`，浏览器里注册 lazy factory，往 slot 里渲染 React 组件 | UI：主面板、设置页、会话视图、状态条、图标 |
| **Host + Client 同一个包** | 上面两者放一个包里，Client 通过 `host.call()` 调本包 Host 半 | PMW 完整形态：Host 管进程 + Client 出 UI |

### 2.2 硬性要求清单（缺一项就装不上或显示不对）

| 要求 | 具体内容 |
|---|---|
| 包清单 | `name`（全局唯一）、`version`、`private: true`、`type: "module"`、`exports`（至少 `"."`，UI 再加 `"./client"`、`"./locale/*.json"`、`"./icon"`）、`files`（发布/打包必须含 patch、locale、icon、所有运行时文件） |
| bundle 入口 | `dsh.bundle.patch: "./cordis.patch.yml"`；patch 用 Loader YAML：`insert: [{ id, name: '<包名>', config: {...} }]`，覆盖已有行用 `id` |
| Client 清单 | `dsh.client: { platform: "web", immediately: true, inject: ["…"] }`（`inject` 只用于排序激活，不提供 API） |
| Host 入口 | `export function apply(ctx, config)`；可选 `export const inject = ['subprocess', …]`、`export const Config`；所有注册必须走 `ctx.effect`/`ctx.on` 并在卸载时清理 |
| Client 入口 | `window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … } })`；`require('react')` 从宿主模块表取 React，**不许自带 React/CDN**；`apply(ctx)` 里用 `ctx.slots.inject(key, () => ctx.slots.register(spec, Component))` |
| 显示元数据 | `locale/en.json`、`locale/zh.json` 里 `meta.title` / `meta.description`；英文 title 用 sentence case；插件管理器和设置页不激活插件也会读 |
| 图标 | 原图或可再分发素材，SVG/PNG/JPEG/WebP，≤256 KiB，必须在包内，不能是包外绝对路径/URL/软链；可导出 `./icon` 或 `package.json` 顶层 `icon` |
| 安装 | 走 `plugin_manager` 的 `install_bundle`（本地目录或打包产物），**不要**手写 profile 的 `package.json`/`cordis.patch.yml`、不要在 profile 目录跑 pnpm；有 build script 的包需要用户显式批准后才会跑 |
| 作用域 | 插件装在**当前 profile**，对同一 profile 的所有会话生效、重启后仍在；本地目录安装是链接，`files` 不过滤 |
| 生命周期 | 安装后可 `applied` / `overridden` / `restart-required` / `failed`；改普通配置会重启插件，`.volatile()` 字段原地生效；替换已装包需要重启才能加载新 JS 代号 |
| 配置持久化 | 插件**不能**自己读写 profile 的 `cordis.patch.yml`；要改自己的配置用 `ctx.get('configEditor').edit(entry, current => …)`；密钥存 `ctx.credentials`，不进配置 |
| 兼容性 | Host 插件的可选服务用 `inject` 或 `ctx.inject([...], …)` 声明，profile 里没有该服务时保持 inactive 而不是抛错 |

### 2.3 与本项目最相关的扩展点（本机实测）

**Client Slot（用 `cordis_inspect_query` 的 `Slots.listSubTree` 核实）：**

| Slot | 类型/作用域 | 用途与注册参数 | 对 PMW 的意义 |
|---|---|---|---|
| `main` | keyed / root | **中央主面板**，按 sidebar 条目 id 选中；注册 `{ name: 'main', key }`。已占用 key：`conversation`、`plugins`、`schedules` | **PMW 主界面的落点**：注册自己的 key（如 `pmw`）就是一个整页中央面板 |
| `sidebar.panellist` | list / root | 全局面板图标；注册 `{ id, order, label }` + 图标组件，**id 与 `main` 的 key 对应**；ownerProps 提供 `size`、`active` | 侧边栏加一个 PMW 图标，点开进主面板 |
| `shell.overlay` | list / root | 全屏浮层，层本身 click-through，条目自己接管 pointer events；注册 `{ id, order, label }` | 录音/执行状态条、提醒角标（PMW `ShellStatus` 的天然落点） |
| `settings.section` | list / root | 每条一个设置页；`{ id, order, label }` | PMW 的设置分节（外观/域名/终端/SOP/工作区/录音…） |
| `settings.plugins.tab` | list / root | Plugins 设置页里的标签页 | 放置 PMW 的配置页 |
| `conversation.view` | list / session | Conversation 的视图标签（session 作用域） | PMW 的 Agent 会话视图（`ChatPane` + 流式） |
| `sidebar.right.pane.tab` | keyed / session | 右栏标签体，按 tab kind 的 id 分发；session 作用域 | PMW 的终端/浏览器等「会话侧工具」面板（需先注册 tab type） |

其它可用但优先级低的：`settings.general.item`（单条设置项）、`sidebar.footer.action`、`conversation.composer.dock`、`conversation.input.*`、`sidebar.session.row.*`、`tool.call.toolview` 等。

**Host Service（本机实测目录）：**

| Service | 关键方法 | 对 PMW 的意义 |
|---|---|---|
| `subprocess` | `spawn(spec) → { stdin/stdout/stderr/collected, done, terminate(), waitForExit() }`、`spawnTerminal`；服务释放时终止所有受管进程 | **拉起/监管 pmw 二进制**的基础设施；spec 含 `argv/cwd/stdio/graceMs/signal/env`，输出支持 pipe/collect+spill |
| `webServer` | `register(route)`、`registerUpgrade`、`registerFallback`、`tapIndex`、`getOrigin()` | 把 PMW 的 API 以**同源**路径反代给 DSH 页面（如 `/pmw-api/*`），SSE/WS 可行；也可托管 PMW 静态资源 |
| `tools` | `register(definition, options)`、`restrict`、`guard`、`execute` | 把 `pmw-mcp` 的 21 个工具注册成 DSH Agent 工具（与 MCP 路线二选一） |
| `credentials` | `readRecord/modifyRecord/deleteRecord/…` | 存 PMW 的 API token（如果加鉴权）、OAuth 凭证 |
| `storage` / `storageDomain` | 挂载 JSON/SQLite domain | 存插件自己的状态（首次启动标记、端口、健康历史） |
| `configEditor` | `edit(entry, change)` | 插件配置页保存（不要自己改写 profile patch） |
| `terminal` / `terminals` | PTY 会话 | 只有做「在 DSH 里嵌 PMW 终端」时才用；PMW 自己的 `creack/pty` 更好 |
| Client `locale` / `theme` / `layout` / `slots` | `register(ns, locale, dict)`、`getTheme`、`openRightbar` 等 | 原生 UI 迁移时对齐宿主语言与主题 |

**硬约束/反模式（来自 DSH 官方实践文档，必须记住）：**

- **不要把 Host 提供的 HTML 页面塞进 iframe 当插件页**：iframe 拿不到宿主主题 token、明暗切换和 `ctx.locale`。插件页面应当是用宿主 React 渲染的组件。
- 不覆盖应用根节点、不往 `document.body` 追加第二个应用；不读写别的插件的 DOM/CSS。
- 主题只用 `--dsw-alias-*` token（本机实测 14 个：`bg-base/bg-layer-1/2/bg-overlay/border-l1/2/brand-primary/label-primary/secondary/state-*/specific-sidebar-fill`），字面色只允许用于插画。
- 可见文案走 Client locale 服务；`label` 支持传函数以跟随语言切换。
- 不 `require` 任何 Harness Client 包（`dsh.client.inject` 只排序）；需要宿主组件样式就复制并改前缀。

---

## 3. 差距矩阵：PMW 现状 vs DSH 插件要求

> 「工作量」是粗估，单位为人日（1 人）；★ 为相对风险。

| # | 项 | PMW 现状 | DSH 要求/可用机制 | 需要的调整工作 | 工作量 |
|---|---|---|---|---|---|
| 1 | 交付形态 | 独立单二进制 + 前端 embed | 插件包（package.json + patch + exports/files） | 新建 bundle 包；Host/Client 入口；locale/icon | 2–3 |
| 2 | 进程管理 | LaunchAgent / 用户手动起 | Host `ctx.subprocess`，`ctx.effect` 清理 | Host 半实现 spawn/健康等待/崩溃重启/终止；端口分配 | 3–5 |
| 3 | 就绪与健康 | stdout 打印 URL；`/api/health` 不查库 | Host 需知道「起来了没有、端口多少」 | PMW 加 `--ready-file`（或机器可读 ready 行）；Host 等健康 | 1–2 |
| 4 | 端口 | 固定 7777 或命令行指定 | 动态选空闲端口，避免冲突 | Host 选端口（或 PMW 支持 `:0` 并回报）；配置项覆盖 | 1 |
| 5 | 数据目录 | `./data/pm.db` + `vault.key` + 附件 | 由插件/线程管理，profile 级 | Config 指定受管目录（如 `$DSH_HOME/pmw/`）；首次初始化；旧数据迁移说明 | 2 |
| 6 | 凭证 | macOS 钥匙串或 `vault.key` | `ctx.credentials` 或沿用 PMW 保险箱 | 受管模式默认 `--vault-keychain=false`（避免隐藏子进程弹钥匙串）；可选接 credentials | 1 |
| 7 | Agent 工具 | `pmw-mcp` 21 工具（stdio，`--api`） | ① 配置型 bundle 接 `@deepseek-ai/dsh-mcp-client`；② Host `ctx.tools.register` | 路线①最省；路线②要写 schema/handler 与权限 | 1–3 |
| 8 | UI 承载 | 整页 React SPA（自有 Shell + 路由） | `main` + `sidebar.panellist` 可挂顶层面板 | Client 半：主面板 + 图标；先 iframe，后原生 | 3–5（iframe）/ 20+（原生） |
| 9 | 主题 | 自有 token `--bg/--panel/--text` + `html[data-theme]` | `--dsw-alias-*` 14 个 token | 原生迁移时做 token 映射层；iframe 形态无法同步 | 2–3 |
| 10 | 国际化 | 无 i18n，中文硬编码 17,150 处 | Client locale 服务 + `locale/en.json`、`locale/zh.json` | 插件元数据必须中英；UI 文案短期接受中文单语，中期抽 `messages.ts` | 1（元数据）/ 15+（全量） |
| 11 | 图标 | 内联 SVG + 插件 `icon` key | `./icon` 导出，≤256 KiB | 选一个 PMW 图标（或新画）；sidebar 图标组件 | 0.5 |
| 12 | 安装/升级 | `make build`、LaunchAgent、自更新 | `plugin_manager install_bundle`；版本随包 | 打包脚本、预编译二进制、CI；受管模式停用 PMW 自更新 | 2–3 |
| 13 | 多平台分发 | Go 本机编译 | 插件包直接跑在用户机器上 | 预编译 darwin(arm64/amd64)/linux/windows；签名/公证 | 2–4 |
| 14 | 安全 | 回环 + 无 token + 无 CORS | 同源反代或 iframe；本机 | 若走同源反代则 API 不出回环；可选加 token 防同机其他进程 | 1 |
| 15 | 多实例 | 一个进程一个库 | 一个 profile 一个插件实例 | Host 侧单例 + 锁；`mode: external` 复用已运行的 PMW | 1 |
| 16 | 前端 React 共享 | 自带 React 19/ReactDOM/Query/Router | React 必须来自宿主模块表 | 原生迁移时 external React + 路由兼容层 | 3–5（P0） |
| 17 | 构建产物 | 绝对路径 `/assets/*`、根路径路由 | 同源挂载需要前缀 | 加 `base` 的构建变体 + API base 接缝（`setApiBase` 已在） | 2 |
| 18 | 运行环境差异 | macOS 自启、书签、`--open` | DSH 里不需要浏览器自启 | 受管模式关 `--open`；日志进 DSH 收集 | 0.5 |

**结论：真正改 PMW 源码的只有 #3、#4、#5、#6、#12（部分）、#17（原生 UI 才需要），合计约 6–10 人日；其余都是新增包装层与打包工作。**

---

## 4. 路线对比与推荐

### 4.1 五条路线

| 路线 | 做法 | 改动范围 | 粗估 | 风险 | 终态 |
|---|---|---|---|---|---|
| **A. 配置型 MCP 插件** | 新建 bundle 包，patch 插 `@deepseek-ai/dsh-mcp-client`（stdio → `pmw-mcp`）；前提 PMW 已在跑 | 只新增一个包（无 Host/Client 代码） | **1–2 天** | 低（依赖 PMW 常驻；MCP 子进程路径要配） | DSH Agent 可用 21 个 PMW 工具；无 UI |
| **B. Host 管 sidecar + 工具** | 在 A 基础上加 Host 半：spawn/健康/重启/终止 PMW，注册工具或保留 MCP，配置页 | 新增包 + PMW 小改（ready/端口/目录） | **1–2 周** | 中（进程生命周期、跨平台二进制） | 安装即用：DSH 启停 PMW、Agent 读写 PMW；仍无 UI |
| **C. B + Client 主面板** | 加 Client 半：`main` 面板 + `sidebar.panellist` 图标；先 iframe 指向 sidecar（跨源）或同源反代 | 新增包 + PMW 少量前端/构建改动 | **+1 周** | 中高（iframe 是 DSH 反模式；主题/locale 双轨；CSP 未知） | 用户在 DSH 里点一下就能用完整 PMW 界面 |
| **D. 原生 slot 渐进迁移** | 抽「可移植前端内核」（React external、路由 shim、API base、CSS/主题隔离），把设置页/今日/状态条/会话视图逐块搬进 DSH slot | 前端大改 + 后端按需 | **2–3 周 P0 + 每页 3–10 天** | 高（149 文件路由依赖、无 i18n、对象模型无对应 slot） | 与 DSH 视觉/交互一体的工作台 |
| **E. 全量重写为 DSH 原生插件** | 用 TS/Cordis 重写 Go 内核与前端 | 全部 | **6–12+ 人月** | 极高（丢内核资产、长期双轨） | 不推荐 |

### 4.2 推荐：A → B → C → D（渐进），保留 PMW 独立运行

```
            现在                       阶段1（1–2天）           阶段2（1–2周）              阶段3（约1周）              阶段4（数周起）
  ┌──────────────┐    ┌──────────────────┐   ┌───────────────────┐   ┌──────────────────┐   ┌─────────────────────┐
  │ PMW 独立应用  │ →  │ DSH MCP bundle    │ → │ + Host sidecar     │ → │ + Client 主面板   │ → │ 设置/今日/会话原生 UI │
  │ (现有形态保留)│    │ mcp__pmw__* 工具   │   │ 自动启停/配置/日志  │   │ iframe 完整界面    │   │ 主题/locale 对齐      │
  └──────────────┘    └──────────────────┘   └───────────────────┘   └──────────────────┘   └─────────────────────┘
```

**为什么是这个顺序：**
- A 的成本几乎为零，且 `pmw-mcp` 已经稳定（21 个工具、schema 测试、MCP 回写都在用）；先把「DSH Agent 能操作 PMW」跑通，风险最低。
- B 解决 A 的硬伤（PMW 得先手工起）。Host `subprocess` + `ctx.effect` 正好覆盖「拉起—健康检查—退出清理」，不需要 PMW 改造进程模型。
- C 让用户「在 DSH 里打开 PMW」成立。先用 iframe 换完整功能，把**主题/locale/快捷键割裂**明确记为过渡债务；同时开始 D 的 P0（可移植内核），条件成熟后逐块替换。
- D 不做「全量」，只做高价值面：设置分节 → `shell.overlay` 状态/提醒 → `conversation.view` 会话视图；任务/文档/项目这类重业务页继续留在 iframe/原窗口，直到 DSH 侧有对应的对象/详情 slot。
- **保留 PMW 独立运行**（Config `mode: external` + `baseUrl`）：用户已有的 LaunchAgent/书签/`bro.vip` 域名访问不受影响；DSH 只是多一个入口。

---

## 5. 分阶段工作清单

### 阶段 1 — 配置型 MCP 插件（最小可用，1–2 天）

新增目录（建议 `dsh/pmw-mcp/`，与 `frontend/`、`internal/` 平级，不侵入现有构建）：

```
dsh/pmw-mcp/
  package.json          # @pmw/dsh-mcp，dsh.bundle.patch，exports ./locale/*.json ./icon，files
  cordis.patch.yml      # - insert: [{ id: pmw-mcp, name: '@deepseek-ai/dsh-mcp-client',
                        #     config: { serverName: pmw, transport: stdio,
                        #               command: <pmw-mcp 绝对路径>, args: ['--api', 'http://127.0.0.1:7777'],
                        #               failOnStartupError: true } }]
  locale/en.json        # meta.title "PMW workbench tools", meta.description …
  locale/zh.json        # meta.title "一人之下工具", meta.description …
  icon.svg
```

- `command` 的路径解析是**实现时第一个要验证的点**：stdio 的 `command` 是交给子进程执行的字面量，不确定能否相对 patch 文件锚定；建议先按「用户配置/安装后写绝对路径」设计，或让 Host 半（阶段 2）自己 spawn。
- 验收：DSH 会话里出现 `mcp__pmw__pmw_list_types`、`pmw_get_object`、`pmw_create_object` 等工具，且 PMW 没起时工具报错清晰（`failOnStartupError`）。

### 阶段 2 — Host 管 sidecar（1–2 周）

新增 `dsh/pmw/`（Host bundle）：

```
dsh/pmw/
  package.json          # @pmw/dsh-pmw：dsh.bundle.patch + dsh.client（阶段 3 再加）
  cordis.patch.yml      # - insert: [{ id: pmw-host, name: '@pmw/dsh-pmw', config: { autoStart: true } }]
  index.js              # Host: export const inject=['subprocess','webServer','tools'];
                        #       export const Config = {...}; export function apply(ctx, config){...}
  locale/{en,zh}.json   # meta.title / meta.description
  icon.svg
  bin/                  # 预编译 pmw（darwin-arm64 等），打包时由 scripts/dsh-package.sh 放进 files
```

Host 半的状态机（建议）：

```js
// apply(ctx, config):
// 1. mode === 'external' → 只探活 config.baseUrl，不 spawn
// 2. resolve pmw 路径（config.pmwBin || 包内 bin/<platform>-<arch>/pmw）
// 3. 选空闲端口（或 config.port；0 表示让 PMW 自己选并读 ready 文件）
// 4. handle = ctx.subprocess.spawn({ argv:[pmw,'--addr',`127.0.0.1:${port}`,'--db',dbPath,
//        '--vault-keychain=false','--public-url',...,'--ready-file',readyPath],
//        cwd:dataDir, stdio:{stdin:'ignore',stdout:{maxBytes:…},stderr:{maxBytes:…}}, graceMs:5000 })
// 5. 等 ready 文件或健康检查（GET /api/health，最长 15s）；失败 → 记录日志并上报插件状态
// 6. ctx.effect(() => () => { handle.terminate(); await handle.waitForExit() })  // 卸载/停用/退出必清
// 7. 崩溃自动重启（退避 1s/2s/4s，最多 3 次），并把 stdout/stderr 尾部暴露到 Client 设置页
```

Host 配置 `Config`（建议字段）：`mode`（`managed`/`external`）、`baseUrl`、`pmwBin`、`dataDir`、`dbPath`、`publicUrl`、`autoStart`、`vaultKeychain`、`extraArgs`、`toolMode`（`mcp`/`native`）。

配套 PMW 小改（见 §6.2）：`--ready-file`、`--no-open`、动态端口、受管数据目录约定、关闭自更新。

验收：
- `install_bundle` 后 PMW 自动起，插件行显示 `applied`；`plugin_manager set_plugin` 停用后子进程退出、端口释放、无孤儿进程（`pgrep -f pmw` 为空）。
- 改配置（如端口/数据目录）触发插件重启且新配置生效。
- PMW 被 `kill -9` 后自动重启并恢复；连续失败 3 次后插件状态给出可读错误，而不是无限重启。

### 阶段 3 — Client 主面板（约 1 周）

在 `dsh/pmw/package.json` 加：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-layout"] }
},
"exports": { ".": "./index.js", "./client": "./client.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" }
```

`client.js`（按 decoration 模板的形态）：

```js
window.__ModuleLoader__.load({
  id: '@pmw/dsh-pmw',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        // 1) 侧栏图标：id 与 main 的 key 对应
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'pmw', label: () => '一人之下' }, PmwIcon))
        // 2) 中央主面板
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'pmw' }, PmwPanel))
        // 3) 可选：设置分节、shell.overlay 状态条
      },
    }
  },
})
```

`PmwPanel` 的两条实现：
- **过渡（推荐先做）**：`<iframe src={pmwUrl} style={{width:'100%',height:'100%',border:0}} />`，`pmwUrl` 由 Host 半通过 `host.call('state')` 返回（Host 侧的 package RPC 注册方式是实现时第一个要核对的 Client↔Host API；备选是 Host 用 `webServer.register('/pmw')` 返回当前 URL，Client 直接 `fetch('/pmw')`）。
- **长期**：原生组件（阶段 4），iframe 逐步降级为「在浏览器打开」的逃生入口。

验收：DSH 侧栏出现 PMW 图标 → 点击进入中央面板 → 完整 PMW 页面可用（登录态/数据与独立运行一致）→ 切换 DSH 主题不崩（至少可读）→ 卸载插件后图标/面板消失且 iframe 卸载。

### 阶段 4 — 原生 UI 渐进迁移（数周起，按模块立项）

前置 P0（约 2–3 周，所有原生迁移共用）——见前端分析结论：
1. **React external**：`require('react')` 走宿主模块表，打包产物改成 `window.__ModuleLoader__.load` 工厂（需要一个小 esbuild 包装脚本，DSH 没有现成的第三方构建工具链）。
2. **路由兼容层**：149 个文件用了 `react-router`（`useNavigate` 116、`useSearchParams` 55）；插件内改 `createMemoryRouter` 或把导航转发给宿主的 `ctx.layout`/`uiWorkspace`。
3. **API 接缝**：`setApiBase(宿主反代前缀)`（`frontend/src/core/api/client.ts`）+ `startEventStream(qc, { url })` + `terminalSocketUrl` 三处；其余 205 处 `/api/...` 字面量不用动。
4. **CSS/主题隔离**：删 `base.css` 全局 reset；`tokens.css` 做 `--bg ↔ --dsw-alias-bg-*` 映射或把 PMW 子树包进容器；主题写入从 `documentElement` 改为宿主 `ctx.theme`。
5. **locale**：插件元数据先中英双语；UI 短期接受中文单语，按页面抽文案。

迁移顺序：`settings.section`（外观/域名/终端/SOP/工作区/录音）→ `shell.overlay`（录音/执行状态条）→ `conversation.view`（`ChatPane` + `chatLive` + 流式 `/api/agent/chat`）→ 其余重业务页（等 DSH 侧有对象/详情 slot 再谈）。

---

## 6. 具体改造清单

### 6.1 新增：DSH 插件包（不侵入 PMW 现有构建）

| 文件 | 作用 |
|---|---|
| `dsh/pmw/package.json` | 包名/版本/`private`/`type: module`/`exports`/`files`/`dsh.bundle.patch`/`dsh.client` |
| `dsh/pmw/cordis.patch.yml` | `insert` 一行 Host 插件；阶段 1 的 MCP 行可复用同一个包或单独包 |
| `dsh/pmw/index.js` | Host：`apply(ctx, config)`、`inject`、`Config`；subprocess 生命周期、健康检查、工具注册、`webServer` 反代（可选） |
| `dsh/pmw/client.js` | Client：`__ModuleLoader__.load` 工厂；`main` + `sidebar.panellist`（+ 可选 `settings.section`、`shell.overlay`） |
| `dsh/pmw/locale/en.json`、`zh.json` | `meta.title` / `meta.description`、插件内文案 |
| `dsh/pmw/icon.svg` | 插件图标（也可复用 PMW 的 logo 转 SVG） |
| `dsh/pmw/bin/<os>-<arch>/pmw` | 预编译二进制（由打包脚本生成） |
| `dsh/pmw/README.md` | 安装方式、配置项、已知限制 |
| `scripts/dsh-package.sh` | 构建前端 → 编译各平台 pmw → 组装 `bin/` → 生成校验和；CI 调用 |
| `Makefile` 目标 | `make dsh-bundle`（本地目录安装用）、`make dsh-package`（发布用） |

### 6.2 PMW 仓库内的小改（最小侵入）

| 位置 | 改动 | 目的 | 估量 |
|---|---|---|---|
| `cmd/pmw/main.go` | 新增 `--ready-file <path>`：全部监听成功后写 `{ "urls": [...], "pid": N, "version": "…" }`，退出时删除；错误时写 `{ "error": … }` | Host 不用解析中文 stdout | ~40 行 + 测试 |
| `cmd/pmw/main.go` | 支持 `--addr 127.0.0.1:0` 时把实际端口写进 ready 文件（`net.Listen` 已支持，`displayAddr` 会打印实际地址） | 动态端口 | ~10 行 |
| `cmd/pmw/main.go` | 新增 `--no-self-update`（受管模式禁用自更新；自更新依赖源码目录与原地 exec，在插件包里不成立） | 避免插件内自更新 | ~15 行 |
| `cmd/pmw/main.go` | 新增 `--instance-lock <dir>`（可选 flock）：同数据目录只允许一个进程 | 防 DSH 多窗口/多次安装起两份 | ~30 行 |
| `internal/vault` / `run()` | 受管模式默认 `--vault-keychain=false`（配置层），避免隐藏子进程弹钥匙串；文档写明密钥文件随数据目录备份 | 稳定性 | 文档 + 配置 |
| `internal/api` | 可选：`--token`/`PMW_TOKEN` 校验（仅非回环时强制，或由 Host 生成后经环境传入） | 防同机其他进程调用无鉴权 API | ~30 行（可选） |
| `frontend`（仅阶段 4） | 增加 `base: '/pmw/'` 的构建变体；`setApiBase` 指向宿主反代；主题 token 映射；locale 抽取 | 原生 UI 复用 | 见阶段 4 |
| `docs/` | 本文件 + 在 `README.md`、`docs/deepseek-harness.md` 加交叉链接 | 文档 | 0.5 |

### 6.3 Agent 工具映射（两选一）

- **MCP 路线（阶段 1 推荐）**：`@deepseek-ai/dsh-mcp-client` 自带工具命名 `mcp__<serverName>__<tool>`，接现成 `pmw-mcp`，零工具代码；缺点是 PMW 必须先起、stdio 子进程随宿主生命周期。
- **原生工具路线（阶段 2 可选）**：Host 用 `ctx.tools.register` 注册同名 `pmw_*` 工具，handler 直接 `fetch(http://127.0.0.1:<port>/api/...)`；好处是工具可复用 sidecar 的连接/鉴权/错误处理，且能加 `ctx.tools.guard` 做写操作审批。建议**先 MCP，后续把写操作重的工具迁原生**。

### 6.4 PMW 与 DSH 概念对照（长期可统一命名，别急着改）

| PMW | DSH |
|---|---|
| `plugin.json`（第一方插件清单） | `package.json` + `cordis.patch.yml`（插件包） |
| 模块（`module: { id, label, path, load }`） | Client slot 注册（`main`/`settings.section`/…） |
| 设置分节 | `settings.section` |
| 今日卡片 | 无对应「今日」slot；用 `main` 面板/`shell.overlay` 状态条 |
| 插件启停/权限 | `plugin_manager` 的 install/enable/disable/uninstall + 宿主审批/凭证 |
| 事件总线（`object.*`/`run.finished`） | Host Event / Session 事件；跨进程用 HTTP/MCP 桥 |
| `pmw-mcp` 工具 | `ctx.tools` 工具 或 MCP client 的 `mcp__pmw__*` |

---

## 7. 风险与未决问题

### 7.1 风险

1. **iframe 是 DSH 明确不推荐的插件页形态**（拿不到主题/locale，交互割裂）。阶段 3 的 iframe 必须被定位为「过渡/逃生舱」，并得到产品侧确认；否则阶段 3 只能等阶段 4 的原生 UI。
2. **DSH Web 页的 CSP 未知**：`frame-src` 是否允许 `http://127.0.0.1:<port>` 需要实测；Electron 壳可能有额外限制。若被拦，退到「同源反代 + iframe」或「在外部浏览器打开」。
3. **跨源 iframe 的 Cookie/存储**：PMW 自身无登录态，影响小；但 OAuth 连接器回调依赖 `--public-url`，受管模式下要显式配置，不能沿用 `https://bro.vip`。
4. **跨平台二进制分发**：Go 二进制按 OS/arch 预编译（macOS arm64/amd64、Linux、Windows），包体积约 11 MB/平台；macOS 未签名/未公证的嵌套二进制可能触发 Gatekeeper，需在 README 说明并尽量走签名流程。**不要用 postinstall 现编译**（用户机器可能没有 Go，且触发 build script 审批）。
5. **自更新冲突**：PMW 的 `internal/selfupdate` 假设「正在跑的二进制旁边有源码仓库」，在插件包内不成立；受管模式必须禁用，版本更新走 DSH 插件升级。
6. **数据归属**：受管模式用 `$DSH_HOME` 下的新目录，还是复用用户现有 `./data`？建议首次安装时让用户选（Config），并给出「旧数据迁移」文档；不要默认覆盖已有库。
7. **无鉴权的回环 API**：本机任意进程都能调用 PMW API。若接受 iframe/独立运行，现状维持；若希望收紧，加 token（阶段 2 可选工作）。
8. **DSH 版本漂移**：slot/service 契约随 DSH 版本变；插件要声明最低 DSH 版本、加冒烟测试（安装→主面板→工具往返），并把 `dsh-*` 版本写进 README。
9. **profile 作用域**：插件装在当前 profile（本机是 `desktop`），对同 profile 所有会话生效；headless/CLI profile 里没有 `webServer` 时，Host 插件应保持 inactive（用 `inject` 声明），MCP 工具仍可用。

### 7.2 未决问题（需要你拍板）

1. **终态**：是「完整 PMW 界面在 DSH 里」还是「DSH 只做一个入口/Agent 工具面」？这决定阶段 4 是否投入。
2. **是否接受 iframe 过渡**（DSH 实践不推荐）；若不接受，阶段 3 推迟到原生 UI 就绪。
3. **数据策略**：新建受管库，还是复用现有 `./data/pm.db`（迁移/双写）？
4. **分发**：只在本机 `install_bundle`，还是进插件市场/npm 包？
5. **目标 DSH 版本**：只支持当前 Desktop 版，还是同时支持 CLI headless profile？
6. **是否保留 PMW 独立运行**（推荐保留；Config `mode: external` 兼容）。

---

## 8. 验收标准（分阶段）

| 阶段 | 验收 |
|---|---|
| A | DSH 会话能调 `mcp__pmw__pmw_*` 至少 5 个只读工具；PMW 未起时错误可读 |
| B | `install_bundle` → PMW 自动启动；停用/卸载后无孤儿进程、端口释放；崩溃自动重启有上限；配置修改生效 |
| C | 侧栏出现 PMW 图标；主面板完整加载 PMW UI；卸载后入口消失；DSH 明暗主题切换至少可读 |
| D | 至少一个 `settings.section` 与一个 `conversation.view` 用宿主 React/主题/locale 渲染，无全局 CSS 泄漏 |

---

## 附录 A：DSH 侧证据索引

- 插件/包规范：`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`、`ui-plugin.md`、`mcp-bundle.md`、`practices.md`；模板 `templates/decoration/{package.json,index.js,client.js}`
- 可装载包清单：`skills/cordis-composition-reference/references/packages.md`（`@deepseek-ai/dsh-mcp-client`、`dsh-tools`、`dsh-credentials`、`dsh-storage*`、`dsh-terminal*`、`dsh-subprocess-local` 等）
- 本机实测：`cordis_inspect_list`（Host/Client Provider）、`Slots.listSubTree`（`main`、`sidebar.panellist`、`shell.overlay`、`settings.section`、`conversation.view`、`sidebar.right.pane.tab`）、`Service.listService`（`subprocess`、`webServer`、`tools`、`credentials`、`configEditor`、`theme`、`locale`、`layout`）、`Theme.listTokens`（`--dsw-alias-*`）
- DSH profile：`desktop`（`$DSH_HOME=/Users/broleez/.dsh`），Web GUI `http://127.0.0.1:49766`

## 附录 B：PMW 侧证据索引

- 进程/部署：`cmd/pmw/main.go`、`internal/webui/embed.go`、`internal/selfupdate/`、`scripts/install-autostart.sh`
- API/实时：`internal/api/server.go`（229 条 `m.HandleFunc`）、`internal/api/misc.go`（health）、`internal/api/*`（SSE）、`internal/plugins/*`（352 条路由 + `terminal/ws.go`）
- 插件体系：`internal/plugin/{plugin,registry,manifest,host,permissions,migrate,uninstall}.go`、`internal/plugins/*/plugin.json`、`docs/plugin-api.md`
- DSH 反向触点：`internal/runner/dsh.go`、`cmd/pmw-mcp/`、`docs/deepseek-harness.md`、`docs/mcp.md`
- 前端：`frontend/src/{main.tsx,core/shell,core/plugin,core/api,core/data}`、`frontend/vite.config.ts`、`frontend/src/core/ui/tokens.css`；前端可迁移性细目见本次分析产出的 `.workbuddy/dsh-plugin-analysis/pmw-frontend.md`（本地工作区，不入库）

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
