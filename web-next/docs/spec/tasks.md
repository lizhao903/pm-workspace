# 任务 规格（SPEC-tasks）

| 项 | 内容 |
|---|---|
| 模块 key | `tasks` |
| 原型入口 | 一级菜单「任务」，http://127.0.0.1:7778 |
| 源码 | `web-next/src/tasks.tsx`（二级菜单、列表、任务抽屉、Webhook 列表和配置页）、`web-next/src/devloop.tsx`（开发闭环：等你验收栏、进展、产出物、执行记录、交给 Claude Code 弹窗、完成圆圈确认，`useDevLoop`）、`web-next/src/schedule.tsx`（定时任务列表和抽屉）；接线在 `web-next/src/App.tsx`（`patchTask`、`useDevLoop`、`deleteTask`、`taskPlan`、`runScheduleNow`、`ingest` 调用） |
| 数据文件 | `web-next/src/taskdata.ts`（任务、Webhook、投递；末尾是开发闭环的进展、产出物、执行记录和演示数据）、`web-next/src/scheduledata.ts`（定时任务）；状态、优先级的显示名和颜色在 `web-next/src/enumdata.ts`（`task_status`、`task_priority`） |
| 截图 | [`shots/tasks/`](shots/tasks/) |
| 负责任务 | PROTO-04b、PROTO-07（开发闭环） |
| 状态 | 已整理 |
| 最后对照 | 2026-10-28，原型提交 `932555b`；`SPEC-tasks-5`、`SPEC-tasks-6` 和待验收相关的条目按 PROTO-07 的原型改动（未提交）修订 |

## SPEC-tasks-0 模块概述

人工创建、IM 消息转来、Webhook 推来、定时任务建的、运行异常转的任务都在这里；还管两种自动建任务的规则：定时任务和 Webhook 接入。开发任务（交给 Claude Code 做、做完提交验收）也是任务的一种，用 `review` 待验收状态承接。

### 页面清单

| 节 | 页面 | 入口 | 说明 |
|---|---|---|---|
| [SPEC-tasks-1](#spec-tasks-1-二级菜单) | 二级菜单 | 进入任务模块 | 视图、来源、自动化、最近推送四组 |
| [SPEC-tasks-2](#spec-tasks-2-全部任务和逾期) | 全部任务、逾期 | 二级菜单「全部任务」「逾期」（模块入口是全部任务） | 任务列表，按截止日分段 |
| [SPEC-tasks-3](#spec-tasks-3-来源视图) | 来源视图 | 二级菜单「人工创建」「IM 消息」「Webhook」「定时」「运行异常」 | 同一个列表，只看某种来源 |
| [SPEC-tasks-4](#spec-tasks-4-任务抽屉) | 任务抽屉 | 列表点一行、「新建任务」、IM 消息「转任务」、今日点任务 | 新建、查看、编辑、删除 |
| [SPEC-tasks-5](#spec-tasks-5-任务抽屉的开发闭环区块) | 任务抽屉的开发闭环区块 | 开发任务的抽屉里 | 等你验收栏（验收通过、退回）、进展时间线（按会话分组）、产出物、执行记录；列表完成圆圈的验收确认。改动区原型未做 |
| [SPEC-tasks-6](#spec-tasks-6-交给-claude-code) | 交给 Claude Code | 任务抽屉「开发」组的按钮 | 选工作目录、只读或允许写入、附加说明，流式显示执行过程 |
| [SPEC-tasks-7](#spec-tasks-7-定时任务列表) | 定时任务列表 | 二级菜单「定时任务」 | 规则列表，启停 |
| [SPEC-tasks-8](#spec-tasks-8-定时任务抽屉) | 定时任务抽屉 | 定时任务列表点一行、「新建定时任务」、今日点定时任务 | 配规则和动作、立即执行、执行记录 |
| [SPEC-tasks-9](#spec-tasks-9-webhook-接入) | Webhook 接入 | 二级菜单「Webhook 接入」 | Webhook 列表 |
| [SPEC-tasks-10](#spec-tasks-10-webhook-配置页) | Webhook 配置页 | Webhook 列表点一行、二级菜单「最近推送」下的某个 Webhook、「新建 Webhook」 | 地址、映射、过滤去重、测试推送、推送记录 |

### 引用本文件的开发任务

| 任务 | 对照的节 |
|---|---|
| DEV-07a 任务列表页接真实接口 | `SPEC-tasks-1.1 到 1.4`、`SPEC-tasks-2`（全节）；待验收见 `SPEC-tasks-2.6`、`SPEC-tasks-0` 状态流转 |
| DEV-07b 任务抽屉：新建、编辑、改状态 | `SPEC-tasks-4`（全节，开发字段见 `SPEC-tasks-4.25 到 4.28`） |
| DEV-08a 进展时间线 | `SPEC-tasks-5.1 到 5.6`、`5.19`（会话 id 复制） |
| DEV-08b 产出物 | `SPEC-tasks-5.7 到 5.11` |
| DEV-08c 执行记录和流式输出 | `SPEC-tasks-5.12 到 5.17`、`5.26` |
| DEV-08d 改动痕迹、验收和退回 | `SPEC-tasks-5.18`、`5.20 到 5.25`、`5.27`（完成圆圈确认）、`5.28` |
| DEV-09 交给 Claude Code | `SPEC-tasks-6`（全节） |
| TODAY-02 今日页 | 点任务打开的抽屉是 `SPEC-tasks-4`；主体见 `today.md` `SPEC-today-1` |
| TASK-04a 定时任务页 | `SPEC-tasks-7`、`SPEC-tasks-8` |
| TASK-04b Webhook 页和来源视图 | `SPEC-tasks-1.5 到 1.8`、`SPEC-tasks-3`、`SPEC-tasks-9`、`SPEC-tasks-10`；来源标签见 `SPEC-tasks-0` `TaskSource` |

### 共用数据结构

`Task`（`web-next/src/taskdata.ts`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号 | `tk_s1` |
| `ref` | `string` | 是 | 给人看的编号，原型按现有最大号加一（正式产品由后端发号，见 CORE-11） | `T-012` |
| `title` | `string` | 是 | 标题，去首尾空白后不能为空 | `Export job timeout after 300s` |
| `desc` | `string` | 是 | 描述，可以是空串 | |
| `status` | `TaskStatus` | 是 | 状态 | 见下 |
| `priority` | `Priority` | 是 | 优先级 | 见下 |
| `assignee` | `string` | 是 | 负责人名字，空串表示未分配 | `我`、`周屿` |
| `due` | `string \| null` | 是 | 截止日期 `yyyy-mm-dd`，没有截止为 `null` | `2026-10-31` |
| `source` | `TaskSource` | 是 | 从哪来的 | 见下 |
| `project_id` | `string` | 否 | 所属项目；不属于任何项目时没有这个字段 | `pj_perm` |
| `project_removed` | `string` | 否 | 原属项目被删时记下的项目名，任务上提示「原属项目已删除」；重新选了项目后清掉 | `远川科技权限改造` |
| `acceptance` | `string` | 否 | 开发任务的验收标准，Markdown 清单 `- [ ] …`（正式产品存 `props.acceptance`） | `- [ ] 12 万行的导出 60 秒内完成` |
| `workdir` | `string` | 否 | 开发任务的工作目录，本机绝对路径；没设时继承所属项目的根目录（正式产品是 `workdir` 列） | `/Volumes/project/clients/yuanchuan-permission/server` |
| `repo` | `string` | 否 | 关联仓库，远端地址或本机绝对路径，只放一个（正式产品存 `props.repo`） | `/Volumes/project/0xBroleez/pm-workspace` |
| `created_at` | `string` | 是 | ISO 时间 | |
| `updated_at` | `string` | 是 | ISO 时间，每次改动刷新 | |

`TaskStatus`（`taskdata.ts`）：`'todo' | 'doing' | 'review' | 'done' | 'cancelled'`。显示名、颜色、说明读设置里的枚举 `task_status`（`enumdata.ts`），数据里只存 key；种子默认值如下，新建任务的默认状态取枚举的 `default_key`（`todo`）。

| key | 显示名 | 颜色 | 说明 | 是否算未结束（`isOpenTask`） |
|---|---|---|---|---|
| `todo` | 待办 | `#a19d92` | | 是 |
| `doing` | 进行中 | `#3d4fd6` | | 是 |
| `review` | 待验收 | `#7048e8` | 做完了等人验收，验收通过再改成已完成。开发任务由 Claude Code 提交验收后停在这里（迁移 0013，非终态） | 是 |
| `done` | 已完成 | `#2f7d43` | 算作完成，不再提示逾期 | 否 |
| `cancelled` | 已取消 | `#a19d92` | 不算完成也不算逾期 | 否 |

状态可以在「设置 / 枚举值」里加；页面上的状态筛选、抽屉里的状态按钮都按枚举顺序排，不写死。

状态流转（原型里任意状态之间都能在抽屉里直接切换；下图是开发任务闭环约定的主路径，验收和退回的按钮见 `SPEC-tasks-5.21 到 5.23`）：

```mermaid
stateDiagram-v2
  [*] --> todo: 新建
  todo --> doing: 领取 / 手动改
  doing --> review: 提交验收
  review --> done: 验收通过
  review --> todo: 退回（意见必填）
  todo --> cancelled: 取消
  doing --> cancelled: 取消
  done --> todo: 列表里取消勾选
```

`Priority`（`taskdata.ts`）：`'P0' | 'P1' | 'P2' | 'P3' | (string & {})`，可以在设置的枚举 `task_priority` 里新增。种子：`P0` P0 紧急 `#c0352b` 当天处理 / `P1` P1 高 `#b0570b` 本周内 / `P2` P2 中 `#3d4fd6`（默认） / `P3` P3 低 `#a19d92` 有空再做。

`TaskSource`（`taskdata.ts`），按 `kind` 区分：

| `kind` | 其余字段 | 列表上的来源标签（`SourceTag`） | 抽屉里的来源卡 |
|---|---|---|---|
| `manual` | 无 | 「人工」 | 无 |
| `im` | `message_id: string`、`channel: string`、`sender: string`、`text: string` | 「渠道名 · 发送人」，悬停显示原文 | 「来自 IM 消息」，引用原文，「查看原消息」 |
| `webhook` | `hook_id: string`、`delivery_id: string` | 「Webhook · Webhook 名」，Webhook 已删时「已删除」 | 「来自 Webhook」，「查看配置」「看推送内容」 |
| `schedule` | `schedule_id: string`、`name: string` | 「定时 · 定时任务名」 | 「来自定时任务」，「查看规则」 |
| `incident` | `incident_id: string`、`title: string` | 「异常 · 异常标题」，悬停显示标题 | 「来自运行异常」，「查看异常」 |

`Webhook`（`taskdata.ts`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号 | `wh_sentry` |
| `name` | `string` | 是 | 名称，保存时必填 | `Sentry 线上告警` |
| `token` | `string` | 是 | 接收地址最后一段，新建时随机生成 | `k7Qm2sentry9x` |
| `secret` | `string` | 是 | 签名用的密钥，新建时随机生成 | `whsec_3f9a71c2e84b` |
| `enabled` | `boolean` | 是 | 停用后推送只记录不建任务 | `true` |
| `mapping` | `{ title: string; desc: string; priority: string; assignee: string; due: string }` | 是 | 任务字段取推送 JSON 里的哪个路径，形如 `event.title`、`items[0].name`；`title` 必填，其余留空用默认值或不取 | `{ title: 'event.title', desc: 'event.culprit', priority: 'event.level', assignee: '', due: '' }` |
| `filter` | `string` | 是 | 只有满足才建任务，只支持 `路径 == 值` / `路径 != 值`，留空不过滤 | `action == created` |
| `dedupe` | `string` | 是 | 去重字段路径，同一个值第二次推来不再建（只认任务还在的投递） | `event.id` |
| `defaults` | `{ priority: Priority; assignee: string }` | 是 | 映射取不到时的默认值 | `{ priority: 'P1', assignee: '周屿' }` |
| `sample` | `string` | 是 | 测试推送用的示例 JSON 文本 | |
| `created_at` | `string` | 是 | ISO 时间 | |

`Delivery`（`taskdata.ts`）：一次推送的记录

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号 | `dl_s1` |
| `hook_id` | `string` | 是 | 哪个 Webhook | `wh_sentry` |
| `at` | `string` | 是 | 推送时间 | |
| `payload` | `Json`（`Record<string, unknown>`） | 是 | 原始推送内容 | |
| `result` | `'created' \| 'skipped' \| 'failed'` | 是 | 结果 | `created` 已建任务（绿） / `skipped` 已忽略（灰） / `failed` 失败（红） |
| `task_id` | `string` | 否 | 建出的任务；按重复忽略时指向之前建的那条 | `tk_s1` |
| `reason` | `string` | 否 | 没建或失败的原因 | `标题路径 answers.need 取不到值` |
| `mapped` | `Partial<Record<'title' \| 'desc' \| 'priority' \| 'assignee' \| 'due', string>>` | 否 | 映射出来的字段，失败时也留着 | |

`Ingest`（`taskdata.ts`）：`{ delivery: Delivery; task?: Task }`，一次推送处理的结果。处理顺序（`ingest`）：Webhook 停用 -> `skipped`「Webhook 已停用，只记录不建任务」；不满足过滤 -> `skipped`「不满足过滤条件 …（实际是「…」）」；过滤条件写法不对 -> `skipped`「过滤条件写法不对：…」；去重值已建过且那条任务还在 -> `skipped`「… 已经建过任务，按重复推送忽略」；标题取不到 -> `failed`「标题路径 … 取不到值」或「没有配置标题映射」；否则建任务，标题截前 120 字，截止只取 `yyyy-mm-dd` 开头，优先级按 `SPEC-tasks-10.9` 的规则换算。

`Schedule`（`web-next/src/scheduledata.ts`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号 | `sc_weekly_agenda` |
| `name` | `string` | 是 | 名称，保存时必填 | `周会前整理议程` |
| `enabled` | `boolean` | 是 | 停用后不自动执行，可以手动执行 | `true` |
| `rule` | `ScheduleRule` | 是 | 什么时候 | 见下 |
| `action` | `ScheduleAction` | 是 | 做什么 | 见下 |
| `history` | `ScheduleRun[]` | 是 | 执行记录，新的在前 | |
| `created_at` | `string` | 是 | ISO 时间 | |

`ScheduleRule`（`scheduledata.ts`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `freq` | `Freq` | 是 | 频率 | `once` 只执行一次 / `daily` 每天 / `weekdays` 工作日 / `weekly` 每周 / `monthly` 每月 / `cron` Cron 表达式 |
| `time` | `string` | 是 | `HH:mm`，`cron` 时不用 | `09:00` |
| `weekdays` | `number[]` | 是 | 每周的周几，0 是周日 | `[1]` |
| `day` | `number` | 是 | 每月几号，31 在小月按月底 | `25` |
| `date` | `string` | 是 | 只执行一次的日期 `yyyy-mm-dd` | |
| `cron` | `string` | 是 | 5 段：分 时 日 月 周 | `0 18 * * 1` |

新建时的默认规则（`emptyRule`）：每周一 09:00，`date` 是明天，`cron` 是 `0 9 * * 1`。规则校验（`ruleError`）：时间不是 `HH:mm`「时间要写成 09:00 这种格式」；每周没选周几「每周执行要至少选一天」；只执行一次没选日期「选一个执行日期」、时间已过「这个时间已经过去了」；Cron 不是 5 段「Cron 要 5 段：分 时 日 月 周，比如 0 9 * * 1」。原型的 Cron 只认「分 时 * * 周」，其余按每天这个点算（正式产品要完整支持）。

`ScheduleAction`（`scheduledata.ts`），按 `kind` 区分，显示名 `ACTION_LABEL`：

| `kind` | 显示名 | 其余字段 | 列表里「做什么」的文字（`actionText`） |
|---|---|---|---|
| `task` | 建一条任务 | `title: string`（可写 `{{date}}`，执行时换成当天日期）、`desc: string`、`priority: Priority`、`assignee: string`、`due_days: number`（截止是执行日加几天，可选 0 / 1 / 2 / 3 / 5 / 7） | 建任务「标题」，没填时「未填标题」 |
| `sop` | 执行 SOP | `sop_id: string` | 执行「SOP 名」，SOP 已删时「已删除的 SOP」 |
| `agent` | 让 Agent 去做 | `agent_id: string`、`prompt: string` | 「Agent 名：要求」，Agent 已删时「已删除的 Agent」，没填要求时「未填要求」 |

`ScheduleRun`（`scheduledata.ts`）：`{ at: string; ok: boolean; text: string; ref?: string; manual?: boolean }`。`text` 是给人看的结果（「建了任务 T-005」「没执行：已停用」）；`ref` 是建出的任务编号；`manual` 为 `true` 表示「立即执行一次」手动触发。

`TaskView`（`tasks.tsx`）：二级菜单的 key。`'all' | 'due' | 'manual' | 'im' | 'webhook' | 'schedule' | 'incident' | 'schedules' | 'hooks' | 'hook:<Webhook id>'`，其中 `hook:new` 是新建 Webhook。

### 联动总表

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | 今日 | 点任务行 / 完成圆圈 / 「全部任务」 | 打开任务抽屉 / 改为已完成 / 任务列表 | `SPEC-today-1.8 到 1.11` |
| 进来 | 今日 | 点「今天还会自动执行」的一行 | 定时任务列表并打开抽屉 | `SPEC-today-1.12` |
| 进来 | IM 消息 | 点「转任务」 | 已经转过：打开那条任务；没转过：打开「IM 消息转任务」抽屉 | `SPEC-tasks-4.3`、`SPEC-messages` |
| 进来 | 设置 / 运行异常 | 异常抽屉里「转为研发任务」再点「建任务」 | 建一条 `source.kind = incident` 的任务，异常状态改为已转任务 | `SPEC-settings` |
| 进来 | 外部系统 | 往 Webhook 接收地址推 JSON | 记一条投递，按规则建任务 | `SPEC-tasks-10` |
| 进来 | 命令面板 | 「新建定时任务」 | 定时任务列表并打开新建抽屉 | `SPEC-tasks-8` |
| 出去 | IM 消息 | 抽屉「查看原消息」 | 跳到原消息 | `SPEC-messages` |
| 出去 | 设置 / 运行异常 | 抽屉「查看异常」 | 设置的运行异常并打开异常抽屉 | `SPEC-settings` |
| 出去 | 会话 | 定时任务执行「让 Agent 去做」 | 会话 / 执行记录多一条 | `SPEC-sessions` |
| 出去 | SOP | 定时任务执行「执行 SOP」 | SOP 多一次执行 | `SPEC-sop` |
| 改动 | IM 消息 | 转任务时勾选「建好后把这条消息标为已处理」 | 消息状态改为已处理、取消稍后提醒、标为已读 | `SPEC-tasks-4.14` |
| 改动 | 设置 / 运行异常 | 删除由异常转来的任务 | 异常退回未处理，备注「关联的任务已删除」 | `SPEC-tasks-4.19` |
| 改动 | 设置 / 运行异常 | Webhook 测试推送结果为失败 | 上报一条 warn 级运行异常「Webhook 名：推送没建成任务」 | `SPEC-tasks-10.15` |
| 改动 | 项目 | 任务选了所属项目 | 项目的任务标签里多一条 | `SPEC-projects` |
| 改动 | 项目 | 项目被删 | 任务移出项目，留 `project_removed` 提示 | `SPEC-tasks-2.9` |

## SPEC-tasks-1 二级菜单

任务模块的二级菜单。桌面在左侧竖排；手机变成页面顶部横向滚动的一排标签。

### 截图

二级菜单出现在本模块每张截图里，见 `SPEC-tasks-2` 的截图（桌面左侧一栏、手机顶部第二行）。

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-1.1 | 「视图」组：全部任务 | 点击 | 切到全部任务列表（`SPEC-tasks-2`），关掉已打开的抽屉 |
| SPEC-tasks-1.2 | 「视图」组：逾期 | 展示、点击 | 有逾期时显示红点，说明「N 条过了截止日还没完成」；没有时说明「没有逾期的任务」。点击切到逾期列表 |
| SPEC-tasks-1.3 | 分组标题 | 展示 | 视图、来源、自动化、最近推送四组，组标题不可点。本模块的二级菜单不带搜索框（外壳二级菜单的搜索要显式开启，任务模块没开） |
| SPEC-tasks-1.4 | 任意菜单项 | 点击 | 切换视图都会关闭当前抽屉 |
| SPEC-tasks-1.5 | 「来源」组：人工创建、IM 消息、Webhook、定时、运行异常 | 点击 | 切到对应的来源视图（`SPEC-tasks-3`） |
| SPEC-tasks-1.6 | 「自动化」组：定时任务 | 点击 | 说明「到点自动建任务、跑 SOP、叫 Agent」，切到定时任务列表（`SPEC-tasks-7`） |
| SPEC-tasks-1.7 | 「自动化」组：Webhook 接入 | 展示、点击 | 说明「N 个」，有最近一次推送失败的 Webhook 时加「，M 个最近推送失败」并显示红点。点击切到 Webhook 列表（`SPEC-tasks-9`） |
| SPEC-tasks-1.8 | 「最近推送」组 | 展示、点击 | 最近推送过的 Webhook，按最近推送时间排，最多 5 个；说明「N 分钟前推送」，停用的加「· 已停用」；最近一次失败的显示红点。点击打开它的配置页（`SPEC-tasks-10`）。打开的 Webhook 不在这 5 个里时，高亮落在「Webhook 接入」 |
| SPEC-tasks-1.9 | 菜单底部「新建 Webhook」 | 点击 | 打开新建 Webhook 页（`SPEC-tasks-10`，`hook:new`） |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-tasks-1.10 | 还没有任何推送 | 「最近推送」组不出现 | 「新建 Webhook」 |
| SPEC-tasks-1.11 | 逾期条数、失败条数加载失败 | 原型未做。正式产品：不显示红点和数字，不显示成「没有逾期的任务」 | 无 |

### 数据

逾期条数用 `isOverdue`：有 `due`、早于今天、状态未结束。「最近推送」用每个 Webhook 最近一条 `Delivery`（`lastDeliveries`）。正式产品里逾期条数取 `/api/counts` 的 `overdue`，必须和逾期列表口径一致（DEV-07a）。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | 今日 | 「还有 N 条，去任务」 | 有逾期时停在「逾期」 | `SPEC-today-1.11` |

## SPEC-tasks-2 全部任务和逾期

任务列表。两个视图共用一个页面，差别只在过滤条件、标题和说明。

### 截图

全部任务（模块入口截图 `入口-*` 与此相同）：

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![全部任务 1440 亮](shots/tasks/全部任务-1440-light.png) | ![全部任务 1440 暗](shots/tasks/全部任务-1440-dark.png) |
| 手机 375 | ![全部任务 375 亮](shots/tasks/全部任务-375-light.png) | ![全部任务 375 暗](shots/tasks/全部任务-375-dark.png) |

逾期：

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![逾期 1440 亮](shots/tasks/逾期-1440-light.png) | ![逾期 1440 暗](shots/tasks/逾期-1440-dark.png) |
| 手机 375 | ![逾期 375 亮](shots/tasks/逾期-375-light.png) | ![逾期 375 暗](shots/tasks/逾期-375-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-2.1 | 页面标题 | 展示 | 面包屑「任务 /」加标题，标题旁是当前筛选后的条数。全部任务：「全部任务」，说明「人工创建、IM 消息转来、Webhook 推来的任务都在这里，按截止日分段」；逾期：「逾期任务」，说明「过了截止日还没完成的任务，最早到期的在前」 |
| SPEC-tasks-2.2 | 右上「新建任务」 | 点击 | 打开新建任务抽屉（`SPEC-tasks-4`），焦点在标题 |
| SPEC-tasks-2.3 | 状态筛选（分段按钮） | 点击 | 依次是「未完成」（默认，未结束的状态都算，含待验收）、枚举里除 `cancelled` 以外的前 5 个状态、「全部」；每个按钮带该视图下的条数。已取消的只在「全部」里看得到 |
| SPEC-tasks-2.4 | 「更多状态」下拉 | 选择 | 枚举里的状态超过 5 个（不算已取消）时出现，可搜索，选项旁带条数；选中后按该状态过滤，清空回到「未完成」 |
| SPEC-tasks-2.5 | 「全部优先级」下拉 | 选择 | 按优先级过滤，选项来自枚举 `task_priority` |
| SPEC-tasks-2.6 | 待验收 | 展示 | 状态筛选里有「待验收」按钮（`review`）；待验收的任务在「未完成」里照常按截止日分段，状态列显示紫色「待验收」标签；不算逾期豁免，过了截止日照样进「逾期」。演示数据里 `T-015`、`T-017` 待验收，`T-016` 进行中，都由 Claude Code 做（`SPEC-tasks-5`） |
| SPEC-tasks-2.7 | 「全部项目」下拉 | 选择 | 可搜索；选项是所有项目和「不属于项目」。选中的项目已删除时显示「已删除的项目」 |
| SPEC-tasks-2.8 | 搜索框 | 输入 | 按标题、描述、编号、负责人模糊匹配（不区分大小写），实时过滤，清空后恢复 |
| SPEC-tasks-2.9 | 列表行 | 展示 | 列：完成圆圈、任务（编号、标题；下一行是来源标签、项目标签、「N 分钟前创建」）、优先级、负责人（空时「未分配」）、截止（今天显示「今天」，其余 `mm-dd`，没有显示「-」，逾期的红字加「逾期」）、状态。项目已删除时项目标签显示「已删除的项目」；任务的原属项目被删时显示「原属项目已删除」，悬停显示原项目名。已完成的行变淡 |
| SPEC-tasks-2.10 | 列表行 | 点击 | 打开该任务的抽屉（`SPEC-tasks-4`），当前行高亮 |
| SPEC-tasks-2.11 | 行首完成圆圈 | 点击 | 不打开抽屉。未完成的标为 `done`，圆圈打勾；已完成的改回 `todo`。悬停提示「标为已完成」/「标为待办」。待验收的任务例外：先弹确认，确认后等于验收通过，悬停提示「验收通过」（`SPEC-tasks-5.27`） |
| SPEC-tasks-2.12 | 截止分段 | 展示 | 列表按截止日分段：逾期（红字）、今天、本周（到本周日）、以后、无截止、已结束（`done`、`cancelled`），没有条目的段不出现。段内先按优先级 key 排，再按截止日，没有截止的在后 |
| SPEC-tasks-2.13 | 分段标题 | 点击 | 折叠或展开这一段，标题带条数 |
| SPEC-tasks-2.14 | 段尾「这一段还有 N 条」 | 点击 | 每段先露 30 条，超出时出现；点一次多露 100 条。换视图、状态、优先级、项目或搜索词后各段重新只露 30 条 |
| SPEC-tasks-2.15 | 手机宽度 | 展示 | 正文宽度不到 640px 时隐藏负责人、截止两列，只留圆圈、任务、优先级、状态 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-tasks-2.16 | 全部任务视图没有任务 | 「这里还没有任务」，下面「点右上角新建一个」 | 「新建任务」 |
| SPEC-tasks-2.17 | 逾期视图没有任务 | 「没有逾期的任务」，下面「截止日都还没到，或者已经做完了」 | 无 |
| SPEC-tasks-2.18 | 有搜索词、优先级或项目筛选但没有结果 | 「没有匹配的任务」 | 清掉筛选条件 |
| SPEC-tasks-2.19 | 只是状态筛选没有结果（视图里有任务，如「定时」视图里全是已完成） | 「没有符合条件的任务」，下面说明：选的是具体状态时「没有处于「状态名」的任务」，「未完成」时「这里的 N 条都已结束」。搜索、优先级、项目筛空时是「没有匹配的任务 / 换个筛选条件试试」；视图里一条都没有才是视图的空状态（`SPEC-tasks-3.7`） | 「切回「未完成」」/「看全部」 |
| SPEC-tasks-2.20 | 加载失败 | 原型未做。正式产品：列表区显示错误信息和「重试」，状态按钮上的条数不显示 | 重试 |
| SPEC-tasks-2.21 | 改状态失败（点完成圆圈） | 原型未做。正式产品：圆圈恢复原状，提示失败原因 | 再点一次 |
| SPEC-tasks-2.22 | 状态被别处改了（MCP、其它客户端） | 原型未做。正式产品：刷新或重新进入页面后显示新状态，和其它客户端看到同一份数据（DEV-07a） | 刷新 |

### 数据

见 `SPEC-tasks-0` `Task`、`TaskStatus`、`Priority`、`TaskSource`。页面内部类型（`tasks.tsx`）：

| 名称 | 类型 | 说明 |
|---|---|---|
| `StatusFilter` | `'open' \| TaskStatus \| 'all'` | 状态筛选；`open` 即未结束 |
| `DueSeg` | `'overdue' \| 'today' \| 'week' \| 'later' \| 'none' \| 'closed'` | 截止分段：逾期 / 今天 / 本周 / 以后 / 无截止 / 已结束 |
| `PAGE` | `30` | 每段先露几条 |

逾期视图的条件：`isOverdue`（有 `due`、早于今天、未结束）。正式产品用 `GET /api/objects?type=task&overdue=true`，条数和 `/api/counts` 的 `overdue` 一致；搜索走 `q=`；本周、今天的口径见 `docs/api-contract.md` 工作对象一节。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 出去 | 任务抽屉 | 点一行 / 新建任务 | 打开抽屉 | `SPEC-tasks-4` |
| 改动 | 今日 | 点完成圆圈 | 今日的「今天的任务」同步 | `SPEC-today-1.7` |

## SPEC-tasks-3 来源视图

同 `SPEC-tasks-2` 的列表，只看 `source.kind` 等于某个来源的任务；筛选、分段、行、抽屉的交互完全一样，只列差别。

### 截图

| 视图 | 桌面 1440 亮 | 桌面 1440 暗 | 手机 375 亮 | 手机 375 暗 |
|---|---|---|---|---|
| 人工创建 | ![](shots/tasks/人工创建-1440-light.png) | ![](shots/tasks/人工创建-1440-dark.png) | ![](shots/tasks/人工创建-375-light.png) | ![](shots/tasks/人工创建-375-dark.png) |
| IM 消息 | ![](shots/tasks/IM_消息-1440-light.png) | ![](shots/tasks/IM_消息-1440-dark.png) | ![](shots/tasks/IM_消息-375-light.png) | ![](shots/tasks/IM_消息-375-dark.png) |
| Webhook | ![](shots/tasks/Webhook-1440-light.png) | ![](shots/tasks/Webhook-1440-dark.png) | ![](shots/tasks/Webhook-375-light.png) | ![](shots/tasks/Webhook-375-dark.png) |
| 定时 | ![](shots/tasks/定时-1440-light.png) | ![](shots/tasks/定时-1440-dark.png) | ![](shots/tasks/定时-375-light.png) | ![](shots/tasks/定时-375-dark.png) |
| 运行异常 | ![](shots/tasks/运行异常-1440-light.png) | ![](shots/tasks/运行异常-1440-dark.png) | ![](shots/tasks/运行异常-375-light.png) | ![](shots/tasks/运行异常-375-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-3.1 | 页面标题和说明 | 展示 | 人工创建：「人工创建的任务」/「自己手动建的任务」；IM 消息：「IM 消息转的任务」/「在 IM 消息里点「转任务」建的，能回看原消息」；Webhook：「Webhook 转的任务」/「外部系统推到接收地址后按映射规则自动建的，能回看原始推送」；定时：「定时任务建的任务」/「定时任务到点自动建的，规则在「定时任务」里改」；运行异常：「运行异常转的研发任务」/「从「设置 / 运行异常」转过来的，带着异常详情；做完回去把异常标为已解决」 |
| SPEC-tasks-3.2 | 状态按钮上的条数 | 展示 | 只数这个来源的任务 |
| SPEC-tasks-3.3 | 来源标签 | 展示 | 每行的来源标签见 `SPEC-tasks-0` `TaskSource`；条数与按 `source` 筛选的结果一致（TASK-04b） |
| SPEC-tasks-3.4 | 「新建任务」 | 点击 | 在任何来源视图里新建的都是人工任务（`source.kind = manual`），建完不一定出现在当前视图 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-tasks-3.5 | IM 消息视图没有任务 | 「这里还没有任务」，下面「在 IM 消息里点「转任务」」 | 无 |
| SPEC-tasks-3.6 | Webhook 视图没有任务 | 「这里还没有任务」，下面「在「Webhook 接入」里建一个 Webhook，把地址填到外部系统里」 | 二级菜单「Webhook 接入」 |
| SPEC-tasks-3.7 | 人工创建、定时、运行异常视图没有任务 | 「这里还没有任务」，下面：人工创建「点右上角新建一个」，定时「定时任务到点会建在这里」，运行异常「在「设置 / 运行异常」里转任务」 | 人工创建：「新建任务」 |
| SPEC-tasks-3.8 | 来源对象已删除 | Webhook 已删：来源标签「Webhook · 已删除」；定时任务、异常已删：标签照旧显示建任务时记下的名字 | 无 |

### 数据

过滤条件 `t.source.kind === view`，`view` 是 `manual`、`im`、`webhook`、`schedule`、`incident` 之一。正式产品的来源字段由 TASK-01 补到后端。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | IM 消息 / Webhook / 定时任务 / 运行异常 | 各自建任务 | 对应来源视图多一条 | `SPEC-tasks-0` 联动总表 |

## SPEC-tasks-4 任务抽屉

从右侧滑出的抽屉，新建和查看共用。三种开法：新建（kicker「新建任务」）、IM 消息转任务（kicker「IM 消息转任务」）、查看已有任务（kicker 是任务编号）。

### 截图

开发闭环和未保存确认的抽屉截图见 `SPEC-tasks-5` 和 `SPEC-tasks-4.23`，其余没有截图。看到它的步骤：

- 新建：任务模块右上「新建任务」。
- 查看 IM 来源的任务：全部任务里点 `T-010`。
- 查看 Webhook 来源的任务：点 `T-012`，再点来源卡的「看推送内容」。
- 查看定时来源：「全部」状态下点 `T-005`；运行异常来源：点 `T-013`。
- IM 消息转任务：IM 消息模块里选一条待处理的消息，点「转任务」。
- 删除确认：打开任意任务，点左下「删除任务」。
- 开发任务（等你验收栏、开发组、进展、产出物、执行记录）：点 `T-015`、`T-017`（待验收）或 `T-016`（进行中），截图见 `SPEC-tasks-5`。

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-4.1 | 右上关闭按钮 / Esc | 点击 / 按键 | 关闭抽屉，不保存。原型没有未保存提示（见文末第 6 条） |
| SPEC-tasks-4.2 | 新建 | 打开 | 标题空、获得焦点；状态取枚举 `task_status` 的默认值（`todo`），优先级取 `task_priority` 的默认值（`P2`），负责人「我」，没有截止，不属于项目 |
| SPEC-tasks-4.3 | IM 消息转任务 | 打开 | 顶部来源卡「来自 IM 消息」：渠道 · 发送人、原文引用、「查看原消息」；标题预填消息正文前 40 字（空白合并）。这条消息已经转过任务时，不开新建，直接打开那条任务 |
| SPEC-tasks-4.4 | 来源卡「查看原消息」 | 点击 | 切到 IM 消息模块并打开原消息 |
| SPEC-tasks-4.5 | 来源卡（Webhook）「查看配置」 | 点击 | 关闭抽屉，切到这个 Webhook 的配置页（`SPEC-tasks-10`）；Webhook 已删时不显示按钮，名称显示「已删除的 Webhook」 |
| SPEC-tasks-4.6 | 来源卡（Webhook）「看推送内容」/「收起推送内容」 | 点击 | 展开或收起这次投递的原始 JSON；说明文字带「N 分钟前推送」。找不到投递时不显示 |
| SPEC-tasks-4.7 | 来源卡（定时）「查看规则」 | 点击 | 切到定时任务列表并打开该定时任务的抽屉（`SPEC-tasks-8`） |
| SPEC-tasks-4.8 | 来源卡（运行异常）「查看异常」 | 点击 | 切到「设置 / 运行异常」并打开异常抽屉 |
| SPEC-tasks-4.9 | 标题（必填） | 输入 | 占位「要做的事」 |
| SPEC-tasks-4.10 | 描述 | 输入 | 多行文本 |
| SPEC-tasks-4.11 | 状态、优先级（分段按钮） | 点击 | 选项按枚举顺序，悬停显示枚举里的说明；当前值已被停用或删除时仍保留在选项里（`optionsWith`）。状态里有「待验收」 |
| SPEC-tasks-4.12 | 负责人 | 输入或选择 | 可手填；候选是「我」加联系人里「同事」组的人 |
| SPEC-tasks-4.13 | 截止日期、所属项目 | 选择 | 日期可清空；所属项目可搜索，选「不属于项目」清空。任务原属项目被删时，项目为空并在下面显示「原属项目「名称」已删除」，重新选项目后这条提示消失 |
| SPEC-tasks-4.14 | 「建好后把这条消息标为已处理」 | 勾选 | 只在 IM 消息转任务、且消息还是待处理时出现，默认勾上；建好后把消息改为已处理、取消稍后提醒、标为已读 |
| SPEC-tasks-4.15 | 创建 / 更新时间 | 展示 | 查看已有任务时在表单末尾显示「N 天前创建 · N 分钟前更新」 |
| SPEC-tasks-4.16 | 「创建任务」 | 点击 | 标题去首尾空白后保存；建好后抽屉切到这条新任务的查看状态。来源：IM 转来的记 `im`，其余 `manual` |
| SPEC-tasks-4.17 | 「保存」 | 点击 | 保存全部字段并关闭抽屉，`updated_at` 刷新；重新选了项目时清掉 `project_removed` |
| SPEC-tasks-4.18 | 「取消」 | 点击 | 同关闭 |
| SPEC-tasks-4.25 | 「+ 开发信息：验收标准、工作目录，交给 Claude Code 做」 | 点击 | 新建任务时出现在所属项目下面，展开后是「开发」组。已存在的任务一直显示「开发」组 |
| SPEC-tasks-4.26 | 「开发」组：验收标准 | 输入 | 等宽多行文本，占位「- [ ] 一条一行，写成能检查的样子」；清空等于不设。保存时随表单一起保存 |
| SPEC-tasks-4.27 | 「开发」组：工作目录、关联仓库 | 输入 | 一行两格，等宽字体。工作目录没填时占位「继承自项目：项目根目录」，下面提示「没设时用所属项目的目录」；不属于项目时占位「本机绝对路径」。关联仓库占位「远端地址或本机路径，只放一个」 |
| SPEC-tasks-4.28 | 「开发」组右上「交给 Claude Code」 | 点击 | 只在已存在的任务上出现，见 `SPEC-tasks-6` |
| SPEC-tasks-4.19 | 左下「删除任务」 | 点击 | 底栏换成红字确认：「删除后不能恢复」，有连带影响时接着列出，如「运行异常「…」会退回未处理」「Webhook 再推送同样的内容会重新建任务」；「取消」回到原底栏，「删除」删掉并关闭抽屉。由异常转来的任务删掉后，异常退回未处理、备注「关联的任务已删除」；Webhook 投递记录保留，去重只认还在的任务 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-tasks-4.20 | 标题为空就点创建或保存 | 标题框标红，下面「必填」，不关闭抽屉 | 补全后再提交 |
| SPEC-tasks-4.21 | 打开的任务已被删除 | 原型不渲染抽屉。正式产品：抽屉显示「这条任务已删除」和关闭按钮 | 关闭 |
| SPEC-tasks-4.22 | 保存失败 | 原型未做。正式产品：底栏显示失败原因，抽屉保持打开、输入不丢 | 重试 |
| SPEC-tasks-4.23 | 有未保存改动时关闭 | Esc、右上关闭、底栏「取消」都先在底栏确认「有未保存的修改，关闭后会丢掉」；确认时再按 Esc 等于继续编辑。已有任务跟它当前的值比，验收、交给 Claude Code 直接改的状态和负责人不算改动；新建跟打开时比。截图 `shots/tasks/抽屉_未保存确认-1440-*.png` | 「继续编辑」/「放弃修改」 |
| SPEC-tasks-4.24 | 来源对象已删除 | Webhook 已删：「已删除的 Webhook」，不显示「查看配置」；投递找不到：不显示「看推送内容」 | 无 |

### 数据

`TaskDraft`（`tasks.tsx`）：抽屉的表单值，保存时整体交给上层

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | `string` | 是 | 保存时去首尾空白 |
| `desc` | `string` | 是 | |
| `status` | `TaskStatus` | 是 | |
| `priority` | `Priority` | 是 | |
| `assignee` | `string` | 是 | |
| `due` | `string \| null` | 是 | |
| `project_id` | `string` | 否 | |
| `acceptance`、`workdir`、`repo` | `string` | 否 | 开发字段，清空时为 `undefined` |

正式产品（DEV-07b）在原型字段之外加：正文用 Markdown、负责人和参与人从干系人名册选（`owner_id`、`participant_ids`）、工作目录（`workdir` 列，可选目录并即时校验，任务没设时显示「继承自项目：…」）、关联仓库（`props.repo`）、验收标准（`props.acceptance`，Markdown 清单）。编辑只传改动的字段，`props` 先读回再合并。删除走软删。开发任务的抽屉下部是 `SPEC-tasks-5` 的三块，顶部是等你验收栏；正式产品再加一块改动区（`SPEC-tasks-5.18`）。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | 今日 | 点任务行 | 在今日页上打开抽屉 | `SPEC-today-1.9` |
| 进来 | IM 消息 | 「转任务」 | 打开 IM 消息转任务抽屉 | `SPEC-messages` |
| 出去 | IM 消息、设置、Webhook、定时任务 | 来源卡按钮 | 见 `SPEC-tasks-4.4 到 4.8` | |
| 改动 | IM 消息、设置 / 运行异常 | 转任务勾选、删除任务 | 见 `SPEC-tasks-4.14`、`SPEC-tasks-4.19` | |

## SPEC-tasks-5 任务抽屉的开发闭环区块

开发任务（交给 Claude Code 做的任务）在抽屉里多出：顶部的「等你验收」栏（只在待验收时）、表单里的「开发」组（`SPEC-tasks-4.25 到 4.28`），以及表单下面的三块：进展、产出物、执行记录。原型在 `web-next/src/devloop.tsx`（组件和 `useDevLoop`），数据在 `taskdata.ts` 末尾；字段和 `docs/api-contract.md` 进展与领取、输出产物、任务执行 runs 对齐。时序见 `web-next/docs/dev-plan.md` 4.0。

什么算开发任务（`isDevTask`）：填了验收标准、工作目录、关联仓库之一，或者已经有进展、产出物、执行记录。不是开发任务的抽屉不出现这三块。

演示故事线（都在「产品工作台新版」「远川科技权限改造」两个项目里，负责人 Claude Code）：

| 任务 | 状态 | 故事 |
|---|---|---|
| `T-015` 导出改成分批写文件，修掉 300 秒超时 | 待验收 | 对应 `T-012` 的 Sentry 告警。会话 `7c41e2a9` 领取、改服务端、提交验收；你以「界面还是 300 秒报超时」退回；会话 `b18f5d03` 重新领取、改前端、再次提交验收。两条执行记录：一次只读（被权限挡下一次，有保留意见）、一次允许写入 |
| `T-016` 旧版设置页的错误横幅改成行内提示 | 进行中 | 对应项目资料「旧版用起来的问题清单」。会话 `e5a90c17` 做到一半；一条失败的执行记录 |
| `T-017` 权限变更缓存改成按部门失效 | 待验收 | 对应 `T-009`。会话 `42d7b8e6` 一次做完提交验收，带压测截图 |

### 截图

下面这些抽屉截图由 `shots.py` 按步骤截（`STEPS` 里的 `tasks_devloop`，桌面 1440，打开 `T-015`），`--only tasks` 重跑时一起重新生成；要手机宽度加 `--step-widths 1440,375`。

| 场景 | 步骤 | 亮 | 暗 |
|---|---|---|---|
| 等你验收 | 全部任务点 `T-015` | ![](shots/tasks/抽屉_待验收-1440-light.png) | ![](shots/tasks/抽屉_待验收-1440-dark.png) |
| 退回 | 等你验收栏点「退回」 | ![](shots/tasks/抽屉_退回-1440-light.png) | ![](shots/tasks/抽屉_退回-1440-dark.png) |
| 进展时间线 | 抽屉往下滚到「进展」 | ![](shots/tasks/抽屉_进展-1440-light.png) | ![](shots/tasks/抽屉_进展-1440-dark.png) |
| 产出物和执行记录 | 滚到「产出物」，展开只读那条执行记录 | ![](shots/tasks/抽屉_产出物和执行记录-1440-light.png) | ![](shots/tasks/抽屉_产出物和执行记录-1440-dark.png) |
| 执行中（流式） | 「交给 Claude Code」只读执行，开始后 2 秒 | ![](shots/tasks/抽屉_执行中-1440-light.png) | ![](shots/tasks/抽屉_执行中-1440-dark.png) |
| 列表完成圆圈确认 | 全部任务点 `T-017` 行首圆圈 | ![](shots/tasks/待验收_完成圆圈确认-1440-light.png) | ![](shots/tasks/待验收_完成圆圈确认-1440-dark.png) |

### 交互

进展（DEV-08a）：

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-5.1 | 「进展」时间线 | 展示 | 标题旁说明「按会话分组，标出是 Claude Code 哪次会话写的」。按时间顺序排；相邻、同一会话（`session_id` 和 `actor_name` 都相同）的进展归成一组。组头：操作者（`claude-code` 显示为紫色「Claude Code」，界面操作显示「我」）、会话 id 前 8 位（界面操作的组显示「界面操作」、底色更灰）、时间范围「5 小时前 到 4 小时前」。组里每条：圆点（领取蓝、进展灰、提交验收紫）、类型（领取 / 进展 / 提交验收）、「状态改为…」（这条进展同时切了状态时）、相对时间、正文（保留换行）、提交和文件小标签（提交只显示前 7 位） |
| SPEC-tasks-5.2 | 提交验收那条（`kind = review`） | 展示 | 正文区域加紫色浅底，类型字样紫色，作为验收时的阅读入口；最近一条还会出现在顶部「等你验收」栏（`SPEC-tasks-5.21`） |
| SPEC-tasks-5.3 | 自动刷新 | 抽屉打开期间 | 原型的进展都在本地，不刷新。正式产品：任务处于进行中时每 10 秒刷新一次；有事件推送（CORE-07c）后改为推送 |
| SPEC-tasks-5.4 | 「追加一条进展」输入框和「追加进展」 | 输入、提交 | 正文去首尾空白后为空时按钮不可用；Cmd/Ctrl + Enter 也能提交。提交后以「我 / 界面操作」出现在时间线末尾，输入框清空。正式产品：`POST /progress`，`kind = note` |
| SPEC-tasks-5.5 | 修订记录里的进展行 | 展示 | 原型没有修订记录。正式产品：`/revisions` 里 `field = progress` 的行不按「从 old 改成 new」显示（`old_value` 是元数据 JSON），只显示正文；任何位置都不把它显示成 JSON |
| SPEC-tasks-5.6 | 没有进展 | 展示 | 「还没有进展」 |
| SPEC-tasks-5.19 | 组头的会话 id | 点击 | 复制完整会话 id，按钮文字变成「已复制，claude --resume 7c41e2a9…」；悬停提示「复制会话 id，可以 claude --resume <id> 接着做」 |

产出物（DEV-08b）：

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-5.7 | 「产出物」面板 | 展示 | 标题旁说明「提交、分支、PR、文件」。分四组，组名带条数，没有条目的组不出现。种类从 `note` 前缀 `[commit]` / `[branch]` / `[pr]` 识别（`parseArtifact`），没有前缀的算文件；sha、branch、repo 从紧跟前缀的 `key=value` 取，余下的是备注。提交：7 位 sha（蓝色等宽）、分支标签、备注；分支：分支标签；PR：分支标签、备注（链接）；文件：相对路径、备注 |
| SPEC-tasks-5.8 | 有 `url` 的条目 | 点击 | 用「打开地址」打开（工作台开了浏览器模块就在内置浏览器里开，否则新窗口） |
| SPEC-tasks-5.9 | 只有 `path` 的条目 | 展示、复制 | 文件显示 `rel_path`（没有时显示绝对路径）；右侧「复制路径」复制绝对路径，按钮变「已复制」，悬停显示绝对路径 |
| SPEC-tasks-5.10 | 来源标签 | 展示 | `manual` 手动登记 / `agent` Agent / `run` 执行扫描 / `mcp` MCP 回写；每行最右是相对时间（手机上不显示） |
| SPEC-tasks-5.11 | 右上「登记产出物」 | 点击、提交 | 展开一个小表单：「链接或本机绝对路径」（必填）和备注（占位提示提交写成 `[commit] sha=… branch=…`）。以 `http` 开头记为 `url`，以 `/` 开头记为 `path`，其余提示「链接以 http 开头，路径要写绝对路径」且「登记」不可用。登记后来源是 `manual`。没有产出物时显示「还没有产出物」。正式产品：`POST /api/artifacts`，来源由后端定 |

执行记录（DEV-08c）：

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-5.12 | 「执行记录」列表 | 展示 | 标题旁说明「从这里交给 Claude Code 的每一次执行，最近的在前」。每条一行：状态（运行中蓝 / 完成绿 / 失败红 / 已取消灰，按 `TaskRun.status`，不看 `exit_code`）、权限（「只读」灰 / 「允许写入」橙）、附加说明（没有时「没有附加说明」，手机上隐藏）、「N 分钟前 · 用时」 |
| SPEC-tasks-5.13 | 一条执行记录 | 点击 | 展开或收起完整输出：首行等宽显示工作目录、会话 id 前 8 位、`exit N`，下面是输出。运行中的一直展开 |
| SPEC-tasks-5.14 | 流式输出 | 运行中 | 正文增量（`delta`）连续拼成段落；工具调用（`tool`）和结果（`tool_result`）按 `id` 配成一张卡片：工具名、参数摘要、右侧「执行中 / 成功 / 失败」；失败的卡片红边并在下面显示原因。写入类工具（Edit、Write、Bash）圆点是橙色。运行中末尾有闪烁的光标。原型每 450ms 吐一个事件模拟 SSE |
| SPEC-tasks-5.15 | 「取消执行」 | 点击（运行中） | 状态变「已取消」，原因「已取消」，不再有输出。正式产品：`POST /api/runs/{id}/cancel`，状态以后端返回为准 |
| SPEC-tasks-5.16 | 保留意见 | 展示 | 状态是完成但 `error` 有值时，行下面灰字「保留意见：…」，如「有 1 次工具调用被权限挡下（只读运行），没有改文件」；失败的红字显示原因 |
| SPEC-tasks-5.17 | 没有执行记录 | 展示 | 「还没有执行过」 |
| SPEC-tasks-5.26 | 执行结束后 | 展示 | 原型模拟：一个工具调用都没成功记「失败」，原因「没有一次工具调用成功」；有失败的记「完成」加保留意见；允许写入且完成时，Claude Code 会话回写一条进展「执行完成：改了文件，测试通过。」，改过的文件登记为来源「执行扫描」的产出物 |

改动痕迹、验收和退回（DEV-08d）：

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-5.18 | 「改动」区 | 展示 | 原型没有单独的改动区：字段改动没有修订记录，按会话分组只做在进展时间线上（`SPEC-tasks-5.1`）。正式产品：读 `GET /api/objects/{id}/revisions`，按 `session_id` 分组，组头样式同进展时间线；每组显示 `actor_name`、会话 id、时间范围、字段变更列表。不自己拆 `actor` 字符串 |
| SPEC-tasks-5.20 | 没有会话的改动（界面、接口） | 展示 | 归到「界面操作」组，不显示会话 id（进展时间线已经这样做） |
| SPEC-tasks-5.21 | 顶部「等你验收」栏 | 展示（只在 `review` 时） | 紫色边框的卡片，在来源卡之后、标题之前。头部「等你验收」加「Claude Code · 会话 b18f5d03 · 1 小时前提交」（取最近一条提交验收的进展）；正文是那条进展的全文；有验收标准时列出清单「对照验收标准（勾选只为自己核对，不保存）」，可勾选；底部「验收通过」「退回」 |
| SPEC-tasks-5.22 | 「验收通过」 | 点击 | 展开意见框（占位「意见（可选）」）和「确认验收通过」「取消」，说明「状态改为已完成，记一条「验收通过」的进展」。确认后记一条「我 / 界面操作」的进展「验收通过」（有意见时「验收通过：意见」），状态改为已完成，等你验收栏消失，抽屉里的状态按钮同步。正式产品：`POST /progress`，`kind = note`，`status = done`，进展和状态同一事务，`completed_at` 有值 |
| SPEC-tasks-5.23 | 「退回」 | 点击 | 展开意见框（占位「哪里没过、要怎么改，Claude Code 下次领取时会读到」）和「确认退回」「取消」，说明「状态回到待办，别的会话可以重新领取」。意见去首尾空白后为空时「确认退回」不可用，点过一次后框标红并提示「写一下退回原因」。确认后记一条进展「退回：意见」，状态改为待办。退回到待办而不是进行中：领取规则里「状态仍是那次领取切到的状态、负责人仍是领取者」算占用，退回到进行中会让别的会话领不到（`docs/api-contract.md` 进展与领取） |
| SPEC-tasks-5.24 | 「接手」 | 不提供 | 不做 takeover 按钮 |
| SPEC-tasks-5.27 | 列表、今日的完成圆圈（待验收的任务） | 点击 | 不直接改状态，先弹确认：标题「验收通过 T-017？」，说明「「标题」会改为已完成，并记一条「验收通过」的进展。要写意见或退回，打开任务处理。」；按钮「取消」「打开任务」「验收通过」（默认焦点）。Esc、点遮罩同取消。确认后等于 `SPEC-tasks-5.22` 不填意见；「打开任务」打开抽屉。圆圈悬停提示「验收通过」 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-tasks-5.6 / 5.11 / 5.17 | 没有进展 / 产出物 / 执行记录 | 「还没有进展」/「还没有产出物」/「还没有执行过」 | 追加进展 / 登记产出物 / 交给 Claude Code |
| SPEC-tasks-5.23 | 退回不写意见 | 「确认退回」不可用，提示「写一下退回原因」 | 写意见 |
| SPEC-tasks-5.25 | 加载失败 | 原型未做。正式产品：三块和改动区各自显示错误和「重试」，互不影响；任务表单照常可用 | 重试 |
| SPEC-tasks-5.28 | 验收、退回提交失败 | 原型未做。正式产品：意见框保留输入，显示失败原因，状态不变 | 重试 |

### 数据

`TaskProgress`（`taskdata.ts`，对应接口的 `Progress`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号 | `pg_tk_dev1_300` |
| `task_id` | `string` | 是 | 哪条任务（接口里是 `object_id`） | `tk_dev1` |
| `kind` | `ProgressKind` | 是 | `claim` 领取 / `note` 进展 / `review` 提交验收；显示名 `PROGRESS_LABEL` | `review` |
| `text` | `string` | 是 | 正文，Markdown，原型按纯文本保留换行显示 | |
| `commits` | `string[]` | 是 | 相关提交 | `['e3b91c4']` |
| `files` | `string[]` | 是 | 相关文件，相对工作目录 | `['internal/export/runner.go']` |
| `status` | `TaskStatus` | 否 | 和这条进展同时切到的状态 | `review` |
| `actor_name` | `string` | 是 | `claude-code` 或界面上的「我」 | `claude-code` |
| `session_id` | `string` | 否 | Claude Code 的会话 id；界面操作没有 | `b18f5d03-92c4-4a7e-8d61-0f3a9e27c5b4` |
| `source` | `'agent' \| 'ui'` | 是 | 谁写的 | `agent` |
| `at` | `string` | 是 | ISO 时间（接口里是 `created_at`） | |

`TaskArtifact`（`taskdata.ts`，对应接口的 `Artifact`）：`id`、`task_id`（接口里是 `object_id`）、`note: string`（种类标记加备注）、`url?: string`、`path?: string`（绝对路径；本地的 commit / branch 填仓库目录）、`rel_path?: string`、`source: 'manual' | 'agent' | 'run' | 'mcp'`、`at`。`ArtifactKind`：`'commit' | 'branch' | 'pr' | 'file'`，分组和显示名 `ARTIFACT_GROUPS`；`parseArtifact(note)` 返回 `{ kind, sha?, branch?, repo?, text }`。

`TaskRun`（`taskdata.ts`，对应接口的 `TaskRun`）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 编号，如 `run_d1` |
| `task_id` | `string` | 是 | 哪条任务 |
| `status` | `'running' \| 'done' \| 'failed' \| 'cancelled'` | 是 | 按「有没有工具调用成功过」判定，不看 `exit_code` |
| `workdir` | `string` | 是 | 这次执行用的目录 |
| `allow_writes` | `boolean` | 是 | 是否允许写入 |
| `extra_prompt` | `string` | 是 | 附加说明，可以是空串 |
| `exit_code` | `number` | 否 | 结束后才有 |
| `error` | `string` | 否 | 失败原因；`done` 时是保留意见 |
| `session_id` | `string` | 是 | 这次执行的 Claude Code 会话 |
| `started_at` / `ended_at` | `string` | 是 / 否 | ISO 时间 |
| `events` | `RunEvent[]` | 是 | 已输出的事件 |
| `pending` | `RunEvent[]` | 是 | 原型模拟流式用：还没吐出来的事件，正式产品没有 |

`RunEvent`：`{ type: 'delta'; text }` / `{ type: 'tool'; id; name; detail }` / `{ type: 'tool_result'; id; ok; error? }`，对应 SSE 的 `delta` / `tool` / `tool_result`；`start`、`done`、`error` 事件在原型里体现为 `TaskRun` 的字段。`stepRun` 每次吐一个事件并在吐完时定状态；`runScript` 生成模拟的执行过程。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | Claude Code（MCP） | `pmw_claim_task`、`pmw_append_progress`、`pmw_record_artifact`、`pmw_submit_review` | 进展、产出物多出对应记录；提交验收后任务停在 `review`。原型用演示数据和 `SPEC-tasks-5.26` 模拟 | `docs/mcp.md` |
| 改动 | 任务列表、今日 | 验收通过 / 退回 | 状态变为 `done` / `todo`；今日「任务待验收」组少一条 | `SPEC-tasks-2`、`SPEC-today-1.4` |
| 进来 | 今日 | 「任务待验收」一条的「去验收」 | 在今日页上打开任务抽屉，顶部是等你验收栏 | `SPEC-today-1.25` |

## SPEC-tasks-6 交给 Claude Code

任务抽屉「开发」组右上的按钮和弹窗：把这条任务交给本机 Claude Code 执行。原型是 `devloop.tsx` 的 `RunDialog`，样式同快速新建会话（`quicksession.tsx`）。

### 截图

| 场景 | 步骤 | 亮 | 暗 |
|---|---|---|---|
| 弹窗（默认只读） | 打开 `T-015`，点「交给 Claude Code」 | ![](shots/tasks/交给_Claude_Code-1440-light.png) | ![](shots/tasks/交给_Claude_Code-1440-dark.png) |
| 允许写入的二次确认 | 勾选「允许写入」 | ![](shots/tasks/交给_Claude_Code_允许写入确认-1440-light.png) | ![](shots/tasks/交给_Claude_Code_允许写入确认-1440-dark.png) |

执行起来的样子见 `SPEC-tasks-5` 截图「执行中（流式）」。

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-6.1 | 抽屉「开发」组右上「交给 Claude Code」 | 点击 | 只在已存在的任务上出现（新建时没有）。打开弹窗，标题「交给 Claude Code」，旁边是任务编号和标题。同一任务已有运行中的执行时，按钮变成带绿灯的「查看运行中」，点击滚到那条执行记录 |
| SPEC-tasks-6.2 | 工作目录 | 输入 | 默认取抽屉里当前填的工作目录，没有时用所属项目的根目录；下面提示来源「任务上设的」/「继承自所属项目」/「这次执行用的目录」。为空提示「选一个工作目录，任务和所属项目都没设」，不是绝对路径提示「要写本机绝对路径」，「开始执行」不可用。原型只校验写法；正式产品用 `POST /api/agent/workdir/check` 即时校验 |
| SPEC-tasks-6.3 | 「允许写入」 | 勾选 | 默认不勾，下面说明「默认只读：只跑一遍看它打算怎么做，不改文件」。点勾选时先不勾上，弹出橙色确认：「允许写入后，Claude Code 可以不经确认直接改「目录」里的文件。其他需要权限的操作仍会被挡下，任何情况下都不会跳过权限确认。」，按钮「确认允许写入」「算了，只读」；确认后才勾上，说明变成「会以 acceptEdits 权限模式运行：可以直接改工作目录里的文件」。确认没答时「开始执行」不可用。取消勾选不用确认 |
| SPEC-tasks-6.4 | 附加说明 | 输入 | 可选，占位「可选：这次要特别注意的事，会接在任务内容后面发给 Claude Code」，作为 `extra_prompt`；执行输出第一句是「按附加说明：…」 |
| SPEC-tasks-6.5 | 「开始执行（只读）」/「开始执行（允许写入）」 | 点击 | 按钮文字随权限变。关闭弹窗，执行记录最上面多一条运行中的记录并展开，流式显示过程（`SPEC-tasks-5.14`）。允许写入时 Claude Code 先领取：进展多一条该会话的「领取」，状态改为进行中，负责人改为 Claude Code。只读时不领取、不改状态，写文件那一步被挡下（「只读运行，没有写入权限」），最后输出打算的改法 |
| SPEC-tasks-6.6 | 「取消」/ 右上关闭 / Esc / 点遮罩 | 点击 | 关闭弹窗，不执行 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-tasks-6.7 | 工作目录为空或不是绝对路径 | 输入框下红字提示原因，「开始执行」不可用 | 改目录 |
| SPEC-tasks-6.8 | 执行接口报错（`error` 事件或请求失败） | 原型未做。正式产品：流式区显示错误信息，执行记录照常刷新 | 重新执行 |
| SPEC-tasks-6.9 | 执行失败 | 执行记录显示「失败」和原因（演示数据 `T-016` 的那条：「npm run build 失败：Providers.tsx 类型错误」） | 重新执行 |

### 数据

请求体 `{ workdir?: string, extra_prompt?: string, allow_writes?: boolean }`（原型 `start(task, { workdir, allow_writes, extra_prompt })`）；`workdir` 省略时后端按任务、所属项目逐级继承；`allow_writes` 默认 `false`，为 `true` 时后端加 `--permission-mode acceptEdits`，任何情况下都不传 `--dangerously-skip-permissions`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 改动 | 任务抽屉 | 开始执行 / 执行结束 | 执行记录多一条；允许写入时进展多「领取」、状态改进行中；结束后 Claude Code 回写的进展、产出物出现在对应区块 | `SPEC-tasks-5` |
| 改动 | 任务列表、今日 | 允许写入的执行开始 | 状态改进行中，待验收的任务从今日「任务待验收」组里消失 | `SPEC-tasks-2`、`SPEC-today-1.4` |

## SPEC-tasks-7 定时任务列表

按规则到点自动做一件事：建一条任务、执行一个 SOP、或者让一个 Agent 去做。原型没有真的后台计时，「下次执行」按规则算出来展示。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![定时任务 1440 亮](shots/tasks/定时任务-1440-light.png) | ![定时任务 1440 暗](shots/tasks/定时任务-1440-dark.png) |
| 手机 375 | ![定时任务 375 亮](shots/tasks/定时任务-375-light.png) | ![定时任务 375 暗](shots/tasks/定时任务-375-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-7.1 | 页面标题 | 展示 | 面包屑「任务 /」「定时任务」，带总数；说明「到点自动建任务、执行 SOP，或者让 Agent 去做；它建的任务来源标为「定时」」 |
| SPEC-tasks-7.2 | 右上「新建定时任务」 | 点击 | 打开新建抽屉（`SPEC-tasks-8`） |
| SPEC-tasks-7.3 | 动作类型筛选（分段按钮） | 点击 | 全部 / 建一条任务 / 执行 SOP / 让 Agent 去做，各带条数 |
| SPEC-tasks-7.4 | 搜索框 | 输入 | 按名称、规则文字、「做什么」文字匹配 |
| SPEC-tasks-7.5 | 列表行 | 展示 | 列：名称、什么时候（`describeRule`，如「每周一 09:00」「Cron：0 18 * * 1」）、做什么（动作类型标签加 `actionText`）、下次执行（`whenText`：「今天 09:00」「明天 09:00」「周三 18:00」「11-15 09:00」，算不出时「不再执行」；停用的显示「已停用」）、上次（「N 天前」，失败的红字加「失败」，悬停显示结果；没执行过「还没执行过」）、启用开关。启用的按下次执行时间排，近的在前 |
| SPEC-tasks-7.6 | 列表行 | 点击 | 打开该定时任务的抽屉，当前行高亮 |
| SPEC-tasks-7.7 | 行尾启用开关 | 切换 | 立刻启用或停用，不打开抽屉；停用的移到底部「已停用」段 |
| SPEC-tasks-7.8 | 「已停用」分段 | 点击 | 停用的沉到底部，默认收起，标题带条数；有搜索词时自动展开，免得命中的藏在收起的段里 |
| SPEC-tasks-7.9 | 手机宽度 | 展示 | 正文宽度不到 760px 时隐藏什么时候、做什么、上次三列，只留名称、下次执行、启用 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-tasks-7.10 | 还没有定时任务 | 不显示筛选栏；「还没有定时任务」，下面「比如每周一 9 点建一条「整理周会议程」，或者每周五让周报助手写周报」 | 「新建定时任务」 |
| SPEC-tasks-7.11 | 筛选后没有结果 | 「没有匹配的定时任务」，下面「换个筛选条件试试」 | 改筛选 |
| SPEC-tasks-7.12 | 动作指向的 SOP、Agent 已删除 | 「做什么」显示「执行「已删除的 SOP」」「已删除的 Agent：…」 | 打开抽屉改 |
| SPEC-tasks-7.13 | 上次执行失败 | 「上次」列红字「N 天前 失败」 | 打开抽屉看执行记录 |
| SPEC-tasks-7.14 | 加载失败、启停失败 | 原型未做。正式产品：列表显示错误和「重试」；启停失败时开关弹回原状并提示 | 重试 |

### 数据

见 `SPEC-tasks-0` `Schedule`、`ScheduleRule`、`ScheduleAction`、`ScheduleRun`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 改动 | 今日 | 启停、改规则 | 「今天还会自动执行」同步 | `SPEC-today-1.12` |

## SPEC-tasks-8 定时任务抽屉

配「什么时候」和「做什么」，下面是执行记录。

### 截图

| 亮 | 暗 |
|---|---|
| ![定时任务抽屉 1440 亮](shots/tasks/定时任务抽屉-1440-light.png) | ![定时任务抽屉 1440 暗](shots/tasks/定时任务抽屉-1440-dark.png) |

上面是「周会前整理议程」（建任务类）滚到执行记录，由 `shots.py` 按步骤截。其余几种：「周五写周报」（Agent 类）、「周会纪要」（SOP 类、Cron 规则）；新建：右上「新建定时任务」。

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-8.1 | kicker / 关闭 / Esc | 展示、点击 | 新建时「新建定时任务」，否则「定时任务」；关闭不保存 |
| SPEC-tasks-8.2 | 名称（必填） | 输入 | 新建时获得焦点，占位「比如：周会前整理议程」 |
| SPEC-tasks-8.3 | 「什么时候」频率 | 点击 | 一次 / 每天 / 工作日 / 每周 / 每月 / Cron 表达式；新建默认每周一 09:00 |
| SPEC-tasks-8.4 | 每周：周几 | 点击 | 一到日 7 个按钮，可多选 |
| SPEC-tasks-8.5 | 日期 / 几号 / 时间 / Cron | 输入 | 一次：日期；每月：几号（1 到 31，「31（小月按月底）」）；Cron：表达式（提示「分 时 日 月 周」）；其余：时间 |
| SPEC-tasks-8.6 | 规则预览 | 展示 | 规则有效时显示「规则描述，接下来：」加接下来三次执行（`whenText`）；不会再执行时「不会再执行」 |
| SPEC-tasks-8.7 | 「做什么」动作类型 | 点击 | 建一条任务 / 执行 SOP / 让 Agent 去做；切换时清空该动作的字段，SOP 默认选第一个，Agent 默认选第一个启用的 |
| SPEC-tasks-8.8 | 建一条任务 | 输入 | 任务标题（必填，提示可以写 `{{date}}`）、描述、优先级（默认取枚举默认值）、负责人（候选同任务抽屉）、截止（当天 / N 天后） |
| SPEC-tasks-8.9 | 执行 SOP | 选择 | 可搜索选 SOP；提示「用 SOP 输入字段的默认值执行；流程里的人工检查点照常停下等你」 |
| SPEC-tasks-8.10 | 让 Agent 去做 | 选择、输入 | 可搜索选 Agent，停用的显示「已停用」且不能选；「要它做什么」必填；提示「执行结果在「会话 / 执行记录」里，写操作按 Agent 的权限等你确认」 |
| SPEC-tasks-8.11 | 启用开关 | 切换 | 启用时说明「下次：…」，停用时「停用后不会自动执行，可以手动执行」 |
| SPEC-tasks-8.12 | 执行记录 | 展示、点击 | 只在查看已有定时任务时出现，标题带次数；每条：成功绿点 / 失败红点、结果文字、手动执行的带「手动」标签、相对时间。新的在前。建了任务的那条，任务编号（`ref`）是链接，点开那条任务的抽屉；任务已删时只显示文字 |
| SPEC-tasks-8.13 | 「立即执行一次」 | 点击 | 按抽屉里当前的配置（未保存的也算）马上跑一次，不影响下次执行时间：建任务类建出一条来源为「定时」的任务（标题里的 `{{date}}` 换成当天日期），记「建了任务 T-xxx」；SOP 类发起一次执行，记「发起了「SOP 名」」；Agent 类在会话执行记录里加一条，记「交给了 Agent 名，结果在「会话 / 执行记录」」。结果写进执行记录并标「手动」。配置有错时按钮不可用 |
| SPEC-tasks-8.14 | 「创建」/「保存」 | 点击 | 校验通过后保存，抽屉切到这条定时任务的查看状态 |
| SPEC-tasks-8.15 | 「删除」 | 点击 | 底栏换成确认「删除后不再执行，已经建出来的任务保留」，「取消」/「删除」 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-tasks-8.16 | 规则有误 | 预览位置显示红字错误（见 `SPEC-tasks-0` `ruleError` 的五种文案） | 改规则 |
| SPEC-tasks-8.17 | 名称、动作必填项为空就保存 | 底栏显示第一条错误：「名称必填」、规则错误、「任务标题必填」/「选一个 SOP」/「选一个 Agent」/「写一下要它做什么」；对应输入框标红；不关闭抽屉 | 补全 |
| SPEC-tasks-8.18 | 还没执行过 | 执行记录区「还没执行过」 | 「立即执行一次」 |
| SPEC-tasks-8.19 | 立即执行时 SOP 已删 / Agent 停用或已删 | 记一条失败：「没执行：SOP 已删除」「没执行：Agent 名 已停用」「没执行：Agent 已删除」 | 改动作 |
| SPEC-tasks-8.20 | 定时任务已停用时到点 | 记一条失败「没执行：已停用」。原型没有后台计时，只有演示数据「机柜合同续签提醒」里有这条记录；正式产品由调度（TASK-03）写 | 启用 |
| SPEC-tasks-8.21 | 保存或执行请求失败 | 原型未做。正式产品：底栏显示失败原因，抽屉保持打开 | 重试 |

### 数据

见 `SPEC-tasks-0` `Schedule` 等。新建时 `id` 由 `newId('sc')` 生成（正式产品由后端生成，CORE-11）。执行记录正式产品用独立的定时任务执行记录表（`docs/dev-decisions.md` TASK-03 决策），不复用 runs。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 改动 | 任务 | 建任务类执行 | 任务列表、「定时」来源视图多一条 | `SPEC-tasks-3` |
| 改动 | SOP | SOP 类执行 | SOP 多一次执行 | `SPEC-sop` |
| 改动 | 会话 | Agent 类执行 | 会话 / 执行记录多一条 | `SPEC-sessions` |
| 进来 | 任务抽屉 | 定时来源的「查看规则」 | 打开本抽屉 | `SPEC-tasks-4.7` |

## SPEC-tasks-9 Webhook 接入

Webhook 列表。外部系统往接收地址 POST 一段 JSON，按映射规则自动建任务。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![Webhook 接入 1440 亮](shots/tasks/Webhook_接入-1440-light.png) | ![Webhook 接入 1440 暗](shots/tasks/Webhook_接入-1440-dark.png) |
| 手机 375 | ![Webhook 接入 375 亮](shots/tasks/Webhook_接入-375-light.png) | ![Webhook 接入 375 暗](shots/tasks/Webhook_接入-375-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-9.1 | 页面标题 | 展示 | 「任务 /」「Webhook 接入」，带总数；说明「外部系统往接收地址 POST 一段 JSON，按映射规则自动建任务；最近推送失败的排在前面」 |
| SPEC-tasks-9.2 | 右上「新建 Webhook」 | 点击 | 打开新建 Webhook 页（`SPEC-tasks-10`） |
| SPEC-tasks-9.3 | 筛选（分段按钮） | 点击 | 全部 / 最近失败 / 已停用，各带条数；拿不到推送记录时不显示「最近失败」 |
| SPEC-tasks-9.4 | 搜索框 | 输入 | 按名称、地址（token）匹配 |
| SPEC-tasks-9.5 | 列表行 | 展示 | 列：名称（空时「未命名」）、接收地址（「…/token」，悬停显示完整地址）、最近推送（结果标签加说明：已建任务显示「编号 标题」，其余显示原因；没有推送「还没收到推送」）、推送时间（失败的红字）、建了任务（「N 条 / M 次」，悬停「推送 M 次，建了 N 条任务」）、启用（「启用」/「停用」文字）。排序：最近失败的在前，其次启用的，再按最近推送时间，最后按名称 |
| SPEC-tasks-9.6 | 列表行 | 点击 | 打开该 Webhook 的配置页 |
| SPEC-tasks-9.7 | 手机宽度 | 展示 | 正文宽度不到 760px 时隐藏接收地址、最近推送、建了任务三列 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-tasks-9.8 | 还没有 Webhook | 「还没有 Webhook」，下面「建一个 Webhook，把接收地址填到 Sentry、表单、工单系统里，推过来的事件自动变成任务」 | 「新建 Webhook」 |
| SPEC-tasks-9.9 | 筛选后没有结果 | 「没有匹配的 Webhook」，下面「换个筛选条件试试」 | 改筛选 |
| SPEC-tasks-9.10 | 拿不到推送记录 | 推送相关的列显示「-」，不当成「没收到推送」；「建了任务」只显示条数 | 无 |
| SPEC-tasks-9.11 | 加载失败 | 原型未做。正式产品：列表显示错误和「重试」 | 重试 |

### 数据

见 `SPEC-tasks-0` `Webhook`、`Delivery`。页面内部类型 `HookFilter = '' | 'failed' | 'off'`；「最近失败」= 最近一条投递 `result = failed`。结果标签 `RESULT`：`created` 已建任务 `#2f7d43` / `skipped` 已忽略 `#a19d92` / `failed` 失败 `#c0352b`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 改动 | 二级菜单 | 最近一次推送失败 | 「Webhook 接入」和「最近推送」里亮红点 | `SPEC-tasks-1.7`、`1.8` |

## SPEC-tasks-10 Webhook 配置页

一个 Webhook 的配置和推送记录；新建也用这一页（`hook:new`）。宽屏左右两栏：左接收地址、字段映射、过滤与去重，右测试推送、推送记录；底部固定一栏放删除和保存。

### 截图

Sentry 线上告警（最近有忽略和建任务的推送）：

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![Sentry 1440 亮](shots/tasks/Sentry_线上告警-1440-light.png) | ![Sentry 1440 暗](shots/tasks/Sentry_线上告警-1440-dark.png) |
| 手机 375 | ![Sentry 375 亮](shots/tasks/Sentry_线上告警-375-light.png) | ![Sentry 375 暗](shots/tasks/Sentry_线上告警-375-dark.png) |

官网需求表单（最近一次推送失败）：

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![官网需求表单 1440 亮](shots/tasks/官网需求表单-1440-light.png) | ![官网需求表单 1440 暗](shots/tasks/官网需求表单-1440-dark.png) |
| 手机 375 | ![官网需求表单 375 亮](shots/tasks/官网需求表单-375-light.png) | ![官网需求表单 375 暗](shots/tasks/官网需求表单-375-dark.png) |

新建 Webhook 页截图脚本不截：二级菜单底部或 Webhook 列表右上点「新建 Webhook」。

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-tasks-10.1 | 页面标题 | 展示 | 面包屑「Webhook /」加名称（空时「未命名」，新建时「新建 Webhook」）；说明「外部系统往接收地址 POST 一段 JSON，按映射规则自动建任务」 |
| SPEC-tasks-10.2 | 右上启用开关 | 切换 | 只在已有 Webhook 上出现，显示「已启用」/「已停用」；改完要点保存才生效 |
| SPEC-tasks-10.3 | 名称（必填） | 输入 | 占位「比如：Sentry 线上告警」 |
| SPEC-tasks-10.4 | 接收地址「复制」 | 点击 | 复制完整地址（`https://pmw.local/hooks/<token>`），按钮变「已复制」1.5 秒 |
| SPEC-tasks-10.5 | Secret「显示」/「隐藏」、「复制」 | 点击 | 默认只露前 6 位加圆点；复制同上。说明「请求头 X-PMW-Signature 带上用 Secret 算的签名，签名不对的推送直接拒收，不进推送记录。」 |
| SPEC-tasks-10.6 | 「curl 示例」 | 展开 | 一段带地址、签名头和当前测试推送内容的 curl 命令 |
| SPEC-tasks-10.7 | 字段映射（标题、描述、优先级、负责人、截止日期） | 输入 | 每行填推送 JSON 的路径；右侧用测试推送的 JSON 实时算出取到的值，取不到显示「取不到值」，没填显示「-」。占位：标题「必填」，优先级「留空用默认 <默认优先级>」，负责人「留空用默认 <默认负责人>」（没有默认负责人时「未分配」），其余「留空不取」 |
| SPEC-tasks-10.8 | 默认优先级、默认负责人 | 选择、输入 | 映射取不到时用 |
| SPEC-tasks-10.9 | 优先级换算说明 | 展示 | 「优先级取到 fatal / critical / 紧急 记为 P0，error / high / 高 记为 P1，warning / 中 记为 P2，info / low / 低 记为 P3。」`p0` 到 `p3` 直接对上，其余用默认 |
| SPEC-tasks-10.10 | 过滤条件 | 输入 | 占位「action == created」；填了且测试推送是合法 JSON 时，下面实时显示「示例推送：满足，会建任务」或不满足的原因（橙字） |
| SPEC-tasks-10.11 | 去重字段 | 输入 | 占位「event.id」；填了时下面显示「示例推送取到：…」 |
| SPEC-tasks-10.12 | 测试推送 JSON | 输入 | 默认是 Webhook 的示例；JSON 不合法时框标红、下面显示「JSON 格式不对：…」或「推送内容要是一个 JSON 对象」 |
| SPEC-tasks-10.13 | 「发送测试推送」 | 点击 | 用页面上当前的配置（未保存的也算）处理一次推送，会真的建任务并记进推送记录；旁边显示结果标签，建了任务时是可点的「编号 标题」（打开任务抽屉），否则是原因。新建时不可用，提示「先保存再测试」；JSON 不合法时不可用 |
| SPEC-tasks-10.14 | 推送记录 | 展示、点击 | 标题带次数，新的在前，先露 20 条；每条：结果标签、说明（已建任务「编号 标题」，否则原因）、相对时间。点一条展开：原因、映射出来的各字段（空的显示「空」）、原始 JSON、「打开任务 T-xxx」（有任务时）、「拿来当测试推送」（把这条的 JSON 填进测试框）。末尾「更早的 N 条」展开全部 |
| SPEC-tasks-10.15 | 测试推送失败 | 结果 | 除了在推送记录里记失败，还会上报一条 warn 级运行异常「Webhook 名：推送没建成任务」，带推送内容，进「设置 / 运行异常」 |
| SPEC-tasks-10.16 | 底栏「保存修改」/「创建 Webhook」 | 点击 | 没有改动时按钮显示「已保存」且不可用；新建后切到这个 Webhook 的配置页 |
| SPEC-tasks-10.17 | 底栏「取消」 | 点击 | 只在新建时出现，回到 Webhook 列表 |
| SPEC-tasks-10.18 | 底栏「删除 Webhook」 | 点击 | 底栏换成确认「删除后这个地址不再接收推送，已建的任务保留」，「取消」/「删除」；删完回到 Webhook 列表 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-tasks-10.19 | 还没收到推送 | 推送记录区「还没有收到推送」 | 「发送测试推送」 |
| SPEC-tasks-10.20 | 名称或标题映射为空就保存 | 底栏红字「还没有名称」或「标题映射必填」，对应输入框标红 | 补全 |
| SPEC-tasks-10.21 | 标题映射取不到值 | 映射预览显示「取不到值」；真推送时记 `failed`「标题路径 … 取不到值」 | 改映射 |
| SPEC-tasks-10.22 | 签名不对的推送 | 直接拒收，不进推送记录（原型只有说明，没有模拟） | 无 |
| SPEC-tasks-10.23 | 打开的 Webhook 已被删除 | 原型会当成新建页显示。正式产品：显示「这个 Webhook 已删除」，回到列表 | 回到列表 |
| SPEC-tasks-10.24 | 保存或测试请求失败 | 原型未做。正式产品：底栏或结果位置显示失败原因，输入不丢 | 重试 |

### 数据

见 `SPEC-tasks-0` `Webhook`、`Delivery`、`Ingest`。新建 Webhook 的默认值（`newHook`）：随机 `token`、`secret`（`whsec_` 开头），启用，映射 `title` / `description` / `priority`，默认优先级 P2、负责人「我」，示例 JSON「示例：客户要求导出支持 Excel」。接收地址前缀 `HOOK_BASE = https://pmw.local/hooks/`；字段名显示 `FIELD_LABEL`：标题、描述、优先级、负责人、截止日期。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 改动 | 任务 | 测试推送或真实推送建了任务 | 任务列表、「Webhook」来源视图多一条，来源标签「Webhook · 名称」 | `SPEC-tasks-3` |
| 改动 | 设置 / 运行异常 | 测试推送失败 | 多一条或累加一条运行异常 | `SPEC-settings` |
| 出去 | 任务抽屉 | 点结果里的任务、「打开任务」 | 打开任务抽屉 | `SPEC-tasks-4` |
| 进来 | 任务抽屉 | Webhook 来源的「查看配置」 | 打开本页 | `SPEC-tasks-4.5` |

## 和原型对不上的地方

整理时发现、还没改的，另开原型修错任务（或先确认规格），不在本规格里顺手改原型。

1. **列表分段口径和 DEV-07a 不一致**：原型按截止日分段（逾期 / 今天 / 本周 / 以后 / 无截止 / 已结束），状态只是上方的筛选按钮；DEV-07a 的要求写的是「按状态分段」「review 状态的任务在「待验收」分段里」「某个状态超过 30 条时出现「这一段还有 N 条」」。原型是规格，本节按原型写（`SPEC-tasks-2.3`、`2.6`、`2.12`）；需要主会话决定是改 DEV-07a 的验收（改成「状态筛选里有待验收、按截止分段」），还是改原型改成按状态分段。
2. ~~演示数据里没有待验收的任务~~：PROTO-07 已补 `T-015`、`T-017`（待验收）和 `T-016`（进行中）。
3. ~~列表的完成圆圈能跳过验收~~：PROTO-07 已改，列表和今日先弹确认、确认后等于验收通过（`SPEC-tasks-5.27`，决策见 `docs/dev-decisions.md`）；项目的任务标签里点圆圈改为打开任务抽屉（那个组件在 `projecttabs.tsx`，没加确认弹窗）。
4. ~~状态筛选没有结果时文案不对~~：PROTO-08 已修（`SPEC-tasks-2.19`）。原文：只切到「待验收」等状态筛选、结果为空时，显示的是「这里还没有任务 / 点右上角新建一个」，看起来像模块里一条任务都没有（`SPEC-tasks-2.19`）。
5. ~~定时、运行异常来源视图的空状态文案~~：PROTO-08 已修（`SPEC-tasks-3.7`）。原文：显示「点右上角新建一个」，但在这里新建的是人工任务，不会出现在当前视图（`SPEC-tasks-3.7`）。应改成「定时任务到点会建在这里」「在「设置 / 运行异常」里转任务」。
6. ~~任务抽屉关闭时不提示未保存的改动~~：PROTO-08 已修（`SPEC-tasks-4.23`）。原文：Esc、关闭按钮、取消都直接丢弃（`SPEC-tasks-4.23`）；DEV-07b 要求有未保存改动时先确认。
7. ~~开发闭环区块和「交给 Claude Code」原型没有~~：PROTO-07 已补，两节已按原型修订。原型仍没有的：单独的改动区（`SPEC-tasks-5.18`）、进行中自动刷新（`5.3`）、工作目录的真实校验（`6.2`）。
8. ~~「今天」按 UTC 取~~：PROTO-08 已修，统一用 `taskdata.ts` 的 `localDay()`。原文：`tasks.tsx` 的 `today()` 和 `today.tsx` 一样用 `toISOString().slice(0, 10)`，东八区 0 点到 8 点之间逾期、今天、本周分段会错一天。正式产品按本地日期。
9. ~~定时任务执行记录的 `ref` 没用上~~：PROTO-08 已修（`SPEC-tasks-8.12`）。原文：`ScheduleRun.ref` 记了建出的任务编号，但抽屉里的执行记录只是文字，不能点开那条任务。建议做成链接。
10. **截图压缩的残影（不是原型问题）**：`Sentry_线上告警-1440-*.png` 底部「删除 Webhook」后面有一块白色不规则残影。用原色截图核对过，原型的底栏是半透明叠在内容上，残影是压成 256 色造成的，原型不用改；以后截图脚本可以考虑对这类半透明区域保留原色。
11. **退回到哪个状态，PROTO-07 的任务说明和 DEV-08d 不一致**：PROTO-07 写「退回后状态回到进行中」，DEV-08d、状态流转图和接口契约的领取规则都是回到待办。原型按 DEV-08d 做（`SPEC-tasks-5.23`），PROTO-07 的说明是笔误。
12. ~~手机宽度下抽屉比屏幕宽~~：PROTO-08 已修，手机断点的规则带上 `.shell > .drawer`。原文：`styles.css` 里 `.shell > .drawer { width: var(--drawer-w) }` 的优先级高于手机断点里的 `.drawer { width: min(var(--drawer-w), 100%) }`，375 宽时抽屉仍是 520px，左边一截在屏幕外。所有抽屉都这样，不是开发闭环新加的；`SPEC-tasks-5` 因此没截手机图。建议并进 PROTO-08。
13. ~~截图脚本不截抽屉~~：PROTO-08 已修，`shots.py` 的 `STEPS` 按步骤截抽屉和弹窗。原文：`SPEC-tasks-5`、`SPEC-tasks-6` 的截图是另外截的，`shots.py --only tasks` 重跑会把它们删掉。建议 `shots.py` 支持按步骤截抽屉，或者对 `抽屉_` 前缀的文件不删。
