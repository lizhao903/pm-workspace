package trade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Binance 实盘下单适配（TRD-08d）：现货 /api/v3/order、U 本位永续 /fapi/v1/order 的下单（POST）、撤单（DELETE）、查单（GET），
// 参数都放查询串签名（同只读接口）。只做市价、限价；限价 GTC。委托编号 newClientOrderId 由插件生成，查单、撤单按 origClientOrderId。
// 下单回包要 newOrderRespType=RESULT（带状态和已成交数量）。永续只支持单向持仓（positionSide BOTH），不改杠杆。
//
// 结果的判定（Binance 文档「HTTP Return Codes」「Error Codes」）：
//   - 2xx：按回包的 status；
//   - 5xx、-1006（意外回包）、-1007（等后端超时，「Send status unknown」）、没收到回包：状态未知，按 clientOrderId 查单，不重发；
//   - 其余 4xx（参数、余额不足 -2010、限频 429）：交易所拒了，没有下成。
// 查单 -2013（委托不存在）回 errOrderNotFound；撤单 -2011（已经成交或撤掉）当成撤不了，调用方再查一次单看终态。

func (b *binanceAccount) Inst(symbol string) (liveInst, bool) {
	code, ok := strings.CutPrefix(symbol, "BINANCE:")
	if !ok || code == "" {
		return liveInst{}, false
	}
	if c, perp := strings.CutSuffix(code, ".P"); perp {
		if !strings.HasSuffix(c, "USDT") {
			return liveInst{}, false
		}
		return liveInst{Symbol: symbol, Code: c, Kind: "perp"}, true
	}
	if !strings.HasSuffix(code, "USDT") || strings.Contains(code, ".") {
		return liveInst{}, false
	}
	return liveInst{Symbol: symbol, Code: code, Kind: "spot"}, true
}

func (b *binanceAccount) base(s *exSession, in liveInst) (string, string) {
	if in.Kind == "perp" {
		return b.perp(s), "/fapi/v1/order"
	}
	return b.spot(s), "/api/v3/order"
}

type binanceRuleFilter struct {
	FilterType       string `json:"filterType"`
	TickSize         string `json:"tickSize"`
	MinPrice         string `json:"minPrice"`
	MaxPrice         string `json:"maxPrice"`
	StepSize         string `json:"stepSize"`
	MinQty           string `json:"minQty"`
	MaxQty           string `json:"maxQty"`
	MinNotional      string `json:"minNotional"`
	Notional         string `json:"notional"` // 合约 MIN_NOTIONAL
	ApplyMinToMarket *bool  `json:"applyMinToMarket"`
	ApplyToMarket    *bool  `json:"applyToMarket"`
}

func (b *binanceAccount) Rules(ctx context.Context, s *exSession, in liveInst) (symbolRules, error) {
	var info struct {
		Symbols []struct {
			Symbol  string              `json:"symbol"`
			Status  string              `json:"status"`
			Filters []binanceRuleFilter `json:"filters"`
		} `json:"symbols"`
	}
	u := b.spot(s) + "/api/v3/exchangeInfo?" + url.Values{"symbol": {in.Code}}.Encode()
	if in.Kind == "perp" {
		u = b.perp(s) + "/fapi/v1/exchangeInfo"
	}
	body, err := exGet(ctx, s.http, "Binance", u, nil, binanceErrBody)
	if err != nil {
		return symbolRules{}, err
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return symbolRules{}, errors.New("Binance exchangeInfo 响应不是预期的 JSON")
	}
	for _, x := range info.Symbols {
		if x.Symbol != in.Code {
			continue
		}
		r := symbolRules{Trading: x.Status == "TRADING"}
		for _, f := range x.Filters {
			switch f.FilterType {
			case "PRICE_FILTER":
				r.Tick, r.MinPrice, r.MaxPrice = mustFx(f.TickSize), mustFx(f.MinPrice), mustFx(f.MaxPrice)
			case "LOT_SIZE":
				r.Step, r.MinQty, r.MaxQty = mustFx(f.StepSize), mustFx(f.MinQty), mustFx(f.MaxQty)
			case "MARKET_LOT_SIZE":
				r.MktStep, r.MktMinQty, r.MktMaxQty = mustFx(f.StepSize), mustFx(f.MinQty), mustFx(f.MaxQty)
			case "NOTIONAL":
				r.MinNotional = mustFx(f.MinNotional)
				r.NotionalMkt = f.ApplyMinToMarket == nil || *f.ApplyMinToMarket
			case "MIN_NOTIONAL":
				if n := mustFx(f.Notional); n > 0 {
					r.MinNotional, r.NotionalMkt = n, true // 合约：市价单按标记价算，同样要满足
				} else {
					r.MinNotional = mustFx(f.MinNotional)
					r.NotionalMkt = f.ApplyToMarket == nil || *f.ApplyToMarket
				}
			}
		}
		return r, nil
	}
	return symbolRules{}, fmt.Errorf("Binance 没有 %s 的交易规则", in.Code)
}

func (b *binanceAccount) Perp(ctx context.Context, s *exSession, in liveInst, _ KeyPerms) (perpSetup, error) {
	var rows []struct {
		Leverage     string `json:"leverage"`
		PositionSide string `json:"positionSide"`
		MarginType   string `json:"marginType"`
	}
	if err := b.get(ctx, s, b.perp(s), "/fapi/v2/positionRisk", url.Values{"symbol": {in.Code}}, &rows); err != nil {
		return perpSetup{}, err
	}
	out := perpSetup{MgnMode: "cross"}
	for _, x := range rows {
		if n, err := strconv.Atoi(x.Leverage); err == nil && n > 0 {
			out.Leverage = n
		}
		if ps := strings.ToUpper(x.PositionSide); ps == "LONG" || ps == "SHORT" {
			out.Hedge = true
		}
		if strings.EqualFold(x.MarginType, "isolated") {
			out.MgnMode = "isolated"
		}
	}
	if out.Leverage == 0 {
		return out, fmt.Errorf("Binance 没返回 %s 的杠杆", in.Code)
	}
	return out, nil
}

// binanceOrderResp 是下单、查单、撤单的回包（现货和合约的并集）。
type binanceOrderResp struct {
	OrderID       int64  `json:"orderId"`
	ClientOrderID string `json:"clientOrderId"`
	Status        string `json:"status"`
	ExecutedQty   string `json:"executedQty"`
	CumQuote      string `json:"cummulativeQuoteQty"` // 现货
	CumQuoteF     string `json:"cumQuote"`            // 合约
	AvgPrice      string `json:"avgPrice"`            // 合约
}

func (r binanceOrderResp) state() exOrderState {
	filled := mustFx(r.ExecutedQty)
	avg := mustFx(r.AvgPrice)
	if avg == 0 && filled > 0 {
		quote := mustFx(r.CumQuote)
		if quote == 0 {
			quote = mustFx(r.CumQuoteF)
		}
		if v, err := fxDiv(quote, filled); err == nil {
			avg = v
		}
	}
	st := orderOpen
	switch r.Status {
	case "NEW", "PENDING_NEW":
		st = orderOpen
		if filled > 0 {
			st = orderPartial
		}
	case "PARTIALLY_FILLED":
		st = orderPartial
	case "FILLED":
		st = orderFilled
	case "CANCELED", "PENDING_CANCEL", "EXPIRED", "EXPIRED_IN_MATCH":
		st = orderCanceled
	case "REJECTED":
		st = orderRejected
	}
	return exOrderState{OrderID: strconv.FormatInt(r.OrderID, 10), ClientID: r.ClientOrderID, Status: st, Raw: r.Status, Filled: filled, AvgPrice: avg}
}

// binanceUnknownCodes 是 Binance 表示「结果不明」的错误码。
var binanceUnknownCodes = map[string]bool{"-1000": true, "-1001": true, "-1006": true, "-1007": true}

// binancePlaceErr 把下单的错误分成状态未知、被拒。
func binancePlaceErr(err error) error {
	var nr *exNoReplyError
	var ee *ExchangeError
	switch {
	case errors.As(err, &nr):
		return &exUnknownError{msg: "下单请求没收到回包：" + err.Error()}
	case errors.As(err, &ee) && (ee.Status >= 500 || binanceUnknownCodes[ee.Code]):
		return &exUnknownError{msg: "交易所回「状态未知」：" + err.Error()}
	case errors.As(err, &ee):
		return &exRejectError{msg: err.Error()}
	}
	return err
}

func (b *binanceAccount) Place(ctx context.Context, s *exSession, in liveInst, o exOrder) (exOrderState, error) {
	base, path := b.base(s, in)
	q := url.Values{"symbol": {in.Code}, "side": {strings.ToUpper(o.Side)}, "type": {strings.ToUpper(o.Type)}, "quantity": {o.Qty.String()},
		"newClientOrderId": {o.ClientID}, "newOrderRespType": {"RESULT"}}
	if o.Type == "limit" {
		q.Set("price", o.Price.String())
		q.Set("timeInForce", "GTC")
	}
	if o.ReduceOnly && in.Kind == "perp" {
		q.Set("reduceOnly", "true")
	}
	var r binanceOrderResp
	if err := b.signed(ctx, s, http.MethodPost, base, path, q, &r); err != nil {
		return exOrderState{}, binancePlaceErr(err)
	}
	return r.state(), nil
}

func (b *binanceAccount) Query(ctx context.Context, s *exSession, in liveInst, clientID string) (exOrderState, error) {
	base, path := b.base(s, in)
	var r binanceOrderResp
	if err := b.signed(ctx, s, http.MethodGet, base, path, url.Values{"symbol": {in.Code}, "origClientOrderId": {clientID}}, &r); err != nil {
		var ee *ExchangeError
		if errors.As(err, &ee) && ee.Code == "-2013" {
			return exOrderState{}, errOrderNotFound
		}
		return exOrderState{}, err
	}
	return r.state(), nil
}

func (b *binanceAccount) Cancel(ctx context.Context, s *exSession, in liveInst, clientID, orderID string) (exOrderState, error) {
	base, path := b.base(s, in)
	q := url.Values{"symbol": {in.Code}}
	if clientID != "" {
		q.Set("origClientOrderId", clientID)
	} else {
		q.Set("orderId", orderID)
	}
	var r binanceOrderResp
	if err := b.signed(ctx, s, http.MethodDelete, base, path, q, &r); err != nil {
		var ee *ExchangeError
		if errors.As(err, &ee) && (ee.Code == "-2011" || ee.Code == "-2013") {
			return exOrderState{}, errOrderNotFound
		}
		return exOrderState{}, err
	}
	return r.state(), nil
}

func (b *binanceAccount) OpenOrders(ctx context.Context, s *exSession, k KeyPerms) ([]LiveOrder, error) {
	out := []LiveOrder{}
	var spot []binanceOrder
	if err := b.get(ctx, s, b.spot(s), "/api/v3/openOrders", nil, &spot); err != nil {
		return nil, err
	}
	for _, o := range spot {
		out = append(out, o.live("BINANCE:"+o.Symbol))
	}
	if k.Futures {
		var perp []binanceOrder
		if err := b.get(ctx, s, b.perp(s), "/fapi/v1/openOrders", nil, &perp); err != nil {
			return nil, err
		}
		for _, o := range perp {
			out = append(out, o.live("BINANCE:"+o.Symbol+".P"))
		}
	}
	return out, nil
}
