# 权限与安全参考

> 状态：**P1-a 已实现**（`internal/pluginhost/broker.go` 按「声明 + 已授予」校验）；
> 本文是 `docs/plugin-spec-v2.md` 第 5、12 节的开发速查，冲突时以规范为准。
> 一句话：外部插件是**不受信任的本机代码**，靠进程隔离 + 最小权限 + 用户逐项确认，不做「绝对安全」承诺。

## 1. 两个原则

1. **最小权限**：只申请代码真正用到的权限；每项权限在 `permissions_reason` 写 1–80 字中文理由。
   评审会逐项对照代码，用不到的权限要求删掉。
2. **运行时强制，不靠自觉**：宿主 broker 对每个 `host.*` 调用检查「清单声明 + 用户已授予」；
   未声明直接回 `permission_denied`。插件上报的权限状态只用于展示，不能当授权依据。

## 2. 隐式权限（不写进 `permissions`）

| 能力 | 说明 |
|---|---|
| `store:plugin` | 宿主给每个插件一个独立 SQLite 库，只能经 `host.store.query/exec` 访问；不能直连内核库、拿不到 `table_prefix` |
| `log:write` | 插件 stdout/stderr 与日志由宿主收集；日志统一脱敏 |
| 自己的数据/缓存目录 | `PMW_PLUGIN_DATA_DIR` / `PMW_PLUGIN_CACHE_DIR` 内读写不需要 `fs:*` 权限；缓存删了不丢数据 |
| `host.settings.get/set` | 插件自己的设置值，天然隔离 |
| `host.i18n` | 宿主文案/格式化，不带数据 |
| 发布自己声明的事件 | 只允许 `emits` 里的事件 |

把隐式权限写进 `permissions` 反而是**非法清单**（`validate` 直接报错，schema enum 也不含它们）。

## 3. 可申请权限

| 权限 | 能做什么 | 风险 | 备注 |
|---|---|---|---|
| `objects:read` | 只读内核对象、联系人、会话（`host.objects/contacts/conversations.*`） | 普通 | |
| `objects:write` | 建对象、改**本插件创建的对象**（`host.objects.create/update`）；改不了内核或别的插件建的对象 | 普通 | |
| `events:subscribe` | 订阅内核事件/依赖插件事件 | 普通 | 订阅清单必须写进 `subscribes`，且双向一致 |
| `fs:read:project` | 读项目根目录内文件 | 普通 | |
| `fs:write:project` | 写项目根目录内文件 | 普通 | |
| `fs:read:attachments` | 读附件目录 | 普通 | |
| `fs:write:attachments` | 写附件目录 | 普通 | |
| `fs:read:any` | 读本机任意路径（文件选择器里用户当场选的除外） | 高 | 是否单独授权待 P1 安全评审确认 |
| `fs:write:any` | 写本机任意路径 | **高（单独授权）** | 安装/升级都不授予；装后单独申请 + 二次确认 |
| `network:localhost` | 访问回环地址与本机域名 | 普通 | |
| `network:im` | 访问 IM 平台接口域名 | 普通 | |
| `network:media-platforms` | 访问视频/内容平台 | 普通 | |
| `network:github` | 访问 GitHub Release 接口（只拉公开仓库匿名 API） | 普通 | 只 `api.github.com`，匿名 API 每小时 60 次限流 |
| `network:market-data` | 访问行情源公开接口 | 普通 | |
| `network:model` | 下载本地模型（HuggingFace 与镜像） | 普通 | |
| `network:exchanges` | 访问交易所账户/交易接口 | 普通 | 高风险边界待 P1 评审确认 |
| `network:any` | 访问任意外网地址 | **高（单独授权）** | |
| `process:spawn` | 起子进程 | **高（单独授权）** | |
| `agent:run` | 用宿主 Agent/模型跑 LLM（消耗额度、对外发送数据） | 普通 | |
| `notify` | 以插件名义发系统通知 | 普通 | |
| `schedule` | 向宿主调度器登记一次性/周期任务 | 普通 | |
| `artifacts:write` | 登记产物（本地文件） | 普通 | |
| `audit:write` | 往审计日志写插件替用户做的对外动作 | 普通 | |
| `trade:live` | 实盘下单 | **最高** | **v0.1 外部插件一律不授予**；声明不阻塞安装但目录评审不接受；`validate` 给警告，`--strict` 失败 |
| `secrets:<scope>` | 读写指定 scope 的凭证 | 按 scope 定 | scope 是 `^[a-z][a-z0-9_]*$`；每个 scope 一条独立理由 |

格式 `<类别>:<动作>[:<范围>]`；未知权限非法。

## 4. 授权与拒绝语义

1. **安装/升级时确认非高风险权限**：安全预览列出全部权限 + 中文理由；用户确认的是**非高风险**权限列表，
   随安装请求提交；没确认的不写进授权记录。高风险项只列出来、不在安装时授予。
2. **高风险安装后单独申请**：`fs:write:any`、`network:any`、`process:spawn` 安装和升级都**不授予**；
   装好后由用户本人在插件设置里逐项申请 + 二次确认（输入插件名/勾选风险说明）才授予，可随时收回。
   未授予期间相关能力在 RPC 层返回 `permission_denied`。
3. **升级新增权限**：列新增项要求确认（仅非高风险项）；用户拒绝则升级不生效（版本和权限集都不变），
   需要新权限的代码路径在运行时被拦；减少的权限直接收回。
4. **`trade:live`**：安装、升级都不授予、也不要求确认；v0.1 外部插件一律不授予，评审不接受。
5. **运行时强制**：`host.*` broker 检查「清单声明 + 用户已授予」；未声明能力直接 `permission_denied`。
6. **收回**：用户随时可收回单项权限（含单独授权的）；宿主发 `plugin.permission_changed` 通知，插件应立刻降级而不是继续重试。
7. **卸载**：删安装记录、单独授权；**默认保留插件数据**，二次确认才删。

`permission_denied` 的 `data`（设计）：`{ "permission": "objects:write", "declared": false, "granted": false }`。
插件应当优雅降级：相关页面显示不可用原因，不要循环重试；宿主对同一权限连续拒绝会记审计并提示用户。

## 5. 清单与权限一致性（`validate` 会查的部分）

| 条件 | 规则 |
|---|---|
| `provides.modules` 非空 | 必须有 `runtime.web` |
| `provides.connectors` 非空 | `permissions` 至少一项 `network:*` |
| `subscribes` 非空 | 必须有 `events:subscribe`；反之声明了 `events:subscribe` 就必须有订阅 |
| 有权限 | `permissions_reason` 一一对应，1–80 字中文 |
| 调 `host.agent.run` | 清单必须声明 `agent:run`（代码级，评审检查） |
| 调 `host.schedules.enqueue` | 必须声明 `schedule`（代码级，评审检查） |
| 调 `host.artifacts.add` / `host.audit.record` | 分别需要 `artifacts:write` / `audit:write`（代码级） |
| 调 `host.http.request` | 目标组必须是已声明的 `network:<group>`；`network:any` 例外放行全部 http(s)（代码级） |

`validate` 只能静态检查清单；**代码里实际调了哪些 `host.*`** 靠评审对照权限清单确认。

## 6. 安全边界：插件能 / 不能

### 不能

- 不能直连内核 SQLite、读凭证保险箱、读 `vault.key`、拿内核 `table_prefix`。
- 不能继承宿主的 vault/凭证/DB 路径环境变量；env 只有 `backend.md` §1 的白名单。
- 不能把安装目录当可写目录（安装后只读）；写文件只能写自己的数据/缓存目录或有权限的路径。
- 不能绕过 broker 直连数据库/网络（声明了 `network:*` 的插件进程本身可以出网，但宿主不承诺流量审计，P2 起改走宿主代理 allowlist）。
- 不能在前端加载远程代码、`eval`、追加第二个应用、读写别的插件 DOM、覆盖宿主全局样式。
- 不能打包挖矿/后门、静默外传数据、把密钥写进配置或仓库。
- 不能申请 `trade:live`（v0.1）。

### 能

- 通过 `host.*` 在用户确认的权限范围内读写对象/联系人/会话、私有库、项目/附件文件、网络、通知、调度、产物、审计。
- 通过 `host.secrets.*` 读写自己声明的 `secrets:<scope>`（密钥由宿主保险箱管理，不进配置/日志）。
- 用宿主 Agent 跑 LLM（`agent:run`，消耗额度、对外发送数据，权限页会写清）。
- 用 `host.settings.*` 存自己的设置；用 `PMW_PLUGIN_DATA_DIR` / `PMW_PLUGIN_CACHE_DIR` 存数据/缓存。

## 7. 评审清单（发布到目录前）

- [ ] 权限逐项最小化，每项理由和代码用途对得上；没有「以后可能用到」的权限。
- [ ] 没有硬编码密钥/token；凭证通过 `host.secrets.*`，不进配置、日志、仓库。
- [ ] 没有静默外传：所有出网都有对应 `network:*`，并在 README 写清用途。
- [ ] 没有绕过 IPC 直连 DB、没有 `ATTACH`、没有字符串拼 SQL。
- [ ] 迁移只作用于插件私有库，没有破坏性操作；卸载默认保留数据。
- [ ] 崩溃/权限收回/宿主不可用时能降级，不循环重试、不刷日志。
- [ ] 前端错误边界、CSS 作用域、无远程脚本/`eval`、无自带 React。
- [ ] 依赖许可证兼容；`LICENSE` 与清单 `license` 一致。
- [ ] `plugin-sdk` 的 `validate`（可加 `--strict`）通过；`self-test` 通过。
- [ ] README 写清功能、权限用途、数据存哪、卸载行为。

### 红线（评审直接拒绝）

1. 未声明权限偷偷用、或把权限当摆设绕过 broker。
2. 破坏宿主数据（内核库/表、凭证、别的插件数据）。
3. 绕过 IPC 直连 DB、起后门监听、打包挖矿/后门。
4. 需要 `trade:live`（v0.1 不接受）。
5. 源码仓库提交混淆/压缩后的后端二进制，或无法复现构建。

## 8. 给开发者的提示

- 先写 **只读 + 无权限** 的最小版本（一个模块页 + 一张卡片），跑通 validate/pack 后再逐项加权限。
- 加权限的顺序：`objects:read` → `notify` → `host.settings`（无需权限）→ 需要时再加网络/文件。
- 调试时不要为了图省事申请 `network:any` / `fs:write:any`；先用最小 scope，评审时再解释。
- 权限理由写给用户看：「展示最近对象标题」比「读取数据」有用；写清影响范围和不申请的后果。
