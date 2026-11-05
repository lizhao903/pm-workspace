package trade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 实盘评审闸门（TRD-08c）：评审清单、评审记录、实盘开关，表在迁移 0011。
//
// 评审清单五项（审计日志、对账、异常演练、全停演练、模拟盘两周记录）的条件由后端现算，每项带证据链接（能直接查的接口路径）。
// 条件满足的项才能确认；确认、申请 trade:live、打开实盘开关只接受用户本人在界面上的操作（plugin.RequireUser：
// X-Actor-Source 是 ui 且不带会话标识），Agent、脚本、接口代为提交一律 403 并记审计。撤回、关开关只会更保守，谁调都行。
// 五项都确认即评审通过（记一条 pass，评审人是确认最后一项的人）；之后撤回任何一项，评审回到未通过、trade:live 一并收回、开关关掉。
//
// trade:live 走内核的单独申请（POST /api/plugins/trade/permissions/grant，二次确认输入插件名），
// 插件实现 PermissionGuard：评审没通过时不同意授予。
//
// 实盘开关：评审没通过或没授予 trade:live 时打开一律 403 并写缺什么。开关只记意愿——
// 本批次没有实盘下单：开关开着，下单、改单撤单、平仓、部署对实盘账户照样 403（paperAccount、liveErr），要等 TRD-08d。

// LivePerm 是实盘下单的权限。
const LivePerm = "trade:live"

// liveCheckDef 是评审清单的一项，文字同原型 LIVE_CHECKS。
type liveCheckDef struct{ Key, Label, Desc string }

var liveCheckDefs = []liveCheckDef{
	{"audit", "审计日志", "一笔委托从下单、报单、成交到撤单的每一步都能查到，风控拦截和熔断也记"},
	{"recon", "对账", "实盘账户定时和交易所对余额、持仓、挂单，差异都处理完"},
	{"incident", "异常演练", "账户异常、委托被拒、风控拦截、熔断、对账差异都记审计、运行异常并通知；至少真的出过一次并查得到"},
	{"drill", "全停演练", "手动按一次一键全停，确认策略全停、挂单全撤、进入熔断，再解除"},
	{"paper", "模拟盘两周记录", "至少一个部署在模拟盘连续跑满 14 天，每天一条运行检查记录（TRD-05d）"},
}

func liveCheckDefOf(key string) (liveCheckDef, bool) {
	for _, d := range liveCheckDefs {
		if d.Key == key {
			return d, true
		}
	}
	return liveCheckDef{}, false
}

// LiveEvidence 是一条证据：href 是能直接 GET 的接口路径，view 是前端交易页里去看的视图（可选）。
type LiveEvidence struct {
	Label string `json:"label"`
	Href  string `json:"href"`
	View  string `json:"view,omitempty"`
}

// liveCheck 是一项此刻的情况。
type liveCheck struct {
	OK       bool           `json:"ok"`
	Text     string         `json:"text"`
	Go       string         `json:"go,omitempty"` // 条件不满足时去处理的视图：accounts / risk / runs / orders
	Evidence []LiveEvidence `json:"evidence"`
}

// LiveCheckView 是评审清单的一项（TradeLiveCheck）。
type LiveCheckView struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Desc  string `json:"desc"`
	liveCheck
	ConfirmedAt string `json:"confirmed_at,omitempty"`
	Reviewer    string `json:"reviewer,omitempty"`
	Note        string `json:"note,omitempty"`
	// Confirmed 是确认那一刻的情况和证据快照
	Confirmed *liveCheck `json:"confirmed,omitempty"`
}

// LiveReviewRecord 是一条评审记录（TradeLiveReviewRecord）。
type LiveReviewRecord struct {
	ID       int64          `json:"id"`
	At       string         `json:"at"`
	Action   string         `json:"action"`
	Item     string         `json:"item,omitempty"`
	Reviewer string         `json:"reviewer"`
	Source   string         `json:"source"`
	Detail   map[string]any `json:"detail"`
}

// LiveView 是实盘评审和开关的全貌（TradeLive）。
type LiveView struct {
	Checks []LiveCheckView `json:"checks"`
	// Review 是评审结论：passed（五项都确认）/ pending
	Review struct {
		Status   string   `json:"status"`
		At       string   `json:"at,omitempty"`
		Reviewer string   `json:"reviewer,omitempty"`
		Missing  []string `json:"missing"`
	} `json:"review"`
	Granted   bool   `json:"granted"`
	Enabled   bool   `json:"enabled"`
	ChangedAt string `json:"changed_at,omitempty"`
	ChangedBy string `json:"changed_by,omitempty"`
	OffReason string `json:"off_reason,omitempty"`
	// CanEnable、Blockers：现在能不能打开、不能的原因（按要做的先后）
	CanEnable bool     `json:"can_enable"`
	Blockers  []string `json:"blockers"`
	// LiveOrders 恒为 false：实盘下单（TRD-08d）没上线，开关开着实盘账户也只读
	LiveOrders bool               `json:"live_orders"`
	Note       string             `json:"note"`
	PluginName string             `json:"plugin_name"`
	Records    []LiveReviewRecord `json:"records"`
}

const liveOrdersNote = "实盘下单还没上线（TRD-08d）：实盘开关打开后，实盘账户的下单、改单撤单、平仓、部署和启动照样不可用，只读同步"

/* ---------- 五项的条件 ---------- */

func auditHref(q url.Values) string { return "/api/trade/audit?" + q.Encode() }

func (h *handlers) checkAudit(ctx context.Context) (liveCheck, error) {
	st := h.c.Store()
	var places, fills, halts int
	if err := st.QueryRow(ctx, `SELECT COUNT(DISTINCT order_id) FROM trade_audit WHERE action = 'place'`).Scan(&places); err != nil {
		return liveCheck{}, err
	}
	if err := st.QueryRow(ctx, `SELECT COUNT(DISTINCT order_id) FROM trade_audit WHERE action = 'fill'`).Scan(&fills); err != nil {
		return liveCheck{}, err
	}
	if err := st.QueryRow(ctx, `SELECT COUNT(*) FROM trade_audit WHERE action IN ('kill', 'halt')`).Scan(&halts); err != nil {
		return liveCheck{}, err
	}
	var sample string
	err := st.QueryRow(ctx, `SELECT order_id FROM trade_audit WHERE action = 'fill' AND order_id != ''
		AND order_id IN (SELECT order_id FROM trade_audit WHERE action = 'place') ORDER BY at DESC LIMIT 1`).Scan(&sample)
	if err != nil && !errors.Is(err, plugin.ErrNoRows) {
		return liveCheck{}, err
	}
	ev := []LiveEvidence{
		{Label: "下单审计", Href: auditHref(url.Values{"action": {"place"}})},
		{Label: "成交审计", Href: auditHref(url.Values{"action": {"fill"}})},
		{Label: "熔断审计", Href: auditHref(url.Values{"target_type": {"trade_risk"}})},
	}
	if sample == "" {
		return liveCheck{Text: fmt.Sprintf("还没有一笔从下单到成交都查得到的委托（下单 %d 笔、成交 %d 笔）：先在模拟盘下一笔成交", places, fills), Go: "orders", Evidence: ev}, nil
	}
	ev = append([]LiveEvidence{{Label: "一笔委托从下单到成交（" + sample + "）", Href: auditHref(url.Values{"order_id": {sample}})}}, ev...)
	return liveCheck{OK: true, Text: fmt.Sprintf("委托 %d 笔有下单记录、%d 笔有成交记录，熔断 %d 次，每一步都有记录", places, fills, halts), Evidence: ev}, nil
}

func (h *handlers) checkRecon(ctx context.Context) (liveCheck, error) {
	accts, err := loadAccounts(ctx, h.c)
	if err != nil {
		return liveCheck{}, err
	}
	ev := []LiveEvidence{{Label: "对账差异的处理", Href: auditHref(url.Values{"action": {"recon_resolve"}})}}
	var bad []string
	n := 0
	for _, a := range accts {
		if a.Paper {
			continue
		}
		n++
		b, err := h.p.live.reconBrief(ctx, a.ID)
		if err != nil {
			return liveCheck{}, err
		}
		ev = append(ev, LiveEvidence{Label: a.Name + " 的对账记录", Href: "/api/trade/recons?" + url.Values{"account_id": {a.ID}}.Encode(), View: "accounts"})
		switch {
		case b.Status == "none":
			bad = append(bad, a.Name+"还没对过账")
		case b.Status == "failed":
			bad = append(bad, a.Name+"对账失败")
		case b.Open > 0:
			bad = append(bad, fmt.Sprintf("%s有 %d 处差异没处理", a.Name, b.Open))
		}
	}
	if n == 0 {
		return liveCheck{Text: "还没有接入实盘账户，没有可对的账", Go: "accounts", Evidence: ev}, nil
	}
	if len(bad) > 0 {
		return liveCheck{Text: strings.Join(bad, "；"), Go: "accounts", Evidence: ev}, nil
	}
	return liveCheck{OK: true, Text: fmt.Sprintf("%d 个实盘账户最近一次对账都一致", n), Evidence: ev}, nil
}

// incidentActions 是算「交易异常」的审计动作和名字。
var incidentActions = []struct{ Action, Label string }{
	{"risk_block", "风控拦截"}, {"reject", "委托被拒"}, {"sync_failed", "账户异常"}, {"key_rejected", "Key 被拒"},
	{"recon_diff", "对账差异"}, {"breaker", "自动熔断"},
}

func (h *handlers) checkIncident(ctx context.Context) (liveCheck, error) {
	var parts []string
	var ev []LiveEvidence
	total := 0
	for _, x := range incidentActions {
		var n int
		if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_audit WHERE action = ?`, x.Action).Scan(&n); err != nil {
			return liveCheck{}, err
		}
		ev = append(ev, LiveEvidence{Label: x.Label, Href: auditHref(url.Values{"action": {x.Action}})})
		if n > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", x.Label, n))
			total += n
		}
	}
	if total == 0 {
		return liveCheck{Text: "还没有记过交易异常：在模拟盘下一笔超过单笔上限的单，确认被风控拦下、审计和「设置 / 运行异常」里都查得到", Go: "orders", Evidence: ev}, nil
	}
	var at, summary string
	acts := make([]any, 0, len(incidentActions))
	marks := make([]string, 0, len(incidentActions))
	for _, x := range incidentActions {
		acts = append(acts, x.Action)
		marks = append(marks, "?")
	}
	if err := h.c.Store().QueryRow(ctx, `SELECT at, summary FROM trade_audit WHERE action IN (`+strings.Join(marks, ", ")+`) ORDER BY at DESC, id DESC LIMIT 1`, acts...).
		Scan(&at, &summary); err != nil {
		return liveCheck{}, err
	}
	return liveCheck{OK: true, Text: fmt.Sprintf("记过 %d 条交易异常（%s），都进了审计和运行异常；最近一次 %s：%s", total, strings.Join(parts, "、"), shortTime(at), summary), Evidence: ev}, nil
}

func (h *handlers) checkDrill(ctx context.Context) (liveCheck, error) {
	ev := []LiveEvidence{
		{Label: "一键全停", Href: auditHref(url.Values{"action": {"kill"}})},
		{Label: "解除熔断", Href: auditHref(url.Values{"action": {"release"}})},
		{Label: "熔断记录", Href: "/api/trade/risk/halts", View: "risk"},
	}
	var at, rel string
	err := h.c.Store().QueryRow(ctx, `SELECT at, released_at FROM trade_halts WHERE kind = 'manual' AND released_at != '' ORDER BY released_at DESC LIMIT 1`).Scan(&at, &rel)
	if errors.Is(err, plugin.ErrNoRows) {
		return liveCheck{Text: "还没演练过：按一次一键全停，确认都停了再解除熔断", Go: "risk", Evidence: ev}, nil
	}
	if err != nil {
		return liveCheck{}, err
	}
	return liveCheck{OK: true, Text: fmt.Sprintf("%s 全停，%s 解除", shortTime(at), shortTime(rel)), Evidence: ev}, nil
}

// checkPaper：模拟盘两周记录要 TRD-05d 的每日运行检查，那条还没做，这一项一律不满足（Plugin.paperRecord 只给测试换）。
func (h *handlers) checkPaper(ctx context.Context) (liveCheck, error) {
	ev := []LiveEvidence{{Label: "模拟盘部署", Href: "/api/trade/runs", View: "runs"}}
	if h.p.paperRecord != nil {
		ok, text := h.p.paperRecord(ctx)
		return liveCheck{OK: ok, Text: text, Go: "runs", Evidence: ev}, nil
	}
	rows, err := h.c.Store().Query(ctx, `SELECT r.started_at, r.stopped_at FROM trade_runs r JOIN trade_accounts a ON a.id = r.account_id WHERE a.paper = 1`)
	if err != nil {
		return liveCheck{}, err
	}
	defer func() { _ = rows.Close() }()
	now := h.p.paper.now()
	best := 0.0
	for rows.Next() {
		var from, to string
		if err := rows.Scan(&from, &to); err != nil {
			return liveCheck{}, err
		}
		s, err := time.Parse(time.RFC3339Nano, from)
		if err != nil {
			continue
		}
		e := now
		if t, err := time.Parse(time.RFC3339Nano, to); err == nil && to != "" {
			e = t
		}
		best = max(best, e.Sub(s).Hours()/24)
	}
	if err := rows.Err(); err != nil {
		return liveCheck{}, err
	}
	run := "还没在模拟盘跑过部署"
	if best > 0 {
		run = fmt.Sprintf("模拟盘最长连续跑了 %d 天", int(best))
	}
	return liveCheck{Text: run + "；连续两周的每日运行检查（TRD-05d）还没做，这一项先不能确认", Go: "runs", Evidence: ev}, nil
}

func shortTime(s string) string {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return s
	}
	return t.UTC().Format("01-02 15:04") + " UTC"
}

func (h *handlers) liveCheckOf(ctx context.Context, key string) (liveCheck, error) {
	switch key {
	case "audit":
		return h.checkAudit(ctx)
	case "recon":
		return h.checkRecon(ctx)
	case "incident":
		return h.checkIncident(ctx)
	case "drill":
		return h.checkDrill(ctx)
	case "paper":
		return h.checkPaper(ctx)
	}
	return liveCheck{}, apiErr(errNotFound, "评审项 %s 不存在", key)
}

/* ---------- 状态 ---------- */

type confirmedCheck struct {
	At, Reviewer, Note string
	Snap               *liveCheck
}

func loadConfirmed(ctx context.Context, c plugin.Core) (map[string]confirmedCheck, error) {
	rows, err := c.Store().Query(ctx, `SELECT key, confirmed_at, reviewer, evidence, note FROM trade_live_checks`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]confirmedCheck{}
	for rows.Next() {
		var k, ev string
		var x confirmedCheck
		if err := rows.Scan(&k, &x.At, &x.Reviewer, &ev, &x.Note); err != nil {
			return nil, err
		}
		var snap liveCheck
		if json.Unmarshal([]byte(ev), &snap) == nil {
			x.Snap = &snap
		}
		out[k] = x
	}
	return out, rows.Err()
}

// reviewMissing 是还没确认的项名，按清单顺序；空即评审通过。
func reviewMissing(conf map[string]confirmedCheck) []string {
	out := []string{}
	for _, d := range liveCheckDefs {
		if _, ok := conf[d.Key]; !ok {
			out = append(out, d.Label)
		}
	}
	return out
}

func reviewPassed(ctx context.Context, c plugin.Core) (bool, []string, error) {
	conf, err := loadConfirmed(ctx, c)
	if err != nil {
		return false, nil, err
	}
	m := reviewMissing(conf)
	return len(m) == 0, m, nil
}

type liveSwitch struct {
	Enabled                      bool
	ChangedAt, ChangedBy, Reason string
}

func loadSwitch(ctx context.Context, c plugin.Core) (liveSwitch, error) {
	var s liveSwitch
	var on int
	err := c.Store().QueryRow(ctx, `SELECT enabled, changed_at, changed_by, reason FROM trade_live_switch WHERE id = 'global'`).Scan(&on, &s.ChangedAt, &s.ChangedBy, &s.Reason)
	if errors.Is(err, plugin.ErrNoRows) {
		return s, nil
	}
	s.Enabled = on == 1
	return s, err
}

func saveSwitch(ctx context.Context, c plugin.Core, s liveSwitch) error {
	_, err := c.Store().Exec(ctx, `INSERT INTO trade_live_switch (id, enabled, changed_at, changed_by, reason) VALUES ('global', ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, changed_at = excluded.changed_at, changed_by = excluded.changed_by, reason = excluded.reason`,
		b2i(s.Enabled), s.ChangedAt, s.ChangedBy, s.Reason)
	return err
}

// gateBlockers 是打开实盘开关还缺的，按要做的先后：评审、trade:live。
func gateBlockers(missing []string, granted bool) []string {
	out := []string{}
	if len(missing) > 0 {
		out = append(out, fmt.Sprintf("评审还差 %d 项没确认：%s", len(missing), strings.Join(missing, "、")))
	}
	if !granted {
		out = append(out, "还没授予 trade:live 权限（在交易设置里申请，二次确认输入插件名）")
	}
	return out
}

func (h *handlers) record(ctx context.Context, action, item string, a plugin.RequestActor, detail map[string]any) error {
	if detail == nil {
		detail = map[string]any{}
	}
	b, _ := json.Marshal(detail)
	_, err := h.c.Store().Exec(ctx, `INSERT INTO trade_live_reviews (at, action, item, reviewer, source, detail) VALUES (?, ?, ?, ?, ?, ?)`,
		stamp(h.p.paper.now()), action, item, reviewerName(a), a.Source, string(b))
	return err
}

// reviewerName 是评审人：界面操作者的名字，带会话的加上会话。
func reviewerName(a plugin.RequestActor) string {
	if a.Session != "" {
		return a.Name + "#" + a.Session
	}
	return a.Name
}

// settle 让开关和评审、trade:live 对得上：开关开着但评审没通过或 trade:live 没了，就关掉并记下原因。
// 调用方持有 h.p.liveMu。
func (h *handlers) settle(ctx context.Context) (liveSwitch, error) {
	sw, err := loadSwitch(ctx, h.c)
	if err != nil || !sw.Enabled {
		return sw, err
	}
	passed, missing, err := reviewPassed(ctx, h.c)
	if err != nil {
		return sw, err
	}
	granted := h.c.Granted(LivePerm)
	if passed && granted {
		return sw, nil
	}
	sw = liveSwitch{ChangedAt: stamp(h.p.paper.now()), ChangedBy: "trade", Reason: strings.Join(gateBlockers(missing, granted), "；") + "，实盘开关自动关掉"}
	if err := saveSwitch(ctx, h.c, sw); err != nil {
		return sw, err
	}
	h.p.paper.audit(ctx, "live_off", "trade_live", "switch", "实盘开关自动关掉："+sw.Reason, map[string]any{"reason": sw.Reason}, plugin.WriteMeta{Session: "system"})
	return sw, nil
}

func (h *handlers) liveView(ctx context.Context) (LiveView, error) {
	var v LiveView
	sw, err := h.settle(ctx)
	if err != nil {
		return v, err
	}
	conf, err := loadConfirmed(ctx, h.c)
	if err != nil {
		return v, err
	}
	for _, d := range liveCheckDefs {
		ck, err := h.liveCheckOf(ctx, d.Key)
		if err != nil {
			return v, err
		}
		cv := LiveCheckView{Key: d.Key, Label: d.Label, Desc: d.Desc, liveCheck: ck}
		if x, ok := conf[d.Key]; ok {
			cv.ConfirmedAt, cv.Reviewer, cv.Note, cv.Confirmed = x.At, x.Reviewer, x.Note, x.Snap
		}
		v.Checks = append(v.Checks, cv)
	}
	missing := reviewMissing(conf)
	v.Review.Missing = missing
	v.Review.Status = "pending"
	if len(missing) == 0 {
		v.Review.Status = "passed"
		_ = h.c.Store().QueryRow(ctx, `SELECT at, reviewer FROM trade_live_reviews WHERE action = 'pass' ORDER BY id DESC LIMIT 1`).Scan(&v.Review.At, &v.Review.Reviewer)
	}
	v.Granted = h.c.Granted(LivePerm)
	v.Enabled, v.ChangedAt, v.ChangedBy, v.OffReason = sw.Enabled, sw.ChangedAt, sw.ChangedBy, sw.Reason
	v.Blockers = gateBlockers(missing, v.Granted)
	v.CanEnable = len(v.Blockers) == 0
	v.Note, v.PluginName = liveOrdersNote, h.p.m.Name
	v.Records = []LiveReviewRecord{}
	rows, err := h.c.Store().Query(ctx, `SELECT id, at, action, item, reviewer, source, detail FROM trade_live_reviews ORDER BY id DESC LIMIT 50`)
	if err != nil {
		return v, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var x LiveReviewRecord
		var detail string
		if err := rows.Scan(&x.ID, &x.At, &x.Action, &x.Item, &x.Reviewer, &x.Source, &detail); err != nil {
			return v, err
		}
		if json.Unmarshal([]byte(detail), &x.Detail) != nil || x.Detail == nil {
			x.Detail = map[string]any{}
		}
		v.Records = append(v.Records, x)
	}
	return v, rows.Err()
}

// CanGrant：trade:live 只在实盘评审通过后才能授予（内核单独申请时问，持有注册表锁，这里只读表）。
func (p *Plugin) CanGrant(ctx context.Context, c plugin.Core, perm string) (bool, string) {
	if perm != LivePerm {
		return false, "交易插件只单独申请 trade:live"
	}
	passed, missing, err := reviewPassed(ctx, c)
	if err != nil {
		return false, "读评审记录失败：" + err.Error()
	}
	if !passed {
		return false, fmt.Sprintf("实盘评审还差 %d 项没确认：%s", len(missing), strings.Join(missing, "、"))
	}
	return true, ""
}

/* ---------- 接口 ---------- */

// denyNotUser 写回 403：只接受用户本人在界面上的操作；同时记审计和一条 denied 评审记录。
func (h *handlers) denyNotUser(w http.ResponseWriter, r *http.Request, item string, err error) {
	ctx := r.Context()
	a := plugin.ActorOf(ctx)
	_ = h.record(ctx, "denied", item, a, map[string]any{"path": r.URL.Path, "reason": err.Error()})
	h.p.paper.audit(ctx, "live_denied", "trade_live", orDefault(item, "switch"), "拒绝代为提交："+err.Error(),
		map[string]any{"path": r.URL.Path, "actor": reviewerName(a), "source": a.Source}, userMeta)
	writeJSON(w, http.StatusForbidden, map[string]any{"error": map[string]any{"code": "forbidden", "reason": "not_user", "message": err.Error()}})
}

func failGate(w http.ResponseWriter, msg string, missing []string) {
	writeJSON(w, http.StatusForbidden, map[string]any{"error": map[string]any{"code": "forbidden", "reason": "live_gate", "message": msg, "missing": missing}})
}

// GET /api/trade/live
func (h *handlers) getLive(w http.ResponseWriter, r *http.Request) {
	h.p.liveMu.Lock()
	defer h.p.liveMu.Unlock()
	v, err := h.liveView(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// POST /api/trade/live/checks/{key}/confirm {note?}：确认一项。只接受用户本人；条件不满足 409；已确认过 409。
func (h *handlers) confirmLiveCheck(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := r.PathValue("key")
	d, ok := liveCheckDefOf(key)
	if !ok {
		h.fail(w, r, apiErr(errNotFound, "评审项 %s 不存在", key))
		return
	}
	if err := plugin.RequireUser(ctx, "实盘评审「"+d.Label+"」"); err != nil {
		h.p.liveMu.Lock()
		h.denyNotUser(w, r, key, err)
		h.p.liveMu.Unlock()
		return
	}
	raw, err := readOptionalBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	b := &bodyReader{raw: raw}
	b.only("note")
	var note string
	b.str("note", &note)
	if b.err != nil {
		h.fail(w, r, b.err)
		return
	}
	if utf8.RuneCountInString(note) > 200 {
		h.fail(w, r, apiErr(errValidation, "备注最多 200 字"))
		return
	}
	h.p.liveMu.Lock()
	defer h.p.liveMu.Unlock()
	conf, err := loadConfirmed(ctx, h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if x, ok := conf[key]; ok {
		failLive(w, http.StatusConflict, "state", fmt.Sprintf("「%s」%s 已经确认过了", d.Label, shortTime(x.At)))
		return
	}
	ck, err := h.liveCheckOf(ctx, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if !ck.OK {
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "conflict", "reason": "check", "message": "「" + d.Label + "」的条件还不满足：" + ck.Text}})
		return
	}
	a := plugin.ActorOf(ctx)
	snap, _ := json.Marshal(ck)
	now := stamp(h.p.paper.now())
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO trade_live_checks (key, confirmed_at, reviewer, evidence, note) VALUES (?, ?, ?, ?, ?)`,
		key, now, reviewerName(a), string(snap), note); err != nil {
		h.fail(w, r, err)
		return
	}
	if err := h.record(ctx, "confirm", key, a, map[string]any{"text": ck.Text, "evidence": ck.Evidence, "note": note}); err != nil {
		h.fail(w, r, err)
		return
	}
	h.p.paper.audit(ctx, "review_confirm", "trade_live", key, "实盘评审确认「"+d.Label+"」："+ck.Text,
		map[string]any{"item": key, "reviewer": reviewerName(a), "evidence": ck.Evidence, "note": note}, userMeta)
	conf[key] = confirmedCheck{At: now}
	if len(reviewMissing(conf)) == 0 {
		if err := h.record(ctx, "pass", "", a, map[string]any{"items": liveCheckKeys()}); err != nil {
			h.fail(w, r, err)
			return
		}
		h.p.paper.audit(ctx, "review_pass", "trade_live", "review", "实盘评审五项都已确认，评审通过（评审人 "+reviewerName(a)+"）", map[string]any{"reviewer": reviewerName(a)}, userMeta)
	}
	v, err := h.liveView(ctx)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

func liveCheckKeys() []string {
	out := make([]string, 0, len(liveCheckDefs))
	for _, d := range liveCheckDefs {
		out = append(out, d.Key)
	}
	return out
}

// POST /api/trade/live/checks/{key}/revoke：撤回一项。只会更保守，谁调都行（记下是谁）；
// 评审原来是通过的：回到未通过，trade:live 一并收回，实盘开关关掉。没确认过的照样 200。
func (h *handlers) revokeLiveCheck(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := r.PathValue("key")
	d, ok := liveCheckDefOf(key)
	if !ok {
		h.fail(w, r, apiErr(errNotFound, "评审项 %s 不存在", key))
		return
	}
	h.p.liveMu.Lock()
	defer h.p.liveMu.Unlock()
	conf, err := loadConfirmed(ctx, h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if _, ok := conf[key]; ok {
		wasPassed := len(reviewMissing(conf)) == 0
		a := plugin.ActorOf(ctx)
		if _, err := h.c.Store().Exec(ctx, `DELETE FROM trade_live_checks WHERE key = ?`, key); err != nil {
			h.fail(w, r, err)
			return
		}
		if err := h.record(ctx, "revoke", key, a, nil); err != nil {
			h.fail(w, r, err)
			return
		}
		h.p.paper.audit(ctx, "review_revoke", "trade_live", key, "撤回实盘评审「"+d.Label+"」（"+a.Label()+"）", map[string]any{"item": key, "actor": reviewerName(a), "source": a.Source}, userMeta)
		if wasPassed {
			if err := h.record(ctx, "reopen", "", a, map[string]any{"item": key}); err != nil {
				h.fail(w, r, err)
				return
			}
			if err := h.c.RevokePermission(ctx, LivePerm); err != nil {
				h.fail(w, r, err)
				return
			}
			h.p.paper.audit(ctx, "review_reopen", "trade_live", "review", "撤回「"+d.Label+"」，实盘评审回到未通过，trade:live 一并收回", map[string]any{"item": key}, userMeta)
		}
	}
	v, err := h.liveView(ctx)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// POST /api/trade/live/switch {enabled}：打开只接受用户本人，且评审通过、trade:live 已授予，否则 403 写缺什么；关掉谁调都行。
// 开关只记意愿：实盘下单没上线前，开着也不开放实盘账户的任何交易动作。
func (h *handlers) setLiveSwitch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	b := &bodyReader{raw: raw}
	b.only("enabled")
	var on *bool
	if v, ok := raw["enabled"]; ok {
		var x bool
		if json.Unmarshal(v, &x) != nil {
			h.fail(w, r, apiErr(errValidation, "enabled 要是 true 或 false"))
			return
		}
		on = &x
	}
	if b.err != nil {
		h.fail(w, r, b.err)
		return
	}
	if on == nil {
		h.fail(w, r, apiErr(errValidation, "要给 enabled"))
		return
	}
	h.p.liveMu.Lock()
	defer h.p.liveMu.Unlock()
	a := plugin.ActorOf(ctx)
	if *on {
		if err := plugin.RequireUser(ctx, "打开实盘开关"); err != nil {
			h.denyNotUser(w, r, "", err)
			return
		}
		_, missing, err := reviewPassed(ctx, h.c)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		bl := gateBlockers(missing, h.c.Granted(LivePerm))
		if len(bl) > 0 {
			failGate(w, "实盘开关现在不能打开："+strings.Join(bl, "；"), bl)
			return
		}
	}
	sw, err := loadSwitch(ctx, h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if sw.Enabled != *on {
		reason := ""
		if !*on {
			reason = "手动关掉"
		}
		sw = liveSwitch{Enabled: *on, ChangedAt: stamp(h.p.paper.now()), ChangedBy: reviewerName(a), Reason: reason}
		if err := saveSwitch(ctx, h.c, sw); err != nil {
			h.fail(w, r, err)
			return
		}
		action, text := "live_on", "打开实盘开关（实盘下单还没上线，实盘账户仍只读）"
		if !*on {
			action, text = "live_off", "关掉实盘开关"
		}
		h.p.paper.audit(ctx, action, "trade_live", "switch", text+"（"+a.Label()+"）", map[string]any{"actor": reviewerName(a), "source": a.Source}, userMeta)
	}
	v, err := h.liveView(ctx)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}
