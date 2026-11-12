// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 回测任务（TRD-04b）：落 trade_backtests（迁移 0004），后台常驻任务 trade_backtests 排队执行，最多同时跑 2 个，
// 其余排队（status=queued）。历史 K 线从行情缓存取（klines.go），缓存里缺的先找交易所补齐；
// 回测区间（config.bars 根）取不全时任务失败，写明缺哪一段；只缺指标预热的部分时照跑，在 note 里写明。
// 进度写进库，前端轮询 GET /api/trade/backtests 看（只在有排队、运行中的时候轮询）。
// 后端重启（或插件停用）时还在跑的标为失败、可以重跑；排队中的接着排。
// 只做回测：不碰下单、撤单、划转、提币，代码模式也不执行源码（按 CodeKindOf 的内置近似）。

const (
	btParallel    = 2
	btPollEvery   = 2 * time.Second
	btProgressGap = 300 * time.Millisecond
	klinePage     = 1000 // 行情缓存一次最多取多少根
)

// 失败原因的三类开头，前端照原样显示
const (
	failData   = "数据缺失："
	failParam  = "参数不合法："
	failEngine = "引擎错误："
	// 后端重启、插件停用时打断的
	failAbort = "回测被中断："
	abortMsg  = failAbort + "后端重启或插件停用时这次回测还没跑完，可以重新回测"
)

// Backtest 同原型 Backtest，多了开始时间、实际用到的数据区间和最近一次参数扫描。
// data_from、data_to 是第一根、最后一根 K 线的开盘时间，没跑完为空串。
type Backtest struct {
	ID               string          `json:"id"`
	StrategyID       string          `json:"-"`
	Name             string          `json:"name"`
	Config           BacktestConfig  `json:"config"`
	Status           string          `json:"status"`
	Progress         float64         `json:"progress"`
	StrategySnapshot Strategy        `json:"strategy_snapshot"`
	Result           *BacktestResult `json:"result,omitempty"`
	Error            string          `json:"error,omitempty"`
	CreatedAt        string          `json:"created_at"`
	StartedAt        string          `json:"started_at,omitempty"`
	FinishedAt       string          `json:"finished_at,omitempty"`
	DataFrom         string          `json:"data_from,omitempty"`
	DataTo           string          `json:"data_to,omitempty"`
	Sweep            *SweepRecord    `json:"sweep,omitempty"`
}

// BacktestBrief 是列表里的一条：没有资金曲线、成交和扫描，只带统计和说明。
type BacktestBrief struct {
	ID               string         `json:"id"`
	Name             string         `json:"name"`
	Config           BacktestConfig `json:"config"`
	Status           string         `json:"status"`
	Progress         float64        `json:"progress"`
	StrategySnapshot Strategy       `json:"strategy_snapshot"`
	Stats            *BacktestStats `json:"stats,omitempty"`
	Note             string         `json:"note,omitempty"`
	Error            string         `json:"error,omitempty"`
	CreatedAt        string         `json:"created_at"`
	StartedAt        string         `json:"started_at,omitempty"`
	FinishedAt       string         `json:"finished_at,omitempty"`
	DataFrom         string         `json:"data_from,omitempty"`
	DataTo           string         `json:"data_to,omitempty"`
}

// SweepRecord 是一次参数扫描：同一份配置、同一段数据，只改 param 各跑一次。
type SweepRecord struct {
	Param  string       `json:"param"`
	Points []SweepPoint `json:"points"`
	At     string       `json:"at"`
}

func msStamp(ms int64) string {
	if ms == 0 {
		return ""
	}
	return stamp(time.UnixMilli(ms))
}

const btCols = `id, strategy_id, name, config, status, progress, strategy_snapshot, error, created_at, started_at, finished_at, data_from, data_to`

type btRow struct {
	b        Backtest
	from, to int64
}

func scanBacktestHead(row plugin.Row, extra ...any) (btRow, error) {
	var x btRow
	var cfg, snap string
	dest := append([]any{&x.b.ID, &x.b.StrategyID, &x.b.Name, &cfg, &x.b.Status, &x.b.Progress, &snap, &x.b.Error,
		&x.b.CreatedAt, &x.b.StartedAt, &x.b.FinishedAt, &x.from, &x.to}, extra...)
	if err := row.Scan(dest...); err != nil {
		return x, err
	}
	if err := json.Unmarshal([]byte(cfg), &x.b.Config); err != nil {
		return x, fmt.Errorf("回测 %s 的配置解不开：%w", x.b.ID, err)
	}
	if x.b.Config.Symbols == nil {
		x.b.Config.Symbols = []string{}
	}
	if x.b.Config.Params == nil {
		x.b.Config.Params = Params{}
	}
	if err := json.Unmarshal([]byte(snap), &x.b.StrategySnapshot); err != nil {
		return x, fmt.Errorf("回测 %s 的策略快照解不开：%w", x.b.ID, err)
	}
	_ = x.b.StrategySnapshot.normalizeRead()
	x.b.DataFrom, x.b.DataTo = msStamp(x.from), msStamp(x.to)
	return x, nil
}

func loadBacktest(ctx context.Context, c plugin.Core, id string) (Backtest, int64, error) {
	var result, sweep string
	x, err := scanBacktestHead(c.Store().QueryRow(ctx, `SELECT `+btCols+`, result, sweep FROM trade_backtests WHERE id = ?`, id), &result, &sweep)
	if errors.Is(err, plugin.ErrNoRows) {
		return x.b, 0, apiErr(errNotFound, "回测 %s 不存在", id)
	}
	if err != nil {
		return x.b, 0, err
	}
	if result != "" {
		var res BacktestResult
		if err := json.Unmarshal([]byte(result), &res); err != nil {
			return x.b, 0, fmt.Errorf("回测 %s 的结果解不开：%w", id, err)
		}
		x.b.Result = &res
	}
	if sweep != "" {
		var sw SweepRecord
		if json.Unmarshal([]byte(sweep), &sw) == nil {
			x.b.Sweep = &sw
		}
	}
	return x.b, x.to, nil
}

// ---- 执行 ----

type btRunner struct {
	p    *Plugin
	c    plugin.Core
	now  func() time.Time
	wake chan struct{}

	mu      sync.Mutex
	running map[string]context.CancelFunc
}

func newBtRunner(p *Plugin, c plugin.Core) *btRunner {
	now := p.now
	if now == nil {
		now = time.Now
	}
	return &btRunner{p: p, c: c, now: func() time.Time { return now().UTC() }, wake: make(chan struct{}, 1), running: map[string]context.CancelFunc{}}
}

// poke 叫醒调度（新建、重跑后马上开始，不等下一轮）。
func (b *btRunner) poke() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

// cancel 打断一个正在跑的回测（删除时用），回是否在跑。
func (b *btRunner) cancel(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if f, ok := b.running[id]; ok {
		f()
		return true
	}
	return false
}

// recover 把上次进程留下的 running 标为失败。只在调度起来、还没开始跑新的之前调。
func (b *btRunner) recoverStale(ctx context.Context) {
	res, err := b.c.Store().Exec(ctx, `UPDATE trade_backtests SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'`,
		abortMsg, stamp(b.now()))
	if err != nil {
		b.c.Log().Warn("mark interrupted backtests failed", "err", err)
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		b.c.Log().Info("interrupted backtests marked failed", "count", n)
	}
}

// run 是常驻任务：取排队的回测，最多 btParallel 个同时跑，直到插件停用。
func (b *btRunner) run(ctx context.Context) error {
	b.recoverStale(ctx)
	var wg sync.WaitGroup
	done := make(chan struct{}, btParallel)
	t := time.NewTicker(btPollEvery)
	defer t.Stop()
	for {
		for b.slots() > 0 {
			id, ok := b.claim(ctx)
			if !ok {
				break
			}
			jctx, cancel := context.WithCancel(ctx)
			b.mu.Lock()
			b.running[id] = cancel
			b.mu.Unlock()
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() {
					cancel()
					b.mu.Lock()
					delete(b.running, id)
					b.mu.Unlock()
					select {
					case done <- struct{}{}:
					default:
					}
				}()
				b.execute(jctx, id)
			}()
		}
		select {
		case <-ctx.Done():
			wg.Wait()
			return nil
		case <-b.wake:
		case <-done:
		case <-t.C:
		}
	}
}

func (b *btRunner) slots() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return btParallel - len(b.running)
}

// claim 把最早排队的一条改成 running，回它的 id；没有排队的回 false。
func (b *btRunner) claim(ctx context.Context) (string, bool) {
	for range 3 {
		var id string
		err := b.c.Store().QueryRow(ctx, `SELECT id FROM trade_backtests WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`).Scan(&id)
		if err != nil {
			return "", false
		}
		res, err := b.c.Store().Exec(ctx, `UPDATE trade_backtests SET status = 'running', progress = 0, started_at = ? WHERE id = ? AND status = 'queued'`,
			stamp(b.now()), id)
		if err != nil {
			return "", false
		}
		if n, _ := res.RowsAffected(); n == 1 {
			return id, true
		}
	}
	return "", false
}

// progress 写进度，节流；写不进去不影响回测。
type progress struct {
	b    *btRunner
	ctx  context.Context
	id   string
	at   time.Time
	last float64
}

func (p *progress) set(v float64) {
	v = min(max(v, 0), 0.99)
	if v <= p.last || time.Since(p.at) < btProgressGap {
		return
	}
	p.last, p.at = v, time.Now()
	_, _ = p.b.c.Store().Exec(p.ctx, `UPDATE trade_backtests SET progress = ? WHERE id = ? AND status = 'running'`, v, p.id)
}

// btFail 是带分类开头的失败原因。
type btFail struct{ msg string }

func (e *btFail) Error() string { return e.msg }

func failf(kind, format string, args ...any) error {
	return &btFail{kind + fmt.Sprintf(format, args...)}
}

// execute 跑一条回测，结果、失败都写库。
func (b *btRunner) execute(ctx context.Context, id string) {
	wctx := context.WithoutCancel(ctx)
	bt, _, err := loadBacktest(wctx, b.c, id)
	if err != nil {
		b.c.Log().Error("load backtest failed", "id", id, "err", err)
		b.finishFail(wctx, id, Backtest{}, failEngine+err.Error())
		return
	}
	pr := &progress{b: b, ctx: wctx, id: id}
	res, from, to, err := b.compute(ctx, bt, time.Time{}, pr.set)
	if err != nil {
		var f *btFail
		msg := failEngine + err.Error()
		switch {
		case ctx.Err() != nil:
			// 停机、停用、删除时取数被打断，报的错不算数据缺失
			msg = abortMsg
		case errors.As(err, &f):
			msg = f.msg
		}
		b.finishFail(wctx, id, bt, msg)
		return
	}
	body, err := json.Marshal(res)
	if err != nil {
		b.finishFail(wctx, id, bt, failEngine+err.Error())
		return
	}
	stats, _ := json.Marshal(res.Stats)
	if _, err := b.c.Store().Exec(wctx, `UPDATE trade_backtests SET status = 'done', progress = 1, result = ?, stats = ?, note = ?, error = '',
		data_from = ?, data_to = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
		string(body), string(stats), res.Note, from, to, stamp(b.now()), id); err != nil {
		b.c.Log().Error("save backtest result failed", "id", id, "err", err)
	}
}

func (b *btRunner) finishFail(ctx context.Context, id string, bt Backtest, msg string) {
	if _, err := b.c.Store().Exec(ctx, `UPDATE trade_backtests SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
		msg, stamp(b.now()), id); err != nil {
		b.c.Log().Error("save backtest failure failed", "id", id, "err", err)
	}
	if strings.HasPrefix(msg, failAbort) || bt.ID == "" {
		return
	}
	// 同原型：回测失败记一条 error 级运行异常；同一个策略同一类原因合并
	kind := "engine"
	switch {
	case strings.HasPrefix(msg, failData):
		kind = "data"
	case strings.HasPrefix(msg, failParam):
		kind = "param"
	}
	name := bt.StrategySnapshot.Name
	if name == "" {
		name = "未命名策略"
	}
	err := b.c.Incidents().Record(ctx, plugin.Incident{
		Fingerprint: "trade:backtest:" + bt.StrategyID + ":" + kind, Level: "error", Module: "交易",
		Title: "「" + name + "」回测失败", Message: msg,
		Context: map[string]any{"回测": bt.Name, "回测 id": bt.ID, "策略 id": bt.StrategyID},
	})
	if err != nil && !errors.Is(err, plugin.ErrNoIncidents) {
		b.c.Log().Warn("record backtest incident failed", "id", id, "err", err)
	}
}

// compute 取数据、跑引擎。end 为零表示截至最近一根收盘的 K 线；回实际用到的数据区间（毫秒）。
func (b *btRunner) compute(ctx context.Context, bt Backtest, end time.Time, onProgress func(float64)) (BacktestResult, int64, int64, error) {
	st, cfg := bt.StrategySnapshot, bt.Config
	if err := st.Validate(); err != nil {
		return BacktestResult{}, 0, 0, failf(failParam, "%v", err)
	}
	if err := checkConfig(cfg); err != nil {
		return BacktestResult{}, 0, 0, failf(failParam, "%v", err)
	}
	h, err := newHistory(ctx, b, cfg, end, onProgress)
	if err != nil {
		return BacktestResult{}, 0, 0, err
	}
	var res BacktestResult
	func() {
		defer func() {
			if r := recover(); r != nil {
				b.c.Log().Error("backtest engine panic", "id", bt.ID, "panic", r, "stack", string(debug.Stack()))
				err = failf(failEngine, "%v", r)
			}
		}()
		res = RunBacktest(cfg, st, h.data())
	}()
	if ctx.Err() != nil {
		return res, 0, 0, ctx.Err()
	}
	if err != nil {
		return res, 0, 0, err
	}
	if err := h.check(); err != nil {
		return res, 0, 0, err
	}
	if extra := h.notes(); extra != "" {
		if res.Note != "" {
			res.Note += "；"
		}
		res.Note += extra
	}
	var from, to int64
	if n := len(res.Equity); n > 0 {
		from, to = res.Equity[0].T, res.Equity[n-1].T
	}
	return res, from, to, nil
}

// checkConfig 是发起和执行时都查的配置范围（SPEC-strategy-0 BacktestConfig）。
func checkConfig(cfg BacktestConfig) error {
	var errs []string
	if len(cfg.Symbols) == 0 {
		errs = append(errs, "先选至少一个标的")
	}
	for _, s := range cfg.Symbols {
		if !ValidSymbol(s) {
			errs = append(errs, "标的格式不对："+s)
		}
	}
	if _, ok := Intervals[cfg.Interval]; !ok {
		errs = append(errs, "周期不认识："+cfg.Interval)
	}
	if cfg.Bars < 50 || cfg.Bars > 5000 {
		errs = append(errs, "K 线根数要在 50 到 5000")
	}
	if !(cfg.Capital > 0) || !finite(cfg.Capital) {
		errs = append(errs, "初始资金要大于 0")
	}
	if cfg.FeeBp < 0 || !finite(cfg.FeeBp) {
		errs = append(errs, "手续费不能为负")
	}
	if cfg.SlippageTicks < 0 || !finite(cfg.SlippageTicks) {
		errs = append(errs, "滑点不能为负")
	}
	for _, p := range cfg.Params {
		if !finite(p.Value) {
			errs = append(errs, "参数 "+p.Key+" 不是有限数")
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "；"))
	}
	return nil
}

// ---- 历史数据 ----

// history 给引擎供数据：标的从 trade_instruments 读，K 线从行情缓存按页取（缺的缓存会找交易所补）。
// 引擎的回调不能回错，取数的问题记在这里，跑完由 check 统一判。
type history struct {
	ctx      context.Context
	b        *btRunner
	cfg      BacktestConfig
	end      time.Time // 最后一根 K 线的开盘时间
	step     time.Duration
	insts    map[string]*Instrument
	progress func(float64)
	loaded   int // 已取完的标的数，算进度用
	want     int

	errs  []string
	short []string
}

func newHistory(ctx context.Context, b *btRunner, cfg BacktestConfig, end time.Time, onProgress func(float64)) (*history, error) {
	step := Intervals[cfg.Interval]
	if end.IsZero() {
		// 最近一根已经收盘的
		end = alignOpen(b.now(), cfg.Interval).Add(-step)
	} else {
		end = alignOpen(end, cfg.Interval)
	}
	h := &history{ctx: ctx, b: b, cfg: cfg, end: end, step: step, insts: map[string]*Instrument{}, progress: onProgress, want: len(cfg.Symbols)}
	for _, s := range cfg.Symbols {
		if b.p.sourceFor(s) == nil {
			return nil, failf(failData, "%s 的行情源还没接，现在只有 Binance、OKX 的数币行情能回测", s)
		}
		in, ok := h.instrument(s)
		if !ok {
			return nil, failf(failData, "标的表里没有 %s：行情源还没同步标的，或交易所没有这个标的；到「行情」里搜一下或稍后再试", s)
		}
		_ = in
	}
	if onProgress != nil {
		onProgress(0.02)
	}
	return h, nil
}

func (h *history) instrument(sym string) (Instrument, bool) {
	if in, ok := h.insts[sym]; ok {
		if in == nil {
			return Instrument{}, false
		}
		return *in, true
	}
	in, err := scanInstrument(h.b.c.Store().QueryRow(h.ctx, `SELECT `+instCols+` FROM trade_instruments WHERE symbol = ?`, sym))
	if err != nil {
		h.insts[sym] = nil
		return Instrument{}, false
	}
	h.insts[sym] = &in
	return in, true
}

func (h *history) data() BacktestData {
	return BacktestData{Instrument: h.instrument, Bars: h.bars}
}

func (h *history) fmtT(ms int64) string {
	t := time.UnixMilli(ms).UTC()
	if h.cfg.Interval == "1d" || h.cfg.Interval == "1w" {
		return t.Format("2006-01-02")
	}
	return t.Format("2006-01-02 15:04") + " UTC"
}

// bars 取截至 end 的最近 count 根，一页 1000 根往前翻；交易所更早没有数据了就停。
func (h *history) bars(sym, iv string, count int) []Bar {
	if count <= 0 || h.ctx.Err() != nil {
		return nil
	}
	if h.b.p.sourceFor(sym) == nil {
		h.errs = append(h.errs, sym+" 的行情源还没接")
		return nil
	}
	step := h.step.Milliseconds()
	endMs := h.end.UnixMilli()
	startMs := endMs - int64(count-1)*step
	var got []Kline
	end := h.end
	pages := count/klinePage + 3
	for p := 0; p < pages && len(got) < count; p++ {
		if h.ctx.Err() != nil {
			return nil
		}
		ks, meta, err := h.b.p.mkt.klines(h.ctx, sym, iv, klinePage, end)
		if err != nil {
			h.errs = append(h.errs, fmt.Sprintf("取 %s 的 K 线失败：%v", sym, err))
			return nil
		}
		if meta.Status == "error" || meta.Status == "no_source" {
			h.errs = append(h.errs, fmt.Sprintf("取 %s 的 K 线失败：%s", sym, meta.Error))
			return nil
		}
		if meta.Status == "stale" && len(ks) < klinePage {
			// 交易所取不到，缓存里也不全：不能当成「更早没有数据」
			h.errs = append(h.errs, fmt.Sprintf("%s 的 K 线没取全（%s 之前的那一页），交易所暂时取不到：%s", sym, h.fmtT(end.UnixMilli()), meta.Error))
			return nil
		}
		got = append(ks, got...)
		if h.progress != nil && h.want > 0 {
			frac := min(1, float64(len(got))/float64(count))
			h.progress(0.05 + 0.85*(float64(h.loaded)+frac)/float64(h.want))
		}
		if len(ks) == 0 {
			break
		}
		end = ks[0].Time.Add(-h.step)
		if end.UnixMilli() < startMs-int64(klinePage)*step*2 {
			break
		}
	}
	h.loaded++
	if len(got) > count {
		got = got[len(got)-count:]
	}
	bs := BarsOf(got)
	need := h.cfg.Bars
	if len(bs) < need {
		first := endMs + step // 一根都没有时整段都缺
		if len(bs) > 0 {
			first = bs[0].T
		}
		reqFrom := endMs - int64(need-1)*step
		h.errs = append(h.errs, fmt.Sprintf("%s %s 要最近 %d 根（%s 到 %s），只取到 %d 根；缺 %s 到 %s 这一段，交易所更早没有数据（可能是上市不久），把 K 线根数调小或换周期",
			sym, iv, need, h.fmtT(reqFrom), h.fmtT(endMs), len(bs), h.fmtT(reqFrom), h.fmtT(first-step)))
	} else if len(bs) < count {
		h.short = append(h.short, fmt.Sprintf("%s 指标预热少了 %d 根，开头一段指标可能不准", sym, count-len(bs)))
	}
	return bs
}

// check 回取数时记下的问题：取不到、回测区间不够都算数据缺失。
func (h *history) check() error {
	if len(h.errs) == 0 {
		return nil
	}
	return failf(failData, "%s", strings.Join(uniqTrim(h.errs), "；"))
}

func (h *history) notes() string { return strings.Join(uniqTrim(h.short), "；") }
