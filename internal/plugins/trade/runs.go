package trade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 策略部署到模拟盘（TRD-05b）：表 trade_runs、trade_run_logs（迁移 0006）。
// 「部署」是策略在一个账户上长期跑，和 SOP 的「执行」分开建模。
//
// 信号：后台任务 trade_runs 每 runEvery 看一遍运行中的部署，每个标的在策略周期的 K 线收盘后算一次信号。
// 规则和指标复用回测引擎（backtest.go 的 ApplyParams、Series、warmOf、evalGroup、fallbackMa），和回测同一套口径：
//   - 条件规则：只做多 / 只做空 / 多空双向的开平仓同回测约定 6；止损止盈按收盘那根 K 线的最高最低价判断（约定 1），
//     触发了按市价平仓（回测按止损价成交，实盘模拟只能按最新价加滑点）；
//   - 代码策略：双均线近似同回测；网格近似按收盘价算目标仓位，差超过半格就下单补齐；期现基差不能部署（要两条腿同时成交，模拟盘还不支持）。
// 开仓数量：分配资金平均分给每个标的，乘仓位比例，除以（收盘价 × 乘数），按最小下单量向下取整；不够一手不开，写日志。
// 下单走统一入口 paper.place（市价单，source=run），风控逐笔检查；被拦写 warn 日志。幂等键是「部署 + 标的 + K 线时间 + 动作」，
// 同一根 K 线重算不会重复下单。
// 部署自己的持仓按 run_id 是它的成交重放（applyFill）算，平仓数量不超过账户里这个标的同方向的持仓。
//
// 重启：运行中的部署照常继续。每个标的记着算到的最后一根 K 线（last_bars），重启后中间错过的 K 线逐根补算信号、写进日志，
// 但不补下单；只有刚收盘的那根（收盘后 runGrace 以内）才下单。暂停、停止后再启动不补算，从启动时最近收盘的那根之后接着算。

// runEvery 是检查间隔；测试里改小。
var runEvery = 5 * time.Second

const (
	runListLogs   = 60
	runDetailLogs = 500
	maxRunCapital = 1e9
)

// RunStatuses 同原型 RunStatus。
var RunStatuses = []string{"running", "paused", "stopped", "error"}

// Run 是 trade_runs 的一行。
type Run struct {
	ID         string
	StrategyID string
	Strategy   Strategy
	AccountID  string
	Symbols    []string
	Params     Params
	Capital    fx
	Status     string
	Error      string
	StoppedAt  string
	StopReason string
	LastBars   map[string]int64
	StartedAt  string
	CreatedAt  string
	UpdatedAt  string
}

const runCols = `id, strategy_id, strategy_snapshot, account_id, symbols, params, capital_e8, status, error, stopped_at, stop_reason, last_bars, started_at, created_at, updated_at`

func scanRun(row plugin.Row) (Run, error) {
	var x Run
	var snap, syms, params, bars string
	err := row.Scan(&x.ID, &x.StrategyID, &snap, &x.AccountID, &syms, &params, &x.Capital, &x.Status, &x.Error, &x.StoppedAt, &x.StopReason, &bars,
		&x.StartedAt, &x.CreatedAt, &x.UpdatedAt)
	if err != nil {
		return x, err
	}
	_ = json.Unmarshal([]byte(snap), &x.Strategy)
	_ = x.Strategy.normalizeRead()
	if json.Unmarshal([]byte(syms), &x.Symbols) != nil || x.Symbols == nil {
		x.Symbols = []string{}
	}
	if json.Unmarshal([]byte(params), &x.Params) != nil || x.Params == nil {
		x.Params = Params{}
	}
	if json.Unmarshal([]byte(bars), &x.LastBars) != nil || x.LastBars == nil {
		x.LastBars = map[string]int64{}
	}
	return x, nil
}

func loadRun(ctx context.Context, c plugin.Core, id string) (Run, error) {
	x, err := scanRun(c.Store().QueryRow(ctx, `SELECT `+runCols+` FROM trade_runs WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return x, apiErr(errNotFound, "部署 %s 不存在", id)
	}
	return x, err
}

func queryRuns(ctx context.Context, c plugin.Core, where string, args ...any) ([]Run, error) {
	rows, err := c.Store().Query(ctx, `SELECT `+runCols+` FROM trade_runs `+where, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Run{}
	for rows.Next() {
		x, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// RunLog 是一条部署日志。
type RunLog struct {
	At    string `json:"at"`
	Level string `json:"level"`
	Text  string `json:"text"`
}

type runner struct {
	p       *Plugin
	c       plugin.Core
	now     func() time.Time
	started time.Time
	wake    chan struct{}

	evalMu  sync.Mutex // 一次只跑一轮
	mu      sync.Mutex
	resumed map[string]bool
	errs    map[string]string // 部署 + 标的 -> 上一次取数出错的原因，变了才写日志
}

func newRunner(p *Plugin, c plugin.Core) *runner {
	r := &runner{p: p, c: c, now: p.mkt.now, wake: make(chan struct{}, 1), resumed: map[string]bool{}, errs: map[string]string{}}
	r.started = r.now()
	return r
}

func (rn *runner) poke() {
	select {
	case rn.wake <- struct{}{}:
	default:
	}
}

// log 写一条部署日志（不在账本锁里也能调）。
func (rn *runner) log(ctx context.Context, runID, level, text string) {
	if _, err := rn.c.Store().Exec(ctx, `INSERT INTO trade_run_logs (run_id, at, level, text) VALUES (?, ?, ?, ?)`, runID, stamp(rn.now()), level, text); err != nil {
		rn.c.Log().Warn("write run log failed", "run", runID, "err", err)
	}
}

func (rn *runner) logs(ctx context.Context, runID string, limit int) ([]RunLog, int, error) {
	var total int
	if err := rn.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_run_logs WHERE run_id = ?`, runID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := rn.c.Store().Query(ctx, `SELECT at, level, text FROM trade_run_logs WHERE run_id = ? ORDER BY id DESC LIMIT ?`, runID, limit)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	out := []RunLog{}
	for rows.Next() {
		var l RunLog
		if err := rows.Scan(&l.At, &l.Level, &l.Text); err != nil {
			return nil, 0, err
		}
		out = append(out, l)
	}
	slices.Reverse(out)
	return out, total, rows.Err()
}

func (rn *runner) setStatus(ctx context.Context, x Run, status, errText, stoppedAt, stopReason string) error {
	_, err := rn.c.Store().Exec(ctx, `UPDATE trade_runs SET status = ?, error = ?, stopped_at = ?, stop_reason = ?, updated_at = ? WHERE id = ?`,
		status, errText, stoppedAt, stopReason, stamp(rn.now()), x.ID)
	return err
}

// stopAllLocked 把所有没停的部署停掉（一键全停用，调用方持有账本锁）。
func (rn *runner) stopAllLocked(ctx context.Context, reason string, m plugin.WriteMeta) (int, []string) {
	runs, err := queryRuns(ctx, rn.c, `WHERE status != 'stopped'`)
	if err != nil {
		return 0, []string{err.Error()}
	}
	n := 0
	var failed []string
	now := stamp(rn.now())
	for _, x := range runs {
		res, err := rn.c.Store().Exec(ctx, `UPDATE trade_runs SET status = 'stopped', stopped_at = ?, stop_reason = ?, updated_at = ? WHERE id = ? AND status != 'stopped'`,
			now, reason, now, x.ID)
		if err != nil {
			failed = append(failed, x.ID+"："+err.Error())
			continue
		}
		if k, _ := res.RowsAffected(); k == 1 {
			n++
			rn.log(ctx, x.ID, "warn", reason)
			rn.p.paper.audit(ctx, "stop", "trade_run", x.ID, "停止部署「"+x.Strategy.Name+"」："+reason, map[string]any{"reason": reason, "from": x.Status}, m)
		}
	}
	return n, failed
}

// stopLocked 停一个部署并撤掉它的挂单（持仓保留）。
func (rn *runner) stopLocked(ctx context.Context, x Run, reason string, m plugin.WriteMeta) error {
	if x.Status == "stopped" {
		return nil
	}
	now := stamp(rn.now())
	if err := rn.setStatus(ctx, x, "stopped", "", now, reason); err != nil {
		return err
	}
	n, _, err := rn.p.paper.cancelWhereLocked(ctx, ` AND run_id = ?`, "部署已停止", m, x.ID)
	if err != nil {
		return err
	}
	text := reason + "；持仓保留，不自动平仓"
	if n > 0 {
		text += fmt.Sprintf("；撤了 %d 笔挂单", n)
	}
	rn.log(ctx, x.ID, "info", text)
	rn.p.paper.audit(ctx, "stop", "trade_run", x.ID, "停止部署「"+x.Strategy.Name+"」："+reason, map[string]any{"reason": reason, "from": x.Status, "orders_canceled": n}, m)
	return nil
}

// stopForStrategy：删策略时停掉它没停的部署（原因「策略已删除」）、撤它们的挂单。
func (rn *runner) stopForStrategy(ctx context.Context, strategyID string) error {
	pp := rn.p.paper
	pp.mu.Lock()
	defer pp.mu.Unlock()
	runs, err := queryRuns(ctx, rn.c, `WHERE strategy_id = ? AND status != 'stopped'`, strategyID)
	if err != nil {
		return err
	}
	for _, x := range runs {
		if err := rn.stopLocked(ctx, x, "策略已删除", userMeta); err != nil {
			return err
		}
	}
	return nil
}

/* ---------- 部署自己的持仓和盈亏 ---------- */

// runBook 是一个部署按自己的成交重放出来的账：每个标的的持仓、已实现、手续费。
type runBook struct {
	pos      map[string]posState
	realized fx
	fees     fx
}

func (rn *runner) book(ctx context.Context, runID string) (runBook, error) {
	fills, err := queryFills(ctx, rn.c, `WHERE run_id = ? ORDER BY seq`, runID)
	if err != nil {
		return runBook{}, err
	}
	b := runBook{pos: map[string]posState{}}
	for _, f := range fills {
		d := f.Qty
		if f.Side == "sell" {
			d = -d
		}
		np, r, err := applyFill(b.pos[f.Symbol], d, f.Notional, f.Pos.Lev, runID, f.At, func() string { return f.Pos.ID })
		if err != nil {
			return b, err
		}
		b.pos[f.Symbol] = np
		b.realized += r
		b.fees += f.Fee
	}
	return b, nil
}

// pnl 是部署的盈亏：已实现 − 手续费 + 部署持仓按现价的未实现。
func (rn *runner) pnl(ctx context.Context, b runBook) (fx, fx) {
	var unreal fx
	for sym, p := range b.pos {
		if p.Qty == 0 {
			continue
		}
		in, ok := loadLedgerInst(ctx, rn.c, sym)
		if !ok {
			continue
		}
		px, _, _ := rn.p.paper.markOf(ctx, sym)
		if px == 0 {
			continue
		}
		mv, err := fxMul3(p.Qty, px, in.Mult)
		if err == nil {
			unreal += mv - p.Cost
		}
	}
	return b.realized - b.fees + unreal, unreal
}

/* ---------- 新建 ---------- */

var runFields = []string{"strategy_id", "account_id", "symbols", "params", "capital"}

// deployKind 是部署按什么跑：rules（条件规则，含退回双均线的代码策略）、grid（网格近似）；期现基差回错。
func deployKind(st Strategy) (string, error) {
	if st.Mode != "code" {
		return "rules", nil
	}
	switch CodeKindOf(st) {
	case CodeGrid:
		return "grid", nil
	case CodeBasis:
		return "", apiErr(errValidation, "期现基差的代码策略要两条腿同时成交，模拟盘还不能部署")
	}
	return "rules", nil
}

// effective 是部署实际跑的规则：代码策略的双均线近似换成条件规则（同回测）。
func (x Run) effective() Strategy {
	st := x.Strategy
	if st.Mode == "code" && CodeKindOf(st) != CodeGrid {
		return fallbackMa(st, BacktestConfig{Params: x.Params})
	}
	return st
}

func (h *handlers) createRun(ctx context.Context, raw map[string]json.RawMessage) (Run, error) {
	for k := range raw {
		if !slices.Contains(runFields, k) {
			return Run{}, apiErr(errValidation, "不认识的字段 %s", k)
		}
	}
	var sid, aid string
	if json.Unmarshal(raw["strategy_id"], &sid) != nil || strings.TrimSpace(sid) == "" {
		return Run{}, apiErr(errValidation, "选一个策略（strategy_id）")
	}
	_ = json.Unmarshal(raw["account_id"], &aid)
	pp := h.p.paper
	a, err := paperAccount(ctx, h.c, aid)
	if err != nil {
		return Run{}, err
	}
	st, err := loadStrategy(ctx, h.c, sid)
	if err != nil {
		return Run{}, err
	}
	if err := st.Validate(); err != nil {
		return Run{}, apiErr(errValidation, "策略不合法：%v", err)
	}
	kind, err := deployKind(st)
	if err != nil {
		return Run{}, err
	}
	if kind == "rules" && st.Mode == "rules" && len(st.Entry.Rules) == 0 {
		return Run{}, apiErr(errValidation, "策略的入场规则为空，部署了也不会开仓")
	}
	rules, err := pp.risk(ctx)
	if err != nil {
		return Run{}, err
	}
	if rules.Halted {
		return Run{}, errHalted
	}
	// 标的：没传取策略里账户支持、能模拟的全部；传了要是策略标的的子集
	var syms []string
	if v, ok := raw["symbols"]; ok {
		if json.Unmarshal(v, &syms) != nil {
			return Run{}, apiErr(errValidation, "symbols 要是字符串数组")
		}
		syms = uniqTrim(syms)
		for _, s := range syms {
			if !slices.Contains(st.Symbols, s) {
				return Run{}, apiErr(errValidation, "%s 不是这个策略的标的", s)
			}
		}
	} else {
		for _, s := range st.Symbols {
			if in, ok := loadLedgerInst(ctx, h.c, s); ok && slices.Contains(a.Markets, in.Market) && h.p.sourceFor(s) != nil {
				syms = append(syms, s)
			}
		}
	}
	if len(syms) == 0 {
		return Run{}, apiErr(errValidation, "至少选一个标的：策略里没有这个账户能模拟交易的标的")
	}
	for _, s := range syms {
		in, ok := loadLedgerInst(ctx, h.c, s)
		switch {
		case !ok:
			return Run{}, apiErr(errValidation, "标的表里没有 %s：行情源还没同步标的", s)
		case h.p.sourceFor(s) == nil:
			return Run{}, apiErr(errValidation, "%s 的行情源还没接，现在只有 Binance、OKX 的数币能部署", s)
		case !slices.Contains(a.Markets, in.Market):
			return Run{}, apiErr(errValidation, "账户「%s」不支持%s（%s）", a.Name, marketLabel(in.Market), s)
		case in.Kind == "option":
			return Run{}, apiErr(errValidation, "期权还不能部署（%s）", s)
		case !in.contract() && st.Direction != "long":
			return Run{}, apiErr(errValidation, "现货不能做空：只做多的策略才能部署到现货 %s", s)
		}
	}
	// 参数：策略参数加本次覆盖；能覆盖的是策略里有的参数和三个保留键
	params := slices.Clone(st.Params)
	if v, ok := raw["params"]; ok {
		var over Params
		if err := json.Unmarshal(v, &over); err != nil {
			return Run{}, apiErr(errValidation, "params 要是参数名到数值的对象：%v", err)
		}
		for _, p := range over {
			if !st.Params.Has(p.Key) && !slices.Contains(ReservedParams, p.Key) {
				return Run{}, apiErr(errValidation, "参数 %s 策略里没有", p.Key)
			}
			if !finite(p.Value) {
				return Run{}, apiErr(errValidation, "参数 %s 要是数字", p.Key)
			}
			if slices.Contains(ReservedParams, p.Key) && (p.Value < 0 || p.Value > 100) {
				return Run{}, apiErr(errValidation, "%s 要在 0 到 100 之间", p.Key)
			}
		}
		params = params.Merge(over)
	}
	capital := fxInt(20000)
	if v, ok := raw["capital"]; ok {
		var f float64
		if json.Unmarshal(v, &f) != nil {
			return Run{}, apiErr(errValidation, "capital 要是数字")
		}
		c, ok := fxFromFloat(f)
		if !ok || c <= 0 || f > maxRunCapital {
			return Run{}, apiErr(errValidation, "分配资金要大于 0")
		}
		capital = c
	}
	val, err := pp.value(ctx, a)
	if err != nil {
		return Run{}, err
	}
	if capital > val.Available {
		return Run{}, apiErr(errValidation, "分配资金超过账户可用 %s %s", priceText(val.Available, 2), a.Currency)
	}
	now := rnNow(h.p)
	x := Run{ID: idgen.Prefixed("rn"), StrategyID: st.ID, Strategy: st, AccountID: a.ID, Symbols: syms, Params: params, Capital: capital,
		Status: "running", LastBars: map[string]int64{}, StartedAt: stamp(now), CreatedAt: stamp(now), UpdatedAt: stamp(now)}
	var notes []string
	if kind == "grid" {
		// 网格区间没给时按现价上下 8% 定下来，之后不再变
		for _, k := range []string{"lower", "upper"} {
			if !x.Params.Has(k) {
				h.p.mkt.ensure(ctx, "ticker", syms[0])
				last, _, _ := pp.markOf(ctx, syms[0])
				if last == 0 {
					return Run{}, apiErr(errValidation, "网格没设区间，要按现价定区间，但还没有 %s 的最新价", syms[0])
				}
				f := 0.92
				if k == "upper" {
					f = 1.08
				}
				x.Params = x.Params.Set(k, roundTo(last.Float()*f, 8))
				notes = append(notes, fmt.Sprintf("%s 没设，按现价定为 %s", k, numStr(roundTo(last.Float()*f, 8))))
			}
		}
	}
	for _, s := range syms {
		x.LastBars[s] = lastClosedOpen(now, st.Interval)
	}
	snap, _ := json.Marshal(st)
	symsJSON, _ := json.Marshal(x.Symbols)
	paramsJSON, _ := json.Marshal(x.Params)
	barsJSON, _ := json.Marshal(x.LastBars)
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO trade_runs (`+runCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?, ?)`,
		x.ID, x.StrategyID, string(snap), x.AccountID, string(symsJSON), string(paramsJSON), x.Capital, x.Status, string(barsJSON), x.StartedAt, x.CreatedAt, x.UpdatedAt); err != nil {
		return Run{}, err
	}
	names := make([]string, len(syms))
	for i, s := range syms {
		in, _ := loadLedgerInst(ctx, h.c, s)
		names[i] = in.Name
	}
	text := fmt.Sprintf("模拟盘启动：%s，分配 %s %s；%s K 线收盘时算信号", strings.Join(names, "、"), priceText(capital, 2), a.Currency, st.Interval)
	if len(notes) > 0 {
		text += "；" + strings.Join(notes, "，")
	}
	h.p.runs.log(ctx, x.ID, "info", text)
	pp.audit(ctx, "deploy", "trade_run", x.ID, "部署「"+st.Name+"」到模拟盘「"+a.Name+"」",
		map[string]any{"strategy_id": st.ID, "account_id": a.ID, "symbols": syms, "params": x.Params, "capital": capital.String()}, userMeta)
	h.p.runs.mu.Lock()
	h.p.runs.resumed[x.ID] = true
	h.p.runs.mu.Unlock()
	h.p.runs.poke()
	return x, nil
}

var errHalted = errors.New("halted")

func rnNow(p *Plugin) time.Time { return p.mkt.now() }

// lastClosedOpen 是 now 时刻最近一根已经收盘的 K 线的开盘时间（毫秒）。
func lastClosedOpen(now time.Time, iv string) int64 {
	return alignOpen(now, iv).Add(-Intervals[iv]).UnixMilli()
}

/* ---------- 启停 ---------- */

// pause、resume、stop 是卡片上的三个按钮。
func (rn *runner) act(ctx context.Context, id, action, reason string) (Run, error) {
	pp := rn.p.paper
	pp.mu.Lock()
	defer pp.mu.Unlock()
	x, err := loadRun(ctx, rn.c, id)
	if err != nil {
		return x, err
	}
	switch action {
	case "pause":
		if x.Status != "running" {
			return x, apiErr(errConflictState, "只有运行中的部署能暂停")
		}
		if err := rn.setStatus(ctx, x, "paused", "", "", ""); err != nil {
			return x, err
		}
		rn.log(ctx, x.ID, "info", "手动暂停（不再出新信号，已有挂单保留）")
		pp.audit(ctx, "pause", "trade_run", x.ID, "暂停部署「"+x.Strategy.Name+"」", nil, userMeta)
	case "resume":
		if x.Status == "running" {
			return x, apiErr(errConflictState, "部署已经在运行")
		}
		r, err := pp.risk(ctx)
		if err != nil {
			return x, err
		}
		if r.Halted {
			return x, errHalted
		}
		if _, err := paperAccount(ctx, rn.c, x.AccountID); err != nil {
			return x, err
		}
		text := "手动恢复"
		if x.Status != "paused" {
			text = "重新启动"
		}
		now := rn.now()
		for _, s := range x.Symbols {
			x.LastBars[s] = lastClosedOpen(now, x.Strategy.Interval)
		}
		bars, _ := json.Marshal(x.LastBars)
		if _, err := rn.c.Store().Exec(ctx, `UPDATE trade_runs SET status = 'running', error = '', stopped_at = '', stop_reason = '', last_bars = ?, updated_at = ? WHERE id = ?`,
			string(bars), stamp(now), x.ID); err != nil {
			return x, err
		}
		rn.log(ctx, x.ID, "info", text+"；停着的这段时间不补算，从下一根收盘的 K 线开始")
		pp.audit(ctx, "resume", "trade_run", x.ID, text+"部署「"+x.Strategy.Name+"」", map[string]any{"from": x.Status}, userMeta)
		rn.mu.Lock()
		rn.resumed[x.ID] = true
		rn.mu.Unlock()
		rn.poke()
	case "stop":
		if x.Status == "stopped" {
			return x, apiErr(errConflictState, "部署已经停止")
		}
		if reason == "" {
			reason = "手动停止"
		}
		if err := rn.stopLocked(ctx, x, reason, userMeta); err != nil {
			return x, err
		}
	}
	return loadRun(ctx, rn.c, id)
}

var errConflictState = errors.New("conflict_state")

/* ---------- 信号 ---------- */

// run 是常驻任务：每 runEvery 一轮或被叫醒时，看一遍运行中的部署。
func (rn *runner) run(ctx context.Context) error {
	t := time.NewTicker(runEvery)
	defer t.Stop()
	for {
		rn.tick(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		case <-rn.wake:
		}
	}
}

func (rn *runner) tick(ctx context.Context) {
	rn.evalMu.Lock()
	defer rn.evalMu.Unlock()
	runs, err := queryRuns(ctx, rn.c, `WHERE status = 'running' ORDER BY started_at`)
	if err != nil {
		if ctx.Err() == nil {
			rn.c.Log().Warn("load runs failed", "err", err)
		}
		return
	}
	for _, x := range runs {
		if ctx.Err() != nil {
			return
		}
		if err := rn.eval(ctx, x); err != nil && ctx.Err() == nil {
			rn.c.Log().Warn("run eval failed", "run", x.ID, "err", err)
		}
	}
}

// runGrace 是一根 K 线收盘后多久以内还算「刚收盘」、可以下单：周期的十分之一，至少 1 分钟，至多一个周期。
func runGrace(iv string) time.Duration {
	step := Intervals[iv]
	return min(step, max(time.Minute, step/10))
}

// eval 算一个部署每个标的新收盘的 K 线。
func (rn *runner) eval(ctx context.Context, x Run) error {
	rn.mu.Lock()
	first := !rn.resumed[x.ID]
	rn.resumed[x.ID] = true
	rn.mu.Unlock()
	if first {
		rn.log(ctx, x.ID, "info", "后端重启，部署继续运行")
	}
	a, err := loadAccount(ctx, rn.c, x.AccountID)
	if err != nil || !a.Paper {
		why := "账户已删除"
		if err == nil {
			why = "账户不是模拟盘"
		} else if !errors.Is(err, errNotFound) {
			return err
		}
		if err := rn.setStatus(ctx, x, "error", why+"，部署已挂起", "", ""); err != nil {
			return err
		}
		rn.log(ctx, x.ID, "error", why+"，部署已挂起")
		return nil
	}
	st := x.effective()
	iv := st.Interval
	step := Intervals[iv]
	now := rn.now()
	latest := lastClosedOpen(now, iv)
	changed := false
	for _, sym := range x.Symbols {
		lb := x.LastBars[sym]
		if lb >= latest {
			continue
		}
		done, err := rn.evalSymbol(ctx, x, st, a, sym, lb, latest, step, now)
		if err != nil {
			return err
		}
		if done > lb {
			x.LastBars[sym] = done
			changed = true
		}
	}
	if changed {
		bars, _ := json.Marshal(x.LastBars)
		if _, err := rn.c.Store().Exec(ctx, `UPDATE trade_runs SET last_bars = ?, updated_at = ? WHERE id = ? AND status = 'running'`, string(bars), stamp(rn.now()), x.ID); err != nil {
			return err
		}
	}
	return nil
}

// warmFor 是规则要的预热根数（同回测，最多 600）。
func warmFor(st Strategy, params Params) int {
	entry, exit := ApplyParams(st, params)
	warm := 0
	for _, r := range append(append([]Rule{}, entry.Rules...), exit.Rules...) {
		warm = max(warm, warmOf(r.Left), warmOf(r.Right))
	}
	return min(600, warm)
}

// evalSymbol 处理一个标的 (lb, latest] 之间收盘的 K 线，回算到了哪一根（取不到数据时回 lb，下一轮再来）。
func (rn *runner) evalSymbol(ctx context.Context, x Run, st Strategy, a account, sym string, lb, latest int64, step time.Duration, now time.Time) (int64, error) {
	in, ok := loadLedgerInst(ctx, rn.c, sym)
	if !ok {
		rn.noteErr(ctx, x.ID, sym, sym+" 不在标的表里，算不了信号")
		return lb, nil
	}
	grid := st.Mode == "code" && CodeKindOf(st) == CodeGrid
	warm := 2
	if !grid {
		warm = warmFor(st, x.Params) + 2
	}
	missed := int((latest - lb) / step.Milliseconds())
	if lb == 0 {
		missed = 1
	}
	limit := min(1000, warm+missed)
	ks, meta, err := rn.p.mkt.klines(ctx, sym, st.Interval, limit, time.UnixMilli(latest).UTC())
	if err != nil || len(ks) == 0 || ks[len(ks)-1].Time.UnixMilli() != latest {
		why := "K 线还没取到"
		if err != nil {
			why = err.Error()
		} else if meta.Error != "" {
			why = meta.Error
		}
		rn.noteErr(ctx, x.ID, sym, "取 "+sym+" 的 K 线失败，等下一轮："+why)
		return lb, nil
	}
	rn.noteErr(ctx, x.ID, sym, "")
	bs := BarsOf(ks)
	var series [2][][2][]float64
	var entry, exit RuleGroup
	if !grid {
		entry, exit = ApplyParams(st, x.Params)
		for gi, g := range []RuleGroup{entry, exit} {
			sv := make([][2][]float64, len(g.Rules))
			for i, r := range g.Rules {
				sv[i] = [2][]float64{Series(r.Left, bs), Series(r.Right, bs)}
			}
			series[gi] = sv
		}
	}
	var catchup []string
	firstMissed, lastMissed, nMissed := int64(0), int64(0), 0
	if lb > 0 && int64(len(bs)) < int64(missed) {
		catchup = append(catchup, fmt.Sprintf("更早的 %d 根超出一次能取的范围，没有补算", missed-len(bs)))
	}
	for i, b := range bs {
		if b.T <= lb {
			continue
		}
		closeAt := time.UnixMilli(b.T).Add(step)
		fresh := b.T == latest && now.Sub(closeAt) <= runGrace(st.Interval)
		if !fresh {
			if nMissed == 0 {
				firstMissed = b.T
			}
			lastMissed = b.T
			nMissed++
			if !grid {
				en, ex := evalGroup(entry, series[0], i), evalGroup(exit, series[1], i)
				if en || ex {
					var s []string
					if en {
						s = append(s, "入场")
					}
					if ex {
						s = append(s, "出场")
					}
					catchup = append(catchup, barText(b.T, st.Interval)+" "+strings.Join(s, "、")+"信号")
				}
			}
			continue
		}
		if grid {
			if err := rn.actGrid(ctx, x, st, a, in, b, sym); err != nil {
				return lb, err
			}
		} else if err := rn.actRules(ctx, x, st, a, in, b, sym, evalGroup(entry, series[0], i), evalGroup(exit, series[1], i)); err != nil {
			return lb, err
		}
	}
	if nMissed > 0 {
		text := fmt.Sprintf("补算 %s %d 根 K 线（%s 到 %s）：", in.Name, nMissed, barText(firstMissed, st.Interval), barText(lastMissed, st.Interval))
		if len(catchup) == 0 {
			text += "没有信号"
		} else {
			text += strings.Join(catchup, "；")
		}
		text += "。后端没在跑时错过的 K 线只补算、不补下单"
		rn.log(ctx, x.ID, "info", text)
	}
	return latest, nil
}

func barText(ms int64, iv string) string {
	t := time.UnixMilli(ms).UTC()
	if iv == "1d" || iv == "1w" {
		return t.Format("2006-01-02")
	}
	return t.Format("01-02 15:04") + " UTC"
}

// noteErr 记取数问题：同一个问题只写一次日志，恢复后清掉。
func (rn *runner) noteErr(ctx context.Context, runID, sym, msg string) {
	key := runID + "|" + sym
	rn.mu.Lock()
	prev := rn.errs[key]
	if msg == "" {
		delete(rn.errs, key)
	} else {
		rn.errs[key] = msg
	}
	rn.mu.Unlock()
	if msg != "" && msg != prev {
		rn.log(ctx, runID, "warn", msg)
	}
}

// holding 是部署在这个标的上的持仓：按它自己的成交重放，再收到账户里同方向持仓以内（手动平掉的不算）。
func (rn *runner) holding(ctx context.Context, x Run, sym string) (posState, error) {
	b, err := rn.book(ctx, x.ID)
	if err != nil {
		return posState{}, err
	}
	mine := b.pos[sym]
	if mine.Qty == 0 {
		return posState{}, nil
	}
	acct, err := loadPosition(ctx, rn.c, x.AccountID, sym)
	if err != nil {
		return posState{}, err
	}
	if acct.Qty == 0 || acct.Qty.sign() != mine.Qty.sign() {
		return posState{}, nil
	}
	if acct.Qty.abs() < mine.Qty.abs() {
		share, _ := fxMulDiv(mine.Cost, acct.Qty.abs(), mine.Qty.abs())
		mine.Qty, mine.Cost = acct.Qty, share
	}
	return mine, nil
}

// order 经统一入口下一笔市价单；被风控拦、被拒、重复都写日志，不回错。
func (rn *runner) order(ctx context.Context, x Run, in ledgerInst, sym, side string, qty fx, reduce bool, barT int64, tag, why string) error {
	if qty <= 0 {
		return nil
	}
	o, err := rn.p.paper.place(ctx, orderReq{AccountID: x.AccountID, Symbol: sym, Side: side, Type: "market", Qty: qty, ReduceOnly: reduce && in.contract(),
		RunID: x.ID, Source: "run", ClientID: fmt.Sprintf("%s|%s|%d|%s", x.ID, sym, barT, tag)})
	var re *riskError
	var de *duplicateError
	switch {
	case errors.As(err, &re):
		rn.log(ctx, x.ID, "warn", "风控拦截："+why+"，"+strings.Join(re.Blocks, "；"))
		return nil
	case errors.As(err, &de):
		return nil
	case errors.Is(err, errRunNotRunning):
		return nil
	case errors.Is(err, errValidation):
		_, msg, _ := strings.Cut(err.Error(), ": ")
		rn.log(ctx, x.ID, "error", "下单失败："+why+"，"+msg)
		return nil
	case err != nil:
		return err
	}
	if o.Status == orderRejected {
		rn.log(ctx, x.ID, "warn", "委托被拒："+why+"，"+o.RejectReason)
		return nil
	}
	rn.log(ctx, x.ID, "info", fmt.Sprintf("%s，市价%s %s", why, sideText[side], qtyText(qty, in.Lot)))
	return nil
}

// sizeFor 是开仓数量：分配资金 / 标的数 × 仓位比例 / (价格 × 乘数)，按最小下单量向下取整。
func sizeFor(x Run, st Strategy, in ledgerInst, px float64) fx {
	pct := numOf(x.Params, "position_pct", st.PositionPct) / 100
	alloc := x.Capital.Float() / float64(max(1, len(x.Symbols)))
	raw := alloc * pct / (px * in.Mult.Float())
	q, ok := fxFromFloat(raw)
	if !ok {
		return 0
	}
	return floorLot(q, in.Lot)
}

// actRules 是条件规则在一根刚收盘的 K 线上的动作：先看止损止盈，再看信号（同回测 runRulesLeg）。
func (rn *runner) actRules(ctx context.Context, x Run, st Strategy, a account, in ledgerInst, b Bar, sym string, en, ex bool) error {
	pos, err := rn.holding(ctx, x, sym)
	if err != nil {
		return err
	}
	bt := barText(b.T, st.Interval) + " 收盘 " + numStr(b.C)
	q := pos.Qty
	sl := numOf(x.Params, "stop_loss", st.StopLoss) / 100
	tp := numOf(x.Params, "take_profit", st.TakeProfit) / 100
	closeSide := func() string {
		if q > 0 {
			return "sell"
		}
		return "buy"
	}
	if q != 0 && (sl > 0 || tp > 0) {
		dir := float64(q.sign())
		avg := pos.avgPrice(in.Mult).Float()
		stopPx, takePx := avg*(1-dir*sl), avg*(1+dir*tp)
		if sl > 0 && ((dir > 0 && b.L <= stopPx) || (dir < 0 && b.H >= stopPx)) {
			return rn.order(ctx, x, in, sym, closeSide(), q.abs(), true, b.T, "sl", bt+"：止损 "+toFixed(sl*100, 1)+"%")
		}
		if tp > 0 && ((dir > 0 && b.H >= takePx) || (dir < 0 && b.L <= takePx)) {
			return rn.order(ctx, x, in, sym, closeSide(), q.abs(), true, b.T, "tp", bt+"：止盈 "+toFixed(tp*100, 1)+"%")
		}
	}
	size := func() fx {
		n := sizeFor(x, st, in, b.C)
		if n <= 0 {
			rn.log(ctx, x.ID, "warn", bt+"：入场信号，但分配资金不足一手，没开仓")
		}
		return n
	}
	switch st.Direction {
	case "long":
		if q > 0 && ex {
			return rn.order(ctx, x, in, sym, "sell", q, true, b.T, "exit", bt+"：出场信号，平多")
		} else if q == 0 && en {
			return rn.order(ctx, x, in, sym, "buy", size(), false, b.T, "entry", bt+"：入场信号，开多")
		}
	case "short":
		if q < 0 && ex {
			return rn.order(ctx, x, in, sym, "buy", q.abs(), true, b.T, "exit", bt+"：出场信号，平空")
		} else if q == 0 && en {
			return rn.order(ctx, x, in, sym, "sell", size(), false, b.T, "entry", bt+"：入场信号，开空")
		}
	default:
		if en && q <= 0 {
			if q < 0 {
				if err := rn.order(ctx, x, in, sym, "buy", q.abs(), true, b.T, "flip", bt+"：入场信号，反手平空"); err != nil {
					return err
				}
			}
			return rn.order(ctx, x, in, sym, "buy", size(), false, b.T, "entry", bt+"：入场信号，开多")
		} else if ex && q >= 0 {
			if q > 0 {
				if err := rn.order(ctx, x, in, sym, "sell", q, true, b.T, "flip", bt+"：出场信号，反手平多"); err != nil {
					return err
				}
			}
			return rn.order(ctx, x, in, sym, "sell", size(), false, b.T, "entry", bt+"：出场信号，开空")
		}
	}
	return nil
}

// actGrid 是网格近似在一根刚收盘的 K 线上的动作（同回测 runGridLeg 的目标仓位）；亏损超过止损时平仓并停掉部署。
func (rn *runner) actGrid(ctx context.Context, x Run, st Strategy, a account, in ledgerInst, b Bar, sym string) error {
	prm := x.Params
	lower, upper := numOf(prm, "lower", 0), numOf(prm, "upper", 0)
	if !(upper > lower) || lower <= 0 {
		rn.noteErr(ctx, x.ID, sym, "网格区间不对（lower 要小于 upper），不下单")
		return nil
	}
	grids := math.Max(2, jsRound(numOf(prm, "grids", 20)))
	step := (upper - lower) / grids
	pct := numOf(prm, "position_pct", st.PositionPct) / 100
	alloc := x.Capital.Float() / float64(max(1, len(x.Symbols)))
	mid := (lower + upper) / 2
	cp := alloc * pct / (grids / 2) / (mid * in.Mult.Float())
	unit := math.Min(numOf(prm, "qty", cp), cp)
	pos, err := rn.holding(ctx, x, sym)
	if err != nil {
		return err
	}
	bt := barText(b.T, st.Interval) + " 收盘 " + numStr(b.C)
	if sl := numOf(prm, "stop_loss", st.StopLoss) / 100; sl > 0 {
		book, err := rn.book(ctx, x.ID)
		if err != nil {
			return err
		}
		pnl, _ := rn.pnl(ctx, book)
		if pnl.Float() < -alloc*sl {
			side := "sell"
			if pos.Qty < 0 {
				side = "buy"
			}
			if err := rn.order(ctx, x, in, sym, side, pos.Qty.abs(), true, b.T, "gridstop", bt+"：亏损超过 "+toFixed(sl*100, 0)+"% 停止网格"); err != nil {
				return err
			}
			pp := rn.p.paper
			pp.mu.Lock()
			defer pp.mu.Unlock()
			cur, err := loadRun(ctx, rn.c, x.ID)
			if err != nil {
				return err
			}
			return rn.stopLocked(ctx, cur, "亏损超过 "+toFixed(sl*100, 0)+"% 停止网格", runMeta(x.ID))
		}
	}
	level := math.Max(0, math.Min(grids, math.Floor((b.C-lower)/step)))
	target := (grids/2 - level) * unit
	if st.Direction == "long" {
		target = math.Max(target, 0)
	}
	if st.Direction == "short" {
		target = math.Min(target, 0)
	}
	tq, ok := fxFromFloat(target)
	if !ok {
		return nil
	}
	dq := tq - pos.Qty
	half, _ := fxFromFloat(unit * 0.5)
	if dq.abs() <= half {
		return nil
	}
	dqLot := floorLot(dq.abs(), in.Lot)
	if dqLot <= 0 {
		return nil
	}
	side := "buy"
	if dq < 0 {
		side = "sell"
	}
	reduce := pos.Qty != 0 && (pos.Qty > 0) != (side == "buy") && dqLot <= pos.Qty.abs()
	return rn.order(ctx, x, in, sym, side, dqLot, reduce, b.T, "grid", bt+"：网格第 "+numStr(level)+" 格")
}

var errRunNotRunning = errors.New("run not running")
