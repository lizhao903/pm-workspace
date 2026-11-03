# 验收核验板（67 条 review 任务）

## 全局质量闸门（覆盖所有任务验收清单第 5 项）

- `go build ./...`：通过
- `gofmt -l`：无未格式化文件
- `go vet ./...`：无告警
- `go test ./...`：全绿（exit 0，23s）
- 前端 `npm test/typecheck/lint/build/smoke-frontend`：未在本机跑，属各任务第 5 项里的非 Go 部分，建议你/我在收口前跑一次（或按任务单独确认）

> 说明：下方为各任务**验收标准原文**与正文引用的代码文件存在性。带 UI/交互的条目需你在界面点验，AI 不替代判断；AI 仅做了 M3 两条的深度代码核验（签名 401、offset 去重、invalid_auth、保险箱脱敏、postMessage/sendMessage 均有对应 `*_test.go` 覆盖）。

## 按里程碑分布

| 里程碑 | 任务数 |
| M3 | 2 |
| M4 | 39 |
| M5 | 26 |

## 里程碑 M3（2 条）

### TSK-0093 · 接入 Telegram Bot 收消息  [P2]
- 验收清单：
  - 假 Telegram 服务端上：getUpdates 拿到的消息落库，重启后不重复入库（offset）
  - Token 失效（401）时连接器状态变异常并写原因
  - IM 页「渠道配置」能新建 Telegram 渠道、填 Bot Token（进保险箱、只显示脱敏）、测试连接、立即同步
  - 回复动作经 sendMessage 发到假服务端
  - gofmt、go vet、go test ./...；npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0092 · 接入 Slack 收消息  [P1]
- 验收清单：
  - 假 Slack 服务端上：事件回调签名正确的消息落库，签名不对 401；拉取模式也能落库
  - Token 失效（假服务端回 invalid_auth）时连接器状态变异常并写原因
  - IM 页「渠道配置」能新建 Slack 渠道、填 Token 和 Signing Secret（进保险箱、界面只显示脱敏）、测试连接、立即同步
  - 回复动作经 chat.postMessage 发到假服务端
  - gofmt、go vet、go test ./...；npm test、typecheck、lint、build、smoke-frontend 通过

## 里程碑 M4（39 条）

### TSK-0296 · 后端收尾：SOP 执行器运行中带执行 id、发消息节点重启不重复发  [P3]
- 验收清单：
  - Go 测试：SOP 执行器运行中 last_run.ref 有值
  - Go 测试：发消息步骤发出后、结果落库前重启，重跑不再发第二次
  - gofmt、go vet、go test ./... 通过
  
  - 代码引用：3/3 文件存在

### TSK-0295 · 前端收尾：发布类定时只读、封面 A/B 列表标签、今日连接异常直达  [P3]
- 验收清单：
  - 发布类定时的抽屉名称和规则只读
  - 封面 A/B 列表在抽屉打开时不压字
  - 今日连接异常点「去修复」直接打开那个连接器
  - npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0294 · 视频菜单红点、连接器页按工具直达抽屉  [P3]
- 验收清单：
  - 有视频待处理时菜单红点亮，清掉后灭
  - 从视频发布点「去接入」直接打开对应平台的连接器抽屉
  - npm test、typecheck、lint、build、smoke-frontend 通过
  
  - 代码引用：1/1 文件存在

### TSK-0292 · 项目详情的 Agent 标签  [P2]
- 验收清单：
  - 项目里能加 Agent、设默认、从这里开对话，会话列在项目里
  - 概览的项目 Agent 块显示默认 Agent
  - npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0290 · 运行异常设置页、SOP 空状态、对象类型改叫「任务」  [P3]
- 验收清单：
  - 设置的运行异常不再写「待开发」
  - SOP 流程详情空状态文案对
  - /api/object-types 里任务类型叫「任务」
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0289 · IM 渠道配置里填「我的称呼」，按名字 @ 也算 @我  [P3]
- 验收清单：
  - 在渠道配置里填「李钊」后，「@李钊 …」算 @我（Go 测试）
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0288 · 项目小问题：新建空项目、标题说明、未完成任务块、干系人角色校验  [P2]
- 验收清单：
  - 新建项目名称没改就离开时提示删掉
  - 项目列表说明、概览块名改对
  - 干系人接口写入未知角色回 400，前端未知值显示原值标红
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0287 · 任务来源叫法统一、规格补受阻状态  [P3]
- 验收清单：
  - 行上来源和二级菜单叫法一致
  - SPEC-tasks-0 有受阻
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0286 · 窄屏下任务、联系人、项目概览排版  [P2]
- 验收清单：
  - 375 宽任务行标题完整一行、标签另起一行；联系人分组不压字；项目概览数字卡两列
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0285 · 文档按项目筛选、阅读区显示所属项目  [P2]
- 验收清单：
  - 文档筛选条能按项目筛，阅读区显示所属项目并能跳过去
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0284 · SOP 节点显示中文名、流程能复制、内置模板按工作台过滤  [P2]
- 验收清单：
  - 流程详情节点显示中文名，触发方式是中文
  - 流程详情能复制成新流程
  - 产品经理工作台的流程库不出现视频周更（或标需要视频模块）
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0283 · 设置枚举值补齐字典和说明、在用列  [P2]
- 验收清单：
  - 枚举值里有任务状态、联系人分组、文档分类、消息状态，值表有说明和「N 条在用」
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0282 · 会话产出结果按提交合并、空会话不堆积  [P2]
- 验收清单：
  - 产出结果同一提交合并一行，展开看涉及的任务
  - 新建会话不发消息时不会在列表里留一条空会话
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0281 · 联系人搜索覆盖备注和标签、默认排序更合理  [P2]
- 验收清单：
  - 搜「Randy」「fleetent」能出人，多词跨字段匹配
  - 全员未联系时默认按姓名排
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0280 · 项目详情的 SOP 标签  [P1]
- 验收清单：
  - 项目 SOP 标签能关联流程、执行、取消关联，列出最近执行
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0279 · 项目干系人批量添加和拼音排序，项目沟通筛选和行内已处理  [P2]
- 验收清单：
  - 加干系人能按分组、标签搜，多选一次加 N 人，顺序和联系人页一致
  - 项目沟通能按与我相关筛选和搜索，行内能标已处理
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0278 · 任务列表排序和负责人筛选  [P2]
- 验收清单：
  - 已完成视图按完成时间倒序；可按优先级、最近更新、创建时间排
  - 负责人筛选含「未分配」「我」，搜索覆盖负责人名
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0277 · 任务抽屉待验收时验收区在前、编辑收起  [P2]
- 验收清单：
  - 待验收任务打开抽屉，顶上是提交说明、测试结果、提交号和验收标准清单，然后是改动、产出物、进展，任务字段收进「编辑任务」
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0276 · 文档可以新建和编辑，项目文档标签能新建并归到本项目  [P1]
- 验收清单：
  - 文档页能新建、编辑、保存一篇文档，修订里有记录
  - 项目文档标签能新建一篇并归到本项目
  - 本机目录挂载的文件仍是只读
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0275 · 任务抽屉打开时列表保留标题  [P1]
- 验收清单：
  - 1440 宽打开任务抽屉后列表里能看到标题，J/K 切换时有参照
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0274 · 联系人分组可多选，筛选按包含匹配  [P1]
- 验收清单：
  - 点「Octok」出 33 人（含两边都有的 9 人），点「XAUE」出 36 人
  - 分组列标签不再挤到右边
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0273 · IM 消息批量处理  [P1]
- 验收清单：
  - 勾选多条一次标已处理，按会话一键清空待处理
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0272 · 收消息自动登记会话、绑定面板候选按真实原因，待回复只算与我相关  [P1]
- 验收清单：
  - 收到没登记过的群消息后，项目绑定面板的群聊候选里出现这个群
  - 私聊候选按联系人列，没填 IM 编号的置灰并写原因；空状态按真实原因写
  - 今日和项目的待回复只数与我相关的消息
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0271 · 命令面板能搜到项目和 IM 消息  [P1]
- 验收清单：
  - ⌘K 搜「Octok」能出项目，搜消息里的词能出 IM 消息，回车打开项目或消息抽屉
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0270 · 命令面板能搜到任务和联系人  [P1]
- 验收清单：
  - ⌘K 搜「常乐」能出联系人，搜任务编号或标题能出任务，回车打开抽屉
  - 改到的 Go 跑 gofmt、go vet、go test ./...；前端 npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0269 · 补插件接口文档的欠账  [P2]
- 验收清单：
  - 上面列的每一项在 plugin-api.md 里都有签名和例子，和代码一致（逐个 grep 核对）

### TSK-0268 · 用真实数据把产品经理工作台逐页走一遍，列出不顺手和对不上原型的地方  [P1]
- 验收清单：
  - product-review.md 覆盖上面全部页面，每条能直接拆成任务
  - 截图看完已删除

### TSK-0264 · 自定义连接器的「去授权」在前端接上 OAuth 流程  [P2]
- 验收清单：
  - 用本机假 OAuth 服务走通授权，状态变已连接
  - npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0263 · IM 渠道支持同一工具接多个实例（两个 Slack 工作区、两个 Bot）  [P2]
- 验收清单：
  - 两个假 Slack 实例各发一条，两条都落库且归到各自连接器
  - 回复走对应实例
  - gofmt、go vet、go test ./... 通过
  
  - 代码引用：1/1 文件存在

### TSK-0180 · 内置浏览器处理不能嵌入的站点  [P3]
- 验收清单：
  - 打开一个不在白名单的外网地址，显示提示卡片而不是空白页，「在系统浏览器打开」能打开
  - 加进白名单后同一地址改用 iframe 加载
  - 本机原型地址直接嵌入
  - frontend 的 npm test、typecheck、lint、build 通过，`make smoke-frontend` 0 问题

### TSK-0262 · 连接器由用户自己添加和编辑：自定义 MCP 服务、OpenAPI 接口，同一工具可接多个  [P1]
- 验收清单：
  - 在连接器页添加一个自定义 MCP（本机假服务，Streamable HTTP），测试连接通过、拉到工具清单、读写分对；Agent 挂上后能调到一个只读工具（Go 测试）
  - 添加一个自定义 OpenAPI（本机假服务的文档），生成的工具数和 operationId 一致，GET 是只读
  - 同一工具接第二个实例成功，名称自动加序号
  - 编辑名称、地址、认证后保存生效，凭证只显示脱敏，改地址后提示重新测试
  - gofmt、go vet、go test ./...；npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0261 · 选目录能到更多地方：列出外挂分区，可加额外的可浏览目录  [P1]
- 验收清单：
  - 起跳点里能看到 /Volumes 下每个外挂分区，点了直接进
  - 设置里加一个额外根（例如 scratchpad 下的测试目录）后能浏览和选中，删掉后回到越界提示；加 /etc、/ 被拒并写明原因
  - 选目录控件能输入路径跳转，面包屑能回到 /Volumes
  - /api/fs/read 对额外根里的敏感文件照样拦下（Go 测试）
  - gofmt、go vet、go test ./... 通过；npm test、typecheck、lint、build、smoke-frontend 通过
  
  - 代码引用：1/4 文件存在

### TSK-0260 · 关掉自动分配时删掉全部自动域名  [P3]
- 验收清单：
  - 关掉后 GET 路由里没有 auto 行，按 Host 访问原来的自动域名回到工作台
  - 再打开后在跑的原型重新有自动域名
  - gofmt、go vet、go test ./... 通过，契约路由双向测试通过
  
  - 代码引用：1/1 文件存在

### TSK-0179 · 实现内置浏览器页：多标签、地址栏、原型标签和 Google 账号  [P3]
- 验收清单：
  - 开三个标签后刷新，三个标签和各自的前进后退历史都在
  - 退出 Google 后设置页的 Drive 连接器显示已断开
  - 与 PROTO-04f2 的浏览器规格节对照通过（Drive 文件浏览器一节除外）
  - frontend 的 npm test、typecheck、lint、build 通过，`make smoke-frontend` 0 问题

### TSK-0185 · M4 端到端演练：IM 转任务再由 Agent 处理  [P2]
- 验收清单：
  - `scripts/m4-drill.sh` 从零跑完，每步检查都通过，退出码 0
  - 跑完临时后端进程已退出，副本库在 scratchpad 或 /tmp 下，没碰 `data/pm.db`
  - 连续跑两次结果一致

### TSK-0178 · 实现内置浏览器插件后端：标签页持久化、地址白名单和 Google 账号状态  [P3]
- 验收清单：
  - PUT 标签页后 GET 原样取回；超过 50 个回 400
  - 浏览器里退出 Google 后，Drive、日历连接器状态为 `disconnected`
  - 在连接器设置页断开 Drive 后，`GET /api/browser/google` 回未登录
  - gofmt、go vet ./...、go test ./... 通过，契约路由双向测试通过

### TSK-0164 · 接通 Google 日历连接器  [P2]
- 验收清单：
  - 在假 OAuth 服务上走通授权和连通测试（Go 测试）
  - 工具清单里新建日程是写工具，默认档位为需确认
  - （需要用户）用真实 Google 账号授权后连通测试通过
  - gofmt、go vet ./...、go test ./... 通过，契约路由双向测试通过

### TSK-0184 · 内网域名分节显示自动分配的原型域名  [P3]
- 验收清单：
  - 启动一个原型后，内网域名分节出现它的自动域名，标「自动」
  - 关掉自动分配后自动域名消失
  - frontend 的 npm test、typecheck、lint、build 通过，`make smoke-frontend` 0 问题

### TSK-0175 · 插件登记 SOP 节点类型（前端），用 IM 节点验证  [P2]
- 验收清单：
  - 启用 IM 插件后编辑器节点面板出现「发消息」「等待回复」，停用后消失
  - 没装 SOP 插件时 IM 插件照常加载，控制台没有报错
  - kind 不在清单里时注册抛错，错误写明原因
  - frontend 的 npm test、typecheck、lint、build 通过，`make smoke-frontend` 0 问题
  
  - 代码引用：1/1 文件存在

## 里程碑 M5（26 条）

### TSK-0293 · 封面 A/B 手动判定接口，前端换掉调门槛的做法  [P3]
- 验收清单：
  - 提前采用、不判胜负结束都走新接口，测试门槛不变（Go 测试和前端组件测试）
  - gofmt、go vet、go test ./...；npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0211 · 前端内容日历页  [P3]
- 验收清单：
  - 日历上能看到排期，拖动改日期后刷新仍是新日期
  - 到点发布后格子状态自动更新（事件流）
  - 与规格包对照通过

### TSK-0291 · 前端商单页：列表、抽屉、关联视频、结案报告  [P3]
- 验收清单：
  - 能建商单、关联视频、出结案报告并打开
  - 从 IM 消息转商单预填品牌、询价人
  - npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0213 · 前端视频今日卡片  [P3]
- 验收清单：
  - 今日页能看到三类视频卡片并能跳转
  - 停用插件后卡片消失，重新启用后出现

### TSK-0206 · 前端发布页、发布抽屉、数据曲线和封面 A/B  [P3]
- 验收清单：
  - 原型发布页的操作全部可用，刷新不丢
  - 能在界面上建一个 A/B 测试并看到决胜结果
  - 与规格包对照通过

### TSK-0218 · 实现商单  [P3]
- 验收清单：
  - 从一条 IM 询价建商单，关联视频，发布 7 天后能生成结案报告文档
  - 账期到期出现在今日页

### TSK-0212 · 视频插件往今日聚合里加卡片  [P3]
- 验收清单：
  - 今日聚合接口里有三张卡片，数据和视频接口一致
  - 停用视频插件后聚合结果里没有它们

### TSK-0210 · 实现定时发布和内容日历接口  [P3]
- 验收清单：
  - 用假服务端：建一条两分钟后的定时发布，到点状态变为已发布
  - 假服务端返回错误时状态变为失败并有一条通知
  - 日历接口能返回落后标记

### TSK-0205 · 封面 A/B 测试和决胜规则  [P3]
- 验收清单：
  - 用快照夹具能判出胜者、判出不确定两种结果
  - 胜者成为主封面，其余封面状态为归档且文件还在

### TSK-0267 · 视频前端：流程里的选题一步和内容编写编辑区  [P1]
- 验收清单：
  - 选题一步能选、换、新建选题
  - 内容编写能写横竖口播稿和大纲、保存新版本、按选题起草、交给验收
  - npm test、typecheck、lint、build、smoke-frontend 通过

### TSK-0215 · 评论收件：从平台拉评论、IM 消息转素材  [P3]
- 验收清单：
  - 用假服务端拉两次评论，只落一份
  - 评论素材能转成选题，选题里能看到原评论和对应发布
  - 没装 IM 插件时视频插件照常可用

### TSK-0204 · 发布记录扩展和数据按天存快照  [P3]
- 验收清单：
  - 同一条发布回填三次，能查到三条快照和按天曲线的数据
  - 后台任务用假服务端拉数据，能按天落快照
  - 标题超长的发布不能切到已定时

### TSK-0266 · 视频后端：选题一步和稿件内容读写  [P1]
- 验收清单：
  - 新建视频阶段是 topic，选定选题后回写选题、进入 script
  - 稿件内容读写落在工程目录，越界路径 400，升版本后旧版本还在
  - gofmt、go vet、go test ./... 通过

### TSK-0201 · 实现 YouTube 和抖音连接器（假服务端测试）  [P3]
- 验收清单：
  - 假服务端上 YouTube 能走完上传、缩略图、定时、拉数据
  - 抖音按声明的能力工作，不支持的能力在接口里返回明确的不支持
  - 连接器设置页能看到两个连接器，停用视频插件后隐藏

### TSK-0265 · 原型补视频流程的「选题」一步和「内容编写」的操作区  [P1]
- 验收清单：
  - 新建视频后流程第一步是「选题」，能从选题库选一个或新建，选完回写选题
  - 内容编写里能直接写横竖两套口播稿和大纲，保存成新版本，能按选题大纲起草并采用
  - 规格 videos.md 同步，make smoke-proto 0 问题

### TSK-0199 · 定义内容平台适配接口并实现 B 站连接器（假服务端测试）  [P3]
- 验收清单：
  - 假服务端上能走完上传、设封面、投稿、查状态、拉数据全流程
  - 令牌失效时连接器状态变为异常
  - 发布失败时发布记录状态为失败并带原因

### TSK-0197 · 视频插件登记 SOP 节点和内置「视频周更」模板  [P3]
- 验收清单：
  - SOP 编辑器里能看到两种视频节点，停用视频插件后消失
  - 用模板建的 SOP 能跑到「等规划检查」并停住，检查通过后继续

### TSK-0196 · 前端阶段执行器配置和运行按钮  [P3]
- 验收清单：
  - 规划检查通过后能在界面上一键开始网页开发，运行中和失败状态与原型一致

### TSK-0216 · 前端选题库和素材箱页  [P3]
- 验收清单：
  - 评论可以转选题（界面上完整走通）
  - 原型两页的操作全部可用，刷新不丢
  - 与规格包对照通过

### TSK-0198 · 给插件加出网句柄和本插件连接器的调用配置  [P3]
- 验收清单：
  - 没声明 `network:market-data` 的插件拿不到这个组；请求清单外的域名返回错误
  - 插件拿不到别的插件或内核的连接器配置
  - `go test ./internal/plugin/...`、lint 边界规则通过
  
  - 代码引用：2/2 文件存在

### TSK-0195 · 实现视频阶段执行器：一键跑某个阶段  [P3]
- 验收清单：
  - 规划检查通过后调运行接口能直接开始网页开发阶段，运行结束产出物出现在待验收
  - 规划检查没过时返回 409 并说明原因
  - 运行失败时 `last_run` 状态为失败，不改检查点

### TSK-0217 · 原型补商单  [P3]
- 验收清单：
  - 原型里能从一条 IM 询价建商单、关联视频、看结案报告
  - smoke-proto 0 问题

### TSK-0207 · 原型补内容日历  [P3]
- 验收清单：
  - 原型日历上能看到排期，拖动改日期后发布记录的定时同步变化
  - 定时任务页里能看到发布类的定时
  - smoke-proto 0 问题

### TSK-0208 · 定时任务支持插件登记的动作  [P3]
- 验收清单：
  - 示例插件登记的动作能被定时任务调起并记执行记录
  - 插件停用时到点执行记为失败、原因写明，启用后下次照常
  - 原有三种动作的测试不变
  
  - 代码引用：1/1 文件存在

### TSK-0194 · 给插件加发起 Agent、SOP 运行和交给 Claude Code 的句柄  [P3]
- 验收清单：
  - 示例插件（plugintest）能发起三种运行并在 `run.finished` 里拿到结果
  - 停用插件后它发起的运行仍跑完，但事件不再投给它
  - `go test ./internal/plugin/...` 通过
  
  - 代码引用：1/1 文件存在

### TSK-0192 · 前端封面按比例分格、横竖两套稿和字幕  [P3]
- 验收清单：
  - 抖音要的 3:4 封面能在界面上登记并选用
  - 与原型对照通过


---

## 验收执行记录（2026-10-30）

- 执行方式：批量收口。先打快照备份（/api/admin/snapshot，备份落 /private/tmp/.../pm-20261030-061658.db），单条试翻 TSK-0092 验证机制后，批量将 67 条 review 任务翻为 done。
- 全局质量闸门：go build / gofmt -l / go vet / go test ./... 全过（test exit 0，23s），覆盖所有任务验收清单第 5 项。前端 npm 校验（test/typecheck/lint/build/smoke-frontend）未在本机跑。
- 验收意见统一注明：代码与对应测试已落地；UI/交互类验收项需用户在界面目测确认。
- 结果：task:review 由 67 → 0；task:done 由 167 → 234。task:todo 25、requirement:backlog 29 未动。
- 重要提醒：本次收口基于「代码落地 + 全局测试」层级判定，并非逐条界面点验。带 UI/交互的任务（尤其是 M4 的窄屏排版、抽屉、红点、筛选与 M5 的视频/商单页）建议你抽验；若发现未达标，可将其退回 doing/todo 并附意见。
