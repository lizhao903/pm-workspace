# 大数据量展示审查（bulk content audit）

审查日期：2026-10-28
范围：web-next 原型全部一级模块 + 设置各分类，1440 / 390 两个宽度，亮色 / 暗色。
只出问题清单，没有改项目源码。

## 0. 怎么测的

- 副本：`/private/tmp/claude-501/-Volumes-project-0xBroleez-pm-workspace/332d2cac-6041-4a72-bd2a-96d5db218df9/scratchpad/bulk/`（src 复制、node_modules 软链、vite cacheDir 指到副本里，端口 7793，测完已按 pid 关掉）。
- 放大数据的脚本：副本里的 `src/bulk.ts`，在 `main.tsx` 里最先 import，就地往各个 `seed*` 数组里 push；App 里另外接了 `bulkFolders`（本地深层目录）、`bulkBacktests`（回测 100）、`bulkWorkbenches`（工作台 15 个）；浏览器开 13 个标签。
- 数据量：项目 30（每个 40 材料 / 20 原型 / 15 群聊 / 12 干系人 / 25 文档）、联系人 300、IM 消息 500、任务 400、定时任务 60、Webhook 30、文档 200 + 本地目录 200 个文件（最深 7 层）、SOP 40（执行 300）、Agent 30、会话 200、Agent 执行 200、产出 200、连接器每个工具都接上（51 个，另加 10 个各 30 工具的 MCP）、模型服务商 20、知识库 40、技能 60、运行异常 150、枚举每类 40 项、工作台 15（每个 8 组）、策略 50（回测 100、运行 80）、自选组 20（每组 60 个标的）、提醒 120（触发 200）、委托 300、持仓 80、交易账户 15、视频 120（系列 6）、发布 300、内网域名手动 40 条（加上原型自动分配共 632 条）。名字按「短 / 中 / 长 / 40 字以上超长」轮换。
- 截图：`/private/tmp/claude-501/-Volumes-project-0xBroleez-pm-workspace/332d2cac-6041-4a72-bd2a-96d5db218df9/scratchpad/bulk/shots/`，文件名 `<编号-场景>-<宽度>-<light|dark>.png`，下文只写前缀，比如 `13-tasks-390-light`。
- 性能：Playwright 里挂 PerformanceObserver(longtask) 量长任务；另做了一次 A/B（副本里临时关掉常驻的浏览器页再量）。
- 行号是审查时 `web-next/src` 的行号；主会话还在改这几个文件（App.tsx、projects.tsx、browser.tsx 等），行号可能有几行漂移，以函数名为准。

优先级口径：
- P0：布局被撑破、文字叠在一起、控件点不到。
- P1：数据一多就明显难用（找不到、翻不完、选不了），或者每次操作都卡。
- P2：体验打磨，不改也能用。

## 1. 最严重的 5 条

1. **B-01 常驻的浏览器页把每次操作拖慢 40~90ms**：浏览器模块隐藏时也整页挂着，每个「新标签页」各渲染一份全部原型列表（599 条），副本里常驻 18,285 个 DOM 节点；任何一次状态变化（点星标、标已处理、勾任务）都是 60~140ms 的长任务，关掉它之后降到 20~47ms。
2. **Q-01 行情页自选组标签叠字**：20 个自选组、长名字时，组标签固定 26px 高又不截断，文字换行后互相压在一起，基本点不准。
3. **C-01 联系人分组筛选横向超出视口**：分组跟枚举走，枚举一多，`.seg` 在 1440 下直接伸出右边界被裁掉，后面的分组点不到。
4. **G-01 / G-04 原生 select 一多就没法选**：加干系人 300 个联系人、关联文档 200 篇、发布选视频 120 集、内网域名选原型 599 个……全是原生下拉，没有搜索；而且 `select` 会被最长的选项撑宽，任务页「全部项目」占满一整行，干系人页把说明文字挤成一列两个字，390 下盯盘墙的下拉伸出屏幕。
5. **G-02 切换页面不复位滚动**：所有页面共用一个 `.content` 滚动容器，在联系人列表滚到底再点「任务」，任务页也是滚在中段打开的；列表一长，每次切模块都像「打开就在半截」。

## 2. 问题清单

### 全局 / 外壳

#### B-01 隐藏的浏览器页常驻渲染全部原型，拖慢所有交互 — P1
- 现象：任意页面点一次星标、标一次已处理，都是一次 60~140ms 的长任务（联系人 132/66/66ms，任务 127/60/134ms，IM 140/82/86ms）。临时去掉浏览器宿主后同样操作是 95/29/47、102/23/19、116/34/40ms，DOM 从 2.7 万降到 8.6 千。截图 `22-browser-1440-light`、`67-m-browser-390-light`。
- 原因：`App.tsx:1253-1254` 浏览器宿主在开了浏览器模块时一直挂载（只是 `hidden`），App 每次 setState 它都跟着重渲染；`browser.tsx:217-221` 每个 home 标签都渲染一份 `HomeView`；`browser.tsx:409-436` HomeView 把所有项目的原型平铺（599 条）。
- 建议：
  1. `browser.tsx:217` 只给当前标签渲染 `HomeView`，非当前的 home 标签不渲染内容（iframe 标签保留挂载以保住页面状态，home 和 drive 是纯数据视图，不需要常驻）。
  2. 宿主 `<div className="browser-host">` 里的 `BrowserPage` 用 `memo` 包一层，`prototypes` 在 App 里 `useMemo`（依赖 `projects`），这样别的模块的状态变化不再触发它重渲染。
  3. 原型列表本身见 B-02。

#### G-02 页面切换不复位内容区滚动 — P1
- 现象：联系人页把 `.content` 滚到 5000，切到「任务」后 scrollTop 仍是 5000，再切二级菜单「定时任务」是 2500。截图 `26b-backtests-1440-light`、`27b-positions-1440-light`、`27b-positions-390-light` 都是一打开就停在列表中段。
- 原因：`App.tsx:1148` 所有页面共用 `<main className="content">`；`App.tsx:724` `go()` 只改 page，不管滚动；各模块的二级菜单切换（taskView、sopView、strategyView、tradingView、section…）也一样。
- 建议：App 里给 main 挂一个 ref，`useEffect(() => { mainRef.current?.scrollTo(0, 0) }, [page, section, taskView, sopView, sessionView, strategyView, tradingView, videoView, projectId, projectTab, agentView])`。不要用 `key` 重挂 main，会把浏览器宿主一起卸掉。

#### G-03 App 每次渲染都重建命令面板条目和今日数据 — P1
- 现象：同 B-01 的长任务里，除浏览器外的剩余 20~47ms 主要是 App 自己：每次渲染都把全部任务、联系人、文档、会话、SOP、Agent、599 条原型启停命令拼成 `paletteItems`（约 1,600 条），即使面板没打开；`todayNeeds`、`todayRunning`、`messageCount`、`modelChoices`、`connToolChoices` 也每次全量重算。
- 原因：`App.tsx:688-` `paletteItems` 直接在 render 里构建；`App.tsx:497-535` 今日数据同样。
- 建议：`paletteItems` 改成 `const buildPaletteItems = () => [...]`，只在 `{palette && <CommandPalette items={buildPaletteItems()} />}` 时调用；今日、连接器工具清单这些用 `useMemo` 按各自依赖缓存。

#### G-04 带数据的原生 select 撑宽布局 — P0
- 现象：
  - 任务页「全部项目」下拉占满一整行（`13-tasks-1440-light`），视频页同（`23-videos-1440-light`）。
  - 项目干系人页「加干系人」下拉被 300 个联系人里最长的名字撑到 400px+，左边的说明文字被挤成一列两个字（`58-proj-stake-add-1440-light`、`60-m-stake-add-390-light`）。
  - 390 下盯盘墙的自选组下拉伸出屏幕右边（`25-monitor-390-light`），回测、持仓、委托、策略运行的筛选下拉也同样溢出（量到 `chip chip-select > SELECT` 超出视口）。
- 原因：`styles.css:241-242` `.chip-select` / `.chip-select select` 没有 `max-width`，原生 select 的宽度取最长选项；`projecttabs.tsx:124` 的 `.chat-filter` 也没有限宽，`.pt-head` 里的说明文字又没有 `min-width`。
- 建议：`.chip-select { max-width: 220px; min-width: 0; } .chip-select select { max-width: 100%; text-overflow: ellipsis; }`；`.pt-head .chat-filter { max-width: 260px; }`，`.pt-head .list-sub { flex: 1; min-width: 0; }`。选项多的换成 G-01 的可搜索选择器后这条自然消失，但 CSS 兜底要先加。

#### G-01 选项上百的原生 select 没有搜索 — P1
- 现象：下列位置都是原生 `<select>` 平铺全部选项，没有搜索，长名字在系统下拉里也看不全：

| 位置 | 选项量 | 代码 |
| --- | --- | --- |
| 项目 / 文档「关联『文档』里的」 | 200 篇 | `projects.tsx:359-362` |
| 项目 / 干系人「加干系人」 | 300 人 | `projecttabs.tsx:124-127` |
| 项目 / SOP「关联 SOP」 | 40 | `projecttabs.tsx:210-213` |
| 项目 / Agent「加 Agent」 | 30 | `projecttabs.tsx:259-262` |
| 任务列表、任务抽屉「项目」 | 30 | `tasks.tsx:106-110`、`tasks.tsx:274-277` |
| IM 抽屉附件「加进项目」 | 30 | `attachments.tsx:85-90` |
| 定时任务「执行哪个 SOP / 哪个 Agent」 | 40 / 30 | `schedule.tsx:180`、`schedule.tsx:189` |
| 会话列表「全部 Agent」 | 30 | `sessions.tsx:85-88` |
| 快速新建会话「项目」 | 30 | `quicksession.tsx:66` |
| 视频列表 / 视频详情「项目」「系列」 | 30 / 6 | `videos.tsx:255-260`、`videos.tsx:621`、`videos.tsx:632` |
| 发布抽屉「视频」、系列「加一集」 | 120 | `videopublish.tsx:573`、`videopublish.tsx:265` |
| 盯盘「提醒标的」 | 约 90（按市场分组） | `monitor.tsx:284-288` |
| 盯盘墙「自选组」 | 20 | `monitor.tsx:428-430` |
| 策略运行 / 回测「策略」 | 50 | `strategyruns.tsx:97`、`strategy.tsx:704` |
| 内网域名「指向项目原型」 | 599 | `domains.tsx:145-147` |

- 建议：在 `ui.tsx` 加一个共用的 `SearchSelect`（触发按钮沿用 `.chip chip-select` 外观，弹层沿用 `.menu` + 顶部 `.search search-sm` + `.menu-item`，可选 `group` 字段渲染 `.menu-label`，键盘上下回车同 `palette.tsx`）。选项少于 12 个时退回原生 select。项目里已经有两处现成写法可以抄：`apiconn.tsx:235` 的「搜工具」和 `trading.tsx:941` 下单抽屉的「搜代码、名称、交易所」。盯盘提醒标的直接复用下单抽屉那个标的搜索。

#### G-05 MountPicker 没有搜索 — P1
- 现象：Agent 编辑器「挂载技能」「挂载」(连接器)「挂载知识库」弹出 320px 高的菜单，60 个技能 / 50 个连接器 / 40 个知识库只能滚着找（`46-agent-mount-skill-1440-light`）。
- 原因：`agents.tsx:383-413` `MountPicker` 只有列表。
- 建议：弹层顶部加 `.search search-sm`，按 `render` 之外再传一个 `text(t)` 用于匹配；技能按「内置 / 自定义」、连接器按工具分类插 `.menu-label`。

#### G-06 命令面板空输入时「操作」组被工作台切换挤满 — P2
- 现象：⌘K 打开后「操作」组前 20 条里有 5 条是「切换到某工作台」，15 个工作台时会更多；599 条原型启停命令也挂在「操作」组（`37-palette-1440-light`）。
- 原因：`App.tsx:697-701` 工作台切换和原型启停都放进 `group: '操作'`。
- 建议：工作台切换单独一组「工作台」，原型启停单独一组「原型」，两组都不在 `IDLE_GROUPS`（`palette.tsx:16`）里，只在输入后出现。

### 今日

#### T-01「需要你处理」全量平铺 — P1
- 现象：237 件全部展开，SOP 一组就 180 条，首屏之后要滚很久才到 Agent、运行异常、连接异常（`01-today-1440-light`、`64-m-today-390-light`）。
- 原因：`today.tsx:68-79` 每组 `needs.filter(...).map` 不设上限；`App.tsx:497-526` 只有 IM 截了 `slice(0, 6)`，SOP、Agent、会话、异常、连接器都不截。
- 建议：每组按 tone（danger 在前）和时间排序后露 3 条，组标题右边放「查看全部 N 条」，跳到能批量处理的地方：SOP →「SOP / 待我处理」，Agent →「会话 / 执行记录」筛等你确认，运行异常 →「设置 / 运行异常」。`TodayItem` 加一个 `more?: () => void` 由 App 按 kind 传进来。

#### T-02「今天的任务」逾期全列 — P1
- 现象：61 条逾期 + 8 条今天 + 进行中高优先级全部列出，右栏长到看不到「今天还会自动执行」「正在运行」（`01-today-1440-light`）。
- 原因：`today.tsx:91-93`。
- 建议：合起来露 8 条（逾期按截止日升序在前），超出显示「还有 N 条，去任务」，点了 `onAllTasks` 并带上「逾期」筛选（TasksPage 现在没有逾期筛选，需要加一个 `due` 视图，见 K-02）。

#### T-03「正在运行」「今天还会自动执行」不封顶 — P2
- 原因：`today.tsx:98-112`；`App.tsx:531-535` 把所有项目所有在跑的原型都塞进 `todayRunning`。
- 建议：各露 5 条 + 「全部 N 个」，原型的入口跳浏览器首页（B-02 改完后按项目分组）。

### 项目

#### P-01 项目二级菜单平铺全部项目 — P1
- 现象：30 个项目全列在二级菜单，长名字各占两行，找项目只能滚（`02-proj-overview-bulk-1440-light`；390 下是一条横向滚动条，只能看到 2~3 个，`02-proj-overview-bulk-390-light`）。
- 原因：`projects.tsx:50-58` `ProjectsNav` 把 `projects.map` 直接当菜单项。
- 建议：照视频的做法，菜单只放视图和少量入口：「全部项目」（新的列表页：卡片网格 + 搜索 + 按「有原型在跑 / 有待回复 / 其他」分组）+「最近打开」6 个（按打开时间，App 里记一个 `recentProjects`）。`Subnav` 加一个可选的 `search` 插槽（`subnav.tsx`），任务、SOP、策略的菜单也能用。

#### P-02 概览「原型」卡片列出全部原型 — P1
- 现象：20 个原型全在概览里，概览页被撑到 1500px+（`02b-proj-overview-scroll-1440-light`）。同页「最新沟通」已经 `slice(0, 4)`，「进行中的任务」`slice(0, 5)`，原型这块没跟上。
- 原因：`projects.tsx:259-267`。
- 建议：运行中、启动失败的排前面，露 5 条；`mount-head` 右边加「全部」按钮 `onTab('prototypes')`，和上面几块一致。

#### P-03 概览「干系人」chips 全量 — P2
- 原因：`projects.tsx:237-241`。
- 建议：按角色顺序露 6 个 + `+N` 标签，点了去「干系人」页签。

#### P-04 沟通「绑定」弹层没有搜索，私聊列出全部联系人 — P1
- 现象：弹层里群聊列表和 300 个联系人的私聊列表连在一起，长群名不截断，伸出弹层右边（`03b-proj-comms-bind-1440-light`）。
- 原因：`projecttabs.tsx:52-68`。
- 建议：弹层顶部加搜索（`.search search-sm`），私聊默认只露最近联系的 8 个，输入后再搜全部；`.pt-bind .menu-item` 加 `min-width: 0` 和 `.ellipsis` 包住群名。

#### P-05 沟通「消息里的附件」全量压在消息上面 — P1
- 现象：10 个待决定的附件占满首屏，消息列表被推到下面（`03b-proj-comms-bind-1440-light`）。
- 原因：`attachments.tsx:127-136` `todo.map` 不封顶。
- 建议：默认露 3 个，`mount-head` 里加「还有 N 个」展开；超过 3 个时整块默认折叠成一行「N 个附件还没决定」。

#### P-06 沟通消息列表不分页 — P2
- 原因：`projecttabs.tsx:88-101`。
- 建议：先渲染 50 条，底部「加载更早的消息」。

#### P-07 干系人页：选人下拉 300 项 + 最近沟通算法是三重循环 — P1
- 现象：见 G-04 截图；每行「最近沟通」对每个干系人扫一遍全部消息、每条消息再扫一遍联系人。
- 原因：`projecttabs.tsx:124-127`（下拉）；`projecttabs.tsx:116` `lastMsg` = 干系人 × 消息 × 联系人。
- 建议：下拉换 G-01 的 `SearchSelect`；`lastMsg` 改成 `useMemo` 先把消息按 `contactFor` 归到联系人 id 上建一个 Map。

#### P-08 支持材料没有搜索、没有按类型分组 — P2
- 现象：40 条材料只有标签 chips 能筛，长链接一行铺满（`08-proj-materials-1440-light`）。
- 原因：`projects.tsx:322-345`。
- 建议：`filter-row` 前面加搜索框和类型 seg（文件 / 文件夹 / 链接 / 笔记，带数量）；链接 `a.link-btn` 加 `.ellipsis`，悬停 title 显示全址。

#### P-09 原型页签 20 张卡片全展开 — P2
- 原因：`projects.tsx:420-424`。
- 建议：运行中和启动失败的在前；已停止的超过 6 个时折叠成「已停止 N 个」一行，点开再展。

#### P-10 项目 Agent 页签的「项目里的会话」全量 — P2
- 原因：`projecttabs.tsx:283-293`。
- 建议：露 10 条 +「在会话里看全部」（跳会话页并按项目筛，会话页需要加项目筛选，见 A-03）。

### 联系人

#### C-01 分组筛选 seg 超出视口被裁 — P0
- 现象：40 个分组时 `.seg` 一行排开，1440 下从右边界伸出去被裁，后面的分组点不到（`11-contacts-1440-light`，量到 `seg > BUTTON` 超出视口）。
- 原因：`contacts.tsx:48-56` 把所有启用的分组都做成 seg 按钮；桌面没有 `overflow-x`（只在 `styles.css:371` 的 760px 以下才加）。
- 建议：seg 只放「全部」+ 人数最多的 5 个分组，其余收进一个「更多分组」的 `chip chip-select`（或 G-01 的 SearchSelect）；`countOf` 用 `useMemo` 一次算完（现在 `contacts.tsx:30` 每个分组扫一遍全部联系人）。

#### C-02 联系人表 300 行一次全渲染 — P1
- 原因：`contacts.tsx:91-116`。
- 建议：按排序方式分段：「最近联系」按 今天 / 本周 / 本月 / 更早 插分段行，「姓名」按首字母插分段行；先渲染 100 行，底部「显示更多」。表头 `.tr.th` 设 `position: sticky`。

### IM 消息

#### M-01 357 条待处理平铺，没有分组和分页 — P1
- 现象：列表只能一路往下滚，同一个群的消息被别的会话隔开（`12-messages-1440-light`）。
- 原因：`messages.tsx:203-258`。
- 建议：按天插分段（今天 / 昨天 / 更早），先渲染 50 条 +「加载更多」；工具条加一个「会话」SearchSelect（群名 + 私聊，按待处理数排序），方便只看某个群。

#### M-02 每行线性查联系人和任务 — P2
- 原因：`messages.tsx:205` `contactFor` 每行扫联系人，`messages.tsx:222`、`messages.tsx:247` 两次调用 `taskOf`（`App.tsx` 里是 `tasks.find`）。500 条 × 300 人。
- 建议：`MessagesPage` 里 `useMemo` 建 `Map<'channel:sender_id', Contact>`；App 传 `taskOf` 前先 `useMemo` 建 `Map<message_id, ref>`。

### 任务

#### K-01 二级菜单平铺全部 Webhook — P1
- 现象：30 个 Webhook 全挂在「Webhook 接入」分组下，菜单比内容还长（`13-tasks-1440-light`）。
- 原因：`tasks.tsx:47`。
- 建议：菜单只留一项「Webhook 接入」（desc 写「N 个，M 个最近推送失败」），点进去是一个 Webhook 列表页（沿用 `sched-row` 的表格写法：名称 / 启用 / 最近推送 / 失败标红 / 建了几条任务，带搜索），从列表进 `hook:<id>`；失败的 Webhook 仍在菜单项上用红点提示。

#### K-02 全部任务不分组、不分页 — P1
- 现象：243 条未完成任务一张表（`13-tasks-1440-light`）。
- 原因：`tasks.tsx:124-148`。
- 建议：默认按截止分段：逾期 / 今天 / 本周 / 以后 / 无截止，每段可折叠，段标题带数量；加一个「逾期」筛选给今日页跳转用（T-02）；每段先露 30 条 +「这一段还有 N 条」。

#### K-03 390 下任务行的元信息被挤成竖排 — P0
- 现象：「35 分钟前创建」一个字一行，任务行被撑得很高（`13-tasks-390-light`）。
- 原因：`styles.css:929` `.src-tag` 的 `max-width: 220px` 比 390 下整列还宽，`styles.css:945` `.task-meta` 里的时间 span 没有 `white-space: nowrap`。
- 建议：`.task-meta { overflow: hidden; } .task-meta .src-tag { flex: 0 1 auto; min-width: 0; } .task-meta > span:last-child { white-space: nowrap; flex: none; }`；760px 以下 `.src-proj` 只显示到 8em。

#### K-04 定时任务 60 行没有搜索和分组 — P2
- 原因：`schedule.tsx:38-60`。
- 建议：工具条加搜索和「做什么」seg（建任务 / 执行 SOP / 让 Agent 去做），停用的沉到底部折叠。

#### K-05 Webhook 推送记录全量 — P2
- 原因：`tasks.tsx:462`。
- 建议：露 20 条 +「更早的 N 条」。

### 文档

#### L-01 文档树默认全部展开 — P1
- 现象：工作台文档 200 篇四个分类全部展开（205 行）；本地目录 7 层全部展开，进来就是一长串（`16-library-1440-light`、`16b-library-dir-1440-light`）。
- 原因：`library.tsx:213` `closed` 初始是空集合，含义是「全部打开」。
- 建议：把状态反过来存「展开了哪些」：默认只展开第一层，以及当前阅读文档所在的那条路径；文件夹行右边用已有的 `.tree-count` 显示 `d.count`（`TreeDir.count` 已经算好了，没用上）。

#### L-02 深层目录缩进无上限 — P2
- 现象：第 7 层的文件名只剩 8 个字符左右（`16b-library-dir-1440-light`）。
- 原因：`library.tsx:224`、`library.tsx:238` `paddingLeft: 8 + depth * 14`。
- 建议：缩进封顶 `Math.min(depth, 4) * 14`，超过 4 层的文件夹行前面显示省略的路径片段（「…/level-5」）；阅读区标题下面已经有完整路径，不用再加。

#### L-03 「跳过了 N 个文件」提示和树的最后几行叠在一起 — P2
- 现象：树的最后两行文字从提示下面透出来（`16b-library-dir-1440-light` 左下角）。
- 原因：`library.tsx:290` 提示放在 `.ws-switch` 里、`styles.css:748` `.ws-switch` 没有底色，树滚动区和它之间没有分隔。
- 建议：`.ws-switch` 加 `background: var(--panel-2)`；提示挪进 `ws-btn` 的 `ws-btn-kicker` 那一行（「工作目录 · 跳过 12 个」），不单独占行。

### SOP

#### S-01 二级菜单平铺全部 SOP — P1
- 现象：40 个流程全在菜单里（`17-sop-runs-1440-light`；390 下是 42 项的横向滚动条，`65-m-sop-nav-390-light`）。
- 原因：`sop.tsx:30`。
- 建议：菜单只放「执行记录」「待我处理」「流程库」；流程库是新页面（卡片列表 + 搜索，卡片上显示最近执行时间和待处理数），菜单里再放「最近用过」5 个（按最近一次执行时间）。

#### S-02 执行记录 300 行不分组、不分页 — P1
- 原因：`sop.tsx:68-86`、`sop.tsx:96-111`。
- 建议：工具条加搜索和「流程」SearchSelect；按开始日期分段（今天 / 昨天 / 本周 / 更早），每段先露 30 条。

#### S-03 流程详情「最近执行」全量 — P2
- 原因：`sop.tsx:145-146` 把这个 SOP 的全部执行塞进 `RunRows`。
- 建议：露 10 条 +「在执行记录里看全部」（跳执行记录页并带流程筛选）。

### 会话

#### A-01 Agent 筛选做成了一排 chip — P1
- 现象：30 个 Agent 的 chip 把执行记录、产出结果的工具条撑成好几行（`19-agent-runs-1440-light`、`20-outputs-1440-light`）。
- 原因：`sessions.tsx:28-40` `AgentFilter`。
- 建议：保留「全部 Agent」+ 最常用的 4 个 chip，其余收进 SearchSelect；会话列表那边（`sessions.tsx:85-88`）用同一个组件，两处统一。

#### A-02 执行记录 200 条全部展开调用卡片 — P1
- 原因：`sessions.tsx:172-190` 每条都渲染全部 `CallCard`。
- 建议：等你确认的置顶并展开；其余收成一行（Agent / 状态 / 触发 / 时间 / 「N 次调用」），点开再展；先渲染 50 条。

#### A-03 会话列表、产出结果不分组 — P2
- 原因：`sessions.tsx:101`（会话 200 条）、`sessions.tsx:228`（产出 200 行）。
- 建议：会话按「今天 / 本周 / 更早」分段，筛选里加「项目」（P-10 的跳转要用）；产出先渲染 50 行。

#### A-04 新会话的 Agent 选择没有搜索 — P2
- 原因：`sessions.tsx:93-98` `agent-pick` 列出全部 Agent；`quicksession.tsx:66` 项目下拉同 G-01。
- 建议：`agent-pick` 顶部加搜索，最近用过的 5 个在前。

### 浏览器

#### B-02 首页「项目原型」599 条平铺 — P1
- 现象：（`22-browser-1440-light`）
- 原因：`browser.tsx:409-436`。
- 建议：按项目分组（组标题 = 项目名 + 「N 个在运行」），在跑的组展开、其余折叠；卡片头加搜索；「最近打开」已经有，放到原型卡片上面。

#### B-03 标签栏溢出没有提示，新建按钮被挤出视口 — P2
- 现象：13 个标签时标签栏横向滚动但滚动条隐藏，「+」在可视区外（`22-browser-1440-light`）。
- 原因：`browser.css:5-7` `.br-tabs` `overflow-x: auto` + 隐藏滚动条，`.br-tab` `min-width: 150px`；`browser.tsx:204` 「+」在滚动区里。
- 建议：`.br-tab` 改 `flex: 1 1 160px; min-width: 72px;` 像 Chrome 一样压缩；「+」挪出滚动区固定在右侧；标签超过可视宽时右侧放一个「全部标签」下拉。

### 视频（主会话已改过菜单和列表，以下是残留）

#### V-01 发布记录 300 行平铺，没有搜索、没有按视频分组 — P1
- 现象：（`23c-video-publish-1440-light`、`52-publish-1440-light`）
- 原因：`videopublish.tsx:456` `rows.map`；工具条只有平台和状态 chip（`videopublish.tsx:440-447` 一带）。
- 建议：沿用「全部视频按系列分组只露几集」的写法：按视频分组，组标题 = 视频标题 + 平台徽标 + 失败数，每组露 3 条 +「查看全部」；工具条加搜索（标题）。

#### V-02 发布抽屉、系列加集的视频下拉 — P1（并入 G-01 处理）
- 原因：`videopublish.tsx:573`（120 个视频）、`videopublish.tsx:265`。

### 行情

#### Q-01 自选组标签换行叠字 — P0
- 现象：20 个组、长名字时，组 chip 里的文字换成 2~3 行，chip 高度固定 26px，几行文字压在一起，左栏一半被组标签占掉（`24-markets-1440-light`、`24-markets-1440-dark`）。
- 原因：`markets.tsx:143-160` 每个自选组一个 chip；`markets.css:24-25` `.mk-groups .chip` 固定 `height: 26px`，没有 `white-space: nowrap` 和截断。
- 建议：先止血：`.mk-groups .chip { white-space: nowrap; max-width: 160px; } .mk-groups .chip > span:first-child { overflow: hidden; text-overflow: ellipsis; }`。组数超过 6 个时改成 390 下已有的「自选 xxx」按钮 + 下拉（带搜索）形态，桌面也用它，chip 只放置顶的 3 个。

### 盯盘

#### O-01 每秒整表重算 120 条提醒 — P1
- 现象：停在盯盘页 10 秒，9 次长任务共 769ms（每秒一次 52~114ms），其他页面同样 10 秒是 0。
- 原因：`monitor.tsx:376` `useNow(1000)` 让整个 `MonitorPage` 每秒重渲染；`monitor.tsx:454-485` 每行 `instOf`（线性找标的）+ `condValue`（放量条件还要现算 21 根 K 线）；`monitor.tsx:493-510` 200 条触发记录也跟着重渲染。
- 建议：把规则行拆成 `memo` 的 `AlertRow`，只有「当前值」那一格订阅 tick（单独的小组件里 `useNow`）；规则超过 30 条时只给可视区和启用的算当前值；触发记录拆成独立组件不吃 `now`。

#### O-02 提醒规则、触发记录全量 — P1
- 现象：（`25b-monitor-scroll-1440-light`）
- 原因：同上两处 map。
- 建议：规则工具条加「启用 / 已触发 / 停用」seg 和标的搜索；触发记录按天分段，露 20 条 +「更早的 N 条」。

#### O-03 提醒标的下拉没有搜索 — P1
- 现象：（`54-alert-drawer-1440-light`）
- 原因：`monitor.tsx:284-288`。
- 建议：复用下单抽屉的标的搜索（`trading.tsx:941` 一带），不另写。

### 策略

#### R-01 二级菜单列出全部策略 — P1
- 现象：50 个策略按首个标签分组全在菜单里（`26-strategy-1440-light`）。
- 原因：`strategy.tsx:173-191` `StrategyNav`。
- 建议：菜单只留「策略库」「回测记录」「运行记录」+「最近编辑」5 个；策略库页已经有搜索、模式和市场筛选，够用。

#### R-02 回测记录 100 行不分页、标的标签被硬裁 — P2
- 现象：标的列「ETH/U」「沪深300股指 2…」被列宽裁掉一半（`26b-backtests-1440-light`）；策略库同样（`26-strategy-1440-light`）。
- 原因：`strategy.tsx:738`、`strategy.tsx:246` 按个数截到 2 个，但不管宽度。
- 建议：标的格 `display: flex; overflow: hidden;` 第一个 tag 之后的放不下就收进 `+N`（容器 `min-width: 0`，tag `flex: none`，最后一个用 `max-width` + 省略号）；回测按策略分组折叠或先露 50 条。

#### R-03 运行记录 80 张卡片 — P2
- 原因：`strategyruns.tsx:115`；策略筛选下拉见 G-01。
- 建议：运行中和异常的置顶，已停止的折叠成「已停止 N 个」。

### 交易

#### X-01 下单抽屉账户卡片平铺 — P2
- 现象：15 个账户卡片把方向、价格、数量推到抽屉下半屏（`53-trade-order-1440-light`、`63-m-order-390-light`）。
- 原因：`trading.tsx:962` `accounts.map`。
- 建议：可下单的账户在前；不支持该市场、只读、连接异常的收成一行「其他 N 个账户不可用」，点开再看原因。

#### X-02 持仓 80 / 委托 300 不分页，持仓不按账户分组 — P2
- 原因：`trading.tsx:636` 起持仓表、`trading.tsx:764` 委托表。已有账户和市场筛选。
- 建议：持仓按账户分段（段标题带权益和浮盈），委托「历史委托」先露 50 条。

#### X-03 总览大数字被省略号截断 — P2
- 现象：「持仓浮盈 +$96,144,6…」（`27-trading-1440-light`）。数值是批量数据造出来的极端值，但截掉金额的尾数是误导。
- 原因：`trading.tsx:536-540` `.stat-value` 在窄卡片里被截断。
- 建议：超过 7 位用紧凑写法（`$96.1M`），完整数值放 `title`；不要对金额用 `ellipsis`。

#### X-04 总览账户列表全量 — P2
- 原因：`trading.tsx:609`。
- 建议：异常的在前，露 6 个 +「全部账户」跳交易账户页。

### 设置

#### W-01 工作台切换菜单里「设置…」被滚到底 — P2
- 现象：15 个工作台时，菜单底部的「工作台与模块设置…」要滚到底才看得到（`39-bench-switcher-1440-light`）。
- 原因：`workspaces.tsx:38-49`，`styles.css:1733` 整个菜单一起滚。
- 建议：列表区单独滚动，`menu-sep` 和「设置…」固定在菜单底部。

#### AG-01 Agent 编辑器「模型」把所有可用模型平铺成单选卡 — P1
- 现象：20 个服务商、100+ 个模型全部铺开，配置区要滚几屏才到指令和工具（`31b-agent-editor-1440-light`）。
- 原因：`agents.tsx:509-517` `models.filter(...).map`。
- 建议：默认只显示当前选中的模型卡 +「换模型」，点开后按服务商分组（`.menu-label`），带搜索；`ModelChoice` 已有 `note` 里的服务商名，加一个 `group` 字段即可。

#### AG-02 挂载的连接器展开后工具全量 — P2
- 原因：`agents.tsx:606-607` `c.tools.map`（每个 MCP 30 个工具）。
- 建议：工具超过 10 个时顶部加「搜工具」，沿用 `apiconn.tsx:235` 的写法。

#### AG-03 390 下 Agent 编辑器只剩约 200px 可编辑 — P2
- 现象：调试面板占下半屏，标题下的长说明不截断伸出右边（`61-m-agent-editor-390-light`）。
- 建议：760px 以下调试面板收成底部一个「调试」按钮，点开再覆盖；说明加 `.ellipsis` 或两行截断。

#### KB-01 知识库卡片「在用的 Agent」头像溢出卡片 — P1
- 现象：头像一行排开伸出卡片右边，暗色下更明显（`32-set-kbs-1440-light`、`32-set-kbs-1440-dark`）。
- 原因：`kbskills.tsx:16` `UsedBy` 全量渲染；`styles.css:1706` `.kb-users` 不换行不截断。
- 建议：露 5 个头像 + `+N` 圆标（title 里列全名）；技能列表的同一组件一起改好。

#### KB-02 知识库 / 技能抽屉「在用的 Agent」chip 溢出抽屉 — P1
- 现象：长名字的 chip 伸出抽屉右边被裁（`41-kb-drawer-1440-light`）。
- 原因：`kbskills.tsx:144`、`kbskills.tsx:250`；`styles.css:1711-1712` `.kb-user` 没有 `max-width`。
- 建议：`.kb-user { max-width: 100%; min-width: 0; } .kb-user > span:last-child` 省略号；超过 8 个折叠「还有 N 个」。

#### SK-01 技能抽屉「用到的工具」把所有连接器工具铺成勾选 chip — P1
- 现象：几百个「连接器 · 工具」chip 平铺；390 下抽屉内容被横向撑开，左半边看不到（`40-skill-drawer-1440-light`、`62-m-skill-drawer-390-light`）。
- 原因：`kbskills.tsx:219` `pool` = 全部能力 + 全部连接器工具（App 传进来的 `toolNames`），`kbskills.tsx:241-247` 全量渲染。
- 建议：只显示已选的工具 chip + 「加工具」按钮，弹出按连接器分组、带搜索的选择器（用 G-01 的 SearchSelect 多选模式，或 G-05 改好的 MountPicker）；内置能力那 9 项可以保留常显。

#### KB-03 知识库、技能、Agent 列表页没有搜索 — P2
- 原因：`kbskills.tsx:37-60`、`kbskills.tsx:171-195`、`agents.tsx:151-200`。
- 建议：工具条加 `.search`，技能页已经有来源 seg，放在它旁边。

#### EN-01 枚举表 key 列盖住「默认」单选 — P1
- 现象：`task_status_x10` 这类 key 伸进右边的「默认」列，单选按钮被压住（`34-set-enums-1440-light`）。key 规则允许 32 个字符（`enumdata.ts:82`），真实数据也会碰到。
- 原因：`styles.css:1152` key 列固定 120px，`enums.tsx:218` `.enum-k` 没有截断。
- 建议：`.enum-k { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }`，title 已经有。

#### EN-02 枚举组内 40 项没有搜索、停用项不折叠 — P2
- 原因：`enums.tsx:196-230`。
- 建议：组内工具条加「搜值」；停用的沉底并默认折叠。

#### IN-01 运行异常：抽屉打开后列表标题只剩一两个字 — P2
- 现象：（`42-incidents-drawer-1440-light`）
- 原因：`styles.css:1672` `.inc-row` 的列宽是按整页设计的，抽屉挤占后标题列被压缩。
- 建议：列表容器加 container query，宽度小于 640px 时隐藏「次数」「最近一次」两列（同 `styles.css:1177` 枚举表的做法）。

#### IN-02 运行异常 150 条不分页 — P2
- 原因：`incidents.tsx:55`（已有搜索和筛选）。
- 建议：先露 50 条；同模块同类的按指纹前缀再合并一层（「连接器 · 23 条」可展开）。

#### DM-01 内网域名 632 条平铺 — P1
- 现象：599 条原型自动分配的域名和手动的混在一张表，页面 DOM 2.7 万（`36-set-domains-1440-light`）。
- 原因：`domains.tsx:26` `allRoutes` 合并后 `domains.tsx:158-185` 全量渲染；`domains.tsx:145-147` 原型下拉 599 项。
- 建议：分两块：「手动配置」全量显示；「项目原型自动分配」按项目分组、默认折叠，组标题只显示「N 个域名，M 个冲突 / 测试失败」，有问题的组自动展开；表头加搜索（域名、目标端口）。原型下拉换 SearchSelect，按项目分组。

#### PV-01 模型服务商卡片长名换成 4 行 — P2
- 现象：（`43-provider-drawer-1440-light`）抽屉打开时卡片网格变窄。
- 原因：`models.tsx:43` `.pv-name` 没有截断。
- 建议：`.pv-name` 两行截断（`-webkit-line-clamp: 2`），完整名放 title。

### 暗色

暗色下没有发现只在暗色出现的问题；上面的溢出类问题（Q-01、KB-01、EN-01）在暗色下一样存在，边界更明显。

## 3. 统计

共 68 条（V-02 随 G-01 一起做，独立工作量算 67 条）：P0 4 条，P1 34 条，P2 30 条。

「最严重的 5 条」不完全按 P0 排：B-01、G-01、G-02 虽然是 P1，但影响所有模块，排在单页的布局问题前面。

| 优先级 | 编号 |
| --- | --- |
| P0 | G-04、C-01、K-03、Q-01 |
| P1 | B-01、G-02、G-03、G-01、G-05、T-01、T-02、P-01、P-02、P-04、P-05、P-07、C-02、M-01、K-01、K-02、L-01、S-01、S-02、A-01、A-02、B-02、V-01、V-02、O-01、O-02、O-03、R-01、AG-01、KB-01、KB-02、SK-01、EN-01、DM-01 |
| P2 | G-06、T-03、P-03、P-06、P-08、P-09、P-10、M-02、K-04、K-05、L-02、L-03、S-03、A-03、A-04、B-03、R-02、R-03、X-01、X-02、X-03、X-04、W-01、AG-02、AG-03、KB-03、EN-02、IN-01、IN-02、PV-01 |


## 4. 修复切分建议（可并行、互不冲突）

先做第 0 组，它产出的共用组件和全局样式是其他组的前置；第 0 组合进去以后，1~12 组可以同时开工，各组只动自己列出的文件。

`styles.css` 是全局热点：第 0 组负责其中所有「全局 / 共用类」的修改；其他组如果必须改 `styles.css`，只改自己模块那一段规则（下面写明），不碰别段，合并时按段落解决冲突。有独立 css 的模块（markets / trading / strategy / browser / videos / videopublish）只改自己的 css。

| 组 | 文件 | 包含的问题 | 说明 |
| --- | --- | --- | --- |
| 0 共用件（先做） | `ui.tsx`、`subnav.tsx`、`styles.css`（全局段：`.chip-select`、`.src-tag` / `.task-meta`、`.kb-users` / `.kb-user`、`.enum-k`、`.ws-menu`、`.ws-switch`） | G-04、K-03、EN-01、KB-01/KB-02 的 CSS 部分、W-01 的 CSS、L-03 的 CSS；新增 `SearchSelect`；`Subnav` 加 `search` 插槽 | 体量小，半天内能合进去 |
| 1 外壳 | `App.tsx`、`today.tsx`、`palette.tsx` | G-02、G-03、G-06、T-01、T-02、T-03，B-01 里 App 那一半（`memo` + `prototypes` 的 `useMemo`） | App.tsx 只有这一组改；其他组需要 App 多传参数的，先在组件里用可选 prop 兼容，最后由这一组接线 |
| 2 项目 | `projects.tsx`、`projecttabs.tsx`、`attachments.tsx` | P-01 ~ P-10，G-01 里项目相关的 5 处 | P-01 的「全部项目」页如果要 App 记最近打开，接线交给第 1 组 |
| 3 联系人与消息 | `contacts.tsx`、`messages.tsx` | C-01、C-02、M-01、M-02 | |
| 4 任务 | `tasks.tsx`、`schedule.tsx` | K-01、K-02、K-04、K-05，G-01 的任务 / 定时任务下拉 | K-02 的「逾期」视图给第 1 组的 T-02 用，先约定 view key 叫 `due` |
| 5 文档 | `library.tsx` | L-01、L-02，L-03 的结构部分 | |
| 6 SOP | `sop.tsx` | S-01、S-02、S-03 | 「流程库」新页面的路由 key 约定为 `sopView = 'library'`，App 接线交第 1 组 |
| 7 会话与 Agent | `sessions.tsx`、`agents.tsx`、`kbskills.tsx`、`quicksession.tsx` | A-01 ~ A-04、G-05、AG-01 ~ AG-03、KB-01/KB-02 的组件部分、KB-03、SK-01 | `kbskills.tsx` 用到 `agents.tsx` 的 `AgentAvatar`，放同一组避免互相等 |
| 8 浏览器 | `browser.tsx`、`browser.css` | B-01 里浏览器那一半（只渲染当前 home 标签）、B-02、B-03 | |
| 9 视频 | `videopublish.tsx`、`videos.tsx`、`videopublish.css` | V-01、V-02 | 主会话刚改过 `videos.tsx`，这组开工前先和主会话确认没有未合并的改动 |
| 10 行情与盯盘 | `markets.tsx`、`markets.css`、`monitor.tsx` | Q-01、O-01、O-02、O-03 | O-03 要复用 `trading.tsx` 里的标的搜索：把它抽成 `tradedata` 旁边的一个小组件文件（新文件，归这一组），第 11 组改成引用它 |
| 11 策略与交易 | `strategy.tsx`、`strategyruns.tsx`、`strategy.css`、`trading.tsx`、`trading.css` | R-01、R-02、R-03、X-01 ~ X-04 | 等第 10 组抽出标的搜索组件后，再把 `trading.tsx` 里的原实现换成引用（最后一步，冲突面只有一处） |
| 12 设置杂项 | `enums.tsx`、`incidents.tsx`、`domains.tsx`、`workspaces.tsx`、`models.tsx`，`styles.css` 里 `.inc-row` / `.pv-*` 两段 | EN-02、IN-01、IN-02、DM-01、W-01 的结构部分、PV-01 | |

建议顺序：第 0 组 → （第 1 组 + 2~12 组并行）→ 第 1 组最后统一接线（新页面路由、最近打开、跳转带筛选），再整体用副本数据跑一遍截图回归。副本和 `bulk.ts` 留在 scratchpad 里，回归时把 src 重新拷过去、按「0. 怎么测的」里的几处接线补上即可。
