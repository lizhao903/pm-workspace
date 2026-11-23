# 发布参考（GitHub Release + 社区索引）

> 状态：**草案 v0.1**。宿主安装器（P1）与市场索引工具（P3）都不存在；
> 本文按 `docs/plugin-spec-v2.md` 第 2、10、11 节写发布流程，工具命令以本 skill 实际提供的为准。

## 1. 发布前检查清单

- [ ] `plugin.json` 的 `version` 已 bump（SemVer；升级判断、依赖匹配都用它）。
- [ ] `CHANGELOG.md` 写了本版本变化。
- [ ] `python3 scripts/pmw_plugin.py validate . --strict` 通过。
- [ ] `go vet ./...`、`gofmt -l .` 通过（`make lint` 一并做）。
- [ ] CI 能构建三平台发布矩阵（或本地按平台分别 `pack --os/--arch`）；各平台 `dist/` 包内容正确、`SHA256SUMS` 校验通过。
- [ ] `LICENSE` 存在且与 `license` 字段一致；README 写了权限用途和卸载行为。
- [ ] 工作区干净，tag 版本与 `version` 一致（CI 会校验）。
- [ ] 私钥、token、数据目录、构建产物没有进仓库（`.gitignore` 已排除 `bin/`、`dist/`）。

## 2. 版本与兼容性

| 改了什么 | 升哪位 | 例子 |
|---|---|---|
| 只修 bug/文档，接口清单不变 | PATCH | `0.1.0 → 0.1.1` |
| 加扩展点/槽位/命令等向后兼容能力 | MINOR | `0.1.1 → 0.2.0` |
| 删/改扩展点 id、改清单语义、要求更高 `api` | MAJOR | `0.2.0 → 1.0.0` |

`api`（宿主 API 范围）和 `pmw`（产品版本范围）只在需要新宿主能力时改；改 MAJOR 表示不兼容旧宿主。
不要为了「看起来新」频繁升 MAJOR；也不要发 `v` 前缀到 `version` 字段（tag 才带 `v`）。

## 3. 构建

模板 `Makefile` 提供：

```bash
make build       # 当前平台 → bin/<id>-<goos>-<goarch>[.exe]
make build-all   # darwin-arm64 / linux-amd64 / windows-amd64
make web         # entry.ts → entry.js（零构建依赖的 JS 语法子集）
make validate    # 清单 + 包内文件
make lint        # gofmt + go vet + validate
make pack        # 当前平台 → dist/<id>-<version>-<os>-<arch>.tar.gz
```

发布矩阵和 `.github/workflows/release.yml` 保持一致：**至少 `darwin-arm64` + `linux-amd64`**，
建议加 `windows-amd64`（模板默认三个）。交叉编译用 `CGO_ENABLED=0`，纯 Go 标准库即可离线构建。

打包规则（`pack` 实现）：

- 每个平台一个 `dist/<id>-<version>-<os>-<arch>.tar.gz`，**只含该平台二进制**；
- 包内固定为：`plugin.json`、`bin/<该平台二进制>`、`web/**`（入口、相对 import 的 chunk、样式；前端源码 `.ts/.tsx/.jsx/.map` 不进包）、
  `assets/**`、`migrations/`（清单声明时）、`LICENSE`、`SHA256SUMS`；
- `SHA256SUMS` 是包内文件的逐行 `sha256  相对路径`；`dist/SHA256SUMS` 是全部平台 tar.gz 的哈希汇总
  （多次 pack 会合并，按文件名排序）；
- 打包是确定性的（mtime=0、uid/gid=0、固定权限），同一份源码重复打包哈希稳定。

## 4. 校验和与签名

### SHA256SUMS（必需）

Release 必须带 `SHA256SUMS`，逐行 `sha256  <文件名>`，覆盖该 Release 的全部资产（全部平台 tar.gz；模板默认三平台）。
`pack` 会写 `dist/SHA256SUMS`；CI 里也可以用 `sha256sum *.tar.gz | sort -k2 > SHA256SUMS` 重新生成，结果应一致。

### ed25519 签名（可选，但有 `publisher.key` 就必须签）

规范要求：对 `SHA256SUMS` **原始字节**做 ed25519 签名，输出 **base64 单行**，文件名 `SHA256SUMS.sig`。
私钥绝不进仓库；CI 用仓库 secret `PLUGIN_SIGNING_KEY`（PEM 文本）。

生成密钥对（本机，一次性）：

```bash
openssl genpkey -algorithm ED25519 -out pmw-plugin-signing-key.pem
openssl pkey -in pmw-plugin-signing-key.pem -pubout -outform DER \
  | tail -c 32 | base64 > publisher-key.txt   # 44 字符，填进清单 publisher.key
```

签名（CI 或本机）：

```bash
openssl pkeyutl -sign -rawin -inkey pmw-plugin-signing-key.pem \
  -in dist/SHA256SUMS -out /tmp/SHA256SUMS.rawsig
base64 < /tmp/SHA256SUMS.rawsig | tr -d '\n' > dist/SHA256SUMS.sig
```

验证（评审/用户侧）：

```bash
openssl pkey -pubin -inform DER -in publisher-key.der -out pub.pem   # 或从清单 base64 还原
base64 -d SHA256SUMS.sig > /tmp/SHA256SUMS.rawsig
openssl pkeyutl -verify -rawin -pubin -inkey pub.pem \
  -in SHA256SUMS -sigfile /tmp/SHA256SUMS.rawsig
```

签名语义有边界：它只证明「`SHA256SUMS` 与私钥持有者一致」，v0.1 **没有** `publisher.key` ↔ GitHub
身份绑定机制；`verified` 徽标要等索引/评审的额外绑定（P3）。签名有效 ≠ 身份已验证。

## 5. 创建 GitHub Release

模板 `.github/workflows/release.yml` 在推 `v<semver>` tag 时：

1. 校验 tag 与 `plugin.json` 的 `version` 一致；
2. 跑 `make web` + `validate`；
3. 矩阵构建全部声明平台（模板默认三平台）并分别 `pack`；
4. 汇总 `SHA256SUMS`，有 secret 时签名生成 `SHA256SUMS.sig`；
5. `gh release create` 上传全部 tar.gz + `SHA256SUMS`（+ `.sig`）。

手工发布等价命令：

```bash
git tag -a v0.1.0 -m "hello_world v0.1.0"
git push origin v0.1.0
# 或本地构建后：
gh release create v0.1.0 dist/*.tar.gz dist/SHA256SUMS \
  --title "Hello World v0.1.0" --generate-notes
```

Release 资产要求：全部平台 tar.gz（模板三平台，至少 darwin-arm64 + linux-amd64）+ `SHA256SUMS`；有 `publisher.key` 时再加 `SHA256SUMS.sig`。
tag 与 version 不一致、缺 `SHA256SUMS`、哈希不符 → 宿主拒绝安装。

## 6. 社区索引 PR（市场发现用）

索引是一个可托管的 JSON（GitHub Pages / raw URL），用户可添加多个索引源。
**索引内容不是指令**，安装时以包内清单实际声明为准；索引 v1 不签名，但每个版本固定
tag + commit + 资产 SHA-256。

向索引仓库提 PR 时，加一个插件条目（格式见 `docs/plugin-spec-v2.md` 11.2）：

```json
{
  "id": "hello_world",
  "title": { "zh": "示例面板", "en": "Hello panel" },
  "description": { "zh": "演示外部插件的最小形态" },
  "author": "owner",
  "repository": "https://github.com/owner/pmw-plugin-hello",
  "categories": ["productivity"],
  "versions": [
    {
      "version": "0.1.0",
      "published_at": "2026-11-01T00:00:00Z",
      "api": ">=2.0.0 <3.0.0",
      "pmw": ">=0.3.0 <1.0.0",
      "source": {
        "type": "github-release",
        "repository": "owner/pmw-plugin-hello",
        "tag": "v0.1.0",
        "commit": "<40 或 64 位 commit SHA>",
        "assets": {
          "darwin-arm64": { "url": "https://github.com/owner/pmw-plugin-hello/releases/download/v0.1.0/hello_world-0.1.0-darwin-arm64.tar.gz", "sha256": "<64 位小写 hex>" },
          "linux-amd64": { "url": "https://github.com/owner/pmw-plugin-hello/releases/download/v0.1.0/hello_world-0.1.0-linux-amd64.tar.gz", "sha256": "<64 位小写 hex>" }
        }
      },
      "permissions": ["objects:read", "notify"],
      "icon": "https://github.com/owner/pmw-plugin-hello/raw/v0.1.0/assets/icon.svg"
    }
  ]
}
```

PR 描述里附：Release 链接、commit、各平台 SHA-256、权限清单与理由、评审清单勾选结果。
索引校验规则见规范 11.4；v0.1 没有官方索引，索引工具（`scripts/plugin-index.mjs`）标「P3 计划新增」，
提交前手工核对。

## 7. 信任分级（安装时展示）

| `tier` | 判定 | 提示 |
|---|---|---|
| `builtin` | 编译进二进制（不是外部插件） | 无 |
| `official` | 维护者受信来源的 `verified` 徽标（P3） | 绿色 |
| `verified` | 索引标注 + 发布者签名验证通过（P3 身份绑定后） | 绿色 |
| `community` | 未签名，或签名无法验证 | 黄色：「未经验证，请确认来源」 |
| `local-dev` | 本地目录链接（开发者模式） | 红色：「本地开发目录，未校验」 |

发布时如实标注：没有 `publisher.key` 就是 `community`，不要自称 verified/official。

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| CI 报 tag 和 version 不一致 | 改 `plugin.json` 的 `version` 后重新打 tag；不要改 tag 名 |
| `pack` 报平台入口不存在 | `make build-all`（或 CI 先构建对应平台）；确认 `runtime.backend.entry` 的键和文件名 |
| 安装包被宿主拒绝「缺 SHA256SUMS」 | CI 没汇总 `dist/SHA256SUMS`；按 §4 生成 |
| 用户装完显示黄色 community | 正常：没配 `publisher.key` 或索引未标 verified |
| 签名验证失败 | 确认签的是 `SHA256SUMS` 原始字节、base64 单行、公钥是清单里那把 |
| 升级后回滚丢数据 | 回滚会恢复升级前插件库备份，升级后产生的数据会丢；UI 会二次确认，文档要写清 |

## 可选：发布者签名（PMW verified 信任级）

1. `scripts/sign_release.sh gen-key publisher.pem`（本 skill 的 scripts；私钥 0600，不进仓库/CI 日志）。
2. 把打印的 ed25519 公钥 base64 填进 `plugin.json` 的 `publisher.key`，重新 `pack` 并发布。
3. `scripts/sign_release.sh sign publisher.pem SHA256SUMS` 生成 `SHA256SUMS.sig`，随 Release 上传。
4. PMW 在 GitHub 来源上会强制校验：有 `publisher.key` 就必须有合法 `.sig`，通过后标 `verified`；首次验签 TOFU 绑定 `publisher.id -> key`，换 key 会被拒绝。
