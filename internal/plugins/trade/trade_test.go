package trade

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func TestManifestValid(t *testing.T) {
	m, err := plugin.Parse(manifestJSON)
	if err != nil {
		t.Fatalf("清单不合法：%v", err)
	}
	if m.ID != "trade" || m.TablePrefix != "trade_" {
		t.Fatalf("id=%s table_prefix=%s", m.ID, m.TablePrefix)
	}
	if !slices.Equal(m.Permissions, []string{"network:market-data"}) {
		t.Fatalf("权限只该有 network:market-data：%v", m.Permissions)
	}
	if !slices.Equal(m.Provides.Modules, []string{"markets", "monitor", "strategy", "trading"}) {
		t.Fatalf("modules = %v", m.Provides.Modules)
	}
}

// 资金边界：插件源码里不出现向交易所下单、撤单、划转、提币的路径，也不申请实盘和交易所权限。
// 模拟盘自己的接口 /api/trade/orders（TRD-05a，只在本地撮合）是例外，先从源码里去掉再查。
func TestNoLiveTradingPaths(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	banned := []string{"/order", "/api/v5/trade", "/sapi/", "withdraw", "transfer", "cancelorder", "placeorder", "http.defaultclient"}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		src := strings.ReplaceAll(strings.ToLower(string(b)), "/api/trade/orders", "")
		for _, s := range banned {
			if strings.Contains(src, s) {
				t.Errorf("%s 里出现了 %q", f, s)
			}
		}
	}
	b, err := os.ReadFile("plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"trade:live", "network:exchanges"} {
		if strings.Contains(string(b), s) {
			t.Errorf("清单里出现了 %q", s)
		}
	}
}

type env struct {
	h   http.Handler
	reg *plugin.Registry
}

func setup(t *testing.T, sources ...Source) env {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	if err := r.Add(New(sources...)); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	if err := r.Install(ctx, "trade", []string{"network:market-data"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "trade"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{"code": "not_found", "message": "x"}})
	}) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return env{h: mux, reg: r}
}

func call(t *testing.T, h http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s %s 回的不是 JSON：%s", method, path, w.Body.String())
	}
	return w.Code, out
}

func data(t *testing.T, h http.Handler, method, path, body string) map[string]any {
	t.Helper()
	code, out := call(t, h, method, path, body)
	if code/100 != 2 {
		t.Fatalf("%s %s = %d %v", method, path, code, out)
	}
	m, _ := out["data"].(map[string]any)
	return m
}

func list(t *testing.T, h http.Handler, path string) []any {
	t.Helper()
	code, out := call(t, h, "GET", path, "")
	if code != 200 {
		t.Fatalf("GET %s = %d %v", path, code, out)
	}
	a, _ := out["data"].([]any)
	return a
}

func TestWatchlistCRUD(t *testing.T) {
	e := setup(t)
	if n := len(list(t, e.h, "/api/trade/watchlists")); n != 0 {
		t.Fatalf("新装应当没有分组：%d", n)
	}
	a := data(t, e.h, "POST", "/api/trade/watchlists", `{"name":" 核心关注 ","symbols":["BINANCE:BTCUSDT"," NASDAQ:NVDA","BINANCE:BTCUSDT"]}`)
	id, _ := a["id"].(string)
	if !strings.HasPrefix(id, "wl_") || a["name"] != "核心关注" || a["position"].(float64) != 0 {
		t.Fatalf("新建 = %v", a)
	}
	if syms := a["symbols"].([]any); len(syms) != 2 || syms[1] != "NASDAQ:NVDA" {
		t.Fatalf("symbols 应当去空白、去重、保序：%v", syms)
	}
	b := data(t, e.h, "POST", "/api/trade/watchlists", `{"name":"数币合约"}`)
	if b["position"].(float64) != 1 || len(b["symbols"].([]any)) != 0 {
		t.Fatalf("第二个分组 = %v", b)
	}
	if got := data(t, e.h, "GET", "/api/trade/watchlists/"+id, ""); got["name"] != "核心关注" {
		t.Fatalf("取一个 = %v", got)
	}

	u := data(t, e.h, "PATCH", "/api/trade/watchlists/"+id, `{"symbols":["OKX:ETH-USDT-SWAP","BINANCE:BTCUSDT.P"],"position":5}`)
	if u["name"] != "核心关注" || u["position"].(float64) != 5 || u["symbols"].([]any)[0] != "OKX:ETH-USDT-SWAP" {
		t.Fatalf("改 = %v", u)
	}
	rows := list(t, e.h, "/api/trade/watchlists")
	if len(rows) != 2 || rows[0].(map[string]any)["name"] != "数币合约" {
		t.Fatalf("按 position 排：%v", rows)
	}

	for _, c := range []struct{ method, path, body string }{
		{"POST", "/api/trade/watchlists", `{}`},
		{"POST", "/api/trade/watchlists", `{"name":"  "}`},
		{"POST", "/api/trade/watchlists", `{"name":"x","symbols":["btcusdt"]}`},
		{"POST", "/api/trade/watchlists", `{"name":"x","color":"red"}`},
		{"POST", "/api/trade/watchlists", `{"name":"` + strings.Repeat("长", 41) + `"}`},
		{"PATCH", "/api/trade/watchlists/" + id, `{"symbols":"BINANCE:BTCUSDT"}`},
		{"PATCH", "/api/trade/watchlists/" + id, `{"position":-1}`},
		{"PATCH", "/api/trade/watchlists/" + id, `[]`},
	} {
		if code, out := call(t, e.h, c.method, c.path, c.body); code != 400 {
			t.Errorf("%s %s %s = %d %v，应当 400", c.method, c.path, c.body, code, out)
		}
	}

	if out := data(t, e.h, "DELETE", "/api/trade/watchlists/"+id, ""); out != nil {
		t.Fatalf("删 = %v", out)
	}
	for _, m := range []string{"GET", "PATCH", "DELETE"} {
		if code, _ := call(t, e.h, m, "/api/trade/watchlists/"+id, `{"name":"x"}`); code != 404 {
			t.Errorf("%s 删掉的分组 = %d，应当 404", m, code)
		}
	}
	if n := len(list(t, e.h, "/api/trade/watchlists")); n != 1 {
		t.Fatalf("删后剩 %d 个", n)
	}
}

func TestSyncAndInstruments(t *testing.T) {
	e := setup(t, &FakeSource{})
	srcs := list(t, e.h, "/api/trade/sources")
	if len(srcs) != 1 || srcs[0].(map[string]any)["id"] != "fake" {
		t.Fatalf("sources = %v", srcs)
	}
	res := data(t, e.h, "POST", "/api/trade/sources/fake/sync", "")
	if res["upserted"].(float64) != 3 || res["skipped"].(float64) != 0 {
		t.Fatalf("同步 = %v", res)
	}
	// 再同步一次是覆盖，不会变多
	data(t, e.h, "POST", "/api/trade/sources/fake/sync", "")
	if n := len(list(t, e.h, "/api/trade/instruments")); n != 3 {
		t.Fatalf("标的 %d 个", n)
	}
	if rows := list(t, e.h, "/api/trade/instruments?kind=perp"); len(rows) != 1 || rows[0].(map[string]any)["underlying"] != "FAKE:BTCUSDT" {
		t.Fatalf("kind=perp = %v", rows)
	}
	if rows := list(t, e.h, "/api/trade/instruments?q=eth"); len(rows) != 1 {
		t.Fatalf("q=eth = %v", rows)
	}
	if rows := list(t, e.h, "/api/trade/instruments?q=_"); len(rows) != 0 {
		t.Fatalf("q 里的通配符要转义：%v", rows)
	}
	code, out := call(t, e.h, "GET", "/api/trade/instruments?limit=1", "")
	if code != 200 || out["meta"].(map[string]any)["total"].(float64) != 3 || len(out["data"].([]any)) != 1 {
		t.Fatalf("limit=1 = %d %v", code, out)
	}
	in := data(t, e.h, "GET", "/api/trade/instruments/"+url.PathEscape("FAKE:BTCUSDT.P"), "")
	if in["kind"] != "perp" || in["source"] != "fake" || in["digits"].(float64) != 1 {
		t.Fatalf("取一个 = %v", in)
	}
	for _, p := range []string{"/api/trade/instruments?market=forex", "/api/trade/instruments?kind=bond", "/api/trade/instruments?limit=0"} {
		if code, _ := call(t, e.h, "GET", p, ""); code != 400 {
			t.Errorf("%s = %d，应当 400", p, code)
		}
	}
	if code, _ := call(t, e.h, "GET", "/api/trade/instruments/FAKE:NOPE", ""); code != 404 {
		t.Errorf("没有的标的 = %d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/trade/sources/nope/sync", ""); code != 404 {
		t.Errorf("没有的源 = %d", code)
	}
}

// badSource 交回覆盖之外和格式不对的标的，或者直接出错
type badSource struct {
	FakeSource
	fail bool
}

func (b *badSource) ID() string { return "bad" }
func (b *badSource) Instruments(context.Context, string, string) ([]Instrument, error) {
	if b.fail {
		return nil, errors.New("连不上")
	}
	return []Instrument{
		{Symbol: "BAD:OK", Name: "好的", Market: "crypto", Kind: "spot", Venue: "Bad", Digits: 2, Lot: 1, Multiplier: 1},
		{Symbol: "bad:lower", Name: "小写", Market: "crypto", Kind: "spot", Venue: "Bad", Digits: 2, Lot: 1, Multiplier: 1},
		{Symbol: "BAD:US", Name: "覆盖外", Market: "us", Kind: "spot", Venue: "Bad", Digits: 2, Lot: 1, Multiplier: 1},
		{Symbol: "BAD:LOT", Name: "零手", Market: "crypto", Kind: "spot", Venue: "Bad", Digits: 2, Lot: 0, Multiplier: 1},
	}, nil
}

func TestSyncSkipsInvalid(t *testing.T) {
	e := setup(t, &badSource{})
	res := data(t, e.h, "POST", "/api/trade/sources/bad/sync", "")
	// 覆盖里有 spot、perp 两种，每种都交回同一批：只有 BAD:OK 能进
	if res["upserted"].(float64) != 2 || res["skipped"].(float64) != 6 || len(res["errors"].([]any)) != 6 {
		t.Fatalf("同步 = %v", res)
	}
	if n := len(list(t, e.h, "/api/trade/instruments")); n != 1 {
		t.Fatalf("标的 %d 个", n)
	}

	e2 := setup(t, &badSource{fail: true})
	code, out := call(t, e2.h, "POST", "/api/trade/sources/bad/sync", "")
	if code != http.StatusBadGateway || out["error"].(map[string]any)["code"] != "upstream" {
		t.Fatalf("源出错 = %d %v", code, out)
	}
}

func TestDisableHidesRoutes(t *testing.T) {
	e := setup(t)
	data(t, e.h, "POST", "/api/trade/watchlists", `{"name":"a"}`)
	if err := e.reg.Disable(context.Background(), "trade"); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, e.h, "GET", "/api/trade/watchlists", ""); code != 404 {
		t.Fatalf("停用后 = %d，应当 404", code)
	}
	if err := e.reg.Enable(context.Background(), "trade"); err != nil {
		t.Fatal(err)
	}
	if n := len(list(t, e.h, "/api/trade/watchlists")); n != 1 {
		t.Fatalf("重新启用后数据还在：%d", n)
	}
}

type badMarket struct{ FakeSource }

func (*badMarket) Coverage() []Coverage {
	return []Coverage{{Market: "forex", Kinds: []string{"spot"}}}
}

func TestNewRejectsBadSources(t *testing.T) {
	for name, srcs := range map[string][]Source{
		"重复 id":  {&FakeSource{}, &FakeSource{}},
		"不认识的市场": {&badMarket{}},
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("%s：应当 panic", name)
				}
			}()
			New(srcs...)
		}()
	}
}

func TestFakeSource(t *testing.T) {
	ctx := context.Background()
	at := time.Date(2026, 10, 29, 12, 34, 0, 0, time.UTC)
	f := &FakeSource{Now: func() time.Time { return at }}
	if err := checkSource(f); err != nil {
		t.Fatal(err)
	}
	a, err := f.Ticker(ctx, "FAKE:BTCUSDT")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := f.Ticker(ctx, "FAKE:BTCUSDT")
	if a.Last != b.Last || a.Last <= 0 || !(a.Bid < a.Last && a.Last < a.Ask) || a.High24h < a.Low24h {
		t.Fatalf("ticker = %+v", a)
	}
	ks, err := f.Klines(ctx, KlineQuery{Symbol: "FAKE:BTCUSDT", Interval: "1h", Limit: 5})
	if err != nil || len(ks) != 5 {
		t.Fatalf("klines = %v %v", ks, err)
	}
	for i, k := range ks {
		if k.High < k.Open || k.High < k.Close || k.Low > k.Open || k.Low > k.Close {
			t.Errorf("第 %d 根高低不对：%+v", i, k)
		}
		if i > 0 && k.Time.Sub(ks[i-1].Time) != time.Hour {
			t.Errorf("第 %d 根间隔不对", i)
		}
	}
	if !ks[4].Time.Equal(at.Truncate(time.Hour)) {
		t.Errorf("最后一根应当是当前这个小时：%v", ks[4].Time)
	}
	if _, err := f.Klines(ctx, KlineQuery{Symbol: "FAKE:BTCUSDT", Interval: "3m", Limit: 5}); !errors.Is(err, ErrUnsupported) {
		t.Errorf("不认识的周期：%v", err)
	}
	ob, err := f.OrderBook(ctx, "FAKE:ETHUSDT", 3)
	if err != nil || len(ob.Bids) != 3 || ob.Bids[0].Price <= ob.Bids[1].Price || ob.Asks[0].Price >= ob.Asks[1].Price || ob.Bids[0].Price >= ob.Asks[0].Price {
		t.Fatalf("盘口 = %+v %v", ob, err)
	}
	fr, err := f.Funding(ctx, "FAKE:BTCUSDT.P")
	if err != nil || fr.Rate == 0 || !fr.NextTime.After(at) {
		t.Fatalf("资金费率 = %+v %v", fr, err)
	}
	if _, err := f.Funding(ctx, "FAKE:BTCUSDT"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("现货没有资金费率：%v", err)
	}
	if _, err := f.Ticker(ctx, "FAKE:NOPE"); !errors.Is(err, ErrUnknownSymbol) {
		t.Errorf("没有的标的：%v", err)
	}
}

func TestCheckInstrument(t *testing.T) {
	f := &FakeSource{}
	ok := Instrument{Symbol: "FAKE:X", Name: "x", Market: "crypto", Kind: "spot", Venue: "Fake", Digits: 2, Lot: 1, Multiplier: 1}
	if err := checkInstrument(f, ok); err != nil {
		t.Fatal(err)
	}
	bad := []func(*Instrument){
		func(i *Instrument) { i.Symbol = "X" },
		func(i *Instrument) { i.Name = "" },
		func(i *Instrument) { i.Kind = "option"; i.Right = "call" }, // 假源不覆盖期权
		func(i *Instrument) { i.Right = "call" },
		func(i *Instrument) { i.Multiplier = 0 },
		func(i *Instrument) { i.Expiry = "2026/12/25" },
		func(i *Instrument) { i.Underlying = "btc" },
	}
	for n, mut := range bad {
		in := ok
		mut(&in)
		if checkInstrument(f, in) == nil {
			t.Errorf("第 %d 个应当不通过：%+v", n, in)
		}
	}
}
