# 一人之下 · 系统结构与功能关联

> 2026-11-04 依据 feat/prototype-dev-loop 分支代码整理，2026-11-11 补录音转写插件。7796（data-dev）为生产实例。

## 1. 系统结构

```mermaid
graph TB
  U["用户（浏览器）"]

  subgraph FE["前端层 · React，嵌入 pmw 单文件"]
    direction LR
    SHELL["外壳<br/>导航 / 通知 / 提醒弹窗"]
    MODS["内核页面<br/>今日 / 任务（交给 CLI、定时任务）/ 文档<br/>联系人 / 对话（AI 助手）/ 设置（预置提示词、连接器、版本）"]
    PUI["插件页面<br/>消息 / 项目 / SOP / 终端 / 视频 / 域名 / 浏览器 / 录音"]
  end

  subgraph CORE["内核层 · Go cmd/pmw"]
    direction LR
    API["HTTP API + SSE"]
    STORE["对象存储<br/>需求 / 任务 / 项目 / 资料 / 笔记"]
    EV["事件流<br/>object.* / run.finished / im.*"]
    RUN["执行器<br/>拼提示词 + 拉起 Claude Code"]
    AG["Agent<br/>多模型对话 + 知识库 + 工具"]
    SCH["定时任务<br/>建任务 / 提醒"]
    NT["通知中心"]
    CON["连接器 + 凭证保险箱"]
    DOCFS["文档目录挂载"]
    AU["审计日志"]
    DB[("SQLite")]
  end

  subgraph PL["插件层 · 经插件宿主接入事件、SOP 节点、页面"]
    direction LR
    IM["IM 消息<br/>收发 / 转任务 / 转资料 / 回执"]
    SOP["SOP 编排引擎"]
    PRJ["项目"]
    TERM["终端"]
    VID["视频创作"]
    DOM["内网域名 / 内置浏览器"]
    REC["录音转写<br/>本机 whisper / ffmpeg"]
  end

  subgraph EXT["外部系统"]
    direction LR
    CC["Claude Code CLI"]
    MCP["pmw-mcp<br/>工作台 MCP 服务"]
    IMX["Slack / Telegram"]
    LLM["Anthropic / OpenAI<br/>Gemini / Ollama"]
    GG["Google 日历 / 云盘"]
    FS["本机目录<br/>示例资料库 / PRD"]
    VP["B站 / YouTube / 抖音"]
  end

  U --> SHELL
  SHELL --- MODS & PUI
  FE <-->|"REST 请求 / SSE 推送"| API
  API --> STORE & RUN & AG & SCH & CON & DOCFS
  STORE --> DB
  STORE --> EV
  STORE --> AU
  SCH --> NT
  EV -->|"事件订阅"| PL
  PL -->|"读写对象 / 发通知"| STORE
  RUN --> CC
  TERM --> CC
  CC --> MCP -->|"回写进度 / 产出"| API
  CC --> FS
  DOCFS --> FS
  AG --> LLM
  CON --> GG
  IM <--> IMX
  VID --> VP
```

## 2. 功能关联（任务从哪来、到哪去）

```mermaid
flowchart LR
  subgraph IN["入口"]
    A1["IM 消息<br/>Slack / Telegram"]
    A2["手动新建"]
    A3["定时任务"]
    A4["AI 对话"]
    A5["Claude Code 通过 MCP"]
  end

  subgraph OBJ["工作台对象"]
    T["任务"]
    R["需求"]
    P["项目"]
    D["文档 / 资料"]
    C["联系人 / 会话"]
  end

  subgraph EXE["执行"]
    H["交给 CLI / 终端<br/>任务自动进行中"]
    PRE["预置提示词<br/>产品经理工作台 / 研发 / 调研"]
    CLI["Claude Code 执行<br/>写 PRD / 改原型 / 写代码"]
    S["SOP 流程"]
  end

  subgraph OUT["反馈"]
    O1["回复原 IM 消息"]
    O2["工作台通知 / 提醒弹窗<br/>右下角 或 中间弹窗"]
    O3["产出登记<br/>commit / 文件 / 链接"]
    O4["任务完成"]
  end

  A1 -->|"转任务"| T
  A1 -->|"转资料"| D
  A1 --> C
  A2 --> T & R
  A3 -->|"建任务"| T
  A3 -->|"提醒"| O2
  A4 --> T & D
  A5 --> T & O3

  R --> T
  T --> P
  D --> P
  C --> P

  T --> H
  PRE --> H
  H --> CLI
  CLI -->|"run.finished"| S
  CLI --> O3
  CLI --> O4
  A1 -.->|"IM 任务回执"| S
  S -->|"等任务完成"| O1
  O4 --> O2
```

## 3. 已打通的自动化链路：IM 消息 → 任务 → Claude Code → 回复

```mermaid
sequenceDiagram
  autonumber
  participant IMU as IM 用户
  participant IM as IM 插件
  participant K as 内核（任务 / 事件）
  participant SOP as SOP 引擎
  participant CLI as Claude Code
  participant ME as 我（工作台）

  IMU->>IM: 发消息
  ME->>IM: 转任务（勾选「执行完成后在原消息里回复」）
  IM->>K: 建任务（带来源消息）
  IM->>SOP: 启动「IM 任务回执」流程
  SOP->>SOP: 第 1 步 等任务完成（最长 14 天）
  ME->>K: 交给 CLI（选预置提示词）
  K->>K: 任务改为进行中
  K->>CLI: 提示词 = 任务 + 来源消息 + 执行要求<br/>软链目录用 --add-dir 放行
  CLI-->>K: 执行结束 run.finished（状态 + 摘要）
  K-->>SOP: 事件触发，继续流程
  SOP->>IM: 第 2 步 回复原消息
  IM->>IMU: 「任务标题」（编号）已完成 + 结果（只回结论）
```

## 4. 模块与代码位置

| 层 | 模块 | 代码位置 |
| --- | --- | --- |
| 前端外壳 | 导航、通知、提醒弹窗 | frontend/src/core/shell |
| 前端模块 | 今日、任务、文档、联系人、对话、设置 | frontend/src/modules/* |
| 前端插件 | 消息、项目、SOP、终端、视频、浏览器、域名、录音 | frontend/src/plugins/* |
| 内核 | HTTP API、执行器、Agent、定时任务、通知、连接器、保险箱、审计 | internal/{api,runner,agent,schedule,notify,connector,vault,audit} |
| 插件 | IM、SOP、项目、终端、视频、域名、浏览器、录音 | internal/plugins/* |
| MCP | 给 Claude Code 用的工作台工具 | cmd/pmw-mcp |
| 原型与规格 | 演示原型、SPEC 文档 | web-next/、web-next/docs/spec |

交易套件（internal/plugins/trade）整体暂停，图中未画。

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
