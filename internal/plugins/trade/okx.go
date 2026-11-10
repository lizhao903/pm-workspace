// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// OKX 公开行情（TRD-01c）：www.okx.com 的 /api/v5/market/ 和 /api/v5/public/，不需要也不带 API Key。
//
// symbol 和 instId 互转：OKX: 加上 instId 就是 symbol，冒号后原样是 instId。
//
//	现货 OKX:BTC-USDT          <-> instId BTC-USDT（instType SPOT）
//	永续 OKX:BTC-USDT-SWAP     <-> instId BTC-USDT-SWAP（instType SWAP，只接 USDT 本位 linear）
//	交割、期权（OKX:BTC-USD-261225 这类）不在覆盖里，回 ErrUnsupported。
//
// 数量换算成标的币数量：永续的盘口、成交量交易所给的是张数，乘合约面值 ctVal（BTC-USDT-SWAP 一张 0.01 BTC）。
// 日线、周线用 UTC 对齐的 1Dutc、1Wutc，和 Binance 一致。
type OKX struct {
	Base string // 默认 https://www.okx.com，测试换成假服务端
	http HTTPDoer

	mu    sync.Mutex
	ctVal map[string]float64 // instId -> 合约面值，永续用
}

// NewOKX 建 OKX 源；出网客户端在插件 Register 时绑定。
func NewOKX() *OKX { return &OKX{Base: "https://www.okx.com", ctVal: map[string]float64{}} }

func (o *OKX) BindHTTP(fn HTTPDoer)  { o.http = fn }
func (o *OKX) ID() string            { return "okx" }
func (o *OKX) Name() string          { return "OKX" }
func (o *OKX) ConnectorTool() string { return "okx_market" }

func (o *OKX) Coverage() []Coverage {
	return []Coverage{{Market: "crypto", Kinds: []string{"spot", "perp"}}}
}

// Ping 是连接器的连通测试：取一次交易所时间。
func (o *OKX) Ping(ctx context.Context) error {
	var v []json.RawMessage
	return o.get(ctx, "/api/v5/public/time", nil, &v)
}

// OKXInstID 把 symbol 换成 OKX 的 instId，不是 OKX: 开头的回 false。
func OKXInstID(symbol string) (string, bool) {
	venue, code := codeOf(symbol)
	return code, venue == "OKX" && code != ""
}

// OKXSymbol 把 instId 换成全局 symbol。
func OKXSymbol(instID string) string { return "OKX:" + instID }

// get 发请求，解开 {code, msg, data} 信封；code 不是 "0" 按错误处理（HTTP 200 也可能带业务错误码）。
func (o *OKX) get(ctx context.Context, path string, q url.Values, data any) error {
	u := o.Base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	var env struct {
		Code string          `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err := getJSON(ctx, o.http, "OKX", u, &env, okxErr); err != nil {
		return err
	}
	if env.Code != "0" {
		return okxCodeErr(http.StatusOK, env.Code, env.Msg)
	}
	if err := json.Unmarshal(env.Data, data); err != nil {
		return fmt.Errorf("OKX 响应不是预期的 JSON：%w", err)
	}
	return nil
}

func okxErr(status int, body []byte) error {
	var e struct {
		Code string `json:"code"`
		Msg  string `json:"msg"`
	}
	_ = json.Unmarshal(body, &e)
	if e.Code == "" && e.Msg == "" {
		e.Msg = strings.TrimSpace(string(body[:min(len(body), 200)]))
	}
	return okxCodeErr(status, e.Code, e.Msg)
}

func okxCodeErr(status int, code, msg string) error {
	ue := &UpstreamError{Source: "OKX", Status: status, Code: code, Msg: msg}
	switch code {
	case "51001": // 产品不存在
		return fmt.Errorf("%w：%s", ErrUnknownSymbol, ue.Error())
	case "50011", "50061": // 用户请求频率过快 / 子账户限频
		ue.RateLimited = true
	}
	return ue
}

// inst 按 instId 判断品种：-SWAP 结尾是永续，两段（BTC-USDT）是现货，其余（交割、期权）不覆盖。
func (o *OKX) inst(symbol string) (instID string, perp bool, err error) {
	id, ok := OKXInstID(symbol)
	if !ok {
		return "", false, fmt.Errorf("%w：%s", ErrUnknownSymbol, symbol)
	}
	if strings.HasSuffix(id, "-SWAP") {
		return id, true, nil
	}
	if strings.Count(id, "-") == 1 {
		return id, false, nil
	}
	return "", false, fmt.Errorf("%w：OKX 的交割和期权还没接（%s）", ErrUnsupported, symbol)
}

type okxInstrument struct {
	InstID   string `json:"instId"`
	InstType string `json:"instType"`
	BaseCcy  string `json:"baseCcy"`
	QuoteCcy string `json:"quoteCcy"`
	SettleCc string `json:"settleCcy"`
	CtType   string `json:"ctType"`
	CtVal    string `json:"ctVal"`
	Uly      string `json:"uly"`
	TickSz   string `json:"tickSz"`
	LotSz    string `json:"lotSz"`
	MinSz    string `json:"minSz"`
	State    string `json:"state"`
}

func (o *OKX) Instruments(ctx context.Context, market, kind string) ([]Instrument, error) {
	if market != "crypto" || (kind != "spot" && kind != "perp") {
		return nil, fmt.Errorf("%w：OKX 没有 %s/%s", ErrUnsupported, market, kind)
	}
	instType := "SPOT"
	if kind == "perp" {
		instType = "SWAP"
	}
	var list []okxInstrument
	if err := o.get(ctx, "/api/v5/public/instruments", url.Values{"instType": {instType}}, &list); err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	out := []Instrument{}
	for _, x := range list {
		if x.State != "live" {
			continue
		}
		in := Instrument{Symbol: OKXSymbol(x.InstID), Market: "crypto", Kind: kind, Venue: "OKX", Digits: digitsOf(x.TickSz), Lot: num(x.MinSz), Multiplier: 1, UpdatedAt: now}
		if in.Lot <= 0 {
			in.Lot = num(x.LotSz)
		}
		if kind == "spot" {
			if x.QuoteCcy != "USDT" {
				continue
			}
			in.Name = x.BaseCcy + "/" + x.QuoteCcy
		} else {
			if x.SettleCc != "USDT" || x.CtType != "linear" {
				continue
			}
			base, _, _ := strings.Cut(x.Uly, "-")
			in.Name = base + " 永续"
			in.Multiplier = num(x.CtVal)
			in.Underlying = OKXSymbol(x.Uly)
			o.mu.Lock()
			o.ctVal[x.InstID] = in.Multiplier
			o.mu.Unlock()
		}
		out = append(out, in)
	}
	return out, nil
}

// contractValue 是永续一张合约的面值（标的币数量）；没缓存时单取一次。
func (o *OKX) contractValue(ctx context.Context, instID string) (float64, error) {
	o.mu.Lock()
	v, ok := o.ctVal[instID]
	o.mu.Unlock()
	if ok && v > 0 {
		return v, nil
	}
	var list []okxInstrument
	if err := o.get(ctx, "/api/v5/public/instruments", url.Values{"instType": {"SWAP"}, "instId": {instID}}, &list); err != nil {
		return 0, err
	}
	if len(list) == 0 || num(list[0].CtVal) <= 0 {
		return 0, fmt.Errorf("%w：OKX 没有 %s 的合约面值", ErrUnknownSymbol, instID)
	}
	v = num(list[0].CtVal)
	o.mu.Lock()
	o.ctVal[instID] = v
	o.mu.Unlock()
	return v, nil
}

func (o *OKX) Ticker(ctx context.Context, symbol string) (Ticker, error) {
	id, perp, err := o.inst(symbol)
	if err != nil {
		return Ticker{}, err
	}
	var list []struct {
		Last      string `json:"last"`
		AskPx     string `json:"askPx"`
		BidPx     string `json:"bidPx"`
		Open24h   string `json:"open24h"`
		High24h   string `json:"high24h"`
		Low24h    string `json:"low24h"`
		Vol24h    string `json:"vol24h"`
		VolCcy24h string `json:"volCcy24h"`
		Ts        string `json:"ts"`
	}
	if err := o.get(ctx, "/api/v5/market/ticker", url.Values{"instId": {id}}, &list); err != nil {
		return Ticker{}, err
	}
	if len(list) == 0 {
		return Ticker{}, fmt.Errorf("%w：%s", ErrUnknownSymbol, symbol)
	}
	t := list[0]
	// 现货 vol24h 是标的币；永续 vol24h 是张数，volCcy24h 才是标的币
	vol := num(t.Vol24h)
	if perp {
		vol = num(t.VolCcy24h)
	}
	return Ticker{Symbol: symbol, Last: num(t.Last), Bid: num(t.BidPx), Ask: num(t.AskPx), Open24h: num(t.Open24h),
		High24h: num(t.High24h), Low24h: num(t.Low24h), Volume24h: vol, At: msTime(msOf(t.Ts))}, nil
}

// okxBars 是周期到 OKX bar 参数的对照；日线、周线用 UTC 对齐。
var okxBars = map[string]string{"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc", "1w": "1Wutc"}

// okxPage 是 candles 一页最多多少根。
const okxPage = 300

func (o *OKX) Klines(ctx context.Context, q KlineQuery) ([]Kline, error) {
	id, perp, err := o.inst(q.Symbol)
	if err != nil {
		return nil, err
	}
	bar, ok := okxBars[q.Interval]
	if !ok {
		return nil, fmt.Errorf("%w：K 线周期 %q", ErrUnsupported, q.Interval)
	}
	if q.Limit < 1 || q.Limit > 1000 {
		return nil, fmt.Errorf("K 线根数要在 1 到 1000：%d", q.Limit)
	}
	// after 取比它早的；End+1ms 让包含 End 的那根也在里面。新的在前，一页 300 根，往前翻
	var after int64
	if !q.End.IsZero() {
		after = q.End.UnixMilli() + 1
	}
	path := "/api/v5/market/candles"
	var out []Kline
	for len(out) < q.Limit {
		v := url.Values{"instId": {id}, "bar": {bar}, "limit": {strconv.Itoa(min(okxPage, q.Limit-len(out)))}}
		if after > 0 {
			v.Set("after", strconv.FormatInt(after, 10))
		}
		var raw [][]string
		if err := o.get(ctx, path, v, &raw); err != nil {
			return nil, err
		}
		if len(raw) == 0 {
			// candles 只有最近一段，再往前在 history-candles
			if path == "/api/v5/market/candles" {
				path = "/api/v5/market/history-candles"
				continue
			}
			break
		}
		for _, r := range raw {
			if len(r) < 7 {
				continue
			}
			// [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]：现货 vol 是标的币；永续 vol 是张数，volCcy 是标的币
			vol := num(r[5])
			if perp {
				vol = num(r[6])
			}
			out = append(out, Kline{Time: msTime(msOf(r[0])), Open: num(r[1]), High: num(r[2]), Low: num(r[3]), Close: num(r[4]), Volume: vol})
		}
		after = msOf(raw[len(raw)-1][0])
		if len(raw) < min(okxPage, q.Limit) && path == "/api/v5/market/history-candles" {
			break
		}
	}
	slices.SortFunc(out, func(a, b Kline) int { return a.Time.Compare(b.Time) })
	out = slices.CompactFunc(out, func(a, b Kline) bool { return a.Time.Equal(b.Time) })
	if len(out) > q.Limit {
		out = out[len(out)-q.Limit:]
	}
	return out, nil
}

func (o *OKX) OrderBook(ctx context.Context, symbol string, depth int) (OrderBook, error) {
	id, perp, err := o.inst(symbol)
	if err != nil {
		return OrderBook{}, err
	}
	if depth < 1 || depth > 100 {
		return OrderBook{}, fmt.Errorf("盘口档数要在 1 到 100：%d", depth)
	}
	mult := 1.0
	if perp {
		if mult, err = o.contractValue(ctx, id); err != nil {
			return OrderBook{}, err
		}
	}
	var list []struct {
		Asks [][]string `json:"asks"`
		Bids [][]string `json:"bids"`
		Ts   string     `json:"ts"`
	}
	if err := o.get(ctx, "/api/v5/market/books", url.Values{"instId": {id}, "sz": {strconv.Itoa(depth)}}, &list); err != nil {
		return OrderBook{}, err
	}
	if len(list) == 0 {
		return OrderBook{}, fmt.Errorf("%w：%s", ErrUnknownSymbol, symbol)
	}
	b := list[0]
	return OrderBook{Symbol: symbol, Bids: levels(b.Bids, depth, mult), Asks: levels(b.Asks, depth, mult), At: msTime(msOf(b.Ts))}, nil
}

func (o *OKX) Funding(ctx context.Context, symbol string) (Funding, error) {
	id, perp, err := o.inst(symbol)
	if err != nil {
		return Funding{}, err
	}
	if !perp {
		return Funding{}, fmt.Errorf("%w：%s 不是永续合约，没有资金费率", ErrUnsupported, symbol)
	}
	// fundingRate 是当期费率，在 fundingTime 结算；nextFundingTime 是再下一期
	var list []struct {
		FundingRate string `json:"fundingRate"`
		FundingTime string `json:"fundingTime"`
		Ts          string `json:"ts"`
	}
	if err := o.get(ctx, "/api/v5/public/funding-rate", url.Values{"instId": {id}}, &list); err != nil {
		return Funding{}, err
	}
	if len(list) == 0 {
		return Funding{}, fmt.Errorf("%w：%s", ErrUnknownSymbol, symbol)
	}
	f := list[0]
	return Funding{Symbol: symbol, Rate: num(f.FundingRate), NextTime: msTime(msOf(f.FundingTime)), At: msTime(msOf(f.Ts))}, nil
}
