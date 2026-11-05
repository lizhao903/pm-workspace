package trade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 交易所实盘账户的只读同步（TRD-07a），对账和自动熔断在 recon.go（TRD-08b）。
//
// 接入：前端先用内核接口建连接器实例（POST /api/connectors，tool 是 binance_account / okx_account，凭证进保险箱），
// 测试连接（POST /api/connectors/{id}/test，Key 带提币权限时失败），再 POST /api/trade/accounts {connector_id} 建账户。
// 建账户时再查一遍 Key 的权限：带提币或转出资金的划转权限 409，不建。
//
// 同步（后台任务 trade_live，每 liveSyncEvery 一轮；POST /accounts/{id}/sync、/connect、/recon 当场同步一次）：
// 每次先查 Key 权限（发现带了提币权限：账户立刻停用、写审计、停掉这个账户上的部署），再拉余额、持仓、挂单和新的成交。
// 第一次成功时按交易所数据建立本地记录；之后本地记录只按新拉到的成交变动，再和交易所的持仓、挂单对账。
// 出网走 Core.HTTP("exchanges")，外面包 readOnlyTransport：只能 GET exchangeReadPaths 里的路径。

var (
	liveEvery     = 30 * time.Second // 后台任务多久看一遍
	liveSyncEvery = time.Minute      // 每个账户多久同步一次
)

var (
	liveMeta  = plugin.WriteMeta{Session: "live"}
	reconMeta = plugin.WriteMeta{Session: "recon"}
)

// errLive：对实盘账户的交易动作。接口回 403 forbidden、reason live。
var errLive = errors.New("live")

func liveErr(name string) error {
	return fmt.Errorf("%w: 账户「%s」是实盘账户：实盘下单、改单撤单、平仓和部署还没开放（要先过实盘评审、打开实盘开关，并等实盘下单上线），实盘账户现在只读同步", errLive, name)
}

type liveSync struct {
	p  *Plugin
	c  plugin.Core
	ex map[string]exchangeAccount

	mu          sync.Mutex      // 同步、对账、处理差异串行
	feedTripped map[string]bool // 行情源这一轮断开已经熔断过（mu 保护）
}

func newLiveSync(p *Plugin, c plugin.Core) *liveSync {
	ls := &liveSync{p: p, c: c, ex: map[string]exchangeAccount{}, feedTripped: map[string]bool{}}
	for _, x := range p.exchanges {
		ls.ex[x.Tool()] = x
	}
	return ls
}

func (ls *liveSync) now() time.Time { return ls.p.mkt.now() }

// session 建一次调用的上下文：受控出网客户端外面包只读检查。
func (ls *liveSync) session(ctx context.Context, cfg plugin.ConnectorConfig) (*exSession, error) {
	var hc *http.Client
	var err error
	if ls.p.exDoer != nil {
		hc, err = ls.p.exDoer(ctx)
	} else {
		hc, err = ls.c.HTTP("exchanges")
	}
	if err != nil {
		return nil, err
	}
	return &exSession{http: readOnlyClient(hc), cfg: cfg, now: ls.now(), mark: ls.mark(ctx), inst: func(sym string) (ledgerInst, bool) {
		return loadLedgerInst(ctx, ls.c, sym)
	}}, nil
}

// mark 是币种折 USD 的价：稳定币 1，别的取行情缓存里 Binance、OKX 的 <币种>USDT 现价。
func (ls *liveSync) mark(ctx context.Context) func(string) (fx, bool) {
	return func(asset string) (fx, bool) {
		if isStable(asset) {
			return fxScale, true
		}
		if ls.p.mkt == nil {
			return 0, false
		}
		for _, sym := range []string{"BINANCE:" + asset + "USDT", "OKX:" + asset + "-USDT"} {
			if ls.p.sourceFor(sym) == nil {
				continue
			}
			if q := ls.p.mkt.quote(ctx, sym); q.Last > 0 {
				if v, ok := fxFromFloat(q.Last); ok {
					return v, true
				}
			}
		}
		return 0, false
	}
}

// connectorDef 是一家交易所的连接器定义：令牌认证，凭证字段都是 secret（进保险箱、对外只有提示）。
func (ls *liveSync) connectorDef(x exchangeAccount) plugin.ConnectorDef {
	return plugin.ConnectorDef{
		Tool: x.Tool(), Label: x.Broker() + " 交易账户", Category: "market", Color: connectorColors[strings.ToLower(x.Broker())],
		Desc: x.Desc(), Auth: []connector.AuthMode{connector.AuthToken}, Fields: x.Fields(),
		Test: func(ctx context.Context, cfg connector.Config) (string, error) {
			k, hint, err := ls.probeCfg(ctx, x, cfg)
			if err != nil {
				return "", err
			}
			perm := "只读"
			if k.Trade {
				perm = "读取 + 交易（交易套件里只读）"
			}
			return x.Broker() + " " + hint + " · " + perm, nil
		},
	}
}

// probeCfg 查 Key 的权限并判断能不能接入；错误文本里的凭证已抹掉。
func (ls *liveSync) probeCfg(ctx context.Context, x exchangeAccount, cfg plugin.ConnectorConfig) (KeyPerms, string, error) {
	s, err := ls.session(ctx, cfg)
	if err != nil {
		return KeyPerms{}, "", err
	}
	k, err := x.Perms(ctx, s)
	if err != nil {
		return k, "", scrubbed(err, cfg)
	}
	if err := checkKey(k); err != nil {
		return k, "", err
	}
	return k, keyHint(cfg.Secret("api_key")), nil
}

// probe 用连接器实例里的凭证查一次权限。
func (ls *liveSync) probe(ctx context.Context, connectorID string, x exchangeAccount) (KeyPerms, string, error) {
	var k KeyPerms
	var hint string
	err := ls.c.Connectors().With(ctx, connectorID, func(cfg plugin.ConnectorConfig) error {
		var err error
		k, hint, err = ls.probeCfg(ctx, x, cfg)
		return err
	})
	return k, hint, err
}

// scrubbedError 保留原错误的类型（errors.As 照样认），只把文本里的凭证抹掉。
type scrubbedError struct {
	msg string
	err error
}

func (e *scrubbedError) Error() string { return e.msg }
func (e *scrubbedError) Unwrap() error { return e.err }

func scrubbed(err error, cfg plugin.ConnectorConfig) error {
	if err == nil {
		return nil
	}
	return &scrubbedError{msg: scrubSecrets(err.Error(), cfg), err: err}
}

/* ---------- 状态 ---------- */

type liveState struct {
	Equity, Available, Margin fx
	Stale                     bool
	Balances                  []LiveBalance
	Positions                 []LivePosition
	Orders                    []LiveOrder
	SyncedAt, BaselineAt      string
	Cursors                   map[string]string
	FailCount                 int
	LastError                 string
	LastAttemptAt             string
	Tripped                   bool
	exists                    bool
}

func (ls *liveSync) state(ctx context.Context, aid string) (liveState, error) {
	var st liveState
	var bal, pos, ord, cur string
	var stale, tripped int
	err := ls.c.Store().QueryRow(ctx, `SELECT equity_e8, available_e8, margin_e8, marks_stale, balances, positions, orders, synced_at, baseline_at, cursors,
		fail_count, last_error, last_attempt_at, tripped FROM trade_live_state WHERE account_id = ?`, aid).
		Scan(&st.Equity, &st.Available, &st.Margin, &stale, &bal, &pos, &ord, &st.SyncedAt, &st.BaselineAt, &cur, &st.FailCount, &st.LastError, &st.LastAttemptAt, &tripped)
	st.Cursors = map[string]string{}
	st.Balances, st.Positions, st.Orders = []LiveBalance{}, []LivePosition{}, []LiveOrder{}
	if errors.Is(err, plugin.ErrNoRows) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	st.exists, st.Stale, st.Tripped = true, stale == 1, tripped == 1
	_ = json.Unmarshal([]byte(bal), &st.Balances)
	_ = json.Unmarshal([]byte(pos), &st.Positions)
	_ = json.Unmarshal([]byte(ord), &st.Orders)
	_ = json.Unmarshal([]byte(cur), &st.Cursors)
	return st, nil
}

func (ls *liveSync) ensureState(ctx context.Context, aid string) error {
	_, err := ls.c.Store().Exec(ctx, `INSERT OR IGNORE INTO trade_live_state (account_id, updated_at) VALUES (?, ?)`, aid, stamp(ls.now()))
	return err
}

// holding 是本地记录里的一个持仓。
type holding struct {
	Key, Kind, Symbol string
	Qty               fx
}

func (ls *liveSync) holdings(ctx context.Context, aid string) (map[string]holding, error) {
	rows, err := ls.c.Store().Query(ctx, `SELECT key, kind, symbol, qty_e8 FROM trade_live_holdings WHERE account_id = ?`, aid)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]holding{}
	for rows.Next() {
		var h holding
		if err := rows.Scan(&h.Key, &h.Kind, &h.Symbol, &h.Qty); err != nil {
			return nil, err
		}
		out[h.Key] = h
	}
	return out, rows.Err()
}

// localOrder 是本地记录里的一笔挂单。
type localOrder struct {
	ID, Symbol, Side, Type string
	Qty, Price, Filled     fx
}

func (ls *liveSync) localOrders(ctx context.Context, aid string) (map[string]localOrder, error) {
	rows, err := ls.c.Store().Query(ctx, `SELECT order_id, symbol, side, type, qty_e8, price_e8, filled_e8 FROM trade_live_orders WHERE account_id = ?`, aid)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]localOrder{}
	for rows.Next() {
		var o localOrder
		if err := rows.Scan(&o.ID, &o.Symbol, &o.Side, &o.Type, &o.Qty, &o.Price, &o.Filled); err != nil {
			return nil, err
		}
		out[o.ID] = o
	}
	return out, rows.Err()
}

// addHolding 给本地记录的一个持仓加 d（带符号），减到 0 删掉。
func (ls *liveSync) addHolding(ctx context.Context, aid, key, kind, symbol string, d fx) error {
	if d == 0 {
		return nil
	}
	now := stamp(ls.now())
	if _, err := ls.c.Store().Exec(ctx, `INSERT INTO trade_live_holdings (account_id, key, kind, symbol, qty_e8, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_id, key) DO UPDATE SET qty_e8 = qty_e8 + excluded.qty_e8, updated_at = excluded.updated_at`, aid, key, kind, symbol, d, now); err != nil {
		return err
	}
	_, err := ls.c.Store().Exec(ctx, `DELETE FROM trade_live_holdings WHERE account_id = ? AND key = ? AND qty_e8 = 0`, aid, key)
	return err
}

// setHolding 把本地记录的一个持仓改成 q（按交易所修正、建立本地记录用），0 删掉。
func (ls *liveSync) setHolding(ctx context.Context, aid, key, kind, symbol string, q fx) error {
	if q == 0 {
		_, err := ls.c.Store().Exec(ctx, `DELETE FROM trade_live_holdings WHERE account_id = ? AND key = ?`, aid, key)
		return err
	}
	_, err := ls.c.Store().Exec(ctx, `INSERT INTO trade_live_holdings (account_id, key, kind, symbol, qty_e8, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_id, key) DO UPDATE SET qty_e8 = excluded.qty_e8, kind = excluded.kind, symbol = excluded.symbol, updated_at = excluded.updated_at`,
		aid, key, kind, symbol, q, stamp(ls.now()))
	return err
}

func (ls *liveSync) putLocalOrder(ctx context.Context, aid string, o LiveOrder) error {
	now := stamp(ls.now())
	_, err := ls.c.Store().Exec(ctx, `INSERT OR REPLACE INTO trade_live_orders (account_id, order_id, symbol, side, type, qty_e8, price_e8, filled_e8, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, aid, o.ID, o.Symbol, o.Side, o.Type, o.qty, o.price, o.filled, orDefault(o.CreatedAt, now), now)
	return err
}

func newAccountID() string { return idgen.Prefixed("ac") }

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// holdingKind 是持仓键的种类：spot:<币种> 是现货持有，其余是合约。
func holdingKind(key string) string {
	if strings.HasPrefix(key, "spot:") {
		return "spot"
	}
	return "contract"
}

// spotSymbol 是现货持有对应的标的：Binance <币种>USDT，OKX <币种>-USDT。
func spotSymbol(broker, key string) string {
	asset := strings.TrimPrefix(key, "spot:")
	if broker == "OKX" {
		return "OKX:" + asset + "-USDT"
	}
	return "BINANCE:" + asset + "USDT"
}

/* ---------- 同步 ---------- */

// syncFailure 是同步失败的种类：withdraw 发现提币权限，down 数据源断开（Key 无效、过期、连接器没了），
// grant network:exchanges 还没确认（不熔断），fail 接口失败（网络、限频、5xx）。
type syncFailure struct {
	kind string
	msg  string
}

func classify(err error) string {
	var we *errWithdrawKey
	var ee *ExchangeError
	switch {
	case errors.As(err, &we):
		return "withdraw"
	case errors.Is(err, plugin.ErrNotGranted), errors.Is(err, plugin.ErrNetworkNotDeclared):
		// network:exchanges 还没确认（升级后没确认新权限）：不是交易所的问题，不熔断
		return "grant"
	case errors.As(err, &ee) && ee.Auth:
		return "down"
	case errors.Is(err, plugin.ErrNoRows), errors.Is(err, domain.ErrConflict), errors.Is(err, domain.ErrNotFound):
		// 连接器没了、被暂停或断开
		return "down"
	}
	return "fail"
}

// syncAccount 同步一个实盘账户；不管成没成功，账户状态、连接器状态、对账记录、审计都记好，回这次的错误（文本里没有凭证）。
func (ls *liveSync) syncAccount(ctx context.Context, aid string) error {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	return ls.syncLocked(ctx, aid)
}

func (ls *liveSync) syncLocked(ctx context.Context, aid string) error {
	a, err := loadAccount(ctx, ls.c, aid)
	if err != nil {
		return err
	}
	if a.Paper {
		return apiErr(errValidation, "模拟盘本地撮合，不用同步")
	}
	if err := ls.ensureState(ctx, a.ID); err != nil {
		return err
	}
	st, err := ls.state(ctx, a.ID)
	if err != nil {
		return err
	}
	now := ls.now()
	if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_live_state SET last_attempt_at = ? WHERE account_id = ?`, stamp(now), a.ID); err != nil {
		return err
	}
	ci, err := ls.c.Connectors().Get(ctx, a.ConnectorID)
	if err != nil {
		if errors.Is(err, plugin.ErrNoRows) {
			return ls.failed(ctx, a, st, syncFailure{kind: "down", msg: "连接器已删除，账户拉不到交易所数据；重新接入后再连接"})
		}
		return err
	}
	x := ls.ex[ci.Tool]
	if x == nil {
		return ls.failed(ctx, a, st, syncFailure{kind: "down", msg: "连接器 " + ci.Tool + " 不是交易所账户"})
	}
	since := now.Add(-time.Minute)
	if t, err := time.Parse(time.RFC3339Nano, st.SyncedAt); err == nil && st.BaselineAt != "" {
		since = t.Add(-2 * time.Minute)
	}
	hs, err := ls.holdings(ctx, a.ID)
	if err != nil {
		return err
	}
	los, err := ls.localOrders(ctx, a.ID)
	if err != nil {
		return err
	}
	track := []string{}
	for k := range hs {
		track = append(track, k)
	}
	for _, o := range los {
		track = append(track, o.Symbol)
	}
	slices.Sort(track)
	var k KeyPerms
	var snap liveSnapshot
	werr := ls.c.Connectors().With(ctx, a.ConnectorID, func(cfg plugin.ConnectorConfig) error {
		s, err := ls.session(ctx, cfg)
		if err != nil {
			return err
		}
		if k, err = x.Perms(ctx, s); err != nil {
			return scrubbed(err, cfg)
		}
		if err := checkKey(k); err != nil {
			return err
		}
		if snap, err = x.Snapshot(ctx, s, k, st.Cursors, since, track); err != nil {
			return scrubbed(err, cfg)
		}
		return nil
	})
	if werr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		msg := werr.Error()
		for _, pre := range []string{domain.ErrConflict.Error() + ": ", domain.ErrNotFound.Error() + ": "} {
			msg = strings.TrimPrefix(msg, pre)
		}
		return ls.failed(ctx, a, st, syncFailure{kind: classify(werr), msg: msg})
	}
	return ls.succeeded(ctx, a, x, st, k, snap)
}

// failed 记一次同步失败：账户置为异常；提币权限停用账户；数据源断开立刻熔断，接口连续失败到上限熔断（这一轮故障只熔断一次）。
func (ls *liveSync) failed(ctx context.Context, a account, st liveState, f syncFailure) error {
	now := stamp(ls.now())
	msg := f.msg
	if utf8.RuneCountInString(msg) > 300 {
		msg = string([]rune(msg)[:300]) + "…"
	}
	fails := st.FailCount + 1
	accountMsg := msg
	if f.kind == "withdraw" {
		accountMsg = strings.Replace(msg, "，不能接入。", "，已停止使用。", 1)
		accountMsg = strings.Replace(accountMsg, "后再试（交易套件只需要读取权限）", "后重新连接", 1)
	}
	wasOK := a.Status == "connected"
	if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_accounts SET status = 'error', error = ?, updated_at = ? WHERE id = ?`, accountMsg, now, a.ID); err != nil {
		return err
	}
	if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_live_state SET fail_count = ?, last_error = ?, updated_at = ? WHERE account_id = ?`, fails, msg, now, a.ID); err != nil {
		return err
	}
	if a.ConnectorID != "" {
		if _, err := ls.c.Connectors().RecordSync(ctx, a.ConnectorID, errors.New(msg)); err != nil && !errors.Is(err, plugin.ErrNoRows) {
			ls.c.Log().Warn("record trade connector sync failed", "account", a.ID, "err", err)
		}
	}
	// 对账也记一条失败
	if err := ls.recordFailedRecon(ctx, a, accountMsg); err != nil {
		ls.c.Log().Warn("record failed recon failed", "account", a.ID, "err", err)
	}
	pp := ls.p.paper
	detail := map[string]any{"account_id": a.ID, "kind": f.kind, "error": msg, "fail_count": fails}
	if wasOK || f.kind == "withdraw" {
		pp.audit(ctx, "sync_failed", "trade_account", a.ID, "同步交易账户「"+a.Name+"」失败："+msg, detail, liveMeta)
		pp.notify(ctx, "account", plugin.NotifyError, "交易账户异常："+a.Name, accountMsg, map[string]any{"account_id": a.ID})
		pp.incident(ctx, "trade:account:"+a.ID, "交易账户异常", a.Name+"："+accountMsg, map[string]any{"账户": a.Name})
	}
	if f.kind == "withdraw" {
		// 账户立刻停用：这个账户上的部署全停（实盘不能部署，正常是 0 个）
		pp.mu.Lock()
		runs, _ := queryRuns(ctx, ls.c, `WHERE account_id = ? AND status != 'stopped'`, a.ID)
		for _, x := range runs {
			if err := ls.p.runs.stopLocked(ctx, x, "交易账户的 API Key 开了提币权限，已停用", liveMeta); err != nil {
				ls.c.Log().Warn("stop run on withdraw key failed", "run", x.ID, "err", err)
			}
		}
		pp.mu.Unlock()
		pp.audit(ctx, "key_rejected", "trade_account", a.ID, "交易账户「"+a.Name+"」的 API Key 开了提币权限，已停止使用", detail, liveMeta)
	}
	r, err := pp.risk(ctx)
	if err != nil {
		return &scrubbedError{msg: msg}
	}
	if st.Tripped {
		return &scrubbedError{msg: msg}
	}
	reason := ""
	switch {
	case f.kind == "withdraw" || f.kind == "down":
		reason = fmt.Sprintf("交易账户「%s」的数据源断开：%s，自动熔断", a.Name, accountMsg)
	case f.kind == "grant":
	case float64(fails) >= r.SyncFailLimit:
		reason = fmt.Sprintf("交易账户「%s」的交易所接口连续失败 %d 次：%s，自动熔断", a.Name, fails, msg)
	}
	if reason != "" {
		ls.trip(ctx, reason, map[string]any{"account_id": a.ID, "trigger": "sync_" + f.kind, "fail_count": fails, "error": msg})
		_, _ = ls.c.Store().Exec(ctx, `UPDATE trade_live_state SET tripped = 1 WHERE account_id = ?`, a.ID)
	}
	return &scrubbedError{msg: msg}
}

// succeeded 记一次成功的同步：存交易所数据、记新成交、第一次时建立本地记录，然后对账。
func (ls *liveSync) succeeded(ctx context.Context, a account, x exchangeAccount, st liveState, k KeyPerms, snap liveSnapshot) error {
	nowT := ls.now()
	now := stamp(nowT)
	pp := ls.p.paper
	kp, _ := json.Marshal(k.list())
	if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_accounts SET status = 'connected', error = '', key_perms = ?, updated_at = ? WHERE id = ?`, string(kp), now, a.ID); err != nil {
		return err
	}
	if snap.Balances == nil {
		snap.Balances = []LiveBalance{}
	}
	if snap.Positions == nil {
		snap.Positions = []LivePosition{}
	}
	if snap.Orders == nil {
		snap.Orders = []LiveOrder{}
	}
	bal, _ := json.Marshal(snap.Balances)
	pos, _ := json.Marshal(snap.Positions)
	ord, _ := json.Marshal(snap.Orders)
	cur, _ := json.Marshal(snap.Cursors)
	if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_live_state SET equity_e8 = ?, available_e8 = ?, margin_e8 = ?, marks_stale = ?, balances = ?, positions = ?, orders = ?,
		synced_at = ?, cursors = ?, fail_count = 0, last_error = '', tripped = 0, updated_at = ? WHERE account_id = ?`,
		snap.Equity, snap.Available, snap.Margin, b2i(snap.Stale), string(bal), string(pos), string(ord), now, string(cur), now, a.ID); err != nil {
		return err
	}
	if a.ConnectorID != "" {
		if _, err := ls.c.Connectors().RecordSync(ctx, a.ConnectorID, nil); err != nil && !errors.Is(err, plugin.ErrNoRows) {
			ls.c.Log().Warn("record trade connector sync failed", "account", a.ID, "err", err)
		}
	}
	if a.Status != "connected" || st.FailCount > 0 {
		text := "交易账户「" + a.Name + "」恢复同步"
		if st.Tripped {
			text += "；之前触发的熔断不会自动解除，要到风控手动解除"
		}
		pp.audit(ctx, "sync_recovered", "trade_account", a.ID, text, map[string]any{"account_id": a.ID, "fail_count": st.FailCount, "tripped": st.Tripped}, liveMeta)
		if st.Tripped {
			pp.notify(ctx, "account", plugin.NotifyInfo, "交易账户恢复："+a.Name, "数据源已恢复。熔断不会自动解除，确认没问题后到「交易 / 风控」手动解除。", map[string]any{"account_id": a.ID})
		}
	}
	// 新成交：按成交号去重，新插入的才记进本地记录（建立本地记录这一次不记，交易所的持仓已经含了它们）
	baseline := st.BaselineAt == ""
	applied := 0
	for _, f := range snap.Fills {
		res, err := ls.c.Store().Exec(ctx, `INSERT OR IGNORE INTO trade_live_fills (account_id, fill_id, order_id, symbol, side, qty_e8, price_e8, fee_e8, fee_asset, at, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, a.ID, f.ID, f.OrderID, f.Symbol, f.Side, f.qty.abs(), mustFx(fmtFloat(f.Price)), f.fee, f.FeeAsset, f.At, now)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 || baseline {
			continue
		}
		applied++
		sym := f.Symbol
		if holdingKind(f.key) == "spot" {
			sym = spotSymbol(x.Broker(), f.key)
		}
		if err := ls.addHolding(ctx, a.ID, f.key, holdingKind(f.key), sym, f.qty); err != nil {
			return err
		}
		if f.feeKey != "" {
			if err := ls.addHolding(ctx, a.ID, f.feeKey, "spot", spotSymbol(x.Broker(), f.feeKey), f.fee); err != nil {
				return err
			}
		}
		if f.OrderID != "" {
			if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_live_orders SET filled_e8 = filled_e8 + ?, updated_at = ? WHERE account_id = ? AND order_id = ?`,
				f.qty.abs(), now, a.ID, f.OrderID); err != nil {
				return err
			}
			if _, err := ls.c.Store().Exec(ctx, `DELETE FROM trade_live_orders WHERE account_id = ? AND order_id = ? AND filled_e8 >= qty_e8`, a.ID, f.OrderID); err != nil {
				return err
			}
		}
	}
	if baseline {
		for _, p := range snap.Positions {
			if err := ls.setHolding(ctx, a.ID, p.Key, holdingKind(p.Key), p.Symbol, p.qty); err != nil {
				return err
			}
		}
		for _, o := range snap.Orders {
			if err := ls.putLocalOrder(ctx, a.ID, o); err != nil {
				return err
			}
		}
		if _, err := ls.c.Store().Exec(ctx, `UPDATE trade_live_state SET baseline_at = ? WHERE account_id = ?`, now, a.ID); err != nil {
			return err
		}
		pp.audit(ctx, "baseline", "trade_account", a.ID, fmt.Sprintf("交易账户「%s」第一次同步成功，按交易所数据建立本地记录：%d 个持仓、%d 笔挂单", a.Name, len(snap.Positions), len(snap.Orders)),
			map[string]any{"account_id": a.ID, "positions": len(snap.Positions), "orders": len(snap.Orders), "fills": len(snap.Fills)}, liveMeta)
	}
	if applied > 0 {
		ls.c.Log().Info("live fills applied", "account", a.ID, "fills", applied)
	}
	return ls.reconcileLocked(ctx, a, snap)
}

func fmtFloat(f float64) string {
	v, _ := fxFromFloat(f)
	return v.String()
}

/* ---------- 后台任务 ---------- */

// runAll 是 trade_live：到点的实盘账户同步一遍（含对账），再看行情数据源断开要不要熔断。
func (ls *liveSync) runAll(ctx context.Context) error {
	accts, err := loadAccounts(ctx, ls.c)
	if err != nil {
		return err
	}
	now := ls.now()
	for _, a := range accts {
		if ctx.Err() != nil {
			return nil
		}
		if a.Paper || a.Status == "disconnected" || a.ConnectorID == "" {
			continue
		}
		st, err := ls.state(ctx, a.ID)
		if err != nil {
			return err
		}
		if t, err := time.Parse(time.RFC3339Nano, st.LastAttemptAt); err == nil && now.Sub(t) < liveSyncEvery {
			continue
		}
		if err := ls.syncAccount(ctx, a.ID); err != nil && ctx.Err() == nil {
			ls.c.Log().Warn("live account sync failed", "account", a.ID, "err", err.Error())
		}
	}
	ls.checkFeeds(ctx)
	return nil
}

/* ---------- 接口 ---------- */

// effectivePerms 是账户的权限：用户要了交易、Key 也有交易权限才是读取 + 交易（实盘下单没开放前也不起作用）。
func effectivePerms(a account) []string {
	if a.WantTrade && slices.Contains(a.KeyPerms, "trade") {
		return []string{"read", "trade"}
	}
	return []string{"read"}
}

func (ls *liveSync) view(ctx context.Context, a account) (AccountView, error) {
	st, err := ls.state(ctx, a.ID)
	if err != nil {
		return AccountView{}, err
	}
	var upl float64
	for _, p := range st.Positions {
		upl += p.PnL
	}
	marks := "live"
	if st.Stale {
		marks = "stale"
	}
	want := a.WantTrade
	brief, err := ls.reconBrief(ctx, a.ID)
	if err != nil {
		return AccountView{}, err
	}
	return AccountView{ID: a.ID, Name: a.Name, Broker: a.Broker, Kind: a.Kind, Markets: a.Markets, Paper: false, Currency: a.Currency,
		Equity: st.Equity.Float(), Available: st.Available.Float(), MarginUsed: st.Margin.Float(), Status: a.Status, Error: a.Error,
		APIHint: a.APIHint, Permissions: effectivePerms(a), UpdatedAt: orDefault(st.SyncedAt, a.UpdatedAt), Balance: st.Equity.Float(),
		UnrealizedPnL: upl, MarksStatus: marks, CreatedAt: a.CreatedAt, ConnectorID: a.ConnectorID, KeyPermissions: a.KeyPerms,
		WantTrade: &want, SyncedAt: st.SyncedAt, Recon: &brief}, nil
}

// failLive 写回实盘账户接口的冲突：reason 是 key_withdraw / connect_failed / in_use / disconnected。
func failLive(w http.ResponseWriter, status int, reason, msg string) {
	code := "conflict"
	if status == http.StatusForbidden {
		code = "forbidden"
	}
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "reason": reason, "message": msg}})
}

// POST /api/trade/accounts {connector_id, name?, trade?, paper?, markets?}：接入交易所实盘账户（只读）。
func (h *handlers) addLiveAccount(w http.ResponseWriter, r *http.Request, raw map[string]json.RawMessage) {
	ctx := r.Context()
	ls := h.p.live
	b := &bodyReader{raw: raw}
	b.only("connector_id", "name", "trade", "paper", "markets")
	var cid, name string
	var trade bool
	b.str("connector_id", &cid)
	b.str("name", &name)
	b.boolean("trade", &trade)
	if b.err != nil {
		h.fail(w, r, b.err)
		return
	}
	if v, ok := raw["paper"]; ok {
		var p bool
		if json.Unmarshal(v, &p) != nil || p {
			h.fail(w, r, apiErr(errValidation, "接交易所账户时 paper 只能是 false：实盘账户在交易套件里恒为非模拟盘"))
			return
		}
	}
	if v, ok := raw["markets"]; ok {
		var ms []string
		if json.Unmarshal(v, &ms) != nil || !slices.Equal(uniqTrim(ms), []string{"crypto"}) {
			h.fail(w, r, apiErr(errValidation, "交易所账户现在只有数币（markets 只能是 [\"crypto\"]）"))
			return
		}
	}
	if cid == "" {
		h.fail(w, r, apiErr(errValidation, "选一个连接器（connector_id）"))
		return
	}
	if utf8.RuneCountInString(name) > maxAccountName {
		h.fail(w, r, apiErr(errValidation, "名称最多 %d 字", maxAccountName))
		return
	}
	ci, err := h.c.Connectors().Get(ctx, cid)
	if errors.Is(err, plugin.ErrNoRows) {
		h.fail(w, r, apiErr(errValidation, "连接器 %s 不存在", cid))
		return
	} else if err != nil {
		h.fail(w, r, err)
		return
	}
	x := ls.ex[ci.Tool]
	if x == nil {
		h.fail(w, r, apiErr(errValidation, "连接器 %s 不是交易所账户（tool 要是 %s 或 %s）", cid, BinanceAccountTool, OKXAccountTool))
		return
	}
	var used string
	if h.c.Store().QueryRow(ctx, `SELECT name FROM trade_accounts WHERE connector_id = ?`, cid).Scan(&used) == nil {
		failLive(w, http.StatusConflict, "in_use", "这个连接器已经接到账户「"+used+"」上了")
		return
	}
	k, hint, err := ls.probe(ctx, cid, x)
	if err != nil {
		var we *errWithdrawKey
		if errors.As(err, &we) {
			h.p.paper.audit(ctx, "key_rejected", "connector", cid, "拒绝接入 "+x.Broker()+" 账户："+err.Error(), map[string]any{"connector_id": cid, "tool": ci.Tool}, userMeta)
			failLive(w, http.StatusConflict, "key_withdraw", err.Error())
			return
		}
		failLive(w, http.StatusConflict, "connect_failed", "连不上 "+x.Broker()+"："+err.Error())
		return
	}
	now := stamp(ls.now())
	if name == "" {
		name = x.Broker() + " 账户"
	}
	kp, _ := json.Marshal(k.list())
	a := account{ID: newAccountID(), Name: name, Broker: x.Broker(), Kind: "exchange", Markets: []string{"crypto"}, Currency: "USDT",
		APIHint: hint, ConnectorID: cid, Status: "connected", WantTrade: trade, KeyPerms: k.list(), CreatedAt: now, UpdatedAt: now}
	a.Permissions = effectivePerms(a)
	ps, _ := json.Marshal(a.Permissions)
	// paper 写死 0：实盘账户在插件里恒为非模拟盘，没有改它的语句
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO trade_accounts (`+accountCols+`) VALUES (?, ?, ?, 'exchange', '["crypto"]', 0, 'USDT', 0, 0, 0, ?, ?, ?, ?, ?, 'connected', '', ?, ?)`,
		a.ID, a.Name, a.Broker, string(ps), a.APIHint, now, now, cid, b2i(trade), string(kp)); err != nil {
		h.fail(w, r, err)
		return
	}
	h.p.paper.audit(ctx, "create", "trade_account", a.ID, "接入 "+x.Broker()+" 实盘账户「"+a.Name+"」（只读，"+a.APIHint+"）",
		map[string]any{"account_id": a.ID, "connector_id": cid, "broker": a.Broker, "key_permissions": k.list(), "want_trade": trade, "ip_restricted": k.IPRestricted}, userMeta)
	if err := ls.syncAccount(ctx, a.ID); err != nil {
		h.c.Log().Warn("first live sync failed", "account", a.ID, "err", err.Error())
	}
	a, err = loadAccount(ctx, h.c, a.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	v, err := ls.view(ctx, a)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": v})
}

// PATCH /api/trade/accounts/{id}（实盘）：只能改名称和要不要交易权限（trade，只记意愿，实盘下单没开放前不起作用）。
func (h *handlers) updateLiveAccount(w http.ResponseWriter, r *http.Request, a account, raw map[string]json.RawMessage) {
	ctx := r.Context()
	b := &bodyReader{raw: raw}
	b.only("name", "trade")
	name, trade := a.Name, a.WantTrade
	b.str("name", &name)
	b.boolean("trade", &trade)
	if b.err != nil {
		h.fail(w, r, b.err)
		return
	}
	if name == "" || utf8.RuneCountInString(name) > maxAccountName {
		h.fail(w, r, apiErr(errValidation, "名称不能为空，最多 %d 字", maxAccountName))
		return
	}
	now := stamp(h.p.live.now())
	if _, err := h.c.Store().Exec(ctx, `UPDATE trade_accounts SET name = ?, want_trade = ?, updated_at = ? WHERE id = ?`, name, b2i(trade), now, a.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	h.p.paper.audit(ctx, "update", "trade_account", a.ID, "修改实盘账户「"+name+"」",
		map[string]any{"account_id": a.ID, "from": map[string]any{"name": a.Name, "want_trade": a.WantTrade}, "to": map[string]any{"name": name, "want_trade": trade}}, userMeta)
	h.writeAccount(w, r, a.ID, http.StatusOK)
}

func (h *handlers) writeAccount(w http.ResponseWriter, r *http.Request, id string, status int) {
	a, err := loadAccount(r.Context(), h.c, id)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	v, err := h.accountView(r.Context(), a)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, status, map[string]any{"data": v})
}

// 删实盘账户：只删插件里的关联和本地记录，交易所那边什么都不动；连接器实例（凭证）留着，要删到连接器页删。
// 成交历史、对账记录、审计保留。调用方持有账本锁。
func (h *handlers) removeLiveAccount(w http.ResponseWriter, r *http.Request, a account) {
	ctx := r.Context()
	for _, q := range []string{`DELETE FROM trade_accounts WHERE id = ?`, `DELETE FROM trade_live_state WHERE account_id = ?`,
		`DELETE FROM trade_live_holdings WHERE account_id = ?`, `DELETE FROM trade_live_orders WHERE account_id = ?`} {
		if _, err := h.c.Store().Exec(ctx, q, a.ID); err != nil {
			h.fail(w, r, err)
			return
		}
	}
	h.p.paper.audit(ctx, "delete", "trade_account", a.ID, "删除实盘账户「"+a.Name+"」（交易所那边不动，连接器保留）", map[string]any{"account_id": a.ID, "name": a.Name, "connector_id": a.ConnectorID}, userMeta)
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// liveAccount 取路径里的实盘账户；模拟盘 400。
func (h *handlers) liveAccount(w http.ResponseWriter, r *http.Request) (account, bool) {
	a, err := loadAccount(r.Context(), h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return a, false
	}
	if a.Paper {
		h.fail(w, r, apiErr(errValidation, "账户「%s」是模拟盘：本地撮合，不用同步、对账", a.Name))
		return a, false
	}
	return a, true
}

// POST /api/trade/accounts/{id}/sync：马上同步一次（含对账）。已断开的 409。同步失败不是接口错误：回账户，status 是 error。
func (h *handlers) syncLiveAccount(w http.ResponseWriter, r *http.Request) {
	a, ok := h.liveAccount(w, r)
	if !ok {
		return
	}
	if a.Status == "disconnected" {
		failLive(w, http.StatusConflict, "disconnected", "账户已断开，先重新连接")
		return
	}
	_ = h.p.live.syncAccount(r.Context(), a.ID)
	h.writeAccount(w, r, a.ID, http.StatusOK)
}

// POST /api/trade/accounts/{id}/connect：重新连接（断开后再连、异常后重试），查 Key 权限并同步一次。
func (h *handlers) connectLiveAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, ok := h.liveAccount(w, r)
	if !ok {
		return
	}
	if a.Status == "disconnected" {
		if _, err := h.c.Store().Exec(ctx, `UPDATE trade_accounts SET status = 'connected', error = '', updated_at = ? WHERE id = ?`, stamp(h.p.live.now()), a.ID); err != nil {
			h.fail(w, r, err)
			return
		}
	}
	h.p.paper.audit(ctx, "connect", "trade_account", a.ID, "重新连接实盘账户「"+a.Name+"」", map[string]any{"account_id": a.ID, "from": a.Status}, userMeta)
	_ = h.p.live.syncAccount(ctx, a.ID)
	h.writeAccount(w, r, a.ID, http.StatusOK)
}

// POST /api/trade/accounts/{id}/disconnect：断开（不再同步、不对账）；交易所那边、连接器实例都不动。
func (h *handlers) disconnectLiveAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, ok := h.liveAccount(w, r)
	if !ok {
		return
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE trade_accounts SET status = 'disconnected', error = '', updated_at = ? WHERE id = ?`, stamp(h.p.live.now()), a.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	h.p.paper.audit(ctx, "disconnect", "trade_account", a.ID, "断开实盘账户「"+a.Name+"」", map[string]any{"account_id": a.ID, "from": a.Status}, userMeta)
	h.writeAccount(w, r, a.ID, http.StatusOK)
}

// LiveSnapshotView 是 GET /api/trade/accounts/{id}/snapshot（TradeLiveSnapshot）：最近一次只读同步拉到的交易所数据。
type LiveSnapshotView struct {
	AccountID      string         `json:"account_id"`
	SyncedAt       string         `json:"synced_at"`
	BaselineAt     string         `json:"baseline_at"`
	Status         string         `json:"status"`
	Error          string         `json:"error,omitempty"`
	Equity         float64        `json:"equity"`
	Available      float64        `json:"available"`
	MarginUsed     float64        `json:"margin_used"`
	MarksStatus    string         `json:"marks_status"`
	KeyPermissions []string       `json:"key_permissions"`
	FailCount      int            `json:"fail_count"`
	Balances       []LiveBalance  `json:"balances"`
	Positions      []LivePosition `json:"positions"`
	Orders         []LiveOrder    `json:"orders"`
}

func (h *handlers) liveSnapshot(w http.ResponseWriter, r *http.Request) {
	a, ok := h.liveAccount(w, r)
	if !ok {
		return
	}
	st, err := h.p.live.state(r.Context(), a.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	marks := "live"
	if st.Stale {
		marks = "stale"
	}
	for i := range st.Positions {
		st.Positions[i].AccountID = a.ID
	}
	for i := range st.Orders {
		st.Orders[i].AccountID = a.ID
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": LiveSnapshotView{AccountID: a.ID, SyncedAt: st.SyncedAt, BaselineAt: st.BaselineAt, Status: a.Status, Error: a.Error,
		Equity: st.Equity.Float(), Available: st.Available.Float(), MarginUsed: st.Margin.Float(), MarksStatus: marks, KeyPermissions: a.KeyPerms,
		FailCount: st.FailCount, Balances: st.Balances, Positions: st.Positions, Orders: st.Orders}})
}

// LiveFillView 是交易所拉来的一笔成交（TradeLiveFill）。
type LiveFillView struct {
	ID        string  `json:"id"`
	AccountID string  `json:"account_id"`
	OrderID   string  `json:"order_id"`
	Symbol    string  `json:"symbol"`
	Side      string  `json:"side"`
	Qty       float64 `json:"qty"`
	Price     float64 `json:"price"`
	Fee       float64 `json:"fee"`
	FeeAsset  string  `json:"fee_asset"`
	At        string  `json:"at"`
	SyncedAt  string  `json:"synced_at"`
}

// GET /api/trade/accounts/{id}/fills?symbol=&limit=&offset=：交易所成交历史（只读拉来的），新的在前。
func (h *handlers) liveFills(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, ok := h.liveAccount(w, r)
	if !ok {
		return
	}
	limit, offset, err := pageParams(r, 200, 1000)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	where, args := `WHERE account_id = ?`, []any{a.ID}
	if s := r.URL.Query().Get("symbol"); s != "" {
		where += ` AND symbol = ?`
		args = append(args, s)
	}
	var total int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_live_fills `+where, args...).Scan(&total); err != nil {
		h.fail(w, r, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT fill_id, order_id, symbol, side, qty_e8, price_e8, fee_e8, fee_asset, at, synced_at FROM trade_live_fills `+where+
		` ORDER BY at DESC, fill_id DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []LiveFillView{}
	for rows.Next() {
		var f LiveFillView
		var q, px, fee fx
		if err := rows.Scan(&f.ID, &f.OrderID, &f.Symbol, &f.Side, &q, &px, &fee, &f.FeeAsset, &f.At, &f.SyncedAt); err != nil {
			h.fail(w, r, err)
			return
		}
		f.AccountID, f.Qty, f.Price, f.Fee = a.ID, q.Float(), px.Float(), fee.abs().Float()
		out = append(out, f)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total, "limit": limit, "offset": offset}})
}

/* ---------- 连接器删除前的影响 ---------- */

func liveAccountsImpact(ctx context.Context, c plugin.Core, cn plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
	if cn.Tool != BinanceAccountTool && cn.Tool != OKXAccountTool {
		return nil, nil
	}
	var n int
	if err := c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_accounts WHERE connector_id = ?`, cn.ID).Scan(&n); err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, nil
	}
	return &plugin.ConnectorImpactData{Count: n, Effect: plugin.ImpactKeep,
		Text: fmt.Sprintf("%d 个交易账户会断开、不再同步（持仓、成交、对账记录保留，只能查看）", n)}, nil
}
