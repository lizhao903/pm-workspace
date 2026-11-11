# 一人之下

产品经理的个人工作台：需求、任务、项目、文档、IM 消息和联系人放在一处，能把任务直接交给 Claude Code 去做，再用 SOP 把「收消息、建任务、执行、回复」串成自动流程。本机单二进制运行，Go + SQLite 后端，React 前端打包进同一个可执行文件。

![今日总览](docs/images/readme/overview.png)

<details>
<summary>深色主题</summary>

![今日总览（深色）](docs/images/readme/overview-dark.png)

</details>

> 本文所有截图都来自全新空库加演示数据（`--seed-demo` 加接口补的虚构示例），行情用不出网的假行情源，不含任何真实消息、联系人或凭证。

## 目录

- [核心能力](#核心能力)
- [系统结构](#系统结构)
- [模块一览](#模块一览)
  - [今日](#今日) · [项目](#项目) · [任务](#任务) · [文档](#文档) · [IM 消息](#im-消息) · [联系人](#联系人) · [会话](#会话)
  - [视频创作](#视频创作) · [交易套件](#交易套件) · [宽基监控](#宽基监控) · [SOP 编排](#sop-编排) · [终端](#终端) · [内置浏览器](#内置浏览器) · [录音](#录音) · [设置](#设置)
  - [手机上看](#手机上看)
- [自动交付流程](#自动交付流程)
- [插件体系](#插件体系)
- [开发](#开发)
- [文档索引](#文档索引)

## 核心能力

- **一个入口看今天**：逾期和今天截止的任务、等我处理的 IM 消息、待确认的 SOP 步骤、待验收的视频产出，都汇总在「今日」。
- **消息变任务**：IM 消息（Slack、Telegram）按身份认人、按会话归档，一键转任务、转资料、归到项目，处理完可以在原消息里回执。
- **任务交给 Claude Code**：任务带上预置角色和执行要求交给本机 Claude Code，执行进度、产出（commit、文件、链接）经 MCP 回写到任务上。
- **SOP 编排**：可视化流程，节点覆盖人工检查、AI、Claude Code 执行、IM 收发、项目测试与发布；内置研发 pipeline、发布 pipeline、IM 需求自动受理等流程。
- **项目工作区**：项目绑定本机目录、沟通群、干系人、资料和原型，原型一键启停，测试环境和发布都能在项目里跑。
- **视频创作**：选题库、素材收件箱、文稿和分镜编辑、多平台发布记录、内容日历、B 站数据与私信。
- **录音转写**：麦克风、浏览器分享的标签页声音、本机虚拟声卡的系统声音都能录，停止后本机 ffmpeg + whisper.cpp 转成带时间戳的文字；录音常驻，切页面也不停，录音和转写都不出本机。
- **交易套件**：行情、盯盘提醒、策略回测与参数扫描、模拟盘交易和风控；实盘默认关闭，要过评审闸门才能开。
- **插件化**：内核加插件，插件按需安装、启停，安装时逐项确认权限；工作台按角色组装菜单。
- **数据在本机**：SQLite 单文件，凭证进保险箱（钥匙串或 0600 密钥文件），关键操作留审计日志。

## 系统结构

```mermaid
graph TB
  U["用户（浏览器）"]

  subgraph FE["前端层：React，嵌入 pmw 单文件"]
    direction LR
    SHELL["外壳<br/>导航 / 通知 / 提醒弹窗"]
    MODS["内核页面<br/>今日 / 任务 / 文档 / 联系人 / 会话 / 设置"]
    PUI["插件页面<br/>项目 / IM 消息 / SOP / 视频 / 交易 / 终端 / 浏览器 / 录音"]
  end

  subgraph CORE["内核层：Go cmd/pmw"]
    direction LR
    API["HTTP API + SSE"]
    STORE["对象存储<br/>需求 / 任务 / 项目 / 资料"]
    EV["事件流"]
    RUN["执行器<br/>拉起 Claude Code"]
    AG["Agent<br/>多模型对话 + 知识库"]
    SCH["定时任务"]
    CON["连接器 + 凭证保险箱"]
    AU["审计日志"]
    DB[("SQLite")]
  end

  subgraph PL["插件层：经插件宿主接入"]
    direction LR
    IM["IM 消息"]
    SOP["SOP 编排引擎"]
    PRJ["项目"]
    VID["视频创作"]
    TRD["交易套件 / 宽基监控"]
    TOOL["终端 / 内网域名 / 内置浏览器"]
    REC["录音转写<br/>本机 whisper / ffmpeg"]
  end

  subgraph EXT["外部系统"]
    direction LR
    CC["Claude Code CLI"]
    MCP["pmw-mcp<br/>工作台 MCP 服务"]
    IMX["Slack / Telegram"]
    LLM["模型服务商<br/>Anthropic / OpenAI / Gemini / Ollama"]
    MKT["行情源 / 内容平台"]
  end

  U --> SHELL
  SHELL --- MODS & PUI
  FE <-->|"REST / SSE"| API
  API --> STORE & RUN & AG & SCH & CON
  STORE --> DB
  STORE --> EV
  STORE --> AU
  EV -->|"事件订阅"| PL
  PL -->|"读写对象 / 发通知"| STORE
  RUN --> CC
  CC --> MCP -->|"回写进度和产出"| API
  AG --> LLM
  IM <--> IMX
  TRD --> MKT
  VID --> MKT
```

任务从哪来、到哪去：

```mermaid
flowchart LR
  subgraph IN["入口"]
    A1["IM 消息"]
    A2["手动新建"]
    A3["定时任务"]
    A4["AI 对话"]
    A5["Claude Code 经 MCP"]
  end
  subgraph OBJ["工作台对象"]
    T["任务"]
    R["需求"]
    P["项目"]
    D["文档 / 资料"]
  end
  subgraph EXE["执行"]
    H["交给 Claude Code<br/>选角色和执行要求"]
    S["SOP 流程"]
  end
  subgraph OUT["反馈"]
    O1["回复原 IM 消息"]
    O2["工作台通知"]
    O3["产出登记<br/>commit / 文件 / 链接"]
  end
  A1 -->|"转任务"| T
  A1 -->|"转资料"| D
  A2 --> T & R
  A3 --> T
  A4 --> T & D
  A5 --> T & O3
  R --> T
  T --> P
  D --> P
  T --> H
  H -->|"run.finished"| S
  H --> O3
  S --> O1
  S --> O2
```

更完整的结构图和代码位置见 [docs/system-overview.md](docs/system-overview.md)。

## 模块一览

侧边栏按「工作台」组装，下面按默认的产品经理工作台顺序介绍。今日、任务、文档、联系人、会话、设置是内核模块，其余来自插件。

### 今日

每天打开的第一页：顶部是待处理、逾期、今天截止、定时任务、运行中的计数；「需要你处理」按来源分组（SOP 待检查、IM 消息），右侧是今天的任务、今天还会自动执行的定时任务；插件可以往这里加卡片，比如视频待验收、SOP 待处理。截图见本文开头。

### 项目

插件 `projects`。项目绑定本机目录、沟通群、干系人、资料和原型；概览页汇总待回复消息、未完成任务、干系人和最近的文档。详情页按标签分：沟通、附件、干系人、任务、文档、SOP、Agent、支持材料、原型、档案、设置。

| 项目列表 | 项目概览 |
|---|---|
| ![项目列表](docs/images/readme/projects.png) | ![项目概览](docs/images/readme/project-overview.png) |
| **项目沟通**：绑定的群里的消息按项目聚合 | **干系人**：角色、关注点、最近沟通 |
| ![项目沟通](docs/images/readme/project-comms.png) | ![项目干系人](docs/images/readme/project-stakeholders.png) |

### 任务

人工创建、IM 转来、Webhook 推送、定时任务建的任务都在这里，按逾期、今天、本周分组。任务抽屉里能改状态、优先级、负责人，看流水线，交给 Claude Code 执行。「阶段看板」按提出人看需求走到哪一步；「定时任务」到点建任务、发提醒、跑 SOP 或巡检运行异常。

| 全部任务 | 任务抽屉 |
|---|---|
| ![任务列表](docs/images/readme/tasks.png) | ![任务抽屉](docs/images/readme/task-drawer.png) |
| **阶段看板** | **定时任务** |
| ![阶段看板](docs/images/readme/tasks-board.png) | ![定时任务](docs/images/readme/tasks-schedules.png) |

### 文档

工作台文档（需求文档、技术方案、会议纪要、复盘总结）和挂载的本机目录放在一起，左边目录树，右边阅读和编辑。

![文档](docs/images/readme/docs.png)

### IM 消息

插件 `im`。各渠道的消息汇总成待处理队列，@我、私聊会标出来；每条可以回复、稍后、转任务、转资料、归到项目、发起 AI 会话。消息抽屉里带分诊建议和快捷回复。

| 待处理队列 | 消息抽屉 |
|---|---|
| ![IM 消息](docs/images/readme/messages.png) | ![消息抽屉](docs/images/readme/message-drawer.png) |

### 联系人

客户、合作伙伴、同事、供应商的名册，一个人可以挂多个 IM 身份，收消息时按身份认人。

| 联系人列表 | 联系人详情 |
|---|---|
| ![联系人](docs/images/readme/contacts.png) | ![联系人详情](docs/images/readme/contact-drawer.png) |

### 会话

和 Agent 的对话，可以选模型服务商和 Agent，对话里能调用工作台工具（读对象、建任务等），调用过程可回放；旁边能看执行记录和产出。

![会话](docs/images/readme/conversations.png)

### 视频创作

插件 `video`。一集视频从选题、内容编写、规划检查、网页开发、音频、录屏渲染走到分发，四个检查点要人确认；每个阶段可以配执行器（技能、SOP、Agent）。

| 全部视频（按系列分组） | 视频详情：制作流程和文稿 |
|---|---|
| ![视频列表](docs/images/readme/videos.png) | ![视频详情](docs/images/readme/video-detail.png) |
| **分镜**：口播、画面、时长、B-roll | **选题库**：想法、调研中、可开拍、已排期、已做成 |
| ![分镜](docs/images/readme/video-storyboard.png) | ![选题](docs/images/readme/video-topics.png) |
| **素材收件箱**：评论、热点、链接、随手记 | **发布记录**：按平台和比例登记，回填数据 |
| ![素材收件箱](docs/images/readme/video-clips.png) | ![发布记录](docs/images/readme/video-publishes.png) |
| **内容日历**：已发布、已定时、计划首发 | **B 站**：扫码登录后看账号数据和私信 |
| ![内容日历](docs/images/readme/video-calendar.png) | ![B 站](docs/images/readme/video-bilibili.png) |

### 交易套件

插件 `trade`，占四个菜单：行情、盯盘、策略、交易。默认只做行情、回测和模拟盘；实盘要过评审清单、单独申请 `trade:live` 权限、再打开实盘开关。

**行情**：K 线、盘口、自选分组，下单按钮只到模拟盘。

![行情](docs/images/readme/trade-markets.png)

| 盯盘：盯盘墙、市场时段、提醒规则 | 策略库 |
|---|---|
| ![盯盘](docs/images/readme/trade-monitor.png) | ![策略库](docs/images/readme/trade-strategy.png) |
| **策略编辑**：条件规则或代码，右侧快速回测 | **回测报告**：资金曲线、回撤、逐笔成交、参数扫描 |
| ![策略编辑](docs/images/readme/trade-strategy-editor.png) | ![回测报告](docs/images/readme/trade-backtest.png) |

交易页按账户、持仓、委托、策略运行、风控、设置分开：

| 交易总览（模拟盘） | 持仓 |
|---|---|
| ![交易总览](docs/images/readme/trade-trading.png) | ![持仓](docs/images/readme/trade-positions.png) |
| **委托** | **策略运行**：策略部署到模拟盘 |
| ![委托](docs/images/readme/trade-orders.png) | ![策略运行](docs/images/readme/trade-runs.png) |
| **交易账户** | **风控**：日亏损上限、单笔金额、仓位、杠杆、一键全停 |
| ![交易账户](docs/images/readme/trade-accounts.png) | ![风控](docs/images/readme/trade-risk.png) |

**交易设置**：实盘评审清单（审计日志、对账、异常演练、全停演练、模拟盘两周记录）逐项确认后才能申请实盘。

![交易设置](docs/images/readme/trade-settings.png)

### 宽基监控

插件 `etf`。A 股宽基 ETF 的每日份额变动、估算净流入、折溢价，按规则判定异动并发通知。截图里的行情是东方财富公开数据。

![宽基监控](docs/images/readme/etf.png)

### SOP 编排

插件 `sop`。标准流程的编辑、执行和待我处理。节点有自动、AI、人工检查、判断、等待、Claude Code 执行、IM 收发、项目测试与发布等；执行可以逐步确认，失败步骤可重试或按最新流程重跑。

| 执行记录 | 一次执行：停在人工检查 |
|---|---|
| ![SOP 执行记录](docs/images/readme/sop.png) | ![SOP 执行详情](docs/images/readme/sop-run.png) |
| **流程库** | **流程详情**：内置的研发 pipeline |
| ![流程库](docs/images/readme/sop-library.png) | ![研发 pipeline](docs/images/readme/sop-flow.png) |

### 终端

插件 `terminal`。本机真终端（pty 加 WebSocket），多标签、分屏，从项目里打开时工作目录就是项目目录，也能直接拉起 Claude Code。

![终端](docs/images/readme/terminal.png)

### 内置浏览器

插件 `browser`。工作台里的多标签浏览器，新标签页列出项目原型，Google 账号走 Google Drive 连接器。

![内置浏览器](docs/images/readme/browser.png)

### 录音

插件 `recording`。浏览器里直接录音，来源四种：麦克风、浏览器分享的标签页声音（不用装东西）、本机虚拟声卡的系统声音（覆盖会议 App 和系统播放器）、麦克风和系统声音双轨混成一条。停止后本机 `ffmpeg` + `whisper.cpp` 转成带时间戳的文字，音频和文本都不出本机。录音常驻：切到别的模块、切浏览器标签页都继续录，外壳顶部一直显示计时和暂停/停止，只有手动停止才保存。转写后可编辑正文、生成会议纪要（摘要/决议/待办/风险 + 图表）、把候选项目/任务/目标确认后建出来；说话人分离和声纹绑定联系人走本机 Python + FunASR。

> 录音页截图暂未收录：`--seed-demo` 的演示数据不含录音，采一份需要本机麦克风或虚拟声卡。

### 设置

| 工作台与模块：按角色组装菜单 | 插件：安装、启停、卸载，安装时确认权限 |
|---|---|
| ![工作台与模块](docs/images/readme/settings-workspace.png) | ![插件管理](docs/images/readme/settings-plugins.png) |
| **连接器**：IM、研发协作、文档、日程、内容平台 | **模型服务商**：国内外服务商和本地 Ollama |
| ![连接器](docs/images/readme/settings-connectors.png) | ![模型服务商](docs/images/readme/settings-providers.png) |
| **角色**：交给 Claude Code 的执行要求和权限 | **运行异常**：系统出的问题，可转研发任务 |
| ![角色](docs/images/readme/settings-run-prompts.png) | ![运行异常](docs/images/readme/settings-incidents.png) |

**内网域名**（插件 `domains`）：给本机服务配好记的域名，只检测和生成配置、命令，不改系统文件。

![内网域名](docs/images/readme/settings-domains.png)

### 手机上看

同一套前端，窄屏下侧边栏收成顶部的模块条，列表和筛选自动换行。

<table>
  <tr>
    <td align="center"><img src="docs/images/readme/mobile-today.png" width="250" alt="今日（手机）"><br>今日</td>
    <td align="center"><img src="docs/images/readme/mobile-tasks.png" width="250" alt="任务（手机）"><br>任务</td>
    <td align="center"><img src="docs/images/readme/mobile-messages.png" width="250" alt="IM 消息（手机）"><br>IM 消息</td>
  </tr>
</table>

## 自动交付流程

目标是从一条 IM 消息或一条平台任务开始，经分类、产品设计、研发评审、研发、自动测试，到人工验收、发布全程自动推进，只在「拿不准」和「上生产」两处要人。下图是主线的简化版，完整设计（含回退环、看板状态、原型回写旁路）见 [docs/auto-delivery-flow.md](docs/auto-delivery-flow.md)。

```mermaid
flowchart TB
  T1["IM 消息 / 平台新建任务"] --> T2{"是不是需求？"}
  T2 -->|"否"| T0["普通消息，不建任务"]
  T2 -->|"是"| T3["建需求任务<br/>回执提出人"]
  T3 --> C1["分类 Agent<br/>判断目标项目"]
  C1 --> C2{"置信度够高？"}
  C2 -->|"否"| C3["私信提出人确认项目"]
  C3 --> P1
  C2 -->|"是"| P1["产品 Agent<br/>写 PRD、改原型和规格"]
  P1 --> R1{"研发评审通过？"}
  R1 -->|"退回，最多 3 轮"| P1
  R1 -->|"超过 3 轮"| RH["人工裁决"]
  RH --> D1
  R1 -->|"通过"| D1["研发 pipeline<br/>开发 + 测试用例 + 自动化脚本"]
  D1 --> E1["部署测试环境<br/>冒烟 + 回归 + 截图"]
  E1 -->|"失败"| D1
  E1 -->|"通过"| N1["通知提出人验收"]
  N1 --> H1{"人工验收"}
  H1 -->|"实现缺陷"| D1
  H1 -->|"需求偏差"| P1
  H1 -->|"通过"| F1{"上线审批"}
  F1 -->|"批准"| F2["备份、核对密钥<br/>发布 + 线上冒烟"]
  F2 -->|"失败"| F3["自动回滚，通知负责人"]
  F2 -->|"正常"| F4["回复原消息：已上线"]
  F4 -.->|"旁路"| B1["按上线代码回写原型库"]
```

各段对应的落地：IM 插件的「IM 需求自动受理」「来消息确认派发」流程负责触发和分类，项目插件的工作区、测试环境、发布、原型同步提供 SOP 节点，SOP 插件的「研发 pipeline」「发布 pipeline」把它们串起来。

## 插件体系

一人之下是内核加插件的结构。内核必装、不能卸载：外壳、对象模型、身份、连接器框架、Agent 框架、执行与调度、事件总线、凭证保险箱、审计、插件管理。插件是按需安装的功能包，第一方插件和内核同仓库、编译进同一个二进制。

| 插件 | 版本 | 做什么 |
|---|---|---|
| `projects` 项目 | 0.17.0 | 项目目录、沟通渠道、资料、原型启停、工作区、测试环境、发布、原型同步 |
| `im` IM 消息 | 0.24.0 | 收 Slack、Telegram 消息，按身份认人、按会话归档，转任务和回执 |
| `sop` SOP 编排 | 0.11.0 | 流程编辑、节点和执行，流水线视图与治理 |
| `terminal` 终端 | 0.2.0 | 本机 pty 终端，分屏，能跑项目原型命令 |
| `domains` 内网域名 | 0.2.0 | 检测 hosts、pf 转发和本地证书，生成配置和命令 |
| `trade` 交易套件 | 0.7.0 | 行情、盯盘、策略回测、模拟盘、风控、实盘闸门 |
| `etf` 宽基监控 | 0.2.0 | 宽基 ETF 份额与资金流、异动规则 |
| `video` 视频创作 | 0.8.0 | 制作流程、选题素材、文稿分镜、发布与日历、B 站组件 |
| `browser` 内置浏览器 | 0.2.0 | 多标签浏览器、嵌入白名单 |
| `recording` 录音转写 | 0.4.0 | 浏览器/系统声音录音，本机 whisper 转写，纪要、候选、声纹，录音常驻 |
| `hello` 示例插件 | | 只在开发模式出现，给写插件的人当模板 |

要点：

- **一份清单**：`internal/plugins/<id>/plugin.json`，前后端读同一个文件；插件 id 决定表前缀、接口路径前缀和事件前缀。
- **扩展点**：功能模块、设置分节、对象类型、数据迁移、连接器、技能和 Agent 工具、SOP 节点、今日卡片、命令面板、事件订阅、定时任务动作等。
- **权限**：清单声明要用的权限（读写项目目录、出网、拉起子进程等），安装时逐项确认；高风险权限（如 `trade:live`）单独申请，只接受用户本人在界面上操作。
- **生命周期**：安装（跑迁移，安装前自动备份数据库）、启用、停用、升级、卸载（默认保留数据）；强依赖没启用时不能启用。
- **工作台**：一套菜单配置，决定开哪些模块、怎么分组；切工作台只换菜单，数据不隔离。

清单格式和全部扩展点见 [docs/plugin-api.md](docs/plugin-api.md)。

## 开发

### 跑起来

```bash
make deps     # 拉 Go 依赖 + npm install
make build    # 构建正式前端 frontend/ 并编译出 bin/pmw、bin/pmw-mcp
./bin/pmw     # 默认监听 http://127.0.0.1:7777，数据库在 ./data/pm.db
```

首次体验可以先灌演示数据：

```bash
make seed     # 等价于 go run ./cmd/pmw --seed-demo
```

想要和本文截图一样的离线演示环境，可以用空库加这些参数（都不出网，只用于演练）：

```bash
PMW_TRADE_DEMO=1 ./bin/pmw --db /path/to/demo/pm.db --seed-demo \
  --vault-keychain=false --fake-connector --fake-im
```

`PMW_TRADE_DEMO=1` 给交易套件加上假行情源；`--fake-im` 让 IM 插件带上假适配器，可以 `POST /api/im/callbacks/fake` 灌消息；`--fake-connector` 登记演练用的假连接器。插件装好后要在 设置 → 插件 里安装、启用，再到 设置 → 工作台与模块 里把模块加进菜单。

### 开发模式

前端要热更新时分两个终端：

```bash
scripts/dev-instance.sh start   # 测试实例 127.0.0.1:7796，用的是真实库副本
cd frontend && npm run dev      # http://127.0.0.1:7780，/api 代理到 7796
```

正式前端的约定见 `frontend/README.md`。旧前端 `web/` 还能 `cd web && npm run dev`（5173，/api 反代到 7777 真实库，写操作会落进真实数据）。

`make dev` 会把这两条命令打印出来。

`web-next/` 是演示原型，只当规格和演示用，规格文档在 `web-next/docs/spec/`。

### 构建哪套前端

`make build` 默认嵌正式前端 `frontend/`（`FRONTEND=new`）。旧前端 `web/` 保留一个版本做回退，下个版本删掉。

```bash
make build                    # 嵌正式前端
make build FRONTEND=legacy    # 嵌旧前端 web/
make ui FRONTEND=legacy       # 只构建前端、不编译 Go
```

两套前端都落到 `internal/webui/dist`，后切的那套整份覆盖前一套；非 `--dev` 模式下由 pmw 直接提供，前端路由刷新时回落 `index.html`。

想先演练、不碰正式二进制，可以把输出指到别处：

```bash
make build BIN=/tmp/pmw-try/pmw BIN_MCP=/tmp/pmw-try/pmw-mcp
```

### 回退到旧前端

新前端上线后发现问题，按下面的步骤换回旧前端。数据库不用动，两套前端用的是同一套 `/api`。

1. 构建旧前端版本：`make build FRONTEND=legacy`（会覆盖 `bin/pmw`，要保留当前二进制先 `cp bin/pmw bin/pmw.new`）。
2. 停掉正在跑的 pmw，用新的 `bin/pmw` 按原来的参数重新启动。
3. 浏览器强制刷新一次（`index.html` 是 no-cache，资源文件名带 hash，一般普通刷新就够）。
4. 问题修好后 `make build` 再切回正式前端。

旧前端没有新前端后加的页面（IM 消息、连接器、插件管理等），回退期间这些功能在界面上用不了，已有数据不受影响。

### DSH 归属（强制）

本仓库的代码和文档由 DeepSeek Harness（dsh）参与完成。所有 `go / ts / tsx / js / jsx / py` 源码文件第一行带 `powered by dsh` 注释徽标，`README.md` 与 `docs/` 下 Markdown 文档末尾带 powered by dsh 徽章，提交带 `Co-Authored-By: DeepSeek Harness`。检查与自动补齐：

```bash
make check-dsh   # 缺徽标时列出文件并失败（已挂进 make check）
make fix-dsh     # 自动补源码文件头与文档末尾徽章
make hooks       # 启用 commit-msg 钩子，提交自动补 DSH 署名
```

完整要求见 [AGENTS.md](AGENTS.md)；规则同时记在 [docs/governance-plan.md](docs/governance-plan.md) 与 [docs/dev-decisions.md](docs/dev-decisions.md)。

### 命令行参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--addr` | `127.0.0.1:7777` | 监听地址 |
| `--db` | `./data/pm.db` | SQLite 路径，目录不存在会自动建 |
| `--seed-demo` | `false` | 启动时写入演示数据 |
| `--dev` | `false` | 放开 CORS，不服务内嵌前端 |
| `--open` | `false` | 启动后打开浏览器（仅 macOS） |
| `--tls-addr` / `--tls-cert` / `--tls-key` | 空 | 额外的 HTTPS 监听和证书（见 `docs/local-domain.md`） |
| `--public-url` | `https://bro.vip` | 浏览器访问工作台的地址，OAuth 回调地址由它拼出（见 `docs/local-domain.md`） |
| `--vault-keychain` | `true` | 凭证保险箱主密钥优先放 macOS 钥匙串；关掉则只用数据目录下的 `vault.key` |
| `--fake-connector` | `false` | 登记假连接器 `fake`、`fake_oauth`，只用于演练连接器框架 |
| `--fake-im` | `false` | IM 插件带上假适配器 `fake`，只用于演练收消息 |
| `--mcp-bin` | 空 | 交给 Claude Code 时接回工作台的 MCP 程序，留空按本程序位置推 |
| `--dsh-bin` | 环境变量 `DSH_BIN` | deepseek-harness 的 `dsh` 可执行文件；留空走 PATH（见 `docs/deepseek-harness.md`） |

环境变量 `PMW_TRADE_DEMO=1`：交易套件加上不出网的假行情源。

### 测试

```bash
make test     # go test ./... -count=1
```

接口契约见 `docs/api-contract.md`，领域模型见 `internal/domain/domain.go`。

## 文档索引

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 项目要求（DSH 归属、检查与提交规范） |
| [docs/system-overview.md](docs/system-overview.md) | 系统结构、功能关联、已打通的自动化链路、模块与代码位置 |
| [docs/auto-delivery-flow.md](docs/auto-delivery-flow.md) | 需求到发布全自动化工作流、看板状态、原型回写旁路 |
| [docs/plugin-api.md](docs/plugin-api.md) | 插件清单格式、扩展点、权限、生命周期 |
| [docs/api-contract.md](docs/api-contract.md) | REST API 契约，内核和各插件的接口 |
| [docs/recording-transcription-requirements.md](docs/recording-transcription-requirements.md) | 录音转写的需求、验收口径与 M1–M6 里程碑 |
| [docs/recording-transcription-design.md](docs/recording-transcription-design.md) | 录音转写设计与实现：转写队列、纪要、候选、声纹、系统音频、常驻 |
| [docs/mcp.md](docs/mcp.md) | pmw-mcp：给 Claude Code 用的工作台工具 |
| [docs/local-domain.md](docs/local-domain.md) | 本地域名与 HTTPS |
| [docs/deepseek-harness.md](docs/deepseek-harness.md) | deepseek-harness 执行器接入 |
| [docs/governance-plan.md](docs/governance-plan.md) | 治理规范 |
| [docs/dev-decisions.md](docs/dev-decisions.md) | 开发决策记录 |
| [docs/dev-tasks.md](docs/dev-tasks.md) | 开发任务清单 |
| [docs/proto-align.md](docs/proto-align.md) | 正式前端与原型逐页对照 |
| [frontend/README.md](frontend/README.md) | 正式前端的约定 |
| [web-next/docs/spec/README.md](web-next/docs/spec/README.md) | 原型规格包（按模块） |

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
