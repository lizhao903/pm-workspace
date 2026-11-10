# 一人之下（pmw）使用审计与一致性核对

> 2026-11-09 · 只读分析。数据源：**7796 端口生产实例的日常库** `data-dev/pm.db`（112MB，WAL 4MB；`sqlite3 -readonly "file:...?mode=ro"` 直读，未起服务、未写库）；历史对照 `data/pm.db`（712KB，2026-09，旧实例）；备份目录 `data-dev/backups/`。
> **口径修正（10:22 复核）**：7796 是生产环境、不是测试库，本报告的所有「低使用量」就是真实使用量。快照从 09:5x 的 3,456 条消息变为 10:22 的 3,462 条（pending 1,209、与我相关 910、未读 474），数字随实例实时变化，下文保留原快照口径并以本行为准。另两处更正：① 848 条私聊不是「2025 年的」，而是 10-30 一次性回填、发送时间跨 2025-04-15～2026-10-26（2025 年 149 条）；② 267 条 `task.review_requested` 未读里 266 条对应任务已是 `done`——问题不是「验收队列看不见」，而是通知不随对象状态收敛且没有列表入口。
> 口径：凡标「数据事实」的都能用文中 SQL/表重放；「代码事实」给到 `文件:行`；「推断」是解释，不当作事实。
> 注意：实例在 2026-11-06 有一次大批量造数/回滚（下称「11-06 批处理」），它把多个总量指标抬高，阅读总量时先去噪。

---

## 0. 一句话

**主回路不是 README 的「IM→SOP→任务→执行→回执」全链，而是两条半：IM 收取后规则性忽略（2244 条）、Claude Code 经 MCP 回写开发任务（3098 条 agent 修订、261 个 commit）、以及少量私聊回复。** IM→建任务的支路在 11-06 一次性跑出 216 条任务又在 3 分钟内全部删掉；回执支路 8 天只跑通 2 次；跟踪字段（到期 0、人类负责人 2）仍是空的。**「库建好了，节拍还没有」这句 2026-09 的判词，到 11 月只在运维侧（定时巡检/提醒）有了一点节拍，任务跟踪侧没有。**

---

## 1. 使用矩阵

### 1.1 总表（对象数 / 时间范围 / 来源与性质）

| 模块 | 主要表 | 数量（存活） | 最早–最近 | 性质判断 |
|---|---|---|---|---|
| 今日 | 无表，`GET /api/today` 聚合 | 派生 | — | 入口在用，本身无数据 |
| 项目 | `objects(type=project)` 5(4) | 5 (4) | 10-29–11-02 | 真实，4 个项目在跑 |
| 任务 | `objects(type=task)` | 692 (467) | 10-28–11-06 | 真实+大量开发任务，见 §2 |
| 文档 | `objects(type=doc)` | **0** | — | 工作台文档一篇没建；只挂了 4 个本机目录 |
| IM 消息 | `im_messages` | 3456 | 发送 2025-04–2026-11-09 | 实收，其中 10-30 一次历史回填 1324 条 |
| 联系人 | `stakeholders` / `contact_identities` | 91 / 44 | 10-28–11-06 | 真实名册；43 个 Slack 身份 |
| 会话/Agent | `agent_sessions` / `agent_messages` | 21 / 186 | 10-29–11-06 | 真实，含 1 个 76 条消息的深用会话 |
| 视频 | `video_topics` 等 | 94 / 其余 0–1 | 10-29 | **批量导入的选题表，制作流水线零使用** |
| 交易 | `trade_instruments` 2027 / `trade_klines` 2065 | 其余全 0 | 11-05–11-09 | **只有行情管道，策略/回测/委托 0；插件已停用** |
| 宽基 ETF | `etf_funds` 10 / `etf_daily` 20 | — | 11-05–11-09 | **新装 4 天，只跑了 2 个交易日** |
| SOP | `sop_flows` 5 / `sop_runs` 3856 | — | 11-02–11-09 | 总量被 11-06 批处理放大，见 §2 |
| 终端 | `terminal_settings` | 1 | 11-03 | 只配了命令，执行记录在 `task_runs(mode=terminal)` 2 次 |
| 浏览器 | `browser_tabs` | 1 (`about:home`) | 11-02 | 零使用；插件 11-09 01:48 已停用 |
| 设置 | 见 §3 | — | — | 16 个分节，半数是空配置 |

关键明细（数据事实）：

- `objects`：727 中 226 软删，存活 501。按类型 task 692、requirement 30、project 5；doc/resource/note **全 0**。按来源 `import` 294、`sop` 352（219 已删）、`manual` 7、`incident` 12、`im` 7、`agent` 6、空 49。
- 字段填充（存活 task 467）：优先级 461、项目 402、分类 297、完成时间 375、**负责人 `owner_id` 245 但其中 243 是 "Claude Code"（AI）**、人类负责人 2、**到期 0**。全库存活对象到期 0/501。
- 分类 18 个（每类 1 级）、标签 356 个/引用 1345、关联 499（`blocks` 484、`parent` 15）。
- `revisions` 4386：`agent` 3098（70.6%）、`api` 422、`plugin` 359、`import` 317、`ui` 182、`schedule` 8；字段 `progress` 1878、`status` 901。**写库主渠道是 Agent/MCP，不是人。**
- `audits` 3951（progress 1215、append 841、create 680、update 556、delete 303、claim 201）。

### 1.2 SOP：3856 条是什么（这是全篇最需要去噪的数字）

按 flow × 触发来源拆（`SELECT flow_id,source,status,count(*) FROM sop_runs GROUP BY 1,2,3`）：

| flow | 名称 | 状态 | 数量 | 说明 |
|---|---|---|---|---|
| `sop_06gs45…` | 消息分诊：要不要我处理（**已从 sop_flows 删除**） | done/subflow | 1062 | 旧版分诊子流程，11-02–11-06 |
| `sop_06gsnq…` | 消息分流：按项目归档（**已删除**） | done/failed/stopped | 1070 | 旧版父流程 |
| `sop_06gtz9m…` | IM:忽略 ai-octok-platform 自动消息（**live v5**） | done | 1146 | 规则型，平均 0.0 秒 |
| `sop_06gtzez…` | IM:@我和私信转任务（**live v5**） | done 285 / stopped 277 / failed 14 | 576 | 唯一建任务的流程 |
| `sop_im_task_reply` | IM 任务回执 | done | 2 | 回执支路全部使用量 |

- **数据事实**：3856 = 旧流程 2132（55.3%，`flow_id` 在 `sop_flows` 已不存在）+ 忽略流程 1146（29.7%）+ 转任务流程 576（14.9%）+ 回执 2。整体 done 3548（92.0%）、stopped 285（7.4%）、failed 23（0.6%）。
- **推断**：3856 不能当「SOP 被跑了 3856 次」看。真正产出业务结果的只有转任务流程 576 次（且一半被中止），忽略流程是廉价的规则过滤（0 秒），旧流程是流程改写前的历史版本。
- 失败步骤 31 条的原因（`sop_run_steps.error`）：调模型失败 15（本机 Ollama 没启动）、任务标题为空 14、HTTP 503 2。即 **失败主要不是流程写错，是本地模型服务不可用/上游给空**（数据事实）。
- 步骤 53,119：bypassed 32,574、done 17,278、pending 3,234、failed 31。`pending` 的 3234 里 2,770 条来自 11-06 被中止的 277 个 run（每个 run 停在 title 步，10 个步骤各 277 条），不是排队等待（`im_sop_waits`=0）。
- 跳过规则 `sop_skips` 34 条；`sop_folders` 6、`sop_templates` 12、`sop_settings` 2。

### 1.3 IM：3456 条消息的去向

- 渠道：Slack 3453、Telegram 3（Bot 只通了 3 条，基本没用）。会话 204（私聊 157、群 46、tg 私聊 1），身份 44。
- 接收日：10-30 一次回填 1324（发送时间最早 2025-04-15）；11-02 352、11-05 1149、11-06 256；**11-07 5、11-08 2、11-09 10**（数据事实）。后三天是真实的低频流入。
- 状态：pending 1208、ignored 2244、**done 仅 4**。pending 构成：私聊 848（121 个会话，2025-04 起的历史对话，全部来自 10-30 回填）、群 358（其中 @我 56、@所有人 5、无关系 299）。
- 与我相关但未处理：**909 条**（私聊 848 + @我 56 + @所有人 5；未读 473；10:22 复核为 910/474）。今日页 `todayNeeds` 只要求 `relevance!=''&&status='pending'`（`frontend/src/plugins/im/index.ts:10`），所以**打开今日会看到约 910 条「IM 消息」待处理**；其中 848 条私聊全部是 10-30 回填的存量（发送时间跨 2025-04～2026-10，2025 年 149 条）——这是当前最刺眼的数字。
- 回复：`im_replies` 1015 条，全部 `sent`、全部带 external_id。按 `created_at` 落在库生命周期（≥10-28）的 237 条；其中 11-02 起每天 16–35 条（11-02 35、03 35、04 29、05 28、06 16）。其余约 778 条是 10-30 历史拉取时把「本人过去的发言」回填成回复（`internal/plugins/im/ingest.go:364` 注释：我发的不落成消息，记成回复）。**推断：真实出站回复约 180–240 条，集中在 11-02—11-06；11-07 起归零。**
- 发件箱 `im_outbox` 4（manual）；`im_task_acks` 0；等待表 `im_task_waits/im_sop_waits/im_ask_waits` 全 0。

### 1.4 任务执行与产物

- `task_runs` 15：harness `claude` 13（stream 11、terminal 2）、`agent` 2；状态 done 13、failed 1、canceled 1。覆盖 11 个任务，10-30–11-06。**新接的 `deepseek`（dsh）执行器 0 次**（`internal/runner/dsh.go:16`，表里无该 harness）。
- `artifacts` 418：commit 261、kind 空 140、doc 10、branch 3、prototype 2、other 2；platform local 403、github 4；actor `mcp` 275、`run` 140、`user` 3。挂在 263 个对象上。**产物回写是真的，但集中在开发任务，且空 kind 的 140 条（run 自动扫工作目录）没有归类。**
- `notifications` 289：`task.review_requested` 267（10-28—10-31，**全部未读**）、`run.finished` 15、`schedule.remind` 6、`etf.anomaly` 1。未读合计 283。

### 1.5 Agent / 调度

- `agent_sessions` 21、`agent_messages` 186（user 35 / assistant 41 / tool 110）、`agent_tool_calls` 9、`agent_runs` 24（done 21/failed 3）、`agents` 11、`agent_providers` 2（本机 Ollama + NewAPI，均 `last_test.ok=true`）、`agent_tool_grants` 47、`agent_settings` 4（场景绑定 3 条）。
- 真实深度使用：会话「更新Octok 项目中任务的标题」76 条消息、9 次 `update_object` 工具调用（3 次 decided 间隔 30 分钟，`agent_tool_calls`），说明**内置 Agent 的能力被用在批量改对象上，而不是聊天**。
- `schedules` 3、`schedule_runs` 14：
  - 运行异常巡检（daily 09:00，`incident_sweep`）：8 次，5 ok，**3 missed**，原因「到点时服务没在运行，没有补跑」；
  - 点餐提醒（工作日 17:30，`remind`）：6/6；
  - 每周一整理项目知识库（`sop`）：**disabled，0 次**。
  - 动作种类只有 `task/sop/agent/incident_sweep/remind`（`internal/schedule/plugin_action.go:51`）——**没有备份动作，也没有「逾期/停滞扫描」「日报/周报」动作**。
- `incidents` 15：Slack 同步失败（41 次）、Telegram 同步失败（213 次）、Binance/OKX 行情超时、2 条前端分包加载。连接器「连接成功」但**同步长期不稳**（Telegram 213 次/10 天）。

### 1.6 垂直模块：演示/种子 vs 真实

| 数据 | 数量 | 判断 | 依据 |
|---|---|---|---|
| `video_topics` 94 | 94 | **批量导入**，非使用 | 94 条 `created_at` 全部 = `2026-10-29T09:06:35Z`；94 条 `tag_list` 含「编号:T2026…」；`outline` 自述来自 `web-video/projects/选题总表.xlsx`；81 idea/13 scheduled |
| `video_videos` 1 | 1 | 空壳 | 标题「第 1 集：」、stage=script、topic_id 空；clips/shots/publishes/bili_* 全 0 |
| `trade_instruments` 2027 | 2027 | **行情同步产物**，非交易使用 | 全部 `market=crypto`、source binance/okx、updated 2026-11-09 01:47；`trade_strategies/backtests/orders/accounts/live_*` 全 0；插件 11-09 01:48 停用 |
| `trade_klines` 2065 | 2065 | 同上 | 仅 4 个 symbol、15m、约 2 天 |
| `etf_funds` 10 | 10 | **真实配置**，新装试用 | 10 只宽基；`etf_daily` 仅 11-05/06 两天 ×10；`etf_index_daily` 14（7 指数×2 天）；`etf_anomaly_events` 4 条 11-06 全部 open |
| `sop_runs` 3856 | 3856 | **55% 是旧流程残留 + 30% 规则过滤** | §1.2 |
| `im_replies` 1015 | 1015 | **约 3/4 是历史回填** | §1.3；`created_at` 最早 2025-04-17，库 10-28 才建 |
| `projects_materials` 21 | 21 | 真实 | 4 个项目挂本机目录/链接 |
| `browser_tabs` 1 | 1 | 零使用 | 仅 `about:home`；allowlist 0；插件已停用 |
| `domains_routes` 2 | 2 | 配置型真实 | `bro.vip` + app/web-next 两条路由；`domains_checks` 0 |

---

## 2. 真实回路还原：IM→SOP→任务→产物→回执

### 2.1 链路事实

```
3456 收到（Slack 3453 / TG 3）
 ├─ 2244 ignored（1802 群自动忽略 + 其余规则/人工忽略）
 ├─ 1208 pending（848 私聊历史 + 358 群）
 └─ 4 done
        │ 转任务 234 条（im_message_tasks）
        ├─ 只 19 条存活任务（source=sop 12 + source=im 7）
        └─ 217 条任务已删（其中 216 条是 11-06 08:00 批处理）
               │ 执行
               ├─ task_runs 15 次（claude 13 / agent 2）
               └─ artifacts 418（261 commit）
                      │ 回执
                      ├─ im_replies 真实约 180–240（历史回填约 778）
                      ├─ im_outbox 4、im_task_acks 0
                      └─ SOP「IM 任务回执」2 次（各约 7 分钟）
```

### 2.2 11-06 批处理：一次「跑通然后撤销」

- **数据事实**：`sop_runs` 在 11-06 08 时一小时 1558 条；转任务流程 08:26:38–08:29:32 启动 277 条、全部 `stopped`；`sop_run_steps` 留下 2,770 条 pending；`im_message_tasks` 08 时新增 216 条；`objects(source=sop)` 在 08:30:27–08:30:43 建 216 条、**08:33:52 一次软删 213 条**；对应消息被标 `ignored` 216 条。08:14–08:20 另有 7 条失败，原因「任务标题是空的」。
- **推断**：这是对存量消息做的一次批量分诊演练（很可能就是 B-02 批量分诊功能的首跑）：277 条并发跑 → 216 条建成任务 → 3 分钟内全部回滚。它同时解释了：今日积压为什么没减少（消息被打成 ignored/任务被删）、SOP 总量为什么虚高、`failed` 里为什么有一批空标题。

### 2.3 最近 7 天每天动作量（按库内时间，UTC 日界）

| 日期 | IM 收 | 回复 | SOP run | SOP 失败 | 新对象 | task_run | artifact | 通知 | 定时 run |
|---|---|---|---|---|---|---|---|---|---|
| 11-03 | 250 | 35 | 219 | 0 | 34 | 2 | 17 | 2 | 1 |
| 11-04 | 108 | 29 | 216 | 0 | 27 | 4 | 108 | 8 | 5 |
| 11-05 | 1149 | 28 | 852 | 0 | 27 | 2 | 1 | 3 | 3 |
| 11-06 | 256 | 16 | **1903** | 14 | **249** | 4 | 44 | 6 | 2 |
| 11-07 | 5 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 1 |
| 11-08 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 1 |
| 11-09 | 10 | 0 | 9 | 0 | 0 | 0 | 0 | 0 | 1 |

- 7 天合计：收 1780、回复 108、SOP 3205、新对象 337、task_run 12、artifact 170。
- **数据事实**：11-07/08 是周六日，11-09 是周一上午，所以低量有周末因素；但即使只看工作日，11-06 之后每天 SOP 只有 2–9 条、回复 0、artifact 0。**推断：11-07 起主回路只剩「忽略流程」在跑，转任务/执行/回执三段全部停摆。**
- 待处理/暂停：IM pending 1208；SOP stopped 285、failed 23、pending steps 3234；未读通知 283；等待表 0。

### 2.4 主回路、断点、空转

- **主回路（推断，依据写库来源与量）**：① Claude Code 经 MCP 改任务（`revisions.agent` 3098、`artifacts.mcp` 275、`claim` 201）——这是唯一每天都有动作的深度回路；② IM 收消息 + 忽略流程（2244 ignored / 1146 忽略 run）；③ 私聊回复（11-02—06 每天 16–35 条）。
- **断点**：
  1. **转任务断**：848 条历史私聊从未分诊；批量分诊的唯一一次成功产物被回滚；577 条 pending 群消息无人认领。
  2. **执行断**：SOP 建出的任务只有 19 条存活，`task_runs` 15 次、且没有一次由「IM/私信转任务」流程自动接力到执行器。
  3. **回执断**：`im_task_acks` 0、SOP 回执 2 次、回复不改变消息状态（`done` 仅 4 条）——**回了消息，消息仍留在待处理**。
  4. **归档断**：`doc` 对象 0，SOP/IM 产出的结论没有一篇落到文档。
- **空转**：视频（94 导入选题 + 1 空视频）、交易（只同步行情、插件已停）、浏览器（1 个首页标签、已停）、宽基 ETF（2 个交易日、4 条未处理异动）、域名 checks（0）、知识库（2 个库 0 chunk）、Webhook（0）、快捷访问（0）。

---

## 3. 冗余 / 不必要功能的数据证据

### 3.1 近零使用但有界面/有表

| 模块/能力 | 数据证据 | 损失（若默认隐藏/删除） |
|---|---|---|
| 交易套件（17,358 Go + 8,405 前端 LOC） | 委托/成交/持仓/账户/策略/回测/实盘全 0；仅同步 2027 合约 + 2065 K 线；插件 11-09 已停用 | 无业务数据损失，删掉省最大一块维护面；行情连接器可保留 |
| 视频创作（14,859 + 10,979 LOC） | 94 选题是 xlsx 导入；视频 1 个空壳；发布/素材/分镜/B站全 0 | 只丢 94 条可再导入的选题 |
| 内置浏览器（818 + 2,207 LOC） | `browser_tabs` 1 (`about:home`)、allowlist 0；插件已停 | 无损失 |
| 宽基 ETF（2,188 + 918 LOC） | 10 只基金、2 天数据、4 条 open 异动；规则全用内置默认 | 小；但刚装 4 天，建议先观察 |
| Webhook | `webhooks` 0、`webhook_deliveries` 0 | 无损失（内核已实现但无入口使用） |
| 快捷访问/快捷键 | `shortcuts` 0、`shortcut_groups` 0 | 无损失 |
| 技能/知识库 | `skills` 0；`knowledge_bases` 2 但 `kb_docs`/`kb_chunks` 0 | 无损失（embedding 模型配了没用） |
| 项目工作区/发布 | `projects_worktrees` 0、`projects_releases` 0、`projects_test_runs` 0 | 无损失 |
| 终端 | 仅 1 条 `claude_command` 配置；terminal 模式执行 2 次 | 小 |

### 3.2 设置页「配了没用 / 没配」

- 已配（数据事实）：`agent_providers` 2（均连通测试通过）、`connectors` 4（Slack/Telegram/OKX/Binance，均 connected）、`dict_items` 42/7 字典（优先级、关联关系、产物平台、产物种类、联系人分组、IM 消息状态、项目角色）、`local_dirs` 4、`vault_secrets` 3、`workspaces` 6。
- 空配置（数据事实）：`shortcuts` 0、`skills` 0、`webhooks` 0、`kb_docs` 0、`schedule` 里 KB 周更 0 次（disabled）、`browser_allowlist` 0、`projects_releases/worktrees` 0。
- **推断**：设置页 16 个分节（`frontend/src/modules/settings/Page.tsx:26-45`）里约一半是「有界面、无数据」；活跃的是 连接器 / 模型服务商 / 插件 / 工作台菜单 / 运行异常 / 角色与权限。

### 3.3 模块化复用没做够的地方（代码事实）

1. **「与我相关」三套实现**：后端 `internal/plugins/im/relevance.go:13-58`；前端 IM `frontend/src/plugins/im/model.ts:73,285`；项目 `frontend/src/plugins/projects/commsModel.ts:62,211`。`relOk` 与 `ALL_HANDLES` 基本逐字重复，口径已开始分叉。
2. **搜索五处各写**：`core/data/search.ts`（23 行）+ `modules/tasks/search.ts` + `modules/contacts/search.ts` + `plugins/im/search.ts` + `plugins/projects/search.ts`，各自拼 `CommandDef`；匹配语义不统一——联系人做多词 AND（`modules/contacts/model.ts:88-96`），任务走后端单串 `LIKE`（`internal/store/sqlite/objects.go:216`）。
3. **通知有表有事件、只暴露一种**：`notifications` 289 行、`internal/notify` 367 行，前端只消费 `schedule.remind`（`core/data/notifications.ts:1-2,26`），267 条待验收 + 13 条运行完成 + 1 条 ETF 异动**没有任何入口**（`Shell.tsx:196-226` 顶栏只有搜索）。
4. **今日/待处理口径分散**：IM 的 pending 口径在 `im/index.ts:10`、`im/model.ts`、`projects/commsModel.ts:44` 各写一遍；今日插件卡片（`todaySources.register`）没有共享策略层。
5. **备份能力有内核没出口**：`internal/store/sqlite/backup.go:49` 有 `Snapshot`、`internal/api/server.go:489` 有 `POST /api/admin/snapshot`、`internal/db/migrate.go:175` 迁移前自动快照，**前端 0 处调用**（`grep admin/snapshot frontend/src` 无结果）。

---

## 4. 好用度核对

### 4.1 `docs/product-review.md` A-01…B-12 逐条结论

**代码层已全部落地（21/21 已修，B-12 也已修）**；注意：这是代码确认，未实机复测。

| 编号 | 结论 | 依据（代码/数据） |
|---|---|---|
| A-01 命令面板搜项目/任务/联系人 | 已修 | 内核注册 `modules/tasks/index.ts:30`、`modules/contacts/index.ts:13`；插件 `provides.search` 已声明（`internal/plugins/im/plugin.json`、`projects/plugin.json`）；动态数据源 `CommandPalette.tsx:10-35` |
| A-02 收消息自动登记会话、候选分因 | 已修 | `internal/plugins/im/ingest.go:394-400` `Ensure`；`commsModel.ts:199-207` 空态按原因分 |
| A-03 项目 SOP / Agent 标签 | 已修 | `ProjectPage.tsx:125` 挂 `SopTab`；`AgentsTab.tsx` 存在；`model.ts:155-168` 12 个 Tab 无 todo |
| A-04 验收栏提交说明+标准清单 | 已修 | `ReviewBar.tsx:2-3,84,94`（全文、提交号、勾选清单） |
| A-05 枚举值补齐与「说明/使用中」 | 已修 | `settings/enums/model.ts:58-113`；`migrations/0041_enum_dicts.sql` 补 contact_group/msg_status；`EnumsSection.tsx:223,257` 两列 |
| A-06 SOP 节点/触发方式显示名 | 已修 | `plugins/sop/model.ts:49,61`；`FlowDetail.tsx:51-52,132` |
| A-07 来源标签统一 | 已修 | `tasks/sourceModel.ts:40-51`（import 显示「人工」+悬停说明） |
| A-08 规格补「受阻」 | 已修 | `web-next/docs/spec/tasks.md:90,97,110` |
| A-09 设置里运行异常 | 已修 | `settings/incidents/IncidentDrawer.tsx` 真实抽屉 |
| B-01 待回复口径 | 已修 | `im/index.ts:10` 要求 relevance；`commsModel.ts:44-45` |
| B-02 IM 批量已处理 | 已修 | `im/Page.tsx:7,12-14,777`（批条、全选、分批、批量分诊） |
| B-03 联系人多分组 | 已修 | `contacts/model.ts:42-43` 按「、」拆；筛选/计数/首屏分组都按拆后的组 |
| B-04 联系人搜索含备注/职位/别名 | 已修 | `contacts/model.ts:80-96`（hay 含 role/note/tags + 多词每词命中） |
| B-05 干系人多选/拼音/多字段 | 已修 | `StakeholdersTab.tsx:6,90`；拼音在 `core/ui/pinyin.ts` |
| B-06 任务排序（完成时间） | 已修 | `tasks/model.ts:110-140`，`byCompleted` |
| B-07 负责人筛选+搜索负责人 | 已修 | `TaskList.tsx:80,231`；`matchQuery` 含 `owner_name/owner`（`model.ts:190-193`） |
| B-08 产出按提交合并 | 已修 | `conversations/OutputsView.tsx:5,70` |
| B-09 空会话隐藏/切走删除 | 已修 | `ChatsView.tsx:32-34,46`；测试 `ChatsView.test.tsx:44-60` |
| B-10 项目沟通搜索/与我相关 | 已修 | `CommsTab.tsx:6,301`；`commsModel.ts:62` |
| B-11 窄屏三处 | 已修（代码） | `tasks.css:11,48,640px 容器查询`；`projects.css`/`contacts.css` 均有 media 查询 |
| B-12 连接器「我的称呼」 | 已修 | `im/relevance.go:16-19,38`；数据里 Slack 已填 `self_names` 5 个别名 |

> 说明：`docs/product-review.md` 的 C/T/E 系列也基本能在代码中找到对应（如 C-03 文档可写 `docs/Page.tsx:5`、C-01 抽屉窄列 `tasks.css` 容器查询、E-03 默认排序 `contacts/model.ts:100-104`），本次未逐条复测。

### 4.2 `docs/product-assessment.md` 的 P0/P1 是否解决

| 条目 | 现状 | 依据 |
|---|---|---|
| P0-1 备份定时器 | **未解决** | 无定时备份动作（`internal/schedule/plugin_action.go:51` 只有 5 种动作）；前端 0 处调用 snapshot；`data-dev/backups/` 99 个 .db + 20 个 `.db-shm/.db-wal` 旁文件、2.5GB 无轮转，来自插件安装/迁移/更新触发 |
| P0-2 跟踪链条/节拍 | **部分** | 调度器与通知已存在（`internal/schedule` 2,117 行、3 条定时、14 次执行）；但任务跟踪仍空：到期 0/501、人类负责人 2/467；3 次 missed 且「没补跑」；无逾期/停滞扫描、无周报 |
| P1-3 收集是一次性搬运 | **已解决（IM 侧）** | Slack/Telegram 连接器真实收数（3453/3），按身份认人、按会话归档已有数据；但同步不稳（Telegram 213 次失败、Slack 41 次） |
| P1-4 内置 Agent 悬空 | **部分解决** | 21 会话/186 消息/9 工具调用/24 run，且 76 条消息的批量改对象会话是深用；但仍是「要主动打开的聊天框」，没有变成提醒源；DeepSeek 执行器 0 次 |
| P1-5 无鉴权 | **未解决** | 216 条路由无认证中间件（`grep Authorization internal/api` 仅出站 provider）；`domains_settings.enabled=1, suffix=bro.vip`，已暴露到域名 |
| P1-6 检索多词失效 | **部分** | 联系人已支持多词 AND（`contacts/model.ts:88`）；任务/对象仍单串 `LIKE`（`objects.go:216`），命令面板任务搜索走该接口；FTS5 有代码（`internal/kb/fts.go`）但 `kb_chunks=0` |
| P2-7 汇总自动化 | **未解决** | 无自动归类/去重/汇总节奏；知识库 2 个 0 文档 |
| P2-8 功能过剩 | **仍然成立** | 见 §3、§5 |
| P3-9 界面细节 | **部分变化** | 抽屉 AI 样稿已删；但「通知」从死入口变成**没有入口**（283 条未读隐形，更隐蔽） |

### 4.3 新发现（均能从代码/schema/数据确认）

1. **通知既无出口也无生命周期（P1）**：`notifications` 289 条、未读 283（全部积压在 10-28～11-06，之后 3 天没有新通知）。267 条 `task.review_requested` 里 **266 条对应任务已 `done`**、1 条对象已不存在——通知没有列表入口（`core/data/notifications.ts:1-2` 只消费 `schedule.remind`；`Shell.tsx` 顶栏无通知按钮），也不会随对象状态自动已读。真正要修的是「通知生命周期 + 入口」，而不是补一个「待验收」队列。
2. **今日页被回填私聊淹没（P1）**：`todayNeeds` 口径下 IM 组 ≈910 条（未读 474），其中 848 条是 10-30 回填的存量私聊（发送时间跨 2025-04～2026-10）；「今日」从「一个入口看今天」退化为「一个入口看一次没做过的历史分诊」。（数据 + `im/index.ts:10`）
3. **批量分诊不可撤销（P1）**：11-06 一次批量 277 个 run、216 条任务，3 分钟内全部软删；没有「先出建议、再确认建任务」的两段式，也没有一键回滚。（`sop_runs`/`objects.deleted_at`/`im_message_tasks` 数据）
4. **处理完不收敛（P2）**：回复 180–240 次，但消息 `done` 仅 4 条。回复接口会把消息标已读，但只在勾选「并处理」时才置 `done`（`internal/plugins/im/actions.go:310-314`），默认不勾；于是 1,209 条仍留在待处理里。
5. **停用插件不彻底（P2，推断）**：trade/browser 于 11-09 01:48 `disable`，但当天 01:47 行情仍在更新；若后台连接器由插件注册，停用后应停——建议核对 `plugins.enabled` 是否真正门控后台任务。（`audits` 11-09 + `trade_instruments.updated_at`）
6. **备份不可见（P2）**：有 `Snapshot` API 与 99 份快照，但界面既看不到、也不能手动触发/恢复；其中 20 个 `.db-wal/.db-shm` 旁文件说明部分是 `cp` 而非 `VACUUM INTO`（`backup.go:49` 是后者），一致性存疑。

---

## 5. 产品定位一致性：宣称 / 使用 / 维护成本

README 目录列 **14 个模块**（用户口述 12，实际多出「宽基监控」「内置浏览器」）；`plugin.json` 9 个插件、当前启用 7 个（trade、browser 11-09 停用）。默认产品经理工作台（`workspaces` 模板 ws_pm）只挂 today/projects/tasks/library/messages/contacts/sessions/sop/terminal/browser 10 个，**视频/交易/宽基不在默认菜单**。

| 模块 | README 宣称强度 | 实际使用（数据） | 维护成本（Go+前端 LOC） | 性价比 |
|---|---|---|---|---|
| 交易套件 | 极强：4 个菜单、17 张截图、一段风控/实盘闸门说明 | 0 交易；只同步行情；插件已停 | 17,358 + 8,405 = **25.8k** | **最不划算** |
| 视频创作 | 强：12 张截图、完整制作流水线 | 94 条导入选题、1 个空视频、0 发布 | 14,859 + 10,979 = **25.8k** | **第二不划算** |
| IM 消息 | 核心能力首位 | 3453 条实收、204 会话、234 转任务 | 14,175 + 12,178 = 26.4k | 最划算（主回路） |
| SOP 编排 | 强：内置研发/发布 pipeline | 3856 run，但 55% 旧残留、30% 规则过滤；转任务流程成功率 49.5% | 13,598 + 9,593 = 23.2k | 中（应瘦身） |
| 项目 | 强：12 个 Tab | 4 个活跃项目、10 群绑定、11 干系人、21 资料 | 9,529 + 10,264 = 19.8k | 划算 |
| 宽基 ETF | 中：1 节 | 10 基金 / 2 个交易日 / 4 条 open 异动 | 2,188 + 918 = 3.1k | 待观察 |
| 终端/域名/浏览器 | 中：各 1 节 | 终端 1 配置 2 次执行；域名 2 路由；浏览器 0 | 4,068 + 4,958 ≈ 9k | 域名有价值，浏览器不划算 |
| 会话/Agent | 中：1 节 | 21 会话/186 消息/9 工具调用 | 6,008 + 2,218 = 8.2k | 中（价值被低估） |
| 今日/任务/文档/联系人 | 内核 | 任务 467 存活；文档 0；联系人 91 | tasks 10,168 + docs 2,174 + contacts 1,849 + today 1,065 | 任务划算，文档闲置 |
| 设置 | — | 16 分节，半数空配置 | 13,118 + core 27,860 | 偏重 |

- 全仓规模（代码事实）：Go 非测试 136,778 行 + Go 测试 78,734 行（测试占 57.6%）；前端 115,870 + 测试 31,768；插件 Go 75,775 行（占 55.4%）；216 条路由、51 内核迁移 + 71 插件迁移。
- **最不划算 5 项**：交易、视频、内置浏览器、SOP 的旧流程兼容层、设置页的「空配置分节」。
- **最被低估 1 项**：会话/Agent——真实深度用（76 条消息批量改对象），却仍被当成聊天框，没有接到「待验收/停滞/周报」的提醒源上。

---

## 6. 结论

### 6.1 只保留 5 个模块

**今日、任务、IM 消息、项目、SOP**（设置作为基础设施保留，不计入 5 个）。理由：这 5 个覆盖了全部真实动作——任务 467 存活、IM 3453 实收、项目 4 个活跃、SOP 是唯一自动化载体、今日是唯一聚合入口；其余模块要么 0 数据（文档/浏览器/Webhook），要么只有导入或行情（视频/交易），删掉不损失业务记录。

### 6.2 应默认隐藏或拆走 3 个

1. **交易套件**——插件已停用、0 交易数据、LOC 最大；先拆成独立可选包，行情连接器可留给 ETF。
2. **视频创作**——数据只有一份可再导入的选题表；拆走时导出 `video_topics` 即可。
3. **内置浏览器**——已停用、仅 1 个首页标签；用系统浏览器替代。

（宽基 ETF 列为第 4 个「观察项」：刚装 4 天，若一个月内仍只有 2 天数据就一并隐藏。）

### 6.3 日常最痛的 3 件事

1. **待处理永远不会减少**：1208 条 pending，其中 848 条历史私聊从 10-30 起没人处理；回复不置 done，批量分诊的唯一产物被删。打开 IM 只能靠搜索/筛选自救。
2. **「等你验收」没有入口**：267 条待验收通知从 10-28 起未读、无界面；验收动作要靠翻任务列表。
3. **跟踪字段是负担而不是帮助**：到期 0/501、人类负责人 2/467；「今日」没有可催的东西，节拍只能靠人肉。

### 6.4 给「好用」的 5 条最高性价比改动

1. **通知中心（P0）**：把 `notifications` 按 kind 分组挂到顶栏，`task.review_requested` 直达待验收；先处理 267 条存量。复用已有表与 `useReadNotification`，成本最小、收益最大。
2. **存量消息一次性分诊 + 两段式批量（P0）**：对 848 条历史私聊先跑「建议」不建任务；批量分诊加预览/撤销（11-06 的 277 条教训），并把回复与 `done` 联动。
3. **跟踪字段自动补全（P1）**：负责人从 IM 发信人/项目干系人推断（先把 243 条 AI 负责人之外的人类 owner 补上），到期从 SOP/模型建议；目标让 467 条存活任务至少一半有 due，今日才有得催。
4. **备份接上定时器并可见（P1）**：`Snapshot` 已有，加 schedule 动作（每日/每次迁移前）+ 设置页「数据与备份」列出快照/轮转；同时清理 20 个 wal/shm 旁文件与 2.5GB 无轮转。
5. **检索语义统一（P1）**：对象查询拆词 AND（联系人已有实现可复用），命令面板补 docs/SOP/artifact 数据源；FTS 已写好但知识库 0 chunk，先不扩容。

### 6.5 一句话建议

**先做「减法 + 节拍」**：把交易/视频/浏览器从默认菜单拿掉，把通知入口、存量分诊、跟踪字段的自动补全接上；「扩张」暂停——当前已经有 25.8k 行代码在给 0 交易数据服务。

---

## 附录：关键查询（可直接重放）

```sql
-- 只读打开
-- sqlite3 -readonly "file:data-dev/pm.db?mode=ro"

-- 对象/来源/字段
SELECT type_id, source, count(*), sum(deleted_at IS NOT NULL) FROM objects GROUP BY 1,2;
SELECT count(*), sum(owner_id IS NOT NULL), sum(due_at IS NOT NULL) FROM objects WHERE type_id='task' AND deleted_at IS NULL;

-- SOP 构成（旧流程不在 sop_flows 里的即孤儿）
SELECT r.flow_id, r.source, r.status, count(*)
FROM sop_runs r GROUP BY 1,2,3 ORDER BY 1,2,3;
SELECT flow_id, count(*) FROM sop_runs r
WHERE NOT EXISTS (SELECT 1 FROM sop_flows f WHERE f.id=r.flow_id) GROUP BY 1;

-- IM 去向
SELECT relevance, status, count(*) FROM im_messages GROUP BY 1,2;
SELECT substr(received_at,1,10) d, count(*) FROM im_messages GROUP BY 1;
SELECT count(*), sum(o.deleted_at IS NOT NULL) FROM im_message_tasks t JOIN objects o ON o.id=t.task_id;
SELECT substr(created_at,1,10) d, count(*) FROM im_replies WHERE created_at>='2026-10-20' GROUP BY 1;

-- 每日动作量
SELECT substr(started_at,1,10) d, source, count(*) FROM sop_runs GROUP BY 1,2;
SELECT substr(at,1,10) d, kind, count(*) FROM notifications GROUP BY 1,2;

-- 演示判断
SELECT substr(created_at,1,19), count(*) FROM video_topics GROUP BY 1;  -- 全部同一秒
SELECT market, source, count(*) FROM trade_instruments GROUP BY 1,2;
SELECT symbol, min(trade_date), max(trade_date), count(*) FROM etf_daily GROUP BY 1;

-- 备份/调度
SELECT id, enabled, rule FROM schedules;
SELECT schedule_id, status, missed, planned_at FROM schedule_runs ORDER BY planned_at;
```

*报告完 · 2026-11-09 · 只读分析，未改动仓库与数据库*

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
