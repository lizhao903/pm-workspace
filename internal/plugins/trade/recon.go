package trade

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 实盘账户对账和异常处理（TRD-08b）：表 trade_recons、trade_recon_items（迁移 0010）。
//
// 每次只读同步成功后对一次账：本地记录（trade_live_holdings、trade_live_orders：建立本地记录时按交易所初始化，之后只按拉到的成交变动）
// 和交易所这一刻的持仓、挂单逐项比，对不上的落一条差异。同一处差异再次出现时更新它（seen 加一），不重复建；
// 自己对上了的自动关闭（resolution auto）。差异连续两次对账都在才算数：发通知（kind trade.recon）、记运行异常「交易对账异常」，
// 持仓差异的相对差到 recon_diff_pct 时自动熔断。挂单差异只通知不熔断（在交易所手动挂撤单就会出现）。
// 计价币（USDT 等）余额受资金费、合约盈亏影响，不比，只给人看。
//
// 自动熔断复用一键全停（paper.kill，kind auto），三种触发：对账差异超阈值、交易所接口连续失败 sync_fail_limit 次、
// 数据源断开（Key 失效、带了提币权限、连接器没了，或行情源断开超过 feed_down_minutes 且有在跑的部署、挂单）。
// 每一轮故障只熔断一次；恢复后不自动解除熔断，要到风控手动解除。熔断都写审计（breaker，origin risk）。

const reconConfirm = 2 // 差异连续几次对账都在才发通知、判熔断

// ReconItemView 是一处差异（TradeReconItem），前半同原型 ReconItem。
type ReconItemView struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"` // position / order
	Label      string   `json:"label"`
	Local      string   `json:"local"`
	Remote     string   `json:"remote"`
	Note       string   `json:"note,omitempty"`
	RemoteQty  *float64 `json:"remote_qty,omitempty"`
	ResolvedAt string   `json:"resolved_at,omitempty"`
	Resolution string   `json:"resolution,omitempty"`
	Key        string   `json:"key"`
	Symbol     string   `json:"symbol,omitempty"`
	LocalQty   float64  `json:"local_qty"`
	Pct        float64  `json:"pct"`
	Seen       int      `json:"seen"`
	Confirmed  bool     `json:"confirmed"`
	Method     string   `json:"method,omitempty"` // adopt / verify / auto
	CreatedAt  string   `json:"created_at"`
	UpdatedAt  string   `json:"updated_at"`
}

// ReconView 是一个实盘账户最近一次对账（TradeRecon），前半同原型 Reconciliation。
type ReconView struct {
	AccountID string          `json:"account_id"`
	At        string          `json:"at"`
	Status    string          `json:"status"` // ok / diff / failed / none（还没对过账）
	Error     string          `json:"error,omitempty"`
	Checked   int             `json:"checked"`
	Items     []ReconItemView `json:"items"`
	ID        string          `json:"id,omitempty"`
	Open      int             `json:"open"`
	MaxPct    float64         `json:"max_pct"`
	Threshold float64         `json:"threshold"`
}

// ReconBrief 是账户卡片上的对账一行（TradeAccount.recon）。
type ReconBrief struct {
	Status string `json:"status"`
	At     string `json:"at,omitempty"`
	Open   int    `json:"open"`
	Error  string `json:"error,omitempty"`
}

type reconItem struct {
	ID, Kind, Key, Symbol, Label, Local, Remote, Note string
	LocalQ, RemoteQ                                   fx
	Pct                                               float64
	Seen                                              int
	Notified, Tripped                                 bool
	First, Last, CreatedAt, UpdatedAt                 string
	ResolvedAt, Resolution, ResolveNote               string
}

const reconItemCols = `id, kind, key, symbol, label, local, remote, note, local_e8, remote_e8, pct, seen, notified, tripped, first_recon_id, last_recon_id,
	created_at, updated_at, resolved_at, resolution, resolve_note`

func scanReconItem(row plugin.Row) (reconItem, error) {
	var x reconItem
	var n, t int
	err := row.Scan(&x.ID, &x.Kind, &x.Key, &x.Symbol, &x.Label, &x.Local, &x.Remote, &x.Note, &x.LocalQ, &x.RemoteQ, &x.Pct, &x.Seen, &n, &t, &x.First, &x.Last,
		&x.CreatedAt, &x.UpdatedAt, &x.ResolvedAt, &x.Resolution, &x.ResolveNote)
	x.Notified, x.Tripped = n == 1, t == 1
	return x, err
}

func (ls *liveSync) reconItems(ctx context.Context, where string, args ...any) ([]reconItem, error) {
	rows, err := ls.c.Store().Query(ctx, `SELECT `+reconItemCols+` FROM trade_recon_items `+where, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []reconItem{}
	for rows.Next() {
		x, err := scanReconItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

var resolutionText = map[string]string{"adopt": "按交易所修正了本地记录", "verify": "标为已核实，本地记录不改", "auto": "下次对账已一致，自动关闭"}

func (x reconItem) view() ReconItemView {
	v := ReconItemView{ID: x.ID, Kind: x.Kind, Label: x.Label, Local: x.Local, Remote: x.Remote, Note: x.Note, ResolvedAt: x.ResolvedAt, Key: x.Key,
		Symbol: x.Symbol, LocalQty: x.LocalQ.Float(), Pct: x.Pct, Seen: x.Seen, Confirmed: x.Seen >= reconConfirm, Method: x.Resolution,
		CreatedAt: x.CreatedAt, UpdatedAt: x.UpdatedAt}
	if x.Kind == "position" {
		q := x.RemoteQ.Float()
		v.RemoteQty = &q
	}
	if x.Resolution != "" {
		v.Resolution = resolutionText[x.Resolution]
		if x.ResolveNote != "" {
			v.Resolution += "：" + x.ResolveNote
		}
	}
	return v
}

// diff 是这次对账算出来的一处差异。
type diff struct {
	Kind, Key, Symbol, Label, Local, Remote, Note string
	LocalQ, RemoteQ                               fx
	Pct                                           float64
}

func pctDiff(a, b fx) float64 {
	m := max(a.abs(), b.abs())
	if m == 0 {
		return 0
	}
	return math.Round((a-b).abs().Float()/m.Float()*100*100) / 100
}

// qtyLabel 是持仓数量给人看的写法：带符号的空仓写「空 N」，OKX 永续按张。
func qtyLabel(q fx, key string) string {
	if q == 0 {
		return "0"
	}
	unit := ""
	if strings.HasPrefix(key, "OKX:") && strings.Contains(key, "-SWAP") {
		unit = " 张"
	}
	if q < 0 {
		return "空 " + q.abs().String() + unit
	}
	return q.String() + unit
}

func holdingLabel(key, name string) string {
	if a, ok := strings.CutPrefix(key, "spot:"); ok {
		return a + " 现货持有"
	}
	side := ""
	if _, s, ok := strings.Cut(key, "#"); ok {
		side = map[string]string{"long": "（多）", "short": "（空）"}[s]
	}
	if name == "" {
		name, _, _ = strings.Cut(key, "#")
	}
	return name + " 持仓" + side
}

// reconcileLocked 对一次账（调用方持有 ls.mu）：比本地记录和这次拉到的交易所持仓、挂单，更新差异，到点发通知、熔断。
func (ls *liveSync) reconcileLocked(ctx context.Context, a account, snap liveSnapshot) error {
	hs, err := ls.holdings(ctx, a.ID)
	if err != nil {
		return err
	}
	los, err := ls.localOrders(ctx, a.ID)
	if err != nil {
		return err
	}
	remote := map[string]LivePosition{}
	for _, p := range snap.Positions {
		if cur, ok := remote[p.Key]; ok {
			p.qty += cur.qty
		}
		remote[p.Key] = p
	}
	keys := []string{}
	for k := range hs {
		keys = append(keys, k)
	}
	for k := range remote {
		if _, ok := hs[k]; !ok {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	var diffs []diff
	for _, k := range keys {
		l, r := hs[k].Qty, remote[k].qty
		if l == r {
			continue
		}
		sym := remote[k].Symbol
		if sym == "" {
			sym = hs[k].Symbol
		}
		name := remote[k].Name
		if name == "" {
			if in, ok := loadLedgerInst(ctx, ls.c, sym); ok {
				name = in.Name
			}
		}
		d := diff{Kind: "position", Key: k, Symbol: sym, Label: holdingLabel(k, name), Local: qtyLabel(l, k), Remote: qtyLabel(r, k), LocalQ: l, RemoteQ: r, Pct: pctDiff(l, r)}
		switch {
		case l == 0:
			d.Note = "本地没有这个持仓：可能是在交易所充币、划转进来，或成交没拉到"
		case r == 0:
			d.Note = "交易所已经没有这个持仓：可能是在交易所提币、划转出去，或成交没拉到"
		case strings.HasPrefix(k, "spot:"):
			d.Note = "数量对不上：可能是手续费按这个币扣、充提、划转，或成交没拉到"
		default:
			d.Note = "数量对不上：可能是强平、自动减仓，或成交没拉到"
		}
		diffs = append(diffs, d)
	}
	remoteOrders := map[string]LiveOrder{}
	for _, o := range snap.Orders {
		remoteOrders[o.ID] = o
	}
	ids := []string{}
	for id := range los {
		ids = append(ids, id)
	}
	for id := range remoteOrders {
		if _, ok := los[id]; !ok {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	for _, id := range ids {
		lo, inL := los[id]
		ro, inR := remoteOrders[id]
		if inL && inR {
			continue
		}
		if inR {
			diffs = append(diffs, diff{Kind: "order", Key: id, Symbol: ro.Symbol, Label: ro.Symbol + " " + sideText[ro.Side] + "挂单 #" + id, Local: "没有",
				Remote: "挂单中 " + ro.qty.String(), RemoteQ: ro.qty, Pct: 100, Note: "本地没有这笔挂单：在交易所手动挂的，或本地漏记"})
		} else {
			diffs = append(diffs, diff{Kind: "order", Key: id, Symbol: lo.Symbol, Label: lo.Symbol + " " + sideText[lo.Side] + "挂单 #" + id, Local: "挂单中 " + lo.Qty.String(),
				Remote: "没有", LocalQ: lo.Qty, Pct: 100, Note: "交易所已经没有这笔挂单：在交易所撤了，或成交没拉到"})
		}
	}
	return ls.recordRecon(ctx, a, len(keys)+len(ids), diffs)
}

// recordRecon 落一次对账和它的差异，到点发通知、熔断。
func (ls *liveSync) recordRecon(ctx context.Context, a account, checked int, diffs []diff) error {
	now := stamp(ls.now())
	rid := idgen.Prefixed("rcn")
	open, err := ls.reconItems(ctx, `WHERE account_id = ? AND resolved_at = ''`, a.ID)
	if err != nil {
		return err
	}
	verified, err := ls.reconItems(ctx, `WHERE account_id = ? AND resolution = 'verify' ORDER BY resolved_at DESC`, a.ID)
	if err != nil {
		return err
	}
	pp := ls.p.paper
	found := map[string]bool{}
	var maxPct float64
	var nOpen int
	var fresh []reconItem
	for _, d := range diffs {
		id := d.Kind + "|" + d.Key
		found[id] = true
		// 标为已核实、数量没变的不再报
		if slices.ContainsFunc(verified, func(x reconItem) bool {
			return x.Kind == d.Kind && x.Key == d.Key && x.LocalQ == d.LocalQ && x.RemoteQ == d.RemoteQ
		}) {
			continue
		}
		nOpen++
		if d.Kind == "position" {
			maxPct = max(maxPct, d.Pct)
		}
		if i := slices.IndexFunc(open, func(x reconItem) bool { return x.Kind == d.Kind && x.Key == d.Key }); i >= 0 {
			x := open[i]
			if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_recon_items SET label = ?, local = ?, remote = ?, note = ?, local_e8 = ?, remote_e8 = ?, pct = ?, seen = seen + 1,
				last_recon_id = ?, updated_at = ? WHERE id = ?`, d.Label, d.Local, d.Remote, d.Note, d.LocalQ, d.RemoteQ, d.Pct, rid, now, x.ID); err != nil {
				return err
			}
			continue
		}
		x := reconItem{ID: idgen.Prefixed("rc"), Kind: d.Kind, Key: d.Key, Symbol: d.Symbol, Label: d.Label, Local: d.Local, Remote: d.Remote, Note: d.Note,
			LocalQ: d.LocalQ, RemoteQ: d.RemoteQ, Pct: d.Pct, Seen: 1, First: rid, Last: rid, CreatedAt: now, UpdatedAt: now}
		if _, err := ls.c.Store().Exec(ctx, `INSERT INTO trade_recon_items (id, account_id, kind, key, symbol, label, local_e8, remote_e8, local, remote, note, pct, seen,
			first_recon_id, last_recon_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
			x.ID, a.ID, x.Kind, x.Key, x.Symbol, x.Label, x.LocalQ, x.RemoteQ, x.Local, x.Remote, x.Note, x.Pct, rid, rid, now, now); err != nil {
			return err
		}
		fresh = append(fresh, x)
	}
	// 自己对上了的自动关闭
	for _, x := range open {
		if found[x.Kind+"|"+x.Key] {
			continue
		}
		if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_recon_items SET resolved_at = ?, resolution = 'auto', updated_at = ? WHERE id = ? AND resolved_at = ''`, now, now, x.ID); err != nil {
			return err
		}
		pp.audit(ctx, "recon_auto_resolved", "trade_recon_item", x.ID, "对账差异自己对上了，自动关闭："+a.Name+" "+x.Label, map[string]any{"account_id": a.ID, "key": x.Key}, reconMeta)
	}
	status := "ok"
	if nOpen > 0 {
		status = "diff"
	}
	if _, err := ls.c.Store().Exec(ctx, `INSERT INTO trade_recons (id, account_id, at, status, checked, open, max_pct) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		rid, a.ID, now, status, checked, nOpen, maxPct); err != nil {
		return err
	}
	for _, x := range fresh {
		pp.audit(ctx, "recon_diff", "trade_recon_item", x.ID, fmt.Sprintf("对账差异：%s %s，本地 %s，交易所 %s", a.Name, x.Label, x.Local, x.Remote),
			map[string]any{"account_id": a.ID, "recon_id": rid, "kind": x.Kind, "key": x.Key, "local": x.Local, "remote": x.Remote, "pct": x.Pct}, reconMeta)
	}
	return ls.escalate(ctx, a)
}

// escalate：连续两次都在的差异，没通知过的发通知、记运行异常；持仓差异到阈值的熔断（每处差异只熔断一次）。
func (ls *liveSync) escalate(ctx context.Context, a account) error {
	items, err := ls.reconItems(ctx, `WHERE account_id = ? AND resolved_at = '' AND seen >= ? ORDER BY created_at, id`, a.ID, reconConfirm)
	if err != nil {
		return err
	}
	r, err := ls.p.paper.risk(ctx)
	if err != nil {
		return err
	}
	pp := ls.p.paper
	var lines []string
	var tripOn []reconItem
	for _, x := range items {
		if !x.Notified {
			lines = append(lines, fmt.Sprintf("%s本地 %s，交易所 %s", x.Label, x.Local, x.Remote))
			if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_recon_items SET notified = 1 WHERE id = ?`, x.ID); err != nil {
				return err
			}
		}
		if x.Kind == "position" && !x.Tripped && x.Pct >= r.ReconDiffPct {
			tripOn = append(tripOn, x)
		}
	}
	if len(lines) > 0 {
		body := fmt.Sprintf("%d 处差异没处理，%s。到「交易 / 交易账户」的对账里处理。", len(lines), strings.Join(lines, "；"))
		pp.notify(ctx, "recon", plugin.NotifyError, "交易对账异常："+a.Name, body, map[string]any{"account_id": a.ID})
		pp.incident(ctx, "trade:recon:"+a.ID, "交易对账异常", a.Name+"："+body, map[string]any{"账户": a.Name})
	}
	if len(tripOn) > 0 {
		x := tripOn[0]
		reason := fmt.Sprintf("交易账户「%s」对账差异超过阈值：%s本地 %s，交易所 %s（差 %s%%，阈值 %s%%），自动熔断", a.Name, x.Label, x.Local, x.Remote,
			jsString(x.Pct), jsString(r.ReconDiffPct))
		for _, y := range tripOn {
			if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_recon_items SET tripped = 1 WHERE id = ?`, y.ID); err != nil {
				return err
			}
		}
		ls.trip(ctx, reason, map[string]any{"account_id": a.ID, "trigger": "recon_diff", "item_id": x.ID, "pct": x.Pct, "threshold": r.ReconDiffPct})
	}
	return nil
}

// recordFailedRecon 记一次失败的对账（拉不到交易所数据）。
func (ls *liveSync) recordFailedRecon(ctx context.Context, a account, msg string) error {
	_, err := ls.c.Store().Exec(ctx, `INSERT INTO trade_recons (id, account_id, at, status, error) VALUES (?, ?, ?, 'failed', ?)`,
		idgen.Prefixed("rcn"), a.ID, stamp(ls.now()), msg)
	return err
}

// trip 自动熔断：已经在熔断中就只记审计，不再全停一次。
func (ls *liveSync) trip(ctx context.Context, reason string, detail map[string]any) {
	pp := ls.p.paper
	r, err := pp.risk(ctx)
	if err != nil {
		ls.c.Log().Warn("breaker risk read failed", "err", err)
		return
	}
	detail["reason"] = reason
	if r.Halted {
		detail["already_halted"] = r.HaltID
		pp.audit(ctx, "breaker", "trade_risk", r.HaltID, "自动熔断条件触发（已经在熔断中，不再全停）："+reason, detail, riskMeta)
		return
	}
	res, err := pp.kill(ctx, reason, "auto", riskMeta)
	if err != nil {
		ls.c.Log().Warn("breaker kill failed", "err", err)
		return
	}
	detail["halt_id"] = res.HaltID
	pp.audit(ctx, "breaker", "trade_risk", res.HaltID, "自动熔断："+reason, detail, riskMeta)
}

/* ---------- 行情数据源断开 ---------- */

// downSince 是行情源从什么时候开始异常；正常回 false。
func (m *market) downSince(id string) (time.Time, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := m.health[id]
	if h == nil || h.status != "error" || h.since.IsZero() {
		return time.Time{}, false
	}
	return h.since, true
}

// checkFeeds：行情源断开超过 feed_down_minutes，而且还有用它的在跑部署或挂单时熔断；这一轮断开只熔断一次，恢复后清掉标记。
func (ls *liveSync) checkFeeds(ctx context.Context) {
	r, err := ls.p.paper.risk(ctx)
	if err != nil {
		return
	}
	now := ls.now()
	for _, s := range ls.p.sources {
		since, down := ls.p.mkt.downSince(s.ID())
		ls.mu.Lock()
		if !down {
			delete(ls.feedTripped, s.ID())
			ls.mu.Unlock()
			continue
		}
		tripped := ls.feedTripped[s.ID()]
		ls.mu.Unlock()
		lim := time.Duration(r.FeedDownMinutes * float64(time.Minute))
		if tripped || now.Sub(since) < lim {
			continue
		}
		prefix := strings.ToUpper(s.ID()) + ":%"
		var nRuns, nOrders int
		_ = ls.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_runs WHERE status = 'running' AND EXISTS (SELECT 1 FROM json_each(trade_runs.symbols) WHERE value LIKE ?)`, prefix).Scan(&nRuns)
		_ = ls.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_orders WHERE status = 'open' AND symbol LIKE ?`, prefix).Scan(&nOrders)
		if nRuns == 0 && nOrders == 0 {
			continue
		}
		ls.mu.Lock()
		ls.feedTripped[s.ID()] = true
		ls.mu.Unlock()
		reason := fmt.Sprintf("行情数据源 %s 断开超过 %s 分钟（从 %s 起），还有 %d 个部署在跑、%d 笔挂单，自动熔断", s.Name(), jsString(r.FeedDownMinutes),
			since.UTC().Format("01-02 15:04"), nRuns, nOrders)
		ls.trip(ctx, reason, map[string]any{"trigger": "feed_down", "source": s.ID(), "since": stamp(since), "runs": nRuns, "orders": nOrders})
	}
}

/* ---------- 接口 ---------- */

func (ls *liveSync) latestRecon(ctx context.Context, aid string) (id, at, status, errText string, checked, open int, maxPct float64, ok bool, err error) {
	err = ls.c.Store().QueryRow(ctx, `SELECT id, at, status, error, checked, open, max_pct FROM trade_recons WHERE account_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`, aid).
		Scan(&id, &at, &status, &errText, &checked, &open, &maxPct)
	if errors.Is(err, plugin.ErrNoRows) {
		return "", "", "none", "", 0, 0, 0, false, nil
	}
	return id, at, status, errText, checked, open, maxPct, err == nil, err
}

func (ls *liveSync) reconBrief(ctx context.Context, aid string) (ReconBrief, error) {
	_, at, status, errText, _, _, _, _, err := ls.latestRecon(ctx, aid)
	if err != nil {
		return ReconBrief{}, err
	}
	var open int
	if err := ls.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_recon_items WHERE account_id = ? AND resolved_at = ''`, aid).Scan(&open); err != nil {
		return ReconBrief{}, err
	}
	if status == "diff" && open == 0 {
		status = "ok"
	}
	return ReconBrief{Status: status, At: at, Open: open, Error: errText}, nil
}

func (ls *liveSync) reconView(ctx context.Context, a account) (ReconView, error) {
	id, at, status, errText, checked, _, maxPct, ok, err := ls.latestRecon(ctx, a.ID)
	if err != nil {
		return ReconView{}, err
	}
	r, err := ls.p.paper.risk(ctx)
	if err != nil {
		return ReconView{}, err
	}
	v := ReconView{AccountID: a.ID, At: at, Status: status, Error: errText, Checked: checked, ID: id, MaxPct: maxPct, Threshold: r.ReconDiffPct, Items: []ReconItemView{}}
	if !ok {
		return v, nil
	}
	// 没处理的，加上最近一次对账之后处理掉的、最近一次对账看到的
	items, err := ls.reconItems(ctx, `WHERE account_id = ? AND (resolved_at = '' OR resolved_at >= ? OR last_recon_id = ?) ORDER BY created_at, id`, a.ID, at, id)
	if err != nil {
		return v, err
	}
	for _, x := range items {
		v.Items = append(v.Items, x.view())
		if x.ResolvedAt == "" {
			v.Open++
		}
	}
	if v.Status == "diff" && v.Open == 0 {
		v.Status = "ok"
	}
	return v, nil
}

// GET /api/trade/accounts/{id}/recon：最近一次对账和差异。
func (h *handlers) getRecon(w http.ResponseWriter, r *http.Request) {
	a, ok := h.liveAccount(w, r)
	if !ok {
		return
	}
	v, err := h.p.live.reconView(r.Context(), a)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// POST /api/trade/accounts/{id}/recon：重新对账（同步一次再对）。已断开的照样记一次失败的对账。
func (h *handlers) recheckRecon(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, ok := h.liveAccount(w, r)
	if !ok {
		return
	}
	ls := h.p.live
	if a.Status == "disconnected" {
		ls.mu.Lock()
		err := ls.recordFailedRecon(ctx, a, "账户未连接")
		ls.mu.Unlock()
		if err != nil {
			h.fail(w, r, err)
			return
		}
	} else {
		_ = ls.syncAccount(ctx, a.ID)
	}
	v, err := ls.reconView(ctx, a)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// POST /api/trade/accounts/{id}/recon/items/{item}/resolve {action, note?}：处理一处差异。
// action adopt：按交易所修正本地记录（持仓改成交易所的数，挂单按交易所加上或去掉）；verify：标为已核实，本地不改，note 必填。
func (h *handlers) resolveRecon(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, ok := h.liveAccount(w, r)
	if !ok {
		return
	}
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	b := &bodyReader{raw: raw}
	b.only("action", "note")
	var action, note string
	b.str("action", &action)
	b.str("note", &note)
	if b.err != nil {
		h.fail(w, r, b.err)
		return
	}
	if action != "adopt" && action != "verify" {
		h.fail(w, r, apiErr(errValidation, "action 只能是 adopt（按交易所修正）或 verify（标为已核实）"))
		return
	}
	if utf8.RuneCountInString(note) > 200 {
		h.fail(w, r, apiErr(errValidation, "备注最多 200 字"))
		return
	}
	if action == "verify" && note == "" {
		h.fail(w, r, apiErr(errValidation, "标为已核实要写备注（note），说明为什么以本地为准"))
		return
	}
	ls := h.p.live
	ls.mu.Lock()
	defer ls.mu.Unlock()
	items, err := ls.reconItems(ctx, `WHERE account_id = ? AND id = ?`, a.ID, r.PathValue("item"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if len(items) == 0 {
		h.fail(w, r, apiErr(errNotFound, "差异 %s 不存在", r.PathValue("item")))
		return
	}
	x := items[0]
	if x.ResolvedAt != "" {
		failLive(w, http.StatusConflict, "state", "这处差异已经处理过了")
		return
	}
	if action == "adopt" {
		if err := ls.adopt(ctx, a, x); err != nil {
			h.fail(w, r, err)
			return
		}
	}
	now := stamp(ls.now())
	if _, err := h.c.Store().Exec(ctx, `UPDATE trade_recon_items SET resolved_at = ?, resolution = ?, resolve_note = ?, updated_at = ? WHERE id = ? AND resolved_at = ''`,
		now, action, note, now, x.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	h.p.paper.audit(ctx, "recon_resolve", "trade_recon_item", x.ID, "处理对账差异："+a.Name+" "+x.Label+"，"+resolutionText[action],
		map[string]any{"account_id": a.ID, "action": action, "note": note, "key": x.Key, "local": x.Local, "remote": x.Remote}, userMeta)
	v, err := ls.reconView(ctx, a)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// adopt 按交易所修正本地记录。
func (ls *liveSync) adopt(ctx context.Context, a account, x reconItem) error {
	if x.Kind == "position" {
		sym := x.Symbol
		if holdingKind(x.Key) == "spot" {
			sym = spotSymbol(a.Broker, x.Key)
		}
		return ls.setHolding(ctx, a.ID, x.Key, holdingKind(x.Key), sym, x.RemoteQ)
	}
	if x.RemoteQ == 0 {
		_, err := ls.c.Store().Exec(ctx, `DELETE FROM trade_live_orders WHERE account_id = ? AND order_id = ?`, a.ID, x.Key)
		return err
	}
	st, err := ls.state(ctx, a.ID)
	if err != nil {
		return err
	}
	for _, o := range st.Orders {
		if o.ID == x.Key {
			o.qty, _ = fxFromFloat(o.Qty)
			o.filled, _ = fxFromFloat(o.Filled)
			if o.Price != nil {
				o.price, _ = fxFromFloat(*o.Price)
			}
			return ls.putLocalOrder(ctx, a.ID, o)
		}
	}
	return apiErr(errValidation, "交易所这一刻已经没有这笔挂单了，重新对账后再处理")
}

// ReconRecord 是一次对账（TradeReconRecord），GET /api/trade/recons 列表用。
type ReconRecord struct {
	ID        string  `json:"id"`
	AccountID string  `json:"account_id"`
	At        string  `json:"at"`
	Status    string  `json:"status"`
	Error     string  `json:"error,omitempty"`
	Checked   int     `json:"checked"`
	Open      int     `json:"open"`
	MaxPct    float64 `json:"max_pct"`
}

// GET /api/trade/recons?account_id=&status=&limit=&offset=：对账记录，新的在前。
func (h *handlers) listRecons(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	limit, offset, err := pageParams(r, 100, 1000)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var conds []string
	var args []any
	if v := r.URL.Query().Get("account_id"); v != "" {
		conds, args = append(conds, "account_id = ?"), append(args, v)
	}
	if v := r.URL.Query().Get("status"); v != "" {
		if v != "ok" && v != "diff" && v != "failed" {
			h.fail(w, r, apiErr(errValidation, "status 只能是 ok、diff、failed"))
			return
		}
		conds, args = append(conds, "status = ?"), append(args, v)
	}
	where := wherePrefix(strings.Join(conds, " AND "))
	var total int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_recons`+where, args...).Scan(&total); err != nil {
		h.fail(w, r, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT id, account_id, at, status, error, checked, open, max_pct FROM trade_recons`+where+` ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`,
		append(args, limit, offset)...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []ReconRecord{}
	for rows.Next() {
		var x ReconRecord
		if err := rows.Scan(&x.ID, &x.AccountID, &x.At, &x.Status, &x.Error, &x.Checked, &x.Open, &x.MaxPct); err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, x)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total, "limit": limit, "offset": offset}})
}
