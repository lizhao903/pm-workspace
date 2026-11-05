package etf

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// ---------- 指标计算（纯函数） ----------

func days(n int) []dayPoint {
	out := make([]dayPoint, n)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := range out {
		out[i] = dayPoint{date: base.AddDate(0, 0, i).Format(time.DateOnly), shares: 100, nav: 1, price: 1, amount: 100, aum: 100, basis: "nav"}
	}
	return out
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestAmountRatioExcludesToday(t *testing.T) {
	s := days(21)
	s[20].amount = 300
	m := computeMetrics(s, nil)
	// 去掉当日：300 / 100 = 3；把当日算进均值会是 300 / 110 ≈ 2.73
	if m.AmountRatio == nil || !near(*m.AmountRatio, 3) {
		t.Fatalf("量比 = %v，应当 3", m.AmountRatio)
	}
	// 之前只有 19 天：样本不足为空
	if m := computeMetrics(s[1:], nil); m.AmountRatio != nil {
		t.Fatalf("19 天的量比应当为空：%v", *m.AmountRatio)
	}
	// 窗口里有一天缺成交额也不算
	s[5].amount = 0
	if m := computeMetrics(s, nil); m.AmountRatio != nil {
		t.Fatalf("缺成交额的量比应当为空：%v", *m.AmountRatio)
	}
}

func TestTrackingError(t *testing.T) {
	s := days(25)
	idx := map[string]float64{}
	for i := range s {
		s[i].changePct = 1
		d := 0.1
		if i%2 == 1 {
			d = -0.1
		}
		idx[s[i].date] = 1 - d // ETF 收益 - 指数收益 = ±0.1
	}
	m := computeMetrics(s, idx)
	if m.TrackingError == nil {
		t.Fatal("够 20 天应当有跟踪误差")
	}
	// 近 20 天差值 10 个 +0.1、10 个 -0.1，均值 0，样本标准差 √(20×0.01/19)，年化 × √252
	want := math.Sqrt(20*0.01/19) * math.Sqrt(252)
	if !near(*m.TrackingError, want) {
		t.Fatalf("跟踪误差 = %v，应当 %v", *m.TrackingError, want)
	}
	if m.ExcessReturn == nil {
		t.Fatal("够 20 天应当有超额收益")
	}
	if m := computeMetrics(s[:19], idx); m.TrackingError != nil || m.ExcessReturn != nil {
		t.Fatal("19 天不该有跟踪误差")
	}
	delete(idx, s[24].date)
	if m := computeMetrics(s, idx); m.TrackingError != nil {
		t.Fatal("窗口里缺一天指数数据不该算")
	}
	if m := computeMetrics(s, nil); m.TrackingError != nil {
		t.Fatal("没有指数数据不该算")
	}
}

func TestPercentileNeedsSixtyDays(t *testing.T) {
	s := days(60)
	for i := range s {
		s[i].shares = float64(100 + i)
		s[i].aum = float64(100 + i)
		s[i].premium = float64(i % 10)
	}
	m := computeMetrics(s, nil)
	if m.SharePctile == nil || !near(*m.SharePctile, 100) {
		t.Fatalf("份额是 60 天里最大，分位应当 100：%v", m.SharePctile)
	}
	if m.AUMPctile == nil || m.PremiumPctile == nil {
		t.Fatal("60 天应当有规模和折溢价分位")
	}
	if m := computeMetrics(s[1:], nil); m.SharePctile != nil || m.AUMPctile != nil || m.PremiumPctile != nil {
		t.Fatal("59 天不该有分位")
	}
	// 折溢价口径不可用的那些天不算样本
	s[0].basis = "none"
	if m := computeMetrics(s, nil); m.PremiumPctile != nil {
		t.Fatal("只有 59 天可用的折溢价，不该有分位")
	}
}

func TestInflowStreak(t *testing.T) {
	cases := []struct {
		shares []float64
		want   int
	}{
		{[]float64{100, 101, 102, 103}, 3},
		{[]float64{100, 99, 101, 102}, 2},
		{[]float64{105, 104, 103, 102, 101}, -4},
		{[]float64{100, 101, 101}, 0},
		{[]float64{0, 101, 102}, 1}, // 缺份额的那天断开
		{[]float64{100}, 0},
	}
	for _, c := range cases {
		s := days(len(c.shares))
		for i, v := range c.shares {
			s[i].shares = v
		}
		if got := computeMetrics(s, nil).InflowStreak; got != c.want {
			t.Errorf("%v 连续天数 = %d，应当 %d", c.shares, got, c.want)
		}
	}
}

func TestShareChangeAndReviewFlag(t *testing.T) {
	s := days(2)
	s[1].shares, s[1].nav = 102, 1.5
	m := computeMetrics(s, nil)
	if m.ShareChangePct == nil || !near(*m.ShareChangePct, 2) || m.NetInflow == nil || !near(*m.NetInflow, 3) {
		t.Fatalf("份额变动 = %v，净流入 = %v", m.ShareChangePct, m.NetInflow)
	}
	if m.ReviewFlag != "" {
		t.Fatalf("2%% 不该待核：%s", m.ReviewFlag)
	}
	// 份额跳 15%、没有量比（样本不足）：待核
	s[1].shares = 115
	if m := computeMetrics(s, nil); m.ReviewFlag != ReviewPending {
		t.Fatalf("份额跳变应当待核：%q", m.ReviewFlag)
	}
	// 有放量配合（量比 ≥ 2）不算待核
	s = days(22)
	s[21].shares, s[21].amount = 120, 500
	if m := computeMetrics(s, nil); m.ReviewFlag != "" {
		t.Fatalf("放量配合的跳变不该待核：%q", m.ReviewFlag)
	}
	// 折溢价口径不可用时为空
	s = days(1)
	s[0].basis = "none"
	if m := computeMetrics(s, nil); m.PremiumDiscount != nil || m.PremiumBasis != "none" {
		t.Fatalf("口径不可用：%v %s", m.PremiumDiscount, m.PremiumBasis)
	}
}

func TestPriceDerived(t *testing.T) {
	d := Daily{Shares: 10, Price: 1.01, NAV: 1, IOPV: 1.005}
	priceDerived(&d)
	if d.PremiumBasis != "iopv" || !near(d.PremiumDiscount, (1.01-1.005)/1.005*100) || !near(d.AUM, 10) {
		t.Fatalf("IOPV 优先：%+v", d)
	}
	d = Daily{Shares: 10, Price: 1.01, NAV: 1}
	priceDerived(&d)
	if d.PremiumBasis != "nav" || !near(d.PremiumDiscount, 1) {
		t.Fatalf("退到净值：%+v", d)
	}
	d = Daily{Shares: 10, Price: 2}
	priceDerived(&d)
	if d.PremiumBasis != "none" || d.PremiumDiscount != 0 || !near(d.AUM, 20) {
		t.Fatalf("都没有：%+v", d)
	}
}

func TestRuleHitAndScope(t *testing.T) {
	for _, c := range []struct {
		op     string
		v, th  float64
		expect bool
	}{
		{"gt", 2.1, 2, true}, {"gt", 2, 2, false}, {"gte", 3, 3, true}, {"lt", -1, 0, true},
		{"lte", -3, -3, true}, {"lte", -2, -3, false}, {"abs_gt", -2.5, 2, true}, {"abs_gt", 1.9, 2, false}, {"nope", 9, 0, false},
	} {
		if got := ruleHit(c.op, c.v, c.th); got != c.expect {
			t.Errorf("%s %v %v = %v", c.op, c.v, c.th, got)
		}
	}
	r := Rule{Scope: "index", ScopeValue: "000300"}
	if !inScope(r, "510300", "000300", "沪深300") || inScope(r, "510500", "000905", "中证500") {
		t.Error("index 范围按跟踪指数代码认")
	}
	r.ScopeValue = "沪深300"
	if !inScope(r, "510300", "000300", "沪深300") {
		t.Error("index 范围也认指数名")
	}
	if !inScope(Rule{Scope: "symbol", ScopeValue: "510300"}, "510300", "", "") || inScope(Rule{Scope: "symbol", ScopeValue: "510300"}, "510500", "", "") {
		t.Error("symbol 范围")
	}
}

func TestParseSnapshots(t *testing.T) {
	body := []byte(`{"data":{"diff":[{"f12":"510300","f38":44587387648.0,"f124":1793779920,"f441":4.1728},{"f12":"159915","f38":"-","f441":"-"}]}}`)
	got, err := parseSnapshots(body)
	if err != nil {
		t.Fatal(err)
	}
	s := got["510300"]
	if s.shares != 44587387648 || s.iopv != 4.1728 || s.date != time.Unix(1793779920, 0).In(shanghai).Format(time.DateOnly) {
		t.Fatalf("快照 = %+v", s)
	}
	if got["159915"].shares != 0 || got["159915"].iopv != 0 {
		t.Fatalf("没有值的字段应当为 0：%+v", got["159915"])
	}
	if indexSecid("399006") != "0.399006" || indexSecid("000300") != "1.000300" || indexSecid("000852") != "1.000852" {
		t.Error("指数 secid")
	}
}

// ---------- 采集后判定（走接口） ----------

// scripted 是按日期给数据的测试源：不出网，每天的份额、成交额、涨跌幅由测试写好。
type scripted struct {
	mu    sync.Mutex
	daily map[string][]Daily
	index map[string][]IndexBar
}

func newScripted() *scripted {
	return &scripted{daily: map[string][]Daily{}, index: map[string][]IndexBar{}}
}

func (s *scripted) ID() string   { return "scripted" }
func (s *scripted) Name() string { return "脚本数据" }

func (s *scripted) Funds(context.Context) ([]Fund, error) {
	return []Fund{
		{Symbol: "510300", Name: "沪深300ETF", TrackIndex: "沪深300", Category: "宽基", Market: "SH", Secid: "1.510300", Underlying: "000300"},
		{Symbol: "510500", Name: "中证500ETF", TrackIndex: "中证500", Category: "宽基", Market: "SH", Secid: "1.510500", Underlying: "000905"},
	}, nil
}

func (s *scripted) Daily(_ context.Context, date string, _ []string) ([]Daily, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, ok := s.daily[date]
	if !ok {
		return nil, errors.New("没有这天")
	}
	return append([]Daily(nil), rows...), nil
}

func (s *scripted) IndexDaily(_ context.Context, date string, _ []string) ([]IndexBar, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]IndexBar(nil), s.index[date]...), nil
}

// day 写一天：两只 ETF，510300 的份额（亿份）、成交额、涨跌幅可调，510500 每天不变。
func (s *scripted) day(date string, shares, amount, chg, idxChg float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.daily[date] = []Daily{
		{Date: date, Symbol: "510300", Shares: shares * 1e8, NAV: 4, Price: 4, Amount: amount, ChangePct: chg},
		{Date: date, Symbol: "510500", Shares: 50e8, NAV: 6, Price: 6, Amount: 1e8},
	}
	s.index[date] = []IndexBar{{Date: date, Code: "000300", ChangePct: idxChg}, {Date: date, Code: "000905"}}
}

type fakeNotifier struct {
	mu  sync.Mutex
	got []plugin.Notification
}

func (f *fakeNotifier) NotifyFromPlugin(_ context.Context, n plugin.Notification) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, n)
	return nil
}

func (f *fakeNotifier) list() []plugin.Notification {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]plugin.Notification(nil), f.got...)
}

func dateN(i int) string {
	return time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, i).Format(time.DateOnly)
}

func collectOn(t *testing.T, e env, date string) map[string]any {
	t.Helper()
	return data(t, e.h, "POST", "/api/etf/collect", fmt.Sprintf(`{"date":%q}`, date))
}

func anomaliesOf(t *testing.T, e env, query string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, x := range list(t, e.h, "/api/etf/anomalies?"+query) {
		out = append(out, x.(map[string]any))
	}
	return out
}

func TestAnomalyFlow(t *testing.T) {
	src := newScripted()
	e := setup(t, src)
	n := &fakeNotifier{}
	e.reg.SetNotifier(n)

	// 首批 7 条规则安装时补好
	rules := list(t, e.h, "/api/etf/rules")
	if len(rules) != 7 {
		t.Fatalf("内置规则 %d 条", len(rules))
	}

	src.day(dateN(0), 100, 1e9, 0, 0)
	src.day(dateN(1), 102.5, 1e9, 0, 0) // +2.5%：份额单日骤变（warn）
	collectOn(t, e, dateN(0))
	res := collectOn(t, e, dateN(1))
	if res["metrics"].(float64) != 2 || res["indexes"].(float64) != 2 || res["new_hits"].(float64) != 1 {
		t.Fatalf("采集结果 = %v", res)
	}
	evs := anomaliesOf(t, e, "date="+dateN(1))
	if len(evs) != 1 || evs[0]["rule_id"] != "ear_share_jump" || evs[0]["severity"] != "warn" || evs[0]["status"] != "open" ||
		evs[0]["fund_name"] != "沪深300ETF" || evs[0]["flag"] != "" {
		t.Fatalf("命中 = %v", evs)
	}
	if !near(evs[0]["value"].(float64), 2.5) {
		t.Fatalf("命中值 = %v", evs[0]["value"])
	}
	if got := n.list(); len(got) != 1 || got[0].Kind != "etf.anomaly" || got[0].Level != plugin.NotifyInfo {
		t.Fatalf("通知 = %+v", got)
	}

	// 确认后重跑：还是一条、状态保持、不再发通知
	id := evs[0]["id"].(string)
	if a := data(t, e.h, "POST", "/api/etf/anomalies/"+id+"/ack", `{"status":"acked"}`); a["status"] != "acked" || a["handled_at"] == "" {
		t.Fatalf("确认 = %v", a)
	}
	res = collectOn(t, e, dateN(1))
	if res["new_hits"].(float64) != 0 || res["hits"].(float64) != 1 {
		t.Fatalf("重跑 = %v", res)
	}
	evs = anomaliesOf(t, e, "date="+dateN(1))
	if len(evs) != 1 || evs[0]["id"] != id || evs[0]["status"] != "acked" {
		t.Fatalf("重跑后 = %v", evs)
	}
	if len(n.list()) != 1 {
		t.Fatalf("重跑不该再通知：%d", len(n.list()))
	}

	// 重跑覆盖值：源数据变了，值跟着变，状态还是 acked
	src.day(dateN(1), 103, 1e9, 0, 0)
	collectOn(t, e, dateN(1))
	evs = anomaliesOf(t, e, "date="+dateN(1))
	if len(evs) != 1 || !near(evs[0]["value"].(float64), 3) || evs[0]["status"] != "acked" {
		t.Fatalf("覆盖值后 = %v", evs)
	}

	// 连续 3 天净流入：info
	src.day(dateN(2), 103.5, 1e9, 0, 0)
	src.day(dateN(3), 104, 1e9, 0, 0)
	collectOn(t, e, dateN(2))
	collectOn(t, e, dateN(3))
	evs = anomaliesOf(t, e, "date="+dateN(3)+"&severity=info")
	if len(evs) != 1 || evs[0]["rule_id"] != "ear_inflow_streak" || evs[0]["value"].(float64) != 3 {
		t.Fatalf("连续流入 = %v", evs)
	}
	// 忽略
	ig := data(t, e.h, "POST", "/api/etf/anomalies/"+evs[0]["id"].(string)+"/ack", `{"status":"ignored"}`)
	if ig["status"] != "ignored" {
		t.Fatalf("忽略 = %v", ig)
	}
	if got := anomaliesOf(t, e, "status=ignored"); len(got) != 1 {
		t.Fatalf("按状态筛 = %v", got)
	}

	// 改阈值：没处理过的命中不再满足时撤掉；确认、忽略过的留着
	src.day(dateN(4), 107, 1e9, 0, 0) // +2.88%，份额骤变
	collectOn(t, e, dateN(4))
	if got := anomaliesOf(t, e, "date="+dateN(4)+"&severity=warn"); len(got) != 1 {
		t.Fatalf("第 5 天 warn = %v", got)
	}
	r := data(t, e.h, "PATCH", "/api/etf/rules/ear_share_jump", `{"threshold":5}`)
	if r["threshold"].(float64) != 5 || r["builtin"] != true {
		t.Fatalf("改阈值 = %v", r)
	}
	collectOn(t, e, dateN(4))
	if got := anomaliesOf(t, e, "date="+dateN(4)+"&severity=warn"); len(got) != 0 {
		t.Fatalf("改阈值后未处理的命中应当撤掉：%v", got)
	}
	collectOn(t, e, dateN(1))
	if got := anomaliesOf(t, e, "date="+dateN(1)); len(got) != 1 || got[0]["status"] != "acked" {
		t.Fatalf("确认过的不撤：%v", got)
	}
	// 改过的阈值不被补种覆盖
	for _, x := range list(t, e.h, "/api/etf/rules") {
		if m := x.(map[string]any); m["id"] == "ear_share_jump" && m["threshold"].(float64) != 5 {
			t.Fatalf("补种覆盖了用户改的阈值：%v", m)
		}
	}

	// 停用：不再判定
	data(t, e.h, "PATCH", "/api/etf/rules/ear_inflow_streak", `{"enabled":false}`)
	src.day(dateN(5), 107.5, 1e9, 0, 0)
	collectOn(t, e, dateN(5))
	for _, a := range anomaliesOf(t, e, "date="+dateN(5)) {
		if a["rule_id"] == "ear_inflow_streak" {
			t.Fatalf("停用的规则还在判定：%v", a)
		}
	}

	// 新建规则：只看 510500 的净流入为 0（≥ 0 必中）
	created := data(t, e.h, "POST", "/api/etf/rules", `{"name":"500 盯着","metric":"net_inflow","operator":"gte","threshold":0,"scope":"symbol","scope_value":"510500","severity":"info"}`)
	if created["builtin"] != false || created["enabled"] != true || created["id"].(string)[:4] != "ear_" {
		t.Fatalf("新建 = %v", created)
	}
	collectOn(t, e, dateN(5))
	got := anomaliesOf(t, e, "date="+dateN(5)+"&symbol=510500")
	if len(got) != 1 || got[0]["rule_id"] != created["id"] {
		t.Fatalf("新规则命中 = %v", got)
	}
	if got := anomaliesOf(t, e, "date="+dateN(5)+"&symbol=510300"); len(got) != 0 {
		for _, a := range got {
			if a["rule_id"] == created["id"] {
				t.Fatalf("范围外的也判了：%v", a)
			}
		}
	}

	// 样本不足：跟踪误差、量比都为空，不判定
	ms := list(t, e.h, "/api/etf/metrics?symbol=510300&date="+dateN(5))
	if len(ms) != 1 {
		t.Fatalf("指标 = %v", ms)
	}
	m := ms[0].(map[string]any)
	if m["tracking_error"] != nil || m["amount_ratio"] != nil || m["share_pctile"] != nil || m["premium_basis"] != "nav" {
		t.Fatalf("样本不足应当为空：%v", m)
	}
}

func TestTrackingErrorRuleAndReview(t *testing.T) {
	src := newScripted()
	e := setup(t, src)
	n := &fakeNotifier{}
	e.reg.SetNotifier(n)
	for i := 0; i < 21; i++ {
		// ETF 和指数每天差 ±0.5%：20 日跟踪误差远超 1%
		d := 0.5
		if i%2 == 1 {
			d = -0.5
		}
		src.day(dateN(i), 100, 1e9, d, 0)
		collectOn(t, e, dateN(i))
		if i == 18 {
			for _, a := range anomaliesOf(t, e, "date="+dateN(i)+"&severity=critical") {
				t.Fatalf("不足 20 天不该判跟踪误差：%v", a)
			}
		}
	}
	evs := anomaliesOf(t, e, "date="+dateN(20)+"&severity=critical")
	if len(evs) != 1 || evs[0]["rule_id"] != "ear_tracking_error" {
		t.Fatalf("跟踪误差 = %v", evs)
	}
	last := n.list()[len(n.list())-1]
	if last.Level != plugin.NotifyError {
		t.Fatalf("critical 的通知应当是 error 级别：%+v", last)
	}

	// 份额跳 15%、成交额不变：命中份额骤变但标待核
	src.day(dateN(21), 115, 1e9, 0, 0)
	collectOn(t, e, dateN(21))
	var jump map[string]any
	for _, a := range anomaliesOf(t, e, "date="+dateN(21)) {
		if a["rule_id"] == "ear_share_jump" {
			jump = a
		}
	}
	if jump == nil || jump["flag"] != ReviewPending {
		t.Fatalf("份额跳变应当待核：%v", jump)
	}
	ms := list(t, e.h, "/api/etf/metrics?symbol=510300&from="+dateN(21)+"&to="+dateN(21))
	if len(ms) != 1 || ms[0].(map[string]any)["review_flag"] != ReviewPending || ms[0].(map[string]any)["amount_ratio"] == nil {
		t.Fatalf("指标 = %v", ms)
	}
}

func TestAnomalyAPIValidation(t *testing.T) {
	e := setup(t, newScripted())
	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/etf/metrics?from=2026/01/01", ""},
		{"GET", "/api/etf/metrics?limit=0", ""},
		{"GET", "/api/etf/anomalies?severity=huge", ""},
		{"GET", "/api/etf/anomalies?status=done", ""},
		{"GET", "/api/etf/anomalies?date=x", ""},
		{"POST", "/api/etf/rules", `{"name":"x"}`},
		{"POST", "/api/etf/rules", `{"name":"x","metric":"nope","operator":"gt","threshold":1}`},
		{"POST", "/api/etf/rules", `{"name":"x","metric":"amount_ratio","operator":"between","threshold":1}`},
		{"POST", "/api/etf/rules", `{"name":"","metric":"amount_ratio","operator":"gt","threshold":1}`},
		{"POST", "/api/etf/rules", `{"name":"x","metric":"amount_ratio","operator":"gt","threshold":1,"scope":"symbol"}`},
		{"POST", "/api/etf/rules", `{"name":"x","metric":"amount_ratio","operator":"gt","threshold":1,"severity":"fatal"}`},
		{"POST", "/api/etf/rules", `{"name":"x","metric":"amount_ratio","operator":"gt","threshold":1,"window_days":0}`},
		{"POST", "/api/etf/rules", `{"name":"x","metric":"amount_ratio","operator":"gt","threshold":1,"bogus":1}`},
		{"POST", "/api/etf/rules", `[]`},
		{"PATCH", "/api/etf/rules/ear_premium", `{"operator":"between"}`},
		{"POST", "/api/etf/anomalies/eae_x/ack", `{"status":"done"}`},
	} {
		if code, out := call(t, e.h, c.method, c.path, c.body); code != 400 {
			t.Errorf("%s %s %s = %d %v，应当 400", c.method, c.path, c.body, code, out)
		}
	}
	for _, c := range []struct{ method, path, body string }{
		{"PATCH", "/api/etf/rules/ear_nope", `{"threshold":1}`},
		{"POST", "/api/etf/anomalies/eae_nope/ack", ``},
	} {
		if code, out := call(t, e.h, c.method, c.path, c.body); code != 404 {
			t.Errorf("%s %s = %d %v，应当 404", c.method, c.path, code, out)
		}
	}
	// scope 改回 all 时 scope_value 清掉
	r := data(t, e.h, "PATCH", "/api/etf/rules/ear_premium", `{"scope":"index","scope_value":"000300"}`)
	if r["scope"] != "index" || r["scope_value"] != "000300" {
		t.Fatalf("改范围 = %v", r)
	}
	r = data(t, e.h, "PATCH", "/api/etf/rules/ear_premium", `{"scope":"all"}`)
	if r["scope_value"] != "" {
		t.Fatalf("回到全部 = %v", r)
	}
}
