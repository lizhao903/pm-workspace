package trade

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 交易审计（TRD-08a）：每条交易动作写内核审计（Core.Audit()，正本），同时在 trade_audit（迁移 0009）记一份，
// 给 GET /api/trade/audit 按账户、部署、委托、时间筛。审计口径：
//   - 委托：下单 place、被拒 reject、风控拦截 risk_block、改价 modify、撤单 cancel、成交 fill（target_type trade_order）；
//   - 部署：deploy、pause、resume、stop（trade_run）；
//   - 风控：改规则 update、一键全停 kill、自动熔断 halt、熔断触发 breaker、解除 release（trade_risk）；
//   - 账户：create、update、delete、connect、disconnect、baseline、sync_failed、sync_recovered、key_rejected（trade_account）；
//   - 对账：recon_diff、recon_resolve、recon_auto_resolved（trade_recon_item）。
// 来源 origin：部署的动作是部署 id，接口来的（含手动单的撮合成交）是 manual，风控自动动作 risk，同步 live，对账 recon。
// detail 和内核审计同一份，不含凭证（凭证只在连接器回调里出现，从不进 detail）。

// audit 记一条交易审计：内核审计一条，trade_audit 一条。
func (pp *paper) audit(ctx context.Context, action, targetType, targetID, summary string, detail map[string]any, m plugin.WriteMeta) {
	if detail == nil {
		detail = map[string]any{}
	}
	accountID, _ := detail["account_id"].(string)
	runID, _ := detail["run_id"].(string)
	orderID := ""
	switch targetType {
	case "trade_order":
		orderID = targetID
		if accountID == "" || runID == "" {
			var a, rn string
			if pp.c.Store().QueryRow(ctx, `SELECT account_id, run_id FROM trade_orders WHERE id = ?`, targetID).Scan(&a, &rn) == nil {
				accountID = orDefault(accountID, a)
				runID = orDefault(runID, rn)
			}
		}
	case "trade_run":
		runID = targetID
		if accountID == "" {
			_ = pp.c.Store().QueryRow(ctx, `SELECT account_id FROM trade_runs WHERE id = ?`, targetID).Scan(&accountID)
		}
	case "trade_account":
		accountID = targetID
	}
	origin := "manual"
	switch {
	case runID != "" && (targetType == "trade_order" || m.Session == runID):
		origin = runID
	case m.Session == "risk", m.Session == "live", m.Session == "recon":
		origin = m.Session
	case m.Session == "user", m.Session == "paper":
		origin = "manual"
	case strings.HasPrefix(m.Session, "rn_"):
		origin = m.Session
	default:
		origin = "system"
	}
	detail["origin"] = origin
	if accountID != "" {
		detail["account_id"] = accountID
	}
	if runID != "" {
		detail["run_id"] = runID
	}
	pp.c.Audit().Note(ctx, plugin.AuditNote{Action: action, TargetType: targetType, TargetID: targetID, Summary: summary, Detail: detail}, m)
	b, err := json.Marshal(detail)
	if err != nil {
		b = []byte("{}")
	}
	if _, err := pp.c.Store().Exec(ctx, `INSERT INTO trade_audit (at, action, target_type, target_id, summary, origin, actor, account_id, run_id, order_id, detail)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, stamp(pp.now()), action, targetType, targetID, summary, origin, m.Session, accountID, runID, orderID, string(b)); err != nil {
		pp.c.Log().Warn("trade audit index failed", "action", action, "err", err)
	}
}

// AuditView 是一条交易审计（TradeAudit）。
type AuditView struct {
	ID         int64          `json:"id"`
	At         string         `json:"at"`
	Action     string         `json:"action"`
	TargetType string         `json:"target_type"`
	TargetID   string         `json:"target_id"`
	Summary    string         `json:"summary"`
	Origin     string         `json:"origin"`
	Actor      string         `json:"actor"`
	AccountID  string         `json:"account_id,omitempty"`
	RunID      string         `json:"run_id,omitempty"`
	OrderID    string         `json:"order_id,omitempty"`
	Detail     map[string]any `json:"detail"`
}

// GET /api/trade/audit?account_id=&run_id=&order_id=&action=&target_type=&origin=&since=&until=&limit=&offset=
// 新的在前；since、until 是 RFC3339，左闭右开。
func (h *handlers) listAudit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	qs := r.URL.Query()
	limit, offset, err := pageParams(r, 200, 1000)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var conds []string
	var args []any
	for _, k := range []string{"account_id", "run_id", "order_id", "action", "target_type", "origin"} {
		if v := qs.Get(k); v != "" {
			conds, args = append(conds, k+" = ?"), append(args, v)
		}
	}
	for k, op := range map[string]string{"since": ">=", "until": "<"} {
		v := qs.Get(k)
		if v == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			h.fail(w, r, apiErr(errValidation, "%s 要是 RFC3339 时间，如 2026-11-05T00:00:00Z", k))
			return
		}
		conds, args = append(conds, "at "+op+" ?"), append(args, stamp(t))
	}
	where := wherePrefix(strings.Join(conds, " AND "))
	var total int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_audit`+where, args...).Scan(&total); err != nil {
		h.fail(w, r, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT id, at, action, target_type, target_id, summary, origin, actor, account_id, run_id, order_id, detail FROM trade_audit`+where+
		` ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []AuditView{}
	for rows.Next() {
		var x AuditView
		var detail string
		if err := rows.Scan(&x.ID, &x.At, &x.Action, &x.TargetType, &x.TargetID, &x.Summary, &x.Origin, &x.Actor, &x.AccountID, &x.RunID, &x.OrderID, &detail); err != nil {
			h.fail(w, r, err)
			return
		}
		if json.Unmarshal([]byte(detail), &x.Detail) != nil || x.Detail == nil {
			x.Detail = map[string]any{}
		}
		out = append(out, x)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total, "limit": limit, "offset": offset}})
}

/* ---------- 停用、卸载前强制全停 ---------- */

// activeCounts 是还没停的部署（运行中、已暂停、异常都算）和挂单数。
func activeCounts(ctx context.Context, c plugin.Core) (runs, orders int, err error) {
	if err = c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_runs WHERE status != 'stopped'`).Scan(&runs); err != nil {
		return
	}
	err = c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_orders WHERE status = 'open'`).Scan(&orders)
	return
}

// stopBlock 是停用、卸载被拦的原因（同原型 pluginOffBlock）；没有在跑的回空串。
func stopBlock(ctx context.Context, c plugin.Core) string {
	runs, orders, err := activeCounts(ctx, c)
	if err != nil {
		return "查不到部署和挂单（" + err.Error() + "），为了安全先不停用；稍后再试"
	}
	var parts []string
	if runs > 0 {
		parts = append(parts, fmt.Sprintf("%d 个部署在跑", runs))
	}
	if orders > 0 {
		parts = append(parts, fmt.Sprintf("%d 笔挂单", orders))
	}
	if len(parts) == 0 {
		return ""
	}
	return "还有 " + strings.Join(parts, "、") + "，先到交易里一键全停"
}

// CanDisable 实现 plugin.DisableGuard：有没停的部署或挂单时拒绝停用（docs/plugin-api.md 4.3），一键全停之后可以停。
func (p *Plugin) CanDisable(ctx context.Context, c plugin.Core) (bool, string) {
	if why := stopBlock(ctx, c); why != "" {
		return false, why
	}
	return true, ""
}

// OnUninstall 实现 plugin.Uninstaller：同样拦（停用前没全停就停了的旧版本数据），先启用、一键全停再卸载。
func (p *Plugin) OnUninstall(ctx context.Context, c plugin.Core, _ bool) error {
	if why := stopBlock(ctx, c); why != "" {
		return &stateError{msg: why + "（先启用交易插件、一键全停，再停用、卸载）"}
	}
	return nil
}

// stateError 认作 plugin.ErrState（插件管理接口回 409 conflict），文字直接给人看。
type stateError struct{ msg string }

func (e *stateError) Error() string        { return e.msg }
func (e *stateError) Is(target error) bool { return target == plugin.ErrState }

var _ plugin.DisableGuard = (*Plugin)(nil)
var _ plugin.Uninstaller = (*Plugin)(nil)
