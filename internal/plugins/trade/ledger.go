// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 模拟盘账本（TRD-05a）：成交流水 trade_fills 为准，持仓是每个标的最新一条成交带的 pos_* 字段（迁移 0005 的说明）。
//
// 口径：
//   - 持仓记带符号的数量和成本（成本 = 带符号的名义价值累计，多为正、空为负）。成交时：
//     同向加仓：数量、成本直接相加；
//     反向减仓：按减掉的比例结转成本，已实现 = −本笔名义 − 结转成本；
//     反手：先按「平掉原持仓的那部分」拆出名义，平仓部分同上，剩下的按成交价开新仓（新编号、开仓时间更新）。
//   - 已实现不含手续费，手续费单独累计。于是：权益 = 初始 + Σ已实现 + Σ(现价 × 数量 × 乘数 − 成本) − Σ手续费。
//   - 保证金：合约 |成本| / 杠杆，现货 |成本|（现货买入占用全额）。可用 = 权益 − 保证金 − 挂单占用。
//   - 强平价同原型 applyFills：多单均价 ×（1 − 1/杠杆 + 0.5%），空单均价 ×（1 + 1/杠杆 − 0.5%）。

// posState 是一个账户一个标的的持仓，Qty 为 0 表示没有持仓。
type posState struct {
	ID       string
	Qty      fx // 带符号：多为正、空为负
	Cost     fx // 带符号的成本（名义价值累计）
	Lev      int
	RunID    string
	OpenedAt string
}

// applyFill 把一笔成交应用到持仓：d 是带符号的成交数量（买正卖负），n 是带符号的名义价值（同号），
// 回新的持仓和这笔的已实现盈亏（不含手续费）。纯函数，账本和部署盈亏的重放都用它。
func applyFill(p posState, d, n fx, lev int, runID, at string, newID func() string) (posState, fx, error) {
	if d == 0 {
		return p, 0, errors.New("成交数量为 0")
	}
	if p.Qty == 0 {
		return posState{ID: newID(), Qty: d, Cost: n, Lev: lev, RunID: runID, OpenedAt: at}, 0, nil
	}
	if p.Qty.sign() == d.sign() {
		out := p
		out.Qty += d
		out.Cost += n
		out.Lev = lev
		if runID != "" {
			out.RunID = runID
		}
		return out, 0, nil
	}
	if d.abs() <= p.Qty.abs() {
		share, err := fxMulDiv(p.Cost, d.abs(), p.Qty.abs())
		if err != nil {
			return p, 0, err
		}
		realized := -n - share
		out := p
		out.Qty += d
		out.Cost -= share
		if out.Qty == 0 {
			return posState{}, realized, nil
		}
		return out, realized, nil
	}
	// 反手：名义按数量拆成平仓、开仓两段
	nClose, err := fxMulDiv(n, p.Qty.abs(), d.abs())
	if err != nil {
		return p, 0, err
	}
	realized := -nClose - p.Cost
	return posState{ID: newID(), Qty: p.Qty + d, Cost: n - nClose, Lev: lev, RunID: runID, OpenedAt: at}, realized, nil
}

// avgPrice 是持仓均价 |成本| / (|数量| × 乘数)。
func (p posState) avgPrice(mult fx) fx {
	if p.Qty == 0 || mult == 0 {
		return 0
	}
	den, err := fxMul(p.Qty.abs(), mult)
	if err != nil || den == 0 {
		return 0
	}
	v, err := fxDiv(p.Cost.abs(), den)
	if err != nil {
		return 0
	}
	return v
}

// liqPrice 是合约的强平价，现货、没有持仓回 0。
func (p posState) liqPrice(in ledgerInst) fx {
	if p.Qty == 0 || !in.contract() || p.Lev <= 0 {
		return 0
	}
	avg := p.avgPrice(in.Mult)
	inv, err := fxDiv(fxInt(1), fxInt(int64(p.Lev)))
	if err != nil {
		return 0
	}
	const mm = fx(fxScale / 200) // 0.5%
	factor := fxInt(1) - inv + mm
	if p.Qty < 0 {
		factor = fxInt(1) + inv - mm
	}
	v, err := fxMul(avg, factor)
	if err != nil {
		return 0
	}
	return max(v, 0)
}

// margin 是这个持仓占的保证金：合约 |成本| / 杠杆，现货 |成本|。
func (p posState) margin(in ledgerInst) fx {
	if !in.contract() || p.Lev <= 1 {
		return p.Cost.abs()
	}
	v, _ := fxDiv(p.Cost.abs(), fxInt(int64(p.Lev)))
	return v
}

// ledgerInst 是记账要用的标的信息，从 trade_instruments 读。
type ledgerInst struct {
	Symbol string
	Name   string
	Market string
	Kind   string
	Digits int
	Lot    fx
	Mult   fx
}

func (in ledgerInst) contract() bool { return in.Kind == "perp" || in.Kind == "future" }

// tick 是一跳。
func (in ledgerInst) tick() fx { return pow10fx(in.Digits) }

func loadLedgerInst(ctx context.Context, c plugin.Core, sym string) (ledgerInst, bool) {
	in, err := scanInstrument(c.Store().QueryRow(ctx, `SELECT `+instCols+` FROM trade_instruments WHERE symbol = ?`, sym))
	if err != nil {
		return ledgerInst{}, false
	}
	lot, ok1 := fxFromFloat(in.Lot)
	mult, ok2 := fxFromFloat(in.Multiplier)
	if !ok1 || !ok2 || lot <= 0 || mult <= 0 {
		return ledgerInst{}, false
	}
	return ledgerInst{Symbol: in.Symbol, Name: in.Name, Market: in.Market, Kind: in.Kind, Digits: in.Digits, Lot: lot, Mult: mult}, true
}

/* ---------- 成交流水 ---------- */

// Fill 是一笔成交（TradeFill）。
type Fill struct {
	Seq       int64
	ID        string
	OrderID   string
	AccountID string
	Symbol    string
	Side      string
	Qty       fx
	Price     fx
	Mult      fx
	Notional  fx // 带符号：买正卖负
	Fee       fx
	Realized  fx
	Kind      string
	RunID     string
	Pos       posState
	At        string
}

const fillCols = `seq, id, order_id, account_id, symbol, side, qty_e8, price_e8, mult_e8, notional_e8, fee_e8, realized_e8, kind, run_id,
	pos_id, pos_qty_e8, pos_cost_e8, pos_leverage, pos_run_id, pos_opened_at, at`

func scanFill(row plugin.Row) (Fill, error) {
	var f Fill
	err := row.Scan(&f.Seq, &f.ID, &f.OrderID, &f.AccountID, &f.Symbol, &f.Side, &f.Qty, &f.Price, &f.Mult, &f.Notional, &f.Fee, &f.Realized,
		&f.Kind, &f.RunID, &f.Pos.ID, &f.Pos.Qty, &f.Pos.Cost, &f.Pos.Lev, &f.Pos.RunID, &f.Pos.OpenedAt, &f.At)
	return f, err
}

func insertFill(ctx context.Context, c plugin.Core, f Fill) error {
	_, err := c.Store().Exec(ctx, `INSERT INTO trade_fills (id, order_id, account_id, symbol, side, qty_e8, price_e8, mult_e8, notional_e8, fee_e8,
		realized_e8, kind, run_id, pos_id, pos_qty_e8, pos_cost_e8, pos_leverage, pos_run_id, pos_opened_at, at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID, f.OrderID, f.AccountID, f.Symbol, f.Side, f.Qty, f.Price, f.Mult, f.Notional, f.Fee, f.Realized, f.Kind, f.RunID,
		f.Pos.ID, f.Pos.Qty, f.Pos.Cost, f.Pos.Lev, f.Pos.RunID, f.Pos.OpenedAt, f.At)
	return err
}

func queryFills(ctx context.Context, c plugin.Core, where string, args ...any) ([]Fill, error) {
	rows, err := c.Store().Query(ctx, `SELECT `+fillCols+` FROM trade_fills `+where, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Fill{}
	for rows.Next() {
		f, err := scanFill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// heldPosition 是持仓表里的一行：账户、标的加持仓状态。
type heldPosition struct {
	AccountID string
	Symbol    string
	posState
}

// loadPositions 读持仓：每个 (账户, 标的) 最新一条成交的 pos_*，数量为 0 的不要。accountID 为空读全部账户。
func loadPositions(ctx context.Context, c plugin.Core, accountID string) ([]heldPosition, error) {
	q := `SELECT account_id, symbol, pos_id, pos_qty_e8, pos_cost_e8, pos_leverage, pos_run_id, pos_opened_at FROM trade_fills
		WHERE seq IN (SELECT MAX(seq) FROM trade_fills %s GROUP BY account_id, symbol) AND pos_qty_e8 != 0 ORDER BY pos_opened_at DESC, seq DESC`
	var args []any
	if accountID != "" {
		q = fmt.Sprintf(q, "WHERE account_id = ?")
		args = append(args, accountID)
	} else {
		q = fmt.Sprintf(q, "")
	}
	rows, err := c.Store().Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []heldPosition{}
	for rows.Next() {
		var h heldPosition
		if err := rows.Scan(&h.AccountID, &h.Symbol, &h.ID, &h.Qty, &h.Cost, &h.Lev, &h.RunID, &h.OpenedAt); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// loadPosition 读一个账户一个标的的持仓，没有回零值。
func loadPosition(ctx context.Context, c plugin.Core, accountID, symbol string) (posState, error) {
	var p posState
	err := c.Store().QueryRow(ctx, `SELECT pos_id, pos_qty_e8, pos_cost_e8, pos_leverage, pos_run_id, pos_opened_at FROM trade_fills
		WHERE account_id = ? AND symbol = ? ORDER BY seq DESC LIMIT 1`, accountID, symbol).
		Scan(&p.ID, &p.Qty, &p.Cost, &p.Lev, &p.RunID, &p.OpenedAt)
	if errors.Is(err, plugin.ErrNoRows) {
		return posState{}, nil
	}
	if p.Qty == 0 {
		return posState{}, err
	}
	return p, err
}

// fillTotals 是一个账户全部成交的已实现、手续费合计。
func fillTotals(ctx context.Context, c plugin.Core, accountID string) (realized, fees fx, n int64, err error) {
	err = c.Store().QueryRow(ctx, `SELECT COALESCE(SUM(realized_e8), 0), COALESCE(SUM(fee_e8), 0), COUNT(*) FROM trade_fills WHERE account_id = ?`, accountID).
		Scan(&realized, &fees, &n)
	return
}

/* ---------- 对账 ---------- */

// LedgerCheck 是一个账户的对账结果（TradeLedgerCheck）：账本口径（初始 + 已实现 + 未实现 − 手续费）
// 和现金流重放口径（初始 − Σ带符号名义 − Σ手续费 + Σ持仓市值）各算一遍权益，再逐个标的核对持仓数量和成本。
// 数都是精确的十进制字符串。ok 为真表示两种口径分毫不差、持仓也对得上。TSK-0233 的两周运行检查脚本调它。
type LedgerCheck struct {
	AccountID    string   `json:"account_id"`
	At           string   `json:"at"`
	OK           bool     `json:"ok"`
	Initial      string   `json:"initial"`
	Realized     string   `json:"realized"`
	Unrealized   string   `json:"unrealized"`
	Fees         string   `json:"fees"`
	Equity       string   `json:"equity"`
	EquityReplay string   `json:"equity_replay"`
	Diff         string   `json:"diff"`
	Fills        int      `json:"fills"`
	Positions    int      `json:"positions"`
	Problems     []string `json:"problems"`
	MarksStatus  string   `json:"marks_status"`
}

// reconcile 对一个账户做对账；mark 回每个标的的估值价（拿不到时回 false，按均价估、未实现记 0）。
func reconcile(initial fx, fills []Fill, positions []heldPosition, insts func(string) (ledgerInst, bool), mark func(string) (fx, bool)) (LedgerCheck, error) {
	var out LedgerCheck
	out.Problems = []string{}
	var realized, fees, cashFlow fx
	type acc struct{ qty, cost fx }
	replay := map[string]*acc{}
	replayPos := map[string]posState{}
	syms := []string{}
	for _, f := range fills {
		realized += f.Realized
		fees += f.Fee
		cashFlow += f.Notional
		a := replay[f.Symbol]
		if a == nil {
			a = &acc{}
			replay[f.Symbol] = a
			syms = append(syms, f.Symbol)
		}
		d := f.Qty
		if f.Side == "sell" {
			d = -d
		}
		a.qty += d
		// 独立重放一遍持仓链，核对每一行记下的 pos_*
		np, r, err := applyFill(replayPos[f.Symbol], d, f.Notional, f.Pos.Lev, f.RunID, f.At, func() string { return f.Pos.ID })
		if err != nil {
			return out, err
		}
		if np.Qty != f.Pos.Qty || np.Cost != f.Pos.Cost {
			out.Problems = append(out.Problems, fmt.Sprintf("成交 %s 后的持仓记的是 %s / 成本 %s，重放是 %s / 成本 %s", f.ID, f.Pos.Qty, f.Pos.Cost, np.Qty, np.Cost))
		}
		if r != f.Realized {
			out.Problems = append(out.Problems, fmt.Sprintf("成交 %s 的已实现记的是 %s，重放是 %s", f.ID, f.Realized, r))
		}
		replayPos[f.Symbol] = f.Pos
		if f.Pos.Qty == 0 {
			replayPos[f.Symbol] = posState{}
		}
	}
	held := map[string]heldPosition{}
	for _, p := range positions {
		held[p.Symbol] = p
	}
	var unrealized, marketValue fx
	status := "live"
	for _, s := range syms {
		a := replay[s]
		p := held[s]
		if p.Qty != a.qty {
			out.Problems = append(out.Problems, fmt.Sprintf("%s 持仓 %s，成交流水累计 %s", s, p.Qty, a.qty))
		}
		if a.qty == 0 {
			continue
		}
		in, ok := insts(s)
		if !ok {
			out.Problems = append(out.Problems, s+" 标的表里没有，估不了市值")
			continue
		}
		px, live := mark(s)
		if !live {
			status = "stale"
		}
		if px == 0 {
			px = p.avgPrice(in.Mult)
		}
		mv, err := fxMul3(a.qty, px, in.Mult)
		if err != nil {
			return out, err
		}
		pv, err := fxMul3(p.Qty, px, in.Mult)
		if err != nil {
			return out, err
		}
		marketValue += mv
		unrealized += pv - p.Cost
	}
	equity := initial + realized + unrealized - fees
	replayEquity := initial - cashFlow - fees + marketValue
	out.Initial, out.Realized, out.Unrealized, out.Fees = initial.String(), realized.String(), unrealized.String(), fees.String()
	out.Equity, out.EquityReplay, out.Diff = equity.String(), replayEquity.String(), (equity - replayEquity).String()
	out.Fills, out.Positions = len(fills), len(positions)
	out.MarksStatus = status
	if equity != replayEquity {
		out.Problems = append(out.Problems, "账本权益和现金流重放的权益不一致，差 "+(equity-replayEquity).String())
	}
	out.OK = len(out.Problems) == 0
	return out, nil
}

/* ---------- 小工具 ---------- */

func newFillID() string  { return idgen.Prefixed("fl") }
func newPosID() string   { return idgen.Prefixed("ps") }
func newOrderID() string { return idgen.Prefixed("od") }

// usdText 同原型 usd(v)：$ 加千分位整数，负数带负号。
func usdText(v fx) string {
	s := groupThousands(localeFixed(v.Float(), 0))
	if strings.HasPrefix(s, "-") {
		return "-$" + s[1:]
	}
	return "$" + s
}

// qtyText 按最小下单量的小数位写数量，去掉末尾的 0。
func qtyText(q fx, lot fx) string {
	d := 0
	for l := lot; l > 0 && l%fxScale != 0 && d < 8; l *= 10 {
		d++
	}
	s := groupThousands(localeFixed(q.abs().Float(), d))
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	return s
}

// priceText 按标的精度写价格，千分位。
func priceText(p fx, digits int) string {
	return groupThousands(localeFixed(p.Float(), max(0, digits)))
}

var sideText = map[string]string{"buy": "买入", "sell": "卖出"}

func containsStr(xs []string, x string) bool { return slices.Contains(xs, x) }
