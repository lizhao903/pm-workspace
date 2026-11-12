// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"
)

// 实盘下单（TRD-08d）。全部对着本机的假交易所（live_fake_test.go），凭证是假的，不连任何真实交易所、测试网。

/* ---------- 写操作的放行：只有闸门令牌下、只到放行清单 ---------- */

func TestTradeTransportNeedsGateGrant(t *testing.T) {
	hits := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits[r.Method+" "+r.Header.Get("X-Original-Host")+r.URL.Path]++
		w.WriteHeader(200)
	}))
	defer srv.Close()
	to, _ := url.Parse(srv.URL)
	c := readOnlyClient(&http.Client{Transport: hostRewrite{to}})
	do := func(ctx context.Context, method, u string) error {
		req, _ := http.NewRequestWithContext(ctx, method, u, strings.NewReader(""))
		resp, err := c.Do(req)
		if resp != nil {
			_ = resp.Body.Close()
		}
		return err
	}
	bg := context.Background()
	writes := []struct{ method, url string }{
		{"POST", "https://api.binance.com/api/v3/order"},
		{"DELETE", "https://api.binance.com/api/v3/order"},
		{"GET", "https://api.binance.com/api/v3/order"},
		{"POST", "https://fapi.binance.com/fapi/v1/order"},
		{"POST", "https://www.okx.com/api/v5/trade/order"},
		{"POST", "https://www.okx.com/api/v5/trade/cancel-order"},
	}
	// 没有令牌：任何写请求、查单都在本地拦下
	for _, x := range writes {
		if err := do(bg, x.method, x.url); !errors.Is(err, errNotReadOnly) {
			t.Fatalf("没有令牌 %s %s：%v", x.method, x.url, err)
		}
	}
	// 自己构造的令牌（没登记过）不管用
	forged := context.WithValue(bg, tradeGrantKey{}, &tradeGrant{scope: scopePlace, accountID: "ac", broker: "Binance", expires: time.Now().Add(time.Hour)})
	if err := do(forged, "POST", "https://api.binance.com/api/v3/order"); !errors.Is(err, errNotReadOnly) {
		t.Fatalf("伪造的令牌：%v", err)
	}
	// 撤单查单令牌：能撤、能查，不能下单
	mctx, release := issueTradeGrantForTest(bg, scopeManage, "Binance")
	for _, x := range []struct {
		method, url string
		ok          bool
	}{
		{"DELETE", "https://api.binance.com/api/v3/order", true},
		{"GET", "https://fapi.binance.com/fapi/v1/order", true},
		{"POST", "https://api.binance.com/api/v3/order", false},
		{"POST", "https://www.okx.com/api/v5/trade/cancel-order", false}, // 令牌是 Binance 的
		{"POST", "https://api.binance.com/sapi/v1/capital/withdraw/apply", false},
		{"POST", "https://api.binance.com/sapi/v1/asset/transfer", false},
		{"POST", "https://api.binance.com/api/v3/order/oco", false},
		{"PUT", "https://api.binance.com/api/v3/order", false},
		{"POST", "https://fapi.binance.com/fapi/v1/leverage", false},
	} {
		err := do(mctx, x.method, x.url)
		if x.ok != (err == nil) {
			t.Fatalf("撤单查单令牌 %s %s：%v", x.method, x.url, err)
		}
	}
	release()
	if err := do(mctx, "DELETE", "https://api.binance.com/api/v3/order"); !errors.Is(err, errNotReadOnly) {
		t.Fatalf("作废后的令牌还能用：%v", err)
	}
	// 下单令牌：只到放行清单，提币、划转、借贷照样拦
	pctx, release := issueTradeGrantForTest(bg, scopePlace, "OKX")
	for _, x := range []struct {
		method, url string
		ok          bool
	}{
		{"POST", "https://www.okx.com/api/v5/trade/order", true},
		{"GET", "https://www.okx.com/api/v5/trade/order", true},
		{"POST", "https://www.okx.com/api/v5/asset/withdrawal", false},
		{"POST", "https://www.okx.com/api/v5/asset/transfer", false},
		{"POST", "https://www.okx.com/api/v5/account/set-leverage", false},
		{"POST", "https://www.okx.com/api/v5/trade/batch-orders", false},
		{"POST", "https://www.okx.com/api/v5/trade/amend-order", false},
		{"POST", "https://api.binance.com/api/v3/order", false},
	} {
		err := do(pctx, x.method, x.url)
		if x.ok != (err == nil) {
			t.Fatalf("下单令牌 %s %s：%v", x.method, x.url, err)
		}
	}
	release()
	if liveGrants() != 0 {
		t.Fatalf("令牌没作废干净：%d", liveGrants())
	}
	if hits["POST api.binance.com/api/v3/order"] != 0 || hits["POST www.okx.com/api/v5/trade/order"] != 1 || hits["DELETE api.binance.com/api/v3/order"] != 1 {
		t.Fatalf("出网 = %v", hits)
	}
}

// issueTradeGrantForTest 在测试里拿令牌（源码里只有 withGate 能调 issueTradeGrant，TestTradeGrantOnlyFromGate 只扫非测试文件）。
func issueTradeGrantForTest(ctx context.Context, scope grantScope, broker string) (context.Context, func()) {
	return issueTradeGrant(ctx, scope, "ac_test", broker)
}

/* ---------- 精度和最小量 ---------- */

func TestFitOrderRules(t *testing.T) {
	r := symbolRules{Trading: true, Tick: mustFx("0.01"), MinPrice: mustFx("0.01"), MaxPrice: mustFx("1000000"), Step: mustFx("0.00001"), MinQty: mustFx("0.00001"),
		MaxQty: mustFx("9000"), MinNotional: mustFx("5"), NotionalMkt: true}
	q, px, err := r.fitOrder("buy", "limit", mustFx("0.0123456"), mustFx("30000.129"), 0)
	if err != nil || q.String() != "0.01234" || px.String() != "30000.12" {
		t.Fatalf("买单取整 = %s %s %v", q, px, err)
	}
	if _, px, _ := r.fitOrder("sell", "limit", mustFx("1"), mustFx("30000.121"), 0); px.String() != "30000.13" {
		t.Fatalf("卖单价格向上取整 = %s", px)
	}
	for name, c := range map[string]struct {
		side, typ    string
		qty, px, ref string
		want         string
	}{
		"数量不足一步": {"buy", "limit", "0.000001", "100", "", "取整后为 0"},
		"金额不够":   {"buy", "limit", "0.00001", "100", "", "最小下单金额 5"},
		"市价金额不够": {"buy", "market", "0.00001", "0", "100", "最小下单金额 5"},
		"超过单笔上限": {"buy", "limit", "9001", "1", "", "单笔上限 9000"},
		"价格太高":   {"buy", "limit", "1", "2000000", "", "最高价 1000000"},
	} {
		_, _, err := r.fitOrder(c.side, c.typ, mustFx(c.qty), mustFx(c.px), mustFx(orDefault(c.ref, "0")))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s：%v，应当含 %q", name, err, c.want)
		}
	}
	// OKX 永续：张数 × 面值 × 价格算金额；市价单的数量上限用 maxMktSz
	okx := symbolRules{Trading: true, Tick: mustFx("0.1"), Step: fxScale, MinQty: fxScale, MaxQty: mustFx("100000"), MktMaxQty: mustFx("3000"), CtVal: mustFx("0.01"),
		MinNotional: mustFx("10"), NotionalMkt: true}
	if _, _, err := okx.fitOrder("buy", "market", mustFx("3001"), 0, mustFx("60000")); err == nil || !strings.Contains(err.Error(), "单笔上限 3000") {
		t.Fatalf("市价上限：%v", err)
	}
	if q, _, err := okx.fitOrder("buy", "market", mustFx("2.7"), 0, mustFx("60000")); err != nil || q.String() != "2" {
		t.Fatalf("张数向下取整 = %s %v", q, err)
	}
	if _, _, err := (symbolRules{}).fitOrder("buy", "limit", fxScale, fxScale, 0); err == nil {
		t.Fatal("交易所不能交易的标的要拒")
	}
}

/* ---------- 环境 ---------- */

// venueSrc 是场所为 BINANCE / OKX 的测试行情源（价格、K 线由测试定），让实盘标的有标的表和最新价。
type venueSrc struct {
	*paperSrc
	id    string
	insts []Instrument
}

func (s *venueSrc) ID() string   { return s.id }
func (s *venueSrc) Name() string { return s.id + " 测试行情" }
func (s *venueSrc) Instruments(_ context.Context, market, kind string) ([]Instrument, error) {
	out := []Instrument{}
	for _, in := range s.insts {
		if in.Market == market && in.Kind == kind {
			out = append(out, in)
		}
	}
	return out, nil
}

func setupTrade(t *testing.T) liveEnv {
	t.Helper()
	clock := newTestClock(time.Now())
	bn := &venueSrc{paperSrc: &paperSrc{price: map[string]float64{"BINANCE:BTCUSDT": 60000, "BINANCE:BTCUSDT.P": 60000}, clock: clock}, id: "binance",
		insts: []Instrument{
			{Symbol: "BINANCE:BTCUSDT", Name: "BTC/USDT", Market: "crypto", Kind: "spot", Venue: "Binance", Digits: 2, Lot: 0.00001, Multiplier: 1},
			{Symbol: "BINANCE:BTCUSDT.P", Name: "BTC 永续", Market: "crypto", Kind: "perp", Venue: "Binance", Digits: 1, Lot: 0.001, Multiplier: 1},
		}}
	ok := &venueSrc{paperSrc: &paperSrc{price: map[string]float64{"OKX:BTC-USDT": 60000, "OKX:BTC-USDT-SWAP": 60000}, clock: clock}, id: "okx",
		insts: []Instrument{
			{Symbol: "OKX:BTC-USDT", Name: "BTC/USDT", Market: "crypto", Kind: "spot", Venue: "OKX", Digits: 2, Lot: 0.0001, Multiplier: 1},
			{Symbol: "OKX:BTC-USDT-SWAP", Name: "BTC 永续", Market: "crypto", Kind: "perp", Venue: "OKX", Digits: 1, Lot: 1, Multiplier: 0.01},
		}}
	e := setupLive(t, bn, ok)
	data(t, e.h, "POST", "/api/trade/sources/binance/sync", "")
	data(t, e.h, "POST", "/api/trade/sources/okx/sync", "")
	e.fake.set(func(f *fakeAcctEx) {
		f.bnPerms = map[string]bool{"enableReading": true, "enableSpotAndMarginTrading": true, "enableFutures": true}
		f.bnBalances = map[string][2]string{"USDT": {"10000", "0"}}
		f.okPerm = "read_only,trade"
		f.okDetails = []map[string]string{{"ccy": "USDT", "cashBal": "10000", "availBal": "10000", "frozenBal": "0", "eqUsd": "10000"}}
	})
	return e
}

// openGate 把实盘闸门的三项全局条件做齐：评审五项都确认（直接写库）、授予 trade:live、用户本人打开开关。
func (e liveEnv) openGate(t *testing.T) {
	t.Helper()
	for _, k := range liveCheckKeys() {
		if _, err := e.d.W.Exec(`INSERT OR IGNORE INTO trade_live_checks (key, confirmed_at, reviewer) VALUES (?, '2026-11-05T00:00:00.000Z', 'me')`, k); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.reg.Grant(context.Background(), "trade", LivePerm); err != nil {
		t.Fatal(err)
	}
	if v := data(t, as(e.h, asUser), "POST", "/api/trade/live/switch", `{"enabled":true}`); v["enabled"] != true {
		t.Fatalf("打开开关 = %v", v)
	}
}

// liveAcct 接一个选了「读取 + 交易」的实盘账户。
func (e liveEnv) liveAcct(t *testing.T, tool string) string {
	t.Helper()
	sec := bnSecrets()
	if tool == OKXAccountTool {
		sec = okSecrets()
	}
	a := data(t, e.h, "POST", "/api/trade/accounts", `{"connector_id":"`+e.addConn(t, tool, sec)+`","trade":true}`)
	if a["status"] != "connected" {
		t.Fatalf("接入 = %v", a)
	}
	return a["id"].(string)
}

func (e liveEnv) postOrder(t *testing.T, h http.Handler, body string) (int, map[string]any) {
	t.Helper()
	return call(t, h, "POST", "/api/trade/orders", body)
}

func (e liveEnv) countAudit(t *testing.T, q string) int {
	t.Helper()
	return len(e.auditActions(t, q))
}

// noStrangeCalls：假交易所没收到放行清单以外的请求，签名都对。
func (e liveEnv) noStrangeCalls(t *testing.T) {
	t.Helper()
	_, bad, strange := e.fake.snapshot()
	if len(bad) > 0 || len(strange) > 0 {
		t.Fatalf("签名不对：%v；不该有的请求：%v", bad, strange)
	}
	for _, w := range e.fake.writeCalls() {
		parts := strings.SplitN(w, " ", 3)
		if !fakeTradeWrite(parts[0], parts[1], parts[2]) {
			t.Fatalf("写请求不在放行清单：%s", w)
		}
	}
}

/* ---------- Binance 现货：闸门、取整、风控、二次确认、下单、成交回写、对账、撤单 ---------- */

func TestLiveOrderBinanceSpot(t *testing.T) {
	e := setupTrade(t)
	ctx := context.Background()
	h, user, agent := e.h, as(e.h, asUser), as(e.h, asAgent)
	f := e.fake
	aid := e.liveAcct(t, BinanceAccountTool)
	body := func(qty, px string, extra string) string {
		return `{"account_id":"` + aid + `","symbol":"BINANCE:BTCUSDT","side":"buy","type":"limit","qty":` + qty + `,"price":` + px + extra + `}`
	}

	// 闸门没开：403 live_gate，逐条写缺什么，记审计，不出网
	code, out := e.postOrder(t, user, body("0.01", "30000", `,"confirmed":true`))
	miss := strs(errOf(out)["missing"])
	if code != 403 || errOf(out)["reason"] != "live_gate" || len(miss) != 3 || !strings.Contains(miss[0], "实盘评审还没通过") ||
		!strings.Contains(miss[1], "trade:live") || !strings.Contains(miss[2], "实盘开关没打开") {
		t.Fatalf("闸门没开 = %d %v", code, out)
	}
	if e.countAudit(t, "action=live_gate_block&account_id="+aid) != 1 || f.postCount() != 0 {
		t.Fatal("闸门拒绝要记审计、不出网")
	}
	if a := data(t, h, "GET", "/api/trade/accounts/"+aid, ""); a["trade_ready"] != false || len(a["trade_blockers"].([]any)) != 3 {
		t.Fatalf("账户卡片上要写不能下单的原因：%v", a)
	}

	e.openGate(t)
	if a := data(t, h, "GET", "/api/trade/accounts/"+aid, ""); a["trade_ready"] != true {
		t.Fatalf("闸门全开后账户可以下单：%v", a)
	}
	// 代理代为下单：403 not_user
	if code, out := e.postOrder(t, agent, body("0.01", "30000", `,"confirmed":true`)); code != 403 || errOf(out)["reason"] != "not_user" {
		t.Fatalf("代理下实盘单 = %d %v", code, out)
	}
	// 没带二次确认：409 confirm（实盘每笔都要），不出网
	if code, out := e.postOrder(t, user, body("0.01", "30000", "")); code != 409 || errOf(out)["reason"] != "confirm" || errOf(out)["live"] != true ||
		!strings.Contains(errOf(out)["message"].(string), "真实盈亏") {
		t.Fatalf("实盘没确认 = %d %v", code, out)
	}
	// 不满足交易所规则：本地 400，不出网
	if code, out := e.postOrder(t, user, body("0.00001", "100", `,"confirmed":true`)); code != 400 || !strings.Contains(errOf(out)["message"].(string), "最小下单金额") {
		t.Fatalf("金额不够 = %d %v", code, out)
	}
	if code, out := e.postOrder(t, user, body("0.01", "30000", `,"confirmed":true,"type":"stop"`)); code != 400 {
		t.Fatalf("实盘止损单 = %d %v", code, out)
	}
	// 风控照常逐笔检查：超单笔上限 409 risk，委托记成被拒，不出网
	data(t, h, "PATCH", "/api/trade/risk", `{"max_order_value":100}`)
	code, out = e.postOrder(t, user, body("0.01", "30000", `,"confirmed":true`))
	if code != 409 || errOf(out)["reason"] != "risk" || errOf(out)["order"].(map[string]any)["live"] != true {
		t.Fatalf("实盘风控 = %d %v", code, out)
	}
	data(t, h, "PATCH", "/api/trade/risk", `{"max_order_value":50000}`)
	if f.postCount() != 0 {
		t.Fatalf("被拒的都不该出网：%d", f.postCount())
	}

	// 下单：按 stepSize、tickSize 取整，先落库再发，委托编号就是 newClientOrderId
	o := data(t, user, "POST", "/api/trade/orders", body("0.0123456", "30000.129", `,"confirmed":true`))
	cid := o["client_order_id"].(string)
	if o["live"] != true || o["status"] != "open" || o["qty"] != 0.01234 || o["price"] != 30000.12 || o["exchange_order_id"] != "1001" || !strings.HasPrefix(cid, "pmw") {
		t.Fatalf("实盘下单 = %v", o)
	}
	fo := f.order(cid)
	if fo == nil || fo.Qty != "0.01234" || fo.Price != "30000.12" || fo.Type != "LIMIT" || fo.Side != "BUY" || f.postCount() != 1 {
		t.Fatalf("交易所收到的委托 = %+v", fo)
	}
	oid := o["id"].(string)
	if acts := e.auditActions(t, "order_id="+oid); !slices.Contains(acts, "place") {
		t.Fatalf("下单要记审计：%v", acts)
	}
	// 实盘委托不改价、模拟盘撮合不碰它
	if code, out := call(t, h, "PATCH", "/api/trade/orders/"+oid, `{"price":29000}`); code != 403 || errOf(out)["reason"] != "live" {
		t.Fatalf("改实盘委托的价 = %d %v", code, out)
	}
	time.Sleep(100 * time.Millisecond)
	if got := data(t, h, "GET", "/api/trade/orders/"+oid, ""); got["status"] != "open" || got["filled"] != 0.0 {
		t.Fatalf("模拟盘撮合不该动实盘委托：%v", got)
	}

	// 对账认得出：同步后交易所的这笔挂单不算差异，本地挂单里记上了
	e.sync(t, aid)
	rc := data(t, h, "GET", "/api/trade/accounts/"+aid+"/recon", "")
	if rc["status"] != "ok" || len(rc["items"].([]any)) != 0 {
		t.Fatalf("对账要认出交易套件下的委托：%v", rc)
	}

	// 部分成交、全部成交：查单回写，成交审计记增量
	f.fill(cid, "0.005")
	e.p.trader.poll(ctx)
	if got := data(t, h, "GET", "/api/trade/orders/"+oid, ""); got["status"] != "partial" || got["filled"] != 0.005 || got["avg_fill"] != 30000.12 {
		t.Fatalf("部分成交 = %v", got)
	}
	f.fill(cid, "0.01234")
	e.p.trader.poll(ctx)
	if got := data(t, h, "GET", "/api/trade/orders/"+oid, ""); got["status"] != "filled" || got["filled"] != 0.01234 {
		t.Fatalf("全部成交 = %v", got)
	}
	if n := e.countAudit(t, "action=fill&order_id="+oid); n != 2 {
		t.Fatalf("两次成交要记两条成交审计：%d", n)
	}
	if n := len(list(t, h, "/api/trade/orders?live=true&status=active")); n != 0 {
		t.Fatalf("成交完了不在进行中：%d", n)
	}

	// 撤单：DELETE 到交易所，回写撤销；谁撤都行（只会更保守）
	o2 := data(t, user, "POST", "/api/trade/orders", body("0.01", "29000", `,"confirmed":true`))
	c2 := data(t, agent, "POST", "/api/trade/orders/"+o2["id"].(string)+"/cancel", ``)
	if c2["status"] != "canceled" || f.order(o2["client_order_id"].(string)).Status != "CANCELED" {
		t.Fatalf("撤单 = %v", c2)
	}
	if !slices.Contains(f.writeCalls(), "DELETE api.binance.com /api/v3/order") {
		t.Fatalf("撤单要发 DELETE：%v", f.writeCalls())
	}

	// Key 在交易所开了提币权限：下一笔就被闸门拦下，不出网
	posts := f.postCount()
	f.set(func(f *fakeAcctEx) { f.bnPerms["enableWithdrawals"] = true })
	code, out = e.postOrder(t, user, body("0.01", "30000", `,"confirmed":true`))
	if code != 403 || errOf(out)["reason"] != "live_gate" || !strings.Contains(strings.Join(strs(errOf(out)["missing"]), ""), "提币权限") {
		t.Fatalf("Key 开了提币 = %d %v", code, out)
	}
	f.set(func(f *fakeAcctEx) {
		delete(f.bnPerms, "enableWithdrawals")
		f.bnPerms["enableSpotAndMarginTrading"] = false
	})
	if code, out := e.postOrder(t, user, body("0.01", "30000", `,"confirmed":true`)); code != 403 || !strings.Contains(strings.Join(strs(errOf(out)["missing"]), ""), "现货交易权限") {
		t.Fatalf("Key 没有现货交易权限 = %d %v", code, out)
	}
	f.set(func(f *fakeAcctEx) { f.bnPerms["enableSpotAndMarginTrading"] = true })
	// 关开关（谁关都行）：下一笔就被拦
	data(t, agent, "POST", "/api/trade/live/switch", `{"enabled":false}`)
	if code, out := e.postOrder(t, user, body("0.01", "30000", `,"confirmed":true`)); code != 403 || !strings.Contains(strings.Join(strs(errOf(out)["missing"]), ""), "实盘开关没打开") {
		t.Fatalf("关开关后下单 = %d %v", code, out)
	}
	// 账户改成只读：同样被拦
	data(t, as(h, asUser), "POST", "/api/trade/live/switch", `{"enabled":true}`)
	data(t, h, "PATCH", "/api/trade/accounts/"+aid, `{"trade":false}`)
	if code, out := e.postOrder(t, user, body("0.01", "30000", `,"confirmed":true`)); code != 403 || !strings.Contains(strings.Join(strs(errOf(out)["missing"]), ""), "读取 + 交易") {
		t.Fatalf("只读账户下单 = %d %v", code, out)
	}
	if f.postCount() != posts {
		t.Fatalf("闸门拦下的不该出网：%d → %d", posts, f.postCount())
	}
	if liveGrants() != 0 {
		t.Fatalf("令牌没作废：%d", liveGrants())
	}
	e.noStrangeCalls(t)
	e.noSecrets(t)
}

/* ---------- 幂等：状态未知时查单确认，永不重发 ---------- */

func TestLiveOrderUnknownNeverResends(t *testing.T) {
	e := setupTrade(t)
	ctx := context.Background()
	user := as(e.h, asUser)
	f := e.fake
	aid := e.liveAcct(t, BinanceAccountTool)
	e.openGate(t)
	body := `{"account_id":"` + aid + `","symbol":"BINANCE:BTCUSDT","side":"buy","type":"limit","qty":0.01,"price":30000,"confirmed":true}`

	// 交易所收下了但连接断了（没回包）：记状态未知，当场按委托编号查到，回写成挂单中；只发了一次 POST
	f.set(func(f *fakeAcctEx) { f.placeMode = "close" })
	o := data(t, user, "POST", "/api/trade/orders", body)
	if o["status"] != "open" || o["exchange_order_id"] == nil || f.postCount() != 1 {
		t.Fatalf("断线后查单确认 = %v，POST %d 次", o, f.postCount())
	}
	acts := e.auditActions(t, "order_id="+o["id"].(string))
	if !slices.Contains(acts, "unknown") || !slices.Contains(acts, "confirm") {
		t.Fatalf("状态未知、查单确认都要记审计：%v", acts)
	}

	// 交易所回 503（没收下）：状态未知，查不到也不重发；超过 orderLostAfter 才按没下成处理
	f.set(func(f *fakeAcctEx) { f.placeMode = "drop" })
	o2 := data(t, user, "POST", "/api/trade/orders", body)
	if o2["status"] != "unknown" || f.postCount() != 2 {
		t.Fatalf("503 = %v，POST %d 次", o2, f.postCount())
	}
	e.p.trader.poll(ctx)
	if got := data(t, e.h, "GET", "/api/trade/orders/"+o2["id"].(string), ""); got["status"] != "unknown" || got["checked_at"] == nil {
		t.Fatalf("还没到时间，留着状态未知：%v", got)
	}
	e.clock.advance(2 * orderLostAfter)
	e.p.trader.poll(ctx)
	got := data(t, e.h, "GET", "/api/trade/orders/"+o2["id"].(string), "")
	if got["status"] != "rejected" || !strings.Contains(got["reject_reason"].(string), "按没下成处理") {
		t.Fatalf("超时查不到 = %v", got)
	}
	if f.postCount() != 2 {
		t.Fatalf("状态未知不能自动重发：POST %d 次", f.postCount())
	}
	// 交易所明确拒单：rejected，原因写进委托
	f.set(func(f *fakeAcctEx) { f.placeMode = "reject" })
	o3 := data(t, user, "POST", "/api/trade/orders", body)
	if o3["status"] != "rejected" || !strings.Contains(o3["reject_reason"].(string), "-2010") {
		t.Fatalf("拒单 = %v", o3)
	}
	// 每笔委托的编号都不一样
	ids := map[string]bool{}
	for _, x := range list(t, e.h, "/api/trade/orders?live=true") {
		if c, _ := x.(map[string]any)["client_order_id"].(string); c != "" {
			if ids[c] {
				t.Fatalf("委托编号重复：%s", c)
			}
			ids[c] = true
		}
	}
	e.noStrangeCalls(t)
}

/* ---------- OKX：永续张数、杠杆不改、双向持仓不支持、现货市价按币数量 ---------- */

func TestLiveOrderOKX(t *testing.T) {
	e := setupTrade(t)
	ctx := context.Background()
	user := as(e.h, asUser)
	f := e.fake
	aid := e.liveAcct(t, OKXAccountTool)
	e.openGate(t)
	perp := func(extra string) string {
		return `{"account_id":"` + aid + `","symbol":"OKX:BTC-USDT-SWAP","side":"buy","type":"limit","qty":3,"price":60000.05,"confirmed":true` + extra + `}`
	}
	if code, out := e.postOrder(t, user, perp(`,"leverage":5`)); code != 400 || !strings.Contains(errOf(out)["message"].(string), "不改交易所的杠杆") {
		t.Fatalf("杠杆对不上 = %d %v", code, out)
	}
	o := data(t, user, "POST", "/api/trade/orders", perp(""))
	fo := f.order(o["client_order_id"].(string))
	if o["status"] != "open" || o["leverage"] != 3.0 || o["price"] != 60000.0 || fo == nil || fo.Params["tdMode"] != "cross" || fo.Params["sz"] != "3" ||
		fo.Params["px"] != "60000" || fo.Params["ordType"] != "limit" {
		t.Fatalf("OKX 永续 = %v，交易所收到 %+v", o, fo)
	}
	// 杠杆按交易所的过风控：上限调到 2 倍，3 倍的单被拦
	data(t, e.h, "PATCH", "/api/trade/risk", `{"max_leverage":2}`)
	if code, out := e.postOrder(t, user, perp("")); code != 409 || !strings.Contains(errOf(out)["message"].(string), "杠杆 3x 超过上限 2x") {
		t.Fatalf("杠杆风控 = %d %v", code, out)
	}
	data(t, e.h, "PATCH", "/api/trade/risk", `{"max_leverage":10}`)
	f.set(func(f *fakeAcctEx) { f.okPosMode = "long_short_mode" })
	if code, out := e.postOrder(t, user, perp("")); code != 400 || !strings.Contains(errOf(out)["message"].(string), "双向持仓") {
		t.Fatalf("双向持仓 = %d %v", code, out)
	}
	f.set(func(f *fakeAcctEx) { f.okPosMode = "net_mode" })

	// 现货市价买：按币数量（tgtCcy base_ccy），要有最新价
	e.p.mkt.ensure(ctx, "ticker", "OKX:BTC-USDT")
	waitFor(t, "OKX:BTC-USDT 的最新价", func() bool { return e.p.mkt.quote(ctx, "OKX:BTC-USDT").Last > 0 })
	f.set(func(f *fakeAcctEx) { f.placeMode = "fill" })
	m := data(t, user, "POST", "/api/trade/orders", `{"account_id":"`+aid+`","symbol":"OKX:BTC-USDT","side":"buy","type":"market","qty":0.01,"confirmed":true}`)
	fm := f.order(m["client_order_id"].(string))
	if fm.Params["tgtCcy"] != "base_ccy" || fm.Params["tdMode"] != "cash" || fm.Params["sz"] != "0.01" {
		t.Fatalf("OKX 现货市价 = %+v", fm.Params)
	}
	e.p.trader.poll(ctx)
	if got := data(t, e.h, "GET", "/api/trade/orders/"+m["id"].(string), ""); got["status"] != "filled" || got["filled"] != 0.01 || got["fee"] != 0.01 {
		t.Fatalf("查单回写 = %v", got)
	}
	// OKX 拒单（sCode）：rejected
	f.set(func(f *fakeAcctEx) { f.placeMode = "reject" })
	r := data(t, user, "POST", "/api/trade/orders", perp(""))
	if r["status"] != "rejected" || !strings.Contains(r["reject_reason"].(string), "51008") {
		t.Fatalf("OKX 拒单 = %v", r)
	}
	// 撤单走 cancel-order
	f.set(func(f *fakeAcctEx) { f.placeMode = "" })
	c := data(t, as(e.h, asAgent), "POST", "/api/trade/orders/"+o["id"].(string)+"/cancel", ``)
	if c["status"] != "canceled" || !slices.Contains(f.writeCalls(), "POST www.okx.com /api/v5/trade/cancel-order") {
		t.Fatalf("OKX 撤单 = %v %v", c, f.writeCalls())
	}
	e.noStrangeCalls(t)
	e.noSecrets(t)
}

/* ---------- 全停：撤掉实盘账户在交易所的全部挂单，不动持仓；撤不掉的列出来 ---------- */

func TestLiveKillCancelsExchangeOrders(t *testing.T) {
	e := setupTrade(t)
	user := as(e.h, asUser)
	f := e.fake
	aid := e.liveAcct(t, BinanceAccountTool)
	e.openGate(t)
	body := `{"account_id":"` + aid + `","symbol":"BINANCE:BTCUSDT","side":"buy","type":"limit","qty":0.01,"price":30000,"confirmed":true}`
	o1 := data(t, user, "POST", "/api/trade/orders", body)
	o2 := data(t, user, "POST", "/api/trade/orders", body)
	f.set(func(f *fakeAcctEx) {
		// 一笔不是交易套件下的挂单（在交易所 App 里挂的），全停也要撤
		f.bnSpotOrders = []map[string]any{{"symbol": "BTCUSDT", "orderId": 11, "price": "20000", "origQty": "0.1", "executedQty": "0", "status": "NEW",
			"type": "LIMIT", "side": "BUY", "stopPrice": "0", "time": 1730000000000}}
		f.cancelFail[o2["client_order_id"].(string)] = true
	})
	code, out := call(t, e.h, "POST", "/api/trade/risk/kill", `{"reason":"全停演练"}`)
	res, _ := errOf(out)["result"].(map[string]any)
	if code != 500 || res == nil || res["orders_canceled"] != 2.0 || len(res["failed"].([]any)) == 0 || len(res["remaining_orders"].([]any)) != 1 ||
		!strings.Contains(res["remaining_orders"].([]any)[0].(string), "#1002") {
		t.Fatalf("全停撤实盘挂单 = %d %v", code, out)
	}
	if got := data(t, e.h, "GET", "/api/trade/orders/"+o1["id"].(string), ""); got["status"] != "canceled" {
		t.Fatalf("交易套件下的挂单要撤掉：%v", got)
	}
	if len(f.bnSpotOrders) != 0 {
		t.Fatal("交易所 App 里挂的单也要撤")
	}
	if e.countAudit(t, "action=cancel_failed&account_id="+aid) == 0 {
		t.Fatal("撤不掉要记审计")
	}
	// 熔断中：实盘开仓单被风控拦下（不出网）
	posts := f.postCount()
	if code, out := e.postOrder(t, user, body); code != 409 || !strings.Contains(errOf(out)["message"].(string), "熔断中") {
		t.Fatalf("熔断中实盘开仓 = %d %v", code, out)
	}
	if f.postCount() != posts {
		t.Fatal("熔断中开仓不该出网")
	}
	// 撤得掉了再全停一次：全部撤完，200
	f.set(func(f *fakeAcctEx) { f.cancelFail = map[string]bool{} })
	if k := data(t, e.h, "POST", "/api/trade/risk/kill", `{"reason":"再停一次"}`); k["orders_canceled"] != 1.0 || len(k["remaining_orders"].([]any)) != 0 {
		t.Fatalf("第二次全停 = %v", k)
	}
	e.noStrangeCalls(t)
}

/* ---------- 部署到实盘：同一个入口下单；闸门失效时自动暂停 ---------- */

func TestLiveRunPausesWhenGateCloses(t *testing.T) {
	e := setupTrade(t)
	ctx := context.Background()
	h, user, agent := e.h, as(e.h, asUser), as(e.h, asAgent)
	f := e.fake
	aid := e.liveAcct(t, BinanceAccountTool)
	strat := strings.ReplaceAll(crossStrategy, "FAKE:BTCUSDT", "BINANCE:BTCUSDT")
	sid := data(t, h, "POST", "/api/trade/strategies", strat)["id"].(string)
	runBody := `{"strategy_id":"` + sid + `","account_id":"` + aid + `","capital":1000}`
	// 闸门没开：用户本人部署也 403 live_gate；代理 403 not_user
	if code, out := call(t, user, "POST", "/api/trade/runs", runBody); code != 403 || errOf(out)["reason"] != "live_gate" {
		t.Fatalf("闸门没开部署 = %d %v", code, out)
	}
	e.openGate(t)
	if code, out := call(t, agent, "POST", "/api/trade/runs", runBody); code != 403 || errOf(out)["reason"] != "not_user" {
		t.Fatalf("代理部署到实盘 = %d %v", code, out)
	}
	run := data(t, user, "POST", "/api/trade/runs", runBody)
	rid := run["id"].(string)
	if run["status"] != "running" || !strings.Contains(runLogs(run), "实盘启动") {
		t.Fatalf("部署到实盘 = %v", run)
	}
	// 信号单走同一个入口：source run、带部署 id，发到交易所
	x, err := loadRun(ctx, e.p.runs.c, rid)
	if err != nil {
		t.Fatal(err)
	}
	in, _ := loadLedgerInst(ctx, e.p.runs.c, "BINANCE:BTCUSDT")
	e.p.mkt.ensure(ctx, "ticker", "BINANCE:BTCUSDT")
	waitFor(t, "BINANCE:BTCUSDT 的最新价", func() bool { return e.p.mkt.quote(ctx, "BINANCE:BTCUSDT").Last > 0 })
	f.set(func(f *fakeAcctEx) { f.placeMode = "fill" })
	if err := e.p.runs.order(ctx, x, in, "BINANCE:BTCUSDT", "buy", mustFx("0.001"), false, 1, "entry", "测试信号"); err != nil {
		t.Fatal(err)
	}
	os := list(t, h, "/api/trade/orders?run_id="+rid)
	if len(os) != 1 || os[0].(map[string]any)["source"] != "run" || os[0].(map[string]any)["live"] != true || f.postCount() != 1 {
		t.Fatalf("部署下单 = %v", os)
	}
	// 同一根 K 线重算不重复下单
	_ = e.p.runs.order(ctx, x, in, "BINANCE:BTCUSDT", "buy", mustFx("0.001"), false, 1, "entry", "测试信号")
	if f.postCount() != 1 {
		t.Fatal("同一根 K 线不该重复下单")
	}
	// 部署的持仓按实盘委托的成交算
	if b, err := e.p.runs.book(ctx, rid); err != nil || b.pos["BINANCE:BTCUSDT"].Qty != mustFx("0.001") {
		t.Fatalf("实盘部署的账 = %+v %v", b.pos, err)
	}

	// 关开关：运行中的实盘部署自动暂停，写日志、审计
	data(t, agent, "POST", "/api/trade/live/switch", `{"enabled":false}`)
	waitFor(t, "实盘部署自动暂停", func() bool { return data(t, h, "GET", "/api/trade/runs/"+rid, "")["status"] == "paused" })
	r := data(t, h, "GET", "/api/trade/runs/"+rid, "")
	if !strings.Contains(r["error"].(string), "实盘开关没打开") || !strings.Contains(runLogs(r), "自动暂停") {
		t.Fatalf("暂停原因 = %v", r)
	}
	if acts := e.auditActions(t, "run_id="+rid+"&action=pause"); len(acts) != 1 {
		t.Fatalf("自动暂停要记审计：%v", acts)
	}
	// 闸门没恢复：恢复 403；代理恢复 403 not_user
	if code, out := call(t, user, "POST", "/api/trade/runs/"+rid+"/resume", ``); code != 403 || errOf(out)["reason"] != "live_gate" {
		t.Fatalf("闸门没开恢复 = %d %v", code, out)
	}
	data(t, user, "POST", "/api/trade/live/switch", `{"enabled":true}`)
	if code, out := call(t, agent, "POST", "/api/trade/runs/"+rid+"/resume", ``); code != 403 || errOf(out)["reason"] != "not_user" {
		t.Fatalf("代理恢复实盘部署 = %d %v", code, out)
	}
	if r := data(t, user, "POST", "/api/trade/runs/"+rid+"/resume", ``); r["status"] != "running" {
		t.Fatalf("恢复 = %v", r)
	}
	// 下单那一刻 Key 没了交易权限：这笔被拦，部署自动暂停
	f.set(func(f *fakeAcctEx) { f.bnPerms["enableSpotAndMarginTrading"] = false })
	x, _ = loadRun(ctx, e.p.runs.c, rid)
	_ = e.p.runs.order(ctx, x, in, "BINANCE:BTCUSDT", "sell", mustFx("0.001"), false, 2, "exit", "测试信号")
	if r := data(t, h, "GET", "/api/trade/runs/"+rid, ""); r["status"] != "paused" || !strings.Contains(r["error"].(string), "现货交易权限") {
		t.Fatalf("下单时闸门失效要暂停部署：%v", r)
	}
	if f.postCount() != 1 {
		t.Fatal("闸门拦下的不该出网")
	}
	e.noStrangeCalls(t)
}
