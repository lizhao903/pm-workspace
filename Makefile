# 产品工作台构建入口。前端产物落进 internal/webui/dist，由 Go 二进制 embed。

BIN     := bin/pmw
BIN_MCP := bin/pmw-mcp
DIST    := internal/webui/dist
VERSION ?= 0.1.0
LDFLAGS := -X main.version=$(VERSION)

.DEFAULT_GOAL := build
.PHONY: deps web frontend ui build build-mcp run dev seed test vet fmt clean placeholder

# 嵌哪套前端：legacy 是旧前端 web/（默认），new 是正式前端 frontend/。默认切换留给 REL-01。
FRONTEND ?= legacy
ifeq ($(filter $(FRONTEND),legacy new),)
$(error FRONTEND 只能是 legacy 或 new，当前是 "$(FRONTEND)")
endif
UI_TARGET := $(if $(filter new,$(FRONTEND)),frontend,web)

deps:
	go mod download
	cd web && npm install
	cd frontend && npm install

# placeholder 保证 dist 至少有个 index.html，否则 //go:embed 编译不过。
placeholder:
	@test -f $(DIST)/index.html || { \
		mkdir -p $(DIST); \
		printf '%s\n' '<!doctype html><meta charset="utf-8"><title>产品工作台</title><p>前端尚未构建，执行 make web。' > $(DIST)/index.html; \
	}

web:
	cd web && npm run build

# frontend/ 产物在 frontend/dist，整份换进 DIST。.gitkeep 要补回来，理由见 .gitignore。
frontend:
	cd frontend && npm run build
	@test -f frontend/dist/index.html || { echo "frontend/dist/index.html 不存在，构建没产出" >&2; exit 1; }
	rm -rf $(DIST)
	mkdir -p $(DIST)
	cp -R frontend/dist/. $(DIST)/
	@touch $(DIST)/.gitkeep
	@echo "已把 frontend/dist 拷进 $(DIST)"

# ui 按 FRONTEND 构建对应前端：make ui FRONTEND=new。
ui: $(UI_TARGET)

# make build FRONTEND=new 嵌正式前端，不带参数嵌旧前端。
build: $(UI_TARGET) build-mcp
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

# 原型和正式前端的截图对照：两边都要先在跑。make shot-compare MODULE=tasks ARGS="--front-port 7781 --diff"
.PHONY: shot-compare
shot-compare:
	@/opt/miniconda3/bin/python scripts/shot-compare.py --module $(or $(MODULE),all) $(ARGS)

# 压测夹具：往测试实例灌 2000 任务、500 干系人、1000 文档（默认 7796，拒绝 7777）。
# make seed-bulk ARGS="--api http://127.0.0.1:7799 --apply"；删掉加 --purge。
.PHONY: seed-bulk
seed-bulk:
	@/usr/bin/python3 scripts/seed-bulk.py $(ARGS)

# 正式前端冒烟测试：前端要先在跑（cd frontend && npm run dev，后端为测试实例 7796）。换端口 ARGS="--front-port 7792"。
.PHONY: smoke-frontend
smoke-frontend:
	@/opt/miniconda3/bin/python scripts/smoke-frontend.py $(ARGS)

# 开发任务闭环演练（DEV-11）：make dev-loop-drill ARGS="setup" / ARGS="check TSK-0123"。
# 默认对 7796，setup 会 reset 它、要带 --yes；独立实例用 PMW_DEV_DIR、PMW_DEV_ADDR、PMW_SRC_DB 指定。
.PHONY: dev-loop-drill
dev-loop-drill:
	@scripts/dev-loop-drill.sh $(ARGS)
