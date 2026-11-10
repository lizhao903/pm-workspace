# 前端架构评审：一人之下个人工作台

2026-11-09，只读评审（除本报告未改仓库）。口径：`frontend/src` 共 918 个文件（801 个 ts/tsx，其中生产 550 个文件 76,362 行、测试 251 个文件 31,768 行；CSS 72 个 7,740 行）。所有行号按当前 HEAD `c1a1c12` 与工作区实测。

## 0. 结论摘要

1. **真正超预期的资产是插件机制本身**：清单前后端同源、注册按 owner 记账、17 个扩展点里 12 个已接、注册表测试覆盖到真实 IM 插件（`frontend/src/core/plugin/extensions.test.ts:106`）。这是全仓最像「产品级框架」的部分。
2. **边界规则被工具强制执行，但守的是「core 对非 core」，不是「公开 API 对内部实现」**：插件可以 import 整个 21,517 行 core，没有 `core/public.ts`；于是能力被迫上移（拼音、定时规则、61% 的数据层），`core/data` 成了插件间的第二总线。
3. **最大的产品债不是功能，是页面级复用缺口**：core/ui 23 个生产组件/40 个导出，撑 548 个生产文件；列表+筛选+抽屉、Tab、表格、批量选择、分页、日期、复制 7 类模式各手写 5–19 份，直接导致「同一概念在不同插件长得不一样」。
4. **质量门槛存在但没接进流程**：251 个测试文件、1,844 个用例全绿（39s），typecheck 绿；但 `npx oxlint` 当前 **3 errors**（都是边界违规）、`make test` 只跑 Go、没有 CI；e2e 只有一份 32 行配置，真正跑起来靠两条需要先起服务的 Python 脚本。
5. **三套前端**：`web/`（12,427 行 + 3,705 行 CSS）应删除；`web-next/`（41,630 行 + 5,531 行 CSS、39MB 截图）仍在按生产行为改（10-29 以来 61 个提交、5 个文件未提交），「原型即规格」已从机制退化为双写成本。

---

## 1. 分层与规则

### 1.1 规则确实是工具强制，不只是文档

| 手段 | 位置 | 强制力 |
|---|---|---|
| 自定义 oxlint 插件守插件/模块边界 | `frontend/.oxlintrc.json:8,16`、`frontend/scripts/lint-boundaries.js:2,47,53` | 插件互不 import、插件不 import 模块、模块只 import 对方 index.ts，`error` 级 |
| 禁直接 fetch / 禁模块插件 import `core/api` | `frontend/.oxlintrc.json:24-46,66-75` | 数据一律走 `core/data`，`error` 级 |
| 清单校验 + 注册时比对 `provides` | `frontend/src/core/plugin/extensions.ts:139,156,166,176,188`、`commands.ts:41-67` | 开发态抛错/生产态拒绝并记原因 |
| 约定文档 | `frontend/README.md:257`「约定」、`frontend/src/plugins/README.md` | 人读 |
| 注册表测试 | `core/plugin/` 11 个测试文件、899 行 | 覆盖撤销、冲突、真实插件 |

### 1.2 但规则当前是红的，且没有流程接住

- `cd frontend && npx oxlint`：**18 warnings / 3 errors**，3 条全是 `pmw(boundaries)`：`src/modules/settings/runners/RunnersSection.tsx:12-13`（引 `modules/tasks/handoffModel`、`modules/tasks/ProviderModelFields`）、`src/modules/settings/runperms/RunPermsSection.tsx:9`（引 `modules/tasks/handoffModel`）。`modules/tasks/index.ts` 没导出这两个符号，等于规则要求「改公开出口」，但没人被拦下。
- 没有 CI：仓库无 `.github`/`.gitlab-ci.yml`；`Makefile:70-71` 的 `make test` 只 `go test ./...`，`make ui` 只 build；`package.json:8-11` 的 lint/typecheck/test 没有任何 Makefile 目标或钩子调用。
- 因此「边界被工具强制」只在开发者自觉跑 `npm run lint` 时成立。这是资产，但目前是**未兑现的资产**。

### 1.3 真正的边界粒度问题：core 没有公开面

- lint 规则允许 `plugins/<a>` import `core/*` 全部（`lint-boundaries.js:46`）。core 生产代码 21,517 行、238 个文件（含测试），没有 `core/index.ts` 或 `exports` map 区分公开/内部。
- 插件实际吃到的东西远超「插件 API」：308 个插件文件 import `../../core/data`，141 个 import `core/ui`；还有直接引用 core 内部的：`plugins/projects/AgentsTab.tsx:7` import `core/chat/ChatPane`，`plugins/sop/scope.ts:5` import `core/shell/workspace`。`core/plugin/api.ts:139,166` 直接把整个数据层类型 `DataClient = typeof DataLayer`（168 个导出）交给插件。
- 结果：**插件隔离是「import 图隔离」而不是「能力隔离」**。跨插件数据耦合全部从 `core/data` 走：`plugins/video/DealsTab.tsx:7` 用 IM 的 `useImMessage`，`plugins/projects/ListPage.tsx:6` 用 `usePendingImMessages`，`plugins/im/Page.tsx:33` 用 SOP 的 `useSopRunsByInput`，`plugins/sop/Debug.tsx:7` 用 IM 的 `useImRecentMessages`（视频 9 个、IM 10 个、交易 14 个、SOP 5 个、项目 3 个文件引用别家 domain 的 hook）。

### 1.4 「插件被迫把能力挪进 core」的真实案例

| 案例 | 证据 | 性质 |
|---|---|---|
| 拼音排序从联系人模块搬进 core | git `2e1a594`（rename `modules/contacts/pinyin.ts → core/ui/pinyin.ts`）；`docs/product-review.md:34` 明写理由「插件不能 import 模块」 | 规则导致：项目插件要用，只能上收 |
| 定时规则纯函数落在 core/ui | `frontend/src/core/ui/scheduleRule.ts:1-2`「定时任务页和 SOP 流程编辑（TSK-0463）共用」；git `5facfee` 新增 | 规则导致：内核模块与插件都要用 |
| 插件自己的数据访问层全在 core/data | 42/82 个生产文件、7,694/12,642 行（61%）是插件 domain：`sop.ts` 770、`im.ts` 466、`tradePaper.ts` 454、video 系列约 1,650（含 `storyboard.ts` 229）、trade 系列约 1,470、projects 系列约 1,650 | 规则 + 懒加载共同导致；这是最大一块「能力上移」 |
| 内核反向提供「打开任务抽屉」注册点 | `frontend/src/modules/tasks/index.ts:23-27` 注册 `registerCoreObjectDrawer`；插件从 `core/plugin` 取 `useObjectDrawer('task')`：`plugins/projects/Overview.tsx:39`、`plugins/im/Page.tsx:126` | 合理设计，但说明插件需要的内核能力只能通过 core/plugin 逐项加口 |
| 对象详情/今日卡片宿主 | `core/shell/extensionHosts.tsx:30-107` | 同上 |

**判断：这条边界是资产，但不是「规则本身」的资产，而是「有计划地加口」的资产。** 摩擦有三：一是粗粒度规则逼着做「抢跑抽象」（拼音、定时规则这种小工具还好；数据层 61% 上收是结构性的）；二是 core/data 成为跨插件总线，隔离名存实亡；三是规则红着没人管。建议保留规则不动，补两件事：`core/public.ts` 只导出插件 API + 数据访问层门面；允许 `plugins/<id>/data.ts` 放本插件资源 hook（内部仍只 import `core/api`），把 `core/data` 里插件 domain 逐步迁回。

---

## 2. 插件前端机制

### 2.1 扩展点现状：11 个进清单 + 6 个不进清单，实际接线 12 个

| 扩展点 | 进 `provides` | 注册数（`api.*.register`） | 状态 |
|---|---|---|---|
| modules | 是 | 9 | 在用 |
| settings | 是 | 5 | 在用 |
| sop_nodes | 是 | 30 | 在用（IM 15、项目 15） |
| today_cards | 是 | 5 | 在用 |
| commands | 是 | 1 | 在用（示例 hello） |
| search | 是（数据源） | 2 个插件 | 在用（A-01 修复后） |
| object_types | 是 | **0** | 死点：`extensions.ts:234` 有读取函数，但内核没有页面读它，也没有插件注册 |
| connectors / skills / agent_tools | 是 | 0 | 前端没有注册面：`connectors`/`agent`/`events` 是 `notImplemented`（`registry.ts:199-201,211`），`skills` 连 `pluginApi` 字段都没有，调用即插件加载失败 |
| migrations / events | 否（后端概念） | 0 | `registry.ts:199,211` `notImplemented` |
| schedule_actions | 是 | 仅后端 | 不进前端 |
| todaySources / projectTabs / objectSections / sessionTools / sessionSources / terminalLauncher | **否** | 3/1/3/2/1/1 | 在用，但绕过清单 |

后 6 个是设计上有意为之（`core/plugin/todaySources.ts:3`、`projectTabs.ts:2` 注释「和今日卡片不同，这里不进清单 provides」）。代价：插件管理详情只按 `provides` 展示能力（`modules/settings/plugins/labels.ts:48-53`），**用户和安装确认看不到这 6 类能力**；同名冲突只能等 activate 抛错（各 registry 的 `重复注册` 分支）；`docs/plugin-api.md:52`（第 5 节表 `:2026`）的规则「注册清单里没声明的东西 → 注册时比对 provides」实际被这 6 个点打破。文档也说「共十个扩展点」（`docs/plugin-api.md:27`），与代码 11+6 不符。

### 2.2 类型安全：类型层强，运行时校验强，能力面弱

- 清单是强类型的（`core/plugin/manifest.ts:9-47`，441 行实现 + 204 行测试），校验错误文案与 Go 侧逐字一致（`manifest.ts:1-3`）。
- `provides` 校验只覆盖已声明的 11 个键：模块 key、settings key、sop node kind（要求 `<id>_`）、命令 id（`<id>.<动作>`）在注册时逐条对（`extensions.ts:139-198`、`commands.ts:41-67`）；`icons` 指向非本插件模块会校验失败（`manifest.ts:302`）。
- 但 6 个扩展点没有清单契约，等于类型系统知道、清单不知道；插件 API 的 `ShellApi` 只有一个方法。

### 2.3 懒加载：分包做得对，启动路径被插件拖住

- 清单 eager（只读 JSON）、插件入口 `import.meta.glob` 非 eager（`registry.ts:57-60`）、页面 `lazy(() => import(...))` 或路由 `lazy`（`core/shell/router.tsx:20-27`）。构建产物 119 个文件、28 个 `Page-*.js` 页面级 chunk 可验证。
- 但 `src/modules/index.ts:15` 顶层 `await initPlugins(...)`，`main.tsx:10-11` 拿到 `coreModules` 才建路由；`registry.ts:168-174` 顺序 `await` 每个启用插件的入口。再加上 `fetchPluginState` 最多等 3 秒（`registry.ts:73`），**首屏 = 后端 `/api/plugins` + 所有启用插件入口**。读不到时降级正确（只显示内核，`registry.ts:155-160`），但「插件装了越多首屏越慢」这个方向与「插件按需」的承诺相反。
- 可接受的第一版取舍；优化点是并行 `Promise.all` 入口（注册顺序可用 map 保持）、把非首屏插件的 activate 延后到首次进入模块。

### 2.4 可卸载：验证比 hello 充分，但集中在注册层

- `deactivatePlugin`（`core/plugin/registry.ts:234`）+ `retiredModules`/`useActiveModules`（`core/plugin/extensions.ts:104-121`），停用后菜单/今日卡/设置分节消失、停在插件页会被送回默认模块（`core/shell/Shell.test.tsx:228-236`）。
- 真实验证不止 hello：`extensions.test.ts:106` 用真实 IM 插件注册 15 个 SOP 节点后停用；`plugins/video/index.test.ts`、`plugins/trade/index.test.ts`、`plugins/etf/index.test.ts` 各验证真实入口注册与撤销；`Shell.test.tsx:170-237` 用 `discoverPlugins()` 加载真实插件。假插件 hello 只承担「文档示例 + 最小生命周期」。
- 没验证到的：运行时停用一个**正在被别的插件数据 hook 使用**的插件（数据层不分 owner，停用 IM 后 video 的 `useImMessage` 仍会请求——见 1.3），以及插件页面内的长连接/定时器是否随卸载停掉（`deactivate` 只清注册）。

### 2.5 插件页面能拿到什么 shell 能力、有没有权限约束

- `api.shell` 只有 `navigate(to)`（`core/plugin/commands.ts:6-9`、`core/plugin/api.ts:168`）。没有 toast、confirm、drawer、打开对象——所以插件各造各的：`plugins/browser/Google.tsx:185` 手写 `<div className="dialog br-modal" role="dialog" aria-modal="true">`（没有 ConfirmDialog 的焦点循环/连点保护），`plugins/sop/Editor.tsx:64,128-132` 自己造 toast 计时器，`plugins/terminal/store.ts:38` 又一个 notice。**文档示例还写着不存在的 API**：`docs/plugin-api.md:886` 用 `shell.openDrawer('projects.new')`，而实现只有 navigate（`commands.ts:5` 注释自认「抽屉、提示、确认框在 CORE-02b」但 CORE-02b 之后的代码里并没有）。
- 权限：前端**完全不读** `manifest.permissions`（全仓 `permissions` 只出现在清单解析 `manifest.ts:340-341`、测试、设置页展示），`api.data` 是全量数据层。也就是说「插件能调什么接口」在前端不受清单约束，只受后端接口鉴权约束；这和后端 `Core` 按插件 id 收窄的设计（`docs/plugin-api.md:229`）不是一个强度。

### 2.6 新增一个前端插件要写哪些文件、容易漏什么

必写：① `internal/plugins/<id>/plugin.json`（无后端的放 `frontend/src/plugins/<id>/plugin.json`，如 hello）；② `frontend/src/plugins/<id>/index.ts`（`definePlugin` + `activate`）；③ 模块页面 `Page.tsx`，若 `provides.settings` 还要设置页，今日卡/SOP 节点/对象区块/项目 Tab/会话工具按需；④ 清单 `provides` 逐项声明 + `icons` 只写本插件模块；⑤ 后端 `plugin.go` 的 `Register` + 迁移（有表时）；⑥ CSS、测试、`docs/plugin-api.md` 对应节。

容易漏（都踩过注释/校验）：
- `provides` 漏声明 → 开发态 activate 抛错、生产态拒绝并记原因（`commands.ts:57-66`、`extensions.ts:130-142`）。
- 模块 id/path 与已有冲突 → 不报错，只是不进菜单并在侧栏提示（`registry.ts:316-330`）。
- 6 个「不进清单」扩展点不需要声明，但也**不会出现在插件详情**，重复注册才在运行时炸。
- `plugins/enabled.ts` 只该放后端不认识的插件（`enabled.ts:1-4`）；有后端记录的插件以后端为准，加了也不生效（`registry.ts:92-96`）。
- 新加插件目录后 Vitest 的 glob 会缓存旧结果，要先清缓存（`frontend/README.md:61`）。
- activate 里做 IO 会拖慢整个首屏（`api.ts:174-176` 注释要求「只注册，不发请求」）。

---

## 3. 复用缺口（重点）

core/ui 只有 23 个生产组件文件、40 个导出（约 27 个组件 + 三态 + 工具）、2,731 行生产代码；撑 548 个生产文件。缺失的不是「基础件」而是「页面级模式」。

| 模式 | 现状（每类 2–3 个证据） | 应抽 |
|---|---|---|
| 列表 + 筛选 + 抽屉 | 6 份手写状态：`modules/tasks/Page.tsx:71-72,99`（300ms 防抖）、`modules/docs/Page.tsx:39-43`（4 个筛选 + deferred）、`modules/contacts/Page.tsx:26-32,59-61`（5 个筛选 + 自写分页）、`plugins/im/Page.tsx:174-177`、`plugins/projects/ListPage.tsx:29-32`、`plugins/sop/Library.tsx:42`；26 个文件用 `useSearchParams` 存列表/抽屉状态，39 处 `params.get` | `ListPage` 壳 + `useListParams`（搜索防抖、筛选、排序、URL 同步、三态、分页） |
| Tab | 19 个文件出现 `role="tab"`，至少 6 种私有 class：`plugins/projects/ProjectPage.tsx:103`（pj-tabs）、`plugins/video/Detail.tsx:79`（vd-dtabs）、`plugins/video/parts.tsx:49`（vd-mtabs）、`plugins/sop/NodePanel.tsx:173`（sop-np-tabs）、`modules/settings/agents/AgentEditor.tsx:220`（ag-tabs）、`modules/settings/kb/KbDetail.tsx:66`（kbx-tabs） | `Tabs`（受控 + 徽标 + URL tab + 键盘） |
| 表格 | 19 种 `.[a-z]+-table` CSS：`.task-table`、`.etf-table`、`.pj-table`、`.tr-table`、`.vd-table`、`.sop-run-table`、`.sg-table`… 每份自己写表头/斑马纹/空态 | `DataTable`（列定义、排序、行选择、空态） |
| 批量选择 | 5 份：`plugins/im/Page.tsx:777-790`（底部常驻批量条，全选只算已加载）、`plugins/sop/RunList.tsx:70-73,175`（`SOP_BATCH_MAX=200`，`core/data/sopBatch.ts:12`；indeterminate）、`plugins/projects/AttachmentsTab.tsx:69-71,162`（顶部批量条）、`plugins/im/GroupAdmin.tsx:199`、`plugins/video/SeriesSettingsDrawer.tsx:112` | `useBatchSelect`（全选/半选/上限/只算可见）+ `BatchBar` |
| 分页/加载更多 | 3 种语义：客户端 slice（`plugins/video/ClipsPage.tsx:15,34,175`）、服务端 limit（`plugins/trade/TradingTables.tsx:216,221,339`）、筛选变化回到前 N 行（`modules/contacts/Page.tsx:56-61`） | `usePagedList` + `LoadMore`（统一「还有 N 条」文案） |
| 日期/相对时间 | **11 份 `timeAgo`**：`core/chat/chatModel.ts:239`、`modules/tasks/model.ts:211`、`modules/docs/model.ts:76`、`modules/settings/providers/model.ts:135`、`plugins/{video,domains,sop,browser,im}/model.ts`、`plugins/trade/{monitorModel,strategyModel}.ts`；另 5 份 `dayLabel/dayGroup`（`plugins/im/model.ts:236`、`plugins/im/toMaterialModel.ts:18`、`plugins/trade/monitorModel.ts:78`、`plugins/sop/model.ts:174`、`plugins/video/topicModel.ts:88`）+ `modules/contacts/model.ts:142` | `core/ui/time.ts`：`timeAgo/fmtDateTime/dayLabel/localDay`（带时区与测试） |
| 复制 | 8 处手写 copied 状态：`modules/docs/Reader.tsx:58,90`、`modules/tasks/Outputs.tsx:196`、`modules/tasks/WebhookPage.tsx:39`、`modules/tasks/ArtifactsPanel.tsx:76`、`modules/tasks/Changes.tsx:74`、`plugins/sop/NodePanel.tsx:146`、`plugins/sop/RunView.tsx:55`、`plugins/projects/WorktreeSection.tsx:48`；而现成的 `plugins/domains/useCopy.ts` 只有自己用 | `core/ui/useCopy` + `CopyButton`（统一 1.2–1.5s 反馈） |
| 空/加载/错误 | 三态组件已用 74/76/85 处（空/加载/错，好），但仍有 86 处裸空态文案、56 处自写「加载中」、19 处自写错误标题 | 先把裸文案收进 `EmptyState`；再做列表页统一三态插槽 |
| toast/提示 | 无共享实现：`plugins/sop/Editor.tsx:64,128-132` 本地 toast、`plugins/terminal/store.ts:38` 自己的 notice、`plugins/im/Page.tsx:385` syncNote、设置各页 `notice` 状态 | `ToastHost`（外壳）+ `useToast`（插件可用） |
| 弹层 | 只有 `ConfirmDialog`；通用 `.dialog` 只是 CSS（`core/ui/components.css:162-175`），`plugins/browser/Google.tsx:185` 手写、`plugins/sop/Editor.tsx` 手写确认 | `Dialog` 原语（焦点陷阱/Esc/遮罩） |
| 查询键/失效 | 主体很好：`core/data/keys.ts:23` + `invalidate.ts` 集中；但仍有 20+ 个独立 `*Keys` 模块（`videoKeys`/`tradeKeys`/`etfKeys`…），插件入口重复缓存逻辑：`plugins/projects/index.ts:12-16`、`plugins/im/index.ts:63` 都是 `fetchQuery + 30s staleTime`；事件里手写 queryKey 字面量（`plugins/projects/index.ts:177-180`） | 把 `Keys` 归并进 `dataKeys`；插件入口用共享 `queryResource()` 帮助函数 |

CSS 现状（不是重灾区，但布局复用为零）：

| 区 | CSS 文件 | 行数 | 说明 |
|---|---|---|---|
| core | 17 | 979 | `tokens.css` 76 个变量，README 有「tsx 不出现色值」验收命令（`frontend/README.md:221`） |
| modules | 30 | 2,472 | 每模块前缀（tasks-/docs-/ct-/im-），无共享布局类 |
| plugins | 25 | 4,289 | video 1,059、trade 899、sop 675、projects 642、im 544、browser 179、domains 138、terminal 87、etf 66；最大单文件 `plugins/sop/sop.css` 675、`plugins/projects/projects.css` 550 |

- **token 复用是真的**：全仓 72 个 CSS 里只有 8 个本地变量定义，其中 `plugins/terminal/terminal.css:9-13` 是终端自己的深色配色（合理），`plugins/sop/sop.css:154,224` 是节点类型色（可从后端 node-type 色同步，属小漂移）。没有发现重复 tokens.css 的插件。
- **布局/响应式复用是缺的**：全仓 80 条 `@media`，其中 39 条是 `max-width: 760px`，散在 20 多个文件里各写各的；没有 `_layout.css`/shared breakpoint 变量/容器查询。类前缀避免了冲突，也意味着每个列表页的「工具条 + 内容 + 空态」都是重新发明。
- 还有两个直接信号：`styles`/`components` 之外没有一层「页面骨架」CSS；`core/ui/components.css` 里 `.dialog` 只有样式没有组件（见上）。

### 建议抽的 5–8 个共享抽象（按投入产出排序）

| 优先级 | 抽象 | 覆盖现状 | 收益/成本 |
|---|---|---|---|
| P0 | `ListPage` + `useListParams` | 6 个大列表 + 26 个 URL 状态文件 | 每个新列表省 100–200 行、统一搜索/URL/三态；2–3 天 |
| P0 | `Tabs`（含 URL tab） | 19 个文件、6+ 种实现 | 统一键盘/徽标/样式；1 天 |
| P0 | `DataTable` | 19 种表 CSS | 排序/选择/空态一次做对；2 天 |
| P1 | `useBatchSelect` + `BatchBar` | 5 份实现、语义不一 | 修「全选只算可见/上限多少」的正确性；1–2 天 |
| P1 | `core/ui/time.ts` | 11 份 timeAgo + 5 份 dayLabel | 消除时区/边界差异，测试一处；0.5–1 天 |
| P1 | `ToastHost` + `useToast` + `Dialog` 原语 | 4 套提示、2 套手写 dialog | 插件不再手写弹层、可访问性统一；1–2 天 |
| P2 | `useCopy` + `CopyButton` | 8 处手写 | 小但高频；0.5 天 |
| P2 | `usePagedList` + `LoadMore` | 3 种分页语义 | 统一「还有 N 条」；0.5–1 天 |

先做 P0 三项即可把「新插件/新页面」的骨架成本砍掉一半；P1 中 `time.ts` 是顺手可做的正确性修复。

---

## 4. 三套前端

| | `frontend/` | `web/`（旧） | `web-next/`（原型兼规格） |
|---|---|---|---|
| 文件 | 918（550 生产 ts/tsx + 251 测试 + 72 CSS + 42 svg） | 50 | 135（含 18 个 `*data.ts`） |
| 代码 | 76,362 行 + 7,740 CSS | 12,427 行 + 3,705 CSS | 41,630 行 + 5,531 CSS |
| 职责 | 正式产品，`make ui` → Go embed | `make ui FRONTEND=legacy` 回退 | 交互/视觉规格 + 演示数据 |
| 依赖 | React 19 / router 8 / RQ 5 / vitest / oxlint | React 19 only（无路由、无 RQ、无测试） | React 19，自带 seed 数据与 JS 模拟引擎 |
| 独特资产 | 插件机制、数据层、251 个测试 | 无 | 12,906 行 SPEC（19 个 md）+ 1,027 张截图（39MB）、`sopflow.ts` 1,581 行模拟引擎、`backtest.ts` 480 行 |
| 状态 | 持续迭代 | `Makefile:13-19,31-32` 保留一个版本，「下个版本删」 | **未冻结**：10-29 以来 61 个提交；工作区 5 个文件未提交（`App.tsx` +3、`nodetypes/sop/sopflow` 新功能、`styles.css` +4，共 +60/−8） |

### 4.1 未提交改动说明什么

那 5 个文件是在补 TSK-0498（「条件写成一句话的 SOP 流程」）：`web-next/src/nodetypes.tsx` 加 `ruleIsSentence/ruleSentenceError`、`sopflow.ts` 在执行引擎里接上、`App.tsx` 给运行面板加「去改流程」入口。生产侧同一需求已经由 Go 后端 + SOP 前端做完（HEAD `d6197b4`，sop 0.20.0）。也就是说：

1. **原型没有冻结**，`web-next/docs/dev-plan.md:29` 写的「原型冻结成规格」已被实际工作方式推翻；`docs/dev-decisions.md:37` 记着用户规则「涉及 UX 的需求改动，原型 web-next 一并修改」——这是当前真实规则。
2. **同一个业务语义存在第三份实现**：Go（生产）+ 原型 JS 引擎（`web-next/src/sopflow.ts:1291-1300` 同逻辑）+ 前端展示层。原型引擎越做越像后端，语义漂移风险随每次改动上升。
3. 未提交 = 规格不可追溯：截图/SPEC 的「最后对照原型版本」是按提交算的，未提交改动无法被验收、也无法回滚到某个规格版本。
4. 39MB 截图 + 2,941 行单体 `styles.css` + 2,269 行单体 `App.tsx` 说明原型本身已到「不便维护」的体量。

### 4.2 判断与成本

- `web/`：**删**。12,427+3,705 行、50 个文件、独立 `node_modules`、`make deps` 里的 `cd web && npm install`（`Makefile:19-22`）、`FRONTEND=legacy` 分支。成本 1–2 小时（Makefile 去掉 UI_TARGET 分支、README/文档改口径、删目录），风险低——embed 早已默认 `frontend/`，旧前端的回退价值在「新前端缺失页面」的窗口期后归零。
- `web-next/`：**冻结代码，规格降级为「md + 截图基线」**。三条路：
  - A（推荐）冻结：打个 tag 后不再接新功能；SPEC md 继续维护，截图由「对着原型跑」改为「对着已冻结的 dist/截图基线跑」，保留只读演示。成本 0.5–1 天（改 `shots.py`/`shot-compare.py` 指向冻结快照）。
  - B 现状延续（原型跟需求双写）：每个 UX 改动约 1.5–2 倍成本，且语义可能出现第三份实现；不建议超过一个大版本。
  - C 转 Storybook 式组件预览 + 复用 `frontend` 组件：最干净但成本最高（约 1–2 周），当前不值得。
- **视觉回归替代**：现在 `shot-compare.py` 是「原型 vs 正式」的对照（`scripts/shot-compare.py:1-11`），产物 `frontend/.shots/` 被 gitignore（`frontend/.gitignore`），等于没有基线。改成「正式 vs 入库基线」并留 `frontend/e2e/` 里，成本约 1 天，收益是「原型冻结后仍能守住视觉」。

---

## 5. 质量门槛

| 项 | 实测 | 评价 |
|---|---|---|
| 测试文件/行 | 251 个 / 31,768 行；1,844 个用例（`npx vitest run` 全绿，39s，跳过 5 个联调用例） | 数量扎实 |
| 密度 | core 5,364/21,517 行=25%；modules 9,327/18,808=50%；plugins 17,077/35,985=47% | 依赖最多的 core 反而最薄 |
| 关键薄点 | `core/data` 1,321/12,642 行=**10%**；页面级测试 11 个（/289 个生产 tsx）；`core/api/live.test.ts` 默认跳过 | 数据层是前端唯一出口，却只有 `invalidate.test.ts` 等少量测试 |
| e2e | `frontend/e2e/` 只有 `shot-pairs.json`（32 行配置），无 Playwright 依赖；真跑靠 `scripts/smoke-frontend.py`、`shot-compare.py`，需手工先起前后端，不在 `make test` | 名义 e2e，实质手工冒烟 |
| 门槛接线 | 无 CI；`make test` 只 Go；`npm run lint/typecheck/test` 无人自动跑 | 规则存在、流程不跑 |
| 静态检查 | `npx tsc -b` 绿；`npx oxlint` 3 errors + 18 warnings（见 1.2） | typecheck 可信，lint 不可信 |
| 产物 | `frontend/dist` 3.5MB / 119 文件；gzip 0.95MB（js 0.85 + css 0.10）；首屏 `index` 242KB + `data` 230KB；最大页面 chunk 342KB；embed 后 `internal/webui/dist` 3.5MB | 可接受；首屏 472KB 未压缩（≈150KB gzip）偏大 |
| 其它 | 工作区留着 `frontend/dist.bak-20261104-193321`（3.5MB，已 gitignore）；`core/ui/hosts.tsx` 的 `InDrawerHost` 无人使用 | 小清理项 |

「看起来有测试其实没测关键路径」的具体位置：
1. **插件启动主路径**：`initPlugins`→`fetchPluginState`→每插件 `activate` 的顺序、超时、并行度没有被任何测试覆盖（`registry.test.ts` 用假 source，`Shell.test.tsx` 直接调 `loadPlugins` 绕过 `/api/plugins`）。
2. **数据层请求/缓存/失效**：`core/data` 10% 测试覆盖，大量 hook 只有组件测试间接覆盖；queryKey 拼错、失效漏项只能靠 E2E 发现。
3. **真实后端契约**：`live.test.ts` 默认 skip，`docs/api-contract.md` 与前端类型的漂移没有测试守（后端有，前端没有）。
4. **视觉/响应式**：`shot-compare` 与 `smoke-frontend` 不在 CI，宽度/主题回归靠人记得跑。
5. **权限/边界**：lint 是唯一守门人，而它是红的（3 errors），等于当前没有守门人。

---

## 6. 好用度：同一概念的五种长相

1. **「打开关联对象」有 3 种框**：内核任务页用自己的 `TaskDrawer`（`modules/tasks/Page.tsx:80` 用 `?t=` 定位）；插件通过 `useObjectDrawer('task')` 把同一个抽屉塞进插件页（`plugins/projects/Overview.tsx:39`、`plugins/im/Page.tsx:126`）；SOP/项目又用 `objectSections` 在详情里嵌「区块」（`core/shell/extensionHosts.tsx:68-107`）。用户看到的是「点任务有时在当前页开、有时跳任务页、有时嵌在详情里」。
2. **筛选条长得不一样**：任务用状态分段按钮 + 搜索；文档用 kind/tags/project 三个下拉 + 搜索；联系人用分组 + 星标 + 渠道 + 排序；IM 用状态/渠道/会话/相关性/未读/项目 6 个条件；SOP 用文件夹 chips。同一个「筛选」概念，五种控件语言（`SearchSelect` chip、原生 `select`、segmented、chips、纯搜索框）。
3. **批量操作位置/上限不一致**：IM 在底部常驻条（`plugins/im/Page.tsx:777`），SOP 在顶部按钮 + 勾选（`plugins/sop/RunList.tsx:70-73`），项目附件在顶部条（`plugins/projects/AttachmentsTab.tsx:147-162`）；SOP 上限 200 条、IM 分批、附件只认本页。
4. **时间表述不一致**：11 份 `timeAgo` + 5 份「今天/昨天」分组，边界（是否按日历日）和文案（刚刚/1 分钟前/N 天前）各不相同；跨插件看同一时间会看到不同写法。
5. **提示/空态/报错不一致**：空态有 74 处用共享组件、86 处裸文案；加载 56 处自写；错误提示有 `ErrorState`、行内 `rowErr`、`notice`、toast 四种。
6. **配置入口不一致**：IM 的渠道/群组/免打扰是页面内 `?channels=1/?groups=1` 抽屉（`plugins/im/Page.tsx:108-110,278-288`），终端/域名/SOP 是设置分节，项目是项目详情 Tab，浏览器没有设置；用户要记住「这个插件的配置在哪」。

### 10 月底走查（`docs/product-review.md`）复核

文档共 **34 条**（A 9 / B 12 / C 6 / T 4 / E 3），拆成 PR-01a…PR-20 共 20 个开发任务。抽查指定 4 条**全部已修，且都有测试**：

| 条目 | 结论 | 证据 |
|---|---|---|
| A-01 命令面板搜索 | 已修 | 内核任务/联系人 `registerCoreSearch`（`modules/tasks/index.ts:30`、`modules/contacts/index.ts:13`）；projects/im 插件 `commands.provide`（`plugins/projects/index.ts:63`、`plugins/im/index.ts:63`）+ 清单 `provides.search`（`internal/plugins/projects/plugin.json:20`、`im/plugin.json:20`）；结果分组 `core/shell/palette.ts:41-46` |
| B-02 IM 批量处理 | 已修 | `plugins/im/Page.tsx:7-14,777-790`（常驻全选、已选 N/已加载 M、分批）；测试 `plugins/im/Page.test.tsx:284-326` |
| B-05 干系人选择器 | 已修 | 多选批量 + 拼音排序：`plugins/projects/StakeholdersTab.tsx:6,14,45,65`；拼音在 `core/ui/pinyin.ts`；测试 `StakeholdersTab.test.tsx:57,80` |
| B-09 空会话 | 已修 | 空会话只在打开时列出、切走即删：`modules/conversations/ChatsView.tsx:3,33,160,205-216`；测试 `ChatsView.test.tsx:45,55` |

顺带核到的：A-03（`plugins/projects/SopTab.tsx`）、A-04（`modules/tasks/ReviewBar.tsx:3`）、A-05（`modules/settings/enums/EnumsSection.tsx:223` PR-13）、A-06（`plugins/sop/model.ts:49`）、A-07（`modules/tasks/sourceModel.ts:44-47`）、A-09（`modules/settings/incidents/`）、B-01（IM 今日只取 relevance：`plugins/im/index.ts:8-11`）、B-06/B-07（`modules/tasks/model.ts:110-116`）、B-10（`plugins/projects/CommsTab`）、B-12（`plugins/im/ChannelPanel.tsx:163`）、C-01（`core/shell/shell.css:209` + `modules/tasks/tasks.css:56`）、C-03/C-04（文档新建编辑与按项目筛）、C-05（`plugins/projects/Settings.tsx:8` 空项目拦截）、E-02（后端角色校验，`internal/plugins/projects/projects_test.go:143-157`）、E-03（`modules/contacts/model.ts:142`）都看到了代码/测试痕迹。

**判断：走查闭环质量很高，问题不在修复率，而在修复方式。** 20 个 PR 任务几乎都是「按模块各修一遍」，没有把重复模式升级成共享层，所以每修一条就多一份手写模式。这正是第 3 节缺口的来源。

---

## 7. 结论

### 做得好（3–5 条）

1. **插件机制是产品级框架**：清单与后端同源（`manifest.ts` 与 `internal/plugin/manifest.go` 同规则，样例/错误逐字一致）、注册按 owner 可整体撤销、扩展点注册有 11 个测试文件、真实插件参与测试。同类单机产品里少见。
2. **数据访问层是正确的中台**：`core/data` 统一 hook/键/失效/错误（`core/data/index.ts:1-3`），`invalidate.ts` 有 525 行测试，事件流 `onServerEvent` 驱动失效，写操作不手抄状态。
3. **设计变量与组件基座统一**：76 个 token、深浅主题由 `data-theme` 控制、README 给了色值禁用命令；`Drawer/ConfirmDialog/SearchSelect/Subnav/三态` 有焦点、键盘、未保存确认等真实细节和测试。
4. **「原型→规格包→编号」的规格工程**：12,906 行 SPEC（19 个 md）、固定编号规则、截图脚本自动更新；`docs/product-review.md` 的 34 条能一一拆成任务并验收，说明这套规格体系真的在驱动开发。
5. **插件按需加载与边界错误提示的用户体验**：清单不合法/依赖缺失/版本不符/读不到后端都会在侧栏提示原因，停用插件会撤菜单、撤分节、送回默认模块。

### 复用/架构缺口（6–10 条）

1. 没有页面级复用层（列表/Tab/表格/批量/分页/日期/复制/Toast/Dialog），导致 7 类模式 5–19 份手写，是「不一致」的总根源。
2. core 没有公开 API 面，插件可 import 全部 core，能力被迫上移（拼音、定时规则、61% 数据层）。
3. core/data 成为跨插件总线，插件「互不 import」在数据层已被绕过（视频用 IM、IM 用 SOP…）。
4. 6 个扩展点不进清单：插件管理看不到、冲突只能运行时炸、文档规则自相矛盾。
5. `ShellApi` 只有 navigate，插件重新造 toast/dialog/确认，可访问性与一致性都受损。
6. 前端不读 `permissions`，插件页面能力不受清单约束；权限只活在后端。
7. 启动路径 await 所有启用插件入口 + `/api/plugins` 3s，插件数量与首屏时间正相关。
8. 质量门槛未接线：无 CI、`make test` 只 Go、oxlint 3 errors、e2e 是需手工起服务的外部脚本、视觉无基线。
9. 三套前端并存：`web/` 已无价值、`web-next/` 未冻结且语义与生产重复；维护成本随时间上升。
10. core/data 测试密度 10%：最关键的取数/失效路径缺少测试保护。

### 建议（按投入产出排序）

1. **今天就能做（<1 天）**：修 3 个 oxlint 边界错误；把 `lint/typecheck/test` 接进 `make`（`make check`）并让 `make test` 调前端测试；删 `frontend/dist.bak-*`；删 `web/`。
2. **1–3 天**：抽 `Tabs`、`time.ts`、`useCopy/CopyButton`、`ToastHost`（四项里前两项覆盖最广、后两项成本最低）。
3. **3–5 天**：抽 `ListPage + useListParams` 与 `DataTable`，先在任务、项目、IM 三个最大的列表上落地；同步把 triggers/空态/加载收口。
4. **1 周**：`useBatchSelect + BatchBar`；把 IM/SOP/附件三处批量统一（先定「全选=可见还是全查」的产品口径）。
5. **1 周**：把 6 个不进清单的扩展点补进 `provides`（`today_sources`/`project_tabs`/`object_sections`/`session_tools`/`session_sources`/`terminal_launcher`），同步 `docs/plugin-api.md` 和插件详情展示；顺手更新 `docs/plugin-api.md` 2.9 节里不存在的 `shell.openDrawer` 示例。
6. **1–2 周**：`ShellApi` 补 `toast/confirm/openObject`，让插件不再手写弹层；`core/public.ts` 收窄插件面对 core 的 import；把 `plugins/<id>/data.ts` 作为插件数据 home，逐步从 core/data 迁出。
7. **2 周**：web-next 冻结（打 tag，改截图基线脚本）；删原型应用代码或降级为只读演示；把 `shot-compare` 改成「正式 vs 基线」并入库，接入 `make check`。
8. **持续**：给 `core/data` 补契约/失效测试（先覆盖列表/详情/写后失效 3 类）；把启动时插件加载改为并行 + 非首屏延迟 activate。

**总体判断**：这是一个架构方向正确、执行密度很高的单机工作台，插件化和数据层是「好用且好扩展」的真实基础；短板集中在两处——页面层没有形成复用的「设计系统」，以及规则只写在工具里、没接进交付流程。把 P0/P1 共享件和 `make check` 做掉，扩展成本会立刻下降一个台阶；三套前端的收敛是接下来一个版本最明确的减法。

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
