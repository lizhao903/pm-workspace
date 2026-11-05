package trade

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 盯盘提醒的接口（TRD-03a），契约见 docs/api-contract.md「交易套件插件 trade / 盯盘提醒」。

func registerAlertRoutes(m plugin.RouteRegistrar, h *handlers) {
	m.HandleFunc("GET /api/trade/alerts", h.listAlerts)
	m.HandleFunc("POST /api/trade/alerts", h.addAlert)
	m.HandleFunc("GET /api/trade/alerts/values", h.alertValues)
	m.HandleFunc("GET /api/trade/alerts/preview", h.previewAlert)
	m.HandleFunc("GET /api/trade/alerts/{id}", h.getAlert)
	m.HandleFunc("PATCH /api/trade/alerts/{id}", h.patchAlert)
	m.HandleFunc("DELETE /api/trade/alerts/{id}", h.removeAlert)
	m.HandleFunc("POST /api/trade/alerts/{id}/rearm", h.rearmAlert)
	m.HandleFunc("GET /api/trade/alert-events", h.listAlertEvents)
	m.HandleFunc("POST /api/trade/alert-events/read", h.readAlertEvents)
}

func (h *handlers) loadAlert(ctx context.Context, id string) (Alert, error) {
	a, err := scanAlert(h.c.Store().QueryRow(ctx, `SELECT `+alertCols+` FROM trade_alerts WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return a, apiErr(errNotFound, "提醒 %s 不存在", id)
	}
	return a, err
}

func (h *handlers) listAlerts(w http.ResponseWriter, r *http.Request) {
	out, err := loadAlerts(r.Context(), h.c, false)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handlers) getAlert(w http.ResponseWriter, r *http.Request) {
	a, err := h.loadAlert(r.Context(), r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": a})
}

func (h *handlers) addAlert(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	for _, k := range []string{"symbol", "cond", "value"} {
		if _, ok := raw[k]; !ok {
			h.fail(w, r, apiErr(errValidation, "缺少 %s", k))
			return
		}
	}
	a := Alert{CooldownMin: 30, Notify: []string{"app"}, Enabled: true}
	if err := h.applyAlert(ctx, &a, raw); err != nil {
		h.fail(w, r, err)
		return
	}
	a.ID = idgen.Prefixed("al")
	now := time.Now().UTC().Format(time.RFC3339)
	notify, _ := json.Marshal(a.Notify)
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO trade_alerts (`+alertCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
		a.ID, a.Symbol, a.Cond, a.Value, b2i(a.Repeat), a.CooldownMin, string(notify), a.IMConnector, b2i(a.Enabled), a.Note, now, now); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.loadAlert(ctx, a.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

// patchAlert 只改出现的字段；单次提醒改了标的、条件或阈值时清掉 last_fired_at（重新上膛），同原型抽屉的保存。
func (h *handlers) patchAlert(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	old, err := h.loadAlert(ctx, id)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	a := old
	a.Notify = slices.Clone(old.Notify)
	if err := h.applyAlert(ctx, &a, raw); err != nil {
		h.fail(w, r, err)
		return
	}
	if !a.Repeat && (a.Symbol != old.Symbol || a.Cond != old.Cond || a.Value != old.Value) {
		a.LastFiredAt = ""
	}
	now := time.Now().UTC().Format(time.RFC3339)
	notify, _ := json.Marshal(a.Notify)
	if _, err := h.c.Store().Exec(ctx, `UPDATE trade_alerts SET symbol = ?, cond = ?, value = ?, repeat = ?, cooldown_min = ?, notify = ?,
		im_connector = ?, enabled = ?, note = ?, last_fired_at = ?, updated_at = ? WHERE id = ?`,
		a.Symbol, a.Cond, a.Value, b2i(a.Repeat), a.CooldownMin, string(notify), a.IMConnector, b2i(a.Enabled), a.Note, a.LastFiredAt, now, id); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.loadAlert(ctx, id)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// removeAlert 删规则，触发记录保留。
func (h *handlers) removeAlert(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.loadAlert(ctx, id); err != nil {
		h.fail(w, r, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM trade_alerts WHERE id = ?`, id); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// rearmAlert 清掉 last_fired_at，重新开始检查（规则表的「重新上膛」）。
func (h *handlers) rearmAlert(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.loadAlert(ctx, id); err != nil {
		h.fail(w, r, err)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `UPDATE trade_alerts SET last_fired_at = '', updated_at = ? WHERE id = ?`, now, id); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.loadAlert(ctx, id)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// applyAlert 认 symbol、cond、value、repeat、cooldown_min、notify、im_connector、enabled、note；
// id、时间、last_fired_at 忽略（重新上膛走 /rearm），别的字段 400。改完整体校验一遍。
func (h *handlers) applyAlert(ctx context.Context, a *Alert, raw map[string]json.RawMessage) error {
	for k, v := range raw {
		var err error
		switch k {
		case "symbol":
			err = json.Unmarshal(v, &a.Symbol)
			a.Symbol = strings.TrimSpace(a.Symbol)
		case "cond":
			err = json.Unmarshal(v, &a.Cond)
		case "value":
			err = json.Unmarshal(v, &a.Value)
		case "repeat":
			err = json.Unmarshal(v, &a.Repeat)
		case "cooldown_min":
			err = json.Unmarshal(v, &a.CooldownMin)
		case "notify":
			var ns []string
			if err = json.Unmarshal(v, &ns); err == nil {
				a.Notify = ns
			}
		case "im_connector":
			var s *string
			if err = json.Unmarshal(v, &s); err == nil {
				a.IMConnector = ""
				if s != nil {
					a.IMConnector = strings.TrimSpace(*s)
				}
			}
		case "enabled":
			err = json.Unmarshal(v, &a.Enabled)
		case "note":
			err = json.Unmarshal(v, &a.Note)
			a.Note = strings.TrimSpace(a.Note)
		case "id", "created_at", "updated_at", "last_fired_at":
			continue
		default:
			return apiErr(errValidation, "不认识的字段 %s", k)
		}
		if err != nil {
			return apiErr(errValidation, "%s 的类型不对", k)
		}
	}
	return h.checkAlert(ctx, a)
}

func (h *handlers) checkAlert(ctx context.Context, a *Alert) error {
	if !ValidSymbol(a.Symbol) {
		return apiErr(errValidation, "标的 %q 格式不对，要写成 交易场所:代码，如 BINANCE:BTCUSDT", a.Symbol)
	}
	if _, ok := alertCondInfo[a.Cond]; !ok {
		return apiErr(errValidation, "条件 %q 不认识，要是 %s 之一", a.Cond, strings.Join(AlertConds, "、"))
	}
	if math.IsNaN(a.Value) || math.IsInf(a.Value, 0) {
		return apiErr(errValidation, "阈值要是数字")
	}
	inst := loadAlertInsts(ctx, h.c, []string{a.Symbol})[a.Symbol]
	if !alertCondFits(a.Cond, inst) {
		return apiErr(errValidation, "条件「%s」不适用于 %s：%s", alertCondInfo[a.Cond].label, a.Symbol, unsupportedReason(a.Cond))
	}
	if a.CooldownMin < 0 || a.CooldownMin > maxAlertCool {
		return apiErr(errValidation, "冷却要在 0 到 %d 分钟", maxAlertCool)
	}
	var ns []string
	for _, n := range a.Notify {
		if !slices.Contains(AlertNotifies, n) {
			return apiErr(errValidation, "通知方式 %q 不认识，要是 app、im、sound", n)
		}
		if !slices.Contains(ns, n) {
			ns = append(ns, n)
		}
	}
	if len(ns) == 0 {
		return apiErr(errValidation, "至少选一种通知方式")
	}
	a.Notify = ns
	if !slices.Contains(ns, "im") {
		a.IMConnector = ""
	} else {
		if a.IMConnector == "" {
			return apiErr(errValidation, "推 IM 要选一个 IM 连接器（im_connector）")
		}
		if _, err := h.c.Connectors().Get(ctx, a.IMConnector); errors.Is(err, plugin.ErrNoRows) {
			return apiErr(errValidation, "IM 连接器 %s 不存在", a.IMConnector)
		}
	}
	if len([]rune(a.Note)) > maxAlertNote {
		return apiErr(errValidation, "备注最多 %d 字", maxAlertNote)
	}
	return nil
}

// alertValues：每条启用的提醒上一轮算出的当前值，顺序同 /alerts。
func (h *handlers) alertValues(w http.ResponseWriter, r *http.Request) {
	alerts, err := loadAlerts(r.Context(), h.c, true)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := make([]AlertValue, 0, len(alerts))
	for _, a := range alerts {
		out = append(out, h.p.alerts.value(a))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// previewAlert：抽屉里还没保存的标的和条件，现算当前值；查过的标的之后 30 秒内最新价按每秒刷新（同 /quotes）。
func (h *handlers) previewAlert(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	sym, cond := q.Get("symbol"), q.Get("cond")
	if !ValidSymbol(sym) {
		h.fail(w, r, apiErr(errValidation, "symbol 要写成 交易场所:代码，如 BINANCE:BTCUSDT"))
		return
	}
	if _, ok := alertCondInfo[cond]; !ok {
		h.fail(w, r, apiErr(errValidation, "cond 不认识，要是 %s 之一", strings.Join(AlertConds, "、")))
		return
	}
	m := h.p.mkt
	m.mu.Lock()
	m.polled[sym] = m.now()
	m.mu.Unlock()
	inst := loadAlertInsts(ctx, h.c, []string{sym})[sym]
	in, status, msg := h.p.alerts.inputFor(ctx, cond, sym, inst, true)
	writeJSON(w, http.StatusOK, map[string]any{"data": valueOf("", cond, sym, in, status, msg, m.now())})
}

// listAlertEvents：触发记录，新的在前；unread=1 只要未读。meta 带 total（筛选后）和 unread（全部未读数）。
func (h *handlers) listAlertEvents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	limit, offset := 50, 0
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 500 {
			h.fail(w, r, apiErr(errValidation, "limit 要在 1 到 500"))
			return
		}
		limit = n
	}
	if v := q.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			h.fail(w, r, apiErr(errValidation, "offset 不能是负数"))
			return
		}
		offset = n
	}
	where := ""
	switch q.Get("unread") {
	case "", "0", "false":
	case "1", "true":
		where = ` WHERE read = 0`
	default:
		h.fail(w, r, apiErr(errValidation, "unread 要是 1 或 0"))
		return
	}
	var total, unread int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_alert_events`+where).Scan(&total); err != nil {
		h.fail(w, r, err)
		return
	}
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_alert_events WHERE read = 0`).Scan(&unread); err != nil {
		h.fail(w, r, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT `+alertEventCols+` FROM trade_alert_events`+where+` ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []AlertEvent{}
	for rows.Next() {
		e, err := scanAlertEvent(rows)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total, "unread": unread, "limit": limit, "offset": offset}})
}

// readAlertEvents：{ids?} 标为已读，不传 ids 是全部已读；回 {updated}。不认识的 id 跳过。
func (h *handlers) readAlertEvents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var ids []string
	for k, v := range raw {
		if k != "ids" {
			h.fail(w, r, apiErr(errValidation, "不认识的字段 %s", k))
			return
		}
		if err := json.Unmarshal(v, &ids); err != nil {
			h.fail(w, r, apiErr(errValidation, "ids 要是字符串数组"))
			return
		}
		if ids == nil {
			ids = []string{}
		}
	}
	if len(ids) > 500 {
		h.fail(w, r, apiErr(errValidation, "一次最多 500 条"))
		return
	}
	var n int64
	if _, ok := raw["ids"]; !ok {
		res, err := h.c.Store().Exec(ctx, `UPDATE trade_alert_events SET read = 1 WHERE read = 0`)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		n, _ = res.RowsAffected()
	} else if len(ids) > 0 {
		args := make([]any, len(ids))
		for i, id := range ids {
			args[i] = id
		}
		res, err := h.c.Store().Exec(ctx, `UPDATE trade_alert_events SET read = 1 WHERE read = 0 AND id IN (?`+strings.Repeat(", ?", len(ids)-1)+`)`, args...)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		n, _ = res.RowsAffected()
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]int64{"updated": n}})
}
