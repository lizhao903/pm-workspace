# deepseek-harness 接入（执行器 `deepseek`）

2026-11-04 · 目标：让 DeepSeek 模型在它自己的 harness（dsh）里跑，工作台只做派单、收事件、留档。
实测版本：`@deepseek-ai/dsh` 0.2.1-rc.5（macOS）。

---

## 一、定位

同一个任务可以选两个执行器：

| 执行器 | 谁在跑 | 适合什么 |
|---|---|---|
| `claude`（默认） | 本机 Claude Code | 改代码、动文件、跑测试 |
| `deepseek` | deepseek-harness（`dsh`）的 headless 模式 | 读需求写方案、结构化整理、分析 |

两者共用任务单、事件流、产物登记（扫工作目录差集）、取消、历史记录。区别只在起哪个进程、
谁来拼提示词、按谁的安全边界执行。

## 二、装 dsh

```sh
npm i -g @deepseek-ai/dsh     # 或 npx @deepseek-ai/dsh
pmw --dsh-bin "$(which dsh)"  # 也可以 export DSH_BIN=...，或留空走 PATH
```

**不需要建 profile**。工作台用的就是随包发布的 `headless`（`$DSH_HOME/profiles/headless`，
首次启动自动生成），每次执行用 `--patch` 叠一份临时配置；`--patch` 只作用于这一次执行、
不写回 profile，所以不会污染你自己在 headless 里配的 provider。

模型服务商在**设置 > 模型**里配，不用配进 dsh：每次执行由工作台把选中的服务商翻译进 patch。

## 三、工作台做了什么

命令行只有四个参数——0.2.x 的 headless 就认这些：

```sh
dsh --profile headless --patch <临时文件> --json [--session-id <id>] -
```

任务走 stdin（末尾的 `-`），不走命令行：一次带上下文的提示词几十 KB，塞 argv 会撞
`ARG_MAX`，也会被 `ps` 看见。审批策略、沙箱档位、额外可写目录这些**都不在命令行上**，
它们全是 patch 里的配置（见下），这也更稳：配置不该跟着命令行漂。

patch 六块，各自解决一个必须解决的问题：

| patch 条目 | 内容 | 为什么少不了 |
|---|---|---|
| `llm-pi-ai` | 路由 `pmw`：`apiKeyEnv` / `api` / `baseURL` / `models` | dsh 读不到工作台的库，必须把服务商写进它的 provider 表 |
| `agent-default-model` | `provider: pmw` + 模型 | 不写这条，headless 用它自己的默认（`deepseek-official`），实测报 `no API key for provider route "deepseek-official"` |
| `agent-loop` | `agents: [{id: main, provider, model, cwd}]` | 会话里真正干活的那个 agent |
| `sandbox-policy` | `mode`（read-only / workspace-write）+ `workspaceRoot` + `additionalWritableRoots` | 文件效果的边界 |
| `approval` | `policy: never` | headless 没有交互界面，`ask` 只会停在一个没人回答的确认上 |
| `permission` | 预设表把三个档位的 `approval` 都改成 `never`，`defaultPreset` 指到当前档位 | dsh 启动时校验「沙箱档位 + 审批策略能对上某个预设」，对不上整条 permission 插件不激活（实测报 `composed sandbox and approval defaults match no preset`） |

密钥只走进程环境 `PMW_DSH_API_KEY`，patch 里用 `apiKeyEnv` 引用：写进文件就留在磁盘上，
放命令行会被 `ps` 看见。

权限映射：不勾「允许修改文件」→ `read-only`；勾了 → `workspace-write`，
工作目录里软链接指向的外部目录进 `additionalWritableRoots`。

## 四、事件映射

`--json` 的行由 dsh 定义，翻成工作台的 `runner.Event`：

| dsh（实测 0.2.1） | 工作台 | 界面 |
|---|---|---|
| `text` | `delta` | 正文增量 |
| `tool_call`（`tool` + `input` 对象；新版是 `name` + `arguments` 字符串，两套都认） | `tool` | 工具行，detail 取命令或路径 |
| `tool_result`（`status` / `result` / `error`） | `tool_result` | 按 `callId` 回填成功或失败 |
| `session`（`sessionId`） | — | 落库，续跑用 |
| `status` / `thinking` | — | 轮次状态与草稿纸不上界面 |
| `final` | 收尾 | **只有 `text`，没有 `reason`** |
| `error` | 收尾 | 直接驱动器失败（agent 没建起来等），此时没有 `final` |

成败判定：**退出码 + `status.turn_end.reason.kind`**。`final` 不带 `reason`，
靠它判会把握手成功的运行全标成红的（这一点是实测踩出来的）。失败文案取
`turn_end.reason.error.message`——那一种情况下 `final.text` 是空串。

## 五、两种「看起来成功、其实什么都没做成」

dsh 没有 claude 那种 `permission_denials` 结构化清单，沙箱拒绝表现为一条工具错误。
所以按签名识别（来自 dsh 沙箱实现的 denialSignatures）：

- **沙箱后端起不来**（`no sandbox backend is usable` / `refusing to run the command unconfined`）：
  dsh 拒绝在无隔离情况下执行命令，这一轮什么都没干。这是环境问题，不是任务失败，
  界面上要说清「装 bubblewrap / 启用 Landlock / 让 sandbox-exec 可用，或改用 Claude Code」。
- **写入被拒**（`EROFS` / `EACCES` / `EPERM` / `Permission denied` / `Read-only file system`）：
  只读执行里一次都没写成 → 判失败，提示勾「允许修改文件」；
  勾了还被拒 → 说明写的是工作区之外，提示把目录设成工作区或放软链接。

判定条件里都带「成功的工具调用为 0」：被挡过一次但换个路子做成的事，不该标红。

## 六、续跑

dsh 用 `session-<uuid>` 标识一段会话，`--session-id` 接着它跑（实测第二轮 `turn=2`）。
工作台把会话 id 落在 `task_runs.harness_session`（0050），面板上勾「接着上次会话」才带上——
默认新开：续跑会把上一轮的上下文一起带进来，那该是用户明确要的。
勾了但没有可续的会话直接回 400，不悄悄新开一段。

## 七、边界

- 只接流式发起（`POST /api/objects/{id}/run`）。「切换到终端」仍只走 claude：
  终端方式的价值是**人在环里操作**，而 dsh 的交互形态是 `dsh tui` 那套，接进来是另一个功能。
- 插件发起的运行（`StartClaudeCode`，走 `pmw_finish_run` 回写）仍只走 claude：
  那是已发布的插件契约，加执行器维度要同时改插件 API 与每个插件的假设。
- 不做逐条写入审计：被拒次数是从错误文本里数出来的，只用于判定「做成了没有」。
- 不校验 dsh 版本：命令行参数与事件字段的差异由冒烟测试兜（`dsh_smoke_test.go`），
  上游换词汇表会先在那里红。

## 八、验收

```sh
# 真 dsh + 假模型端点，跑通工具往返、事件解析、会话 id、失败归类
go test ./internal/runner -run 'TestSmokeRealDSH' -v
```

已实测（0.2.1-rc.5）：工具往返事件解析、`--session-id` 续跑、沙箱不可用归类、失败原因取自
`turn_end`。**未实测**：`workspace-write` 下的真实写入——本机 `sandbox-exec` 被拒绝，
dsh 直接拒绝执行命令；换一台 sandbox-exec 正常的机器再验一次写入路径。
