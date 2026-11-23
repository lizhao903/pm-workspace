# PMW 外部插件与社区协作方案（草案 v0.1）

> 2026-11-13 · 分析对象：写作时工作区 HEAD `13c44013`（PMW，一人之下；main 可能已前进，不影响结论）· 参考宿主：本机 Desktop 版 DeepSeek Harness（DSH，`profile=desktop`，Web GUI `http://127.0.0.1:49766`）
>
> 本文回答四个问题：
> 1. 如果想让用户**输入一个 GitHub 链接就安装第三方插件**，PMW 现在缺什么、要改哪些地方；
> 2. 要形成类似 DSH 插件市场那样的**社区协作模式**，产品、协议、安全、治理分别要补什么；
> 3. 要给开发者什么样的**规范提示**和**构建插件提示**；
> 4. 能不能做成一套**可安装的 skill**，开发者装上后能在本地按规范生成插件。
>
> 结论先说：**能，但插件形态必须换。** 当前插件是"编译进二进制的第一方代码"，第三方装不进来；目标形态是"独立子进程 + 运行时前端 ESM + 精确来源的插件包"。本次交付 P0（规范、计划、开发者指南、skill 与模板），宿主运行时 P1 起再落地，详见第 7 节路线图。
>
> 配套文档：[插件规范 v2（草案）](plugin-spec-v2.md)、[开发者指南](plugin-developer-guide.md)、[`plugin-sdk/`](../plugin-sdk/README.md)（skill + 模板 + 校验打包脚本）。

---

## 0. 结论摘要

1. **当前插件体系解决的是"一个二进制内按需启用功能"，不是"安装第三方代码"。** 插件在 `internal/plugins/<id>/`，构建时和内核一起编译；前端入口 `frontend/src/plugins/<id>/index.ts` 由 `import.meta.glob` 构建期打包。管理接口的「安装」只是跑迁移、改状态、启用注册，**没有"来源"概念**，也没有任何地方能加载外部代码。
2. **要支持 GitHub 安装，最小可行形态是"外部插件包"**：GitHub 仓库里放 `plugin.json`（清单 v2）+ 各平台预编译的 sidecar 二进制 + 预构建的前端 ESM。宿主从 GitHub Release 下载、校验 SHA-256、解包到数据目录，启用时拉起子进程、运行时加载前端模块。**不重建 PMW、不要求用户装 Go/Node。**
3. **后端必须是进程隔离 + 能力代理，不能是 Go `.so` 或进程内 JS。** 第三方代码和内核同进程，崩溃、越权、数据破坏都无法收场；Go 的 `plugin` 包还有平台/版本强绑定。子进程用本机 Unix socket 跑 JSON-RPC（`pmw-plugin-rpc/1`），内核能力（对象、事件、出网、文件、密钥、Agent）全部经宿主 broker 按声明权限放行。
4. **前端必须改成运行时加载。** 现在插件 UI 在构建期进 bundle，第三方 UI 装不进来；要注入 import map（共享宿主 React）、用 `window.__PMW_PLUGIN__` 注册、`import()` 动态加载、禁用即卸载，并做错误边界/CSP/CSS 作用域。
5. **社区模式 = 索引 + 版本 + 精确来源 + 兼容性 + 信任分级。** 借 DSH 已验证的形态：可添加的索引源 JSON、SemVer 版本列表、npm/Git 精确来源、`engines` 兼容性、安装前信任提示、第三方内容声明；PMW 另外补上 DSH 缺的**校验和固定、升级、索引校验**。签名不阻塞 P1（P1 用 commit + 资产 SHA-256 + 权限确认），作为 P2 的 `verified`/`official` 可选增强，理由见 9.1。
6. **开发者侧这次能直接给出一套 skill**：`plugin-sdk/skill/pmw-plugin-builder/`（SKILL.md + references + 模板 + `pmw_plugin.py` 的 init/validate/pack/self-test），装到 `.dsh/skills`、`.agents/skills`、`~/.claude/skills` 后，开发者让 agent 按规范生成、校验、打包插件；配套的 5 类 prompt（系统/生成/评审/发布/升级）在本文件第 6 节和开发者指南里。
7. **改造量的大头在宿主运行时和前端加载器，不在插件作者侧。** 后端新增约 8 个包/文件、前端新增运行时注册与安装 UI、数据层 4 张表、CLI/脚本/索引工具若干；P1 MVP 估 2–3 周（1.5 人），P2 安全加固 1–1.5 周，P3 市场 1 周，P4 DX 1 周。**不建议**在第一版就上源码构建、OS 级沙箱、跨语言 SDK。

---

## 1. 背景与目标

### 1.1 用户诉求

- 产品上：插件生态从"官方内置"扩展到"社区贡献"。用户拿到一个 GitHub 链接（仓库、Release、索引条目），在 PMW 里粘贴即可安装，像 DSH 一样。
- 安全上：第三方代码默认不可信，权限要可见、可拒绝、可收回；装错了能卸载、能回滚，数据不被误删。
- 开发者上：一条低摩擦路径——看一份规范、装一个 skill，让 AI agent 在本地生成/校验/打包插件，提 PR 进索引。
- 运维上：不要求终端用户装 Go/Node；离线/镜像可用；升级不重建二进制。

### 1.2 不在本期范围

- 不把现有 12 个第一方插件改写成外部插件（它们继续编译进内核）。
- 不做插件内购/计费、评分评论、远程遥测。
- 不做在 PMW 里运行任意 npm 包（那是 Node 宿主的事）。
- 不改变 `docs/dsh-plugin-adaptation.md` 的方向（把 PMW 整体包成 DSH 插件）；两件事正交：本文是 PMW 自己的插件生态，那份文档是 PMW 如何被 DSH 安装。

### 1.3 术语

| 术语 | 含义 |
|---|---|
| 内置插件（builtin） | 现有第一方插件，Go/React 代码与内核同仓、编译进二进制，Plugin API 1.x |
| 外部插件（external） | 第三方插件包，独立进程 + 运行时前端，清单 `manifest_version: 2`，宿主 API 2.x |
| 插件包 | 一个 GitHub 仓库及其发布产物（清单 + 平台二进制 + 前端 ESM + 资源） |
| 宿主（host） | PMW 主进程新增的插件运行时：来源解析、安装、子进程监管、RPC broker、前端资源服务 |
| 市场索引（index） | 一份 JSON，列出插件与版本、来源、兼容性、展示元数据，用户可添加多个索引源 |
| 信任等级 | `official` / `verified` / `community` / `local-dev`，决定提示强度与可安装性 |

---

## 2. 现状盘点（代码事实）

### 2.1 插件生命周期与加载

| 环节 | 现状 | 证据 |
|---|---|---|
| 登记 | 启动前 `Registry.Add(p Plugin)`，插件是 Go 接口实现；`Add` 后 `Start` 读状态表按依赖顺序启用 | `internal/plugin/plugin.go`、`internal/plugin/registry.go:169`、`:200` |
| 路由 | 启动时按清单展开挂进 `http.ServeMux`，启停只切换"这组路由交给谁"，停用返回 404 | `internal/plugin/registry.go:444` |
| 迁移 | 插件自带 SQL，跑在**主库**，用 `table_prefix` 隔离；安装前快照 | `internal/plugin/migrate.go`、`internal/db/migrations/0016_plugins.sql` |
| 权限 | 清单声明，安装时逐项确认；`trade:live` 等单独授权；运行时 `Granted(perm)` 查询 | `internal/plugin/permissions.go`、`docs/plugin-api.md` 第 3 节 |
| 管理接口 | `GET /api/plugins` + `{id}` 的 install/enable/disable/uninstall/upgrade + permissions grant/revoke | `internal/api/plugins.go:19-27` |
| 插件 API 版本 | `APIVersion = "1.1.0"`，清单 `core` 字段声明范围 | `internal/plugin/manifest.go` |
| 前端 | `discoverPlugins()` 用 `import.meta.glob` 构建期读清单和入口；`enabledPlugins` 来自 `GET /api/plugins`；`activate` 注册模块等 | `frontend/src/core/plugin/registry.ts:56-80`、`frontend/src/plugins/enabled.ts` |
| 安装 UI | 设置 → 插件（`PluginsSection.tsx`/`PluginDrawer.tsx`）只列二进制里的插件，没有来源输入 | `frontend/src/modules/settings/plugins/` |

**关键判断：** 现有"安装"是状态机，不是"代码进入系统"的过程。要装第三方，必须新增"代码从哪来、怎么校验、怎么运行、怎么卸载"四件事。

### 2.2 与 DSH 社区模型的对照

DSH 的插件市场（本机实测，`@deepseek-ai/dsh-plugin-market` / `-market-index` / `-client-ui-plugin-market`）已经跑通一整套：

| 能力 | DSH 做法 | PMW 现状 | 借用/改造 |
|---|---|---|---|
| 分发单位 | npm 包，含 `dsh.bundle.patch` / `dsh.client` / 兼容性元数据 | 编译进二进制 | **借**：独立包 + 清单 |
| 安装来源 | 精确 spec：`name@version` 或 `git+https://...#<commit>&path:/<dir>` | 无 | **借**：GitHub Release + commit 固定 |
| 市场 | 用户可添加索引源 JSON；搜索/分类/标签/版本/兼容性/信任提示；第三方内容声明 | 无 | **借**：索引格式 v1（本文 3.8） |
| 兼容性 | `engines.dsh` 按版本算，不兼容禁止装；默认最高兼容稳定版 | 只有 `core` 范围 | **借**：`api` + `pmw` 双范围 |
| 安全 | 依赖包管理器信任 + 安装确认；无权限模型、索引无签名 | 有权限确认，但只对内置 | **改**：权限 broker + 签名 + 校验和 |
| 升级 | **不支持升级**（只能卸载再装） | 换二进制后升级 | **改**：第一版就做升级/回滚 |
| 开发者 | 官方 `cordis-plugin-development` skill（SKILL.md + references + templates） | 无 | **借形态**：`plugin-sdk` skill |

结论：**产品形态照 DSH 抄，安全模型必须比 DSH 严**（因为 PMW 是 Go 本机进程、有凭证保险箱和项目目录访问权，不能像 npm 生态那样默认全信任）。

---

## 3. 目标架构

### 3.1 总体形态

```mermaid
graph TB
  U["用户：粘贴 GitHub 链接"]
  subgraph SHELL["PMW 主进程（Go）"]
    API["HTTP API / SSE"]
    HOST["插件宿主 pluginhost<br/>来源解析 / 安装 / 版本 / 子进程监管"]
    RPC["能力代理 broker<br/>对象 / 事件 / 文件 / 网络 / 密钥 / Agent"]
    WEB["运行时前端加载<br/>import map + ESM + 错误边界"]
    DB[("内核 SQLite")]
    PD[("每插件独立 SQLite")]
  end
  subgraph EXT["外部插件包（GitHub Release）"]
    BIN["sidecar 二进制<br/>pmw-plugin-rpc/1"]
    WEBP["web/entry.js（ESM）"]
    MAN["plugin.json（清单 v2）"]
  end
  subgraph CLOUD["GitHub / 镜像 / 市场索引"]
    GH["GitHub API + Release 资产"]
    IDX["市场索引 JSON"]
  end
  U --> API --> HOST
  HOST --> GH
  GH --> HOST
  IDX --> HOST
  HOST --> BIN
  HOST --> PD
  RPC <--> BIN
  BIN --- MAN
  WEB --> WEBP
  WEBP -. window.__PMW_PLUGIN__ .-> WEB
  API --> DB
```

四条链路：

1. **安装链**：粘贴链接 → 解析（GitHub API / 直链）→ 下载 → 校验清单/兼容/依赖/冲突/SHA-256/签名 → 展示权限 → 用户确认 → 解包落盘 → 写安装记录。
2. **运行链**：启用 → 建/升插件库 → 拉子进程 → socket 握手 → 健康检查 → 加载前端 ESM → 注册扩展点。
3. **能力链**：插件要对象/事件/文件/网络/密钥/Agent → RPC 到 broker → broker 按权限和 allowlist 放行 → 返回/拒绝（`permission_denied`）。
4. **社区链**：开发者用 skill 生成插件 → CI 构建多平台资产 + SHA256SUMS → GitHub Release → 提索引 PR → 用户索引源可见 → 安装/升级。

### 3.2 外部插件包（发布产物）

```text
plugin.json                 # 唯一清单，manifest_version: 2
bin/<id>-<os>-<arch>        # 预编译 sidecar，按平台各一份
web/entry.js, web/*.css     # 预构建 ESM + 样式（React 由宿主提供）
assets/icon.svg             # 图标，包内相对路径
migrations/*.sql            # 可选，只作用于插件自己的库
LICENSE
SHA256SUMS                  # 发布时必须，安装时校验
SHA256SUMS.sig              # 可选，ed25519 签名，verified 等级要求
```

源码仓库额外有 `Makefile`、`.github/workflows/release.yml`、`README.md`、`CHANGELOG.md`、测试；`plugin-sdk` 的模板直接给出这套骨架。安装记录固定 **release tag + commit SHA + 每个资产 SHA-256**，不跟着分支漂移。

### 3.3 后端：子进程 + 能力代理

- 每个启用的外部插件是一个子进程，由 `internal/pluginhost` 拉起；**第三方代码永不进主进程**。
- IPC：Unix domain socket（Windows 用 named pipe），JSON-RPC 2.0 + 换行分帧，协议 `pmw-plugin-rpc/1`。宿主是 server，插件启动后连上来；握手 `plugin.hello` → `host.welcome`，协商 API 版本与能力。
- 环境变量白名单（不含 DB、vault、profile 等敏感变量）：`PMW_PLUGIN_ID`、`PMW_PLUGIN_VERSION`、`PMW_PLUGIN_API_VERSION`、`PMW_PLUGIN_SOCKET`、`PMW_PLUGIN_TOKEN`、`PMW_PLUGIN_DATA_DIR`、`PMW_PLUGIN_CACHE_DIR`、`PMW_PLUGIN_LOG_LEVEL`、`PMW_PLUGIN_OS`、`PMW_PLUGIN_ARCH`。
- 插件数据：每插件独立 SQLite（`<data>/plugins/<id>/data.db`）和目录，只能经 `host.store.query/exec` 访问；**没有 table_prefix，不能直连内核库**。
- 生命周期：`activate` ≤10s → 健康检查（≤5s，失败只告警）→ 运行；停用先 `deactivate` ≤10s，再 SIGTERM，5s 后 SIGKILL；P1-a 崩溃只记 `last_error`、不自动重启（退避重启/`failed` 标记属 P1-b）。
- 限额：单条 RPC 消息 ≤8 MiB、每插件并发请求默认 8、普通宿主调用 30s 超时（`agent.run` 另配）、日志限速；超限返回 `rate_limited`/`validation`。

完整方法表、错误码、流式 HTTP/WS 转发方式见 [`docs/plugin-spec-v2.md`](plugin-spec-v2.md) 第 7 节；`plugin-sdk/skill/pmw-plugin-builder/references/backend.md` 是同一份协议的开发者版。

### 3.4 前端：运行时 ESM + 宿主 UI SDK

- 宿主启动时注入 import map：`react`、`react-dom`、`react-dom/client` → 宿主同一份 React 19；**插件不许自带 React**（包体积和双实例问题）。
- 插件入口 `web/entry.js` 执行 `window.__PMW_PLUGIN__.register({ id, api, activate(ctx), deactivate() })`；宿主校验 `api` 后才登记。
- `ctx` 提供：`slots.register`（模块页/设置分节/今日卡片/命令/对象区块）、`ui`（宿主组件 + `--pmw-*` token）、`host.call`（调自己的后端）、`permissions.has`、`i18n`、`theme`、`notify`、`openExternal`。
- 隔离：每插件一个错误边界；CSS 挂在 `[data-pmw-plugin="<id>"]` 下；禁止改 `document.body`、读别的插件 DOM、加载远程脚本、`eval/new Function`；CSP `script-src 'self'`，插件资源单独路径。
- 加载：`import(/* @vite-ignore */ '/api/plugins/external/<id>/web/<web_entry>?v=<version>')`；停用即 unregister，前端异常不影响外壳。
- 现有 `frontend/src/core/plugin/registry.ts` 的登记表改为 "builtin（构建期 glob）+ external（运行时注册）" 合并；`enabledPlugins` 不再只来自构建期。

### 3.5 安装管线

```text
输入 GitHub 链接
  → 解析来源（仓库/Release/资产直链/本地 zip/本地目录/索引条目）
  → 读清单（Release 资产优先）
  → 校验：schema + 语义 + api/pmw 兼容 + 依赖 + id/连接器/对象类型冲突
  → 安全预览：来源、commit、版本、许可证、签名、信任等级、权限与理由、目标平台
  → 用户确认非高风险权限（安装后默认不启用，到插件页手动启用）
  → 下载资产 → SHA-256（+签名）校验 → 解包到 <data>/plugins/<id>/<version>/
  → 写安装记录（不可变）
  → 启用：建/升插件库 → 备份 → 迁移 → 子进程 → 健康 → 前端 → 登记扩展点
  → 失败 → 回滚到上一版本/未启用，保留日志
```

升级保留最近 2 个版本可回滚；卸载默认保留插件数据，删数据要二次确认；单独授权（高风险权限）在卸载后清空。

### 3.6 需要新增/修改的代码位置（P1 基线）

后端：

| 位置 | 改动 |
|---|---|
| `internal/pluginhost/manifest.go` | 清单 v2 解析/校验，复用 `internal/plugin` 的 SemVer、版本范围、保留字、事件名规则 |
| `internal/pluginhost/source.go` | GitHub URL 解析、API/Release 读取、镜像/代理、下载与缓存、sha256/签名校验 |
| `internal/pluginhost/install.go` | 安装/升级/回滚/卸载/失败恢复、权限确认、依赖排序 |
| `internal/pluginhost/process.go` | 子进程拉起/健康/重启/退出、Unix socket、named pipe |
| `internal/pluginhost/rpc.go` | JSON-RPC 分帧、握手、请求路由、流式 HTTP/WS |
| `internal/pluginhost/broker.go` | `host.*` 能力实现（对象/事件/存储/文件/网络/密钥/Agent/通知/审计） |
| `internal/pluginhost/registry.go` | 外部插件运行时注册表（启用集合、前端资源清单、路由代理） |
| `internal/pluginhost/state.go` | 安装记录、版本、权限授予、日志 |
| `internal/api/plugins_external.go` | `POST /api/plugins/external/resolve`、`/install`、`/upgrade`、`/uninstall`、`GET /api/plugins/external/updates`、`GET /api/plugins/{id}/web/*`、`/icon`，安装进度 SSE |
| `internal/db/migrations/00xx_external_plugins.sql` | 新表：`external_plugins`、`external_plugin_versions`、`plugin_permissions`、`plugin_install_log` |
| `cmd/pmw/main.go` | flags：`--allow-external-plugins`、`--plugin-mirror`、`--plugin-dev-dir`、`--plugin-max-versions`；装配 pluginhost |
| `internal/plugin` | 新增 `ExternalAPIVersion = "2.0.0"`，不动 `APIVersion`（1.1.0） |

前端：

| 位置 | 改动 |
|---|---|
| `frontend/src/core/plugin/runtime.ts` | 外部插件运行时注册表：启用/停用、扩展点撤销、错误边界 |
| `frontend/src/core/plugin/loader.ts` | import map 注入、ESM 动态加载、版本缓存、失败重试 |
| `frontend/src/core/plugin/registry.ts` | builtin + external 合并，`enabledPlugins` 改为合并来源 |
| 菜单/工作台组装（`frontend/src/modules/settings/workspaces` 附近的组装逻辑） | 动态读取外部插件 `modules` |
| `frontend/src/modules/settings/plugins/` | 安装来源输入、预览/权限确认、进度、升级/回滚/卸载、信任徽标 |
| `frontend/vite.config.ts` | 暴露 React 共享 chunk / import map 配置 |

CLI 与构建（P3，P0 先用 `plugin-sdk/skill/pmw-plugin-builder/scripts/pmw_plugin.py`）：

- `cmd/pmw-plugin`：`init` / `validate` / `pack` / `index` / `release-check` / `dev`（与 Python 脚本同语义，给不装 Python 的开发者）。
- `.github/workflows/` 模板：三平台构建、SHA256SUMS、签名、Release、索引 PR 检查。
- `scripts/`：索引校验、签名/验签、发布前检查。
- `Makefile`：`plugin-validate`、`plugin-pack`、`plugin-release-check`。

数据层：

- 主库新增 4 张表；插件数据不落主库，避免"第三方迁移污染内核库"。
- 安装目录内容不可变（`<data>/plugins/<id>/<version>/`），升级=新增目录+切指针，回滚=切回旧目录。
- 插件库在升级前做 SQLite 一致性快照，失败自动恢复。

测试：

- `internal/pluginhost`：清单解析、来源解析（httptest 假 GitHub）、安装状态机、RPC 编解码、broker 权限拒绝、子进程崩溃重启。
- 前端：运行时加载/卸载、错误边界、import map、权限提示。
- E2E：本地起测试实例（7796），用 `plugin-sdk/examples/hello-world` 打包产物走一遍安装→启用→页面出现→升级→回滚→卸载。
- 安全用例：未声明权限、越权路径、超限消息、坏签名、不兼容版本、依赖成环。

---

## 4. 关键取舍

| 方案 | 结论 | 原因 |
|---|---|---|
| 第三方 Go `.so`（`plugin.Open`） | **否** | 平台/Go 版本强绑定，CGO 构建链复杂；崩溃拖垮宿主；无法跨语言 |
| 安装时从源码重建 PMW | **仅开发者模式** | 要求用户装 Go/Node，分钟级构建，供应链风险高；只用于本地开发目录 |
| 进程内嵌 JS（goja 等） | **否** | 沙箱弱、生态依赖宿主注入、调试差；第三方代码仍与宿主同进程 |
| WebAssembly 插件 | **暂缓** | 沙箱好，但 FS/网络/子进程能力受限，Go→WASM 的 SDK 与调试成本高；可作为未来"纯逻辑插件"档 |
| 子进程 + JSON-RPC + 运行时 ESM | **采用** | 隔离、跨语言、可崩溃恢复、能力可代理；与 PMW 现有 Go/React 技术栈兼容 |
| 前端 iframe 承载插件页 | **否**（仅逃生舱） | 拿不到宿主主题/路由/语言，交互割裂；DSH 实践也明确不推荐 |
| 直接复用 DSH 插件格式（npm/Cordis） | **否** | PMW 是 Go 单体；为了插件生态引入 Node 宿主是反向依赖，只借产品形态 |

---

## 5. 社区协作与治理

### 5.1 市场索引

- 索引是一份可托管的 JSON（GitHub Pages / raw URL），用户可添加多个索引源；索引内容按**第三方内容**展示，界面上明确"索引说法不等于安装内容，以清单为准"。
- **已定（2026-11-13）：索引放独立仓库 `pmw-plugins-index`**（GitHub Pages 托管 `index.json`），主仓库只保留索引 schema、校验脚本、PR 模板与评审清单，不背社区内容。
- 索引格式 v1（JSON）与校验脚本见 [`docs/plugin-spec-v2.md`](plugin-spec-v2.md) 第 11 节；字段：插件 id、标题/描述（多语言）、作者、仓库、分类/标签、版本列表（SemVer、发布时间、`api`/`pmw` 兼容范围、来源=GitHub Release 的 tag/commit/各平台资产 URL+SHA-256、权限）。
- 索引本身不签名（第一版），但**每个版本固定 commit 和资产 SHA-256**；安装时以清单实际声明为准，索引只做发现与排序。

### 5.2 发布与评审流程

```text
开发者：fork 模板仓库 → 用 skill 生成插件 → 本地 validate/self-test/pack
  → 打 tag → GitHub Actions 三平台构建 + SHA256SUMS（可选签名）→ 创建 Release
  → 向社区索引仓库提 PR（附：仓库、版本、权限与理由、许可证、测试记录）
维护者：自动检查（清单/schema/链接/checksum/构建可复现）→ 人工评审安全清单 → 合并
用户：添加索引源 → 发现 → 安装（信任提示 + 权限确认）
```

### 5.3 信任等级

| 等级 | 条件 | 安装时表现 |
|---|---|---|
| `official` | PMW 维护者仓库（P2 起可加签名 key） | 默认展示，不额外警告 |
| `verified` | 索引标注 + 维护者评审（P2 起可加 Release 签名验证，签名通过才能保持该级） | 绿色徽标；P2 后展示签名指纹 |
| `community` | GitHub 公开仓库，未评审/未签名 | 黄色提示，权限逐项确认，建议先看源码 |
| `local-dev` | 本地目录/源码构建，开发者模式 | 每次启动重新加载，明确"开发中、不保证稳定" |

### 5.4 治理规则（第一版）

- **命名**：插件 id 全局唯一、小写下划线、发布后不改；建议 `作者_功能` 前缀降低冲突。
- **版本**：插件自身 SemVer；`api` 声明宿主 API 范围；破坏性变更必须升 MAJOR 并在 CHANGELOG 写迁移说明。
- **兼容**：宿主保证 Plugin API 2.x 内向后兼容；弃用先标注一个 MINOR，至少保留两个 MINOR。
- **许可证**：必须声明 SPDX；第三方依赖许可证随包；不接受无许可证/闭源二进制（`official` 例外）。
- **安全红线**：未声明权限偷偷用、绕过 IPC 直连 DB、打包后门/挖矿、静默外传数据、`trade:live` 实盘（v0.1 一律拒绝）。
- **安全披露**：`SECURITY.md` 给私密渠道与响应时限；索引维护者有权下架。
- **质量门槛**：有 README、CHANGELOG、三平台或声明支持平台的产物、`validate`/`self-test` 通过、权限理由逐项。
- **社区载体**：模板仓库、`pmw-plugin` GitHub topic、索引仓库 PR、Discussions、每月兼容性矩阵。

### 5.5 版本与升级政策

- 插件 API `2.0.0` 起，宿主用 `api` 范围做门禁；`pmw` 范围做 app 版本门禁。
- 索引默认版本 = 最高兼容稳定版；预发布只在用户勾选"包含预发布"时可选。
- 升级必须展示新增权限；插件数据迁移失败自动回滚；用户可手动回滚到上一保留版本。

---

## 6. 开发者规范提示与构建提示

这次交付的不只是文档，而是一套"给 AI agent 看也能照着做"的规范。分三层：

1. **规范（normative）**：[`docs/plugin-spec-v2.md`](plugin-spec-v2.md) + [`docs/plugin-manifest-v2.schema.json`](plugin-manifest-v2.schema.json)。字段、协议、权限、生命周期、前端契约的唯一事实来源。
2. **指南（how-to）**：[`docs/plugin-developer-guide.md`](plugin-developer-guide.md)。从 0 到发布的分步流程、目录结构、本地调试、发布检查、常见错误，以及**可直接复制的 prompt**。
3. **技能（skill）**：[`plugin-sdk/`](../plugin-sdk/README.md)。`pmw-plugin-builder` skill + 模板 + `pmw_plugin.py`（init/validate/pack/self-test/install-check）。装到 agent 的技能目录后，"帮我做一个 PMW 插件"就能按规范产出。

### 6.1 五类 prompt（全文见开发者指南与 skill 的 `references/prompts.md`）

| Prompt | 用途 | 关键约束 |
|---|---|---|
| 系统提示 | 给 AI coding agent 的常驻角色设定 | 先读 spec/skill；最小权限；不直连 DB；不自造宿主 API；不打包 React；先跑通再加功能 |
| 生成插件 | 从一句需求生成完整插件包 | 槽位：目标/插件 id/页面位置/数据与权限/验收/非目标；产出清单+后端+前端+测试+README |
| 评审插件 | 提交前自检或维护者评审 | 权限逐项理由、安全红线、API 兼容、迁移与卸载、错误处理、UX/可访问性 |
| 发布插件 | 打 tag 到 Release + 索引 PR | 版本 bump、CHANGELOG、三平台构建、SHA256SUMS/签名、Release 说明、索引条目 |
| 升级兼容 | 宿主 API 变化或插件大版本 | 兼容范围、迁移脚本、回滚、弃用说明 |

### 6.2 skill 的安装位置（DSH / Claude Code 兼容）

`plugin-sdk/install-skill.sh` 不传 `--dest` 时按以下顺序找第一个已存在的目录；都不存在时创建 `~/.dsh/skills`。`--dest DIR` 可显式指定（装到 `DIR/pmw-plugin-builder`），重复执行幂等替换：

| 位置 | 适用 |
|---|---|
| `~/.dsh/skills/` | 当前用户所有 DSH 会话（默认首选） |
| `~/.claude/skills/` | Claude Code 用户技能目录 |
| `~/.agents/skills/` | 当前用户跨 agent |
| `<project>/.agents/skills/` | 跨 agent 的项目技能根 |
| `<project>/.dsh/skills/` | 用 `--dest .dsh/skills` 装到当前 PMW 仓库（DSH 项目技能根） |

装好后开发者说"给我做一个带今日卡片的 PMW 插件"，agent 会按 SKILL.md 流程走 `init → 实现 → validate → self-test → pack → install-check → 发布检查`。

### 6.3 为什么 spec 和 skill 要分开

- spec 是**人与 CI** 的契约（schema、协议、错误码），必须能独立校验；
- skill 是**agent 的操作手册**，负责"先做什么后做什么、什么时候停、怎么验证"；
- 两者共用模板与校验脚本，避免"文档一套、实际一套"。`pmw_plugin.py validate` 就是 spec 的可执行版本，CI 和 skill 共用它。

---

## 7. 分阶段路线图

### P0：规范与开发者工具（本次交付，0.5–1 天）

- 交付：本计划、规范 v2、manifest v2 schema、开发者指南、`plugin-sdk/`（skill + 模板 + 校验打包脚本 + hello-world 示例）。
- 验收：任何 agent 装 skill 后能生成一个 `validate` + `self-test` + `pack` 全通过的插件骨架；文档可被新开发者照做；`make check-dsh` 通过。
- 不承诺：宿主能真的安装（P1）。

### P1：宿主 MVP（2–3 周，1.5 人）——**P1-a 已完成（2026-11-13）**

**已落地（P1-a）**：
- 安装：本地目录 / `pmw_plugin.py pack` 的 tar.gz / GitHub Release（repo、releases/tag、资产直链），SHA-256 + `SHA256SUMS` 校验，`external_plugins` 状态表（migration 0059），安装目录与独立插件库。
- 运行时：子进程 + `/tmp` 短路径 Unix socket + `pmw-plugin-rpc/1`（hello/welcome/activate/health/deactivate），10 项 env 白名单、日志文件、崩溃记 last_error；broker 已实现 `host.store.query/exec`、`host.objects.list/get`、`host.settings.get/set`、`host.notify`（权限逐项校验）。
- API：`/api/plugins/external` 的 list/capabilities/resolve/install/enable/disable/uninstall/call/web/icon 十条路由（已进 `docs/api-contract.md`）。
- 前端：静态 import map + `pmw-external-react.js`（与主应用同一份 React）、`window.__PMW_PLUGIN__` 运行时桥、槽位映射（模块/设置/今日卡片/命令）、CSS 注入、设置页外部插件安装/预览/启停/卸载 UI。
- 验证：`scripts/e2e-external-plugin.py` 全链路 PASS（安装→子进程 command→broker→web/icon/style→停用/启用→卸载）；本机另用临时 headless Chrome 脚本验证菜单出现「Hello World」、插件路由渲染、插件 CSS 生效（UI 检查脚本未入库、依赖本机 Chrome，不作为仓库命令）。

**验收**：`plugin-sdk/examples/hello-world` 在临时实例走通 安装→启用→页面出现→停用→卸载；权限拒绝返回 `permission_denied`；重启 PMW 后按状态恢复 enabled 插件。

**安全边界（诚实口径）**：P1-a 的 broker 按「清单声明 + 用户授予」拦能力，但**不是同页隔离/OS 沙箱**——插件前端与宿主同页执行，恶意 JS 可直接 `fetch` 本机 API、借 URL 里的插件 id 调别的插件；插件进程同用户权限，可 `os.Open` 本机文件。P1-a 已加固：握手强制 hello+token、SQL 去注释后关键字黑名单 + 只读连接 `query_only`、web/icon 解析符号链接后再校验、插件前端槽位 id 强制命名空间、`window.__PMW_PLUGIN__` 不可写且按加载 id 校验。硬隔离（capability token + iframe/Worker + OS 沙箱）列入 P2/P3。

**未做（P1-b）**：签名、源码构建、Windows 命名管道。

**P1-a 追加（2026-11-13 下午）**：运行中崩溃按 1s/2s/4s 退避重启最多 3 次；运行期每 30s health，连续 3 次失败杀进程并走重启；高风险权限（`fs:write:any`/`network:any`/`process:spawn`）装后在插件卡片上逐项「单独授予」+ 二次确认、可收回，授予/收回实时推 `plugin.permission_changed`；`trade:live` 仍一律不授予。

**P1-a 追加（2026-11-16）**：插件 HTTP/WS 代理已实现——`/api/plugins/external/<id>/api/*` 转 `plugin.http.request`（一次性或 `host.http.chunk/end` 流式，seq 排序）；`Upgrade: websocket` 走 `plugin.http.upgrade` + `plugin.http.ws_message`/`host.ws.send`/`host.ws.close` 双向转发；GitHub 下载镜像 `--plugin-mirror` 与重定向域名白名单；市场索引独立仓库与发现/安装；事件投递已实现——内核事件经 `events.Bus` tap 分发给「清单 subscribes 且已授予 events:subscribe」的运行中插件（`plugin.event.deliver`，5s 超时、异步不阻塞发布方）；插件经 `host.events.publish` 发布清单 `emits` 里声明的事件，经同一总线再分发；未声明/未授予一律拒绝。升级/回滚已实现——`POST .../upgrade` 校验新版本/权限、复制版本目录、跑新迁移、按原启用状态拉起，旧版本进 `previous_*`；`POST .../rollback` 交换当前/上一版本（数据库迁移不回退，UI 有提示）；只保留当前+上一版本目录。

### P2：安全加固（1–1.5 周）——**部分开始**

- 可选签名（ed25519、key 固定、`SHA256SUMS.sig`，默认只对 `verified`/`official` 要求）、网络走宿主代理 allowlist、FS broker 路径 allowlist、密钥 broker、CSP 强化、审计、限速、超时、日志脱敏；macOS `sandbox-exec`/Linux `bwrap` 探针（可选）。
- 验收：安全用例集全过；坏签名/越权/超限被拒且有用户可读原因；安全文档补齐。

### P3：市场与社区（1 周）——**部分完成（2026-11-16）**

**已落地**：
- 独立索引仓库 `pmw-plugins-index`（本机 `../pmw-plugins-index`）：`index.json` v1、JSON Schema、`scripts/validate_index.py`、GitHub Actions 校验、PR 模板、CONTRIBUTING（收录门槛/评审清单/安全红线）、SECURITY、MIT LICENSE；本地 git 初始化并提交，未推送。
- PMW 侧：`Host.FetchMarketIndex` + `POST /api/plugins/external/market`（http(s)、≤2 MiB、10s、同源重定向、格式/兼容性校验），设置页新增「发现（市场索引）」：填索引 URL → 加载条目 → 显示兼容版本 → 解析预览 → 安装；索引只做发现，安装仍走真实包校验/权限确认。
- 索引侧恶意内容防护：只接受 github-release 来源与 https 资产、sha256 必填；索引内容不参与信任判断。

**未做**：官方/受信索引托管、评审 SLA、下架自动化、CI 里真实下载校验资产。

**2026-11-16 追加**：索引可选 ed25519 签名（`index.json.sig`，PMW 按 URL TOFU，换 key/去签名拒绝）；发现页加搜索（标题/描述/作者/仓库/分类/标签）与「索引已签名/未签名」标识。

- 索引格式 v1 + 校验、插件页"发现"、多索引源、搜索/分类/兼容性、升级提示、`cmd/pmw-plugin` CLI、模板仓库、GitHub Actions 模板、索引 PR 检查、评审清单。
- 验收：用户添加一个索引源 → 发现 → 安装成功；索引 PR 的自动检查能拦住坏条目。

**完成度快照（2026-11-16）**：P0 完成；P1-a 完成（安装/启停/卸载/权限/重启恢复/崩溃重启/周期 health/高风险授权/事件投递/升级回滚）；P1-b 剩余源码构建、Windows 命名管道（WS/流式 HTTP、开发者目录已实现）；P2 部分完成（可选 ed25519 签名 + TOFU/verified、`host.http.request` 网络代理 + 每跳重定向 allowlist、基线 CSP 已做；FS/密钥 broker、审计/限速、OS 沙箱未做）；P3 部分完成（独立索引仓库、发现/安装、索引签名、搜索/分类筛选、HTTP/WS 代理已做；官方/受信索引托管、评审 SLA、真实资产 CI 校验未做）；P4 部分完成（开发者目录已做；热加载 watch、从源码构建、跨语言 SDK、testkit 未做）。

### P4：开发者体验与长期（1 周+）——**部分开始**

- 本地目录热加载、源码构建、并发/性能、回滚/降级、镜像/离线、跨语言 SDK（Node/Python）、兼容性矩阵、插件测试工具包。

依赖关系：P1 依赖 P0 的 schema/协议定稿；P2 依赖 P1 的 broker 边界；P3 依赖 P1 的安装/升级；P4 视社区反馈排。

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 第三方代码逃逸/越权 | 数据与凭证泄露 | 子进程隔离 + broker 最小权限 + 高风险单独授权 + 签名/评审；不承诺绝对安全，做风险可见 |
| 前端插件破坏页面/样式 | 体验崩坏 | 错误边界、CSS 作用域、CSP、禁用/卸载、评审 |
| GitHub 不可达/限速 | 安装失败 | 镜像/代理配置、离线 zip、索引可托管在任意 URL、缓存已下载版本 |
| API 演进导致插件碎片化 | 生态维护成本 | 2.x 向后兼容承诺、弃用窗口、兼容性矩阵、skill 生成时写死范围 |
| 插件数据迁移失败/丢数据 | 用户数据损失 | 升级前快照、失败回滚、保留两版本、迁移只动插件自己的库 |
| 索引被投毒/仿冒 | 装到恶意插件 | 信任等级、签名、固定 commit+sha256、第三方内容提示、下架机制 |
| 维护负担（评审/issue/兼容） | 团队被拖垮 | 第一版只收 `community` 索引 PR，明确 SLA；工具化检查优先于人工 |
| 用户误以为插件=官方 | 责任边界 | UI 明确作者/来源/信任等级；官方插件仍有独立徽标 |

---

## 9. 已定决策与待决问题

### 9.1 已定（2026-11-13）

1. **外部插件允许安装，用户确认即可**：`--allow-external-plugins` 默认 `true`，每次安装仍必须由用户在安全预览里确认非高风险权限；企业/内网可设为 `false` 全局关闭。
2. **市场索引放独立仓库**：`pmw-plugins-index`（GitHub Pages 托管 `index.json`）；主仓库只保留索引 schema、校验脚本、PR 模板和评审清单。
3. **P1 不做强制签名**：P1 的完整性保证 = 固定 commit + 资产 SHA-256 + 权限逐项确认 + 信任分级/评审；签名作为 P2 的可选增强，默认只对 `verified`/`official` 要求。

**为什么这样定（签名的价值与边界）：**

- 签名解决的是「**发布者身份 + 资产未被篡改**」：SHA-256 只能证明"下载到的文件和我手里的哈希一致"，但哈希本身来自同一个下载源；如果 GitHub Release 资产被替换（账号被盗/仓库被接管/镜像或代理被投毒），攻击者能同时替换文件和哈希。ed25519 签名由发布者私钥生成，宿主用公钥验证，能在不信任下载通道的前提下确认"这个包确实由该 key 持有者发布、且未被改动"。
- 签名**不解决**「代码是否安全」：恶意作者签出来的仍是恶意代码；PMW 也没有现成的发布者身份 PKI，`publisher.key` 与 GitHub 账号的绑定要靠索引/评审（P3）。所以**主要风险靠权限模型、安装确认、评审红线和进程隔离来兜**，签名只是供应链加分项。
- 代价：开发者要管私钥/CI secret、轮换与泄露处理；用户看不懂指纹；索引要登记/校验 key；对单机个人产品来说，P1 强制的收益低于成本。DSH 的索引和包目前也不签名，靠 npm/Git 信任 + 评审 + 安装确认。
- 可选路径（P2 再做）：只对 `official`/`verified` 要求签名、首次使用 TOFU + 指纹展示；或引入 Sigstore/cosign 一类现成方案，避免自建密钥体系。

### 9.2 待决问题

1. **签名最终形态**：可选 ed25519 TOFU / 只对 official 强制 / 引入 Sigstore，三选一，等 P2 前拍板。
2. **是否允许插件带自己的 npm/Go 依赖**：P1 允许（打包进 bin/前端 bundle），但源码仓库要锁版本；评审看许可证与体积。
3. **高风险能力边界**：`process:spawn`/`fs:write:any`/`network:any` 是否对外部插件开放。v0.1 按 spec 5.3：任何插件安装/升级都不授予，装后逐项申请 + 二次确认；是否对 `verified` 简化流程、或直接不对 community 开放，待 P1 安全评审定。
4. **是否把 DSH 市场索引格式兼容**：可做一层适配（PMW 索引格式 v1 与 DSH index 字段映射），但第一版不承诺。

---

## 附录 A：与 `docs/plugin-api.md`（第一方 API 1.x）的关系

- 1.x 是**内置插件**的进程内契约：`Plugin` 接口、`Core` 句柄、`Registrar`、迁移在主库、权限在清单确认。
- 2.x 是**外部插件**的跨进程契约：清单 v2 + RPC + 前端 ESM；能力是 1.x 的子集 + 代理语义。
- 两者共用：plugin id 规则、保留字、SemVer/版本范围、扩展点名、权限名（尽量一致）、安装/启用/停用/卸载的产品语义。
- 迁移策略：内置插件保持 1.x 不动；未来若要把某个内置插件外置，按 2.x 重写后端为 sidecar、前端改为 ESM，并按新生命周期迁移数据（单独任务，不在本期）。
- 文档关系：`plugin-api.md` 仍是内置插件规范；`plugin-spec-v2.md` 是外部插件规范；两者在术语和扩展点上互相引用，避免漂移。

## 附录 B：本次交付物清单

| 文件 | 内容 |
|---|---|
| `docs/plugin-community-plan.md` | 本文：现状、目标架构、改造清单、路线图、风险 |
| `docs/plugin-spec-v2.md` | 外部插件规范 v0.1：清单、权限、RPC、前端、索引、安全 |
| `docs/plugin-manifest-v2.schema.json` | 清单 v2 的 JSON Schema |
| `docs/plugin-developer-guide.md` | 开发者指南：流程、prompt、检查清单、发布 |
| `plugin-sdk/` | 可安装 skill、模板、`pmw_plugin.py`、hello-world 示例、安装脚本 |
| `README.md` 文档索引 | 新增上述文档入口 |

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
