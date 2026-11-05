package trade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 盯盘提醒（TRD-03a）：规则和触发记录落 trade_alerts、trade_alert_events（迁移 0003），
// 后台任务 trade_alerts 每 alertEvery 检查一次，页面关着也照常提醒。
//
// 判定 evalAlerts 是纯函数，逐行移植原型 web-next/src/alertcheck.ts 的 checkAlerts，
// 和原型用同一组夹具对拍（testdata/alerts_golden.json，由 testdata/gen-alert-golden.mjs 跑原型生成）。
// 判定没有「穿越」：价格上穿 70000 在价格一直高于 70000 时也算满足，单次提醒因此只响一次，重复提醒按冷却反复响。
//
// 行情一律取行情缓存（market.go），不另起轮询交易所：启用的提醒用到的标的挂进行情的订阅，最新价每秒刷；
// 资金费率按行情缓存的 30 秒节奏取；放量要的 1 分钟 K 线走 K 线缓存，每个标的 10 秒最多取一次。
// 只在最新价是实时（live）时判定：交易所取不到、给的是缓存时不判定，免得拿旧价格误报。
//
// 触发时：按「last_fired_at 还是读到时的值」条件更新（并发的重新上膛、编辑不会被覆盖），写触发记录，
// 发 trade.alert_fired 事件，选了应用内的发通知。IM 推送：工作台还没有给插件发 IM 的接口（plugin.Core 没有、
// im 插件也没对外提供），触发记录上标 im_status=unavailable 并写原因；这时规则没选应用内的也补发一条应用内通知。
// 声音由打开着的页面收到事件后自己响。

const (
	alertFiredEvent = "trade.alert_fired"
	alertVolumeTTL  = 10 * time.Second
	maxAlertNote    = 500
	maxAlertCool    = 30 * 24 * 60 // 冷却最多 30 天
	imUnavailable   = "工作台还没有给插件发 IM 的接口，这次没推（应用内通知照发）"
)

// alertEvery 是检查间隔；测试里改小。
var alertEvery = 2 * time.Second

// AlertConds 是提醒条件，顺序同原型 ALERT_COND。
var AlertConds = []string{"price_above", "price_below", "pct_above", "pct_below", "volume_spike", "funding_above", "iv_above", "limit_near"}

// alertCondInfo 是条件的显示名和只适用的品种（空为全部），同原型 ALERT_COND。
var alertCondInfo = map[string]struct {
	label string
	kinds []string
}{
	"price_above":   {"价格上穿", nil},
	"price_below":   {"价格下穿", nil},
	"pct_above":     {"涨幅超过", nil},
	"pct_below":     {"跌幅超过", nil},
	"volume_spike":  {"成交量放大", nil},
	"funding_above": {"资金费率高于", []string{"perp"}},
	"iv_above":      {"隐含波动率高于", []string{"option"}},
	"limit_near":    {"接近涨跌停", nil},
}

// AlertNotifies 是通知方式：应用内、IM、声音。
var AlertNotifies = []string{"app", "im", "sound"}

// Alert 同原型 PriceAlert（TradeAlert）。没触发过 last_fired_at 为空串，没选 IM 时 im_connector 为空串。
type Alert struct {
	ID          string   `json:"id"`
	Symbol      string   `json:"symbol"`
	Cond        string   `json:"cond"`
	Value       float64  `json:"value"`
	Repeat      bool     `json:"repeat"`
	CooldownMin int      `json:"cooldown_min"`
	Notify      []string `json:"notify"`
	IMConnector string   `json:"im_connector"`
	Enabled     bool     `json:"enabled"`
	Note        string   `json:"note"`
	LastFiredAt string   `json:"last_fired_at"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}

// AlertEvent 同原型 AlertEvent（TradeAlertEvent），多了触发时的条件、当前值、规则备注和 IM 推送结果。
type AlertEvent struct {
	ID       string  `json:"id"`
	AlertID  string  `json:"alert_id"`
	Symbol   string  `json:"symbol"`
	Cond     string  `json:"cond"`
	Value    float64 `json:"value"`
	Text     string  `json:"text"`
	Price    float64 `json:"price"`
	Note     string  `json:"note"`
	At       string  `json:"at"`
	Read     bool    `json:"read"`
	IMStatus string  `json:"im_status"`
	IMError  string  `json:"im_error"`
}

// AlertFired 是 trade.alert_fired 事件的载荷：触发记录加规则的通知方式。
type AlertFired struct {
	AlertEvent
	Notify []string `json:"notify"`
}

// AlertValue 是一条提醒此刻的当前值（TradeAlertValue），规则表的「当前值」列和抽屉里的「当前值」用。
// status：ok 算出来了；no_source / loading / stale / error 同 Quote 的最新价状态（这时不判定）；
// unsupported 条件不适用于这个标的；unavailable 行情源给不了这项数据（如期权的隐含波动率）。
type AlertValue struct {
	AlertID string   `json:"alert_id"`
	Symbol  string   `json:"symbol"`
	Cond    string   `json:"cond"`
	Status  string   `json:"status"`
	Error   string   `json:"error"`
	Value   *float64 `json:"value"`
	Price   float64  `json:"price"`
	At      string   `json:"at"`
}

/* ---------- 判定（纯函数，对照原型 alertcheck.ts） ---------- */

// AlertInst 是判定要用的标的信息。
type AlertInst struct {
	Symbol string  `json:"symbol"`
	Name   string  `json:"name"`
	Kind   string  `json:"kind"`
	Digits int     `json:"digits"`
	Limit  float64 `json:"limit"`
}

// AlertInput 是判定一条提醒要用的行情，同原型 AlertMarket：最新价、昨收（数币是 24 小时前的开盘价）、
// 最近 21 根 1 分钟成交量（最后一根没走完）、资金费率 %、隐含波动率 %。Inst 为 nil 表示标的找不到。
type AlertInput struct {
	Inst    *AlertInst `json:"inst"`
	Last    float64    `json:"last"`
	Prev    float64    `json:"prev"`
	Volumes []float64  `json:"volumes"`
	Funding float64    `json:"funding"`
	IV      float64    `json:"iv"`
}

// AlertHit 是这一刻该触发的一条：说明、触发价、当前值。
type AlertHit struct {
	Alert Alert
	Inst  *AlertInst
	Text  string
	Price float64
	Value float64
}

// alertCondFits 同原型 condFits：标的存在、品种适用、接近涨跌停要有涨跌停幅度。
func alertCondFits(cond string, i *AlertInst) bool {
	if i == nil {
		return false
	}
	info, ok := alertCondInfo[cond]
	if !ok {
		return false
	}
	if info.kinds != nil && !slices.Contains(info.kinds, i.Kind) {
		return false
	}
	if cond == "limit_near" && i.Limit == 0 {
		return false
	}
	return true
}

// alertCondValue 同原型 condValueOn：按条件的单位算当前值，不适用或算不出回 false。
// 先乘后加的地方显式转一次 float64，不让编译器合成乘加（结果和原型逐位一致）。
func alertCondValue(cond string, in AlertInput) (float64, bool) {
	i := in.Inst
	if !alertCondFits(cond, i) {
		return 0, false
	}
	last := in.Last
	switch cond {
	case "price_above", "price_below":
		return last, true
	case "pct_above", "pct_below":
		prev := in.Prev
		pct := 0.0
		if prev != 0 {
			pct = ((last - prev) / prev) * 100
		}
		if cond == "pct_above" {
			return pct, true
		}
		return -pct, true
	case "volume_spike":
		xs := in.Volumes
		if len(xs) == 0 {
			return 0, false
		}
		s := 0.0
		for _, v := range xs[:len(xs)-1] {
			s += math.Abs(v)
		}
		avg := s / float64(max(1, len(xs)-1))
		if avg == 0 {
			return 0, true
		}
		return math.Abs(xs[len(xs)-1]) / avg, true
	case "funding_above":
		return in.Funding, true
	case "iv_above":
		return in.IV, true
	case "limit_near":
		prev := in.Prev
		up, down := float64(prev*(1+i.Limit)), float64(prev*(1-i.Limit))
		return (math.Min(float64(up-last), float64(last-down)) / prev) * 100, true
	}
	return 0, false
}

// alertHit 同原型 hit：价格下穿、接近涨跌停是小于等于，其余大于等于。
func alertHit(cond string, v, th float64) bool {
	if cond == "price_below" || cond == "limit_near" {
		return v <= th
	}
	return v >= th
}

func alertDigits(i *AlertInst) int {
	if i == nil {
		return 2
	}
	return i.Digits
}

// fmtAlertPrice 同原型 p.toLocaleString('en-US', {minimumFractionDigits: d, maximumFractionDigits: d})：
// 按最短十进制表示正好一半时远离零进位，整数部分千分位；负数（含 -0 和舍成 0 的负数）带负号，同 ICU。
func fmtAlertPrice(i *AlertInst, p float64) string {
	return groupThousands(localeFixed(p, alertDigits(i)))
}

func localeFixed(x float64, d int) string {
	if !finite(x) {
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	neg := math.Signbit(x)
	s := strconv.FormatFloat(math.Abs(x), 'f', -1, 64)
	ip, fp, _ := strings.Cut(s, ".")
	fp += strings.Repeat("0", d+1)
	digits := []byte(ip + fp[:d])
	if fp[d] >= '5' {
		k := len(digits) - 1
		for ; k >= 0; k-- {
			if digits[k] == '9' {
				digits[k] = '0'
				continue
			}
			digits[k]++
			break
		}
		if k < 0 {
			digits = append([]byte{'1'}, digits...)
		}
	}
	t := string(digits)
	if d > 0 {
		t = t[:len(t)-d] + "." + t[len(t)-d:]
	}
	if neg {
		t = "-" + t
	}
	return t
}

func groupThousands(s string) string {
	sign := ""
	if strings.HasPrefix(s, "-") {
		sign, s = "-", s[1:]
	}
	ip, fp, hasFrac := strings.Cut(s, ".")
	var b strings.Builder
	for k, c := range ip {
		if k > 0 && (len(ip)-k)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	if hasFrac {
		return sign + b.String() + "." + fp
	}
	return sign + b.String()
}

// jsString 同 JS 的 String(number)，阈值写进说明时用；-0 写 0。
func jsString(x float64) string {
	if x == 0 {
		return "0"
	}
	return numStr(x)
}

// fmtAlertValue 同原型 fmtCondValue：价格按标的精度，量比两位小数加「倍」，资金费率四位小数加 %，其余两位小数加 %。
func fmtAlertValue(cond string, i *AlertInst, v float64) string {
	switch cond {
	case "price_above", "price_below":
		return fmtAlertPrice(i, v)
	case "volume_spike":
		return toFixed(v, 2) + " 倍"
	case "funding_above":
		return toFixed(v, 4) + "%"
	}
	return toFixed(v, 2) + "%"
}

// alertText 同原型 alertText。
func alertText(a Alert, i *AlertInst, v float64) string {
	name := a.Symbol
	if i != nil {
		name = i.Name
	}
	th := jsString(a.Value)
	if a.Cond == "price_above" || a.Cond == "price_below" {
		th = fmtAlertPrice(i, a.Value)
	}
	switch a.Cond {
	case "price_above":
		return fmt.Sprintf("%s 价格 %s，上穿 %s", name, fmtAlertPrice(i, v), th)
	case "price_below":
		return fmt.Sprintf("%s 价格 %s，下穿 %s", name, fmtAlertPrice(i, v), th)
	case "pct_above":
		return fmt.Sprintf("%s 涨幅 %s%%，超过 %s%%", name, toFixed(v, 2), th)
	case "pct_below":
		return fmt.Sprintf("%s 跌幅 %s%%，超过 %s%%", name, toFixed(v, 2), th)
	case "volume_spike":
		return fmt.Sprintf("%s 1 分钟成交量是 20 根均量的 %s 倍，超过 %s 倍", name, toFixed(v, 2), th)
	case "funding_above":
		return fmt.Sprintf("%s 资金费率 %s%%，高于 %s%%", name, toFixed(v, 4), th)
	case "iv_above":
		return fmt.Sprintf("%s 隐含波动率 %s%%，高于 %s%%", name, toFixed(v, 1), th)
	case "limit_near":
		return fmt.Sprintf("%s 距涨跌停 %s%%，在 %s%% 以内", name, toFixed(v, 2), th)
	}
	return name
}

// evalAlerts 同原型 checkAlertsOn：给定时刻、给定行情，哪些提醒该触发。
// marketOf 回 false 表示这条提醒的行情现在拿不到（没接、不是实时），跳过不判定。
func evalAlerts(alerts []Alert, at time.Time, marketOf func(a Alert) (AlertInput, bool)) []AlertHit {
	var out []AlertHit
	for _, a := range alerts {
		if !a.Enabled {
			continue
		}
		in, ok := marketOf(a)
		if !ok || !alertCondFits(a.Cond, in.Inst) {
			continue
		}
		if a.LastFiredAt != "" {
			// 单次提醒触发过就不再响；重复提醒要过了冷却
			if !a.Repeat {
				continue
			}
			if fired, err := time.Parse(time.RFC3339Nano, a.LastFiredAt); err == nil &&
				at.UnixMilli()-fired.UnixMilli() < int64(max(0, a.CooldownMin))*60000 {
				continue
			}
		}
		v, ok := alertCondValue(a.Cond, in)
		if !ok || !finite(v) || !alertHit(a.Cond, v, a.Value) {
			continue
		}
		out = append(out, AlertHit{Alert: a, Inst: in.Inst, Text: alertText(a, in.Inst, v), Price: in.Last, Value: v})
	}
	return out
}

/* ---------- 标的信息 ---------- */

// venueMarkets 是交易场所到市场的对照，标的表里还没有时按它推（同前端 guessInstrument）。
var venueMarkets = map[string]string{
	"BINANCE": "crypto", "OKX": "crypto", "FAKE": "crypto", "BYBIT": "crypto", "DERIBIT": "crypto",
	"SSE": "cn", "SZSE": "cn", "BSE": "cn", "CFFEX": "cn", "SHFE": "cn", "DCE": "cn", "CZCE": "cn", "INE": "cn",
	"HKEX": "hk",
}

// guessAlertInst 在标的表里还没有（行情源没同步、或这个市场没接）时按 symbol 推一个：
// 数币按代码后缀分永续（.P、-SWAP）、交割（OKX 带 6 位日期）、现货；别的市场一律按现货。精度 -1 表示按价格大小定。
func guessAlertInst(symbol string) *AlertInst {
	venue, code := codeOf(symbol)
	kind := "spot"
	if venueMarkets[venue] == "crypto" {
		switch {
		case strings.HasSuffix(code, ".P") || strings.HasSuffix(code, "-SWAP"):
			kind = "perp"
		case len(code) > 7 && code[len(code)-7] == '-' && isDigits(code[len(code)-6:]):
			kind = "future"
		}
	}
	return &AlertInst{Symbol: symbol, Name: guessName(venue, code, kind == "perp"), Kind: kind, Digits: -1}
}

// guessName 同前端 guessInstrument 的名字：Binance、OKX 的现货写成 BTC/USDT，永续写成 BTC 永续，别的用代码。
func guessName(venue, code string, perp bool) string {
	switch venue {
	case "BINANCE":
		if perp {
			return strings.TrimSuffix(code, "USDT.P") + " 永续"
		}
		if base, ok := strings.CutSuffix(code, "USDT"); ok {
			return base + "/USDT"
		}
	case "OKX":
		if perp {
			return strings.SplitN(code, "-", 2)[0] + " 永续"
		}
		return strings.Replace(code, "-", "/", 1)
	}
	return code
}

func isDigits(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return s != ""
}

// priceDigits 按价格大小给小数位（同前端 digitsFor）。
func priceDigits(p float64) int {
	a := math.Abs(p)
	switch {
	case a >= 1000:
		return 1
	case a >= 1:
		return 2
	case a >= 0.01:
		return 4
	}
	return 6
}

// loadAlertInsts 从标的表读这些标的，没有的按 symbol 推。
func loadAlertInsts(ctx context.Context, c plugin.Core, symbols []string) map[string]*AlertInst {
	out := make(map[string]*AlertInst, len(symbols))
	for _, s := range symbols {
		var i AlertInst
		err := c.Store().QueryRow(ctx, `SELECT symbol, name, kind, digits, price_limit FROM trade_instruments WHERE symbol = ?`, s).
			Scan(&i.Symbol, &i.Name, &i.Kind, &i.Digits, &i.Limit)
		if err != nil {
			out[s] = guessAlertInst(s)
			continue
		}
		out[s] = &i
	}
	return out
}

/* ---------- 存取 ---------- */

const alertCols = `id, symbol, cond, value, repeat, cooldown_min, notify, im_connector, enabled, note, last_fired_at, created_at, updated_at`
const alertEventCols = `id, alert_id, symbol, cond, value, text, price, note, at, read, im_status, im_error`

func scanAlert(row plugin.Row) (Alert, error) {
	var a Alert
	var rep, en int
	var notify string
	err := row.Scan(&a.ID, &a.Symbol, &a.Cond, &a.Value, &rep, &a.CooldownMin, &notify, &a.IMConnector, &en, &a.Note,
		&a.LastFiredAt, &a.CreatedAt, &a.UpdatedAt)
	a.Repeat, a.Enabled = rep == 1, en == 1
	if json.Unmarshal([]byte(notify), &a.Notify) != nil || a.Notify == nil {
		a.Notify = []string{}
	}
	return a, err
}

func scanAlertEvent(row plugin.Row) (AlertEvent, error) {
	var e AlertEvent
	var read int
	err := row.Scan(&e.ID, &e.AlertID, &e.Symbol, &e.Cond, &e.Value, &e.Text, &e.Price, &e.Note, &e.At, &read, &e.IMStatus, &e.IMError)
	e.Read = read == 1
	return e, err
}

func loadAlerts(ctx context.Context, c plugin.Core, onlyEnabled bool) ([]Alert, error) {
	q := `SELECT ` + alertCols + ` FROM trade_alerts`
	if onlyEnabled {
		q += ` WHERE enabled = 1`
	}
	rows, err := c.Store().Query(ctx, q+` ORDER BY created_at DESC, rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Alert{}
	for rows.Next() {
		a, err := scanAlert(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

/* ---------- 后台检查 ---------- */

type volSnap struct {
	vols   []float64
	ok     bool
	err    string
	tookAt time.Time
}

// alerter 是后台检查的状态：上一轮算出的当前值、挂在行情上的订阅、放量用的成交量缓存。
type alerter struct {
	p *Plugin
	c plugin.Core

	mu       sync.Mutex
	values   map[string]AlertValue // alert id -> 上一轮的当前值
	unsub    func()
	subKey   string
	vols     map[string]volSnap
	imLogged bool
}

func newAlerter(p *Plugin, c plugin.Core) *alerter {
	return &alerter{p: p, c: c, values: map[string]AlertValue{}, vols: map[string]volSnap{}}
}

func (a *alerter) now() time.Time { return a.p.mkt.now() }

// watch 把这些标的挂进行情订阅（最新价每秒刷），换了一组才重挂。
func (a *alerter) watch(symbols []string) {
	sort.Strings(symbols)
	key := strings.Join(symbols, ",")
	a.mu.Lock()
	defer a.mu.Unlock()
	if key == a.subKey {
		return
	}
	if a.unsub != nil {
		a.unsub()
		a.unsub = nil
	}
	a.subKey = key
	if len(symbols) > 0 {
		a.unsub = a.p.mkt.subscribe(symbols, "")
	}
}

// volumes 取最近 21 根 1 分钟 K 线的成交量，每个标的 alertVolumeTTL 内只取一次。
func (a *alerter) volumes(ctx context.Context, sym string) volSnap {
	now := a.now()
	a.mu.Lock()
	v, ok := a.vols[sym]
	a.mu.Unlock()
	if ok && now.Sub(v.tookAt) < alertVolumeTTL {
		return v
	}
	ks, meta, err := a.p.mkt.klines(ctx, sym, "1m", 21, time.Time{})
	v = volSnap{tookAt: now}
	switch {
	case err != nil:
		v.err = err.Error()
	case meta.Status != "live":
		v.err = meta.Error
		if v.err == "" {
			v.err = "1 分钟 K 线不是实时的"
		}
	case len(ks) < 2:
		v.err = "1 分钟 K 线不够"
	default:
		v.ok = true
		for _, k := range ks {
			v.vols = append(v.vols, k.Volume)
		}
	}
	a.mu.Lock()
	a.vols[sym] = v
	a.mu.Unlock()
	return v
}

// inputFor 拼一条提醒的判定输入；拿不到回 false，同时给出当前值的状态和原因。
// probe 为真时是抽屉里现查：最新价还没有就当场取一次。
func (a *alerter) inputFor(ctx context.Context, cond, sym string, inst *AlertInst, probe bool) (AlertInput, string, string) {
	in := AlertInput{Inst: inst}
	if !alertCondFits(cond, inst) {
		return in, "unsupported", unsupportedReason(cond)
	}
	m := a.p.mkt
	if probe {
		m.ensure(ctx, "ticker", sym)
	}
	q := m.quote(ctx, sym)
	if q.Status != "live" {
		msg := q.Error
		if q.Status == "stale" && msg == "" {
			msg = "最新价超过 90 秒没刷到"
		}
		return in, q.Status, msg
	}
	in.Last, in.Prev = q.Last, q.Open24h
	if inst.Digits < 0 {
		cp := *inst
		cp.Digits = priceDigits(q.Last)
		in.Inst = &cp
	}
	switch cond {
	case "volume_spike":
		v := a.volumes(ctx, sym)
		if !v.ok {
			return in, "unavailable", v.err
		}
		in.Volumes = v.vols
	case "funding_above":
		m.ensure(ctx, "funding", sym)
		f := m.fundingOf(sym)
		if f.Status != "live" {
			return in, "unavailable", strings.TrimSpace("资金费率不是实时的 " + f.Error)
		}
		in.Funding = f.Rate * 100
	case "iv_above":
		return in, "unavailable", "还没有期权行情源，取不到隐含波动率"
	case "limit_near", "pct_above", "pct_below":
		if in.Prev == 0 {
			return in, "unavailable", "没有昨收（24 小时前的开盘价）"
		}
	}
	return in, "ok", ""
}

func unsupportedReason(cond string) string {
	switch cond {
	case "funding_above":
		return "资金费率只适用于永续合约"
	case "iv_above":
		return "隐含波动率只适用于期权"
	case "limit_near":
		return "这个标的没有涨跌停"
	}
	return "条件不适用于这个标的"
}

func valueOf(alertID, cond, sym string, in AlertInput, status, msg string, at time.Time) AlertValue {
	out := AlertValue{AlertID: alertID, Symbol: sym, Cond: cond, Status: status, Error: msg, At: fmtT(at)}
	if status == "ok" {
		if v, ok := alertCondValue(cond, in); ok && finite(v) {
			out.Value = &v
			out.Price = in.Last
		} else {
			out.Status, out.Error = "unavailable", "当前值算不出来"
		}
	}
	return out
}

// check 跑一轮：读启用的提醒，挂订阅，算当前值，触发该触发的。
func (a *alerter) check(ctx context.Context) error {
	alerts, err := loadAlerts(ctx, a.c, true)
	if err != nil {
		return err
	}
	syms := []string{}
	for _, x := range alerts {
		if !slices.Contains(syms, x.Symbol) {
			syms = append(syms, x.Symbol)
		}
	}
	a.watch(slices.Clone(syms))
	insts := loadAlertInsts(ctx, a.c, syms)
	now := a.now()
	inputs := map[string]AlertInput{}
	values := map[string]AlertValue{}
	for _, x := range alerts {
		in, status, msg := a.inputFor(ctx, x.Cond, x.Symbol, insts[x.Symbol], false)
		values[x.ID] = valueOf(x.ID, x.Cond, x.Symbol, in, status, msg, now)
		if status == "ok" {
			inputs[x.ID] = in
		}
	}
	a.mu.Lock()
	a.values = values
	a.mu.Unlock()
	hits := evalAlerts(alerts, now, func(x Alert) (AlertInput, bool) { in, ok := inputs[x.ID]; return in, ok })
	for _, h := range hits {
		if err := a.fire(ctx, h, now); err != nil {
			a.c.Log().Warn("alert fire failed", "alert", h.Alert.ID, "err", err)
		}
	}
	return nil
}

// fire 记一次触发：条件更新 last_fired_at，写触发记录，发事件和通知。
func (a *alerter) fire(ctx context.Context, h AlertHit, now time.Time) error {
	at := fmtT(now)
	x := h.Alert
	res, err := a.c.Store().Exec(ctx, `UPDATE trade_alerts SET last_fired_at = ? WHERE id = ? AND enabled = 1 AND last_fired_at = ?`, at, x.ID, x.LastFiredAt)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return nil // 这一轮之间被停用、编辑或重新上膛了，下一轮按新的来
	}
	ev := AlertEvent{ID: idgen.Prefixed("ae"), AlertID: x.ID, Symbol: x.Symbol, Cond: x.Cond, Value: h.Value, Text: h.Text, Price: h.Price, Note: x.Note, At: at}
	wantIM := slices.Contains(x.Notify, "im")
	if wantIM {
		ev.IMStatus, ev.IMError = "unavailable", imUnavailable
		a.mu.Lock()
		first := !a.imLogged
		a.imLogged = true
		a.mu.Unlock()
		if first {
			a.c.Log().Info("alert im push unavailable: no plugin IM send capability yet", "alert", x.ID, "connector", x.IMConnector)
		}
	}
	if _, err := a.c.Store().Exec(ctx, `INSERT INTO trade_alert_events (`+alertEventCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		ev.ID, ev.AlertID, ev.Symbol, ev.Cond, ev.Value, ev.Text, ev.Price, ev.Note, ev.At, ev.IMStatus, ev.IMError); err != nil {
		return err
	}
	notify := slices.Clone(x.Notify)
	if err := a.c.Events().Publish(ctx, alertFiredEvent, AlertFired{AlertEvent: ev, Notify: notify}); err != nil {
		a.c.Log().Warn("publish alert_fired failed", "alert", x.ID, "err", err)
	}
	// 应用内通知：选了应用内的发；只选了 IM 又推不出去的也补一条，免得什么都收不到
	if slices.Contains(x.Notify, "app") || wantIM {
		body := "触发价 " + fmtAlertPrice(h.Inst, h.Price)
		if x.Note != "" {
			body = x.Note + "\n" + body
		}
		err := a.c.Notify(ctx, plugin.Notification{Kind: "alert", Title: h.Text, Body: body,
			Data: map[string]any{"alert_id": x.ID, "event_id": ev.ID, "symbol": x.Symbol}})
		if err != nil && !errors.Is(err, plugin.ErrNoNotifier) {
			a.c.Log().Warn("alert notify failed", "alert", x.ID, "err", err)
		}
	}
	return nil
}

// value 回这条提醒上一轮算出的当前值；还没算过的回 loading。
func (a *alerter) value(x Alert) AlertValue {
	a.mu.Lock()
	v, ok := a.values[x.ID]
	a.mu.Unlock()
	if ok && v.Symbol == x.Symbol && v.Cond == x.Cond {
		return v
	}
	return AlertValue{AlertID: x.ID, Symbol: x.Symbol, Cond: x.Cond, Status: "loading"}
}
