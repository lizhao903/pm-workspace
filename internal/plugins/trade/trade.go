// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package trade 是交易套件插件的后端（TRD-01a 起）：一个插件、四个功能模块（行情、盯盘、策略与回测、交易执行），
// 以后要单独装时再拆。标的（instruments.go）、自选分组（watchlists.go）、行情源适配接口（source.go），
// Binance、OKX 公开行情（binance.go、okx.go，TRD-01b、TRD-01c），行情缓存和推送（market.go、klines.go、stream.go，TRD-02a），
// 盯盘提醒（alerts.go、alerts_api.go，TRD-03a），策略和回测（strategies.go、backtests.go，TRD-04b），
// 模拟盘账户、委托、撮合（accounts.go、ledger.go、paper.go，TRD-05a），策略部署（runs.go，TRD-05b），风控（risk.go，TRD-06a），
// 交易所账户只读接入（exchange*.go、live.go，TRD-07a），交易审计和停用前全停（audit.go，TRD-08a），对账和自动熔断（recon.go，TRD-08b），
// 实盘评审闸门和实盘开关（livegate.go，TRD-08c），实盘下单（exchange_trade.go、exchange_*_trade.go、livetrade.go，TRD-08d）。
//
// 涉及资金的边界：永不提币、永不划转（没有这类代码路径）。交易所的写操作只有下单、撤单、查单（exchangeTradePaths），
// 只在实盘闸门逐笔现查全过（评审通过、trade:live 已授予、实盘开关开着、账户选了读取 + 交易、Key 现查有交易权限且没有提币划转权限）后签发的令牌下发出。
// 权限 network:market-data（公开行情）、network:exchanges（交易所账户：只读接口，加闸门放行的下单、撤单、查单），
// 0.6.0 起声明 trade:live，它是单独申请的权限：安装、升级都不授予，要用户本人在交易设置里过评审后申请（TRD-08c）。
// 模拟盘的委托只在本地撮合；实盘账户 paper 恒为假，实盘委托的状态只由交易所回写。
// 接口契约见 docs/api-contract.md「交易套件插件 trade」。
package trade

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Plugin 是交易套件插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct {
	m       plugin.Manifest
	sources []Source
	mkt     *market
	alerts  *alerter    // 盯盘提醒（alerts.go）
	bt      *btRunner   // 回测调度（TRD-04b，backtests.go）
	paper   *paper      // 模拟盘账本、下单入口、撮合、风控（TRD-05a、TRD-06a，paper.go、risk.go）
	runs    *runner     // 策略部署（TRD-05b，runs.go）
	live    *liveSync   // 交易所账户只读同步、对账（TRD-07a、TRD-08b，live.go、recon.go）
	trader  *liveTrader // 实盘下单、撤单、查单回写（TRD-08d，livetrade.go）

	exchanges []exchangeAccount // 交易所账户适配器（只读）

	// 测试用：时钟、刷新和推送间隔、出网函数（换成假交易所），零值用默认
	now    func() time.Time
	tick   time.Duration
	push   time.Duration
	doer   HTTPDoer
	exDoer HTTPDoer // 交易所账户用的出网客户端，测试换成假交易所；零值走 Core.HTTP("exchanges")

	liveMu sync.Mutex // 实盘评审、开关的读改写串行（TRD-08c，livegate.go）
	// paperRecord 是评审「模拟盘两周记录」的条件；TRD-05d 的每日运行检查还没做，零值时这一项一律不满足，只给测试换
	paperRecord func(ctx context.Context) (ok bool, text string)
}

// DefaultSources 是编进二进制的行情源：Binance、OKX 公开行情。
// 不出网的假行情源只给测试和离线演示，设了环境变量 PMW_TRADE_DEMO=1 才加上，界面上标为「假行情源」。
func DefaultSources() []Source {
	out := []Source{NewBinance(), NewOKX()}
	if os.Getenv("PMW_TRADE_DEMO") == "1" {
		out = append(out, &FakeSource{})
	}
	return out
}

// New 带上要用的行情源；id 重复或覆盖声明不对直接 panic（源是编译进来的，写错是代码问题）。
func New(sources ...Source) *Plugin {
	seen := map[string]bool{}
	for _, s := range sources {
		if err := checkSource(s); err != nil {
			panic(err)
		}
		if seen[s.ID()] {
			panic(fmt.Sprintf("行情源 %s 登记了两次", s.ID()))
		}
		seen[s.ID()] = true
	}
	return &Plugin{m: plugin.MustParse(manifestJSON), sources: sources, exchanges: []exchangeAccount{newBinanceAccount(), newOKXAccount()}}
}

func (p *Plugin) Manifest() plugin.Manifest { return p.m }

// Migrations 是 migrations/ 下的 .sql，安装时由内核按文件名顺序应用（CORE-05）。
func (p *Plugin) Migrations() fs.FS {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

// connectorColors 是连接器页上的品牌色。
var connectorColors = map[string]string{"binance": "#F0B90B", "okx": "#121212"}

func (p *Plugin) Register(r plugin.Registrar) error {
	core := r.Core()
	// 要出网的源在这里接上受控客户端；client 每次请求时现取，权限变了立刻生效
	for _, s := range p.sources {
		if b, ok := s.(httpBinder); ok {
			if p.doer != nil {
				b.BindHTTP(p.doer)
			} else {
				b.BindHTTP(func(ctx context.Context) (*http.Client, error) { return core.HTTP("market-data") })
			}
		}
		if cs, ok := s.(connectorSource); ok {
			r.Connector(plugin.ConnectorDef{
				Tool: cs.ConnectorTool(), Label: s.Name() + " 公开行情", Category: "market", Color: connectorColors[s.ID()],
				Desc: s.Name() + " 现货和 USDT 永续的公开行情：K 线、盘口、最新价、资金费率。只读，不需要 API Key，不能下单。" +
					"交易套件拉行情时把限频、断网记到这里，恢复后自动回到已连接",
				Auth: []connector.AuthMode{connector.AuthNone},
				Test: func(ctx context.Context, _ connector.Config) (string, error) {
					if err := cs.Ping(ctx); err != nil {
						return "", err
					}
					return s.Name() + " 公开行情", nil
				},
			})
		}
	}
	// 交易所账户（只读）：每家一个令牌认证的连接器，凭证进保险箱
	p.live = newLiveSync(p, core)
	for _, x := range p.exchanges {
		r.Connector(p.live.connectorDef(x))
	}
	r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "accounts", Load: liveAccountsImpact})
	p.mkt = newMarket(p, core)
	p.alerts = newAlerter(p, core)
	p.bt = newBtRunner(p, core)
	p.paper = newPaper(p, core)
	p.runs = newRunner(p, core)
	p.trader = newLiveTrader(p, core)
	h := &handlers{c: core, p: p}
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/trade/sources", h.listSources)
		m.HandleFunc("POST /api/trade/sources/{id}/sync", h.syncSource)
		m.HandleFunc("GET /api/trade/instruments", h.listInstruments)
		m.HandleFunc("GET /api/trade/instruments/{symbol}", h.getInstrument)
		m.HandleFunc("GET /api/trade/watchlists", h.listWatchlists)
		m.HandleFunc("POST /api/trade/watchlists", h.addWatchlist)
		m.HandleFunc("GET /api/trade/watchlists/{id}", h.getWatchlist)
		m.HandleFunc("PATCH /api/trade/watchlists/{id}", h.updateWatchlist)
		m.HandleFunc("DELETE /api/trade/watchlists/{id}", h.removeWatchlist)
		m.HandleFunc("GET /api/trade/quotes", h.getQuotes)
		m.HandleFunc("GET /api/trade/book", h.getBook)
		m.HandleFunc("GET /api/trade/funding", h.getFunding)
		m.HandleFunc("GET /api/trade/klines", h.getKlines)
		m.HandleFunc("GET /api/trade/stream", h.stream)
		registerAlertRoutes(m, h)
		// 策略和回测（TRD-04b，strategies.go、backtests_api.go）
		m.HandleFunc("GET /api/trade/strategies", h.listStrategies)
		m.HandleFunc("POST /api/trade/strategies", h.addStrategy)
		m.HandleFunc("GET /api/trade/strategies/{id}", h.getStrategy)
		m.HandleFunc("PATCH /api/trade/strategies/{id}", h.updateStrategy)
		m.HandleFunc("DELETE /api/trade/strategies/{id}", h.removeStrategy)
		m.HandleFunc("GET /api/trade/backtests", h.listBacktests)
		m.HandleFunc("POST /api/trade/backtests", h.addBacktest)
		m.HandleFunc("GET /api/trade/backtests/compare", h.compareBacktests)
		m.HandleFunc("GET /api/trade/backtests/{id}", h.getBacktest)
		m.HandleFunc("DELETE /api/trade/backtests/{id}", h.removeBacktest)
		m.HandleFunc("POST /api/trade/backtests/{id}/rerun", h.rerunBacktest)
		m.HandleFunc("POST /api/trade/backtests/{id}/sweep", h.sweepBacktest)
		// 模拟盘（TRD-05a，accounts.go、paper_api.go）
		m.HandleFunc("GET /api/trade/accounts", h.listAccounts)
		m.HandleFunc("POST /api/trade/accounts", h.addAccount)
		m.HandleFunc("GET /api/trade/accounts/{id}", h.getAccount)
		m.HandleFunc("PATCH /api/trade/accounts/{id}", h.updateAccount)
		m.HandleFunc("DELETE /api/trade/accounts/{id}", h.removeAccount)
		m.HandleFunc("GET /api/trade/accounts/{id}/reconcile", h.reconcileAccount)
		// 交易所账户只读同步、对账（TRD-07a、TRD-08b，live.go、recon.go）
		m.HandleFunc("POST /api/trade/accounts/{id}/sync", h.syncLiveAccount)
		m.HandleFunc("POST /api/trade/accounts/{id}/connect", h.connectLiveAccount)
		m.HandleFunc("POST /api/trade/accounts/{id}/disconnect", h.disconnectLiveAccount)
		m.HandleFunc("GET /api/trade/accounts/{id}/snapshot", h.liveSnapshot)
		m.HandleFunc("GET /api/trade/accounts/{id}/fills", h.liveFills)
		m.HandleFunc("GET /api/trade/accounts/{id}/recon", h.getRecon)
		m.HandleFunc("POST /api/trade/accounts/{id}/recon", h.recheckRecon)
		m.HandleFunc("POST /api/trade/accounts/{id}/recon/items/{item}/resolve", h.resolveRecon)
		m.HandleFunc("GET /api/trade/recons", h.listRecons)
		m.HandleFunc("GET /api/trade/orders", h.listOrders)
		m.HandleFunc("POST /api/trade/orders", h.addOrder)
		m.HandleFunc("POST /api/trade/orders/cancel-all", h.cancelAllOrders)
		m.HandleFunc("GET /api/trade/orders/{id}", h.getOrder)
		m.HandleFunc("PATCH /api/trade/orders/{id}", h.updateOrder)
		m.HandleFunc("POST /api/trade/orders/{id}/cancel", h.cancelPaperOrder)
		m.HandleFunc("GET /api/trade/positions", h.listPositions)
		m.HandleFunc("POST /api/trade/positions/{id}/close", h.closePosition)
		m.HandleFunc("GET /api/trade/fills", h.listFills)
		// 部署（TRD-05b，runs.go）
		m.HandleFunc("GET /api/trade/runs", h.listRuns)
		m.HandleFunc("POST /api/trade/runs", h.addRun)
		m.HandleFunc("GET /api/trade/runs/{id}", h.getRun)
		m.HandleFunc("POST /api/trade/runs/{id}/pause", h.runAction("pause"))
		m.HandleFunc("POST /api/trade/runs/{id}/resume", h.runAction("resume"))
		m.HandleFunc("POST /api/trade/runs/{id}/stop", h.runAction("stop"))
		// 风控（TRD-06a，risk.go）
		m.HandleFunc("GET /api/trade/risk", h.getRisk)
		m.HandleFunc("PATCH /api/trade/risk", h.updateRisk)
		m.HandleFunc("POST /api/trade/risk/kill", h.killAll)
		m.HandleFunc("POST /api/trade/risk/release", h.releaseHalt)
		m.HandleFunc("GET /api/trade/risk/halts", h.listHalts)
		// 交易审计（TRD-08a，audit.go）
		m.HandleFunc("GET /api/trade/audit", h.listAudit)
		// 实盘评审闸门和实盘开关（TRD-08c，livegate.go）
		m.HandleFunc("GET /api/trade/live", h.getLive)
		m.HandleFunc("POST /api/trade/live/checks/{key}/confirm", h.confirmLiveCheck)
		m.HandleFunc("POST /api/trade/live/checks/{key}/revoke", h.revokeLiveCheck)
		m.HandleFunc("POST /api/trade/live/switch", h.setLiveSwitch)
	})
	r.Job(plugin.Job{Name: "trade_backtests", Run: func(ctx context.Context, _ plugin.Core) error { return p.bt.run(ctx) }})
	r.Job(plugin.Job{Name: "trade_alerts", Every: alertEvery, Run: func(ctx context.Context, _ plugin.Core) error { return p.alerts.check(ctx) }})
	r.Job(plugin.Job{Name: "trade_paper", Run: func(ctx context.Context, _ plugin.Core) error { return p.paper.run(ctx) }})
	r.Job(plugin.Job{Name: "trade_runs", Run: func(ctx context.Context, _ plugin.Core) error { return p.runs.run(ctx) }})
	r.Job(plugin.Job{Name: "trade_live", Every: liveEvery, Run: func(ctx context.Context, _ plugin.Core) error { return p.live.runAll(ctx) }})
	if len(p.sources) > 0 {
		// 行情刷新常驻；标的表一天同步一次（启用时先跑一次）
		r.Job(plugin.Job{Name: "trade_market", Run: func(ctx context.Context, _ plugin.Core) error { return p.mkt.run(ctx) }})
		r.Job(plugin.Job{Name: "trade_instruments", Every: 24 * time.Hour, Run: func(ctx context.Context, c plugin.Core) error {
			for _, s := range p.sources {
				if _, err := runSync(ctx, c, s); err != nil {
					c.Log().Warn("sync instruments failed", "source", s.ID(), "err", err)
				}
			}
			return nil
		}})
	}
	return nil
}

func (p *Plugin) source(id string) Source {
	for _, s := range p.sources {
		if s.ID() == id {
			return s
		}
	}
	return nil
}

type handlers struct {
	c plugin.Core
	p *Plugin
}

// 错误分类，对应信封里的 code
var (
	errValidation = errors.New("validation")
	errNotFound   = errors.New("not_found")
)

func apiErr(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{kind}, args...)...)
}

const maxBody = 64 << 10

func readBody(r *http.Request) (map[string]json.RawMessage, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return nil, apiErr(errValidation, "读请求体失败：%v", err)
	}
	if len(body) > maxBody {
		return nil, apiErr(errValidation, "请求体超过 64KB")
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(body, &out); err != nil || out == nil {
		return nil, apiErr(errValidation, "请求体必须是 JSON 对象")
	}
	return out, nil
}

// fail 按内核的错误信封写回：{"error":{"code","message"}}。
func (h *handlers) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, errNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, errValidation):
		status, code = http.StatusBadRequest, "validation"
	case errors.Is(err, errLive):
		_, msg, _ = strings.Cut(msg, ": ")
		writeJSON(w, http.StatusForbidden, map[string]any{"error": map[string]any{"code": "forbidden", "reason": "live", "message": msg}})
		return
	default:
		h.c.Log().Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		msg = "internal server error"
	}
	if code != "internal" {
		_, msg, _ = strings.Cut(msg, ": ")
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
