package trade

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 实盘下单（TRD-08d）：统一下单入口 paper.place 对实盘账户走 placeLiveLocked，手动下单、平仓、部署下单都从这里过，
// 风控逐笔检查（单笔上限、仓位上限、杠杆上限、熔断中不许开仓）和二次确认照常做，一项不跳。
//
// 实盘闸门（withGate，每一笔现查，不缓存任何「已放行」）：
//  1. 实盘评审已通过（trade_live_checks 五项都确认）；
//  2. trade:live 已授予（Core.Granted 现读）；
//  3. 实盘开关开着；
//  4. 账户接入时选了「读取 + 交易」（want_trade），账户没断开、最近一次同步正常；
//  5. 这把 Key 在交易所现查：有这个品种（现货 / 合约）的交易权限，并且仍然没有提币和划转权限。
// 任何一条不满足：不发请求，接口回 403（reason live_gate，missing 逐条写缺什么），写审计 live_gate_block；
// 部署下单被闸门拒绝时，部署自动暂停（写部署日志和审计）。全过时签发一张只在这次调用里有效的下单令牌（exchange_trade.go），
// 调用结束即作废。撤单、查单用撤单查单令牌，只要求 Key 仍然没有提币、划转权限（撤单只会更保守，开关关了也能撤）。
//
// 幂等：每笔委托先生成 clientOrderId（ex_client_id），先落库（status pending）再发 POST。
// 回包明确：按回包写状态。交易所明确拒了：rejected。没收到回包、超时、交易所回「状态未知」：记 unknown、写审计，
// 当场按 clientOrderId 查一次单，查到了按查到的写；查不到就留着 unknown，由查单任务接着查；
// 超过 orderLostAfter 仍查不到（Binance recvWindow、OKX expTime 都是 5 秒，之后交易所不会再收这笔）才按没下成记 rejected。
// 任何情况下都不自动重发 POST：一笔委托只发一次下单请求。
//
// 状态回写：后台任务 trade_live 每轮（liveEvery）对没到终态的实盘委托按 clientOrderId 查单，写状态、已成交数量、均价、手续费；
// 已成交数量变多时记一条成交审计（数量是增量）。部分成交的状态是 partial。挂单中的实盘委托同时记进对账的本地挂单（trade_live_orders），
// 对账认得出这些委托；成交由只读同步拉的成交（trade_live_fills）记进本地持仓。
//
// 全停：一键全停和自动熔断在撤模拟盘挂单之后，到每个实盘账户的交易所撤掉全部挂单（先列挂单再逐笔撤），持仓不动；
// 撤不掉的写进结果的 failed、remaining_orders，并写审计。

// orderLostAfter：状态未知的委托超过这么久仍按 clientOrderId 查不到，按没下成处理。
var orderLostAfter = time.Minute

type liveTrader struct {
	p     *Plugin
	c     plugin.Core
	rules rulesCache
}

func newLiveTrader(p *Plugin, c plugin.Core) *liveTrader { return &liveTrader{p: p, c: c} }

func (lt *liveTrader) now() time.Time { return lt.p.mkt.now() }

// gateError 是实盘闸门没过：接口回 403 forbidden、reason live_gate、missing 逐条写缺什么。
type gateError struct{ Missing []string }

func (e *gateError) Error() string { return "实盘闸门没过：" + strings.Join(e.Missing, "；") }

// adapters 取账户那家交易所的适配器。
func (lt *liveTrader) adapters(a account) (exchangeAccount, exchangeTrader, bool) {
	for _, x := range lt.p.exchanges {
		if x.Broker() == a.Broker {
			t, ok := x.(exchangeTrader)
			return x, t, ok
		}
	}
	return nil, nil, false
}

// localGate 是闸门里不用问交易所的几项：评审、trade:live、开关、读取 + 交易、账户状态。每次现读，不缓存。
func (lt *liveTrader) localGate(ctx context.Context, a account) ([]string, error) {
	miss := []string{}
	passed, missing, err := reviewPassed(ctx, lt.c)
	if err != nil {
		return nil, err
	}
	if !passed {
		miss = append(miss, fmt.Sprintf("实盘评审还没通过（还差 %d 项：%s）", len(missing), strings.Join(missing, "、")))
	}
	if !lt.c.Granted(LivePerm) {
		miss = append(miss, "还没授予 trade:live 权限")
	}
	sw, err := loadSwitch(ctx, lt.c)
	if err != nil {
		return nil, err
	}
	if !sw.Enabled {
		miss = append(miss, "实盘开关没打开")
	}
	if !a.WantTrade {
		miss = append(miss, "账户「"+a.Name+"」接入时没选「读取 + 交易」")
	}
	switch {
	case a.ConnectorID == "":
		miss = append(miss, "账户「"+a.Name+"」没有连接器")
	case a.Status == "disconnected":
		miss = append(miss, "账户「"+a.Name+"」已断开")
	case a.Status == "error":
		miss = append(miss, "账户「"+a.Name+"」同步异常（"+a.Error+"），恢复后再下单")
	}
	st, err := lt.p.live.state(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	if st.BaselineAt == "" && a.Status != "disconnected" && a.ConnectorID != "" {
		miss = append(miss, "账户「"+a.Name+"」还没同步成功过，先同步一次")
	}
	return miss, nil
}

// gateCall 是闸门放行后的一次调用：ctx 带着令牌，s 是这次的出网会话（凭证只在里面），k 是刚查到的 Key 权限。
type gateCall struct {
	ctx context.Context
	s   *exSession
	x   exchangeAccount
	t   exchangeTrader
	k   KeyPerms
}

// withGate 是实盘闸门：scope 是 scopePlace（下单，kind 是 spot / perp）或 scopeManage（撤单、查单）。
// 条件全部现查；不过回 *gateError，过了在连接器回调里签发令牌、调 fn，fn 返回后令牌立刻作废。
func (lt *liveTrader) withGate(ctx context.Context, a account, scope grantScope, kind string, fn func(g gateCall) error) error {
	if a.Paper {
		return errors.New("模拟盘账户不走实盘闸门")
	}
	if scope == scopePlace {
		miss, err := lt.localGate(ctx, a)
		if err != nil {
			return err
		}
		if len(miss) > 0 {
			return &gateError{Missing: miss}
		}
	}
	if a.ConnectorID == "" {
		return &gateError{Missing: []string{"账户「" + a.Name + "」没有连接器"}}
	}
	ci, err := lt.c.Connectors().Get(ctx, a.ConnectorID)
	if errors.Is(err, plugin.ErrNoRows) {
		return &gateError{Missing: []string{"账户「" + a.Name + "」的连接器已删除"}}
	}
	if err != nil {
		return err
	}
	x := lt.p.live.ex[ci.Tool]
	t, ok := x.(exchangeTrader)
	if x == nil || !ok || x.Broker() != a.Broker {
		return &gateError{Missing: []string{"连接器 " + ci.Tool + " 不是这个账户的交易所"}}
	}
	return lt.c.Connectors().With(ctx, a.ConnectorID, func(cfg plugin.ConnectorConfig) error {
		s, err := lt.p.live.session(ctx, cfg)
		if err != nil {
			return &gateError{Missing: []string{"交易所出网不可用：" + err.Error()}}
		}
		k, err := x.Perms(ctx, s)
		if err != nil {
			return &gateError{Missing: []string{"查不到这把 Key 在交易所的权限：" + scrubSecrets(err.Error(), cfg)}}
		}
		if err := checkKey(k); err != nil {
			var we *errWithdrawKey
			if errors.As(err, &we) {
				return &gateError{Missing: []string{"这把 Key 开了" + we.What + "，不能再用它向交易所发任何写请求"}}
			}
			return &gateError{Missing: []string{err.Error()}}
		}
		if scope == scopePlace && !k.canTrade(kind) {
			what := "合约交易"
			if kind == "spot" {
				what = "现货交易"
			}
			return &gateError{Missing: []string{"这把 Key 在交易所没有" + what + "权限"}}
		}
		gctx, release := issueTradeGrant(ctx, scope, a.ID, x.Broker())
		defer release()
		return fn(gateCall{ctx: gctx, s: s, x: x, t: t, k: k})
	})
}

// newExClientID 是发给交易所的委托编号：pmw + 16 位小写字母数字（Binance newClientOrderId、OKX clOrdId 都认）。
func newExClientID() string { return "pmw" + idgen.New() }

/* ---------- 下单 ---------- */

// liveHeld 是本地记录里这个标的的持仓（带符号；单位同标的表：现货、Binance 永续是币，OKX 永续是张）。
func (lt *liveTrader) liveHeld(ctx context.Context, a account, in liveInst) (fx, error) {
	hs, err := lt.p.live.holdings(ctx, a.ID)
	if err != nil {
		return 0, err
	}
	return hs[holdingKeyOf(in)].Qty, nil
}

// holdingKeyOf 是标的在对账本地记录里的持仓键：现货 spot:<币种>，永续是标的本身（单向持仓）。
func holdingKeyOf(in liveInst) string {
	if in.Kind == "spot" {
		base := strings.TrimSuffix(strings.TrimSuffix(in.Code, "-USDT"), "USDT")
		return spotKey(base)
	}
	return in.Symbol
}

// placeLiveLocked 是统一下单入口的实盘分支（调用方持有 paper.mu）。
func (pp *paper) placeLiveLocked(ctx context.Context, a account, req orderReq) (Order, error) {
	lt := pp.p.trader
	_, t, ok := lt.adapters(a)
	if !ok {
		return Order{}, apiErr(errValidation, "账户「%s」的交易所 %s 还不支持实盘下单", a.Name, a.Broker)
	}
	if req.Source == "" {
		req.Source = "manual"
	}
	meta := userMeta
	if req.RunID != "" {
		meta = runMeta(req.RunID)
	}
	// 手动下单、平仓只接受用户本人在界面上的操作；部署的单在部署时（用户本人）已确认过
	if req.Source != "run" {
		if err := plugin.RequireUser(ctx, "实盘下单"); err != nil {
			pp.audit(ctx, "live_denied", "trade_account", a.ID, "拒绝代为提交实盘委托："+req.Symbol+" "+sideText[req.Side]+" "+req.Qty.String(),
				map[string]any{"account_id": a.ID, "symbol": req.Symbol, "side": req.Side, "qty": req.Qty.String(), "source": req.Source, "reason": err.Error(), "live": true}, meta)
			return Order{}, err
		}
	}
	// 闸门的本地几项先看一遍（不出网）：没开就直接说缺什么；全过了下面 withGate 还会连交易所那项一起再现查一遍
	if miss, err := lt.localGate(ctx, a); err != nil {
		return Order{}, err
	} else if len(miss) > 0 {
		ge := &gateError{Missing: miss}
		pp.audit(ctx, "live_gate_block", "trade_account", a.ID, "实盘闸门拒绝下单："+req.Symbol+" "+sideText[req.Side]+" "+req.Qty.String()+"："+strings.Join(miss, "；"),
			map[string]any{"account_id": a.ID, "symbol": req.Symbol, "side": req.Side, "qty": req.Qty.String(), "source": req.Source, "run_id": req.RunID,
				"missing": miss, "live": true}, meta)
		if req.RunID != "" {
			pp.p.runs.pauseForGate(ctx, req.RunID, miss)
		}
		return Order{}, ge
	}
	if !slices.Contains(OrderSides, req.Side) {
		return Order{}, apiErr(errValidation, "side 只能是 buy 或 sell")
	}
	if req.Type != "market" && req.Type != "limit" {
		return Order{}, apiErr(errValidation, "实盘只支持市价单、限价单（type 是 market 或 limit）")
	}
	if !ValidSymbol(req.Symbol) {
		return Order{}, apiErr(errValidation, "标的 %q 格式不对，要写成 交易场所:代码，如 BINANCE:BTCUSDT", req.Symbol)
	}
	lin, ok := t.Inst(req.Symbol)
	if !ok {
		return Order{}, apiErr(errValidation, "账户「%s」是 %s 账户，只能下 %s 的现货、USDT 永续", a.Name, a.Broker, a.Broker)
	}
	in, ok := loadLedgerInst(ctx, pp.c, req.Symbol)
	if !ok {
		return Order{}, apiErr(errValidation, "标的表里没有 %s：行情源还没同步标的", req.Symbol)
	}
	if (lin.Kind == "perp") != in.contract() {
		return Order{}, apiErr(errValidation, "标的 %s 的品种和交易所对不上", req.Symbol)
	}
	if req.Qty <= 0 || req.Qty > fxMax {
		return Order{}, apiErr(errValidation, "数量要大于 0")
	}
	if req.Type == "limit" && (req.Price <= 0 || req.Price > fxMax) {
		return Order{}, apiErr(errValidation, "限价单要填委托价 price（大于 0）")
	}
	if req.Type == "market" {
		req.Price = 0
	}
	if req.Stop != 0 {
		return Order{}, apiErr(errValidation, "实盘不支持触发价（stop_price）")
	}
	if req.ReduceOnly && !in.contract() {
		return Order{}, apiErr(errValidation, "仅减仓只适用于合约")
	}
	if !in.contract() && req.Leverage > 1 {
		return Order{}, apiErr(errValidation, "现货不能加杠杆")
	}
	desc := fmt.Sprintf("实盘%s %s %s %s", orderTypeText[req.Type], sideText[req.Side], qtyText(req.Qty, in.Lot), in.Name)
	detail := map[string]any{"account_id": a.ID, "symbol": req.Symbol, "side": req.Side, "type": req.Type, "qty": req.Qty.String(), "price": req.Price.String(),
		"reduce_only": req.ReduceOnly, "source": req.Source, "run_id": req.RunID, "live": true}
	if req.Source == "run" {
		var st string
		if err := pp.c.Store().QueryRow(ctx, `SELECT status FROM trade_runs WHERE id = ?`, req.RunID).Scan(&st); err != nil || st != "running" {
			return Order{}, errRunNotRunning
		}
	}
	if req.ClientID != "" {
		var have string
		if pp.c.Store().QueryRow(ctx, `SELECT id FROM trade_orders WHERE client_id = ?`, req.ClientID).Scan(&have) == nil {
			return Order{}, &duplicateError{OrderID: have}
		}
	}
	var out Order
	var result error
	err := lt.withGate(ctx, a, scopePlace, lin.Kind, func(g gateCall) error {
		out, result = pp.submitLive(ctx, g, a, in, lin, req, meta, desc, detail)
		return nil
	})
	var ge *gateError
	if errors.As(err, &ge) {
		detail["missing"] = ge.Missing
		pp.audit(ctx, "live_gate_block", "trade_account", a.ID, "实盘闸门拒绝下单："+desc+"："+strings.Join(ge.Missing, "；"), detail, meta)
		if req.RunID != "" {
			pp.p.runs.pauseForGate(ctx, req.RunID, ge.Missing)
		}
		return Order{}, ge
	}
	if err != nil {
		return Order{}, err
	}
	return out, result
}

// submitLive 在闸门里：取交易规则、取整、风控、二次确认、落库、发 POST、处理结果。
func (pp *paper) submitLive(ctx context.Context, g gateCall, a account, in ledgerInst, lin liveInst, req orderReq, meta plugin.WriteMeta, desc string, detail map[string]any) (Order, error) {
	lt := pp.p.trader
	rules, err := lt.rulesFor(ctx, g, a, lin)
	if err != nil {
		return Order{}, fmt.Errorf("%w: 取不到 %s 在交易所的下单规则：%s", errUpstream, lin.Code, scrubSecrets(err.Error(), g.s.cfg))
	}
	ref := req.Price
	if ref == 0 {
		if pp.p.sourceFor(req.Symbol) != nil {
			pp.p.mkt.ensure(ctx, "ticker", req.Symbol)
		}
		last, _, _ := pp.markOf(ctx, req.Symbol)
		if last == 0 {
			return Order{}, apiErr(errValidation, "还没有 %s 的最新价，稍后再下市价单", req.Symbol)
		}
		ref = last
	}
	lev := 1
	tdMode := "cash"
	if lin.Kind == "perp" {
		ps, err := g.t.Perp(g.ctx, g.s, lin, g.k)
		if err != nil {
			return Order{}, fmt.Errorf("%w: 查不到 %s 在交易所的杠杆：%s", errUpstream, lin.Code, scrubSecrets(err.Error(), g.s.cfg))
		}
		if ps.Hedge {
			return Order{}, apiErr(errValidation, "交易所的合约账户开了双向持仓：实盘下单只支持单向持仓，到交易所改成单向持仓后再下")
		}
		if req.Leverage != 0 && req.Leverage != ps.Leverage {
			return Order{}, apiErr(errValidation, "实盘不改交易所的杠杆：%s 在交易所现在是 %d 倍，按 %d 倍下，或先到交易所改杠杆", in.Name, ps.Leverage, ps.Leverage)
		}
		lev, tdMode = ps.Leverage, ps.MgnMode
	}
	qty, px, err := rules.fitOrder(req.Side, req.Type, req.Qty, req.Price, ref)
	if err != nil {
		return Order{}, apiErr(errValidation, "不符合交易所的下单规则：%v", err)
	}
	if px != 0 {
		ref = px
	}
	notional, err := fxMul3(qty, ref, in.Mult)
	if err != nil {
		return Order{}, apiErr(errValidation, "金额太大")
	}
	held, err := lt.liveHeld(ctx, a, lin)
	if err != nil {
		return Order{}, err
	}
	st, err := pp.p.live.state(ctx, a.ID)
	if err != nil {
		return Order{}, err
	}
	heldValue, _ := fxMul3(held.abs(), ref, in.Mult)
	pos := posState{Qty: held}
	open := opening(in, pos, req.Side, qty, req.ReduceOnly)
	rr, err := pp.risk(ctx)
	if err != nil {
		return Order{}, err
	}
	now := stamp(pp.now())
	o := Order{ID: newOrderID(), AccountID: a.ID, Symbol: req.Symbol, Side: req.Side, Type: req.Type, Qty: qty, Price: px, Leverage: lev,
		ReduceOnly: req.ReduceOnly, Status: orderPending, RunID: req.RunID, Source: req.Source, ClientID: req.ClientID, Confirmed: req.Confirmed,
		CreatedAt: now, UpdatedAt: now, Live: true, ExClientID: newExClientID()}
	for k, v := range map[string]any{"qty": qty.String(), "price": px.String(), "requested_qty": req.Qty.String(), "requested_price": req.Price.String(),
		"leverage": lev, "value": notional.String(), "opening": open, "client_order_id": o.ExClientID} {
		detail[k] = v
	}
	blocks := riskBlocks(riskInput{Rules: rr, Equity: st.Equity, Held: heldValue, Value: notional, Leverage: lev, Contract: in.contract(), Opening: open, Name: in.Name})
	if len(blocks) > 0 {
		o.Status, o.RejectReason, o.ClientID, o.ExClientID = orderRejected, strings.Join(blocks, "；"), "", ""
		if err := insertOrder(ctx, pp.c, o); err != nil {
			return Order{}, err
		}
		detail["blocks"] = blocks
		pp.audit(ctx, "risk_block", "trade_order", o.ID, "风控拦截："+desc+"："+o.RejectReason, detail, meta)
		pp.incident(ctx, "trade:risk_block:"+a.ID, "下单被风控拦截", desc+"："+o.RejectReason, map[string]any{"账户": a.Name, "委托 id": o.ID, "部署 id": o.RunID})
		return o, &riskError{Order: o, Blocks: blocks}
	}
	// 实盘的手动单、平仓每笔都要二次确认（会产生真实盈亏），不看金额
	if (o.Source == "manual" || o.Source == "close") && !o.Confirmed {
		return Order{}, &confirmError{Value: notional.abs(), Live: true}
	}
	// 先落库再发请求：进程在请求中途没了，重启后查单任务按 clientOrderId 查得到
	o.SubmittedAt = stamp(pp.now())
	if err := insertOrder(ctx, pp.c, o); err != nil {
		if o.ClientID != "" && strings.Contains(err.Error(), "UNIQUE") {
			return Order{}, &duplicateError{}
		}
		return Order{}, err
	}
	xo := exOrder{ClientID: o.ExClientID, Side: o.Side, Type: o.Type, Qty: qty, Price: px, ReduceOnly: o.ReduceOnly, TdMode: tdMode}
	res, perr := g.t.Place(g.ctx, g.s, lin, xo)
	var rej *exRejectError
	switch {
	case perr == nil:
		lt.apply(ctx, a, o, res, meta, "place")
	case errors.As(perr, &rej), errors.Is(perr, errNotReadOnly), errors.Is(perr, plugin.ErrHostNotAllowed), errors.Is(perr, plugin.ErrNotGranted), errors.Is(perr, plugin.ErrNetworkNotDeclared):
		// 交易所明确拒了，或在本地就没发出去
		reason := scrubSecrets(perr.Error(), g.s.cfg)
		lt.finish(ctx, o, orderRejected, "交易所拒单："+reason)
		detail["reason"] = reason
		pp.audit(ctx, "reject", "trade_order", o.ID, "实盘委托被拒："+desc+"："+reason, detail, meta)
		pp.incident(ctx, "trade:order_rejected:"+a.ID, "实盘委托被拒", desc+"："+reason, map[string]any{"账户": a.Name, "委托 id": o.ID, "部署 id": o.RunID})
		if o.RunID != "" {
			pp.p.runs.log(ctx, o.RunID, "warn", "实盘委托被拒："+desc+"："+reason)
		}
	default:
		// 状态未知：不重发，按 clientOrderId 查一次
		reason := scrubSecrets(perr.Error(), g.s.cfg)
		lt.markUnknown(ctx, a, o, reason, meta, desc)
		o.Status = orderUnknown
		q, qerr := g.t.Query(g.ctx, g.s, lin, o.ExClientID)
		lt.touch(ctx, o.ID)
		if qerr == nil {
			lt.apply(ctx, a, o, q, meta, "confirm")
		}
	}
	return loadOrder(ctx, pp.c, o.ID)
}

// rulesFor 取一个标的的交易规则（缓存 rulesTTL）。
func (lt *liveTrader) rulesFor(ctx context.Context, g gateCall, a account, lin liveInst) (symbolRules, error) {
	key := a.Broker + "|" + g.s.cfg.Get("env") + "|" + lin.Code
	if r, ok := lt.rules.get(key, time.Now()); ok {
		return r, nil
	}
	r, err := g.t.Rules(g.ctx, g.s, lin)
	if err != nil {
		return r, err
	}
	lt.rules.put(key, r, time.Now())
	return r, nil
}

/* ---------- 状态回写 ---------- */

func (lt *liveTrader) touch(ctx context.Context, id string) {
	_, _ = lt.c.Store().Exec(ctx, `UPDATE trade_orders SET checked_at = ? WHERE id = ?`, stamp(lt.now()), id)
}

// finish 把一笔实盘委托直接改成终态（拒单、按没下成处理），并从对账的本地挂单里去掉。
func (lt *liveTrader) finish(ctx context.Context, o Order, status, reason string) {
	now := stamp(lt.now())
	if _, err := lt.c.Store().Exec(ctx, `UPDATE trade_orders SET status = ?, reject_reason = ?, client_id = CASE WHEN ? = 'rejected' THEN '' ELSE client_id END,
		checked_at = ?, updated_at = ? WHERE id = ?`, status, reason, status, now, now, o.ID); err != nil {
		lt.c.Log().Warn("update live order failed", "order", o.ID, "err", err)
	}
	if o.ExOrderID != "" {
		_, _ = lt.c.Store().Exec(ctx, `DELETE FROM trade_live_orders WHERE account_id = ? AND order_id = ?`, o.AccountID, o.ExOrderID)
	}
}

func (lt *liveTrader) markUnknown(ctx context.Context, a account, o Order, reason string, meta plugin.WriteMeta, desc string) {
	now := stamp(lt.now())
	if _, err := lt.c.Store().Exec(ctx, `UPDATE trade_orders SET status = 'unknown', reject_reason = ?, updated_at = ? WHERE id = ?`, reason, now, o.ID); err != nil {
		lt.c.Log().Warn("update live order failed", "order", o.ID, "err", err)
	}
	pp := lt.p.paper
	pp.audit(ctx, "unknown", "trade_order", o.ID, "实盘委托状态未知："+desc+"："+reason+"；不重发，按委托编号 "+o.ExClientID+" 查单确认",
		map[string]any{"account_id": a.ID, "symbol": o.Symbol, "client_order_id": o.ExClientID, "reason": reason, "run_id": o.RunID, "live": true}, meta)
	pp.incident(ctx, "trade:order_unknown:"+a.ID, "实盘委托状态未知", desc+"："+reason, map[string]any{"账户": a.Name, "委托 id": o.ID, "委托编号": o.ExClientID})
	if o.RunID != "" {
		pp.p.runs.log(ctx, o.RunID, "warn", "实盘委托状态未知："+desc+"，按委托编号查单确认，不重发")
	}
}

// apply 按交易所那边的情况回写一笔实盘委托：状态、交易所委托号、已成交、均价、手续费；成交变多时记成交审计；
// how 是 place（下单回包）/ confirm（状态未知后查到）/ poll（查单任务）/ cancel（撤单）。
func (lt *liveTrader) apply(ctx context.Context, a account, o Order, st exOrderState, meta plugin.WriteMeta, how string) Order {
	pp := lt.p.paper
	now := stamp(lt.now())
	if st.OrderID == "" {
		st.OrderID = o.ExOrderID
	}
	filled := max(st.Filled, o.Filled)
	avg := st.AvgPrice
	if avg == 0 {
		avg = o.AvgFill
	}
	fee := st.Fee
	if fee == 0 {
		fee = o.Fee
	}
	status := st.Status
	if status == orderOpen && filled > 0 {
		status = orderPartial
	}
	reason := o.RejectReason
	if status == orderOpen || status == orderPartial || status == orderFilled {
		reason = ""
	}
	if st.Reason != "" {
		reason = st.Reason
	}
	if _, err := lt.c.Store().Exec(ctx, `UPDATE trade_orders SET status = ?, ex_order_id = ?, filled_e8 = ?, avg_fill_e8 = ?, fee_e8 = ?, reject_reason = ?,
		checked_at = ?, updated_at = ? WHERE id = ?`, status, st.OrderID, filled, avg, fee, reason, now, now, o.ID); err != nil {
		lt.c.Log().Warn("update live order failed", "order", o.ID, "err", err)
		return o
	}
	in, _ := loadLedgerInst(ctx, lt.c, o.Symbol)
	name := orDefault(in.Name, o.Symbol)
	desc := fmt.Sprintf("实盘%s %s %s %s", orderTypeText[o.Type], sideText[o.Side], qtyText(o.Qty, in.Lot), name)
	base := map[string]any{"account_id": a.ID, "symbol": o.Symbol, "side": o.Side, "client_order_id": o.ExClientID, "exchange_order_id": st.OrderID,
		"exchange_status": st.Raw, "status": status, "run_id": o.RunID, "live": true, "via": how}
	switch how {
	case "place":
		pp.audit(ctx, "place", "trade_order", o.ID, "实盘下单："+desc+"（交易所委托号 "+st.OrderID+"）", base, meta)
		if o.RunID != "" {
			pp.p.runs.log(ctx, o.RunID, "info", "实盘下单："+desc)
		}
	case "confirm":
		pp.audit(ctx, "confirm", "trade_order", o.ID, "状态未知的实盘委托查单确认："+desc+"，交易所状态 "+st.Raw, base, meta)
	}
	if filled > o.Filled {
		d := filled - o.Filled
		fd := map[string]any{}
		for k, v := range base {
			fd[k] = v
		}
		fd["qty"], fd["filled"], fd["avg_price"], fd["fee"] = d.String(), filled.String(), avg.String(), fee.String()
		text := fmt.Sprintf("实盘成交：%s 成交 %s，累计 %s / %s，均价 %s", desc, d, filled, o.Qty, priceText(avg, in.Digits))
		pp.audit(ctx, "fill", "trade_order", o.ID, text, fd, meta)
		if o.RunID != "" {
			pp.p.runs.log(ctx, o.RunID, "info", text)
		}
	}
	if status == orderCanceled && o.Status != orderCanceled && how != "cancel" {
		pp.audit(ctx, "cancel", "trade_order", o.ID, "实盘委托在交易所已撤销："+desc+"（交易所状态 "+st.Raw+"）", base, meta)
	}
	// 对账的本地挂单：没到终态的记上，到了终态的去掉（成交数量由只读同步按成交记，这里不动）
	if st.OrderID != "" {
		if terminalStatus(status) {
			_, _ = lt.c.Store().Exec(ctx, `DELETE FROM trade_live_orders WHERE account_id = ? AND order_id = ?`, a.ID, st.OrderID)
		} else {
			_, _ = lt.c.Store().Exec(ctx, `INSERT OR IGNORE INTO trade_live_orders (account_id, order_id, symbol, side, type, qty_e8, price_e8, filled_e8, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`, a.ID, st.OrderID, o.Symbol, o.Side, o.Type, o.Qty, o.Price, o.CreatedAt, now)
		}
	}
	o.Status, o.ExOrderID, o.Filled, o.AvgFill, o.Fee = status, st.OrderID, filled, avg, fee
	return o
}

// poll 是查单任务（trade_live 每轮调一次）：没到终态的实盘委托逐笔按 clientOrderId 查单回写。
func (lt *liveTrader) poll(ctx context.Context) {
	orders, err := queryOrders(ctx, lt.c, `WHERE live = 1 AND `+liveActiveSQL+` ORDER BY created_at, id`)
	if err != nil || len(orders) == 0 {
		return
	}
	byAcct := map[string][]Order{}
	var ids []string
	for _, o := range orders {
		if _, ok := byAcct[o.AccountID]; !ok {
			ids = append(ids, o.AccountID)
		}
		byAcct[o.AccountID] = append(byAcct[o.AccountID], o)
	}
	pp := lt.p.paper
	for _, aid := range ids {
		if ctx.Err() != nil {
			return
		}
		a, err := loadAccount(ctx, lt.c, aid)
		if err != nil {
			continue
		}
		pp.mu.Lock()
		err = lt.withGate(ctx, a, scopeManage, "", func(g gateCall) error {
			for _, o0 := range byAcct[aid] {
				o, err := loadOrder(ctx, lt.c, o0.ID)
				if err != nil || !o.Live || terminalStatus(o.Status) {
					continue
				}
				lt.check(ctx, g, a, o)
			}
			return nil
		})
		pp.mu.Unlock()
		if err != nil && ctx.Err() == nil {
			lt.c.Log().Warn("poll live orders failed", "account", aid, "err", err.Error())
		}
	}
}

// check 查一笔实盘委托并回写；状态未知的查不到、超过 orderLostAfter 按没下成处理。
func (lt *liveTrader) check(ctx context.Context, g gateCall, a account, o Order) {
	lin, ok := g.t.Inst(o.Symbol)
	if !ok || o.ExClientID == "" {
		return
	}
	meta := liveMeta
	if o.RunID != "" {
		meta = runMeta(o.RunID)
	}
	st, err := g.t.Query(g.ctx, g.s, lin, o.ExClientID)
	switch {
	case err == nil:
		lt.apply(ctx, a, o, st, meta, "poll")
	case errors.Is(err, errOrderNotFound):
		lt.touch(ctx, o.ID)
		sent, perr := time.Parse(time.RFC3339Nano, orDefault(o.SubmittedAt, o.CreatedAt))
		// 只有交易所从来没确认过的（没有交易所委托号）才可能是「没下成」；确认过的查不到，留着状态未知等人工核对
		if (o.Status == orderPending || o.Status == orderUnknown) && o.ExOrderID == "" && perr == nil && lt.now().Sub(sent) > orderLostAfter {
			reason := "交易所查不到这笔委托（委托编号 " + o.ExClientID + "）：下单请求没到交易所，按没下成处理"
			lt.finish(ctx, o, orderRejected, reason)
			lt.p.paper.audit(ctx, "reject", "trade_order", o.ID, "实盘委托没下成："+o.Symbol+"："+reason,
				map[string]any{"account_id": a.ID, "client_order_id": o.ExClientID, "reason": reason, "run_id": o.RunID, "live": true}, meta)
			if o.RunID != "" {
				lt.p.runs.log(ctx, o.RunID, "warn", "实盘委托没下成："+reason)
			}
		} else if o.Status == orderOpen || o.Status == orderPartial {
			lt.markUnknown(ctx, a, o, "交易所查不到这笔挂单", meta, o.Symbol)
		}
	default:
		lt.touch(ctx, o.ID)
		lt.c.Log().Warn("query live order failed", "order", o.ID, "err", scrubSecrets(err.Error(), g.s.cfg))
	}
}

/* ---------- 撤单 ---------- */

// cancelOrderLocked 撤一笔实盘委托（调用方持有 paper.mu）。回撤没撤掉；撤不了的回错误（已写审计）。
func (lt *liveTrader) cancelOrderLocked(ctx context.Context, o Order, reason string, m plugin.WriteMeta) (bool, error) {
	if !o.Live || terminalStatus(o.Status) {
		return false, nil
	}
	a, err := loadAccount(ctx, lt.c, o.AccountID)
	if err != nil {
		return false, err
	}
	done := false
	err = lt.withGate(ctx, a, scopeManage, "", func(g gateCall) error {
		var err error
		done, err = lt.cancelOne(ctx, g, a, o, reason, m)
		return err
	})
	if err != nil {
		lt.p.paper.audit(ctx, "cancel_failed", "trade_order", o.ID, "实盘撤单失败："+o.Symbol+"："+err.Error(),
			map[string]any{"account_id": a.ID, "client_order_id": o.ExClientID, "reason": reason, "error": err.Error(), "live": true}, m)
	}
	return done, err
}

// cancelOne 在令牌里撤一笔本地的实盘委托，撤完查一次单写终态。
func (lt *liveTrader) cancelOne(ctx context.Context, g gateCall, a account, o Order, reason string, m plugin.WriteMeta) (bool, error) {
	lin, ok := g.t.Inst(o.Symbol)
	if !ok {
		return false, fmt.Errorf("标的 %s 不是这家交易所的", o.Symbol)
	}
	st, err := g.t.Cancel(g.ctx, g.s, lin, o.ExClientID, o.ExOrderID)
	if err != nil && !errors.Is(err, errOrderNotFound) {
		return false, errors.New(scrubSecrets(err.Error(), g.s.cfg))
	}
	// 撤单回包未必带成交数量：再查一次单写准
	if q, qerr := g.t.Query(g.ctx, g.s, lin, o.ExClientID); qerr == nil {
		st = q
	} else if errors.Is(qerr, errOrderNotFound) && (o.Status == orderPending || o.Status == orderUnknown) {
		// 交易所没有这笔：从来没下成
		lt.finish(ctx, o, orderCanceled, reason+"（交易所没有这笔委托）")
		lt.p.paper.audit(ctx, "cancel", "trade_order", o.ID, "撤实盘委托："+o.Symbol+"，"+reason+"（交易所没有这笔委托）",
			map[string]any{"account_id": a.ID, "client_order_id": o.ExClientID, "reason": reason, "run_id": o.RunID, "live": true}, m)
		return true, nil
	} else if err != nil {
		return false, errors.New(scrubSecrets(err.Error(), g.s.cfg))
	}
	if st.Status == "" {
		st.Status = orderCanceled
	}
	o2 := lt.apply(ctx, a, o, st, m, "cancel")
	if o2.Status == orderCanceled {
		_, _ = lt.c.Store().Exec(ctx, `UPDATE trade_orders SET reject_reason = ? WHERE id = ?`, reason, o.ID)
		lt.p.paper.audit(ctx, "cancel", "trade_order", o.ID, "撤实盘委托："+o.Symbol+" "+sideText[o.Side]+" "+o.Qty.String()+"，"+reason,
			map[string]any{"account_id": a.ID, "symbol": o.Symbol, "client_order_id": o.ExClientID, "exchange_order_id": o2.ExOrderID,
				"filled": o2.Filled.String(), "reason": reason, "run_id": o.RunID, "live": true}, m)
		if o.RunID != "" {
			lt.p.runs.log(ctx, o.RunID, "info", "撤实盘委托："+o.Symbol+"，"+reason)
		}
		return true, nil
	}
	if terminalStatus(o2.Status) {
		return false, nil // 撤之前已经成交完了
	}
	return false, fmt.Errorf("交易所还没撤掉（状态 %s）", st.Raw)
}

// cancelOrdersLocked 撤一批本地的实盘委托（停部署用），按账户分组过闸门。回撤掉的条数和撤不掉的原因。
func (lt *liveTrader) cancelOrdersLocked(ctx context.Context, orders []Order, reason string, m plugin.WriteMeta) (int, []string) {
	n := 0
	var failed []string
	for _, o := range orders {
		ok, err := lt.cancelOrderLocked(ctx, o, reason, m)
		if err != nil {
			failed = append(failed, o.ID+"："+err.Error())
			continue
		}
		if ok {
			n++
		}
	}
	return n, failed
}

// cancelAccountLocked 撤掉一个实盘账户在交易所的全部挂单（含不是交易套件下的）：先列挂单再逐笔撤，持仓不动。
// 回撤掉的条数、失败原因、没撤掉的挂单（账户名 #交易所委托号）。
func (lt *liveTrader) cancelAccountLocked(ctx context.Context, a account, reason string, m plugin.WriteMeta) (int, []string, []string) {
	n := 0
	failed, remaining := []string{}, []string{}
	err := lt.withGate(ctx, a, scopeManage, "", func(g gateCall) error {
		open, err := g.t.OpenOrders(g.ctx, g.s, g.k)
		if err != nil {
			return errors.New("列不出交易所的挂单：" + scrubSecrets(err.Error(), g.s.cfg))
		}
		for _, x := range open {
			lin, ok := g.t.Inst(x.Symbol)
			if !ok {
				failed = append(failed, a.Name+" #"+x.ID+"：标的 "+x.Symbol+" 不是现货或 USDT 永续，到交易所手动撤")
				remaining = append(remaining, a.Name+" #"+x.ID)
				continue
			}
			var local Order
			found := false
			if os, err := queryOrders(ctx, lt.c, `WHERE live = 1 AND account_id = ? AND ex_order_id = ?`, a.ID, x.ID); err == nil && len(os) > 0 {
				local, found = os[0], true
			}
			if found {
				ok, err := lt.cancelOne(ctx, g, a, local, reason, m)
				switch {
				case err != nil:
					failed = append(failed, a.Name+" #"+x.ID+"："+err.Error())
					remaining = append(remaining, a.Name+" #"+x.ID)
				case ok:
					n++
				}
				continue
			}
			if _, err := g.t.Cancel(g.ctx, g.s, lin, "", x.ID); err != nil && !errors.Is(err, errOrderNotFound) {
				msg := scrubSecrets(err.Error(), g.s.cfg)
				failed = append(failed, a.Name+" #"+x.ID+"："+msg)
				remaining = append(remaining, a.Name+" #"+x.ID)
				continue
			}
			n++
			_, _ = lt.c.Store().Exec(ctx, `DELETE FROM trade_live_orders WHERE account_id = ? AND order_id = ?`, a.ID, x.ID)
			lt.p.paper.audit(ctx, "cancel", "trade_account", a.ID, "撤交易所挂单："+a.Name+" "+x.Symbol+" #"+x.ID+"（不是交易套件下的委托），"+reason,
				map[string]any{"account_id": a.ID, "symbol": x.Symbol, "exchange_order_id": x.ID, "reason": reason, "live": true}, m)
		}
		return nil
	})
	if err != nil {
		// 闸门没过或列不出挂单：本地记录里没有挂单的账户不算失败（没什么可撤）
		var ge *gateError
		idle := false
		if errors.As(err, &ge) {
			st, _ := lt.p.live.state(ctx, a.ID)
			var nLocal int
			_ = lt.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_orders WHERE live = 1 AND account_id = ? AND `+liveActiveSQL, a.ID).Scan(&nLocal)
			idle = len(st.Orders) == 0 && nLocal == 0
		}
		if !idle {
			failed = append(failed, a.Name+"：撤不了交易所挂单："+err.Error())
			remaining = append(remaining, a.Name+"（全部挂单）")
		}
	}
	if len(failed) > 0 {
		lt.p.paper.audit(ctx, "cancel_failed", "trade_account", a.ID, "撤实盘账户「"+a.Name+"」的挂单没有全部成功："+strings.Join(failed, "；"),
			map[string]any{"account_id": a.ID, "failed": failed, "reason": reason, "live": true}, m)
	}
	return n, failed, remaining
}

// cancelAllLiveLocked 是全停的实盘部分：每个接了连接器的实盘账户撤掉交易所的全部挂单。调用方持有 paper.mu。
func (lt *liveTrader) cancelAllLiveLocked(ctx context.Context, reason string, m plugin.WriteMeta) (int, []string, []string) {
	accts, err := loadAccounts(ctx, lt.c)
	if err != nil {
		return 0, []string{err.Error()}, []string{}
	}
	n := 0
	failed, remaining := []string{}, []string{}
	for _, a := range accts {
		if a.Paper || a.ConnectorID == "" {
			continue
		}
		k, f, r := lt.cancelAccountLocked(ctx, a, reason, m)
		n += k
		failed = append(failed, f...)
		remaining = append(remaining, r...)
	}
	return n, failed, remaining
}

/* ---------- 部署 ---------- */

// liveRunBlockers 是部署到实盘账户、恢复实盘部署前的闸门：本地几项加交易所现查 Key（不发写请求）。
func (lt *liveTrader) probeGate(ctx context.Context, a account, kinds []string) error {
	for _, kind := range kinds {
		if err := lt.withGate(ctx, a, scopePlace, kind, func(gateCall) error { return nil }); err != nil {
			return err
		}
	}
	return nil
}

// tradeReady 是账户卡片上的「现在能不能实盘下单」：本地几项加最近一次同步查到的 Key 权限（下单时还会现查交易所）。
func (lt *liveTrader) tradeReady(ctx context.Context, a account) (bool, []string) {
	miss, err := lt.localGate(ctx, a)
	if err != nil {
		return false, []string{err.Error()}
	}
	if !slices.Contains(a.KeyPerms, "trade") {
		miss = append(miss, "最近一次同步查到这把 Key 没有交易权限")
	}
	return len(miss) == 0, miss
}
