// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package etf

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 异动规则与命中记录（ETF-01b）：一条规则 = 一个指标 + 比较 + 阈值；每次算完指标按启用的规则判定，
// 命中写 etf_anomaly_events（同日同标的同规则一条），新命中汇总成一条通知。

// MetricInfo 是规则能用的指标。
type MetricInfo struct {
	Label string
	Unit  string
	// Shares 为 true 的指标由份额推出来，份额跳变待核时命中也标待核。
	Shares bool
}

// MetricCatalog 是规则能用的指标名到说明；规则的 metric 只能是这些。
var MetricCatalog = map[string]MetricInfo{
	"share_change_pct": {"份额日变动", "%", true},
	"net_inflow":       {"估算净流入", "元", true},
	"inflow_streak":    {"连续净流入天数", "天", true},
	"amount_ratio":     {"量比", "倍", false},
	"premium_discount": {"折溢价", "%", false},
	"aum_change_pct":   {"规模日变动", "%", true},
	"tracking_error":   {"跟踪误差（20 日年化）", "%", false},
	"excess_return":    {"超额收益（20 日）", "%", false},
	"share_pctile":     {"份额历史分位", "", true},
	"aum_pctile":       {"规模历史分位", "", true},
	"premium_pctile":   {"折溢价历史分位", "", false},
}

var (
	ruleOperators  = map[string]string{"gt": ">", "gte": "≥", "lt": "<", "lte": "≤", "abs_gt": "绝对值 >"}
	ruleSeverities = map[string]int{"info": 1, "warn": 2, "critical": 3}
	ruleScopes     = map[string]bool{"all": true, "symbol": true, "index": true}
	eventStatuses  = map[string]bool{"open": true, "acked": true, "ignored": true}
)

// Rule 是一条异动规则，同时是 etf_anomaly_rules 的行和接口里的形状。builtin 是首批内置的 7 条。
type Rule struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Scope      string  `json:"scope"`
	ScopeValue string  `json:"scope_value"`
	Metric     string  `json:"metric"`
	Operator   string  `json:"operator"`
	Threshold  float64 `json:"threshold"`
	WindowDays int     `json:"window_days"`
	Severity   string  `json:"severity"`
	Enabled    bool    `json:"enabled"`
	Builtin    bool    `json:"builtin"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

// Anomaly 是一条命中记录，同时是 etf_anomaly_events 的行和接口里的形状；fund_name 取自 etf_funds。
type Anomaly struct {
	ID        string  `json:"id"`
	Date      string  `json:"date"`
	Symbol    string  `json:"symbol"`
	FundName  string  `json:"fund_name"`
	RuleID    string  `json:"rule_id"`
	RuleName  string  `json:"rule_name"`
	Metric    string  `json:"metric"`
	Value     float64 `json:"value"`
	Threshold float64 `json:"threshold"`
	Operator  string  `json:"operator"`
	Severity  string  `json:"severity"`
	Status    string  `json:"status"`
	Flag      string  `json:"flag"`
	Detail    string  `json:"detail"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
	HandledAt string  `json:"handled_at"`
}

// defaultRules 是首批 7 条（设计第四节），固定 id，补种时已有的不动。
var defaultRules = []Rule{
	{ID: "ear_share_jump", Name: "份额单日骤变", Metric: "share_change_pct", Operator: "abs_gt", Threshold: 2, WindowDays: 1, Severity: "warn"},
	{ID: "ear_inflow_streak", Name: "连续净流入", Metric: "inflow_streak", Operator: "gte", Threshold: 3, WindowDays: 1, Severity: "info"},
	{ID: "ear_outflow_streak", Name: "连续净流出", Metric: "inflow_streak", Operator: "lte", Threshold: -3, WindowDays: 1, Severity: "warn"},
	{ID: "ear_volume_spike", Name: "放量", Metric: "amount_ratio", Operator: "gt", Threshold: 2, WindowDays: amountWindow, Severity: "info"},
	{ID: "ear_premium", Name: "折溢价异常", Metric: "premium_discount", Operator: "abs_gt", Threshold: 0.5, WindowDays: 1, Severity: "warn"},
	{ID: "ear_aum_jump", Name: "规模骤变", Metric: "aum_change_pct", Operator: "abs_gt", Threshold: 3, WindowDays: 1, Severity: "warn"},
	{ID: "ear_tracking_error", Name: "跟踪误差扩大", Metric: "tracking_error", Operator: "gt", Threshold: 1, WindowDays: teWindow, Severity: "critical"},
}

// ensureDefaultRules 补种内置规则：INSERT OR IGNORE，用户改过阈值或停用的不覆盖。
func ensureDefaultRules(ctx context.Context, c plugin.Core) error {
	now := time.Now().UTC().Format(time.RFC3339)
	for _, r := range defaultRules {
		if _, err := c.Store().Exec(ctx, `INSERT OR IGNORE INTO etf_anomaly_rules
			(id, name, scope, scope_value, metric, operator, threshold, window_days, severity, enabled, builtin, created_at, updated_at)
			VALUES (?, ?, 'all', '', ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
			r.ID, r.Name, r.Metric, r.Operator, r.Threshold, r.WindowDays, r.Severity, now, now); err != nil {
			return err
		}
	}
	return nil
}

func ruleHit(op string, v, th float64) bool {
	switch op {
	case "gt":
		return v > th
	case "gte":
		return v >= th
	case "lt":
		return v < th
	case "lte":
		return v <= th
	case "abs_gt":
		return math.Abs(v) > th
	}
	return false
}

// inScope：规则管不管这只。index 范围按跟踪指数代码认（000300），也认跟踪指数名（沪深300）。
func inScope(r Rule, symbol, indexCode, indexName string) bool {
	switch r.Scope {
	case "symbol":
		return r.ScopeValue == symbol
	case "index":
		return r.ScopeValue == indexCode || (indexName != "" && r.ScopeValue == indexName)
	}
	return true
}

func fmtNum(v float64, unit string) string {
	switch unit {
	case "元":
		switch {
		case math.Abs(v) >= 1e8:
			return fmt.Sprintf("%.2f 亿元", v/1e8)
		case math.Abs(v) >= 1e4:
			return fmt.Sprintf("%.2f 万元", v/1e4)
		}
		return fmt.Sprintf("%.0f 元", v)
	case "天":
		return fmt.Sprintf("%.0f 天", v)
	case "倍":
		return fmt.Sprintf("%.2f 倍", v)
	}
	return fmt.Sprintf("%.2f%s", v, unit)
}

func hitDetail(r Rule, v float64, flag string) string {
	info := MetricCatalog[r.Metric]
	head := info.Label + " " + fmtNum(v, info.Unit)
	if r.Metric == "inflow_streak" && v < 0 {
		// 负数是连续净流出，换成人话
		head = fmt.Sprintf("连续净流出 %.0f 天", -v)
	} else if r.Metric == "inflow_streak" {
		head = fmt.Sprintf("连续净流入 %.0f 天", v)
	}
	s := fmt.Sprintf("%s，规则 %s %s", head, ruleOperators[r.Operator], fmtNum(r.Threshold, info.Unit))
	if flag == ReviewPending {
		s += "；份额单日变动超过 10% 且没有放量配合，疑似分红、拆分或份额折算，待核"
	}
	return s
}

type evalTarget struct {
	m         Metrics
	indexCode string
	indexName string
	fundName  string
}

// evaluateDay 按启用的规则判定 date 这天的指标：命中的写记录（重跑覆盖值、不动状态），
// 不再命中且还没处理的记录删掉；回这次新增的命中和总命中数。
func evaluateDay(ctx context.Context, c plugin.Core, date string) (fresh []Anomaly, hits int, err error) {
	if err := ensureDefaultRules(ctx, c); err != nil {
		return nil, 0, err
	}
	rules, err := listRules(ctx, c)
	if err != nil {
		return nil, 0, err
	}
	rows, err := c.Store().Query(ctx, `SELECT `+prefixed("m.", metricsCols)+`, COALESCE(f.underlying, ''), COALESCE(f.track_index, ''), COALESCE(f.name, '')
		FROM etf_metrics_daily m LEFT JOIN etf_funds f ON f.symbol = m.symbol WHERE m.trade_date = ? ORDER BY m.symbol`, date)
	if err != nil {
		return nil, 0, err
	}
	var targets []evalTarget
	for rows.Next() {
		var t evalTarget
		m := &t.m
		if err := rows.Scan(&m.Date, &m.Symbol, &m.ShareChangePct, &m.NetInflow, &m.InflowStreak, &m.AmountRatio, &m.SharePctile,
			&m.AUMPctile, &m.PremiumPctile, &m.TrackingError, &m.ExcessReturn, &m.AUMChangePct, &m.PremiumDiscount,
			&m.PremiumBasis, &m.ReviewFlag, &m.UpdatedAt, &t.indexCode, &t.indexName, &t.fundName); err != nil {
			_ = rows.Close()
			return nil, 0, err
		}
		targets = append(targets, t)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, 0, err
	}

	existing := map[string]string{} // symbol|rule_id -> status
	erows, err := c.Store().Query(ctx, `SELECT symbol, rule_id, status FROM etf_anomaly_events WHERE trade_date = ?`, date)
	if err != nil {
		return nil, 0, err
	}
	for erows.Next() {
		var sym, rid, st string
		if err := erows.Scan(&sym, &rid, &st); err != nil {
			_ = erows.Close()
			return nil, 0, err
		}
		existing[sym+"|"+rid] = st
	}
	err = erows.Err()
	_ = erows.Close()
	if err != nil {
		return nil, 0, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	for _, t := range targets {
		for _, r := range rules {
			if !r.Enabled || !inScope(r, t.m.Symbol, t.indexCode, t.indexName) {
				continue
			}
			key := t.m.Symbol + "|" + r.ID
			v, ok := metricValue(t.m, r.Metric)
			if !ok || !ruleHit(r.Operator, v, r.Threshold) {
				// 样本不足或不再命中：没处理过的旧记录撤掉，确认、忽略过的留着
				if st, had := existing[key]; had && st == "open" {
					if _, err := c.Store().Exec(ctx, `DELETE FROM etf_anomaly_events WHERE trade_date = ? AND symbol = ? AND rule_id = ? AND status = 'open'`,
						date, t.m.Symbol, r.ID); err != nil {
						return nil, 0, err
					}
				}
				continue
			}
			hits++
			flag := ""
			if MetricCatalog[r.Metric].Shares && t.m.ReviewFlag == ReviewPending {
				flag = ReviewPending
			}
			a := Anomaly{
				ID: idgen.Prefixed("eae"), Date: date, Symbol: t.m.Symbol, FundName: t.fundName, RuleID: r.ID, RuleName: r.Name,
				Metric: r.Metric, Value: v, Threshold: r.Threshold, Operator: r.Operator, Severity: r.Severity, Status: "open",
				Flag: flag, Detail: hitDetail(r, v, flag), CreatedAt: now, UpdatedAt: now,
			}
			if _, err := c.Store().Exec(ctx, `INSERT INTO etf_anomaly_events
				(id, trade_date, symbol, rule_id, rule_name, metric, value, threshold, operator, severity, status, flag, detail, created_at, updated_at, handled_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, '')
				ON CONFLICT(trade_date, symbol, rule_id) DO UPDATE SET rule_name = excluded.rule_name, metric = excluded.metric,
				value = excluded.value, threshold = excluded.threshold, operator = excluded.operator, severity = excluded.severity,
				flag = excluded.flag, detail = excluded.detail, updated_at = excluded.updated_at`,
				a.ID, a.Date, a.Symbol, a.RuleID, a.RuleName, a.Metric, a.Value, a.Threshold, a.Operator, a.Severity,
				a.Flag, a.Detail, a.CreatedAt, a.UpdatedAt); err != nil {
				return nil, 0, err
			}
			if _, had := existing[key]; !had {
				fresh = append(fresh, a)
			}
		}
	}
	return fresh, hits, nil
}

func prefixed(p, cols string) string {
	parts := strings.Split(cols, ",")
	for i, s := range parts {
		parts[i] = p + strings.TrimSpace(s)
	}
	return strings.Join(parts, ", ")
}

// notifyAnomalies 把这次新增的命中汇总成一条通知；有 critical 记 error 级别。通知中心没接上不算错。
func notifyAnomalies(ctx context.Context, c plugin.Core, date string, fresh []Anomaly) {
	if len(fresh) == 0 {
		return
	}
	level := plugin.NotifyInfo
	var lines []string
	ids := make([]string, 0, len(fresh))
	review := 0
	for i, a := range fresh {
		ids = append(ids, a.ID)
		if a.Severity == "critical" {
			level = plugin.NotifyError
		}
		if a.Flag == ReviewPending {
			review++
		}
		if i < 5 {
			name := a.FundName
			if name == "" {
				name = a.Symbol
			}
			lines = append(lines, fmt.Sprintf("%s %s · %s：%s", a.Symbol, name, a.RuleName, a.Detail))
		}
	}
	if len(fresh) > 5 {
		lines = append(lines, fmt.Sprintf("另有 %d 条，到宽基监控页查看", len(fresh)-5))
	}
	title := fmt.Sprintf("宽基异动：%s 新增 %d 条", date, len(fresh))
	if review > 0 {
		title += fmt.Sprintf("（%d 条待核）", review)
	}
	err := c.Notify(ctx, plugin.Notification{Kind: "anomaly", Level: level, Title: title, Body: strings.Join(lines, "\n"),
		Data: map[string]any{"date": date, "count": len(fresh), "event_ids": ids}})
	if err != nil && !errors.Is(err, plugin.ErrNoNotifier) {
		c.Log().Warn("etf anomaly notify", "date", date, "err", err)
	}
}

const ruleCols = `id, name, scope, scope_value, metric, operator, threshold, window_days, severity, enabled, builtin, created_at, updated_at`

func scanRule(row plugin.Row) (Rule, error) {
	var r Rule
	var enabled, builtin int
	err := row.Scan(&r.ID, &r.Name, &r.Scope, &r.ScopeValue, &r.Metric, &r.Operator, &r.Threshold, &r.WindowDays, &r.Severity,
		&enabled, &builtin, &r.CreatedAt, &r.UpdatedAt)
	r.Enabled, r.Builtin = enabled == 1, builtin == 1
	return r, err
}

func listRules(ctx context.Context, c plugin.Core) ([]Rule, error) {
	rows, err := c.Store().Query(ctx, `SELECT `+ruleCols+` FROM etf_anomaly_rules ORDER BY builtin DESC, created_at, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Rule{}
	for rows.Next() {
		r, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// validateRule 查规则字段，name 去空白；不合法回 errValidation。
func validateRule(r *Rule) error {
	r.Name = strings.TrimSpace(r.Name)
	r.ScopeValue = strings.TrimSpace(r.ScopeValue)
	switch {
	case r.Name == "":
		return apiErr(errValidation, "name 必填")
	case len([]rune(r.Name)) > 50:
		return apiErr(errValidation, "name 最多 50 字")
	}
	if _, ok := MetricCatalog[r.Metric]; !ok {
		return apiErr(errValidation, "metric 不认识：%s", r.Metric)
	}
	if _, ok := ruleOperators[r.Operator]; !ok {
		return apiErr(errValidation, "operator 只能是 gt、gte、lt、lte、abs_gt")
	}
	if _, ok := ruleSeverities[r.Severity]; !ok {
		return apiErr(errValidation, "severity 只能是 info、warn、critical")
	}
	if !ruleScopes[r.Scope] {
		return apiErr(errValidation, "scope 只能是 all、symbol、index")
	}
	if r.Scope == "all" {
		r.ScopeValue = ""
	} else if r.ScopeValue == "" {
		return apiErr(errValidation, "scope 是 %s 时 scope_value 必填", r.Scope)
	}
	if math.IsNaN(r.Threshold) || math.IsInf(r.Threshold, 0) {
		return apiErr(errValidation, "threshold 要是数字")
	}
	if r.WindowDays < 1 || r.WindowDays > pctileWindow {
		return apiErr(errValidation, "window_days 要在 1 到 %d", pctileWindow)
	}
	return nil
}

const anomalyCols = `e.id, e.trade_date, e.symbol, COALESCE(f.name, ''), e.rule_id, e.rule_name, e.metric, e.value, e.threshold,
	e.operator, e.severity, e.status, e.flag, e.detail, e.created_at, e.updated_at, e.handled_at`

func scanAnomaly(row plugin.Row) (Anomaly, error) {
	var a Anomaly
	err := row.Scan(&a.ID, &a.Date, &a.Symbol, &a.FundName, &a.RuleID, &a.RuleName, &a.Metric, &a.Value, &a.Threshold,
		&a.Operator, &a.Severity, &a.Status, &a.Flag, &a.Detail, &a.CreatedAt, &a.UpdatedAt, &a.HandledAt)
	return a, err
}

func getAnomaly(ctx context.Context, c plugin.Core, id string) (Anomaly, error) {
	return scanAnomaly(c.Store().QueryRow(ctx, `SELECT `+anomalyCols+` FROM etf_anomaly_events e
		LEFT JOIN etf_funds f ON f.symbol = e.symbol WHERE e.id = ?`, id))
}
