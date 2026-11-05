package trade

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 模拟盘、部署、风控的接口（TRD-05a、TRD-05b、TRD-06a），路由在 trade.go 登记，契约见 docs/api-contract.md「交易套件插件 trade」。

/* ---------- 形状 ---------- */

// OrderView 是接口里的委托（TradeOrder），前半同原型 Order。
type OrderView struct {
	ID           string   `json:"id"`
	AccountID    string   `json:"account_id"`
	Symbol       string   `json:"symbol"`
	Side         string   `json:"side"`
	Type         string   `json:"type"`
	Qty          float64  `json:"qty"`
	Price        *float64 `json:"price,omitempty"`
	StopPrice    *float64 `json:"stop_price,omitempty"`
	Filled       float64  `json:"filled"`
	AvgFill      *float64 `json:"avg_fill,omitempty"`
	Status       string   `json:"status"`
	RejectReason string   `json:"reject_reason,omitempty"`
	ReduceOnly   bool     `json:"reduce_only"`
	RunID        string   `json:"run_id,omitempty"`
	CreatedAt    string   `json:"created_at"`
	UpdatedAt    string   `json:"updated_at"`
	Leverage     int      `json:"leverage"`
	Fee          float64  `json:"fee"`
	Source       string   `json:"source"`
	Triggered    bool     `json:"triggered"`
	Confirmed    bool     `json:"confirmed"`
}

func optFx(v fx) *float64 {
	if v == 0 {
		return nil
	}
	f := v.Float()
	return &f
}

func (o Order) view() OrderView {
	return OrderView{ID: o.ID, AccountID: o.AccountID, Symbol: o.Symbol, Side: o.Side, Type: o.Type, Qty: o.Qty.Float(), Price: optFx(o.Price),
		StopPrice: optFx(o.Stop), Filled: o.Filled.Float(), AvgFill: optFx(o.AvgFill), Status: o.Status, RejectReason: o.RejectReason,
		ReduceOnly: o.ReduceOnly, RunID: o.RunID, CreatedAt: o.CreatedAt, UpdatedAt: o.UpdatedAt, Leverage: o.Leverage, Fee: o.Fee.Float(),
		Source: o.Source, Triggered: o.Triggered, Confirmed: o.Confirmed}
}

// PositionView 是接口里的持仓（TradePosition），前半同原型 Position，后面是现价和盈亏。
type PositionView struct {
	ID         string   `json:"id"`
	AccountID  string   `json:"account_id"`
	Symbol     string   `json:"symbol"`
	Name       string   `json:"name"`
	Side       string   `json:"side"`
	Qty        float64  `json:"qty"`
	AvgPrice   float64  `json:"avg_price"`
	Leverage   *int     `json:"leverage,omitempty"`
	LiqPrice   *float64 `json:"liq_price,omitempty"`
	RunID      string   `json:"run_id,omitempty"`
	OpenedAt   string   `json:"opened_at"`
	Cost       float64  `json:"cost"`
	Margin     float64  `json:"margin"`
	Last       float64  `json:"last"`
	Value      float64  `json:"value"`
	PnL        float64  `json:"pnl"`
	Pct        float64  `json:"pct"`
	MarkStatus string   `json:"mark_status"`
	MarkAt     string   `json:"mark_at"`
}

func (pm positionMark) view() PositionView {
	side := "long"
	if pm.Qty < 0 {
		side = "short"
	}
	mult := fx(fxScale)
	name := pm.Symbol
	if pm.InstOK {
		mult, name = pm.Inst.Mult, pm.Inst.Name
	}
	margin := pm.margin(pm.Inst)
	v := PositionView{ID: pm.ID, AccountID: pm.AccountID, Symbol: pm.Symbol, Name: name, Side: side, Qty: pm.Qty.abs().Float(),
		AvgPrice: pm.avgPrice(mult).Float(), RunID: pm.RunID, OpenedAt: pm.OpenedAt, Cost: pm.Cost.abs().Float(), Margin: margin.Float(),
		Last: pm.Mark.Float(), Value: pm.Value.Float(), PnL: pm.PnL.Float(), MarkStatus: pm.MarkStatus, MarkAt: pm.MarkAt}
	if margin > 0 {
		v.Pct = pm.PnL.Float() / margin.Float()
	}
	if pm.InstOK && pm.Inst.contract() {
		lev := pm.Lev
		v.Leverage = &lev
		v.LiqPrice = optFx(pm.liqPrice(pm.Inst))
	}
	return v
}

// FillView 是一笔成交（TradeFill）。
type FillView struct {
	ID          string  `json:"id"`
	OrderID     string  `json:"order_id"`
	AccountID   string  `json:"account_id"`
	Symbol      string  `json:"symbol"`
	Side        string  `json:"side"`
	Qty         float64 `json:"qty"`
	Price       float64 `json:"price"`
	Fee         float64 `json:"fee"`
	RealizedPnL float64 `json:"realized_pnl"`
	Kind        string  `json:"kind"`
	RunID       string  `json:"run_id,omitempty"`
	PositionID  string  `json:"position_id"`
	At          string  `json:"at"`
}

func (f Fill) view() FillView {
	return FillView{ID: f.ID, OrderID: f.OrderID, AccountID: f.AccountID, Symbol: f.Symbol, Side: f.Side, Qty: f.Qty.Float(), Price: f.Price.Float(),
		Fee: f.Fee.Float(), RealizedPnL: f.Realized.Float(), Kind: f.Kind, RunID: f.RunID, PositionID: f.Pos.ID, At: f.At}
}

// RunHolding 是部署在一个标的上的持仓（按它自己的成交重放）。
type RunHolding struct {
	Symbol   string  `json:"symbol"`
	Side     string  `json:"side"`
	Qty      float64 `json:"qty"`
	AvgPrice float64 `json:"avg_price"`
}

// RunView 是接口里的部署（TradeRun），前半同原型 StrategyRun。
type RunView struct {
	ID            string       `json:"id"`
	StrategyID    string       `json:"strategy_id"`
	AccountID     string       `json:"account_id"`
	Symbols       []string     `json:"symbols"`
	Params        Params       `json:"params"`
	Capital       float64      `json:"capital"`
	Status        string       `json:"status"`
	Error         string       `json:"error,omitempty"`
	PnL           float64      `json:"pnl"`
	StartedAt     string       `json:"started_at"`
	StoppedAt     string       `json:"stopped_at,omitempty"`
	StopReason    string       `json:"stop_reason,omitempty"`
	Logs          []RunLog     `json:"logs"`
	LogTotal      int          `json:"log_total"`
	StrategyName  string       `json:"strategy_name"`
	Interval      string       `json:"interval"`
	RealizedPnL   float64      `json:"realized_pnl"`
	UnrealizedPnL float64      `json:"unrealized_pnl"`
	Fees          float64      `json:"fees"`
	Holdings      []RunHolding `json:"holdings"`
	UpdatedAt     string       `json:"updated_at"`
}

func (h *handlers) runView(ctx context.Context, x Run, logs int) (RunView, error) {
	rn := h.p.runs
	b, err := rn.book(ctx, x.ID)
	if err != nil {
		return RunView{}, err
	}
	pnl, unreal := rn.pnl(ctx, b)
	ls, total, err := rn.logs(ctx, x.ID, logs)
	if err != nil {
		return RunView{}, err
	}
	hs := []RunHolding{}
	for _, s := range x.Symbols {
		p := b.pos[s]
		if p.Qty == 0 {
			continue
		}
		mult := fx(fxScale)
		if in, ok := loadLedgerInst(ctx, h.c, s); ok {
			mult = in.Mult
		}
		side := "long"
		if p.Qty < 0 {
			side = "short"
		}
		hs = append(hs, RunHolding{Symbol: s, Side: side, Qty: p.Qty.abs().Float(), AvgPrice: p.avgPrice(mult).Float()})
	}
	return RunView{ID: x.ID, StrategyID: x.StrategyID, AccountID: x.AccountID, Symbols: x.Symbols, Params: x.Params, Capital: x.Capital.Float(),
		Status: x.Status, Error: x.Error, PnL: pnl.Float(), StartedAt: x.StartedAt, StoppedAt: x.StoppedAt, StopReason: x.StopReason,
		Logs: ls, LogTotal: total, StrategyName: x.Strategy.Name, Interval: x.Strategy.Interval, RealizedPnL: b.realized.Float(),
		UnrealizedPnL: unreal.Float(), Fees: b.fees.Float(), Holdings: hs, UpdatedAt: x.UpdatedAt}, nil
}

/* ---------- 请求体解析 ---------- */

type bodyReader struct {
	raw map[string]json.RawMessage
	err error
}

func (b *bodyReader) str(k string, out *string) {
	if v, ok := b.raw[k]; ok && b.err == nil {
		if json.Unmarshal(v, out) != nil {
			b.err = apiErr(errValidation, "%s 要是字符串", k)
		}
		*out = strings.TrimSpace(*out)
	}
}

func (b *bodyReader) num(k string, out *fx) {
	if v, ok := b.raw[k]; ok && b.err == nil {
		if string(v) == "null" {
			*out = 0
			return
		}
		var f float64
		if json.Unmarshal(v, &f) != nil {
			b.err = apiErr(errValidation, "%s 要是数字", k)
			return
		}
		x, ok := fxFromFloat(f)
		if !ok || x < 0 {
			b.err = apiErr(errValidation, "%s 要是不小于 0 的数", k)
			return
		}
		*out = x
	}
}

func (b *bodyReader) boolean(k string, out *bool) {
	if v, ok := b.raw[k]; ok && b.err == nil {
		if json.Unmarshal(v, out) != nil {
			b.err = apiErr(errValidation, "%s 要是 true 或 false", k)
		}
	}
}

func (b *bodyReader) only(keys ...string) {
	for k := range b.raw {
		if !slices.Contains(keys, k) && b.err == nil {
			b.err = apiErr(errValidation, "不认识的字段 %s", k)
		}
	}
}

// failPlace 把下单入口的错误写回：风控拦截、二次确认是 409。
func (h *handlers) failPlace(w http.ResponseWriter, r *http.Request, err error) {
	var re *riskError
	var ce *confirmError
	switch {
	case errors.As(err, &re):
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "conflict", "reason": "risk",
			"message": "风控未通过：" + strings.Join(re.Blocks, "；"), "blocks": re.Blocks, "order": re.Order.view()}})
	case errors.As(err, &ce):
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "conflict", "reason": "confirm",
			"message": ce.Error(), "value": ce.Value.Float(), "confirm_above": ce.Threshold.Float()}})
	case errors.Is(err, errHalted):
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "conflict", "reason": "halted",
			"message": "熔断中，不能启动新运行；先到风控解除熔断"}})
	case errors.Is(err, errConflictState):
		_, msg, _ := strings.Cut(err.Error(), ": ")
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "conflict", "reason": "state", "message": msg}})
	default:
		h.fail(w, r, err)
	}
}

func pageParams(r *http.Request, def, maxN int) (int, int, error) {
	qs := r.URL.Query()
	limit, offset := def, 0
	if v := qs.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > maxN {
			return 0, 0, apiErr(errValidation, "limit 要在 1 到 %d", maxN)
		}
		limit = n
	}
	if v := qs.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return 0, 0, apiErr(errValidation, "offset 要是非负整数")
		}
		offset = n
	}
	return limit, offset, nil
}

/* ---------- 委托 ---------- */

// POST /api/trade/orders：统一下单入口。
func (h *handlers) addOrder(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	b := &bodyReader{raw: raw}
	b.only("account_id", "symbol", "side", "type", "qty", "price", "stop_price", "leverage", "reduce_only", "confirmed")
	var req orderReq
	var lev fx
	b.str("account_id", &req.AccountID)
	b.str("symbol", &req.Symbol)
	b.str("side", &req.Side)
	b.str("type", &req.Type)
	b.num("qty", &req.Qty)
	b.num("price", &req.Price)
	b.num("stop_price", &req.Stop)
	b.num("leverage", &lev)
	b.boolean("reduce_only", &req.ReduceOnly)
	b.boolean("confirmed", &req.Confirmed)
	if b.err != nil {
		h.fail(w, r, b.err)
		return
	}
	if req.Type == "" {
		req.Type = "limit"
	}
	if lev%fxScale != 0 {
		h.fail(w, r, apiErr(errValidation, "杠杆要是整数倍"))
		return
	}
	req.Leverage = int(lev / fxScale)
	if _, ok := raw["leverage"]; ok && req.Leverage == 0 {
		h.fail(w, r, apiErr(errValidation, "杠杆要在 1 到 %d 倍", maxLeverage))
		return
	}
	req.Source = "manual"
	o, err := h.p.paper.place(r.Context(), req)
	if err != nil {
		h.failPlace(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": o.view()})
}

// GET /api/trade/orders?account_id=&status=&run_id=&symbol=&limit=&offset=
func (h *handlers) listOrders(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	qs := r.URL.Query()
	limit, offset, err := pageParams(r, 200, 1000)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var conds []string
	var args []any
	for _, k := range []string{"account_id", "run_id", "symbol"} {
		if v := qs.Get(k); v != "" {
			conds = append(conds, k+" = ?")
			args = append(args, v)
		}
	}
	base := strings.Join(conds, " AND ")
	where := base
	switch st := qs.Get("status"); st {
	case "":
	case "active":
		where = joinCond(base, "status = 'open'")
	case "history":
		where = joinCond(base, "status != 'open'")
	case orderOpen, orderFilled, orderCanceled, orderRejected:
		where = joinCond(base, "status = ?")
		args = append(args, st)
	default:
		h.fail(w, r, apiErr(errValidation, "status 只能是 active、history、open、filled、canceled、rejected"))
		return
	}
	var total, active, history int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_orders`+wherePrefix(where), args...).Scan(&total); err != nil {
		h.fail(w, r, err)
		return
	}
	baseArgs := args
	if qs.Get("status") != "" && qs.Get("status") != "active" && qs.Get("status") != "history" {
		baseArgs = args[:len(args)-1]
	}
	_ = h.c.Store().QueryRow(ctx, `SELECT COALESCE(SUM(status = 'open'), 0), COALESCE(SUM(status != 'open'), 0) FROM trade_orders`+wherePrefix(base), baseArgs...).Scan(&active, &history)
	os, err := queryOrders(ctx, h.c, wherePrefix(where)+` ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := make([]OrderView, len(os))
	for i, o := range os {
		out[i] = o.view()
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total, "active": active, "history": history, "limit": limit, "offset": offset}})
}

func joinCond(a, b string) string {
	if a == "" {
		return b
	}
	return a + " AND " + b
}

func wherePrefix(w string) string {
	if w == "" {
		return ""
	}
	return " WHERE " + w
}

func (h *handlers) getOrder(w http.ResponseWriter, r *http.Request) {
	o, err := loadOrder(r.Context(), h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": o.view()})
}

// PATCH /api/trade/orders/{id} {price?, stop_price?}：改挂单的委托价、触发价，开仓单重新过风控。
func (h *handlers) updateOrder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	b := &bodyReader{raw: raw}
	b.only("price", "stop_price")
	var price, stop fx
	b.num("price", &price)
	b.num("stop_price", &stop)
	if b.err != nil {
		h.fail(w, r, b.err)
		return
	}
	pp := h.p.paper
	pp.mu.Lock()
	defer pp.mu.Unlock()
	o, err := loadOrder(ctx, h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if o.Status != orderOpen {
		h.failPlace(w, r, apiErr(errConflictState, "只有挂单中的委托能改价"))
		return
	}
	if _, err := paperAccount(ctx, h.c, o.AccountID); err != nil {
		h.fail(w, r, err)
		return
	}
	next := o
	if _, ok := raw["price"]; ok {
		if o.Type != "limit" && o.Type != "stop_limit" {
			h.fail(w, r, apiErr(errValidation, "%s单没有委托价", orderTypeText[o.Type]))
			return
		}
		if price <= 0 || price > fxMax {
			h.fail(w, r, apiErr(errValidation, "新价格要大于 0"))
			return
		}
		next.Price = price
	}
	if _, ok := raw["stop_price"]; ok {
		if o.Type != "stop" && o.Type != "stop_limit" {
			h.fail(w, r, apiErr(errValidation, "%s单没有触发价", orderTypeText[o.Type]))
			return
		}
		if o.Triggered {
			h.fail(w, r, apiErr(errValidation, "止损限价已经触发，只能改委托价"))
			return
		}
		if stop <= 0 || stop > fxMax {
			h.fail(w, r, apiErr(errValidation, "新触发价要大于 0"))
			return
		}
		next.Stop = stop
	}
	if next.Price == o.Price && next.Stop == o.Stop {
		writeJSON(w, http.StatusOK, map[string]any{"data": o.view()})
		return
	}
	// 开仓单按新价格重新过风控
	in, ok := loadLedgerInst(ctx, h.c, o.Symbol)
	if ok {
		a, _ := loadAccount(ctx, h.c, o.AccountID)
		pos, err := loadPosition(ctx, h.c, o.AccountID, o.Symbol)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		ref := next.Price
		if ref == 0 {
			ref = next.Stop
		}
		n, err := fxMul3(o.Qty, ref, in.Mult)
		if err != nil {
			h.fail(w, r, apiErr(errValidation, "金额太大"))
			return
		}
		val, err := pp.value(ctx, a)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		rules, err := pp.risk(ctx)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		var held fx
		for _, pm := range val.Positions {
			if pm.Symbol == o.Symbol {
				held += pm.Value
			}
		}
		if blocks := riskBlocks(riskInput{Rules: rules, Equity: val.Equity, Held: held, Value: n, Leverage: o.Leverage, Contract: in.contract(),
			Opening: opening(in, pos, o.Side, o.Qty, o.ReduceOnly), Name: in.Name}); len(blocks) > 0 {
			pp.audit(ctx, "risk_block", "trade_order", o.ID, "风控拦截改价："+strings.Join(blocks, "；"), map[string]any{"blocks": blocks, "price": next.Price.String(), "stop_price": next.Stop.String()}, userMeta)
			writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "conflict", "reason": "risk",
				"message": "风控未通过：" + strings.Join(blocks, "；"), "blocks": blocks, "order": o.view()}})
			return
		}
	}
	now := stamp(pp.now())
	res, err := h.c.Store().Exec(ctx, `UPDATE trade_orders SET price_e8 = ?, stop_e8 = ?, updated_at = ? WHERE id = ? AND status = 'open'`, next.Price, next.Stop, now, o.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n != 1 {
		h.failPlace(w, r, apiErr(errConflictState, "委托已经不是挂单中"))
		return
	}
	pp.audit(ctx, "modify", "trade_order", o.ID, "改价："+o.Symbol, map[string]any{"from": map[string]string{"price": o.Price.String(), "stop_price": o.Stop.String()},
		"to": map[string]string{"price": next.Price.String(), "stop_price": next.Stop.String()}}, userMeta)
	pp.poke()
	o, _ = loadOrder(ctx, h.c, o.ID)
	writeJSON(w, http.StatusOK, map[string]any{"data": o.view()})
}

// POST /api/trade/orders/{id}/cancel
func (h *handlers) cancelPaperOrder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pp := h.p.paper
	pp.mu.Lock()
	defer pp.mu.Unlock()
	o, err := loadOrder(ctx, h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	ok, err := pp.cancelLocked(ctx, o, "手动撤单", userMeta)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if !ok {
		h.failPlace(w, r, apiErr(errConflictState, "委托不是挂单中，撤不了"))
		return
	}
	o, _ = loadOrder(ctx, h.c, o.ID)
	writeJSON(w, http.StatusOK, map[string]any{"data": o.view()})
}

// POST /api/trade/orders/cancel-all {account_id?}：撤掉全部（或一个账户的）挂单。
func (h *handlers) cancelAllOrders(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readOptionalBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	b := &bodyReader{raw: raw}
	b.only("account_id")
	var aid string
	b.str("account_id", &aid)
	if b.err != nil {
		h.fail(w, r, b.err)
		return
	}
	if aid != "" {
		// 实盘账户的撤单同样不开放（403）
		if a, err := loadAccount(ctx, h.c, aid); err == nil && !a.Paper {
			h.fail(w, r, liveErr(a.Name))
			return
		}
	}
	pp := h.p.paper
	pp.mu.Lock()
	defer pp.mu.Unlock()
	where, args := "", []any{}
	if aid != "" {
		where, args = " AND account_id = ?", append(args, aid)
	}
	n, failed, err := pp.cancelWhereLocked(ctx, where, "全部撤单", userMeta, args...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if len(failed) > 0 {
		h.fail(w, r, errors.New(strings.Join(failed, "；")))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]int{"canceled": n}})
}

/* ---------- 持仓、成交 ---------- */

// GET /api/trade/positions?account_id=
func (h *handlers) listPositions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	aid := r.URL.Query().Get("account_id")
	accts, err := loadAccounts(ctx, h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := []PositionView{}
	for _, a := range accts {
		if aid != "" && a.ID != aid {
			continue
		}
		v, err := h.p.paper.value(ctx, a)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		for _, pm := range v.Positions {
			out = append(out, pm.view())
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// POST /api/trade/positions/{id}/close {type?, price?, stop_price?, confirmed?}：反向委托平掉整个持仓，合约带仅减仓；走统一下单入口。
func (h *handlers) closePosition(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readOptionalBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	b := &bodyReader{raw: raw}
	b.only("type", "price", "stop_price", "confirmed")
	req := orderReq{Type: "market", Source: "close"}
	b.str("type", &req.Type)
	b.num("price", &req.Price)
	b.num("stop_price", &req.Stop)
	b.boolean("confirmed", &req.Confirmed)
	if b.err != nil {
		h.fail(w, r, b.err)
		return
	}
	held, err := loadPositions(ctx, h.c, "")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	id := r.PathValue("id")
	i := slices.IndexFunc(held, func(p heldPosition) bool { return p.ID == id })
	if i < 0 {
		h.fail(w, r, apiErr(errNotFound, "持仓 %s 不存在或已经平掉", id))
		return
	}
	p := held[i]
	in, _ := loadLedgerInst(ctx, h.c, p.Symbol)
	req.AccountID, req.Symbol, req.Qty, req.RunID = p.AccountID, p.Symbol, p.Qty.abs(), p.RunID
	req.Side = "sell"
	if p.Qty < 0 {
		req.Side = "buy"
	}
	req.ReduceOnly = in.contract()
	o, err := h.p.paper.place(ctx, req)
	if err != nil {
		h.failPlace(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": o.view()})
}

// GET /api/trade/fills?account_id=&run_id=&order_id=&limit=&offset=
func (h *handlers) listFills(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	qs := r.URL.Query()
	limit, offset, err := pageParams(r, 200, 1000)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var conds []string
	var args []any
	for _, k := range []string{"account_id", "run_id", "order_id", "symbol"} {
		if v := qs.Get(k); v != "" {
			conds = append(conds, k+" = ?")
			args = append(args, v)
		}
	}
	where := wherePrefix(strings.Join(conds, " AND "))
	var total int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_fills`+where, args...).Scan(&total); err != nil {
		h.fail(w, r, err)
		return
	}
	fs, err := queryFills(ctx, h.c, where+` ORDER BY seq DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := make([]FillView, len(fs))
	for i, f := range fs {
		out[i] = f.view()
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total, "limit": limit, "offset": offset}})
}

/* ---------- 部署 ---------- */

// GET /api/trade/runs?strategy_id=&account_id=&status=
func (h *handlers) listRuns(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	qs := r.URL.Query()
	var conds []string
	var args []any
	for _, k := range []string{"strategy_id", "account_id"} {
		if v := qs.Get(k); v != "" {
			conds = append(conds, k+" = ?")
			args = append(args, v)
		}
	}
	if st := qs.Get("status"); st != "" {
		if !slices.Contains(RunStatuses, st) {
			h.fail(w, r, apiErr(errValidation, "status 只能是 running、paused、stopped、error"))
			return
		}
		conds = append(conds, "status = ?")
		args = append(args, st)
	}
	runs, err := queryRuns(ctx, h.c, wherePrefix(strings.Join(conds, " AND "))+` ORDER BY started_at DESC, id DESC`, args...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := []RunView{}
	meta := map[string]any{"total": len(runs), "running": 0, "paused": 0, "stopped": 0, "error": 0}
	var pnl float64
	for _, x := range runs {
		v, err := h.runView(ctx, x, runListLogs)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		meta[x.Status] = meta[x.Status].(int) + 1
		pnl += v.PnL
		out = append(out, v)
	}
	meta["pnl"] = pnl
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": meta})
}

// POST /api/trade/runs：部署到模拟盘。
func (h *handlers) addRun(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	x, err := h.createRun(ctx, raw)
	if err != nil {
		h.failPlace(w, r, err)
		return
	}
	v, err := h.runView(ctx, x, runDetailLogs)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": v})
}

func (h *handlers) getRun(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	x, err := loadRun(ctx, h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	v, err := h.runView(ctx, x, runDetailLogs)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

func (h *handlers) runAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		raw, err := readOptionalBody(r)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		reason := ""
		for k, v := range raw {
			if k != "reason" || action != "stop" {
				h.fail(w, r, apiErr(errValidation, "不认识的字段 %s", k))
				return
			}
			if json.Unmarshal(v, &reason) != nil || utf8.RuneCountInString(reason) > maxHaltReason {
				h.fail(w, r, apiErr(errValidation, "reason 要是字符串，最多 %d 字", maxHaltReason))
				return
			}
			reason = strings.TrimSpace(reason)
		}
		x, err := h.p.runs.act(ctx, r.PathValue("id"), action, reason)
		if err != nil {
			h.failPlace(w, r, err)
			return
		}
		v, err := h.runView(ctx, x, runDetailLogs)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": v})
	}
}
