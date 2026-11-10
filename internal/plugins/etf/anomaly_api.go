// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package etf

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 派生指标、命中记录、规则的接口（ETF-01b），契约见 docs/api-contract.md「宽基监控插件 etf」。

// readJSON 读一个 JSON 对象请求体；空 body 当 {}。
func readJSON(r *http.Request, v any) error {
	if r.Body == nil {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<10))
	if err != nil {
		return apiErr(errValidation, "读请求体失败：%v", err)
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		return nil
	}
	if body[0] != '{' {
		return apiErr(errValidation, "请求体必须是 JSON 对象")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return apiErr(errValidation, "请求体不对：%v", err)
	}
	return nil
}

// parseLimit 读 limit，默认 def，范围 1 到 max。
func parseLimit(qs string, def, max int) (int, error) {
	if qs == "" {
		return def, nil
	}
	n, err := strconv.Atoi(qs)
	if err != nil || n < 1 || n > max {
		return 0, apiErr(errValidation, "limit 要在 1 到 %d", max)
	}
	return n, nil
}

// dateFilters 把 date / from / to 拼进 where。
func dateFilters(col string, q map[string]string, where []string, args []any) ([]string, []any, error) {
	for _, k := range []string{"date", "from", "to"} {
		v := strings.TrimSpace(q[k])
		if v == "" {
			continue
		}
		if !validDate(v) {
			return nil, nil, apiErr(errValidation, "%s 要写成 YYYY-MM-DD", k)
		}
		op := map[string]string{"date": " = ?", "from": " >= ?", "to": " <= ?"}[k]
		where, args = append(where, col+op), append(args, v)
	}
	return where, args, nil
}

func queryMap(r *http.Request, keys ...string) map[string]string {
	out := map[string]string{}
	qs := r.URL.Query()
	for _, k := range keys {
		out[k] = qs.Get(k)
	}
	return out
}

func (h *handlers) listMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := queryMap(r, "symbol", "date", "from", "to")
	where, args := []string{"1 = 1"}, []any{}
	if v := strings.TrimSpace(q["symbol"]); v != "" {
		where, args = append(where, "symbol = ?"), append(args, v)
	}
	where, args, err := dateFilters("trade_date", q, where, args)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	limit, err := parseLimit(r.URL.Query().Get("limit"), 500, 5000)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	// 截断时留最近的，再按日期正序给（画趋势用）
	rows, err := h.c.Store().Query(ctx, `SELECT `+metricsCols+` FROM (SELECT * FROM etf_metrics_daily WHERE `+strings.Join(where, " AND ")+
		` ORDER BY trade_date DESC, symbol LIMIT ?) ORDER BY trade_date, symbol`, append(args, limit)...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Metrics{}
	for rows.Next() {
		m, err := scanMetrics(rows)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out), "limit": limit}})
}

func (h *handlers) listAnomalies(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := queryMap(r, "symbol", "severity", "status", "date", "from", "to")
	where, args := []string{"1 = 1"}, []any{}
	if v := strings.TrimSpace(q["symbol"]); v != "" {
		where, args = append(where, "e.symbol = ?"), append(args, v)
	}
	if v := strings.TrimSpace(q["severity"]); v != "" {
		if _, ok := ruleSeverities[v]; !ok {
			h.fail(w, r, apiErr(errValidation, "severity 只能是 info、warn、critical"))
			return
		}
		where, args = append(where, "e.severity = ?"), append(args, v)
	}
	if v := strings.TrimSpace(q["status"]); v != "" {
		if !eventStatuses[v] {
			h.fail(w, r, apiErr(errValidation, "status 只能是 open、acked、ignored"))
			return
		}
		where, args = append(where, "e.status = ?"), append(args, v)
	}
	where, args, err := dateFilters("e.trade_date", q, where, args)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	limit, err := parseLimit(r.URL.Query().Get("limit"), 200, 2000)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT `+anomalyCols+` FROM etf_anomaly_events e LEFT JOIN etf_funds f ON f.symbol = e.symbol
		WHERE `+strings.Join(where, " AND ")+` ORDER BY e.trade_date DESC,
		CASE e.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, e.symbol, e.rule_id LIMIT ?`, append(args, limit)...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Anomaly{}
	for rows.Next() {
		a, err := scanAnomaly(rows)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out), "limit": limit}})
}

// ackAnomaly 确认或忽略一条命中；status 传 open 是撤回成未处理。不传 body 当确认。
func (h *handlers) ackAnomaly(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	var in struct {
		Status string `json:"status"`
	}
	if err := readJSON(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	if in.Status == "" {
		in.Status = "acked"
	}
	if !eventStatuses[in.Status] {
		h.fail(w, r, apiErr(errValidation, "status 只能是 acked、ignored、open"))
		return
	}
	handled := ""
	if in.Status != "open" {
		handled = time.Now().UTC().Format(time.RFC3339)
	}
	res, err := h.c.Store().Exec(ctx, `UPDATE etf_anomaly_events SET status = ?, handled_at = ? WHERE id = ?`, in.Status, handled, id)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		h.fail(w, r, apiErr(errNotFound, "命中记录 %s 不存在", id))
		return
	}
	a, err := getAnomaly(ctx, h.c, id)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": a})
}

func (h *handlers) listRules(w http.ResponseWriter, r *http.Request) {
	if err := ensureDefaultRules(r.Context(), h.c); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := listRules(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

type ruleInput struct {
	Name       *string  `json:"name"`
	Scope      *string  `json:"scope"`
	ScopeValue *string  `json:"scope_value"`
	Metric     *string  `json:"metric"`
	Operator   *string  `json:"operator"`
	Threshold  *float64 `json:"threshold"`
	WindowDays *int     `json:"window_days"`
	Severity   *string  `json:"severity"`
	Enabled    *bool    `json:"enabled"`
}

func (in ruleInput) apply(r *Rule) {
	set := func(dst *string, src *string) {
		if src != nil {
			*dst = *src
		}
	}
	set(&r.Name, in.Name)
	set(&r.Scope, in.Scope)
	set(&r.ScopeValue, in.ScopeValue)
	set(&r.Metric, in.Metric)
	set(&r.Operator, in.Operator)
	set(&r.Severity, in.Severity)
	if in.Threshold != nil {
		r.Threshold = *in.Threshold
	}
	if in.WindowDays != nil {
		r.WindowDays = *in.WindowDays
	}
	if in.Enabled != nil {
		r.Enabled = *in.Enabled
	}
}

func (h *handlers) createRule(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in ruleInput
	if err := readJSON(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	if in.Metric == nil || in.Operator == nil || in.Threshold == nil {
		h.fail(w, r, apiErr(errValidation, "metric、operator、threshold 必填"))
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	rule := Rule{ID: idgen.Prefixed("ear"), Scope: "all", WindowDays: 1, Severity: "warn", Enabled: true, CreatedAt: now, UpdatedAt: now}
	in.apply(&rule)
	if err := validateRule(&rule); err != nil {
		h.fail(w, r, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO etf_anomaly_rules (`+ruleCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		rule.ID, rule.Name, rule.Scope, rule.ScopeValue, rule.Metric, rule.Operator, rule.Threshold, rule.WindowDays,
		rule.Severity, boolInt(rule.Enabled), rule.CreatedAt, rule.UpdatedAt); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": rule})
}

func (h *handlers) patchRule(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	var in ruleInput
	if err := readJSON(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	if err := ensureDefaultRules(ctx, h.c); err != nil {
		h.fail(w, r, err)
		return
	}
	rule, err := scanRule(h.c.Store().QueryRow(ctx, `SELECT `+ruleCols+` FROM etf_anomaly_rules WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		h.fail(w, r, apiErr(errNotFound, "规则 %s 不存在", id))
		return
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	in.apply(&rule)
	if err := validateRule(&rule); err != nil {
		h.fail(w, r, err)
		return
	}
	rule.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `UPDATE etf_anomaly_rules SET name = ?, scope = ?, scope_value = ?, metric = ?, operator = ?,
		threshold = ?, window_days = ?, severity = ?, enabled = ?, updated_at = ? WHERE id = ?`,
		rule.Name, rule.Scope, rule.ScopeValue, rule.Metric, rule.Operator, rule.Threshold, rule.WindowDays, rule.Severity,
		boolInt(rule.Enabled), rule.UpdatedAt, rule.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rule})
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
