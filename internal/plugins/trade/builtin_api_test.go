// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"math"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// 内置策略（TRD-09）的接口：目录、建策略补默认值、校验、回测区间、网格扫描、只能部署到模拟盘、模拟盘按信号开首笔。
func TestBuiltinStrategyAPIAndDeploy(t *testing.T) {
	fastPaper(t)
	fixture, _ := loadATGolden(t)
	// 行情：fixture 的收盘价按 3m 排到「现在」之前，K 线只有收盘价（高低开收相同）
	b, _ := builtinOf("kdj-short-1h3m")
	closeOnly := make([]Bar, len(fixture))
	for i, x := range fixture {
		closeOnly[i] = Bar{T: int64(i) * 180000, O: x.C, H: x.C, L: x.C, C: x.C, V: 1}
	}
	sig := builtinSignals(b, b.defaults(), closeOnly, "")
	k := -1
	for i := b.WarmBars + 100; i < len(sig.buy); i++ {
		if sig.buy[i] {
			k = i
			break
		}
	}
	if k < 0 {
		t.Fatal("对照 K 线里找不到买入信号")
	}
	now := time.Now().UTC()
	t0 := alignOpen(now.Add(-time.Duration(k+30)*3*time.Minute), "1h") // 整点对齐，聚出来的 1h 和 fixture 一样
	at := func(i int) time.Time { return t0.Add(time.Duration(i) * 3 * time.Minute) }
	clock := newTestClock(at(k).Add(10 * time.Second)) // 第 k-1 根刚收盘
	var mu sync.Mutex
	crash := 0.0 // 非 0 时第 k 根之后都收这个价
	src := &paperSrc{price: map[string]float64{"FAKE:BTCUSDT": fixture[k].C, "FAKE:BTCUSDT.P": fixture[k].C}, clock: clock}
	src.closes = func(_ string, open time.Time) float64 {
		mu.Lock()
		defer mu.Unlock()
		i := int(open.Sub(t0) / (3 * time.Minute))
		if crash > 0 && i > k {
			return crash
		}
		return fixture[min(max(i, 0), len(fixture)-1)].C
	}
	e := setupPaperAt(t, filepath.Join(t.TempDir(), "pm.db"), true, src)
	t.Cleanup(func() { e.reg.Close(); _ = e.d.Close() })
	h := e.h

	cat := list(t, h, "/api/trade/strategy-builtins")
	if len(cat) != 2 || cat[0].(map[string]any)["id"] != "kdj-short-1h3m" || len(cat[0].(map[string]any)["params"].([]any)) != len(b.Params) {
		t.Fatalf("内置策略目录 = %v", cat)
	}
	// 建策略：只给 mode、builtin、标的和权重，其余取内置默认
	st := data(t, h, "POST", "/api/trade/strategies", `{"mode":"builtin","builtin":"kdj-short-1h3m","symbols":["FAKE:BTCUSDT"],"symbol_weights":{"FAKE:BTCUSDT":2,"FAKE:ETHUSDT":1}}`)
	sid := st["id"].(string)
	ps := st["params"].(map[string]any)
	if st["interval"] != "3m" || st["direction"] != "long" || st["stop_loss"] != 4.5 || st["take_profit"] != 6.5 || st["position_pct"] != 100.0 ||
		st["name"] != b.Name || ps["oversold"] != 20.0 || ps["pyramid_first_pct"] != 40.0 || len(ps) != len(b.Params) {
		t.Fatalf("内置策略默认值 = %v", st)
	}
	if w := st["symbol_weights"].(map[string]any); len(w) != 1 || w["FAKE:BTCUSDT"] != 2.0 {
		t.Fatalf("不在标的里的权重应当去掉：%v", w)
	}
	for _, body := range []string{
		`{"mode":"builtin","builtin":"nope"}`,
		`{"mode":"builtin","builtin":"kdj-short-1h3m","params":{"oversold":200}}`,
		`{"mode":"builtin","builtin":"kdj-short-1h3m","params":{"fast":12}}`,
		`{"mode":"rules","symbols":["FAKE:BTCUSDT"],"symbol_weights":{"FAKE:BTCUSDT":-1}}`,
	} {
		if code, out := call(t, h, "POST", "/api/trade/strategies", body); code != 400 {
			t.Errorf("%s = %d %v，应当 400", body, code, out)
		}
	}
	// PATCH 改周期不生效（内置策略的周期固定）
	if p := data(t, h, "PATCH", "/api/trade/strategies/"+sid, `{"interval":"1h","params":{"oversold":15}}`); p["interval"] != "3m" ||
		p["params"].(map[string]any)["oversold"] != 15.0 || p["params"].(map[string]any)["overbought"] != 78.0 {
		t.Fatalf("PATCH 后 = %v", p)
	}
	data(t, h, "PATCH", "/api/trade/strategies/"+sid, `{"params":{"oversold":20}}`)

	// 回测：start、end 算根数；周期只能 3m；参数越界 400
	bt := data(t, h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","start":"2024-06-01","end":"2024-09-01","capital":1000}`)
	if c := bt["config"].(map[string]any); c["bars"] != 44160.0 || c["start"] != "2024-06-01" || c["end"] != "2024-09-01" {
		t.Fatalf("按区间算根数 = %v", c)
	}
	data(t, h, "DELETE", "/api/trade/backtests/"+bt["id"].(string), "")
	for _, body := range []string{
		`{"strategy_id":"` + sid + `","interval":"1h"}`,
		`{"strategy_id":"` + sid + `","params":{"oversold":0}}`,
		`{"strategy_id":"` + sid + `","start":"2024-09-01","end":"2024-06-01"}`,
		`{"strategy_id":"` + sid + `","start":"2024-06-01"}`,
		`{"strategy_id":"` + sid + `","bars":300000}`,
	} {
		if code, out := call(t, h, "POST", "/api/trade/backtests", body); code != 400 {
			t.Errorf("%s = %d %v，应当 400", body, code, out)
		}
	}
	bt = data(t, h, "POST", "/api/trade/backtests", `{"strategy_id":"`+sid+`","bars":500,"fee_bp":0,"slippage_ticks":0}`)
	var done map[string]any
	waitFor(t, "回测跑完", func() bool {
		done = data(t, h, "GET", "/api/trade/backtests/"+bt["id"].(string), "")
		return done["status"] == "done" || done["status"] == "failed"
	})
	if done["status"] != "done" || done["result"].(map[string]any)["per_symbol"] == nil {
		t.Fatalf("内置策略回测 = %v %v", done["status"], done["error"])
	}
	// 网格扫描
	sw := data(t, h, "POST", "/api/trade/backtests/"+bt["id"].(string)+"/sweep", `{"grid":{"oversold":[15,20],"stop_loss":[3,4.5,6]}}`)
	if pts := sw["points"].([]any); len(pts) != 6 || sw["param"] != "oversold" || len(sw["grid"].([]any)) != 2 ||
		pts[5].(map[string]any)["params"].(map[string]any)["stop_loss"] != 6.0 {
		t.Fatalf("网格扫描 = %v", sw)
	}
	for _, body := range []string{
		`{"grid":{"oversold":[0]}}`,
		`{"grid":{"nope":[1]}}`,
		`{"grid":{"a":[1],"b":[1],"c":[1],"d":[1],"e":[1]}}`,
		`{"param":"oversold","values":[15],"grid":{"oversold":[15]}}`,
	} {
		if code, out := call(t, h, "POST", "/api/trade/backtests/"+bt["id"].(string)+"/sweep", body); code != 400 {
			t.Errorf("扫描 %s = %d %v，应当 400", body, code, out)
		}
	}

	// 部署：实盘账户不行；模拟盘按信号开首笔 40%
	if _, err := e.d.W.Exec(`INSERT INTO trade_accounts (id, name, paper, initial_e8, created_at, updated_at) VALUES ('ac_live', '实盘', 0, 1, 'x', 'x')`); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"ac_live","capital":1000}`); code < 400 {
		t.Fatalf("内置策略部署到实盘 = %d %v，应当被拒", code, out)
	}
	aid := e.account(t, `{"initial":100000,"fee_bp":0,"slippage_ticks":0}`)
	if code, out := call(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"`+aid+`","capital":20000,"params":{"oversold":500}}`); code != 400 {
		t.Fatalf("部署参数越界 = %d %v", code, out)
	}
	run := data(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"`+aid+`","capital":20000}`)
	rid := run["id"].(string)
	clock.advance(3 * time.Minute) // 第 k 根收盘
	var r map[string]any
	for i := 0; i < 60; i++ {
		r = data(t, h, "GET", "/api/trade/runs/"+rid, "")
		if strings.Contains(runLogs(r), "成交：") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	want := math.Floor(20000*0.4/fixture[k].C/0.0001) * 0.0001
	hs := r["holdings"].([]any)
	if !strings.Contains(runLogs(r), "买入信号，开多（首笔 40%）") || len(hs) != 1 || math.Abs(hs[0].(map[string]any)["qty"].(float64)-want) > 1e-9 {
		t.Fatalf("开首笔：日志 %s 持仓 %v，要 %v", runLogs(r), hs, want)
	}
	ep, err := e.p.runs.episode(t.Context(), rid, "FAKE:BTCUSDT")
	if err != nil || ep.buys != 1 || math.Abs(ep.first-fixture[k].C) > 0.05 {
		t.Fatalf("持仓轮次 = %+v %v", ep, err)
	}
	// 下一根跌 3%：开仓不满 20 根，只认应急止损 2.5%，按市价平掉
	mu.Lock()
	crash = math.Round(fixture[k].C*0.97*10) / 10
	mu.Unlock()
	src.set("FAKE:BTCUSDT", crash)
	clock.advance(3 * time.Minute)
	waitFor(t, "应急止损平仓", func() bool {
		r = data(t, h, "GET", "/api/trade/runs/"+rid, "")
		return strings.Count(runLogs(r), "成交：") == 2
	})
	if !strings.Contains(runLogs(r), "应急止损 2.5%") || len(r["holdings"].([]any)) != 0 {
		t.Fatalf("应急止损：%s", runLogs(r))
	}
	if ep, _ := e.p.runs.episode(t.Context(), rid, "FAKE:BTCUSDT"); ep.buys != 0 {
		t.Fatalf("清仓后持仓轮次应当清空：%+v", ep)
	}
}
