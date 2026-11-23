# PMW 外部插件开发包（plugin-sdk）

给开发者（和 AI coding agent）的一套 PMW 外部插件开发材料：**可安装的 skill** + **代码模板** +
**校验/打包工具** + **完整示例**。

> **状态：草案 v0.1，宿主 P1-a 已实现（PMW ≥ 0.3.0）。** 现在可以做：生成插件骨架、写后端/前端、
> 校验清单、打包、生成 SHA256SUMS、跑通协议 mock、准备 GitHub Release，并安装进 P1-a 宿主
> （设置 → 插件 → 外部插件：GitHub / 本地目录 / tar.gz）。P1-b 未实现：签名、高风险权限装后单独
> 授权 UI、事件投递、WS 流、市场索引、源码构建；`install-check` 会探测宿主能力并如实报告。

规范依据：

| 文档 | 作用 |
|---|---|
| `docs/plugin-spec-v2.md` | 外部插件规范 v2（清单、权限、协议、前端、生命周期、签名、索引） |
| `docs/plugin-manifest-v2.schema.json` | 清单 v2 的 JSON Schema |
| `docs/plugin-developer-guide.md` | 开发者指南（面向人读的完整教程） |
| 本目录 `skill/pmw-plugin-builder/` | 面向 agent 的可安装 skill + 模板 + 工具 |

## 快速开始

### 1. 安装 skill

```bash
cd plugin-sdk
./install-skill.sh                 # 自动装到 ~/.dsh/skills 或首个可用 skills 目录
./install-skill.sh --dest ~/.claude/skills   # 或指定
```

幂等，可重复执行；打印实际安装路径。装好后重开一个 agent 会话（或刷新 skills 目录），
agent 就能在「为 PMW 生成/校验/打包/发布外部插件」时自动加载 `pmw-plugin-builder`。

### 2. 生成插件骨架

```bash
python3 ~/.dsh/skills/pmw-plugin-builder/scripts/pmw_plugin.py init ./my-plugin \
  --id=my_plugin --owner=<你的 GitHub 用户名> --name="我的插件" --description="一句话说明"
```

需要 Go 1.22+（默认会构建 darwin-arm64 / linux-amd64 / windows-amd64 三个平台）；
没有 Go 时加 `--no-build` 只生成源码。**模板最低 Go 1.22；PMW 主仓自用 Go 1.25，不影响插件**
（插件只需要能构建自己的 `main.go`，不依赖主仓的 Go 版本）。生成后目录：

```text
my-plugin/
  plugin.json              # 清单 v2
  main.go / go.mod         # 后端：pmw-plugin-rpc/1 客户端（纯标准库）
  web/entry.ts             # 前端入口源码（JS 语法子集 + JSDoc）
  web/entry.js             # make web 生成：宿主 import() 的 ESM 入口
  web/style.css            # 作用域样式（[data-pmw-plugin="<id>"]）
  assets/icon.svg
  scripts/pmw_plugin.py    # 校验/打包工具（init 复制的副本，权威版本在 SDK 的 skill 目录里）
  Makefile                 # build / build-all / web / validate / lint / pack
  CHANGELOG.md             # 版本变更（Keep a Changelog，含 [Unreleased]）
  .github/workflows/release.yml
  README.md / LICENSE / .gitignore
```

### 3. 开发、校验、打包

```bash
cd my-plugin
make validate                                  # 清单 + 包内文件
make lint                                      # gofmt + go vet + validate
python3 <SKILL>/scripts/pmw_plugin.py validate . --strict
make build-all && make pack                    # → dist/<id>-<version>-<os>-<arch>.tar.gz + SHA256SUMS
python3 <SKILL>/scripts/pmw_plugin.py install-check . --pmw-url http://127.0.0.1:7796
```

`<SKILL>` 是 skill 安装目录（如 `~/.dsh/skills/pmw-plugin-builder`）。插件仓库里的
`scripts/pmw_plugin.py` 是 `init` 复制进去的**副本**，够 validate/pack，不是第二份权威代码；
`init` 和 `self-test` 需要 skill 目录里的原脚本（依赖 `assets/templates/`）。两边不一致时以
PMW 仓库 `plugin-sdk/skill/pmw-plugin-builder/` 为准。

### 4. 发布

版本 bump → `CHANGELOG.md` → `validate --strict` + `self-test` + `build-all` → 推 `v<version>` tag，
CI 构建矩阵、打包、汇总 SHA256SUMS、可选 ed25519 签名、建 Release。完整步骤、签名命令、
社区索引 PR 格式见 `skill/pmw-plugin-builder/references/release.md`。

## 目录说明

```text
plugin-sdk/
├── README.md                       # 本文件
├── install-skill.sh                # 安装 skill（幂等，默认找 ~/.dsh/skills 等）
├── skill/pmw-plugin-builder/
│   ├── SKILL.md                    # skill 入口：流程、硬规则、references 索引（<8 KiB）
│   ├── references/
│   │   ├── manifest.md             # 清单 v2 逐字段 + 校验规则 + 保留字
│   │   ├── backend.md              # pmw-plugin-rpc/1 协议全文 + Go 模板说明
│   │   ├── frontend.md             # ESM 入口、ctx、槽位、隔离/CSP、import map
│   │   ├── permissions-security.md # 权限表、授权规则、安全边界、评审红线
│   │   ├── release.md              # 构建矩阵、SHA256SUMS、签名、Release、索引 PR
│   │   └── prompts.md              # 5 类可直接复制的提示词 + 常见错误
│   ├── assets/templates/           # 模板（统一 .tmpl 后缀，init 时去掉）
│   │   ├── plugin.json.tmpl  main.go.tmpl  go.mod.tmpl
│   │   ├── Makefile.tmpl  README.md.tmpl  CHANGELOG.md.tmpl
│   │   ├── LICENSE.tmpl  gitignore.tmpl
│   │   ├── web/entry.ts.tmpl  web/style.css.tmpl  assets/icon.svg.tmpl
│   │   └── .github/workflows/release.yml.tmpl
│   └── scripts/pmw_plugin.py       # init / validate / pack / self-test / install-check
└── examples/hello-world/           # 用模板生成并跑通 validate/self-test/pack 的完整示例
```

## 工具用法（`pmw_plugin.py`）

只用 Python 标准库（3.9+），不联网（`install-check` 只请求本机 PMW）。

| 子命令 | 作用 |
|---|---|
| `init <dir> --id=... --owner=...` | 渲染模板、复制工具脚本、构建发布矩阵（`--no-build` 跳过） |
| `validate <dir> [--strict] [--platform KEY]` | 校验清单语义 + 包内文件；`--platform` 只查目标平台二进制（安装产物用） |
| `pack <dir> [--os --arch] [--dist DIR]` | 打平台包，包内生成 SHA256SUMS，`dist/` 汇总 `SHA256SUMS` |
| `self-test [--keep]` | 临时目录跑 `init → validate → pack → 解包 → 再校验`，全过退 0 |
| `install-check <dir> --pmw-url URL` | 探测 `GET /api/plugins` / `/api/plugins/external/updates`；不支持时明确提示并退 0 |

`validate` 覆盖：JSON 合法、必填/未知字段、id 正则 + 内核保留字 + 内置插件冲突、SemVer、
`api`/`pmw` 范围语法、权限枚举 + `permissions_reason` 一一对应、runtime 平台与文件存在、
`provides` 与 runtime 一致性（`modules` → `web`、`connectors` → `network:*`、
`subscribes` ↔ `events:subscribe`）、清单引用文件存在。发布前建议 `--strict`。

## 示例

`examples/hello-world/` 是 `init` 真实生成、跑通 `validate` + `self-test` + `pack` 的完整示例：
模块页、设置分节、今日卡片、命令、后端 RPC 客户端、错误边界、作用域 CSS。
验证方式：

```bash
cd examples/hello-world
make build-all   # 新克隆没有 bin/（被 .gitignore 排除），先构建一次
make lint && python3 <SKILL>/scripts/pmw_plugin.py pack .
```

示例里的 `.go` / `.ts` / `.js` 源文件带仓库要求的 DSH 归属注释；模板文件本身不带
（模板输出由开发者自己的仓库决定归属）。示例的 `bin/`、`dist/` 是构建产物，不提交。

## 常见问题

| 问题 | 说明 |
|---|---|
| `install-check` 说「当前 PMW 版本不支持外部插件」 | 目标 PMW < 0.3.0 或没开外部插件。退出码 0，包已经可发布，升级/开启后再装 |
| `init` 报找不到模板目录 | `init` 必须用 skill 目录里的原脚本；插件仓库里的副本只用于 validate/pack |
| `validate` 报 `bin/... 文件不存在` | 先 `make build-all`（或删掉未构建的平台入口）；安装产物用 `--platform` 校验 |
| 没有 Go | `init --no-build` 生成源码，装好 Go 1.22+ 后 `make build-all`；前端不需要 Node |
| Windows 上后端连不上 | 模板已处理命名管道（`os.OpenFile`）；宿主 P1-a 只实现 Unix socket，Windows 命名管道在 P1-b，未在 Windows 实机验证 |
| 想改模板/脚本 | 改 `skill/pmw-plugin-builder/assets/templates/*.tmpl` 或脚本后，跑一遍 `self-test`，再重新生成示例 |

## 维护（给仓库贡献者）

- 模板统一 `.tmpl` 后缀（避免 DSH 归属检查把所有模板当源码）；`init` 按去后缀规则生成。
- 改脚本后必须跑：`python3 skill/pmw-plugin-builder/scripts/pmw_plugin.py self-test`。
- 示例由模板生成，改动模板后重新生成示例并补 `// powered by dsh` 文件头（见
  `scripts/dsh-badge.sh`）；本文档和仓库内 README 需要 DSH 徽章。
- 不把 `dist/`、`bin/`、私钥、token 提交进仓库。

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
