# 产品工作台 pmw

本地单二进制的个人产品工作台：Go + SQLite 后端，React 前端打包进同一个可执行文件。

## 跑起来

```bash
make deps     # 拉 Go 依赖 + npm install
make build    # 构建前端并编译出 bin/pmw
./bin/pmw     # 默认监听 http://127.0.0.1:7777，数据库在 ./data/pm.db
```

首次体验可以先灌演示数据：

```bash
make seed     # 等价于 go run ./cmd/pmw --seed-demo
```

## 开发

前端要热更新时分两个终端：

```bash
go run ./cmd/pmw --dev      # 只服务 /api，并放开 CORS
cd web && npm run dev       # http://127.0.0.1:5173，/api 反代到 7777
```

`make dev` 会把这两条命令打印出来。

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
