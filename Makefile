# 产品工作台构建入口。前端产物落进 internal/webui/dist，由 Go 二进制 embed。

BIN     := bin/pmw
BIN_MCP := bin/pmw-mcp
DIST    := internal/webui/dist
VERSION ?= 0.1.0
LDFLAGS := -X main.version=$(VERSION)

.DEFAULT_GOAL := build
.PHONY: deps web build build-mcp run dev seed test vet fmt clean placeholder

deps:
	go mod download
	cd web && npm install

# placeholder 保证 dist 至少有个 index.html，否则 //go:embed 编译不过。
placeholder:
	@test -f $(DIST)/index.html || { \
		mkdir -p $(DIST); \
		printf '%s\n' '<!doctype html><meta charset="utf-8"><title>产品工作台</title><p>前端尚未构建，执行 make web。' > $(DIST)/index.html; \
	}

web:
	cd web && npm run build

build: web build-mcp
	go build -ldflags "$(LDFLAGS)" -o $(BIN) ./cmd/pmw
	@echo "已生成 $(BIN)"

# MCP server 不 embed 前端，所以不依赖 web；.mcp.json 里写的就是这个产物路径。
build-mcp:
	go build -ldflags "$(LDFLAGS)" -o $(BIN_MCP) ./cmd/pmw-mcp
	@echo "已生成 $(BIN_MCP)"

run: placeholder
	go run ./cmd/pmw --open

# dev 分两个终端跑：Go 只服务 API，前端热更新交给 vite。
dev: placeholder
	@echo "终端 1: go run ./cmd/pmw --dev"
	@echo "终端 2: cd web && npm run dev   然后打开 http://127.0.0.1:5173"

seed: placeholder
	go run ./cmd/pmw --seed-demo

test: placeholder
	go test ./... -count=1

vet: placeholder
	go vet ./...

fmt:
	gofmt -w ./cmd ./internal

clean:
	rm -rf bin $(DIST)

# 原型冒烟测试：原型要先在跑（cd web-next && npm run dev）。截图存哪用 ARGS="--out 目录" 指定。
.PHONY: smoke-proto
smoke-proto:
	@/opt/miniconda3/bin/python scripts/smoke-proto.py $(ARGS)
