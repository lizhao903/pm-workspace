package trade

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

/* ---------- 和原型对拍 ---------- */

// testdata/alerts_golden.json 由 testdata/gen-alert-golden.mjs 用原型 web-next/src/alertcheck.ts 跑出：
// 13 个标的（含期权、找不到的标的）× 8 种条件 × 3 个时刻 × 10 种规则状态，判定、说明文字、触发价都要和原型逐字一致。
type alertGolden struct {
	Markets map[string]AlertInput `json:"markets"`
	Cases   []struct {
		Name   string `json:"name"`
		At     int64  `json:"at"`
		Market string `json:"market"`
		Alert  Alert  `json:"alert"`
		Hit    *struct {
			Text  string  `json:"text"`
			Price float64 `json:"price"`
		} `json:"hit"`
	} `json:"cases"`
}

func TestAlertsMatchPrototype(t *testing.T) {
	b, err := os.ReadFile("testdata/alerts_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g alertGolden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) < 1000 {
		t.Fatalf("黄金文件里只有 %d 个用例", len(g.Cases))
	}
	hits, conds := 0, map[string]int{}
	for _, c := range g.Cases {
		in, ok := g.Markets[c.Market]
		if !ok {
			t.Fatalf("%s：黄金文件里没有行情 %s", c.Name, c.Market)
		}
		got := evalAlerts([]Alert{c.Alert}, time.UnixMilli(c.At), func(Alert) (AlertInput, bool) { return in, true })
		switch {
		case c.Hit == nil && len(got) != 0:
			t.Errorf("%s：原型不触发，Go 触发了：%s", c.Name, got[0].Text)
		case c.Hit != nil && len(got) != 1:
			t.Errorf("%s：原型触发（%s），Go 没触发", c.Name, c.Hit.Text)
		case c.Hit != nil:
			hits++
			conds[c.Alert.Cond]++
			if got[0].Text != c.Hit.Text || got[0].Price != c.Hit.Price {
				t.Errorf("%s：\n  原型 %q 触发价 %v\n  Go   %q 触发价 %v", c.Name, c.Hit.Text, c.Hit.Price, got[0].Text, got[0].Price)
			}
		}
	}
	// 每种条件都要真的有触发的用例，免得夹具退化成全不触发也能过
	for _, k := range AlertConds {
		if conds[k] == 0 {
			t.Errorf("条件 %s 没有触发的用例", k)
		}
	}
	t.Logf("%d 个用例，%d 个触发", len(g.Cases), hits)
}

func TestLocaleFixed(t *testing.T) {
	cases := []struct {
		x    float64
		d    int
		want string
	}{
		{67120, 1, "67,120.0"}, {1234567.891, 2, "1,234,567.89"}, {0.153, 3, "0.153"}, {999.995, 2, "1,000.00"},
		{1.005, 2, "1.01"}, {-1234.5, 0, "-1,235"}, {25454, 0, "25,454"}, {-0.001, 2, "-0.00"}, {math.Copysign(0, -1), 2, "-0.00"}, {12, 0, "12"},
	}
	for _, c := range cases {
		if got := groupThousands(localeFixed(c.x, c.d)); got != c.want {
			t.Errorf("%v 保留 %d 位 = %q，要 %q", c.x, c.d, got, c.want)
		}
	}
	if jsString(-0.0) != "0" || jsString(0.05) != "0.05" || jsString(70000) != "70000" {
		t.Fatal("jsString 和 JS 的 String(number) 不一致")
	}
}

func TestGuessAlertInst(t *testing.T) {
	if n := guessAlertInst("BINANCE:BTCUSDT.P").Name + "," + guessAlertInst("BINANCE:BTCUSDT").Name + "," + guessAlertInst("OKX:ETH-USDT-SWAP").Name + "," + guessAlertInst("OKX:BTC-USDT").Name; n != "BTC 永续,BTC/USDT,ETH 永续,BTC/USDT" {
		t.Fatalf("推的名字 = %s", n)
	}
	for sym, kind := range map[string]string{
		"BINANCE:BTCUSDT": "spot", "BINANCE:BTCUSDT.P": "perp", "OKX:ETH-USDT-SWAP": "perp", "OKX:BTC-USD-261225": "future",
		"OKX:BTC-USDT": "spot", "NASDAQ:NVDA": "spot", "SSE:600519": "spot",
	} {
		if i := guessAlertInst(sym); i.Kind != kind || i.Digits != -1 {
			t.Errorf("%s 推成 %+v，要 %s", sym, i, kind)
		}
	}
}

/* ---------- 后台检查、接口 ---------- */

// scriptSource 是价格由测试设定的行情源（场所 FAKE），一个现货、一个永续。
type scriptSource struct {
	mu      sync.Mutex
	price   map[string]float64
	open    float64
	funding float64
	lastVol float64
}

func (s *scriptSource) ID() string   { return "fake" }
func (s *scriptSource) Name() string { return "脚本行情源" }
func (s *scriptSource) Coverage() []Coverage {
	return []Coverage{{Market: "crypto", Kinds: []string{"spot", "perp"}}}
}

func (s *scriptSource) Instruments(_ context.Context, market, kind string) ([]Instrument, error) {
	return []Instrument{}, nil
}

func (s *scriptSource) set(sym string, p float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.price[sym] = p
}

func (s *scriptSource) Ticker(_ context.Context, sym string) (Ticker, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.price[sym]
	if !ok {
		return Ticker{}, ErrUnknownSymbol
	}
	return Ticker{Symbol: sym, Last: p, Bid: p, Ask: p, Open24h: s.open, High24h: p, Low24h: p, Volume24h: 1, At: time.Now()}, nil
}

func (s *scriptSource) Klines(_ context.Context, q KlineQuery) ([]Kline, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	step := Intervals[q.Interval]
	end := q.End
	if end.IsZero() {
		end = time.Now()
	}
	start := alignOpen(end, q.Interval).Add(-time.Duration(q.Limit-1) * step)
	out := make([]Kline, 0, q.Limit)
	for i := range q.Limit {
		v := 10.0
		if i == q.Limit-1 {
			v = s.lastVol
		}
		out = append(out, Kline{Time: start.Add(time.Duration(i) * step), Open: 1, High: 1, Low: 1, Close: 1, Volume: v})
	}
	return out, nil
}

func (s *scriptSource) OrderBook(context.Context, string, int) (OrderBook, error) {
	return OrderBook{}, ErrUnsupported
}

func (s *scriptSource) Funding(_ context.Context, sym string) (Funding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Funding{Symbol: sym, Rate: s.funding, At: time.Now()}, nil
}

type alertNotifier struct {
	mu  sync.Mutex
	got []plugin.Notification
}

func (f *alertNotifier) NotifyFromPlugin(_ context.Context, n plugin.Notification) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, n)
	return nil
}

func (f *alertNotifier) list() []plugin.Notification {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]plugin.Notification(nil), f.got...)
}

type alertRecorder struct {
	mu  sync.Mutex
	evs []map[string]any
}

func (r *alertRecorder) Publish(_ context.Context, eventType string, payload any) error {
	b, _ := json.Marshal(payload)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	m["type"] = eventType
	r.mu.Lock()
	r.evs = append(r.evs, m)
	r.mu.Unlock()
	return nil
}

func (r *alertRecorder) list() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]map[string]any(nil), r.evs...)
}

type alertEnv struct {
	h     http.Handler
	src   *scriptSource
	clock *testClock
	n     *alertNotifier
	ev    *alertRecorder
	d     *db.DB
}

func setupAlerts(t *testing.T) alertEnv {
	t.Helper()
	ctx := context.Background()
	old := alertEvery
	alertEvery = 50 * time.Millisecond
	t.Cleanup(func() { alertEvery = old })

	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	src := &scriptSource{price: map[string]float64{"FAKE:BTCUSDT": 90, "FAKE:BTCUSDT.P": 90}, open: 100, funding: 0.0001, lastVol: 10}
	p := New(src)
	clock := newTestClock(time.Now())
	p.now, p.tick, p.push = clock.now, 50*time.Millisecond, 50*time.Millisecond
	n, ev := &alertNotifier{}, &alertRecorder{}
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	r.Events = ev
	r.SetNotifier(n)
	if err := r.Add(p); err != nil {
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
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return alertEnv{h: mux, src: src, clock: clock, n: n, ev: ev, d: d}
}

func eventsOf(t *testing.T, h http.Handler, q string) ([]map[string]any, map[string]any) {
	t.Helper()
	code, out := call(t, h, "GET", "/api/trade/alert-events"+q, "")
	if code != 200 {
		t.Fatalf("触发记录 = %d %v", code, out)
	}
	var evs []map[string]any
	for _, x := range out["data"].([]any) {
		evs = append(evs, x.(map[string]any))
	}
	return evs, out["meta"].(map[string]any)
}

func TestAlertCRUDAndValidation(t *testing.T) {
	e := setupAlerts(t)
	h := e.h
	// 条件对品种不适用的拒绝保存；格式、通知方式、IM 连接器、冷却都要校验
	bad := map[string]string{
		"资金费率用在现货":  `{"symbol":"FAKE:BTCUSDT","cond":"funding_above","value":0.05}`,
		"隐含波动率用在现货": `{"symbol":"FAKE:BTCUSDT","cond":"iv_above","value":50}`,
		"没有涨跌停":     `{"symbol":"FAKE:BTCUSDT","cond":"limit_near","value":2}`,
		"条件不认识":     `{"symbol":"FAKE:BTCUSDT","cond":"cross","value":1}`,
		"缺阈值":       `{"symbol":"FAKE:BTCUSDT","cond":"price_above"}`,
		"阈值不是数字":    `{"symbol":"FAKE:BTCUSDT","cond":"price_above","value":"70000"}`,
		"标的格式":      `{"symbol":"btc","cond":"price_above","value":1}`,
		"没有通知方式":    `{"symbol":"FAKE:BTCUSDT","cond":"price_above","value":1,"notify":[]}`,
		"通知方式不认识":   `{"symbol":"FAKE:BTCUSDT","cond":"price_above","value":1,"notify":["mail"]}`,
		"IM 没选连接器":  `{"symbol":"FAKE:BTCUSDT","cond":"price_above","value":1,"notify":["im"]}`,
		"IM 连接器不存在": `{"symbol":"FAKE:BTCUSDT","cond":"price_above","value":1,"notify":["im"],"im_connector":"cn_nope"}`,
		"冷却为负":      `{"symbol":"FAKE:BTCUSDT","cond":"price_above","value":1,"repeat":true,"cooldown_min":-1}`,
		"不认识的字段":    `{"symbol":"FAKE:BTCUSDT","cond":"price_above","value":1,"sound":"ding"}`,
	}
	for name, body := range bad {
		if code, out := call(t, h, "POST", "/api/trade/alerts", body); code != 400 {
			t.Errorf("%s = %d %v，应当 400", name, code, out)
		}
	}
	// 永续可以设资金费率；默认值同原型抽屉：冷却 30、应用内、启用
	f := data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT.P","cond":"funding_above","value":0.05,"note":"  费率高减多单 "}`)
	if f["cooldown_min"] != 30.0 || f["enabled"] != true || f["repeat"] != false || f["note"] != "费率高减多单" ||
		fmt.Sprint(f["notify"]) != "[app]" || f["last_fired_at"] != "" || f["im_connector"] != "" || !strings.HasPrefix(f["id"].(string), "al_") {
		t.Fatalf("新建 = %v", f)
	}
	id := f["id"].(string)
	// 没选 IM 时 im_connector 不存；notify 去重
	p := data(t, h, "PATCH", "/api/trade/alerts/"+id, `{"notify":["sound","app","sound"],"im_connector":"cn_x","repeat":true,"cooldown_min":480}`)
	if fmt.Sprint(p["notify"]) != "[sound app]" || p["im_connector"] != "" || p["repeat"] != true || p["cooldown_min"] != 480.0 {
		t.Fatalf("PATCH = %v", p)
	}
	if code, _ := call(t, h, "PATCH", "/api/trade/alerts/"+id, `{"symbol":"FAKE:BTCUSDT"}`); code != 400 {
		t.Fatalf("改成现货后资金费率不适用，应当 400，得到 %d", code)
	}
	if code, _ := call(t, h, "GET", "/api/trade/alerts/al_nope", ""); code != 404 {
		t.Fatalf("不存在的提醒 = %d", code)
	}
	if got := list(t, h, "/api/trade/alerts"); len(got) != 1 {
		t.Fatalf("列表 = %v", got)
	}
	if code, _ := call(t, h, "DELETE", "/api/trade/alerts/"+id, ""); code != 200 {
		t.Fatalf("删除 = %d", code)
	}
	if got := list(t, h, "/api/trade/alerts"); len(got) != 0 {
		t.Fatalf("删除后列表 = %v", got)
	}
	// 预览：条件不适用、标的没有行情源
	if v := data(t, h, "GET", "/api/trade/alerts/preview?symbol=FAKE:BTCUSDT&cond=funding_above", ""); v["status"] != "unsupported" || v["value"] != nil {
		t.Fatalf("预览不适用 = %v", v)
	}
	if v := data(t, h, "GET", "/api/trade/alerts/preview?symbol=NASDAQ:NVDA&cond=price_above", ""); v["status"] != "no_source" {
		t.Fatalf("预览没有行情源 = %v", v)
	}
	if v := data(t, h, "GET", "/api/trade/alerts/preview?symbol=FAKE:BTCUSDT&cond=pct_below", ""); v["status"] != "ok" || v["value"] != 10.0 || v["price"] != 90.0 {
		t.Fatalf("预览跌幅（90 比 100 跌 10%%）= %v", v)
	}
	if code, _ := call(t, h, "GET", "/api/trade/alerts/preview?symbol=FAKE:BTCUSDT&cond=x", ""); code != 400 {
		t.Fatal("预览条件不认识应当 400")
	}
}

func TestAlertFiresInBackground(t *testing.T) {
	e := setupAlerts(t)
	h := e.h
	single := data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT","cond":"price_above","value":100,"notify":["app","sound"],"note":"突破前高"}`)
	rep := data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT.P","cond":"price_above","value":100,"repeat":true,"cooldown_min":1}`)
	off := data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT","cond":"price_above","value":100,"enabled":false}`)
	_ = off

	// 价格在阈值下面：当前值有了，但不触发
	waitFor(t, "当前值算出来", func() bool {
		vs := list(t, h, "/api/trade/alerts/values")
		return len(vs) == 2 && vs[0].(map[string]any)["status"] == "ok" && vs[1].(map[string]any)["status"] == "ok"
	})
	time.Sleep(200 * time.Millisecond)
	if evs, _ := eventsOf(t, h, ""); len(evs) != 0 {
		t.Fatalf("没过阈值就触发了：%v", evs)
	}

	// 价格穿过阈值：几轮之内两条都触发，停用的不触发
	e.src.set("FAKE:BTCUSDT", 101.5)
	e.src.set("FAKE:BTCUSDT.P", 102)
	waitFor(t, "两条触发", func() bool { evs, _ := eventsOf(t, h, ""); return len(evs) == 2 })
	evs, meta := eventsOf(t, h, "")
	if meta["unread"] != 2.0 || meta["total"] != 2.0 {
		t.Fatalf("meta = %v", meta)
	}
	var se map[string]any
	for _, x := range evs {
		if x["alert_id"] == single["id"] {
			se = x
		}
	}
	if se == nil || se["text"] != "BTCUSDT 价格 101.50，上穿 100.00" || se["price"] != 101.5 || se["value"] != 101.5 ||
		se["note"] != "突破前高" || se["read"] != false || se["im_status"] != "" || !strings.HasPrefix(se["id"].(string), "ae_") {
		t.Fatalf("触发记录 = %v", se)
	}
	// 事件总线和通知
	waitFor(t, "事件和通知", func() bool { return len(e.ev.list()) >= 2 && len(e.n.list()) >= 2 })
	var fired map[string]any
	for _, x := range e.ev.list() {
		if x["alert_id"] == single["id"] {
			fired = x
		}
	}
	if fired == nil || fired["type"] != "trade.alert_fired" || fired["id"] != se["id"] || fmt.Sprint(fired["notify"]) != "[app sound]" {
		t.Fatalf("事件 = %v", fired)
	}
	var note plugin.Notification
	for _, x := range e.n.list() {
		if x.Data["alert_id"] == single["id"] {
			note = x
		}
	}
	if note.Kind != "trade.alert" || note.Title != se["text"] || note.Body != "突破前高\n触发价 101.50" || note.Data["source"] != "trade" {
		t.Fatalf("通知 = %+v", note)
	}
	if a := data(t, h, "GET", "/api/trade/alerts/"+single["id"].(string), ""); a["last_fired_at"] != se["at"] {
		t.Fatalf("单次提醒的 last_fired_at = %v，触发时间 %v", a["last_fired_at"], se["at"])
	}

	// 冷却内不重复：单次的不再响，重复的 1 分钟冷却内也不响
	time.Sleep(300 * time.Millisecond)
	if evs, _ := eventsOf(t, h, ""); len(evs) != 2 {
		t.Fatalf("冷却内又触发了：%d 条", len(evs))
	}
	// 过了冷却：重复的再响一次，单次的还是不响
	e.clock.advance(61 * time.Second)
	waitFor(t, "冷却后重复提醒再响", func() bool { evs, _ := eventsOf(t, h, ""); return len(evs) == 3 })
	evs, _ = eventsOf(t, h, "")
	if evs[0]["alert_id"] != rep["id"] {
		t.Fatalf("新的在前，应当是重复提醒：%v", evs[0])
	}
	// 重新上膛：单次的再响一次
	if a := data(t, h, "POST", "/api/trade/alerts/"+single["id"].(string)+"/rearm", ""); a["last_fired_at"] != "" {
		t.Fatalf("重新上膛 = %v", a)
	}
	waitFor(t, "重新上膛后再响", func() bool { evs, _ := eventsOf(t, h, ""); return len(evs) == 4 })

	// 已读：单条、全部
	evs, _ = eventsOf(t, h, "")
	if r := data(t, h, "POST", "/api/trade/alert-events/read", fmt.Sprintf(`{"ids":[%q,"ae_nope"]}`, evs[0]["id"])); r["updated"] != 1.0 {
		t.Fatalf("单条已读 = %v", r)
	}
	if un, meta := eventsOf(t, h, "?unread=1"); len(un) != 3 || meta["unread"] != 3.0 {
		t.Fatalf("未读 = %d %v", len(un), meta)
	}
	if r := data(t, h, "POST", "/api/trade/alert-events/read", `{}`); r["updated"] != 3.0 {
		t.Fatalf("全部已读 = %v", r)
	}
	// 单次提醒改阈值重新上膛；重复提醒改阈值不动 last_fired_at
	e.src.set("FAKE:BTCUSDT", 50)
	e.src.set("FAKE:BTCUSDT.P", 50)
	time.Sleep(200 * time.Millisecond)
	if a := data(t, h, "PATCH", "/api/trade/alerts/"+single["id"].(string), `{"value":120}`); a["last_fired_at"] != "" {
		t.Fatalf("单次改阈值应当重新上膛：%v", a)
	}
	if a := data(t, h, "PATCH", "/api/trade/alerts/"+rep["id"].(string), `{"value":120}`); a["last_fired_at"] == "" {
		t.Fatalf("重复提醒改阈值不该清 last_fired_at：%v", a)
	}
	// 删了规则，触发记录还在
	if code, _ := call(t, h, "DELETE", "/api/trade/alerts/"+single["id"].(string), ""); code != 200 {
		t.Fatal("删除失败")
	}
	if evs, _ := eventsOf(t, h, "?limit=2"); len(evs) != 2 {
		t.Fatalf("分页 limit=2 = %d", len(evs))
	}
	if _, meta := eventsOf(t, h, ""); meta["total"] != 4.0 {
		t.Fatalf("删规则后触发记录 = %v", meta)
	}
}

// IM：工作台没有给插件发 IM 的接口，记 unavailable；只选了 IM 的也补一条应用内通知。放量、资金费率走行情缓存。
func TestAlertIMAndOtherConds(t *testing.T) {
	e := setupAlerts(t)
	h := e.h
	ctx := context.Background()
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := e.d.W.ExecContext(ctx, `INSERT INTO connectors (id, tool, name, status, created_at, updated_at) VALUES ('cn_tg', 'telegram', '个人 Telegram', 'connected', ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	im := data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT","cond":"pct_below","value":5,"notify":["im"],"im_connector":"cn_tg"}`)
	if im["im_connector"] != "cn_tg" {
		t.Fatalf("IM 提醒 = %v", im)
	}
	vol := data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT","cond":"volume_spike","value":3}`)
	fund := data(t, h, "POST", "/api/trade/alerts", `{"symbol":"FAKE:BTCUSDT.P","cond":"funding_above","value":0.05}`)

	// 90 比 100 跌了 10%：IM 提醒触发；放量 1 倍、资金费率 0.01% 都没到
	waitFor(t, "IM 提醒触发", func() bool { evs, _ := eventsOf(t, h, ""); return len(evs) == 1 })
	evs, _ := eventsOf(t, h, "")
	if evs[0]["alert_id"] != im["id"] || evs[0]["im_status"] != "unavailable" || evs[0]["im_error"] != imUnavailable ||
		evs[0]["text"] != "BTCUSDT 跌幅 10.00%，超过 5%" {
		t.Fatalf("IM 提醒的记录 = %v", evs[0])
	}
	waitFor(t, "补发应用内通知", func() bool { return len(e.n.list()) == 1 })
	vs := map[string]map[string]any{}
	for _, x := range list(t, h, "/api/trade/alerts/values") {
		v := x.(map[string]any)
		vs[v["alert_id"].(string)] = v
	}
	if v := vs[vol["id"].(string)]; v["status"] != "ok" || v["value"] != 1.0 {
		t.Fatalf("放量当前值 = %v", v)
	}
	if v := vs[fund["id"].(string)]; v["status"] != "ok" || v["value"] != 0.01 {
		t.Fatalf("资金费率当前值（0.0001 即 0.01%%）= %v", v)
	}
	// 放量到 4 倍、资金费率到 0.06%
	e.src.mu.Lock()
	e.src.lastVol, e.src.funding = 40, 0.0006
	e.src.mu.Unlock()
	e.clock.advance(31 * time.Second) // 让成交量缓存（10 秒）和资金费率（30 秒）过期
	waitFor(t, "放量和资金费率触发", func() bool { evs, _ := eventsOf(t, h, ""); return len(evs) == 3 })
	evs, _ = eventsOf(t, h, "")
	texts := evs[0]["text"].(string) + "|" + evs[1]["text"].(string)
	if !strings.Contains(texts, "BTCUSDT 1 分钟成交量是 20 根均量的 4.00 倍，超过 3 倍") || !strings.Contains(texts, "BTCUSDT.P 资金费率 0.0600%，高于 0.05%") {
		t.Fatalf("触发说明 = %s", texts)
	}
}
