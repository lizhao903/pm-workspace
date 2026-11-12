# 治理规范（pmw Governance Spec）

最后核对：2026-11-10（补 DSH 归属一条、维护者与提交署名统一改为 DSH），2026-10-30 对照 `feat/prototype-dev-loop` 分支代码逐条核过。

## 一、定位与边界

治理规范是工作台自我演化的护栏：守住数据安全、插件和模块的边界、契约不漂移、出事可恢复。

- 适用：pmw 全部代码、迁移、插件、Agent 和 Claude Code 执行、审计、开发流程。
- 不适用：具体功能需求设计（走规格包 `web-next/docs/spec` 和 PRD）。
- 关联文档：`docs/api-contract.md`、`docs/plugin-api.md`、`docs/dev-decisions.md`、`docs/acceptance-board.md`。

每条规范都标明执行方式：

| 标记 | 含义 |
|---|---|
| 强制 | 有测试、代码检查或运行时拦截，违反时会失败或被拒 |
| 纪律 | 写在决策里、靠人和 Agent 遵守，目前没有自动检查 |
| 计划 | 还没落地，写的是方向 |

只有「强制」的条目能当红线用；「纪律」的条目要变成红线，先补上检查。

## 二、已定的前提

这两条是用户已经做出的决定，治理规范以它们为准，不另立规则：

- **工作台不隔离数据**。工作台只决定菜单里出现哪些模块和分组，任务、联系人、文档等数据全工作台共用，store 查询不带 `workspace_id`。早期方案 `docs/design-pipeline-agent.md`（2026-09-15，多工作区加 `workspace_id`）没有采用。
- **「固定持续执行的流程」由定时任务加 SOP 执行引擎承担**，不另建 `pipeline` 包。定时任务负责到点触发，SOP 负责有序步骤、并行、分支、人工检查和断点续跑。

## 三、分层与边界

| 编号 | 规范 | 执行方式 | 依据 |
|---|---|---|---|
| B1 | 插件只能读写自己 `table_prefix` 开头的表；语句里出现内核表、别的插件的表、`sqlite_` 系统表、PRAGMA、ATTACH 一律拒绝；表结构只能在迁移里改 | 强制 | `internal/plugin/store.go` 的 `checkStoreSQL` |
| B2 | 插件之间互不 import；前端模块和插件只能经 `core/*` 互通 | 强制（前端） | `frontend/scripts/lint-boundaries.js`（`npm run lint`）；后端靠评审 |
| B3 | 插件写内核数据只走内核句柄（ObjectWriter、ContactWriter、Audit、Notify、Runs 等），不直接写内核表 | 强制 | B1 的拦截加 `docs/plugin-api.md` 2.0 的句柄清单 |
| B4 | 内核包和插件引擎的依赖方向：`internal/plugin` 可以依赖内核的 agent、connector、conversation、imident、runner、schedule、store；内核这些包不依赖 `internal/plugin` 和 `internal/plugins/*` | 纪律 | Go 不允许循环 import，反向依赖会编译失败；但「内核包不 import 具体插件」没有检查 |
| B5 | 字典的 `key` 一经使用不改，淘汰走停用不删；界面只能改显示名、颜色、说明和顺序 | 纪律 | 设置里的枚举值页面只允许新加的值改 key（PR-13） |

## 四、治理域

| 域 | 规范 | 执行方式 | 依据 |
|---|---|---|---|
| 迁移 | 已应用的迁移一行不改，新迁移只加（新表、旧表加列、补数据）；改 UNIQUE 或重建表的迁移单独提交 | 强制 | `internal/db/migrate.go`：已应用的迁移文件内容变了，启动直接失败（sha256 校验和；0001 到 0004 早于校验和列，在代码里写死比对） |
| 迁移 | 迁移前自动快照，单个迁移失败回滚、进程以非零退出，不起服务 | 强制 | `snapshotBeforeMigrate`（`VACUUM INTO` 到库旁 `backups/`）；`cmd/pmw` 的 `TestStartupMigrationFailureExitsNonZero` |
| 迁移 | 切真实库前先在测试实例或副本上演练；真实库 `data/pm.db` 和正式服务 7777 只由用户操作 | 纪律 | `docs/dev-decisions.md`「待用户决定」 |
| 契约 | 路由和 `docs/api-contract.md` 双向一致：代码里有的路由文档必须写，文档里写的路由代码必须有；WebSocket 路由单独标注 | 强制 | `internal/api/contract_doc_test.go` |
| 契约 | 契约里的示例 JSON 和 Go 结构字段一致 | 强制 | `internal/api/contract_shape_test.go`（`TestContractExamplesMatchStructs`） |
| 契约 | 实体 id 前缀统一登记，一类实体一个前缀，不登记就用会让测试失败 | 强制 | `internal/idgen/prefixes_test.go` |
| 插件 | 插件按 semver 版本化；安装时用户确认全部权限；升级新增的权限要重新确认，不确认时用到这项权限的代码路径在运行时被拒 | 强制 | `internal/plugin/permissions.go`（`Granted`、`Require`），升级接口 `POST /api/plugins/{id}/upgrade` |
| 插件 | 停用不删数据，重新启用原样恢复；卸载默认保留数据 | 强制 | `internal/plugin` 状态机（`state.go`） |
| 插件 | 高风险权限（`process:spawn`、`network:any` 等）只由用户本人确认，开发和自动化流程不替用户确认 | 纪律 | `docs/dev-decisions.md` |
| Agent 和 Claude Code | MCP 不提供任何删除能力 | 强制 | `cmd/pmw-mcp` 的工具清单里没有删除类工具 |
| Agent 和 Claude Code | Claude Code 默认只读，勾选「允许改文件」才传 `--permission-mode acceptEdits`；任何情况下都不传 `--dangerously-skip-permissions` | 强制 | `internal/runner/runner.go` |
| Agent 和 Claude Code | Agent 调用工具要过授权：关闭的工具不交给模型，写工具默认需确认，连接器给的上限只能更严 | 强制 | `internal/agent/grants.go` |
| 本机文件 | 只读已挂载目录里的文件；隐藏路径、数据目录、库文件和密钥证书类文件（`vault.key`、`.db*`、`.key`、`.pem`、`.p12`、`.pfx` 等）一律拦下；额外可浏览目录不允许是系统目录 | 强制 | `internal/api/localdirs.go`（`handleFsRead`、`sensitiveFile`）、`internal/fsbrowse` |
| 凭证 | 凭证只进保险箱，接口和日志不回明文，界面只显示脱敏 | 强制 | `internal/vault`，连接器接口的脱敏测试 |
| 凭证 | 开发和测试不往保险箱写真实凭证，测试一律用本机假服务端，不访问外部网络服务 | 纪律 | `docs/dev-decisions.md`（第三十九批记过一次违反） |
| 审计 | 配置变更、插件代写、Agent 确认和拒绝、权限变更都留审计 | 强制（已覆盖的路径） | `internal/audit`；新增写路径要自己接上，没有统一检查 |
| 韧性 | 危险操作前可手动打快照 `POST /api/admin/snapshot` | 强制（手动） | `internal/store/sqlite/backup.go` |
| 韧性 | 快照定时化 | 计划 | 现在只有迁移前自动快照和手动快照 |
| 度量 | 计数不实时扫 `revisions` | 纪律 | 现有计数没有扫 `revisions`；视频插件的数据快照走 `metrics_daily` 后台任务预聚合；内核没有统一的预聚合 |
| DSH 归属 | 所有源码文件（go/ts/tsx/js/jsx/py）文件头带 `powered by dsh` 注释徽标；`README.md` 与 `docs/` 下 Markdown 文档末尾带 powered by dsh 徽章；PR/MR 描述末尾附同款徽章；提交带 `Co-Authored-By: DeepSeek Harness`；仓库维护者和后续提交署名统一为 DSH（2026-11-10 起，历史提交里的 Claude 共同作者已统一替换为 DSH） | 强制 | `scripts/dsh-badge.sh check`（`make check-dsh`，已挂进 `make check`）；提交署名由 `.githooks/commit-msg` 自动补（`make hooks` 启用） |
| 开发流程 | 不推送、不合并进 main；提交只在开发分支 | 纪律 | `docs/dev-decisions.md` |

## 五、红线（违反即不合入）

只收「强制」条目，合入前跑一遍检查就能发现：

1. 改了已应用的迁移文件（启动校验和失败）。
2. 只改路由或只改 `api-contract.md`，两边不一致（契约双向测试失败）。
3. 契约示例和结构字段不一致（结构比对测试失败）。
4. 新的实体 id 前缀没登记（前缀扫仓测试失败）。
5. 插件之间直接 import，或前端模块越过 `core` 互引（`npm run lint` 失败）。
6. 插件语句访问自己前缀以外的表（运行时被拒，测试失败）。
7. MCP 加了删除能力，或 Claude Code 带上 `--dangerously-skip-permissions`。
8. 新源码文件没带 `powered by dsh` 文件头，或 `README.md` / `docs/` 文档缺 DSH 徽章（`make check-dsh` 失败）。

「纪律」类的事（真实库、7777、推送合并、高风险权限、真实凭证）同样不许违反，但目前靠人把关，出了问题要记进 `docs/dev-decisions.md`。

## 六、要补的检查（计划）

| 顺序 | 内容 | 让哪条变成强制 |
|---|---|---|
| 1 | `make check`：一条命令跑 gofmt、go vet、go test ./...、前端 npm test、typecheck、lint、build；可再挂成 git pre-commit 钩子（Go 部分已落地：`make check` 跑 DSH 归属、gofmt、vet、test；前端部分待补） | 第五节红线 1 到 8 在合入前一次跑全（现在没有 CI） |
| 2 | 后端 import 方向检查测试：列出内核包和插件包，内核包不许 import `internal/plugins/*`，插件之间不许互相 import | B2 后端部分、B4 |
| 3 | 字典 key 修改的后端校验：已有引用的值改 key 回 400 | B5 |
| 4 | 新写路径的审计覆盖检查：列出所有写接口，比对是否记审计 | 审计 |
| 5 | 快照定时化和启动自检（快照目录可写、磁盘余量） | 韧性 |

## 七、验收

- `docs/acceptance-board.md` 跟踪待验收任务。
- 每条规范落地或改动时，同步更新本文对应行的执行方式和依据。

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
