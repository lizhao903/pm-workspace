# 后端扩展性与插件宿主评审（2026-11-09）

> 评审对象：`cmd/pmw` 内核 + `internal/plugin` 宿主 + `internal/plugins/*` 九个第一方插件。
> 只读评审，除本文件外未改任何文件；未启动服务、未写库（`data-dev/pm.db` 仅 `sqlite3 -readonly` 查询）。
> **事实与推断**：有 `文件:行` 出处的陈述是读代码/文档/数据库得到的事实；标【推断】的是从结构推演、未运行验证的判断。
> **假设**：①只评第一方插件形态，第三方插件按 `web-next/docs/dev-plan.md:167,526` 的决议（第一方同仓库构建，进程外协议留待以后）暂不作为现期标准；②`web-next/` 是原型，不计入实现度；③`data-dev/pm.db` 是 **7796 生产实例的日常库**（不是测试数据），只用于只读看状态与表；④Go 侧"插件"= 编译进同一二进制的进程内模块。

## 0. 结论摘要

宿主骨架是够用的：清单校验、迁移校验和、表前缀隔离、权限确认、停用撤注册、扩展点"注册前查清单"这套东西真实存在且有测试（`internal/plugin` 81 个测试函数）。**真正的问题不在"插件系统能不能跑"，而在三处**：

1. **内核模块不插件化，通用能力缺句柄**：设置、文件、进程、搜索、对象类型没有统一能力，导致 5 个插件各写一套设置、8 个文件 import `database/sql`（多为 `sql.NullString`/`sql.ErrNoRows` 类型，非自建连接）、fs/process 权限全靠插件自愿。
2. **接口宽、校验单向**：`Core` 27 个方法全量下发（11 个方法只有 ≤1 个插件用）；清单 `provides` 只验"代码→清单"，清单有、代码没注册完全合法；边界静态检查只实现了文档承诺的三分之一。
3. **生命周期的非原子点与"停用≠隔离"**：升级失败会留下"已升级但没启动"；停用超时后协程残留且仍可卸载；没有 deactivate 钩子，在飞请求不取消。

规模数据（`find|wc -l`，prod/test 行）：插件 75,775/36,163（9 个，152 文件），宿主 `internal/plugin` 7,584/3,850，`internal/api` 12,680/16,233，内核 store 9,932/7,891；插件 71 个迁移、内核 51 个；产库 155 张表（插件 107 / 内核 48）；插件路由约 479 条（内核约 330）；9 个插件全部编译进 `pmw`，产库中 7 个启用、2 个停用（browser、trade）。

---

## 1. 扩展点覆盖：哪些真有消费方

### 1.1 后端登记入口（`Registrar` 14 个方法 = 13 个扩展点 + `Core()`，`internal/plugin/plugin.go:48`）

| 扩展点 | 宿主实现/校验点 | 第一方消费方 | 判断 |
|---|---|---|---|
| Routes | `registry.go:440`，路径必须 `/api/<id>/`；启动时固定注册、停用回 404 | 9 个全用 | 主通道，够用 |
| Job | `registry.go:783`（登记）、`:712`（跑）；每插件内 Name 唯一 | 8 个（browser 不用） | 太原始，见 §6 |
| Subscribe | `registry.go:798`、`:471`；事件类型须在 `subscribes` 里 | 5（domains、im、projects、sop、video） | 行为干净：停用即撤 |
| TodayCard | `today.go:130`，Key 须在 `provides.today_cards`；每卡 800ms 超时 | 2（sop、video） | 与内核卡片合流做得好（`api/today.go:21`） |
| Connector | `connector.go:29`；Tool 须在 `provides.connectors`，安装期查 id 冲突（`manifest.go:211`） | 3（im、trade、video） | 好 |
| ConnectorImpact | `impact.go:140`；删连接器前的影响检查 | 2（im、trade） | 好，跨插件解耦范例 |
| Skill | `skill.go:43`；`sk_` 前缀 | **0**（只有 `internal/plugin/plugintest/demo.go` 测试插件） | 为未来留的，无现期收益 |
| SOPNode | `sopnode.go:268`；Kind 须在 `provides.sop_nodes`、`<id>_` 前缀 | 3（im 15、projects 13、video 3 个节点） | **跨插件协议的最佳案例**，见 §7 |
| SOPEngine | `sopnode.go:307`；只许 id=`sop` | 1（sop） | 合理 |
| SOPStarter | `soplaunch.go:37`；`provides.modules` 须含 `sop`，全局唯一 | 1（sop） | 合理 |
| HostHandler | `host.go:28`；须 `network:localhost`，每插件最多一个 | 1（domains） | 线窄但场景真实（按 Host 分流反代） |
| ScheduleAction | `scheduleaction.go:43`；Kind 须在 `provides.schedule_actions` | 1（video） | 好 |
| ProjectPrototypes | `projectprotos.go:31`；须 `provides.modules` 含 `projects` | 1（projects） | 好 |

**结论 1**：13 个后端扩展点全部有宿主实现和校验，12 个有真实消费方；只有 `Skill` 零第一方使用。没有"只有类型没有消费方"的死扩展点，只有提前量。

**结论 2**：文档规划、后端**未实现**的扩展点有 4 个：`SettingsSection`（`docs/plugin-api.md:390`，2.2）、`ObjectType`（`:431`，2.3）、`AgentTool`（2.6）、`SearchProvider`（2.9）；`Core` 注释同样承认"设置、凭证等句柄随各自的任务加"（`plugin.go:89`）。这四块正是 §1.3 和 §6 里插件重复造轮子的根源。

**结论 3**：清单 `provides` 声明了 11 组（`manifest.go:130`），后端真正消费的只有 6 组：`modules`、`connectors`、`skills`、`sop_nodes`、`today_cards`、`schedule_actions`。`settings`、`search`、`commands` 只有前端消费；`object_types` 后端未实现、前端有注册器但零注册，`agent_tools` 前后端都未实现；`adopts` 后端只做形状校验（`manifest.go:532-540`），零消费——前端也只用了 `adopts.object_types`（`frontend/src/core/plugin/extensions.ts:179`），`adopts.routes` 前后端都没人查。

### 1.2 前端扩展点对照

16 个前端扩展点中：9 个后端插件 + hello 演示都用 `modules`；`settings` 5 个（domains、projects、sop、terminal、hello 演示）；`sopNodes` 3 个（im、projects、video）；`todaySources` 3 个（im、projects、sop）；`todayCards` 3 个（sop、video、hello）；`objectSections` 2（projects、sop）；`sessionTools` 2（browser、terminal）；`projectTabs`（video）、`sessionSources`（im）、`terminalLauncher`（terminal）、`commands`（只有 hello）各 1；`objectTypes`、`migrations`、`connectors`、`agent`、`events` **0 消费**——后四者是 `notImplemented` 占位（`frontend/src/core/plugin/registry.ts:199-211`），`objectTypes` 有实现但没人注册。

### 1.3 内核模块不走插件，插件因此要多写什么

内核的今日/任务/文档/联系人/会话/设置是"内核模块"（`docs/system-overview.md:14`），插件只能通过 `Core` 的只读句柄和几个写入句柄访问。代价是具体的：

- **设置**：`SettingsSection` 没落地，5 个插件各自建表、各自写端点、各自校验。表 + 端点：`domains_settings`（`domains/domains.go:97-98`，GET/PUT）、`im_settings`（`im/im.go:134-135`，GET/PATCH）、`sop_settings`（`sop/sop.go:105-106`；表见 `sop/gate.go:23`）、`terminal_settings`（`terminal/terminal.go:61-62`）、`projects_worktree_settings`（`projects/worktrees.go:133-134`）+ `projects_proto_sync_settings`（无独立端点）。合计 10 个端点、6 张表。若内核实现一个通用设置存储，这 5 套都能删成一张 schema。
- **IM 会话/身份模型被内核吸收**：`conversations`、`contact_identities` 是内核迁移 `internal/db/migrations/0027_contact_identities.sql`、`0028_conversations.sql`，接口在 `internal/api/conversations.go`、`internal/api/imidentities.go`，包在 `internal/imident/{store.go}`。IM 插件 14,175 行 × 44 文件却把这两块"公共数据"留在内核，卸载 IM 后路由和表还在。这对第一方是省事的，但意味着"IM 是插件"只在装配层成立。
- **项目概念被内核硬编码**：`objects.project_id` 在内核 `0001_init.sql:50`，`project` 类型由内核种子写入（`0002_seed_types.sql:10`），`internal/api/projectdocs.go:22-24` 硬编码 `projectType="project"`、`propDocsDir="docs_dir"`，`projectdocs.go:99` 直接按项目类型列表。项目插件 9,529 行，但"项目是什么"内核认识。
- **SOP 概念也被内核认识**：内核 `internal/schedule/sopcatalog.go`、`internal/plugin/soplaunch.go`/`sopschedule.go` 直接编码 SOP 发起与调度；agent 工具里也有 SOP 入口。SOP 插件 13,598 行，但"发 SOP 的入口"在内核。

【推断】这四处不是"错"，而是"内核 + 第一方插件"折中的必然结果：好处是插件不用重复实现数据面，坏处是①卸载/停用后内核里留下死路由死表；②内核要为插件概念改代码，插件化红利只兑现一半；③第三方插件想用同样的能力，只能拿到内核替第一方准备好的那几条句柄。

---

## 2. Core 接口与边界：宽接口、单向校验、只落地一条的静态检查

### 2.1 `Core` 27 个方法的消费分布（`internal/plugin/plugin.go:90`）

按非测试代码里出现的方法调用，统计使用该方法的插件数：

| 使用插件数 | 方法 |
|---|---|
| 9/9 | `Log`、`Store` |
| 6 | `Notify` |
| 5 | `Objects` |
| 4 | `Events`、`Contacts`、`ObjectWriter`、`Connectors`、`HTTP`、`SOP`、`Audit`、`Runs`、`Incidents` |
| 3 | `Conversations`、`Granted` |
| 2 | `ContactWriter` |
| 1 | `Dicts`、`ConversationWriter`、`Identities`、`AttachmentDir`、`WorktreeDir`、`CacheDir`、`Agent`、`Knowledge`、`RevokePermission`、`Artifacts` |
| 0（插件侧） | `PluginID`（宿主内部用） |

即 **11/27 个方法只有 ≤1 个插件在用**，`Log`+`Store` 之外没有真正"公共"的能力。轻量插件只用到极小面：browser 用 `Log`/`Store`/`Connectors`（3 个），domains 用 `Log`/`Store`（2 个），etf 用 `Store`/`Log`/`Notify`/`HTTP`（4 个），terminal 用 `Store`/`Log`/`Objects`/`Audit`（4 个）。

**问题不在"27 个方法多"**，而在分发方式：`Core` 是整个接口值，`Register`/`Job`/`TodayCard`/`SOPNode.Run`/HTTP handler 里拿到的都是全量 27 个能力。【推断】对第一方插件（都可信、都在同仓库）影响小；对第三方，等于每个插件默认持有全部内核能力，最小权限只能靠约定。

**测试成本有直接证据**：插件测试需要真实注册表或嵌入式桩：`plugin.NewRegistry` 在插件测试出现 36 处、`Set*` 接线 102 处、36 个插件测试文件打开真 SQLite 库跑迁移；`plugin.Core` 的桩靠 embedding 写测试插件（如 `projects/permissions_test.go:12`、`terminal/permissions_test.go:15`）。测试总量 640 个（宿主 81 + 插件 559），质量不差，但每个新插件都要重复搭这套脚手架。

### 2.2 绕边界的手段与现状

插件越界渠道按危害排序，逐个查过：

| 渠道 | 现状（事实） |
|---|---|
| 跨插件 import | 非测试代码 **0 处**（`internal/plugins/a` 不 import `internal/plugins/b`）；只有宿主检查与前端 lint 兜着，没有 Go 侧检查 |
| 直连数据库 | 8 个非测试文件 import `database/sql`（video/biliapi.go、projects/protosync.go、projects/worktrees.go、sop/gate.go、sop/folders.go、terminal/launch.go、im/quickreply.go、im/expiry.go），用途多是 `sql.ErrNoRows`/`sql.NullString` 而非自建连接；`internal/db` 无插件 import。文档禁令见 `docs/plugin-api.md:2020` |
| 绕过 HTTP 句柄 | 自建客户端/传输 4 处：`domains/system.go:216-247`（自建 `net.Dialer` 探测上游）、`domains/proxy.go:162-164`（反代 transport）、`projects/testenv.go:824`、`sop/nodes_ai.go:388`（包级 `httpClient`，HTTP 节点只查 `network:any` 不逐请求查 host——`network:any` 本身不限制 host，所以语义上说得过去）（另有 `trade/exchange.go:104-111` 采用"克隆内核客户端再包一层"的写法，属于正确用法） |
| 文件/进程 | 无 `FS`/`Process` 句柄，全靠插件自愿 `Require`/`Granted`：fs/exec/net 调用数 projects 66/检查 10、video 65/9、im 31/0、sop 16/4、domains 14/0、trade 7/8、terminal 5/2、etf 2/0、browser 1/0；`exec.Command` 10 处、`net.Dial` 4 处。【推断】检查基本都落在路由入口，深层调用不复查，属"配合式"权限 |
| 清单没声明却注册 | 宿主会拦：6 组扩展点注册前查 `provides`（§1.1 表），另有路由前缀、事件类型检查（`collect`，`registry.go:662`） |

### 2.3 `boundary_test.go` 与契约测试到底守了什么

- `internal/plugin/boundary_test.go:16` 用 AST 扫非测试 `internal/plugins/**`，**只禁 4 个符号**：`http.DefaultClient`、`http.Get/Post/PostForm/Head`。不查 `&http.Client{}`、`http.NewRequest`、`http.DefaultTransport`、`net.Dial`、`database/sql`、`os.WriteFile`、`os/exec`、跨插件 import。
- 文档承诺的后端静态检查有 3 条（`docs/plugin-api.md:2020` 禁 `database/sql`+`internal/db`；`:2024` 禁 `http.DefaultClient`/`os.WriteFile`/`exec.Command`；`:2026` "前后端注册时比对 provides"）。**实际只落地了第 2 条的一小半（4 个符号）**。
- `internal/api/contract_shape_test.go` 把插件响应结构手抄成 151 条 spec（`:143` 起），`internal/api/contract_doc_test.go:37-61` 手工 `plugins.Add` 九个插件后比对 `docs/api-contract.md`。这两个测试方向是对的（防文档漂移），但**清单是手写的**：新插件不加进这两处，它的路由和结构就静默不进契约检查，测试照样绿。
- 路由注册机制另有结构性保障：路由在启动时固定注册、按 activation 查 404（`registry.go:440-463`），`TestEnableRejectsChangedRoutes` 之类防止启用前后路由漂移。

**结论**：边界守卫是"文档 + 一个很窄的 AST 测试 + 人工 review"。目前仓库干净（跨插件 import 0、`internal/db` 0），属于"守住了但没设防"。【推断】一旦有第三方或仓外贡献者，这套防线会直接漏。

---

## 3. 生命周期与隔离：机制都在，但有几处名义与实际的缝

### 3.1 各机制的实际状态

| 机制 | 实现位置 | 实际效果 |
|---|---|---|
| 安装前置检查（API 版本、依赖已启用、连接器冲突、权限确认） | `registry.go:300-330`、`manifest.go:211` | 生效；依赖要求"已启用"而不只是已装 |
| 迁移校验和 + 已应用不可改 | `migrate.go`（`verifyMigrations`）、`Start` 时 `registry.go:207` | 生效，启动即拒绝 |
| 迁移 SQL 静态检查（只许 CREATE TABLE/INDEX、ALTER ADD、本前缀表） | `migrate.go`；运行时 SQL 再查 | 生效；`Store` 层还查语句里出现的表名（`store.go:182`） |
| 表前缀隔离 | 每插件 `table_prefix=<id>_` + `pluginStore` 包装 | 生效（产库 107 张表全部带前缀） |
| 权限确认/升级补确认 | `permissions.go`、`api/plugins.go:381-450` | 生效；单独授权 `trade:live` 只许用户本人（`RequireUser`）+ 插件 `PermissionGuard` 同意 + 二次确认 |
| 网络白名单 | `network.go:95`（组→host）、`:159`（`Core.HTTP(group)`）、`:181`（每请求重查，含重定向） | **只对走句柄的请求生效**；不走 `Core.HTTP` 的绕过大半（§2.2） |
| 停用：撤路由 404、取消 Job ctx、撤订阅、依赖拒绝 | `registry.go:362-399`、`:693-711`、`:471` | 生效且有测试（`registry_test.go:122` 等） |
| 卸载：只能从停用、备份、`OnUninstall(deleteData)`、`DropData` 删前缀表 | `uninstall.go:27` | 生效；卸载前校验依赖（安装的不论启停） |
| 升级：迁移→写新版本/权限→停旧→collect→起新 | `permissions.go:137-182` | **非原子**，见下 |

### 3.2 五个"名义与实际的缝"

1. **升级非原子**（事实）：`Upgrade` 顺序是 `migrate` → `store.Save(新版本、新权限)` → `stop` → `checkEnable` → `collect` → `start`。若 `collect` 失败（清单与代码不一致等），状态表已是新版本、插件已停，用户看到"升级了但没在跑"，且没有任何回滚路径；文档 `docs/plugin-api.md:2006` 宣称"任一失败时状态表不动（仍是旧版本）"，与代码不符。
2. **停用超时后协程残留，而且残留时仍可卸载**（事实 +【推断】）：`stop` 等 `StopTimeout`（默认 10s）后只记日志，状态照置停用；测试把"剩 1 个没退出的任务"当正确结果（`registry_test.go:441-470`）。此时 `active==nil` 而 `jobs>0`，`Uninstall` 只要求未启用（`uninstall.go` 无 `jobs==0` 检查），会先备份、`OnUninstall`、`DropData` 删表——【推断】残留协程随后写自己已被删的表，得到持续报错而非干净失败。
3. **没有 deactivate 钩子、goroutine 不受 activation 管理**（事实）：`Plugin` 接口只有 `Register` 与可选 `OnInstall/OnUninstall/CanDisable`。插件自己 `go func` 的地方有 19 处（projects 11、sop 8、terminal 5、trade 2、im 1、video 1），宿主无法在停用时等待/告知它们；能管住的只有 `Job` 的 ctx。在飞 HTTP 请求也不会被取消。
4. **卸载清理语义与文档不符**（事实）：`docs/plugin-api.md:1992` 要求卸载时清理"本插件的设置值、本插件范围的凭证、本插件新建的对象类型"。实际：没有 Settings/Secrets 能力，对象类型根本不由插件注册，所以这三项都无从清理；`OnUninstall` 只有 3 个插件实现（video 撤内置 SOP 模板 `video/sopnodes.go:400`、projects 同类 `projects/kb.go:715`、trade 有在跑部署/挂单时拒绝 `trade/audit.go:194`），且模板删除失败只记警告不阻断卸载。
5. **`optional_depends` 版本永不校验，也没有运行时降级 API**（事实）：`manifest.go:30/452/523` 只解析和防重复声明；`api/plugins.go:69` 只回传给前端显示；`Registry` 没有"某插件是否在跑"的查询（`registry.go` 方法清单：`Add/Start/Close/Install/Enable/Disable/List/Get/Routes/Subscribers/MigrationSteps` 等，无 `IsRunning`）。所以 SOP 对 IM 的可选关系实际由 SOPNode 扩展点兜住（这一点是对的），但 video/domains 对可选依赖的降级只能靠 UI 提示。

**隔离级别定性**：同一进程、同一 SQLite 连接池、无 panic 域隔离（`runOnce` 有 `recover`，路由 handler 的 panic 由 `net/http` 兜），停用是"尽力而为的软隔离"。对第一方够用，与 `docs/plugin-api.md` 反复强调的"停用即数据不动、后台活动归内核管"（`:2025`）相比，现实里"后台活动归内核管"只覆盖 `Job`，不覆盖插件自起的 goroutine。

---

## 4. 新增一个插件的最小成本与"漏一步"风险

### 4.1 必须动的文件（以 etf 这种"后端只有采集与查询"的最小插件为例）

| 层 | 文件 | 说明 |
|---|---|---|
| 插件本体 | `internal/plugins/<id>/{plugin.go, source.go, plugin.json, migrations/0001_*.sql, *_test.go}` | etf 首个提交就是这 5 个文件（`git show 5a9495d`，1,167 行） |
| 编译期装配 | `cmd/pmw/main.go:207-248` 加 import + `plugins.Add(...)` | 固定顺序 9 个，手工 |
| 契约文档测试 | `internal/api/contract_doc_test.go:37-61` 手工再 `Add` 一遍 | **不加则新插件路由不进契约检查，测试仍绿** |
| 结构契约测试 | `internal/api/contract_shape_test.go` 手工 `import` + 往 `contractSpecs` 抄结构（现有 151 条插件结构） | 同上，漏抄静默 |
| 编号前缀 | `internal/idgen/prefixes.go`（若新增对象/编号前缀） | 编译期全局注册表 |
| 前端插件 | `frontend/src/plugins/<id>/index.ts` + 页面/样式/测试（browser 前端 13 文件） | 只有前端的演示插件才走 `frontend/src/plugins/enabled.ts`；有后端插件不需要 |
| 契约文档 | `docs/api-contract.md` 补路由/结构 | 契约测试强制，但只对上面清单里的插件 |
| 平台白名单 | `internal/plugin/network.go`（若对接新平台） | 加 host 组 |
| 规格文档 | `docs/plugin-api.md`、`docs/plugin-manifest.schema.json`（仅新增扩展点时）；`web-next/docs/` 流程 | 视改动范围 |

**没有脚手架**：`scripts/` 下只有 dev/smoke/seed/tls 脚本，没有 `plugin new`/模板生成器；`internal/plugin/plugintest/demo.go` 只是测试用示例插件，不会被 `pmw` 编译进去（`cmd/pmw` 不 import 它）。

### 4.2 双向校验缺一半

- **代码→清单**：有。6 组扩展点注册前查 `provides`（§1.1），路由/事件/连接器冲突另有检查。
- **清单→代码**：**没有宿主级检查**。清单里写了 `settings`/`search`/`object_types`/`agent_tools`/`commands` 但代码零注册，完全合法且无告警——而 `settings` 有 4 个插件在声明（`domains`/`projects`/`sop`/`terminal` 的 plugin.json，`im` 没声明却另有 `/api/im/settings`），`search` 有 2 个（`im`/`projects`）——这些声明目前只是给前端看的，后端实现藏在各自路由里。
- 唯一接近"清单→代码"的检查是各插件自带的 SOP 规格测试（`internal/plugins/{im,projects,video}/sopspec_test.go` 校验节点数与 `provides.sop_nodes` 一致）。其它扩展点没有对等物。
- **没有"全部插件可加载、扩展点与清单一致"的端到端测试**：`TestSchemaInSync`/`TestSpecExamplesInSync` 管清单 schema 与示例，`contract_doc_test` 管路由文档，但没人从 `cmd/pmw` 的插件清单驱动一遍"每个插件都能 Add+Enable+注册点与 provides 相符"。

### 4.3 历史成本（git 证据）

| 插件 | 首次加入提交 | 规模 | 备注 |
|---|---|---|---|
| etf | `5a9495d` | 5 文件 / 1,167 行 | 纯后端采集；之后 `8f32dcb`（70 文件）才接进 `cmd/pmw`，`16b9286`（38 文件）才加前端与 0.2.0 清单 |
| im | `33d2c9a` | 33 文件 / 2,616 行 | 当时会话/身份已在内核 |
| browser | `ad4ffd3` | 297 文件 / 6,175 行（混合） | 含前端、契约文档、`idgen`、宿主改动 |
| domains | `8598c10` | 100 文件 / 11,493 行（混合） | |
| trade+video | `b623e6a` | 465 文件 / 11,576 行（混合） | |

【推断】"最小插件"实际要 5 个后端文件 + 1 处装配 + 2 处契约测试（≈8 个文件），一个"完整插件"（含前端）就是几十上百个文件、跨 8 个目录；没有生成器时，新人最可能漏的是装配点（`main.go`）和契约测试清单——两者漏了都不会报错。

---

## 5. 跨插件依赖图与内核/插件边界

### 5.1 依赖声明（各 `internal/plugins/*/plugin.json`）

| 插件 | depends | optional_depends | 说明 |
|---|---|---|---|
| projects | — | — | 根基（terminal、video 依赖它） |
| terminal | projects `>=0.5.0 <1.0.0` | — | |
| video | projects `>=0.5.0 <1.0.0` | im `>=0.3.0 <1.0.0` | |
| domains | — | projects `>=0.6.0 <1.0.0` | |
| sop | — | im `>=0.7.0 <1.0.0` | |
| im / trade / etf / browser | — | — | |

无环：强依赖有向图 `projects→terminal`、`projects→video`；把可选边也算上（`projects→domains`、`im→video`、`im→sop`）仍无环。全部 9 个插件 `core: ">=1.0.0 <2.0.0"`，宿主 `APIVersion="1.1.0"`（`manifest.go`），版本相容检查只在 Install/Enable 做（`Check`/`checkEnable`），启动时不做——启动只校验迁移和依赖已启用。

### 5.2 谁其实是内核

| 名义上是插件 | 实际证据 | 判断 |
|---|---|---|
| im（14,175 行/44 文件/17 迁移） | 内核有 `conversations`、`contact_identities`、`/api/conversations`、`/api/im-identities`、`internal/imident`；`internal/api/contract_shape_test.go` 还直接 import IM 的结构 | 实质是"内核数据面 + 插件工具栏" |
| projects（9,529 行/19 文件/12 迁移） | 内核种子 `project` 类型、`objects.project_id`、`projectdocs.go` 硬编码 `project`/`docs_dir`；terminal/video 以它为强依赖 | 实质是核心模块 |
| sop（13,598 行/34 文件/11 迁移） | 内核 `internal/schedule/sopcatalog.go`、`internal/plugin/soplaunch.go`/`sopschedule.go`、agent 工具都有 SOP 概念；三个插件向它贡献节点 | 实质是内核的编排层 |
| trade（17,358 行/36 文件/12 迁移） | dev-plan 原本计划拆 4 个可独立安装的插件（行情→监控→策略→交易依赖链）；实现是**一个 17k 行单体**，4 个模块由 `provides.modules` 一起声明，装/停/卸只能整体 | 与规划偏离最大 |

### 5.3 内核反向依赖插件装配吗

- 生产代码里只有一个装配点：`cmd/pmw/main.go:198-251`（`plugin.NewRegistry`、9 次 `plugins.Add`、`Start`），方向是"内核 import 插件"，属于合理的组合根；`internal/plugin` 不 import 任何插件包。
- 但装配面很散：`Set*` 钩子 12 处分布在 3 个文件（`cmd/pmw/main.go` 8 处、`cmd/pmw/upstream.go:66`、`internal/api/server.go:149-152`），`internal/api.Options` 有 27 个服务字段【推断】这种"服务定位器式"装配在新增内核服务时会持续膨胀。
- 测试层面的反向依赖更重：`internal/api/contract_shape_test.go`/`contract_doc_test.go` import 全部 9 个插件（且手写清单）；内核测试因此编译依赖全部插件，插件的结构改动会打破内核测试。
- 另有一个跨层实现：`internal/api` 通过 `SetKnowledge`/`SetRunPresets`/`SetRunCallback` 反向给插件（SOP/Agent）注入内核服务——方向没错，但"数据集散"分散在 3 个文件里，没有统一的 wiring 清单。

---

## 6. 横向能力复用：宿主给了什么，插件还在造什么

| 能力 | 宿主 | 现状与缺口 |
|---|---|---|
| 后台任务 | `Job`（`registry.go:783/712`） | 只有"定间隔/常驻"两档；无状态、无重试/退避、无超时、无执行记录、无 jitter、无并发上限；19 处插件自起 goroutine 不归它管 |
| 事件 | `Events()` 发布 + `Subscribe` 订阅 | 好用；订阅随停用自动撤，`Subscribers` 每次查 activation（`registry.go:471-492`） |
| 通知 | `Notify` | 完备（6 个插件用） |
| 产出物 | `Artifacts` | 只有登记+查询，无更新/删除 |
| 对象写 | `ObjectWriter` 4 个方法（`Create/CreateAs/AppendBody/UpdateTask`） | 每个新需求就长一个方法；且 `objectUpdater` 是运行时探测（`writes.go:72`、`taskstage_write.go:47`），说明宿主自己也不确定注入的 store 支持到哪 |
| 设置 | **无** | 5 套插件自建（§1.3），10 个端点、6 张表 |
| 凭证 | 只有 Connector 配置里的 secret 字段（内核 vault 托管） | 插件不能读写任意 secret；`permissions` 里 `secrets:<scope>` 已在权限文案里（`labels.ts:26`）但能力未实现 |
| 文件/进程 | **无句柄** | 全靠 `os.*`/`exec.Command`，权限靠自愿；文档 `plugin-api.md:2024` 承诺的静态检查不存在 |
| HTTP | `Core.HTTP(group)`：清单声明组、每请求重查 host、含重定向 | 4 处绕过（§2.2），大多是历史遗留或特殊场景（反代、探测） |
| 缓存/附件/工作目录 | `CacheDir`/`AttachmentDir`/`WorktreeDir` | 存在；IM 写附件（`im/attachments.go:368/376`）走 `AttachmentDir`，但清单里只声明了 `network:im`——即"由句柄隐含的能力"没有对应权限声明 |
| Agent/知识库 | `Agent`/`Knowledge` | 各 1 个插件用；能力够 |
| 搜索 | 后端**无** `SearchProvider`；前端命令面板由插件注册命令实现 | 第一方插件的命令注册是 0（只有 hello），所以命令面板的数据源问题（`docs/product-review.md` A-01）在插件侧仍未解 |
| 对象类型 | **无** | 内核种子写死 6 类；插件的"对象"多数在自己表里（video/trade 各 27 张表），失去 Revision/审计/搜索/关联等内核对象能力 |
| 定时动作 | `ScheduleAction` | 好（video 发布用它），但只有 1 个消费方 |
| 通用请求解析/校验/分页 | **无**（内核有自己的 `api/params.go`，不对外） | 各插件自写解析、校验、分页、错误码转换，样板代码多 |

**共性判断**：宿主把"对象、联系人、会话"这三类内核数据的访问做成了句柄（这是对的），但把"插件自己需要的基础设施"（设置、文件、进程、搜索、对象类型、任务调度）留给了插件。于是插件越大越像小内核：im/trade/video 各自带一套表、一套设置、一套平台调用、一套后台循环。

**无必要/过度项**（从后端维护成本看）：
1. **trade 暂停但全量在跑**：`docs/system-overview.md:172` 写"交易套件整体暂停"，代码仍是 17,358 行、27 张表、96 条路由、4 个连接器，且产库中处于停用、每次构建都编译进二进制（迁移不跑，但代码、路由、表结构定义都在）。
2. **`Skill` 扩展点**：机制完备、零第一方消费（只有 `plugintest` 示例），属提前投资。
3. **`adopts` 后端半边**：解析+形状校验+前端仅用 `object_types`，`adopts.routes` 无人消费，属接口噪音。
4. **预置但无实现的配置**：`network.go:32` 白名单含 `open.feishu.cn`/`open.larksuite.com`，但 IM 只有 slack/telegram 两个 adapter（`im/im.go:73-79`）；`permissions` 文案支持 `secrets:*`（`labels.ts:26`）但能力不存在。
5. **前端 4 个 `notImplemented` 扩展点**（`registry.ts:199-211`）：占位接口，插件用会直接抛错，属"文档先行"的接口噪音。

---

## 7. 结论与建议

### 7.1 做得好的（5 条）

1. **安装链完整**：清单 schema + 示例同步测试（`TestSchemaInSync`/`TestSpecExamplesInSync`）、迁移校验和、SQL 静态检查、表前缀、权限逐项确认、安装前备份——这条链在文档与代码里是闭环，且各有测试。
2. **停用撤注册干净**：路由启动时固定注册、停用后同路径 404、订阅撤、Job ctx 取消并等待、重新启用恢复（`registry_test.go:122` 起）；不会出现"菜单没了接口还在"。
3. **扩展点注册前的宿主裁决一致**：清单声明、id 前缀、冲突（连接器）、必要权限、路由前缀、事件白名单，全部在 `collect` 里集中拒绝，而不是各插件自己保证。
4. **SOP 节点协议是跨插件协作的样板**：`Spec.Params/Outputs/Effect/DryRun` + 挂起/唤醒（`ErrWaiting`/`SOP.Resume`）+ 提供方停用时降级（`ErrNodeUnavailable`），三个插件共 31 个节点；调试时按 Effect 模拟执行，避免"调试真的发消息"。
5. **权限分级与单独授权做对了**：安装时确认、升级新增权限重新确认、`trade:live` 单独申请（用户本人 + 插件 `PermissionGuard` 同意 + 二次确认 + 审计），网络白名单每请求重查（含重定向）——这是全仓库最接近"安全边界"的设计。

### 7.2 扩展性风险与差距（7 条，按严重度）

1. **内核模块不插件化 → 通用能力缺句柄 → 插件重复造轮子**：设置 5 套、fs/process 裸调用、搜索/对象类型未实现、`ObjectWriter` 每需求长一个方法（§1.3、§6）。
2. **`Core` 宽接口 + 无最小权限**：27 个方法全量下发，11 个 ≤1 个插件用；测试替身/桩成本高；第三方开放前必须拆（§2.1）。
3. **边界守卫名不副实**：文档 3 条后端禁令只落地 1 条的一小半；`database/sql` 8 文件、自建 HTTP 4 处、`net.Dial`/`exec` 遍布；无跨插件 import 检查（当前 0 违反，靠人工守）（§2.2-2.3）。
4. **升级非原子 + 隔离是尽力而为**：升级失败留"已升级未启动"；停用超时协程残留且仍可卸载；无 deactivate 钩子；在飞请求不取消（§3.2）。
5. **卸载语义与文档不符**：设置/凭证/对象类型清理无从执行；`OnUninstall` 只有 3 个插件实现，SOP 模板删除失败只记日志（§3.2）。
6. **清单校验单向 + 装配点手工**：`provides` 声明而代码不注册合法；新插件要改 `main.go` + 两个契约测试的硬编码清单，漏一处不报错；无脚手架（§4）。
7. **内核吸走插件域模型**：conversations/identities、project 类型/docs_dir、SOP 目录/调度都在内核；im/projects/sop 是内核级插件（共 5.1 万行），trade 单体与"拆 4 个"的规划背离；"插件化"对第一方只兑现一半（§5.2）。

### 7.3 ROI 排序的建议

| 优先级 | 建议 | 收益 | 范围/代价 |
|---|---|---|---|
| P0 | 实现通用设置：`Core.Settings()` + 内核 `plugin_settings` 表 + `GET/PUT /api/settings/plugins/{id}/{section}`（文档 2.2 已有完整接口设计） | 删掉 5 套自建设置（10 端点/6 表），统一校验与权限路径 | 内核 1 迁移 + 1 句柄（约 300 行）+ 5 个插件各自删 50-150 行 |
| P0 | 加后端边界静态检查：`go/analysis` 或 AST 测试扫 `internal/plugins/**`，禁 `database/sql`、`internal/db`、`internal/plugins/*`（跨插件）、`net.Dial`、直接 `os/exec`（白名单注释放行特殊场景） | 把文档 3 条禁令落地，第三方前置；现在 8 处 `database/sql`、4 处自建 HTTP 会暴露并清理 | 1 个测试文件（约 200 行）+ 少量 `// 例外：` 注释 |
| P0 | `provides`↔代码双向校验：`Add`/`Enable` 时对比注册结果与清单，缺注册即失败；新增"从 main.go 清单驱动全部插件加载"的端到端测试 | 消灭静默漏注册/漏接线（含契约测试硬编码清单的坑） | 宿主约 30-50 行 + 测试改造 |
| P1 | 升级原子化：`collect` 失败时回滚状态表并恢复旧激活；或把"写状态"移到最后 | 消灭"升级了但没在跑" | `permissions.go:137-182` 约 30 行 + 测试 |
| P1 | 停用/卸载补隔离：`stop` 返回未退出任务数、`Uninstall` 要求 `jobs==0`（或先强制关闭再删）、加可选 `Deactivate(ctx)` 给有长期资源的插件 | 消除"表被删协程还在写"的隐患 | 小，宿主 3 处 |
| P1 | 拆分 trade 为 dev-plan 设计的 4 个插件 | 与规划一致，降低单插件耦合；但影响面大 | 大，需单独排期 |
| P2 | 对象写能力一次做全（`ObjectService`：update/delete/relation，替代 `objectUpdater` 运行时探测） | 减少"每需求长一个方法"和插件对内核表的绕过冲动 | 中，内核 1 组句柄 + 迁移兼容 |
| P2 | `Job` 升级为带状态/重试退避/超时/执行记录的调度，并把 19 处裸 goroutine 中周期性的迁入 | 停用隔离与可观测性同时改善 | 中，宿主重写 `Job` + 各插件迁移 |
| P3 | 清理文档/接口噪音：`plugin.go:17` 的"七个扩展点"、前端 4 个 `notImplemented`、`adopts` 后端要么实现校验要么标注"仅前端"、`network.go` 预置 host 加注释 | 降低读代码的误导 | 极小 |
| P3 | 新插件脚手架：模板目录 + 注册点清单（main.go、两个契约测试）+ 试跑测试 | 把"最小插件 8 个手工文件"降到 1 条命令 | 小，需维护 |

（本报告未覆盖前端模块化、UX 与产品功能取舍；相关结论见同目录其它评审与 `docs/product-review.md`。）

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
