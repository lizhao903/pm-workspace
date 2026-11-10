# 正式前端与原型逐页对照（ALIGN-03）

2026-10-29。正式前端 `frontend/` 已实现的页面和原型 `web-next/`（7778）逐页对照的结果，下一批按这里派任务。外壳（侧栏、顶栏、工作台标识、菜单红点，ALIGN-01）和任务页、二级栏布局（ALIGN-02）不在范围内；和它们相关的地方只写「交给 ALIGN-0x」。

## 怎么对照的

- 后端：7796 库的只读备份副本，临时实例 7797（`--fake-im --fake-connector`），灌了 4 个联系人和 Slack 身份、3 个会话（两个群一个私聊）、3 个项目（干系人、绑定的群、两条资料、三条任务、两篇文档、一个停着的原型）、5 条 IM 消息（带文件、图片、链接附件，@我、@all、陌生人各一条）、一个假连接器。
- 前端：`PMW_API=http://127.0.0.1:7797 npx vite --port 7790`，1440 和 375 宽度、浅色截图。
- 原型：规格包截图 `web-next/docs/spec/shots/`，抽屉、表单这些规格包里没有的，在 7778 上点开现截。
- 规格：`web-next/docs/spec/*.md` 的条目编号写在每条差异里，方便验收时对照。
- 编号：`L` 布局，`T` 文案，`F` 缺功能，`D` 数据造成的不同（不用改）。每条一行能拆成一个任务；建议怎么合批见文末。

## 布局

| 编号 | 页面 | 原型 | 前端 | 建议改法 | 涉及文件 |
|---|---|---|---|---|---|
| L-01 | 所有带抽屉的页（IM 消息、联系人、设置的连接器和模型服务商，今日和项目里的任务抽屉） | 抽屉打开时停靠在右边，左边列表收窄重排：IM 消息的行内按钮换到正文下面，联系人表格只留星标、姓名、分组、IM 渠道、最近联系，连接器、服务商卡片变一列，顶栏说明收起 | 抽屉盖在列表上，列表右半截被挡住，宽度不变 | 外壳内容区加「抽屉停靠」模式：`Drawer` 打开时给内容区右侧留出 `--drawer-w`，各页按容器宽度（container query）收列，复用已有的 760px 窄屏规则。先改共用部分，再逐页核对收列 | `frontend/src/core/ui/Drawer.tsx`、`core/ui/components.css`、`core/shell/*`（内容区）、`plugins/im/im.css`、`modules/contacts/contacts.css`、`modules/settings/connectors/connectors.css`、`modules/settings/providers/providers.css` |
| L-02 | 项目详情 / 沟通 | 「消息里的附件」放在右栏消息列表上面，和渠道列表并排（SPEC-projects-4.13、5.3）；待决定多于 3 个时折成一行带「逐个决定」 | 附件块横跨整页，压在渠道列表和消息上面 | 把 `AttachmentInbox` 挪进右栏、消息列表之前；折叠规则照 5.3 到 5.5 核对 | `frontend/src/plugins/projects/CommsTab.tsx`、`AttachmentInbox.tsx`、`projects.css` |
| L-03 | 项目详情 / 沟通 | 消息行右上「相对时间 回复」同一行；渠道列表标题右侧「绑定」是描边小按钮 | 「回复」掉到时间下面第二行；「绑定」是文字链接 | 时间和动作放一个 flex 容器；「绑定」换 `Button size="sm" variant="outline"` | `frontend/src/plugins/projects/CommsTab.tsx`、`projects.css` |
| L-04 | 项目详情 / 沟通、概览 | 附件小标签带种类图标（文件、链接），同 SPEC-messages-1.16 | 只有文字 | 复用 IM 插件消息行附件标签的写法（图标 + 名字 + 悬停「种类 · 大小」）；插件之间不能 import，挪到 `core/ui` 或在项目插件里照写 | `frontend/src/plugins/projects/CommsTab.tsx`、`plugins/im/parts.tsx`（参考）、`core/ui` |
| L-05 | 项目详情 / 概览 | 数字卡片 5 格一行；摘要块是两列网格：最新沟通、进行中的任务、干系人、项目目录、项目 Agent、原型、最近的文档和材料；行之间有分隔线；「全部」是灰色小字 | 3 格；4 个摘要块；行无分隔线；「全部」是蓝色链接 | 补齐块（见 F-04）后按原型排列顺序；`.pj-link` 在块标题处改成 muted，行加 `border-bottom: 1px solid var(--line)` | `frontend/src/plugins/projects/Overview.tsx`、`projects.css` |
| L-06 | 今日、项目概览、项目任务标签 | 任务编号用强调色（`var(--accent)`，等宽） | 编号是 `--faint` 灰色 | `.today-ref`、`.pj-ref` 改为强调色；和 ALIGN-02 改任务页时用同一个样式 | `frontend/src/modules/today/today.css`、`plugins/projects/projects.css` |
| L-07 | 今日、项目任务标签、项目概览 | 优先级标签「P0 紧急」：编号加名称，按字典颜色铺底 | 只显示编号「P0」 | 用 ALIGN-02 在任务页做的优先级标签（编号 + 字典 label + color），今日和项目任务标签一起换 | `frontend/src/modules/today/Page.tsx`、`plugins/projects/TasksTab.tsx`、`Overview.tsx` |
| L-08 | 项目详情 / 干系人 | 关注点是无边框的行内输入（像文字，悬停、聚焦才出框）；角色下拉是圆角小胶囊；行高约 60px | 关注点是带边框的普通输入框；角色是方角原生下拉；行高约 50px | 关注点输入加 inline 样式（透明边框，hover/focus 显示）；角色下拉套圆角 chip 样式（同文档标签的状态下拉） | `frontend/src/plugins/projects/StakeholdersTab.tsx`、`projects.css` |
| L-09 | 项目详情 / 文档 | 状态下拉是带颜色的圆角胶囊 | 方角下拉，颜色只在文字上 | 和 L-08 的角色下拉共用一个圆角 select 样式 | `frontend/src/plugins/projects/DocsTab.tsx`、`projects.css` |
| L-10 | 项目详情 / 设置 | 标签条下面 18px 就是第一张卡片；「删除项目」是说明文字后面紧跟的描边按钮 | 第一张卡片上方空出约 36px；「删除项目」靠右、无边框 | 去掉设置页顶部多余的 margin；删除按钮改成 `variant="outline"` 跟在说明后面 | `frontend/src/plugins/projects/Settings.tsx`、`projects.css` |
| L-11 | 项目列表 | 卡片底部：「原型 运行数/总数」「N 条待回复」「N 个未完成任务」一行，目录最后一段另起一行（等宽） | 「N 个未完成任务」和目录挤在同一行 | 目录单独一行；补原型数和待回复数（见 F-02） | `frontend/src/plugins/projects/ListPage.tsx`、`projects.css` |
| L-12 | IM 消息 | 渠道切换「全部渠道 / 各渠道」在工具条下面单独一行，从左排起 | 渠道少时跟在工具条同一行最右边 | `.im-channels` 改成 `flex-basis: 100%` 独占一行 | `frontend/src/plugins/im/im.css` |
| L-13 | 联系人 / 新建、编辑抽屉 | IM 渠道一行：左边渠道名是和输入框等高的色块；占位文字是正文字体 | 渠道名是小胶囊，比输入框矮；占位是等宽字体 | 渠道标签改成等高色块（高度同 `Input`）；输入框值用等宽、占位用正文字体（`::placeholder { font-family: var(--sans) }`） | `frontend/src/modules/contacts/ContactForm.tsx`、`contacts.css` |
| L-14 | 联系人 / 抽屉（查看） | 没填的 IM 渠道整行变淡（渠道名也淡）；「复制」只在悬停时出现 | 渠道名照常着色；「复制」一直显示 | 未填行加 `.is-empty` 降低不透明度；复制按钮 hover 才显示（触屏常显） | `frontend/src/modules/contacts/ContactView.tsx`、`contacts.css` |
| L-15 | 设置 / 工作台与模块 | 模块行右侧是开关（`SPEC-settings-2.21`），分组「默认折叠」也是开关（2.17）；「删除工作台」「删除分组」是灰色文字 | 「停用」按钮、勾选框；两个删除是红字 | 用服务商抽屉里已有的「启用」开关样式（挪进 `core/ui` 做成 `Switch`）；删除改为 muted 文字按钮，确认时再标红 | `frontend/src/modules/settings/workspaces/WorkspacesSection.tsx`、`workspaces.css`、`modules/settings/providers/ProviderDrawer.tsx`（开关来源）、`core/ui` |
| L-16 | 会话 | 二级栏底部「新会话」带「+」图标；联系人「新建联系人」也带「+」 | 没有图标 | 按钮前加 plus 图标，和项目列表「新建项目」一致 | `frontend/src/modules/conversations/Page.tsx`、`modules/contacts/Page.tsx` |
| L-17 | IM 消息（375 宽） | 标题「IM 消息」完整显示，「立即同步」「渠道配置」在右边 | 标题被挤成「IM ...」 | 窄屏时顶栏按钮只留图标（同 SPEC-projects-14.1 的做法）或标题不收缩；顶栏属外壳，和 ALIGN-01 确认归属后改 | `frontend/src/plugins/im/Page.tsx`、`core/ui/PageTitle.tsx` |

## 文案

| 编号 | 页面 | 原型 | 前端 | 建议改法 | 涉及文件 |
|---|---|---|---|---|---|
| T-01 | 今日 / 需要你处理 / 任务待验收 | 说明「Claude Code 提交验收 · 项目名」，取最近一条提交验收进展的操作者（SPEC-today-1.25），没有时「等你验收」 | 一律「等你验收」（有项目时加项目名） | 取任务最近一条 `kind=review` 进展的 `actor_name` 拼「<操作者> 提交验收」；时间也改用这条进展的时间。今日列表只显示 3 条，按需拉这 3 条的进展 | `frontend/src/modules/today/Page.tsx`、`model.ts` |
| T-02 | 联系人 | 搜索占位「搜索姓名、公司、电话、邮箱、IM 编号」 | 「……邮箱、标签」 | 改占位；确认搜索也匹配 IM 编号（SPEC-contacts-1.3） | `frontend/src/modules/contacts/Page.tsx`、`model.ts` |
| T-03 | 会话 | 搜索占位「搜会话标题和内容」；二级栏「产出结果」说明「建的任务、写的文档、发的回复」 | 「搜会话标题和模型」；「写的文件、登记的链接」 | 说明照原型改；搜索在会话正文能搜之前保留「标题和模型」，能搜正文后改 | `frontend/src/modules/conversations/Page.tsx`、`ChatsView.tsx` |
| T-04 | 文档 / 阅读区元信息 | 工作台文档：「来源 · 作者」、更新于、字数（SPEC-library-1.23） | 第一项是文档状态（如「草稿」） | 第一项换成来源（`source` 的显示名，人工建的显示「手动」或不显示），状态挪到类型标签旁边 | `frontend/src/modules/docs/Reader.tsx` |
| T-05 | 项目详情 / 设置 | 项目目录说明「原型、文件类材料和文档的路径都相对它」 | 多了「；任务没设工作目录时用它」 | 保留（多出的是事实，且有用），同步到规格 SPEC-projects-13.4 | `web-next/docs/spec/projects.md`（规格）|
| T-06 | 设置 / 连接器抽屉（Token） | 认证区有「请求头」「前缀」两个输入和预览「请求时带上：Authorization: Bearer ••••」（SPEC-settings-5.12） | 只有令牌一个输入 | 后端定义里有 header/prefix 字段时再显示；没有就先在规格里标「正式产品固定 Authorization: Bearer」 | `frontend/src/modules/settings/connectors/ConnectorDrawer.tsx`、`internal/connector`（看是否支持）|

## 缺功能

| 编号 | 页面 | 原型 | 前端 | 建议改法 | 涉及文件 |
|---|---|---|---|---|---|
| F-01 | 今日 / 需要你处理 | 按来源分组：SOP、Agent 待确认、任务待验收、IM 消息、运行异常、连接异常（SPEC-today-1.4）；IM 消息组列待处理消息，动作「回复」，点了打开那条消息 | 只有「任务待验收」一组；灌了 @我 消息也不出现 | 先补 IM 消息组（im 插件今日扩展点贡献，`provides.today_cards` 或「需要你处理」的分组扩展点）和连接异常组（连接器 `status=error`，内核有数据）；SOP、Agent、运行异常等后端有了再接。汇总数字「件事等你处理」随之相加 | `frontend/src/modules/today/Page.tsx`、`model.ts`、`plugins/im/index.ts`、`internal/plugins/im/plugin.json`、可能要在 `core/plugin` 加扩展点 |
| F-02 | 今日 / 正在运行 | 列运行中的项目原型（绿灯，「项目 / 原型 :端口」，点了新窗口打开），再列执行中的 SOP（SPEC-today-1.14） | 列的是任务执行（Claude Code 跑的任务） | 加上运行中的原型（项目插件贡献，读 `/api/projects/*/prototypes` 的状态）；任务执行可以保留在后面，规格补一条 | `frontend/src/modules/today/Page.tsx`、`plugins/projects/index.ts`、`web-next/docs/spec/today.md` |
| F-03 | 项目列表 | 按「有原型在跑 / 有待回复 / 其他」分组和筛选（SPEC-projects-1.5、1.6、1.8）；卡片有原型数、待回复数 | 按项目状态（筹备中、进行中、已暂停、已结项）分组；卡片没有原型数、待回复数 | PJ-01c 当时说数据有了再加，现在原型（PJ-04）和沟通（PJ-02）都有了：按规格改分组和筛选，状态改成卡片上的小标签或排序依据。需要一个项目汇总接口（每个项目的原型运行数/总数、待回复数），否则列表要 N 次请求 | `frontend/src/plugins/projects/ListPage.tsx`、`model.ts`、`internal/plugins/projects`（汇总接口）、`docs/api-contract.md` |
| F-04 | 项目详情 / 概览 | 「待回复消息」「产品文档」两个数字卡；「最新沟通」（最新 4 条，点开消息）、「项目 Agent」、「最近的文档和材料」三个摘要块；项目目录下关联目录标签（SPEC-projects-3.1 到 3.8） | 缺这两个数字和三个块 | 待回复、最新沟通用沟通标签同一份数据；产品文档数用文档标签的数据；最近的文档和材料合并文档和支持材料按时间取 5 条；项目 Agent 等 AG 系列，先放「还没设置。去设置」空状态 | `frontend/src/plugins/projects/Overview.tsx`、`commsModel.ts`、`materialModel.ts` |
| F-05 | 项目详情 / 标签条 | 「沟通」有待回复消息（不含稍后）时带红点（SPEC-projects-2.3） | 没有红点（原型的绿灯已有） | 照 `ProtoTabLight` 做 `CommsTabDot`，数据同 F-04 的待回复数 | `frontend/src/plugins/projects/ProjectPage.tsx`、`CommsTab.tsx` |
| F-06 | 项目详情 / 标题行 | 所有标签右上固定有「终端」「浏览器」两个按钮，展开项目内的终端和浏览器区域（SPEC-projects-14） | 没有 | 一级菜单的终端、浏览器还没做，去留待用户定（dev-decisions「待用户决定」最后一行）。先不做，等用户定了再派 | `frontend/src/plugins/projects/ProjectPage.tsx` |
| F-07 | 项目详情 / 干系人 | 「最近沟通」列显示这个人在本项目会话里的最近一条（「6 分钟前 · 正文」，可点开消息），没有时「本项目会话里没有消息」 | 一律「还没绑定沟通渠道」，即使项目已绑了群、群里有他的消息 | 用沟通标签的项目消息，按 IM 身份对上联系人取最新一条；没绑渠道才显示「还没绑定沟通渠道」 | `frontend/src/plugins/projects/StakeholdersTab.tsx`、`commsModel.ts` |
| F-08 | 项目详情 / 文档 | 表格有「来源」列（文档库，或项目目录里的文件路径）；能列项目目录里的文档文件（SPEC-projects-8） | 只列工作台里归到本项目的文档，没有来源列 | 先补来源列（文档库）；项目目录里的文件等「项目资料与文档合并」（P-2 待定）再做 | `frontend/src/plugins/projects/DocsTab.tsx` |
| F-09 | 项目详情 / SOP | 关联的 SOP 卡片（执行、取消关联）+ 最近执行列表（SPEC-projects-9） | 占位「还在开发中」 | 等 SOP 插件（M4 以后），不单独派 | `frontend/src/plugins/projects/model.ts`（TABS） |
| F-10 | 项目详情 / Agent | 项目 Agent 列表（默认、设为默认、对话、移除）+ 项目里的会话（SPEC-projects-10） | 占位 | 等 Agent 配置（AG-01b）；「项目里的会话」后端会话有 `project_id` 的话可以先做 | `frontend/src/plugins/projects/model.ts`、新文件 `AgentsTab.tsx` |
| F-11 | 项目详情 / 原型 | 卡片头部有内网域名按钮（`proto-7778.pmw.lan`，点了复制，SPEC-projects-12.8）；没有日志时「看日志」置灰（12.14） | 没有域名按钮；「看日志」总能点 | 域名等内网域名插件（F-17）；「看日志」在 `last_seq` 为 0 时置灰 | `frontend/src/plugins/projects/PrototypesTab.tsx` |
| F-12 | 会话 / 二级栏 | 「会话 / 执行记录 / 产出结果」三项，执行记录有红点（SPEC-sessions-2） | 没有「执行记录」 | AG-01a 已记：等 Agent 触发器（AG-01b）。不单独派 | `frontend/src/modules/conversations/Page.tsx` |
| F-13 | 会话 / 会话列表 | 筛选「全部 Agent」「全部项目」；列表项是 Agent 头像 + 标题 + 「Agent 名 · 摘要」，按今天、更早分段 | 筛选「全部服务商」；本次没有会话数据，列表项样式没对上（需要能用的模型服务商才能建会话） | 加「全部项目」筛选（会话有项目时）；Agent 筛选等 AG-01b。列表项样式下次带真实会话数据再对 | `frontend/src/modules/conversations/ChatsView.tsx` |
| F-14 | 会话 / 产出结果 | 「全部 / 任务 / 文档」类型切换 + Agent chip，一张表：类型、产出、Agent、来源、时间（SPEC-sessions-3） | 按来源分「会话里的 Agent / 任务执行 / MCP 回写」三个页签，默认停在第一个；第一个是空的时候显示「还没有产出」，其实 MCP 回写有 107 条 | 至少先改默认页签：落在第一个有数据的；再按规格加「全部」和类型切换，来源改成表格里的一列 | `frontend/src/modules/conversations/OutputsView.tsx` |
| F-15 | 设置 / 工作台与模块 | 基本信息左边有工作台标志，点了编辑图标、文字、底色、图片（SPEC-settings-2.9） | 没有标志 | CORE-10b 记的没做项。复用项目插件的 `Mark` 编辑（挪到 `core/ui`），后端工作台已有 `mark` 字段 | `frontend/src/modules/settings/workspaces/WorkspacesSection.tsx`、`plugins/projects/Mark.tsx`（挪进 `core/ui`） |
| F-16 | 设置 / 枚举值、外观 | 枚举值：按字典列选项、新建、改名改色、排序、停用（SPEC-settings-17）；外观：配色方案、菜单收起（21） | 占位页 | 这两节后端或本地已有支撑（`/api/dictionaries/{id}/items` 增改排序；主题在 `core/ui/theme.ts`，侧栏收起在外壳），可以直接做 | `frontend/src/modules/settings/Page.tsx`，新目录 `modules/settings/enums/`、`appearance/` |
| F-17 | 设置 / Agent、知识库、技能、运行异常、内网域名 | 各有列表、抽屉或详情（SPEC-settings-8 到 16、18 到 20） | 前四个是占位页；「内网域名」二级菜单里没有 | 都还没有后端，等 M4 以后的拆分（PLAN-04、PLAN-05）；内网域名是插件分节，插件做出来时登记设置分节 | `frontend/src/modules/settings/Page.tsx` |
| F-18 | 联系人 / 抽屉 | 资料表：分组、电话、邮箱、标签、最近联系、添加于（SPEC-contacts-2.10） | 多一行「事项：没有负责或参与的事」 | 不算错，但规格里没有：要么规格补上（建议，删除前的引用检查也靠它），要么去掉。建议补规格 | `web-next/docs/spec/contacts.md`（规格） |

## 数据造成的不同（不用改）

| 编号 | 页面 | 现象 | 原因 |
|---|---|---|---|
| D-01 | 今日 | 底部「示例插件」卡片 | hello 示例插件在 dev server 下启用；ALIGN-01 让它只在开发模式出现 |
| D-02 | 今日、项目任务标签 | P0 的名称是「最高」，原型是「紧急」 | 字典 label 不同，前端照字典显示 |
| D-03 | 项目列表 | 「新项目」卡片目录显示 `Volunme` | 7796 库里原有的测试项目，目录是手填的 |
| D-04 | 文档 | 分类全是「未分类」，筛选里 0 篇的分类也列出 | 演示文档没设分类；空分类列出是规格要求（SPEC-library-1.14、1.39） |
| D-05 | 项目详情 / 支持材料 | 卡片上多一个分类标签「需求」「设计」 | 灌数据时填了 `category`；原型的材料没有分类字段，前端有就显示，可以保留 |
| D-06 | 项目详情 / 支持材料 | 「找不到文件」红字 | 演示路径 `/tmp/需求说明.pdf` 不存在，符合 SPEC-projects-11.20 |
| D-07 | IM 消息 | 抽屉头写「星河项目群 · fake」，原型是连接器名「公司 Slack」；「渠道配置」没有红点 | 演练用的是假适配器，消息没挂连接器；真实渠道（IM-01b、IM-01c）接通后显示连接器名 |
| D-08 | IM 消息 | 只有 Slack 一个渠道，原型四个 | 演示数据只灌了 Slack |
| D-09 | 联系人 | 电话 `13800001111` 没有分段，原型是 `138 0013 2201` | 原型演示数据本身带空格；规格说电话原样保存（SPEC-contacts-3.17） |
| D-10 | 联系人 | 「合作方」分组、「Claude Code」联系人 | 灌数据用了字典里没有的分组 key（按 SPEC-contacts-1.20 灰色显示）；Claude Code 是库里原有的干系人（Agent 操作者） |
| D-11 | 设置 / 连接器 | 不开 `--fake-connector` 时整页「还没有可以接入的工具」；开了以后只有两个测试连接器，归在「研发协作」 | 真实连接器从 CONN-01c 起才登记（CONN-01a 决策）；原型有 41 个工具的目录 |
| D-12 | 设置 / 模型服务商 | 卡片写「默认模型 xxx」「未测试」，原型是「N/M 个模型启用」「连接正常 · N 前检查」；Azure、Bedrock「暂未支持」 | MP-01b 决策：后端只有一个 `model` 字段，测试结果不落库 |
| D-13 | 设置 / 二级菜单 | 多「插件」一节和「插件 / 示例插件」 | 插件管理页是正式前端先做的（CORE-09）；示例插件同 D-01 |
| D-14 | 设置 / 工作台与模块 | 多「需要的插件」块；默认编辑「产品经理工作台」而不是 0xBroleez | CORE-10b 决策（默认工作台取第一个），需要的插件是 CORE-10 加的 |
| D-15 | 项目详情 / 原型 | 只有一个已停止的原型，没对到运行中卡片的「打开 :端口」「已运行」 | 没在临时实例上真起进程；运行中状态下次在 7796 上有在跑的原型时再对 |
| D-16 | 会话 | 会话列表、对话区为空 | 临时实例没有可用的模型服务商，没法建会话；见 F-13 |

## 过程中看到的其它情况

- 对照途中 dev server 上设置页出过一次整页「出错了：Cannot read properties of undefined (reading 'has')」，刷新后好了。那时 ALIGN-01 正在改 `core/shell`（`marks.ts` 里有 `active.has(...)`），像是并行修改时热更新的中间状态，不是本页面的问题；ALIGN-01 验收时留意一下 `marks.ts` 里 `active` 为空的情况。
- 375 宽度下各页没有横向滚动；项目概览、沟通在窄屏下按规格排成一列。

## 建议怎么派

| 批 | 条目 | 说明 |
|---|---|---|
| 1 | L-01 | 抽屉停靠，改共用布局，影响所有抽屉页，单独一个任务先做 |
| 2 | F-03、L-11 | 项目列表分组和卡片统计，含项目插件的汇总接口（后端加路由，不加迁移） |
| 2 | F-04、F-05、F-07、L-05 | 项目概览补块、沟通红点、干系人最近沟通，都用项目消息这份数据 |
| 2 | L-02、L-03、L-04 | 项目沟通页布局 |
| 2 | F-01、F-02、T-01 | 今日页的 IM 分组、连接异常、运行中的原型、待验收说明；可能要加今日扩展点 |
| 3 | L-06、L-07、L-08、L-09、L-10、F-08、F-11 | 项目各标签的小样式和文档来源列，等 ALIGN-02 的优先级标签合入后做 |
| 3 | L-13、L-14、L-16、T-02、F-18 | 联系人细节 |
| 3 | L-12、L-17 | IM 消息工具条和窄屏标题（L-17 先和 ALIGN-01 对一下归属） |
| 3 | L-15、F-15 | 工作台设置的开关和标志 |
| 3 | F-14、T-03、T-04 | 产出结果默认页签和类型切换、会话和文档的文案 |
| 4 | F-16 | 枚举值、外观两节设置页 |
| 等依赖 | F-06、F-09、F-10、F-12、F-13、F-17、T-06 | 等终端浏览器去留（用户定）、SOP、Agent、知识库、技能、运行异常、内网域名的后端 |
| 改规格 | T-05、F-18 | 只改 `web-next/docs/spec`，不改代码 |

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
