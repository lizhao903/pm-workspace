// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

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

// OKX 实盘下单适配（TRD-08d）：/api/v5/trade/order 下单（POST）和查单（GET）、/api/v5/trade/cancel-order 撤单（POST）。
// 现货 tdMode cash，市价买单带 tgtCcy=base_ccy（数量按币算，不按 USDT 金额算）；USDT 永续 tdMode cross，数量是张数，
// 只支持单向持仓（posMode net_mode），不改杠杆。委托编号 clOrdId 由插件生成，查单、撤单按它。
// 下单请求带 expTime（发出时刻 + 5 秒）：晚到的请求交易所直接拒，状态未知时据此判断「查不到 = 没下成」。
// 测试网（OKX 模拟盘）和正式网同一个域名，请求头带 x-simulated-trading: 1。
//
// 结果的判定（OKX 文档「错误码」）：code 0 且 sCode 0 是收下了；50001（服务暂不可用）、50004（接口请求超时，不代表成功或失败）、
// 50013（系统繁忙）、50026（系统错误）、5xx、没收到回包是状态未知，按 clOrdId 查单，不重发；别的是拒了，没有下成。
// 查单 51603（委托不存在）回 errOrderNotFound；撤单 51400、51401、51402、51603（已撤、已成交、不存在）当成撤不了。

var okxUnknownCodes = map[string]bool{"50001": true, "50004": true, "50013": true, "50026": true}

var okxGoneCodes = map[string]bool{"51400": true, "51401": true, "51402": true, "51603": true}

func (o *okxAccount) Inst(symbol string) (liveInst, bool) {
	code, ok := strings.CutPrefix(symbol, "OKX:")
	if !ok {
		return liveInst{}, false
	}
	if strings.HasSuffix(code, "-USDT-SWAP") {
		return liveInst{Symbol: symbol, Code: code, Kind: "perp"}, true
	}
	if base, ok := strings.CutSuffix(code, "-USDT"); ok && base != "" && !strings.Contains(base, "-") {
		return liveInst{Symbol: symbol, Code: code, Kind: "spot"}, true
	}
	return liveInst{}, false
}

func (o *okxAccount) header(s *exSession, method, reqPath, body string) http.Header {
	ts := s.now.UTC().Format("2006-01-02T15:04:05.000Z")
	h := http.Header{}
	h.Set("OK-ACCESS-KEY", s.cfg.Secret("api_key"))
	h.Set("OK-ACCESS-SIGN", okxSign(s.cfg.Secret("api_secret"), ts, method, reqPath, body))
	h.Set("OK-ACCESS-TIMESTAMP", ts)
	h.Set("OK-ACCESS-PASSPHRASE", s.cfg.Secret("passphrase"))
	if isTestnet(s) {
		h.Set("x-simulated-trading", "1")
	}
	return h
}

// okxResult 是下单、撤单回包里 data 的一行。
type okxResult struct {
	OrdID   string `json:"ordId"`
	ClOrdID string `json:"clOrdId"`
	SCode   string `json:"sCode"`
	SMsg    string `json:"sMsg"`
}

// write 发一个签名的写请求（下单、撤单），解开 {code, msg, data}；回第一行结果，code 不是 0 时回 *ExchangeError（Code 取 sCode）。
func (o *okxAccount) write(ctx context.Context, s *exSession, path string, payload map[string]string, exp bool) (okxResult, error) {
	b, _ := json.Marshal(payload)
	h := o.header(s, http.MethodPost, path, string(b))
	if exp {
		h.Set("expTime", strconv.FormatInt(s.now.Add(5e9).UnixMilli(), 10))
	}
	body, err := exDo(ctx, s.http, "OKX", http.MethodPost, o.Base+path, h, string(b), okxErrBody)
	if err != nil {
		return okxResult{}, err
	}
	var env struct {
		Code string      `json:"code"`
		Msg  string      `json:"msg"`
		Data []okxResult `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return okxResult{}, &exNoReplyError{msg: "OKX " + path + " 响应不是预期的 JSON", err: err}
	}
	var r okxResult
	if len(env.Data) > 0 {
		r = env.Data[0]
	}
	if env.Code != "0" || (r.SCode != "" && r.SCode != "0") {
		code, msg := env.Code, env.Msg
		if r.SCode != "" && r.SCode != "0" {
			code, msg = r.SCode, r.SMsg
		}
		return r, &ExchangeError{Broker: "OKX", Status: http.StatusOK, Code: code, Msg: msg, Path: path, Auth: okxAuthCodes[code]}
	}
	return r, nil
}

func okxPlaceErr(err error) error {
	var nr *exNoReplyError
	var ee *ExchangeError
	switch {
	case errors.As(err, &nr):
		return &exUnknownError{msg: "下单请求没收到回包：" + err.Error()}
	case errors.As(err, &ee) && (ee.Status >= 500 || okxUnknownCodes[ee.Code]):
		return &exUnknownError{msg: "交易所回「状态未知」：" + err.Error()}
	case errors.As(err, &ee):
		return &exRejectError{msg: err.Error()}
	}
	return err
}

func (o *okxAccount) Rules(ctx context.Context, s *exSession, in liveInst) (symbolRules, error) {
	instType := "SPOT"
	if in.Kind == "perp" {
		instType = "SWAP"
	}
	var h http.Header
	if isTestnet(s) {
		h = http.Header{"X-Simulated-Trading": {"1"}}
	}
	body, err := exGet(ctx, s.http, "OKX", o.Base+"/api/v5/public/instruments?"+url.Values{"instType": {instType}, "instId": {in.Code}}.Encode(), h, okxErrBody)
	if err != nil {
		return symbolRules{}, err
	}
	var env struct {
		Code string `json:"code"`
		Msg  string `json:"msg"`
		Data []struct {
			InstID   string `json:"instId"`
			TickSz   string `json:"tickSz"`
			LotSz    string `json:"lotSz"`
			MinSz    string `json:"minSz"`
			CtVal    string `json:"ctVal"`
			MaxLmtSz string `json:"maxLmtSz"`
			MaxMktSz string `json:"maxMktSz"`
			State    string `json:"state"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil || env.Code != "0" {
		return symbolRules{}, fmt.Errorf("OKX 没返回 %s 的交易规则：%s", in.Code, env.Msg)
	}
	for _, x := range env.Data {
		if x.InstID != in.Code {
			continue
		}
		r := symbolRules{Trading: x.State == "live", Tick: mustFx(x.TickSz), Step: mustFx(x.LotSz), MinQty: mustFx(x.MinSz),
			MaxQty: mustFx(x.MaxLmtSz), MktMaxQty: mustFx(x.MaxMktSz)}
		if in.Kind == "perp" {
			r.CtVal = mustFx(x.CtVal)
		}
		return r, nil
	}
	return symbolRules{}, fmt.Errorf("OKX 没有 %s 的交易规则", in.Code)
}

func (o *okxAccount) Perp(ctx context.Context, s *exSession, in liveInst, k KeyPerms) (perpSetup, error) {
	var rows []struct {
		Lever   string `json:"lever"`
		MgnMode string `json:"mgnMode"`
	}
	if err := o.get(ctx, s, "/api/v5/account/leverage-info", url.Values{"instId": {in.Code}, "mgnMode": {"cross"}}, &rows); err != nil {
		return perpSetup{}, err
	}
	out := perpSetup{Hedge: k.Hedge, MgnMode: "cross"}
	for _, x := range rows {
		if n, err := strconv.Atoi(strings.Split(x.Lever, ".")[0]); err == nil && n > 0 {
			out.Leverage = n
		}
	}
	if out.Leverage == 0 {
		return out, fmt.Errorf("OKX 没返回 %s 的杠杆", in.Code)
	}
	return out, nil
}

func (o *okxAccount) Place(ctx context.Context, s *exSession, in liveInst, x exOrder) (exOrderState, error) {
	p := map[string]string{"instId": in.Code, "clOrdId": x.ClientID, "side": x.Side, "ordType": x.Type, "sz": x.Qty.String(), "tdMode": x.TdMode}
	if x.Type == "limit" {
		p["px"] = x.Price.String()
	}
	if in.Kind == "spot" && x.Type == "market" {
		p["tgtCcy"] = "base_ccy"
	}
	if in.Kind == "perp" && x.ReduceOnly {
		p["reduceOnly"] = "true"
	}
	r, err := o.write(ctx, s, "/api/v5/trade/order", p, true)
	if err != nil {
		return exOrderState{}, okxPlaceErr(err)
	}
	// 下单回包只有委托号：先记成挂单中，成交情况查单回写
	return exOrderState{OrderID: r.OrdID, ClientID: r.ClOrdID, Status: orderOpen, Raw: "accepted"}, nil
}

type okxOrderResp struct {
	OrdID     string `json:"ordId"`
	ClOrdID   string `json:"clOrdId"`
	State     string `json:"state"`
	AccFillSz string `json:"accFillSz"`
	AvgPx     string `json:"avgPx"`
	Fee       string `json:"fee"`
}

func (r okxOrderResp) state() exOrderState {
	st := orderOpen
	filled := mustFx(r.AccFillSz)
	switch r.State {
	case "live":
		if filled > 0 {
			st = orderPartial
		}
	case "partially_filled":
		st = orderPartial
	case "filled":
		st = orderFilled
	case "canceled", "mmp_canceled":
		st = orderCanceled
	}
	return exOrderState{OrderID: r.OrdID, ClientID: r.ClOrdID, Status: st, Raw: r.State, Filled: filled, AvgPrice: mustFx(r.AvgPx), Fee: mustFx(r.Fee).abs()}
}

func (o *okxAccount) Query(ctx context.Context, s *exSession, in liveInst, clientID string) (exOrderState, error) {
	var rows []okxOrderResp
	if err := o.get(ctx, s, "/api/v5/trade/order", url.Values{"instId": {in.Code}, "clOrdId": {clientID}}, &rows); err != nil {
		var ee *ExchangeError
		if errors.As(err, &ee) && ee.Code == "51603" {
			return exOrderState{}, errOrderNotFound
		}
		return exOrderState{}, err
	}
	if len(rows) == 0 {
		return exOrderState{}, errOrderNotFound
	}
	return rows[0].state(), nil
}

func (o *okxAccount) Cancel(ctx context.Context, s *exSession, in liveInst, clientID, orderID string) (exOrderState, error) {
	p := map[string]string{"instId": in.Code}
	if clientID != "" {
		p["clOrdId"] = clientID
	} else {
		p["ordId"] = orderID
	}
	r, err := o.write(ctx, s, "/api/v5/trade/cancel-order", p, false)
	if err != nil {
		var ee *ExchangeError
		if errors.As(err, &ee) && okxGoneCodes[ee.Code] {
			return exOrderState{}, errOrderNotFound
		}
		return exOrderState{}, err
	}
	return exOrderState{OrderID: r.OrdID, ClientID: r.ClOrdID, Status: orderCanceled, Raw: "canceled"}, nil
}

func (o *okxAccount) OpenOrders(ctx context.Context, s *exSession, _ KeyPerms) ([]LiveOrder, error) {
	var od []struct {
		InstID string `json:"instId"`
		OrdID  string `json:"ordId"`
		Side   string `json:"side"`
		Sz     string `json:"sz"`
	}
	if err := o.get(ctx, s, "/api/v5/trade/orders-pending", url.Values{"limit": {"100"}}, &od); err != nil {
		return nil, err
	}
	out := []LiveOrder{}
	for _, x := range od {
		q := mustFx(x.Sz)
		out = append(out, LiveOrder{ID: x.OrdID, Symbol: "OKX:" + x.InstID, Side: x.Side, Qty: q.Float(), qty: q})
	}
	return out, nil
}
