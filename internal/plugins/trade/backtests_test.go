package trade

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// listedSource 是只有 since 之后才有 K 线的假源（模拟上市不久的标的），id 同 FakeSource。
type listedSource struct {
	FakeSource
	since time.Time
}

func (s *listedSource) Klines(ctx context.Context, q KlineQuery) ([]Kline, error) {
	ks, err := s.FakeSource.Klines(ctx, q)
	out := []Kline{}
	for _, k := range ks {
		if !k.Time.Before(s.since) {
			out = append(out, k)
		}
	}
	return out, err
}

type btEnv struct {
	h   http.Handler
	reg *plugin.Registry
	d   *db.DB
}

// setupAt 在指定库文件上装好插件；库里已经装过的（重启）只 Start。
func setupAt(t *testing.T, path string, fresh bool, sources ...Source) btEnv {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
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
	if fresh {
		if err := r.Install(ctx, "trade", []string{"network:market-data"}); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, "trade"); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{"code": "not_found", "message": "x"}})
	}) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return btEnv{h: mux, reg: r, d: d}
}

const emaStrategy = `{"name":"双均线","symbols":["FAKE:BTCUSDT"],"interval":"1h","direction":"long",
	"entry":{"logic":"all","rules":[{"id":"r1","left":{"kind":"ind","ind":"ema","params":[12]},"op":"cross_up","right":{"kind":"ind","ind":"ema","params":[48]}}]},
	"exit":{"logic":"any","rules":[{"id":"r2","left":{"kind":"ind","ind":"ema","params":[12]},"op":"cross_down","right":{"kind":"ind","ind":"ema","params":[48]}}]},
	"stop_loss":6,"position_pct":30,"params":{"fast":12,"slow":48},"tags":["趋势"]}`

func waitBacktest(t *testing.T, h http.Handler, id string) map[string]any {
	t.Helper()
	var b map[string]any
	waitFor(t, "回测 "+id+" 跑完", func() bool {
		b = data(t, h, "GET", "/api/trade/backtests/"+id, "")
		return b["status"] == "done" || b["status"] == "failed"
	})
	return b
}

func TestStrategyCRUD(t *testing.T) {
	e := setup(t)
	st := data(t, e.h, "POST", "/api/trade/strategies", `{}`)
	id, _ := st["id"].(string)
	if !strings.HasPrefix(id, "st_") || st["name"] != "新策略" || st["mode"] != "rules" || st["interval"] != "1h" || st["direction"] != "long" ||
		st["position_pct"].(float64) != 20 || len(st["symbols"].([]any)) != 0 || st["entry"].(map[string]any)["logic"] != "all" {
		t.Fatalf("新建的默认值不对：%v", st)
	}
	// 只改出现的字段；规则 id 空的由后端补
	st = data(t, e.h, "PATCH", "/api/trade/strategies/"+id, `{"name":" 双均线 ","symbols":["FAKE:BTCUSDT","FAKE:BTCUSDT"],"params":{"slow":48,"fast":12},
		"entry":{"logic":"all","rules":[{"id":"","left":{"kind":"ind","ind":"ema","params":[12]},"op":"cross_up","right":{"kind":"num","value":3}}]}}`)
	rules := st["entry"].(map[string]any)["rules"].([]any)
	if st["name"] != "双均线" || len(st["symbols"].([]any)) != 1 || st["interval"] != "1h" || !strings.HasPrefix(rules[0].(map[string]any)["id"].(string), "rl_") {
		t.Fatalf("PATCH 后 = %v", st)
	}
	// 参数表保持键的顺序
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/trade/strategies/"+id, nil))
	if !strings.Contains(rec.Body.String(), `"params":{"slow":48,"fast":12}`) {
		t.Fatalf("参数顺序没保住：%s", rec.Body.String())
	}
	for _, body := range []string{`{"name":""}`, `{"mode":"python"}`, `{"interval":"2h"}`, `{"stop_loss":-1}`, `{"symbols":["btc"]}`, `{"foo":1}`,
		`{"entry":{"logic":"all","rules":[{"id":"x","left":{"kind":"ind","ind":"kdj"},"op":"gt","right":{"kind":"num","value":1}}]}}`, `{"params":{"a":"x"}}`} {
		if code, out := call(t, e.h, "PATCH", "/api/trade/strategies/"+id, body); code != 400 {
			t.Errorf("%s = %d %v，应当 400", body, code, out)
		}
	}
	data(t, e.h, "POST", "/api/trade/strategies", `{"name":"第二个"}`)
	if l := list(t, e.h, "/api/trade/strategies"); len(l) != 2 || l[0].(map[string]any)["name"] != "第二个" {
		t.Fatalf("列表按更新时间新的在前：%v", l)
	}
	data(t, e.h, "DELETE", "/api/trade/strategies/"+id, "")
	if code, _ := call(t, e.h, "GET", "/api/trade/strategies/"+id, ""); code != 404 {
		t.Fatalf("删除后 = %d", code)
	}
}

func TestBacktestLifecycle(t *testing.T) {
	src := &FakeSource{}
	e := setup(t, src)
	data(t, e.h, "POST", "/api/trade/sources/fake/sync", "")
	st := data(t, e.h, "POST", "/api/trade/strategies", emaStrategy)
	sid := st["id"].(string)

	// 发起：校验
	for _, body := range []string{`{}`, `{"strategy_id":"st_nope"}`, `{"strategy_id":"` + sid + `","bars":10}`, `{"strategy_id":"` + sid + `","capital":0}`,
		`{"strategy_id":"` + sid + `","params":{"nope":1}}`, `{"strategy_id":"` + sid + `","foo":1}`} {
		if code, out := call(t, e.h, "POST", "/api/trade/backtests", body); code/100 != 4 {
			t.Errorf("%s = %d %v，应当 4xx", body, code, out)
		}
	}

	bt := data(t, e.h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":300,"params":{"fast":10}}`)
	id := bt["id"].(string)
	if !strings.HasPrefix(id, "bk_") || bt["name"] != "双均线 #1" || bt["status"] != "queued" {
		t.Fatalf("发起 = %v", bt)
	}
	cfg := bt["config"].(map[string]any)
	if cfg["fee_bp"].(float64) != 5 || cfg["capital"].(float64) != 100000 || cfg["interval"] != "1h" {
		t.Fatalf("默认配置 = %v", cfg)
	}
	if p, _ := json.Marshal(cfg["params"]); string(p) != `{"fast":10,"slow":48}` {
		t.Fatalf("参数覆盖 = %s", p)
	}
	// 发起之后改策略不影响快照
	data(t, e.h, "PATCH", "/api/trade/strategies/"+sid, `{"name":"改过的名字"}`)

	b := waitBacktest(t, e.h, id)
	if b["status"] != "done" || b["progress"].(float64) != 1 || b["data_from"] == "" || b["data_to"] == "" || b["finished_at"] == "" {
		t.Fatalf("完成后 = %v", b)
	}
	res := b["result"].(map[string]any)
	if n := len(res["equity"].([]any)); n != 300 {
		t.Fatalf("资金曲线 %d 个点，应当 300", n)
	}
	if b["strategy_snapshot"].(map[string]any)["name"] != "双均线" {
		t.Fatalf("快照被改了：%v", b["strategy_snapshot"])
	}
	// 和直接用同一段缓存 K 线跑引擎的结果一致
	var cfgGo BacktestConfig
	cj, _ := json.Marshal(b["config"])
	_ = json.Unmarshal(cj, &cfgGo)
	var stGo Strategy
	sj, _ := json.Marshal(b["strategy_snapshot"])
	_ = json.Unmarshal(sj, &stGo)
	to, _ := time.Parse(time.RFC3339, b["data_to"].(string))
	want := RunBacktest(cfgGo, stGo, BacktestData{
		Instrument: func(s string) (Instrument, bool) { return fakeInsts[0].Instrument, s == "FAKE:BTCUSDT" },
		Bars: func(s, iv string, n int) []Bar {
			end := to
			start := end.Add(-time.Duration(n-1) * time.Hour)
			ks, _ := src.Klines(context.Background(), KlineQuery{Symbol: s, Interval: iv, Limit: n, End: end})
			out := []Kline{}
			for _, k := range ks {
				if !k.Time.Before(start) {
					out = append(out, k)
				}
			}
			return BarsOf(out)
		},
	})
	stats := res["stats"].(map[string]any)
	if math.Abs(stats["total_return"].(float64)-want.Stats.TotalReturn) > 1e-9 || int(stats["trades"].(float64)) != want.Stats.Trades {
		t.Fatalf("统计 = %v，直接跑 = %+v", stats, want.Stats)
	}
	// 用到的 K 线进了缓存：同一段再查不请求交易所
	if m, bars := meta(t, e.h, "/api/trade/klines?symbol=FAKE:BTCUSDT&interval=1h&limit=444&end="+b["data_to"].(string)); m["cached"] != true || len(bars) != 444 {
		t.Fatalf("K 线没进缓存：%v %d 根", m, len(bars))
	}

	// 列表：不带资金曲线，带统计
	l := list(t, e.h, "/api/trade/backtests?strategy_id="+sid)
	brief := l[0].(map[string]any)
	if len(l) != 1 || brief["stats"] == nil || brief["result"] != nil {
		t.Fatalf("列表 = %v", l)
	}

	// 参数扫描：同一段数据，结果留在这条上；扫当前值和正式回测一致
	if code, out := call(t, e.h, "POST", "/api/trade/backtests/"+id+"/sweep", `{"param":"fast","values":[10,"x"]}`); code != 400 {
		t.Fatalf("取值里有非数字 = %d %v，应当 400", code, out)
	}
}

func TestBacktestSweepRerunCompare(t *testing.T) {
	e := setup(t, &FakeSource{})
	data(t, e.h, "POST", "/api/trade/sources/fake/sync", "")
	sid := data(t, e.h, "POST", "/api/trade/strategies", emaStrategy)["id"].(string)
	id := data(t, e.h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":200}`)["id"].(string)
	b := waitBacktest(t, e.h, id)
	total := b["result"].(map[string]any)["stats"].(map[string]any)["total_return"].(float64)

	sw := data(t, e.h, "POST", "/api/trade/backtests/"+id+"/sweep", `{"param":"fast","values":[12,8,8,20]}`)
	pts := sw["points"].([]any)
	if sw["param"] != "fast" || len(pts) != 3 || math.Abs(pts[0].(map[string]any)["total_return"].(float64)-total) > 1e-12 {
		t.Fatalf("扫描 = %v，当前值的收益应当是 %v", sw, total)
	}
	if got := data(t, e.h, "GET", "/api/trade/backtests/"+id, ""); got["sweep"].(map[string]any)["param"] != "fast" {
		t.Fatalf("扫描结果没留下：%v", got["sweep"])
	}
	for _, body := range []string{`{"param":"nope","values":[1]}`, `{"param":"fast","values":[]}`, `{"param":"fast"}`} {
		if code, out := call(t, e.h, "POST", "/api/trade/backtests/"+id+"/sweep", body); code != 400 {
			t.Errorf("%s = %d %v", body, code, out)
		}
	}

	// 重跑：按扫描的一个值发起，名字顺延；策略删了照样能重跑（用快照）
	re := data(t, e.h, "POST", "/api/trade/backtests/"+id+"/rerun", `{"params":{"fast":8}}`)
	if re["name"] != "双均线 #2" {
		t.Fatalf("重跑 = %v", re)
	}
	if p, _ := json.Marshal(re["config"].(map[string]any)["params"]); string(p) != `{"fast":8,"slow":48}` {
		t.Fatalf("重跑的参数 = %s", p)
	}
	re2 := waitBacktest(t, e.h, re["id"].(string))
	if math.Abs(re2["result"].(map[string]any)["stats"].(map[string]any)["total_return"].(float64)-pts[1].(map[string]any)["total_return"].(float64)) > 1e-9 {
		// 重跑用最新数据，区间可能往后挪了一根；只在同一小时内比较
		if re2["data_to"] == b["data_to"] {
			t.Fatalf("重跑结果和扫描不一致：%v %v", re2["result"].(map[string]any)["stats"], pts[1])
		}
	}
	data(t, e.h, "DELETE", "/api/trade/strategies/"+sid, "")
	re3 := data(t, e.h, "POST", "/api/trade/backtests/"+id+"/rerun", "")
	if re3["name"] != "双均线 #3" || re3["strategy_snapshot"].(map[string]any)["name"] != "双均线" {
		t.Fatalf("策略删了之后重跑 = %v", re3)
	}
	waitBacktest(t, e.h, re3["id"].(string))

	// 对比：2 到 4 条已完成的
	cmp := list(t, e.h, "/api/trade/backtests/compare?ids="+id+","+re["id"].(string))
	if len(cmp) != 2 || len(cmp[0].(map[string]any)["result"].(map[string]any)["equity"].([]any)) != 200 {
		t.Fatalf("对比 = %d 条", len(cmp))
	}
	if code, _ := call(t, e.h, "GET", "/api/trade/backtests/compare?ids="+id, ""); code != 400 {
		t.Fatalf("一条不能对比：%d", code)
	}
	// 删除
	data(t, e.h, "DELETE", "/api/trade/backtests/"+id, "")
	if code, _ := call(t, e.h, "GET", "/api/trade/backtests/"+id, ""); code != 404 {
		t.Fatalf("删除后 = %d", code)
	}
	if l := list(t, e.h, "/api/trade/backtests"); len(l) != 2 {
		t.Fatalf("剩 %d 条", len(l))
	}
}

func TestBacktestDataMissing(t *testing.T) {
	since := alignOpen(time.Now(), "1h").Add(-100 * time.Hour)
	e := setup(t, &listedSource{since: since})
	data(t, e.h, "POST", "/api/trade/sources/fake/sync", "")
	sid := data(t, e.h, "POST", "/api/trade/strategies", emaStrategy)["id"].(string)

	// 区间要 300 根，交易所只有约 99 根收盘的：失败，写明缺哪段
	b := waitBacktest(t, e.h, data(t, e.h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":300}`)["id"].(string))
	msg, _ := b["error"].(string)
	if b["status"] != "failed" || !strings.HasPrefix(msg, "数据缺失：") || !strings.Contains(msg, "FAKE:BTCUSDT 1h 要最近 300 根") || !strings.Contains(msg, "缺 ") {
		t.Fatalf("数据不够 = %v %q", b["status"], msg)
	}
	// 区间够、只是预热不够：照跑，note 里写明
	b = waitBacktest(t, e.h, data(t, e.h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":60}`)["id"].(string))
	if b["status"] != "done" || !strings.Contains(b["result"].(map[string]any)["note"].(string), "指标预热少了") {
		t.Fatalf("预热不够 = %v %v", b["status"], b["error"])
	}

	// 没有行情源的市场
	data(t, e.h, "PATCH", "/api/trade/strategies/"+sid, `{"symbols":["NASDAQ:AAPL"]}`)
	b = waitBacktest(t, e.h, data(t, e.h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":60}`)["id"].(string))
	if !strings.Contains(b["error"].(string), "NASDAQ:AAPL 的行情源还没接") {
		t.Fatalf("没有源 = %v", b["error"])
	}
	// 标的表里没有
	data(t, e.h, "PATCH", "/api/trade/strategies/"+sid, `{"symbols":["FAKE:DOGEUSDT"]}`)
	b = waitBacktest(t, e.h, data(t, e.h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":60}`)["id"].(string))
	if !strings.Contains(b["error"].(string), "标的表里没有 FAKE:DOGEUSDT") {
		t.Fatalf("没有标的 = %v", b["error"])
	}
}

func TestBacktestSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pm.db")
	e := setupAt(t, path, true, &FakeSource{})
	data(t, e.h, "POST", "/api/trade/sources/fake/sync", "")
	sid := data(t, e.h, "POST", "/api/trade/strategies", emaStrategy)["id"].(string)
	done := data(t, e.h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":100}`)["id"].(string)
	waitBacktest(t, e.h, done)
	// 模拟进程挂掉时正在跑的一条
	snap, _ := json.Marshal(newStrategy())
	if _, err := e.d.W.Exec(`INSERT INTO trade_backtests (id, strategy_id, seq, name, config, status, progress, strategy_snapshot, created_at)
		VALUES ('bk_stale', ?, 9, '双均线 #9', '{"strategy_id":"x","symbols":["FAKE:BTCUSDT"],"interval":"1h","bars":100,"capital":1,"fee_bp":0,"slippage_ticks":0,"params":{}}', 'running', 0.4, ?, '2026-01-01T00:00:00.000Z')`,
		sid, string(snap)); err != nil {
		t.Fatal(err)
	}
	e.reg.Close()
	_ = e.d.Close()

	e2 := setupAt(t, path, false, &FakeSource{})
	t.Cleanup(e2.reg.Close)
	t.Cleanup(func() { _ = e2.d.Close() })
	var stale map[string]any
	waitFor(t, "重启后运行中的标为失败", func() bool {
		stale = data(t, e2.h, "GET", "/api/trade/backtests/bk_stale", "")
		return stale["status"] == "failed"
	})
	if !strings.Contains(stale["error"].(string), "可以重新回测") {
		t.Fatalf("中断原因 = %v", stale["error"])
	}
	b := data(t, e2.h, "GET", "/api/trade/backtests/"+done, "")
	if b["status"] != "done" || len(b["result"].(map[string]any)["equity"].([]any)) != 100 {
		t.Fatalf("重启后完成的结果还在：%v", b["status"])
	}
	// 中断的可以重跑
	re := data(t, e2.h, "POST", "/api/trade/backtests/bk_stale/rerun", "")
	if re["status"] != "queued" || re["name"] != "双均线 #10" {
		t.Fatalf("重跑 = %v", re)
	}
}

// slowSource 取 K 线时一直等到请求被取消，用来造「跑到一半」。
type slowSource struct{ FakeSource }

func (s *slowSource) Klines(ctx context.Context, _ KlineQuery) ([]Kline, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestBacktestAbortOnDisable(t *testing.T) {
	e := setup(t, &slowSource{})
	data(t, e.h, "POST", "/api/trade/sources/fake/sync", "")
	sid := data(t, e.h, "POST", "/api/trade/strategies", emaStrategy)["id"].(string)
	id := data(t, e.h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":100}`)["id"].(string)
	waitFor(t, "开始跑", func() bool { return data(t, e.h, "GET", "/api/trade/backtests/"+id, "")["status"] == "running" })
	// 同时最多跑 2 个，第 3 个排队
	data(t, e.h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":100}`)
	third := data(t, e.h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":100}`)["id"].(string)
	time.Sleep(200 * time.Millisecond)
	if st := data(t, e.h, "GET", "/api/trade/backtests/"+third, "")["status"]; st != "queued" {
		t.Fatalf("第 3 个 = %v，应当排队", st)
	}
	if err := e.reg.Disable(context.Background(), "trade"); err != nil {
		t.Fatal(err)
	}
	if err := e.reg.Enable(context.Background(), "trade"); err != nil {
		t.Fatal(err)
	}
	b := data(t, e.h, "GET", "/api/trade/backtests/"+id, "")
	if b["status"] != "failed" || !strings.HasPrefix(b["error"].(string), "回测被中断：") {
		t.Fatalf("停用后 = %v %v", b["status"], b["error"])
	}
}
