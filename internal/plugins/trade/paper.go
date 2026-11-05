package trade

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 模拟盘引擎（TRD-05a、TRD-06a）：统一的下单入口 place、撮合任务 trade_paper、强平、日亏损熔断。
//
// 下单入口只有一个：手动下单（POST /api/trade/orders）、持仓页平仓、部署下单（runs.go）都调 place，
// 风控逐笔检查接在这里（risk.go 的 riskBlocks），直接调接口也绕不过。所有改账本的操作（下单、撤单、改价、撮合、
// 强平、一键全停、部署停止）都在 paper.mu 下做：插件的 Store 没有事务，靠这把锁保证「读持仓 → 算 → 写成交」不被插队。
//
// 撮合：后台任务 trade_paper 每 paperEvery 扫一遍挂单。行情只取行情缓存（挂单、持仓用到的标的挂进行情订阅，最新价每秒刷），
// 不另起轮询交易所；最新价不是实时（live）时不撮合、不强平，免得拿旧价成交。
//   市价单：按最新价加减滑点（买加卖减，slippage_ticks 跳）成交；
//   限价单：买单最新价 ≤ 委托价、卖单最新价 ≥ 委托价时按委托价成交；
//   止损单：买单最新价 ≥ 触发价、卖单 ≤ 触发价时按最新价加减滑点成交；
//   止损限价：先等触发（触发后记 triggered，之后按限价单撮合，触发和成交可以不在同一刻）。
// 一次全部成交，不出现部分成交。手续费 = |名义价值| × 账户手续费率，计入成交。

// paperEvery 是撮合间隔；测试里改小。
var paperEvery = time.Second

// 委托状态
const (
	orderOpen     = "open"
	orderFilled   = "filled"
	orderCanceled = "canceled"
	orderRejected = "rejected"
)

// OrderTypes、OrderSides 同原型 OrderType、Order.side。
var (
	OrderTypes = []string{"market", "limit", "stop", "stop_limit"}
	OrderSides = []string{"buy", "sell"}
)

var orderTypeText = map[string]string{"market": "市价", "limit": "限价", "stop": "止损市价", "stop_limit": "止损限价"}

// maxLeverage 是模拟盘合约杠杆的硬上限（风控规则另有上限）。
const maxLeverage = 125

// userMeta、riskMeta 是审计的操作者：接口来的记 trade#user，风控自动动作记 trade#risk，撮合记 trade#paper。
var (
	userMeta  = plugin.WriteMeta{Session: "user"}
	riskMeta  = plugin.WriteMeta{Session: "risk"}
	paperMeta = plugin.WriteMeta{Session: "paper"}
)

func runMeta(runID string) plugin.WriteMeta { return plugin.WriteMeta{Session: runID} }

type paper struct {
	p   *Plugin
	c   plugin.Core
	now func() time.Time

	mu   sync.Mutex // 账本写锁
	wake chan struct{}

	subMu  sync.Mutex
	unsub  func()
	subKey string

	recovered bool
}

func newPaper(p *Plugin, c plugin.Core) *paper {
	return &paper{p: p, c: c, now: p.mkt.now, wake: make(chan struct{}, 1)}
}

func (pp *paper) poke() {
	select {
	case pp.wake <- struct{}{}:
	default:
	}
}

func (pp *paper) audit(ctx context.Context, action, targetType, targetID, summary string, detail map[string]any, m plugin.WriteMeta) {
	pp.c.Audit().Note(ctx, plugin.AuditNote{Action: action, TargetType: targetType, TargetID: targetID, Summary: summary, Detail: detail}, m)
}

func (pp *paper) incident(ctx context.Context, fp, title, msg string, detail map[string]any) {
	err := pp.c.Incidents().Record(ctx, plugin.Incident{Fingerprint: fp, Level: "warn", Module: "交易", Title: title, Message: msg, Context: detail})
	if err != nil && !errors.Is(err, plugin.ErrNoIncidents) {
		pp.c.Log().Warn("record trade incident failed", "fp", fp, "err", err)
	}
}

func (pp *paper) notify(ctx context.Context, kind, level, title, body string, data map[string]any) {
	err := pp.c.Notify(ctx, plugin.Notification{Kind: kind, Level: level, Title: title, Body: body, Data: data})
	if err != nil && !errors.Is(err, plugin.ErrNoNotifier) {
		pp.c.Log().Warn("trade notify failed", "kind", kind, "err", err)
	}
}

func utcDay(t time.Time) string { return t.UTC().Format("2006-01-02") }

func itoa(n int) string { return strconv.Itoa(n) }

/* ---------- 委托 ---------- */

// Order 是 trade_orders 的一行。
type Order struct {
	ID           string
	AccountID    string
	Symbol       string
	Side         string
	Type         string
	Qty          fx
	Price        fx
	Stop         fx
	Leverage     int
	ReduceOnly   bool
	Triggered    bool
	Status       string
	RejectReason string
	Filled       fx
	AvgFill      fx
	Fee          fx
	RunID        string
	Source       string
	ClientID     string
	Confirmed    bool
	CreatedAt    string
	UpdatedAt    string
}

const orderCols = `id, account_id, symbol, side, type, qty_e8, price_e8, stop_e8, leverage, reduce_only, triggered, status, reject_reason,
	filled_e8, avg_fill_e8, fee_e8, run_id, source, client_id, confirmed, created_at, updated_at`

func scanOrder(row plugin.Row) (Order, error) {
	var o Order
	var ro, tr, cf int
	err := row.Scan(&o.ID, &o.AccountID, &o.Symbol, &o.Side, &o.Type, &o.Qty, &o.Price, &o.Stop, &o.Leverage, &ro, &tr, &o.Status, &o.RejectReason,
		&o.Filled, &o.AvgFill, &o.Fee, &o.RunID, &o.Source, &o.ClientID, &cf, &o.CreatedAt, &o.UpdatedAt)
	o.ReduceOnly, o.Triggered, o.Confirmed = ro == 1, tr == 1, cf == 1
	return o, err
}

func insertOrder(ctx context.Context, c plugin.Core, o Order) error {
	_, err := c.Store().Exec(ctx, `INSERT INTO trade_orders (`+orderCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		o.ID, o.AccountID, o.Symbol, o.Side, o.Type, o.Qty, o.Price, o.Stop, o.Leverage, b2i(o.ReduceOnly), b2i(o.Triggered), o.Status, o.RejectReason,
		o.Filled, o.AvgFill, o.Fee, o.RunID, o.Source, o.ClientID, b2i(o.Confirmed), o.CreatedAt, o.UpdatedAt)
	return err
}

func loadOrder(ctx context.Context, c plugin.Core, id string) (Order, error) {
	o, err := scanOrder(c.Store().QueryRow(ctx, `SELECT `+orderCols+` FROM trade_orders WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return o, apiErr(errNotFound, "委托 %s 不存在", id)
	}
	return o, err
}

func queryOrders(ctx context.Context, c plugin.Core, where string, args ...any) ([]Order, error) {
	rows, err := c.Store().Query(ctx, `SELECT `+orderCols+` FROM trade_orders `+where, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Order{}
	for rows.Next() {
		o, err := scanOrder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (o Order) signedQty() fx {
	if o.Side == "sell" {
		return -o.Qty
	}
	return o.Qty
}

// orderHold 是挂单占用：没成交的开仓委托按委托价（市价单、止损单按触发价或 0）估的名义价值除以杠杆。
// 仅减仓的不占；止损市价按触发价估。
func (pp *paper) orderHold(ctx context.Context, accountID string) (fx, error) {
	os, err := queryOrders(ctx, pp.c, `WHERE account_id = ? AND status = 'open' AND reduce_only = 0`, accountID)
	if err != nil {
		return 0, err
	}
	var hold fx
	for _, o := range os {
		in, ok := loadLedgerInst(ctx, pp.c, o.Symbol)
		if !ok {
			continue
		}
		// 现货卖出、合约平仓方向的单不占（是否开仓到成交时才定，这里按「和现有持仓反向就不占」估）
		pos, err := loadPosition(ctx, pp.c, accountID, o.Symbol)
		if err != nil {
			return 0, err
		}
		hold += holdOf(o, in, pos)
	}
	return hold, nil
}

// holdOf 是一笔挂单的占用：开仓单按委托价（没有按触发价）估的名义 / 杠杆，市价单、平仓单为 0。
func holdOf(o Order, in ledgerInst, pos posState) fx {
	px := o.Price
	if px == 0 {
		px = o.Stop
	}
	if px == 0 || o.ReduceOnly || !opening(in, pos, o.Side, o.Qty, o.ReduceOnly) {
		return 0
	}
	n, err := fxMul3(o.Qty, px, in.Mult)
	if err != nil {
		return 0
	}
	m, _ := marginNeed(n, o.Leverage, in, 0)
	return m
}

// opening 同原型 isOpening：现货买入算开仓；合约勾了仅减仓不算；合约方向和已有持仓相反、数量不超过持仓的不算；其余算。
func opening(in ledgerInst, pos posState, side string, qty fx, reduce bool) bool {
	if !in.contract() {
		return side == "buy"
	}
	if reduce {
		return false
	}
	if pos.Qty != 0 && (pos.Qty > 0) != (side == "buy") && qty <= pos.Qty.abs() {
		return false
	}
	return true
}

/* ---------- 统一的下单入口 ---------- */

// orderReq 是一笔要下的委托。Source 是 manual / close / run；部署下单带 RunID、ClientID（幂等键）。
type orderReq struct {
	AccountID  string
	Symbol     string
	Side       string
	Type       string
	Qty        fx
	Price      fx
	Stop       fx
	Leverage   int // 0 表示没传：合约沿用现有持仓的杠杆，没有持仓按 1
	ReduceOnly bool
	Confirmed  bool
	RunID      string
	Source     string
	ClientID   string
}

// riskError 是被风控拦下：委托已记成被拒绝，Blocks 是逐条原因。
type riskError struct {
	Order  Order
	Blocks []string
}

func (e *riskError) Error() string { return "风控未通过：" + strings.Join(e.Blocks, "；") }

// confirmError 是金额超过二次确认阈值又没带确认标记：不下单、不记委托。
type confirmError struct {
	Value, Threshold fx
}

func (e *confirmError) Error() string {
	return fmt.Sprintf("金额约 %s，超过 %s 二次确认线，确认后带 confirmed: true 重新提交", usdText(e.Value), usdText(e.Threshold))
}

// duplicateError 是部署下单的幂等键已经下过（重启重算同一根 K 线）。
type duplicateError struct{ OrderID string }

func (e *duplicateError) Error() string { return "这根 K 线已经下过单：" + e.OrderID }

// place 是唯一的下单入口：校验、风控、二次确认、模拟交易所的拒单检查，过了记成挂单中并叫醒撮合。
// 回的委托可能是 open（挂单中）或 rejected（模拟交易所拒单：可卖不足、仅减仓没有反向持仓、可用资金不足）；
// 被风控拦下回 *riskError（委托也记成被拒绝），要二次确认回 *confirmError，参数不对回 errValidation。
func (pp *paper) place(ctx context.Context, req orderReq) (Order, error) {
	pp.mu.Lock()
	defer pp.mu.Unlock()
	return pp.placeLocked(ctx, req)
}

func (pp *paper) placeLocked(ctx context.Context, req orderReq) (Order, error) {
	a, err := paperAccount(ctx, pp.c, req.AccountID)
	if err != nil {
		return Order{}, err
	}
	if !slices.Contains(OrderSides, req.Side) {
		return Order{}, apiErr(errValidation, "side 只能是 buy 或 sell")
	}
	if !slices.Contains(OrderTypes, req.Type) {
		return Order{}, apiErr(errValidation, "type 只能是 market、limit、stop、stop_limit")
	}
	if !ValidSymbol(req.Symbol) {
		return Order{}, apiErr(errValidation, "标的 %q 格式不对，要写成 交易场所:代码，如 BINANCE:BTCUSDT", req.Symbol)
	}
	in, ok := loadLedgerInst(ctx, pp.c, req.Symbol)
	if !ok {
		return Order{}, apiErr(errValidation, "标的表里没有 %s：行情源还没同步标的，或交易所没有这个标的", req.Symbol)
	}
	if pp.p.sourceFor(req.Symbol) == nil {
		return Order{}, apiErr(errValidation, "%s 的行情源还没接，现在只有 Binance、OKX 的数币能模拟下单", req.Symbol)
	}
	if in.Kind == "option" {
		return Order{}, apiErr(errValidation, "期权还不能模拟下单")
	}
	if !slices.Contains(a.Markets, in.Market) {
		return Order{}, apiErr(errValidation, "账户「%s」不支持%s", a.Name, marketLabel(in.Market))
	}
	if req.Qty <= 0 || req.Qty > fxMax {
		return Order{}, apiErr(errValidation, "数量要大于 0")
	}
	qty := floorLot(req.Qty, in.Lot)
	if qty <= 0 {
		return Order{}, apiErr(errValidation, "数量不足最小单位 %s", in.Lot)
	}
	needPrice := req.Type == "limit" || req.Type == "stop_limit"
	needStop := req.Type == "stop" || req.Type == "stop_limit"
	if needPrice && (req.Price <= 0 || req.Price > fxMax) {
		return Order{}, apiErr(errValidation, "%s单要填委托价 price（大于 0）", orderTypeText[req.Type])
	}
	if !needPrice {
		req.Price = 0
	}
	if needStop && (req.Stop <= 0 || req.Stop > fxMax) {
		return Order{}, apiErr(errValidation, "%s单要填触发价 stop_price（大于 0）", orderTypeText[req.Type])
	}
	if !needStop {
		req.Stop = 0
	}
	if req.ReduceOnly && !in.contract() {
		return Order{}, apiErr(errValidation, "仅减仓只适用于合约")
	}
	pos, err := loadPosition(ctx, pp.c, a.ID, req.Symbol)
	if err != nil {
		return Order{}, err
	}
	lev := req.Leverage
	switch {
	case !in.contract():
		if lev > 1 {
			return Order{}, apiErr(errValidation, "现货不能加杠杆")
		}
		lev = 1
	case lev == 0:
		lev = max(1, pos.Lev)
	case lev < 1 || lev > maxLeverage:
		return Order{}, apiErr(errValidation, "杠杆要在 1 到 %d 倍", maxLeverage)
	}
	// 估这一笔的金额：限价、止损限价按委托价，止损按触发价，市价按最新价
	ref := req.Price
	if ref == 0 {
		ref = req.Stop
	}
	if ref == 0 {
		pp.p.mkt.ensure(ctx, "ticker", req.Symbol)
		last, _, _ := pp.markOf(ctx, req.Symbol)
		if last == 0 {
			return Order{}, apiErr(errValidation, "还没有 %s 的最新价，稍后再下市价单", req.Symbol)
		}
		ref = last
	}
	notional, err := fxMul3(qty, ref, in.Mult)
	if err != nil {
		return Order{}, apiErr(errValidation, "金额太大")
	}
	now := stamp(pp.now())
	o := Order{ID: newOrderID(), AccountID: a.ID, Symbol: req.Symbol, Side: req.Side, Type: req.Type, Qty: qty, Price: req.Price, Stop: req.Stop,
		Leverage: lev, ReduceOnly: req.ReduceOnly, Status: orderOpen, RunID: req.RunID, Source: req.Source, ClientID: req.ClientID,
		Confirmed: req.Confirmed, CreatedAt: now, UpdatedAt: now}
	if o.Source == "" {
		o.Source = "manual"
	}
	if o.Source == "run" {
		// 部署下单时部署要还在运行（一键全停、停止和这一轮信号并发时，停了的不再下单）
		var st string
		if err := pp.c.Store().QueryRow(ctx, `SELECT status FROM trade_runs WHERE id = ?`, o.RunID).Scan(&st); err != nil || st != "running" {
			return Order{}, errRunNotRunning
		}
	}
	if o.ClientID != "" {
		var have string
		if pp.c.Store().QueryRow(ctx, `SELECT id FROM trade_orders WHERE client_id = ?`, o.ClientID).Scan(&have) == nil {
			return Order{}, &duplicateError{OrderID: have}
		}
	}
	meta := userMeta
	if o.RunID != "" {
		meta = runMeta(o.RunID)
	}
	open := opening(in, pos, o.Side, qty, o.ReduceOnly)
	val, err := pp.value(ctx, a)
	if err != nil {
		return Order{}, err
	}
	rules, err := pp.risk(ctx)
	if err != nil {
		return Order{}, err
	}
	var held fx
	for _, pm := range val.Positions {
		if pm.Symbol == o.Symbol {
			held += pm.Value
		}
	}
	blocks := riskBlocks(riskInput{Rules: rules, Equity: val.Equity, Held: held, Value: notional, Leverage: lev, Contract: in.contract(), Opening: open, Name: in.Name})
	detail := map[string]any{"account_id": a.ID, "symbol": o.Symbol, "side": o.Side, "type": o.Type, "qty": qty.String(), "price": o.Price.String(),
		"stop_price": o.Stop.String(), "leverage": lev, "reduce_only": o.ReduceOnly, "value": notional.String(), "opening": open, "source": o.Source, "run_id": o.RunID}
	desc := fmt.Sprintf("%s %s %s %s", orderTypeText[o.Type], sideText[o.Side], qtyText(qty, in.Lot), in.Name)
	if len(blocks) > 0 {
		o.Status, o.RejectReason = orderRejected, strings.Join(blocks, "；")
		o.ClientID = "" // 被拦的不占幂等键，下一根 K 线还能下
		if err := insertOrder(ctx, pp.c, o); err != nil {
			return Order{}, err
		}
		detail["blocks"] = blocks
		pp.audit(ctx, "risk_block", "trade_order", o.ID, "风控拦截："+desc+"："+o.RejectReason, detail, meta)
		pp.incident(ctx, "trade:risk_block:"+a.ID, "下单被风控拦截", desc+"："+o.RejectReason, map[string]any{"账户": a.Name, "委托 id": o.ID, "部署 id": o.RunID})
		return o, &riskError{Order: o, Blocks: blocks}
	}
	if (o.Source == "manual" || o.Source == "close") && rules.ConfirmAbove > 0 && notional.abs() > rules.confirmAbove() && !o.Confirmed {
		return Order{}, &confirmError{Value: notional.abs(), Threshold: rules.confirmAbove()}
	}
	// 模拟交易所会拒的单：记成被拒绝
	reject := ""
	switch {
	case !in.contract() && o.Side == "sell" && pos.Qty < qty:
		if pos.Qty > 0 {
			reject = "可卖数量不足：持有 " + qtyText(pos.Qty, in.Lot)
		} else {
			reject = "没有可卖的持仓（现货不能卖空）"
		}
	case o.ReduceOnly && (pos.Qty == 0 || (pos.Qty > 0) == (o.Side == "buy")):
		reject = "仅减仓：没有可减的反向持仓"
	case open:
		need, err := marginNeed(notional, lev, in, a.FeeRate)
		if err != nil {
			return Order{}, apiErr(errValidation, "金额太大")
		}
		if need > val.Available {
			reject = fmt.Sprintf("可用资金不足：需要 %s，可用 %s", priceText(need, 2), priceText(val.Available, 2))
		}
	}
	if reject != "" {
		o.Status, o.RejectReason = orderRejected, reject
		o.ClientID = ""
	}
	if err := insertOrder(ctx, pp.c, o); err != nil {
		if o.ClientID != "" && strings.Contains(err.Error(), "UNIQUE") {
			return Order{}, &duplicateError{}
		}
		return Order{}, err
	}
	if reject != "" {
		detail["reason"] = reject
		pp.audit(ctx, "reject", "trade_order", o.ID, "委托被拒："+desc+"："+reject, detail, meta)
		pp.incident(ctx, "trade:order_rejected:"+a.ID, "委托被拒", desc+"："+reject, map[string]any{"账户": a.Name, "委托 id": o.ID, "部署 id": o.RunID})
		return o, nil
	}
	pp.audit(ctx, "place", "trade_order", o.ID, "下单："+desc, detail, meta)
	pp.poke()
	return o, nil
}

// marginNeed 是开仓要的资金：名义 / 杠杆 + 手续费。
func marginNeed(notional fx, lev int, in ledgerInst, feeRate fx) (fx, error) {
	if !in.contract() {
		lev = 1
	}
	m, err := fxDiv(notional.abs(), fxInt(int64(max(1, lev))))
	if err != nil {
		return 0, err
	}
	fee, err := fxMul(notional.abs(), feeRate)
	if err != nil {
		return 0, err
	}
	return m + fee, nil
}

func marketLabel(m string) string {
	switch m {
	case "crypto":
		return "数币"
	case "cn":
		return "A 股"
	case "hk":
		return "港股"
	case "us":
		return "美股"
	}
	return m
}

/* ---------- 撤单、改价 ---------- */

// cancel 撤一笔挂单；不是挂单中回 false。
func (pp *paper) cancelLocked(ctx context.Context, o Order, reason string, m plugin.WriteMeta) (bool, error) {
	now := stamp(pp.now())
	res, err := pp.c.Store().Exec(ctx, `UPDATE trade_orders SET status = 'canceled', reject_reason = ?, updated_at = ? WHERE id = ? AND status = 'open'`, reason, now, o.ID)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return false, nil
	}
	pp.audit(ctx, "cancel", "trade_order", o.ID, "撤单："+o.Symbol+" "+sideText[o.Side]+" "+o.Qty.String()+"，"+reason,
		map[string]any{"account_id": o.AccountID, "symbol": o.Symbol, "reason": reason, "run_id": o.RunID}, m)
	return true, nil
}

// cancelWhere 撤掉一批挂单（全停、停部署、全部撤单用），回撤掉的条数。
func (pp *paper) cancelWhereLocked(ctx context.Context, where string, reason string, m plugin.WriteMeta, args ...any) (int, []string, error) {
	os, err := queryOrders(ctx, pp.c, `WHERE status = 'open'`+where+` ORDER BY created_at`, args...)
	if err != nil {
		return 0, nil, err
	}
	n := 0
	var failed []string
	for _, o := range os {
		ok, err := pp.cancelLocked(ctx, o, reason, m)
		if err != nil {
			failed = append(failed, o.ID+"："+err.Error())
			continue
		}
		if ok {
			n++
		}
	}
	return n, failed, nil
}

/* ---------- 撮合 ---------- */

// run 是撮合常驻任务：启动先恢复上次进程留下的半截成交，之后每 paperEvery 一轮或被叫醒时跑一轮。
func (pp *paper) run(ctx context.Context) error {
	t := time.NewTicker(paperEvery)
	defer t.Stop()
	defer pp.watch(nil)
	for {
		pp.tick(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		case <-pp.wake:
		}
	}
}

func (pp *paper) tick(ctx context.Context) {
	if !pp.recovered {
		if err := pp.recover(ctx); err != nil {
			pp.c.Log().Warn("paper recover failed", "err", err)
		} else {
			pp.recovered = true
		}
	}
	if err := pp.match(ctx); err != nil && ctx.Err() == nil {
		pp.c.Log().Warn("paper match failed", "err", err)
	}
	if err := pp.checkDailyLoss(ctx); err != nil && ctx.Err() == nil {
		pp.c.Log().Warn("daily loss check failed", "err", err)
	}
}

// recover：进程崩在「写成交」和「改委托状态」两条语句中间时，委托还是挂单中但已经有成交，按成交补成已成交。
func (pp *paper) recover(ctx context.Context) error {
	pp.mu.Lock()
	defer pp.mu.Unlock()
	rows, err := pp.c.Store().Query(ctx, `SELECT o.id, f.qty_e8, f.price_e8, f.fee_e8, f.at FROM trade_orders o JOIN trade_fills f ON f.order_id = o.id WHERE o.status = 'open'`)
	if err != nil {
		return err
	}
	type fix struct {
		id              string
		qty, price, fee fx
		at              string
	}
	var fixes []fix
	for rows.Next() {
		var f fix
		if err := rows.Scan(&f.id, &f.qty, &f.price, &f.fee, &f.at); err != nil {
			_ = rows.Close()
			return err
		}
		fixes = append(fixes, f)
	}
	_ = rows.Close()
	for _, f := range fixes {
		if _, err := pp.c.Store().Exec(ctx, `UPDATE trade_orders SET status = 'filled', filled_e8 = ?, avg_fill_e8 = ?, fee_e8 = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
			f.qty, f.price, f.fee, f.at, f.id); err != nil {
			return err
		}
		pp.c.Log().Info("paper order recovered from fill", "order", f.id)
	}
	return nil
}

// watch 把挂单、持仓用到的标的挂进行情订阅，换了一组才重挂；nil 是撤掉。
func (pp *paper) watch(symbols []string) {
	sort.Strings(symbols)
	key := strings.Join(symbols, ",")
	pp.subMu.Lock()
	defer pp.subMu.Unlock()
	if key == pp.subKey && symbols != nil {
		return
	}
	if pp.unsub != nil {
		pp.unsub()
		pp.unsub = nil
	}
	pp.subKey = key
	if len(symbols) > 0 {
		pp.unsub = pp.p.mkt.subscribe(symbols, "")
	}
}

// match 跑一轮撮合和强平。
func (pp *paper) match(ctx context.Context) error {
	pp.mu.Lock()
	defer pp.mu.Unlock()
	orders, err := queryOrders(ctx, pp.c, `WHERE status = 'open' ORDER BY created_at, id`)
	if err != nil {
		return err
	}
	held, err := loadPositions(ctx, pp.c, "")
	if err != nil {
		return err
	}
	syms := []string{}
	for _, o := range orders {
		if !slices.Contains(syms, o.Symbol) {
			syms = append(syms, o.Symbol)
		}
	}
	for _, h := range held {
		if !slices.Contains(syms, h.Symbol) {
			syms = append(syms, h.Symbol)
		}
	}
	pp.watch(slices.Clone(syms))
	accts := map[string]*account{}
	acctOf := func(id string) *account {
		if a, ok := accts[id]; ok {
			return a
		}
		a, err := loadAccount(ctx, pp.c, id)
		if err != nil {
			accts[id] = nil
			return nil
		}
		accts[id] = &a
		return &a
	}
	for _, o := range orders {
		if ctx.Err() != nil {
			return nil
		}
		a := acctOf(o.AccountID)
		if a == nil {
			if _, err := pp.cancelLocked(ctx, o, "账户已删除", paperMeta); err != nil {
				return err
			}
			continue
		}
		in, ok := loadLedgerInst(ctx, pp.c, o.Symbol)
		if !ok {
			continue
		}
		q := pp.p.mkt.quote(ctx, o.Symbol)
		if q.Status != "live" {
			continue
		}
		last, ok := fxFromFloat(q.Last)
		if !ok || last <= 0 {
			continue
		}
		px, fill := triggerPrice(&o, last, in.tick()*fx(a.SlippageTicks))
		if o.Type == "stop_limit" && o.Triggered {
			if _, err := pp.c.Store().Exec(ctx, `UPDATE trade_orders SET triggered = 1, updated_at = ? WHERE id = ? AND triggered = 0`, stamp(pp.now()), o.ID); err != nil {
				return err
			}
		}
		if !fill {
			continue
		}
		if _, err := pp.executeLocked(ctx, *a, in, o, px, "trade"); err != nil {
			pp.c.Log().Warn("paper fill failed", "order", o.ID, "err", err)
		}
	}
	return pp.liquidateLocked(ctx, held, acctOf)
}

// triggerPrice 判断这一刻能不能成交、按什么价（规则见文件头）。止损限价第一次触发时把 o.Triggered 置真。
func triggerPrice(o *Order, last, slip fx) (fx, bool) {
	buy := o.Side == "buy"
	withSlip := last + slip
	if !buy {
		withSlip = max(last-slip, 1)
	}
	stopHit := o.Stop > 0 && ((buy && last >= o.Stop) || (!buy && last <= o.Stop))
	limitOK := o.Price > 0 && ((buy && last <= o.Price) || (!buy && last >= o.Price))
	switch o.Type {
	case "market":
		return withSlip, true
	case "limit":
		return o.Price, limitOK
	case "stop":
		return withSlip, stopHit
	case "stop_limit":
		if !o.Triggered && stopHit {
			o.Triggered = true
		}
		return o.Price, o.Triggered && limitOK
	}
	return 0, false
}

// executeLocked 按 px 把一笔挂单全部成交：成交时再查一遍（仅减仓的数量收到持仓以内、现货可卖、开仓可用资金），
// 不满足的改成被拒绝。写成交流水（一条 INSERT），再把委托改成已成交。
func (pp *paper) executeLocked(ctx context.Context, a account, in ledgerInst, o Order, px fx, kind string) (*Fill, error) {
	pos, err := loadPosition(ctx, pp.c, a.ID, o.Symbol)
	if err != nil {
		return nil, err
	}
	qty := o.Qty
	reject := ""
	switch {
	case o.ReduceOnly && (pos.Qty == 0 || (pos.Qty > 0) == (o.Side == "buy")):
		reject = "仅减仓：没有可减的反向持仓"
	case o.ReduceOnly:
		qty = min(qty, pos.Qty.abs())
	case !in.contract() && o.Side == "sell" && pos.Qty < qty:
		reject = "可卖数量不足：持有 " + qtyText(max(pos.Qty, 0), in.Lot)
	}
	n, err := fxMul3(qty, px, in.Mult)
	if err != nil {
		return nil, err
	}
	fee, err := fxMul(n, a.FeeRate)
	if err != nil {
		return nil, err
	}
	if reject == "" && kind == "trade" && opening(in, pos, o.Side, qty, o.ReduceOnly) {
		// 开仓部分（反手时是超出原持仓的那段）要的保证金
		openQty := qty
		if pos.Qty != 0 && (pos.Qty > 0) != (o.Side == "buy") {
			openQty = qty - pos.Qty.abs()
		}
		on, _ := fxMul3(openQty, px, in.Mult)
		need, err := marginNeed(on, o.Leverage, in, a.FeeRate)
		if err != nil {
			return nil, err
		}
		val, err := pp.value(ctx, a)
		if err != nil {
			return nil, err
		}
		// 这笔自己的挂单占用不算在里面
		self := holdOf(o, in, pos)
		if need > val.Available+self {
			reject = fmt.Sprintf("可用资金不足：需要 %s，可用 %s", priceText(need, 2), priceText(val.Available+self, 2))
		}
	}
	now := stamp(pp.now())
	meta := paperMeta
	if o.RunID != "" {
		meta = runMeta(o.RunID)
	}
	desc := fmt.Sprintf("%s %s %s", sideText[o.Side], qtyText(qty, in.Lot), in.Name)
	if reject != "" {
		if _, err := pp.c.Store().Exec(ctx, `UPDATE trade_orders SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ? AND status = 'open'`, reject, now, o.ID); err != nil {
			return nil, err
		}
		pp.audit(ctx, "reject", "trade_order", o.ID, "委托被拒："+desc+"："+reject, map[string]any{"account_id": a.ID, "symbol": o.Symbol, "reason": reject, "run_id": o.RunID}, meta)
		pp.incident(ctx, "trade:order_rejected:"+a.ID, "委托被拒", desc+"："+reject, map[string]any{"账户": a.Name, "委托 id": o.ID, "部署 id": o.RunID})
		if o.RunID != "" {
			pp.p.runs.log(ctx, o.RunID, "warn", "委托被拒："+desc+"："+reject)
		}
		return nil, nil
	}
	d := qty
	if o.Side == "sell" {
		d, n = -qty, -n
	}
	newPos, realized, err := applyFill(pos, d, n, o.Leverage, o.RunID, now, newPosID)
	if err != nil {
		return nil, err
	}
	f := Fill{ID: newFillID(), OrderID: o.ID, AccountID: a.ID, Symbol: o.Symbol, Side: o.Side, Qty: qty, Price: px, Mult: in.Mult, Notional: n,
		Fee: fee.abs(), Realized: realized, Kind: kind, RunID: o.RunID, Pos: newPos, At: now}
	if err := insertFill(ctx, pp.c, f); err != nil {
		return nil, err
	}
	if _, err := pp.c.Store().Exec(ctx, `UPDATE trade_orders SET status = 'filled', qty_e8 = ?, filled_e8 = ?, avg_fill_e8 = ?, fee_e8 = ?, updated_at = ? WHERE id = ?`,
		qty, qty, px, f.Fee, now, o.ID); err != nil {
		return nil, err
	}
	pp.audit(ctx, "fill", "trade_order", o.ID, "成交："+desc+" @ "+priceText(px, in.Digits),
		map[string]any{"fill_id": f.ID, "account_id": a.ID, "symbol": o.Symbol, "side": o.Side, "qty": qty.String(), "price": px.String(),
			"fee": f.Fee.String(), "realized": realized.String(), "kind": kind, "run_id": o.RunID}, meta)
	if o.RunID != "" {
		pp.p.runs.log(ctx, o.RunID, "info", "成交："+desc+" @ "+priceText(px, in.Digits))
	}
	return &f, nil
}

// liquidateLocked：合约持仓的最新价（实时）越过强平价时，按最新价强平（不加滑点），记强平委托和成交，通知、写部署日志。
func (pp *paper) liquidateLocked(ctx context.Context, held []heldPosition, acctOf func(string) *account) error {
	for _, h := range held {
		in, ok := loadLedgerInst(ctx, pp.c, h.Symbol)
		if !ok || !in.contract() {
			continue
		}
		// held 是这一轮开头读的，撮合后可能变了，重读
		pos, err := loadPosition(ctx, pp.c, h.AccountID, h.Symbol)
		if err != nil || pos.Qty == 0 {
			continue
		}
		liq := pos.liqPrice(in)
		if liq <= 0 {
			continue
		}
		q := pp.p.mkt.quote(ctx, h.Symbol)
		if q.Status != "live" {
			continue
		}
		last, ok := fxFromFloat(q.Last)
		if !ok || (pos.Qty > 0 && last > liq) || (pos.Qty < 0 && last < liq) {
			continue
		}
		a := acctOf(h.AccountID)
		if a == nil {
			continue
		}
		side := "sell"
		if pos.Qty < 0 {
			side = "buy"
		}
		now := stamp(pp.now())
		o := Order{ID: newOrderID(), AccountID: a.ID, Symbol: h.Symbol, Side: side, Type: "market", Qty: pos.Qty.abs(), Leverage: max(1, pos.Lev),
			ReduceOnly: true, Status: orderOpen, RunID: pos.RunID, Source: "liquidation", Confirmed: true, CreatedAt: now, UpdatedAt: now}
		if err := insertOrder(ctx, pp.c, o); err != nil {
			return err
		}
		f, err := pp.executeLocked(ctx, *a, in, o, last, "liquidation")
		if err != nil || f == nil {
			continue
		}
		text := fmt.Sprintf("%s %s 仓 %s 触及强平价 %s，按 %s 强平，亏损 %s", in.Name, map[bool]string{true: "多", false: "空"}[pos.Qty > 0],
			qtyText(pos.Qty, in.Lot), priceText(liq, in.Digits), priceText(last, in.Digits), priceText((-f.Realized+f.Fee), 2))
		pp.notify(ctx, "liquidation", plugin.NotifyError, "模拟盘强平："+in.Name, a.Name+"："+text, map[string]any{"account_id": a.ID, "order_id": o.ID, "symbol": h.Symbol})
		pp.incident(ctx, "trade:liquidation:"+a.ID+":"+h.Symbol, "模拟盘强平", text, map[string]any{"账户": a.Name, "委托 id": o.ID})
		if pos.RunID != "" {
			pp.p.runs.log(ctx, pos.RunID, "warn", "强平："+text)
		}
	}
	return nil
}

// reconcile 对一个账户做对账（LedgerCheck）。
func (pp *paper) reconcile(ctx context.Context, a account) (LedgerCheck, error) {
	pp.mu.Lock()
	fills, err := queryFills(ctx, pp.c, `WHERE account_id = ? ORDER BY seq`, a.ID)
	if err != nil {
		pp.mu.Unlock()
		return LedgerCheck{}, err
	}
	held, err := loadPositions(ctx, pp.c, a.ID)
	pp.mu.Unlock()
	if err != nil {
		return LedgerCheck{}, err
	}
	insts := map[string]ledgerInst{}
	out, err := reconcile(a.Initial, fills, held, func(s string) (ledgerInst, bool) {
		if in, ok := insts[s]; ok {
			return in, true
		}
		in, ok := loadLedgerInst(ctx, pp.c, s)
		if ok {
			insts[s] = in
		}
		return in, ok
	}, func(s string) (fx, bool) {
		px, st, _ := pp.markOf(ctx, s)
		return px, st == "live"
	})
	out.AccountID, out.At = a.ID, stamp(pp.now())
	return out, err
}
