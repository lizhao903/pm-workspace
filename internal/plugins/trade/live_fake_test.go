package trade

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakeAcctEx 是本机假交易所（httptest）：按 X-Original-Host 分 Binance 现货、Binance U 本位、OKX，
// 校验 API Key 和签名，只实现 exchangeReadPaths 里的只读接口；别的路径一律 404 并记下来（测试断言没有出现）。
// 测试里的凭证都是假的，不连任何真实交易所。
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
		bnPerms:    map[string]bool{"enableReading": true},
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
		f.strange = append(f.strange, r.Method+" "+host+" "+r.URL.Path)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
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
		writeJSONT(w, 200, nonNil(f.bnSpotOrders))
	case "api.binance.com/api/v3/myTrades":
		writeJSONT(w, 200, pageTrades(f.bnTrades[q.Get("symbol")], q))
	case "fapi.binance.com/fapi/v2/account":
		writeJSONT(w, 200, map[string]string{"totalMarginBalance": "500", "availableBalance": "300", "totalInitialMargin": "200"})
	case "fapi.binance.com/fapi/v2/positionRisk":
		writeJSONT(w, 200, nonNil(f.bnFutures))
	case "fapi.binance.com/fapi/v1/openOrders":
		writeJSONT(w, 200, nonNil(f.bnPerpOrders))
	case "fapi.binance.com/fapi/v1/userTrades":
		writeJSONT(w, 200, pageTrades(f.bnPerpTrades[q.Get("symbol")], q))
	default:
		f.strange = append(f.strange, "GET "+host+r.URL.Path)
		writeJSONT(w, 404, map[string]any{"code": -1, "msg": "not found"})
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
	ts := r.Header.Get("OK-ACCESS-TIMESTAMP")
	m := hmac.New(sha256.New, []byte(f.okSecret))
	m.Write([]byte(ts + r.Method + r.URL.RequestURI()))
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
		env([]map[string]string{{"uid": "1", "perm": f.okPerm, "ip": ""}})
	case "/api/v5/account/balance":
		env([]map[string]any{{"totalEq": "6500", "imr": "120", "details": f.okDetails}})
	case "/api/v5/account/positions":
		env(nonNilS(f.okPositions))
	case "/api/v5/trade/orders-pending":
		env(nonNilS(f.okOrders))
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

func nonNilS(xs []map[string]string) []map[string]string {
	if xs == nil {
		return []map[string]string{}
	}
	return xs
}
