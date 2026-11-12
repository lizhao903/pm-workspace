# DeepSeek 模块前缀复用调度模式

状态：已落地（2026-11-13，迁移 0058；仅 `harness=deepseek`）。
详细设计与实验过程见 [agent-module-session-cache-design.md](agent-module-session-cache-design.md)。

## 一句话

任务不是「复用整段旧会话」，而是**按功能模块把提示词的第一段做成逐字节稳定的前缀**：
每次任务仍开新的 dsh 会话，但开头都是同一段「模块简报」，服务商的前缀缓存会命中这段；
模块历史任务由程序化生成的简报承载，**不额外调用模型、不花判断的 token**。

## 为什么这样做

- 远端模型 API（DeepSeek/OpenAI/Anthropic 等）对**相同前缀**的输入按更低的缓存读价格计费（DeepSeek 约为未命中的 1/10，以实际价目为准）。
- dsh headless 每次任务是一个独立进程，但系统提示 + 工具声明在同一套 profile/patch 下是**逐字节稳定**的；实测 4 次独立进程系统提示 sha256 完全一致。
- 真实实验（NewAPI / `deepseek-v4-flash`，前缀 P=1695 字符）：

| 轮次 | 首步 cache_read | 首步 uncached | 说明 |
|---|---|---|---|
| 冷启动 | 4096 | 2278 | 只命中系统提示+工具声明 S |
| 紧接 0 秒 | 4096 | 2274 | 服务商缓存可见有延迟，P 未命中 |
| 间隔 10 秒 | **6144** | **225** | **命中 S+P**，会话命中率 96.5% |
| 等长不同前缀对照 | 4096 | 2358 | 只命中 S，差值≈P |

结论：跨进程前缀复用成立；生产任务通常间隔足够，背靠背调度时第一条可能按未命中计价。

## 调度流程

1. **发起**：任务抽屉/接口 `POST /api/objects/{id}/run`，`harness=deepseek`（Claude Code / 工作台 Agent 不走这条调度）。
2. **解析工作目录**：沿用现有规则，任务没设时从所属项目继承。
3. **派生模块键**：
   - 任务挂了项目 → `project:<项目 id>`
   - 否则工作目录非空 → `workdir:<规范化后的绝对路径>`
   - 都没有 → 空键，本次**不加前缀**（宁可新会话，也不进一个「哪里都不属于」的缓存域）
4. **取模块简报**：读 `module_prefixes`；第一次出现时按库里记录程序化 seed（项目 ref/标题/描述 + 模块目录 + 同模块最近 6 条已收尾任务的结论行，不含模型调用），落库 `version=1`。
5. **拼提示词**：`模块简报 + "\n\n---\n\n" + 原提示词`；执行记录写 `module_key`、`prefix_version`。**续跑（`resume_session`）不拼前缀**——那是「接着整段会话跑」，不是「新会话 + 固定前缀」。提示词预览接口同口径。
6. **执行**：新 dsh 会话（不 resume），和普通 deepseek 执行完全一样（沙箱/审批/MCP/超时都不变）。
7. **收尾**：
   - 从 dsh 持久化会话日志（`~/.dsh/sessions/.../session.vN.jsonl[.zstd]`，`assistant/message.usage`）解析 token 用量，写 `task_runs.cache_read_tokens / uncached_input_tokens / output_tokens`；
   - 把这次任务的一行结论（`- <ref> <标题>：<done|failed|canceled>（结论一行≤80字）`）**追加**到简报末尾，`version+1`；成功/失败/取消都追加；
   - 任何一步失败只记日志，不影响执行收尾。

## 模块简报（全是程序生成，零模型调用）

| 环节 | 规则 |
|---|---|
| 首次 seed | 固定头部（模块标签、项目描述截 400 字、模块目录）+「同模块最近任务」段；project 模块从已有执行记录取最近 6 条已收尾结论，workdir 模块从空开始 |
| 追加 | 每次任务结束在**末尾**追加一行，版本 +1；只追加不重写，保证上一版是这一版的前缀 |
| 轮换 | 超过 2400 字时保留「头部 + 最近 3 条」，重新开始积累（会付一次缓存 miss） |
| 并发 | 同一模块「读-改-写」有互斥锁；不同模块互不影响 |
| 降级 | 读库失败/简报缺失时这次不加前缀，照常执行 |

## 缓存命中的条件与失效触发

命中需要同时满足：同一 provider/model/endpoint；系统提示逐字节相同；工具声明逐字节相同；历史只追加（不替换/不压缩）；同一段前缀此前刚被使用过且缓存还热。

会破坏前缀的常见变化：改 dsh profile/patch、换模型或服务商、增删 MCP 工具/工具 schema、改 AGENTS.md/agent instructions、权限档位变化、简报轮换、dsh 升级导致提示词拼装变化。**这些变化只需要接受一次 miss，随后重新积累。**

## 数据模型（迁移 0058）

- `task_runs` 新增：`module_key`、`prefix_version`、`cache_read_tokens`、`uncached_input_tokens`、`output_tokens`。
- 新表 `module_prefixes(module_key TEXT PRIMARY KEY, briefing TEXT, version INTEGER, updated_at TEXT)`。

## 观测与判定

- 执行记录卡片与运行中心 task 行显示「缓存 xx%」；`cache_hit_ratio = cache_read / (cache_read + uncached_input)`，无用量不显示。
- **程序化判定**：模块键、简报内容、是否加前缀、命中率全部由库里的记录和固定规则算出，没有为「要不要复用」发起任何模型调用；唯一花钱的模型调用仍然是任务本身。
- 老执行记录不回填 usage（三列为 0）；dsh 日志缺失时降级为 0、不影响收尾。

## 成本模型

设新任务尾巴 `T`、固定提示 `S`、复用历史 `H`、命中率 `r`、命中价/未命中价之比 `α`：
复用成本 ≈ `H·(α·r + (1−r)) + T`，不复用 ≈ `S + T`；划算条件 `r > (1 − S/H)/(1 − α)`。
例：`H=50k, S=10k, α=0.1` → 命中率需约 89%。所以本模式**只做前缀复用、不做无门槛的整段会话复用**，并且把命中率展示出来作为是否需要继续复用的依据。

## 与「整段会话复用」的区别（为什么先做这个）

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **本方案：前缀复用** | 每任务新会话 + 稳定模块前缀 | 无串行约束、无长上下文膨胀、改动小、可随时回退 | 只命中前缀那一段，历史任务只以简报形式进入上下文 |
| 整段会话复用（下一阶段） | 同一 dsh 会话追加任务 | 历史任务全文都在缓存里，命中面更大 | 同一会话串行/排队、上下文膨胀、需要 dsh 实例前缀稳定性与换代策略 |

## 边界与运维

1. 只覆盖 `harness=deepseek`；Claude Code 与工作台 Agent 的行为不变。
2. 续跑（`resume_session`）不拼模块前缀。
3. 缓存可见有延迟：紧接上一轮 0 秒的重复请求可能只命中系统段；同一模块背靠背调度时第一条可能按未命中计价。
4. 简报轮换会断一次前缀（付一次全量 miss），之后重新积累；2400 字上限是为了避免简报吃掉上下文。
5. `workdir` 模块的历史从本功能上线后开始积累；项目模块可以从已有执行记录 seed。
6. 使用非默认 `DSH_HOME` 时需保证工作台进程能访问 dsh 会话日志，否则只丢用量统计。
7. 迁移只加列/加表、不回退；回滚本批提交后行为退回「不加模块前缀」。

## 验证与复现

```sh
# 真实 API 实验（gated，默认 skip；会产生少量真实费用）
DSH_BIN=/path/to/dsh PMW_DSH_CACHE_PROBE=1 PMW_PROBE_DB_DIR=/path/to/db-copy \
  go test ./internal/api -run TestDSHPrefixCacheProbe -v -count=1 -timeout 15m

# 单元/接口测试
go test ./internal/runner ./internal/store/sqlite ./internal/api
cd frontend && pnpm typecheck && pnpm exec vitest run src/modules/tasks/Runs.test.tsx src/modules/tasks/runsModel.test.ts src/modules/runs/Page.test.tsx
```

## 相关文件

| 文件 | 职责 |
|---|---|
| `internal/api/moduleprefix.go` | 模块键、简报 seed/追加/轮换、读失败降级 |
| `internal/runner/dshusage.go` | 定位并解析 dsh 会话日志的 token 用量（zstd 流式） |
| `internal/api/run.go` | deepseek 执行拼前缀、收尾落 usage、追加简报行 |
| `internal/api/runterminal.go` | 提示词预览同口径 |
| `internal/api/runcenter.go` | 运行中心行带 `module_key` / `cache_hit_ratio` |
| `internal/db/migrations/0058_dsh_prefix_cache.sql` | 迁移 |
| `internal/api/dshcache_probe_test.go` | 真实 API 缓存命中实验（gated） |
| `frontend/src/modules/tasks/runsModel.ts`、`Runs.tsx`、`modules/runs/Page.tsx` | 命中率展示 |

## 下一步（可选）

- 按服务商缓存 TTL 做 warmness 门槛（太冷时直接新会话，不进长历史）；
- 「整段会话复用」：同模块串行租约 + 换代简报 + dsh 实例前缀稳定性验证；
- 运行中心按模块维度统计命中率与成本趋势。

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
