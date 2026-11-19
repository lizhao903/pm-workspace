// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugins/trade/ta"
)

// TRD-10：K 线接口附带指标、指标目录、策略的通达信口径指标、盯盘提醒的指标条件。

func lookupDef(t *testing.T, name string) ta.Def {
	t.Helper()
	d, ok := ta.Lookup(name)
	if !ok {
		t.Fatalf("没有指标 %s", name)
	}
	return d
}

func TestKlinesWithIndicators(t *testing.T) {
	e := setupAlerts(t)
	h := e.h
	base := "/api/trade/klines?symbol=FAKE:BTCUSDT&interval=1h&limit=50"

	// 不带 indicators：响应和以前一样，没有 indicators 键
	if m, _ := meta(t, h, base); m["indicators"] != nil {
		t.Fatalf("没要指标却带了：%v", m["indicators"])
	}
	// 带了但为空：空列表
	if m, _ := meta(t, h, base+"&indicators="); len(m["indicators"].([]any)) != 0 || m["status"] != "live" {
		t.Fatalf("空指标 = %v", m)
	}

	code, out := call(t, h, "GET", base+"&indicators=ma(5),MACD,BOLL(20,2.5),MA(5)", "")
	if code != 200 {
		t.Fatalf("带指标 = %d %v", code, out)
	}
	bars := out["data"].([]any)
	inds := out["meta"].(map[string]any)["indicators"].([]any)
	if len(bars) != 50 || len(inds) != 3 {
		t.Fatalf("%d 根 K 线、%d 个指标（MA(5) 重复只算一次）", len(bars), len(inds))
	}
	ma := inds[0].(map[string]any)
	if ma["spec"] != "MA(5)" || ma["name"] != "MA" || ma["overlay"] != true || ma["warmup"] != inds[1].(map[string]any)["warmup"] {
		t.Fatalf("MA = %v", ma)
	}
	vals := ma["lines"].([]any)[0].(map[string]any)["values"].([]any)
	if len(vals) != 50 || vals[0] != 1.0 || vals[49] != 1.0 {
		t.Fatalf("MA(5) 的值（收盘全是 1，有预热第一根就有值）= %v", vals[:3])
	}
	macd := inds[1].(map[string]any)
	lines := macd["lines"].([]any)
	if macd["spec"] != "MACD(12,26,9)" || macd["overlay"] != false || len(lines) != 3 || lines[2].(map[string]any)["key"] != "MACD" {
		t.Fatalf("MACD = %v", macd)
	}
	// 预热按这次几个指标里要得最多的取（不超过上限），各指标相同
	if w := macd["warmup"].(float64); w != float64(min(maxIndicatorWarm, lookupDef(t, "MACD").Warm(nil))) {
		t.Fatalf("MACD 预热 %v", w)
	}
	if inds[2].(map[string]any)["spec"] != "BOLL(20,2.5)" {
		t.Fatalf("BOLL = %v", inds[2])
	}

	for _, q := range []string{"FOO", "MA(0)", "MA(5", "MA(1),MA(2),MA(3),MA(4),MA(5),MA(6),MA(7),MA(8),MA(9)", "BOLL(20,0)", "RSI(14.5)"} {
		if code, out := call(t, h, "GET", base+"&indicators="+q, ""); code != 400 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "indicators") {
			t.Errorf("%s = %d %v，应当 400", q, code, out)
		}
	}

	// 指标目录
	cat := data(t, h, "GET", "/api/trade/indicators", "")
	if len(cat["indicators"].([]any)) != len(ta.Defs()) || cat["max_per_request"] != float64(ta.MaxCalls) {
		t.Fatalf("目录 = %v", cat)
	}
	ops := cat["operands"].([]any)
	if len(ops) != len(Indicators) || ops[0].(map[string]any)["basis"] != "prototype" || ops[len(ops)-1].(map[string]any)["basis"] != "tdx" {
		t.Fatalf("操作数 = %v", ops)
	}
}

func TestStrategyTAIndicators(t *testing.T) {
	g := loadGolden(t)
	bs := g.Bars["BINANCE:ETHUSDT|1h"]
	b := ohlcvOf(bs)
	k, d, _ := ta.KDJ(b.C, b.H, b.L, 9, 3, 3)
	got := Series(Ind("kdj_k", 9, 3, 3), bs)
	got2 := Series(Ind("kdj_d"), bs) // 不给参数用默认
	for i := range k {
		if !(got[i] == k[i] || math.IsNaN(got[i]) && math.IsNaN(k[i])) || !(got2[i] == d[i] || math.IsNaN(got2[i]) && math.IsNaN(d[i])) {
			t.Fatalf("第 %d 根 kdj_k %v / %v，kdj_d %v / %v", i, got[i], k[i], got2[i], d[i])
		}
	}
	if w := warmOf(Ind("kdj_k", 9, 3, 3)); w != lookupDef(t, "KDJ").Warm([]float64{9, 3, 3}) || w < 9 {
		t.Fatalf("kdj_k 预热 %d", w)
	}
	// 原有的九个口径不变：rsi 还是原型的 Wilder，不是通达信的中国式 SMA
	if a, b := Series(Ind("rsi", 14), bs), ta.RSI(b.C, 14); a[100] == b[100] {
		t.Fatal("原有的 rsi 不该换成通达信口径")
	}
	// 扫参换出来不合法的参数不报错，按范围兜底
	if xs := Series(Ind("wr", 0), bs); math.IsNaN(xs[len(xs)-1]) {
		t.Fatal("wr(0) 应当按 1 算")
	}

	st := Strategy{Name: "x", Mode: "rules", Interval: "1h", Direction: "long", Symbols: []string{"BINANCE:ETHUSDT"},
		Entry: RuleGroup{Logic: "all", Rules: []Rule{{ID: "r1", Left: Ind("kdj_k", 9, 3, 3), Op: "cross_up", Right: Ind("kdj_d", 9, 3, 3)}}},
		Exit:  RuleGroup{Logic: "any", Rules: []Rule{{ID: "r2", Left: Ind("wr"), Op: "lt", Right: Num(20)}}}, PositionPct: 50}
	if err := st.Validate(); err != nil {
		t.Fatalf("合法的策略被拒：%v", err)
	}
	for _, bad := range []Operand{Ind("kdj_k", 0), Ind("macd_dif", 12, 26, 9, 1), Ind("boll_mid", 20, 20), Ind("rsi_x")} {
		st.Entry.Rules[0].Left = bad
		if err := st.Validate(); err == nil {
			t.Errorf("%v 应当被拒", bad)
		}
	}
	// 原有九个的参数仍不校验范围（兼容已存的策略）
	st.Entry.Rules[0].Left = Ind("ma", 0)
	if err := st.Validate(); err != nil {
		t.Fatalf("原有指标不该新加校验：%v", err)
	}
}

func TestAlertIndicatorConds(t *testing.T) {
	e := setupAlerts(t)
	h := e.h
	bad := map[string]string{
		"没有指标":   `{"symbol":"FAKE:BTCUSDT","cond":"ind_above","value":1,"interval":"1h"}`,
		"没有周期":   `{"symbol":"FAKE:BTCUSDT","cond":"ind_above","value":1,"indicator":{"kind":"ind","ind":"ma","params":[5]}}`,
		"周期不认识":  `{"symbol":"FAKE:BTCUSDT","cond":"ind_above","value":1,"interval":"2h","indicator":{"kind":"ind","ind":"ma","params":[5]}}`,
		"指标不认识":  `{"symbol":"FAKE:BTCUSDT","cond":"ind_above","value":1,"interval":"1h","indicator":{"kind":"ind","ind":"foo","params":[]}}`,
		"参数越界":   `{"symbol":"FAKE:BTCUSDT","cond":"ind_above","value":1,"interval":"1h","indicator":{"kind":"ind","ind":"kdj_k","params":[0]}}`,
		"参数太大":   `{"symbol":"FAKE:BTCUSDT","cond":"ind_above","value":1,"interval":"1h","indicator":{"kind":"ind","ind":"ma","params":[5000]}}`,
		"指标不是对象": `{"symbol":"FAKE:BTCUSDT","cond":"ind_above","value":1,"interval":"1h","indicator":"rsi"}`,
	}
	for name, body := range bad {
		if code, out := call(t, h, "POST", "/api/trade/alerts", body); code != 400 {
			t.Errorf("%s = %d %v，应当 400", name, code, out)
		}
	}
	// 别的条件带了指标、周期：清掉
	p := data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT","cond":"price_above","value":1000,"interval":"1h","indicator":{"kind":"ind","ind":"ma","params":[5]}}`)
	if p["indicator"] != nil || p["interval"] != "" {
		t.Fatalf("价格条件不该存指标：%v", p)
	}
	// 收盘全是 1：MA(5) = 1。高于 0.5 触发；上穿 0.5 不触发（上一根也在上面）；低于 0.5 不触发
	above := data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT","cond":"ind_above","value":0.5,"interval":"1h","indicator":{"ind":"ma","params":[5]}}`)
	if ind := above["indicator"].(map[string]any); ind["kind"] != "ind" || ind["ind"] != "ma" || above["interval"] != "1h" {
		t.Fatalf("新建 = %v", above)
	}
	data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT","cond":"ind_cross_up","value":0.5,"interval":"1h","indicator":{"kind":"ind","ind":"ma","params":[5]}}`)
	data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT","cond":"ind_below","value":0.5,"interval":"15m","indicator":{"kind":"ind","ind":"kdj_k","params":[9,3,3]}}`)
	waitFor(t, "指标提醒触发", func() bool { evs, _ := eventsOf(t, h, ""); return len(evs) >= 1 })
	time.Sleep(300 * time.Millisecond)
	evs, _ := eventsOf(t, h, "")
	if len(evs) != 1 || evs[0]["alert_id"] != above["id"] || evs[0]["text"] != "BTCUSDT 1h MA(5) 1.00，高于 0.50" || evs[0]["value"] != 1.0 {
		t.Fatalf("触发记录 = %v", evs)
	}
	// 当前值：三条都算出来了（KDJ 在收盘全相等时 RSV 除以 0，算不出，标 unavailable）
	vs := list(t, h, "/api/trade/alerts/values")
	st := map[string]string{}
	for _, x := range vs {
		v := x.(map[string]any)
		st[v["cond"].(string)] = v["status"].(string)
	}
	if st["ind_above"] != "ok" || st["ind_cross_up"] != "ok" || st["ind_below"] != "unavailable" {
		t.Fatalf("当前值状态 = %v", st)
	}
	// 预览
	if v := data(t, h, "GET", "/api/trade/alerts/preview?symbol=FAKE:BTCUSDT&cond=ind_above&ind=ma&params=5&interval=1h", ""); v["status"] != "ok" || v["value"] != 1.0 {
		t.Fatalf("预览 = %v", v)
	}
	for _, q := range []string{"&ind=ma&params=5", "&ind=nope&interval=1h", "&ind=ma&params=x&interval=1h"} {
		if code, _ := call(t, h, "GET", "/api/trade/alerts/preview?symbol=FAKE:BTCUSDT&cond=ind_above"+q, ""); code != 400 {
			t.Errorf("预览 %s 应当 400", q)
		}
	}
	// 单次提醒改了指标重新上膛
	if a := data(t, h, "PATCH", "/api/trade/alerts/"+above["id"].(string), `{"indicator":{"kind":"ind","ind":"ma","params":[10]}}`); a["last_fired_at"] != "" {
		t.Fatalf("改指标应当重新上膛：%v", a)
	}
}

// 指标条件的判定：上穿要上一根在阈值下面。
func TestAlertIndCross(t *testing.T) {
	inst := &AlertInst{Symbol: "X:Y", Name: "Y", Kind: "spot", Digits: 2}
	op := Ind("rsi", 14)
	a := Alert{ID: "a", Symbol: "X:Y", Cond: "ind_cross_up", Value: 70, Enabled: true, Indicator: &op, Interval: "1h"}
	at := time.Now()
	hit := func(cur, prev float64) bool {
		return len(evalAlerts([]Alert{a}, at, func(Alert) (AlertInput, bool) {
			return AlertInput{Inst: inst, Last: 1, Ind: cur, IndPrev: prev}, true
		})) == 1
	}
	if !hit(71, 69) || hit(71, 70.5) || hit(69, 65) || hit(71, math.NaN()) {
		t.Fatal("上穿判定不对")
	}
	a.Cond = "ind_cross_down"
	a.Value = 30
	if !hit(29, 31) || hit(29, 29.5) {
		t.Fatal("下穿判定不对")
	}
	hs := evalAlerts([]Alert{a}, at, func(Alert) (AlertInput, bool) { return AlertInput{Inst: inst, Last: 1, Ind: 29, IndPrev: 31}, true })
	if hs[0].Text != "Y 1h RSI(14) 29.00，下穿 30" {
		t.Fatalf("说明 = %q", hs[0].Text)
	}
}
