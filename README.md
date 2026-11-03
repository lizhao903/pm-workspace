# 产品工作台 pmw

本地单二进制的个人产品工作台：Go + SQLite 后端，React 前端打包进同一个可执行文件。

## 跑起来

```bash
make deps     # 拉 Go 依赖 + npm install
make build    # 构建正式前端 frontend/ 并编译出 bin/pmw、bin/pmw-mcp
./bin/pmw     # 默认监听 http://127.0.0.1:7777，数据库在 ./data/pm.db
```

首次体验可以先灌演示数据：

```bash
make seed     # 等价于 go run ./cmd/pmw --seed-demo
```

## 开发

前端要热更新时分两个终端：

```bash
scripts/dev-instance.sh start   # 测试实例 127.0.0.1:7796，用的是真实库副本
cd frontend && npm run dev      # http://127.0.0.1:7780，/api 代理到 7796
```

正式前端的约定见 `frontend/README.md`。旧前端 `web/` 还能 `cd web && npm run dev`（5173，/api 反代到 7777 真实库，写操作会落进真实数据）。

`make dev` 会把这两条命令打印出来。

## 构建哪套前端

`make build` 默认嵌正式前端 `frontend/`（`FRONTEND=new`）。旧前端 `web/` 保留一个版本做回退，下个版本删掉。

```bash
make build                    # 嵌正式前端
make build FRONTEND=legacy    # 嵌旧前端 web/
make ui FRONTEND=legacy       # 只构建前端、不编译 Go
```

两套前端都落到 `internal/webui/dist`，后切的那套整份覆盖前一套；非 `--dev` 模式下由 pmw 直接提供，前端路由刷新时回落 `index.html`。

想先演练、不碰正式二进制，可以把输出指到别处：

```bash
make build BIN=/tmp/pmw-try/pmw BIN_MCP=/tmp/pmw-try/pmw-mcp
```

### 回退到旧前端

新前端上线后发现问题，按下面的步骤换回旧前端。数据库不用动，两套前端用的是同一套 `/api`。

1. 构建旧前端版本：`make build FRONTEND=legacy`（会覆盖 `bin/pmw`，要保留当前二进制先 `cp bin/pmw bin/pmw.new`）。
2. 停掉正在跑的 pmw，用新的 `bin/pmw` 按原来的参数重新启动。
3. 浏览器强制刷新一次（`index.html` 是 no-cache，资源文件名带 hash，一般普通刷新就够）。
4. 问题修好后 `make build` 再切回正式前端。

旧前端没有新前端后加的页面（IM 消息、连接器、插件管理等），回退期间这些功能在界面上用不了，已有数据不受影响。

## 命令行参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--addr` | `127.0.0.1:7777` | 监听地址 |
| `--db` | `./data/pm.db` | SQLite 路径，目录不存在会自动建 |
| `--seed-demo` | `false` | 启动时写入演示数据 |
| `--dev` | `false` | 放开 CORS，不服务内嵌前端 |
| `--open` | `false` | 启动后打开浏览器（仅 macOS） |

## 测试

```bash
make test     # go test ./... -count=1
```

接口契约见 `docs/api-contract.md`，领域模型见 `internal/domain/domain.go`。
