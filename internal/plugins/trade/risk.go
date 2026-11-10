// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 风控在后端强制（TRD-06a）：规则表 trade_risk、熔断记录 trade_halts（迁移 0007）。
//
// 逐笔检查接在统一的下单入口 paper.place 上（手动、平仓、部署都过），不通过的委托记成被拒绝、原因写进 reject_reason，
// 接口回 409 conflict（reason: risk）。四条检查同原型 riskBlocks，开仓才查前三条：
//   - 熔断中只能平仓减仓；
//   - 单笔金额（折 USD）不超过 max_order_value；
//   - 下单后这个标的的市值（已有持仓按现价加这一笔）占账户权益不超过 max_position_pct；
//   - 合约杠杆不超过 max_leverage（不分开平仓）。
// 二次确认：手动单（含平仓）金额超过 confirm_above 又没带 confirmed: true 时 409（reason: confirm），不记委托；部署的单在部署时已确认过，不再要。
//
// 日亏损熔断：撮合任务每轮算一次「当日盈亏」= Σ 各模拟盘账户（现在权益 − 当日 UTC 0 点后第一次看到的权益），
// 亏到这些基线合计的 daily_loss_pct 时自动一键全停；持仓的最新价不全是实时时不判定。同一个 UTC 日回到上限以内之前不再重复自动熔断。
// 一键全停：先进入熔断（之后开仓单全被拦），再停所有没停的部署、撤所有挂单；持仓不动。熔断、全停、解除、改规则、拦截都写审计。
// 实盘账户（TRD-08d）：撤模拟盘挂单之后，到每个实盘账户的交易所撤掉全部挂单（livetrade.go cancelAllLiveLocked），持仓不动；
// 撤不掉的写进 failed 和 remaining_orders（「账户名 #交易所委托号」）。
// 熔断和解除发事件 trade.halted、trade.halt_released 并发通知（kind trade.halt）。

const (
	haltedEvent   = "trade.halted"
	releasedEvent = "trade.halt_released"
	maxHaltReason = 200
)

// riskRules 是 trade_risk 那一行。
type riskRules struct {
	MaxPositionPct float64
	DailyLossPct   float64
	MaxOrderValue  float64
	MaxLeverage    float64
	ConfirmAbove   float64
	Halted         bool
	HaltedReason   string
	HaltedAt       string
	HaltID         string
	TripDay        string
	UpdatedAt      string
	// 自动熔断阈值（TRD-08b，迁移 0010）
	ReconDiffPct    float64
	SyncFailLimit   float64
	FeedDownMinutes float64
}

func fxOf(f float64) fx {
	v, _ := fxFromFloat(f)
	return v
}

func (r riskRules) confirmAbove() fx { return fxOf(r.ConfirmAbove) }

// defaultRisk 同原型 seedRisk。
var defaultRisk = riskRules{MaxPositionPct: 35, DailyLossPct: 3, MaxOrderValue: 50000, MaxLeverage: 10, ConfirmAbove: 10000}

const riskCols = `max_position_pct, daily_loss_pct, max_order_value, max_leverage, confirm_above, halted, halted_reason, halted_at, halt_id, trip_day, updated_at`

// riskReadCols 多了 0010 加的三个自动熔断阈值（新建那一行时取列默认值）。
const riskReadCols = riskCols + `, recon_diff_pct, sync_fail_limit, feed_down_minutes`

func (pp *paper) risk(ctx context.Context) (riskRules, error) {
	var r riskRules
	var halted int
	err := pp.c.Store().QueryRow(ctx, `SELECT `+riskReadCols+` FROM trade_risk WHERE id = 'global'`).
		Scan(&r.MaxPositionPct, &r.DailyLossPct, &r.MaxOrderValue, &r.MaxLeverage, &r.ConfirmAbove, &halted, &r.HaltedReason, &r.HaltedAt, &r.HaltID, &r.TripDay, &r.UpdatedAt,
			&r.ReconDiffPct, &r.SyncFailLimit, &r.FeedDownMinutes)
	if errors.Is(err, plugin.ErrNoRows) {
		d := defaultRisk
		d.UpdatedAt = stamp(pp.now())
		if _, err := pp.c.Store().Exec(ctx, `INSERT OR IGNORE INTO trade_risk (id, `+riskCols+`) VALUES ('global', ?, ?, ?, ?, ?, 0, '', '', '', '', ?)`,
			d.MaxPositionPct, d.DailyLossPct, d.MaxOrderValue, d.MaxLeverage, d.ConfirmAbove, d.UpdatedAt); err != nil {
			return r, err
		}
		return pp.risk(ctx)
	}
	r.Halted = halted == 1
	return r, err
}

// riskInput 是逐笔检查要用的数：Equity 是账户权益，Held 是这个标的已有持仓的市值，Value 是这一笔的名义价值（都折 USD）。
type riskInput struct {
	Rules    riskRules
	Equity   fx
	Held     fx
	Value    fx
	Leverage int
	Contract bool
	Opening  bool
	Name     string
}

// riskBlocks 同原型 riskBlocks：回不通过的原因，文字和原型下单抽屉里的一致。纯函数。
func riskBlocks(in riskInput) []string {
	r := in.Rules
	out := []string{}
	v := in.Value.abs()
	if r.Halted && in.Opening {
		out = append(out, "熔断中：只能平仓或减仓，禁止新开仓")
	}
	if in.Opening && v > fxOf(r.MaxOrderValue) {
		out = append(out, fmt.Sprintf("单笔金额 %s 超过上限 %s", usdText(v), usdText(fxOf(r.MaxOrderValue))))
	}
	if in.Opening {
		share := 100.0
		if in.Equity > 0 {
			share = (in.Held + v).Float() / in.Equity.Float() * 100
		}
		if share > r.MaxPositionPct {
			out = append(out, fmt.Sprintf("下单后 %s 占该账户权益 %s%%，超过单标的上限 %s%%", in.Name, toFixed(share, 1), jsString(r.MaxPositionPct)))
		}
	}
	if in.Contract && float64(in.Leverage) > r.MaxLeverage {
		out = append(out, fmt.Sprintf("杠杆 %dx 超过上限 %sx", in.Leverage, jsString(r.MaxLeverage)))
	}
	return out
}

/* ---------- 一键全停、解除 ---------- */

// KillResult 是一键全停的结果（TradeKillResult）。remaining_* 是没停掉的部署、没撤掉的挂单（正常为空），failed 是出错的原因。
type KillResult struct {
	Halted          bool     `json:"halted"`
	Reason          string   `json:"reason"`
	At              string   `json:"at"`
	HaltID          string   `json:"halt_id"`
	Kind            string   `json:"kind"`
	RunsStopped     int      `json:"runs_stopped"`
	OrdersCanceled  int      `json:"orders_canceled"`
	RemainingRuns   []string `json:"remaining_runs"`
	RemainingOrders []string `json:"remaining_orders"`
	Failed          []string `json:"failed"`
}

// Halt 是一条熔断记录（TradeHalt），同原型 HaltRec 加上种类和停掉的数量。
type Halt struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	Reason         string `json:"reason"`
	At             string `json:"at"`
	RunsStopped    int    `json:"runs_stopped"`
	OrdersCanceled int    `json:"orders_canceled"`
	ReleasedAt     string `json:"released_at,omitempty"`
	ReleaseReason  string `json:"release_reason,omitempty"`
}

// kill 一键全停：kind 是 manual 或 auto。顺序是先熔断（新开仓立刻被拦）、再停部署、再撤挂单，都在账本锁下做。
func (pp *paper) kill(ctx context.Context, reason, kind string, m plugin.WriteMeta) (KillResult, error) {
	pp.mu.Lock()
	defer pp.mu.Unlock()
	return pp.killLocked(ctx, reason, kind, m)
}

func (pp *paper) killLocked(ctx context.Context, reason, kind string, m plugin.WriteMeta) (KillResult, error) {
	if _, err := pp.risk(ctx); err != nil {
		return KillResult{}, err
	}
	now := stamp(pp.now())
	res := KillResult{Halted: true, Reason: reason, At: now, Kind: kind, HaltID: idgen.Prefixed("hl"), RemainingRuns: []string{}, RemainingOrders: []string{}, Failed: []string{}}
	// 已经在熔断中：上一条熔断记录由这一次接替
	if _, err := pp.c.Store().Exec(ctx, `UPDATE trade_halts SET released_at = ?, release_reason = '再次一键全停，由新的熔断记录接替' WHERE released_at = ''`, now); err != nil {
		return res, err
	}
	if _, err := pp.c.Store().Exec(ctx, `INSERT INTO trade_halts (id, kind, reason, at) VALUES (?, ?, ?, ?)`, res.HaltID, kind, reason, now); err != nil {
		return res, err
	}
	if _, err := pp.c.Store().Exec(ctx, `UPDATE trade_risk SET halted = 1, halted_reason = ?, halted_at = ?, halt_id = ?, updated_at = ? WHERE id = 'global'`,
		reason, now, res.HaltID, now); err != nil {
		return res, err
	}
	stopped, failed := pp.p.runs.stopAllLocked(ctx, "一键全停："+reason, m)
	res.RunsStopped = stopped
	res.Failed = append(res.Failed, failed...)
	canceled, failed, err := pp.cancelWhereLocked(ctx, "", "一键全停："+reason, m)
	if err != nil {
		res.Failed = append(res.Failed, err.Error())
	}
	res.OrdersCanceled = canceled
	res.Failed = append(res.Failed, failed...)
	liveN, liveFailed, liveLeft := pp.p.trader.cancelAllLiveLocked(ctx, "一键全停："+reason, m)
	res.OrdersCanceled += liveN
	res.Failed = append(res.Failed, liveFailed...)
	if ids, err := idsWhere(ctx, pp.c, `SELECT id FROM trade_runs WHERE status != 'stopped'`); err == nil {
		res.RemainingRuns = ids
	}
	if ids, err := idsWhere(ctx, pp.c, `SELECT id FROM trade_orders WHERE status = 'open' AND live = 0`); err == nil {
		res.RemainingOrders = ids
	}
	res.RemainingOrders = append(res.RemainingOrders, liveLeft...)
	if _, err := pp.c.Store().Exec(ctx, `UPDATE trade_halts SET runs_stopped = ?, orders_canceled = ? WHERE id = ?`, res.RunsStopped, res.OrdersCanceled, res.HaltID); err != nil {
		res.Failed = append(res.Failed, err.Error())
	}
	action, title := "kill", "一键全停"
	if kind == "auto" {
		action, title = "halt", "风控熔断"
	}
	summary := fmt.Sprintf("%s：%s；停了 %d 个部署、撤了 %d 笔挂单", title, reason, res.RunsStopped, res.OrdersCanceled)
	pp.audit(ctx, action, "trade_risk", res.HaltID, summary,
		map[string]any{"reason": reason, "kind": kind, "runs_stopped": res.RunsStopped, "orders_canceled": res.OrdersCanceled,
			"remaining_runs": res.RemainingRuns, "remaining_orders": res.RemainingOrders, "failed": res.Failed}, m)
	if err := pp.c.Events().Publish(ctx, haltedEvent, res); err != nil {
		pp.c.Log().Warn("publish halted failed", "err", err)
	}
	pp.notify(ctx, "halt", plugin.NotifyError, title+"："+reason, fmt.Sprintf("停了 %d 个部署、撤了 %d 笔挂单，进入熔断：只能平仓或减仓。解除要到「交易 / 风控」手动解除。", res.RunsStopped, res.OrdersCanceled),
		map[string]any{"halt_id": res.HaltID, "kind": kind})
	if kind == "auto" {
		pp.incident(ctx, "trade:halt", "风控熔断", reason, map[string]any{"熔断记录": res.HaltID})
	}
	return res, nil
}

func idsWhere(ctx context.Context, c plugin.Core, q string, args ...any) ([]string, error) {
	rows, err := c.Store().Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// release 解除熔断：要写原因；停掉的部署不自动恢复。
func (pp *paper) release(ctx context.Context, reason string, m plugin.WriteMeta) (riskRules, error) {
	pp.mu.Lock()
	defer pp.mu.Unlock()
	r, err := pp.risk(ctx)
	if err != nil {
		return r, err
	}
	if !r.Halted {
		return r, errNotHalted
	}
	now := stamp(pp.now())
	if _, err := pp.c.Store().Exec(ctx, `UPDATE trade_risk SET halted = 0, halted_reason = '', halted_at = '', halt_id = '', updated_at = ? WHERE id = 'global'`, now); err != nil {
		return r, err
	}
	if _, err := pp.c.Store().Exec(ctx, `UPDATE trade_halts SET released_at = ?, release_reason = ? WHERE released_at = ''`, now, reason); err != nil {
		return r, err
	}
	pp.audit(ctx, "release", "trade_risk", r.HaltID, "解除熔断："+reason, map[string]any{"reason": reason, "halted_reason": r.HaltedReason, "halted_at": r.HaltedAt}, m)
	payload := HaltReleased{HaltID: r.HaltID, Reason: reason, At: now, HaltedReason: r.HaltedReason, HaltedAt: r.HaltedAt}
	if err := pp.c.Events().Publish(ctx, releasedEvent, payload); err != nil {
		pp.c.Log().Warn("publish halt_released failed", "err", err)
	}
	pp.notify(ctx, "halt", plugin.NotifyInfo, "熔断已解除", reason+"。停掉的部署不会自动恢复，要逐个启动。", map[string]any{"halt_id": r.HaltID})
	return pp.risk(ctx)
}

var errNotHalted = errors.New("not halted")

// HaltReleased 是 trade.halt_released 事件的载荷（TradeHaltReleased）：解除的是哪条熔断、原因、时间，和那次熔断的原因、时间。
type HaltReleased struct {
	HaltID       string `json:"halt_id"`
	Reason       string `json:"reason"`
	At           string `json:"at"`
	HaltedReason string `json:"halted_reason"`
	HaltedAt     string `json:"halted_at"`
}

/* ---------- 日亏损 ---------- */

// DayLoss 是当日盈亏和熔断线（TradeRiskDay）。status：ok 算出来了；stale 有持仓的最新价不是实时，这一刻不判定（数是按缓存估的）。
type DayLoss struct {
	Date        string  `json:"date"`
	StartEquity float64 `json:"start_equity"`
	Equity      float64 `json:"equity"`
	PnL         float64 `json:"pnl"`
	LossUsed    float64 `json:"loss_used"`
	LossLimit   float64 `json:"loss_limit"`
	Status      string  `json:"status"`
}

type dayCalc struct {
	start, equity, pnl, used, limit fx
	live                            bool
}

// dayLoss 算当日盈亏；record 为真时把这一天还没有基线的账户记上（只在估值全是实时时记）。
func (pp *paper) dayLoss(ctx context.Context, r riskRules, record bool) (dayCalc, error) {
	day := utcDay(pp.now())
	accts, err := loadAccounts(ctx, pp.c)
	if err != nil {
		return dayCalc{}, err
	}
	out := dayCalc{live: true}
	for _, a := range accts {
		if !a.Paper {
			continue
		}
		v, err := pp.value(ctx, a)
		if err != nil {
			return out, err
		}
		if !v.allLive {
			out.live = false
		}
		var base fx
		err = pp.c.Store().QueryRow(ctx, `SELECT equity_e8 FROM trade_day_marks WHERE day = ? AND account_id = ?`, day, a.ID).Scan(&base)
		if errors.Is(err, plugin.ErrNoRows) {
			base = v.Equity
			if record && v.allLive {
				if _, err := pp.c.Store().Exec(ctx, `INSERT OR IGNORE INTO trade_day_marks (day, account_id, equity_e8, at) VALUES (?, ?, ?, ?)`,
					day, a.ID, v.Equity, stamp(pp.now())); err != nil {
					return out, err
				}
			}
		} else if err != nil {
			return out, err
		}
		out.start += base
		out.equity += v.Equity
	}
	out.pnl = out.equity - out.start
	out.used = max(0, -out.pnl)
	lim, err := fxMul(out.start, fxOf(r.DailyLossPct/100))
	if err != nil {
		return out, err
	}
	out.limit = lim
	return out, nil
}

// checkDailyLoss 是撮合任务每轮调的日亏损检查。
func (pp *paper) checkDailyLoss(ctx context.Context) error {
	r, err := pp.risk(ctx)
	if err != nil {
		return err
	}
	d, err := pp.dayLoss(ctx, r, true)
	if err != nil {
		return err
	}
	if !d.live || d.start <= 0 {
		return nil
	}
	day := utcDay(pp.now())
	if d.used < d.limit || d.limit <= 0 {
		if r.TripDay != "" {
			_, err := pp.c.Store().Exec(ctx, `UPDATE trade_risk SET trip_day = '' WHERE id = 'global'`)
			return err
		}
		return nil
	}
	if r.Halted || r.TripDay == day {
		return nil
	}
	if _, err := pp.c.Store().Exec(ctx, `UPDATE trade_risk SET trip_day = ? WHERE id = 'global'`, day); err != nil {
		return err
	}
	reason := fmt.Sprintf("单日亏损 %s，达到上限 %s%%，自动熔断", usdText(d.used), jsString(r.DailyLossPct))
	_, err = pp.kill(ctx, reason, "auto", riskMeta)
	return err
}

/* ---------- 接口 ---------- */

// RiskView 是 GET /api/trade/risk 的形状（TradeRisk），前半同原型 RiskRules。
type RiskView struct {
	MaxPositionPct float64 `json:"max_position_pct"`
	DailyLossPct   float64 `json:"daily_loss_pct"`
	MaxOrderValue  float64 `json:"max_order_value"`
	MaxLeverage    float64 `json:"max_leverage"`
	ConfirmAbove   float64 `json:"confirm_above"`
	Halted         bool    `json:"halted"`
	HaltedReason   string  `json:"halted_reason,omitempty"`
	HaltedAt       string  `json:"halted_at,omitempty"`
	HaltID         string  `json:"halt_id,omitempty"`
	UpdatedAt      string  `json:"updated_at"`
	Day            DayLoss `json:"day"`
	// 自动熔断阈值（TRD-08b）
	ReconDiffPct    float64 `json:"recon_diff_pct"`
	SyncFailLimit   float64 `json:"sync_fail_limit"`
	FeedDownMinutes float64 `json:"feed_down_minutes"`
}

func (h *handlers) riskView(ctx context.Context) (RiskView, error) {
	pp := h.p.paper
	r, err := pp.risk(ctx)
	if err != nil {
		return RiskView{}, err
	}
	d, err := pp.dayLoss(ctx, r, false)
	if err != nil {
		return RiskView{}, err
	}
	st := "ok"
	if !d.live {
		st = "stale"
	}
	return RiskView{MaxPositionPct: r.MaxPositionPct, DailyLossPct: r.DailyLossPct, MaxOrderValue: r.MaxOrderValue, MaxLeverage: r.MaxLeverage,
		ConfirmAbove: r.ConfirmAbove, Halted: r.Halted, HaltedReason: r.HaltedReason, HaltedAt: r.HaltedAt, HaltID: r.HaltID, UpdatedAt: r.UpdatedAt,
		ReconDiffPct: r.ReconDiffPct, SyncFailLimit: r.SyncFailLimit, FeedDownMinutes: r.FeedDownMinutes,
		Day: DayLoss{Date: utcDay(pp.now()), StartEquity: d.start.Float(), Equity: d.equity.Float(), PnL: d.pnl.Float(), LossUsed: d.used.Float(),
			LossLimit: d.limit.Float(), Status: st}}, nil
}

func (h *handlers) getRisk(w http.ResponseWriter, r *http.Request) {
	v, err := h.riskView(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

var riskFields = map[string]string{"max_position_pct": "单标的最大仓位", "daily_loss_pct": "单日最大亏损", "max_order_value": "单笔最大金额",
	"max_leverage": "合约最大杠杆", "confirm_above": "二次确认阈值",
	"recon_diff_pct": "对账差异熔断阈值", "sync_fail_limit": "交易所接口连续失败熔断次数", "feed_down_minutes": "行情断开熔断分钟数"}

// PATCH /api/trade/risk：五条规则加三个自动熔断阈值，只改出现的，都要大于 0；放宽规则不会自动解除熔断。
func (h *handlers) updateRisk(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	pp := h.p.paper
	pp.mu.Lock()
	defer pp.mu.Unlock()
	cur, err := pp.risk(ctx)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	next := cur
	ptr := map[string]*float64{"max_position_pct": &next.MaxPositionPct, "daily_loss_pct": &next.DailyLossPct, "max_order_value": &next.MaxOrderValue,
		"max_leverage": &next.MaxLeverage, "confirm_above": &next.ConfirmAbove,
		"recon_diff_pct": &next.ReconDiffPct, "sync_fail_limit": &next.SyncFailLimit, "feed_down_minutes": &next.FeedDownMinutes}
	keys := []string{}
	for k, v := range raw {
		p, ok := ptr[k]
		if !ok {
			h.fail(w, r, apiErr(errValidation, "不认识的字段 %s；能改的是 max_position_pct、daily_loss_pct、max_order_value、max_leverage、confirm_above、recon_diff_pct、sync_fail_limit、feed_down_minutes", k))
			return
		}
		var f float64
		if json.Unmarshal(v, &f) != nil || !finite(f) || f <= 0 || f > 1e10 {
			h.fail(w, r, apiErr(errValidation, "%s 要是大于 0 的数", riskFields[k]))
			return
		}
		if k == "sync_fail_limit" && (f != float64(int(f)) || f > 100) {
			h.fail(w, r, apiErr(errValidation, "%s 要是 1 到 100 的整数", riskFields[k]))
			return
		}
		if k == "feed_down_minutes" && f > 1440 {
			h.fail(w, r, apiErr(errValidation, "%s 不能超过 1440", riskFields[k]))
			return
		}
		if (k == "max_position_pct" || k == "daily_loss_pct" || k == "recon_diff_pct") && f > 100 {
			h.fail(w, r, apiErr(errValidation, "%s 是百分比，不能超过 100", riskFields[k]))
			return
		}
		*p = f
		keys = append(keys, k)
	}
	slices.Sort(keys)
	now := stamp(pp.now())
	if _, err := h.c.Store().Exec(ctx, `UPDATE trade_risk SET max_position_pct = ?, daily_loss_pct = ?, max_order_value = ?, max_leverage = ?, confirm_above = ?,
		recon_diff_pct = ?, sync_fail_limit = ?, feed_down_minutes = ?, updated_at = ? WHERE id = 'global'`,
		next.MaxPositionPct, next.DailyLossPct, next.MaxOrderValue, next.MaxLeverage, next.ConfirmAbove, next.ReconDiffPct, next.SyncFailLimit, next.FeedDownMinutes, now); err != nil {
		h.fail(w, r, err)
		return
	}
	var parts []string
	from, to := map[string]float64{}, map[string]float64{}
	for _, k := range keys {
		a, b := *map[string]*float64{"max_position_pct": &cur.MaxPositionPct, "daily_loss_pct": &cur.DailyLossPct, "max_order_value": &cur.MaxOrderValue,
			"max_leverage": &cur.MaxLeverage, "confirm_above": &cur.ConfirmAbove,
			"recon_diff_pct": &cur.ReconDiffPct, "sync_fail_limit": &cur.SyncFailLimit, "feed_down_minutes": &cur.FeedDownMinutes}[k], *ptr[k]
		if a != b {
			parts = append(parts, riskFields[k]+" "+jsString(a)+" → "+jsString(b))
			from[k], to[k] = a, b
		}
	}
	if len(parts) > 0 {
		pp.audit(ctx, "update", "trade_risk", "global", "改风控规则："+strings.Join(parts, "，"), map[string]any{"from": from, "to": to}, userMeta)
	}
	v, err := h.riskView(ctx)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

func haltReason(raw map[string]json.RawMessage, def string) (string, error) {
	v, ok := raw["reason"]
	if !ok {
		return def, nil
	}
	var s string
	if json.Unmarshal(v, &s) != nil {
		return "", apiErr(errValidation, "reason 要是字符串")
	}
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > maxHaltReason {
		return "", apiErr(errValidation, "原因最多 %d 字", maxHaltReason)
	}
	if s == "" {
		return def, nil
	}
	return s, nil
}

// readOptionalBody 是可以不带 body 的 POST：空 body 当成 {}。
func readOptionalBody(r *http.Request) (map[string]json.RawMessage, error) {
	if r.ContentLength == 0 {
		return map[string]json.RawMessage{}, nil
	}
	return readBody(r)
}

// POST /api/trade/risk/kill {reason?}：一键全停，默认原因「手动一键全停」。
func (h *handlers) killAll(w http.ResponseWriter, r *http.Request) {
	raw, err := readOptionalBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	for k := range raw {
		if k != "reason" {
			h.fail(w, r, apiErr(errValidation, "不认识的字段 %s", k))
			return
		}
	}
	reason, err := haltReason(raw, "手动一键全停")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	res, err := h.p.paper.kill(r.Context(), reason, "manual", userMeta)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	status := http.StatusOK
	if len(res.Failed) > 0 || len(res.RemainingRuns) > 0 || len(res.RemainingOrders) > 0 {
		status = http.StatusInternalServerError
		writeJSON(w, status, map[string]any{"error": map[string]any{"code": "internal", "message": "全停没有完成：" + strings.Join(res.Failed, "；"), "result": res}})
		return
	}
	writeJSON(w, status, map[string]any{"data": res})
}

// POST /api/trade/risk/release {reason}：解除熔断，原因必填。
func (h *handlers) releaseHalt(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	for k := range raw {
		if k != "reason" {
			h.fail(w, r, apiErr(errValidation, "不认识的字段 %s", k))
			return
		}
	}
	reason, err := haltReason(raw, "")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if reason == "" {
		h.fail(w, r, apiErr(errValidation, "解除熔断要写原因（reason）"))
		return
	}
	if _, err := h.p.paper.release(r.Context(), reason, userMeta); err != nil {
		if errors.Is(err, errNotHalted) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "conflict", "reason": "not_halted", "message": "现在没有熔断"}})
			return
		}
		h.fail(w, r, err)
		return
	}
	v, err := h.riskView(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// GET /api/trade/risk/halts：熔断记录，新的在前。
func (h *handlers) listHalts(w http.ResponseWriter, r *http.Request) {
	rows, err := h.c.Store().Query(r.Context(), `SELECT id, kind, reason, at, runs_stopped, orders_canceled, released_at, release_reason FROM trade_halts ORDER BY at DESC, id DESC LIMIT 200`)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Halt{}
	for rows.Next() {
		var x Halt
		if err := rows.Scan(&x.ID, &x.Kind, &x.Reason, &x.At, &x.RunsStopped, &x.OrdersCanceled, &x.ReleasedAt, &x.ReleaseReason); err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, x)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}
