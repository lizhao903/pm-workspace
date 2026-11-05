# 视频 规格（SPEC-videos）

| 项 | 内容 |
|---|---|
| 模块 key | `videos` |
| 原型入口 | 一级菜单「视频」，http://127.0.0.1:7778 |
| 源码 | `web-next/src/videos.tsx`（`VideosTabs`、`VideosListPage`、`StageDist`、`SeriesSettingsDrawer`、`VideoDetail`、`ScriptDesk`、`TextPane`、`ArtifactDrawer`）、`web-next/src/videopublish.tsx`（`SeriesPage`、`PublishPage`、`NewPublishDrawer`、`PublishDrawer`）、`web-next/src/topics.tsx`（`TopicsPage`、`TopicDrawer`、`ClipsPage`）、`web-next/src/videocalendar.tsx`（`CalendarPage`）、`web-next/src/videodeals.tsx`（`DealsTab`、`DealDrawer`）；接线在 `web-next/src/App.tsx`（`videoView`、`videoFrom`、`videoTexts`、`makeVideoFromTopic`、`newVideo`、`channelOf`、`movePublish`、`moveTarget`、`saveDeal`、`makeDealReport`、`openDealFromMessage`，定时发布同步和发布失败上报两个 effect） |
| 数据文件 | `web-next/src/videodata.ts`（视频、系列、检查点、产出物、文稿正文、发布记录、日历条目、商单）、`web-next/src/topicdata.ts`（选题、素材）；定时发布在 `web-next/src/scheduledata.ts`（`ScheduleAction` 的 `publish`），发布失败在 `web-next/src/incidentdata.ts`（模块「发布」） |
| 截图 | [`shots/videos/`](shots/videos/) |
| 负责任务 | PROTO-04f3 |
| 对应开发任务 | 见下表「引用本规格的开发任务」 |
| 状态 | 已整理 |
| 最后对照 | 2026-10-29，原型提交 `444aee8`（`web-next/src` 最后一次改动 `d164967`） |

### 引用本规格的开发任务

视频插件在 M5 开发，任务按 PLAN-05 拆出的 key 写；带 `p` 后缀的是原型先补的任务，补完要回来更新本规格。

| 任务 | 内容 | 对照的节 |
|---|---|---|
| VID-01a | 视频插件的壳和视频、系列、检查点、发布记录表 | `SPEC-videos-0` 共用数据结构（`Video`、`Series`、`Checkpoint`、`Publish`） |
| VID-01b | 视频产出物：版本、验收记录、来源溯源 | `SPEC-videos-0` 的 `Artifact`、`Review`；`SPEC-videos-12` |
| VID-01c | 视频列表页和视频详情的制作流程 | `SPEC-videos-1`、`SPEC-videos-2`、`SPEC-videos-10`、`SPEC-videos-13` |
| VID-01d | 视频产出物页、产出物抽屉和系列页 | `SPEC-videos-5`、`SPEC-videos-6`、`SPEC-videos-11`、`SPEC-videos-12` |
| VID-02p、VID-02a、VID-02b | 封面比例、横竖两套文稿、字幕 | `SPEC-videos-0` 的 `CoverRatio`、`ARTIFACT_KIND`、`PLATFORMS.cover`；`SPEC-videos-8.10`、`SPEC-videos-9.17`、`SPEC-videos-9.18`、`SPEC-videos-11`、`SPEC-videos-12`（原型已补，VID-02p） |
| VID-03p、VID-03a 到 VID-03d | 阶段执行器（一键跑某个阶段）、SOP 节点和「视频周更」模板 | `SPEC-videos-0` 的 `StageRunner`、`LastRun`；`SPEC-videos-10.19` 到 `10.25`；模板见 `SPEC-sop` 流程库（原型已补，VID-03p） |
| VID-04a 到 VID-04e | 内容平台连接器（B 站、YouTube、抖音） | `SPEC-videos-8`（平台接入情况 `SPEC-videos-8.6` 到 `8.9`）、`SPEC-videos-9` |
| VID-05p、VID-05a 到 VID-05c | 发布记录扩展、按天快照、平台账号、发布前校验、封面 A/B | `SPEC-videos-0` 的 `Metrics`、`MetricSnapshot`、`PlatformAccount`、`PlatformRule`、`CoverTest`；`SPEC-videos-7.15`、`SPEC-videos-8.24` 到 `8.29`、`SPEC-videos-9.19` 到 `9.25`、`SPEC-videos-14`（原型已补，VID-05p） |
| VID-06p、VID-06a 到 VID-06d | 内容日历和到点发布 | `SPEC-videos-0` 的 `Video.target_date`、`CalendarItem`；`SPEC-videos-15`；定时发布 `SPEC-videos-15.12` 到 `15.16`、`SPEC-tasks-0` 的 `ScheduleAction`；`SPEC-videos-8.15`、`SPEC-videos-9.6`（原型已补，VID-06p） |
| VID-07a、VID-07b | 今日卡片：待验收、待发布、发布失败 | `SPEC-videos-0` 联动总表「今日」一行，原型未做 |
| VID-08a 到 VID-08c | 选题库、素材箱、评论收件 | `SPEC-videos-3`、`SPEC-videos-4` |
| VID-09p | 流程最前面的「选题」一步、「内容编写」的编辑区（横竖两套口播稿、大纲、原文，按选题大纲起草） | `SPEC-videos-0` 的 `STAGES`、`Video.topic_id`、`ScriptText`；`SPEC-videos-10.26` 到 `10.45`；`SPEC-videos-3.15`（原型已补，VID-09p；后端 `Stages`、`Video` 和文稿正文还没跟上） |
| VID-08p、VID-08d | 商单 | `SPEC-videos-0` 的 `Deal`、`DealStatus`、`Review.by`；`SPEC-videos-16`（原型已补，VID-08p） |
| TSK-0455 | B 站组件：扫码登录网页端，个人账户数据和按天趋势，私信收发 | `SPEC-videos-18`；源码 `web-next/src/videobili.tsx`（`BiliPage`）（原型和正式版同一任务做完） |
| TSK-0456 | 内容编写的分镜，分镜从登记的本机目录挑 B-roll 照片、视频 | `SPEC-videos-17`；数据约定 `web-next/src/storyboarddata.ts`（`Shot`、`Broll`、`MediaRoot`、`MediaFile`、`shotsFromText`），源码 `web-next/src/storyboard.tsx`（`StoryboardDesk`、`MediaDrawer`）（原型和正式版同一任务做完） |

## SPEC-videos-0 模块概述

给视频博主用：按 web-video-presentation 技能的制作流程管一集视频（选题、内容编写、规划检查、网页开发、第一章验收、其余章节、音频、录屏、分发包），四个检查点要人确认；每一步的产出物带比例、版本和验收记录；多集归成系列共用开场收尾；做完按平台登记发布并回填数据。前面还有选题和素材收件箱两页，负责「做什么」。

模块没有二级菜单，顶栏下面一排八个标签（`VideosTabs`）：全部视频、待我处理、日历、选题、素材收件箱、系列、发布记录、B 站（TSK-0455，见 `SPEC-videos-18`）。商单不在视频模块的标签里，在项目详情的「商单」标签（视频模块开着才有），见 `SPEC-videos-16`。「待我处理」和「素材收件箱」标签后面带数字（停在检查点或被退回的集数、待整理的素材数），一级菜单「视频」在有待处理的集时亮红点。打开某一集时标签栏还在，高亮按从哪进来的算：从系列进来高亮「系列」，其余高亮「全部视频」。

### 页面清单

| 节 | 页面 | 入口 | 说明 |
|---|---|---|---|
| [SPEC-videos-1](#spec-videos-1-全部视频) | 全部视频 | 标签「全部视频」（模块入口） | 按系列分组的视频列表、阶段分布条、搜索和项目筛选 |
| [SPEC-videos-2](#spec-videos-2-待我处理) | 待我处理 | 标签「待我处理」 | 停在检查点上待确认或被退回的集 |
| [SPEC-videos-3](#spec-videos-3-选题) | 选题 | 标签「选题」 | 看板和表格、选题抽屉、打分、立项成视频 |
| [SPEC-videos-4](#spec-videos-4-素材收件箱) | 素材收件箱 | 标签「素材收件箱」 | 收链接和想法、拉热榜和评论、归到选题 |
| [SPEC-videos-5](#spec-videos-5-系列) | 系列 | 标签「系列」 | 系列卡片、新建系列 |
| [SPEC-videos-6](#spec-videos-6-系列详情和系列设置) | 系列详情和系列设置 | 点系列卡片 | 共用部分、待同步、编排集数、改共用部分的影响范围 |
| [SPEC-videos-7](#spec-videos-7-发布记录) | 发布记录 | 标签「发布记录」 | 汇总数字、按视频分组的发布记录、只看一集时的平台对比 |
| [SPEC-videos-8](#spec-videos-8-新建发布) | 新建发布 | 发布记录右上「新建发布」 | 发布弹窗：选视频、平台、比例、封面，按平台接入情况决定能不能自动发 |
| [SPEC-videos-9](#spec-videos-9-发布记录抽屉) | 发布记录抽屉 | 点一条发布记录 | 失败重试、改为立即发布、回填和拉取数据 |
| [SPEC-videos-10](#spec-videos-10-视频详情制作流程) | 视频详情：制作流程 | 点一集视频 | 9 个阶段的时间线（选题、内容编写的编辑区）、4 个检查点的通过和退回、画面比例 |
| [SPEC-videos-11](#spec-videos-11-视频详情产出物) | 视频详情：产出物 | 视频详情标签「产出物」 | 按类型和比例分栏的产出物、封面 5 个版本、登记表单 |
| [SPEC-videos-12](#spec-videos-12-产出物抽屉) | 产出物抽屉 | 点一个产出物 | 改名称路径、状态、选用封面、验收、升版本、预览 |
| [SPEC-videos-13](#spec-videos-13-视频详情设置) | 视频详情：设置 | 视频详情标签「设置」 | 标题、项目、系列和集数、目录、比例、删除 |
| [SPEC-videos-14](#spec-videos-14-封面-ab-测试) | 封面 A/B 测试 | 发布记录「封面 A/B」一节 | 2 到 5 张封面比点击率，按曝光、天数、点击率差距判胜负；新建测试 |
| [SPEC-videos-15](#spec-videos-15-日历) | 日历 | 标签「日历」 | 月、周视图：发布、计划首发日、商单交付；进度落后标红；拖动改日期，定时发布跟着改 |
| [SPEC-videos-16](#spec-videos-16-商单) | 商单 | 项目详情标签「商单」；IM 消息抽屉「转为商单」 | 商单列表、商单抽屉：状态流转、报价参考、账期、挂视频、客户审核、结案报告 |
| [SPEC-videos-18](#spec-videos-18-b-站组件) | B 站组件 | 标签「B 站」 | 扫码登录 B 站网页端；账户概览和按天趋势；私信会话、消息记录、发文字私信 |

### 共用数据结构

字段名和类型照抄 `videodata.ts`、`topicdata.ts`。时间都是 ISO 字符串。

`Video` 一集视频（`videodata.ts`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号。演示数据 `vd1` 到 `vd4`、`ai_01` 到 `ai_32`；选题立项用 `newId('vd')`，「新建视频」用 `vd_<时间戳>` | `vd2` |
| `title` | `string` | 是 | 标题，可以是空串（显示「未命名视频」） | `第 2 集：SOP 编排像搭积木` |
| `project_id` | `string` | 否 | 所属项目 | `pj_pmw` |
| `series_id` | `string` | 否 | 所属系列；没有就是单集 | `sr_pmw` |
| `episode` | `number` | 否 | 第几集，只有在系列里才有 | `2` |
| `orientations` | `Orientation[]` | 是 | 要出哪几个比例；规划检查通过后锁定 | `['landscape', 'portrait']` |
| `stage` | `StageKey` | 是 | 当前阶段 | 见 `STAGES` |
| `checkpoints` | `Checkpoint[]` | 是 | 四个检查点的状态，新建时四条都是 `pending` | |
| `root` | `string` | 是 | 视频项目目录，产出物路径都相对它 | `videos/ep02-sop` |
| `chapters` | `number` | 是 | 章节数，至少 1 | `6` |
| `runners` | `StageRunner[]` | 否 | 各阶段配的执行器，一个阶段最多一条 | 见下 |
| `last_run` | `LastRun` | 否 | 最近一次执行，整集只记一条 | 见下 |
| `target_date` | `string` | 否 | 计划首发日，本地日期 `YYYY-MM-DD`；排日历、算进度落不落后（VID-06p） | `2026-11-02` |
| `topic_id` | `string` | 否 | 来自哪个选题（`Topic.id`），选题那边同时记着 `video_id`；立项生成的视频带上，「选题」一步挑选、新建、换选题时写（VID-09p）。演示数据都没有 | `tp_01` |
| `created_at` | `string` | 是 | 创建时间 | |
| `updated_at` | `string` | 是 | 最后更新；改视频、改产出物都会刷新 | |

`Orientation` 画面比例：`landscape` 横屏 16:9 / `portrait` 竖屏 9:16 / `square` 方形 1:1（常量 `ORIENT`：`label`、`ratio`、`w`、`h`）。

`CoverRatio` 封面比例，和舞台方向分开（常量 `COVER_RATIO`：`label`、`w`、`h`）：`16x9`、`4x3`、`9x16`、`3x4`、`1x1`。每个方向默认出哪几种（`DEFAULT_COVER_RATIOS`，第一个和舞台同比例）：横屏 `16x9`、`4x3`；竖屏 `9x16`、`3x4`、`1x1`；方形 `1x1`、`4x3`。没记 `ratio` 的老封面按方向的第一个算（`coverRatioOf`）。

`StageRunner` 阶段执行器（VID-03p）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `stage` | `StageKey` | 是 | 哪个阶段；能配的阶段见 `SPEC-videos-10.19` | `web` |
| `type` | `RunnerType` | 是 | 交给谁跑 | `skill` 技能 / `sop` SOP / `agent` Agent |
| `ref_id` | `string` | 是 | 技能 id、SOP id 或 Agent id | `sk_video`、`sop_video_weekly` |
| `prompt` | `string` | 否 | 交代给它的话，空就不存 | `套 templates/ai100 搭竖屏演示工程，第 1 章做完整` |

`LastRun` 最近一次执行（技能和 Agent 都按 Agent 运行记，SOP 按 SOP 执行记录）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `type` | `'agent' \| 'sop'` | 是 | 指向哪种运行记录 | `agent` |
| `id` | `string` | 是 | 运行记录 id：Agent 运行 `newId('ar')`，SOP 执行 `newId('run')` | `ar_ai27web` |
| `stage` | `StageKey` | 是 | 跑的哪个阶段 | `web` |
| `status` | `RunState` | 是 | 状态 | `running` / `done` / `failed` |
| `started_at` | `string` | 是 | 开始时间 | |
| `ended_at` | `string` | 否 | 结束时间 | |
| `error` | `string` | 否 | 失败原因 | `预览端口 7801 被占用……` |
| `artifact_ids` | `string[]` | 否 | 这次登记或升版的产出物 | |

`StageKey` 和 `STAGES`（顺序就是制作顺序；`checkpoint: true` 的四个是检查点）

| 顺序 | `key` | `label` | 检查点 | `desc` |
|---|---|---|---|---|
| 1 | `topic` | 选题 | | 这一集讲什么：从选题库挑一个，或者新建一个 |
| 2 | `script` | 内容编写 | | 口播稿按比例各写一套，加大纲；可以按选题大纲起草，原文可选 |
| 3 | `plan` | 规划检查 | 是 | 对齐稿子、大纲、主题、素材、开发方式和画面比例；比例定了就不能改 |
| 4 | `web` | 网页开发 | | 按比例搭演示工程，第 1 章完整做出来 |
| 5 | `ch1` | 第一章验收 | 是 | 第 1 章是后面所有章节的样板，必须验收 |
| 6 | `chapters` | 其余章节 | | 第 2 到 N 章：逐章、顺序或并行开发 |
| 7 | `audio` | 音频合成 | 是 | 决定要不要合成口播音频，按章节出音频 |
| 8 | `record` | 录屏渲染 | | 程序化录屏，合成 mp4 |
| 9 | `distribution` | 分发包 | 是 | 封面（每种封面比例 5 个版本）、简介、章节时间轴 |

「选题」（VID-09p 加的）不是检查点，也没有产出物类型：「新建视频」从它开始，选题立项生成的视频直接停在内容编写（选题一步算已完成）。演示数据里已有的集都已过了选题一步，没挂选题。

`Checkpoint`

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `stage` | `StageKey` | 是 | 哪个检查点 | `plan` / `ch1` / `audio` / `distribution` |
| `state` | `CheckpointState` | 是 | 状态 | `pending` 待确认 / `passed` 已通过 / `rejected` 已退回 / `skipped` 已跳过（只有音频合成能跳过，表示不合成音频） |
| `at` | `string` | 否 | 做决定的时间 | |
| `note` | `string` | 否 | 意见；退回时必填 | `第 3 段太长` |

视频状态 `videoState(v)` 返回 `{ label, tone }`，列表、详情、影响范围里的状态都用它：

- 停在分发包且分发包检查点已通过：「已完成」，`ok`；
- 当前阶段是检查点且 `pending`：「待<阶段名>」（如「待第一章验收」），`warn`；
- 当前阶段是检查点且 `rejected`：「退回修改」，`warn`；
- 其余：阶段名，`info`。
- `tone` 是 `warn` 的就是「等我处理」（`needsMe`），进「待我处理」，算进标签和菜单的数字。

`Artifact` 产出物（`videodata.ts`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号，`newId('af')` | `af10` |
| `video_id` | `string` | 是 | 所属视频 | `vd1` |
| `kind` | `ArtifactKind` | 是 | 类型 | 见 `ARTIFACT_KIND` |
| `name` | `string` | 是 | 名称 | `封面 2` |
| `path` | `string` | 是 | 相对视频目录的路径 | `cover/16x9-2.png` |
| `variant` | `Orientation` | 否 | 按比例区分的类型（`perVariant` 为是的）才有 | `landscape` |
| `ratio` | `CoverRatio` | 否 | 只有封面有：封面本身的比例；没有按 `variant` 算 | `3x4` |
| `option` | `number` | 否 | 封面在同一方向、同一封面比例里第几个版本，1 到 5 | `2` |
| `lang` | `string` | 否 | 只有字幕有：语言 | `zh` |
| `version` | `number` | 是 | 版本号，从 1 起，「升版本」加一 | `3` |
| `status` | `ArtifactStatus` | 是 | 状态 | `draft` 草稿 / `review` 待验收 / `final` 已定稿 / `published` 已发布 |
| `duration` | `number` | 否 | 音频、视频的时长，秒 | `602` |
| `source` | `{ type: 'manual' \| 'sop' \| 'agent' \| 'skill'; label: string }` | 是 | 谁产出的；界面显示「手动 / SOP / Agent / 技能 · label」 | `{ type: 'skill', label: 'web-video-presentation' }`，手动登记的是 `{ type: 'manual', label: '手动登记' }` |
| `reviews` | `Review[]` | 是 | 验收记录，按时间追加 | |
| `picked` | `boolean` | 否 | 封面：同一方向、同一封面比例里选用的那张；没标过的，已发布的那张算选用（`isPicked`） | `true` |
| `created_at` | `string` | 是 | 登记时间 | |

`Review`：`at: string` 时间、`ok: boolean` 通过或退回、`comment: string` 意见（通过没写意见存「通过」）、`by?: ReviewBy` 谁验收的（VID-08p）。`ReviewBy`：`{ type: 'me' | 'contact'; id?: string }`，没有 `by` 的就是自己；`contact` 是外部审核人（商单的客户），`id` 是联系人 id。演示数据：远川的许知行（`ct_005`）验收过 `vd4` 的演示工程、`vd5` 的成片（退回一次再通过）。

`ArtifactKind` 和 `ARTIFACT_KIND`（`stage` 是归在哪个阶段，`perVariant` 是不是每个比例一份）

| `key` | `label` | `stage` | `perVariant` |
|---|---|---|---|
| `article` | 原文 | `script` | 否 |
| `script` | 口播稿 | `script` | 是（横版、竖版各一套，各自验收） |
| `outline` | 大纲 | `script` | 是 |
| `presentation` | 演示工程 | `web` | 是 |
| `audio` | 音频 | `audio` | 否 |
| `video` | 视频（界面上叫「成片」） | `record` | 是 |
| `subtitle` | 字幕 | `record` | 是 |
| `cover` | 封面 | `distribution` | 是（再按 `ratio` 分） |
| `description` | 简介 | `distribution` | 是 |
| `chapters` | 章节时间轴 | `distribution` | 是 |

`ARTIFACT_STATUS` 颜色：草稿 `#a19d92`、待验收 `#b0570b`、已定稿 `#2f7d43`、已发布 `#3d4fd6`。

`ScriptText` 文稿正文（`videodata.ts`，VID-09p）：内容编写里直接写的口播稿、大纲、原文。正文实际落在视频目录的文件里（`Artifact.path`），原型按版本另存一份；不加在 `Artifact` 上

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `video_id` | `string` | 是 | 所属视频 | `vd3` |
| `kind` | `TextKind` | 是 | `article` 原文 / `script` 口播稿 / `outline` 大纲 | `script` |
| `variant` | `Orientation` | 否 | 口播稿、大纲按比例各一份；原文没有 | `landscape` |
| `version` | `number` | 否 | 存成的是这一类产出物的第几版；草稿和初稿没有 | `1` |
| `draft` | `'mine' \| 'proposal'` | 否 | `mine` 自己写着还没保存的草稿（同一类同一比例最多一份，边写边存）；`proposal` 执行器按选题大纲起草、等对比的初稿；都没有就是存成版本的正文 | |
| `body` | `string` | 是 | 正文，Markdown | |
| `source` | `Artifact['source']` | 否 | 初稿是谁起草的，采用时记成产出物来源 | `{ type: 'skill', label: '网页演示做视频' }` |
| `saved_at` | `string` | 是 | 存的时间 | |

- `textStats(md)`：去掉 Markdown 记号后数字数（汉字按字，英文和数字按词），按 `SPEECH_RATE`（每分钟 240 字）估口播时长，返回 `{ chars, seconds }`。
- `draftFromTopic(brief, kind, variant, chapters)`：模拟技能「网页演示做视频」Phase 1，照选题的标题、角度、受众、大纲起草。横屏口播稿开场、大纲每条一段、收尾；竖屏一屏一句；大纲按章节数排，选题大纲条数多的按条数。
- 演示数据 `seedTexts`：只有一人之下第 3 集横屏口播稿 v1（手写）有正文；其余已登记的口播稿、大纲的正文在视频目录里，原型看不到。

`Series` 系列（`videodata.ts`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号，`newId('sr')` | `sr_pmw` |
| `name` | `string` | 是 | 名称，必填 | `一人之下 10 分钟上手` |
| `desc` | `string` | 是 | 说明，可空 | |
| `intro` | `string` | 是 | 共用开场（路径或说明），可空 | `shared/intro-v2.tsx（5 秒标志动画）` |
| `outro` | `string` | 是 | 共用收尾，可空 | |
| `template` | `string` | 是 | 共用模板，可空 | `templates/pmw-theme（暖灰主题）` |
| `stale` | `string[]` | 是 | 改过共用部分但还没同步到的集（视频 id），界面上叫「待同步」 | `['vd3']` |

`Publish` 发布记录（`videodata.ts`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号，`newId('pb')` | `pb3` |
| `video_id` | `string` | 是 | 发的哪一集 | `vd1` |
| `platform` | `PlatformKey` | 是 | 平台 | 见 `PLATFORMS` |
| `variant` | `Orientation` | 是 | 用了哪个比例 | `portrait` |
| `cover_id` | `string` | 否 | 用的哪张封面（`Artifact.id`）；比例要在平台的 `cover` 里 | `af14` |
| `title` | `string` | 是 | 平台上的标题，必填 | `今日待办一页清` |
| `desc` | `string` | 是 | 平台上的简介，可空 | |
| `status` | `PublishStatus` | 是 | 状态 | `planned` 计划中 / `scheduled` 已定时 / `published` 已发布 / `failed` 发布失败 |
| `scheduled_at` | `string` | 否 | 定时发布的时间 | |
| `published_at` | `string` | 否 | 发布时间 | |
| `url` | `string` | 否 | 平台上的链接 | `https://www.bilibili.com/video/BV1xx` |
| `error` | `string` | 否 | 失败原因 | `封面比例不符合要求：抖音要 3:4 或 9:16，这次用的是 1:1` |
| `metrics` | `Metrics` | 否 | 播放数据，最新一条快照 | |
| `account_id` | `string` | 否 | 用哪个平台账号发的（`PlatformAccount.id`） | `pa_ch_a` |
| `tags` | `string[]` | 否 | 标签 | `['效率工具', '待办']` |
| `category` | `string` | 否 | 分区，平台有分区（`PlatformRule.categories`）时才选 | `知识` |
| `collection` | `string` | 否 | 合集 / 播放列表 | `一人之下 10 分钟上手` |
| `checks` | `PublishCheck[]` | 否 | 新建时按平台规则校验的结果，`{ key, ok, text }` | |

`Metrics`：`views` 播放、`likes` 点赞、`comments` 评论、`shares` 转发（都是 `number`，必有）、`updated_at: string` 最后更新；扩展字段平台不给就留空：`impressions` 曝光、`ctr` 点击率（0 到 1）、`avg_watch_sec` 平均观看秒数、`completion` 完播率（0 到 1）、`favorites` 收藏、`coins` 投币（B 站）、`followers_gained` 涨粉。

`MetricSnapshot` 按天快照（`extends Metrics`）：`publish_id`、`day`（发布后第几天，`dayAfter` 算：满一天算 1，不足一天也算 1）、`source`（`manual` 手动回填 / `connector` 连接器拉取）。每次拉取或回填都新存一条，不覆盖；`Publish.metrics` 跟着改成最新一条。`SNAPSHOT_DAYS = [1, 3, 7, 30]` 是曲线上标出的几天。原型的快照和封面测试放在 `covertest.tsx` 的模块级 store（`usePubStore`、`pubStore`），种子是 `seedSnapshots`、`seedCoverTests`；正式版是两张表，连接器每天拉一次（VID-05a）。

`PlatformAccount` 平台账号（`seedAccounts`；一个平台可以接几个账号）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号 | `pa_ch_a` |
| `connector_id` | `string` | 否 | 对应设置里的连接器；手动登记的账号没有，只能回填数据 | `cn_channels` |
| `platform` | `PlatformKey` | 是 | 平台 | `channels` |
| `handle` | `string` | 是 | 平台昵称 / 频道名 | `一人之下·试封面 A` |
| `uid` | `string` | 是 | 平台上的 id | |
| `role` | `AccountRole` | 是 | 角色，`ACCOUNT_ROLE` | `main` 主号 / `ab` A/B 小号 / `client` 客户号 |
| `caps` | `ContentPlatformCap[]` | 是 | 这个账号实际能做什么 | `upload`、`schedule`、`metrics`、`comments`、`reply`、`dm` |
| `followers` | `number` | 否 | 粉丝数 | |

演示数据：每个已接连接器的平台一个主号；视频号另有两个 A/B 小号（手动登记）；B 站有一个远川的客户号；小红书没有账号。

`PlatformRule` 平台发布规则（`PLATFORM_RULES`），`checkPublish(platform, { title, desc, tags, cover, duration })` 按它出 `PublishCheck[]`，字数按字符算：

| 平台 | `title_max` | `desc_max` | `tags_max` | `allow_link` | `cover` | `duration_max_sec` | `categories` |
|---|---|---|---|---|---|---|---|
| B 站 | 80 | 2000 | 10 | 否 | 同 `PLATFORMS.cover` | | 知识、科技、生活 |
| YouTube | 100 | 5000 | 15 | 是 | 同上 | | 教育、科学和技术、人物和博客 |
| 抖音 | 30 | 1000 | 5 | 否 | 同上 | 900 | |
| 视频号 | 30 | 1000 | 10 | 否 | 同上 | 3600 | |
| 小红书 | 20 | 1000 | 10 | 否 | 同上 | 900 | |

校验项：`title` 标题字数、`desc` 简介字数、`tags` 标签个数、`link` 简介外链（平台不允许时才查，认 `http://`、`https://`、`www.`）、`cover` 封面比例（选了封面才查）、`duration` 时长（平台有上限且这集这个比例的成片有时长才查）。数值是原型拟定的，正式版以各平台创作者后台为准（VID-05c）。

`CoverTest` 封面 A/B 测试（`seedCoverTests`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号；原型借 `newId` 的规则换成 `cvt_` 前缀，`ID_PREFIX` 还没登记 | `cvt1` |
| `video_id` | `string` | 是 | 哪一集 | `vd1` |
| `platform` | `PlatformKey` | 是 | 平台 | `channels` |
| `mode` | `CoverTestMode` | 是 | 怎么测，`COVER_TEST_MODE` | `native` 平台原生测试（YouTube 缩略图测试）/ `accounts` 小号分发 / `utm` 分链接（原型不给选） |
| `arms` | `CoverTestArm[]` | 是 | 2 到 5 张封面：`cover_id`；小号分发挂 `publish_id`，曝光点击率从那条发布的 `metrics` 读；原生测试自己记 `impressions`、`ctr` | |
| `started_at` | `string` | 是 | 开始时间 | |
| `ended_at` | `string` | 否 | 结束时间 | |
| `min_days` | `number` | 是 | 至少观察几天 | `7` |
| `min_impressions` | `number` | 是 | 每张至少多少曝光 | `10000` |
| `min_gap` | `number` | 是 | 点击率第一领先第二多少才算显著（相对值） | `0.2` |
| `winner_id` | `string` | 否 | 胜出的封面 | |
| `status` | `CoverTestStatus` | 是 | 状态，`COVER_TEST_STATUS` | `running` 进行中 `#3d4fd6` / `decided` 已决出 `#2f7d43` / `inconclusive` 没有结论 `#a19d92` |

`coverTestState(test, arms)` 算判定进度：`days`（`dayAfter(started_at, ended_at 或现在)`）、`reached`（曝光到线的张数）、`gap`（点击率第一除以第二减 1）、`leader`，以及 `impOk`、`daysOk`、`gapOk` 三个是否到线。

`Artifact.archived`：封面在 A/B 测试里输掉后标归档，留着不删（COVER.md Part 7）。

`PlatformKey` 和 `PLATFORMS`（`prefer` 是平台推荐的比例；`cover` 是平台收的封面比例，第一个是推荐的，新建发布只列这些比例的封面，发布时不符合就失败；`PLATFORM_TOOL` 把平台对到设置里连接器的工具 key，五个平台 key 和工具 key 相同）

| `key` | `label` | `color` | `prefer` | `cover` | 发布方式（开发计划第 6 节） |
|---|---|---|---|---|---|
| `bilibili` | B 站 | `#fb7299` | `landscape` | `16x9`、`4x3` | 连接器接通后自动上传、定时、拉数据 |
| `youtube` | YouTube | `#ff0033` | `landscape` | `16x9` | 同上 |
| `douyin` | 抖音 | `#161823` | `portrait` | `3x4`、`9x16` | 同上 |
| `channels` | 视频号 | `#07c160` | `portrait` | `9x16`、`3x4` | **只做「登记加回填链接加拉数据」**：平台不开放发布接口，在视频号助手里发完回来填链接；连接器只拉数据和评论 |
| `xiaohongshu` | 小红书 | `#ff2442` | `portrait` | `3x4`、`1x1` | **只做「登记加回填链接加拉数据」**：在 App 或创作者中心发布 |

`PUBLISH_STATUS` 颜色：计划中 `#a19d92`、已定时 `#3d4fd6`、已发布 `#2f7d43`、发布失败 `#c0352b`。

`ChannelState` 平台接入情况（原型定义在 `videopublish.tsx`，不在 data 文件；`App.tsx` 按设置里的连接器算出来传给发布页）

| 取值 | 条件 | 含义 |
|---|---|---|
| `ok` | 有这个平台的连接器、状态 `connected`，且它的工具清单里有可写的上传类工具（名字含 `upload` 或 `create_video`） | 能自动发布、定时发布 |
| `manual` | 已连接，但没有上传类工具（视频号、小红书） | 只能登记；数据能拉 |
| `error` | 连接器状态 `error` | 只能登记；提示修复，带连接器的 `error` |
| `none` | 没有这个平台的连接器，或连接器不是 `connected` 也不是 `error` | 只能登记；提示去接入 |

其余字段：`name`（连接器名称）、`error`（异常原因）。演示数据里 B 站、YouTube 是 `ok`，视频号是 `manual`，抖音是 `error`（授权过期），小红书是 `none`。

`Topic` 选题（`topicdata.ts`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号，`newId('tp')` | `tp_01` |
| `title` | `string` | 是 | 标题，可空（显示「未命名选题」）；立项前必须写 | `Cursor 和 Claude Code 到底怎么选` |
| `angle` | `string` | 是 | 切入角度 | |
| `audience` | `string` | 是 | 目标受众 | |
| `status` | `TopicStatus` | 是 | 状态 | `idea` 想法 / `research` 调研中 / `ready` 可开拍 / `scheduled` 已排期 / `made` 已做成 / `dropped` 放弃 |
| `score` | `TopicScore` | 是 | 打分 | `{ demand: 5, fit: 5, effort: 3 }` |
| `tags` | `string[]` | 是 | 标签 | `['AI 编程', '对比']` |
| `series_id` | `string` | 否 | 打算归到哪个系列 | `sr_ai` |
| `platforms` | `PlatformKey[]` | 是 | 打算发哪些平台；立项时按它们的推荐比例定 `orientations` | `['bilibili', 'youtube']` |
| `outline` | `string` | 是 | 大纲草稿，markdown | |
| `clip_ids` | `string[]` | 是 | 关联的素材 | `['cl_01', 'cl_02']` |
| `planned_at` | `string` | 否 | 计划开做的日期，状态「已排期」时填 | |
| `video_id` | `string` | 否 | 立项生成的视频 | |
| `drop_reason` | `string` | 否 | 放弃原因 | `和账号定位不符，热度也一般` |
| `created_at` | `string` | 是 | | |
| `updated_at` | `string` | 是 | | |

`TopicScore`：`demand` 需求度（有多少人想看）、`fit` 契合度（和账号定位合不合）、`effort` 制作成本（越高越难做），各 1 到 5。优先级 `topicPriority = round(((demand x 0.45 + fit x 0.35 + (6 - effort) x 0.2) / 5) x 100) / 10`，满分 10；8 以上高、6 以上中、其余低（三种颜色）。`TOPIC_FLOW` 是状态的排列顺序，也是看板的列顺序：想法、调研中、可开拍、已排期、已做成、放弃。

`Clip` 素材（`topicdata.ts`）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | 编号，`newId('cl')` | `cl_03` |
| `kind` | `ClipKind` | 是 | 类型 | `link` 链接 / `note` 笔记 / `trend` 热榜 / `comment` 评论 / `competitor` 竞品 / `im` IM 消息 |
| `title` | `string` | 是 | 标题 | |
| `content` | `string` | 是 | 内容，可空 | |
| `url` | `string` | 否 | 链接，有就把标题做成外链 | |
| `source` | `string` | 是 | 从哪来：平台名、热榜名、评论所在视频、消息所在群 | `B 站评论 · 第 3 集：Cursor 改代码` |
| `heat` | `number` | 否 | 热度、点赞、播放这类数字 | `860000` |
| `tags` | `string[]` | 是 | 标签 | |
| `starred` | `boolean` | 是 | 收藏 | |
| `topic_ids` | `string[]` | 是 | 已归到的选题 | |
| `triaged` | `boolean` | 是 | 处理过（看过、转选题、归到选题）就不再出现在「待整理」 | |
| `created_at` | `string` | 是 | 收进来的时间 | |

`TREND_POOL`、`COMMENT_POOL`：原型模拟「拉取热榜」「收集评论」用的两批假数据（`Omit<Clip, 'id' | 'created_at'>[][]`），每点一次取下一批，取完就没有新的。正式版由内容平台连接器拉（VID-08b）。

`VideoView`（原型未定义成数据类型，写在 `videos.tsx`）：`all` 全部视频 / `review` 待我处理 / `single` 单集 / `sr:<系列 id>` 系列详情 / `video:<视频 id>` 视频详情 / `series` 系列 / `publish` 发布记录 / `topics` 选题 / `clips` 素材收件箱 / `calendar` 日历。

`CalendarItem` 日历上的一条（`calendarItems(videos, publishes, deals, today)` 算出来，不存）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `date` | `string` | 是 | 落在哪天，本地日期 `YYYY-MM-DD`；发布取 `published_at`（已发布）或 `scheduled_at`（其余），没有时间的发布不上日历 | `2026-11-02` |
| `kind` | `'publish' \| 'target' \| 'deal_deadline'` | 是 | 发布 / 计划首发日（`Video.target_date`）/ 商单交付截止（`Deal.deadline`，已交付、已收款、丢单的不上） | `publish` |
| `ref_id` | `string` | 是 | 发布 id、视频 id 或商单 id | `pb5` |
| `label` | `string` | 是 | 发布标题（空的用视频标题）、视频标题、「品牌：商单名」 | |
| `tone` | `'ok' \| 'warn' \| 'danger' \| 'muted'` | 是 | 发布：失败 `danger`、已发布 `ok`、其余 `muted`；首发日：已完成 `ok`、进度落后 `danger`、其余 `muted`；商单截止：3 天内 `warn` | |
| `at` | `string` | 否 | 发布的具体时刻 | |
| `status` | `PublishStatus` | 否 | 发布的状态 | `scheduled` |
| `platform` | `PlatformKey` | 否 | 发布的平台 | `bilibili` |
| `video_id` | `string` | 否 | 发布和首发日所属的视频 | `vd2` |
| `movable` | `boolean` | 是 | 能不能拖：计划中、已定时的发布和没完成的首发日能拖；已发布、失败的发布和商单截止不能 | |

进度落后 `isBehind(video, today)`：排了 `target_date`，离它不到 `LATE_DAYS`（7）天或已经过了，第一章验收检查点还没 `passed`。日期工具：`localYmd(date)` 本地日期，`daysBetween(a, b)` 两个本地日期差几天。

`Deal` 商单（`seedDeals`，VID-08p）

| 字段 | 类型 | 必填 | 说明 | 取值 / 示例 |
|---|---|---|---|---|
| `id` | `string` | 是 | `newId('deal')`；演示数据 `deal_yc1`、`deal_yc2`、`deal_ba1` | `deal_yc1` |
| `project_id` | `string` | 是 | 挂在哪个项目；客户、对接人、决策人都用项目干系人 | `pj_perm` |
| `contact_id` | `string` | 否 | 询价人（联系人 id）；IM 转来的默认是发信人 | `ct_006` |
| `brand` | `string` | 是 | 品牌；IM 转来的默认取联系人的公司 | `远川科技` |
| `title` | `string` | 是 | 商单名称 | `试点上线短片` |
| `platforms` | `PlatformKey[]` | 是 | 投放平台，可以空 | `['bilibili']` |
| `deliverables` | `string` | 是 | 交付物，可以空串 | `1 支 3 分钟横版……` |
| `quote` | `number` | 是 | 报价，不小于 0 | `12000` |
| `currency` | `'CNY' \| 'USD'` | 是 | 币种 | `CNY` |
| `status` | `DealStatus` | 是 | 状态 | 见下 |
| `deadline` | `string` | 否 | 交付截止，`YYYY-MM-DD` | |
| `pay_due` | `string` | 否 | 账期，最晚收款日 `YYYY-MM-DD` | |
| `video_ids` | `string[]` | 是 | 挂上的视频；保存时没有项目的视频归到商单的项目 | `['vd5']` |
| `source_message_id` | `string` | 否 | 从哪条 IM 消息转来的；一条消息只转一个商单 | `msg_008` |
| `report_content_id` | `string` | 否 | 结案报告，指向「文档」里的一篇 `ContentItem` | |
| `lost_reason` | `string` | 否 | 丢单原因，状态是丢单时必填 | |
| `history` | `{ status: DealStatus; at: string }[]` | 是 | 状态变化，新的在前；新建时一条「询价」 | |
| `created_at`、`updated_at` | `string` | 是 | | |

`DealStatus` 和 `DEAL_STATUS`：`inquiry` 询价 `#a19d92`、`quoted` 已报价 `#7a4fd6`、`signed` 已签约 `#3d4fd6`、`producing` 制作中 `#0f8a8a`、`client_review` 客户审核 `#b0570b`、`delivered` 已交付 `#2f7d43`、`paid` 已收款 `#2f7d43`、`lost` 丢单 `#c0352b`。`DEAL_FLOW` 是前七个的顺序；状态可以点任一步，不强制按顺序，丢单在已收款后不能点。

商单的几个算法（`videodata.ts`）：

- `payState(deal, today)`：已交付、填了账期、离账期不到 7 天时返回 `{ days, tone }`，过了是 `danger`，其余 `warn`；别的情况 `null`。
- `avgViews30(publishes, platforms)`：近 30 天这些平台（空就是全部）已发布、有数据的记录的平均播放（`Publish.metrics` 就是最新一条快照）。报价参考 = 均播 / 1000 x `QUOTE_CPM`（150 元），取整到百，写作「投放价值」，制作费另算。
- `reportState(deal, publishes)`：挂上的视频最早一条已发布记录满 `REPORT_DAYS`（7）天才 `ready`，没满给 `left`（还差几天），还没发布返回 `null`。
- `dealReport(deal, videos, publishes)`：结案报告正文（轻量 Markdown）：合作概况、数据汇总、各平台明细（发布天数、播放、点击率、完播率、链接）、结论（待补充）。

### 联动总表

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 改动 | 项目 | 视频设置里选「所属项目」 | `Video.project_id` 指向项目；全部视频的行上显示项目名，能按项目筛选。原型里项目详情没有「视频」标签，项目页看不到它的视频 | `SPEC-videos-13.2`、`SPEC-projects-2` |
| 进来 | 项目 | 删除项目 | 这个项目的视频 `project_id` 清空，记录保留；删除前的影响里写「N 个视频会移出项目」 | `SPEC-projects-13.10`、`SPEC-projects-13.11` |
| 出去 | 设置（连接器，内容平台） | 新建发布里平台没接入或异常，点「去接入」「去修复」 | 跳到设置 / 连接器，分类筛到内容平台；已有连接器打开它的抽屉，没有就打开这个平台的新建抽屉 | `SPEC-videos-8.8`、`SPEC-settings-3.3`、`SPEC-settings-5` |
| 进来 | 设置（连接器，内容平台） | 连接器状态、工具清单 | 决定每个平台的 `ChannelState`：能不能自动发、只能登记、提示修复 | `SPEC-videos-0` `ChannelState`、`SPEC-settings-5` |
| 进来 | 设置（工作台与模块） | 工作台模板「视频博主」 | 首页就是视频模块；模块不在当前工作台时一级菜单没有「视频」 | `SPEC-settings-2` |
| 出去 | 浏览器 | 产出物「预览」、发布记录「打开链接」 | 在内置浏览器新开标签：演示工程、成片、封面预览地址是 `http://127.0.0.1:7801/<视频目录>/<路径>`；发布链接直接打开 | `SPEC-videos-12.10`、`SPEC-videos-9.9`、`SPEC-browser-3` |
| 进来 | Agent（技能） | 产出物的来源 | 技能列表里有内置的「网页演示做视频」（`sk_video`，web-video-presentation）和「视频数据复盘」（`sk_video_review`）；产出物 `source.type` 可以是 `skill`、`agent`、`sop`。制作流程里每个阶段可以配技能或 Agent 当执行器，跑完的产出物来源记成它（VID-03p，`SPEC-videos-10.19`） | `SPEC-settings-15`、`SPEC-settings-16`、`SPEC-videos-12.2` |
| 出去 | SOP | 制作阶段交给 SOP 跑、SOP 里的「发布到平台」节点 | 原型：阶段执行器可以选 SOP，流程库里有内置的「视频周更」（`sop_video_weekly`，8 步：文稿处理、规划检查、开发第 1 章、检查第 1 章、并行开发其余章节、音频检查、渲染、分发包检查），SOP 产出的产出物 `source.type = 'sop'`。原型里执行器选 SOP 只模拟跑完，不真的发起一次 SOP 执行；「发布到平台」节点原型未做。正式版：视频插件登记 SOP 节点和模板（VID-03d），节点类型的登记方式按 SOP 的插件节点 | `SPEC-sop-11`、`SPEC-sop-0` |
| 出去 | 今日 | 待验收的视频、待发布、发布失败 | 原型未做：今日页没有视频的分组。正式版（VID-07a、VID-07b）往今日聚合里加一组，点一条跳到对应视频的制作流程或发布记录抽屉；视频插件停用后整组消失 | `SPEC-today-1.4`、`SPEC-today-1.23` |
| 出去 | 任务（定时任务） | 发布记录定了时间、在日历上挪了日期、改成立即发布、删掉 | 定时任务跟着补、改、停用、删：一条已定时的发布对一条「只执行一次」的定时任务，动作 `publish`，id `sc_pub_<发布 id>`；定时任务里只读 | `SPEC-videos-15.12`、`SPEC-tasks-7`、`SPEC-tasks-8` |
| 改动 | 运行异常 | 发布记录变成发布失败（到点发、立即执行、重试都算） | 记一条错误级异常，模块「发布」，指纹 `publish:<发布 id>`，同一条合并次数；种子里抖音那条已经记了 `inc10` | `SPEC-videos-15.14`、`SPEC-settings-18` |
| 出去 | 项目 | 项目详情「商单」标签 | 视频模块开着才有这个标签；商单挂在项目下，挂上的视频归到这个项目；有账期快到的单时标签上亮红点 | `SPEC-videos-16`、`SPEC-projects-2` |
| 进来 | IM 消息 | 消息抽屉「转为商单」 | 打开新建商单抽屉，按发信人预填询价人、品牌、项目；转过的打开那个商单 | `SPEC-videos-16.11`、`SPEC-messages-2` |
| 出去 | 文档 | 商单「出结案报告」 | 「文档」里新建一篇（分类文档，标签「商单」「结案报告」），同时挂进项目的文档；重出覆盖原来那篇 | `SPEC-videos-16.9` |
| 出去 | 今日 | 商单账期快到 | 「需要你处理」里一条「商单账期」，点了打开商单抽屉；视频模块关掉就没有 | `SPEC-videos-16.4`、`SPEC-today-1` |
| 进来 | IM 消息 | 素材类型「IM 消息」 | 原型里只有演示数据（`cl_06`），没有从 IM 消息转素材的入口。正式版 VID-08b 加「转为素材」 | `SPEC-messages-2` |

### 发现的原型问题（待另开修错任务，本条不改原型）

| 编号 | 问题 | 在哪 | 建议 |
|---|---|---|---|
| 1 | 视频号、小红书这类只能登记的平台，登记后是「计划中」，抽屉里只给「改为立即发布」，点了会模拟自动发布、生成假链接，和开发计划第 6 节「只登记加回填链接加拉数据」矛盾；也没有地方回填链接，「回填数据」只在已发布时出现，所以手动平台的记录正常走不到已发布 | `PublishDrawer` | 平台不是 `ok` 时把「改为立即发布」换成「填链接，标为已发布」：填 `url`、`published_at`，之后可以回填和拉取数据。对应 `SPEC-videos-9.6`、`9.7` |
| 2 | 删除视频的确认文案只说删产出物记录，实际还会删掉这一集的发布记录、从系列的待同步里摘掉；立项生成它的选题 `video_id` 留着，选题抽屉里「打开视频」会进「这个视频已经删除」 | `VideoDetail` 设置、`App.tsx` 的 `onDelete` | 文案写全「N 条产出物、N 条发布记录」；删除时清掉选题的 `video_id`，状态回到「可开拍」 |
| 3 | 演示数据：AI 系列第 25 集第一章验收是「已退回」，但没有意见也没有时间，详情里显示「退回意见：没写意见」；AI 系列各集过了网页开发却没有演示工程产出物，第一章验收要验的工程是空的 | `videodata.ts` 的 `aiSeries`、`seedArtifacts` | 给退回补 `note`、`at`；第一章验收以后的集补演示工程产出物 |
| 4 | 手机宽度下模块标签栏一行放不下，「发布记录」在右边看不到，要横向滑动，没有提示 | `VideosTabs`（`.vd-mtabs`） | 跟其它模块的窄屏标签一致：可横向滚动并露出半个标签，或换行 |
| 5 | 原型总览页的视频页面名写的是「系列管理」，标签实际叫「系列」；`VIEW_OF` 里没有视频的编号，规格改成已整理后总览点页面名会落到模块入口 | `overview.tsx` 的 `DRAFT`、`VIEW_OF` | 补 `SPEC-videos-1` 到 `SPEC-videos-7` 对应 `all`、`review`、`topics`、`clips`、`series`、`series`、`publish`，`DRAFT` 改名「系列」 |
| 6 | `VideosNav`（视频的二级菜单）已经不用了还留在代码里；`videos.tsx` 的 `isPicked` 注释说「videodata 的 Artifact 还没有 picked 字段」，其实已经有了；「新建视频」的 id 用 `vd_<时间戳>`，没走 `newId` | `videos.tsx`、`App.tsx` 的 `newVideo` | 删掉 `VideosNav`、改注释、改用 `newId('vd')` |
| 7 | 封面「选用」说「发布时默认用它」，但新建发布里封面默认不选，要手动点 | `NewPublishDrawer` 的 `cover` 初值 | 换比例或打开时默认选这个比例里选用的那张 |

## SPEC-videos-1 全部视频

模块入口。按系列分组看所有视频：每个系列一组，组头是系列名、集数、已完成数、待处理数和这一组的阶段分布条，组里先露等我处理的、再按更新时间补满 4 集；不属于系列的放最后一组「单集」。有搜索词或筛选时不分组，换成一张平铺的表。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![](shots/videos/标签_全部视频-1440-light.png) | ![](shots/videos/标签_全部视频-1440-dark.png) |
| 手机 375 | ![](shots/videos/标签_全部视频-375-light.png) | ![](shots/videos/标签_全部视频-375-dark.png) |

模块入口截图（`入口-*.png`）和「全部视频」标签截图是同一页。

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-1.1 | 页面标题 | 展示 | 「全部视频」，前面是「视频」，后面是总集数，说明「按系列分组；点系列看全部集数」 |
| SPEC-videos-1.2 | 右上「新建视频」 | 点击 | 新建一集单集视频（标题「新视频」，比例横屏，阶段选题（VID-09p 起，原来是内容编写），四个检查点待确认，目录 `videos/new-<n>`，章节 3），直接打开它的详情（`SPEC-videos-10`） |
| SPEC-videos-1.3 | 阶段分布条 | 展示 / 点击 | 上面一条按阶段分段、宽度按集数比例：已完成绿色，有等我处理的段橙色，其余蓝色；下面一排「阶段名 + 集数」的小块。点一段或一块按这个阶段筛（再点取消），出现「清除」 |
| SPEC-videos-1.4 | 搜索框 | 输入 | 按标题、目录、集数过滤；有内容时不再分组 |
| SPEC-videos-1.5 | 项目筛选 | 选择 | 「全部项目」/ 某个项目 / 「不属于项目」，可搜索；选了不再分组 |
| SPEC-videos-1.6 | 排序「按集数 / 按更新」 | 点击 | 只在平铺表里出现；默认按更新倒序 |
| SPEC-videos-1.7 | 组头的系列名、组头分布条 | 点击 | 打开这个系列的详情（`SPEC-videos-6`）；「单集」组打开单集列表（`view = single`，同样的表，只列不属于系列的视频） |
| SPEC-videos-1.8 | 组头「查看全部 N 集」 | 点击 | 组里超过 4 集才有，打开系列详情 |
| SPEC-videos-1.9 | 视频行 | 展示 | 集数（没有写「-」）、标题、待同步标签（系列改过共用部分没同步的集，橙色「待同步」）、第二行（系列名、项目名、产出物数，都没有就只有一行）、比例标签（没定写「未定」）、8 段进度条和「n/8」、状态胶囊、相对更新时间 |
| SPEC-videos-1.10 | 视频行 | 点击 | 打开视频详情（`SPEC-videos-10`），标签栏高亮「全部视频」 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-1.11 | 一个视频都没有 | 「还没有视频」「把一篇文章或口播稿做成网页演示，再录成视频」，没有分布条 | 「新建视频」 |
| SPEC-videos-1.12 | 筛选后没有结果 | 「没有匹配的视频」「换个筛选条件试试」 | 清空搜索、点「清除」 |
| SPEC-videos-1.13 | 视频的项目已删除 | 项目名显示「已删除的项目」 | 在视频设置里改项目 |
| SPEC-videos-1.14 | 加载失败 | 原型未做；正式产品显示错误信息和「重试」 | 重试 |

### 数据

用到 `Video`、`Series`、`Artifact`（只数条数），见 `SPEC-videos-0`。阶段筛选的取值 `StageFilter` 是 `''`、任一 `StageKey` 或 `done`（已完成，`isFinished`）。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | 项目 | 项目名、项目筛选 | 读项目列表 | `SPEC-projects-1` |
| 出去 | 本模块 | 点行、点组头 | 视频详情、系列详情 | `SPEC-videos-10`、`SPEC-videos-6` |

## SPEC-videos-2 待我处理

只列「等我动手」的集：停在检查点上待确认，或检查点被退回待修改（`needsMe`）。同一张表，不分组、没有分布条。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![](shots/videos/标签_待我处理-1440-light.png) | ![](shots/videos/标签_待我处理-1440-dark.png) |
| 手机 375 | ![](shots/videos/标签_待我处理-375-light.png) | ![](shots/videos/标签_待我处理-375-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-2.1 | 标签「待我处理」的数字 | 展示 | 等我处理的集数，鼠标悬停「N 集停在检查点或被退回」；为 0 不显示。一级菜单「视频」同时亮红点 |
| SPEC-videos-2.2 | 页面标题 | 展示 | 「待我处理」，说明「停在检查点上等你确认，或者被退回要改的」 |
| SPEC-videos-2.3 | 搜索、项目筛选、排序 | 同 `SPEC-videos-1.4` 到 `1.6` | 默认按更新倒序 |
| SPEC-videos-2.4 | 视频行 | 点击 | 打开视频详情的制作流程，当前检查点上有「通过」「退回」（`SPEC-videos-10.6`）；处理完回到这里，那一集不再出现 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-2.5 | 没有要处理的 | 「没有等你处理的视频」「检查点都确认过了」 | 无 |
| SPEC-videos-2.6 | 筛选后没有结果 | 「没有匹配的视频」 | 清空搜索 |

### 数据

见 `SPEC-videos-0` 的 `Video`、`videoState`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 出去 | 今日 | 等我处理的集 | 原型未做；正式版作为今日的「待验收的视频」卡片（VID-07） | `SPEC-today-1.4` |

## SPEC-videos-3 选题

从素材里挑题、打分、想清楚角度，可开拍了就立项成视频。默认看板（按 `TOPIC_FLOW` 分列，「放弃」列默认不显示），可以切成表格。都按优先级从高到低排。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![](shots/videos/标签_选题-1440-light.png) | ![](shots/videos/标签_选题-1440-dark.png) |
| 手机 375 | ![](shots/videos/标签_选题-375-light.png) | ![](shots/videos/标签_选题-375-dark.png) |
| 表格视图 | ![](shots/videos/选题_表格-1440-light.png) | ![](shots/videos/选题_表格-1440-dark.png) |
| 选题抽屉 | ![](shots/videos/选题抽屉-1440-light.png) | ![](shots/videos/选题抽屉-1440-dark.png) |
| 已放弃的选题 | ![](shots/videos/选题抽屉_已放弃-1440-light.png) | ![](shots/videos/选题抽屉_已放弃-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-3.1 | 右上「新建选题」 | 点击 | 新建一条（状态想法、三项打分都是 3），放在最前面并打开抽屉，焦点在标题 |
| SPEC-videos-3.2 | 搜索框 | 输入 | 按标题、角度、标签过滤 |
| SPEC-videos-3.3 | 系列筛选 | 选择 | 「全部系列」/ 某个系列 / 「不属于系列」 |
| SPEC-videos-3.4 | 状态筛选 | 选择 | 只在表格视图出现，每个状态后面带条数 |
| SPEC-videos-3.5 | 「显示已放弃」 | 点击 | 只在看板出现，切换「放弃」列 |
| SPEC-videos-3.6 | 「看板 / 表格」 | 点击 | 切视图 |
| SPEC-videos-3.7 | 看板列 | 展示 | 列头是状态胶囊和条数；每列先露 8 张，多了显示「还有 N 个」，点开后「收起」；空列显示该状态的说明（如「先记下来，还没细想」） |
| SPEC-videos-3.8 | 选题卡片 | 展示 / 点击 | 标题、优先级分（三色）、角度、系列标签、素材条数、「M/D 开做」（有计划日期时）、「已立项」；点击打开抽屉 |
| SPEC-videos-3.9 | 表格行 | 展示 / 点击 | 优先级、选题和角度、系列、素材数、状态、更新时间；一次 50 条，「显示更多（还有 N 条）」；点击打开抽屉 |
| SPEC-videos-3.10 | 抽屉：标题、角度、受众、标签、大纲 | 输入 | 边输边存，`updated_at` 刷新；标签用中英文逗号分隔 |
| SPEC-videos-3.11 | 抽屉：状态 | 点击 | 六个状态按钮；「已做成」在没立项时不可点（提示「立项后自动变成已做成」）。选「放弃」多出「放弃原因」，选「已排期」多出「计划开做」日期 |
| SPEC-videos-3.12 | 抽屉：打分 | 点圆点 | 三行各 5 个圆点，制作成本用另一种颜色；标题旁的优先级和抽屉头的分数跟着变 |
| SPEC-videos-3.13 | 抽屉：系列、发哪些平台 | 选择 | 平台可多选，决定立项时出哪几个比例 |
| SPEC-videos-3.14 | 抽屉：关联素材 | 展示 / 点 x | 列出关联的素材（类型、标题、来源）；点 x 取消关联，素材那边的 `topic_ids` 同步去掉 |
| SPEC-videos-3.15 | 抽屉底部「立项做成视频」 | 点击 | 生成一集视频：有系列时排在系列最后一集之后、标题「第 N 集：<选题标题>」；比例按所选平台的推荐比例去重，没选平台就横屏；目录 `videos/<选题 id>`，记下 `topic_id`，阶段直接是内容编写（选题一步算已完成，VID-09p）；选题变成「已做成」并记下 `video_id`，关抽屉，打开新视频的详情 |
| SPEC-videos-3.16 | 抽屉底部「打开视频：<标题>」 | 点击 | 已立项的选题显示这个按钮代替立项，打开那一集 |
| SPEC-videos-3.17 | 抽屉底部「删除」 | 点击 | 换成确认条「删除后不能恢复，关联的素材保留」「取消」「删除」；确认后删掉选题，素材上的关联去掉 |
| SPEC-videos-3.18 | Esc、右上 x | 点击 / 按键 | 关抽屉 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-3.19 | 没有任何选题 | 「还没有选题」「先去素材收件箱收点东西，或者直接新建一个」 | 「新建选题」 |
| SPEC-videos-3.20 | 表格筛选后没有结果 | 「没有匹配的选题」 | 改筛选 |
| SPEC-videos-3.21 | 没写标题就想立项 | 「立项做成视频」不可点，提示「先写标题」 | 写标题 |
| SPEC-videos-3.22 | 已放弃的选题 | 「立项做成视频」不可点，提示「已放弃的选题不能立项」 | 改状态 |
| SPEC-videos-3.23 | 选题的系列已删除 | 卡片上显示「已删除的系列」 | 抽屉里改系列 |

### 数据

见 `SPEC-videos-0` 的 `Topic`、`TopicScore`、`Clip`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | 本模块 | 素材「转为选题」、素材上的选题标签 | 切到选题并打开那条 | `SPEC-videos-4.8`、`SPEC-videos-4.12` |
| 改动 | 本模块 | 立项 | 全部视频里多一集，系列里多一集 | `SPEC-videos-1`、`SPEC-videos-6` |

## SPEC-videos-4 素材收件箱

评论、热榜、竞品、聊天里冒出来的点子先收进来，再挑出值得做的变成选题。按收进来的时间倒序，分「今天 / 昨天 / 本周 / 更早」。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![](shots/videos/标签_素材收件箱-1440-light.png) | ![](shots/videos/标签_素材收件箱-1440-dark.png) |
| 手机 375 | ![](shots/videos/标签_素材收件箱-375-light.png) | ![](shots/videos/标签_素材收件箱-375-dark.png) |
| 归到选题 | ![](shots/videos/素材_归到选题-1440-light.png) | ![](shots/videos/素材_归到选题-1440-dark.png) |
| 拉取热榜之后 | ![](shots/videos/素材_拉取热榜-1440-light.png) | ![](shots/videos/素材_拉取热榜-1440-dark.png) |
| 待整理清空 | ![](shots/videos/素材_待整理为空-1440-light.png) | ![](shots/videos/素材_待整理为空-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-4.1 | 标签「素材收件箱」的数字 | 展示 | 待整理（`triaged = false`）的条数，为 0 不显示 |
| SPEC-videos-4.2 | 顶部输入框和「收进来」 | 输入后回车或点击 | 以 `http://` 或 `https://` 开头的当链接（标题取去掉协议的前 60 个字），否则当笔记（标题取前 40 个字）；来源「手动添加」，进待整理，输入框清空。输入法组字时回车不提交；没内容时按钮不可点 |
| SPEC-videos-4.3 | 右上「拉取热榜」「收集评论」 | 点击 | 按钮变「拉取中…」「收集中…」，两个都暂时不可点；原型约 1 秒后从假数据池取下一批插到最前面，标题旁提示「收进 N 条热榜 / 评论」，取完提示「没有新的热榜 / 评论」。正式版由内容平台连接器拉（VID-08b） |
| SPEC-videos-4.4 | 「待整理 / 收藏 / 全部」 | 点击 | 切换范围，后面带条数 |
| SPEC-videos-4.5 | 搜索框 | 输入 | 按标题、内容、来源、标签过滤 |
| SPEC-videos-4.6 | 类型筛选 | 点击 | 「全部类型」或六种类型之一，再点取消 |
| SPEC-videos-4.7 | 素材卡片 | 展示 | 类型标签、标题（有链接时是外链，新窗口打开）、热度、相对时间、内容（和标题相同就不重复）、来源、已归到的选题标签；待整理的卡片左边有色条 |
| SPEC-videos-4.8 | 「转为选题」 | 点击 | 新建一个选题：标题用素材标题，大纲用素材内容，标签照搬，热度过万需求度给 4、否则 3；素材标为已整理并关联它；切到选题页打开这个选题 |
| SPEC-videos-4.9 | 「归到选题」 | 点击 | 弹出菜单列出进行中的选题（不含已做成、已放弃），超过 8 个时带搜索框；已关联的那条不可点；选一个后两边互相记上，素材标为已整理 |
| SPEC-videos-4.10 | 「收藏 / 已收藏」 | 点击 | 切换 `starred` |
| SPEC-videos-4.11 | 「看过了」 | 点击 | 只在待整理的卡片上；标为已整理，从待整理里消失 |
| SPEC-videos-4.12 | 选题标签「选题：<标题>」 | 点击 | 切到选题页打开那条 |
| SPEC-videos-4.13 | 「删除」 | 点击 | 直接删掉素材，选题上的关联一起去掉（原型没有确认） |
| SPEC-videos-4.14 | 「显示更多」 | 点击 | 一次 50 条，多了再加 50 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-4.15 | 待整理的都处理完了 | 「待整理的都处理完了」「在上面粘贴链接，或者拉取热榜、收集评论」 | 收素材、拉取 |
| SPEC-videos-4.16 | 收藏、全部或筛选后没有 | 「这里没有素材」 | 同上 |
| SPEC-videos-4.17 | 没有进行中的选题 | 「归到选题」不可点，提示「没有进行中的选题」 | 「转为选题」 |
| SPEC-videos-4.18 | 平台没接入时拉取 | 原型未做（假数据照样能拉）；正式版：内容平台连接器没接或异常时，按钮旁提示并给「去接入」，跳 `SPEC-settings-3` | 去接入 |

### 数据

见 `SPEC-videos-0` 的 `Clip`、`Topic`、`TREND_POOL`、`COMMENT_POOL`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 改动 | 本模块 | 转为选题、归到选题 | 选题多一条或多一个关联素材 | `SPEC-videos-3` |
| 进来 | 设置（连接器，内容平台） | 拉热榜、收评论 | 原型模拟；正式版读平台连接器 | `SPEC-settings-5` |
| 进来 | IM 消息 | IM 消息类素材 | 原型只有演示数据；正式版 VID-08b | `SPEC-messages-2` |

## SPEC-videos-5 系列

一个系列一张卡片，只看整体进度；点卡片进系列详情。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![](shots/videos/标签_系列-1440-light.png) | ![](shots/videos/标签_系列-1440-dark.png) |
| 手机 375 | ![](shots/videos/标签_系列-375-light.png) | ![](shots/videos/标签_系列-375-dark.png) |
| 新建系列，名称没填 | ![](shots/videos/新建系列_名称没填-1440-light.png) | ![](shots/videos/新建系列_名称没填-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-5.1 | 页面标题 | 展示 | 「系列」，系列个数，说明「多集共用开场、收尾和模板；点系列看各集、改共用部分」 |
| SPEC-videos-5.2 | 待同步提示条 | 展示 | 所有系列加起来有待同步的集时显示「有 N 集改过共用部分还没同步，需要重新录屏渲染」 |
| SPEC-videos-5.3 | 系列卡片 | 展示 | 名称、集数、说明（没写显示「还没写说明」）、「已完成 a / b 集」、「N 集待处理」、「N 集待同步」、阶段分布条（只看不筛） |
| SPEC-videos-5.4 | 系列卡片 | 点击、回车、空格 | 打开系列详情（`SPEC-videos-6`） |
| SPEC-videos-5.5 | 右上「新建系列」 | 点击 | 打开新建系列抽屉：名称（必填）、说明、共用开场、共用收尾、共用模板，底部提示「建好后在系列详情里新建一集，或者把已有的视频加进来」 |
| SPEC-videos-5.6 | 抽屉「创建」 | 点击 | 名称去掉首尾空格后不为空才建；建好后打开它的系列详情 |
| SPEC-videos-5.7 | 抽屉「取消」、Esc、x | 点击 | 关抽屉，不保存 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-5.8 | 没有系列 | 「还没有系列」「把同一主题的几集归成一个系列，共用开场、收尾和模板，批量改版时能看出影响哪几集」 | 「新建系列」 |
| SPEC-videos-5.9 | 系列里还没有集 | 卡片上「还没有归入的集，点开系列新建一集或把视频加进来」 | 点开 |
| SPEC-videos-5.10 | 名称没填就创建 | 名称框标红，底部「名称必填」，抽屉不关 | 填名称 |

### 数据

见 `SPEC-videos-0` 的 `Series`、`Video`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 出去 | 本模块 | 点卡片 | 系列详情 | `SPEC-videos-6` |

## SPEC-videos-6 系列详情和系列设置

一个系列的全部集：顶部是共用部分和待同步的集，下面是和全部视频一样的表，默认按集数排；可以编排集数、把单集加进来、改系列设置。

### 截图

| 状态 | 亮 | 暗 |
|---|---|---|
| 系列详情 | ![](shots/videos/系列详情-1440-light.png) | ![](shots/videos/系列详情-1440-dark.png) |
| 编排集数 | ![](shots/videos/系列详情_编排集数-1440-light.png) | ![](shots/videos/系列详情_编排集数-1440-dark.png) |
| 系列设置，改了共用开场 | ![](shots/videos/系列设置_已改-1440-light.png) | ![](shots/videos/系列设置_已改-1440-dark.png) |
| 保存时的影响范围 | ![](shots/videos/系列设置_影响范围-1440-light.png) | ![](shots/videos/系列设置_影响范围-1440-dark.png) |

手机宽度：系列详情用的是全部视频那张表，窄屏排法同 `SPEC-videos-1` 的手机截图。

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-6.1 | 标题前的「系列」 | 点击 | 回到系列列表 |
| SPEC-videos-6.2 | 右上「新建第 N 集」 | 点击 | N 是现有最大集数加一；新建一集（标题「第 N 集：」）并打开详情，标签栏高亮「系列」 |
| SPEC-videos-6.3 | 共用部分一行 | 展示 | 开场、收尾、模板，没设置的写「未设置」；「修改」打开系列设置 |
| SPEC-videos-6.4 | 待同步区 | 展示 | 「N 集待同步」「共用部分改过，这几集要重新录屏渲染」，每集一行：集数、标题、状态、「标记已同步」「去这一集」；多于 1 集时有「全部标记已同步」 |
| SPEC-videos-6.5 | 「标记已同步」「全部标记已同步」 | 点击 | 从 `Series.stale` 里去掉，行上的「待同步」标签消失 |
| SPEC-videos-6.6 | 阶段分布条、搜索 | 同 `SPEC-videos-1.3`、`1.4` | 搜索提示「搜标题或集数」，没有项目筛选 |
| SPEC-videos-6.7 | 「加入已有视频」 | 选择 | 下拉列出没归入任何系列的视频（标题、当前状态，按更新倒序，可搜索），选一个就排在第 N 集 |
| SPEC-videos-6.8 | 「编排集数 / 完成编排」 | 点击 | 进入编排时先按集数排；每行的集数变成输入框，失焦或回车才改（免得边输边重排），小于 1 的不改；行尾换成「移出」 |
| SPEC-videos-6.9 | 编排时「移出」 | 点击 | 这一集变回单集（清掉系列和集数），同时从待同步里去掉 |
| SPEC-videos-6.10 | 编排时集数重复 | 展示 | 重复的输入框标红，表上方红字「有几集集数重复了，改一下」；不拦截保存 |
| SPEC-videos-6.11 | 右上「系列设置」 | 点击 | 打开系列设置抽屉，和新建系列同样的字段；改过的共用项旁标「已改」，说明「改了任一项，保存时会让你确认这 N 集里哪几集要重新录屏渲染」 |
| SPEC-videos-6.12 | 抽屉「保存」 | 点击 | 名称必填；没改共用部分或系列里没有集时直接保存；改了共用部分且有集时弹出「影响范围」 |
| SPEC-videos-6.13 | 影响范围弹窗 | 展示 / 勾选 | 「改了共用开场、…。下面这些集需要重新录屏渲染，勾上的会标为「待同步」」；列出系列全部集（集数、标题、状态），默认全勾；「全选 / 全不选」 |
| SPEC-videos-6.14 | 弹窗「保存并标记 N 集」/「只保存」 | 点击 | 保存系列；勾上的集加进 `stale`（原来已在里面的不重复），没勾的集如果原来在待同步里会被去掉；一集都没勾时按钮叫「只保存」 |
| SPEC-videos-6.15 | 弹窗「返回修改」、点遮罩、Esc | 点击 | 关弹窗回到抽屉；再按 Esc 关抽屉 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-6.16 | 系列里还没有集 | 「这个系列还没有集」「新建第 1 集，或者用「加入已有视频」把单集归进来」 | 新建、加入 |
| SPEC-videos-6.17 | 没有可加入的单集 | 「加入已有视频」不可点，提示「没有未归入系列的视频」 | 无 |
| SPEC-videos-6.18 | 系列设置名称清空 | 同 `SPEC-videos-5.10` | 填名称 |
| SPEC-videos-6.19 | 系列已删除 | 原型没有删除系列的入口；正式版要补删除，删除时各集变回单集 | |

### 数据

见 `SPEC-videos-0` 的 `Series`、`Video`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 改动 | 本模块 | 加入、移出、改集数 | 视频设置里的系列和集数跟着变 | `SPEC-videos-13.3` |
| 出去 | 本模块 | 点行、「去这一集」 | 视频详情，标签栏高亮「系列」，标题前是系列名 | `SPEC-videos-10` |

## SPEC-videos-7 发布记录

每个平台发了哪个比例、哪张封面，发出去以后的数据。全部记录时按视频分组，从视频详情进来时只看一集并多一块「按平台对比」。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![](shots/videos/标签_发布记录-1440-light.png) | ![](shots/videos/标签_发布记录-1440-dark.png) |
| 手机 375 | ![](shots/videos/标签_发布记录-375-light.png) | ![](shots/videos/标签_发布记录-375-dark.png) |
| 只看一集 | ![](shots/videos/发布记录_只看一集-1440-light.png) | ![](shots/videos/发布记录_只看一集-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-7.1 | 页面标题 | 展示 | 「发布记录」，条数，说明「每个平台发了哪个比例、哪张封面，发出去以后回填播放数据」 |
| SPEC-videos-7.2 | 汇总数字 | 展示 | 已发布、总播放、总点赞、发布失败（大于 0 时红色）；只看一集时只算这一集 |
| SPEC-videos-7.3 | 搜索框 | 输入 | 按发布标题和视频标题过滤（只看一集时只搜发布标题） |
| SPEC-videos-7.4 | 平台、状态筛选 | 点击 | 「全部平台」或五个平台之一、「全部状态」或四个状态之一，后面带条数；再点取消 |
| SPEC-videos-7.5 | 视频分组行 | 展示 / 点击 | 视频标题（点了打开视频详情）、用过的平台、「N 条失败」、条数；组按组里最新一条的时间排，每组先露 3 条，失败的排前面，「查看全部 N 条 / 收起」；一次 30 组，「显示更多视频（还有 N 个）」 |
| SPEC-videos-7.6 | 发布行 | 展示 | 发布标题（没填「未填标题」）和视频标题、平台标签、比例和封面色块（没有写「无封面」）、状态（自动发布进行中显示「发布中…」）、时间（已发布的发布时间、已定时的「定时 MM/DD HH:mm」、失败的红字原因）、播放点赞评论转发（没有数据写「-」） |
| SPEC-videos-7.7 | 发布行 | 点击 | 打开发布记录抽屉（`SPEC-videos-9`） |
| SPEC-videos-7.8 | 右上「新建发布」 | 点击 | 打开新建发布（`SPEC-videos-8`）；只看一集时默认选这一集 |
| SPEC-videos-7.9 | 只看一集：「只看：<标题>」 | 点击标题 / 「清除，看全部」 | 回到这一集的详情 / 去掉过滤看全部 |
| SPEC-videos-7.10 | 只看一集：按平台对比 | 展示 / 切换 | 用过的每个平台一根条，按播放、点赞、评论、转发切换；还没发出去的平台写「还没发出去」 |
| SPEC-videos-7.15 | 「封面 A/B」一节 | 展示 / 点击 | 汇总数字下面（只看一集时在平台对比下面）。说明「每张曝光到 1 万、观察满 7 天、点击率领先 20% 才判胜负」，右上「新建测试」。每个测试一行：各张封面的色块、视频标题、平台、测试方式、张数；进行中的显示三条进度（曝光到 1 万：n / N、观察天数：n / 7、点击率差距：x% / 20%，到线的变绿），已决出的写「封面 n 胜出，N 前结束」，没有结论的写「提前结束，没有判胜负」；状态标签。进行中的排前面。点一行打开封面 A/B 抽屉（`SPEC-videos-14`），会关掉发布抽屉；只看一集时只列这一集的测试，没有时「这一集还没做过封面测试；同一集出了几版封面，可以用 A/B 小号各发一版比点击率」 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-7.11 | 没有发布记录 | 「还没有发布记录」「点右上角「新建发布」，选视频、平台、比例和封面」 | 新建发布 |
| SPEC-videos-7.12 | 筛选后没有 | 「没有匹配的发布记录」 | 改筛选 |
| SPEC-videos-7.13 | 只看的这一集没有记录 | 对比区「这一集还没有发布记录」 | 新建发布 |
| SPEC-videos-7.14 | 发布记录的视频已删除 | 标题显示「已删除的视频」（原型删视频时会把它的发布记录一起删，正常看不到） | 无 |

### 数据

见 `SPEC-videos-0` 的 `Publish`、`Metrics`、`PLATFORMS`、`Artifact`（封面）。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | 本模块 | 视频详情右上「发布记录 N」 | 只看这一集 | `SPEC-videos-10.12` |
| 出去 | 今日 | 发布失败、待发布 | 原型未做；正式版今日卡片（VID-07） | `SPEC-today-1.4` |

## SPEC-videos-8 新建发布

发布弹窗（右侧抽屉）。选视频、平台、比例、封面，写标题简介，选立即还是定时。能不能自动发由平台的接入情况决定：接通了上传接口的才自动发，其余只登记一条「计划中」，发完回来填链接。

### 截图

| 状态 | 亮 | 暗 |
|---|---|---|
| 已接入（B 站） | ![](shots/videos/新建发布_已接入-1440-light.png) | ![](shots/videos/新建发布_已接入-1440-dark.png) |
| 不开放发布接口（视频号） | ![](shots/videos/新建发布_不开放发布接口-1440-light.png) | ![](shots/videos/新建发布_不开放发布接口-1440-dark.png) |
| 标题超长（小红书），不能提交 | ![](shots/videos/新建发布_标题超长-1440-light.png) | ![](shots/videos/新建发布_标题超长-1440-dark.png) |
| 连接异常（抖音） | ![](shots/videos/新建发布_连接异常-1440-light.png) | ![](shots/videos/新建发布_连接异常-1440-dark.png) |
| 未接入（小红书） | ![](shots/videos/新建发布_未接入-1440-light.png) | ![](shots/videos/新建发布_未接入-1440-dark.png) |
| 标题没填 | ![](shots/videos/新建发布_标题没填-1440-light.png) | ![](shots/videos/新建发布_标题没填-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-8.1 | 视频（必填） | 选择 | 下拉可搜标题、目录，按更新倒序，每项带当前状态；下面一行「出了横屏、竖屏，现在在「<状态>」」。换视频时标题如果没改过就跟着换，比例重选，封面清空 |
| SPEC-videos-8.2 | 平台 | 点击 | 五个平台单选，每个标「偏好<比例>」；换平台时比例按平台推荐重选（这集有推荐比例就用它，没有用这集的第一个比例），封面清空 |
| SPEC-videos-8.3 | 画面比例 | 点击 | 三个比例，这集没做的不可点（提示「这集没做这个比例」），平台推荐的标「推荐」；换比例时封面清空 |
| SPEC-videos-8.4 | 推荐比例提示 | 展示 | 这集没出平台推荐的比例时：「这集没出竖屏版，抖音建议竖屏」 |
| SPEC-videos-8.5 | 平台接入提示 | 展示 | 平台不是 `ok` 时在比例下面显示，见 `SPEC-videos-8.6` 到 `8.9` |
| SPEC-videos-8.6 | 已接入（`ok`） | 展示 | 没有提示；底部按钮是「立即发布」或「定时发布」 |
| SPEC-videos-8.7 | 不开放发布接口（`manual`，视频号、小红书接了数据连接器） | 展示 | 「<平台>不开放发布接口，请在 App 或创作者中心发布后回来填链接；数据会自动拉取。」没有跳转；底部按钮「登记发布记录」 |
| SPEC-videos-8.8 | 连接异常（`error`） | 展示 / 点「去修复」 | 「<连接器名>连接异常：<原因>。修好之前只能登记。」；「去修复」跳设置 / 连接器 / 内容平台并打开这个连接器的抽屉；底部按钮「登记发布记录」 |
| SPEC-videos-8.9 | 未接入（`none`） | 展示 / 点「去接入」 | 「还没接入<平台>，只能登记发布记录，不能自动上传和拉数据。」；「去接入」跳设置 / 连接器 / 内容平台并打开这个平台的新建抽屉；底部按钮「登记发布记录」 |
| SPEC-videos-8.10 | 封面 | 点击 | 列出这集这个方向下、比例在平台 `cover` 里的封面产出物，推荐的比例排前面（色块按封面比例画，下面「<比例> · 版本 n」，已发布过的写「<比例> · 用过」），单选，再点取消；不选也能发。说明写「<平台>收 <比例>、<比例> 的封面；这集<方向>有 N 张」。例：第 1 集选抖音只列 3:4 和 9:16，选 B 站只列 16:9（还有 4:3 但这集没出） |
| SPEC-videos-8.11 | 标题（必填） | 输入 | 默认是视频标题 |
| SPEC-videos-8.12 | 「从简介产出物带入」 | 点击 | 取这集版本最高的简介产出物，把「<视频标题> + 取自简介产出物 <路径>，第 n 版，已定稿 / 还没定稿」填进简介（原型用占位文字代表文件内容） |
| SPEC-videos-8.13 | 简介 | 输入 | 可空 |
| SPEC-videos-8.14 | 「立即发布 / 定时发布」 | 点击 | 选定时多出日期时间输入，默认明天 10:00 |
| SPEC-videos-8.15 | 底部主按钮 | 点击 | 先校验（`SPEC-videos-8.17` 到 `8.19`，只显示第一条错误）。通过后新建记录放在最前、抽屉换成这条记录的抽屉：已接入且立即发布，状态「计划中」并开始自动发布（原型约 1.2 秒后变「已发布」、生成链接、数据清零）；已接入且定时，状态「已定时」；不能自动发的不管选立即还是定时都是「计划中」，定时的时间照样记下 |
| SPEC-videos-8.16 | 「取消」、Esc、x | 点击 | 关抽屉，不保存 |
| SPEC-videos-8.24 | 账号 | 点击 | 在平台下面。列出这个平台的账号（`seedAccounts`），每个标角色（主号 / A/B 小号 / 客户号），单选，默认主号；换平台时回到新平台的主号。说明「封面 A/B 用小号各发一版」。没有账号的平台：「还没有<平台>账号，这条记录先不挂账号；接入连接器后账号会出现在这里」 |
| SPEC-videos-8.25 | 标题字数 | 输入 | 标题标签后显示「n / 上限 字」，超过上限时这行变红、输入框标红 |
| SPEC-videos-8.26 | 标签 | 输入 | 逗号、顿号、空格或 # 分开，去重；超过平台上限时输入框标红 |
| SPEC-videos-8.27 | 分区、合集 | 选择 / 输入 | 平台有分区（B 站、YouTube）才出分区下拉，「不选」可空；换平台时清空。合集可空 |
| SPEC-videos-8.28 | 发布前校验 | 展示 | 按 `checkPublish` 一项一行，「通过 / 不通过」加说明（如「标题超长：小红书最多 20 字，现在 27 字」「简介带外链：B 站不允许放链接」）；边改边算 |
| SPEC-videos-8.29 | 校验不过 | 自动 | 有一项不通过时底部主按钮不可点（悬停提示第一条不通过的原因），底部红字显示第一条错误，不用先点提交；全部通过才能发布或登记。建好的记录把这次的校验结果存进 `checks` |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-8.17 | 没选视频 | 底部红字「先选一个视频」 | 选视频 |
| SPEC-videos-8.18 | 标题为空 | 标题框标红，底部红字「标题必填」 | 填标题 |
| SPEC-videos-8.19 | 定时时间无效或不晚于现在 | 「选一个定时时间」/「定时时间要晚于现在」 | 改时间 |
| SPEC-videos-8.20 | 一个视频都没有 | 视频下拉写「还没有视频」且不可点，底部主按钮不可点 | 先去新建视频 |
| SPEC-videos-8.21 | 这个方向没有平台收的封面 | 「这集还没有 <比例>、<比例> 的<方向>封面，先在分发包阶段出封面；不选也能发」 | 不选封面 |
| SPEC-videos-8.22 | 没有简介产出物时点带入 | 简介下面提示「这集还没有简介产出物，先在分发包阶段出简介，或者直接手写」 | 手写 |
| SPEC-videos-8.23 | 平台未连接、连接异常 | 见 `SPEC-videos-8.8`、`8.9`；只能登记 | 去接入、去修复 |

### 数据

写入一条 `Publish`（见 `SPEC-videos-0`）。`id` 用 `newId('pb')`，`cover_id` 是选的封面，`title`、`desc` 去掉首尾空格，`scheduled_at` 只在选定时时有；`account_id` 是选的账号，`tags` 没填不写，`category`、`collection` 空的不写，`checks` 是提交时的校验结果。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | 设置（连接器） | 平台接入情况 | 决定提示和按钮 | `SPEC-settings-5` |
| 出去 | 设置（连接器） | 「去接入」「去修复」 | 连接器列表筛到内容平台，打开抽屉 | `SPEC-settings-3.3`、`SPEC-settings-5` |
| 进来 | 本模块 | 封面、简介产出物 | 列出可选封面、带入简介 | `SPEC-videos-11` |

## SPEC-videos-9 发布记录抽屉

一条发布记录：状态、去向、简介、数据。失败的能重试，计划中和已定时的能改为立即发布，已发布的能回填或拉取数据、打开链接。

### 截图

| 状态 | 亮 | 暗 |
|---|---|---|
| 发布失败 | ![](shots/videos/发布抽屉_发布失败-1440-light.png) | ![](shots/videos/发布抽屉_发布失败-1440-dark.png) |
| 已发布 | ![](shots/videos/发布抽屉_已发布-1440-light.png) | ![](shots/videos/发布抽屉_已发布-1440-dark.png) |
| 回填数据，格式不对 | ![](shots/videos/发布抽屉_回填数据格式不对-1440-light.png) | ![](shots/videos/发布抽屉_回填数据格式不对-1440-dark.png) |
| 计划中（视频号登记后） | ![](shots/videos/发布抽屉_计划中-1440-light.png) | ![](shots/videos/发布抽屉_计划中-1440-dark.png) |
| 抖音被打回，换成 3:4 封面 | ![](shots/videos/发布抽屉_换封面-1440-light.png) | ![](shots/videos/发布抽屉_换封面-1440-dark.png) |
| 换封面后重试成功 | ![](shots/videos/发布抽屉_换封面重试成功-1440-light.png) | ![](shots/videos/发布抽屉_换封面重试成功-1440-dark.png) |
| 按天曲线（B 站，第 6 天） | ![](shots/videos/发布抽屉_按天曲线-1440-light.png) | ![](shots/videos/发布抽屉_按天曲线-1440-dark.png) |
| 回填后多一条快照 | ![](shots/videos/发布抽屉_回填存快照-1440-light.png) | ![](shots/videos/发布抽屉_回填存快照-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-9.1 | 抽屉头 | 展示 | 发布标题、平台标签、状态（发布中显示「发布中…」） |
| SPEC-videos-9.2 | 属性 | 展示 | 视频（链接，点了打开视频详情）、平台（偏好比例）、比例（和平台推荐不一致时提示「平台建议<比例>」）、封面（按封面比例画的色块和路径，没选写「没有选封面」；比例不在平台收的范围里时提示「<平台>不收 <比例>」）、定时时间、发布时间（带相对时间）、链接（没有时：已发布写「没有记链接」，其余「发布后生成」） |
| SPEC-videos-9.3 | 简介 | 展示 | 没填写「没有填简介」 |
| SPEC-videos-9.4 | 失败提示条和「重试」 | 点击 | 「发布失败 <原因>」（没有原因写「平台没有返回原因」）；重试把状态改回计划中、清掉原因和定时时间并重新自动发布；发布中按钮不可点。底部也有同样的「重试」 |
| SPEC-videos-9.5 | 「改为立即发布」 | 点击 | 计划中（且不在发布中）、已定时的记录才有；清掉定时时间，开始自动发布 |
| SPEC-videos-9.6 | 不能自动发的平台（视频号、小红书、未接入或异常） | 应该是 | 原型问题 1：原型照样给「改为立即发布」并模拟发布成功。规格：这类记录不出「改为立即发布」，换成「填链接，标为已发布」：输入平台链接，保存后状态已发布、`published_at` 记当时；已接入的平台到定时时间自动发布由 VID-06 做 |
| SPEC-videos-9.7 | 数据区 | 展示 | 只在已发布时出现：「N 前更新」或「还没回填」，四格播放、点赞、评论、转发 |
| SPEC-videos-9.8 | 「回填数据」 | 点击 | 四个必填格加七个扩展格，预填现有数字；「保存」存一条快照并更新最新数据，「取消」放弃；校验见 `SPEC-videos-9.21` |
| SPEC-videos-9.9 | 「打开链接」 | 点击 | 已发布才有，没有链接时不可点（提示「没有记链接」）；在内置浏览器打开 |
| SPEC-videos-9.10 | 「模拟拉取数据」 | 点击 | 原型在现有数字上随机涨一点，并存一条快照（`SPEC-videos-9.22`）。正式版换成「拉取数据」，从平台连接器拉（VID-04、VID-05），平台没接入或账号是手动登记的不显示 |
| SPEC-videos-9.11 | 「删除」 | 点击 | 换成确认条「只删这条记录，平台上已发的内容不受影响」「取消」「删除」 |
| SPEC-videos-9.12 | Esc、x | 点击 | 关抽屉 |
| SPEC-videos-9.17 | 「换封面」 | 点击 | 失败、计划中、已定时且不在发布中时出现；说明「<平台>收 <比例>、<比例>，推荐 <比例>」；列出同一集同一方向、平台收的封面（推荐的比例排前面，色块下「<比例> · 版本 n」），点了直接改这条记录的 `cover_id`，再点取消；一张都没有时「这集还没有 <比例>、<比例> 的<方向>封面，去视频的产出物里登记一张」 |
| SPEC-videos-9.18 | 封面比例把关 | 自动 | 自动发布（新建立即发布、重试、改为立即发布）时，选了封面且比例不在平台 `cover` 里就失败，原因「封面比例不符合要求：<平台>要 <比例> 或 <比例>，这次用的是 <比例>」；没选封面不拦。演示：第 1 集抖音那条用了 1:1 封面被打回，换成 3:4 后重试成功 |
| SPEC-videos-9.19 | 属性：账号、A/B、标签、分区、合集、校验 | 展示 | 账号（昵称加角色；手动登记的账号加「手动登记，数据要回填」，没挂写「没挂账号」）；在封面测试里的显示「封面 A/B」一行，点了打开测试（「在测试里，进行中」「测试胜出的一版」「测试里输掉的一版」「测试已结束，没有结论」）；有才显示标签、分区、合集；有校验结果时「发布前校验：N 项全部通过」，有不通过的红字列出 |
| SPEC-videos-9.20 | 数据区扩展指标 | 展示 | 四格之后接着显示平台给了的扩展指标：曝光、点击率、平均观看（「n 分 n 秒」）、完播率、收藏、投币、涨粉；没给的不显示。标题后写「N 前更新，发布后第 n 天」 |
| SPEC-videos-9.21 | 回填存快照 | 点击「回填数据」/「保存」 | 表单上方提示「记为发布后第 n 天，存一条新快照，之前的快照不覆盖」；四格必填非负整数，扩展七格可空（百分比填 0 到 100，平均观看填秒，其余整数），预填现有数字；保存后新存一条 `source: manual` 的快照，`metrics` 换成这次填的。格式不对的格子标红，提示「播放、点赞、评论、转发只能填非负整数；百分比填 0 到 100；平台不给的留空」，保存不可点 |
| SPEC-videos-9.22 | 「模拟拉取数据」 | 点击 | 在现有数字上随机涨一点（曝光涨、点击率小幅抖动、播放按曝光乘点击率不回落），存一条 `source: connector` 的快照 |
| SPEC-videos-9.23 | 按天曲线 | 展示 / 切换 | 已发布且不在回填时出现。标题后「N 条快照，最新是第 n 天；同一天取最后一条」。可切播放、曝光、点击率、完播率（只列有数据的）。横轴按对数排，标出 D1、D3、D7、D30（还没到的那几天刻度变淡），超过 30 天的点排在最右；最后一个点上标数值。下面一张表：行是可切的几个指标，列是 D1、D3、D7、D30 和「最新」，那天没有快照写「-」，还没到写「未到」 |
| SPEC-videos-9.24 | 「看全部 N 条快照」 | 点击 | 展开快照历史，新的在上：第几天、手动回填 / 连接器拉取、播放、点击率、时间；再点「收起快照」 |
| SPEC-videos-9.25 | 没有快照 | 展示 | 「拉取或回填一次就有第一条快照；之后每次都存一条，不覆盖」 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-9.13 | 发布失败 | 红色提示条带原因，列表行上红字原因，汇总「发布失败」红色 | 重试 |
| SPEC-videos-9.14 | 视频已删除 | 视频一栏「已删除的视频」 | 删除记录 |
| SPEC-videos-9.15 | 回填格式不对 | 见 `SPEC-videos-9.8` | 改正 |
| SPEC-videos-9.16 | 拉取时连接器异常 | 原型未做；正式版提示连接器异常并给「去修复」，同 `SPEC-videos-8.8` | 去修复 |

### 数据

见 `SPEC-videos-0` 的 `Publish`、`Metrics`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 出去 | 浏览器 | 打开链接 | 内置浏览器新标签 | `SPEC-browser-3` |
| 进来 | 设置（连接器） | 拉取数据 | 正式版读平台连接器 | `SPEC-settings-5` |

## SPEC-videos-10 视频详情：制作流程

一集视频的详情页，三个标签：制作流程、产出物（带条数）、设置。制作流程是 9 个阶段的竖向时间线（第一步「选题」、第二步「内容编写」的编辑区是 VID-09p 加的）：做完的打勾，当前的高亮，检查点带标签；停在检查点上等我处理时标签上有红点。

### 截图

| 状态 | 亮 | 暗 |
|---|---|---|
| 桌面 1440，停在第一章验收 | ![](shots/videos/视频详情_制作流程-1440-light.png) | ![](shots/videos/视频详情_制作流程-1440-dark.png) |
| 手机 375 | ![](shots/videos/视频详情_制作流程-375-light.png) | ![](shots/videos/视频详情_制作流程-375-dark.png) |
| 退回要写意见（1440） | ![](shots/videos/视频详情_退回检查点-1440-light.png) | ![](shots/videos/视频详情_退回检查点-1440-dark.png) |
| 退回要写意见（375） | ![](shots/videos/视频详情_退回检查点-375-light.png) | ![](shots/videos/视频详情_退回检查点-375-dark.png) |
| 被退回待修改 | ![](shots/videos/视频详情_已退回-1440-light.png) | ![](shots/videos/视频详情_已退回-1440-dark.png) |
| 非检查点阶段 | ![](shots/videos/视频详情_非检查点阶段-1440-light.png) | ![](shots/videos/视频详情_非检查点阶段-1440-dark.png) |
| 规划检查没选比例 | ![](shots/videos/视频详情_规划检查没选比例-1440-light.png) | ![](shots/videos/视频详情_规划检查没选比例-1440-dark.png) |
| 已完成 | ![](shots/videos/视频详情_已完成-1440-light.png) | ![](shots/videos/视频详情_已完成-1440-dark.png) |
| 规划检查通过后，网页开发配好执行器 | ![](shots/videos/视频详情_执行器-1440-light.png) | ![](shots/videos/视频详情_执行器-1440-dark.png) |
| 执行器运行中 | ![](shots/videos/视频详情_执行器运行中-1440-light.png) | ![](shots/videos/视频详情_执行器运行中-1440-dark.png) |
| 跑完，产出物进待验收 | ![](shots/videos/视频详情_执行器跑完-1440-light.png) | ![](shots/videos/视频详情_执行器跑完-1440-dark.png) |
| 执行器跑失败 | ![](shots/videos/视频详情_执行器失败-1440-light.png) | ![](shots/videos/视频详情_执行器失败-1440-dark.png) |
| 配执行器 | ![](shots/videos/视频详情_配执行器-1440-light.png) | ![](shots/videos/视频详情_配执行器-1440-dark.png) |
| 新建视频，停在选题（1440） | ![](shots/videos/视频详情_选题-1440-light.png) | ![](shots/videos/视频详情_选题-1440-dark.png) |
| 新建视频，停在选题（375） | ![](shots/videos/视频详情_选题-375-light.png) | ![](shots/videos/视频详情_选题-375-dark.png) |
| 从选题库选一个 | ![](shots/videos/视频详情_挑选题-1440-light.png) | ![](shots/videos/视频详情_挑选题-1440-dark.png) |
| 选好选题 | ![](shots/videos/视频详情_已选题-1440-light.png) | ![](shots/videos/视频详情_已选题-1440-dark.png) |
| 内容编写：写口播稿，草稿自动保存（1440） | ![](shots/videos/视频详情_内容编写-1440-light.png) | ![](shots/videos/视频详情_内容编写-1440-dark.png) |
| 内容编写（375） | ![](shots/videos/视频详情_内容编写-375-light.png) | ![](shots/videos/视频详情_内容编写-375-dark.png) |
| 按选题大纲起草，对比初稿 | ![](shots/videos/视频详情_起草对比-1440-light.png) | ![](shots/videos/视频详情_起草对比-1440-dark.png) |
| 采用初稿、交给验收 | ![](shots/videos/视频详情_采用并交验收-1440-light.png) | ![](shots/videos/视频详情_采用并交验收-1440-dark.png) |
| 原文链接格式不对 | ![](shots/videos/视频详情_原文链接不对-1440-light.png) | ![](shots/videos/视频详情_原文链接不对-1440-dark.png) |
| 从链接导入原文 | ![](shots/videos/视频详情_原文导入-1440-light.png) | ![](shots/videos/视频详情_原文导入-1440-dark.png) |
| 规划检查看到的文稿版本 | ![](shots/videos/视频详情_规划检查文稿-1440-light.png) | ![](shots/videos/视频详情_规划检查文稿-1440-dark.png) |
| 起草失败（选题没写大纲） | ![](shots/videos/视频详情_起草失败-1440-light.png) | ![](shots/videos/视频详情_起草失败-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-10.1 | 顶栏 | 展示 | 标题（没有写「未命名视频」），前面是系列名（点了进系列详情）或「视频」；说明是「系列 · 第 N 集」或「单集」、项目名、比例（没定写「比例未定」）、状态，用「 · 」连 |
| SPEC-videos-10.2 | 阶段 | 展示 | 序号圆点（做完的打勾）、阶段名、「检查点」标签、「当前」标签、阶段说明；这一阶段的产出物一行一个（类型、名称、比例、版本、状态，演示工程、成片、封面有「预览」）；点产出物打开产出物抽屉 |
| SPEC-videos-10.3 | 检查点结果 | 展示 | 右侧「已通过 · N 前」「已跳过，不合成音频 · N 前」「已退回 · N 前」；通过或跳过时有意见的显示「意见：…」 |
| SPEC-videos-10.4 | 规划检查：画面比例 | 点击 | 没锁定时三个比例可多选（「可多选，每个比例是一个独立的演示工程」），选中的按横、竖、方的顺序存；规划检查通过后锁定，只显示选中的、不可点，下面「比例定了不能改，要换比例得新开工程」 |
| SPEC-videos-10.5 | 第一章验收：要验收的演示工程 | 展示 | 当前在第一章验收或已有演示工程时显示，按比例列出演示工程；一个都没有时「还没登记演示工程。去登记」，点了切到产出物标签并打开登记表单 |
| SPEC-videos-10.6 | 当前检查点「通过」 | 点击 | 记 `passed` 和时间，进入下一阶段；分发包通过后停在分发包、状态变「已完成」。被退回过的按钮叫「改好了，通过」。规划检查没选比例时不可点（提示「先选至少一个画面比例」），旁边提示「通过后比例锁定」 |
| SPEC-videos-10.7 | 当前检查点「退回」 | 点击 | 展开意见输入框（「哪里不行、要怎么改」）、「确认退回」「取消」；没写意见时「确认退回」不可点，旁边「退回要写意见」。确认后记 `rejected`、意见和时间，阶段不动，状态变「退回修改」。被退回过的按钮叫「再次退回」 |
| SPEC-videos-10.8 | 被退回的检查点 | 展示 | 框里先显示「退回意见：<意见>」（没写显示「没写意见」），再是「改好了，通过」「再次退回」 |
| SPEC-videos-10.9 | 音频合成「跳过（不合成音频）」 | 点击 | 只在音频合成检查点有；记 `skipped` 和时间，进入「录屏渲染」，音频合成显示「已跳过，不合成音频」 |
| SPEC-videos-10.10 | 非检查点阶段「这一步做完了，进入「<下一阶段>」」 | 点击 | 当前阶段不是检查点时出现（选题一步换成「确认选题」，见 `10.30`），进入下一阶段；这一步还没登记产出物时上面提示「这一步还没登记产出物。登记一个」（内容编写有编辑区，不提示） |
| SPEC-videos-10.11 | 右上「查看系列」 | 点击 | 只在制作流程标签、属于系列时出现，打开系列详情 |
| SPEC-videos-10.12 | 右上「发布记录 N」 | 点击 | 这集有发布记录时出现，切到发布记录并只看这一集（`SPEC-videos-7.9`） |
| SPEC-videos-10.13 | 标签「制作流程 / 产出物 / 设置」 | 点击 | 切标签；产出物后面是条数，制作流程在等我处理时有红点 |
| SPEC-videos-10.19 | 执行器框 | 展示 | 能配执行器的阶段：有产出物类型的阶段（内容编写、网页开发、音频合成、录屏渲染、分发包）加「其余章节」；规划检查、第一章验收只有人能做。已完成的集不显示。配了的阶段显示类型标签（技能 / SOP / Agent）、名称（找不到写「已删除的<类型>」）、交代的话；没配的只在当前阶段显示「没配执行器，产出物手动登记」和「配执行器」；内容编写写的是「没配执行器，按选题大纲起草时用技能「网页演示做视频」」 |
| SPEC-videos-10.20 | 「配执行器」「修改」 | 点击 | 展开编辑：交给谁跑（技能 / SOP / Agent 三选一，切类型时默认选该类第一个）、下拉选具体哪个（技能来自技能列表，SOP 来自流程库，Agent 来自 Agent 列表）、交代给它的话（可不填）；「保存」写进 `runners`（同阶段替换）、「取消」、已配过的还有「不用执行器」（删掉这条）。「配执行器」默认技能「网页演示做视频」 |
| SPEC-videos-10.21 | 「运行」 | 点击 | 只在当前阶段出现，内容编写没有（它的执行器由编辑区的「按选题大纲起草」调用，见 `10.37`）；记一条 `last_run`（`running`），按钮变「运行中…」，下面「正在跑，开始于 N 前；跑完产出物会进「待验收」」；整集同时只跑一个，别的阶段的「运行」不可点（提示「另一个阶段正在跑，等它跑完」），运行中不能修改 |
| SPEC-videos-10.22 | 跑完 | 自动 | 原型约 1.8 秒后按阶段登记产出物：网页开发出演示工程（第 1 章）、其余章节给演示工程升版、音频合成出口播音频、录屏渲染出成片和字幕、分发包出简介和章节时间轴；按比例区分的每个比例一份。同类型同比例已有的升一个版本，没有的新建；都改成「待验收」，来源记成执行器（类型和名称）。`last_run` 变 `done`，显示「N 前跑完，登记了 N 个产出物，待验收」；检查点阶段后面加「；检查点还要你来确认」。不自动往下走，阶段推进和检查点仍由人操作 |
| SPEC-videos-10.23 | 跑失败 | 展示 / 点击 | 框变成实线边，显示「运行失败：<原因> · N 前」，按钮叫「重试」。原型能预判的失败：执行器找不到（「找不到<类型>「<id>」，可能已经删掉了，换一个再跑」）、要按比例出的阶段还没定比例；演示：AI 系列第 27 集网页开发因预览端口被占失败，重试成功 |
| SPEC-videos-10.24 | 跑的时候离开详情页 | 自动 | 照常跑完，结果按跑完那一刻的视频和产出物写入 |
| SPEC-videos-10.25 | 演示数据 | 展示 | AI 系列没做完的集（第 19 集以后）内容编写、网页开发、其余章节、录屏渲染都配了技能「网页演示做视频」；一人之下第 3 集内容编写配了 SOP「视频周更」。验收路径：待我处理里打开第 28 集，规划检查通过，网页开发点「运行」，演示工程进待验收 |

| SPEC-videos-10.26 | 选题一步：已挂选题 | 展示 / 点击 | 框里是选题标题（点了打开选题抽屉，同 `SPEC-videos-3`，抽屉底部是「打开视频：<本集标题>」，点了只关抽屉）、优先级分、状态；角度、受众（没写的显示「还没写」）、打分「需求 N · 契合 N · 成本 N」、大纲（一条一行，去掉序号；没写显示「还没写大纲，按大纲起草要先补上。去补」，点了打开抽屉）。在抽屉里删掉选题时本集的 `topic_id` 一起清掉 |
| SPEC-videos-10.27 | 选题一步：「从选题库选一个」 | 点击 / 选择 | 没挂选题时出现。下拉列出还没立项的选题（不含已做成、已放弃，按优先级排，每项带状态和优先级分），能搜标题、角度、标签。选定后：选题记下 `video_id`、状态改「已做成」；本集记下 `topic_id`；标题还是默认的（空、「新视频」、「第 N 集：」）就换成选题标题（系列里是「第 N 集：<选题标题>」）；比例没锁定且选题选了平台时，按平台的推荐比例去重（同 `3.15`） |
| SPEC-videos-10.28 | 选题一步：「新建选题」 | 点击 | 新建一个选题：标题取本集标题去掉「第 N 集：」（「新视频」算空），系列同本集，三项打分 3，状态直接「已做成」并记下 `video_id`，放在选题列表最前面；本集记下 `topic_id`，打开选题抽屉接着写角度、大纲 |
| SPEC-videos-10.29 | 选题一步：「换一个」 | 选择 | 挂了选题时右上角的下拉，选项同 `10.27`；换上新的（同 `10.27` 的写法），换下来的选题清掉 `video_id`、状态回到「可开拍」。已经过了选题一步的集也能换 |
| SPEC-videos-10.30 | 选题一步「确认选题，进入「内容编写」」 | 点击 | 选题一步是当前阶段时出现；没挂选题时不可点，旁边「先选一个选题或新建一个」。点了进入内容编写 |
| SPEC-videos-10.31 | 内容编写：编辑区 | 展示 | 当前阶段是内容编写时直接展开；已经过了（或还没到）的集显示「打开编辑区改文稿」，点开后右上多一个「收起」。顶上一行说明（挂了选题：「可以照选题「<标题>」的角度和大纲起草，也可以直接写」；没挂：「先在「选题」一步挂上选题，才能按大纲起草；也可以直接写」）和「按选题大纲起草」。下面一栏一个编辑器：本集每个比例一栏口播稿（「横屏口播稿」「竖屏口播稿」「方形口播稿」，还没定比例按横屏一栏），最后一栏大纲（多个比例时栏头有比例切换，各比例的大纲分开存）；宽屏并排，窄屏上下排 |
| SPEC-videos-10.32 | 编辑器栏头 | 展示 / 点击 | 左边栏名；右边当前版本「vN」和状态，点了打开那个产出物的抽屉（`SPEC-videos-12`）；还没存过的写「还没保存过」 |
| SPEC-videos-10.33 | 编辑器 | 输入 | Markdown 纯文本，等宽字体。显示的是草稿（有的话）或当前版本的正文；当前版本的正文原型里没有（执行器或手动登记的文件）时为空，占位写「vN 的正文在 <目录>/<路径>，原型里看不到；在这里写，保存后存成 vN+1」。一改就自动存成草稿（`ScriptText.draft = 'mine'`），栏底「草稿已自动保存 · 刚刚」变成强调色；改回和已保存的一样，草稿就删掉 |
| SPEC-videos-10.34 | 编辑器栏底：字数和时长 | 展示 | 「N 字」（`textStats`）；口播稿加「约 N 秒」或「约 N 分 NN 秒」（按每分钟 240 字估，悬停有说明）；大纲加「N 节」（一到三级标题的个数）；没有草稿时显示「vN 已保存 · N 前」 |
| SPEC-videos-10.35 | 「保存为 vN」 | 点击 | 有草稿且不为空才能点。存成这一类（按比例）产出物的下一版：已有产出物的版本号加一、状态回到草稿、来源「手动 · 手写」、登记时间改成现在；还没有的新建一条（v1，名称和路径同登记表单的默认，如 `script-portrait.md`）。正文存一条 `ScriptText`（带 `version`），草稿删掉 |
| SPEC-videos-10.36 | 「交给验收」 | 点击 | 把当前版本的状态改成待验收。有草稿时按钮叫「保存并交验收」，先存成下一版（同 `10.35`）再标待验收；已在待验收、已定稿的显示「已在待验收」「已定稿」不可点；还没保存过且没草稿的不可点（「先保存成版本」）。验收本身在产出物抽屉里做（`SPEC-videos-12`） |
| SPEC-videos-10.37 | 「按选题大纲起草」 | 点击 | 交给内容编写配的执行器（没配就用技能「网页演示做视频」，悬停显示交给谁）跑 Phase 1：记一条 `last_run`（`stage: 'script'`，`running`），按钮变「起草中…」，编辑区上方「正在起草，开始于 N 前；跑完出初稿，对比后再决定用不用」。整集同时只跑一个，别的阶段在跑时不可点。原型约 1.8 秒后按 `draftFromTopic` 给每个比例各出一份口播稿和大纲的初稿（`draft = 'proposal'`，来源记成执行器），不改产出物；`last_run` 变 `done`、`artifact_ids` 为空。再起草会替换掉还没处理的初稿，按钮叫「重新起草」 |
| SPEC-videos-10.38 | 初稿对比 | 展示 / 点击 | 编辑区上方一块「初稿 N 份」「<来源> · N 前起草；采用的存成新版本」和「全部采用」「全部丢弃」；每份一行栏名和「采用」「丢弃」，下面左右两栏：左边现在的（「现在（vN）」「现在（没保存的草稿）」「现在（还没写）」，空的写「空」），右边初稿和字数。左边是没保存的草稿时提示「采用后，没保存的改动会被初稿替换」 |
| SPEC-videos-10.39 | 「采用」「丢弃」 | 点击 | 采用：初稿存成这一类的下一版（同 `10.35`，状态草稿，来源记成起草的执行器），草稿和这份初稿删掉；丢弃：只删这份初稿 |
| SPEC-videos-10.40 | 原文 | 点击 / 输入 | 编辑区下面一行「原文 可选；有原文的按原文改写，口播稿和大纲各自存」，已有原文（存过或写过）时默认展开，有版本时后面带「vN」。展开后一个链接框（「https://… 从链接导入正文」）加「导入」、选题关联的素材里有链接的列成小标签（点了把链接填进框里），下面是原文的编辑器（同 `10.32` 到 `10.36`，没有时长） |
| SPEC-videos-10.41 | 「导入」 | 点击 / 回车 | 链接要 `http://` 或 `https://` 开头，不对时框变红，下面「链接格式不对，要 http:// 或 https:// 开头」。对的话按钮变「导入中…」，原型约 0.9 秒后把「> 来源：<链接>」和一段模拟正文写进原文的草稿（替换编辑器里现有的），链接框清空；正式版用内置浏览器抓正文 |
| SPEC-videos-10.42 | 规划检查：要对齐的文稿 | 展示 / 点击 | 规划检查一步顶上列出内容编写里保存的版本：原文、每个比例的口播稿和大纲各自最新的一版（类型、名称、比例、版本、状态，点了打开产出物抽屉）；一个都没有时「还没有文稿。去内容编写」（点了展开编辑区）。下面逐条提醒：「<比例>还没有口播稿」「<比例><类型> vN 还是草稿，没交验收」「内容编写里还有没保存的草稿，这里看到的是已保存的版本」。只提醒，不拦「通过」 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-10.43 | 没挂选题 | 选题一步「这一集还没挂选题：讲什么、讲给谁、从哪个角度讲，先在选题里想清楚」；`topic_id` 指向的选题已删掉时「原来的选题已经删掉了，重新挑一个」；选题库里没有还没立项的选题时「从选题库选一个」不可点（「选题库里没有还没立项的选题」）；「按选题大纲起草」不可点（「先选好选题」） | 「从选题库选一个」「新建选题」；直接写 |
| SPEC-videos-10.44 | 起草失败 | 编辑区上方「起草失败：<原因> · N 前」，按钮叫「重试起草」。原型能预判的失败：选题没写大纲（「选题「<标题>」还没写大纲，Phase 1 要照大纲起草；先在选题里补上大纲再重试」）、执行器找不到、还没定比例、跑的时候选题被换掉或删掉。演示：把选题换成「一个人怎么管 30 集的系列」（没写大纲）再起草 | 补大纲、换执行器后重试 |
| SPEC-videos-10.45 | 稿子为空 | 「交给验收」不可点（悬停「稿子是空的，不能交验收」），栏底「稿子是空的，写了才能交验收」；「保存为 vN」在空稿时也不可点 | 写稿 |
| SPEC-videos-10.14 | 视频已删除（打开的链接失效） | 「这个视频已经删除」 | 切别的标签 |
| SPEC-videos-10.15 | 规划检查没选比例 | 「通过」不可点，提示「先选至少一个画面比例」 | 选比例 |
| SPEC-videos-10.16 | 退回没写意见 | 「确认退回」不可点，「退回要写意见」 | 写意见 |
| SPEC-videos-10.17 | 当前阶段没登记产出物 | 「这一步还没登记产出物。登记一个」；第一章验收没有演示工程时「还没登记演示工程。去登记」 | 去登记 |
| SPEC-videos-10.18 | 一键跑某个阶段 | 原型已补（`SPEC-videos-10.19` 到 `10.25`）。原型只模拟：不真的发起 Agent 运行或 SOP 执行，`last_run.id` 只是生成的编号；正式版执行记录进会话的「运行」或 SOP 执行记录，产出回写 `Artifact`（VID-03a 到 VID-03d） | |

### 数据

见 `SPEC-videos-0` 的 `Video`、`STAGES`、`Checkpoint`、`Artifact`、`ScriptText`、`StageRunner`、`LastRun`。检查点决定写 `Checkpoint { stage, state, at: 现在, note }`，没有这条检查点记录时追加。执行器写 `Video.runners`、`Video.last_run`，产出物写法见 `SPEC-videos-10.22`。选题一步写 `Video.topic_id` 和选题的 `video_id`、`status`（`10.27` 到 `10.29`）；内容编写写 `ScriptText` 和 `Artifact` 的 `version`、`status`、`source`（`10.33` 到 `10.39`）。

正式版要跟上的（原型先补，后端还没有）：后端 `Stages` 还是 8 个、没有 `topic`，新建视频从 `script` 开始；`Video` 没有 `topic_id`（`internal/plugins/video` 的字段对齐测试会报 `Video.topic_id`）；文稿正文没有存的地方，正式版应写进视频目录的文件（`Artifact.path`），版本号照 `Artifact.version`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 出去 | 浏览器 | 产出物「预览」 | 内置浏览器打开预览地址 | `SPEC-browser-3` |
| 出去 | SOP、Agent、技能 | 执行器「运行」 | 原型模拟跑完并登记产出物；正式版发起真实运行（VID-03） | `SPEC-sop-11`、`SPEC-settings-16` |
| 出去 | 今日 | 停在检查点 | 原型未做（VID-07） | `SPEC-today-1.4` |
| 双向 | 本模块（选题） | 选题一步挑选、新建、换选题；选题抽屉里删选题 | 选题的 `video_id`、状态（已做成 / 换下来回到可开拍）跟着改，选题卡片上显示「已立项」；删掉选题时本集 `topic_id` 清掉 | `SPEC-videos-3`、`10.26` 到 `10.29` |
| 出去 | Agent（技能）、SOP | 「按选题大纲起草」 | 原型模拟跑 Phase 1 出初稿；正式版发起真实运行，初稿回写到编辑区等对比 | `SPEC-settings-16`、`10.37` |
| 进来 | 本模块（素材） | 选题关联的素材里有链接 | 原文导入下面列成小标签 | `SPEC-videos-4`、`10.40` |

## SPEC-videos-11 视频详情：产出物

这集的全部产出物，按类型分块（顺序同 `ARTIFACT_KIND`），没有的类型不出现；按比例区分的类型（口播稿、大纲、演示工程、成片、字幕、封面、简介、章节时间轴）再按比例分栏；封面在每个方向下再按封面比例分组，每组固定 5 格。

### 截图

| 状态 | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![](shots/videos/视频详情_产出物-1440-light.png) | ![](shots/videos/视频详情_产出物-1440-dark.png) |
| 手机 375 | ![](shots/videos/视频详情_产出物-375-light.png) | ![](shots/videos/视频详情_产出物-375-dark.png) |
| 封面 5 个版本和选用 | ![](shots/videos/视频详情_封面-1440-light.png) | ![](shots/videos/视频详情_封面-1440-dark.png) |
| 竖屏的三种封面比例 | ![](shots/videos/视频详情_封面比例-1440-light.png) | ![](shots/videos/视频详情_封面比例-1440-dark.png) |
| 登记 3:4 封面 | ![](shots/videos/视频详情_登记竖版封面-1440-light.png) | ![](shots/videos/视频详情_登记竖版封面-1440-dark.png) |
| 登记产出物（1440） | ![](shots/videos/视频详情_登记产出物-1440-light.png) | ![](shots/videos/视频详情_登记产出物-1440-dark.png) |
| 登记产出物（375） | ![](shots/videos/视频详情_登记产出物-375-light.png) | ![](shots/videos/视频详情_登记产出物-375-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-11.1 | 类型块的头 | 展示 / 点「加一个」 | 类型名、所属阶段、个数；「加一个」打开这个类型的登记表单 |
| SPEC-videos-11.2 | 产出物行 | 展示 / 点击 | 名称、完整路径（视频目录加路径）、版本、状态、来源、时长（mm:ss）、「验收 N 次」；点击打开产出物抽屉 |
| SPEC-videos-11.3 | 比例分栏 | 展示 | 这集的比例加上已有产出物用到的比例；不在本工程比例里的栏标「（不在本工程比例里）」；某个比例还没有时「这个比例还没有<类型>。登记」 |
| SPEC-videos-11.4 | 封面格 | 展示 / 点击 | 每个方向下按封面比例分组：这个方向的默认封面比例（`DEFAULT_COVER_RATIOS`）加上已登记过的，组头「封面 <比例>  已有数 / 5」；每组 1 到 5 格（有更大的版本号就多出来），色块按封面比例画；有的画状态点和「选用」或版本号，选用的那格高亮，点击打开抽屉；缺的格写「缺」，点击打开登记表单并预填这个方向、封面比例和版本 |
| SPEC-videos-11.5 | 右上「新增产出物」 | 点击 | 只在产出物标签出现；打开登记表单，类型默认是当前阶段的第一个类型 |
| SPEC-videos-11.6 | 登记表单：类型 | 选择 | 十种类型，每项写所属阶段；改类型时名称、比例、封面比例、版本、路径跟着重算 |
| SPEC-videos-11.7 | 登记表单：比例 | 点击 | 按比例区分的类型才有，只列这集的比例（还没定比例时列全部三种）；封面改方向时封面比例回到这个方向的默认（原来的还在这个方向的可选里就保留），版本跳到第一个空着的版本 |
| SPEC-videos-11.16 | 登记表单：封面比例 | 点击 | 只有封面有，列这个方向的 `DEFAULT_COVER_RATIOS`（竖屏是 9:16、3:4、1:1），说明「平台各有要求，抖音要 3:4」；换封面比例时版本跳到这个比例第一个空着的版本，名称、路径跟着变 |
| SPEC-videos-11.8 | 登记表单：名称、第几版、时长 | 输入 | 名称默认「封面 n」「成片」或类型名；封面选第 1 到 5 版；音频、成片填时长（mm:ss 或秒数，可不填，格式不对就不存） |
| SPEC-videos-11.9 | 登记表单：路径 | 输入 | 默认路径：演示工程 `presentation-<比例 key>`、音频 `audio/`、成片 `out/<目录最后一段>-16x9.mp4`、字幕 `subtitle/<目录最后一段>-16x9.srt`、封面 `cover/<封面比例>-<n>.png`（如 `cover/3x4-2.png`）、按比例区分的文稿类 `<类型 key>-<比例 key>.md`（如 `script-portrait.md`）、原文 `article.md`；字幕登记时语言记 `zh`；手动改过路径后再改类型、比例不覆盖 |
| SPEC-videos-11.10 | 「登记」 | 点击 | 新建一条草稿（版本 1，来源「手动登记」），表单收起；提示「登记后是草稿，验收通过才算定稿」 |
| SPEC-videos-11.11 | 「取消」 | 点击 | 收起表单 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-11.12 | 一个产出物都没有 | 「还没有产出物」「文稿、演示工程、音频、成片、封面、简介、章节时间轴都登记在这里」 | 「新增产出物」 |
| SPEC-videos-11.13 | 有产出物但有些类型没有 | 底部提示「没出现的类型说明还没登记，点右上角「新增产出物」」 | 新增 |
| SPEC-videos-11.14 | 路径为空 / 按比例的类型没选比例 | 「登记」不可点 | 补全 |
| SPEC-videos-11.15 | 还没定比例时登记按比例的类型 | 提示「还没定画面比例，先在规划检查里选好」 | 去制作流程选比例 |

### 数据

写入一条 `Artifact`（见 `SPEC-videos-0`）。登记表单的临时数据原型未定义成数据类型（`videos.tsx` 的 `NewArt`：`kind`、`variant`、`ratio` 封面比例、`option`、`name`、`path`、`duration` 字符串、`touched` 路径是否手动改过）。

演示数据：第 1 集（横竖两版）口播稿、大纲、简介、章节时间轴、字幕都是横竖各一份；横版口播稿 v3、竖版 v2，各有自己的两次验收记录（`SPEC-videos-12.6`）。封面横屏 16:9 五版、竖屏 9:16 五版，另有竖屏 1:1 一版（拿去发抖音被打回）和 3:4 一版（已选用）。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 出去 | 本模块 | 封面、简介 | 新建发布里可选、可带入 | `SPEC-videos-8.10`、`8.12` |
| 进来 | 技能、Agent、SOP | 产出物来源 | 执行器跑完的产出物来源记成执行器（`SPEC-videos-10.22`）；手动登记的是「手动登记」 | `SPEC-settings-16` |

## SPEC-videos-12 产出物抽屉

一个产出物的详情：改名称路径、改状态、选用封面、验收、升版本、预览、删除。改动边改边存。

### 截图

| 状态 | 亮 | 暗 |
|---|---|---|
| 封面（已选用） | ![](shots/videos/产出物抽屉_封面-1440-light.png) | ![](shots/videos/产出物抽屉_封面-1440-dark.png) |
| 口播稿，有验收记录 | ![](shots/videos/产出物抽屉_验收记录-1440-light.png) | ![](shots/videos/产出物抽屉_验收记录-1440-dark.png) |
| 删除确认 | ![](shots/videos/产出物抽屉_删除确认-1440-light.png) | ![](shots/videos/产出物抽屉_删除确认-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-12.1 | 抽屉头 | 展示 | 「<类型> · <比例> · 封面 <封面比例> · 第 n 版」（封面比例只有封面有）；封面带按封面比例画的大色块（竖的窄一些）；名称和版本、「<阶段> · N 前登记」、状态 |
| SPEC-videos-12.2 | 属性 | 展示 | 完整路径、来源（「技能 · web-video-presentation」这类）、比例、封面比例（封面）、语言（字幕，`zh` 显示「中文」）、时长 |
| SPEC-videos-12.3 | 名称、路径 | 输入 | 边输边存，视频的更新时间刷新 |
| SPEC-videos-12.4 | 状态 | 点击 | 草稿、待验收、已定稿、已发布四选一，可以直接改 |
| SPEC-videos-12.5 | 封面「选用这张 / 取消选用」 | 点击 | 只在封面有；同一视频同一方向、同一封面比例只能选一张（竖屏的 9:16 和 3:4 各选各的），选这张时同组其余取消；已选用的显示「已选用」。发布时默认用它（原型新建发布还没有默认选上，原型问题 7） |
| SPEC-videos-12.6 | 验收意见和「通过」 | 点击 | 追加一条通过记录（没写意见存「通过」），状态变已定稿（已发布的保持已发布），意见框清空。横版、竖版文稿是两条产出物，各自验收，互不影响 |
| SPEC-videos-12.7 | 「退回」 | 点击 | 没写意见时不可点（提示「退回要写意见」）；追加退回记录，状态回到草稿 |
| SPEC-videos-12.8 | 验收记录 | 展示 | 新的在上：通过或退回、意见（没写显示「没写意见」）、相对时间（悬停看完整时间） |
| SPEC-videos-12.9 | 「升版本」 | 点击 | 版本号加一，状态回到草稿 |
| SPEC-videos-12.10 | 「预览」 | 点击 | 演示工程、成片、封面、音频才有；在内置浏览器打开 `http://127.0.0.1:7801/<视频目录>/<路径>`，标签标题「<视频标题> · <名称>（<比例>）」 |
| SPEC-videos-12.11 | 「删除」 | 点击 | 换成「只删记录，文件不动」「取消」「删除」；确认后删掉，抽屉关闭 |
| SPEC-videos-12.12 | Esc、x | 点击 | 关抽屉 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-12.13 | 还没验收过 | 「还没验收过」 | 通过 / 退回 |
| SPEC-videos-12.14 | 退回没写意见 | 「退回」不可点 | 写意见 |
| SPEC-videos-12.15 | 预览服务没起 / 文件不存在 | 原型未做（内置浏览器打不开就显示浏览器自己的错误）；正式版先检查文件，没有时提示「文件不在 <完整路径>」 | 改路径 |

### 数据

见 `SPEC-videos-0` 的 `Artifact`、`Review`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 出去 | 浏览器 | 预览 | 内置浏览器新标签 | `SPEC-browser-3` |

## SPEC-videos-13 视频详情：设置

### 截图

| 状态 | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![](shots/videos/视频详情_设置-1440-light.png) | ![](shots/videos/视频详情_设置-1440-dark.png) |
| 手机 375 | ![](shots/videos/视频详情_设置-375-light.png) | ![](shots/videos/视频详情_设置-375-dark.png) |
| 删除确认 | ![](shots/videos/视频详情_删除确认-1440-light.png) | ![](shots/videos/视频详情_删除确认-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-13.1 | 标题 | 输入 | 边输边存 |
| SPEC-videos-13.2 | 所属项目 | 选择 | 可搜索，「不属于项目」清空；项目已删除时显示「已删除的项目」 |
| SPEC-videos-13.3 | 系列、第几集 | 选择 / 输入 | 选「单集（不属于系列）」清掉集数，集数输入框不可用；选了系列时集数默认原来的或 1，至少 1 |
| SPEC-videos-13.4 | 章节数 | 输入 | 至少 1 |
| SPEC-videos-13.5 | 视频目录 | 输入 | 等宽字体；文稿、演示工程、音频、成片、封面的路径都相对它 |
| SPEC-videos-13.6 | 画面比例 | 展示 | 只读；没锁定写「在「制作流程」的规划检查里选，通过后锁定」，锁定写「比例定了不能改，要换比例得新开工程」 |
| SPEC-videos-13.7 | 「删除视频」 | 点击 | 换成「会一起删掉 N 条产出物记录，视频目录里的文件不动」「取消」「删除」；确认后删掉视频、它的产出物和发布记录，从系列待同步里摘掉，回到全部视频（原型问题 2：文案没提发布记录，选题的 `video_id` 没清） |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-13.8 | 还没定比例 | 「还没定」 | 去规划检查 |
| SPEC-videos-13.9 | 集数和系列里别的集重复 | 原型不拦；系列详情编排时标红（`SPEC-videos-6.10`） | 改集数 |

### 数据

见 `SPEC-videos-0` 的 `Video`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 改动 | 项目 | 选项目 | `project_id` | `SPEC-projects-13.11` |
| 改动 | 本模块 | 删除视频 | 产出物、发布记录、系列待同步跟着清 | `SPEC-videos-7`、`SPEC-videos-6.4` |

## SPEC-videos-14 封面 A/B 测试

同一集出了几版封面，比点击率选主封面。视频号、抖音、小红书没有原生测试，靠主号加 A/B 小号各发一版（小号分发）；YouTube、B 站可以用平台原生测试。判定规则按 COVER.md Part 7：每张曝光到 1 万、观察满 7 天、点击率第一领先第二 20% 以上；结束后胜者设为主封面，其余归档不删。

### 截图

| 状态 | 亮 | 暗 |
|---|---|---|
| 进行中（第 1 集视频号，第 5 天，B 号曝光没到） | ![](shots/videos/封面AB_进行中-1440-light.png) | ![](shots/videos/封面AB_进行中-1440-dark.png) |
| 已决出（AI 系列第 15 集，封面 2 胜出） | ![](shots/videos/封面AB_已决出-1440-light.png) | ![](shots/videos/封面AB_已决出-1440-dark.png) |
| 新建测试 | ![](shots/videos/封面AB_新建-1440-light.png) | ![](shots/videos/封面AB_新建-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-14.1 | 抽屉头 | 展示 | 视频标题、平台、测试方式、状态；下面一行方式说明和开始 / 结束日期 |
| SPEC-videos-14.2 | 判定进度 | 展示 | 进行中：三条进度（`SPEC-videos-7.15`）加一句话：全到线「可以判定了：封面 n 点击率领先 x%」，否则「条件还没全满足，先别下结论；曝光不够或天数太短时，点击率的差距可能只是噪声」。已决出：「封面 n 胜出，已设为主封面；其余 N 张归档，留着不删」。没有结论：「提前结束，没有判胜负；主封面不变」 |
| SPEC-videos-14.3 | 各版封面 | 展示 | 每张一块：色块、名称、比例；小号分发写发它的账号（点了打开那条发布记录，`SPEC-videos-9`）和角色，还没有用这张封面的发布写「还没有用这张封面的发布，去新建发布选 A/B 小号发一版」；原生测试写「平台按封面分开给数据」。点击率条（按最高的那张算长度）、点击率、曝光（到线绿色，没到黄色并写「差 n」）。进行中时点击率最高的标「领先」；已决出时胜者标「主封面」，其余标「已归档」 |
| SPEC-videos-14.4 | 「模拟拉取数据」 | 点击 | 小号分发：每条已发布的发布涨一次数据并各存一条快照（同 `SPEC-videos-9.22`）；原生测试：每张自己的曝光、点击率涨一次 |
| SPEC-videos-14.5 | 「采用胜者」 | 点击 | 三条都到线时才有。状态改已决出、记胜者和结束时间；胜者设为这一集同方向同封面比例里选用的那张（`picked`），测试里其余封面 `archived`，同组别的封面取消选用 |
| SPEC-videos-14.6 | 「提前采用领先的」 | 点击 | 条件没满足时代替「采用胜者」。换成确认条「条件没满足，按现在的数据采用封面 n？」「取消」「仍然采用」，确认后同 `SPEC-videos-14.5` |
| SPEC-videos-14.7 | 「结束，不判胜负」 | 点击 | 确认条「结束测试，不判胜负，主封面不变？」，确认后状态改没有结论、记结束时间 |
| SPEC-videos-14.8 | Esc、x | 点击 | 关抽屉 |
| SPEC-videos-14.9 | 新建：视频 | 选择 | 只列出了两张以上封面的集，按更新倒序；默认是只看的那一集，否则第一集 |
| SPEC-videos-14.10 | 新建：平台、怎么测 | 点击 | 五个平台单选，默认视频号；「小号分发」「平台原生测试」，原生测试只有 YouTube、B 站能选（其余不可点并提示「<平台>没有原生封面测试」），换到没有原生测试的平台时回到小号分发；下面一行方式说明 |
| SPEC-videos-14.11 | 新建：封面 | 点击 | 列出这集比例在平台 `cover` 里的封面（不分横竖），多选，最多 5 张；说明「选 2 到 5 张，<平台>收 <比例>；已选 n 张」。小号分发时选中的封面下面写已有发布的账号或「还没发」，有「还没发」的给提示「标「还没发」的封面，建好测试后去新建发布，选 A/B 小号各发一版；发出去才有数据」。换视频、换平台清空已选 |
| SPEC-videos-14.12 | 新建：「开始测试」 | 点击 | 校验：没选视频「先选一个视频」，少于 2 张「至少选 2 张封面」（底部红字，只显示第一条）。通过后新建一个进行中的测试（7 天、1 万曝光、20% 差距），小号分发的每张自动挂上这集这个平台用这张封面的发布；抽屉换成这个测试 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-14.13 | 没有封面测试 | 「还没有封面测试；同一集出了几版封面，可以用 A/B 小号各发一版比点击率」 | 新建测试 |
| SPEC-videos-14.14 | 没有出了两张以上封面的视频 | 视频下拉写「还没有出了几版封面的视频」且不可点，「开始测试」不可点 | 先去出封面 |
| SPEC-videos-14.15 | 这集没有平台收的比例的封面 | 「这集还没有 <平台>收的比例的封面」 | 换平台 |
| SPEC-videos-14.16 | 封面或视频被删 | 「已删除的封面」「已删除的视频」 | 无 |
| SPEC-videos-14.17 | 采用胜者后改封面 | `App.tsx` 已给发布页传 `onArtifacts`（VID-06p 顺带接上），采用胜者后视频详情里的封面选用和归档按 `SPEC-videos-14.5` 跟着变 | 无 |

### 数据

见 `SPEC-videos-0` 的 `CoverTest`、`coverTestState`、`Artifact.archived`、`PlatformAccount`。演示数据接 PROTO-01 的故事线：第 1 集视频号主号（`pb2`，封面 1）和两个 A/B 小号（`pb2a` 封面 3、`pb2b` 封面 4）同一天发，测试 `cvt1` 进行中，第 5 天，B 号曝光 8,900 没到线，点击率差距 23% 已到线；AI 系列第 15 集 `cvt2` 三张各发一个号，第 8 天结束，封面 2 点击率 9.2% 胜出，封面 1、3 归档。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | 本模块 | 发布记录（`metrics` 的曝光、点击率） | 小号分发的数据从发布读 | `SPEC-videos-9` |
| 改动 | 本模块 | 采用胜者 | 产出物封面的 `picked`、`archived` | `SPEC-videos-11`、`SPEC-videos-12` |
| 进来 | 设置（连接器，内容平台） | 平台账号 | 主号挂连接器；A/B 小号原型是手动登记的，正式版每个小号一条连接器（VID-04） | `SPEC-settings-5` |

## SPEC-videos-15 日历

这周发什么、来不来得及。格子里是发布（计划中、已定时、已发布、发布失败）、每集的计划首发日和商单交付截止；离首发 7 天内还没过第一章验收的标红。计划中、已定时的发布和没完成的首发日能拖到别的日子，已定时的发布挪了日期，它的定时任务跟着改。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 桌面 1440 | ![](shots/videos/标签_日历-1440-light.png) | ![](shots/videos/标签_日历-1440-dark.png) |
| 手机 375 | ![](shots/videos/标签_日历-375-light.png) | ![](shots/videos/标签_日历-375-dark.png) |
| 进度落后（第 2 集） | ![](shots/videos/日历_进度落后-1440-light.png) | ![](shots/videos/日历_进度落后-1440-dark.png) |
| 拖动改日期 | ![](shots/videos/日历_拖动改日期-1440-light.png) | ![](shots/videos/日历_拖动改日期-1440-dark.png) |
| 周视图 | ![](shots/videos/日历_周视图-1440-light.png) | ![](shots/videos/日历_周视图-1440-dark.png) |
| 手机：点一天 | ![](shots/videos/日历_点一天-375-light.png) | ![](shots/videos/日历_点一天-375-dark.png) |
| 手机：改日期框 | ![](shots/videos/日历_改日期-375-light.png) | ![](shots/videos/日历_改日期-375-dark.png) |
| 手机：周视图 | ![](shots/videos/日历_周视图-375-light.png) | ![](shots/videos/日历_周视图-375-dark.png) |
| 定时任务里的定时发布 | ![](shots/videos/定时任务_定时发布-1440-light.png) | ![](shots/videos/定时任务_定时发布-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-15.1 | 页面标题 | 展示 | 「视频 / 日历」，说明「这周发什么、来不来得及：发布排期、计划首发日和商单交付；离首发 7 天内还没过第一章验收的标红，拖动改日期」 |
| SPEC-videos-15.2 | 月 / 周 | 点击 | 默认月视图。月视图从本月 1 号所在周的周一画到月底所在周的周日，不属于本月的格子变淡；周视图是选中那天所在的一周（周一到周日）。切到周视图时跳到选中那天的那一周 |
| SPEC-videos-15.3 | 上一个 / 下一个、「今天」 | 点击 | 按月或按周翻；「今天」回到今天所在的月或周，选中今天 |
| SPEC-videos-15.4 | 汇总 | 展示 | 当前月（或周）里：发布 N、已定时 N、失败 N（有才显示，红字）、首发 N；全部视频里进度落后的集数「进度落后 N 集」（红字，悬停列出标题） |
| SPEC-videos-15.5 | 图例 | 展示 | 四种发布状态的颜色、计划首发（虚线框）、进度落后（红框）、商单交付（蓝框） |
| SPEC-videos-15.6 | 格子 | 展示 | 日期（每月 1 号写「M/1」，今天是实心圆）；条目按「失败和落后的、商单交付、首发日、发布按时间」排。月视图每格最多露 3 条，多的写「+N 条」，点了切到那一周的周视图。周视图每条带时刻 |
| SPEC-videos-15.7 | 条目 | 展示 | 发布：左边一道状态色，平台色点，标题；首发日：虚线框，「首发」加视频标题，落后的整条标红；商单交付：「交付」加「品牌：商单名」，3 天内到期的标橙。悬停写全「种类 · 平台 时刻：标题（状态）」，能拖的加「可以拖到别的日子」 |
| SPEC-videos-15.8 | 格子 | 点击 | 选中这一天，下面的详情列出这天的全部条目；空的写「这天空着」和「没有排发布，也没有首发日；把别的日子的发布拖过来，或者去发布记录新建」 |
| SPEC-videos-15.9 | 条目 | 点击 | 选中这一条，下面的详情换成这条：种类、标题、日期（能改的是日期框）、时刻、离今天几天；发布还有平台和状态、失败原因；有视频的写视频标题和进度（`videoState`），发布另写计划首发日；商单交付写品牌和商单状态。进度落后的视频给提示「离计划首发 <日期> 只剩 N 天（或已经过了），第一章还在等验收」或「第一章验收还没过，现在在「<阶段>」」。按钮：「打开视频」、「看发布记录」（发布记录页只看这一集）、「打开商单」。「看这一天」回到选中那天的列表 |
| SPEC-videos-15.10 | 条目 | 拖到另一个格子 | 能拖的条目可以拖；拖过的格子高亮。放下后：发布的 `scheduled_at` 换成那天、时刻不变；首发日改 `Video.target_date`。详情选中这一条，写「已改到 <日期>」，已定时的发布加「，定时任务跟着改了」。不能拖的（已发布、失败的发布，已完成的首发日，商单交付）拖不起来 |
| SPEC-videos-15.11 | 详情里的日期框 | 改日期 | 和拖动一样，手机上没法拖时用它 |
| SPEC-videos-15.12 | 定时发布 | 自动 | 一条已定时（`scheduled`、有 `scheduled_at`）的发布对一条定时任务：只执行一次，日期时刻取 `scheduled_at`，名称「定时发布：<平台>「<标题>」」，动作 `{ kind: 'publish', publish_id }`，id `sc_pub_<发布 id>`。发布记录新建成已定时、挪了日期就补上或改时间（改时间时重新启用）；改成立即发布、已发出去，还没到点的停用；发布记录删了就删掉；已发布、失败的留着看执行记录（`syncPublishSchedules`） |
| SPEC-videos-15.13 | 定时任务里的定时发布 | 展示 | 列表「做什么」是「发布视频」和「发布「<平台> · <标题>」」，动作筛选多一项「发布视频」。抽屉里名称只读，「什么时候」「做什么」换成「发布哪条」：发布记录名、规则一句话和下次执行，说明「这条定时跟着视频的发布记录走：改时间在内容日历里拖，或者在发布记录里改；到点按发布记录发，失败的记进运行异常」，按钮「打开发布记录」「去内容日历」。新建定时任务不能选「发布视频」 |
| SPEC-videos-15.14 | 定时发布「立即执行一次」 | 点击 | 按发布记录发：平台连接器异常写「<平台>连接器异常：<原因>」、没有能自动发布的连接器写「<平台>没接能自动发布的连接器，只能手动登记」、平台规则校验不过写校验那一句，这三种发布记录变成发布失败，执行记录写「发布失败：<原因>，已记进运行异常」并标失败，运行异常记一条（`publish:<发布 id>`）；都过了就变成已发布，执行记录写「<平台>发布了「<标题>」」。发布记录已删「没执行：发布记录已删除」，已经发过「没执行：已经发布过了」 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-15.15 | 这个月一条都没有 | 格子都空，汇总都是 0；选中的那天「这天空着」 | 翻月，去发布记录新建 |
| SPEC-videos-15.16 | 发布失败 | 红色条目，汇总「失败 N」；详情写失败原因和「发布失败的要先在发布记录里重试，再排日子」 | 看发布记录 |
| SPEC-videos-15.17 | 已发布 | 绿色条目，不能拖；详情写「已经发出去了，日期不能改」 | 看发布记录 |
| SPEC-videos-15.18 | 手机宽度 | 月视图格子只露日期和最多 4 个色点（发布按状态色，落后红色），点一天在下面看列表、选一条用日期框改；周视图竖着排，每天一段 | 同桌面 |

### 数据

见 `SPEC-videos-0` 的 `CalendarItem`、`isBehind`、`Video.target_date`、`Publish`、`Deal.deadline`；`SPEC-tasks-0` 的 `ScheduleAction`。演示数据接 PROTO-01：第 2 集（`vd2`，停在第一章验收）计划 4 天后首发，B 站那条（`pb5`）已定时在首发日 20:00，所以首发日标红；视频号那条（`pb6`）计划在第二天中午。第 1 集 YouTube（`pb4`）两天后定时，抖音（`pb3`）5 天前到点发布失败。AI 系列第 19 到 26 集每周三首发，第 19、20 集的视频号已排成计划。第 3 集 16 天后首发。远川权限改造演示片 6 天后首发，商单 7 天后交付；远川试点上线短片 10 天前已经发在远川的 B 站号。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 改动 | 本模块 | 拖发布、改首发日 | 发布记录的 `scheduled_at`、视频的 `target_date` | `SPEC-videos-7`、`SPEC-videos-13` |
| 出去 | 本模块 | 「打开视频」「看发布记录」 | 视频详情；发布记录只看这一集（发布抽屉在发布记录页里，原型从外面打不开具体一条） | `SPEC-videos-10`、`SPEC-videos-7.9` |
| 改动 | 任务（定时任务） | 已定时的发布挪了日期 | 定时发布的日期时刻跟着改 | `SPEC-videos-15.12`、`SPEC-tasks-7` |
| 出去 | 项目（商单） | 「打开商单」 | 打开商单抽屉 | `SPEC-videos-16` |
| 改动 | 运行异常 | 定时发布失败 | 记一条，模块「发布」 | `SPEC-videos-15.14` |

## SPEC-videos-16 商单

品牌来问报价，转成商单挂在项目下；按询价、已报价、已签约、制作中、客户审核、已交付、已收款流转，也可以丢单。报价参考近 30 天均播；视频挂到商单上，客户的审核意见记进产出物验收；已交付没收款的提示账期；发布满 7 天出结案报告存进「文档」。商单在项目详情的「商单」标签，视频模块开着才有这个标签。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 项目里的商单标签 | ![](shots/videos/商单_项目标签-1440-light.png) | ![](shots/videos/商单_项目标签-1440-dark.png) |
| 商单抽屉：账期快到 | ![](shots/videos/商单抽屉_账期快到-1440-light.png) | ![](shots/videos/商单抽屉_账期快到-1440-dark.png) |
| 客户审核和结案报告 | ![](shots/videos/商单抽屉_客户审核和结案报告-1440-light.png) | ![](shots/videos/商单抽屉_客户审核和结案报告-1440-dark.png) |
| 记客户意见 | ![](shots/videos/商单抽屉_记客户意见-1440-light.png) | ![](shots/videos/商单抽屉_记客户意见-1440-dark.png) |
| 结案报告（文档） | ![](shots/videos/商单_结案报告文档-1440-light.png) | ![](shots/videos/商单_结案报告文档-1440-dark.png) |
| IM 消息转商单 | ![](shots/videos/商单_IM转商单-1440-light.png) | ![](shots/videos/商单_IM转商单-1440-dark.png) |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-16.1 | 项目详情「商单」标签 | 展示 | 在「任务」后面；视频模块不在当前工作台时没有这个标签。有账期快到的单时标签上亮红点 |
| SPEC-videos-16.2 | 汇总和「新建商单」 | 展示 / 点击 | 进行中 N、进行中金额（人民币的报价合计）、已收款金额、「N 单账期快到了」（有才显示，橙字）；「新建商单」打开新建抽屉，项目默认是这个项目 |
| SPEC-videos-16.3 | 商单列表 | 展示 / 点击 | 一行一单：名称、品牌和交付物、状态、报价、交付 / 账期（`payText`：账期 7 天内「N 天后到账期」橙字、过了「账期已过 N 天」红字、今天「今天到账期」；没交付的写「<截止> 交付」；已交付写「<账期> 前收款」；已收款写「已收款」）、挂的视频标题。已收款、丢单的折在下面「展开已收款、丢单的 N 单」。点一行打开商单抽屉，这一行高亮。手机宽度只留名称和状态 |
| SPEC-videos-16.4 | 抽屉顶部提示 | 展示 | 账期快到或过了：「N 天后到账期：已交付还没收款，记得跟 <询价人> 确认付款」（过了是红色）；从 IM 转来的另有一块来源：发信人、会话、时间、原话，「打开这条消息」 |
| SPEC-videos-16.5 | 基本信息 | 输入 | 品牌、商单名称（都必填）；项目（必填，搜索下拉）；询价人（搜索下拉，这个项目的干系人排前面、带角色，其余联系人在后面，可以不填） |
| SPEC-videos-16.6 | 状态 | 点击 | 七步加「丢单」一排按钮，当前那步实心，之前的绿色；点哪步就改成哪步，记一条状态变化；下面一行最近四次变化「<状态> <多久前>」。丢单要填原因（必填），已收款后不能点丢单 |
| SPEC-videos-16.7 | 报价和交付 | 输入 | 投放平台（五个平台多选）、交付物、报价（整数，步长 100）、币种（人民币、美元）、交付截止、账期（最晚收款日）。报价参考：「近 30 天 <平台>均播 N（M 条发布）」「按每千次播放 ¥150 算，投放价值约 ¥X，制作费另算」，人民币时有「填入」；没数据时「近 30 天各平台都没有已发布的数据，报价参考不出来」 |
| SPEC-videos-16.8 | 视频 | 展示 / 选择 | 挂上的视频：标题（点了打开视频详情）、比例、进度、「移除」；「挂一个视频」搜索下拉，这个项目的视频排前面标「本项目」。保存时没有项目的视频归到商单的项目 |
| SPEC-videos-16.9 | 结案报告 | 点击 | 挂上的视频还没发出去：「挂上的视频还没有发出去；发布满 7 天后可以出结案报告」；没满：「最早一条发布还差 N 天满 7 天」；满了：「出结案报告」，在「文档」里新建一篇「<品牌> · <名称> 结案报告」（分类文档，来源「商单「<名称>」」，标签「商单」「结案报告」），挂进项目的文档（类型其他、定稿）。出过以后「打开结案报告」（跳到文档阅读）、「按最新数据重出」（覆盖原来那篇） |
| SPEC-videos-16.10 | 客户审核 | 点击 | 列出挂上的视频的产出物里外部审核人留下的验收记录：通过 / 要改、审核人、意见、产出物和版本、时间。「记一条意见」：选产出物（待验收、已定稿、已发布的）、审核人（项目里的决策人、对接人）、通过或要改、客户原话（必填），「记下」写进那个产出物的验收记录，`by: { type: 'contact', id }`；不改产出物状态 |
| SPEC-videos-16.11 | IM 消息抽屉「转为商单」 | 点击 | 视频模块开着才有这一节。没转过：打开新建商单抽屉，来源是这条消息，询价人是发信人对上的联系人，品牌取他的公司，项目取这条消息所在会话挂的项目（都对不上取第一个项目）；转过：「已转为商单 <品牌> · <名称>」和「打开商单」 |
| SPEC-videos-16.12 | 「创建」「保存」 | 点击 | 校验（底部红字，只显示第一条）：品牌必填、商单名称必填、选一个项目、写一下丢单原因。新建的跳到这个项目的「商单」标签，抽屉换成这一单 |
| SPEC-videos-16.13 | 「删除」 | 点击 | 换成确认条「删除后视频和结案报告保留，只删这条商单」「取消」「删除」 |
| SPEC-videos-16.14 | 今日 | 展示 | 账期快到的单在「需要你处理」里一条「商单账期」：「<品牌>「<名称>」N 天后到账期」，「已交付待收款 · <报价>」，「去看看」打开商单抽屉 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-16.15 | 这个项目没有商单 | 「这个项目还没有商单」「品牌在 IM 里问报价时，在消息抽屉里点「转为商单」；或者点右上「新建商单」」 | 新建商单 |
| SPEC-videos-16.16 | 还没挂视频 | 视频一节「还没挂视频」；客户审核「挂上视频、有了待验收的产出物后，可以记客户的审核意见」；结案报告「挂上的视频还没有发出去」 | 挂视频 |
| SPEC-videos-16.17 | 视频、联系人、项目被删 | 「已删除的视频」「已删除的联系人」「已删除的项目」 | 换一个 |

### 数据

见 `SPEC-videos-0` 的 `Deal`、`DealStatus`、`payState`、`avgViews30`、`reportState`、`dealReport`、`Review.by`。演示数据接 PROTO-01 的远川和北岸两个项目：远川（`pj_perm`）两单，「试点上线短片」（`deal_yc1`）已交付，视频 `vd5` 10 天前发在远川的 B 站号（客户号 `pa_bili_yc`），成片由许知行退回一次再通过，账期 3 天后，能出结案报告；「权限改造演示片」（`deal_yc2`）制作中，视频 `vd4` 在录屏，演示工程许知行看过，7 天后交付。北岸物流（`pj_beian`）「审批流 demo 讲解视频」（`deal_ba1`）已报价，还没挂视频。远川项目群里梁晚晴「采购流程这边需要一份正式的报价……」那条可以拿来演示 IM 转商单。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | IM 消息 | 「转为商单」 | 新建商单，带来源消息 | `SPEC-videos-16.11`、`SPEC-messages-2` |
| 进来 | 项目 | 干系人 | 询价人、审核人的候选 | `SPEC-projects-6` |
| 改动 | 本模块 | 挂视频、记客户意见 | 视频的 `project_id`、产出物的验收记录 | `SPEC-videos-13`、`SPEC-videos-12` |
| 出去 | 文档 | 「出结案报告」「打开结案报告」 | 新建或覆盖一篇文档，挂进项目文档；跳到文档阅读 | `SPEC-library-1`、`SPEC-projects-8` |
| 出去 | 今日 | 账期快到 | 一条「商单账期」 | `SPEC-today-1` |
| 出去 | 本模块（日历） | 交付截止 | 日历上一条「交付」 | `SPEC-videos-15` |

## SPEC-videos-17 分镜和 B-roll 素材

内容编写的编辑区分「文稿」「分镜」两个视图（编辑区顶上左边的切换，默认「文稿」，就是 `SPEC-videos-10.31` 到 `10.41`）。分镜是这一集的有序列表：每个分镜对应一段口播（A-roll 文本）、写画面说明、估时长，再从本机素材目录挑照片、视频当 B-roll。素材目录只读，不移动、不改、不删原文件。数据约定在 `web-next/src/storyboarddata.ts`，分镜和登记的目录记在 `storyboard.tsx` 的内存 store 里（原型刷新回到演示数据）。演示：「第 3 集：Agent 怎么配才放心」（`vd3`）带三个分镜，第二个分镜里有一条缺失的 B-roll。

### 截图

| | 亮 | 暗 |
|---|---|---|
| 分镜视图 | ![](shots/videos/分镜_列表-1440-light.png) | ![](shots/videos/分镜_列表-1440-dark.png) |
| 素材抽屉 | ![](shots/videos/分镜_素材抽屉-1440-light.png) | ![](shots/videos/分镜_素材抽屉-1440-dark.png) |
| 手机宽度 | ![](shots/videos/分镜_列表-375-light.png) | |

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-17.1 | 「文稿」「分镜」切换 | 点击 | 在编辑区顶上一行最左边。切到「分镜」后这一行只留切换（和点开看的「收起」），下面换成分镜视图；起草、初稿对比、原文都只在「文稿」里 |
| SPEC-videos-17.2 | 分镜视图顶上一行 | 展示 / 点击 | 左边说明：有分镜时「N 个分镜 · 约 m:ss；拖动左边的把手排序，把素材拖到分镜上就能加入」，没有时「按口播稿的段落拆成分镜，每个分镜配画面说明和 B-roll」。右边「素材库」（打开素材抽屉，不指定分镜）、「加一个分镜」（加在最后，空的）、「从口播稿生成」（没有口播稿只有大纲时叫「从大纲生成」） |
| SPEC-videos-17.3 | 「从口播稿生成」 | 点击 | 用当前口播稿（本集第一个比例，没有这个比例的取别的比例；正式版取已保存的当前版本，原型连没保存的草稿一起算）按标题或段落拆（`shotsFromText`）：有标题时一个标题一个分镜，标题当画面说明、下面的正文当口播段落，只有一个总标题、下面没正文的跳过；没有标题按空行分段，一段一个分镜；列表记号去掉。没有口播稿用大纲。都没有时按钮不可点（悬停「先在「文稿」里写口播稿或大纲，保存成版本」）。还没有分镜时直接生成，下面绿字「按口播稿 vN 生成了 N 个分镜」 |
| SPEC-videos-17.4 | 已有分镜时生成 | 点击 | 先出一条确认「已经有 N 个分镜。生成的初稿要：」「追加到后面」「覆盖现有分镜」（悬停「现有分镜和它们的 B-roll 都会删掉」）「取消」。追加的接在最后、序号接着排；覆盖的替换全部分镜 |
| SPEC-videos-17.5 | 分镜行 | 展示 | 左边一列：拖动把手、序号、时长（`m:ss`，手填的优先，没填按口播估）、「上」「下」（第一个没有上、最后一个没有下）；中间口播段落（多行）、画面说明、时长（秒，占位「约 N 秒」，悬停「不填按口播字数估（每分钟 240 字），现在约 N 秒」），下面一排 B-roll 卡片和「加 B-roll」；右边「删除」。窄屏左边一列变成一行，字段上下排 |
| SPEC-videos-17.6 | 编辑分镜 | 输入 | 口播、画面说明改完失焦保存；时长填 1 到 3600 的整数秒，空着按口播估，不是整数时框变红、下面「时长填 1 到 3600 的整数秒，空着按口播估」，不保存 |
| SPEC-videos-17.7 | 排序 | 拖动 / 点击 | 按住把手拖到另一个分镜上，放到那个位置，序号重排；「上」「下」挪一格。拖动时经过的分镜描强调色边框 |
| SPEC-videos-17.8 | 删除分镜 | 点击 | 换成确认：「连同 N 条 B-roll 一起删，原文件不动」（没有 B-roll 时「删掉这个分镜」）「取消」「删除」；删了后面的序号前移 |
| SPEC-videos-17.9 | B-roll 卡片 | 展示 / 输入 / 点击 | 缩略图、文件名（悬停看相对路径）、备注；视频多一行入点「到」出点（秒数或「分:秒」，失焦保存；认不出时框变红，出点不晚于入点时「出点要晚于入点」，不保存）；「前」「后」挪位置，「移除」只从分镜里拿掉（悬停「从分镜里移除，原文件不动」）。卡片能拖到别的分镜上挪过去 |
| SPEC-videos-17.10 | 「加 B-roll」 | 点击 / 拖入 | 打开素材抽屉，加到这个分镜；没有 B-roll 时下面小字「或把素材拖到这里」。从素材抽屉把文件拖到分镜行上也能加（勾选了多个时拖其中一个就是加全部勾选的） |
| SPEC-videos-17.11 | 素材抽屉：目录 | 点击 | 抽屉「B-roll 素材」，顶上一排素材目录：第一个是「工程目录」（这一集的工程目录，不用登记），后面是登记的目录；用不了的（没权限、目录不在了）划掉，悬停看原因。最后「管理目录」展开登记区 |
| SPEC-videos-17.12 | 管理目录 | 输入 / 点击 | 说明「登记本机目录当素材库，只读，不会移动、修改、删除里面的文件。读工程目录以外的目录要视频插件的「只读你登记的目录」权限」；路径框（绝对路径）、「选目录」（正式版用通用目录选择器，选完直接登记）、「登记」；校验：不是 / 开头「填绝对路径，以 / 开头」，磁盘根「不能登记整个磁盘的根目录，选一个具体的素材目录」，路径里有隐藏目录、系统目录、不存在、不是目录都拒绝，登记过的「这个目录已经登记过了」。下面列登记的目录：名称、路径、「移除」（确认「分镜里用到的会标缺失」） |
| SPEC-videos-17.13 | 位置和子目录 | 点击 | 面包屑：目录名 / 子目录 / …，点哪段回到哪；下面一排子目录标签（「子目录/」），在子目录里时多一个「上一级」。隐藏的文件和目录不列 |
| SPEC-videos-17.14 | 筛选和搜索 | 点击 / 输入 | 「全部」「图片」「视频」；搜索框「搜文件名（含子目录）」回车搜当前目录和下面所有子目录，不分大小写，搜的时候不列子目录；有搜索词时多一个「清除」 |
| SPEC-videos-17.15 | 文件格子 | 展示 / 点击 | 一格一个文件：缩略图（视频右下角时长）、勾选框、文件名、尺寸 · 时长 · 大小、修改时间（N 前）。点缩略图在下面预览，再点收起；勾选的格子描强调色边框 |
| SPEC-videos-17.16 | 预览 | 展示 | 文件名、尺寸时长大小、「关闭预览」；图片看原图，视频用播放器播放原文件，能拖进度（正式版；原型只显示画面） |
| SPEC-videos-17.17 | 分页 | 点击 | 正式版一页 48 个（原型 12 个），多页时「上一页」「第 N / M 页 · 共 K 个」「下一页」；一页时「共 K 个，选了 N 个」。换目录、筛选、搜索回到第一页、清空勾选 |
| SPEC-videos-17.18 | 抽屉底部 | 选择 / 点击 | 「加到」分镜下拉（「第 N 个：画面说明」），从分镜行打开时默认是那个分镜；「加入分镜 N 个」把勾选的加到那个分镜后面，同一个文件已经在这个分镜里的跳过；成功后绿字「已加到第 N 个分镜：K 个」，勾选清空。没选分镜、没勾文件时不可点（悬停写原因） |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-17.19 | 还没有分镜 | 「还没有分镜。点「从口播稿生成」一键拆出初稿；也可以「加一个分镜」手写。」（没有稿子时前半句是「先写口播稿，再一键拆成分镜；」） | 生成、加分镜 |
| SPEC-videos-17.20 | B-roll 的文件不在了 | 文件被移走、删掉，或者素材目录被移除：卡片虚线框，缩略图换成「图片」「视频」字样，左上红色「缺失」（悬停「文件被移走或删掉了，或素材目录已移除」）；不报错，备注、入出点照常能改，能移除 | 移除，或者把文件放回原处 |
| SPEC-videos-17.21 | 工程目录用不了 | 视频没填工程目录、目录不在了、没确认 `fs:read:project`：「「工程目录」用不了：<原因>」「在视频的「设置」里填工程目录，或者登记别的素材目录」 | 填工程目录、换目录 |
| SPEC-videos-17.22 | 目录里没有图片和视频 | 「这个目录里没有图片和视频」（筛了类型时说「图片」「视频」）；搜不到时「没有文件名含「<词>」的…」 | 换目录、清除搜索 |
| SPEC-videos-17.23 | 本机没有 ffmpeg、ffprobe | 正式版：「本机没有 ffmpeg（或视频插件没确认 process:spawn），视频没有缩略图，只显示文件信息」，视频格子写「视频」，没有时长和尺寸；图片照常显示（浏览器能显示的格式回原图） | 装 ffmpeg 后刷新 |
| SPEC-videos-17.24 | 越出素材目录 | 正式版后端只认「素材目录 id + 相对路径」：`../`、绝对路径、反斜杠、隐藏项、指到目录外面的符号链接都拒绝；列目录时指到外面的链接不列 | 无 |

### 数据

见 `web-next/src/storyboarddata.ts` 的 `Shot`、`Broll`、`MediaRoot`、`MediaFile`、`shotEst`、`shotSeconds`、`shotsFromText`、`parseSec`。正式版存插件表 `video_shots`（`position` 是序号，`duration` 手填可空）、`video_shot_brolls`（`root_id` 加相对 `path`、`note`、`in_sec`、`out_sec`）、`video_media_roots`（登记的目录，全局共用）；接口见 `docs/api-contract.md`「分镜和 B-roll 素材（TSK-0456）」。缩略图缓存在数据目录的 `cache/video/thumbs/`。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | 本模块（内容编写） | 口播稿、大纲的当前版本 | 生成分镜初稿 | `SPEC-videos-10.31`、`17.3` |
| 进来 | 本模块（设置） | 视频的工程目录 | 素材抽屉的「工程目录」 | `SPEC-videos-13` |
| 进来 | 插件管理 | 视频插件的 `fs:read:registered`、`process:spawn` 权限 | 能不能读登记的目录、有没有缩略图和视频时长 | `docs/plugin-api.md` 3.1、3.2 |
| 出去 | 本机目录 | 浏览、预览 | 只读，不写原文件；缩略图写在插件自己的缓存目录 | `17.12` |

## SPEC-videos-18 B 站组件

视频模块标签栏最后一个标签「B 站」（TSK-0455）。用 B 站网页端扫码登录自己的账号，看个人账户数据和按天趋势，收发私信。开放平台（现有连接器 `bilibili`）只给得出粉丝、关注、过审稿件数，私信和别的数据走网页端：网页端是**非官方接口，可能变化**。登录凭证（Cookie、csrf）存在连接器 `bilibili_web` 实例的保险箱里，页面和接口都拿不到，只显示登录状态、昵称。原型数据都是编的，扫码、来信、风控用「模拟手机确认」「演示来信」「演示风控」「演示失效」几个按钮演示（正式版没有这几个按钮）。

### 截图

原型 `web-next/src/videobili.tsx`，截图待补（1440、375 两种宽度）。

### 交互

| 编号 | 元素 | 操作 | 结果 |
|---|---|---|---|
| SPEC-videos-18.1 | 页面标题 | 展示 | 「视频 / B 站」，说明「B 站账户数据、按天趋势和私信。网页端是非官方接口，可能变化；登录凭证存在保险箱里，页面上看不到」；下面是模块标签栏，「B 站」高亮 |
| SPEC-videos-18.2 | 账号切换 | 点击 | 接了不止一个 `bilibili_web` 实例时，标题下一排 chip（昵称，没登录的用连接器名），点哪个看哪个；地址记 `?c=<连接器 id>` |
| SPEC-videos-18.3 | 账号条 | 展示 | 头像（昵称最后一个字，不加载 B 站的头像图）、昵称、登录状态胶囊（已登录 / 未登录 / 登录已失效）、「UID · 数据 MM-DD HH:mm 拉取 · 每 60 秒查一次新私信」；登录着时右边「退出登录」 |
| SPEC-videos-18.4 | 退出登录 | 点击 | 确认「退出 B 站登录」：清掉保险箱里的登录凭证，停止拉新私信；已经拉到的数据和私信留着。确认后回到扫码登录，连接器显示「已退出 B 站登录，到「视频 / B 站」扫码登录」 |
| SPEC-videos-18.5 | 扫码登录 | 点击 | 没登录或登录失效时代替下面的标签：左边二维码框，右边三步说明（点「生成二维码」、用 B 站 App 扫一扫、手机上确认登录）和「只用扫码，不填密码……二维码 3 分钟内有效」。点「生成二维码」后端生成二维码图（SVG），之后每 2 秒问一次：「等待扫码」→「已扫码，在手机上确认登录」（绿字）→ 登录成功，页面换成登录后的样子。二维码过期「二维码已过期，重新生成一个」（橙字），按钮变成「重新生成二维码」；轮询出错（被限频、连不上）就停下，显示原因，等用户再点 |
| SPEC-videos-18.6 | 小标签 | 点击 | 登录后两个小标签「账户概览」「私信」，私信后面带未读数（为 0 不显示）；地址 `?v=dm` 是私信 |
| SPEC-videos-18.7 | 账户概览的数字卡 | 展示 | 「账户数据」一行写「YYYY-MM-DD 的数据，MM-DD HH:mm 拉取」，粉丝、关注、过审稿件取开放平台时加「；粉丝、关注、过审稿件取开放平台」。数字卡：粉丝（下面绿字「昨日 +N」）、总播放（「昨日 +N」）、获赞、投币、收藏、充电、评论、弹幕、分享、关注、过审稿件（只有开放平台给了才有）；10 万以上写「N 万」 |
| SPEC-videos-18.8 | 刷新数据 | 点击 | 右上「刷新数据」：现拉一次存成当天快照（同一天再拉覆盖），按钮显示「正在拉取」。一次要发 8 个请求，按全局限频排队，十来秒；10 分钟内刷过的回「刚刷新过，N 分钟后再刷新」。后台每天自动拉一次，不用每天点 |
| SPEC-videos-18.9 | 按天趋势 | 点击 | 一排 chip：播放、点赞、投币、收藏、充电（创作中心近 30 天每天的新增）、粉丝（本地每天一次快照攒出来的总数）。柱状图一天一根，悬停「日期：数值」，下面写首尾日期和「最高 N」 |
| SPEC-videos-18.10 | 私信顶上一行 | 展示 / 点击 | 「MM-DD HH:mm 查过新私信；第一次只记下现有会话，之后来的新私信才发通知」，右边「查新私信」（现拉一轮，10 秒内拉过的回「刚拉过」）。后台每 60 秒自动拉一轮 |
| SPEC-videos-18.11 | 会话列表 | 展示 / 点击 | 左边一列：头像、对方昵称（拿不到时「UID N」）、最后一条的时间（今天的只写时分）、最后一条的内容、未读数；按最后一条的时间倒序。点一个在右边打开，地址 `?t=<对方 UID>`。只列和个人的会话，群消息不列 |
| SPEC-videos-18.12 | 会话详情 | 展示 / 点击 | 顶上对方昵称、UID、「拉取消息」；中间消息记录，对方的在左、自己的在右（粉色底），每条下面时间，没发出去的写红字「没发出去」和原因，带「再发一次」。第一次打开、本地还没消息时自动拉一页（只这一次） |
| SPEC-videos-18.13 | 发送框 | 输入 / 点击 | 多行输入框「发给 <昵称>（只发文字，一次一条）」，下面「还能写 N 字」（最多 500，超了红字「超了 N 字」、发送不可点）；「发送」只在点的时候发，Ctrl / ⌘ + Enter 也行，发的时候按钮显示「正在发送」、不可点。发完清空输入框；没发出去的留着输入框里的字，下面红字写原因。不做自动回复、群发、定时发送 |
| SPEC-videos-18.14 | 窄屏 | 展示 | 760 以下私信一次显示一边：先是会话列表，点开一个换成会话详情，顶上多一个「返回」 |

### 空状态和异常状态

| 编号 | 场景 | 显示 | 可做的操作 |
|---|---|---|---|
| SPEC-videos-18.15 | 还没接 B 站网页登录 | 「还没接 B 站网页登录」「新建一个「B 站网页登录」连接，再用 B 站 App 扫码登录……」；「新建并扫码登录」（建一个 `bilibili_web` 实例）、「去连接器页」 | 新建、去连接器页 |
| SPEC-videos-18.16 | 还没有账户数据 | 「还没有账户数据」「每天自动拉一次；现在要看就点「刷新数据」……」 | 刷新数据 |
| SPEC-videos-18.17 | 被限频、风控 | B 站回 -412、-352、-509、-799 或要验证码：之后一段时间不发任何 B 站请求（第一次 2 分钟，连着被拦每次翻倍，最多 2 小时；要验证码的至少 30 分钟），账号条下面橙色条「B 站请求暂停到 MM-DD HH:mm，期间不发任何请求，到点后自动恢复。原因：B 站网页接口返回 -412：请求被拦截（被限频或风控……）」；要验证码的原因写「本工具不绕过验证码：到浏览器里打开 B 站完成验证后再试」。期间刷新、查私信、发送都直接回这条说明，不出网；到点后成功一次自动清掉 | 等到点；要验证码的去浏览器完成验证 |
| SPEC-videos-18.18 | 登录失效 | Cookie 过期或被踢：账号状态「登录已失效」，连接器置为异常「B 站登录已失效，到「视频 / B 站」重新扫码登录」，后台不再拉；页面换成扫码登录，标题「登录已失效，重新扫码登录」 | 重新扫码 |
| SPEC-videos-18.19 | 还没有私信会话 | 会话列表「还没有私信会话，点「查新私信」拉一次」；右边「选一个会话看消息」 | 查新私信 |
| SPEC-videos-18.20 | 连接器暂停、断开 | 请求回「连接器「名称」已暂停 / 已断开」；断开会一起清掉登录凭证 | 去连接器页启用，重新扫码 |

### 数据

正式版：连接器 `bilibili_web`（插件 `video` 登记，认证方式 `none`，没有表单字段）；登录凭证经内核 `Connectors().SaveSession` 存进实例的保险箱条目（键 `_web_cookie`、`_web_csrf`、`_web_refresh`，不出脱敏提示），审计只记键名。插件表 `video_bili_profiles`（公开资料、登录状态、退避）、`video_bili_snapshots`（一天一行的账户数据）、`video_bili_trends`（创作中心按天增量）、`video_bili_sessions`、`video_bili_messages`（`bpm_` 前缀，`client_msg_id` 防重复提交）；接口见 `docs/api-contract.md`「B 站组件（TSK-0455）」。原型的数据都在 `videobili.tsx` 里，刷新回到演示数据。

### 联动

| 方向 | 对方模块 | 触发 | 结果 | 见 |
|---|---|---|---|---|
| 进来 | 设置 / 连接器 | `bilibili_web` 实例的建、暂停、断开、删除 | 有没有这个账号；断开清掉登录凭证 | `SPEC-settings` 连接器 |
| 进来 | 设置 / 连接器 | 开放平台 `bilibili` 实例接着、昵称和网页端账号一样 | 粉丝、关注、过审稿件数取开放平台 | `18.7` |
| 出去 | 通知 | 后台拉到新私信 | 一条通知「B 站新私信」「「昵称」等 N 人发来 M 条私信」，不带消息内容 | `18.10` |
| 出去 | 设置 / 连接器 | 登录、退出、登录失效、连不上 | 连接器的状态和异常说明跟着变 | `18.4`、`18.18` |
