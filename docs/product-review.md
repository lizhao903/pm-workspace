# 产品经理工作台走查（ALIGN-16）

2026-10-29。用真实数据把「产品经理工作台」的菜单逐页走一遍：今日、项目（列表和详情各页签）、任务、文档、IM 消息、联系人、会话、SOP、终端、浏览器、设置各节。每页对照原型（7778）和规格包，再从「产品经理每天怎么用」看：数据多了能不能找、筛选够不够、空状态和报错说得清不清、常用操作要点几下。ALIGN-03（`docs/proto-align.md`）记过、本次复核还在的，在条目里注明。

## 怎么走的

- 7796（测试实例，只读）：232 条任务（`source=import`，都没截止日）、62 个联系人（Acme、Globex 干系人）、5 个 Agent 会话、198 条产出结果、1 个 SOP 模板；没有项目、文档、IM 消息。浏览器里拦掉了所有非 GET 请求。
- 7794（临时后端，7796 库的只读备份副本，`--fake-im --fake-connector`，出网改投本机空端口）：用真实联系人灌了两个项目「Acme 客户端」「Globex 安全审计」（干系人 14 + 10 人、各绑一个群、18 条任务归到 Acme、5 篇文档），两个群和 6 个陌生人私聊共 109 条 IM 消息（含 @我、@all）；写操作（新建项目、加干系人、绑定、新建任务抽屉）在这里试。
- 宽度 1440 和 375，浅色；原型在 7778 上点开对照；Playwright 截图看完已删。
- 每条一行，能直接拆成一个任务。级别：P1 每天都会碰到、影响判断；P2 常用但能绕过；P3 小毛病。

## 对不上原型

| 编号 | 级别 | 页面 | 现象 | 为什么是问题 | 建议改法 | 涉及文件 |
|---|---|---|---|---|---|---|
| A-01 | P1 | 全局 / 命令面板（顶栏「搜索」、⌘K） | 搜「Acme」「周七」「Slack」「客户端」都是「没找到…相关的内容」，只能搜到功能模块和几个操作 | 规格写明命令面板能搜到项目（名称、说明、目录，`SPEC-projects-0` 联动）、联系人（含电话、邮箱、IM 编号，`SPEC-contacts-0`）和任务；数据多了以后这是最快的入口。框架已有（`provides.search`），但 `/api/plugins` 里各插件 `provides.search` 都是空的，内核模块也没登记数据源 | 内核任务、联系人在模块入口登记搜索数据源；projects、im 插件在 `plugin.json` 的 `provides.search` 声明并 `provide`；结果按「项目 / 任务 / 联系人 / 消息」分组，回车打开详情或抽屉 | `frontend/src/core/shell/CommandPalette.tsx`、`core/plugin/commands.ts`、`modules/tasks/index.ts`、`modules/contacts/index.ts`、`plugins/projects/index.ts`、`plugins/im/index.ts`、`internal/plugins/projects/plugin.json`、`internal/plugins/im/plugin.json` |
| A-02 | P1 | 项目详情 / 沟通 / 绑定面板 | 收进来的群消息不会登记成会话（`ingest.go` 只按编号找会话，找不到留空），绑定面板的群聊候选只从会话表取，新群收到再多消息也绑不上；私聊候选为空时写「联系人都已经绑过了」，实际 62 个联系人一个都没绑 | 规格 `SPEC-projects-4.4`、`4.5`：群聊候选是消息里出现过的群，私聊候选是还没绑的联系人。现在要先手工调接口建会话才能绑，空状态还说反了 | 后端收消息时没登记的会话自动登记（渠道 + 编号 + 群名 + kind）；私聊候选按联系人列，联系人有该渠道 IM 身份时取或建私聊会话，没有身份时这一项置灰并提示「先在联系人里填 IM 编号」；空状态按真实原因写 | `internal/plugins/im/ingest.go`、`docs/api-contract.md`（IM 一节）、`frontend/src/plugins/projects/commsModel.ts`、`CommsTab.tsx` |
| A-03 | P1 | 项目详情 / SOP、Agent 标签 | 仍是「『SOP』还在开发中」「『Agent』还在开发中」占位（ALIGN-03 F-09、F-10） | SOP 插件 0.3.0 已上线（流程库、执行记录、发起执行都能用），项目里看不到关联流程和最近执行，规格 `SPEC-projects-9` | SOP 标签先做：关联流程卡片（`props.sop_ids`，执行、取消关联）+ 最近执行；`GET /api/sop/runs` 现在只能按 `flow_id` 筛，按关联流程拉即可，或补 `project_id` 条件。Agent 标签等 Agent 表，先做「项目里的会话」 | `frontend/src/plugins/projects/model.ts`（TABS）、`ProjectPage.tsx`、新文件 `SopTab.tsx`、`internal/plugins/sop`（如补筛选）、`docs/api-contract.md` |
| A-04 | P2 | 任务抽屉 / 等你验收栏 | 原型的栏里有提交说明（做了什么、测试结果）和验收标准勾选清单，下面才是「验收通过 / 退回」；正式只有「claude-code · 会话 main-ses · 1 小时前提交」和两个按钮，提交说明在抽屉底部的进展里（抽屉内容 4800px 高） | `SPEC-tasks-5`；验收时要先滚到底读说明再滚回顶部点按钮 | 栏里放最近一条「提交验收」进展的正文、测试结果、提交号，加验收标准清单（本地勾选，不保存，同原型） | `frontend/src/modules/tasks/ReviewBar.tsx`、`ProgressTimeline.tsx`、`TaskDrawer.tsx` |
| A-05 | P2 | 设置 / 枚举值 | 只有「任务：优先级、关联关系」「产出物：产物平台、产物种类」；任务状态、联系人分组、文档分类、消息状态都不在这里；值表没有「说明」「使用中」两列 | 规格 `SPEC-settings-17.3`、`17.6`：按任务、联系人、文档、IM 消息、SOP、自定义分组，值表有说明和「N 条在用」。联系人分组（客户、合作伙伴、供应商 3 个 0 人的默认组）现在没地方改名或停用 | 补齐字典：任务状态、联系人分组、文档分类、消息状态；值表补说明、使用中两列；产出物（视频）一组只在启用视频模块的工作台显示 | `frontend/src/modules/settings/enums/EnumsSection.tsx`、`model.ts`、后端字典种子 |
| A-06 | P2 | SOP / 流程详情 | 节点上显示类型 key「video_run_stage」「video_wait_checkpoint」，头部「触发：manual」 | `SPEC-sop-5.2`、`5.9` 的类型标签和触发方式是给人看的名字，key 给用户看不懂；节点目录里本来就有显示名 | 用 `GET /api/sop/node-types` 的显示名；触发方式走中文标签（手动、定时、Webhook） | `frontend/src/plugins/sop/FlowGraph.tsx`、`FlowDetail.tsx` |
| A-07 | P3 | 任务列表 / 来源标签 | 行上来源写「导入」，二级菜单「人工创建 232 条」把导入的也算进去（`sourceModel.ts` 有意为之）；原型只有「人工」 | 同一条任务两处叫法不同，点「人工创建」看到的全是「导入」 | 行上标签也按「人工」显示（悬停「导入」），或二级菜单改名「人工创建和导入」 | `frontend/src/modules/tasks/sourceModel.ts`、`SourceTag.tsx` |
| A-08 | P3 | 任务状态 | 正式有「受阻」（后端任务状态集含 `blocked`），原型和 `SPEC-tasks-0` `TaskStatus` 没有 | 规格和产品不一致，验收时对不上 | 规格补「受阻」一行（不算结束、算未完成） | `web-next/docs/spec/tasks.md` |
| A-09 | P3 | 设置 / 运行异常 | 仍是「待开发」（ALIGN-03 F-17） | 今日的「运行异常」组、任务来源「运行异常」都指向这里 | 等运行异常后端；在此之前从设置菜单隐藏，或写明「还没有运行异常记录」而不是「待开发」 | `frontend/src/modules/settings/Page.tsx` |

## 数据多了不好用

| 编号 | 级别 | 页面 | 现象 | 为什么是问题 | 建议改法 | 涉及文件 |
|---|---|---|---|---|---|---|
| B-01 | P1 | 今日、项目列表、项目概览、项目标签红点 | 群里每条消息都算「待处理」：今日「135 件事等你处理」里 109 条是两个群的闲聊（「好的收到」也算）；项目卡片「65 条待回复」、概览「待回复消息 65」、「沟通」红点常亮 | 规格就是这么定的（`SPEC-today-1` IM 组取所有 `pending`），数据少时没问题，接上真实群后数字失去提醒作用，真正 @我 的 5 条被淹没 | 口径改成「与我相关」才进今日和项目待回复：@我、@所有人、私聊（`relevance` 非空）；其余群消息只在 IM 收件箱里。今日 IM 组按 @我 优先排。要先改规格 `SPEC-today-1`、`SPEC-projects-1`、`3` 的待回复口径（需用户拍板） | `frontend/src/plugins/im/index.ts`（今日卡片）、`plugins/projects/commsModel.ts`（`awaitingCount`）、`ListPage.tsx`、`Overview.tsx`、`web-next/docs/spec/today.md`、`projects.md` |
| B-02 | P1 | IM 消息 | 109 条待处理只能逐条点「已处理」；每行常驻 5 个按钮（已处理、回复、稍后、转任务、忽略） | 群消息一多，清收件箱要点上百下 | 选了会话筛选时出现「这个会话全部标为已处理」；列表加多选（勾选后底栏批量已处理、忽略）；后端加批量接口（按 id 列表或按会话 + 时间点之前） | `frontend/src/plugins/im/Page.tsx`、`model.ts`、`internal/plugins/im/actions.go`、`docs/api-contract.md` |
| B-03 | P1 | 联系人 / 分组 | 导入的分组是整串「Acme、Globex」，被当成第三个分组（9 人）；点「Acme」只出 24 人，漏掉同属两组的 9 人（周七、张三、李世豪等核心人）。表格里「Acme、Globex」标签压到右边一列（1440 和 375 都是） | 按项目找人是最常用的筛选，现在会漏人 | 分组改成可多选（数据上存数组或按「、」拆），筛选按包含匹配；导入脚本按「、」拆开；分组列标签超宽时截断加悬停 | `frontend/src/modules/contacts/model.ts`、`Page.tsx`、`contacts.css`、`internal`（stakeholders 的 `group` 字段）、`docs/api-contract.md` |
| B-04 | P2 | 联系人 / 搜索 | 搜「Randy」「fleetent」都「没有匹配的联系人」：别名和职责只写在备注里，搜索只覆盖姓名、公司、电话、邮箱、IM 编号；「Globex 信用卡」这种多词也搜不到 | 导入的 62 人别名全在备注里，按外号找不到人 | 搜索加上备注和标签；多个词按空格拆开、每个词都要命中（跨字段） | `frontend/src/modules/contacts/model.ts` |
| B-05 | P2 | 项目详情 / 干系人 / 加干系人 | 选择器只按姓名、公司、职位搜，搜「Acme」没结果；一次只能挑一个，加 14 个人要开 14 次；排序是拉丁名在前、中文按码位（侯、刁、刘、史…），和联系人页的拼音序不一样 | 新建项目时成批加人是固定动作 | 支持按分组、标签搜；多选后「加 N 人」；排序复用联系人页的拼音排序（`modules/contacts/pinyin.ts` 挪进 `core`，插件不能 import 模块） | `frontend/src/plugins/projects/StakeholdersTab.tsx`、`modules/contacts/pinyin.ts` → `core/` |
| B-06 | P2 | 任务列表 | 232 条任务都没截止日，「按截止日分段」只剩一段「无截止 65」，段内按优先级；「已完成 167」按编号正序，最近完成的在最后（「这一段还有 35 条」要点多次） | 不设截止日的人分段没用；看「刚做完的」最常见 | 已完成视图按完成时间倒序；加排序（优先级、最近更新、创建时间），无截止段内默认按最近更新 | `frontend/src/modules/tasks/model.ts`、`TaskList.tsx`、`Page.tsx` |
| B-07 | P2 | 任务列表 | 没有负责人筛选，搜索也不搜负责人（原型占位「搜索标题、编号、负责人」，正式「搜索标题、描述、编号」） | Claude Code 的开发任务和自己的事混在一起，想只看「我的」做不到 | 筛选条加负责人下拉（含「未分配」「我」）；搜索覆盖负责人名 | `frontend/src/modules/tasks/Page.tsx`、`model.ts` |
| B-08 | P2 | 会话 / 产出结果 | 198 条全是「提交 · 第三十 X 批提交 · MCP 回写」，产出列重复同一个批次名，真正区分的任务在来源列被截断 | 一眼看不出产出了什么；同一次提交对应七八个任务就重复七八行 | 产出列显示「提交号 + 批次说明」，来源列显示任务编号和标题（悬停全称）；同一提交合并成一行，展开看涉及的任务 | `frontend/src/modules/conversations/OutputsView.tsx` |
| B-09 | P2 | 会话列表 | 4 条「新会话 · 还没有消息」堆在列表里 | 点一下「新建会话」就落一条，试几次就满屏空会话 | 发出第一条消息时才落库；或列表默认隐藏空会话、离开时删除 | `frontend/src/modules/conversations/NewSession.tsx`、`ChatsView.tsx`、Agent 会话后端 |
| B-10 | P2 | 项目详情 / 沟通 | 65 条消息没有「与我相关」筛选和搜索，行上只有「回复」，不能标已处理 | 项目里看沟通是日常入口，处理完还得去 IM 页再点一遍 | 复用 IM 页的「与我相关」下拉和搜索；行内加「已处理」（悬停出现） | `frontend/src/plugins/projects/CommsTab.tsx`、`commsModel.ts` |
| B-11 | P2 | 375 宽度：任务、联系人、项目概览 | 任务标题只剩 4 个字（「真实接...」），优先级和状态占了大半；联系人分组标签压到「最近联系」上；项目概览 5 个数字卡各占一整行，滚两屏才到最新沟通 | 手机上主要是看和快速处理 | 窄屏任务行改两行（标题一行、标签一行）；概览数字卡窄屏两列或横向滑动 | `frontend/src/modules/tasks/tasks.css`、`TaskList.tsx`、`modules/contacts/contacts.css`、`plugins/projects/projects.css` |
| B-12 | P3 | IM 消息 / 与我相关 | 「@张三 验收标准麻烦再确认一下」不算 @我（用户本人就叫张三）；「我」的称呼只来自连接器账号和适配器 | 微信、飞书这类渠道按名字 @，认不出就漏 | IM 渠道配置里加「我的称呼」（多个，逗号隔开），后端合进 self handles | `internal/plugins/im/relevance.go`、`frontend/src/plugins/im/ChannelPanel.tsx`、`docs/api-contract.md` |

## 操作绕

| 编号 | 级别 | 页面 | 现象 | 为什么是问题 | 建议改法 | 涉及文件 |
|---|---|---|---|---|---|---|
| C-01 | P1 | 任务列表 + 任务抽屉 | 打开抽屉后列表收窄到约 280px，标题列整列消失，只剩编号、优先级、状态；二级菜单仍占 250px（原型也是这样） | 26 条待验收逐条看时只能靠编号认任务，J/K 切换没有参照 | 抽屉打开时二级菜单自动收起；窄列保留标题（两行截断），去掉来源标签、负责人、截止；规格 `SPEC-tasks-2` 的窄列规则同步改 | `frontend/src/modules/tasks/TaskList.tsx`、`tasks.css`、`core/shell`（二级栏收起）、`web-next/docs/spec/tasks.md` |
| C-02 | P2 | 任务抽屉（待验收） | 点开就是编辑表单（正文是原始 Markdown 文本框、状态、优先级、负责人…），进展、产出物、改动在下面 | 验收是高频动作，编辑是低频动作，顺序反了 | 待验收时默认顺序：等你验收栏（见 A-04）→ 改动 → 产出物 → 进展，任务字段折叠成「编辑任务」；正文默认预览 | `frontend/src/modules/tasks/TaskDrawer.tsx`、`DevSlots.tsx` |
| C-03 | P2 | 文档 | 只能看和加星标，不能新建、编辑（规格 `SPEC-library-0` 就这么定）；项目「文档」标签的「加文档」只能从文档库挑 | 产品经理写 PRD、纪要要绕到 Agent 或 MCP | 文档页加「新建文档」和编辑（复用任务抽屉的编辑 / 预览），项目文档标签加「新建并归到本项目」；先改规格（需用户拍板） | `frontend/src/modules/docs/Page.tsx`、`Reader.tsx`、`plugins/projects/DocsTab.tsx`、`web-next/docs/spec/library.md` |
| C-04 | P2 | 文档 | 文档树只按分类，看不出哪篇归哪个项目，也不能按项目筛 | 项目多了以后找某个项目的文档要逐篇点 | 筛选条加「全部项目」下拉；阅读区标签显示所属项目，点了去项目文档标签 | `frontend/src/modules/docs/Bar.tsx`、`Tree.tsx`、`Reader.tsx` |
| C-05 | P3 | 项目列表 / 新建项目 | 点「新建项目」立即落一个「新项目」并打开设置（规格 1.2 如此）；点两下就是两个，离开也不清，7794 上就堆了两个「新项目 · 筹备中」 | 误点留垃圾 | 名称没改过就离开时提示「这个项目还是空的，要删掉吗」；或名称输入框获焦、回车才落库（改规格） | `frontend/src/plugins/projects/ListPage.tsx`、`Settings.tsx` |
| C-06 | P3 | SOP / 流程库、流程详情 | 内置模板说明写「要改先复制一份」，页面只有删除、编辑、执行，没有复制；「视频周更」出现在产品经理工作台（这里没开视频模块，执行时选不了视频） | 想改模板没路可走；不相干的模板占位 | 流程详情加「复制」；流程库按当前工作台启用的插件过滤内置模板（节点来自未启用插件的不列，或标「需要视频模块」） | `frontend/src/plugins/sop/FlowDetail.tsx`、`Library.tsx` |

## 文案

| 编号 | 级别 | 页面 | 现象 | 建议改法 | 涉及文件 |
|---|---|---|---|---|---|
| T-01 | P3 | 项目列表 | 标题说明「按状态分组；点卡片打开项目」，实际已按「有原型在跑 / 有待回复 / 其他」分组 | 改成「有原型在跑、有待回复的排在前面；点卡片打开项目」 | `frontend/src/plugins/projects/ListPage.tsx:60` |
| T-02 | P3 | 项目概览 | 块名「进行中的任务」里列着未开工的任务（TSK-0267） | 规格 `SPEC-projects-3.3` 是「未完成任务按优先级」，块名改「未完成的任务」，规格同步 | `frontend/src/plugins/projects/Overview.tsx`、`web-next/docs/spec/projects.md` |
| T-03 | P3 | SOP / 流程详情 | 已经在某个流程里，空状态仍写「从流程库里选一个标准流程开始执行」 | 改成「点右上「执行」跑一次」 | `frontend/src/plugins/sop/FlowDetail.tsx:68` |
| T-04 | P3 | 对象类型（MCP、接口） | `/api/object-types` 里任务类型叫「待办」，界面全叫「任务」 | 内置类型名改「任务」，复数「任务」；MCP 的 `pmw_list_types` 跟着变 | 后端对象类型种子（迁移只加不改，需新迁移或启动时更新名称） |

## 报错和空状态

| 编号 | 级别 | 页面 | 现象 | 为什么是问题 | 建议改法 | 涉及文件 |
|---|---|---|---|---|---|---|
| E-01 | P2 | 项目详情 / 绑定面板 | 私聊候选为空时写「联系人都已经绑过了」，其实是没有登记的私聊会话（见 A-02） | 让人以为都绑好了 | 按原因分开写：没有联系人 / 联系人都没填 IM 编号 / 都已绑过 | `frontend/src/plugins/projects/CommsTab.tsx:151`、`commsModel.ts` |
| E-02 | P2 | 项目详情 / 干系人 | 后端不校验角色，经接口或 MCP 写入不认识的角色 key（试了 `owner`）照样存下，界面显示成「对接人」、下拉也停在对接人 | 数据错了界面看不出，改一次就悄悄覆盖 | 后端校验 `role` 只能是五个 key，不对回 400；前端遇到未知值显示原值并标红 | `internal/plugins/projects`（干系人接口）、`frontend/src/plugins/projects/StakeholdersTab.tsx` |
| E-03 | P3 | 联系人列表 | 62 人全部「未联系」，排序「最近联系」时整页只有一段「未联系 62」 | 导入的人都没有最近联系时间，默认排序没用 | 没有最近联系的人多于一半时默认按姓名排；或「记一次联系」之外，从 IM 消息自动更新最近联系（有 IM 身份的人） | `frontend/src/modules/contacts/model.ts`、`internal/plugins/im`（收消息时回写 `last_contact_at`，要跨内核接口） |

## 数据或环境造成的（不用改）

| 编号 | 页面 | 现象 | 原因 |
|---|---|---|---|
| D-01 | 项目、文档、IM 消息 | 7796 上都是空状态 | 测试库里还没有这几类数据；带数据的样子在 7794 灌数据后看的 |
| D-02 | 设置 / 连接器 | 「研发协作」下有「测试连接器」「测试 OAuth 连接器」 | 7794 带了 `--fake-connector` |
| D-03 | IM 消息 / 渠道配置 | 收件箱有 109 条，渠道配置却写「还没接入 IM 渠道」 | 消息是假适配器回调灌的，没挂连接器 |
| D-04 | 任务 | 状态显示「未开工」、P0 叫「最高」，原型是「待办」「紧急」 | 字典 label 不同，同 ALIGN-03 D-02 |

## ALIGN-03 复核

本次走到时顺带看了 ALIGN-03 的条目：F-01（今日 IM 组）、F-03（项目列表按原型、待回复分组）、F-04（概览五个数字和最新沟通）、F-07（干系人最近沟通）、L-01（抽屉停靠、列表收窄）已经做了；F-14 做了一半（产出结果有了类型切换和 Agent 筛选，内容问题见 B-08）；F-09、F-10 见 A-03，F-17 见 A-09，还没做。

## 派批建议

1. 第一批（P1，互相独立，可并行）
   - A-01 命令面板搜索数据源：内核任务、联系人一个代理，projects、im 插件一个代理（都要改各自 `plugin.json`，版本号各升一次）。
   - A-02 + E-01 收消息登记会话、绑定面板候选：一个代理，后端 `im/ingest.go` 加前端 `projects/CommsTab.tsx`。
   - B-03 联系人多分组：一个代理，前后端加导入数据修正（要动线上 7796 数据时先停下问用户）。
   - C-01 抽屉打开时任务列表保留标题：一个代理，只改任务模块和外壳二级栏。
   - B-02 IM 批量已处理：一个代理（和 A-02 都动 IM 插件，错开文件：本条改 `actions.go`、`Page.tsx`）。
   - B-01 待回复口径：先请用户拍板（改规格），定了再派，涉及 IM 今日卡片和项目三处计数。
2. 第二批（P2）
   - A-04 + C-02 任务抽屉验收区重排：一个代理。
   - B-06 + B-07 任务列表排序和负责人筛选：一个代理（和上一条都在任务模块，错开 `TaskDrawer` 与 `TaskList`）。
   - B-05 干系人多选和拼音排序、B-10 项目沟通筛选：项目插件一个代理。
   - A-03 项目 SOP 标签：一个代理（项目插件 + SOP 接口，和上一条错开文件）。
   - B-04 联系人搜索、E-03 联系人排序：一个代理。
   - B-08 产出结果、B-09 空会话：会话模块一个代理。
   - A-05 枚举值补齐、A-06 SOP 节点中文名、C-06 SOP 复制和模板过滤：设置一个、SOP 一个。
   - C-03 文档可写（先拍板）、C-04 文档按项目筛：文档模块一个代理。
   - B-11 窄屏三处：一个代理，只改 CSS 和少量结构。
3. 第三批（P3，可合成一个小批）：A-07、A-08、A-09、B-12、C-05、T-01 到 T-04、E-02。

需要用户拍板的两件：B-01（群消息不算待回复，改今日和项目的口径）、C-03（文档模块能新建和编辑，改 `SPEC-library-0`）。

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
