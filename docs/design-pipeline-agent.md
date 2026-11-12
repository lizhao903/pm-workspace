# 可落地方案：多工作区 + 万级检索 + 固定流水线 + Agent 双轨执行

2026-09-15 · 依据用户三项决策：① Agent 多渠道执行（平台内自建队列，外部工具执行只监控结果）② 量级按万级、需持续输出更新需求 ③ 预留多工作区、把流程做成可固定持续执行的流水线

---

## 一、三项决策的落地含义

| 决策 | 落地形态 | 关键设计要求 |
|---|---|---|
| Agent 多渠道执行 | **双轨**：`local` 由平台自建队列真实执行；`external` 由其他平台工具执行，平台只接收上报并监控 | 两轨共用同一套任务单与运行视图，用 `executor_kind` 区分；外部轨必须有上报协议与心跳 |
| 万级量级 | 检索换索引、列表换游标分页、计数与度量预聚合、修订瘦身 | 所有列表查询必须走索引；度量不实时扫 `revisions` |
| 固定流水线持续执行 | **流水线（pipeline）= 触发器 + 作用域 + 有序步骤**，取代原"调度器"概念 | 调度器不再是独立模块，它就是流水线的 `cron` 触发器 —— 避免做两套 |
| 预留多工作区 | `workspaces` 表 + 全部业务表加 `workspace_id` + 唯一索引重建 | **必须最先做**：`objects.ref` 与 `tags.name` 是行内 UNIQUE 约束，事后改要重建表 |

一句话：**流水线是骨架，Agent 是执行器，多工作区是寻址维度，万级适配是底线。**

---

## 二、多工作区（阶段 0，必须先做）

### 2.1 新表

```sql
CREATE TABLE workspaces (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  root_workdir TEXT NOT NULL DEFAULT '',   -- 该工作区的默认产物根目录
  color        TEXT NOT NULL DEFAULT '',
  archived_at  TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

### 2.2 加列与索引重建

加 `workspace_id TEXT NOT NULL DEFAULT 'ws_default'` 的表：
`objects`、`categories`、`tags`、`shortcuts`、`shortcut_groups`、`views`、`agent_sessions`、`agent_tasks`、`task_runs`、`agents`、`task_templates`、`pipelines`、`metrics_daily`、`counts_cache`

**保持全局（不隔离）**：`agent_providers`（模型接入点是基础设施，跨工作区共用）、`dictionaries` 的 `global` 作用域字典（`scope='type'` 的字典按工作区隔离）。

唯一约束的重建清单（这是本阶段唯一有风险的部分）：

| 现有约束 | 性质 | 处理 |
|---|---|---|
| `objects.ref TEXT NOT NULL UNIQUE` | **行内约束** | 需重建表（SQLite 12 步流程） |
| `tags.name TEXT NOT NULL UNIQUE` | **行内约束** | 需重建表 |
| `idx_categories_slug(type_id, IFNULL(parent_id,''), slug)` | 独立索引 | drop + create，加 `workspace_id` |
| `ref_counters(type_id)` 主键 | 独立 | 重建为 `(workspace_id, type_id)` |
| `idx_dict_items_key(dict_id, IFNULL(type_id,''), key)` | 独立索引 | 视字典作用域决定是否加 `workspace_id` |

新的唯一约束一律带上 `workspace_id`：`(workspace_id, ref)`、`(workspace_id, name)`、`(workspace_id, type_id, IFNULL(parent_id,''), slug)`。

**实施纪律**：
1. 先在 `data/pm.db` 的副本上演练迁移，确认行数与索引齐备后再对线上跑。
2. 迁移写成幂等（`IF NOT EXISTS` / 先查 `pragma table_info`），失败可重跑。
3. 迁移前强制打一次快照（`VACUUM INTO`）。
4. 现有 81 个对象全部落 `ws_default`，并自动创建名为「默认工作区」的一行。

### 2.3 影响面

- 所有 store 查询条件加 `workspace_id`（写路径已集中在 `internal/store/sqlite`，改动点集中）。
- API 层：工作区从请求上下文取（先支持 `X-Workspace` 头或 query 参数，缺省 `ws_default`），不做权限校验（用户已明确后置）。
- 前端：顶栏"工作区"占位切换器（线框稿里已有此位置）。
- `owner_id`：本阶段只加列（`TEXT NOT NULL DEFAULT ''`）+ 不回填，功能层不做权限。事后补是重构，现在补是零成本。

---

## 三、万级适配

### 3.1 检索：FTS5 + CJK bigram 预处理（推荐）

**先说为什么不能直接用现有方案**：`LIKE` 全表扫描，万级下单次查询秒级；且实测多词查询必然归零（「权限 分权」0 命中）。

**再说为什么不用 trigram**：FTS5 的 `trigram` 分词器对**少于 3 字符的查询无法走索引，会退化为全表扫描**。而中文最常用的查询恰恰是两字词（「权限」「支付」「企业」）——trigram 在这里等于没用。

**推荐方案：FTS5(unicode61) + Go 侧 bigram 预处理列**

```sql
CREATE VIRTUAL TABLE objects_fts USING fts5(
  search_text,                    -- 由 Go 侧生成的 bigram 串
  content='objects', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 0'
);
```

Go 侧生成规则：
- 连续 CJK 段落 → 2 字滑窗切分，空格连接：`权限分权` → `权限 限分 分权`
- ASCII 段（`Stripe`、`REQ-0045`）→ 原样小写，不做 bigram
- 结果拼成 `search_text` 写入（title + body + tags + ref 合并后处理）

查询侧：
- 用户输入按空格/标点切分 → 每段生成对应的 bigram → 组成 `"权限" AND "分权"` 形式
- 2 字查询（「权限」）生成 1 个 bigram，能命中；多词查询变成多 bigram 的 AND，能命中
- 结果按 FTS5 rank 排序，命中片段做高亮

**代价与取舍**：`search_text` 约占原文 2 倍字符量，万级按每对象 300 字估算 ≈ 6 MB 索引，可接受；写入路径集中在 store 层，bigram 生成只写一处。相对地，换来的是零 C 扩展依赖、对中文所有 ≥2 字查询均有效。

同步：`objects` 的 insert/update/delete 三个触发器同步 `objects_fts`；`store` 层写入后不需要额外动作。

### 3.2 列表：keyset 游标分页

- 废弃 `offset`（万级下深翻页会退化），改 `(sort_key, id)` 游标，`limit` 50。
- 需要覆盖索引，按排序键各建一条，例如：
  `(workspace_id, type_id, archived_at, deleted_at, updated_at DESC, id DESC)`
- 排序键集合不变（`updated_at` / `created_at` / `due_at` / `priority` / `title`），每条配一个复合索引。
- 前端列表改虚拟滚动，NDJSON/游标增量加载取代"已加载 N 条"。

### 3.3 计数与度量：预聚合，不实时扫

现状 `/api/counts` 每次打开侧栏跑十几次 COUNT，万级下会明显变慢。

```sql
CREATE TABLE counts_cache (
  workspace_id TEXT NOT NULL, key TEXT NOT NULL,
  value INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
```
在 store 写路径增量更新（新建/删除/状态变更/归档时改对应 key），不做定时全量重算。

```sql
CREATE TABLE metrics_daily (
  workspace_id TEXT NOT NULL, day TEXT NOT NULL, type_id TEXT NOT NULL,
  created INTEGER DEFAULT 0, completed INTEGER DEFAULT 0, reopened INTEGER DEFAULT 0,
  overdue INTEGER DEFAULT 0, stalled INTEGER DEFAULT 0,
  avg_cycle_hours REAL, avg_wip REAL,
  PRIMARY KEY (workspace_id, day, type_id)
);
```
由一条 `metrics` 流水线每日写入。度量看板只读此表，永不实时扫 `revisions`。

### 3.4 修订瘦身（万级下 `revisions` 是最大增长源）

- **正文变更不存全文**：`body` 字段的修订只记 `old_len`/`new_len`/`sha256` 前 16 位 + 前 200 字符摘要。当前实现存完整 old/new 值，持续编辑下会爆量。
- 索引补 `(workspace_id, object_id, created_at DESC, id DESC)` 与 `(workspace_id, created_at DESC, id DESC)`。
- 保留策略：`revisions` 超过 180 天且已汇总进 `metrics_daily` 的行可清理（做成一条可配置的流水线步骤，默认关闭）。

### 3.5 归档与默认可见集

- 复用已有 `archived_at`：所有默认列表查询排除 `archived_at IS NOT NULL` 与 `deleted_at IS NOT NULL`，并让索引覆盖这两个条件。
- 终态对象（`done` / `dropped`）超过 N 天自动归档 —— 由流水线执行，避免活跃集随年份无限膨胀。

---

## 四、固定流水线（新增核心抽象）

### 4.1 模型

一条流水线 = **触发器** + **作用域** + **有序步骤**。它取代原"调度器"，即：定时任务是流水线的一种触发器，不是独立模块。

### 4.2 表结构

```sql
CREATE TABLE pipelines (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  trigger_kind  TEXT NOT NULL,          -- cron | scan | manual
  cron          TEXT NOT NULL DEFAULT '',    -- trigger_kind=cron，如 '0 9 * * *'
  scan_interval INTEGER NOT NULL DEFAULT 0,  -- trigger_kind=scan，秒
  scope         TEXT NOT NULL DEFAULT '{}',  -- JSON，复用 ObjectFilter 结构
  concurrency   INTEGER NOT NULL DEFAULT 1,
  last_run_at   TEXT, next_run_at TEXT,
  created_at    TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE pipeline_stages (
  id           TEXT PRIMARY KEY,
  pipeline_id  TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,           -- 见 4.3
  config       TEXT NOT NULL DEFAULT '{}',
  condition    TEXT NOT NULL DEFAULT '',-- JSON 表达式，为空即总是执行
  on_error     TEXT NOT NULL DEFAULT 'stop',  -- stop | continue | retry
  max_attempts INTEGER NOT NULL DEFAULT 1,
  UNIQUE (pipeline_id, seq)
);

CREATE TABLE pipeline_runs (
  id           TEXT PRIMARY KEY,
  pipeline_id  TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  trigger_kind TEXT NOT NULL, triggered_by TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,           -- running | succeeded | partial | failed
  scanned      INTEGER DEFAULT 0, matched INTEGER DEFAULT 0,
  succeeded    INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0,
  started_at   TEXT NOT NULL, finished_at TEXT, error TEXT
);

CREATE TABLE pipeline_run_items (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  object_id  TEXT NOT NULL,
  stage_seq  INTEGER NOT NULL,
  status     TEXT NOT NULL,             -- ok | failed | skipped
  attempts   INTEGER NOT NULL DEFAULT 1,
  message    TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pri_run ON pipeline_run_items(run_id, object_id, stage_seq);

-- 幂等锚：同一流水线对同一对象同一 stage，只在「输入版本」变化时才重新处理
CREATE TABLE pipeline_marks (
  pipeline_id  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  stage_seq    INTEGER NOT NULL,
  input_version TEXT NOT NULL,          -- 对象的 updated_at + 关键字段 hash
  processed_at TEXT NOT NULL,
  PRIMARY KEY (pipeline_id, object_id, stage_seq)
);
```

**`pipeline_marks` 是整个"固定流水线可持续执行"的关键**：没有它，每轮扫描都会重复派单、重复通知；有了它，只有对象真的变了才重新走流程。

### 4.3 步骤类型（必须可配置，不写代码）

| kind | 作用 | 关键 config |
|---|---|---|
| `assign` | 改字段（分类/负责人/优先级/到期/状态） | 字段名、取值或取值表达式 |
| `agent_run` | 派单给指定 Agent + 模板 | agent_id、template_id、workdir 继承策略 |
| `notify` | 推送 | 通道（desktop/im）、消息模板（含变量） |
| `create_object` | 按模板建对象 | type_id、字段映射、与源对象的关联关系 |
| `link` | 建关联 | relation、目标对象 |
| `dedupe` | 相似度判定 + 建议合并 | 阈值、字段范围 |
| `summarize` | LLM 汇总成报告 | 模板、产出对象类型 |
| `wait` | 等人工确认 / 等条件 | 超时、确认方式 |
| `snapshot` | 数据库快照 + 轮转 | 保留份数 |
| `export` | 导出 | 格式、落盘路径 |

### 4.4 触发器：先做扫描驱动，不做事件驱动

- `scan`：每 N 秒按 `scope` 查一次（`WHERE` 必带 `updated_at` 或 `status` 条件 → 走索引），配合 `pipeline_marks` 判断是否需要处理。
- `cron`：固定时刻跑（日报、快照、归档）。
- `manual`：界面上一键跑。

**为什么不做事件驱动**：事件需要 hook 到所有写路径，漏挂一处就静默失效，而这类失效没有报错、只有"某条没被处理"；扫描驱动一致性好、实现简单，万级下每次扫描走索引成本可控。等某条流水线确实需要低延迟再单独优化。

### 4.5 首批七条流水线（直接落地"持续输出更新需求"）

| 流水线 | 触发 | 作用域 | 步骤 |
|---|---|---|---|
| Inbox 归位 | scan 10min | `status=inbox` | Agent 建议类型/分类/负责人/到期 → 等待确认 → 落字段 + 建关联 |
| 需求去重 | cron 每日 | 近 7 天新增 `requirement` | 相似度召回 → 命中则建 `duplicates` 关联并通知 |
| 需求结构化 | scan 5min | `requirement` 且正文 < 阈值 | Agent 补结构化正文与验收标准 → 落草稿待确认 |
| PRD 派单 | scan 15min | `status=planned` 且 `owner=我` | 派给 PRD Agent → 产出回流为 `doc` 对象 + 建 `references` |
| 每日跟踪 | cron 每日 09:00 | 逾期 / 停滞未终态 | 生成催办消息 → IM 推送 → 按需建跟进 task |
| 周报汇总 | cron 每周一 09:00 | 本周有变更的对象 | Agent 汇总 → 生成 `weekly` 文档对象 → 推送摘要 |
| 自动快照 | cron 每日 02:00 | 全库 | `snapshot` 并轮转保留 14 份 |

这七条同时解决了备份定时化、跟踪从零次变每天、需求持续结构化三个问题。

---

## 五、Agent 双轨执行

### 5.1 表结构

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                 -- builtin | cli | external
  provider_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',   -- builtin
  bin TEXT NOT NULL DEFAULT '', args TEXT NOT NULL DEFAULT '[]',          -- cli
  capability_types TEXT NOT NULL DEFAULT '[]',  -- JSON：可承接的对象类型
  capability_tags  TEXT NOT NULL DEFAULT '[]',
  default_workdir TEXT NOT NULL DEFAULT '',
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE task_templates (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  applies_to_types TEXT NOT NULL DEFAULT '[]',
  prompt TEXT NOT NULL,               -- 支持 {{title}} {{body}} {{ref}} {{tags}} {{today}}
  expect TEXT NOT NULL DEFAULT '{}',  -- JSON：预期产出（file|fields|report）
  default_agent_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', template_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',  -- 渲染后快照
  status TEXT NOT NULL,               -- queued|running|succeeded|failed|canceled|waiting_review|stalled
  priority INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT NOT NULL DEFAULT '[]',
  executor_kind TEXT NOT NULL,        -- local | external
  workdir TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT,
  result_summary TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT ''
);
-- 防重复派单：同一对象同一模板至多一个活跃任务
CREATE UNIQUE INDEX idx_agent_tasks_active
  ON agent_tasks(workspace_id, object_id, template_id)
  WHERE status IN ('queued','running','waiting_review');

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 1, executor_kind TEXT NOT NULL,
  status TEXT NOT NULL, pid INTEGER, heartbeat_at TEXT,
  started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER,
  output TEXT NOT NULL DEFAULT '', output_log_path TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_micro INTEGER DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE agent_steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, kind TEXT NOT NULL,   -- text | tool | tool_result | notice
  name TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
```

### 5.2 轨道一：平台内自建队列

- **worker pool**：全局 `max_concurrency` + 单 Agent `max_concurrency` 双重限制；按 `priority` 排序，同级轮转避免单一工作区饿死其他。
- **心跳租约（必须）**：`agent_runs.heartbeat_at` 每 10 秒更新。**工作台启动时先把所有 `running` 且心跳超时的 run 置回 `queued`** —— 否则进程重启后这些任务会永远卡在"执行中"。
- **取消**：复用现有 `Setpgid` + `kill(-pgid)` 实现，杀整个进程组。
- **重试**：区分可重试（网络、超时、上游 5xx）与不可重试（参数非法、目录不可写），指数退避。
- **依赖**：`depends_on` 支持简单 DAG（PRD 写完才派评审）。
- **幂等**：`idx_agent_tasks_active` 唯一索引在库层挡住重复派单。

### 5.3 轨道二：外部执行 + 结果上报

其他平台工具（Claude Code、WorkBuddy、任意 MCP 客户端）执行时，平台只**接收上报并监控**。上报接口同时提供 MCP 工具与 HTTP 端点：

| 接口 | 作用 |
|---|---|
| `claim_tasks(agent, limit)` | 外部 Agent 主动认领 `queued` 任务；平台建 `agent_runs`（`executor_kind=external`）并返回 `run_id` |
| `heartbeat(run_id)` | 上报存活；超过阈值未心跳 → `stalled` |
| `report_step(run_id, kind, name, detail, state)` | 追加过程步骤，喂给运行中心 |
| `report_finish(run_id, status, summary, artifacts[], field_updates{})` | 收尾：写产出回流、落字段变更 |
| `report_run(object_id, executor, ...)` | 不经任务单的直接上报（外部工具自己发起的执行也能被监控） |

**取消语义要区分**（外部进程平台杀不掉）：
- `cancel_requested`：平台发出取消请求，等待外部确认
- `canceled`：外部确认终止
- 超时未确认 → 保持 `cancel_requested` 并在运行中心标红，不假装已取消

### 5.4 统一运行中心

- 两个 tab：「Agent 任务」（`agent_runs`，含内外部）与「流水线运行」（`pipeline_runs`）。
- 状态归一：`queued` / `running` / `succeeded` / `failed` / `canceled` / `stalled` / `waiting_review`。
- 每条运行可下钻到 `agent_steps`（实时过程）与 `pipeline_run_items`（"这条对象为什么没被处理"）。
- 现有 runner 的 SSE 是单连接模型，运行中心需要**全局事件流**（一条 SSE 推送所有运行的状态变化），否则并发 10 个任务就要开 10 条连接。

### 5.5 产出回流

- `agent_artifacts` 增加 `object_id` / `task_id` / `run_id`。
- 详情抽屉新增「产出」区：预览、下载、在 Finder 打开。
- 一键把产出沉淀为 `doc` 对象，并自动建 `references` 关联回源对象。
- `field_updates` 的写入走"建议"状态（见 5.6）。

### 5.6 人在环（轻量版）

只拦 Agent 对主表三类字段的写入：`status` / `owner` / `body`。落为"建议"，详情抽屉显示 diff 并提供接受/拒绝。产出文件不拦。

理由不是权限而是数据可信度：万级数据下，跑几周后如果主表被 Agent 改乱，人工返工成本远高于拦截成本。

---

## 六、实施顺序与验收

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **0 地基** | 多工作区迁移（含两张表重建）、`owner_id` 预留、快照定时化 | 迁移在副本演练通过后在线上跑通；81 条数据完整落 `ws_default`；启动自检索引齐备 |
| **1 万级可用** | FTS5 + bigram、keyset 分页、counts_cache、revisions 瘦身 | 10 万条造数下：中文 2 字词与多词查询均 < 200ms；深翻页无退化；侧栏加载 < 100ms |
| **2 流水线骨架** | pipelines 四表 + 扫描/定时触发器 + `pipeline_marks` 幂等 + 运行中心（流水线 tab） | 七条首批流水线中的「自动快照」「每日跟踪」「周报汇总」跑通；重复执行不产生重复派单 |
| **3 执行双轨** | agents / task_templates / agent_tasks / agent_runs / agent_steps；内置队列；外部上报协议；统一运行中心；产出回流 | 内外部各跑通一次；进程中途重启后无僵死任务；外部运行断了能标 `stalled` |
| **4 流水线接执行** | `agent_run` 步骤接入流水线 | 「PRD 派单」「需求结构化」两条流水线端到端跑通 |
| **5 提效补全** | Saved View、今日聚焦页、需求去重、导入器、度量看板 | 度量看板只读 `metrics_daily`；导入器支持去重与按 batch 回滚 |
| **6 双角色台账** | 容量与负载 → RAID → 里程碑 → 验收 → 变更控制 → 干系人 | 全部以注册 `object_type` 实现，零新表；每批做完先看使用率再决定下一批 |

每阶段完成后先观察数据是否被真实使用，再决定下一阶段范围 —— 当前 81 条数据已证明"建好界面不等于发生行为"。

---

## 七、需要提前知道的风险

1. **阶段 0 是唯一有不可逆风险的一步**。`objects` 与 `tags` 的行内 UNIQUE 约束必须重建表；务必先副本演练 + 强制快照 + 迁移幂等。建议单独一次提交，不与其它改动混合。
2. **CJK 检索方案的取舍已明确**：trigram 对两字查询不可用，故推荐 bigram 预处理列。若将来要上向量检索，bigram 列可保留为关键词通道。
3. **流水线扫描成本随流水线数量线性增长**。万级下每条流水线每次扫描都必须是索引命中的窄查询（`scope` 必须带 `status` 或 `updated_at` 条件），否则 20 条流水线会被扫成全表遍历。
4. **外部执行的"取消"不可靠**，产品语义上要如实呈现为"已请求取消"，不要显示成已终止。
5. **单进程队列**决定了工作台必须常驻。若将来要多机，`agent_tasks` 的认领需要改成 `UPDATE ... WHERE status='queued'` 的原子抢占（表结构已支持，无需改）。

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
