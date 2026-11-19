// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// 回测接口（TRD-04b）：列表、详情、发起、重跑、删除、参数扫描、对比。执行在 backtests.go。

const (
	maxSweepValues = 20
	maxCompare     = 4
	maxGridParams  = 4  // 网格扫描最多几个参数（TRD-09）
	maxGridCombos  = 64 // 网格扫描最多几组
)

// objectKeys 按出现顺序回 JSON 对象的键。
func objectKeys(b []byte) ([]string, error) {
	var ps map[string]json.RawMessage
	if err := json.Unmarshal(b, &ps); err != nil || ps == nil {
		return nil, errors.New("not object")
	}
	dec := json.NewDecoder(strings.NewReader(string(b)))
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	var keys []string
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return nil, err
		}
		keys = append(keys, k.(string))
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil, err
		}
	}
	return keys, nil
}

var btStatuses = []string{"queued", "running", "done", "failed"}

// GET /api/trade/backtests?strategy_id=&status=：新的在前，不分页；列表项不带资金曲线和成交。
func (h *handlers) listBacktests(w http.ResponseWriter, r *http.Request) {
	qs := r.URL.Query()
	where, args := []string{"1 = 1"}, []any{}
	if v := qs.Get("strategy_id"); v != "" {
		where, args = append(where, "strategy_id = ?"), append(args, v)
	}
	if v := qs.Get("status"); v != "" {
		if !slices.Contains(btStatuses, v) {
			h.fail(w, r, apiErr(errValidation, "status 只能是 queued、running、done、failed"))
			return
		}
		where, args = append(where, "status = ?"), append(args, v)
	}
	rows, err := h.c.Store().Query(r.Context(), `SELECT `+btCols+`, stats, note FROM trade_backtests WHERE `+strings.Join(where, " AND ")+
		` ORDER BY created_at DESC, id DESC`, args...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []BacktestBrief{}
	counts := map[string]int{}
	for rows.Next() {
		var stats, note string
		x, err := scanBacktestHead(rows, &stats, &note)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		b := x.b
		br := BacktestBrief{ID: b.ID, Name: b.Name, Config: b.Config, Status: b.Status, Progress: b.Progress, StrategySnapshot: b.StrategySnapshot,
			Note: note, Error: b.Error, CreatedAt: b.CreatedAt, StartedAt: b.StartedAt, FinishedAt: b.FinishedAt, DataFrom: b.DataFrom, DataTo: b.DataTo}
		if stats != "" {
			var s BacktestStats
			if json.Unmarshal([]byte(stats), &s) == nil {
				br.Stats = &s
			}
		}
		counts[b.Status]++
		out = append(out, br)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{
		"total": len(out), "queued": counts["queued"], "running": counts["running"], "done": counts["done"], "failed": counts["failed"]}})
}

func (h *handlers) getBacktest(w http.ResponseWriter, r *http.Request) {
	b, _, err := loadBacktest(r.Context(), h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": b})
}

// GET /api/trade/backtests/compare?ids=a,b：2 到 4 条，按 ids 的顺序回完整的回测（含资金曲线）。
func (h *handlers) compareBacktests(w http.ResponseWriter, r *http.Request) {
	ids := uniqTrim(strings.Split(r.URL.Query().Get("ids"), ","))
	if len(ids) < 2 || len(ids) > maxCompare {
		h.fail(w, r, apiErr(errValidation, "ids 要有 2 到 4 个回测 id"))
		return
	}
	out := []Backtest{}
	for _, id := range ids {
		b, _, err := loadBacktest(r.Context(), h.c, id)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		if b.Status != "done" || b.Result == nil {
			h.fail(w, r, apiErr(errValidation, "回测 %s 还没完成，完成后才能对比", b.Name))
			return
		}
		b.Sweep = nil
		out = append(out, b)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// btBody 是发起回测的请求体：strategy_id 必填；symbols、interval 不传取策略的；params 是覆盖，只认策略里有的参数和三个保留键。
type btBody struct {
	StrategyID    string    `json:"strategy_id"`
	Symbols       *[]string `json:"symbols"`
	Interval      *string   `json:"interval"`
	Bars          *int      `json:"bars"`
	Capital       *float64  `json:"capital"`
	FeeBp         *float64  `json:"fee_bp"`
	SlippageTicks *float64  `json:"slippage_ticks"`
	Params        Params    `json:"params"`
	Start         *string   `json:"start"`
	End           *string   `json:"end"`
}

func decodeStrict(raw map[string]json.RawMessage, allowed []string, v any) error {
	for k := range raw {
		if !slices.Contains(allowed, k) {
			return apiErr(errValidation, "不认识的字段 %s", k)
		}
	}
	b, _ := json.Marshal(raw)
	if err := json.Unmarshal(b, v); err != nil {
		return apiErr(errValidation, "字段的类型不对：%v", err)
	}
	return nil
}

// overrideParams 把 over 盖到 base 上，键要是策略参数或保留键。
func overrideParams(st Strategy, base, over Params) (Params, error) {
	for _, p := range over {
		if !st.Params.Has(p.Key) && !slices.Contains(ReservedParams, p.Key) {
			return nil, apiErr(errValidation, "参数 %s 策略里没有", p.Key)
		}
	}
	return base.Merge(over), nil
}

// defaultFee：数币万分之 5，其余 3（SPEC-strategy-5.4）。
func defaultFee(symbols []string) float64 {
	if len(symbols) > 0 {
		venue, _ := codeOf(symbols[0])
		if venue == "BINANCE" || venue == "OKX" || venue == "FAKE" {
			return 5
		}
	}
	return 3
}

// POST /api/trade/backtests：用策略当前的样子拍快照、排队，回 201 + Backtest（status=queued）。
func (h *handlers) addBacktest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var body btBody
	if err := decodeStrict(raw, []string{"strategy_id", "symbols", "interval", "bars", "capital", "fee_bp", "slippage_ticks", "params", "start", "end"}, &body); err != nil {
		h.fail(w, r, err)
		return
	}
	if strings.TrimSpace(body.StrategyID) == "" {
		h.fail(w, r, apiErr(errValidation, "缺少 strategy_id"))
		return
	}
	st, err := loadStrategy(ctx, h.c, body.StrategyID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	cfg := BacktestConfig{StrategyID: st.ID, Symbols: st.Symbols, Interval: st.Interval, Bars: 1000, Capital: 100000,
		FeeBp: defaultFee(st.Symbols), SlippageTicks: 1, Params: st.Params}
	if body.Symbols != nil {
		cfg.Symbols = uniqTrim(*body.Symbols)
	}
	if body.Interval != nil {
		cfg.Interval = *body.Interval
	}
	if st.Mode == "builtin" {
		cfg.Bars = 14400 // 内置策略默认回测 3m 30 天
	}
	if body.Bars != nil {
		cfg.Bars = *body.Bars
	}
	if body.Capital != nil {
		cfg.Capital = *body.Capital
	}
	if body.FeeBp != nil {
		cfg.FeeBp = *body.FeeBp
	}
	if body.SlippageTicks != nil {
		cfg.SlippageTicks = *body.SlippageTicks
	}
	if cfg.Params, err = overrideParams(st, st.Params, body.Params); err != nil {
		h.fail(w, r, err)
		return
	}
	if body.End != nil {
		cfg.End = strings.TrimSpace(*body.End)
	}
	if body.Start != nil {
		cfg.Start = strings.TrimSpace(*body.Start)
	}
	if err := rangeBars(&cfg); err != nil {
		h.fail(w, r, err)
		return
	}
	b, err := h.enqueue(ctx, st, cfg)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": b})
}

// POST /api/trade/backtests/{id}/rerun：同样的配置再跑一次；策略还在用当前的，删了用快照。
// body 可以带 params（扫描结果里「回测」用），盖在原配置的参数上。
func (h *handlers) rerunBacktest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		Params Params `json:"params"`
	}
	if r.ContentLength != 0 {
		raw, err := readBody(r)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		if err := decodeStrict(raw, []string{"params"}, &body); err != nil {
			h.fail(w, r, err)
			return
		}
	}
	old, _, err := loadBacktest(ctx, h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if old.Status == "queued" || old.Status == "running" {
		h.fail(w, r, apiErr(errValidation, "这条回测还在%s，跑完才能重新回测", map[string]string{"queued": "排队", "running": "运行"}[old.Status]))
		return
	}
	st, err := loadStrategy(ctx, h.c, old.StrategyID)
	if errors.Is(err, errNotFound) {
		st, err = old.StrategySnapshot, nil
		st.ID = old.StrategyID
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	cfg := old.Config
	if cfg.Params, err = overrideParams(old.StrategySnapshot, cfg.Params, body.Params); err != nil {
		h.fail(w, r, err)
		return
	}
	b, err := h.enqueue(ctx, st, cfg)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": b})
}

// rangeBars：给了 start、end（TRD-09）时 bars 按区间算（左闭右开）；end 不能晚于今天。
func rangeBars(cfg *BacktestConfig) error {
	if cfg.End == "" {
		return nil
	}
	end, err := time.Parse(time.DateOnly, cfg.End)
	if err != nil {
		return apiErr(errValidation, "end 要是 YYYY-MM-DD")
	}
	if end.After(time.Now().UTC().Add(24 * time.Hour)) {
		return apiErr(errValidation, "end 不能晚于明天")
	}
	if cfg.Start == "" {
		return nil
	}
	start, err := time.Parse(time.DateOnly, cfg.Start)
	if err != nil || !start.Before(end) {
		return apiErr(errValidation, "start 要是 YYYY-MM-DD，且早于 end")
	}
	step, ok := Intervals[cfg.Interval]
	if !ok {
		return apiErr(errValidation, "周期不认识：%s", cfg.Interval)
	}
	cfg.Bars = int(end.Sub(start) / step)
	return nil
}

// enqueue 校验、拍快照、落一条 queued，叫醒调度。
func (h *handlers) enqueue(ctx context.Context, st Strategy, cfg BacktestConfig) (Backtest, error) {
	if err := checkConfig(cfg, st); err != nil {
		return Backtest{}, apiErr(errValidation, "%v", err)
	}
	if st.Mode == "rules" && len(st.Entry.Rules) == 0 {
		return Backtest{}, apiErr(errValidation, "入场规则还是空的")
	}
	var seq int
	if err := h.c.Store().QueryRow(ctx, `SELECT COALESCE(MAX(seq), 0) + 1 FROM trade_backtests WHERE strategy_id = ?`, st.ID).Scan(&seq); err != nil {
		return Backtest{}, err
	}
	name := st.Name
	if name == "" {
		name = "未命名策略"
	}
	b := Backtest{ID: idgen.Prefixed("bk"), StrategyID: st.ID, Name: name + " #" + strconv.Itoa(seq), Config: cfg, Status: "queued",
		StrategySnapshot: st, CreatedAt: stamp(time.Now())}
	cj, _ := json.Marshal(cfg)
	sj, _ := json.Marshal(st)
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO trade_backtests (id, strategy_id, seq, name, config, status, progress, strategy_snapshot, created_at)
		VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`, b.ID, st.ID, seq, b.Name, string(cj), string(sj), b.CreatedAt); err != nil {
		return Backtest{}, err
	}
	if h.p.bt != nil {
		h.p.bt.poke()
	}
	return b, nil
}

// DELETE /api/trade/backtests/{id}：在跑的先打断。
func (h *handlers) removeBacktest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, _, err := loadBacktest(ctx, h.c, id); err != nil {
		h.fail(w, r, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM trade_backtests WHERE id = ?`, id); err != nil {
		h.fail(w, r, err)
		return
	}
	if h.p.bt != nil {
		h.p.bt.cancel(id)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// POST /api/trade/backtests/{id}/sweep {param, values}：已完成的回测按同一段数据只改一个参数各跑一次，
// 结果存在这条回测上（覆盖上一次扫描），不新增回测记录。
func (h *handlers) sweepBacktest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var body struct {
		Param  string               `json:"param"`
		Values []float64            `json:"values"`
		Grid   map[string][]float64 `json:"grid"`
	}
	if err := decodeStrict(raw, []string{"param", "values", "grid"}, &body); err != nil {
		h.fail(w, r, err)
		return
	}
	// 网格扫描（TRD-09）：grid 的键按请求里出现的顺序
	gridOrder := []string{}
	if g, ok := raw["grid"]; ok {
		if body.Param != "" || body.Values != nil {
			h.fail(w, r, apiErr(errValidation, "param、values 和 grid 只能给一种"))
			return
		}
		keys, err := objectKeys(g)
		if err != nil {
			h.fail(w, r, apiErr(errValidation, "grid 要是参数名到取值数组的对象"))
			return
		}
		gridOrder = keys
	}
	b, to, err := loadBacktest(ctx, h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if b.Status != "done" || to == 0 {
		h.fail(w, r, apiErr(errValidation, "回测完成后才能扫参"))
		return
	}
	dedup := func(xs []float64) []float64 {
		var out []float64
		for _, v := range xs {
			if finite(v) && !slices.Contains(out, v) {
				out = append(out, v)
			}
		}
		return out
	}
	var grid []GridAxis
	if len(gridOrder) > 0 {
		if len(gridOrder) > maxGridParams {
			h.fail(w, r, apiErr(errValidation, "grid 最多 %d 个参数", maxGridParams))
			return
		}
		n := 1
		for _, k := range gridOrder {
			if !SweepableParams(b.StrategySnapshot).Has(k) {
				h.fail(w, r, apiErr(errValidation, "参数 %s 不能扫：只能扫策略参数和 stop_loss、take_profit、position_pct", k))
				return
			}
			vs := dedup(body.Grid[k])
			if len(vs) == 0 {
				h.fail(w, r, apiErr(errValidation, "grid.%s 至少要 1 个有限数", k))
				return
			}
			n *= len(vs)
			grid = append(grid, GridAxis{Param: k, Values: vs})
		}
		if n > maxGridCombos {
			h.fail(w, r, apiErr(errValidation, "grid 的组合数 %d 超过 %d", n, maxGridCombos))
			return
		}
	} else if !SweepableParams(b.StrategySnapshot).Has(body.Param) {
		h.fail(w, r, apiErr(errValidation, "参数 %s 不能扫：只能扫策略参数和 stop_loss、take_profit、position_pct", body.Param))
		return
	}
	values := dedup(body.Values)
	if grid == nil && (len(values) == 0 || len(values) > maxSweepValues) {
		h.fail(w, r, apiErr(errValidation, "values 要有 1 到 20 个不同的数"))
		return
	}
	if b.StrategySnapshot.Mode == "builtin" {
		if bi, ok := builtinOf(b.StrategySnapshot.Builtin); ok {
			var over Params
			for _, ax := range grid {
				for _, v := range ax.Values {
					over = append(over, Param{ax.Param, v})
				}
			}
			for _, v := range values {
				over = append(over, Param{body.Param, v})
			}
			if err := bi.check(over); err != nil {
				h.fail(w, r, apiErr(errValidation, "%v", err))
				return
			}
		}
	}
	if h.p.bt == nil {
		h.fail(w, r, errors.New("回测调度没起来"))
		return
	}
	cfg := b.Config
	hist, err := newHistory(ctx, h.p.bt, cfg, time.UnixMilli(to), nil)
	if err != nil {
		h.failBt(w, r, err)
		return
	}
	var points []SweepPoint
	func() {
		defer func() {
			if x := recover(); x != nil {
				h.c.Log().Error("sweep engine panic", "id", b.ID, "panic", x, "stack", string(debug.Stack()))
				err = failf(failEngine, "%v", x)
			}
		}()
		if grid != nil {
			points = SweepGrid(cfg, b.StrategySnapshot, grid, hist.data())
		} else {
			points = Sweep(cfg, b.StrategySnapshot, body.Param, values, hist.data())
		}
	}()
	if err == nil {
		err = hist.check()
	}
	if err != nil {
		h.failBt(w, r, err)
		return
	}
	rec := SweepRecord{Param: body.Param, Points: points, At: stamp(time.Now())}
	if grid != nil {
		rec.Param, rec.Grid = grid[0].Param, gridOrder
	}
	sj, _ := json.Marshal(rec)
	if _, err := h.c.Store().Exec(ctx, `UPDATE trade_backtests SET sweep = ? WHERE id = ?`, string(sj), b.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rec})
}

// failBt：数据缺失回 502 upstream（交易所、缓存的问题），参数不合法 400，其余按内部错误。
func (h *handlers) failBt(w http.ResponseWriter, r *http.Request, err error) {
	var f *btFail
	if errors.As(err, &f) {
		switch {
		case strings.HasPrefix(f.msg, failParam):
			h.fail(w, r, apiErr(errValidation, "%s", f.msg))
			return
		case strings.HasPrefix(f.msg, failData):
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": map[string]string{"code": errUpstream.Error(), "message": f.msg}})
			return
		}
	}
	h.fail(w, r, err)
}
