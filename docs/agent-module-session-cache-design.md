# 模块维护会话与 API 缓存命中设计

状态：设计稿（2026-11-12），未实现。读者：需要决定「是否做、怎么做」的人。
范围：任务执行走 **DeepSeek Harness（dsh）执行器**（`harness=deepseek`）时，如何把任务分派到「历史执行过同一功能模块的维护会话」，提高服务商前缀缓存（KV Cache）命中率、降低远程 API 成本；以及为此「会话这一层的插件/模块」要改什么。

> 一句话结论：**方向可行，但它不是「会话复用」一个开关，而是一组前缀稳定性 + 命中率门槛 + 失效熔断的工程约束。**
> 命中时输入 token 按更低单价计（DeepSeek 官方价目里缓存命中约为未命中的 1/10，以实际价目为准）；
> 但缓存**未命中却复用了长会话**时，一次就要按全价重发整段历史——所以「先度量、再路由、低命中就降级」是前提，不是可选项。

---

## 一、缓存为什么能省，以及它的硬条件

服务商（DeepSeek / OpenAI / Anthropic / Gemini 等）的上下文缓存是**前缀缓存**：一次请求里，从第一个 token 开始到某个位置、与上一次请求逐字节相同的那一段，可以按缓存读计价。dsh 自己的文档把规则写得很明确：

- **前缀复用要求在同一提供方与模型路由下，此前消息和声明保持逐字节一致**（`@deepseek-ai/dsh-agent-loop` README「KV Cache 影响」）。
- **历史只追加不替换**时保留可复用条目；**表层替换或压缩会从第一个被遮蔽的历史 token 起使复用失效**（同上；`@deepseek-ai/dsh-session`「模型体验」）。
- **系统提示原地替换**会从该节点第一个 token 起失效；声明了 `systemPromptUpdate: 'in-history'` 的路由，把变更**追加到已缓存历史之后**，之前的前缀仍可复用。**工具定义变化**会从第一个变化的 token 起失效（同上）。
- **模型/服务商切换**会进入不同的缓存域；切换模型可能无法复用原模型缓存（`@deepseek-ai/dsh-agent`「可选的模型切换提示」）。
- dsh 已经能把服务商的缓存指标映射进 harness 用量桶（`dsh-llm-deepseek`：`cacheReadTokens`/`cacheWriteTokens`；`dsh-llm-pi-ai` 也会把 pi-ai 的 `usage.cacheRead` 映射成 `cacheReadTokens`），并有 `dsh-token-meter`/`dsh-session-stats` 投影。也就是说 **dsh 会话日志里本来就有 cache read 数据可读**。

因此「分派到历史维护会话」能命中缓存，需要**同时**满足：

| # | 条件 | 违反时的后果 |
|---|---|---|
| 1 | 同一 provider、同一 model、同一 endpoint（同一缓存域） | 全新缓存域，命中率为 0 |
| 2 | 渲染后的系统提示逐字节相同（含当前日期等动态片段） | 从变化处起全 miss |
| 3 | 工具声明逐字节相同：工具集合、顺序、schema 都不变 | 从第一个变化 token 起 miss |
| 4 | 历史只追加：没有 replace、压缩、裁剪、图片省略 | 从被遮蔽处起 miss |
| 5 | 复用的是**同一个 dsh 会话**（同一段持久化日志），且 cwd / preset / profile 记录一致 | dsh 会拒绝 resume，或重建出不同前缀 |
| 6 | 上一轮距离现在足够近，缓存仍热（DeepSeek 磁盘缓存按小时～天计，不保证） | 长会话按全价重发，成本反而放大 |
| 7 | 权限/沙箱/审批配置不在两次之间变化（如果它们进入提示词或工具面） | 前缀变化，miss |

**结论：复用会话本身不产生缓存；产生缓存的是「同一段前缀字节连续两次被发送」。**

---

## 二、现状（pmw 这一侧）

pmw 的 dsh 执行器是**一次任务一个 headless 进程**：

- `internal/runner/dsh.go`：`buildDSHArgs` 用 `dsh --profile headless --patch <临时 patch> --json -`，任务走 stdin；会话 id 从 `session` 事件取回，落 `task_runs.harness_session`（0050）；续跑时 `--session-id` 沿用同一 Session。
- `internal/api/run.go`：`resume_session` 目前只按「**这个对象**上一次同执行器的执行」找会话（`lastHarnessSession(ctx, objectID, harness)`，`run.go:689`），没有模块维度，也没有前缀校验。
- 每次执行现拼一份 dsh patch（模型路由、agent-loop、沙箱、审批、MCP），模型/工作目录/权限档位都是**每次请求传入**的；工作目录一变，dsh resume 的 cwd 校验就会拒绝。
- 任务提示词每次重建（`internal/runner/prompt.go` 的 `BuildPrompt`/`BuildAgentPrompt`），包含执行 id、日期、任务快照等；这些如果落在系统提示里会破坏前缀，落在 user 消息里则只影响尾部（安全）。
- **没有 token/成本/缓存命中采集**：`task_runs`、`agent_runs` 没有 usage 列，dsh 的 `--json` 事件流（`session/status/text/thinking/tool_call/tool_result/final`）也不带 usage；目前只能从 dsh 持久化会话日志（`~/.dsh/sessions/<cwd>/<sid>/session.vN.jsonl.zstd`，Assistant message 的 `usage` 含 cacheReadTokens）或 dsh 的投影缓存里读。
- 会话模块（`agent_sessions`）是给 `harness=agent` 和人工对话用的：`internal/agent/runner.go` 每轮重建系统提示、只回灌最近 40 条（`historyLimit`）。**这两点都会破坏前缀**，所以「pmw 自己的 Agent 会话」目前也不具备稳定缓存的前提。

补充一个容易忽略的事实：pmw 的 dsh 路由走的是 `llm-pi-ai`（OpenAI 兼容路由），不是 dsh 官方 `llm-deepseek` 适配器；不过 pi-ai 的 OpenAI 兼容实现会把 `prompt_cache_hit_tokens` 映射成 `cacheRead`，所以 DeepSeek/OpenAI 兼容端点的命中数据理论上仍可拿到。

---

## 三、目标模式：模块维护会话

### 3.1 模型

- **路由键（routing key）**：`(module_key, agent_id, provider, model, workdir, preset, permission_mode, tools_hash, prompt_hash)`。
- **模块标识 `module_key`**：先做**显式、可解释**的来源，按优先级：
  1. 任务对象 `props.module` / 自定义字段；
  2. 任务所属项目（project）→ 项目上配置的「模块」；
  3. `workdir` 归一化（仓库 + 相对目录）；
  4. 关联仓库 `props.repo` + 目录。
  没有明确模块时**不复用**（宁可新会话）。
- **维护会话**：一个路由键对应一条「当前代」dsh 会话（`kind=maintenance`），只追加、不替换；同一路由键的多个任务**串行**跑（一个会话同时只能跑一轮）。
- **代际（generation）**：历史增长接近上下文阈值（或跨天/跨周、模型/工具变化）时「换代」：新建一条会话 + 一段交接简报（模块现状、上几轮任务结论、未决问题），旧会话归档只读。换代 = 冷缓存，成本要按摊销看。
- **任务流**：任务到达 → 解析路由键 → 校验会话指纹/热度和空闲度 → 命中则 `--session-id` 追加任务提示；不命中则新会话并把它注册为该模块的当前代；busy 时排队（或按策略降级新会话）。

### 3.2 两种复用粒度（建议都实现开关）

| 粒度 | 做法 | 命中面 | 优点 | 缺点 |
|---|---|---|---|---|
| **前缀复用**（低风险） | 每任务新会话，但会话开头带同一段「模块简报 + 系统提示 + 工具声明」 | 只命中固定的模块前缀 | 不串任务历史、上下文不膨胀、无串行约束 | 省的是固定前缀那一段，任务多时收益有限 |
| **整段会话复用**（本设计目标） | 同一 dsh 会话追加任务，历史全保留 | 命中「系统+工具+此前全部任务」 | 省得多，尤其是上一轮工具结果很多时 | 会话串行、上下文膨胀、质量/污染风险，冷启动时反而贵 |

推荐：**默认「整段复用」，但必须过热度和熔断门槛；前缀复用作为降级/冷启动形态**。

### 3.3 dsh 侧实现形态（两条路）

| 方案 | 做法 | 前缀稳定性 | 工作量 | 风险 |
|---|---|---|---|---|
| **A. headless + `--session-id`**（先做） | 沿用现有一次一进程；续跑同一会话；pmw 记录并校验路由键/前缀指纹 | 中：dsh 文档明说「新建或恢复的实例可能建立不同前缀」（`@deepseek-ai/dsh-agent`「模型体验」），需要实测前缀是否逐字节一致 | S～M | 前缀漂移导致命中率不稳定 |
| **B. 常驻会话进程**（更稳） | pmw 用 `dsh --profile acp`（或 SDK JSON-RPC）常驻，每个模块会话持有 Agent 句柄，任务以 prompt 追加 | 高：文档说「会话前缀在循环实例内保持稳定」（`@deepseek-ai/dsh-agent`） | L | 常驻进程管理、沙箱/权限、崩溃恢复、事件桥接；需要新增执行器形态 |

建议先用 A 做**实验验证**（同一会话连续续跑两次，读会话日志看 `cacheReadTokens` 是否显著大于 0、前缀是否稳定），再决定是否投资 B。

---

## 四、会话这一层要做的调整

「会话的插件」在这里分两层：**pmw 的会话模块/执行器插件**（内核 + 前端）和 **dsh 的会话与压缩插件组合**（profile/patch 配置）。两层都要动。

### 4.1 数据层（迁移 0058 起）

新增表 `session_routes`（路由键 → 会话）：

| 列 | 说明 |
|---|---|
| `routing_key` | 主键，路由键规范化后的哈希/字符串 |
| `module_key` | 模块标识（可空，空表示不是模块会话） |
| `agent_id` / `provider_id` / `model` | 缓存域的一部分 |
| `workdir` / `preset` / `permission_mode` | resume 校验与配置稳定性 |
| `harness_session` | dsh 会话 id（`task_runs.harness_session` 同源） |
| `prompt_hash` / `tools_hash` | 最近一次成功执行的前缀指纹（系统提示 + 工具声明） |
| `generation` | 第几代 |
| `parent_session_id` | 换代关系（旧代归档） |
| `state` | `active` / `rotating` / `retired` |
| `last_used_at` / `last_hit_ratio` | 热度与命中率 |
| `created_at` / `updated_at` | |

执行记录补 usage（`task_runs`，`agent_runs` 同样加）：

- `cache_read_tokens`、`cache_write_tokens`、`uncached_input_tokens`、`output_tokens`
- `cost_estimate_micros`（按服务商价目估算）
- `prompt_hash`、`tools_hash`、`session_generation`
- `cache_hit_ratio`（`cache_read / (cache_read + uncached_input)`）

> 没有这些列，后面的「命中率门槛」「熔断」都无从谈起；这是第一批必须做的。

### 4.2 服务层（pmw）

1. **路由解析器**（新包，如 `internal/sessionroute`）：`Resolve(task, agent, provider, workdir, mode) → *StoreSessionRoute`。校验：provider/model/route 相同、workdir 相同、preset/权限配置相同、`prompt_hash`/`tools_hash` 与当前拼装结果一致、状态 `active`、热度在窗口内、会话未被压缩过（或压缩点记录到最后一次请求之后）。
2. **改续跑规则**：`lastHarnessSession` 从「同对象最近一次」扩展为「按 `session_routes` 查路由键」；`POST /api/objects/{id}/run` 增加 `session_mode: auto | reuse | new`（默认 `auto`），响应/`start` 事件带上 `session_reuse`、`session_id`、`generation`、`cache_expected`。
3. **串行租约与队列**：`session_routes` 加 `owner_run_id`/`lease_until`；busy 时任务进持久队列（`task_runs.status=queued`）或按策略降级新会话；进程崩溃后把 stale running 队列恢复/失败（与现有 `reapStale` 同口径）。
4. **前缀稳定性**（关键，代码级约束）：
   - 系统提示**快照化**：模块会话第一次执行时把渲染后的系统提示（含 agent instructions、来源、技能）整体快照存 `prompt_hash`；后续每轮必须能证明它逐字节不变，否则换代。对 `harness=agent` 路径，`internal/agent/prompt.go` 现在每轮拼 `time.Now()`/对象/技能；要改成「核心提示冻结 + 动态片段放到 user 消息」。
   - 工具声明稳定：同一路由键内不增删工具、不改 MCP server 名/工具 schema/顺序；工具集变化 → 换代。
   - 任务里的动态内容（执行 id、日期、任务快照）只放**尾部 user 消息**，不要进系统提示。
   - dsh patch 对同一路由键保持等价（模型路由、agent-loop、沙箱/审批、MCP 配置不变）；变即换代。
5. **命中采集与熔断**：
   - 读 usage：优先用 dsh 持久化会话日志（`~/.dsh/sessions/.../session.vN.jsonl.zstd` 的 assistant `usage`，含 cacheRead/uncached），需要 zstd 解码（pmw 加依赖，或用 `compression: none` 的 patch 让日志可逐行读）；也可以推动 dsh headless 在 `--json` 里补 usage 事件（上游改动）。
   - 每次执行后算 `cache_hit_ratio`，写 `task_runs`。
   - 熔断：连续 N 次低于门槛（例：首轮应 >0.5，稳定后 >0.8；门槛按成本公式算）→ 该路由键停止复用，降级为新会话并记录原因；会话被压缩/模型切换/工具变化 → 标记 `stale`，下次换代。
   - 热度窗口：超过服务商缓存保留窗口（保守取 30–120 分钟，配置项）未使用的会话，视为冷，**不**直接续跑到长历史里；先新会话并把模块简报作为稳定前缀。
6. **换代与交接**：阈值（上下文窗口 70–80%）或组织变化（跨天/跨周、模型/工具变更）触发；换代时生成简报（可由模型总结上一代，注意这次总结调用本身可以复用旧前缀，成本低）；新一代 vs 旧代关系落库，前端可追溯。
7. **dsh 侧配置**：
   - headless profile 已组合 `sessionPersistence` + `sessionQuery`（`--session-id` 依赖它们）；建议把持久化根目录固定到 pmw 数据目录（patch `session-persistence-jsonl.root`，具体条目 id 以实际 profile 为准，`compression` 可选 `none` 方便读 usage）。
   - **压缩策略要统一**：`dsh-compaction-basic` 达到阈值自动摘要，会让后续前缀失效一次；模块会话建议把自动压缩阈值调高/关闭，由 pmw 在 70–80% 时主动换代，避免「模型自己压缩」不可控。`dsh-compaction-tool-result-pruner` 只在压缩时修剪，保留；`dsh-command-compact` 是人工命令，headless 不涉及。
   - `dsh-agent-instructions` 的发现结果（AGENTS.md/项目规则）会改变系统提示：模块会话要固定 include 集合，文件内容变化视为换代。
   - 工具声明：MCP `pmw-run` 固定；不要按任务动态开关工具/连接器；需要动态工具时用支持 `toolUpdate` 的路由（dsh 文档提到 DeepSeek-V4.1-Flash 等），否则每次工具 schema 变化都会断缓存。
8. **契约与文档**：`docs/api-contract.md` 补 `session_mode`、运行中心/执行记录的缓存与成本字段、`/api/session-routes` 系列接口（列出/重置模块会话）。

### 4.3 前端（会话模块 / 运行中心）

- 任务发起弹窗（`HandOff`/`AgentHandOff`）：加「复用模块维护会话」开关 + 预估收益/冷启动提示，默认按 `auto` 策略；显示上次该模块命中率。
- 会话页：新增「模块维护会话」视图/筛选（按 module_key、代际、状态），显示命中率、估算成本、最近任务；提供「重置该模块会话」「查看交接简报」。
- 运行中心/执行记录：加缓存命中率、token 与估算成本列；Agent 行/任务行都显示是否复用了会话。
- 设置页：模块→路由的显式映射（第一阶段手工维护）、热度窗口、换代阈值、复用开关与熔断阈值。

---

## 五、成本模型与门槛（决定「值不值得复用」）

设：新任务的 user 消息为 `T`；不使用复用时固定提示（系统+工具）为 `S`；复用时前缀里已有历史为 `H`（`H ≥ S`）；命中率 `r`；命中单价是未命中的 `α` 倍（DeepSeek ≈ 0.1，Anthropic 缓存读 ≈ 0.1、缓存写 ≈ 1.25）。

- 不复用成本（近似，忽略输出）：`S + T`
- 复用成本：`H·(α·r + (1−r)) + T`

复用划算的条件：`r > (1 − S/H) / (1 − α)`。例：`H=50k, S=10k, α=0.1` → `r > (1−0.2)/0.9 ≈ 0.89`。也就是说**长会话要命中 90% 左右才比新会话便宜**；命中率 50% 时会贵出一倍以上。这说明：

1. 必须**记录并展示命中率**，按任务/模块维度看趋势；
2. 「冷启动」任务不要塞进长会话（先新会话或前缀复用形态）；
3. 命中率低时熔断，恢复新会话；
4. 换代的冷启动成本要摊销（比如换代后前几轮优先小任务）。

---

## 六、落地建议（MVP 顺序）

1. **先度量**（1～2 天）：加 usage 采集（解析 dsh 会话日志或补 headless 事件）+ `task_runs` 列 + 运行中心显示；同时跑一个**前缀稳定性实验**：同一 dsh 会话顺序跑 2–3 个任务，读 cacheReadTokens 看是否命中、命中多少。实验不通过就先别做路由。
2. **路由最小版**（2～3 天）：`session_routes` 表 + 路由解析器（只做显式模块映射 + 同模型/同 workdir/同权限 + 空闲才复用）；`session_mode` 参数；串行租约；busy 降级新会话。
3. **稳定性加固**（2～3 天）：系统提示/工具指纹校验、dsh patch 固定、自动压缩阈值调整、换代（简版：达到阈值直接新会话 + 保存一份简报）。
4. **熔断与前端**（2 天）：命中率门槛、运行中心/会话页展示、重置按钮。
5. **A/B 验收**：同模块任务随机 reuse / new，比较「每任务成本、命中率、时长、失败率、人工返工率」，达标再默认开启；不达标就只保留前缀复用形态。

**验收指标（建议）**：复用任务的输入 token 成本相对同模块新会话下降 ≥30%；缓存命中率稳定 ≥80%；任务成功率/人工返工率不劣化；冷启动任务不进入长会话（或有明确提示）。

---

## 七、风险与必须的护栏

| 风险 | 说明 | 护栏 |
|---|---|---|
| **冷缓存成本放大** | 长会话未命中时按全价重发 H，比新会话贵数倍 | 热度窗口 + 先小任务试热 + 命中率熔断 + 显式「新会话」 |
| 前缀漂移 | dsh 版本升级、profile/patch 变化、AGENTS.md 变化、MCP 工具变化、模型/权限切换、图片/附件变化、压缩 | 每次执行记录 prompt/tools/route 指纹，下次校验；变化即换代 |
| resume 重建前缀不确定 | headless 每次新进程，dsh 文档明说恢复实例可能建立不同前缀 | 先做实验；不稳定则上常驻会话（方案 B）或只用前缀复用 |
| 上下文污染/质量下降 | 模块历史任务内容进入模型上下文，可能干扰当前任务 | 换代简报只放模块长期事实；敏感任务强制新会话；可重置；A/B 看返工率 |
| 串行与吞吐 | 一个会话同时只能跑一轮，排队会拖慢批量任务 | 持久队列 + 超时降级；批量场景可 fork 会话（同前缀、并行独立尾部） |
| 崩溃/重启 | 常驻方案或运行中进程崩溃 | 租约过期回收、stale running 收尾、会话恢复策略（headless resume 前检查） |
| 计费口径 | 不同服务商缓存语义不同（Anthropic 需显式 `cache_control` + TTL；OpenAI 自动前缀；DeepSeek 自动磁盘缓存） | 按 provider 建价目表与能力表；Anthropic 场景要单独设计 TTL/断点 |
| 隐私/边界 | 单用户前提；模块内历史跨任务共享 | 模块隔离、禁止跨 project/模块复用、可审计 |

---

## 八、需要拍板的问题

1. 目标执行器：先只做 `harness=deepseek`（推荐），还是同时覆盖 `harness=agent` 与 `harness=claude`（缓存语义/会话存储不同）？
2. 模块从哪来：任务 `props.module`、项目、还是 workdir？第一阶段是否接受人工维护「模块→路由」映射？
3. 复用粒度：默认整段会话复用，还是先上「前缀复用」低风险形态？
4. 质量底线：允许模型看到同模块历史任务内容吗？敏感任务是否默认新会话？
5. dsh 形态：先 headless + `--session-id` 实验，还是直接投入常驻会话（ACP）？

---

参考（代码/文档位置）：

- `internal/runner/dsh.go`（headless 调用、patch、session id、事件解析）
- `internal/api/run.go`（`resume_session`、`lastHarnessSession`、task run 收尾）、`internal/api/runagent.go`
- `internal/runner/prompt.go`、`internal/agent/prompt.go`、`internal/agent/runner.go`（提示词与 40 条截断）
- dsh 包文档：`@deepseek-ai/dsh-headless`（`--session-id` 续跑与 `--json` 事件）、`@deepseek-ai/dsh-agent-loop`/`dsh-session`（「KV Cache 影响」）、`@deepseek-ai/dsh-llm-deepseek`/`dsh-llm-pi-ai`（缓存用量映射）、`dsh-session-persistence-jsonl`（会话日志布局）、`dsh-compaction-basic`（压缩对前缀的影响）
- 本机 dsh 会话日志：`~/.dsh/sessions/<normalized-cwd>/<session-id>/session.vN.jsonl.zstd`

---

## 十、落地实现（2026-11-12，第一批：前缀复用）

已实现（未提交，工作区）：

- **迁移 0058**：`task_runs` 加 `module_key` / `prefix_version` / `cache_read_tokens` / `uncached_input_tokens` / `output_tokens`；新表 `module_prefixes(module_key PK, briefing, version, updated_at)`。
- **dsh 用量采集**：`internal/runner/dshusage.go` 按会话 id 找 `~/.dsh/sessions/**/<sid>/session.vN.jsonl[.zstd]`，流式 zstd 解码，解析 `assistant/message.data.usage`（`inputTokens` 是未命中输入、`cacheReadTokens` 是命中）；含单测。
- **程序化模块前缀**：`internal/api/moduleprefix.go`
  - 模块键：任务挂项目 → `project:<id>`；否则 `workdir:<规范化绝对路径>`；都没有则不加前缀。
  - 首次按库里的记录 seed（项目 ref/标题/描述 + 模块目录 + 同模块最近 6 条已收尾任务的结论行），之后**逐字节复用**；每次执行结束在末尾追加一行（版本 +1），超过 2400 字轮换成「头部 + 最近 3 条」。全程不调模型。
  - 同一模块读改写有互斥锁；读失败降级为「这次不加前缀」，不让执行起不来。
- **执行集成**：`harness=deepseek` 新会话的提示词 = `模块简报 + "\n\n---\n\n" + 原提示词`；续跑（`resume_session`）不拼；`GET /api/objects/{id}/run/prompt?harness=deepseek` 预览同口径。收尾时读 dsh 会话日志落 token 用量，并把本次任务结论行追加进简报（成功/失败/取消都记）。
- **观测/展示**：`TaskRun` 带 5 个新字段；运行中心 task 行带 `module_key`、`cache_hit_ratio`（`cache_read/(cache_read+uncached)`）；执行记录卡片和运行中心显示「缓存 xx%」。
- **契约文档**：`docs/api-contract.md` 已补 TaskRun 新字段、RunCenterItem 字段、deepseek 模块前缀行为、预览口径。

启用：换新二进制重启工作台（0058 启动时自动应用），前端重新 build/dev。已有 dsh 执行记录不回填 usage（老记录三列为 0）。

已知边界（与设计稿一致）：

1. 缓存可见有延迟：实验里紧接上一轮 0 秒的请求只命中系统段；生产任务间隔通常够，但同一模块背靠背调度时第一条可能按未命中计价。
2. 续跑（`resume_session`）仍是「整段会话续跑」，不拼模块前缀；两者语义不同，不要混用。
3. 轮换（2400 字）会让「上一版前缀是这一版前缀」断一次，付一次全量缓存 miss，随后重新积累。
4. 尚未做「整段会话复用」（同一 dsh 会话追加任务）——那需要串行租约、dsh 实例前缀稳定性验证与换代策略，是下一阶段（设计稿 3.3 的方案 A/B）。
5. `workdir` 模块的历史任务从本功能上线后才开始积累（项目模块可从已有执行记录 seed）；跨项目/跨模块不复用。


由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

---

## 九、实验记录（2026-11-12，真实远端 API）

已确认决策：只做 `harness=deepseek`；模块从「项目 / workdir」派生；先上「前缀复用」（每任务新 dsh 会话，首个 user 消息以同一段模块前缀开头）；允许模型看到同模块历史任务（程序化摘要）；能程序判断的不用 LLM。

实验方法：`internal/api/dshcache_probe_test.go`（`PMW_DSH_CACHE_PROBE=1` 才跑，默认 skip），用 `/tmp/pmw-probe` 库副本里 NewAPI provider（`deepseek-v4-flash`）真实调用 dsh headless 4 次；P = 1695 字符模块上下文前缀，S = 系统提示+工具声明（约 4096 token）；Run1–3 同 P 不同任务尾巴，Run4 用等长但内容不同的 P2 对照。

| 轮次 | 首步 cache_read | 首步 uncached | 说明 |
|---|---|---|---|
| Run1 | 4096 | 2278 | 冷启动，只命中 S |
| Run2（紧接 0s） | 4096 | 2274 | 服务商缓存落盘/可见有延迟，P 还没进缓存 |
| Run3（距 Run2 10s） | 6144 | 225 | **命中 S + P**；该会话命中率 96.5% |
| Run4（P2 对照） | 4096 | 2358 | 只命中 S（63.5%），证明命中面是 P |

- 4 次 `SystemPrompt` 逐字节一致：len=2391，sha256=2056a5fe309ec679 → **headless 跨进程系统提示稳定，前缀复用的前提成立**。
- 结论：**跨进程前缀复用成立**。新 dsh 进程带相同用户前缀，10 秒后首步命中 S+P=6144 token；对照组只命中 S=4096，差值 ≈ P 本身（与 Run1 的 P+尾巴 uncached=2278 吻合）。
- 注意点（写进实现与运维）：
  1. 紧接上一轮结束（0s）就发重复请求只命中 S —— 服务商/代理侧缓存可见有延迟。生产任务通常间隔远大于此；同一模块背靠背调度时留几秒窗口，或接受首个请求按未命中计价。
  2. S（系统提示+工具声明）本身可跨 workdir、跨批次稳定复用：即使没有模块前缀，也值得保证 profile/patch/工具声明稳定。
  3. 对照前缀必须逐字节不同（本次第一版对照组因跨批次内容相同被缓存污染，已改为带批次盐）。
- 实现方向据此确定为「模块前缀复用」：`module_prefixes` 表存逐字节前缀，任务开始时 `prefix + "\n\n---\n\n" + 原提示词`，任务结束后程序化追加一行同模块任务摘要（无 LLM 调用），超长轮换。

---

## 十、落地实现（2026-11-12，第一批：前缀复用）

已实现（未提交，工作区）：

- **迁移 0058**：`task_runs` 加 `module_key` / `prefix_version` / `cache_read_tokens` / `uncached_input_tokens` / `output_tokens`；新表 `module_prefixes(module_key PK, briefing, version, updated_at)`。
- **dsh 用量采集**：`internal/runner/dshusage.go` 按会话 id 找 `~/.dsh/sessions/**/<sid>/session.vN.jsonl[.zstd]`，流式 zstd 解码，解析 `assistant/message.data.usage`（`inputTokens` 是未命中输入、`cacheReadTokens` 是命中）；含单测。
- **程序化模块前缀**：`internal/api/moduleprefix.go`
  - 模块键：任务挂项目 → `project:<id>`；否则 `workdir:<规范化绝对路径>`；都没有则不加前缀。
  - 首次按库里的记录 seed（项目 ref/标题/描述 + 模块目录 + 同模块最近 6 条已收尾任务的结论行），之后**逐字节复用**；每次执行结束在末尾追加一行（版本 +1），超过 2400 字轮换成「头部 + 最近 3 条」。全程不调模型。
  - 同一模块读改写有互斥锁；读失败降级为「这次不加前缀」，不让执行起不来。
- **执行集成**：`harness=deepseek` 新会话的提示词 = `模块简报 + "\n\n---\n\n" + 原提示词`；续跑（`resume_session`）不拼；`GET /api/objects/{id}/run/prompt?harness=deepseek` 预览同口径。收尾时读 dsh 会话日志落 token 用量，并把本次任务结论行追加进简报（成功/失败/取消都记）。
- **观测/展示**：`TaskRun` 带 5 个新字段；运行中心 task 行带 `module_key`、`cache_hit_ratio`（`cache_read/(cache_read+uncached)`）；执行记录卡片和运行中心显示「缓存 xx%」。
- **契约文档**：`docs/api-contract.md` 已补 TaskRun 新字段、RunCenterItem 字段、deepseek 模块前缀行为、预览口径。

启用：换新二进制重启工作台（0058 启动时自动应用），前端重新 build/dev。已有 dsh 执行记录不回填 usage（老记录三列为 0）。

已知边界（与设计稿一致）：

1. 缓存可见有延迟：实验里紧接上一轮 0 秒的请求只命中系统段；生产任务间隔通常够，但同一模块背靠背调度时第一条可能按未命中计价。
2. 续跑（`resume_session`）仍是「整段会话续跑」，不拼模块前缀；两者语义不同，不要混用。
3. 轮换（2400 字）会让「上一版前缀是这一版前缀」断一次，付一次全量缓存 miss，随后重新积累。
4. 尚未做「整段会话复用」（同一 dsh 会话追加任务）——那需要串行租约、dsh 实例前缀稳定性验证与换代策略，是下一阶段（设计稿 3.3 的方案 A/B）。
5. `workdir` 模块的历史任务从本功能上线后才开始积累（项目模块可从已有执行记录 seed）；跨项目/跨模块不复用。


由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
