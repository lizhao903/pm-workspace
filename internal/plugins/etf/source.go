// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package etf

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// 宽基数据源适配接口（ETF-01a）：只读，列出宽基、拉某交易日的份额与交易快照。
// 真实源是东方财富（eastmoney），另有不出网的 fake 给测试和离线演练。
// 没有下单、撤单、划转、提币，任何情况下都不碰资金。

// ErrUnsupported：源不提供这项数据。
var ErrUnsupported = errors.New("数据源不支持")

// ErrUnknownSymbol：源里没有这只 ETF。
var ErrUnknownSymbol = errors.New("没有这个标的")

// HTTPDoer 是出网函数，由插件在 Register 时注入 Core.HTTP("market-data")。
// 插件里不直接用默认客户端出网，域名清单由内核守着（network.go）。
type HTTPDoer func(ctx context.Context) (*http.Client, error)

// httpBinder 是可选接口：需要出网的源实现它，Register 时接上受控客户端。
type httpBinder interface{ BindHTTP(fn HTTPDoer) }

// Fund 是宽基 ETF 的静态元信息，同时是 etf_funds 的行和接口里的形状。
type Fund struct {
	Symbol     string `json:"symbol"`
	Name       string `json:"name"`
	TrackIndex string `json:"track_index"`
	Category   string `json:"category"`
	Manager    string `json:"manager"`
	Market     string `json:"market"`
	Secid      string `json:"secid"`
	Underlying string `json:"underlying"`
	LaunchDate string `json:"launch_date"`
	UpdatedAt  string `json:"updated_at"`
}

// Daily 是一天一只 ETF 的份额与交易快照，同时是 etf_daily 的行和接口里的形状。
// 源只填原始量（份额、净值、行情）；aum、premium_discount、updated_at 由采集时算。
type Daily struct {
	Date            string  `json:"date"`
	Symbol          string  `json:"symbol"`
	Shares          float64 `json:"shares"`
	NAV             float64 `json:"nav"`
	Price           float64 `json:"price"`
	Open            float64 `json:"open"`
	High            float64 `json:"high"`
	Low             float64 `json:"low"`
	Volume          float64 `json:"volume"`
	Amount          float64 `json:"amount"`
	ChangePct       float64 `json:"change_pct"`
	ChangeAmount    float64 `json:"change_amount"`
	Amplitude       float64 `json:"amplitude"`
	TurnoverRate    float64 `json:"turnover_rate"`
	AUM             float64 `json:"aum"`
	PremiumDiscount float64 `json:"premium_discount"`
	// IOPV 是盘中参考净值（元），只有采集最近交易日时能拿到，历史日期为 0（ETF-01b）。
	IOPV float64 `json:"iopv"`
	// PremiumBasis 是折溢价口径：iopv / nav / none（两样都没有，折溢价不可用），采集时定。
	PremiumBasis string `json:"premium_basis"`
	Source       string `json:"source"`
	UpdatedAt    string `json:"updated_at"`
}

// IndexBar 是跟踪指数一天的行情，同时是 etf_index_daily 的行和接口里的形状（ETF-01b）。
type IndexBar struct {
	Date      string  `json:"date"`
	Code      string  `json:"code"`
	Close     float64 `json:"close"`
	ChangePct float64 `json:"change_pct"`
	Amount    float64 `json:"amount"`
	Source    string  `json:"source"`
	UpdatedAt string  `json:"updated_at"`
}

// IndexSource 是可选接口：能拉跟踪指数日行情的源实现它，没实现的源跟踪误差和超额收益为空（ETF-01b）。
type IndexSource interface {
	// IndexDaily 拉某交易日（空串为最近交易日）这批指数代码的日行情，取不到的代码跳过。
	IndexDaily(ctx context.Context, date string, codes []string) ([]IndexBar, error)
}

// Source 是一个宽基数据源，只读。
type Source interface {
	ID() string
	Name() string
	// Funds 返回覆盖的宽基 ETF 静态元信息。
	Funds(ctx context.Context) ([]Fund, error)
	// Daily 拉取某交易日（YYYY-MM-DD，空串为最近交易日）这批 symbol 的快照。
	Daily(ctx context.Context, date string, symbols []string) ([]Daily, error)
}

// broadBased 是本插件覆盖的宽基 ETF 清单（静态元信息）。
// secid 前缀 1 是上交所、0 是深交所；underlying 是跟踪指数代码。
// 新增一只在这里加一行即可，采集时按这份清单拉数据。
var broadBased = []Fund{
	{Symbol: "510300", Name: "沪深300ETF", TrackIndex: "沪深300", Manager: "华泰柏瑞基金", Market: "SH", Secid: "1.510300", Underlying: "000300"},
	{Symbol: "510330", Name: "沪深300ETF华夏", TrackIndex: "沪深300", Manager: "华夏基金", Market: "SH", Secid: "1.510330", Underlying: "000300"},
	{Symbol: "159919", Name: "沪深300ETF嘉实", TrackIndex: "沪深300", Manager: "嘉实基金", Market: "SZ", Secid: "0.159919", Underlying: "000300"},
	{Symbol: "510500", Name: "中证500ETF", TrackIndex: "中证500", Manager: "南方基金", Market: "SH", Secid: "1.510500", Underlying: "000905"},
	{Symbol: "510050", Name: "上证50ETF", TrackIndex: "上证50", Manager: "华夏基金", Market: "SH", Secid: "1.510050", Underlying: "000016"},
	{Symbol: "510180", Name: "上证180ETF", TrackIndex: "上证180", Manager: "华安基金", Market: "SH", Secid: "1.510180", Underlying: "000010"},
	{Symbol: "159915", Name: "创业板ETF", TrackIndex: "创业板指", Manager: "易方达基金", Market: "SZ", Secid: "0.159915", Underlying: "399006"},
	{Symbol: "588000", Name: "科创50ETF", TrackIndex: "科创50", Manager: "华夏基金", Market: "SH", Secid: "1.588000", Underlying: "000688"},
	{Symbol: "512100", Name: "中证1000ETF", TrackIndex: "中证1000", Manager: "南方基金", Market: "SH", Secid: "1.512100", Underlying: "000852"},
	{Symbol: "159845", Name: "中证1000ETF华夏", TrackIndex: "中证1000", Manager: "华夏基金", Market: "SZ", Secid: "0.159845", Underlying: "000852"},
}

// EastMoney 是东方财富公开数据源：行情走 push2his 日 K，份额走数据中心基金份额表。
// 它只读公开页面背后的结构化接口，不需要 token。
type EastMoney struct {
	http HTTPDoer
}

// NewEastMoney 建一个东方财富源；出网客户端在插件 Register 时绑定。
func NewEastMoney() *EastMoney { return &EastMoney{} }

// BindHTTP 由插件 Register 调用，注入 Core.HTTP("market-data")。
func (e *EastMoney) BindHTTP(fn HTTPDoer) { e.http = fn }

func (e *EastMoney) ID() string   { return "eastmoney" }
func (e *EastMoney) Name() string { return "东方财富" }

// Funds 返回内置的宽基清单。静态元信息不走网络，避免每次采集多打一轮请求。
func (e *EastMoney) Funds(_ context.Context) ([]Fund, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	out := make([]Fund, 0, len(broadBased))
	for _, f := range broadBased {
		f.UpdatedAt = now
		out = append(out, f)
	}
	return out, nil
}

// Daily 逐只拉日 K 与份额。行情失败整体失败；份额取不到只把 shares 留 0，行情照常返回。
func (e *EastMoney) Daily(ctx context.Context, date string, symbols []string) ([]Daily, error) {
	if e.http == nil {
		return nil, errors.New("东方财富源还没接上出网客户端")
	}
	hc, err := e.http(ctx)
	if err != nil {
		return nil, err
	}
	bySymbol := make(map[string]Fund, len(broadBased))
	for _, f := range broadBased {
		bySymbol[f.Symbol] = f
	}
	// 最近交易日多拉一轮实时快照补总份额和 IOPV（ETF-01b）；历史日期没有快照，拿不到不算失败
	var snaps map[string]quoteSnap
	if date == "" {
		secids := make([]string, 0, len(symbols))
		for _, sym := range symbols {
			if f, ok := bySymbol[sym]; ok {
				secids = append(secids, f.Secid)
			}
		}
		snaps, _ = e.fetchSnapshots(ctx, hc, secids)
	}
	out := make([]Daily, 0, len(symbols))
	for _, sym := range symbols {
		f, ok := bySymbol[sym]
		if !ok {
			continue
		}
		d, err := e.fetchDaily(ctx, hc, f, date, snaps[sym])
		if err != nil {
			return nil, fmt.Errorf("%s: %w", sym, err)
		}
		out = append(out, d)
	}
	if len(out) == 0 {
		return nil, ErrUnknownSymbol
	}
	return out, nil
}

// IndexDaily 拉跟踪指数的日 K（ETF-01b）：同 ETF 日 K 的接口，指数不复权；取不到的代码跳过。
func (e *EastMoney) IndexDaily(ctx context.Context, date string, codes []string) ([]IndexBar, error) {
	if e.http == nil {
		return nil, errors.New("东方财富源还没接上出网客户端")
	}
	hc, err := e.http(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]IndexBar, 0, len(codes))
	for _, code := range codes {
		k, err := e.fetchKline(ctx, hc, indexSecid(code), date)
		if err != nil {
			continue
		}
		out = append(out, IndexBar{Date: k.date, Code: code, Close: k.close, ChangePct: k.changePct, Amount: k.amount, Source: e.ID()})
	}
	return out, nil
}

// indexSecid 把指数代码换成东方财富证券标识：399 开头是深交所指数（0.），其余（000300、000905、000852…）是 1.。
func indexSecid(code string) string {
	if strings.HasPrefix(code, "399") {
		return "0." + code
	}
	return "1." + code
}

// quoteSnap 是实时快照里用到的两项：f38 总份额（份）、f441 IOPV（元），f124 是行情时间（Unix 秒）。
type quoteSnap struct {
	date   string
	shares float64
	iopv   float64
}

// fetchSnapshots 一次拉一批 ETF 的实时快照（push2 ulist.np），按 6 位代码返回。
func (e *EastMoney) fetchSnapshots(ctx context.Context, hc *http.Client, secids []string) (map[string]quoteSnap, error) {
	if len(secids) == 0 {
		return nil, nil
	}
	q := url.Values{}
	q.Set("secids", strings.Join(secids, ","))
	q.Set("fields", "f12,f38,f124,f441")
	q.Set("fltt", "2")
	body, err := e.get(ctx, hc, "https://push2.eastmoney.com/api/qt/ulist.np/get?"+q.Encode())
	if err != nil {
		return nil, err
	}
	return parseSnapshots(body)
}

func parseSnapshots(body []byte) (map[string]quoteSnap, error) {
	var resp struct {
		Data *struct {
			Diff []map[string]json.RawMessage `json:"diff"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("解析实时快照失败: %w", err)
	}
	out := map[string]quoteSnap{}
	if resp.Data == nil {
		return out, nil
	}
	for _, row := range resp.Data.Diff {
		code := strings.Trim(string(row["f12"]), `"`)
		if code == "" {
			continue
		}
		snap := quoteSnap{shares: parseFlexFloat(row["f38"]), iopv: parseFlexFloat(row["f441"])}
		if ts := parseFlexFloat(row["f124"]); ts > 0 {
			snap.date = time.Unix(int64(ts), 0).In(shanghai).Format(time.DateOnly)
		}
		out[code] = snap
	}
	return out, nil
}

// shanghai 是 A 股的时区；系统里没有时区库时退到固定 +8。
var shanghai = func() *time.Location {
	if loc, err := time.LoadLocation("Asia/Shanghai"); err == nil {
		return loc
	}
	return time.FixedZone("CST", 8*3600)
}()

func (e *EastMoney) fetchDaily(ctx context.Context, hc *http.Client, f Fund, date string, snap quoteSnap) (Daily, error) {
	k, err := e.fetchKline(ctx, hc, f.Secid, date)
	if err != nil {
		return Daily{}, err
	}
	d := Daily{
		Date:         k.date,
		Symbol:       f.Symbol,
		Open:         k.open,
		Price:        k.close,
		High:         k.high,
		Low:          k.low,
		Volume:       k.volume,
		Amount:       k.amount,
		ChangePct:    k.changePct,
		ChangeAmount: k.changeAmount,
		Amplitude:    k.amplitude,
		TurnoverRate: k.turnoverRate,
		Source:       e.ID(),
	}
	// 实时快照和日 K 是同一天才用：总份额（f38）、IOPV（f441）
	if snap.date == k.date {
		d.Shares = snap.shares
		d.IOPV = snap.iopv
	}
	// 份额偶有延迟：取不到不整体失败，留 0，下次采集补齐。
	if d.Shares <= 0 {
		if shares, err := e.fetchShares(ctx, hc, f.Symbol, date); err == nil {
			d.Shares = shares
		}
	}
	return d, nil
}

type klineRow struct {
	date         string
	open         float64
	close        float64
	high         float64
	low          float64
	volume       float64
	amount       float64
	amplitude    float64
	changePct    float64
	changeAmount float64
	turnoverRate float64
}

// fetchKline 拉日 K。date 为空取最近一根；指定日期只取那一天。
// fields2 顺序：f51 日期、f52 开、f53 收、f54 高、f55 低、f56 量、f57 额、f58 振幅、f59 涨跌幅、f60 涨跌额、f61 换手率。
func (e *EastMoney) fetchKline(ctx context.Context, hc *http.Client, secid, date string) (klineRow, error) {
	q := url.Values{}
	q.Set("secid", secid)
	q.Set("fields1", "f1,f2,f3,f4,f5,f6")
	q.Set("fields2", "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61")
	q.Set("klt", "101") // 日 K
	q.Set("fqt", "1")   // 前复权
	q.Set("lmt", "1")
	if date == "" {
		q.Set("beg", "0")
		q.Set("end", "20500101")
	} else {
		ymd := strings.ReplaceAll(date, "-", "")
		q.Set("beg", ymd)
		q.Set("end", ymd)
	}
	body, err := e.get(ctx, hc, "https://push2his.eastmoney.com/api/qt/stock/kline/get?"+q.Encode())
	if err != nil {
		return klineRow{}, err
	}
	var resp struct {
		Data *struct {
			Klines []string `json:"klines"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return klineRow{}, fmt.Errorf("解析日 K 失败: %w", err)
	}
	if resp.Data == nil || len(resp.Data.Klines) == 0 {
		return klineRow{}, ErrUnknownSymbol
	}
	return parseKline(resp.Data.Klines[len(resp.Data.Klines)-1])
}

func parseKline(line string) (klineRow, error) {
	parts := strings.Split(line, ",")
	if len(parts) < 11 {
		return klineRow{}, fmt.Errorf("日 K 字段不足：%q", line)
	}
	f := func(i int) float64 {
		v, _ := strconv.ParseFloat(strings.TrimSpace(parts[i]), 64)
		return v
	}
	return klineRow{
		date:         strings.TrimSpace(parts[0]),
		open:         f(1),
		close:        f(2),
		high:         f(3),
		low:          f(4),
		volume:       f(5),
		amount:       f(6),
		amplitude:    f(7),
		changePct:    f(8),
		changeAmount: f(9),
		turnoverRate: f(10),
	}, nil
}

// fetchShares 从数据中心基金份额表取最新一条期末总份额（OCF）。
// OCF 单位是亿份，落库前换成份；数值已经很大时按份处理，避免重复放大。
func (e *EastMoney) fetchShares(ctx context.Context, hc *http.Client, symbol, date string) (float64, error) {
	q := url.Values{}
	q.Set("reportName", "RPT_FUND_SCALE_DET")
	q.Set("columns", "ALL")
	q.Set("filter", fmt.Sprintf(`(FCODE="%s")`, symbol))
	q.Set("pageNumber", "1")
	q.Set("pageSize", "1")
	q.Set("sortColumns", "ENDDATE")
	q.Set("sortTypes", "-1")
	q.Set("source", "WEB")
	q.Set("client", "WEB")
	body, err := e.get(ctx, hc, "https://datacenter-web.eastmoney.com/api/data/v1/get?"+q.Encode())
	if err != nil {
		return 0, err
	}
	var resp struct {
		Result *struct {
			Data []struct {
				ENDDATE string          `json:"ENDDATE"`
				OCF     json.RawMessage `json:"OCF"`
			} `json:"data"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, fmt.Errorf("解析基金份额失败: %w", err)
	}
	if resp.Result == nil || len(resp.Result.Data) == 0 {
		return 0, ErrUnsupported
	}
	row := resp.Result.Data[0]
	// 指定了日期但份额还没更新到那天，放弃这次，等下次补齐。
	if date != "" && !sameDay(row.ENDDATE, date) {
		return 0, ErrUnsupported
	}
	ocf := parseFlexFloat(row.OCF)
	if ocf <= 0 {
		return 0, ErrUnsupported
	}
	if ocf < 1e6 {
		ocf *= 1e8
	}
	return ocf, nil
}

func (e *EastMoney) get(ctx context.Context, hc *http.Client, raw string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; pmw-etf/0.1)")
	req.Header.Set("Referer", "https://data.eastmoney.com/")
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("东方财富返回 %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 4<<20))
}

func parseFlexFloat(raw json.RawMessage) float64 {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if s == "" || s == "null" || s == "-" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}

func sameDay(a, b string) bool {
	return len(a) >= 10 && len(b) >= 10 && a[:10] == b[:10]
}

// Fake 是不出网的演示源，给测试和离线演练用；同一天重跑结果一致。
type Fake struct{}

func NewFake() *Fake { return &Fake{} }

func (f *Fake) ID() string   { return "fake" }
func (f *Fake) Name() string { return "演示数据" }

func (f *Fake) Funds(_ context.Context) ([]Fund, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	out := make([]Fund, 0, len(fakeFunds()))
	for _, base := range fakeFunds() {
		base.UpdatedAt = now
		out = append(out, base)
	}
	return out, nil
}

func (f *Fake) Daily(_ context.Context, date string, symbols []string) ([]Daily, error) {
	day := date
	if day == "" {
		day = time.Now().Format(time.DateOnly)
	}
	base, err := time.Parse(time.DateOnly, day)
	if err != nil {
		return nil, fmt.Errorf("日期 %q 要写成 YYYY-MM-DD", date)
	}
	seq := float64(base.Unix() / 86400)
	bySymbol := map[string]Fund{}
	for _, fund := range fakeFunds() {
		bySymbol[fund.Symbol] = fund
	}
	out := make([]Daily, 0, len(symbols))
	for _, sym := range symbols {
		if _, ok := bySymbol[sym]; !ok {
			continue
		}
		// 每天在基准上做确定性的小幅变化，重跑同一天结果一致。
		wave := math.Sin(seq/7 + float64(len(sym)))
		price := 4.0 + 0.2*wave
		shares := 2.5e10 * (1 + 0.01*wave)
		iopv := 0.0
		if date == "" {
			// 实时快照只有最近交易日有，演示源照这个口径
			iopv = price * 0.9995
		}
		out = append(out, Daily{
			IOPV:         iopv,
			Date:         day,
			Symbol:       sym,
			Shares:       shares,
			NAV:          price * 0.999,
			Price:        price,
			Open:         price * 0.995,
			High:         price * 1.01,
			Low:          price * 0.99,
			Volume:       1.2e6 * (1 + 0.1*wave),
			Amount:       1.2e6 * price * 100,
			ChangePct:    0.6 * wave,
			ChangeAmount: price * 0.006 * wave,
			Amplitude:    1.2,
			TurnoverRate: 0.8,
			Source:       "fake",
		})
	}
	return out, nil
}

// IndexDaily 给演示源的跟踪指数行情：和 ETF 同一条波形，叠一点偏差，跟踪误差不为 0。
func (f *Fake) IndexDaily(_ context.Context, date string, codes []string) ([]IndexBar, error) {
	day := date
	if day == "" {
		day = time.Now().Format(time.DateOnly)
	}
	base, err := time.Parse(time.DateOnly, day)
	if err != nil {
		return nil, fmt.Errorf("日期 %q 要写成 YYYY-MM-DD", date)
	}
	seq := float64(base.Unix() / 86400)
	out := make([]IndexBar, 0, len(codes))
	for _, code := range codes {
		wave := math.Sin(seq/7 + 6)
		out = append(out, IndexBar{
			Date: day, Code: code, Close: 4000 * (1 + 0.05*wave),
			ChangePct: 0.6*wave + 0.05*math.Sin(seq/3), Amount: 3e11, Source: "fake",
		})
	}
	return out, nil
}

func fakeFunds() []Fund {
	return []Fund{
		{Symbol: "510300", Name: "沪深300ETF", TrackIndex: "沪深300", Category: "宽基", Manager: "华泰柏瑞基金", Market: "SH", Secid: "1.510300", Underlying: "000300"},
		{Symbol: "510500", Name: "中证500ETF", TrackIndex: "中证500", Category: "宽基", Manager: "南方基金", Market: "SH", Secid: "1.510500", Underlying: "000905"},
		{Symbol: "159915", Name: "创业板ETF", TrackIndex: "创业板指", Category: "宽基", Manager: "易方达基金", Market: "SZ", Secid: "0.159915", Underlying: "399006"},
	}
}
