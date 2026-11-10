// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package etf

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func TestManifestValid(t *testing.T) {
	m, err := plugin.Parse(manifestJSON)
	if err != nil {
		t.Fatalf("清单不合法：%v", err)
	}
	if m.ID != "etf" || m.TablePrefix != "etf_" {
		t.Fatalf("id=%s table_prefix=%s", m.ID, m.TablePrefix)
	}
	if !slices.Equal(m.Permissions, []string{"network:market-data"}) {
		t.Fatalf("权限只该有 network:market-data：%v", m.Permissions)
	}
	// 「盯盘」模块归交易插件 trade；宽基监控的页面另起模块 key etf，不能和 trade 抢 monitor
	if !slices.Equal(m.Provides.Modules, []string{"etf"}) {
		t.Fatalf("modules = %v", m.Provides.Modules)
	}
	if m.Version != "0.2.0" {
		t.Fatalf("version = %s", m.Version)
	}
}

// 资金边界：插件源码里不出现下单、撤单、划转、提币的路径，也不申请实盘和交易所权限
func TestNoTradingPaths(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	banned := []string{"/order", "withdraw", "transfer", "cancelorder", "placeorder", "http.defaultclient"}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		src := strings.ToLower(string(b))
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
	if err := r.Install(ctx, "etf", []string{"network:market-data"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "etf"); err != nil {
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

func TestCollectAndQuery(t *testing.T) {
	e := setup(t, NewFake())

	srcs := list(t, e.h, "/api/etf/sources")
	if len(srcs) != 1 || srcs[0].(map[string]any)["id"] != "fake" {
		t.Fatalf("sources = %v", srcs)
	}

	res := data(t, e.h, "POST", "/api/etf/collect", `{"date":"2026-11-02"}`)
	if res["upserted"].(float64) != 3 || res["skipped"].(float64) != 0 {
		t.Fatalf("采集 = %v", res)
	}
	res = data(t, e.h, "POST", "/api/etf/collect", `{"date":"2026-11-03"}`)
	if res["upserted"].(float64) != 3 {
		t.Fatalf("第二次采集 = %v", res)
	}

	if n := len(list(t, e.h, "/api/etf/funds")); n != 3 {
		t.Fatalf("宽基 %d 只", n)
	}
	f := data(t, e.h, "GET", "/api/etf/funds/510300", "")
	if f["name"] != "沪深300ETF" || f["secid"] != "1.510300" {
		t.Fatalf("取一只 = %v", f)
	}

	// 过滤到这两天，避开 Job 首跑写入的当天数据
	rows := list(t, e.h, "/api/etf/daily?symbol=510300&from=2026-11-02&to=2026-11-03")
	if len(rows) != 2 {
		t.Fatalf("日快照 %d 条：%v", len(rows), rows)
	}
	first := rows[0].(map[string]any) // 按日期倒序，11-03 在前
	if first["date"] != "2026-11-03" || first["symbol"] != "510300" {
		t.Fatalf("按日期倒序 = %v", first)
	}
	if first["aum"].(float64) <= 0 || first["shares"].(float64) <= 0 {
		t.Fatalf("规模和份额应当算出来：%v", first)
	}

	ch := list(t, e.h, "/api/etf/share-change?symbol=510300&days=2")
	if len(ch) != 2 {
		t.Fatalf("份额变动 %d 条", len(ch))
	}
	if ch[0].(map[string]any)["change"].(float64) != 0 {
		t.Fatalf("头一条不该有变动：%v", ch[0])
	}
	if ch[1].(map[string]any)["change"].(float64) == 0 {
		t.Fatalf("第二条应当有变动：%v", ch[1])
	}

	// 幂等：同一天再采集一次不新增
	data(t, e.h, "POST", "/api/etf/collect", `{"date":"2026-11-03"}`)
	if rows := list(t, e.h, "/api/etf/daily?symbol=510300&from=2026-11-02&to=2026-11-03"); len(rows) != 2 {
		t.Fatalf("重跑同一天不该变多：%d", len(rows))
	}

	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/etf/daily?limit=0", ""},
		{"GET", "/api/etf/daily?from=2026/11/02", ""},
		{"GET", "/api/etf/share-change", ""},
		{"GET", "/api/etf/share-change?symbol=510300&days=1", ""},
		{"POST", "/api/etf/collect", `{"date":"2026/11/02"}`},
		{"POST", "/api/etf/collect", `[]`},
	} {
		if code, out := call(t, e.h, c.method, c.path, c.body); code != 400 {
			t.Errorf("%s %s %s = %d %v，应当 400", c.method, c.path, c.body, code, out)
		}
	}
	if code, _ := call(t, e.h, "GET", "/api/etf/funds/NOPE", ""); code != 404 {
		t.Errorf("没有的宽基 = %d", code)
	}
}

func TestDisableHidesRoutes(t *testing.T) {
	e := setup(t, NewFake())
	data(t, e.h, "POST", "/api/etf/collect", `{"date":"2026-11-02"}`)
	if err := e.reg.Disable(context.Background(), "etf"); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, e.h, "GET", "/api/etf/funds", ""); code != 404 {
		t.Fatalf("停用后 = %d，应当 404", code)
	}
	if err := e.reg.Enable(context.Background(), "etf"); err != nil {
		t.Fatal(err)
	}
	if n := len(list(t, e.h, "/api/etf/funds")); n != 3 {
		t.Fatalf("重新启用后数据还在：%d", n)
	}
}

func TestParseKline(t *testing.T) {
	k, err := parseKline("2026-11-03,4.01,4.05,4.08,3.99,123456,498765432.00,2.25,1.00,0.04,0.55")
	if err != nil {
		t.Fatal(err)
	}
	if k.date != "2026-11-03" || k.open != 4.01 || k.close != 4.05 || k.high != 4.08 || k.low != 3.99 ||
		k.volume != 123456 || k.amount != 498765432 || k.amplitude != 2.25 || k.changePct != 1.00 ||
		k.changeAmount != 0.04 || k.turnoverRate != 0.55 {
		t.Fatalf("解析 = %+v", k)
	}
	if _, err := parseKline("2026-11-03,4.01"); err == nil {
		t.Error("字段不足应当报错")
	}
}

func TestParseFlexFloat(t *testing.T) {
	if v := parseFlexFloat(json.RawMessage(`123.5`)); v != 123.5 {
		t.Errorf("数字 = %v", v)
	}
	if v := parseFlexFloat(json.RawMessage(`"123.5"`)); v != 123.5 {
		t.Errorf("字符串 = %v", v)
	}
	for _, raw := range []string{`null`, `""`, `"-"`} {
		if v := parseFlexFloat(json.RawMessage(raw)); v != 0 {
			t.Errorf("%s = %v，应当 0", raw, v)
		}
	}
}
