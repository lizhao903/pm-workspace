package trade

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 模拟盘账户（TRD-05a）：表 trade_accounts（迁移 0005）。本批次只建模拟盘：没有实盘账户的创建路径，
// paper 建好后不能改（PATCH 带 paper 回 400，库里也没有改它的语句）。权益、可用、保证金不落表，读的时候现算。

const (
	maxAccountName = 40
	defaultCapital = 100000
)

// paperCurrencies 是模拟盘能用的币种；现在只有数币行情，USD、USDT 按 1:1 折算。
var paperCurrencies = []string{"USD", "USDT"}

// account 是 trade_accounts 的一行。
type account struct {
	ID            string
	Name          string
	Broker        string
	Kind          string
	Markets       []string
	Paper         bool
	Currency      string
	Initial       fx
	FeeRate       fx // 手续费率，0.0005 存 50000
	SlippageTicks int
	Permissions   []string
	APIHint       string
	CreatedAt     string
	UpdatedAt     string
}

const accountCols = `id, name, broker, kind, markets, paper, currency, initial_e8, fee_rate_e8, slippage_ticks, permissions, api_hint, created_at, updated_at`

func scanAccount(row plugin.Row) (account, error) {
	var a account
	var markets, perms string
	var paper int
	err := row.Scan(&a.ID, &a.Name, &a.Broker, &a.Kind, &markets, &paper, &a.Currency, &a.Initial, &a.FeeRate, &a.SlippageTicks, &perms, &a.APIHint, &a.CreatedAt, &a.UpdatedAt)
	a.Paper = paper == 1
	if json.Unmarshal([]byte(markets), &a.Markets) != nil || a.Markets == nil {
		a.Markets = []string{}
	}
	if json.Unmarshal([]byte(perms), &a.Permissions) != nil || a.Permissions == nil {
		a.Permissions = []string{}
	}
	return a, err
}

// loadAccount 读一个账户；没有回 errNotFound。
func loadAccount(ctx context.Context, c plugin.Core, id string) (account, error) {
	a, err := scanAccount(c.Store().QueryRow(ctx, `SELECT `+accountCols+` FROM trade_accounts WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return a, apiErr(errNotFound, "账户 %s 不存在", id)
	}
	return a, err
}

// paperAccount 是下单、部署用的账户检查：不存在、不是模拟盘都回 400（不是 404：账户 id 是请求体里的引用）。
func paperAccount(ctx context.Context, c plugin.Core, id string) (account, error) {
	if strings.TrimSpace(id) == "" {
		return account{}, apiErr(errValidation, "选一个账户（account_id）")
	}
	a, err := loadAccount(ctx, c, id)
	if errors.Is(err, errNotFound) {
		return a, apiErr(errValidation, "账户 %s 不存在", id)
	}
	if err != nil {
		return a, err
	}
	if !a.Paper {
		return a, apiErr(errValidation, "账户「%s」是实盘账户，现在只能对模拟盘账户下单和部署", a.Name)
	}
	return a, nil
}

func loadAccounts(ctx context.Context, c plugin.Core) ([]account, error) {
	rows, err := c.Store().Query(ctx, `SELECT `+accountCols+` FROM trade_accounts ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []account{}
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

/* ---------- 估值 ---------- */

// AccountView 是接口里的账户（TradeAccount），前半段同原型 TradeAccount，后面是模拟盘账本的明细。
type AccountView struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Broker        string   `json:"broker"`
	Kind          string   `json:"kind"`
	Markets       []string `json:"markets"`
	Paper         bool     `json:"paper"`
	Currency      string   `json:"currency"`
	Equity        float64  `json:"equity"`
	Available     float64  `json:"available"`
	MarginUsed    float64  `json:"margin_used"`
	Status        string   `json:"status"`
	Error         string   `json:"error,omitempty"`
	APIHint       string   `json:"api_hint"`
	Permissions   []string `json:"permissions"`
	UpdatedAt     string   `json:"updated_at"`
	Initial       float64  `json:"initial"`
	Balance       float64  `json:"balance"`
	RealizedPnL   float64  `json:"realized_pnl"`
	UnrealizedPnL float64  `json:"unrealized_pnl"`
	Fees          float64  `json:"fees"`
	OrderHold     float64  `json:"order_hold"`
	FeeBp         float64  `json:"fee_bp"`
	SlippageTicks int      `json:"slippage_ticks"`
	MarksStatus   string   `json:"marks_status"`
	CreatedAt     string   `json:"created_at"`
}

// valuation 是一个账户此刻的估值（定点），下单检查和接口都用。
type valuation struct {
	Acct        account
	Realized    fx
	Fees        fx
	Unrealized  fx
	Equity      fx
	MarginUsed  fx
	OrderHold   fx
	Available   fx
	MarksStatus string // live：全部持仓的现价都是实时的；stale：有的不是实时（按缓存或均价估）
	Positions   []positionMark
	allLive     bool
}

// positionMark 是一个持仓加上现价。
type positionMark struct {
	heldPosition
	Inst       ledgerInst
	InstOK     bool
	Mark       fx
	MarkStatus string
	MarkAt     string
	Value      fx // 现价 × |数量| × 乘数
	PnL        fx // 未实现
}

// markOf 取一个标的的估值价：行情缓存有数就用（实时的标 live），没有回 0。
func (pp *paper) markOf(ctx context.Context, sym string) (fx, string, string) {
	q := pp.p.mkt.quote(ctx, sym)
	if q.Last <= 0 {
		return 0, q.Status, q.At
	}
	v, ok := fxFromFloat(q.Last)
	if !ok {
		return 0, "error", q.At
	}
	return v, q.Status, q.At
}

// value 现算一个账户的估值。
func (pp *paper) value(ctx context.Context, a account) (valuation, error) {
	v := valuation{Acct: a, MarksStatus: "live", allLive: true}
	var err error
	if v.Realized, v.Fees, _, err = fillTotals(ctx, pp.c, a.ID); err != nil {
		return v, err
	}
	held, err := loadPositions(ctx, pp.c, a.ID)
	if err != nil {
		return v, err
	}
	for _, h := range held {
		pm := positionMark{heldPosition: h}
		pm.Inst, pm.InstOK = loadLedgerInst(ctx, pp.c, h.Symbol)
		mult := fx(fxScale)
		if pm.InstOK {
			mult = pm.Inst.Mult
		}
		pm.Mark, pm.MarkStatus, pm.MarkAt = pp.markOf(ctx, h.Symbol)
		if pm.MarkStatus != "live" {
			v.allLive = false
			v.MarksStatus = "stale"
		}
		px := pm.Mark
		if px == 0 {
			px = h.avgPrice(mult)
		}
		mv, err := fxMul3(h.Qty, px, mult)
		if err != nil {
			return v, err
		}
		pm.Value = mv.abs()
		pm.PnL = mv - h.Cost
		v.Unrealized += pm.PnL
		v.MarginUsed += h.margin(pm.Inst)
		v.Positions = append(v.Positions, pm)
	}
	v.Equity = a.Initial + v.Realized + v.Unrealized - v.Fees
	hold, err := pp.orderHold(ctx, a.ID)
	if err != nil {
		return v, err
	}
	v.OrderHold = hold
	v.Available = v.Equity - v.MarginUsed - v.OrderHold
	return v, nil
}

func (v valuation) view(now string) AccountView {
	a := v.Acct
	status := "connected"
	return AccountView{
		ID: a.ID, Name: a.Name, Broker: a.Broker, Kind: a.Kind, Markets: a.Markets, Paper: a.Paper, Currency: a.Currency,
		Equity: v.Equity.Float(), Available: v.Available.Float(), MarginUsed: v.MarginUsed.Float(), Status: status,
		APIHint: a.APIHint, Permissions: a.Permissions, UpdatedAt: now,
		Initial: a.Initial.Float(), Balance: (a.Initial + v.Realized - v.Fees).Float(), RealizedPnL: v.Realized.Float(),
		UnrealizedPnL: v.Unrealized.Float(), Fees: v.Fees.Float(), OrderHold: v.OrderHold.Float(),
		FeeBp: (a.FeeRate * 10000).Float(), SlippageTicks: a.SlippageTicks, MarksStatus: v.MarksStatus, CreatedAt: a.CreatedAt,
	}
}

/* ---------- 接口 ---------- */

var accountFields = []string{"name", "currency", "initial", "markets", "fee_bp", "slippage_ticks", "paper"}

// applyAccount 把请求体里的字段写进账户；create 为真时是新建。
func applyAccount(a *account, raw map[string]json.RawMessage, create bool) error {
	for k := range raw {
		if !slices.Contains(accountFields, k) {
			return apiErr(errValidation, "不认识的字段 %s", k)
		}
	}
	if v, ok := raw["paper"]; ok {
		if !create {
			return apiErr(errValidation, "paper 建好后不能改")
		}
		var b bool
		if json.Unmarshal(v, &b) != nil || !b {
			return apiErr(errValidation, "现在只能建模拟盘账户（paper 只能是 true）")
		}
	}
	if v, ok := raw["name"]; ok {
		var s string
		if json.Unmarshal(v, &s) != nil {
			return apiErr(errValidation, "name 要是字符串")
		}
		s = strings.TrimSpace(s)
		if s == "" || utf8.RuneCountInString(s) > maxAccountName {
			return apiErr(errValidation, "名称不能为空，最多 %d 字", maxAccountName)
		}
		a.Name = s
	}
	if v, ok := raw["currency"]; ok {
		if !create {
			return apiErr(errValidation, "币种建好后不能改")
		}
		var s string
		if json.Unmarshal(v, &s) != nil || !slices.Contains(paperCurrencies, s) {
			return apiErr(errValidation, "币种只能是 USD 或 USDT")
		}
		a.Currency = s
	}
	if v, ok := raw["initial"]; ok {
		if !create {
			return apiErr(errValidation, "初始资金建好后不能改")
		}
		var f float64
		if json.Unmarshal(v, &f) != nil {
			return apiErr(errValidation, "initial 要是数字")
		}
		x, ok := fxFromFloat(f)
		if !ok || x <= 0 || x > fxInt(1e9) {
			return apiErr(errValidation, "初始资金要大于 0、不超过 10 亿")
		}
		a.Initial = x
	}
	if v, ok := raw["markets"]; ok {
		var ms []string
		if json.Unmarshal(v, &ms) != nil {
			return apiErr(errValidation, "markets 要是字符串数组")
		}
		ms = uniqTrim(ms)
		if len(ms) == 0 {
			return apiErr(errValidation, "至少选一个市场")
		}
		for _, m := range ms {
			if !slices.Contains(Markets, m) {
				return apiErr(errValidation, "市场 %s 不认识，只能是 crypto、cn、hk、us", m)
			}
		}
		a.Markets = ms
	}
	if v, ok := raw["fee_bp"]; ok {
		var f float64
		if json.Unmarshal(v, &f) != nil {
			return apiErr(errValidation, "fee_bp 要是数字")
		}
		x, ok := fxFromFloat(f)
		if !ok || x < 0 || x > fxInt(100) {
			return apiErr(errValidation, "手续费（万分之）要在 0 到 100")
		}
		a.FeeRate = x / 10000
	}
	if v, ok := raw["slippage_ticks"]; ok {
		var n float64
		if json.Unmarshal(v, &n) != nil || n != float64(int(n)) || n < 0 || n > 1000 {
			return apiErr(errValidation, "滑点（跳）要是 0 到 1000 的整数")
		}
		a.SlippageTicks = int(n)
	}
	return nil
}

func (h *handlers) accountView(ctx context.Context, a account) (AccountView, error) {
	v, err := h.p.paper.value(ctx, a)
	if err != nil {
		return AccountView{}, err
	}
	return v.view(stamp(h.p.paper.now())), nil
}

// GET /api/trade/accounts
func (h *handlers) listAccounts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	accts, err := loadAccounts(ctx, h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := []AccountView{}
	for _, a := range accts {
		v, err := h.accountView(ctx, a)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// POST /api/trade/accounts：只建模拟盘。
func (h *handlers) addAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	now := stamp(h.p.paper.now())
	a := account{ID: idgen.Prefixed("ac"), Name: "模拟盘", Broker: "模拟", Kind: "exchange", Markets: []string{"crypto"}, Paper: true,
		Currency: "USD", Initial: fxInt(defaultCapital), FeeRate: 50000, SlippageTicks: 1, Permissions: []string{"read", "trade"},
		APIHint: "本地模拟撮合", CreatedAt: now, UpdatedAt: now}
	if err := applyAccount(&a, raw, true); err != nil {
		h.fail(w, r, err)
		return
	}
	ms, _ := json.Marshal(a.Markets)
	ps, _ := json.Marshal(a.Permissions)
	// paper 写死 1：本批次没有实盘账户的创建路径
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO trade_accounts (`+accountCols+`) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.Name, a.Broker, a.Kind, string(ms), a.Currency, a.Initial, a.FeeRate, a.SlippageTicks, string(ps), a.APIHint, a.CreatedAt, a.UpdatedAt); err != nil {
		h.fail(w, r, err)
		return
	}
	// 当天的日亏损基线记初始资金，免得新账户的资金算成当日盈利
	_, _ = h.c.Store().Exec(ctx, `INSERT OR IGNORE INTO trade_day_marks (day, account_id, equity_e8, at) VALUES (?, ?, ?, ?)`,
		utcDay(h.p.paper.now()), a.ID, a.Initial, now)
	h.p.paper.audit(ctx, "create", "trade_account", a.ID, "新建模拟盘账户「"+a.Name+"」，初始资金 "+a.Initial.String()+" "+a.Currency,
		map[string]any{"initial": a.Initial.String(), "currency": a.Currency, "markets": a.Markets, "fee_bp": (a.FeeRate * 10000).String(), "slippage_ticks": a.SlippageTicks}, userMeta)
	v, err := h.accountView(ctx, a)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": v})
}

func (h *handlers) getAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, err := loadAccount(ctx, h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	v, err := h.accountView(ctx, a)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// PATCH /api/trade/accounts/{id}：只能改名称、市场、手续费、滑点；paper、币种、初始资金建好后不能改。
func (h *handlers) updateAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	pp := h.p.paper
	pp.mu.Lock()
	defer pp.mu.Unlock()
	a, err := loadAccount(ctx, h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	before := a
	if err := applyAccount(&a, raw, false); err != nil {
		h.fail(w, r, err)
		return
	}
	a.UpdatedAt = stamp(pp.now())
	ms, _ := json.Marshal(a.Markets)
	if _, err := h.c.Store().Exec(ctx, `UPDATE trade_accounts SET name = ?, markets = ?, fee_rate_e8 = ?, slippage_ticks = ?, updated_at = ? WHERE id = ?`,
		a.Name, string(ms), a.FeeRate, a.SlippageTicks, a.UpdatedAt, a.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	pp.audit(ctx, "update", "trade_account", a.ID, "修改模拟盘账户「"+a.Name+"」",
		map[string]any{"from": map[string]any{"name": before.Name, "markets": before.Markets, "fee_bp": (before.FeeRate * 10000).String(), "slippage_ticks": before.SlippageTicks},
			"to": map[string]any{"name": a.Name, "markets": a.Markets, "fee_bp": (a.FeeRate * 10000).String(), "slippage_ticks": a.SlippageTicks}}, userMeta)
	v, err := h.accountView(ctx, a)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// DELETE /api/trade/accounts/{id}：有持仓、挂单或没停的部署时 409；委托、成交、部署记录保留。
func (h *handlers) removeAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pp := h.p.paper
	pp.mu.Lock()
	defer pp.mu.Unlock()
	a, err := loadAccount(ctx, h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var why []string
	if ps, err := loadPositions(ctx, h.c, a.ID); err != nil {
		h.fail(w, r, err)
		return
	} else if len(ps) > 0 {
		why = append(why, itoa(len(ps))+" 个持仓")
	}
	var nOrders, nRuns int
	_ = h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_orders WHERE account_id = ? AND status = 'open'`, a.ID).Scan(&nOrders)
	_ = h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_runs WHERE account_id = ? AND status != 'stopped'`, a.ID).Scan(&nRuns)
	if nOrders > 0 {
		why = append(why, itoa(nOrders)+" 笔挂单")
	}
	if nRuns > 0 {
		why = append(why, itoa(nRuns)+" 个没停的部署")
	}
	if len(why) > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "conflict", "reason": "in_use",
			"message": "账户还有 " + strings.Join(why, "、") + "，先平仓、撤单、停掉部署再删"}})
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM trade_accounts WHERE id = ?`, a.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	pp.audit(ctx, "delete", "trade_account", a.ID, "删除模拟盘账户「"+a.Name+"」", map[string]any{"name": a.Name}, userMeta)
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// GET /api/trade/accounts/{id}/reconcile：账本对账，见 LedgerCheck。
func (h *handlers) reconcileAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, err := loadAccount(ctx, h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.p.paper.reconcile(ctx, a)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}
