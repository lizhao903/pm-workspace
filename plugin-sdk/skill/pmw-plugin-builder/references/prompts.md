# 可直接复制的提示词

> 这几段是给 AI coding agent / 评审人用的现成提示词，替换 `<尖括号>` 里的内容即可。
> 共同前提：先读 PMW 仓库 `docs/plugin-spec-v2.md` 和本 skill 的 `references/`；
> P1-a 宿主已支持安装运行；任何「已安装/已运行」的说法都必须先有 `install-check` 或实际安装的实测输出。

## 1. 系统提示（给 AI coding agent）

下面整段复制，作为任务开始时的系统/上下文提示：

```text
你在为 PMW（一人之下）开发一个「外部插件」（PMW Plugin 2.0，清单 manifest_version: 2）。

先读这些再动手：
1) PMW 仓库 docs/plugin-spec-v2.md（规范，冲突时以它为准）；
2) plugin-sdk/skill/pmw-plugin-builder/SKILL.md 和按需 references/（manifest、backend、frontend、permissions-security、release）；
3) 用 skill 自带脚本：python3 scripts/pmw_plugin.py init/validate/pack/self-test/install-check。

硬规则：
- 清单只写 manifest v2 字段；id 用 ^[a-z][a-z0-9_]{1,23}$，不能是内核保留字、不能和内置插件冲突；
  version 是 SemVer；api 用 >=2.0.0 <3.0.0 这类范围。
- 只申请代码真正用到的权限；每项权限在 permissions_reason 写 1–80 字中文理由；
  隐式权限（store:plugin、log:write）不写；v0.1 绝不申请 trade:live。
- 后端是独立子进程，走 pmw-plugin-rpc/1（JSON-RPC 2.0 + 换行分帧，8 MiB 上限）。
  宿主拉起进程、注入 env（PMW_PLUGIN_SOCKET/TOKEN/DATA_DIR/...），插件连 socket，
  握手 plugin.hello → host.welcome，再处理 plugin.activate/health/event.deliver/command.run 等。
- 数据只能通过 host.store.query/exec（插件私有库）或 host.objects/contacts/conversations 等 host.* 访问；
  绝不直连内核 SQLite、不读 vault/凭证、不做 ATTACH/跨库、不拼 SQL。
- 前端是 ESM 入口 window.__PMW_PLUGIN__.register({id, api, activate(ctx), deactivate()})；
  不自带 React（import map 共享）、CSS 只挂在 [data-pmw-plugin="<id>"] 下、不 eval/不加载远程脚本、
  不往 document.body 追加应用；注册的槽位 id 必须出现在清单 provides 里。
- 每步用命令自证：validate 0 错误 → self-test 通过 → pack 产物存在且 SHA256SUMS 正确 →
  install-check 如实报告宿主是否支持（当前应输出「不支持外部插件」并退出 0）。
- 不要声称已实现的功能：P1-b 的签名、事件投递、WS、市场索引、源码构建尚未实现，写清「设计，P1-b 待实现」。
- 不要自造宿主 API/方法名/权限名；不确定就停下来读 references 或问用户。
- 禁止：未声明越权、绕过 IPC、硬编码密钥/token、破坏性迁移、混淆/压缩后端二进制。
- 先能跑再美化：先最小只读版本通过 validate/pack，再加功能；不要一上来堆 UI。

完成时输出：改动的文件清单、跑过的命令与关键输出、权限清单及理由、未实现/待定项。
```

## 2. 生成插件提示模板

```text
为 PMW 生成一个外部插件。

目标：<一句话说明插件做什么、解决什么问题>
插件 id：<小写字母/数字/下划线，2–24 位，不能是保留字>
显示名：<中文名>
GitHub owner：<owner>
页面位置：<模块页 / 设置分节 / 今日卡片 / 命令面板 / 对象详情区块，可多选>
数据与权限：<需要读/写什么：对象、联系人、会话、文件、网络、通知、调度…；
             逐项说明为什么需要，能只读就不写>
第三方依赖：<无 / 仅 Go 标准库 / 仅宿主共享的 React；不允许自带 React>
验收：<可执行的验收条件，例：validate 0 错误、self-test 通过、pack 通过，CI 全部平台（模板三平台）Release 产物齐全>
非目标：<明确不做什么，例：不做安装/升级流程、不做远程同步、不碰其他插件数据>

执行步骤：
1. 读 docs/plugin-spec-v2.md 与 skill references（manifest/backend/frontend/permissions-security）；
2. 选最小权限集合，先写 permissions_reason；
3. python3 <skill>/scripts/pmw_plugin.py init <目录> --id=<id> --owner=<owner> --name="<显示名>"；
4. 按清单 provides 实现后端 handler 和前端槽位；不用的模板代码删掉，不要留假实现；
5. validate（0 错误）→ self-test（PASS）→ pack（拿到 dist/<id>-<version>-<os>-<arch>.tar.gz）；
6. install-check 探测本机 PMW；不支持时如实写「等待宿主支持」，不要伪造安装结果；
7. 输出文件清单、命令输出摘要、权限理由、遗留项。

约束：不联网装依赖；不修改 PMW 仓库源码（只改插件目录）；不 commit/push。
```

## 3. 评审提示

```text
评审这个 PMW 外部插件包（目录：<路径>；规范：docs/plugin-spec-v2.md）。

逐项检查并给出「通过 / 需修改」+ 证据（文件:行号）：
1. 清单：manifest v2 必填字段、id 正则/保留字/内置冲突、SemVer、api/pmw 范围、
   permissions_reason 与 permissions 一一对应且理由具体（1–80 字）、runtime 平台与文件存在。
2. 权限最小化：把清单 permissions 和代码里所有 host.* 调用对照；有调用没权限、有权限没调用都要指出。
   高风险权限（fs:write:any、network:any、process:spawn）是否单独说明；是否出现 trade:live（红线）。
3. 安全：不直连内核 DB、不读凭证/vault、无 ATTACH、无字符串拼 SQL、无硬编码密钥/token、
   无静默外传、无后门/挖矿、依赖许可证、迁移只动私有库且可回滚。
4. 协议：握手字段（protocol/plugin_id/token/api）、方法名和信封格式、错误码、超时/并发上限、
   权限失败是否优雅降级、崩溃是否靠宿主重启而不是自己守护。
5. 前端：注册 id 与清单一致、无自带 React、CSS 作用域 [data-pmw-plugin]、错误边界、
   无 eval/远程脚本/document.body 追加、停用清理资源、权限状态只用于展示。
6. 兼容与发布：version 语义、api 范围、升级/回滚/卸载行为、CHANGELOG、LICENSE、
   CI 构建矩阵、SHA256SUMS、签名（有 publisher.key 必须签）。
7. UX/可访问性：空状态、加载/错误态、键盘可达、文案中文、暗色主题 token（--pmw-*）。
8. 工具：validate --strict 通过、self-test 通过、pack 产物可复现。

输出：按上面的编号给结论；最后列出「阻断项」「建议项」「未验证项」。
未验证项要说明原因（例：目标宿主版本太老，无法做安装 E2E）。
```

## 4. 发布提示

```text
发布这个 PMW 外部插件（目录：<路径>，版本：<x.y.z>）。

1. 版本：把 plugin.json 的 version 从 <旧> bump 到 <新>（SemVer 理由：<patch/minor/major>）；
   更新 CHANGELOG.md；确认 <新版本> 与计划 tag v<新版本> 一致。
2. 校验：make lint（gofmt + go vet + validate --strict 等价的工具检查）；
   python3 scripts/pmw_plugin.py validate . --strict 必须 0 错误 0 警告；
   make build-all 三个平台都能构建。
3. 打包：对 darwin-arm64、linux-amd64、windows-amd64 分别 pack；
   确认 dist/ 里每个 tar.gz 只含对应平台二进制；包内 SHA256SUMS 与 dist/SHA256SUMS 都正确。
4. 签名：如果清单有 publisher.key，用 PLUGIN_SIGNING_KEY 对 SHA256SUMS 原始字节做 ed25519 签名，
   输出 base64 单行的 SHA256SUMS.sig；私钥只从 secret 读取，绝不打印/提交。
5. Release：推 v<新版本> tag 触发 CI；确认 Release 资产包含全部 tar.gz + SHA256SUMS（+ SHA256SUMS.sig），
   并逐个核对 SHA-256。
6. 索引：向社区索引提 PR，条目用 tag + 40/64 位 commit + 每个平台资产 SHA-256；
   PR 描述附 Release 链接、权限清单与理由、评审清单勾选、签名状态/信任等级。
7. 如实报告：没有 publisher.key 就是 community 未签名；不要自称 verified/official。
8. 输出：Release URL、tag、commit、各资产 SHA-256、索引 PR 链接、未能验证的项。
```

## 5. 升级 / 兼容提示

```text
升级 PMW 外部插件 <id> 从 <旧版本> 到 <新版本>。

1. 兼容性：新版本要不要改 api（宿主插件 API 范围）/ pmw（产品版本范围）？
   只加向后兼容能力就升 MINOR；删/改扩展点 id 或要求更高宿主 API 才升 MAJOR。
   在 CHANGELOG 写清对宿主版本的要求。
2. 清单：provides 里新增/删除的扩展点、权限变化逐项列出；新权限必须有中文理由，
   并在 PR/Release 说明里标出「升级会请求新权限」。
3. 迁移：插件私有库的变更写进 migrations/（按文件名顺序、只动私有库、含回滚说明）；
   不要做不可逆的破坏性迁移；升级失败必须能回到旧版本（宿主保留最近 2 个版本 + 升级前备份）。
4. 数据兼容：说明新版本读旧数据是否兼容、回滚后新数据会不会丢；
   回滚会恢复升级前备份，升级后产生的数据会丢——UI 和文档都要写清。
5. 验证：validate --strict、self-test、build-all、pack 全过；
   用 ≥2 个历史版本的数据做一次「升级 → 使用 → 回滚」演练（目标宿主不支持时可用 mock host 验证协议）。
6. 发布：按发布提示走；Release notes 写「新增权限 / 迁移 / 回滚注意事项」。
7. 输出：升级步骤、权限变化、迁移与回滚方案、验证记录、遗留风险。
```

## 6. 常见错误对照

| 错误 | 正确做法 |
|---|---|
| 插件自带 React / react-dom | 删掉依赖，`import` 裸模块由宿主 import map 提供 |
| CSS 全局选择器泄漏 | 所有选择器挂 `[data-pmw-plugin="<id>"]` 下 |
| 用了未声明权限 | 清单补权限 + 理由；代码改成权限内实现 |
| 把密钥写进配置/清单 | 用 `host.secrets.*`（对应 `secrets:<scope>`），配置只存非敏感项 |
| 跳过迁移直接改表 | 写 `migrations/*.sql`，只作用于插件私有库；运行时 `host.store.exec` 不跑 DDL |
| id 用了保留字/大写/连字符 | 改成 `^[a-z][a-z0-9_]{1,23}$` 的非保留字 |
| 省略 permissions_reason | 每项权限一条 1–80 字中文理由 |
| 直连内核 SQLite | 只能 `host.store.*`（私有库）或 `host.objects.*` |
| 后端 stdout 打日志当协议 | 日志写 stderr；stdout 不能混入协议帧 |
| 自己实现进程守护/重启 | 宿主已按 1s/2s/4s 退避重启最多 3 次；把关键状态落库，不要自带守护进程 |
| 停用后定时器还在跑 | `deactivate()` 里清资源；前端 disposable 统一 dispose |
| 声称「已安装/已上线」 | 没实际安装时只能写「未安装/未验证」，install-check 的结论照实贴 |
