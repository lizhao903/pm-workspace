package trade

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakeAcctEx 是本机假交易所（httptest）：按 X-Original-Host 分 Binance 现货、Binance U 本位、OKX，
// 校验 API Key 和签名，实现 exchangeReadPaths 里的只读接口和 exchangeTradePaths 里的下单、撤单、查单（TRD-08d）；
// 别的路径一律 404 并记下来（测试断言没有出现）。测试里的凭证都是假的，不连任何真实交易所。
type fakeAcctEx struct {
	t  *testing.T
	mu sync.Mutex

	calls    []string // "GET host path"
	bad      []string // 签名、Key 不对的请求
	strange  []string // 不认识的路径、不是 GET 的请求
	fail     int      // >0：所有请求回 500（每次减一；-1 一直失败）
	authFail bool     // 回 401 和 -2015 / 50111（错误信息里故意带上 Key 和 Secret，看插件会不会抹掉）

	// Binance
	bnKey, bnSecret string
	bnPerms         map[string]bool
	bnBalances      map[string][2]string // 币种 -> free, locked
	bnFutures       []map[string]any     // positionRisk
	bnSpotOrders    []map[string]any
	bnPerpOrders    []map[string]any
	bnTrades        map[string][]map[string]any // 现货 symbol -> 成交
	bnPerpTrades    map[string][]map[string]any

	// OKX
	okKey, okSecret, okPass string
	okPerm                  string
	okDetails               []map[string]string
	okPositions             []map[string]string
	okOrders                []map[string]string
	okFills                 []map[string]string
	okPosMode, okLever      string

	// 下单（TRD-08d）
	orders     map[string]*fakeOrder // clientOrderId -> 委托
	orderSeq   int64
	posts      map[string]int // clientOrderId -> 收到几次下单请求
	writes     []string       // 收到的写请求 "METHOD host path"
	placeMode  string         // ""：收下挂着；fill：马上全部成交；reject：拒单；close：收下但不回包（断开连接）；drop：没收下、回 503
	cancelFail map[string]bool
	bnLeverage string
	bnHedge    bool
}

// fakeOrder 是假交易所上的一笔委托。
type fakeOrder struct {
	Host, Symbol, ClientID, Side, Type, Qty, Price string
	Status, Executed                               string // Binance 的状态写法；OKX 换算
	ID                                             int64
	ReduceOnly                                     bool
	Params                                         map[string]string
}

func (o *fakeOrder) binance() map[string]any {
	quote, _ := fxMul(mustFx(o.Executed), mustFx(o.Price))
	return map[string]any{"symbol": o.Symbol, "orderId": o.ID, "clientOrderId": o.ClientID, "status": o.Status, "executedQty": o.Executed,
		"origQty": o.Qty, "price": orDefault(o.Price, "0"), "cummulativeQuoteQty": quote.String(), "avgPrice": "0", "type": o.Type, "side": o.Side, "time": 1730000000000}
}

func (o *fakeOrder) okxState() string {
	switch o.Status {
	case "FILLED":
		return "filled"
	case "PARTIALLY_FILLED":
		return "partially_filled"
	case "CANCELED":
		return "canceled"
	}
	return "live"
}

func (o *fakeOrder) open() bool { return o.Status == "NEW" || o.Status == "PARTIALLY_FILLED" }

// fill 让一笔委托成交到 executed（全部成交时状态 FILLED）。
func (f *fakeAcctEx) fill(clientID, executed string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o := f.orders[clientID]
	o.Executed = executed
	o.Status = "PARTIALLY_FILLED"
	if mustFx(executed) >= mustFx(o.Qty) {
		o.Status = "FILLED"
	}
}

func (f *fakeAcctEx) order(clientID string) *fakeOrder {
	f.mu.Lock()
	defer f.mu.Unlock()
	if o := f.orders[clientID]; o != nil {
		c := *o
		return &c
	}
	return nil
}

func (f *fakeAcctEx) writeCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.writes...)
}

func (f *fakeAcctEx) postCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.posts {
		n += c
	}
	return n
}

// fakeTradeWrite 是假交易所认的写请求（同 exchangeTradePaths 的下单、撤单）。
func fakeTradeWrite(method, host, path string) bool {
	for _, p := range exchangeTradePaths[host] {
		if p.Method == method && p.Path == path {
			return true
		}
	}
	return false
}

const (
	testBNKey    = "bnkey-TEST-ONLY-0001-abcdWXYZ"
	testBNSecret = "bnsecret-TEST-ONLY-never-real-9f8e7d"
	testOKKey    = "okkey-TEST-ONLY-0002-qrst7Q2c"
	testOKSecret = "oksecret-TEST-ONLY-never-real-1a2b3c"
	testOKPass   = "okpass-TEST-ONLY-xyz"
)

func newFakeAcctEx(t *testing.T) *fakeAcctEx {
	return &fakeAcctEx{t: t, bnKey: testBNKey, bnSecret: testBNSecret, okKey: testOKKey, okSecret: testOKSecret, okPass: testOKPass,
		bnPerms: map[string]bool{"enableReading": true},
		orders:  map[string]*fakeOrder{}, posts: map[string]int{}, cancelFail: map[string]bool{}, bnLeverage: "5", okPosMode: "net_mode", okLever: "3",
		bnBalances: map[string][2]string{"USDT": {"1000.5", "0"}, "BTC": {"0.5", "0.1"}},
		bnTrades:   map[string][]map[string]any{}, bnPerpTrades: map[string][]map[string]any{},
		okPerm:    "read_only",
		okDetails: []map[string]string{{"ccy": "USDT", "cashBal": "2000", "availBal": "1500", "frozenBal": "500", "eqUsd": "2000"}, {"ccy": "ETH", "cashBal": "1.5", "availBal": "1.5", "frozenBal": "0", "eqUsd": "4500"}},
	}
}

func (f *fakeAcctEx) set(fn func(f *fakeAcctEx)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeAcctEx) snapshot() (calls, bad, strange []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...), append([]string(nil), f.bad...), append([]string(nil), f.strange...)
}

func writeJSONT(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeAcctEx) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	host := r.Header.Get("X-Original-Host")
	f.calls = append(f.calls, r.Method+" "+host+" "+r.URL.Path)
	if r.Method != http.MethodGet {
		if !fakeTradeWrite(r.Method, host, r.URL.Path) {
			f.strange = append(f.strange, r.Method+" "+host+" "+r.URL.Path)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		f.writes = append(f.writes, r.Method+" "+host+" "+r.URL.Path)
	}
	if f.fail != 0 {
		if f.fail > 0 {
			f.fail--
		}
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"code":-1001,"msg":"Internal error; unable to process your request. Please try again."}`))
		return
	}
	switch host {
	case "api.binance.com", "fapi.binance.com":
		f.binance(w, r, host)
	case "www.okx.com":
		f.okx(w, r)
	default:
		f.strange = append(f.strange, "host "+host)
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fakeAcctEx) binance(w http.ResponseWriter, r *http.Request, host string) {
	switch host + r.URL.Path {
	case "api.binance.com/api/v3/exchangeInfo":
		writeJSONT(w, 200, map[string]any{"symbols": []map[string]any{{"symbol": "BTCUSDT", "status": "TRADING", "filters": []map[string]any{
			{"filterType": "PRICE_FILTER", "tickSize": "0.01", "minPrice": "0.01", "maxPrice": "1000000"},
			{"filterType": "LOT_SIZE", "stepSize": "0.00001", "minQty": "0.00001", "maxQty": "9000"},
			{"filterType": "NOTIONAL", "minNotional": "5", "applyMinToMarket": true, "maxNotional": "9000000", "applyMaxToMarket": false},
		}}}})
		return
	case "fapi.binance.com/fapi/v1/exchangeInfo":
		writeJSONT(w, 200, map[string]any{"symbols": []map[string]any{{"symbol": "ETHUSDT", "status": "TRADING"}, {"symbol": "BTCUSDT", "status": "TRADING", "filters": []map[string]any{
			{"filterType": "PRICE_FILTER", "tickSize": "0.10", "minPrice": "0.10", "maxPrice": "4000000"},
			{"filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.001", "maxQty": "1000"},
			{"filterType": "MARKET_LOT_SIZE", "stepSize": "0.001", "minQty": "0.001", "maxQty": "120"},
			{"filterType": "MIN_NOTIONAL", "notional": "100"},
		}}}})
		return
	}
	raw := r.URL.RawQuery
	i := strings.LastIndex(raw, "&signature=")
	if i < 0 || r.Header.Get("X-MBX-APIKEY") != f.bnKey {
		f.bad = append(f.bad, r.URL.Path)
		writeJSONT(w, http.StatusUnauthorized, map[string]any{"code": -2015, "msg": "Invalid API-key, IP, or permissions for action."})
		return
	}
	m := hmac.New(sha256.New, []byte(f.bnSecret))
	m.Write([]byte(raw[:i]))
	if hex.EncodeToString(m.Sum(nil)) != raw[i+len("&signature="):] {
		f.bad = append(f.bad, r.URL.Path)
		writeJSONT(w, http.StatusUnauthorized, map[string]any{"code": -1022, "msg": "Signature for this request is not valid."})
		return
	}
	if f.authFail {
		writeJSONT(w, http.StatusUnauthorized, map[string]any{"code": -2015, "msg": "Invalid API-key " + f.bnKey + " secret " + f.bnSecret})
		return
	}
	q := r.URL.Query()
	switch host + r.URL.Path {
	case "api.binance.com/sapi/v1/account/apiRestrictions":
		out := map[string]any{"ipRestrict": false, "createTime": 1698645219000}
		for _, k := range []string{"enableReading", "enableSpotAndMarginTrading", "enableWithdrawals", "enableInternalTransfer", "enableMargin", "enableFutures",
			"permitsUniversalTransfer", "enableVanillaOptions", "enablePortfolioMarginTrading"} {
			out[k] = f.bnPerms[k]
		}
		writeJSONT(w, 200, out)
	case "api.binance.com/api/v3/account":
		bs := []map[string]string{}
		for a, v := range f.bnBalances {
			bs = append(bs, map[string]string{"asset": a, "free": v[0], "locked": v[1]})
		}
		writeJSONT(w, 200, map[string]any{"uid": 1, "canTrade": true, "accountType": "SPOT", "balances": bs})
	case "api.binance.com/api/v3/openOrders":
		writeJSONT(w, 200, append(nonNil(f.bnSpotOrders), f.openOf("api.binance.com")...))
	case "api.binance.com/api/v3/myTrades":
		writeJSONT(w, 200, pageTrades(f.bnTrades[q.Get("symbol")], q))
	case "fapi.binance.com/fapi/v2/account":
		writeJSONT(w, 200, map[string]string{"totalMarginBalance": "500", "availableBalance": "300", "totalInitialMargin": "200"})
	case "fapi.binance.com/fapi/v2/positionRisk":
		if sym := q.Get("symbol"); sym != "" {
			if f.bnHedge {
				writeJSONT(w, 200, []map[string]any{{"symbol": sym, "leverage": f.bnLeverage, "positionSide": "LONG", "positionAmt": "0", "marginType": "cross"},
					{"symbol": sym, "leverage": f.bnLeverage, "positionSide": "SHORT", "positionAmt": "0", "marginType": "cross"}})
				return
			}
			writeJSONT(w, 200, []map[string]any{{"symbol": sym, "leverage": f.bnLeverage, "positionSide": "BOTH", "positionAmt": "0", "marginType": "cross"}})
			return
		}
		writeJSONT(w, 200, nonNil(f.bnFutures))
	case "fapi.binance.com/fapi/v1/openOrders":
		writeJSONT(w, 200, append(nonNil(f.bnPerpOrders), f.openOf("fapi.binance.com")...))
	case "api.binance.com/api/v3/order", "fapi.binance.com/fapi/v1/order":
		f.binanceOrder(w, r, host, q)
	case "fapi.binance.com/fapi/v1/userTrades":
		writeJSONT(w, 200, pageTrades(f.bnPerpTrades[q.Get("symbol")], q))
	default:
		f.strange = append(f.strange, "GET "+host+r.URL.Path)
		writeJSONT(w, 404, map[string]any{"code": -1, "msg": "not found"})
	}
}

func (f *fakeAcctEx) openOf(host string) []map[string]any {
	out := []map[string]any{}
	for _, o := range f.orders {
		if o.Host == host && o.open() {
			out = append(out, o.binance())
		}
	}
	return out
}

// hangUp 收下了请求但不回包：直接断开连接（客户端拿到的是网络错误，结果不明）。
func hangUp(w http.ResponseWriter) {
	if hj, ok := w.(http.Hijacker); ok {
		if c, _, err := hj.Hijack(); err == nil {
			_ = c.Close()
			return
		}
	}
	panic(http.ErrAbortHandler)
}

func (f *fakeAcctEx) binanceOrder(w http.ResponseWriter, r *http.Request, host string, q url.Values) {
	switch r.Method {
	case http.MethodPost:
		cid := q.Get("newClientOrderId")
		f.posts[cid]++
		switch f.placeMode {
		case "reject":
			writeJSONT(w, 400, map[string]any{"code": -2010, "msg": "Account has insufficient balance for requested action."})
			return
		case "drop":
			writeJSONT(w, 503, map[string]any{"code": -1001, "msg": "Internal error; unable to process your request. Please try again."})
			return
		}
		f.orderSeq++
		o := &fakeOrder{Host: host, Symbol: q.Get("symbol"), ClientID: cid, Side: q.Get("side"), Type: q.Get("type"), Qty: q.Get("quantity"), Price: q.Get("price"),
			Status: "NEW", Executed: "0", ID: 1000 + f.orderSeq, ReduceOnly: q.Get("reduceOnly") == "true"}
		if f.placeMode == "fill" {
			o.Status, o.Executed = "FILLED", o.Qty
		}
		f.orders[cid] = o
		if f.placeMode == "close" {
			hangUp(w)
			return
		}
		writeJSONT(w, 200, o.binance())
	case http.MethodGet:
		o := f.orders[q.Get("origClientOrderId")]
		if o == nil {
			writeJSONT(w, 400, map[string]any{"code": -2013, "msg": "Order does not exist."})
			return
		}
		writeJSONT(w, 200, o.binance())
	case http.MethodDelete:
		var o *fakeOrder
		if cid := q.Get("origClientOrderId"); cid != "" {
			o = f.orders[cid]
		} else {
			id, _ := strconv.ParseInt(q.Get("orderId"), 10, 64)
			for _, x := range f.orders {
				if x.ID == id {
					o = x
				}
			}
			if o == nil {
				for i, x := range f.bnSpotOrders {
					if x["orderId"] == int(id) || x["orderId"] == id {
						f.bnSpotOrders = append(f.bnSpotOrders[:i], f.bnSpotOrders[i+1:]...)
						writeJSONT(w, 200, map[string]any{"symbol": q.Get("symbol"), "orderId": id, "status": "CANCELED", "executedQty": "0"})
						return
					}
				}
			}
		}
		if o == nil || !o.open() {
			writeJSONT(w, 400, map[string]any{"code": -2011, "msg": "Unknown order sent."})
			return
		}
		if f.cancelFail[o.ClientID] {
			writeJSONT(w, 429, map[string]any{"code": -1003, "msg": "Too many requests."})
			return
		}
		o.Status = "CANCELED"
		writeJSONT(w, 200, o.binance())
	}
}

func nonNil(xs []map[string]any) []map[string]any {
	if xs == nil {
		return []map[string]any{}
	}
	return xs
}

// pageTrades 按 fromId / startTime 过滤（同 Binance 的口径）。
func pageTrades(all []map[string]any, q url.Values) []map[string]any {
	out := []map[string]any{}
	from, _ := strconv.ParseInt(q.Get("fromId"), 10, 64)
	start, _ := strconv.ParseInt(q.Get("startTime"), 10, 64)
	for _, t := range all {
		id := t["id"].(int64)
		at := t["time"].(int64)
		if q.Has("fromId") && id < from {
			continue
		}
		if q.Has("startTime") && at < start {
			continue
		}
		out = append(out, t)
	}
	return out
}

func (f *fakeAcctEx) okx(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/v5/public/instruments" {
		q := r.URL.Query()
		d := map[string]string{"instId": q.Get("instId"), "state": "live"}
		if strings.HasSuffix(q.Get("instId"), "-SWAP") {
			d["tickSz"], d["lotSz"], d["minSz"], d["ctVal"], d["maxLmtSz"], d["maxMktSz"] = "0.1", "1", "1", "0.01", "100000", "3000"
		} else {
			d["tickSz"], d["lotSz"], d["minSz"], d["maxLmtSz"], d["maxMktSz"] = "0.01", "0.0001", "0.0001", "10000", "1000"
		}
		writeJSONT(w, 200, map[string]any{"code": "0", "msg": "", "data": []map[string]string{d}})
		return
	}
	body, _ := io.ReadAll(r.Body)
	ts := r.Header.Get("OK-ACCESS-TIMESTAMP")
	m := hmac.New(sha256.New, []byte(f.okSecret))
	m.Write([]byte(ts + r.Method + r.URL.RequestURI() + string(body)))
	if r.Header.Get("OK-ACCESS-KEY") != f.okKey || r.Header.Get("OK-ACCESS-PASSPHRASE") != f.okPass ||
		base64.StdEncoding.EncodeToString(m.Sum(nil)) != r.Header.Get("OK-ACCESS-SIGN") {
		f.bad = append(f.bad, r.URL.Path)
		writeJSONT(w, http.StatusUnauthorized, map[string]any{"code": "50113", "msg": "Invalid Sign", "data": []any{}})
		return
	}
	if f.authFail {
		writeJSONT(w, http.StatusUnauthorized, map[string]any{"code": "50111", "msg": "Invalid OK-ACCESS-KEY " + f.okKey + " " + f.okPass, "data": []any{}})
		return
	}
	env := func(data any) { writeJSONT(w, 200, map[string]any{"code": "0", "msg": "", "data": data}) }
	switch r.URL.Path {
	case "/api/v5/account/config":
		env([]map[string]string{{"uid": "1", "perm": f.okPerm, "ip": "", "posMode": f.okPosMode}})
	case "/api/v5/account/leverage-info":
		env([]map[string]string{{"instId": r.URL.Query().Get("instId"), "mgnMode": "cross", "lever": f.okLever, "posSide": "net"}})
	case "/api/v5/trade/order", "/api/v5/trade/cancel-order":
		f.okxOrder(w, r, body)
	case "/api/v5/account/balance":
		env([]map[string]any{{"totalEq": "6500", "imr": "120", "details": f.okDetails}})
	case "/api/v5/account/positions":
		env(nonNilS(f.okPositions))
	case "/api/v5/trade/orders-pending":
		out := nonNilS(f.okOrders)
		for _, o := range f.orders {
			if o.Host == "www.okx.com" && o.open() {
				out = append(out, map[string]string{"instId": o.Symbol, "ordId": strconv.FormatInt(o.ID, 10), "side": o.Side, "ordType": o.Type, "px": o.Price,
					"sz": o.Qty, "accFillSz": o.Executed, "state": o.okxState(), "cTime": "1730000000000"})
			}
		}
		env(out)
	case "/api/v5/trade/fills":
		before := r.URL.Query().Get("before")
		out := []map[string]string{}
		for _, x := range f.okFills {
			if before != "" && !billLess(before, x["billId"]) {
				continue
			}
			out = append(out, x)
		}
		env(out)
	default:
		f.strange = append(f.strange, "GET www.okx.com"+r.URL.Path)
		writeJSONT(w, 404, map[string]any{"code": "1", "msg": "not found"})
	}
}

func (f *fakeAcctEx) okxOrder(w http.ResponseWriter, r *http.Request, body []byte) {
	env := func(code, msg string, data any) {
		writeJSONT(w, 200, map[string]any{"code": code, "msg": msg, "data": data})
	}
	if r.Method == http.MethodGet {
		o := f.orders[r.URL.Query().Get("clOrdId")]
		if o == nil {
			env("51603", "Order does not exist", []any{})
			return
		}
		env("0", "", []map[string]string{{"ordId": strconv.FormatInt(o.ID, 10), "clOrdId": o.ClientID, "state": o.okxState(), "accFillSz": o.Executed,
			"avgPx": orDefault(o.Price, "0"), "fee": "-0.01", "sz": o.Qty}})
		return
	}
	var p map[string]string
	if err := json.Unmarshal(body, &p); err != nil {
		f.strange = append(f.strange, "bad body "+string(body))
		env("50000", "bad body", []any{})
		return
	}
	if r.URL.Path == "/api/v5/trade/cancel-order" {
		var o *fakeOrder
		if cid := p["clOrdId"]; cid != "" {
			o = f.orders[cid]
		} else {
			for _, x := range f.orders {
				if strconv.FormatInt(x.ID, 10) == p["ordId"] {
					o = x
				}
			}
		}
		if o == nil || !o.open() {
			env("1", "", []map[string]string{{"sCode": "51400", "sMsg": "Cancellation failed as the order has been filled, canceled or does not exist"}})
			return
		}
		o.Status = "CANCELED"
		env("0", "", []map[string]string{{"ordId": strconv.FormatInt(o.ID, 10), "clOrdId": o.ClientID, "sCode": "0"}})
		return
	}
	cid := p["clOrdId"]
	f.posts[cid]++
	if r.Header.Get("expTime") == "" {
		f.strange = append(f.strange, "下单没带 expTime")
	}
	switch f.placeMode {
	case "reject":
		env("1", "", []map[string]string{{"sCode": "51008", "sMsg": "Order failed. Insufficient USDT balance in account."}})
		return
	case "drop":
		writeJSONT(w, 503, map[string]any{"code": "50001", "msg": "Service temporarily unavailable", "data": []any{}})
		return
	}
	f.orderSeq++
	o := &fakeOrder{Host: "www.okx.com", Symbol: p["instId"], ClientID: cid, Side: p["side"], Type: p["ordType"], Qty: p["sz"], Price: p["px"],
		Status: "NEW", Executed: "0", ID: 5000 + f.orderSeq, ReduceOnly: p["reduceOnly"] == "true", Params: p}
	if f.placeMode == "fill" {
		o.Status, o.Executed = "FILLED", o.Qty
	}
	f.orders[cid] = o
	if f.placeMode == "close" {
		hangUp(w)
		return
	}
	env("0", "", []map[string]string{{"ordId": strconv.FormatInt(o.ID, 10), "clOrdId": cid, "sCode": "0", "sMsg": ""}})
}

func nonNilS(xs []map[string]string) []map[string]string {
	if xs == nil {
		return []map[string]string{}
	}
	return xs
}
