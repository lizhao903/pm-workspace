# 插件清单格式和插件 API

一人之下的内核加插件架构的接口规范：插件清单怎么写、插件能往内核里注册什么、权限怎么确认、生命周期每一步前后端各做什么、插件不能做什么。

- 来源：`web-next/docs/dev-plan.md` 2.3 到 2.8、第 6 节；已定决策见 `docs/dev-decisions.md`
- 任务：CORE-01a（本文档）；类型定义和校验在 CORE-01b，后端注册在 CORE-04a，迁移在 CORE-05
- 范围：只定第一方插件需要的东西。第三方插件（进程外、走 HTTP 或 MCP）到 M3 之后再开放，到时在本文档上加一版
- 插件 API 版本：`1.1.0`（M2 起 1.0.0，VID-03a 升到 1.1.0），见第 1.3 节

## 评审记录

| 评审人 | 日期 | 结论 |
|---|---|---|
| Claude（代评，待用户复核） | 2026-10-28 | 通过。第 8 节待定事项：1 同意「强依赖不许成环、弱依赖允许」；2 交易套件表前缀放到 M6 定；3 第三方插件协议 M3 之后另起一版。偏离开发计划的一处（干系人留在内核、不划给项目插件）理由成立：任务的负责人字段也引用干系人表，同意。第 6 节模板样例里的 terminal、browser 模块，PROTO-05 要把它们改成项目内的展开区域，到时同步改样例 |

按 `docs/dev-decisions.md`「设计文档的用户评审由主会话代评」，由主会话代评并标注「Claude 代评，待用户复核」。用户复核时提出的修改，按修改调整本文档和已开工的相关任务。

---

## 0. 术语和约定

| 词 | 意思 |
|---|---|
| 内核 | 必装、不能卸载的部分：外壳、对象模型、身份、连接器框架、Agent 框架、执行与调度、事件总线、凭证保险箱、审计、插件管理；内核模块是今日、任务、文档、联系人、会话、设置 |
| 插件 | 按需安装的功能包，带一份清单；第一方插件和内核同仓库、编译进同一个二进制、一起构建前端 |
| 扩展点 | 插件能往内核里注册的东西，共十个，见第 2 节 |
| 插件 id | 清单里的 `id`，全局唯一，同时决定表前缀、接口路径前缀、事件前缀 |

约定：

- 插件目录：后端 `internal/plugins/<id>/`，前端 `frontend/src/plugins/<id>/`
- 清单文件只有一份：`internal/plugins/<id>/plugin.json`。后端用 `embed` 读；前端构建时通过 Vite 的 glob 导入同一个文件（`server.fs.allow` 放开这个目录），运行时的安装、启用状态从 `GET /api/plugins` 拿。不在两边各写一份，避免漂移
- 清单字段名用 snake_case，和后端 JSON 风格一致；前端类型里保持同名
- 所有 id、key 都是小写字母、数字、下划线，插件 id 不带下划线以外的分隔符

## 1. 清单

### 1.1 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `id` | string | 是 | 插件 id，`^[a-z][a-z0-9_]{1,23}$`。一经发布不能改：表前缀、迁移记录、已确认权限、工作台配置都挂在它上面。不能和内核保留字重名（见 1.4） |
| `name` | string | 是 | 显示名，插件管理页和菜单用 |
| `description` | string | 否 | 一句话说明，插件管理页用 |
| `icon` | string | 否 | 本插件功能模块在一级菜单上的图标，外壳内置图标的 key（`^[a-z][a-z0-9_]*$`，如 `folder`、`message`）；外壳不认识的 key 用默认图标 |
| `icons` | object | 否 | 按模块给的菜单图标：`{ "<模块 id>": "<图标 key>" }`，模块必须在 `provides.modules` 里，图标 key 规则同 `icon`。没给的模块用 `icon`。例：交易套件 `{ "markets": "candles", "monitor": "pulse", "strategy": "chart", "trading": "swap" }` |
| `version` | string | 是 | 插件自己的版本，semver（`MAJOR.MINOR.PATCH`）。升级判断、依赖匹配都用它 |
| `core` | string | 是 | 要求的插件 API 版本范围，semver 范围语法（见 1.2）。内核的插件 API 版本不在范围里就拒绝安装和启用 |
| `depends` | object | 否 | 强依赖：`{ "<插件 id>": "<版本范围>" }`。安装前必须已装且版本匹配；被依赖的插件停用时，本插件跟着停用 |
| `optional_depends` | object | 否 | 弱依赖：装了就联动，没装也能用。例：IM 消息在装了项目插件时提供「绑定到项目」 |
| `provides` | object | 是 | 本插件注册的扩展点 id 清单，按扩展点分组（见 1.5）。代码里注册的东西必须在这里列出，反之亦然，CORE-01b 的校验和 CORE-04a 的注册都会比对 |
| `emits` | string[] | 否 | 本插件会发布的事件类型，必须以 `<id>.` 开头 |
| `subscribes` | string[] | 否 | 本插件订阅的事件类型（内核事件或别的插件的事件）。订阅别的插件的事件时，那个插件要在 `depends` 或 `optional_depends` 里 |
| `adopts` | object | 否 | 认领插件化之前就在内核里的东西，见 1.6。只给第一方插件用 |
| `permissions` | string[] | 是 | 需要的权限，见第 3 节；可以是空数组 |
| `migrations` | string | 否 | 迁移目录，相对插件目录。没有自己的表就不写 |
| `table_prefix` | string | 有迁移时必填 | 本插件的表名前缀，必须是 `<id>_`（交易套件这类插件族可以申请共享前缀，如 `trade_`，在内核的白名单里登记） |

未知字段：CORE-01b 的校验报错，不静默忽略。加字段要升插件 API 的小版本。

### 1.2 版本范围

用 semver 范围，写法和 npm 的子集一致，前后端用同一套解析（CORE-01b 实现）：

| 写法 | 意思 |
|---|---|
| `>=1.2.0 <2.0.0` | 空格分隔表示同时满足 |
| `^1.2.0` | 等价 `>=1.2.0 <2.0.0`；`^0.3.0` 等价 `>=0.3.0 <0.4.0` |
| `~1.2.0` | 等价 `>=1.2.0 <1.3.0` |
| `1.2.3` | 只认这一个版本 |

不支持 `||`、`*`、`x` 通配和预发布标签。开发计划里的 `>=1.2 <2` 这种省略写法按补零处理（`>=1.2.0 <2.0.0`），但清单里推荐写全。

### 1.3 插件 API 版本怎么升

插件 API 版本是内核对插件承诺的接口版本，和内核二进制的发版号分开记，定义在 `internal/plugin` 包里的一个常量，前端从 `GET /api/plugins` 的响应里拿。

| 变化 | 升哪位 | 例子 |
|---|---|---|
| 加扩展点、加清单字段、加注册参数里的可选字段、加内核事件 | MINOR | 加第十一个扩展点 |
| 修文档、修实现，接口不变 | PATCH | |
| 删字段、改语义、改签名 | MAJOR | 改 `Registrar` 的方法签名 |

第一方插件跟内核一起构建，升 MAJOR 时在同一个提交里改完所有第一方插件。这一条是为了把「插件 API 定得太早会频繁改」（开发计划第 6 节）的代价压在仓库内部：M3 之前接口可以改，但每改一次都升版本、写进本文档的变更记录。

### 1.4 内核保留字

插件 id 不能是这些（它们是内核的接口路径段或模块 key）：

`api` `admin` `agent` `agent_providers` `agents` `artifacts` `audits` `categories` `connectors` `contacts` `conversations` `core` `counts` `dict_items` `dictionaries` `events` `fs` `health` `hooks` `kernel` `knowledge_bases` `library` `links` `notifications` `objects` `object_types` `plugins` `revisions` `runs` `schedules` `sessions` `settings` `shortcut_groups` `shortcuts` `skills` `stakeholders` `stats` `tags` `tasks` `today` `webhooks` `workspaces`

内核以后加新的一级路径时同步这张表；已发布插件的 id 和新路径冲突时，内核让路（换内核路径），不改插件 id。

### 1.5 `provides` 的分组

| 键 | 扩展点（第 2 节） | 每项是什么 |
|---|---|---|
| `modules` | 2.1 功能模块 | 模块 key，等于工作台菜单里的 key，例 `projects`、`messages`、`videos` |
| `settings` | 2.2 设置分节 | 设置分节 key |
| `object_types` | 2.3 对象类型 | 新对象类型 id，必须等于插件 id 或以 `<id>_` 开头 |
| `connectors` | 2.5 连接器 | 连接器工具 id，例 `slack`、`bilibili` |
| `skills` | 2.6 技能 | 技能 id，以 `sk_` 开头 |
| `agent_tools` | 2.6 Agent 工具 | 工具名，以 `<id>_` 开头 |
| `sop_nodes` | 2.7 SOP 节点 | 节点 kind，以 `<id>_` 开头 |
| `today_cards` | 2.8 今日卡片 | 卡片 key，以 `<id>_` 开头 |
| `commands` | 2.9 命令面板命令 | 命令 id，`<id>.<动作>` |
| `search` | 2.9 命令面板数据源 | 搜索数据源 key |
| `schedule_actions` | 2.12 定时任务动作（只有后端） | 动作 kind，以 `<id>_` 开头，例 `video_publish`（VID-06a） |

数据迁移（2.4）用顶层的 `migrations` 和 `table_prefix`，事件订阅（2.10）用顶层的 `emits` 和 `subscribes`，不放进 `provides`。

开发计划 2.4 的样例里 `connectors` 写的是 `douyin`、`channels` 这类不带前缀的名字。连接器 id 是全局命名空间（一个平台只该有一个连接器定义），不加插件前缀，靠内核检查重复：两个插件声明同一个连接器 id 时，后装的拒绝安装。

### 1.6 `adopts`：认领插件化之前的东西

项目、对象类型 `project` 这些在插件化之前就已经在内核里了（`project` 类型由 0002 号迁移写进 `object_types`）。已应用的迁移不能改、表不能搬，所以插件不「拥有」它们，只「认领」：

| 键 | 意思 | 停用时 | 卸载删数据时 |
|---|---|---|---|
| `object_types` | 认领已有的对象类型 | 该类型从新建菜单、命令面板里隐藏；已有对象仍能通过搜索、关联打开（只读） | 不删类型，不删对象；只在插件管理页提示「这些对象还在，可以在文档或任务里看到」 |
| `routes` | 认领已有的内核接口路径 | 这些路径返回 404 | 同停用 |

认领只能认领内核白名单里列出的东西（白名单写在 `internal/plugin`，CORE-04a 实现）。白名单第一版只有一项：`project` 类型给 `projects` 插件。

决策（CORE-01a）：干系人（`stakeholders`、`object_participants` 两张表和 `/api/stakeholders` 接口）留在内核，不给项目插件认领。理由：0010 号迁移让所有对象的 `owner_id` 都引用干系人，任务、需求也用，停用项目插件不能让任务的负责人失效。项目插件只提供项目页里的「干系人」标签页，数据走内核接口。撤回：把干系人加进认领白名单即可，不动表。

---

## 2. 扩展点

十个扩展点，每个给出前端注册函数、后端注册接口和一个例子；另有只在后端的按 Host 分发（2.11）。

### 2.0 公共部分

前端入口（`frontend/src/plugins/<id>/index.ts`），由内核按清单动态 `import()`，没装或没启用的插件不加载：

```ts
// frontend/src/core/plugin/api.ts（CORE-01b 定类型，CORE-02b 实现）
export interface Disposable { dispose(): void }

export interface PluginEntry {
  /** 启用时调用。只注册，不发请求；数据在页面里按需取 */
  activate(api: PluginApi): void
  /** 停用时调用。注册过的东西内核会自动撤掉，这里只清插件自己的定时器、订阅之外的资源 */
  deactivate?(): void
}

export function definePlugin(entry: PluginEntry): PluginEntry

export interface PluginApi {
  readonly id: string
  readonly manifest: PluginManifest
  modules: ModuleRegistry          // 2.1
  settings: SettingsRegistry       // 2.2
  objectTypes: ObjectTypeRegistry  // 2.3
  migrations: MigrationInfo        // 2.4（只读）
  connectors: ConnectorRegistry    // 2.5
  agent: AgentRegistry             // 2.6
  sopNodes: SopNodeRegistry        // 2.7
  todayCards: TodayCardRegistry    // 2.8
  commands: CommandRegistry        // 2.9
  events: EventRegistry            // 2.10
  /** 内核的数据访问层（CORE-03a）；插件只能通过它读写数据 */
  data: DataClient
  /** 外壳能力：跳转、抽屉、提示、确认框 */
  shell: ShellApi
}
```

规则：

- 每个 `register` 返回 `Disposable`；停用时内核按插件 id 统一撤销，插件不用自己记
- 注册的 id 不在清单 `provides` 里：开发环境直接抛错，生产环境拒绝注册并记运行异常
- 插件的状态只放在自己目录里（自己的 store 或组件状态），不读写别的模块的状态（第 5 节）

后端入口（`internal/plugins/<id>/plugin.go`）：

```go
// internal/plugin（CORE-04a 实现）
package plugin

type Plugin interface {
	// Manifest 返回 embed 进来的 plugin.json 解析结果。
	Manifest() Manifest
	// Migrations 返回迁移目录；没有自己的表返回 nil。
	Migrations() fs.FS
	// Register 在启用时调用，只登记，不做 IO、不起协程。
	Register(r Registrar) error
}

// 可选：需要在生命周期节点做事的插件实现这些。
type Installer interface   { OnInstall(ctx context.Context, c Core) error }
type Uninstaller interface { OnUninstall(ctx context.Context, c Core, deleteData bool) error }
type DisableGuard interface {
	// CanDisable 返回 false 时内核拒绝停用并把 reason 给用户看，例：交易插件还有挂单。
	CanDisable(ctx context.Context, c Core) (ok bool, reason string)
}

type Registrar interface {
	Core() Core

	Routes(fn func(m RouteRegistrar))     // 2.1
	Job(j Job)                            // 2.1
	SettingsSection(s SettingsSection)    // 2.2
	ObjectType(t ObjectTypeDef)           // 2.3
	Connector(c ConnectorDef)             // 2.5
	Skill(s SkillDef)                     // 2.6
	AgentTool(t AgentToolDef)             // 2.6
	SOPNode(n SOPNodeDef)                 // 2.7
	SOPStarter(st SOPStarter)             // 2.7，只给 provides.modules 含 sop 的插件（SOP-01d）
	TodayCard(c TodayCardDef)             // 2.8
	SearchProvider(p SearchProviderDef)   // 2.9
	Subscribe(eventType string, h EventHandler) // 2.10
	HostHandler(d HostHandlerDef)        // 2.11，只有后端
	ScheduleAction(d ScheduleActionDef)  // 2.12，只有后端（VID-06a）
}

// Core 是插件能用的全部内核能力。每个方法拿到的都是按本插件 id 和权限收窄过的句柄。
type Core interface {
	PluginID() string
	Objects() ObjectService     // 读所有类型；写只限本插件声明或认领的类型
	Links() LinkService
	Contacts() ContactService   // 联系人、IM 身份、会话（CT-01、CT-02）
	Artifacts() ArtifactService // 产出和文件（AG-03）
	Settings() SettingsStore    // 本插件命名空间下的设置值
	Secrets() SecretStore       // 只能取 secrets:<scope> 声明过的范围（CORE-06）
	HTTP(group string) (*http.Client, error) // 只给 network:<group> 声明并确认过的组，每一跳查域名清单（VID-04a，3.1）
	FS(scope string) (FS, error)             // 只给 fs:<read|write>:<scope> 声明过的范围
	Process() (ProcessRunner, error)         // 只给声明了 process:spawn 的插件
	Events() Publisher          // 只能发布清单 emits 里的类型
	Audit() AuditLog            // CORE-08；已实现 Note(ctx, AuditNote, WriteMeta)，插件替用户做的对外动作记一条（SOP-02b）
	Store() Store               // 只能访问 table_prefix 开头的表
	Agent() AgentService        // 用默认服务商补全、按 Agent 的授权跑一轮、搜指定知识库（SOP-01c）
	Granted(perm string) bool   // 用户确认过这项权限没有，只认状态表里确认过的（SEC-01，3.3）
	SOP() SOPService            // 插件登记的 SOP 节点、执行插件节点、唤醒挂起的步骤（SOP-03a）、指向流程的定时任务（SOP-01d），2.7
	Notify(ctx context.Context, n Notification) error // 以本插件的名义发通知，kind 补插件前缀（VID-06b）
	Runs() RunService           // 发起 Agent、SOP 运行或交给 Claude Code，跑完投 run.finished（VID-03a）
	Log() *slog.Logger
}
```

`RouteRegistrar` 沿用 `internal/api/server.go` 里的同名接口（`HandleFunc(pattern, handler)`），路径必须以 `/api/<id>/` 开头；内核在外面包一层，停用时整组返回 404。加了路由照旧要写进 `docs/api-contract.md`（契约测试双向检查）。

内核对象只读句柄（已实现，`internal/plugin/store.go`）：`Objects().Get(ctx, id)` 返回 `ObjectInfo{ID, Type, Title, Workdir, Deleted}`，没有这个 id 返回 `ErrNoRows`。`Workdir` 是对象自身的 `workdir` 列，对项目就是 `root`，没设为空串，不往所属项目继承（TERM-01c 加）。项目根目录可能存成了 `file://` 地址，拿来当目录用之前过一遍 `plugin.LocalDir`（SEC-01 加：去掉前缀、按 URL 解码，不是 `file://` 的原样返回）。

模型和 Agent 句柄（已实现，`internal/plugin/agent.go`，SOP-01c 加）：实现是 `internal/agent` 的 `Service`，`cmd/pmw` 用 `Registry.SetAgent` 接上；没接上时每个方法回 `ErrNoAgent`。服务商、授权、技能的口径和对话接口（`/api/agent/chat`）一致。

| 方法 | 做什么 |
|---|---|
| `Complete(ctx, CompleteRequest{System, Prompt, Model})` | 不带工具补全一次，回模型说的原文。服务商取默认的（没有默认的取第一个启用的），`Model` 为空用服务商的模型；一个服务商都没有回 `agent.ErrNoProvider` |
| `RunAgent(ctx, AgentRunRequest{Agent, Prompt, Title})` | `Agent` 是 id 或名称，停用的不跑。新建一个挂这个 Agent 的会话（标题 `Title`），按它当前的服务商、模型、技能、工具授权跑一轮。遇到授权是「需确认」的工具不执行，回 `Waiting: true`、`Pending`（给人看的一句话）、`CallIDs`；人在会话里确认或拒绝后由对话接口接着跑 |
| `AgentState(ctx, sessionID)` | 会话里最新一条 Agent 回复（`MessageID`、`Reply`）；回复里还有确认卡片时 `Waiting` 为真。插件靠「`MessageID` 变了、`Waiting` 为假」判断确认后这一轮跑完了 |
| `SearchKB(ctx, kbIDs, query, top)` | 只在给的知识库里检索，回前 `top` 段（`KBHit` 即 `kb.SearchHit`）；`kbIDs` 为空直接报错，不搜全部 |

这个句柄暂不按权限收窄：调模型、跑 Agent 不在 3.1 的权限清单里，Agent 能做什么由它自己的工具授权管。

带操作者和审计的写入（已实现，`internal/plugin/writes.go`，SOP-02a 加）：插件替用户自动写内核数据时用，例 SOP 的写节点。和只能建对象的 `ObjectWriter().Create`（IM-02a，`objects_write.go`）走同一个外层包装过的 store（`Registry.SetObjectCreator`），修订、事件照常，不用另外接线。每个方法都带 `WriteMeta{Session, Key, Detail}`：

- 操作者记为 `<插件 id>#<Session>`（`Session` 空时就是插件 id），来源 `plugin`；对象的 `source` 固定是插件 id。
- 每次成功写入记一条审计：`kind` 为 `agent`、`source` 为 `plugin`，`detail` 补上 `Detail` 的键和 `write_key`。失败的写不记，审计写失败只记日志（同 CORE-08）。
- `Key` 非空时同一个键只写一次，再调回第一次的结果、`Reused` 为真。按同一操作者、`detail.write_key` 相同的审计查；建对象另外把 `props.source_ref.write_key` 写成 `Key` 并按它查，写成了但审计没落下时也认得出。追加正文、写联系人只按审计查。

| 方法 | 做什么 |
|---|---|
| `ObjectWriter().CreateAs(ctx, NewObject, WriteMeta)` | 建对象，校验同 `POST /api/objects`；`NewObject.CategoryID` 是分类 id（可空） |
| `ObjectWriter().AppendBody(ctx, id, text, WriteMeta)` | 在对象正文末尾追加一段，和原文空一行；对象不存在或已删除回 `domain.ErrNotFound` |
| `ContactWriter().Create(ctx, NewContact, WriteMeta)` | 建联系人（干系人名册），`Name` 必填，校验同 `POST /api/stakeholders` |
| `ContactWriter().Merge(ctx, id, ContactPatch, WriteMeta)` | 把非 nil 的字段写进已有联系人，回 `WrittenContact{ID, Name, Fields}`，`Fields` 是改了的字段 |
| `Contacts().FindByName(ctx, name)` | 只读：按名字找没归档的联系人，重名取最早建的，没有回 `ErrNoRows` |

写内核数据不在 3.1 的权限清单里，暂不按权限收窄；能写哪些类型等 `ObjectService` 落地时按「本插件声明或认领的类型」收。

发通知（已实现，`internal/plugin/notify.go`，VID-06b 加）：插件要提醒人时调 `Core.Notify(ctx, Notification{Kind, Level, Title, Body, ObjectID, Data})`，实现是 `internal/notify` 的 `Center`，`cmd/pmw` 用 `Registry.SetNotifier` 接上；落进通知列表（`GET /api/notifications`），同时照常推 `notification.created`。

- `Kind` 必填，小写字母开头、点分段（`publish_failed`、`alert.price`）；内核统一补成 `<插件 id>.<kind>`，已带本插件前缀的不重复加。插件因此发不出内核的 kind（`task.review_requested` 会变成 `<id>.task.review_requested`）；插件 id 本身是内核事件命名空间（`object`、`task`、`run`、`contact`）或保留字时一律拒绝。
- `Title` 必填；`Level` 是 `info`、`success`、`error`，空记 `info`。
- 来源：`Data.source` 由内核写成插件 id，插件自己填的会被覆盖（通知表没有来源列，本批不加迁移）。
- 插件没在跑（停用了、还没启用）回 `ErrNotifyInactive`；已发的通知保留，不随停用、卸载删。没接通知中心（测试里）回 `ErrNoNotifier`。
- 发通知不在 3.1 的权限清单里，不按权限收窄。

发起运行（已实现，`internal/plugin/runs.go`，VID-03a 加）：插件要让 Agent、SOP 或本机 Claude Code 替它干活时用 `Core.Runs()`。三个发起方法都不等跑完，先回运行 id（`run_` 开头），跑完给发起的插件投一条 `run.finished`，插件按运行 id 认是哪次、用 `Get` 取结果。

| 方法 | 做什么 |
|---|---|
| `StartAgent(ctx, AgentRunStart{Agent, Prompt, Title})` | 在后台调 `Agent().RunAgent` 跑一轮（口径同上面的 `RunAgent`），上限 10 分钟。Agent 不存在、停用、服务商不对在结束时报（`status: failed`）；停在要确认的调用上记 `waiting` 并算结束，`Error` 是待确认的那句话，确认后接着跑由会话管，用 `Agent().AgentState(Ref)` 查 |
| `StartSOP(ctx, SOPRunStart{Flow, Input})` | 经 `Registry.StartSOP` 交给 SOP 插件起一条执行（口径同定时任务的 sop 动作，发起方记 `plugin`、插件 id）。SOP 插件没启用回 `ErrNoSOPStarter`，流程不存在、必填空着同步回错误。内核看 SOP 插件发的 `sop.run_status_changed`，到 `done`、`failed`、`stopped` 算结束；人工检查点停着（`waiting`）不算 |
| `StartClaudeCode(ctx, ClaudeCodeStart{Workdir, Prompt, AllowWrites, ObjectID, ScopeType, ScopeID})` | 用 `internal/runner` 在 `Workdir`（绝对路径，校验同任务执行）里跑一次 claude，提示词原样交过去。默认只读；`AllowWrites` 要用户确认过 `process:spawn`，没确认回 `ErrNotGranted`。跑完按执行前后的目录快照登记改动的文件（同任务执行）：来源 `run`、产出者 `run` 加插件 id、`props.plugin_run_id` 是运行 id，挂到 `ObjectID`（可空）和 `ScopeType`/`ScopeID`（可空，要同时给）。不写 `task_runs`：那张表要挂对象，接口层的取消和残留收尾也认不得这里起的进程 |
| `Get(runID)` | 本插件发起的运行 `RunInfo{ID, Kind, Source, Status, OK, Ref, Output, Error, ExitCode, Artifacts, Finished, StartedAt, FinishedAt}`；别的插件发起的、不存在的回 `ErrRunNotFound` |

- `Kind` 是 `agent`、`sop`、`claude_code`；`Status` 是 `done`、`failed`、`waiting`（Agent）、`canceled`（Claude Code）、`stopped`（SOP），只有 `done` 时 `OK` 为真。`Ref` 是 Agent 会话 id 或 SOP 执行 id；`Output` 是 Agent 最新回复或 Claude Code 的过程记录，SOP 为空。
- `run.finished` 只投给发起插件当前在跑的订阅，不上总线：总线上的 `run.finished` 是任务执行的（2.10），通知中心和事件流按任务执行认。载荷 `{ run_id, kind, source, status, ok, ref }`，插件照常在清单 `subscribes` 里写 `run.finished`、用 `Subscribe` 登记；任务执行的那条也会收到，`Get` 回 `ErrRunNotFound` 跳过即可。
- 插件停用后它发起的运行照样跑完、`Get` 照样查得到，只是 `run.finished` 不再投给它；停用期间不能发起（回 `ErrRunInactive`）。
- 每次发起记一条审计：`kind` 为 `agent`、`action` 为 `run`、`target_type` 为 `plugin_run`、`target_id` 是运行 id，操作者是插件 id、来源 `plugin`，`detail` 带种类和 Agent、流程或目录。
- 运行记录只在进程内存里，最多留 500 条跑完的；重启后查不到，在途的 Agent、Claude Code 运行退出时最多等 5 秒。没接实现时回 `ErrNoAgent`、`ErrNoClaudeRunner`（`cmd/pmw` 用 `Registry.SetClaudeRunner` 接上）。
- 发起 Agent、SOP 不在 3.1 的权限清单里，不按权限收窄，同上面的 Agent 句柄。

### 2.1 功能模块

一级菜单项、它的页面、二级菜单；后端是这个模块的接口和后台任务。

前端：

```ts
export interface ModuleDef {
  key: string                 // = provides.modules 里的一项，也是工作台菜单里的 key
  label: string
  icon: string                // 内核图标集里的名字
  desc?: string               // 工作台「挑模块」时的说明
  /** 页面组件，用 React.lazy 包，没打开不加载 */
  page: React.LazyExoticComponent<React.ComponentType<ModulePageProps>>
  /** 二级菜单；没有就不出二级菜单 */
  subnav?: { key: string; label: string; badge?: () => number | undefined }[]
  /** 一级菜单上的角标，例：未读数 */
  badge?: () => number | undefined
}
export interface ModulePageProps { sub?: string; params: Record<string, string> }
export interface ModuleRegistry { register(def: ModuleDef): Disposable }
```

后端：

```go
type Job struct {
	Name  string        // 本插件内唯一，审计和执行记录里显示
	Every time.Duration // 定时跑；0 表示常驻
	Run   func(ctx context.Context, c Core) error // ctx 在停用时取消
}
// Registrar.Routes(fn func(m RouteRegistrar))
// Registrar.Job(j Job)
```

例子（IM 消息）：

```ts
api.modules.register({
  key: 'messages', label: 'IM 消息', icon: 'chat', desc: '各渠道收进来的消息，处理和回复',
  page: lazy(() => import('./MessagesPage')),
  subnav: [{ key: 'inbox', label: '收件箱' }, { key: 'mine', label: '与我相关', badge: () => mentions.unread() }],
})
```

```go
r.Routes(func(m plugin.RouteRegistrar) {
	m.HandleFunc("GET /api/im/messages", h.list)
	m.HandleFunc("POST /api/im/messages/{id}/reply", h.reply)
})
r.Job(plugin.Job{Name: "poll", Every: 30 * time.Second, Run: p.pollAll})
```

### 2.2 设置分节

设置页里的一节。值存在内核的设置存储里，按插件 id 分命名空间；凭证类字段不进设置，进凭证保险箱。

前端：

```ts
export interface SettingsSectionDef {
  key: string                 // = provides.settings 里的一项
  label: string
  group?: string              // 设置左侧导航的分组，默认「插件」
  page: React.LazyExoticComponent<React.ComponentType>
}
export interface SettingsRegistry { register(def: SettingsSectionDef): Disposable }
```

后端：

```go
type SettingsSection struct {
	Key    string
	Schema json.RawMessage           // JSON Schema，内核按它校验写入
	Defaults map[string]any
	// Validate 做 Schema 表达不了的检查（例：端口范围不重叠），可以为 nil。
	Validate func(ctx context.Context, v map[string]any) error
}
// Registrar.SettingsSection(s SettingsSection)
// 读写：Core().Settings().Get(ctx, key) / Put(ctx, key, v)，接口由内核统一提供：
// GET/PUT /api/settings/plugins/{id}/{section}
```

例子（项目）：设置分节 `projects`，放「原型端口范围」「新项目默认根目录」。

```go
r.SettingsSection(plugin.SettingsSection{
	Key:      "projects",
	Schema:   projectsSettingsSchema,
	Defaults: map[string]any{"port_from": 5170, "port_to": 5199, "root": "~/Projects"},
})
```

### 2.3 对象类型

带字段定义的对象类型。数据有两种放法：放内核对象表（`objects`，享受搜索、关联、标签、修订记录），或放插件自己的表（见 2.4）。默认放内核对象表；只有字段多、查询重（例：K 线、成交）的才放自己的表。

前端：

```ts
export interface ObjectTypeView {
  typeId: string              // = provides.object_types 或 adopts.object_types 里的一项
  /** 详情抽屉；不给就用内核的通用详情 */
  detail?: React.LazyExoticComponent<React.ComponentType<{ objectId: string }>>
  /** 列表行的副标题、角标 */
  summary?: (o: ObjectRecord) => { sub?: string; badges?: string[] }
}
export interface ObjectTypeRegistry { register(def: ObjectTypeView): Disposable }
```

后端：

```go
type ObjectTypeDef struct {
	ID        string            // 新类型：插件 id 或 <id>_ 开头；认领的类型：adopts 里的 id
	Name      string
	Plural    string
	RefPrefix string            // 编号前缀，例 VID；内核检查不重复
	Icon      string
	Color     string
	Statuses  []domain.Status   // 和 object_types.statuses 同结构
	Fields    []FieldDef        // 自定义字段，存在 objects 的扩展字段里
}
// Registrar.ObjectType(t ObjectTypeDef)
// 新类型在安装时写进 object_types（内核代写，插件不直接 INSERT）；
// 认领的类型只登记归属，不改 object_types 里已有的行。
```

例子（视频创作，M5）：

```go
r.ObjectType(plugin.ObjectTypeDef{
	ID: "videos_clip", Name: "视频", Plural: "视频", RefPrefix: "VID", Icon: "video", Color: "#e8590c",
	Statuses: []domain.Status{{Key: "script", Label: "写稿"}, {Key: "recording", Label: "录制"}, {Key: "published", Label: "已发布", Terminal: true}},
})
```

例子（项目，认领）：`r.ObjectType(plugin.ObjectTypeDef{ID: "project"})`，只给 ID 表示沿用已有定义。

### 2.4 数据迁移

插件自己的表，表名带插件前缀，迁移按插件分目录、单独编号、单独记版本（CORE-05）。

前端：没有注册函数，前端只读。插件管理页在安装、升级前展示迁移计划：

```ts
export interface MigrationStep { plugin: string; file: string; checksum: string; applied_at?: string }
export interface MigrationInfo {
  /** 本插件已应用和待应用的迁移；来自 GET /api/admin/migrations?plugin=<id> */
  list(): Promise<MigrationStep[]>
}
```

后端：

```go
// Plugin.Migrations() fs.FS
// 目录：internal/plugins/<id>/migrations/0001_<说明>.sql，插件内从 0001 起编号，和内核的 0001..0013 无关。
// 应用记录写在插件迁移表里（插件 id、文件名、校验和、插件版本、时间），不写进内核的 schema_migrations。
```

规则：

- 每个文件一个事务；已应用的文件不能改，启动时比对校验和，不一致拒绝启动并指出文件（和内核迁移同一套逻辑）
- 只能 `CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE ... ADD COLUMN` 本插件前缀的表；不能 `ALTER`、`DROP`、`INSERT`、`UPDATE`、`DELETE` 内核表。CORE-05 在应用前做静态检查（按语句前缀和表名），不合规拒绝应用
- 不写回滚脚本。升级失败靠迁移前的自动备份恢复（REL-02），见 4.5
- 外键可以指向内核表（例：`REFERENCES objects(id)`），但不能 `ON DELETE CASCADE` 到内核表之外的方向

例子（IM 消息）：

```sql
-- internal/plugins/im/migrations/0001_messages.sql
CREATE TABLE im_messages (
  id              TEXT PRIMARY KEY,
  connector_id    TEXT NOT NULL,
  conversation_id TEXT NOT NULL,          -- 内核会话（CT-02），不按群名匹配
  identity_id     TEXT,                   -- 内核 IM 身份（CT-01），不按名字匹配
  external_id     TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  mentions_me     INTEGER NOT NULL DEFAULT 0,
  received_at     TEXT NOT NULL,
  UNIQUE (connector_id, external_id)
);
```

### 2.5 连接器

连接器定义：认证方式、配置表单、工具清单。连接器框架（OAuth、Token、工具权限）在内核，插件只提供定义和适配器。凭证由内核的凭证保险箱存，插件拿到的是取凭证的句柄，拿不到明文的存储位置。

前端：

```ts
export interface ConnectorView {
  tool: string                // = provides.connectors 里的一项
  label: string
  color: string
  category: 'im' | 'media' | 'market' | 'dev' | 'other'
  desc: string
  /** 配置表单字段；凭证字段标 secret，前端只显示脱敏提示 */
  fields: { key: string; label: string; kind: 'text' | 'secret' | 'select'; placeholder?: string }[]
}
export interface ConnectorRegistry { register(def: ConnectorView): Disposable }
```

后端：

```go
type ConnectorDef struct {
	Tool     string
	Auth     AuthMode            // AuthToken / AuthOAuth2 / AuthNone
	Network  string              // 用哪个 network 权限组发请求，例 "im"
	Tools    []ConnectorToolDef  // 工具清单：名字、说明、读或写；Agent 工具授权（AG-02）按它逐项授权
	// Test 在「测试连接」时调用，返回账号名（「我」的称呼从这里来，IM-03）。
	Test func(ctx context.Context, cfg ConnectorConfig) (account string, err error)
}
// Registrar.Connector(c ConnectorDef)
// cfg.Secret("bot_token") 经凭证保险箱解密，只在调用期间有效，不落日志。
```

例子（IM 消息，Slack）：

```go
r.Connector(plugin.ConnectorDef{
	Tool: "slack", Auth: plugin.AuthToken, Network: "im",
	Tools: []plugin.ConnectorToolDef{{Name: "read_messages", Write: false}, {Name: "post_message", Write: true}},
	Test:  slack.Test,
})
```

连接器实例句柄（已实现，`internal/plugin/connectors_read.go`，IM-02a 加只读，BR-01a 加两个动作）：`Core.Connectors()` 拿实例的状态，不给凭证和配置；建、改、删实例仍走内核 `/api/connectors`。发起授权和断开的实现是内核的 `connector.Store`，`cmd/pmw` 用 `Registry.SetConnectors` 接上；没接上时这两个方法回 `ErrNoConnectors`。

| 方法 | 做什么 |
|---|---|
| `Get(ctx, id)` | 一个实例的 `ConnectorInfo{ID, Tool, Name, Account, Status, Error, Direction, Scope, AuthorizedAt}`，没有这个 id 回 `ErrNoRows`。`Scope` 是 OAuth 授权下来的范围（空格分隔），`AuthorizedAt` 是最近一次授权完成的时间，没授权为 nil |
| `List(ctx, tool)` | 按工具列实例，新建的在前；`tool` 为空列全部 |
| `StartOAuth(ctx, id, returnTo)` | 发起这个实例的 OAuth 授权，回 `OAuthStart{AuthorizeURL, RedirectURI, ExpiresAt}`，口径同 `POST /api/connectors/{id}/oauth/start`：`returnTo` 只认站内路径或本机地址，实例不是 OAuth 或缺 client_id 回内核的冲突错误。回调照常落在内核 |
| `Disconnect(ctx, id)` | 断开这个实例，口径同 `POST /api/connectors/{id}/disconnect`：状态置为 `disconnected`，OAuth 令牌删掉、授权状态清空。记一条审计（`action: disconnect`，`kind` 为 `agent`，操作者是插件 id），回断开后的 `ConnectorInfo` |

这个句柄暂不按权限收窄：连接器的授权和断开都要用户在界面上点，插件只是替用户转一次（例：浏览器插件的「登录 Google」「退出登录」转给 Google Drive、Google 日历实例，BR-01a）。

调对方接口时拿配置（已实现，VID-04a，`internal/plugin/connectors_config.go`，实现是 `connector.Store.WithConfig`）：`Connectors().With(ctx, id, func(cfg plugin.ConnectorConfig) error)`。

- 只开放本插件登记的连接器实例（定义的 `Source` 是本插件 id）；别的插件和内核的实例、没有这个 id、本插件停用后定义不在了，都回 `ErrNoRows`，回调不会被调。没接上实现回 `ErrNoConnectors`。
- 回调里 `cfg.Get(key)` 取普通字段、`cfg.Secret(key)` 取凭证明文、`cfg.AccessToken()` 取 OAuth 令牌。回调结束即丢，不要把 `cfg` 或里面的值留存、打日志、放进错误。
- 暂停、断开的实例回冲突；OAuth 实例没授权回冲突。令牌已过期或 5 分钟内到期时先刷新（CONN-01b）；刷新失败时令牌还没过期就先用着，已过期回冲突，失败后 30 分钟内不每次都重刷（同后台刷新的退避）。
- 回调返回的错误里出现凭证原文时换成 `***`，没有时原样返回，调用方还能 `errors.Is`。
- 发请求用 `Core.HTTP(def.Network)` 拿的客户端，不用默认客户端（3.3）。

### 2.6 技能、Agent 工具

技能是给 Agent 的一段说明加可选资源；Agent 工具是 Agent 能调用的函数，走内核的工具权限（AG-02：自动、确认、关闭）。

前端：

```ts
export interface AgentToolView {
  name: string                // = provides.agent_tools 里的一项
  label: string
  /** 「确认」模式下给用户看的调用预览；不给就显示参数 JSON */
  preview?: React.ComponentType<{ args: unknown }>
}
export interface AgentRegistry {
  registerToolView(def: AgentToolView): Disposable
  /** 技能只在后端定义；前端注册图标和分组，技能列表从后端读 */
  registerSkillView(def: { id: string; icon: string; group?: string }): Disposable
}
```

后端：

```go
// 已实现（AG-01b2，internal/plugin/skill.go），字段对齐原型 Skill
type SkillDef struct {
	ID           string   // = provides.skills 里的一项，sk_ 开头，不能和内置技能重复
	Name         string   // 必填
	Desc         string   // 一句话说明
	When         string   // 什么时候用
	Instructions string   // 怎么做；为空时读 Prompt 里的 SKILL.md
	Prompt       fs.FS    // 可选，SKILL.md 和资源文件（embed 进来的，登记时读一次）
	Tools        []string // 用到的工具，对应原型 uses
}
type AgentToolDef struct {
	Name        string          // <id>_ 开头
	Description string
	Schema      json.RawMessage // 参数的 JSON Schema
	Write       bool            // 写操作默认「确认」，并记审计日志（CORE-08）
	Run         func(ctx context.Context, c Core, args json.RawMessage) (agent.ToolResult, error)
}
// Registrar.Skill(s SkillDef) / Registrar.AgentTool(t AgentToolDef)
// 返回值沿用 internal/agent 的 ToolResult。
```

技能后端的实现情况（AG-01b2）：

- `Registrar.Skill` 已实现。登记不对（id 不在 `provides.skills`、和内置技能重复、没名称、没说明、本插件内重复）时 `Register` 整体失败，插件起不来。
- 插件技能在 `GET /api/skills` 里 `source` 是插件 id，只读（改、删回 409）；停用插件后不在列表里，`GET /api/skills/{id}` 回 404，挂了它的 Agent 对话时跳过、不报错，重新启用后回来。Agent 的 `skills` 里不摘掉它。
- 对话时按 Agent 挂载顺序拼成「技能：<名称>」段，见 `docs/api-contract.md`「技能 skills」。
- `AgentTool` 还没实现（AG-02）。

例子（IM 消息）：

```go
r.AgentTool(plugin.AgentToolDef{
	Name: "im_draft_reply", Description: "给一条消息起草回复，不发送",
	Schema: draftSchema, Write: false, Run: p.draftReply,
})
```

### 2.7 SOP 节点

SOP 编排插件里的自定义节点类型。SOP 编排本身是插件，所以这个扩展点由内核定义接口、SOP 插件负责执行；没装 SOP 插件时，别的插件注册的节点不显示，也不报错。

前端（字段结构和原型 `web-next/src/nodetypes.tsx` 一致）：

```ts
export interface SopNodeView {
  kind: string                // = provides.sop_nodes 里的一项
  label: string
  group: string               // 节点面板里的分组
  desc: string
  color: string
  fields: { key: string; label: string; type: 'text' | 'textarea' | 'select' | 'multi' | 'number' | 'code'; required?: boolean; default?: string; hint?: string; options?: () => { value: string; label: string }[] }[]
}
export interface SopNodeRegistry { register(def: SopNodeView): Disposable }
```

后端：

```go
// 已实现（SOP-03a，internal/plugin/sopnode.go）
type SOPNodeDef struct {
	Kind     string         // = provides.sop_nodes 里的一项，以 <id>_ 开头
	Group    string         // 节点面板分组，空为「插件」
	Required []SOPNodeField // {Key, Label}，保存时校验的必填配置项
	// Run 拿到上游输入和节点配置，返回输出字段；返回 ErrWaiting 表示挂起等外部事件（例：等对方回复）。
	// c 是提供节点的插件自己的 Core。
	Run func(ctx context.Context, c Core, in SOPNodeInput) (map[string]any, error)
}
type SOPNodeInput struct {
	RunID, FlowID, Step string // Step 是步骤 key，唤醒时用
	Attempt             int    // 从 1 起，重试、退回重做加 1
	Input               map[string]any
	Config              map[string]string
}
// Registrar.SOPNode(n SOPNodeDef)
// Core.SOP() SOPService：Nodes()、Provider(kind)、RunNode(ctx, kind, in)、Resume(ctx, runID, step, output)、Fail(ctx, runID, step, reason)
```

后端的实现情况（SOP-03a）：

- `Registrar.SOPNode` 已实现。登记不对（kind 不在 `provides.sop_nodes`、不以 `<id>_` 开头、没有 `Run`、必填项缺 key 或 label、本插件内重复）时 `Register` 整体失败，插件起不来，错误写明哪一项。
- 内核只存登记，执行由 SOP 插件经 `Core.SOP()` 取到：`Nodes()` 是在跑的插件登记的节点（`Source` 为插件 id），`RunNode` 用提供方的 Core 跑一次（panic 转成错误），提供方没在跑回 `ErrNodeUnavailable`（「提供这个节点的插件已停用」）。
- `GET /api/sop/node-types` 在内置节点后面接上插件节点，带 `source`；停用后消失。用到它的流程定义不动，保存照常（不查必填项），执行到这一步失败并写「提供这个节点的插件已停用」。
- 挂起：`Run` 返回 `ErrWaiting`（可以包一层写原因，如 `fmt.Errorf("等对方回复：%w", plugin.ErrWaiting)`）时步骤停在 `running`，挂起状态落在步骤输出里，服务重启后不重跑、接着等。之后提供节点的插件调 `c.SOP().Resume(ctx, runID, step, output)` 唤醒，这一步 `done`、输出是 `output`，下游接着跑；只能唤醒自己提供的节点，步骤没在等、执行已结束都回错误。SOP 插件没在跑时回 `ErrNoSOPEngine`。`Resume` 要在 `Run` 返回之后调，先存下 `RunID`、`Step`。
- 挂起后要让步骤失败（例：等回复超时）调 `c.SOP().Fail(ctx, runID, step, reason)`（SOP-02b），这一步 `failed`、`error` 是 `reason`，校验同 `Resume`。
- `Registrar.SOPEngine` 只给 SOP 编排插件用（别的插件登记直接失败），是 `Resume` 的接收方。
- 前端登记（`SopNodeRegistry`）归 SOP-03b。示例插件 `internal/plugin/plugintest` 登记了 `demo_wait_reply` 用来测试；第一方节点是 SOP-02b 的 IM 发消息 `im_send_message`、等回复 `im_wait_reply`（契约「IM 消息插件 im」的「SOP 节点」）。
- 内置流程（VID-03d，`internal/plugin/sopflow.go`）：插件经 `Core.SOP().InstallFlow(ctx, SOPFlowTemplate)` 把自带的流程写进 SOP，`RemoveFlow(ctx, id)` 撤下。`SOPFlowTemplate` 形状同 `POST /api/sop/flows` 的请求体，id 必须是 `sop_<插件 id>_` 开头（靠前缀认归属，只能写入、撤下自己的）。内核只转交给 SOP 插件登记的执行引擎，引擎另外实现 `SOPFlowInstaller` 才接得住，否则回 `ErrNoSOPFlowInstaller`。写入时已有同 id 的不动、回 `false`；撤下只删还是第 1 版、没有进行中的执行、没被定时任务引用的，别的回 `false` 和原因。第一个用的是视频插件的「视频周更」（契约「视频创作插件 video」的「SOP 节点和内置流程」）。

**发起 SOP 的钩子（SOP-01d，`internal/plugin/soplaunch.go`）**：SOP 编排是插件，内核不直接调它。定时任务的 `sop` 动作和 Agent 的内置工具 `run_sop` 经这个钩子起执行。

```go
// 请求和结果的类型定义在 internal/schedule（agent、schedule 不能 import plugin），这里是别名
type SOPStartRequest = schedule.SOPRequest // {FlowID（也认流程名）, Input, Source（schedule / agent）, SourceID, SourceName}
type SOPStarted = schedule.SOPStarted      // {RunID, FlowID, FlowName, Status}，不等跑完，Status 是发起时的运行状态
type SOPStarter interface {
	StartSOP(ctx context.Context, q SOPStartRequest) (*SOPStarted, error)
}
// Registrar.SOPStarter(st SOPStarter)
// Registry.StartSOP(ctx, q)：交给在跑的登记方；没有回 ErrNoSOPStarter（「SOP 编排插件没启用」，即 schedule.ErrSOPUnavailable）
// Core.SOP().Schedules(ctx, flowID) ([]SOPScheduleRef, error)：动作 sop 指向这个流程的定时任务 {ID, Name}
```

- 只有清单 `provides.modules` 含 `sop` 的插件能登记，**同一时间只有一个**：已有在跑的插件登记过时，后启用的那个启用失败（「发起 SOP 的入口已由插件 x 登记，同一时间只能有一个」），先停掉前一个再启用。本插件内重复登记、传 nil 也失败。
- 登记方的 `StartSOP` 自己负责找流程、补默认值和必填校验，错误文字给人看（定时任务记进执行记录、Agent 回给模型）；panic 转成「发起 SOP 出错」。SOP 编排插件的实现同 `POST /api/sop/flows/{id}/runs`，不逐步确认，人工检查点照常停下。
- `Schedules` 由内核接上定时任务的查询（`Registry.SetSOPRefs`），没接时回空切片。SOP 插件删流程前用它拦下被定时任务引用的流程（契约「SOP 编排插件 sop」）。

例子（IM 消息，发消息节点）：

```ts
api.sopNodes.register({
  kind: 'im_send_message', label: '发消息', group: '沟通', color: '#0f8a8a', desc: '往指定渠道和会话发一条消息',
  fields: [{ key: 'conversation', label: '会话', type: 'select', required: true, options: conversationOptions },
           { key: 'text', label: '内容', type: 'textarea', required: true, hint: '支持 {{字段}}' }],
})
```

### 2.8 今日卡片

今日页上的一块。数据由今日聚合接口（TODAY-01）一次请求拿全，插件后端提供数据，前端提供渲染；插件停用后卡片消失（TODAY-02）。

前端：

```ts
export interface TodayCardView<T = unknown> {
  key: string                 // = provides.today_cards 里的一项
  title: string
  order?: number              // 越小越靠前，默认 100
  render: React.ComponentType<{ data: T }>
}
export interface TodayCardRegistry { register<T>(def: TodayCardView<T>): Disposable }
```

后端：

```go
type TodayCardDef struct {
	Key   string
	Title string
	Order int // 0 表示默认 100
	// Load 在今日聚合接口里并发调用，超时（默认 800ms）就跳过这张卡，不拖慢整页。
	// 返回 nil 表示今天没有内容，卡片不显示。
	Load func(ctx context.Context, c Core) (*TodayCardData, error)
}
type TodayCardData struct {
	Total int // 全量条数
	Items any // 形状由插件定
}
// Registrar.TodayCard(c TodayCardDef)
```

例子（IM 消息，与我相关）：

```go
r.TodayCard(plugin.TodayCardDef{Key: "im_mentions", Title: "与我相关", Load: func(ctx context.Context, c plugin.Core) (*plugin.TodayCardData, error) {
	top5, n, err := p.unreadMentions(ctx, 5) // 最多 5 条，带总数
	if err != nil || n == 0 {
		return nil, err
	}
	return &plugin.TodayCardData{Total: n, Items: top5}, nil
}})
```

### 2.9 命令面板命令

可搜索的操作，以及命令面板里的数据条目（项目、消息）。命令只在前端执行；后端提供数据源，让命令面板能搜到插件的数据。

前端（结构和原型 `App.tsx` 里命令面板条目一致）：

```ts
export interface CommandDef {
  id: string                  // = provides.commands 里的一项
  group: string
  title: string
  sub?: string
  keywords?: string
  run(ctx: { shell: ShellApi }): void | Promise<void>
}
export interface CommandRegistry {
  register(cmd: CommandDef): Disposable
  /** 动态条目，命令面板打开且有输入时才调用 */
  provide(source: string, fn: (q: string) => Promise<CommandDef[]>): Disposable
}
```

后端：

```go
type SearchHit struct{ ID, Title, Sub, Kind string }
type SearchProviderDef struct {
	Key    string // = provides.search 里的一项
	Search func(ctx context.Context, c Core, q string, limit int) ([]SearchHit, error)
}
// Registrar.SearchProvider(p SearchProviderDef)
// 内核的统一搜索接口按启用的插件合并结果，前端的 provide() 一般就是调它。
```

例子（项目）：

```ts
api.commands.register({ id: 'projects.new', group: '操作', title: '新建项目', keywords: 'project 新建', run: ({ shell }) => shell.openDrawer('projects.new') })
```

### 2.10 事件订阅

订阅内核事件和别的插件的事件；插件也能发布自己的事件。总线在 CORE-07a 实现：事务提交后才发布，订阅者异步执行、互相隔离，出错或 panic 不影响发布方，插件停用后不再收到。

内核事件（第一版）：

| 类型 | 何时 | 载荷 |
|---|---|---|
| `object.created` | 对象新建 | `{ id, type_id }` |
| `object.updated` | 对象字段变化 | `{ id, type_id, fields }` |
| `object.status_changed` | 状态变化 | `{ id, type_id, from, to }` |
| `object.progress_appended` | 记了一条进展（领取、普通进展、提交验收都发） | `{ id, kind }` |
| `task.review_requested` | 任务提交验收 | `{ id }` |
| `run.finished` | 执行结束 | `{ run_id, object_id, ok }`；插件发起的运行不上总线，只投给发起的插件，载荷见 2.0「发起运行」 |
| `contact.identity_merged` | 两个 IM 身份合到一个联系人 | `{ contact_id, identity_ids }` |

插件事件以 `<id>.` 开头，在清单 `emits` 里声明，例 `im.message_received`。

前端（经事件流接口推到前端，CORE-07c）：

```ts
export interface EventRegistry {
  on<T = unknown>(type: string, handler: (payload: T) => void): Disposable
}
```

后端：

```go
type Event struct {
	Type    string
	At      time.Time
	Payload json.RawMessage
}
type EventHandler func(ctx context.Context, c Core, e Event) error
// Registrar.Subscribe(eventType string, h EventHandler)
// 发布：Core().Events().Publish(ctx, "im.message_received", payload)，类型不在 emits 里返回错误。
```

例子（项目，消息到达时刷新项目沟通页的未读数）：

```go
r.Subscribe("im.message_received", func(ctx context.Context, c plugin.Core, e plugin.Event) error {
	return p.bumpUnreadForConversation(ctx, e.Payload)
})
```

已有的插件事件：

| 类型 | 何时 | 载荷 |
|---|---|---|
| `projects.prototype_started` | 原型进程起来了（还没开始监听也发） | `{ id, name, project_id, project_name, port }` |
| `projects.prototype_stopped` | 原型进程退出：点了停止、自己退出、崩溃都发 | 同上，多 `status`：`stopped` 或 `crashed` |
| `projects.prototype_deleted` | 原型定义删了 | 同 `started` |

DOM-02a 加。投递是异步的，先后可能乱，订阅方按 `Event.At` 只认更新的（内网域名插件就这么做）。

### 2.11 按 Host 分发（只有后端）

DOM-02a 加（`internal/plugin/host.go`）。插件接管某个域名后缀下的子域名：请求的 `Host` 落在后缀下、插件也认它时，整个请求交给插件，不进接口层。内网域名插件用它做内置代理，把 `<原型>.<后缀>` 转到原型的端口。

```go
type HostHandlerDef struct {
	Suffix  func() string           // 现在接的后缀（不带开头的点），空串表示不接；每个请求都调，要快
	Match   func(host string) bool  // host 已转小写、去掉端口和末尾的点，一定是 Suffix 下的子域名
	Handler http.Handler            // 拿到的是未经接口层包装的 ResponseWriter，WebSocket 升级可以 Hijack
}
// Registrar.HostHandler(d HostHandlerDef)
```

规则：

- 清单要声明 `network:localhost`，没声明 `Register` 失败；每个插件最多登记一个。用户没确认这项权限、插件停用时不交给它。
- 内核在接口层外面包一层（`Registry.HostDispatch`，`cmd/pmw` 接上）。这些主机永远进工作台、不问插件：空的、`localhost` 和 `*.localhost`、IP、不带点的、`--public-url` 的主机（默认 `bro.vip`）、后缀本身。
- 工作台的别名、目标是工作台的路由由插件自己在 `Match` 里排除；多个插件都认同一个主机时按登记顺序取第一个。
- 交出去的请求不经过接口层的日志、鉴权、错误信封，插件自己回中文说明页。

例子（内网域名插件，`internal/plugins/domains/proxy.go`）：

```go
r.HostHandler(plugin.HostHandlerDef{Suffix: h.hostSuffix, Match: h.hostMatch, Handler: http.HandlerFunc(h.serveHost)})
```

### 2.12 定时任务动作（只有后端）

VID-06a 加（`internal/plugin/scheduleaction.go`）。定时任务内核只认 `task`、`sop`、`agent` 三种动作，插件用这个扩展点加别的：视频的到点发布（`video_publish`），以后交易的盘前简报也走这里。

```go
type ScheduleActionDef struct {
	Kind string // = 清单 provides.schedule_actions 里的一项，以 <插件 id>_ 开头
	// 新建、修改定时任务时校验参数（不含 kind），返回要存的参数；为 nil 时原样存
	Validate func(ctx context.Context, c Core, params map[string]any) (map[string]any, error)
	// 到点执行一次
	Run func(ctx context.Context, c Core, in ScheduleActionInput) (*ScheduleActionResult, error)
}
// Registrar.ScheduleAction(d ScheduleActionDef)

type ScheduleActionInput struct {
	Kind, ScheduleID, ScheduleName string
	RunID  string         // 这次执行记录的 id，按它去重
	At     time.Time      // 计划时刻，手动执行为点按钮的时刻
	Manual bool
	Params map[string]any // Validate 返回的参数
}
type ScheduleActionResult struct {
	Text     string // 写进执行记录，空时写「执行了 <kind>」
	ObjectID string // 产出的对象，可以空
	Ref      string
}
```

规则：

- 动作的参数和 `kind` 平铺在定时任务的 `action` 里（同原型 `ScheduleAction`，例 `{"kind":"video_publish","publish_id":"pb_…"}`），内核原样存、原样回，不认识字段。
- 校验交给插件：`Validate` 回错误时定时任务接口回 `validation` 400，文字是 `action: <错误文字>`。没有插件声明这个 kind 时回「`action.kind must be task / sop / agent or a plugin action`」；声明它的插件没在跑时也回 400（「提供这个动作的插件没启用：视频（video）」），只改名字、启停不重新校验动作。
- 到点由调度器交给插件，执行记录照常写（先记 `running`，同一时刻不重复，错过不补跑）：成功记 `ok`，`Run` 回错误记 `failed`「没执行：<错误文字>」。插件停用、没启动起来时记 `failed`「没执行：提供这个动作的插件没启用：<插件名>（<id>）」，定时任务的定义不动，插件启用后下次照常；插件卸载后同样记 `failed`。
- `Validate`、`Run` panic 时转成错误（「校验动作 <kind> 出错」「动作 <kind> 执行出错」），不带垮调度器。
- `Run` 不要等很久：调度器串行处理到点的定时任务，要长时间跑的事（上传视频）起一条插件自己的执行记录、后台任务里做，`Run` 只回「开始发布，记录 …」。
- 前端只认清单里的 `provides.schedule_actions`（清单校验、插件管理页的分组），定时任务页还没认插件动作（名字、参数表单），随用到它的插件一起加。

例子（示例插件，`internal/plugin/plugintest/demo.go`）：

```go
r.ScheduleAction(plugin.ScheduleActionDef{Kind: "demo_note", Validate: validateNote, Run: d.runNote})
```

---

## 3. 权限

### 3.1 权限清单

格式 `<类别>:<动作>[:<范围>]`。内核只认下表里的权限，未知权限 CORE-01b 校验报错。

| 权限 | 能做什么 | 风险级别 |
|---|---|---|
| `fs:read:project` | 读项目根目录下的文件 | 普通 |
| `fs:write:project` | 写项目根目录下的文件 | 普通 |
| `fs:read:attachments` | 读数据目录下的 `attachments/` | 普通 |
| `fs:write:attachments` | 写 `attachments/`（按渠道分子目录，见开发决策「消息附件存在哪」） | 普通 |
| `fs:read:any` | 读本机任意路径（用户在文件选择器里选的除外，那个不需要权限） | 高 |
| `fs:write:any` | 写本机任意路径 | 高 |
| `network:localhost` | 访问 127.0.0.1 和本机域名 | 普通 |
| `network:im` | 访问 IM 平台（Slack、Telegram、飞书、企业微信的接口域名） | 普通 |
| `network:media-platforms` | 访问视频平台 | 普通 |
| `network:market-data` | 访问行情源 | 普通 |
| `network:exchanges` | 访问交易所的交易接口 | 高 |
| `network:any` | 访问任意外网地址 | 高 |
| `secrets:<scope>` | 取凭证保险箱里该范围的凭证，例 `secrets:im`、`secrets:media` | 普通 |
| `process:spawn` | 起子进程（原型、终端） | 高 |
| `trade:live` | 实盘下单 | 最高 |

`network:<group>` 的域名清单由内核维护（写在 `internal/plugin/network.go` 的 `NetworkHosts`，VID-04a），不由插件自己声明，避免插件给自己开口子。只认 http、https，端口不管；`*.example.com` 只配子域名。同一个域名上公开行情和交易接口混在一起时按路径前缀分组。

| 组 | 域名清单 |
|---|---|
| `localhost` | 回环地址（127.0.0.0/8、::1）、`localhost`、`*.localhost` |
| `im` | `slack.com`、`*.slack.com`、`api.telegram.org`、`open.feishu.cn`、`open.larksuite.com`、`qyapi.weixin.qq.com` |
| `media-platforms` | B 站 `bilibili.com`、`*.bilibili.com`、`*.hdslb.com`、`*.bilivideo.com`；YouTube `youtube.com`、`*.youtube.com`、`youtube.googleapis.com`、`*.googlevideo.com`、`*.ytimg.com`，`www.googleapis.com` 只放 `/youtube/`、`/upload/youtube/`；抖音 `douyin.com`、`*.douyin.com`、`*.douyinpic.com`、`*.douyinvod.com` |
| `market-data` | Binance `data-api.binance.vision`、`data-stream.binance.vision`，`api.binance.com` 只放公开行情路径（`/api/v3/` 下的 ping、time、exchangeInfo、depth、trades、aggTrades、klines、uiKlines、avgPrice、ticker），U 本位永续 `fapi.binance.com` 只放公开行情路径（`/fapi/v1/` 下的 ping、time、exchangeInfo、depth、klines、premiumIndex、fundingRate、fundingInfo、ticker）；OKX `www.okx.com` 只放 `/api/v5/market/`、`/api/v5/public/`，`ws.okx.com` 只放 `/ws/v5/public`、`/ws/v5/business` |
| `exchanges` | Binance `api.binance.com`、`api1` 到 `api4.binance.com`、`fapi`、`dapi`、`stream`、`fstream.binance.com`、`testnet.binance.vision`；OKX `www.okx.com`、`ws.okx.com`。先只列域名，实盘（`trade:live`、TRD-08）之前不用 |
| `any` | 任意 http、https 地址 |

`Core.HTTP(group)`：清单 `permissions` 里没声明 `network:<group>`（或组不存在）回 `ErrNetworkNotDeclared`；声明了但用户没确认回 `*NotGrantedError`（3.3）。拿到的客户端每一跳（含重定向）发出前再查一次确认状态和域名清单，清单外回 `*HostNotAllowedError`（`errors.Is(err, plugin.ErrHostNotAllowed)`，说明里不带查询串），请求不发出去。客户端没设总超时，请求用 `NewRequestWithContext` 带期限。测试用 `Registry.SetHTTPTransport` 把底层换成本机假服务，检查照样在外面。

### 3.2 安装时确认的规则

- 安装前，插件管理页列出清单里的全部权限，每条带一句人话说明（来自上表）；用户点「确认并安装」才继续。确认结果（权限列表、时间）记进插件状态表和审计日志
- 高风险权限（`fs:*:any`、`network:exchanges`、`network:any`、`process:spawn`）单独一行、单独勾选，不勾不能装
- `trade:live` 安装时不授予：交易插件装好后只有模拟盘。要开实盘，在交易插件的设置里单独申请，过二次确认（输入插件名），并且要过 TRD-08 评审。默认只开模拟盘
- 升级时新增了权限：列出新增的那几条要求确认；用户不确认，状态表里的版本和权限都不变，要新增权限的代码路径在运行时被拦（3.3、4.5），其余功能照常
- 升级时减少了权限：直接收回，不用确认
- 第一方插件也走确认流程，不因为是第一方就跳过；内核模块不需要确认

### 3.3 权限怎么生效

权限不是靠插件自觉。插件拿到的所有能力都经过 `Core` 的收窄句柄（2.0）：`HTTP(group)` 只给声明过的组、发请求前检查目标域名；`FS(scope)` 只给声明过的范围、路径越界返回错误；`Secrets()` 只解得开声明过的范围；`Process()` 没声明返回错误。第一方插件和内核同进程，句柄外的路（直接 `os.Open`、`http.DefaultClient`）靠代码评审和静态检查守（CORE-03b 的后端对应规则：`internal/plugins/` 下禁止 import `net/http` 的默认客户端、`os` 的写文件函数、`database/sql`）。已落地的一条：`internal/plugins/` 下的非测试代码不许用 `http.DefaultClient`、`http.Get`、`http.Post`、`http.PostForm`、`http.Head`，由 `internal/plugin/boundary_test.go` 用语法树扫，`go test ./internal/plugin/...` 里跑（VID-04a）。进程外插件阶段（M3 之后）改成物理隔离。

运行时检查（已实现，SEC-01，`internal/plugin/permissions.go`）：上面的收窄句柄还没全做，先有一个查询句柄 `Core.Granted(perm)`，只认状态表里用户确认过的权限（插件没安装时都是 false）。要高风险权限的代码路径在执行前调 `plugin.Require(c, perm)`，没确认时返回 `*NotGrantedError`（`errors.Is(err, plugin.ErrNotGranted)`），`Error()` 直接给用户看：「插件 <id> 的 <权限> 权限还没确认，到插件管理里升级并确认」。现在检查的地方：

| 插件 | 权限 | 检查的地方 |
|---|---|---|
| `sop` | `network:any` | HTTP 节点发请求前，没确认时这一步失败 |
| `projects` | `process:spawn` | 原型启动前，409 |
| `terminal` | `process:spawn` | 新建终端会话前，409 |
| 登记了 Host 处理器的插件（`domains`） | `network:localhost` | 内核按 Host 分发前查，没确认的不交给它（2.11） |

`Granted` 不拿注册表的锁（后台任务里也会调，停用时等任务退出不能卡在锁上），状态变了由注册表换掉它看的权限集合。新加要高风险权限的代码路径时同样调 `Require`。

---

## 4. 生命周期

```mermaid
stateDiagram-v2
  [*] --> 未安装
  未安装 --> 已安装: 安装（检查依赖、确认权限、跑迁移）
  已安装 --> 已启用: 启用（注册扩展点、菜单出现）
  已启用 --> 已停用: 停用（菜单消失，数据保留，后台任务暂停）
  已停用 --> 已启用: 启用
  已停用 --> 未安装: 卸载（选择保留或删除数据）
  已启用 --> 已启用: 升级（跑新迁移，失败回滚）
  已停用 --> 已停用: 升级
```

插件状态（是否安装、是否启用、版本、安装时间、确认过的权限）存在内核的插件状态表（CORE-04a 新迁移）。安装后默认直接启用，安装和启用在界面上是一个动作，后端仍是两步。

管理接口（CORE-04b，加进 `docs/api-contract.md`）：`GET /api/plugins`、`POST /api/plugins/{id}/install`、`POST /api/plugins/{id}/enable`、`POST /api/plugins/{id}/disable`、`POST /api/plugins/{id}/uninstall`、`POST /api/plugins/{id}/upgrade`。第一方插件编译进二进制，所以「可装」列表就是二进制里带的全部插件，「升级」发生在换了新二进制之后。

### 4.1 安装

| 步骤 | 后端 | 前端 |
|---|---|---|
| 检查 | 插件 API 版本在 `core` 范围里；`depends` 都已安装、已启用、版本匹配；连接器 id、对象类型 id、编号前缀不和已装的冲突 | 插件管理页展示检查结果；缺依赖时列出要先装的插件，给「一起安装」（按依赖顺序装） |
| 确认权限 | 无 | 按 3.2 展示和勾选；提交时带上确认的权限列表 |
| 备份 | 有迁移时先调快照（`POST /api/admin/snapshot`） | 显示「正在备份」 |
| 迁移 | 按 2.4 跑本插件的迁移；任一失败整次安装失败，用快照恢复 | 显示迁移计划和进度 |
| 写入 | 新对象类型写进 `object_types`；写插件状态表；调 `Installer.OnInstall`；记审计日志 | 无 |
| 结束 | 默认接着做「启用」 | 刷新插件列表 |

### 4.2 启用

| 后端 | 前端 |
|---|---|
| 再查一遍依赖（被依赖的必须已启用）；调 `Register`，登记路由、后台任务、订阅、今日卡片等；启动后台任务；状态表置启用；记审计日志 | 动态 `import()` 插件入口，调 `activate`；菜单出现（按当前工作台的配置决定放在哪组，工作台里没有这个模块时放进「未分组」并提示可以拖到合适的位置）；今日卡片、命令、设置分节出现 |

### 4.3 停用

| 后端 | 前端 |
|---|---|
| 有 `DisableGuard` 时先调 `CanDisable`，不通过就拒绝（交易插件：有在跑的部署或挂单时不允许停用，要先「一键全停」）；取消后台任务的 ctx，等它们退出（最多 10 秒）；撤掉订阅；本插件和认领的路由返回 404；状态表置停用；记审计日志。数据一行不动 | 撤销所有注册（`Disposable`），调 `deactivate`；如果当前停在这个模块的页面，跳回工作台的默认模块；菜单、今日卡片、命令消失 |

被依赖时的提示：停用前后端返回依赖它且已启用的插件列表（`depends` 强依赖），前端弹确认框：

> 停用「项目」会同时停用「视频创作」「终端与原型」。数据都会保留，重新启用即可恢复。[ 取消 ] [ 一起停用 ]

只有 `optional_depends` 的插件不跟着停用，只在确认框里附一句「IM 消息里的绑定到项目会暂时不可用」。

### 4.4 卸载

只能从停用状态卸载。

| 步骤 | 后端 | 前端 |
|---|---|---|
| 检查 | 还有已安装（不论是否启用）的插件强依赖它时拒绝卸载，返回这些插件 | 提示「先卸载视频创作、终端与原型」 |
| 选择 | 无 | 两个选项：保留数据（默认）、删除数据。选删除数据要二次确认：列出要删的表和行数，输入插件名才能点确定 |
| 备份 | 删除数据时先自动备份：调快照，备份文件路径写进审计日志并返回给前端；备份失败就不删 | 显示备份文件位置 |
| 清理 | 调 `Uninstaller.OnUninstall(deleteData)`；删除数据时删掉本插件前缀的表和插件迁移记录、本插件的设置值、本插件范围的凭证；本插件新建的对象类型：类型下还有对象时只隐藏不删，没有对象时删除类型；认领的东西不删（1.6）；状态表置未安装；记审计日志 | 刷新插件列表；工作台里引用这个模块的菜单项去掉 |

保留数据时：表、设置、凭证、迁移记录都在，下次安装跳过已应用的迁移，接着用。

### 4.5 升级

换了新二进制、插件的 `version` 变了时，启动后插件管理页标「可升级」；不自动升级。

第一方插件编译在二进制里，换了二进制跑的就是新代码，「停在旧版本」做不到。所以升级之前：已启用的插件照常起来、旧功能照常用；新版本新增的权限在确认之前一律当没授予，要它的代码路径执行时被 `Require` 拦下（3.3），用户到插件管理里升级并确认后才放行。启动时因有待应用的迁移没起来的插件，升级跑完迁移后起来。

| 步骤 | 后端 | 前端 |
|---|---|---|
| 检查 | 已安装、版本变了；新版本的 `core` 范围、`depends` 仍满足；依赖本插件的已装插件对新版本的版本范围仍满足，不满足就拒绝并列出；新增权限（新清单里有、状态表里没确认过的）都在请求的 `permissions` 里，不在就 409、`error.permissions` 列出 | 展示版本变化、新增权限、待跑的迁移 |
| 确认 | 无 | 新增权限按 3.2 确认，高风险的逐条勾选 |
| 备份、迁移 | 有待跑的迁移时先快照，再跑新迁移；任一失败时状态表不动（仍是旧版本），已提交的迁移用快照恢复（REL-02） | 显示进度和结果 |
| 生效 | 状态表写新版本和新清单的权限（减少的直接收回）；已启用的插件按 4.3 撤掉旧注册、按 4.2 注册新版本；记审计日志（`plugin` / `upgrade`） | 刷新插件列表；插件入口随整页重新加载换新 |

接口是 `POST /api/plugins/{id}/upgrade`，body `{ "permissions": [...] }`，见 `docs/api-contract.md`「插件管理」。

降级不支持：新版本的迁移已经改了表，旧代码不一定认识。要回退只能从升级前的快照恢复。

---

## 5. 插件不能做什么

| 不能做 | 为什么 | 怎么守 |
|---|---|---|
| 直接读写别的模块的状态（前端 import 别的插件或内核模块的 store、组件内部状态） | 停用一个插件会把另一个弄坏；状态和接线拆不开就回到 `App.tsx` 的老问题 | 前端 lint 规则：`frontend/src/plugins/<a>/` 不能 import `plugins/<b>/` 和 `core/` 下非公开导出（CORE-03b）。跨插件只能走事件或数据访问层 |
| 直连数据库（自己开 SQLite 连接、拿 `*sql.DB`、拼 SQL 查内核表） | 绕过对象模型的修订记录、审计、事件；表结构一改就坏 | 插件只拿得到 `Core().Store()`，它只能访问本插件前缀的表；内核数据只走 `Objects()`、`Contacts()` 等服务；后端静态检查禁止 `internal/plugins/` import `database/sql` 和 `internal/db` |
| 改内核表（迁移里 `ALTER`、`DROP`、`INSERT` 内核表，或运行时写内核表） | 已应用的迁移锁死，内核表是所有模块共用的 | 2.4 的迁移静态检查；运行时 `Store()` 拒绝非前缀表 |
| 前端直接 `fetch` | 数据访问层是唯一出口，便于缓存、鉴权和事件刷新 | 组件里不直接 fetch，走 `api.data`（CORE-03a） |
| 拿凭证明文给前端、写进日志 | 凭证保险箱的承诺是前端拿不到明文（CORE-06） | 凭证只在后端调用期间解密；日志统一脱敏 |
| 绕过权限句柄（`http.DefaultClient`、`os.WriteFile`、`exec.Command`） | 权限确认就成了摆设 | 3.3 的静态检查 |
| 在 `Register` 里做 IO 或起协程 | 启用会变慢、失败难回滚 | 后台活动一律用 `Job`，内核管启停 |
| 注册清单里没声明的东西 | 清单是安装确认和依赖检查的依据 | 前后端注册时比对 `provides` |

---

## 6. 工作台

已定（2026-10-28）：工作台之间数据不隔离。工作台只决定菜单里有哪些模块、怎么分组、默认打开哪个，以及需要哪些插件；所有工作台共用同一份数据。

工作台模板是插件组合预设（CORE-10）：

```json
{
  "id": "ws_trader",
  "role": "交易员",
  "name": "交易工作台",
  "plugins": ["markets", "monitor", "strategy", "trading", "im"],
  "groups": [["", ["today"]], ["行情", ["markets", "monitor"]], ["策略与执行", ["strategy", "trading"]], ["资讯", ["messages", "library", "browser"]], ["工具", ["tasks", "sessions", "terminal"]]],
  "home": "markets"
}
```

- `plugins` 列出这个模板需要的插件 id；`groups` 里的模块 key 来自内核模块和这些插件的 `provides.modules`，结构和原型 `web-next/src/workspacedata.ts` 的 `TEMPLATES` 一致
- 切到一个工作台或从模板新建时，前端比对已启用的插件，缺的列出来：「交易工作台需要行情、盯盘、策略与回测、交易执行，现在都没装。[ 去安装 ] [ 先不装 ]」。选「先不装」也能切过去，缺的模块在菜单里不出现
- 切工作台不装、不停用任何插件：插件是全局的，停用一个插件会影响所有工作台，只在插件管理页里做
- 工作台配置存后端（CORE-10a），引用插件里的模块 key；插件卸载后，引用它的菜单项自动去掉

---

## 7. 清单样例

两份样例同时放在 `docs/plugin-api/projects.json`、`docs/plugin-api/im.json`，内容和下面一致；CORE-01b 把它们放进合法样例集。版本从 `0.1.0` 开始：M2 只有壳（PJ-01a），真实功能在 M3 补齐后升 `1.0.0`。

### 7.1 项目

```json
{
  "id": "projects",
  "name": "项目",
  "description": "项目目录、沟通渠道绑定、项目资料、原型启停",
  "version": "0.1.0",
  "core": ">=1.0.0 <2.0.0",
  "depends": {},
  "optional_depends": { "im": ">=0.1.0 <1.0.0" },
  "provides": {
    "modules": ["projects"],
    "settings": ["projects"],
    "object_types": [],
    "connectors": [],
    "skills": ["sk_project_brief"],
    "agent_tools": ["projects_list", "projects_get", "projects_bind_conversation"],
    "sop_nodes": ["projects_start_prototype"],
    "today_cards": ["projects_prototype_errors"],
    "commands": ["projects.new", "projects.open", "projects.start_prototype"],
    "search": ["projects"]
  },
  "emits": ["projects.prototype_started", "projects.prototype_exited"],
  "subscribes": ["object.status_changed", "im.message_received"],
  "adopts": {
    "object_types": ["project"],
    "routes": []
  },
  "permissions": ["fs:read:project", "fs:write:project", "process:spawn", "network:localhost"],
  "migrations": "migrations",
  "table_prefix": "projects_"
}
```

说明：

- 项目数据仍是内核对象表里的 `project` 类型（认领，1.6）；插件自己的表放内核对象表放不下的东西：沟通渠道绑定（PJ-02，按 `conversation_id`）、原型进程配置和运行记录（PJ-04），表名 `projects_channel_bindings`、`projects_prototypes`
- 项目资料（PJ-03）走内核的产出和文件（AG-03），不建自己的表
- 订阅 `im.message_received`，所以把 `im` 写进 `optional_depends`（1.1 的规则）：没装 IM 消息时项目照常可用，只是沟通页没有未读数；IM 消息也弱依赖项目，弱依赖允许成环（8 节第 1 条）
- `process:spawn` 是原型启停要的，高风险，安装时单独勾选
- 项目页的干系人标签页用内核的 `/api/stakeholders`，不认领（1.6 的决策）

### 7.2 IM 消息

```json
{
  "id": "im",
  "name": "IM 消息",
  "description": "各渠道收进来的消息：收件箱、与我相关、回复、稍后提醒、转任务、附件",
  "version": "0.1.0",
  "core": ">=1.0.0 <2.0.0",
  "depends": {},
  "optional_depends": { "projects": ">=0.1.0 <1.0.0" },
  "provides": {
    "modules": ["messages"],
    "settings": ["im_channels"],
    "object_types": [],
    "connectors": ["slack", "telegram", "lark", "wecom"],
    "skills": ["sk_im_reply"],
    "agent_tools": ["im_search_messages", "im_draft_reply", "im_send_reply"],
    "sop_nodes": ["im_send_message", "im_wait_reply"],
    "today_cards": ["im_mentions", "im_snoozed_due"],
    "commands": ["im.open_inbox", "im.reply", "im.to_task"],
    "search": ["im_messages"]
  },
  "emits": ["im.message_received", "im.mention_received", "im.snooze_due"],
  "subscribes": ["object.status_changed", "contact.identity_merged"],
  "adopts": {
    "object_types": [],
    "routes": []
  },
  "permissions": ["network:im", "secrets:im", "fs:write:attachments", "fs:read:attachments"],
  "migrations": "migrations",
  "table_prefix": "im_"
}
```

说明：

- 插件 id 是 `im`，模块 key 是 `messages`（和原型、现有工作台配置里的 key 一致，不改）
- 只依赖内核：连接器框架、联系人和 IM 身份、会话都在内核。消息按 IM 身份 id 和会话 id 关联，不按名字匹配（IM-01a，开发决策「干系人名字重名」）
- 连接器先做 Slack、Telegram（IM-01b、IM-01c），飞书、企业微信随后；个人微信不在清单里（封号风险，开发计划第 6 节）
- 「转任务」建的是内核的任务对象，不需要对象类型；订阅 `object.status_changed` 是为了任务完成时回到原消息标记已处理
- `im_send_reply` 是写工具，默认「确认」模式，调用记审计日志
- 附件下载到数据目录 `attachments/<渠道>/`（开发决策「消息附件存在哪」）；加进项目资料（IM-04）走内核的产出和文件，不直接写项目插件的表

---

## 8. 待定事项

1. `optional_depends` 会形成互相引用（项目弱依赖 IM、IM 弱依赖项目）。暂定：强依赖不允许成环，弱依赖允许成环，CORE-01b 的校验按这个写；评审时确认。
2. 交易套件四个子插件共享 `trade_` 前缀还是各用各的（`markets_`、`trading_` 等）：放到 M6 定，表前缀白名单先留口子。
3. 进程外插件（第三方）的协议、签名、沙箱：M3 之后另起一版，本文档不覆盖。

## 变更记录

| 插件 API 版本 | 日期 | 变化 |
|---|---|---|
| 1.0.0 | 2026-10-28 | 初版（CORE-01a） |
| 1.1.0 | 2026-10-29 | `Core` 加 `Runs()`：发起 Agent、SOP 运行和交给 Claude Code，跑完给发起的插件投 `run.finished`（VID-03a） |
