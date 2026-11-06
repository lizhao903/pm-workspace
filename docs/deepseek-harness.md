# deepseek-harness 接入（执行器 `deepseek`）

2026-11-04 · 目标：让 DeepSeek 模型在它自己的 harness（dsh）里跑，工作台只做派单、收事件、留档。
实测版本：`@deepseek-ai/dsh` 0.2.1-rc.5（macOS，首版）；0.2.2-rc.1（macOS，2026-11-06，TSK-0722：分派入口、执行器状态、集成检查、MCP 回写）。

---

## 一、定位

同一个任务可以选两个执行器：

| 执行器 | 谁在跑 | 适合什么 |
|---|---|---|
| `claude`（默认） | 本机 Claude Code | 改代码、动文件、跑测试 |
| `deepseek` | deepseek-harness（`dsh`）的 headless 模式 | 读需求写方案、结构化整理、分析 |
| `agent` | 工作台自己的 Agent（不起外部进程） | 读写工作台里的对象：记进展、改状态、建子任务 |

`claude` 和 `deepseek` 共用任务单、事件流、工作台 MCP 回写（`pmw-run`）、产物登记（扫工作目录差集）、取消、历史记录。
区别只在起哪个进程、权限怎么映射、按谁的安全边界执行。

界面入口（TSK-0722）：任务抽屉「开发任务」里一个「交给执行」按钮，弹窗最上面选交给谁（Claude Code / DeepSeek / 工作台 Agent），
不能用的置灰并写缺什么；设置「执行器」页显示同一份状态（`GET /api/runners`），能一键做集成检查。

## 二、装 dsh（照做）

不建议全局安装（`npm i -g`）：装到一个固定目录，升级、回退都只动那一个目录，也不会和别的 node 项目的全局包打架。

```sh
# 1. 装到固定目录（要 node 20+；第一次大约 1 分钟，700 多个包）
npm i --prefix ~/.local/share/pmw-dsh @deepseek-ai/dsh
~/.local/share/pmw-dsh/node_modules/.bin/dsh --version     # 实测 0.2.2-rc.1

# 2. 启动工作台时指过去（二选一），然后重启工作台
pmw ... --dsh-bin ~/.local/share/pmw-dsh/node_modules/.bin/dsh
DSH_BIN=~/.local/share/pmw-dsh/node_modules/.bin/dsh pmw ...
```

3. 到「设置 / 模型服务商」配服务商（见下「服务商要求」）。
4. 到「设置 / 执行器」点「检测」：DeepSeek 应显示「可用」、路径和版本；再点「跑一次集成检查」，八项都过就能在任务上「交给执行 → DeepSeek」了。

没装、路径不对时，设置「执行器」和分派弹窗里都会提示同一份步骤（后端 `internal/api/runners.go` 的 `dshInstallSteps`，改步骤两处一起改）。

dsh 的数据（会话、headless profile）在 `$DSH_HOME`（默认在用户主目录下），工作台不改它；要隔离可以在启动工作台的环境里设 `DSH_HOME`。

**服务商要求。** dsh 只接两种协议：OpenAI Chat Completions、Anthropic Messages。工作台里能交给 dsh 的服务商：

| 工作台服务商协议 | 交给 dsh 的 | 说明 |
|---|---|---|
| `openai` | `openai-completions` | DeepSeek 属于这类：Base URL `https://api.deepseek.com`，填 API Key 和模型（如 `deepseek-chat`） |
| `anthropic` | `anthropic-messages` | |
| `ollama` | `openai-completions`，地址补 `/v1` | 本机 Ollama 的 OpenAI 兼容端点；没有密钥时给占位值。模型要支持工具调用（实测 `qwen3:4b` 能跑通，慢：一轮约 3 分钟） |
| `gemini` | 不支持 | 发起前 400 |

不指定服务商时默认挑：名字、地址或模型里带 `deepseek` 的优先，其次标了默认的，再次第一个；不会自动建 Ollama。
分派时可以只改这一次用的服务商和模型。

**不需要建 profile**。工作台用的就是随包发布的 `headless`（`$DSH_HOME/profiles/headless`，
首次启动自动生成），每次执行用 `--patch` 叠一份临时配置；`--patch` 只作用于这一次执行、
不写回 profile，所以不会污染你自己在 headless 里配的 provider。

模型服务商在**设置 > 模型**里配，不用配进 dsh：每次执行由工作台把选中的服务商翻译进 patch。

## 三、工作台做了什么

命令行只有四个参数——0.2.1 的 headless 就认这些（0.2.2 多了 `--permission-mode` / `--approval-policy` / `--add-dir`，为兼容两版仍全走 patch）：

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

| `insert` 一条 `@deepseek-ai/dsh-mcp-client`（id `mcp-pmw-run`） | `serverName: pmw-run`，stdio，`command` 是工作台的 MCP 程序（`--mcp-bin`），`args: ["--api", <--public-url>, "--actor", "deepseek"]` | 工作台 MCP 回写（TSK-0722）。**必须用 `insert`**：headless profile 里没有 MCP 客户端这一条，按 id 覆盖的写法只得到一句 `patch: entry "mcp-pmw-run" not found` 的警告，进程照常起、工具里却没有 pmw-run（0.2.2 实测） |

密钥只走进程环境 `PMW_DSH_API_KEY`，patch 里用 `apiKeyEnv` 引用：写进文件就留在磁盘上，
放命令行会被 `ps` 看见。另设 `DSH_TELEMETRY_MODE=DISABLED` 关掉 dsh 的会话遥测（headless 下本来就没人点反馈、不会上传，这里显式关）。

**工作台 MCP 回写（TSK-0722）。** 和 Claude Code 后台执行同一个 server 名 `pmw-run`、同一个程序和地址，工具名 `mcp__pmw-run__pmw_…`；
提示词带后台执行口径的「回写到工作台」一节（读任务、记进展、登记产出带 `run_id`、结束前 `pmw_finish_run`），`pmw_finish_run` 的结论收尾时放在执行记录最前面。
审批策略 `never` 不挡 MCP 工具（实测）。MCP 接不上（没有 `--mcp-bin` 的程序或 `--public-url`）时照跑，提示词写明原因。
dsh 的 MCP 客户端起 stdio 子进程时会滤掉名字带 KEY / TOKEN / SECRET 的环境变量，pmw-mcp 也不需要凭证。

**权限映射（TSK-0499 的档位 → dsh 沙箱，`runner.DSHSandboxMode`）。** dsh 没有按命令放行的规则表，命令一律在沙箱里跑：

| 工作台档位 | dsh 沙箱 | 说明 |
|---|---|---|
| 只读（`read_only`） | `read-only` | 命令照跑，写任何文件都被挡（EROFS / EPERM） |
| 允许改文件（`accept_edits`） | `workspace-write` | 能写工作目录；软链接指向的外部目录进 `additionalWritableRoots` |
| 允许改文件 + 跑测试构建（`edits_and_tests`） | `workspace-write` | 同上：workspace-write 本来就能跑测试构建，两档在 dsh 里是同一档 |
| 自定义白名单（`custom`） | 没有对应 | 分派弹窗里置灰；接口回 400，不悄悄放宽成 workspace-write |

工作台永远不给 `danger-full-access`。

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

- 只接流式发起（`POST /api/objects/{id}/run`），分派弹窗里 DeepSeek 只有「后台执行」。「切换到终端」仍只走 claude：
  终端方式的价值是**人在环里操作**，而 dsh 的交互形态是 `dsh tui` 那套，接进来是另一个功能。
- 插件发起的运行（`StartClaudeCode`，走 `pmw_finish_run` 回写）仍只走 claude：
  那是已发布的插件契约，加执行器维度要同时改插件 API 与每个插件的假设。
- 不做逐条写入审计：被拒次数是从错误文本里数出来的，只用于判定「做成了没有」。
- 不校验 dsh 版本：`GET /api/runners` 只显示 `dsh --version`，不设最低版本；命令行参数与事件字段的差异由
  冒烟测试（`dsh_smoke_test.go`）和设置页的集成检查兜，上游换词汇表会先在那里红。
- 本机 Ollama 的工具模板解析很严：任何一个工具的入参 schema 根上没有 `properties` 对象，整个请求 400
  「properties must be an object」。pmw-mcp 里不带参数的工具因此显式写了 `{"type":"object","properties":{}}`
  （`cmd/pmw-mcp/schema_test.go` 守着）。
- 0.2.2 的 `final` 行开始带 `reason`，成败判定仍以退出码和 `turn_end` 为准，两版都对。

## 八、验收

**单测（真 dsh + 假模型端点）。** 没装 dsh 自动跳过；不全局安装时用 `DSH_BIN` 指过去：

```sh
DSH_BIN=~/.local/share/pmw-dsh/node_modules/.bin/dsh go test ./internal/runner -run 'SmokeRealDSH' -v
```

| 测试 | 验什么 |
|---|---|
| `TestSmokeRealDSH` | 工具往返、事件解析、会话 id、失败归类；只读档模型让 bash 写的文件不能真写出来 |
| `TestSmokeRealDSHResume` | `--session-id` 续跑，会话不换 |
| `TestSmokeRealDSHWriteBack` | patch 里 `insert` 的 pmw-run 被 dsh 拉起，模型调 `mcp__pmw-run__pmw_finish_run`，请求经现编的 pmw-mcp 到了工作台 `POST /api/runs/{id}/finish` |
| `TestSmokeRealDSHCancelAndTimeout` | 模型端点不回时取消（2 秒后）收尾成「已取消」、超时（3 秒）收尾成「超时」，收尾后整个进程组都不在了 |

**集成检查（设置「执行器」→「跑一次集成检查」，`POST /api/runners/deepseek/smoke`）。** 用真机上配好的 dsh 和服务商，
在临时目录里只读跑一次固定任务，逐项给结果：起进程、模型路由、MCP 回写、只读生效、结论落库、取消收尾、超时收尾、进程清理。
口径见 `docs/api-contract.md`「执行器 runners」。

2026-11-06 实测（TSK-0722，临时实例，dsh 0.2.2-rc.1，本机 Ollama `qwen3:4b`）：八项全过；模型路由一轮约 184 秒；
经 pmw-run 回报「目录里有：probe.txt、README.md」；取消 2.07 秒、超时 3.09 秒收尾，三次执行的进程组都退干净。
第一次跑时「模型路由」失败（Ollama 400 `properties must be an object`，见上「边界」），修了 pmw-mcp 的 schema 后通过。

已实测（0.2.1-rc.5）：工具往返事件解析、`--session-id` 续跑、沙箱不可用归类、失败原因取自
`turn_end`。0.2.2-rc.1 补测（TSK-0722）：`workspace-write` 下真实写入能写进工作目录（`TestSmokeRealDSHWorkspaceWrite`），只读档写不进；
这台机器上 `sandbox-exec` 可用，0.2.1 时被拒绝的情况没再出现。
