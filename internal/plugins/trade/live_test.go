package trade

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

/* ---------- 签名：交易所文档的公开样例 ---------- */

func TestExchangeSignaturesMatchPublishedSamples(t *testing.T) {
	// Binance 文档「SIGNED Endpoint Examples」的样例（HMAC 密钥），签名值文档里给出
	q := "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559"
	if got := binanceSign("NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j", q); got != "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71" {
		t.Fatalf("Binance 签名 = %s", got)
	}
	// OKX 文档「REST 请求验证」的样例：SecretKey、时间戳、请求路径是文档里的，文档没给签名结果，
	// 期望值用 openssl 独立算的（echo -n "<prehash>" | openssl dgst -sha256 -hmac <secret> -binary | base64）
	if got := okxSign("22582BD0CFF14C41EDBF1AB98506286D", "2020-12-08T09:08:57.715Z", "GET", "/api/v5/account/balance?ccy=BTC", ""); got != "HiZhvSfMtWJA3uUIVXV3a/bSXNPCWvYFXoGCVS8V4zY=" {
		t.Fatalf("OKX 签名 = %s", got)
	}
}

/* ---------- 只读出网 ---------- */

func TestReadOnlyTransportBlocksEverythingElse(t *testing.T) {
	hit := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit++; w.WriteHeader(200) }))
	defer srv.Close()
	to, _ := url.Parse(srv.URL)
	c := readOnlyClient(&http.Client{Transport: hostRewrite{to}})
	for _, tc := range []struct {
		method, url string
		ok          bool
	}{
		{"GET", "https://api.binance.com/api/v3/account?timestamp=1", true},
		{"GET", "https://www.okx.com/api/v5/trade/fills", true},
		{"POST", "https://api.binance.com/api/v3/account", false},
		{"GET", "https://api.binance.com/api/v3/order", false},
		{"POST", "https://api.binance.com/api/v3/order", false},
		{"DELETE", "https://api.binance.com/api/v3/openOrders", false},
		{"GET", "https://api.binance.com/sapi/v1/capital/withdraw/apply", false},
		{"POST", "https://www.okx.com/api/v5/trade/order", false},
		{"GET", "https://www.okx.com/api/v5/asset/transfer", false},
		{"GET", "https://evil.example.com/api/v3/account", false},
	} {
		before := hit
		req, _ := http.NewRequest(tc.method, tc.url, strings.NewReader(""))
		resp, err := c.Do(req)
		if resp != nil {
			_ = resp.Body.Close()
		}
		if tc.ok != (err == nil) || (tc.ok && hit != before+1) || (!tc.ok && hit != before) {
			t.Errorf("%s %s：err=%v hit=%d", tc.method, tc.url, err, hit-before)
		}
		if !tc.ok && !errors.Is(err, errNotReadOnly) {
			t.Errorf("%s %s 要是 errNotReadOnly：%v", tc.method, tc.url, err)
		}
	}
}

type hostRewrite struct{ to *url.URL }

func (rw hostRewrite) RoundTrip(r *http.Request) (*http.Response, error) {
	r2 := r.Clone(r.Context())
	r2.Header.Set("X-Original-Host", r.URL.Host)
	r2.URL.Scheme, r2.URL.Host, r2.Host = rw.to.Scheme, rw.to.Host, rw.to.Host
	return http.DefaultTransport.RoundTrip(r2)
}

/* ---------- 环境 ---------- */

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// recorder 记下所有接口响应，最后查里面有没有凭证。
type recorder struct {
	h    http.Handler
	mu   sync.Mutex
	body bytes.Buffer
}

func (rc *recorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rw := httptest.NewRecorder()
	rc.h.ServeHTTP(rw, r)
	rc.mu.Lock()
	rc.body.Write(rw.Body.Bytes())
	rc.mu.Unlock()
	for k, v := range rw.Header() {
		w.Header()[k] = v
	}
	w.WriteHeader(rw.Code)
	_, _ = w.Write(rw.Body.Bytes())
}

type liveEnv struct {
	paperEnv
	conns *connector.Store
	fake  *fakeAcctEx
	logs  *syncBuf
	rec   *recorder
}

func setupLive(t *testing.T, extra ...Source) liveEnv {
	t.Helper()
	fastPaper(t)
	ctx := context.Background()
	src := &paperSrc{price: map[string]float64{"FAKE:BTCUSDT": 100, "FAKE:BTCUSDT.P": 100}, clock: newTestClock(time.Now())}
	path := filepath.Join(t.TempDir(), "pm.db")
	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	v, _, err := vault.Open(ctx, path, vault.KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatal(err)
	}
	logs := &syncBuf{}
	log := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	defs := connector.NewRegistry()
	conns := connector.New(d, v, defs)
	p := New(append([]Source{src}, extra...)...)
	p.now, p.tick, p.push = src.clock.now, 30*time.Millisecond, 50*time.Millisecond
	n, ev := &alertNotifier{}, &alertRecorder{}
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), log)
	r.Migrations = plugin.NewSQLMigrationStore(d)
	r.Events = ev
	r.SetNotifier(n)
	r.SetConnectors(conns)
	r.SetIncidents(incident.New(d, log))
	defs.SetPluginDefs(r.ConnectorDefs)
	fake := newFakeAcctEx(t)
	srv := httptest.NewServer(fake)
	to, _ := url.Parse(srv.URL)
	r.SetHTTPTransport(hostRewrite{to})
	if err := r.Add(p); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.Install(ctx, "trade", tradePerms); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "trade"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	rec := &recorder{h: mux}
	e := liveEnv{paperEnv: paperEnv{h: rec, reg: r, d: d, src: src, clock: src.clock, n: n, ev: ev, p: p}, conns: conns, fake: fake, logs: logs, rec: rec}
	data(t, rec, "POST", "/api/trade/sources/fake/sync", "")
	t.Cleanup(func() { r.Close(); srv.Close(); _ = v.Close(); _ = d.Close() })
	return e
}

func (e liveEnv) addConn(t *testing.T, tool string, secrets map[string]string) string {
	t.Helper()
	c, err := e.conns.Create(context.Background(), connector.Input{Tool: tool, Secrets: secrets})
	if err != nil {
		t.Fatal(err)
	}
	return c.ID
}

func bnSecrets() map[string]string {
	return map[string]string{"api_key": testBNKey, "api_secret": testBNSecret}
}

func okSecrets() map[string]string {
	return map[string]string{"api_key": testOKKey, "api_secret": testOKSecret, "passphrase": testOKPass}
}

// noSecrets：日志、接口响应、库里每一张表（含审计、运行异常、通知、连接器表）都不出现凭证明文和完整的 API Key。
func (e liveEnv) noSecrets(t *testing.T) {
	t.Helper()
	var sb strings.Builder
	sb.WriteString(e.logs.String())
	e.rec.mu.Lock()
	sb.Write(e.rec.body.Bytes())
	e.rec.mu.Unlock()
	for _, n := range e.n.list() {
		sb.WriteString(n.Title + n.Body)
	}
	rows, err := e.d.R.Query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var n string
		_ = rows.Scan(&n)
		tables = append(tables, n)
	}
	_ = rows.Close()
	for _, tb := range tables {
		rs, err := e.d.R.Query(`SELECT * FROM "` + tb + `"`)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rs.Columns()
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		for rs.Next() {
			_ = rs.Scan(ptrs...)
			for _, v := range vals {
				switch x := v.(type) {
				case string:
					sb.WriteString(x)
				case []byte:
					sb.Write(x)
				}
				sb.WriteString("\n")
			}
		}
		_ = rs.Close()
	}
	all := sb.String()
	for _, s := range []string{testBNKey, testBNSecret, testOKKey, testOKSecret, testOKPass} {
		if strings.Contains(all, s) {
			i := strings.Index(all, s)
			t.Fatalf("凭证 %q 出现在日志、响应或库里：…%s…", s, all[max(0, i-200):min(len(all), i+len(s)+50)])
		}
	}
	if len(all) < 1000 {
		t.Fatal("没收集到东西，检查测试本身")
	}
}

// onlyReadCalls：假交易所收到的都是 GET、都是只读清单里的路径，签名都对。
func (e liveEnv) onlyReadCalls(t *testing.T) {
	t.Helper()
	calls, bad, strange := e.fake.snapshot()
	if len(strange) > 0 || len(bad) > 0 {
		t.Fatalf("不该有的请求：%v；签名不对：%v", strange, bad)
	}
	if len(calls) == 0 {
		t.Fatal("假交易所没收到请求")
	}
	for _, c := range calls {
		parts := strings.SplitN(c, " ", 3)
		if parts[0] != "GET" || !slices.Contains(exchangeReadPaths[parts[1]], parts[2]) {
			t.Fatalf("不是只读请求：%s", c)
		}
	}
}

func (e liveEnv) risk(t *testing.T) map[string]any {
	t.Helper()
	return data(t, e.h, "GET", "/api/trade/risk", "")
}

func (e liveEnv) halts(t *testing.T) []any {
	t.Helper()
	return list(t, e.h, "/api/trade/risk/halts")
}

func (e liveEnv) sync(t *testing.T, aid string) map[string]any {
	t.Helper()
	return data(t, e.h, "POST", "/api/trade/accounts/"+aid+"/sync", "")
}

func (e liveEnv) auditActions(t *testing.T, q string) []string {
	t.Helper()
	out := []string{}
	for _, x := range list(t, e.h, "/api/trade/audit?"+q) {
		out = append(out, x.(map[string]any)["action"].(string))
	}
	return out
}

func strs(v any) []string {
	out := []string{}
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

/* ---------- TRD-07a：接入、只读同步、提币权限、403、凭证不外露 ---------- */

func TestLiveBinanceAccount(t *testing.T) {
	e := setupLive(t)
	ctx := context.Background()
	h := e.h
	f := e.fake

	// 带提币权限的 Key：连通测试失败，建账户 409，什么都不建
	f.set(func(f *fakeAcctEx) { f.bnPerms = map[string]bool{"enableReading": true, "enableWithdrawals": true} })
	cid := e.addConn(t, BinanceAccountTool, bnSecrets())
	res, err := e.conns.Test(ctx, cid)
	if err != nil || res.OK || !strings.Contains(res.Message, "提币权限") || !strings.Contains(res.Message, "到交易所关掉") {
		t.Fatalf("带提币权限的连通测试要失败并说明：%+v %v", res, err)
	}
	code, out := call(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`"}`)
	if code != 409 || out["error"].(map[string]any)["reason"] != "key_withdraw" || !strings.Contains(out["error"].(map[string]any)["message"].(string), "提币权限") {
		t.Fatalf("带提币权限建账户 = %d %v", code, out)
	}
	// 带万向划转也拒绝
	f.set(func(f *fakeAcctEx) {
		f.bnPerms = map[string]bool{"enableReading": true, "permitsUniversalTransfer": true}
	})
	if code, out := call(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`"}`); code != 409 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "万向划转") {
		t.Fatalf("带划转权限建账户 = %d %v", code, out)
	}
	if n := len(list(t, h, "/api/trade/accounts")); n != 0 {
		t.Fatalf("被拒的不该建账户：%d", n)
	}

	// 只读 + 现货、合约交易权限：能接入，交易权限也只按只读用
	f.set(func(f *fakeAcctEx) {
		f.bnPerms = map[string]bool{"enableReading": true, "enableSpotAndMarginTrading": true, "enableFutures": true}
		f.bnFutures = []map[string]any{{"symbol": "ETHUSDT", "positionAmt": "-2.5", "entryPrice": "3000", "markPrice": "2950", "unRealizedProfit": "125",
			"liquidationPrice": "4000", "leverage": "5", "positionSide": "BOTH", "isolatedMargin": "0", "notional": "-7375"}}
		f.bnSpotOrders = []map[string]any{{"symbol": "BTCUSDT", "orderId": 11, "price": "60000", "origQty": "0.1", "executedQty": "0", "status": "NEW",
			"type": "LIMIT", "side": "SELL", "stopPrice": "0", "time": 1730000000000}}
	})
	res, _ = e.conns.Test(ctx, cid)
	if !res.OK || res.Connector.Account != "Binance ****WXYZ · 读取 + 交易" {
		t.Fatalf("连通测试：%+v", res)
	}
	if hints := res.Connector.SecretHints; strings.Contains(hints["api_secret"], "never-real") || hints["api_key"] == testBNKey {
		t.Fatalf("连接器只给提示：%v", hints)
	}
	a := data(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`","name":"Binance 主账户"}`)
	aid := a["id"].(string)
	if a["paper"] != false || a["broker"] != "Binance" || a["status"] != "connected" || a["api_hint"] != "****WXYZ" || a["currency"] != "USDT" ||
		!slices.Equal(strs(a["permissions"]), []string{"read"}) || !slices.Equal(strs(a["key_permissions"]), []string{"read", "trade"}) || a["connector_id"] != cid {
		t.Fatalf("新建实盘账户 = %v", a)
	}
	// 同一个连接器不能接两次
	if code, out := call(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`"}`); code != 409 || out["error"].(map[string]any)["reason"] != "in_use" {
		t.Fatalf("重复接 = %d %v", code, out)
	}
	// paper 恒为假：建的时候带 paper true 400，PATCH 改 paper 400
	if code, _ := call(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`","paper":true}`); code != 400 {
		t.Fatalf("实盘带 paper true 应当 400：%d", code)
	}
	if code, _ := call(t, h, "PATCH", "/api/trade/accounts/"+aid, `{"paper":true}`); code != 400 {
		t.Fatalf("PATCH paper 应当 400：%d", code)
	}
	// 用户要交易权限：只记下来，接口照样 403
	if p := data(t, h, "PATCH", "/api/trade/accounts/"+aid, `{"trade":true}`); !slices.Equal(strs(p["permissions"]), []string{"read", "trade"}) || p["paper"] != false {
		t.Fatalf("PATCH trade = %v", p)
	}

	// 只读同步的余额、持仓、挂单和假交易所一致
	if a["equity"] != 1500.5 || a["available"] != 1300.5 || a["margin_used"] != 200.0 || a["marks_status"] != "stale" {
		t.Fatalf("估值 = %v", a)
	}
	s := data(t, h, "GET", "/api/trade/accounts/"+aid+"/snapshot", "")
	bal := map[string]float64{}
	for _, x := range s["balances"].([]any) {
		b := x.(map[string]any)
		bal[b["asset"].(string)+"@"+b["wallet"].(string)] = b["total"].(float64)
	}
	if len(bal) != 3 || bal["USDT@spot"] != 1000.5 || bal["BTC@spot"] != 0.6 || bal["USDT@futures"] != 500 {
		t.Fatalf("余额 = %v", s["balances"])
	}
	ps := s["positions"].([]any)
	if len(ps) != 2 {
		t.Fatalf("持仓 = %v", ps)
	}
	byKey := map[string]map[string]any{}
	for _, x := range ps {
		byKey[x.(map[string]any)["key"].(string)] = x.(map[string]any)
	}
	if p := byKey["spot:BTC"]; p["symbol"] != "BINANCE:BTCUSDT" || p["side"] != "long" || p["qty"] != 0.6 || p["kind"] != "spot" || p["account_id"] != aid {
		t.Fatalf("现货持有 = %v", p)
	}
	if p := byKey["BINANCE:ETHUSDT.P"]; p["side"] != "short" || p["qty"] != 2.5 || p["avg_price"] != 3000.0 || p["leverage"] != 5.0 || p["liq_price"] != 4000.0 || p["pnl"] != 125.0 {
		t.Fatalf("合约持仓 = %v", p)
	}
	if os := s["orders"].([]any); len(os) != 1 || os[0].(map[string]any)["id"] != "11" || os[0].(map[string]any)["side"] != "sell" || os[0].(map[string]any)["qty"] != 0.1 {
		t.Fatalf("挂单 = %v", os)
	}
	// 第一次同步建立了本地记录，对账一致：2 个持仓 + 1 笔挂单
	rc := data(t, h, "GET", "/api/trade/accounts/"+aid+"/recon", "")
	if rc["status"] != "ok" || rc["checked"] != 3.0 || len(rc["items"].([]any)) != 0 {
		t.Fatalf("对账 = %v", rc)
	}

	// 实盘账户：接口代为下单 403 not_user；用户本人下单但闸门没开 403 live_gate（实盘下单见 livetrade_test.go）
	for _, c := range []struct {
		h      http.Handler
		reason string
	}{{h, "not_user"}, {as(h, asUser), "live_gate"}} {
		code, out := call(t, c.h, "POST", "/api/trade/orders", `{"account_id":"`+aid+`","symbol":"BINANCE:BTCUSDT","side":"buy","type":"market","qty":0.1,"confirmed":true}`)
		if code != 403 || out["error"].(map[string]any)["code"] != "forbidden" || out["error"].(map[string]any)["reason"] != c.reason {
			t.Fatalf("实盘账户下单 = %d %v，应当 403 %s", code, out, c.reason)
		}
	}
	var n int
	_ = e.d.R.QueryRow(`SELECT COUNT(*) FROM trade_orders`).Scan(&n)
	if n != 0 {
		t.Fatalf("实盘账户不该留委托：%d", n)
	}

	// 交易所报错时（错误信息里故意带了 Key 和 Secret）：账户异常，原因里抹掉凭证
	f.set(func(f *fakeAcctEx) { f.authFail = true })
	a = e.sync(t, aid)
	if a["status"] != "error" || !strings.Contains(a["error"].(string), "API Key 无效") || strings.Contains(a["error"].(string), "never-real") {
		t.Fatalf("鉴权失败后 = %v", a)
	}
	f.set(func(f *fakeAcctEx) { f.authFail = false })
	if a = e.sync(t, aid); a["status"] != "connected" || a["error"] != nil {
		t.Fatalf("恢复后 = %v", a)
	}
	// 断开、重新连接
	if a = data(t, h, "POST", "/api/trade/accounts/"+aid+"/disconnect", ""); a["status"] != "disconnected" {
		t.Fatalf("断开 = %v", a)
	}
	if code, _ := call(t, h, "POST", "/api/trade/accounts/"+aid+"/sync", ""); code != 409 {
		t.Fatalf("断开后手动同步应当 409：%d", code)
	}
	if a = data(t, h, "POST", "/api/trade/accounts/"+aid+"/connect", ""); a["status"] != "connected" {
		t.Fatalf("重新连接 = %v", a)
	}
	// 模拟盘没有同步、对账
	paid := e.account(t, `{"initial":1000}`)
	if code, _ := call(t, h, "POST", "/api/trade/accounts/"+paid+"/sync", ""); code != 400 {
		t.Fatalf("模拟盘同步应当 400：%d", code)
	}
	// 审计：接入、建立本地记录、同步失败、恢复、断开、连接都有，来源对
	acts := e.auditActions(t, "account_id="+aid)
	for _, want := range []string{"create", "baseline", "update", "sync_failed", "sync_recovered", "disconnect", "connect"} {
		if !slices.Contains(acts, want) {
			t.Fatalf("账户审计少了 %s：%v", want, acts)
		}
	}
	if len(e.auditActions(t, "action=key_rejected")) != 2 {
		t.Fatalf("拒绝接入要记审计：%v", e.auditActions(t, "action=key_rejected"))
	}
	// 删账户：只删插件里的关联，连接器（凭证）留着
	data(t, h, "DELETE", "/api/trade/accounts/"+aid, "")
	if _, err := e.conns.Get(ctx, cid); err != nil {
		t.Fatalf("连接器应当保留：%v", err)
	}
	e.onlyReadCalls(t)
	e.noSecrets(t)
}

func TestLiveOKXAccount(t *testing.T) {
	e := setupLive(t)
	ctx := context.Background()
	h := e.h
	f := e.fake
	f.set(func(f *fakeAcctEx) { f.okPerm = "read_only,withdraw" })
	cid := e.addConn(t, OKXAccountTool, okSecrets())
	if res, _ := e.conns.Test(ctx, cid); res.OK || !strings.Contains(res.Message, "提币权限") {
		t.Fatalf("带提币权限要失败：%+v", res)
	}
	if code, _ := call(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`"}`); code != 409 {
		t.Fatalf("带提币权限建账户应当 409：%d", code)
	}
	now := e.clock.now().UnixMilli()
	f.set(func(f *fakeAcctEx) {
		f.okPerm = "read_only,trade"
		f.okPositions = []map[string]string{{"instId": "BTC-USDT-SWAP", "pos": "3", "posSide": "net", "avgPx": "65000", "lever": "10", "liqPx": "59000", "upl": "12.5", "imr": "195", "markPx": "65100"}}
		f.okOrders = []map[string]string{{"instId": "ETH-USDT", "ordId": "o9", "side": "sell", "ordType": "limit", "px": "3500", "sz": "0.5", "accFillSz": "0", "state": "live", "cTime": "1730000000000"}}
		f.okFills = []map[string]string{{"instType": "SWAP", "instId": "BTC-USDT-SWAP", "ordId": "o1", "billId": "1001", "side": "buy", "posSide": "net",
			"fillSz": "1", "fillPx": "65000", "fee": "-0.5", "feeCcy": "USDT", "ts": itoa64(now - 10_000)}}
	})
	a := data(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`","name":"OKX 合约"}`)
	aid := a["id"].(string)
	if a["broker"] != "OKX" || a["paper"] != false || a["equity"] != 6500.0 || a["available"] != 1500.0 || a["margin_used"] != 120.0 || a["api_hint"] != "****7Q2c" {
		t.Fatalf("OKX 账户 = %v", a)
	}
	s := data(t, h, "GET", "/api/trade/accounts/"+aid+"/snapshot", "")
	if ps := s["positions"].([]any); len(ps) != 2 {
		t.Fatalf("持仓 = %v", ps)
	}
	if fs := list(t, h, "/api/trade/accounts/"+aid+"/fills"); len(fs) != 1 || fs[0].(map[string]any)["id"] != "okx:1001" || fs[0].(map[string]any)["fee"] != 0.5 {
		t.Fatalf("成交 = %v", fs)
	}
	// 新成交（再买 2 张）和持仓（5 张）一致：对账没有差异；挂单成交一半还挂着
	f.set(func(f *fakeAcctEx) {
		f.okPositions[0]["pos"] = "5"
		f.okFills = append(f.okFills, map[string]string{"instType": "SWAP", "instId": "BTC-USDT-SWAP", "ordId": "o2", "billId": "1002", "side": "buy", "posSide": "net",
			"fillSz": "2", "fillPx": "65100", "fee": "-1", "feeCcy": "USDT", "ts": itoa64(now)})
	})
	e.sync(t, aid)
	rc := data(t, h, "GET", "/api/trade/accounts/"+aid+"/recon", "")
	if rc["status"] != "ok" || rc["checked"] != 3.0 {
		t.Fatalf("对账 = %v", rc)
	}
	if fs := list(t, h, "/api/trade/accounts/"+aid+"/fills"); len(fs) != 2 {
		t.Fatalf("成交 = %v", fs)
	}
	e.onlyReadCalls(t)
	e.noSecrets(t)
}

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

// 同步时发现 Key 新开了提币权限：账户立刻停用、写审计，数据源断开熔断。
func TestLiveWithdrawDuringSync(t *testing.T) {
	e := setupLive(t)
	h := e.h
	f := e.fake
	cid := e.addConn(t, BinanceAccountTool, bnSecrets())
	aid := data(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`"}`)["id"].(string)
	f.set(func(f *fakeAcctEx) { f.bnPerms["enableWithdrawals"] = true })
	a := e.sync(t, aid)
	if a["status"] != "error" || !strings.Contains(a["error"].(string), "提币权限，已停止使用") || !strings.Contains(a["error"].(string), "重新连接") {
		t.Fatalf("发现提币权限后 = %v", a)
	}
	if !slices.Contains(e.auditActions(t, "account_id="+aid), "key_rejected") {
		t.Fatal("要记审计 key_rejected")
	}
	r := e.risk(t)
	if r["halted"] != true || !strings.Contains(r["halted_reason"].(string), "数据源断开") {
		t.Fatalf("要熔断：%v", r)
	}
	// 发现提币权限之后不再拉余额（只查了权限）
	calls, _, _ := e.fake.snapshot()
	if last := calls[len(calls)-1]; !strings.HasSuffix(last, "/sapi/v1/account/apiRestrictions") {
		t.Fatalf("最后一个请求应当是查权限：%v", calls)
	}
	e.noSecrets(t)
}

/* ---------- TRD-08b：对账差异、断线、恢复 ---------- */

func TestReconDiffNotifyAndBreaker(t *testing.T) {
	e := setupLive(t)
	h := e.h
	f := e.fake
	f.set(func(f *fakeAcctEx) {
		f.bnPerms["enableFutures"] = true
		f.bnFutures = []map[string]any{{"symbol": "ETHUSDT", "positionAmt": "-2.5", "entryPrice": "3000", "markPrice": "2950", "unRealizedProfit": "125",
			"liquidationPrice": "4000", "leverage": "5", "positionSide": "BOTH", "isolatedMargin": "0", "notional": "-7375"}}
		f.bnSpotOrders = []map[string]any{{"symbol": "BTCUSDT", "orderId": 11, "price": "60000", "origQty": "0.1", "executedQty": "0", "status": "NEW",
			"type": "LIMIT", "side": "SELL", "stopPrice": "0", "time": 1730000000000}}
	})
	cid := e.addConn(t, BinanceAccountTool, bnSecrets())
	aid := data(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`","name":"Binance 主账户"}`)["id"].(string)
	// 模拟盘上开一个部署、挂一笔单，熔断时要被全停
	paid := e.account(t, `{"initial":100000}`)
	sid := data(t, h, "POST", "/api/trade/strategies", crossStrategy)["id"].(string)
	rid := data(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"`+paid+`","capital":20000}`)["id"].(string)

	// 挂单成交（卖 0.1 BTC，手续费按 BTC 扣）：拉到成交，本地记录跟着变，对账一致
	now := e.clock.now().UnixMilli()
	f.set(func(f *fakeAcctEx) {
		f.bnBalances["BTC"] = [2]string{"0.4999", "0"}
		f.bnSpotOrders = nil
		f.bnTrades["BTCUSDT"] = []map[string]any{{"id": int64(101), "orderId": int64(11), "price": "60000", "qty": "0.1", "commission": "0.0001",
			"commissionAsset": "BTC", "time": now, "isBuyer": false}}
	})
	e.sync(t, aid)
	rc := data(t, h, "GET", "/api/trade/accounts/"+aid+"/recon", "")
	if rc["status"] != "ok" || rc["checked"] != 2.0 {
		t.Fatalf("成交后对账 = %v", rc)
	}

	// 交易所的合约持仓变了、没有对应成交：第一次只记差异，不通知、不熔断
	f.set(func(f *fakeAcctEx) { f.bnFutures[0]["positionAmt"] = "-3" })
	e.sync(t, aid)
	rc = data(t, h, "GET", "/api/trade/accounts/"+aid+"/recon", "")
	items := rc["items"].([]any)
	if rc["status"] != "diff" || len(items) != 1 {
		t.Fatalf("有差异 = %v", rc)
	}
	it := items[0].(map[string]any)
	if it["kind"] != "position" || it["local"] != "空 2.5" || it["remote"] != "空 3" || it["remote_qty"] != -3.0 || it["confirmed"] != false || it["pct"] != 16.67 {
		t.Fatalf("差异 = %v", it)
	}
	if e.risk(t)["halted"] == true || len(e.notifs("trade.recon", "recon")) != 0 {
		t.Fatal("第一次看到差异不该熔断、通知")
	}
	// 第二次还在：发通知、记运行异常、超过 5% 自动熔断（一键全停：部署停掉）
	e.sync(t, aid)
	r := e.risk(t)
	if r["halted"] != true || !strings.Contains(r["halted_reason"].(string), "对账差异超过阈值") || !strings.Contains(r["halted_reason"].(string), "差 16.67%，阈值 5%") {
		t.Fatalf("要熔断：%v", r)
	}
	if hs := e.halts(t); len(hs) != 1 || hs[0].(map[string]any)["kind"] != "auto" || hs[0].(map[string]any)["runs_stopped"] != 1.0 {
		t.Fatalf("熔断记录 = %v", hs)
	}
	if run := data(t, h, "GET", "/api/trade/runs/"+rid, ""); run["status"] != "stopped" {
		t.Fatalf("部署要被停：%v", run["status"])
	}
	if ns := e.notifs("recon"); len(ns) != 1 || !strings.Contains(ns[0].Body, "ETHUSDT 永续 持仓本地 空 2.5，交易所 空 3") && !strings.Contains(ns[0].Body, "持仓本地 空 2.5，交易所 空 3") {
		t.Fatalf("对账通知 = %+v", ns)
	}
	var inc int
	_ = e.d.R.QueryRow(`SELECT COUNT(*) FROM incidents WHERE title = '交易对账异常'`).Scan(&inc)
	if inc != 1 {
		t.Fatalf("运行异常 = %d", inc)
	}
	if acts := e.auditActions(t, "action=breaker"); len(acts) != 1 {
		t.Fatalf("熔断要写审计：%v", acts)
	}
	// 第三次还在：不重复熔断、不重复通知
	e.sync(t, aid)
	if len(e.halts(t)) != 1 || len(e.notifs("recon")) != 1 {
		t.Fatal("同一处差异只熔断、通知一次")
	}
	// 按交易所修正：本地记录改成 -3，这处关掉，对账回到一致；熔断不自动解除
	itemID := it["id"].(string)
	rc = data(t, h, "POST", "/api/trade/accounts/"+aid+"/recon/items/"+itemID+"/resolve", `{"action":"adopt"}`)
	if rc["status"] != "ok" || rc["items"].([]any)[0].(map[string]any)["resolution"] != "按交易所修正了本地记录" {
		t.Fatalf("修正后 = %v", rc)
	}
	if code, _ := call(t, h, "POST", "/api/trade/accounts/"+aid+"/recon/items/"+itemID+"/resolve", `{"action":"adopt"}`); code != 409 {
		t.Fatal("处理过的再处理应当 409")
	}
	rc = data(t, h, "POST", "/api/trade/accounts/"+aid+"/recon", "")
	if rc["status"] != "ok" || rc["open"] != 0.0 || e.risk(t)["halted"] != true {
		t.Fatalf("重新对账 = %v", rc)
	}
	data(t, h, "POST", "/api/trade/risk/release", `{"reason":"差异核实过了"}`)

	// 小差异（不到阈值）：只通知，不熔断；标为已核实要写备注，之后同样的差异不再报
	f.set(func(f *fakeAcctEx) { f.bnBalances["BTC"] = [2]string{"0.4998", "0"} })
	e.sync(t, aid)
	e.sync(t, aid)
	if e.risk(t)["halted"] == true || len(e.notifs("recon")) != 2 {
		t.Fatalf("小差异只通知：halted=%v 通知 %d", e.risk(t)["halted"], len(e.notifs("recon")))
	}
	rc = data(t, h, "GET", "/api/trade/accounts/"+aid+"/recon", "")
	var small string
	for _, x := range rc["items"].([]any) {
		if x.(map[string]any)["resolved_at"] == nil {
			small = x.(map[string]any)["id"].(string)
		}
	}
	if code, _ := call(t, h, "POST", "/api/trade/accounts/"+aid+"/recon/items/"+small+"/resolve", `{"action":"verify"}`); code != 400 {
		t.Fatal("标为已核实不写备注应当 400")
	}
	data(t, h, "POST", "/api/trade/accounts/"+aid+"/recon/items/"+small+"/resolve", `{"action":"verify","note":"BNB 抵扣失败多扣的，已和客服确认"}`)
	if rc = data(t, h, "POST", "/api/trade/accounts/"+aid+"/recon", ""); rc["status"] != "ok" || rc["open"] != 0.0 {
		t.Fatalf("核实过的不再报：%v", rc)
	}
	// 对账记录、审计都能查到
	if rs := list(t, h, "/api/trade/recons?account_id="+aid+"&status=diff"); len(rs) < 3 {
		t.Fatalf("对账记录 = %v", rs)
	}
	acts := e.auditActions(t, "account_id="+aid)
	for _, want := range []string{"recon_diff", "recon_resolve"} {
		if !slices.Contains(acts, want) {
			t.Fatalf("审计少了 %s：%v", want, acts)
		}
	}
	e.onlyReadCalls(t)
	e.noSecrets(t)
}

func (e liveEnv) notifs(kinds ...string) []plugin.Notification {
	out := []plugin.Notification{}
	for _, n := range e.n.list() {
		if slices.Contains(kinds, strings.TrimPrefix(n.Kind, "trade.")) {
			out = append(out, n)
		}
	}
	return out
}

// 交易所接口连续失败到上限熔断；断线恢复后账户回到已连接，熔断不自动解除；Key 失效（数据源断开）立刻熔断。
func TestReconDisconnectAndRecover(t *testing.T) {
	e := setupLive(t)
	h := e.h
	f := e.fake
	cid := e.addConn(t, BinanceAccountTool, bnSecrets())
	aid := data(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`"}`)["id"].(string)
	f.set(func(f *fakeAcctEx) { f.fail = -1 })
	for i := 1; i <= 2; i++ {
		a := e.sync(t, aid)
		if a["status"] != "error" || e.risk(t)["halted"] == true {
			t.Fatalf("第 %d 次失败：%v halted=%v", i, a, e.risk(t)["halted"])
		}
	}
	rc := data(t, h, "GET", "/api/trade/accounts/"+aid+"/recon", "")
	if rc["status"] != "failed" || !strings.Contains(rc["error"].(string), "500") {
		t.Fatalf("对账失败 = %v", rc)
	}
	e.sync(t, aid)
	r := e.risk(t)
	if r["halted"] != true || !strings.Contains(r["halted_reason"].(string), "交易所接口连续失败 3 次") {
		t.Fatalf("连续失败 3 次要熔断：%v", r)
	}
	e.sync(t, aid) // 第 4 次：这一轮故障已经熔断过，不再全停
	if len(e.halts(t)) != 1 {
		t.Fatalf("一轮故障只熔断一次：%v", e.halts(t))
	}
	// 恢复：账户回到已连接，熔断不解除
	f.set(func(f *fakeAcctEx) { f.fail = 0 })
	a := e.sync(t, aid)
	if a["status"] != "connected" || e.risk(t)["halted"] != true {
		t.Fatalf("恢复后账户 = %v，熔断 = %v", a["status"], e.risk(t)["halted"])
	}
	if !slices.Contains(e.auditActions(t, "account_id="+aid), "sync_recovered") {
		t.Fatal("恢复要记审计")
	}
	if ns := e.notifs("account"); len(ns) == 0 || !strings.Contains(ns[len(ns)-1].Body, "熔断不会自动解除") {
		t.Fatalf("恢复通知 = %+v", ns)
	}
	// 解除后 Key 失效（数据源断开）：立刻熔断
	data(t, h, "POST", "/api/trade/risk/release", `{"reason":"交易所恢复了"}`)
	f.set(func(f *fakeAcctEx) { f.authFail = true })
	e.sync(t, aid)
	r = e.risk(t)
	if r["halted"] != true || !strings.Contains(r["halted_reason"].(string), "数据源断开") || strings.Contains(r["halted_reason"].(string), "never-real") {
		t.Fatalf("Key 失效要立刻熔断：%v", r)
	}
	if acts := e.auditActions(t, "action=breaker&origin=risk"); len(acts) != 2 {
		t.Fatalf("两次熔断都要审计：%v", acts)
	}
	e.onlyReadCalls(t)
	e.noSecrets(t)
}

// 行情数据源断开超过阈值、还有挂单时熔断；恢复后不自动解除。
func TestFeedDownBreaker(t *testing.T) {
	e := setupLive(t)
	h := e.h
	ctx := context.Background()
	paid := e.account(t, `{"initial":100000}`)
	o := e.order(t, `{"account_id":"`+paid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"limit","price":50,"qty":1}`)
	if o["status"] != "open" {
		t.Fatalf("挂单 = %v", o)
	}
	e.src.setFail(true)
	waitFor(t, "行情源变异常", func() bool { _, down := e.p.mkt.downSince("fake"); return down })
	e.p.live.checkFeeds(ctx)
	if e.risk(t)["halted"] == true {
		t.Fatal("没到 5 分钟不该熔断")
	}
	e.clock.advance(6 * time.Minute)
	e.p.live.checkFeeds(ctx)
	r := e.risk(t)
	if r["halted"] != true || !strings.Contains(r["halted_reason"].(string), "行情数据源 测试行情源 断开超过 5 分钟") {
		t.Fatalf("要熔断：%v", r)
	}
	if o := data(t, h, "GET", "/api/trade/orders/"+o["id"].(string), ""); o["status"] != "canceled" {
		t.Fatalf("挂单要被撤：%v", o["status"])
	}
	e.p.live.checkFeeds(ctx)
	if len(e.halts(t)) != 1 {
		t.Fatal("同一轮断开只熔断一次")
	}
	e.src.setFail(false)
	// 全停撤了挂单、没有订阅了：查一次行情让它再取
	waitFor(t, "行情源恢复", func() bool {
		call(t, h, "GET", "/api/trade/quotes?symbols=FAKE:BTCUSDT", "")
		_, down := e.p.mkt.downSince("fake")
		return !down
	})
	e.p.live.checkFeeds(ctx)
	if e.risk(t)["halted"] != true {
		t.Fatal("恢复后不自动解除熔断")
	}
}

/* ---------- TRD-08a：审计、停用前强制全停 ---------- */

func TestTradeAuditTrail(t *testing.T) {
	e := setupLive(t)
	h := e.h
	start := e.clock.now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
	paid := e.account(t, `{"initial":100000}`)
	o := e.order(t, `{"account_id":"`+paid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"market","qty":1}`)
	oid := o["id"].(string)
	e.waitOrder(t, oid, "filled")
	// 一笔委托从下单到成交，每一步都能按委托查到，来源是手动
	got := list(t, h, "/api/trade/audit?order_id="+oid)
	if len(got) != 2 {
		t.Fatalf("委托审计 = %v", got)
	}
	for i, want := range []string{"fill", "place"} {
		x := got[i].(map[string]any)
		if x["action"] != want || x["origin"] != "manual" || x["account_id"] != paid || x["target_type"] != "trade_order" || x["detail"].(map[string]any)["origin"] != "manual" {
			t.Fatalf("第 %d 条 = %v", i, x)
		}
	}
	// 内核审计里同样有，detail 带来源
	var n int
	_ = e.d.R.QueryRow(`SELECT COUNT(*) FROM audits WHERE target_id = ? AND json_extract(detail, '$.origin') = 'manual'`, oid).Scan(&n)
	if n != 2 {
		t.Fatalf("内核审计 = %d", n)
	}
	// 撤单、改价
	lo := e.order(t, `{"account_id":"`+paid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"limit","price":50,"qty":1}`)
	data(t, h, "PATCH", "/api/trade/orders/"+lo["id"].(string), `{"price":51}`)
	data(t, h, "POST", "/api/trade/orders/"+lo["id"].(string)+"/cancel", "")
	if acts := e.auditActions(t, "order_id="+lo["id"].(string)); !slices.Equal(acts, []string{"cancel", "modify", "place"}) {
		t.Fatalf("撤单改价审计 = %v", acts)
	}
	// 部署：部署和启停按部署查，来源是部署 id 的有部署下的单
	sid := data(t, h, "POST", "/api/trade/strategies", crossStrategy)["id"].(string)
	rid := data(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"`+paid+`","capital":20000}`)["id"].(string)
	data(t, h, "POST", "/api/trade/runs/"+rid+"/pause", "")
	data(t, h, "POST", "/api/trade/runs/"+rid+"/stop", "")
	runAudit := list(t, h, "/api/trade/audit?run_id="+rid)
	acts := []string{}
	for _, x := range runAudit {
		acts = append(acts, x.(map[string]any)["action"].(string))
		if x.(map[string]any)["account_id"] != paid {
			t.Fatalf("部署审计要带账户：%v", x)
		}
	}
	if !slices.Equal(acts, []string{"stop", "pause", "deploy"}) {
		t.Fatalf("部署审计 = %v", acts)
	}
	// 风控变更
	data(t, h, "PATCH", "/api/trade/risk", `{"max_order_value":60000,"recon_diff_pct":2}`)
	if r := e.risk(t); r["recon_diff_pct"] != 2.0 || r["sync_fail_limit"] != 3.0 || r["feed_down_minutes"] != 5.0 {
		t.Fatalf("熔断阈值 = %v", r)
	}
	for _, body := range []string{`{"sync_fail_limit":1.5}`, `{"recon_diff_pct":101}`, `{"feed_down_minutes":0}`} {
		if code, _ := call(t, h, "PATCH", "/api/trade/risk", body); code != 400 {
			t.Fatalf("%s 应当 400", body)
		}
	}
	if acts := e.auditActions(t, "target_type=trade_risk"); !slices.Contains(acts, "update") {
		t.Fatalf("风控审计 = %v", acts)
	}
	// 按账户、时间筛
	if all := list(t, h, "/api/trade/audit?account_id="+paid+"&since="+url.QueryEscape(start)); len(all) < 8 {
		t.Fatalf("按账户 = %d", len(all))
	}
	future := e.clock.now().Add(time.Hour).UTC().Format(time.RFC3339)
	if got := list(t, h, "/api/trade/audit?since="+url.QueryEscape(future)); len(got) != 0 {
		t.Fatalf("未来没有审计：%v", got)
	}
	if got := list(t, h, "/api/trade/audit?until="+url.QueryEscape(start)); len(got) != 0 {
		t.Fatalf("开始前没有审计：%v", got)
	}
	if code, _ := call(t, h, "GET", "/api/trade/audit?since=yesterday", ""); code != 400 {
		t.Fatal("since 不对应当 400")
	}
}

func TestDisableGuardNeedsKillFirst(t *testing.T) {
	e := setupLive(t)
	h := e.h
	ctx := context.Background()
	paid := e.account(t, `{"initial":100000}`)
	sid := data(t, h, "POST", "/api/trade/strategies", crossStrategy)["id"].(string)
	data(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"`+paid+`","capital":20000}`)
	e.order(t, `{"account_id":"`+paid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"limit","price":50,"qty":1}`)
	err := e.reg.Disable(ctx, "trade")
	var ge *plugin.GuardError
	if !errors.As(err, &ge) || ge.Reason != "还有 1 个部署在跑、1 笔挂单，先到交易里一键全停" {
		t.Fatalf("停用要被拦：%v", err)
	}
	// 只有部署（暂停的也算）
	data(t, h, "POST", "/api/trade/orders/cancel-all", "")
	if err := e.reg.Disable(ctx, "trade"); !errors.As(err, &ge) || ge.Reason != "还有 1 个部署在跑，先到交易里一键全停" {
		t.Fatalf("只剩部署 = %v", err)
	}
	// 一键全停之后可以停用
	data(t, h, "POST", "/api/trade/risk/kill", "")
	if err := e.reg.Disable(ctx, "trade"); err != nil {
		t.Fatalf("全停后应当能停用：%v", err)
	}
	// 卸载同样拦：停用状态下还有挂单（比如旧版本没拦就停了）
	if _, err := e.d.W.Exec(`UPDATE trade_orders SET status = 'open' WHERE id = (SELECT id FROM trade_orders LIMIT 1)`); err != nil {
		t.Fatal(err)
	}
	_, err = e.reg.Uninstall(ctx, "trade", plugin.UninstallOptions{})
	if !errors.Is(err, plugin.ErrState) || !strings.Contains(err.Error(), "还有 1 笔挂单") {
		t.Fatalf("卸载要被拦：%v", err)
	}
	if _, err := e.d.W.Exec(`UPDATE trade_orders SET status = 'canceled'`); err != nil {
		t.Fatal(err)
	}
	if _, err := e.reg.Uninstall(ctx, "trade", plugin.UninstallOptions{}); err != nil {
		t.Fatalf("没有挂单了应当能卸载：%v", err)
	}
}

// 连接器在连接器页被断开（或删掉）：算数据源断开，账户异常并熔断。
func TestLiveConnectorDisconnected(t *testing.T) {
	e := setupLive(t)
	h := e.h
	cid := e.addConn(t, BinanceAccountTool, bnSecrets())
	aid := data(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`"}`)["id"].(string)
	if _, _, err := e.conns.Disconnect(context.Background(), cid); err != nil {
		t.Fatal(err)
	}
	a := e.sync(t, aid)
	if a["status"] != "error" || !strings.Contains(a["error"].(string), "已断开") || strings.HasPrefix(a["error"].(string), "conflict") {
		t.Fatalf("连接器断开后 = %v", a)
	}
	if r := e.risk(t); r["halted"] != true || !strings.Contains(r["halted_reason"].(string), "数据源断开") {
		t.Fatalf("要熔断：%v", r)
	}
	if rc := data(t, h, "GET", "/api/trade/accounts/"+aid+"/recon", ""); rc["status"] != "failed" {
		t.Fatalf("对账 = %v", rc)
	}
}

// network:exchanges 还没确认（从 0.4.0 升级后没确认新权限）：同步失败、原因是确认提示，不算交易所故障、不熔断。
func TestLiveExchangesNotGranted(t *testing.T) {
	e := setupLive(t)
	h := e.h
	cid := e.addConn(t, BinanceAccountTool, bnSecrets())
	aid := data(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+cid+`"}`)["id"].(string)
	e.p.exDoer = func(context.Context) (*http.Client, error) {
		return nil, &plugin.NotGrantedError{ID: "trade", Perm: "network:exchanges"}
	}
	for range 4 {
		e.sync(t, aid)
	}
	a := data(t, h, "GET", "/api/trade/accounts/"+aid, "")
	if a["status"] != "error" || a["error"] != "插件 trade 的 network:exchanges 权限还没确认，到插件管理里升级并确认" {
		t.Fatalf("没确认权限 = %v", a)
	}
	if e.risk(t)["halted"] == true {
		t.Fatal("权限没确认不是交易所故障，不该熔断")
	}
}
