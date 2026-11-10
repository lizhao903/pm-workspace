# Agent 操作与 Agent 会话：现状评估与待补功能

2026-11-10 · 视角：产品经理 · 分支 `feat/prototype-dev-loop`（HEAD `b538736` + 82 个已跟踪改动与 16 个未跟踪文件，以工作区为准）
依据：源码与契约实读 + `web-next/docs/spec/sessions.md` 对照 + 生产库 `data-dev/pm.db` 只读统计（截至 2026-11-10 14:53）+ 三路并行只读审计
边界：只读评估，未实机点击、未起服务、未写库。文中的「数据事实」均可按附录 SQL 重放；「判断/建议」是推断。

---

## 一、一页结论

**骨架已经完整，缺的是「工位」那一层：派活、看活、管活、算账、沉淀，五件事没有连成日常循环。**

当前系统已经具备：多供应商模型接入、Agent 配置（指令/技能/知识库/MCP/触发器/工具授权）、会话流式对话、任务交给 Claude Code / DeepSeek / 工作台 Agent 三种执行器、工具写操作确认、执行记录、产出物登记、任务/IM 来源会话、会话换模型。这些不是「还要做」，是「已经有了、不要重做」。

但生产库显示这些能力还没形成节拍：

| 事实 | 数字 | 说明 |
|---|---|---|
| Agent 会话 | 22 个 / 190 条消息 | 其中 6 个空会话；1 个 76 条的深度会话（批量改任务）撑起了主要使用 |
| Agent 执行记录 | 24 条 | done 21 / failed 3；3 条失败同批（11-02 Ollama 连不上，无重试）；8 天没有新执行 |
| 工具确认 | 9 次 | 全是 `update_object`，全部人工确认；**平均等 31 分钟才被点掉** |
| 工具授权 | 49 条 | 全部 `auto`，`confirm` 档 0 条——「需确认」流程建了但没人用 |
| 任务执行 | 15 次 | claude 13 / agent 2 / **deepseek 0**；没有 waiting 积压 |
| 通知 | 290 条 / 未读 284 | 272 条超过 7 天；267 条待验收通知对应的任务大多已 done |
| 产出物 | 418 条 | 全部挂了对象，但 `session_id` 0 条、`source=agent` 0 条——**会话产出没有归位到会话** |

所以「还需要支持哪些功能」的答案不应是再加一个模块，而是把五个闭环补齐：

1. **执行闭环**：活派出去之后，在哪看？卡住能不能停/重试/续跑？——缺统一运行中心与触发执行的可控性。
2. **注意力闭环**：等确认、失败、后台跑完，人怎么知道？——缺今日入口、通知、红点、会话等待态。
3. **上下文闭环**：长会话怎么不丢上下文？会话怎么按项目/对象找？输入怎么带文件？——缺归属维度、检索、上下文治理、附件。
4. **结果闭环**：产出怎么看/怎么用/怎么回写对象？拒绝能不能告诉它原因？——缺打开/归位/转文档/拒绝原因回流。
5. **治理闭环**：花了多少、能不能限额、配置改了怎么追溯、外部 Agent 怎么接？——缺 token/成本/配额/版本快照/外部接入协议。

**P0 只做 5 件（约 1～1.5 周）**：运行中心（含触发执行可停/有预算/可重试）、等确认注意力链、会话归属与检索、上下文治理最小版。**进展（2026-11-10）：P0 五件均已落地第一批，见附录 C（O-2 / O-3）与附录 D（O-1 / S-1 / S-2）；仍欠任务抽屉「助手」Tab、上下文自动压缩、等确认超时与通知。**
**P1 做 10 件（约 3～4 周）**：名册与记分卡、成本配额、并发与触发治理、批量派单与模板、会话输入、会话操作与组织、产出闭环、配置版本、通知中心、内置工具补齐。
**P2 再看**：外部 Agent 接入协议、多 Agent 协作、会话评测、语音——等 P0/P1 真的被用起来再做。

一句话：**把 Agent 从「对话框 + 手动执行」升级成「有工位、有值班表、有记分板」的同事，而不是继续加聊天功能。**

---

## 二、口径与术语

### 2.1 两个容易混的说法

| 说法 | 本报告的定义 | 对应代码 |
|---|---|---|
| **Agent 操作**（人操作 Agent） | 派单、运行、干预（停/重试/续跑）、授权、计量、观测、治理、外部接入 | `internal/agent/trigger.go`、`internal/runner/`、`internal/api/agent*.go`、`internal/api/run*.go`、`frontend/src/modules/settings/agents/`、`frontend/src/modules/tasks/` |
| **Agent 会话**（和 Agent 的对话） | 会话列表/创建/对话/上下文/模型/产出/组织/通知/可靠性 | `internal/api/agent.go`、`internal/api/conversations.go`、`internal/agent/runner.go`、`frontend/src/modules/conversations/`、`frontend/src/core/chat/` |
| **Agent 的操作**（Agent 对系统做什么） | 内置工具集、连接器工具、权限档位、写操作确认 | `internal/agent/tools.go`、`grants.go`、`sopcatalog.go`、`internal/connector/` |

### 2.2 现状盘点总表

**Agent 操作（12 项）**

| 能力 | 状态 | 证据 |
|---|---|---|
| 三执行器统一派单（claude / deepseek / agent） | 已实现 | `POST /api/objects/{id}/run`、`internal/runner/harness.go:17-26`、`HandOff.tsx:120-135` |
| 派出前提示词预览 | 已实现 | `GET /api/objects/{id}/run/prompt`（`runterminal.go:122-167`）、`HandOff.tsx:390` |
| 委托执行角色（预置提示词） | 部分实现 | 设置 >「角色」是**全局**预设（`runprompts.go`），Agent 弹窗默认不用（`AgentHandOff.tsx:47`） |
| 触发器（manual / im / schedule / task） | 已实现 | `domain.go:638-642`、`trigger.go:126-288` |
| 执行记录与去重 | 已实现 | `agent_runs`（0036）、唯一键 `(agent_id,event_key)` |
| 触发式执行可停止 | 已实现（P0-O2，2026-11-10） | `POST /api/agent-runs/{id}/stop`、`trigger.go` 的 `Stop`/取消表；`canceled` 与 `failed` 分开（0056） |
| 触发式执行预算/重试 | 已实现（P0-O2，2026-11-10） | 触发执行 `Unattended` + `Budget{MaxSteps:30}`；`POST /api/agent-runs/{id}/retry`、`RunsView` 的「停止 / 重新执行」；`prompt` 落库（0056） |
| 等待确认超时 | 部分实现 | 任务执行有 `confirm_wait_minutes`（默认 10 分钟，`runagent.go:142`）；会话/触发执行无超时 |
| 工具授权与写确认 | 已实现 | 档位 min 计算（`grants.go:70-83`）、confirm/reject（`toolgrants.go:270-360`）、审计 |
| 成本/用量/配额 | **缺失** | 表无 token/成本列，无聚合、无上限 |
| 并发/队列 | **缺失** | `internal/runner/runner.go:4-6` 明写「没有队列、没有并发上限」；`trigger.go:76` 每事件一 goroutine |
| Agent 名册/能力声明/记分卡 | **缺失** | 只有「设置 > Agent」；无独立 Agent 页（`modules/index.ts:5-8`）；无能力字段、无统计（`AgentList.tsx:64` 明说不显示执行情况） |

**Agent 会话（13 项）**

| 能力 | 状态 | 证据 |
|---|---|---|
| 会话列表（分段/条数/Agent 筛选） | 已实现 | `ChatsView.tsx:130-203`、`store/sqlite/agent.go:79` |
| 快速新建（⌘J / 侧栏 / 命令面板） | 已实现 | `Shell.tsx:123-143`、`QuickSession.tsx` |
| 流式对话 / 停止 / 后台跑完落库 | 已实现 | `agent.go:436-503`、`agentstop.go`、`/api/agent/running` |
| 换模型（含「跟随 Agent / 本会话 / 设为默认」） | 已实现 | `sessionmodel.go`、`ModelSwitch.tsx`、0053 迁移 |
| 工具确认卡 / ask_user / 移除历史消息 | 已实现 | `ChatPane.tsx:19-110`、`agent.go:250-290` |
| 会话来源（任务执行 / IM 消息） | 已实现 | `source_ref` + `sessionSources.ts`、`runagent.go:292-301` |
| 项目/对象归属与筛选 | 部分实现（P0-S1，2026-11-10） | `GET /api/agent/sessions?project_id=`：对象归属 ∪ 项目 `props.session_ids`；全局列表加项目下拉（`ChatsView`）；任务抽屉「助手」Tab 仍未做（`object_id` 会话仍只在抽屉外） |
| 搜索 | 已实现（P0-S1，2026-11-10） | `GET /api/agent/sessions?q=` 搜标题 + 消息正文（LIKE 转义），会话页输入防抖后走服务端；列表第二行显示 `last_message`（截 200 字） |
| 上下文治理 | 部分实现（P0-S2，2026-11-10） | `GET /api/agent/sessions/{id}/context` 给「实际会发什么」：40 条窗口、裁掉条数、字符/token 粗估；`agent_sessions.instruction` 会话级追加要求拼进系统提示；**仍无自动压缩/摘要**（`runner.go` 仍按 40 条硬截断） |
| 附件 / 图片 / @对象 / 斜杠命令 | **缺失** | `ChatPane` 只有文本输入（`:253-280`） |
| 会话操作（编辑/重生成/流式排队/断线续传） | 部分实现 | 只有 live 气泡重试（`ChatPane.tsx:240-250`）；刷新后无重试；流式中同页禁发 |
| 组织能力（置顶/归档/标签/导出/分叉） | **缺失** | 表无列、无路由、无 UI |
| 等确认/失败的注意力链 | 部分实现（P0-O3 第一批） | `GET /api/agent/attention` + 今日「Agent 待确认」组 + 会话菜单红点 + 会话列表圆点 + 刷新恢复确认卡已做；仍缺 waiting/failed 通知与确认超时（见附录 C） |

---

## 三、还需要支持的功能（核心清单）

编号规则：`O-*` 人操作 Agent；`S-*` Agent 会话；`T-*` Agent 的操作（工具面）。量级：S ≤ 0.5 天、M 1～3 天、L 1 周以上。

### 3.1 P0：先把主回路收口（约 1～1.5 周）

#### O-1 统一运行中心
- **现状**：执行记录分散在三处——任务抽屉的「执行记录」（task_runs）、会话模块的「执行记录」（agent_runs）、SOP 的「执行记录」（sop_runs）；侧栏没有「运行中」，Agent 执行记录只读，失败不能重跑。`docs/review-2026-11/workbench-review.md` 的 P2 #12「执行中心」仍成立。
- **还需要**：一页看到「正在跑 / 等确认 / 失败 / 停滞」全部执行；能下钻到过程、工具调用、产出、关联对象；能停止、重试、续跑、打开会话；状态语义诚实（失联 ≠ 执行中、请求取消 ≠ 已取消）。
- **最小形态**：新增内核「运行」页（或并入 Agent 中心），后端加一个聚合接口 `GET /api/runs/all`（复用三张表与现有状态），先只做「列表 + 停止 + 重跑 + 打开会话」；不改三套执行引擎。
- **量级**：M～L（后端聚合 S、前端 M）。**已落地第一批（2026-11-10）**：`GET /api/runs/all` 聚合 `agent_runs` + `task_runs`（`kind` 区分、状态/来源过滤、合并排序分页），新内核「运行」模块 `/runs` 一页看全部执行，Agent 行可停止/重新执行/打开会话，task 行可取消/打开任务；SOP 执行仍留在 SOP 自己的页面（见附录 D）。

#### O-2 触发式 Agent 执行的可控性（已落地第一批，2026-11-10）
- **现状**：`Dispatcher.execute`（`trigger.go:369-377`）在 goroutine 里跑，只有 10 分钟超时；没有取消注册、没有步数预算、失败没有重试；等确认的触发执行会永久停在 `waiting`（只有任务执行有 10 分钟确认超时）。
- **还需要**：`POST /api/agent-runs/{id}/stop`；触发执行也走 Budget（默认 30 步/10 分钟）；等确认复用 `confirm_wait_minutes`，超时按拒绝并落审计；失败执行给「重新执行」。
- **最小形态**：Dispatcher 保存每个 run 的 cancel func（内存表即可）；Runner 复用已有 `Budget`；`RunsView` 加停止/重跑按钮；`POST /api/agent-runs/{id}/retry` 重新投递同一条触发。
- **量级**：M。**已做**：stop / retry / `canceled` / `prompt` 落库 / 无人值守 30 步预算 / `RunsView` 停止与重新执行；**未做**：等确认超时（`confirm_wait_minutes` 只覆盖任务执行）、重试时选择模型/Agent、运行中心聚合（O-1）。

#### O-3 等待确认/失败的注意力链（已落地第一批，2026-11-10）
- **现状**：等确认只出现在会话内和执行记录页底部红点；一级菜单无红点（`marks.ts:4` 明说未做）、今日页无「Agent 待确认」、失败无通知；通知中心只消费 `schedule.remind`（`ReminderPopups.tsx`），`GET /api/notifications` 其余通知没有界面消费。
- **还需要**：`agent_run.waiting` / `agent_run.failed` 通知；今日「需要你处理」加 Agent 组（SPEC-1.29）；一级菜单「会话」红点 = 等确认数；会话列表项等待圆点；**刷新后能按会话恢复 pending 调用 id**（普通会话刷新后 call.id 丢了，只能提示「再说一遍」；任务执行建的会话能从执行记录详情找回，但这条路不通用）。
- **最小形态**：通知加两个 kind（notify 已有事件总线）；今日聚合加一张 `agent_waiting` 卡（`agent_tool_calls where state=pending` + `agent_runs where status=waiting`）；新增 `GET /api/agent/tool-calls?session_id=&state=pending` 供 ChatPane 启动时恢复。
- **量级**：M。**已做**：`GET /api/agent/attention`（waiting 执行 + pending 调用，按会话过滤）、今日「Agent 待确认」组、会话菜单红点、会话列表圆点、刷新后恢复确认按钮；**未做**：`agent_run.waiting` / `agent_run.failed` 通知、通知中心消费、等确认超时。

#### S-1 会话归属与检索
- **现状**：会话没有项目维度，列表只拉 `unscoped=true`，项目会话只活在项目 `props.session_ids` 里；任务触发建的会话 `object_id=任务`，既不在全局列表也不在任务抽屉（任务抽屉没有助手 Tab），**等于找不到**；搜索不搜消息正文，列表第二行是「N 条消息」而不是最后一条。
- **还需要**：会话有项目/对象归属与筛选（SPEC-1.5）；搜索标题 + 消息正文 + 最后一条消息摘要（SPEC-1.3/1.8）；任务/IM/项目三种来源的会话都能从对应业务页进入；对象级 AI 助手 Tab 恢复。
- **最小形态**：`agent_sessions` 加 `project_id`（或按 `object_id` join 项目），列表接口支持 `project_id` 与 `q`；`last_message` 由列表 SQL 带出；任务抽屉加「助手」Tab（建 `object_id` 会话 + 复用 `ChatPane`）。
- **量级**：M。**已落地第一批（2026-11-10）**：项目归属不新增列，按 `object_id` 所属项目的对象 ∪ 项目 `props.session_ids` 派生；列表 `project_id`、`q`（标题 + 消息正文，`%`/`_` 转义）、`last_message` / `last_message_at` 都由列表 SQL 一次带出；会话页搜索改服务端（防抖）并显示最后一条消息，加项目下拉。**未做**：任务抽屉「助手」Tab、IM/项目来源的直达入口。

#### S-2 上下文治理最小版
- **现状**：喂模型的历史固定 40 条（`historyLimit`，按条数不按轮次），长会话（已有的 76 条深度会话）实际会丢开头；没有 token 估算/展示、没有摘要/压缩、没有上下文预览、没有会话级指令。
- **还需要**：显示「本次将发送 N 条消息 / 约 M token」，按模型上下文动态裁剪；长会话自动摘要（滚动摘要或手动「压缩上下文」）；「查看本次上下文」抽屉；会话级追加指令（不进 Agent 全局配置）。
- **最小形态**：先做估算展示 + 手动压缩（把旧消息摘要成一条 system/notice，保留原文）；上下文预览只读渲染；会话级指令存 `agent_sessions` 一列，拼在 Agent 指令后。
- **量级**：M。**已落地第一批（2026-11-10）**：迁移 0057 加 `agent_sessions.instruction`；POST/PATCH 可写（≤2000 字，空串清除），`buildHistory` 拼「这次会话的追加要求」系统段；`GET /api/agent/sessions/{id}/context` 返回 40 条窗口、`dropped_count`、`sent_chars`、`approx_tokens` 与逐条 `dropped`；`ChatPane` 加「上下文」面板（统计、裁掉消息置灰、追加要求编辑）。**未做**：自动/手动压缩摘要、按模型上下文动态裁剪、token 精确计量。
- **量级**：M～L。

### 3.2 P1：让 Agent 真正好用（约 3～4 周）

| 编号 | 功能 | 现状/缺什么 | 最小形态 | 量级 |
|---|---|---|---|---|
| O-4 | **Agent 名册 2.0（能力声明 + 状态 + 记分卡）** | 无能力声明、无独立 Agent 页、卡片不显示执行情况（`AgentList.tsx:64`）；派活靠猜谁合适 | `agents.capabilities`（对象类型/工作类型/擅长产出）；`GET /api/agents/{id}/stats`（成功率/平均耗时/最近运行，从 agent_runs 聚合）；列表卡片显示状态与最近执行 | M |
| O-5 | **成本与配额** | 表无 token/成本列，无聚合、无上限；模型选择只能手动 | 复用各供应商响应里的 usage 落库（Ollama 可为空）；按 Agent/项目/时间聚合；每 Agent 日/月预算，超限排队或告警 | M～L |
| O-6 | **并发队列 + 触发治理** | 无并发上限；IM 洪峰每个事件一 goroutine；task 触发去重 key 固定 `task:<对象id>`（同一 Agent 对同一任务一生只触发一次，改派不再触发）；定时任务 Agent 动作只能手填编号（`ScheduleDrawer.tsx:272`） | 每 Agent 信号量 + 全局上限 + `queued` 状态；触发 key 带"分配/标签变化版本"；定时任务改 Agent 下拉；trigger 诊断「为什么没触发」（仿 SOP `explain_im_trigger`） | M～L |
| O-7 | **批量派单 + 模板库** | 只有单对象派单；角色是全局预设，不能按 Agent/场景存模板 | 任务列表多选「批量交给执行」；`run_prompts` 加 `agent_id`/场景绑定；支持把一次成功执行「存为模板」 | M |
| S-3 | **会话输入能力** | 只能纯文本，无附件/图片/文件/@对象/斜杠命令 | 输入框附件上传（图片走多模态 content parts，文件落 attachments 并让 Agent 用工具读）；@ 用 `search_objects` 选对象注入上下文；斜杠命令映射技能/常用指令 | M～L |
| S-4 | **会话操作与组织** | 无编辑/重生成/流式排队/断线续传；无置顶/归档/标签/导出/分叉 | 消息级重试与重生；流式中排队一条；SSE 断线重连；`pinned/archived/tags` 列 + PATCH；会话导出 md、复制为新会话 | M |
| S-5 | **产出与对象闭环** | 本地文件产物只能看/复制路径，不能打开/Finder；不能改归属、不能转文档；拒绝写操作无原因 | 复用 `POST /api/fs/open`（放宽到会话 workdir）；产物行加打开/Finder；`PATCH artifacts` 改 object_id 的 UI；产出→doc 一键；拒绝时选原因（方向不对/粒度太粗/事实错误/缺上下文）并回灌下次派单 | M |
| O-8 | **配置版本/快照与审计** | Agent 配置无版本；执行记录只存 agent_id，无法追溯产出用哪版配置；换模型/改名/建会话不记审计 | Agent 保存递增 version + 快照 JSON；执行记录存 version；sessionmodel 等写操作补审计 | M |
| T-2 | **内置工具补齐（工具面）** | 11 项内置能力里 4 项空挂（IM 读/回、联系人读/写）；无文档对象读写、无提醒工具；写操作无 diff 预览/幂等 | 补 4 个内置工具（IM 读/回、联系人读/写）+ 文档/提醒工具；写前预览与幂等键；危险工具默认 confirm | M |
| T-1 | **通知中心 + 未读体系** | 通知只弹提醒，其余 284 条未读无入口；无会话未读 | 通知列表页 + 未读角标 + 按 kind 筛选；会话加 `read_at` | M |

### 3.3 P2：规模上来再做

| 编号 | 功能 | 说明 |
|---|---|---|
| O-9 | **外部 Agent 接入协议 2.0** | MCP 已有 claim/report/回写（`docs/mcp.md`），但没有外部 Agent 注册/能力声明/心跳/配额/反向上报 agent_run；`docs/design-pipeline-agent.md` 的 executor 抽象未落地。等外部 Agent 真要用时再做。 |
| O-10 | **多 Agent 协作** | 接力（上一个产出作为下一个输入）、并行批次、结果对比。2026-09 文档已列，但当前 24 次执行/8 天的量还撑不起；先让单 Agent 派单闭环。 |
| S-6 | **会话级配置覆盖** | 会话内临时改指令/工具授权/思考档位/参数（现在只能改 Agent 全局或模型）。 |
| S-7 | **会话分析与评测** | 回复质量反馈（好/差+原因）、按模板的采纳率/返工率、执行回放；这是记分卡的数据来源。 |
| S-8 | **语音/录音接入** | 录音转写插件（未提交）已在做；做通后可把会议纪要直接生成会话/任务，不必单独做会话语音。 |

### 3.4 补充：Agent 的操作能力（工具面）还需要补什么

`grants.go:25-37` 声明了 11 项内置能力，但**有 4 项没有对应工具**（`docs/api-contract.md:744` 自认）：`read_messages`、`reply_message`、`read_contacts`、`write_contacts`。也就是说：Agent 能建任务、改任务、写文件、查 SOP、调连接器，但**读不了 IM 消息、回不了消息、看不了联系人**；`write_content` 实际是写本地文件，不是建文档。

| 工具面 | 现状 | 还需要 |
|---|---|---|
| 工作对象 | `search/list/get/create/update` + 进展 + 父子任务 | 批量更新、归档/删除（现在是刻意不给删除）、按对象类型校验的写前预览 |
| 文档 | `write_file` 落本地文件 | 创建/更新 `doc` 对象、读文档正文、附件读取 |
| IM | 触发时把消息事实写进 prompt，但无读/回工具 | `read_messages`（按会话/范围）、`reply_message`（走连接器，确认档） |
| 联系人 | 无工具 | `read_contacts` / `write_contacts`（确认档） |
| 日程/提醒 | 无工具 | 建提醒/定时任务（确认档） |
| SOP | 完整（list/get/create/update/run/test/explain） | — |
| 连接器 | Slack / Google / 自定义 MCP / OpenAPI 可调 | 超时与重试策略、结果摘要统一、危险工具默认 confirm |
| 安全 | 确认/reject/审计齐；无删除工具 | 写前 diff/预览、幂等键、批量确认、拒绝原因回流 |

这部分不新起模块：补 4 个内置工具 + 2 个安全能力（预览、幂等）即可，量级 M，作为 P1 的 T-2 和名册/派单同批做。

---

## 四、建议路线图与验收

### 批次一（P0，约 1～1.5 周）
1. 触发执行 stop + Budget + 确认超时 + 失败重跑（O-2）
2. 运行中心最小版：列表 + 停止 + 重跑 + 打开会话（O-1）
3. 注意力链：两个通知 kind + 今日 Agent 卡 + 会话红点 + 按会话查 pending（O-3）
4. 会话归属：`project_id`、搜索正文、last_message、任务抽屉助手 Tab（S-1）
5. 上下文：token 估算展示 + 手动压缩 + 上下文预览（S-2）

**验收标准（可测）**：
- 一条 IM 触发执行在跑时，能在运行中心看到并点「停止」，10 秒内状态变「已停止」；
- 触发执行等确认 10 分钟后自动按拒绝收尾，并产生一条通知；
- 今日页出现「Agent 待确认 N」，点进去能直接确认/拒绝；页面刷新后确认卡仍能点；
- 会话页能按项目筛选，搜索能命中消息正文；任务抽屉能看到该任务的 Agent 会话；
- 会话头部显示「约 N token / M 条历史」，点「压缩上下文」后长会话仍能继续。

### 批次二（P1，约 3～4 周）
名册与记分卡 → 成本配额 → 并发/触发治理 → 批量派单与模板 → 会话输入/操作/组织 → 产出闭环 → 配置版本与审计 → 通知中心 → 内置工具补齐。

### 批次三（P2）
外部 Agent 接入、多 Agent 协作、会话级配置、评测、语音——按真实使用量决定，不预先建设。

### 明确不做
- 多用户/账号/云同步/团队协作：产品定位是单机单用户（`docs/review-2026-11/`），做多用户会把权限模型推倒重来；
- 通用 Agent 编排 DSL：SOP 已经是编排层，不重复造；
- 第三方 Agent 市场/插件生态：先把「能接活」的闭环跑通；
- 全量多模态/长视频：附件先做图片与文件，语音等录音插件；
- 为 Agent 新开一个一级模块：优先并进「会话」和「设置」，避免第 13 个模块（评审 §0 结论）。

---

## 五、优先级判断的三条依据

1. **使用数据**：22 会话 / 24 执行 / 9 次确认，说明功能是「有人在用，但节拍没形成」。先补「看得到、停得下、找得到」，比加新能力更能提升使用量。
2. **失败成本**：目前 3 条失败执行无重试、等确认平均 31 分钟无人处理、284 条未读通知——不是能力问题，是注意力与恢复机制问题；这类成本每天都在累积。
3. **既有资产**：运行中心、注意力链、会话归属、成本统计都不需要新引擎：三张执行表、事件总线、notify、agent_runs、artifacts、SOP 的执行记录页都是现成的，主要是聚合与入口工作。真正的新东西只有「上下文压缩」与「成本采集」两块，其余是收口。

---

## 附录 A：数据事实（读于 2026-11-10 14:53，只读）

```sql
-- 会话与消息
SELECT COUNT(*) FROM agent_sessions;                                  -- 22
SELECT COUNT(*) FROM agent_messages;                                  -- 190（tool 110 / user 37 / assistant 43）
SELECT COUNT(*) FROM agent_sessions s WHERE NOT EXISTS (SELECT 1 FROM agent_messages m WHERE m.session_id=s.id); -- 6
SELECT session_id, COUNT(*) c FROM agent_messages GROUP BY 1 ORDER BY c DESC LIMIT 3; -- 76 / 21 / 13

-- 执行
SELECT status, COUNT(*) FROM agent_runs GROUP BY status;              -- done 21 / failed 3
SELECT trigger_kind, COUNT(*) FROM agent_runs GROUP BY 1;             -- im 24
SELECT state, COUNT(*) FROM agent_tool_calls GROUP BY state;          -- confirmed 9
SELECT tool, COUNT(*) FROM agent_tool_calls GROUP BY tool;            -- update_object 9
SELECT mode, COUNT(*) FROM agent_tool_grants GROUP BY mode;           -- auto 49
SELECT harness, status, COUNT(*) FROM task_runs GROUP BY 1,2;         -- claude done 12/canceled 1, agent done 1/failed 1, deepseek 0

-- 通知与产出
SELECT COUNT(*), SUM(read_at IS NULL) FROM notifications;             -- 290 / 284
SELECT kind, COUNT(*) FROM notifications GROUP BY kind;               -- task.review_requested 267, run.finished 15, schedule.remind 6, etf.anomaly 2
SELECT source, COUNT(*), SUM(session_id<>'') FROM artifacts GROUP BY source; -- mcp 275/session 0, run 140/0, manual 3/0, agent 0
```

## 附录 B：关键证据索引

| 主题 | 文件 |
|---|---|
| 触发执行（无 stop/预算） | `internal/agent/trigger.go:39,369-377` |
| 任务执行预算/确认超时 | `internal/api/runagent.go:38-44,142,521,571` |
| 上下文硬截断 | `internal/agent/runner.go:92-94,479-501` |
| Agent 执行记录只读 | `internal/api/agentruns.go`、`frontend/src/modules/conversations/RunsView.tsx` |
| 会话列表仅全局 | `frontend/src/core/data/agent.ts:93-94`、`internal/api/agent.go:35-51` |
| 菜单红点未做 | `frontend/src/core/shell/marks.ts:4` |
| 今日无 Agent 组 | `internal/api/today.go`、`frontend/src/modules/today/Page.tsx` |
| 通知只两类 | `internal/notify/notify.go:4,83-90` |
| 工具面 4 项空挂 | `internal/agent/grants.go:25-37`、`docs/api-contract.md:744` |
| 角色是全局预设 | `internal/api/runprompts.go`、`frontend/src/modules/settings/runprompts/` |
| 规格对照 | `web-next/docs/spec/sessions.md`（S-2.12、S-1.29、S-1.5、S-1.3、S-4.5） |
| 既有产品判断 | `docs/agent-product-features.md`（2026-09-15）、`docs/review-2026-11/workbench-review.md` §6 #10、P2 #12 |

## 附录 C：P0 第一批落地（2026-11-10）

范围：O-2（触发执行可控）+ O-3（等确认注意力链）的后端与前端。O-1 运行中心、S-1 会话归属与检索、S-2 上下文治理同一天由第二批落地，见附录 D。

### C.1 执行可控（O-2）

- 迁移 `0056_agent_run_control.sql` 重建 `agent_runs`：`status` 加 `canceled`（手动停止，不是失败）、新增 `prompt`（这次执行交给 Agent 的第一句话，重试用）；旧行数据保留、`prompt` 空串、索引全部重建，升级在真实库副本上验证过（24 条记录保留）。
- `internal/agent/trigger.go`：Dispatcher 维护并发安全的 run → cancel 表；`Stop(runID)` 取消上下文，`Retry(ctx, run)` 新建执行记录 + 新会话；`execute` 按 `ctx.Err()` 区分手动停止与超时，`SettleRun` 把停止记 `canceled`、总结固定「已手动停止，已经执行的操作不会撤回。」
- API：`POST /api/agent-runs/{id}/stop`（200 / 409 / 404）、`POST /api/agent-runs/{id}/retry`（202，仅 `failed` / `canceled` 且 `prompt` 非空；`event_key` 空串不占原事件去重键，会话标题「重试 · 」+ 原触发说明）。
- 无人值守：触发执行 `Unattended=true` + `Budget{MaxSteps: 30}`；确认后接着跑（run_id 非空）同口径，不再给模型 `ask_user`。
- 前端：`AgentRunStatus` 加 `canceled`；执行记录页加「停止」「重新执行」、状态筛选/计数认 `canceled`；`RunsView.test.tsx` 覆盖停止、重试、已停止。

### C.2 注意力链（O-3）

- API：`GET /api/agent/attention?session_id=` → `{total, pending_calls, waiting_runs}`；`total` = pending 调用数；按会话过滤；空数组不返回 `null`；补 Agent 名、会话标题；上限各 100 条。
- 前端：`useAgentAttention` 30 秒轮询（失败按空处理）；今日「需要你处理」加「Agent 待确认」组（点了打开会话）；一级菜单「会话」红点（悬停「N 个 Agent 调用等你确认」）；会话列表项等待圆点；`ChatPane` 把 pending 调用 id 合并进确认卡引用，**页面刷新后历史里的确认卡也能点**（原先只有任务执行建的会话能从执行记录找回）。
- 已知限制：没有新增 `agent_run.waiting` / `agent_run.failed` 通知（等通知中心，P1）、等确认超时仍只覆盖任务执行（`runagent.go` 的 `confirm_wait_minutes`），O-3 先靠注意力链把等待浮出来。

### C.3 验证

- `go build ./...` 通过；`go test ./internal/agent ./internal/store/sqlite ./internal/api` 全绿（含契约文档/形状测试）；`gofmt -l` 改动文件为空。
- `cd frontend && pnpm typecheck` 通过；`RunsView` / `ChatsView` / `ChatPane` / `marks` / `today Page` / `agents` 相关 vitest 44 用例通过。
- 契约文档 `docs/api-contract.md` 已补 stop、retry 两个接口、`AgentRun.prompt`、`status=canceled` 与「Agent 注意力 attention」小节。

### C.4 第二批（同日已落地，见附录 D）

| 编号 | 内容 | 建议起手 |
|---|---|---|
| O-1 | 统一运行中心：一页看到正在跑 / 等确认 / 失败 / 停滞，可下钻、停止、重试、打开会话 | 先做后端聚合 `GET /api/runs/all`（三张执行表 + 现有状态），前端加「运行」页；O-2 的 stop/retry 直接复用 |
| S-1 | 会话归属与检索：项目/对象维度、按 `q` 搜标题与消息正文、列表带最后一条消息、任务抽屉「助手」Tab | `agent_sessions` 归属列 + 列表 SQL 带 last_message + 任务抽屉复用 `ChatPane` |
| S-2 | 上下文治理最小版：显示将发送条数/约 token、手动压缩摘要、上下文预览、会话级指令 | 基于 `runner.historyLimit` 先做估算展示与手动压缩，再做动态裁剪 |

## 附录 D：P0 第二批落地（2026-11-10）

范围：O-1 统一运行中心、S-1 会话归属与检索、S-2 上下文治理最小版（后端 + 前端）。至此 P0 五件都有第一批可用形态；剩余缺口见 D.5。

### D.1 统一运行中心（O-1）

- 后端 `GET /api/runs/all`：聚合 `agent_runs`（kind=agent）与 `task_runs`（kind=task），`status` / `source` CSV 过滤、`limit`（默认 50，上限 200）/ `offset`、按 `started_at` 倒序合并、`meta.total` 为两类过滤后总数；task 行先 `reapStale` 收尾再输出。store 加 `ListAllTaskRuns`（LEFT JOIN objects 带 ref/title，同条件 COUNT）。
- 前端新增内核模块「运行」（`frontend/src/modules/runs/`，路径 `/runs`，菜单「沟通」组、工作区目录/图标同步注册）：状态 tab（全部/执行中/等你确认/失败/已完成/已停止）、来源筛选（Agent / 任务）、行内停止/重新执行（Agent，复用 O-2 的 stop/retry）、取消（task）、打开会话 / 执行记录 / 任务抽屉；有 running 时 5 秒轮询。
- 已知边界：SOP 执行仍只在 SOP 自己的执行记录页；深页码依赖两侧各取 `offset+limit` 再合并，Agent 侧沿用既有 waiting 优先排序。

### D.2 会话归属与检索（S-1，无迁移）

- `GET /api/agent/sessions` 新增 `q`（标题 + 会话内消息正文，SQLite LIKE 对 ASCII 大小写不敏感、`%`/`_` 转义）与 `project_id`（`object_id` 属于该项目的对象上的会话 ∪ 项目对象 `props.session_ids`，给了它时忽略 `unscoped`）；三种范围都不给仍返回空列表。
- 列表项新增 `last_message`（最后一条消息正文，截 200 字）与 `last_message_at`（`omitzero`，无消息不出键），由列表 SQL 相关子查询一次带出。
- 前端会话页：搜索改服务端（300ms 防抖）、列表第二行显示最后一条消息（没有消息才回「N 条消息」）、项目下拉筛选；保留 Agent 筛选、空会话清理、分组。
- **未做**：任务抽屉「助手」Tab（`object_id` 会话目前仍只能从对象抽屉外找到）、IM / 项目来源会话的直达入口。

### D.3 上下文治理最小版（S-2，迁移 0057）

- 迁移 `0057_agent_session_instruction.sql`：`agent_sessions.instruction TEXT NOT NULL DEFAULT ''`；真实库副本验证 22 条会话全部保留、默认空串。
- `POST /api/agent/sessions` / `PATCH /api/agent/sessions/{id}` 接受 `instruction`（去空白、≤2000 字、空串清除）；`internal/agent` 的 `buildHistory` 在系统提示（含来源、Agent 指令、技能）之后拼「这次会话的追加要求」段，空指令不加。
- `GET /api/agent/sessions/{id}/context`：`history_limit`（40）、`total_messages`、`dropped_count`、`sent_chars`、`approx_tokens`（字符数 / 2 粗估）、逐条 `dropped` 标记、以及当前 `instruction`；会话不存在 404。
- 前端 `ChatPane` 加「上下文」面板：统计「将发送最近 40 条（总 N 条，前 M 条已裁掉）· 约 X tokens」、裁掉消息置灰标注、会话追加要求 textarea（回显已存值，保存 PATCH）。
- **未做**：自动/手动压缩摘要、按模型上下文动态裁剪、精确 token 计量；40 条硬截断仍在。

### D.4 验证

- `go build ./...` 通过；`go test ./internal/store/sqlite ./internal/api ./internal/agent` 全绿（含契约文档/形状测试）；`gofmt -l` 改动文件为空；迁移 0057 在真实库副本上验证。
- `cd frontend && pnpm typecheck` 通过；`vitest run src/modules/runs src/core/shell src/modules/conversations/ChatsView.test.tsx src/core/chat/ChatPane.test.tsx` 99 用例通过。
- 契约文档 `docs/api-contract.md` 已补 `GET /api/runs/all`、`GET /api/agent/sessions/{id}/context`、会话列表 `project_id`/`q`、`instruction` / `last_message` 与「统一运行中心」「会话归属与检索」「会话级追加要求与上下文预览」三节。

### D.5 P0 剩余（下一批候选）

| 缺口 | 说明 |
|---|---|
| 任务抽屉「助手」Tab | 让 `object_id` 是任务的会话能就地打开（复用 `ChatPane`），S-1 的归属闭环才算完整 |
| 等确认超时 | 会话 / 触发执行的等待确认仍无超时；`confirm_wait_minutes` 只覆盖任务执行 |
| 通知 | `agent_run.waiting` / `agent_run.failed` 仍没有通知 kind，今日/红点之外缺少被动提醒 |
| 上下文压缩 | 手动「压缩上下文」+ 按模型上下文动态裁剪；当前只做预览与估算 |
| 运行中心深水区 | SOP 执行并入、跨页游标、按项目/Agent 维度统计 |

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
