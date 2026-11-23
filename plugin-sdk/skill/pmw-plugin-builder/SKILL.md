---
name: pmw-plugin-builder
description: 为 PMW（一人之下）生成、校验、打包、发布外部插件（PMW Plugin 2.0：manifest v2、pmw-plugin-rpc/1 后端、ESM 前端槽位）时使用。覆盖从需求确认、生成插件骨架、写后端 RPC / 前端 React 槽位、最小权限与中文权限理由、本地 validate / self-test / pack、install-check 探测宿主，到 GitHub Release 与社区索引 PR 的完整流程。也可用于评审/修复已有 PMW 外部插件的清单、协议、前端隔离或发布配置。
---

# 构建 PMW 外部插件

PMW 外部插件是「PMW Plugin 2.0」：一个 GitHub 仓库一个插件包，清单 `manifest_version: 2`，
后端是独立子进程走 **`pmw-plugin-rpc/1`**（JSON-RPC 2.0 + 换行分帧），前端是运行时 ESM
（`window.__PMW_PLUGIN__` + 宿主共享 React）。内置插件（Plugin API 1.1.0）不在此列。

**当前状态**：P1-a 宿主已实现（PMW ≥ 0.3.0）：本地目录 / tar.gz / GitHub Release 安装、子进程、
运行时前端加载、设置页启停/卸载、基础 broker（store/objects/settings/notify）。P1-b 未实现：
签名、高风险权限装后单独授权 UI、事件投递、WS 流、市场索引、源码构建。任何「已安装 / 已运行」
的说法必须先有 `install-check` 或实际安装的实测输出；不支持就如实写「等待宿主支持」。

规范以 PMW 仓库 `docs/plugin-spec-v2.md` 为准，本 skill 的 references 是开发速查。

## 流程

### 0. 确认边界

先确认：做什么（一句话）、插件 id、GitHub owner、页面位置（模块页 / 设置分节 / 今日卡片 / 命令 /
对象区块）、数据与权限、验收条件、**非目标**。需求模糊时，用 `references/prompts.md` §2 的生成模板
向用户确认，不要自己猜扩展点。只申请代码真正用到的权限；`trade:live` 在 v0.1 一律不授予，直接说明做不到。

### 1. 按需读 references

| 要做的事 | 读 |
|---|---|
| 写/改 plugin.json、权限理由、校验报错 | `references/manifest.md` |
| 后端 RPC：握手、方法表、错误码、超时、Go 模板结构 | `references/backend.md` |
| 前端入口、ctx API、槽位、import map、CSP/隔离 | `references/frontend.md` |
| 权限最小化、安全边界、评审清单 | `references/permissions-security.md` |
| 版本 bump、CI、SHA256SUMS、签名、Release、索引 PR | `references/release.md` |
| 给用户/agent 的现成提示词 | `references/prompts.md` |

### 2. 生成骨架

```bash
python3 <SKILL_DIR>/scripts/pmw_plugin.py init ./<目录> \
  --id=<id> --owner=<github-owner> --name="<显示名>" --description="<一句话>"
```

`init` 会：渲染 `assets/templates/`（`.tmpl` 去掉后缀）、把工具脚本复制进插件 `scripts/`、
用 Go 构建发布矩阵（需要 Go 1.22+；没有 Go 时加 `--no-build`，之后 `make build-all` 再 validate）。
生成后先跑一次 `validate`，确认基线是 0 错误。

### 3. 实现

**后端**（`main.go`）：只保留清单 `provides` 声明过的 handler；宿主不发未声明的调用。
握手（`plugin.hello` → `host.welcome`）、健康检查、`plugin.deactivate` 优雅退出不要动。
数据只能走 `host.store.*`（插件私有库，隐式权限）或 `host.objects/contacts/conversations.*`；
不直连内核 SQLite、不读凭证、不 `ATTACH`、不拼 SQL。日志写 stderr，`activate` 不做重活，
权限失败要降级（记日志、返回可用状态），崩溃重启交给宿主。

**前端**（`web/entry.ts` → `web/entry.js`）：`window.__PMW_PLUGIN__.register({ id, api, activate(ctx), deactivate() })`；
槽位 key 用 `module` / `settings.section` / `today.card` / `command` / `object.section`，id 必须出现在清单
`provides` 里；React 由宿主 import map 共享，**不自带**；组件包错误边界；CSS 只写
`[data-pmw-plugin="<id>"]` 下；不用 `eval`/远程脚本、不动 `document.body`、停用清资源。
模板的 `entry.ts` 只用 JS 语法子集，`make web` 复制成 `entry.js`，零构建依赖。

**清单**：`provides`、`permissions`、`permissions_reason` 必须和代码一致；每项权限 1–80 字中文理由。
文件引用（icon、web 入口/样式、后端二进制、migrations）必须真的在包里。

### 4. 校验

```bash
make validate          # 等价 python3 scripts/pmw_plugin.py validate .
make lint              # gofmt + go vet + validate
python3 scripts/pmw_plugin.py validate . --strict
```

报错按 `references/manifest.md` §8 对照修；**不要**为了过校验删掉真实需要的文件/权限，
也不要手改 `validate` 的规则。发布前 `--strict` 必须 0 错误 0 警告。

### 5. 工具链自检

```bash
python3 <SKILL_DIR>/scripts/pmw_plugin.py self-test
```

在临时目录跑 `init → validate → pack → 解包 → 再校验`。全过才退 0；失败先修模板/脚本，
不要绕过。注意：插件仓库里 `scripts/pmw_plugin.py` 是副本，只用于 validate/pack；`self-test`
和 `init` 要用 skill 目录里的原脚本（需要 `assets/templates/`）。

### 6. 打包

```bash
make build-all         # darwin-arm64 / linux-amd64 / windows-amd64
make pack              # 当前平台；CI 按平台分别 pack
```

产物：`dist/<id>-<version>-<os>-<arch>.tar.gz` + `dist/SHA256SUMS`。确认包内只有
`plugin.json`、目标平台二进制、`web/`（含相对 import 的 chunk）、`assets/`、`migrations/`（若有）、`LICENSE`、`SHA256SUMS`，没有源码/缓存/密钥。

### 7. 探测宿主（如实报告）

```bash
python3 <SKILL_DIR>/scripts/pmw_plugin.py install-check . --pmw-url http://127.0.0.1:7796
```

宿主支持时按提示进入安装流程（P1-a 起 PMW ≥ 0.3.0 会输出「宿主已支持外部插件（检测到外部插件 API，api_version=2.0.0）」）；
旧宿主才输出「当前 PMW 版本不支持外部插件（需要 >= 0.3.0）」并退出 0（不算失败）。把实际输出原样贴给用户，不要伪造安装结果。

### 8. 发布

版本 bump（SemVer 理由）→ 更新 `CHANGELOG.md` → `validate --strict` + `self-test` + `build-all` →
按 `references/release.md` 汇总 SHA256SUMS、可选 ed25519 签名（`SHA256SUMS.sig`，base64 单行）→
`v<version>` tag 触发 CI 建 Release → 向社区索引提 PR（tag + commit + 每个平台资产 SHA-256）。
没有 `publisher.key` 就是 `community` 未签名，不要自称 verified/official。

### 9. 收尾输出

给用户：改动文件清单、跑过的命令与关键输出（validate/self-test/pack/install-check 摘要）、
权限清单与理由、版本与发布状态、**明确未实现/未验证的项**（P1-b 相关）、遗留问题。

## 硬规则

- 不自造宿主 API、方法名、权限名、槽位 key；不确定就查 references 或停下问用户。
- 不绕过 `validate`/`self-test`，不为了过校验删文件或改规则。
- 不算改 PMW 仓库源码（只写插件目录）；不联网装依赖；不 commit/push 到 main。
- 不硬编码密钥/token；私钥只从 CI secret 读；日志/错误信息里不出现凭证和绝对路径。
- 模板文件保持 `.tmpl` 后缀；生成时由脚本去后缀，不要手写死作者/日期。
- 用户要 `trade:live`、想直连内核库、想自带 React/远程脚本时：说明规范不允许，给出替代方案。
