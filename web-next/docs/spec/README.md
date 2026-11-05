# 原型规格包

原型 `web-next` 就是规格（见 `../dev-plan.md` 0 节）。这里把原型按模块整理成文字规格：截图、交互清单、数据结构、和其它模块的联动。每个开发任务都指向这里的一节，验收就是「真实产品和这一节一致」。

- 每个模块一份文件：`<模块 key>.md`，照 [`_template.md`](_template.md) 写。
- 截图在 `shots/<模块 key>/`，由 `shots.py` 生成，不手工放图。
- 规格和原型对不上时，先判断是哪边错：规格本身要改（需求变了）就改规格、再改原型；原型做错了就修原型。两种情况都要更新截图。

## 编号规则

规格里的每一节、每一条都有固定编号，开发任务、验收、需求讨论都用编号引用。

| 层级 | 格式 | 例子 | 说明 |
|---|---|---|---|
| 模块 | `SPEC-<模块 key>` | `SPEC-tasks` | 模块 key 用原型 `workspacedata.ts` 里 `MODULES` 的 key；设置是 `settings` |
| 节 | `SPEC-<模块 key>-<n>` | `SPEC-tasks-3` | 一个页面或一块独立功能一节。`-0` 固定是模块概述，页面从 `-1` 起 |
| 条 | `SPEC-<模块 key>-<n>.<m>` | `SPEC-tasks-3.4` | 节里的一条交互、空状态或异常状态，同一节里统一往下编，不分表重新起号 |

- 编号写在标题或表格第一列，原样出现，方便 `grep SPEC-tasks-3` 找到。
- 只往后加，不重排、不复用。新页面加在末尾；删掉的节或条保留编号，标「已废弃」并写明原因和日期。
- 开发任务的验收写「与 `SPEC-tasks-3` 对照通过」；只做其中几条就列条号，如 `SPEC-tasks-3.1 到 3.6`。
- 跨模块引用直接写编号，如「点来源标签跳到 `SPEC-messages-2`」。
- 实现状态（AUTO-11）：原型同步按上线代码回写原型和规格时，在条目最后一列末尾标「实现状态：已实现（原型同步 <短提交>）」「实现状态：未实现」「实现状态：已下线（代码 <短提交> 删除）」，新增的条目编号接该节现有最大号往后加；没标的条目视为还没和代码核对过。项目档案的「规格实现状态」（`SPEC-projects-15.25`）按同步记录汇总。

## 模块文件的结构

每份模块文件都按这个顺序，细节见 [`_template.md`](_template.md)：

1. **文件头**：模块 key、原型入口、源码和数据文件、截图目录、负责的开发任务、整理状态、最后对照的原型版本。
2. **`SPEC-<key>-0` 模块概述**：一句话说明、页面清单（每页对应哪一节）、模块共用的数据结构、和其它模块的联动总表。
3. **`SPEC-<key>-1` 起每个页面一节**，固定五块：
   - 截图：桌面（1440）和手机（375）宽度，亮暗各一张，引用 `shots/<key>/` 里的图；
   - 交互：每个按钮、链接、输入框做什么，点完页面怎么变；
   - 空状态和异常状态：没有数据、加载失败、校验不过、权限不够时显示什么；
   - 数据：这一页用到的字段，从 `web-next/src/*data.ts` 的类型导出，写成字段表；
   - 联动：这一页从哪些模块进来、会跳到或改动哪些模块。

数据字段表以原型源码为准：字段名、类型照抄 `*data.ts`，联合类型把取值都列出来；原型里没有类型、只在组件里临时拼的数据，写明「原型未定义类型」并说清字段从哪来。

## 截图

一条命令更新全部截图（在仓库根目录，原型 7778 要在跑）：

```bash
/opt/miniconda3/bin/python web-next/docs/spec/shots.py
```

- 它调 `scripts/smoke-proto.py`（`make smoke-proto` 用的同一个脚本）逐个点一级菜单、二级菜单和标签，每种主题 x 宽度开一个清空 localStorage 的新浏览器，用默认的全部模块工作台。
- 截图先落到临时目录，跑完按一级菜单分到 `shots/<模块 key>/`，再替换这个模块原来的图；原型没在跑时直接退出，已有截图不动。
- 文件名 `<页面>-<宽度>-<主题>.png`。页面是冒烟脚本记下的位置去掉模块名，例如 `shots/tasks/定时任务-1440-dark.png`；模块入口是 `入口-375-light.png`；项目详情的标签是 `第一个项目_标签_概览-...`。
- 默认宽度 375 和 1440、主题亮暗，压成 256 色 png 控制体积；冒烟里的 768 宽度只用来查横向滚动，不进规格包。
- 只更新某几个模块：`--only tasks,today`；换原型地址：`--url` 或环境变量 `PROTO_URL`；要原图：`--no-shrink`。
- 冒烟发现问题（console error、横向滚动）时照常更新截图，但会把问题列出来、退出码为 1，这时先看是不是原型和规格对不上。
- 抽屉、弹窗等需要额外操作才出现的状态，冒烟脚本不会截；需要时在模块文件里写清操作步骤，截图暂时先空着，等截图脚本支持再补，不手工往 `shots/` 放图。

截图是规格的一部分，跟规格一起提交；只放在这里，不放进 `web-next/src`。原型改了界面就重新跑一遍，和对应规格一起提交。

## 模块清单

| 模块 | key | 规格文件 | 截图 | 负责任务 | 状态 |
|---|---|---|---|---|---|
| 今日 | `today` | `today.md` | [shots/today](shots/today) | PROTO-04b | 已整理 |
| 任务 | `tasks` | `tasks.md` | [shots/tasks](shots/tasks) | PROTO-04b | 已整理 |
| 文档 | `library` | `library.md` | [shots/library](shots/library) | PROTO-04c | 已整理 |
| 联系人 | `contacts` | `contacts.md` | [shots/contacts](shots/contacts) | PROTO-04c | 已整理 |
| 会话 | `sessions` | `sessions.md` | [shots/sessions](shots/sessions) | PROTO-04c | 已整理 |
| IM 消息 | `messages` | `messages.md` | [shots/messages](shots/messages) | PROTO-04d | 已整理 |
| 项目 | `projects` | `projects.md` | [shots/projects](shots/projects) | PROTO-04d | 已整理 |
| 设置 | `settings` | `settings.md` | [shots/settings](shots/settings) | PROTO-04e（设置的全部分节：工作台与模块、连接器、模型服务商、Agent、知识库、技能、枚举值、运行异常、内网域名、外观） | 已整理（抽屉和子页截图待 shots.py 步骤补） |
| SOP | `sop` | [`sop.md`](sop.md) | [shots/sop](shots/sop) | PROTO-04f1（流程库、待我处理、执行记录、流程详情、发起执行、运行页、编排页、AI 协助、18 种节点的配置项、原型模拟清单） | 已整理（发现的 6 处原型问题记在 `SPEC-sop-0`，待另开修错任务） |
| 终端 | `terminal` | `terminal.md` | [shots/terminal](shots/terminal) | PROTO-04f2 | 已整理 |
| 浏览器 | `browser` | `browser.md` | [shots/browser](shots/browser) | PROTO-04f2 | 已整理 |
| 视频 | `videos` | [`videos.md`](videos.md) | [shots/videos](shots/videos) | PROTO-04f3（六个标签、系列详情、新建发布、发布记录抽屉、视频详情的制作流程和检查点、产出物和产出物抽屉、设置；引用任务 VID-01a 到 VID-08d） | 已整理（发现的 7 处原型问题记在 `SPEC-videos-0`，待另开修错任务） |
| 行情 | `markets` | [`markets.md`](markets.md) | [shots/markets](shots/markets) | PROTO-04f4（看盘、自选、期权 T 型报价、确定性行情和行情源；引用任务 TRD-01a 到 TRD-02b） | 已整理（发现的 3 处原型问题记在 `SPEC-markets-0`，待另开修错任务） |
| 盯盘 | `monitor` | [`monitor.md`](monitor.md) | [shots/monitor](shots/monitor) | PROTO-04f4（市场时段、盯盘墙、提醒规则和触发记录、提醒抽屉、提醒判定；引用任务 TRD-03a、TRD-03b） | 已整理（发现的 3 处原型问题记在 `SPEC-monitor-0`，待另开修错任务） |
| 策略 | `strategy` | [`strategy.md`](strategy.md) | [shots/strategy](shots/strategy) | PROTO-04f4（策略库、编辑页、快速回测、回测记录和对比、回测报告和扫参、运行记录、回测引擎约定；引用任务 TRD-04a 到 TRD-05c） | 已整理（发现的 3 处原型问题记在 `SPEC-strategy-0`，待另开修错任务） |
| 交易 | `trading` | [`trading.md`](trading.md) | [shots/trading](shots/trading) | PROTO-04f4（总览、持仓、委托、下单、策略运行和部署、交易账户、风控单列一节、实盘标记、今日卡片口径；引用任务 TRD-05a 到 TRD-08d）；TRD-08p（交易设置：实盘评审、trade:live、停用插件；对账抽屉） | 已整理（发现的 8 处原型问题记在 `SPEC-trading-0`，0.1 到 0.4 已由 TRD-08p 改掉，其余待另开修错任务） |
| 宽基监控 | `etf` | [`etf.md`](etf.md) | [shots/etf](shots/etf) | ETF-01b（TSK-0450：份额与资金流、异动、规则和规则抽屉；指标口径、7 条内置规则、判定规则；引用任务 ETF-01a、ETF-01b） | 已整理 |

状态：待整理 / 整理中 / 已整理（已和原型逐条对照）。规格文件写好后把文件名改成链接，并把这一行的状态改掉。

## 原型总览页

原型侧栏左下角「设置」右边的图标（或命令面板搜「原型总览」）打开总览页（PROTO-03，源码 `web-next/src/overview.tsx`）：每个模块一张卡，列出页面、一句话说明和规格编号，点页面名跳到原型里那一页，点编号在右侧展开规格的那一节。

- 总览直接读这里的文件，不用手工同步编号：模块状态读上面模块清单的「状态」列；状态不是「待整理」的模块，页面清单读规格文件 `SPEC-<key>-0` 里「页面清单」表（第一列写成 `[SPEC-<key>-<n>](#锚点)` 才认）；章节内容按 `## SPEC-<key>-<n>` 标题切。
- 还是「待整理」的模块，总览显示「规格待整理」，页面按原型二级菜单列（写在 `overview.tsx` 的 `DRAFT`）。PROTO-04f 写好规格、把状态改成已整理后，总览自动换成规格里的页面清单和编号。
- 点页面名落到哪个子页（二级菜单、设置分项、项目详情标签）写在 `overview.tsx` 的 `VIEW_OF`，按规格编号对；新规格里没对上的页面打开模块入口，需要时在那里补一行。
- 规格里的截图按 `shots/...` 相对路径从原型 dev server 读（`/docs/spec/shots/...`），只在 `npm run dev` 下能看到。
