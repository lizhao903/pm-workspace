// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package etf

import (
	"context"
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 派生指标（ETF-01b）：每日采集后按 etf_daily 和 etf_index_daily 的窗口算一遍，落 etf_metrics_daily。
// 口径见 docs/etf-anomaly-design.md 第七节；样本不够的指标为 nil（接口回 null），规则判定时跳过。

const (
	amountWindow   = 20  // 量比：之前 20 个交易日的均额，不含当日
	pctileMin      = 60  // 历史分位至少要 60 个交易日
	pctileWindow   = 250 // 历史分位最多看近 250 个交易日
	teWindow       = 20  // 跟踪误差、超额收益：近 20 个交易日
	reviewJumpPct  = 10  // 份额单日变动超过 10%……
	reviewMaxRatio = 2.0 // ……且量比不到 2（没有行情配合），记待核
	tradingDays    = 252 // 年化用的交易日数

	// ReviewPending 是待核标记：疑似分红、拆分、份额折算这类非交易性的份额跳变。
	ReviewPending = "pending_review"
)

// Metrics 是一只 ETF 一天的派生指标，同时是 etf_metrics_daily 的行和接口里的形状。
type Metrics struct {
	Date            string   `json:"date"`
	Symbol          string   `json:"symbol"`
	ShareChangePct  *float64 `json:"share_change_pct"`
	NetInflow       *float64 `json:"net_inflow"`
	InflowStreak    int      `json:"inflow_streak"`
	AmountRatio     *float64 `json:"amount_ratio"`
	SharePctile     *float64 `json:"share_pctile"`
	AUMPctile       *float64 `json:"aum_pctile"`
	PremiumPctile   *float64 `json:"premium_pctile"`
	TrackingError   *float64 `json:"tracking_error"`
	ExcessReturn    *float64 `json:"excess_return"`
	AUMChangePct    *float64 `json:"aum_change_pct"`
	PremiumDiscount *float64 `json:"premium_discount"`
	PremiumBasis    string   `json:"premium_basis"`
	ReviewFlag      string   `json:"review_flag"`
	UpdatedAt       string   `json:"updated_at"`
}

// dayPoint 是算指标用到的一天的量。
type dayPoint struct {
	date      string
	shares    float64
	nav       float64
	iopv      float64
	price     float64
	amount    float64
	aum       float64
	premium   float64
	basis     string
	changePct float64
}

func ptr(v float64) *float64 { return &v }

// unitValue 是算净流入时一份值多少钱：净值优先，没有用 IOPV，再没有用收盘价。
func (p dayPoint) unitValue() float64 {
	switch {
	case p.nav > 0:
		return p.nav
	case p.iopv > 0:
		return p.iopv
	default:
		return p.price
	}
}

func premiumUsable(basis string) bool { return basis == "iopv" || basis == "nav" }

// computeMetrics 算序列最后一天的指标。series 按日期正序，最后一条是要算的那天；
// indexChg 是跟踪指数按日期的涨跌幅（%），没有指数数据传 nil。
func computeMetrics(series []dayPoint, indexChg map[string]float64) Metrics {
	n := len(series) - 1
	if n < 0 {
		return Metrics{}
	}
	cur := series[n]
	m := Metrics{Date: cur.date, PremiumBasis: cur.basis}
	if m.PremiumBasis == "" {
		m.PremiumBasis = "none"
	}

	if n >= 1 {
		prev := series[n-1]
		if prev.shares > 0 && cur.shares > 0 {
			diff := cur.shares - prev.shares
			m.ShareChangePct = ptr(diff / prev.shares * 100)
			m.NetInflow = ptr(diff * cur.unitValue())
		}
		if prev.aum > 0 && cur.aum > 0 {
			m.AUMChangePct = ptr((cur.aum - prev.aum) / prev.aum * 100)
		}
	}
	m.InflowStreak = inflowStreak(series)
	m.AmountRatio = amountRatio(series)

	if premiumUsable(cur.basis) {
		m.PremiumDiscount = ptr(cur.premium)
	}
	m.SharePctile = pctileOf(series, func(p dayPoint) (float64, bool) { return p.shares, p.shares > 0 })
	m.AUMPctile = pctileOf(series, func(p dayPoint) (float64, bool) { return p.aum, p.aum > 0 })
	if m.PremiumDiscount != nil {
		m.PremiumPctile = pctileOf(series, func(p dayPoint) (float64, bool) { return p.premium, premiumUsable(p.basis) })
	}
	m.TrackingError, m.ExcessReturn = trackingError(series, indexChg)

	if m.ShareChangePct != nil && math.Abs(*m.ShareChangePct) > reviewJumpPct &&
		(m.AmountRatio == nil || *m.AmountRatio < reviewMaxRatio) {
		m.ReviewFlag = ReviewPending
	}
	return m
}

// inflowStreak：最后一天起往前数份额变动同号的天数，流入为正、流出为负；份额不变或缺数据为 0。
func inflowStreak(series []dayPoint) int {
	sign, count := 0, 0
	for i := len(series) - 1; i >= 1; i-- {
		a, b := series[i-1].shares, series[i].shares
		if a <= 0 || b <= 0 {
			break
		}
		s := 0
		switch {
		case b > a:
			s = 1
		case b < a:
			s = -1
		}
		if s == 0 {
			break
		}
		if sign == 0 {
			sign = s
		}
		if s != sign {
			break
		}
		count++
	}
	return sign * count
}

// amountRatio：当日成交额 / 之前 amountWindow 个交易日的均额（去掉当日，避免自己和自己比）。
func amountRatio(series []dayPoint) *float64 {
	n := len(series) - 1
	if n < amountWindow || series[n].amount <= 0 {
		return nil
	}
	sum := 0.0
	for _, p := range series[n-amountWindow : n] {
		if p.amount <= 0 {
			return nil
		}
		sum += p.amount
	}
	return ptr(series[n].amount / (sum / amountWindow))
}

// pctileOf：最后一天的值在近 pctileWindow 个有效样本里的分位（≤ 它的占比，0-100）；样本不足 pctileMin 为 nil。
func pctileOf(series []dayPoint, get func(dayPoint) (float64, bool)) *float64 {
	cur, ok := get(series[len(series)-1])
	if !ok {
		return nil
	}
	vals := make([]float64, 0, pctileWindow)
	for i := len(series) - 1; i >= 0 && len(vals) < pctileWindow; i-- {
		if v, ok := get(series[i]); ok {
			vals = append(vals, v)
		}
	}
	if len(vals) < pctileMin {
		return nil
	}
	le := 0
	for _, v := range vals {
		if v <= cur {
			le++
		}
	}
	return ptr(float64(le) / float64(len(vals)) * 100)
}

// trackingError：近 teWindow 个交易日（ETF 日收益 - 指数日收益）的样本标准差年化（%），
// 和同期累计超额收益（%）。这些天里有一天缺指数数据就不算。
func trackingError(series []dayPoint, indexChg map[string]float64) (te, excess *float64) {
	if len(series) < teWindow || indexChg == nil {
		return nil, nil
	}
	diffs := make([]float64, 0, teWindow)
	etfCum, idxCum := 1.0, 1.0
	for _, p := range series[len(series)-teWindow:] {
		ic, ok := indexChg[p.date]
		if !ok {
			return nil, nil
		}
		diffs = append(diffs, p.changePct-ic)
		etfCum *= 1 + p.changePct/100
		idxCum *= 1 + ic/100
	}
	mean := 0.0
	for _, d := range diffs {
		mean += d
	}
	mean /= float64(len(diffs))
	ss := 0.0
	for _, d := range diffs {
		ss += (d - mean) * (d - mean)
	}
	sd := math.Sqrt(ss / float64(len(diffs)-1))
	return ptr(sd * math.Sqrt(tradingDays)), ptr((etfCum - idxCum) * 100)
}

// --- 读写 ---

// loadSeries 取一只 ETF 截止到 date 的近 pctileWindow 天，按日期正序。
func loadSeries(ctx context.Context, c plugin.Core, symbol, date string) ([]dayPoint, error) {
	rows, err := c.Store().Query(ctx, `SELECT trade_date, shares, nav, iopv, price, amount, aum, premium_discount, premium_basis, change_pct
		FROM etf_daily WHERE symbol = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT ?`, symbol, date, pctileWindow)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []dayPoint
	for rows.Next() {
		var p dayPoint
		if err := rows.Scan(&p.date, &p.shares, &p.nav, &p.iopv, &p.price, &p.amount, &p.aum, &p.premium, &p.basis, &p.changePct); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	slices.Reverse(out)
	return out, nil
}

// loadIndexChg 取一个指数在 [from, to] 的涨跌幅；没有任何数据回 nil。
func loadIndexChg(ctx context.Context, c plugin.Core, code, from, to string) (map[string]float64, error) {
	if code == "" {
		return nil, nil
	}
	rows, err := c.Store().Query(ctx, `SELECT trade_date, change_pct FROM etf_index_daily
		WHERE index_code = ? AND trade_date >= ? AND trade_date <= ?`, code, from, to)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out map[string]float64
	for rows.Next() {
		var d string
		var v float64
		if err := rows.Scan(&d, &v); err != nil {
			return nil, err
		}
		if out == nil {
			out = map[string]float64{}
		}
		out[d] = v
	}
	return out, rows.Err()
}

// computeDay 算 date 这天所有有快照的 ETF 的指标并落库，回算了几只。
func computeDay(ctx context.Context, c plugin.Core, date string) (int, error) {
	rows, err := c.Store().Query(ctx, `SELECT d.symbol, COALESCE(f.underlying, '') FROM etf_daily d
		LEFT JOIN etf_funds f ON f.symbol = d.symbol WHERE d.trade_date = ? ORDER BY d.symbol`, date)
	if err != nil {
		return 0, err
	}
	type target struct{ symbol, index string }
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.symbol, &t.index); err != nil {
			_ = rows.Close()
			return 0, err
		}
		targets = append(targets, t)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for _, t := range targets {
		series, err := loadSeries(ctx, c, t.symbol, date)
		if err != nil {
			return 0, err
		}
		if len(series) == 0 {
			continue
		}
		idx, err := loadIndexChg(ctx, c, t.index, series[0].date, date)
		if err != nil {
			return 0, err
		}
		m := computeMetrics(series, idx)
		m.Symbol, m.UpdatedAt = t.symbol, now
		if err := upsertMetrics(ctx, c, m); err != nil {
			return 0, fmt.Errorf("写 %s 的指标: %w", t.symbol, err)
		}
	}
	return len(targets), nil
}

const metricsCols = `trade_date, symbol, share_change_pct, net_inflow, inflow_streak, amount_ratio, share_pctile, aum_pctile,
	premium_pctile, tracking_error, excess_return, aum_change_pct, premium_discount, premium_basis, review_flag, updated_at`

func upsertMetrics(ctx context.Context, c plugin.Core, m Metrics) error {
	_, err := c.Store().Exec(ctx, `INSERT INTO etf_metrics_daily (`+metricsCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(trade_date, symbol) DO UPDATE SET share_change_pct = excluded.share_change_pct,
		net_inflow = excluded.net_inflow, inflow_streak = excluded.inflow_streak, amount_ratio = excluded.amount_ratio,
		share_pctile = excluded.share_pctile, aum_pctile = excluded.aum_pctile, premium_pctile = excluded.premium_pctile,
		tracking_error = excluded.tracking_error, excess_return = excluded.excess_return,
		aum_change_pct = excluded.aum_change_pct, premium_discount = excluded.premium_discount,
		premium_basis = excluded.premium_basis, review_flag = excluded.review_flag, updated_at = excluded.updated_at`,
		m.Date, m.Symbol, m.ShareChangePct, m.NetInflow, m.InflowStreak, m.AmountRatio, m.SharePctile, m.AUMPctile,
		m.PremiumPctile, m.TrackingError, m.ExcessReturn, m.AUMChangePct, m.PremiumDiscount, m.PremiumBasis, m.ReviewFlag, m.UpdatedAt)
	return err
}

func scanMetrics(row plugin.Row) (Metrics, error) {
	var m Metrics
	err := row.Scan(&m.Date, &m.Symbol, &m.ShareChangePct, &m.NetInflow, &m.InflowStreak, &m.AmountRatio, &m.SharePctile,
		&m.AUMPctile, &m.PremiumPctile, &m.TrackingError, &m.ExcessReturn, &m.AUMChangePct, &m.PremiumDiscount,
		&m.PremiumBasis, &m.ReviewFlag, &m.UpdatedAt)
	return m, err
}

// metricValue 按规则里的指标名取值；样本不足的回 false。
func metricValue(m Metrics, metric string) (float64, bool) {
	var p *float64
	switch metric {
	case "share_change_pct":
		p = m.ShareChangePct
	case "net_inflow":
		p = m.NetInflow
	case "inflow_streak":
		return float64(m.InflowStreak), true
	case "amount_ratio":
		p = m.AmountRatio
	case "share_pctile":
		p = m.SharePctile
	case "aum_pctile":
		p = m.AUMPctile
	case "premium_pctile":
		p = m.PremiumPctile
	case "tracking_error":
		p = m.TrackingError
	case "excess_return":
		p = m.ExcessReturn
	case "aum_change_pct":
		p = m.AUMChangePct
	case "premium_discount":
		p = m.PremiumDiscount
	}
	if p == nil {
		return 0, false
	}
	return *p, true
}
