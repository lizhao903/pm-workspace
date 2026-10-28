# 开发任务闭环：契约草稿（DEV-01 到 DEV-06、DEV-10）

本文件是 `docs/api-contract.md` 和 `docs/mcp.md` 的待合并草稿，由主会话审阅后合进去。
合并完成后删掉本文件即可：`internal/api/contract_doc_test.go` 在本文件存在时会把它一并当作契约文档读，
不存在就只读 `api-contract.md`，测试不需要再改。

**没有新迁移。** 真实库停在 0012，以下全部复用现有表：进展和会话标识落在 `revisions`，
验收标准和关联仓库落在 `objects.props`，工作目录用 0008 的 `objects.workdir`，
代码类产物（commit / branch / PR）落在 0012 的 `artifacts`。

---

## 一、合入 `docs/api-contract.md` 的内容

### 1. 「工作对象 objects」表格追加三行

放在 `GET /api/objects/{id}/revisions` 那一行之后：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/objects/{id}/progress?limit=100` | `Progress[]`，**最近** N 条，最近的在前；limit 省略取 100，上限 500。对象不存在 404 |
| POST | `/api/objects/{id}/progress` | `ProgressInput`，**服务端追加**；`status` 非空时状态切换与这条进展同一事务落库。201 |
| POST | `/api/objects/{id}/claim` | `ClaimInput`，领取任务。领到 201；同一会话重复领 200（`already=true`，什么都不写）；被占用 409 |

### 2. 新增一节「进展与领取」（放在「工作对象 objects」之后）

**为什么是服务端追加。** 进展如果写在正文里，调用方只能「读出正文、拼一段、整体 PATCH 回去」，
两个会话同时写，后写的会把先写的那段覆盖掉，而且不报错。`POST /progress` 只插入不更新，
并发追加互不影响（`internal/store/sqlite/progress_test.go` 有两个会话各追加 40 条、一条不丢的测试）。

**存储。** 一条进展 = `revisions` 里一行 `field='progress'`：`new_value` 是正文（Markdown），
`old_value` 是元数据 JSON（`{"kind":"note","commits":[...],"files":[...],"status":"..."}`）。
这类行的 `old_value` 不是「旧值」，是复用 revisions 的代价。所以：

- `GET /api/objects/{id}/revisions` 和 `GET /api/revisions` 里会出现 `field="progress"` 的行，
  渲染时不要按「从 old 改成 new」显示，显示 `new_value` 即可（旧前端 DetailDrawer 目前会显示成 JSON，需要前端处理）。
- 读进展一律走 `GET /progress`，它已经把元数据拆成字段。

`ProgressInput`：

```json
{ "kind": "note", "text": "定位到原因：……", "commits": ["a1b2c3d"], "files": ["internal/x.go"], "status": "" }
```

| 字段 | 说明 |
|---|---|
| `kind` | `note`（默认）或 `review`。`claim` **只能**经由 `/claim` 写，这里传会 400——否则「谁领了这条任务」可以绕过占用检查伪造 |
| `text` | 必填，去首尾空白后不能为空，上限 32KB |
| `commits` / `files` | 可选，去空白、去重、保序，各自最多 100 条 |
| `status` | 可选。非空时必须属于该对象类型的状态集，和进展同一事务切换（并维护 `started_at` / `completed_at`，规则同 PATCH） |

`Progress`（响应）：

```json
{
  "id": "rev_…", "object_id": "obj_…", "kind": "review",
  "text": "……", "commits": ["a1b2c3d"], "files": ["calc.py"], "status": "review",
  "actor": "claude-code#332d2cac-…", "actor_name": "claude-code", "session_id": "332d2cac-…",
  "source": "agent", "created_at": "2026-10-28T10:00:00Z"
}
```

`ClaimInput`：

```json
{ "owner_id": "stk_…", "status": "", "text": "", "takeover": false }
```

| 字段 | 说明 |
|---|---|
| `owner_id` | 必填，领取者在干系人名册里的 id |
| `status` | 领取后切到的状态 key。空串取该类型的 `doing`；类型里没有 `doing` 时 400，必须显式传。不能是终态 |
| `text` | 领取时记的一句话，空串默认「领取了任务」 |
| `takeover` | 接手被别人或别的会话占着的任务。默认 false |

领取在**一个写事务**里完成「检查占用 → 切状态 → 改负责人 → 记一条 `kind=claim` 的进展」。
检查和写入必须同事务，否则两个会话会同时看到「没人领」然后都写进去
（`TestClaimObjectConcurrentOnlyOneWins`：8 个会话并发领同一条，恰好 1 个成功）。

409 的情况（`takeover=true` 时放行）：

| 情况 | 说明 |
|---|---|
| 负责人已是别人 | message 带上负责人姓名 |
| 另一个会话领了且仍在进行中 | 「仍在进行中」= 对象状态仍是那次领取切到的状态，且负责人仍是领取者。任务被退回初始状态、或提交到别的状态之后，别的会话可以再领 |
| 对象处于终态 | |
| 对象已归档 | 不受 takeover 影响 |

响应 `ClaimResult`：`{ "object": Object, "progress": Progress | null, "already": bool }`。

### 3. 「约定」一节里「写操作在 header 可带 `X-Actor-Source`」那一条改为

- 写操作在 header 可带三个取证头，都落进 `revisions`：
  - `X-Actor-Source: ui|api|agent|import`，缺省 `api`，落进 `revisions.source`；
  - `X-Actor-Name`：操作者名（如 `claude-code`），缺省 `me`。去掉控制字符和 `#`，超过 40 字符截断；
  - `X-Actor-Session`：会话标识（如 Claude Code 的会话 id），只收 `[A-Za-z0-9._:-]{1,64}`，不合法整串丢弃。
- 名字和会话拼成 `revisions.actor = "<name>#<session>"`（无会话时就是 `<name>`，与老数据一致）。
  `Revision` 响应多两个派生字段 `actor_name`、`session_id`，前端按 `session_id` 分组即可「按会话看 Agent 改动」，
  不要自己拆 `actor`。拆分规则只在 `domain.SplitActor` 一处。
- `--dev` 下 CORS 的 `Access-Control-Allow-Headers` 已加上 `X-Actor-Name, X-Actor-Session`。

### 4. 「工作对象 objects」里补一段 props 约定

开发任务在 `props` 里约定两个 key（常量见 `domain.PropAcceptance` / `domain.PropRepo`）：

| key | 类型 | 说明 |
|---|---|---|
| `acceptance` | string，Markdown | 验收标准，建议写成 `- [ ] …` 清单 |
| `repo` | string | 关联仓库：远端地址或本机绝对路径，只放一个 |

工作目录用 `workdir` 列（0008），不在 props 里重复。`PATCH` 的 `props` 是整体替换，
只改其中一个 key 时要先读回再拼（MCP 的 `pmw_update_object` 已经这么做）。

### 5. 「输出产物 artifacts」补一段代码类产物约定

0012 没有 `kind` 列，不为它加迁移。代码类产物的种类写在 `note` 开头的固定标记里：

```
[commit] sha=a1b2c3d branch=feat/x repo=/abs/path  自由备注…
[branch] branch=feat/x repo=/abs/path
[pr] branch=feat/x  …
```

位置照旧：有远端页面（GitHub commit / 分支 / PR）就填 `url`；只在本地的 commit / branch 把仓库目录（绝对路径）填进 `path`，
`base_dir` 留空。前端按 `note` 的前缀 `^\[(commit|branch|pr)\]` 识别种类，sha / branch / repo 从同一段 `key=value` 里取。
来源照旧按 `X-Actor-Source` 判定，经 MCP 登记的记成 `mcp`。

### 6. 「运维 admin」无变化；迁移仍到 0012。

---

## 二、合入 `docs/mcp.md` 的内容

### 1. 工具清单表格追加

| 工具 | 读写 | 作用 |
| --- | --- | --- |
| `pmw_list_stakeholders` | 只读 | 列出干系人名册（原表里漏了，顺手补上） |
| `pmw_record_artifact` | **写入** | 登记产物；`kind` 支持 `file`（默认）/ `commit` / `branch` / `pr` |
| `pmw_list_artifacts` | 只读 | 列出产物 |
| `pmw_next_task` | 只读 | 按优先级 → 到期 → 创建时间挑下一个可做的任务（默认 task 的初始状态、负责人为空或是 Claude Code），可按项目、标签筛 |
| `pmw_list_runs` | 只读 | 某任务的后端执行记录（任务页「交给 Claude Code」起的那些） |
| `pmw_get_run` | 只读 | 一次执行的详情，输出默认取末尾 8000 字符 |
| `pmw_claim_task` | **写入** | 领任务：状态切到进行中、负责人设为 Claude Code、记 claim 进展；被别人或别的会话占着时拒绝 |
| `pmw_append_progress` | **写入** | 追加进展（Markdown，可带 commits / files），服务端追加不覆盖 |
| `pmw_submit_review` | **写入** | 提交验收：记 review 进展（总结、改动文件、测试结果）并切到待验收类状态 |
| `pmw_create_subtasks` | **写入** | 批量建子任务并建 `parent` 关联，继承项目、工作目录、仓库、优先级、标签 |

所有写工具描述开头都是「【会写入数据】」，注解里 `readOnlyHint` 为 false
（go-sdk 的 `ReadOnlyHint` 是带 omitempty 的 bool，false 不会出现在 JSON 里；按 MCP 规范缺省即 false），
读工具带 `readOnlyHint: true`。工具总数从 12 个变成 19 个，`/mcp` 里展开应能看到 19 个 `pmw_` 工具。

`pmw_get_object` 的输出多了：工作目录（自己没设时显示继承自所属项目的）、关联仓库、验收标准、最近 10 条进展。
`pmw_create_object` / `pmw_update_object` 多了 `acceptance`、`repo`、`workdir` 三个参数；
`pmw_update_object` 改 `acceptance` / `repo` 时只动这两个 key，其它 props 原样保留。

### 2. 新增一节「会话标识」

`pmw-mcp` 每个请求带三个头：`X-Actor-Source: agent`、`X-Actor-Name`、`X-Actor-Session`。

| 值 | 取法（按优先级） |
|---|---|
| actor | `--actor` 参数 → 环境里有 `CLAUDECODE=1` 时是 `claude-code` → 否则 `mcp-agent` |
| session | 环境变量 `PMW_SESSION_ID` → `CLAUDE_CODE_SESSION_ID`（Claude Code 给子进程设的会话 id，与 `claude --resume` 同一个）→ 都没有时进程启动时生成 `mcp-<16 位十六进制>` |

已实测：`claude -p` 拉起的 pmw-mcp 拿到的 `CLAUDE_CODE_SESSION_ID` 与该次 `claude` 输出 JSON 里的 `session_id` 一致
（演练里是 `ca6c7b10-dce0-4287-83da-f7421fd9f3c0`），所以任务页上的会话 id 可以直接拿去 `claude --resume`。
启动横幅（stderr）会打印当前的 actor 和 session。`pmw_claim_task` 写进负责人的干系人名字由
`--agent-owner` 指定，默认「Claude Code」；名册里没有时**自动建一个**（这一点和人名解析「查不到就报错」相反，理由见 `client.agentOwnerID`）。

### 3. 新增一节「测试实例」

```bash
PMW_DEV_DIR=/path/to/devinst scripts/dev-instance.sh start   # 编译 bin/pmw-dev、bin/pmw-mcp-dev，复制真实库，在 127.0.0.1:7796 启动
scripts/dev-instance.sh status
scripts/dev-instance.sh reset    # 丢弃副本，重新从 data/pm.db 复制
scripts/dev-instance.sh stop     # 只按 pid 文件停，并核对命令行确实是 pmw-dev + 副本库
claude --mcp-config .mcp.dev.json   # 加载指向测试实例的 MCP（服务器名 pm-workspace-dev）
```

`PMW_DEV_DIR` 不设时用 `$TMPDIR/pmw-devinst`。复制用 `sqlite3 -readonly data/pm.db ".backup …"`，
只读打开源库、带上 WAL 里的数据。脚本拒绝使用 7777 端口、拒绝把副本放进 `data/`，也不写 `bin/pmw`、`bin/pmw-mcp`。

### 4. 「安全边界」一节补一句

新增的写工具都不提供删除能力；`pmw_claim_task` 默认拒绝接手别人的任务，`takeover=true` 只该在用户明确要求时使用；
`pmw_submit_review` 不会把任务改成终态，完成与否由用户验收决定。

---

## 三、需要主会话或用户决定的事

1. 内置 `task` / `requirement` 类型没有待验收类状态。`pmw_submit_review` 目前的兜底是「状态不变，只记 review 进展」。
   要不要在真实库的 task 类型里加一个 `review`（标签「待验收」，非终态）——这是改用户的类型配置，需要用户点头。
2. 旧前端 DetailDrawer 的变更时间线会把 `field=progress` 的行显示成「把 progress 从 {JSON} 改成 …」。新前端按本草稿处理即可；旧前端要不要顺手修，由前端那边决定。
