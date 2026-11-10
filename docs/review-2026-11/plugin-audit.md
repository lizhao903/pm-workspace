# 一人之下 PM 工作台 · 插件层审计（2026-11）

审计对象：`internal/plugins/` 下 9 个第一方插件（`im`、`trade`、`video`、`sop`、`projects`、`domains`、`etf`、`terminal`、`browser`）与承载它们的内核插件框架（`internal/plugin`、`internal/connector`、`internal/schedule`、`internal/agent`、`internal/runner`）。

方法：只读代码 + 只读 **7796 生产实例的日常库** `sqlite3 -readonly data-dev/pm.db`（2026-11-09 快照，107MB；非测试数据）。未改仓库任何文件、未写库、未起服务、未跑全量构建，所以行为类结论以代码阅读为准，逐条标注事实/推断。

任务书里的插件 LOC（im 23.7k、trade 23.3k、video 22.1k…）是**含测试**的总行数；本报告全部用「非测试 / 测试」分列（`wc -l`，排除 `_test.go`）。两者对得上：如 im 14,175 + 9,509 = 23,684。

## 摘要

1. **事实：插件层已经是主要代码体量。** 非测试 75,775 行、测试 36,163 行；内核非测试 57,416 行、测试 42,188 行。9 个插件共 107 张表（71 个插件迁移），内核 48 张表（51 个迁移）。
2. **事实：日常在用只有 kernel + im + sop + projects 一条线。** im_messages 3,456 条（slack 3,453）、sop_runs 3,856 次（run_steps 53,119）、objects 727、artifacts 418。etf 是小而真实的外挂（10 只 ETF、20 天真实东方财富数据）。
3. **事实：video 与 trade 是「代码很大、数据几乎为零」。** video_videos 1 条（标题「第 1 集：」、stage=script）、video_topics 94 条同一秒导入、publishes/runs/artifacts/deals/shots 全 0；trade 被停用，账户/委托/回测/实盘/对账全 0，只有行情缓存（2,027 标的、2,065 根 K 线、4 条报价）。
4. **最大复用缺口：内核没有「跨插件实体关联」原语。** 结果 `project_id` 出现在 18 张表（含内核 `objects`），conversation↔project 有两套表、message↔task 有两套、资料出处要另建 sidecar 表；`links` 只覆盖 objects↔objects，`artifacts.scope_type` 418 行全空。
5. **第二大缺口：SOP「挂起等待/恢复」没有内核持久化登记表。** 4 张等待表（`im_sop_waits`/`im_task_waits`/`im_ask_waits`/`video_sop_waits`）+ 7 处 `SOP().Resume/Fail` 调用各自实现轮询、超时、补偿。
6. **第三大缺口：产物/资料模型分叉成四套。** 内核 `artifacts`（418 行，projects 有 3 处 `Artifacts().Record` 调用：`release.go:674`、`testenv.go:1058/1068`）、`video_artifacts`（0 行、762 行代码，迁移注释明写「产出物放插件自己的表，不进内核 artifacts」，`video/migrations/0002_artifacts.sql:5`）、`projects_materials`（21 行）、`im_material_sources`（出处 sidecar）；设计文档 `docs/file-artifact-model.md` 规划的 `files` 表根本没建（`sqlite_master` 0 条），`video_artifacts.core_artifact_id` 是预留桥接字段、注释「只存不查」（`video/migrations/0002_artifacts.sql:8-9`）。同一个「把报告/产出登记成产物」的诉求，video 与 projects 一个进内核、一个自建，已分叉。
7. **HTTP 信封、请求体解析、字段校验在 9 个插件里复制了 9 份**（`writeJSON` 9 处、`apiErr` 9 处、`readBody` 5 份且上限/白名单不一致），约 400 行纯样板。
8. **SOP 模板渲染与「内置流程只装一次」也复制了 4 份/4 处**，而 `InstallFlow` 本身已回 `newly bool`（`internal/plugin/sopflow.go:42`），这层标记表是冗余的。
9. **边界纪律整体是好的**：非测试代码零跨插件 import、零内核表裸 SQL、路由前缀/Store 前缀检查/依赖无环都有测试守；但内核里写死了插件知识（`internal/plugin/network.go:24-72` 49 行域名清单混装 im/media/market/exchanges，`internal/connector/logo.go:18-34` 写死插件连接器图标键）。
10. **拆分建议**：trade 冻结（不装/不进默认包）、video 冻结后半（商单/封面 AB/分镜/B站网页/评论约 3.4k 行无数据）并准备拆出、projects 内部按「档案」与「交付流水线」二分（后者 0 使用），im/sop/projects 档案必须贴身内核；详细见第 5、6 节。

## 1. 插件清单与能力盘点

### 1.1 核心子能力与对外扩展点

| 插件（版本） | 核心子能力（3–6） | 对外扩展点（manifest/代码） |
|---|---|---|
| im 0.30.0 | 渠道收发（Slack、Telegram、假适配器）；附件下载与鉴权；身份识别与会话归档；待处理/静音/提醒；消息转任务、转项目资料；群组默认项目与按项目聚合 | 2 连接器、15 个 SOP 节点、2 emits / 3 subscribes、`search: im_messages` |
| trade 0.7.0 | 行情采集与 K 线（币安/OKX）；盯盘与告警；策略与回测；模拟盘；执行器部署与运行记录；风控熔断、实盘闸门/评审/对账/审计、账户密钥 | 4 连接器、4 模块（markets/monitor/strategy/trading）、3 emits、`trade:live` 单独授权 |
| video 0.8.2 | 系列/剧集/选题/分镜/检查点；产出物与验收；发布记录与平台适配（B站/YouTube/抖音/B站网页）；素材目录与 ffmpeg 媒体工具；商单 CRM；封面 A/B；评论与 B 站账号数据；周更 SOP | 4 连接器、3 SOP 节点、1 schedule_action（`video_publish`）、4 今天卡片、1 订阅 |
| sop 0.20.0 | 流程定义/版本/文件夹；执行引擎（25 个内置节点）；等待/唤醒/超时；Claude Code 与 AI 节点；插件节点注册；内置流程安装；定时触发；调试/试运行 | 25 内置节点、1 今天卡片、2 emits / 3 subscribes、`network:any` |
| projects 0.19.0 | 项目档案/角色/干系人；项目资料；项目↔会话绑定；项目知识库同步；需求工作区（git worktree）；测试环境与测试报告；合并/发布流水线；原型进程管理与原型同步 | 13 SOP 节点、7 emits / 3 subscribes、2 设置、已认领 `project` 对象类型 |
| domains 0.2.0 | hosts/pf/证书只读检测；域名路由表；反代/证书配置生成；Host 处理器接管本机域名 | 1 设置、3 订阅（项目原型事件）、Host 处理器 |
| etf 0.2.0 | 宽基 ETF 日份额与行情快照采集；指标计算；异动规则与事件；一键确认异动 | 1 数据源、`network:market-data`、1 每日 Job |
| terminal 0.2.0 | PTY 终端会话（WebSocket）；会话列表/新建/删除；终端设置 | 1 设置、1 会话守护 Job、`process:spawn` |
| browser 0.2.0 | 标签页记录与恢复；地址白名单；Google 账号登录态（复用内核 Google Drive 连接器） | 复用内核 `google_drive` 连接器，无自有连接器 |

### 1.2 规模、用量与运行态

表数取 `sqlite_master` 前缀表；迁移数取 `internal/plugins/<id>/migrations/*.sql`；路由取 `.HandleFunc(` 注册行；Job 取 `.Job(` 注册（im 的 `pull_*` 按适配器展开为 2 条）。

| 插件 | 非测试 / 测试 LOC | 表（迁移） | 路由 | Job / 定时器 | 外部集成 / runner | 开关与实测 |
|---|---|---|---|---|---|---|
| im | 14,175 / 9,509 | 20 (17) | 38 | 11 / 0 | 2 连接器、2 真实渠道 + 1 演练适配器、15 SOP 节点 | 启用；im_messages 3,456、im_outbox 4 |
| trade | 17,358 / 5,939 | 27 (12) | 76 | 7 / 6 | 4 连接器、5 个自跑 runner（行情/回测/模拟/执行/实盘） | **停用**（2026-11-09T01:48:00Z）；账户/委托/回测 0 |
| video | 14,859 / 7,241 | 27 (14) | 98 | 8 / 1 | 4 连接器、3 runner（阶段执行 Claude Code） | 启用；vid 1、topics 94（导入）、publishes 0 |
| sop | 13,598 / 6,781 | 7 (11) | 28 | 3 / 3 | 25 内置节点、1 今天卡 | 启用；sop_runs 3,856、run_steps 53,119、claude_usage 0 |
| projects | 9,529 / 3,908 | 14 (12) | 52 | 8 / 2 | 13 SOP 节点、7 emits | 启用；资料 21、干系人 11、原型 1、发布/测试/worktree 0 |
| domains | 2,237 / 1,000 | 3 (1) | 9 | 0 / 0 | Host 处理器、3 订阅 | 启用；routes 2、checks 0 |
| etf | 2,188 / 792 | 6 (2) | 12 | 1 / 0 | 1 数据源（东方财富） | 启用；funds 10、daily 20、事件 4 |
| terminal | 1,013 / 562 | 1 (1) | 6 | 1 / 0 | PTY 进程 | 启用；settings 1，会话在内存 |
| browser | 818 / 431 | 2 (1) | 8 | 0 / 0 | 复用内核 Drive 连接器 | **停用**；tabs 1、allowlist 0 |

补充事实：9 个插件全部由 `cmd/pmw/main.go:207-248` 无条件 `plugins.Add` 编译进同一个二进制；前端 9 个插件共 53,006 行（另 `core` 26,881、`modules` 28,135、hello 示例 52），由 Vite glob 全量打包。`plugins` 表 9 个 installed=1、7 个 enabled=1，**没有「默认安装/默认启用」字段**，也没有按插件裁剪构建的手段——「默认关闭」目前只能靠安装后手动停用。

## 2. 跨类重复实现与判断

判断口径：**上收内核** = 语义与具体业务无关、边界/安全性关键、复制后容易漂移；**保留插件** = 领域语义重（交易所规则、平台协议），上收只会把内核变成第二个业务层。

### 2.1 HTTP 信封、错误映射、请求体解析（9+5+1 份）→ 上收内核

- `writeJSON` 9 处几乎逐字相同：`video/video.go:239`、`domains/domains.go:168`、`trade/trade.go:304`、`projects/stakeholders.go:345`、`sop/sop.go:219`、`terminal/terminal.go:238`、`browser/browser.go:125`、`im/messages.go:567`、`etf/etf.go:120`（内核自己还有 `internal/api/respond.go:52`）。
- `apiErr` 9 处逐字相同（同上文件 `:183/:127/:261/:61/:138/:47/:75/:524/:116`），错误哨兵 `errValidation`/`errNotFound` 也各建一份。
- `readBody` 5 份但**行为已漂移**：`video/video.go:190` 限 1MB 且拒绝未知字段，`trade/trade.go:267` 限 64KB、`domains/domains.go:133`、`sop/sop.go:164`、`browser/browser.go:82` 不校验未知字段。同一个 API 规范下，`POST /api/trade/*` 和 `POST /api/video/*` 对多余字段的态度就不一样（事实，可从代码读出）。`docs/api-contract.md:10` 定义的统一错误信封因此只能靠每个插件自觉。
- 建议：内核 `internal/plugin` 暴露 `plugin.Reply/plugin.Fail/plugin.ReadBody(allowed...)`（或可 import 的 `internal/httpx`），插件只保留业务错误哨兵。

### 2.2 SOP 模板渲染与「内置流程只装一次」（4 份渲染 + 3 张标记表 + 4 处 installOnce）→ 上收内核

- `{{field}}` 渲染 + `getPath/txt/render` 在 4 个插件里近乎逐字复制：`sop/nodes.go:161-205`、`im/sopnodes.go:429-465`、`video/sopnodes.go:286-320`、`projects/sopnodes.go:175-210`。内核 `internal/plugin` 没有任何渲染原语。
- 模板标记表 schema 完全相同 `(flow_id, installed_at, PK flow_id)`：`im_sop_templates`（`im/migrations/0012_task_reply.sql:27`）、`video_sop_templates`（`video/migrations/0006_sop.sql:24`）、`projects_sop_templates`（`projects/migrations/0012_kb.sql:24`）。
- 对应的 `installOnce` 逻辑重复 4 处：`im/devpipeline.go:243-271`、`im/taskreply.go:88-99`、`video/sopnodes.go:373-416`、`projects/kb.go:688-731`。而 `Core.SOP().InstallFlow` 已经回 `newly bool`（`internal/plugin/sopflow.go:42`），插件完全可以用返回值替代标记表；现状是「内核已告知，插件另记一笔」，属于可去掉的重复。
- 建议：内核提供 `SOPFlowRender(tpl, data)` 与「模板安装台账」（或直接让 `InstallFlow` 幂等语义足够强，插件不建表）。保留插件：各流程自己的步骤定义（业务语义）。

### 2.3 挂起等待、唤醒、超时补偿（4 张表 + 7 处 Resume/Fail）→ 上收内核

- 4 张等待表各自 schema 类似：`im_sop_waits`（`im/migrations/0004_sop_waits.sql:10`）、`im_task_waits`（`im/migrations/0012_task_reply.sql:12`）、`im_ask_waits`（`im/migrations/0013_ask_me.sql:12`）、`video_sop_waits`（`video/migrations/0006_sop.sql:11`）。
- 唤醒/失败实现 7 处：`video/sopnodes.go:203/208`、`im/sopnodes.go:335/342`、`im/askme.go:491/500`、`im/taskreply.go:255/268`；另有 `projects/release.go:719-776`、`projects/testenv.go:1107-1150` 用「状态列 + 自己的 8 个 Job 轮询」实现同一语义而没建等待表——**同一个问题三种解法**。
- 内核只有内存级 `SOPEngine.Resume/Fail`（`internal/plugin/sopnode.go`），没有「某步骤在等某个外部条件」的持久化登记；于是每个插件都要自建表 + 后台 Job + 超时失败 + 补偿清理。
- 建议：内核加 `SOP().WaitFor(step, key, deadline)` / `Resolve(key, result|err)` + 一张 `sop_waits` 表，插件只提供「条件怎么判定/怎么取结果」。保留插件：`im_ask_waits` 的回复解析规则（业务）。

### 2.4 产物/资料四套模型 → 上收内核（设计已定，实现分叉）

- 内核 `artifacts` 418 行数据（`internal/db/migrations/0012_artifacts.sql:61`），`scope_type` 全空、全部靠 `object_id` 归属；`internal/plugin/artifacts_write.go` 只有 `Record`。
- `video_artifacts` 762 行代码、0 行数据（`video/migrations/0002_artifacts.sql:12`）；迁移注释直接写「产出物放插件自己的表，不进内核 artifacts：插件只能建、读写本插件前缀的表」（`video/migrations/0002_artifacts.sql:5`），`core_artifact_id` 注释「插件读不到内核表，只存不查」（同文件 `:8-9`），实际 video 确实从不调 `Artifacts().Record`（该句柄全仓只有 projects 的 3 处调用）。这是历史决策与后续能力（AG-03b 后 `Artifacts().Record` 已可用）之间的漂移。
- `projects_materials`（`projects/migrations/0003_materials.sql:14`，21 行）本质与内核 artifacts 同构（path/url/note/name/category/status）；`im_material_sources`（`im/migrations/0009_message_materials.sql:9`，15 行）是它的出处 sidecar，全部 15 行 material_id 都能在 `projects_materials` 里找到——为了守「插件不互读表」而做的双写。
- 设计文档 `docs/file-artifact-model.md:33/127` 明确规划 `files` 表统一「资料」，并规定视频产出走 `artifacts` + `scope_type='video'`；实测 `sqlite_master` 无 `files` 表，视频产出也没进内核 artifacts。**设计已被实现绕开**（事实）。
- 建议：短期让 plugins 调 `Artifacts().Record`（API 已在），中期补 `files` + `scope_type`，「产出/资料」两套统计口径按文档执行。此项上收收益最大，但需要迁移与前端改造，排 P1。

### 2.5 N×M 关联表爆炸 → 上收内核（关联原语 + 反向索引）

- `project_id` 出现在 18 张表：内核 `objects`（651 行有值）、`im_messages`（773 行）、`video_videos`、`video_deals`、以及 `projects_*` 十余张；`conversation↔project` 两套表并存——`projects_conversations`（10 行，`projects/migrations/0002_conversations.sql:9`）与 `im_conversation_projects`（62 行，`im/migrations/0007_conversation_projects.sql:9`），语义只差「显式绑定 vs 默认归属」，实测 9 行重叠。
- `message↔task` 两套：`im_messages.task_id/task_ref` 列（7 行）与 `im_message_tasks` 表（234 行，`im/migrations/0008_message_sessions.sql:21`，由 task 的 `props.source_ref` 反向扫出）。后者存在的原因就是内核没有「来源外部引用」的反向索引——`object_origins` 有表（`docs/file-artifact-model.md:206`）但实测 0 行、插件没用。
- 项目干系人 `projects_stakeholders`（11 行，`projects/migrations/0001_stakeholders.sql:10`）与内核 `object_participants`（2 行）职责重叠（前者多 role/focus）。
- 组合主键关联表另有 10+ 张（`object_tags`、`object_participants`、`conversation_members`、`im_attachments`、`sop_run_steps`、`video_checkpoints`、`video_topic_clips`、`video_runners`、`video_cover_test_arms`、`video_deal_videos`、`im_message_sessions`、`im_message_tasks`、`im_material_messages`）。内核通用关联只有 `links`（objects↔objects，实测只用于 blocks 484/parent 15）和上面两张小表，**没有** `(entity_type, entity_id, target_type, target_id, relation)` 这种原语。
- 建议：内核补一张通用关联表 + 「外部来源反向索引」（`source_type/source_id → object_id`），插件不再自建 `*_message_tasks`/`*_conversations`；这是插件数量再翻倍之前必须先做的事。

### 2.6 调度与自跑循环（两套调度并存）→ 部分上收，领域 runner 保留

- video 同时用两条路发「到点发布」：内核 `ScheduleAction`（`video/schedule.go:37`）和插件自己的常驻 ticker `publish_due`（`video/schedule.go:41/73`，30s 扫 `video_publishes.scheduled_at`）。同一种能力两个入口，改一处容易漏另一处（推断，但代码结构明确）。
- 插件自建 runner 循环：trade 7 个 Job + 6 个 ticker（`trade.go:221-229`、`backtests.go:206`、`market.go:500`、`paper.go:565`、`runs.go:676`、`stream.go:194/196`）；projects 8 个 Job + 2 ticker（`testenv.go:290-303`、`release.go:173-177`、`procman.go:327`、`testenv.go:782`）；video 8 Job + 1 ticker（`sopnodes.go:46`、`biliapi.go:175-176`、`video.go:144-146`、`schedule.go:41`）。
- 内核 `internal/schedule` 只有 cron/flow/schedule-action，没有「可持久化的后台任务队列」原语，所以 im/video/trade/projects/sop 各自实现「队列表 + 状态机 + 重试/超时 + 进程重启恢复」。建议上收一个通用 `JobQueue`（入队/租约/心跳/超时/重试），领域执行体仍留在插件（保留插件）。
- 结论：调度「入口」上收内核（去掉 video 双路），「执行体」保留插件。

### 2.7 连接器健康、重试、限频、上游 HTTP 解析 → 上收内核连接器框架

- 内核连接器表已有 `status/error/last_sync_at`（`internal/connector/sync.go:27`），但**没有**重试/退避/限频原语，于是各插件自造：trade `upstream.go:32-104`（`UpstreamError`、`RateLimited`、`retryAfter`）+ `market.go` 里 17 处健康/退避处理；video `remote.go:115-140` 只做错误映射 + `RecordSync`；im `attachments.go:200-206` 把连接器状态翻成用户文案；etf `source.go` 每源各自超时/错误文案。
- 出网纪律本身是好的（事实）：所有出网都走 `Core.HTTP(group)`（`im/slack.go:98`、`video/youtube.go:89`、`trade/market.go:19`、`etf/etf.go:78`），`internal/plugin/boundary_test.go:14` 用 AST 禁 `http.DefaultClient/Get/Post`，`internal/plugins/` 下裸 `http.Get` 为 0。
- 建议：内核连接器补 `WithRetry/Backoff/RateLimit`（退避策略可由插件声明参数），保留交易所/平台协议细节插件实现。

### 2.8 路径安全、「起子进程」权限校验（3 份 `within` + 15 处直连 os/exec）→ 上收内核 FS()/Process()

- 同一个「符号链接解析后仍在根目录内」函数 `within` 复制 3 次：`video/media.go:153`、`projects/worktrees.go:891`、`sop/nodes_local.go:136`（前两者逐字相同）；各插件另有自己的 `filepath.Rel` 越界检查 9 处（`video/content.go:108`、`projects/protosync.go:635`、`projects/testenv.go:1042`、`terminal/launch.go` 等）。
- `docs/plugin-api.md:259` 自己写着 `FS(scope)`、`Process()` 还是「规划，还没实现」，现实是 7 个文件直接 `exec.CommandContext`（`video/media.go:709/857`、`projects/procman.go:10`、`projects/testenv.go:12`、`domains/system.go:76`、`terminal/session.go:9`），8 个文件直接 `os.MkdirAll/os.CreateTemp/os.Remove`（`video/content.go:159/166`、`projects/protosync.go`、`projects/worktrees.go`、`sop/nodes_local.go`、`im/attachments.go` 等）——权限靠代码路径上 `plugin.Require(c,"process:spawn")` 自觉（`projects/procman.go:264`、`projects/testenv.go:324`、`video/runners.go:440`）。`boundary_test.go` 只扫默认 HTTP 客户端，不扫 os/exec（事实）。
- 另有 8 个文件 import `database/sql`（`video/biliapi.go:6`、`projects/protosync.go:5`、`projects/worktrees.go:6`、`sop/gate.go:5`、`sop/folders.go:5`、`terminal/launch.go:5`、`im/quickreply.go:8`、`im/expiry.go:5`），只用到 `sql.NullString/sql.Result/sql.ErrNoRows`；插件 API 文档第 5 节明令「后端静态检查禁止 plugins import database/sql」，实际未执行（事实）。
- 建议：内核尽快落 `FS(scope)`（含 `within`/`EvalSymlinks`）与 `Process()`，并把边界测试扩到 os/exec、os 写、database/sql；这是**安全类重复**，优先级应高于功能类。

### 2.9 设置存取（5 个插件各一套）→ 上收 Settings()

`provides.settings` 用了 5 处：`sop`（`sop.go:105-106`）、`terminal`（`terminal.go:61-62`）、`im`（`im.go:134-135`）、`domains`（`domains.go:97-98`）、`projects` 两组（`worktrees.go:133-134`、`proto_sync_settings`）。内核 `Core` 没有 `Settings()`（`docs/plugin-api.md:259` 标「规划」），每个插件各建 `*_settings` 表（`domains_settings`、`im_settings`、`sop_settings`、`terminal_settings`、`projects_worktree_settings`、`projects_proto_sync_settings`）+ 各自的 GET/PATCH 校验。建议内核提供按 key 的 JSON 设置存储（含版本/迁移/审计），插件只留 schema 与表单。

### 2.10 其他小重复（保留或顺手清）

- SSE 帧格式：内核 7 处自己写（`internal/api/agent.go:392`、`agentdebug.go:262`、`notifications.go:124`、`run.go:345`、`runagent.go:316/692`、`toolgrants.go:333`），trade 另有高频行情 SSE（`trade/stream.go:130`，因吞吐高可保留，但 `event:/data:` 拼装可共用 helper）。
- 文件下发 3 套：`video/media.go:792/836`、`im/attachments.go:527`、`projects` 报告（`release.go:831`、`testenv.go:1184` 给 URL）；内核其实有 `/api/fs/raw`、`/api/fs/read`。可让插件用内核下载端点 + 一次性 token（保留插件：各插件的访问控制策略）。
- 今日卡片上限 `todayCardMax=50` 在 `video/today.go:16` 复制了一份内核常量（注释写「同内核的 TodayCardLimit」但未导出）。改成 `plugin.TodayCardLimit` 即可。
- 时间/时区：`time.LoadLocation("Asia/Shanghai")` + `FixedZone("CST")` 回退在 `video/biliweb.go:534-537`、`etf/source.go:266-269` 各一份；`nowStr()` 在 video/browser 各一份。均属小项。

## 3. 边界与泄漏

### 3.1 做对的（事实）

- **非测试代码零跨插件 import**：`grep -rn "internal/plugins/\(projects\|sop\|im\|video\|trade\)\"" internal/plugins --include=*.go | grep -v _test.go` 无输出（只有 `_test.go` 里做夹具）。
- **插件不裸查内核表**：`internal/plugin/store.go` 的 `checkStoreSQL`（`store.go:182-218`，文档 `docs/plugin-api.md:1016` 有签名）按前缀拒绝非本插件表；实测插件 SQL 未出现 `objects/links/artifacts/notifications/conversations` 等内核表名。
- **路由前缀受检**：`/api/<id>/` 强制；`/api/plugins/{id}` 生命周期（安装/启用/停用/卸载/升级/权限确认/迁移校验和）实现完整（`internal/plugin/registry.go:254-300`）。
- **依赖与事件命名空间**：manifest `depends/optional_depends` + 环检测 + 事件前缀校验（`internal/plugin/manifest.go`），video→projects 强依赖、video→im / sop→im 弱依赖的声明与实际使用一致。
- **权限按代码路径检查**：`plugin.Require` 覆盖 `process:spawn`、`network:any`、`network:localhost`、`trade:live`（`docs/plugin-api.md:1921` 表格）；trade 实盘闸门 `RequireUser`（`trade/livegate.go:539/701`、`trade/runs.go:380`）是插件层最重的安全设计，做得好。
- **类型边界**：插件用 `plugin.Core` 收窄句柄（Store/Objects/Connectors/Runs/Notify/Audit/Artifacts），不 import `internal/api`、`internal/conversation`、`internal/store/sqlite`（非测试 0 处）。

### 3.2 内核里写死插件知识（内核→插件特殊化）

- `internal/plugin/network.go:24-72`：`NetworkHosts` 把 im（slack/telegram/feishu）、video（B站/YouTube/抖音）、trade/etf（币安/OKX/东方财富）的域名全都写在内核里，49 行；加一个渠道/交易所要改内核并重发内核版本。设计上这是**故意的安全边界**（「由内核维护，插件改不了」，`network.go:23`），但代价是「垂直模块独立迭代」的承诺打折。建议保留内核裁决权，改成安装时从 manifest 声明候选域名 + 内核校验后落库（比硬编码可扩展，风险可控）。
- `internal/connector/logo.go:18-34`：插件连接器的图标键（`telegram`/`binance_market`/`okx_market`/`bilibili`/`youtube`/`douyin`）写死在内核，注释写明「免得内核引用插件包」——说明缺少「插件给连接器带图标键」的正式扩展点（连接器 `Logo` 字段其实已有，属可清的技术债）。
- 单点常量化：`SOPPluginID="sop"`（`internal/plugin/sopnode.go:27`）、`ProjectsModule="projects"`（`projectprotos.go:17`）、`SOPModule="sop"`（`soplaunch.go:30`）、`internal/schedule/sopcatalog.go` 里 im 触发目录、`cmd/pmw-mcp/projecttools.go` 硬编码 `GET /api/projects/profiles`（找不到时降级 `not_found`）。可控但属「内核知道具体插件 id」的泄漏面。
- `internal/connector/slack.go`：Slack 连接器实现放在内核 connector 包（im 插件消费），与「im 是插件、可停用」不一致——停用 im 后内核仍带 Slack 协议代码。推断：历史原因（IM-01b 先做连接器），迁移到 im 插件是干净的（连接器接口已支持插件登记定义，`r.Connector`）。

### 3.3 插件→内核的反向泄漏（能力越界）

见 2.8：`os/exec`（7 文件）、`os` 写（8 文件）、`database/sql`（8 文件）都在「规划中」的 FS()/Process() 与静态检查落地前直接绕过了句柄。这不是恶意绕过（权限用 `Require` 自查了），但意味着「插件不能绕过权限句柄」这条规则目前靠人工评审，`boundary_test.go` 只守了 HTTP 客户端。

### 3.4 前端

跨插件数据统一走 `frontend/src/core/data/*` 的 hooks（`video/Page.tsx:12` 用 `useProjects`、`im/ToMaterialDialog.tsx:34` 同），符合「跨插件只走数据访问层」；video 的商单页通过 `projectTabs` 扩展点挂进项目页，是正确的扩展点用法。仍有硬编码路由耦合：`video/CalendarPage.tsx:234`、`DealDrawer.tsx`、`DealsTab.tsx:28` 直接拼 `/projects/{id}/deals`——projects 不在时链接会 404（推断：无守卫）。拆 video 时这是必改项。

## 4. 价值判断：video / trade 对 PM 工作台

### 4.1 dev-plan 的意图（事实）

`web-next/docs/dev-plan.md` 2.1/2.2/2.8 明确「交易、视频这类垂直模块迭代节奏和风险等级跟内核完全不同，绑在一起发布会互相拖累」，M5 视频目标「一个系列完整周更一次」，M6 交易目标「模拟盘连续跑两周」且实盘前要单独评审、交易四个子模块要能单独安装。即：**video/trade 定位是可选垂直插件**，不是 PM 工作台的日常面。

### 4.2 实测数据（`data-dev/pm.db`）

| 功能块 | 代码量（非测试） | 关键表与行数 | 判断 |
|---|---|---|---|
| video 系列/剧集/选题/分镜/检查点 | ~2.5k | video_series 1、video_videos 1、video_topics 94（同一秒导入）、video_shots 0 | 骨架刚建，选题是批量导入的种子数据 |
| video 产出物/评审/发布 | ~2.0k | video_artifacts 0、video_publishes 0、video_runs 0 | **零真实使用** |
| video 平台适配 + B站网页/评论/账号数据 | ~4.4k | video_bili_* 全 0、评论 0 | **纯投机**，未验证 |
| video 商单 CRM + 封面 A/B | ~1.6k | video_deals 0、video_cover_tests 0 | **纯投机** |
| video 素材目录/ffmpeg 媒体 | ~0.9k | video_media_roots 0 | 未使用 |
| trade 行情/K线 | ~3.7k | trade_instruments 2,027、trade_klines 2,065、trade_quotes 4（2026-11-09T01:47 停用前抓取） | 唯一有真实数据的部分，等价于「行情缓存」 |
| trade 回测/模拟盘 | ~3.9k | trade_backtests 0、trade_runs 0、trade_accounts 0、orders/fills 0 | 零使用 |
| trade 实盘/风控/对账/审计/闸门 | ~6.0k | trade_live_*/risk/recons/live_reviews 全 0 | 零使用，风险最高 |
| projects 交付流水线（测试环境/发布/worktree/原型同步） | ~6.2k | projects_test_runs 0、projects_releases 0、projects_worktrees 0、projects_proto_syncs 0 | 零使用（1 个原型在跑，属档案侧） |
| projects 档案侧（profiles/干系人/资料/会话/KB） | ~2.9k | profiles 1、stakeholders 11、materials 21、conversations 10、kb 1 | 真实少量使用 |
| etf 宽基监控 | 2.2k | funds 10、daily 20、anomaly_events 4、rules 3 | **小而真实**，是 PM 自己盯盘的日常外挂 |

### 4.3 结论

- **日常主链路 = kernel（今日/任务/文档/会话/Agent/SOP 引擎）+ im + sop + projects 档案侧 + etf**。证据：sop_runs 3,856 次几乎全部集中在 IM 分流与回执流程（1,147 / 1,070 / 1,062 次三条 IM 流程 + 576 次「@我和私信转任务」+ 2 次任务回执；其中两条流程已被删，历史执行仍在），notifications 289 条里 task.review_requested 267 条、im_messages 3,456 条；而 video/trade 的交易性表全 0。
- **video 与 trade 都是「按规划提前建出的完整垂直产品，但未被使用」**。trade 更极端：23.3k 行（含测试）换来 0 笔委托、0 次回测，且被停用；停用时间戳 `plugins.updated_at` 为 2026-11-09T01:48:00Z，四条行情报价抓取于 01:47:56-58Z，即它在停用前刚跑过一轮行情采集（事实），此后无人使用（推断）。
- **video 内部还可以再分**：系列/剧集/选题/检查点是 dev-plan M5 的真实意图（周更流程的骨架）；商单 CRM、封面 A/B、分镜、B站网页扫码、评论——这 5 块约 3.4k 行、0 数据，属产品原型里的「想象功能」，应冻结或独立子模块，不应占据默认包体积与维护面（推断 + 代码行数事实）。
- **projects 交付流水线半边（6.2k 行、0 使用）** 与 video/trade 同类：规划上属 M3「开发任务闭环」，但当前 PM 并没有用它跑测试/发布。建议先观察一个迭代，若仍 0 使用则默认停用该半边，而不是直接删（它和内核对 runner/Claude Code 的集成是真实能力）。
- **默认关闭**：现状只有 trade、browser 两个 enabled=0；其余 7 个都启着。建议把「默认包」定义为 {kernel, im, sop, projects, etf}，video/trade/domains/terminal/browser 改为「可选安装」并把安装动作做成明确的一次性选择（见第 5、6 节）。

## 5. 拆分成本评估

拆 video/trade 为独立仓库/二进制要付的固定成本（两插件同构，列关键差）：

| 成本项 | video | trade |
|---|---|---|
| 自有后端代码 | 14,859 行 | 17,358 行 |
| 自有表 / 迁移 | 27 张 / 14 个 | 27 张 / 12 个 |
| 前端代码 | 9,920 行（依赖 projects 的 projectTabs/路由） | 7,506 行（4 个模块页，无跨插件页签） |
| 对内核表的硬 FK | 0（`project_id`/`contact_id` 只是无 FK 的 TEXT） | 0（全部表零外键） |
| 对内核能力的运行时依赖 | Objects 只读（`deals.go:277`、`runners.go:485`、`videos.go:187`）、Runs（Claude Code 执行）、SOP 节点/流程安装、Notify、Connector/vault、idgen、Incident、Audit | Connector/vault、Notify、Incident、Audit、idgen、Runs（实盘部署）、HTTP 出网 |
| 依赖的内核包（编译期） | `internal/plugin`、`connector`、`vault`、`runner`、`domain`、`db`、`idgen`、`incident` | `internal/plugin`、`connector`、`vault`、`domain`、`db`、`idgen`、`incident`、`audit` |
| 迁移历史 | 14 个已应用（`plugins_migrations` 校验和锁定） | 12 个已应用 |
| SOP 依赖 | 3 个节点注册进内核 SOP 流程，内置周更流程含 video 节点 | 无 |
| 前端装配 | 需从 Vite glob、菜单、今日卡、projectTabs 中撤出 | 需从 Vite glob、菜单撤出 |
| 停用影响 | 无插件依赖 video（terminal/domains 依赖的是 projects）；projects 停用会连带停 video+terminal | 无被依赖 |

拆分阻断点（按难度）：① 迁移历史与插件状态表（拆出后要迁移到独立库、或保留 `plugins_migrations` 记录并声明“另一进程”）② 与内核的 `Objects/Runs/Artifacts/SOP` 句柄要变成 HTTP/MCP 调用，得先有「插件进程外协议」（文档说 M3 之后才开放，`docs/plugin-api.md:7`）③ 前端要独立构建与鉴权 ④ 与停用/启用联动的菜单、今日卡、SOP 节点目录。

**建议**：
- **trade：冻结**。不拆仓、不删代码，从默认包/默认安装里移除（manifest 加 `default_install: false` 或构建期按包裁剪），并用 DisableGuard 保持停用状态；等真的要用模拟盘再启动 M6。理由：23k 行、0 使用、实盘风险最高、拆分成本中等且收益为零。
- **video：冻结后半 + 准备拆分**。保留系列/剧集/选题/检查点/发布记录（周更骨架，dev-plan M5 真实意图），冻结商单/封面 A/B/分镜/B站网页/评论（3.4k 行、0 数据）；商单与 B 站网页这两块若要保留，优先做成 video 自己的子模块并显式标注实验。等 M5 真正开始周更、且插件进程外协议就绪后再拆仓——现在拆，等于把 9.9k 行前端和 3 个 SOP 节点的联动成本提前支付。
- **projects：不拆，内部二分**。「档案侧」（profiles/干系人/资料/会话/KB/原型）可以是独立插件；「交付流水线」（testenv/release/worktree/protosync，6.2k 行）建议独立成 `projects-delivery` 子模块或构建开关，默认不启用。
- **terminal/browser/domains：保留但薄化**。终端与原型按 `docs/plugin-api.md:6` 的 PROTO-05 规划并入项目页展开区域；browser 只有 818 行、1 张标签页表，可并进项目/文档工具区；domains 2.2k 行是纯本机运维，保留独立插件即可（它已用 optional_depends 挂 projects）。
- **im/sop/etf：保留并贴身内核**。im 与 sop 是日常主链路，etf 小而有真实数据。

## 6. 结论

### 6.1 做得好的（3–5 条）

1. **边界机制不是口号**：Store 前缀守（`internal/plugin/store.go:182-218`）、路由前缀、迁移校验和、manifest 依赖环检测、事件命名空间、`boundary_test.go` AST 扫描，共同支撑了「非测试代码零跨插件 import、零内核表裸 SQL」这个实测结果。这在插件化项目里不常见。
2. **内核把高风险横切面收得干净**：Agent 供应商/Claude Code runner（`internal/runner` 3,047 行）、ID 生成（`internal/idgen`）、通知（`internal/notify`）、审计、事件、连接器保险箱、SOP 引擎全部只在内核实现，插件只是调用方——所以「重复实现 Claude/Agent 调用」的担忧在代码层面基本不成立（重复的是提示词与等待逻辑，不是调用机制）。
3. **权限/审计/实盘安全设计认真**：`Require`/`RequireUser`、trade 实盘闸门/评审/对账/审计、`DisableGuard`、卸载前快照、`process:spawn` 前置检查，说明作者理解「插件能拿到的能力必须收窄」。
4. **数据结构积累**：objects 727、artifacts 418、sop_run_steps 53,119、im_messages 3,456，说明主链路真在跑，不是空转；`docs/plugin-api.md`、`docs/file-artifact-model.md`、`dev-plan` 的设计文档质量高，问题能对到文档决策。
5. **插件生命周期完整**：安装/启用/停用/卸载（保留或删数据）/升级/权限再确认/迁移回滚快照，9 个插件都走同一套，这为「默认不装、按需启用」提供了现成机制（缺的只是默认包策略）。

### 6.2 复用缺口与不必要功能（8 条）

1. **缺通用实体关联原语** → project/conversation/message/task/stakeholder 各自建表，`project_id` 散落 18 表，两套 conversation↔project、两套 message↔task。
2. **缺外部来源反向索引** → `im_message_tasks`、`im_material_sources` 这类「反查表」是补丁；`object_origins` 已建未用（0 行）。
3. **缺 SOP 持久化等待/唤醒** → 4 张等待表 + 7 处 Resume/Fail + projects 两种轮询实现。
4. **缺产物/资料统一** → 四套模型、预留未接通的 `core_artifact_id`、`files` 表未建，产出统计口径只能各算各的。
5. **缺 HTTP 信封/请求体/字段校验公共件** → 9 份样板 + 已经漂移的 body 上限/白名单。
6. **缺渲染与设置句柄** → SOP 渲染复制 4 份；5 个插件各写 settings 表与 GET/PATCH。
7. **缺 FS()/Process() 与对应静态检查** → 直接 os/exec/os/database/sql，安全规则靠人工评审。
8. **不必要/未验证的功能面**：video 商单 CRM、封面 A/B、分镜、B站网页扫码、评论（约 3.4k 行、0 数据）；projects 测试环境/发布/worktree/原型同步（6.2k 行、0 数据）；trade 实盘全套（6k 行、0 使用且已停用）；SOP 节点目录里 `code`（不执行）与 `notify`（「由 IM 插件代替、执行会失败」）两个死节点（`sop/flows.go:103/146`）；`agent_tools` 扩展点全插件声明为空、没人用。

### 6.3 优先级建议

- **P0（先做，都是横切且不依赖新协议）**：① 插件 HTTP 公共件（信封/ReadBody/apiErr）进 `internal/plugin`；② `Settings()` + `SOP().WaitFor/Resolve`；③ `FS(scope)`/`Process()` + 边界测试扩到 os/exec、os 写、database/sql；④ video 去掉 `publish_due` 与 ScheduleAction 双路之一；⑤ 删除三张 `*_sop_templates` 与 4 处 `installOnce`（用 `InstallFlow` 返回值）。
- **P1（结构性，需迁移）**：⑥ 产物统一（video 改调 `Artifacts().Record`，补 `files`）；⑦ 通用关联表 + 来源反向索引，先迁 `conversation↔project`、`message↔task`；⑧ 插件默认包/默认安装策略（trade/video 后半默认不装）。
- **P2（产品面）**：⑨ projects 交付流水线二分；⑩ video 商单/封面/B站网页/评论冻结或独立子模块；⑪ trade 冻结，等 M6 真正开跑再评估拆分；⑫ `NetworkHosts` 从硬编码改为安装期声明 + 内核校验。

## 7. 事实与推断分界

- 全部行数、表数、迁移数、路由/Job 数、LOC 为**实测**（`wc -l`、`grep -c`、`sqlite_master`、`plugins_migrations`）；行号为当前工作区文件行号。
- 数据库行数为 `data-dev/pm.db` 2026-11-09 快照（**7796 生产实例日常库**；10:22 复核：im_messages 3,462、objects 728/存活 502、sop_runs 3,861，数字随使用实时变化）；`data/pm.db`（696K、11-04）为旧实例库，未用于结论。
- 未执行构建与运行时验证，以下为**推断**：① 各插件「实际使用中」的行为路径以代码阅读为准，未点开页面；② 「停用后菜单/SOP 节点消失」等生命周期行为依据注册表代码与文档，未运行验证；③ 商单/B站网页等判定「投机」依据是 0 数据 + dev-plan 未提，不排除用户在线下用过但未入库；④ 拆分成本表里的「需迁移/需协议」是结构性判断，非试拆结果。

## 附录：关键证据索引

- 插件注册：`cmd/pmw/main.go:207-248`；插件状态：`plugins` 表（9 installed，trade/browser enabled=0）。
- Store 前缀守：`internal/plugin/store.go:182-218`；边界测试：`internal/plugin/boundary_test.go:14/67`。
- 内核写死插件知识：`internal/plugin/network.go:24-72`、`internal/connector/logo.go:18-34`、`internal/plugin/sopnode.go:27`、`internal/plugin/projectprotos.go:17`、`internal/plugin/soplaunch.go:30`、`cmd/pmw-mcp/projecttools.go`。
- 重复实现证据：2.1–2.10 正文逐条文件:行号。
- 设计意图：`web-next/docs/dev-plan.md` 2.1/2.2/2.8/M5/M6；`docs/file-artifact-model.md:27/33/127/206/254-255`；`docs/plugin-api.md:259`（FS/Process 规划中）、`:1932`（权限检查点）。

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
