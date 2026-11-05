package trade

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Binance 公开行情（TRD-01b）：现货走只行情的 data-api.binance.vision，U 本位永续走 fapi.binance.com 的公开行情路径。
// 不需要 API Key，也不带任何 Key；域名和路径白名单在 internal/plugin/network.go 的 market-data 组。
//
// symbol 写法：现货 BINANCE:BTCUSDT，U 本位永续 BINANCE:BTCUSDT.P（同原型）。只同步 USDT 计价的。
// 数量一律是标的币数量（BTC 个数），时间是 UTC。
type Binance struct {
	SpotBase string // 默认 https://data-api.binance.vision，测试换成假服务端
	PerpBase string // 默认 https://fapi.binance.com
	http     HTTPDoer
}

// NewBinance 建 Binance 源；出网客户端在插件 Register 时绑定。
func NewBinance() *Binance {
	return &Binance{SpotBase: "https://data-api.binance.vision", PerpBase: "https://fapi.binance.com"}
}

func (b *Binance) BindHTTP(fn HTTPDoer)  { b.http = fn }
func (b *Binance) ID() string            { return "binance" }
func (b *Binance) Name() string          { return "Binance" }
func (b *Binance) ConnectorTool() string { return "binance_market" }

func (b *Binance) Coverage() []Coverage {
	return []Coverage{{Market: "crypto", Kinds: []string{"spot", "perp"}}}
}

// Ping 是连接器的连通测试：现货和永续各 ping 一次。
func (b *Binance) Ping(ctx context.Context) error {
	var v struct{}
	if err := b.get(ctx, b.SpotBase+"/api/v3/ping", &v); err != nil {
		return err
	}
	return b.get(ctx, b.PerpBase+"/fapi/v1/ping", &v)
}

func (b *Binance) get(ctx context.Context, u string, out any) error {
	return getJSON(ctx, b.http, "Binance", u, out, binanceErr)
}

// binanceErr 认 Binance 的错误体 {"code":-1121,"msg":"Invalid symbol."}。
func binanceErr(status int, body []byte) error {
	var e struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	_ = json.Unmarshal(body, &e)
	ue := &UpstreamError{Source: "Binance", Status: status, Msg: e.Msg}
	if e.Code != 0 {
		ue.Code = strconv.Itoa(e.Code)
	}
	switch e.Code {
	case -1121, -1122: // Invalid symbol / Invalid symbol status
		return fmt.Errorf("%w：%s", ErrUnknownSymbol, ue.Error())
	case -1003, -1015: // Too many requests / Too many orders
		ue.RateLimited = true
	}
	if ue.Msg == "" {
		ue.Msg = strings.TrimSpace(string(body[:min(len(body), 200)]))
	}
	return ue
}

// parse 把 symbol 拆成 Binance 的交易对和是否永续；不是 BINANCE: 开头的不认识。
func (b *Binance) parse(symbol string) (pair string, perp bool, err error) {
	venue, code := codeOf(symbol)
	if venue != "BINANCE" || code == "" {
		return "", false, fmt.Errorf("%w：%s", ErrUnknownSymbol, symbol)
	}
	if p, ok := strings.CutSuffix(code, ".P"); ok {
		return p, true, nil
	}
	return code, false, nil
}

type binanceFilter struct {
	FilterType string `json:"filterType"`
	TickSize   string `json:"tickSize"`
	MinQty     string `json:"minQty"`
	StepSize   string `json:"stepSize"`
}

type binanceSymbol struct {
	Symbol       string          `json:"symbol"`
	Status       string          `json:"status"`
	BaseAsset    string          `json:"baseAsset"`
	QuoteAsset   string          `json:"quoteAsset"`
	ContractType string          `json:"contractType"`
	SpotAllowed  *bool           `json:"isSpotTradingAllowed"`
	Filters      []binanceFilter `json:"filters"`
}

func (s binanceSymbol) filter(t string) binanceFilter {
	i := slices.IndexFunc(s.Filters, func(f binanceFilter) bool { return f.FilterType == t })
	if i < 0 {
		return binanceFilter{}
	}
	return s.Filters[i]
}

func (b *Binance) Instruments(ctx context.Context, market, kind string) ([]Instrument, error) {
	if market != "crypto" || (kind != "spot" && kind != "perp") {
		return nil, fmt.Errorf("%w：Binance 没有 %s/%s", ErrUnsupported, market, kind)
	}
	var info struct {
		Symbols []binanceSymbol `json:"symbols"`
	}
	u := b.SpotBase + "/api/v3/exchangeInfo?symbolStatus=TRADING&showPermissionSets=false"
	if kind == "perp" {
		u = b.PerpBase + "/fapi/v1/exchangeInfo"
	}
	if err := b.get(ctx, u, &info); err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	out := []Instrument{}
	for _, s := range info.Symbols {
		if s.Status != "TRADING" || s.QuoteAsset != "USDT" {
			continue
		}
		if kind == "spot" && s.SpotAllowed != nil && !*s.SpotAllowed {
			continue
		}
		if kind == "perp" && s.ContractType != "PERPETUAL" {
			continue
		}
		lot := num(s.filter("LOT_SIZE").MinQty)
		if lot <= 0 {
			lot = num(s.filter("LOT_SIZE").StepSize)
		}
		in := Instrument{
			Symbol: "BINANCE:" + s.Symbol, Name: s.BaseAsset + "/" + s.QuoteAsset, Market: "crypto", Kind: kind, Venue: "Binance",
			Digits: digitsOf(s.filter("PRICE_FILTER").TickSize), Lot: lot, Multiplier: 1, UpdatedAt: now,
		}
		if kind == "perp" {
			in.Symbol += ".P"
			in.Name = s.BaseAsset + " 永续"
			in.Underlying = "BINANCE:" + s.Symbol
		}
		out = append(out, in)
	}
	return out, nil
}

// binanceTicker 是现货和永续 /ticker/24hr 的交集；现货多 bidPrice、askPrice。
type binanceTicker struct {
	LastPrice string `json:"lastPrice"`
	BidPrice  string `json:"bidPrice"`
	AskPrice  string `json:"askPrice"`
	OpenPrice string `json:"openPrice"`
	HighPrice string `json:"highPrice"`
	LowPrice  string `json:"lowPrice"`
	Volume    string `json:"volume"`
	CloseTime int64  `json:"closeTime"`
}

func (b *Binance) Ticker(ctx context.Context, symbol string) (Ticker, error) {
	pair, perp, err := b.parse(symbol)
	if err != nil {
		return Ticker{}, err
	}
	q := "?symbol=" + url.QueryEscape(pair)
	var t binanceTicker
	if !perp {
		if err := b.get(ctx, b.SpotBase+"/api/v3/ticker/24hr"+q, &t); err != nil {
			return Ticker{}, err
		}
	} else {
		if err := b.get(ctx, b.PerpBase+"/fapi/v1/ticker/24hr"+q, &t); err != nil {
			return Ticker{}, err
		}
		// 永续的 24hr 不带买一卖一，另取 bookTicker
		var bt struct {
			BidPrice string `json:"bidPrice"`
			AskPrice string `json:"askPrice"`
		}
		if err := b.get(ctx, b.PerpBase+"/fapi/v1/ticker/bookTicker"+q, &bt); err != nil {
			return Ticker{}, err
		}
		t.BidPrice, t.AskPrice = bt.BidPrice, bt.AskPrice
	}
	at := msTime(t.CloseTime)
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return Ticker{Symbol: symbol, Last: num(t.LastPrice), Bid: num(t.BidPrice), Ask: num(t.AskPrice), Open24h: num(t.OpenPrice),
		High24h: num(t.HighPrice), Low24h: num(t.LowPrice), Volume24h: num(t.Volume), At: at}, nil
}

func (b *Binance) Klines(ctx context.Context, q KlineQuery) ([]Kline, error) {
	pair, perp, err := b.parse(q.Symbol)
	if err != nil {
		return nil, err
	}
	if _, ok := Intervals[q.Interval]; !ok {
		return nil, fmt.Errorf("%w：K 线周期 %q", ErrUnsupported, q.Interval)
	}
	if q.Limit < 1 || q.Limit > 1000 {
		return nil, fmt.Errorf("K 线根数要在 1 到 1000：%d", q.Limit)
	}
	v := url.Values{"symbol": {pair}, "interval": {q.Interval}, "limit": {strconv.Itoa(q.Limit)}}
	if !q.End.IsZero() {
		v.Set("endTime", strconv.FormatInt(q.End.UnixMilli(), 10))
	}
	u := b.SpotBase + "/api/v3/klines?" + v.Encode()
	if perp {
		u = b.PerpBase + "/fapi/v1/klines?" + v.Encode()
	}
	// 每根是 [开盘时间, 开, 高, 低, 收, 量, 收盘时间, 成交额, 笔数, ...]，数字是字符串
	var raw [][]json.RawMessage
	if err := b.get(ctx, u, &raw); err != nil {
		return nil, err
	}
	out := make([]Kline, 0, len(raw))
	for _, r := range raw {
		if len(r) < 6 {
			continue
		}
		var t int64
		var o, h, l, c, vol string
		if json.Unmarshal(r[0], &t) != nil || json.Unmarshal(r[1], &o) != nil || json.Unmarshal(r[2], &h) != nil ||
			json.Unmarshal(r[3], &l) != nil || json.Unmarshal(r[4], &c) != nil || json.Unmarshal(r[5], &vol) != nil {
			return nil, fmt.Errorf("Binance K 线格式不对：%s", r)
		}
		out = append(out, Kline{Time: msTime(t), Open: num(o), High: num(h), Low: num(l), Close: num(c), Volume: num(vol)})
	}
	return out, nil
}

// binancePerpDepths 是永续 depth 接口允许的档数。
var binancePerpDepths = []int{5, 10, 20, 50, 100, 500, 1000}

func (b *Binance) OrderBook(ctx context.Context, symbol string, depth int) (OrderBook, error) {
	pair, perp, err := b.parse(symbol)
	if err != nil {
		return OrderBook{}, err
	}
	if depth < 1 || depth > 100 {
		return OrderBook{}, fmt.Errorf("盘口档数要在 1 到 100：%d", depth)
	}
	limit := depth
	u := b.SpotBase + "/api/v3/depth"
	if perp {
		u = b.PerpBase + "/fapi/v1/depth"
		limit = binancePerpDepths[slices.IndexFunc(binancePerpDepths, func(n int) bool { return n >= depth })]
	}
	var d struct {
		Bids [][]string `json:"bids"`
		Asks [][]string `json:"asks"`
		T    int64      `json:"T"` // 永续才有：撮合时间
	}
	if err := b.get(ctx, u+"?symbol="+url.QueryEscape(pair)+"&limit="+strconv.Itoa(limit), &d); err != nil {
		return OrderBook{}, err
	}
	at := msTime(d.T)
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return OrderBook{Symbol: symbol, Bids: levels(d.Bids, depth, 1), Asks: levels(d.Asks, depth, 1), At: at}, nil
}

func (b *Binance) Funding(ctx context.Context, symbol string) (Funding, error) {
	pair, perp, err := b.parse(symbol)
	if err != nil {
		return Funding{}, err
	}
	if !perp {
		return Funding{}, fmt.Errorf("%w：%s 不是永续合约，没有资金费率", ErrUnsupported, symbol)
	}
	var p struct {
		LastFundingRate string `json:"lastFundingRate"`
		NextFundingTime int64  `json:"nextFundingTime"`
		Time            int64  `json:"time"`
	}
	if err := b.get(ctx, b.PerpBase+"/fapi/v1/premiumIndex?symbol="+url.QueryEscape(pair), &p); err != nil {
		return Funding{}, err
	}
	return Funding{Symbol: symbol, Rate: num(p.LastFundingRate), NextTime: msTime(p.NextFundingTime), At: msTime(p.Time)}, nil
}
