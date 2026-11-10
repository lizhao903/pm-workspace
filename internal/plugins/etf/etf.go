// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package etf 是 A 股宽基监控插件的后端（ETF-01a 起）：盯每天的基金份额变动与交易大盘情况，
// 落库留存；ETF-01b 起采集后补跟踪指数行情、算派生指标、按规则判定异动并发通知。
//
// 只读公开数据（东方财富），权限只有 network:market-data；没有任何下单、撤单、划转、提币的代码路径。
// 接口契约见 docs/api-contract.md「宽基监控插件 etf」。
package etf

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Plugin 是宽基监控插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct {
	m       plugin.Manifest
	sources []Source
	// collectMu 让定时任务和手动采集不同时跑：同一天的指标和命中记录要按顺序重算
	collectMu sync.Mutex
}

// New 带上要用的数据源；id 为空或重复直接 panic（源是编译进来的，写错是代码问题）。
func New(sources ...Source) *Plugin {
	seen := map[string]bool{}
	for _, s := range sources {
		if strings.TrimSpace(s.ID()) == "" || strings.TrimSpace(s.Name()) == "" {
			panic("宽基数据源要有 id 和显示名")
		}
		if seen[s.ID()] {
			panic(fmt.Sprintf("宽基数据源 %s 登记了两次", s.ID()))
		}
		seen[s.ID()] = true
	}
	return &Plugin{m: plugin.MustParse(manifestJSON), sources: sources}
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

// OnInstall 安装时补种首批 7 条异动规则（迁移里只能建表，不能写数据）。
func (p *Plugin) OnInstall(ctx context.Context, c plugin.Core) error {
	return ensureDefaultRules(ctx, c)
}

func (p *Plugin) Register(r plugin.Registrar) error {
	core := r.Core()
	// 需要出网的源在这里接上受控客户端；client 延迟到每次请求时取，权限变了立刻生效。
	for _, s := range p.sources {
		if b, ok := s.(httpBinder); ok {
			b.BindHTTP(func(ctx context.Context) (*http.Client, error) {
				return core.HTTP("market-data")
			})
		}
	}
	h := &handlers{c: core, p: p}
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/etf/sources", h.listSources)
		m.HandleFunc("GET /api/etf/funds", h.listFunds)
		m.HandleFunc("GET /api/etf/funds/{symbol}", h.getFund)
		m.HandleFunc("GET /api/etf/daily", h.listDaily)
		m.HandleFunc("GET /api/etf/share-change", h.listShareChange)
		m.HandleFunc("POST /api/etf/collect", h.collect)
		// ETF-01b：派生指标、命中记录、规则
		m.HandleFunc("GET /api/etf/metrics", h.listMetrics)
		m.HandleFunc("GET /api/etf/anomalies", h.listAnomalies)
		m.HandleFunc("POST /api/etf/anomalies/{id}/ack", h.ackAnomaly)
		m.HandleFunc("GET /api/etf/rules", h.listRules)
		m.HandleFunc("POST /api/etf/rules", h.createRule)
		m.HandleFunc("PATCH /api/etf/rules/{id}", h.patchRule)
	})
	// 每个交易日收盘后份额和行情才定型；24 小时一轮，启用时先跑一次。
	r.Job(plugin.Job{Name: "etf_daily", Every: 24 * time.Hour, Run: func(ctx context.Context, c plugin.Core) error {
		_, err := runCollect(ctx, c, p, "")
		return err
	}})
	return nil
}

type handlers struct {
	c plugin.Core
	p *Plugin
}

var (
	errValidation = errors.New("validation")
	errNotFound   = errors.New("not_found")
)

func apiErr(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{kind}, args...)...)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// fail 按内核的错误信封写回：{"error":{"code","message"}}。
func (h *handlers) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, errNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, errValidation):
		status, code = http.StatusBadRequest, "validation"
	default:
		h.c.Log().Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		msg = "internal server error"
	}
	if code != "internal" {
		_, msg, _ = strings.Cut(msg, ": ")
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

// SourceInfo 是数据源在接口里的样子。
type SourceInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// CollectResult 是一次采集的结果；errors 是跳过原因，最多 10 条。
// indexes 是写入的指数行情条数，metrics 是算了指标的 ETF 只数，hits 是当天命中总数，new_hits 是这次新增的命中（ETF-01b）。
type CollectResult struct {
	Date     string   `json:"date"`
	Source   string   `json:"source"`
	Upserted int      `json:"upserted"`
	Skipped  int      `json:"skipped"`
	Indexes  int      `json:"indexes"`
	Metrics  int      `json:"metrics"`
	Hits     int      `json:"hits"`
	NewHits  int      `json:"new_hits"`
	Errors   []string `json:"errors"`
}

// ShareChange 是一只 ETF 相邻两日的份额变动。
type ShareChange struct {
	Date      string  `json:"date"`
	Symbol    string  `json:"symbol"`
	Shares    float64 `json:"shares"`
	Change    float64 `json:"change"`
	ChangePct float64 `json:"change_pct"`
	NetInflow float64 `json:"net_inflow"`
}

func (h *handlers) listSources(w http.ResponseWriter, _ *http.Request) {
	out := make([]SourceInfo, 0, len(h.p.sources))
	for _, s := range h.p.sources {
		out = append(out, SourceInfo{ID: s.ID(), Name: s.Name()})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

const fundCols = `symbol, name, track_index, category, manager, market, secid, underlying, launch_date, updated_at`

func scanFund(row plugin.Row) (Fund, error) {
	var f Fund
	err := row.Scan(&f.Symbol, &f.Name, &f.TrackIndex, &f.Category, &f.Manager, &f.Market, &f.Secid, &f.Underlying, &f.LaunchDate, &f.UpdatedAt)
	return f, err
}

func (h *handlers) listFunds(w http.ResponseWriter, r *http.Request) {
	rows, err := h.c.Store().Query(r.Context(), `SELECT `+fundCols+` FROM etf_funds ORDER BY category, market, symbol`)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Fund{}
	for rows.Next() {
		f, err := scanFund(rows)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handlers) getFund(w http.ResponseWriter, r *http.Request) {
	sym := r.PathValue("symbol")
	f, err := scanFund(h.c.Store().QueryRow(r.Context(), `SELECT `+fundCols+` FROM etf_funds WHERE symbol = ?`, sym))
	if errors.Is(err, plugin.ErrNoRows) {
		h.fail(w, r, apiErr(errNotFound, "宽基 %s 不存在", sym))
		return
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": f})
}

const dailyCols = `trade_date, symbol, shares, nav, price, open, high, low, volume, amount, change_pct, change_amount, amplitude, turnover_rate, aum, premium_discount, iopv, premium_basis, source, updated_at`

func scanDaily(row plugin.Row) (Daily, error) {
	var d Daily
	err := row.Scan(&d.Date, &d.Symbol, &d.Shares, &d.NAV, &d.Price, &d.Open, &d.High, &d.Low, &d.Volume, &d.Amount,
		&d.ChangePct, &d.ChangeAmount, &d.Amplitude, &d.TurnoverRate, &d.AUM, &d.PremiumDiscount, &d.IOPV, &d.PremiumBasis, &d.Source, &d.UpdatedAt)
	return d, err
}

func (h *handlers) listDaily(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	qs := r.URL.Query()
	where, args := []string{"1 = 1"}, []any{}
	if v := strings.TrimSpace(qs.Get("symbol")); v != "" {
		where, args = append(where, "symbol = ?"), append(args, v)
	}
	if v := strings.TrimSpace(qs.Get("from")); v != "" {
		if !validDate(v) {
			h.fail(w, r, apiErr(errValidation, "from 要写成 YYYY-MM-DD"))
			return
		}
		where, args = append(where, "trade_date >= ?"), append(args, v)
	}
	if v := strings.TrimSpace(qs.Get("to")); v != "" {
		if !validDate(v) {
			h.fail(w, r, apiErr(errValidation, "to 要写成 YYYY-MM-DD"))
			return
		}
		where, args = append(where, "trade_date <= ?"), append(args, v)
	}
	limit := 500
	if v := qs.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 5000 {
			h.fail(w, r, apiErr(errValidation, "limit 要在 1 到 5000"))
			return
		}
		limit = n
	}
	rows, err := h.c.Store().Query(ctx, `SELECT `+dailyCols+` FROM etf_daily WHERE `+strings.Join(where, " AND ")+
		` ORDER BY trade_date DESC, symbol LIMIT ?`, append(args, limit)...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Daily{}
	for rows.Next() {
		d, err := scanDaily(rows)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out), "limit": limit}})
}

func (h *handlers) listShareChange(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	qs := r.URL.Query()
	sym := strings.TrimSpace(qs.Get("symbol"))
	if sym == "" {
		h.fail(w, r, apiErr(errValidation, "symbol 必填"))
		return
	}
	days := 30
	if v := qs.Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 2 || n > 500 {
			h.fail(w, r, apiErr(errValidation, "days 要在 2 到 500"))
			return
		}
		days = n
	}
	rows, err := h.c.Store().Query(ctx, `SELECT trade_date, symbol, shares, nav FROM (
		SELECT trade_date, symbol, shares, nav FROM etf_daily WHERE symbol = ? ORDER BY trade_date DESC LIMIT ?
	) ORDER BY trade_date ASC`, sym, days)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []ShareChange{}
	var prevShares float64
	first := true
	for rows.Next() {
		var date, symbol string
		var shares, nav float64
		if err := rows.Scan(&date, &symbol, &shares, &nav); err != nil {
			h.fail(w, r, err)
			return
		}
		item := ShareChange{Date: date, Symbol: symbol, Shares: shares}
		if !first && prevShares != 0 {
			item.Change = shares - prevShares
			item.ChangePct = item.Change / prevShares * 100
			item.NetInflow = item.Change * nav
		}
		first = false
		prevShares = shares
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out), "days": days}})
}

func (h *handlers) collect(w http.ResponseWriter, r *http.Request) {
	date := ""
	if r.Body != nil {
		body, err := io.ReadAll(io.LimitReader(r.Body, 4<<10))
		if err != nil {
			h.fail(w, r, apiErr(errValidation, "读请求体失败：%v", err))
			return
		}
		if len(bytes.TrimSpace(body)) > 0 {
			var in struct {
				Date string `json:"date"`
			}
			if err := json.Unmarshal(body, &in); err != nil {
				h.fail(w, r, apiErr(errValidation, "请求体必须是 JSON 对象"))
				return
			}
			date = strings.TrimSpace(in.Date)
		}
	}
	if date != "" && !validDate(date) {
		h.fail(w, r, apiErr(errValidation, "date 要写成 YYYY-MM-DD"))
		return
	}
	res, err := runCollect(r.Context(), h.c, h.p, date)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

// runCollect 拉宽基清单和某日快照，写进 etf_funds、etf_daily。
// date 为空表示最近交易日；同一天重跑是覆盖，不会重复。
func runCollect(ctx context.Context, c plugin.Core, p *Plugin, date string) (CollectResult, error) {
	p.collectMu.Lock()
	defer p.collectMu.Unlock()
	res := CollectResult{Date: date, Errors: []string{}}
	if len(p.sources) == 0 {
		return res, errors.New("没有可用的宽基数据源")
	}
	src := p.sources[0]
	res.Source = src.ID()

	funds, err := src.Funds(ctx)
	if err != nil {
		return res, fmt.Errorf("取宽基清单失败: %w", err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	symbols := make([]string, 0, len(funds))
	var indexCodes []string
	for _, f := range funds {
		if err := upsertFund(ctx, c, f, now); err != nil {
			return res, err
		}
		symbols = append(symbols, f.Symbol)
		if f.Underlying != "" && !slices.Contains(indexCodes, f.Underlying) {
			indexCodes = append(indexCodes, f.Underlying)
		}
	}

	rows, err := src.Daily(ctx, date, symbols)
	if err != nil {
		return res, fmt.Errorf("取宽基快照失败: %w", err)
	}
	for _, d := range rows {
		if strings.TrimSpace(d.Date) == "" || d.Symbol == "" {
			res.Skipped++
			if len(res.Errors) < 10 {
				res.Errors = append(res.Errors, "快照缺日期或代码")
			}
			continue
		}
		priceDerived(&d)
		d.Source = src.ID()
		d.UpdatedAt = now
		if err := upsertDaily(ctx, c, d); err != nil {
			return res, err
		}
		res.Upserted++
	}
	if res.Date == "" && len(rows) > 0 {
		res.Date = rows[0].Date
	}
	if res.Upserted == 0 || res.Date == "" {
		return res, nil
	}
	analyzeAfterCollect(ctx, c, src, &res, indexCodes, now)
	return res, nil
}

// priceDerived 算规模和折溢价（ETF-01b 起带口径）：折溢价 IOPV 优先，没有用单位净值，两样都没有不可用；
// 规模用净值，没有净值依次退到 IOPV、收盘价。
func priceDerived(d *Daily) {
	switch {
	case d.IOPV > 0:
		d.PremiumBasis = "iopv"
		d.PremiumDiscount = (d.Price - d.IOPV) / d.IOPV * 100
	case d.NAV > 0:
		d.PremiumBasis = "nav"
		d.PremiumDiscount = (d.Price - d.NAV) / d.NAV * 100
	default:
		d.PremiumBasis = "none"
		d.PremiumDiscount = 0
	}
	unit := d.Price
	if d.NAV > 0 {
		unit = d.NAV
	} else if d.IOPV > 0 {
		unit = d.IOPV
	}
	d.AUM = d.Shares * unit
}

// analyzeAfterCollect 是采集后的一串：补跟踪指数行情 → 算派生指标 → 按规则判定 → 新命中发通知（ETF-01b）。
// 这几步出错不让采集整体失败（快照已经落库），原因记进 errors。
func analyzeAfterCollect(ctx context.Context, c plugin.Core, src Source, res *CollectResult, indexCodes []string, now string) {
	note := func(format string, args ...any) {
		if len(res.Errors) < 10 {
			res.Errors = append(res.Errors, fmt.Sprintf(format, args...))
		}
	}
	if is, ok := src.(IndexSource); ok && len(indexCodes) > 0 {
		bars, err := is.IndexDaily(ctx, res.Date, indexCodes)
		if err != nil {
			note("取指数行情失败：%v", err)
		}
		for _, b := range bars {
			if b.Date == "" || b.Code == "" {
				continue
			}
			b.Source, b.UpdatedAt = src.ID(), now
			if err := upsertIndex(ctx, c, b); err != nil {
				note("写指数行情失败：%v", err)
				break
			}
			res.Indexes++
		}
	}
	n, err := computeDay(ctx, c, res.Date)
	if err != nil {
		note("算派生指标失败：%v", err)
		return
	}
	res.Metrics = n
	fresh, hits, err := evaluateDay(ctx, c, res.Date)
	if err != nil {
		note("规则判定失败：%v", err)
		return
	}
	res.Hits, res.NewHits = hits, len(fresh)
	notifyAnomalies(context.WithoutCancel(ctx), c, res.Date, fresh)
}

func upsertIndex(ctx context.Context, c plugin.Core, b IndexBar) error {
	_, err := c.Store().Exec(ctx, `INSERT INTO etf_index_daily (trade_date, index_code, close, change_pct, amount, source, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(trade_date, index_code) DO UPDATE SET close = excluded.close,
		change_pct = excluded.change_pct, amount = excluded.amount, source = excluded.source, updated_at = excluded.updated_at`,
		b.Date, b.Code, b.Close, b.ChangePct, b.Amount, b.Source, b.UpdatedAt)
	return err
}

func upsertFund(ctx context.Context, c plugin.Core, f Fund, now string) error {
	_, err := c.Store().Exec(ctx, `INSERT INTO etf_funds (`+fundCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, track_index = excluded.track_index,
		category = excluded.category, manager = excluded.manager, market = excluded.market, secid = excluded.secid,
		underlying = excluded.underlying, launch_date = excluded.launch_date, updated_at = excluded.updated_at`,
		f.Symbol, f.Name, f.TrackIndex, f.Category, f.Manager, f.Market, f.Secid, f.Underlying, f.LaunchDate, now)
	return err
}

func upsertDaily(ctx context.Context, c plugin.Core, d Daily) error {
	_, err := c.Store().Exec(ctx, `INSERT INTO etf_daily (`+dailyCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(trade_date, symbol) DO UPDATE SET shares = excluded.shares, nav = excluded.nav,
		price = excluded.price, open = excluded.open, high = excluded.high, low = excluded.low,
		volume = excluded.volume, amount = excluded.amount, change_pct = excluded.change_pct,
		change_amount = excluded.change_amount, amplitude = excluded.amplitude,
		turnover_rate = excluded.turnover_rate, aum = excluded.aum, premium_discount = excluded.premium_discount,
		iopv = excluded.iopv, premium_basis = excluded.premium_basis, source = excluded.source, updated_at = excluded.updated_at`,
		d.Date, d.Symbol, d.Shares, d.NAV, d.Price, d.Open, d.High, d.Low, d.Volume, d.Amount,
		d.ChangePct, d.ChangeAmount, d.Amplitude, d.TurnoverRate, d.AUM, d.PremiumDiscount, d.IOPV, d.PremiumBasis, d.Source, d.UpdatedAt)
	return err
}

func validDate(s string) bool {
	_, err := time.Parse(time.DateOnly, s)
	return err == nil
}
