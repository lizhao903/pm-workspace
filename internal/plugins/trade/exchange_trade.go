package trade

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

// 实盘下单的出网边界（TRD-08d）：写操作的放行清单、闸门令牌、交易所下单适配器的接口和交易规则（精度、最小量）。
//
// 写操作只有三种：下单（place）、撤单（cancel）、查单（query），按交易所、方法、路径列在 exchangeTradePaths，
// 没有批量下单、改单、平仓接口、调杠杆、划转、提币、借贷。查单虽然是 GET，也和下单、撤单放在一起，只在闸门令牌下发。
//
// 令牌（tradeGrant）只由实盘闸门 liveTrader.withGate 签发（issueTradeGrant 只许在那里调，TestTradeGrantOnlyFromGate 扫源码），
// 放进这一次调用的 ctx：readOnlyTransport 从请求的 ctx 里取令牌，令牌要在登记表里（签发时登记、调用结束即作废）、
// 没过期、账户的交易所对得上、这条路径在放行清单里、令牌的范围允许这一种操作（下单令牌三种都行，撤单查单令牌不能下单）。
// 别的任何代码路径发写请求，ctx 里没有令牌，一律在本地拦下（errNotReadOnly），不出网。

// tradeOp 是写操作的种类。
type tradeOp string

const (
	opPlace  tradeOp = "place"
	opCancel tradeOp = "cancel"
	opQuery  tradeOp = "query"
)

// tradePath 是一条放行的写操作。
type tradePath struct {
	Method string
	Path   string
	Op     tradeOp
}

// exchangeTradePaths 是写操作的全部放行清单（host -> 方法 + 路径 + 操作）。加一条要同时改 trade_test.go 里的期望清单。
var exchangeTradePaths = map[string][]tradePath{
	"api.binance.com": {
		{http.MethodPost, "/api/v3/order", opPlace},    // 现货下单
		{http.MethodDelete, "/api/v3/order", opCancel}, // 现货撤单
		{http.MethodGet, "/api/v3/order", opQuery},     // 现货查单（按 origClientOrderId）
	},
	"fapi.binance.com": {
		{http.MethodPost, "/fapi/v1/order", opPlace},    // U 本位永续下单
		{http.MethodDelete, "/fapi/v1/order", opCancel}, // U 本位永续撤单
		{http.MethodGet, "/fapi/v1/order", opQuery},     // U 本位永续查单
	},
	"www.okx.com": {
		{http.MethodPost, "/api/v5/trade/order", opPlace},         // 现货、USDT 永续下单
		{http.MethodPost, "/api/v5/trade/cancel-order", opCancel}, // 撤单
		{http.MethodGet, "/api/v5/trade/order", opQuery},          // 查单（按 clOrdId）
	},
	"testnet.binance.vision": {
		{http.MethodPost, "/api/v3/order", opPlace},
		{http.MethodDelete, "/api/v3/order", opCancel},
		{http.MethodGet, "/api/v3/order", opQuery},
	},
	"testnet.binancefuture.com": {
		{http.MethodPost, "/fapi/v1/order", opPlace},
		{http.MethodDelete, "/fapi/v1/order", opCancel},
		{http.MethodGet, "/fapi/v1/order", opQuery},
	},
}

// brokerHosts 是一家交易所的域名（令牌只对自己账户那家交易所有效）。
var brokerHosts = map[string][]string{
	"Binance": {"api.binance.com", "fapi.binance.com", "testnet.binance.vision", "testnet.binancefuture.com"},
	"OKX":     {"www.okx.com"},
}

// grantScope 是令牌的范围。
type grantScope int

const (
	scopeManage grantScope = iota + 1 // 撤单、查单：Key 仍然没有提币、划转权限就发
	scopePlace                        // 下单（含撤单、查单）：实盘闸门五项逐笔现查全过才发
)

// grantTTL 是一张令牌最长有效多久（一次下单、一轮撤单在这之内做完）。
const grantTTL = 2 * time.Minute

// tradeGrant 是闸门发的一次性令牌。字段都不导出，指针本身要在登记表里才算数（自己构造一个不管用）。
type tradeGrant struct {
	scope     grantScope
	accountID string
	broker    string
	expires   time.Time
}

type tradeGrantKey struct{}

var grants = struct {
	sync.Mutex
	live map[*tradeGrant]bool
}{live: map[*tradeGrant]bool{}}

// issueTradeGrant 签发一张令牌，回带令牌的 ctx 和作废函数（调用结束必须作废）。只许 liveTrader.withGate 调。
func issueTradeGrant(ctx context.Context, scope grantScope, accountID, broker string) (context.Context, func()) {
	g := &tradeGrant{scope: scope, accountID: accountID, broker: broker, expires: time.Now().Add(grantTTL)}
	grants.Lock()
	grants.live[g] = true
	grants.Unlock()
	return context.WithValue(ctx, tradeGrantKey{}, g), func() {
		grants.Lock()
		delete(grants.live, g)
		grants.Unlock()
	}
}

// liveGrants 是现在有效的令牌数（测试看用完有没有作废）。
func liveGrants() int {
	grants.Lock()
	defer grants.Unlock()
	return len(grants.live)
}

// tradeAllowed 判断一个写请求能不能发：ctx 里有登记过、没过期的令牌，令牌的交易所有这个域名，
// 方法 + 路径在放行清单里，令牌范围允许这一种操作。
func tradeAllowed(ctx context.Context, method string, u *url.URL) bool {
	if ctx == nil || u == nil {
		return false
	}
	g, _ := ctx.Value(tradeGrantKey{}).(*tradeGrant)
	if g == nil {
		return false
	}
	grants.Lock()
	ok := grants.live[g]
	grants.Unlock()
	if !ok || time.Now().After(g.expires) {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if !slices.Contains(brokerHosts[g.broker], host) {
		return false
	}
	for _, p := range exchangeTradePaths[host] {
		if p.Method == method && p.Path == u.Path {
			return p.Op != opPlace || g.scope == scopePlace
		}
	}
	return false
}

/* ---------- 下单适配器 ---------- */

// liveInst 是一个实盘标的在交易所那边的写法。
type liveInst struct {
	Symbol string // 插件里的标的：BINANCE:BTCUSDT、BINANCE:BTCUSDT.P、OKX:BTC-USDT、OKX:BTC-USDT-SWAP
	Code   string // 交易所的代码：BTCUSDT、BTC-USDT-SWAP
	Kind   string // spot / perp
}

// exOrder 是发给交易所的一笔委托（已经按交易规则取整过）。
type exOrder struct {
	ClientID   string // Binance newClientOrderId、OKX clOrdId
	Side       string // buy / sell
	Type       string // market / limit
	Qty        fx     // Binance 是币数量；OKX 现货是币数量，OKX 永续是张数
	Price      fx     // 限价单的委托价，市价单为 0
	ReduceOnly bool
	TdMode     string // OKX：cash（现货）/ cross / isolated（永续，按交易所现在的保证金模式）
}

// exOrderState 是交易所那边一笔委托的情况。
type exOrderState struct {
	OrderID  string
	ClientID string
	Status   string // open / partial / filled / canceled / rejected
	Raw      string // 交易所的原始状态（NEW、PARTIALLY_FILLED、live、partially_filled 等）
	Filled   fx
	AvgPrice fx
	Fee      fx
	Reason   string
}

// terminal 是委托到了终态（不会再成交）。
func terminalStatus(st string) bool {
	return st == orderFilled || st == orderCanceled || st == orderRejected
}

// errOrderNotFound：交易所按 clientOrderId 查不到这笔委托（Binance -2013，OKX 51603）。
var errOrderNotFound = errors.New("交易所没有这笔委托")

// exRejectError：交易所明确拒了这笔委托（参数、余额、风控），没有下成。
type exRejectError struct{ msg string }

func (e *exRejectError) Error() string { return e.msg }

// exUnknownError：请求可能到了交易所但结果不明（超时、5xx、交易所回「状态未知」）。下单时要查单确认，不能重发。
type exUnknownError struct{ msg string }

func (e *exUnknownError) Error() string { return e.msg }

// perpSetup 是永续下单前要知道的账户设置（只读查来的，实盘不改交易所的杠杆和模式）。
type perpSetup struct {
	Leverage int
	Hedge    bool   // 双向持仓：不支持
	MgnMode  string // OKX：cross / isolated
}

// exchangeTrader 是一家交易所的下单适配器：只有取规则、看永续设置、下单、查单、撤单、列挂单，没有也不许加改单、调杠杆、划转、提币。
// Place、Cancel、Query 只能在闸门令牌的 ctx 里调（readOnlyTransport 拦着）。
type exchangeTrader interface {
	// Inst 把插件的标的换成交易所的写法；不是这家交易所的、不是现货或 USDT 永续的回 false。
	Inst(symbol string) (liveInst, bool)
	// Rules 取公开的交易规则（只读 GET，不签名）。
	Rules(ctx context.Context, s *exSession, in liveInst) (symbolRules, error)
	// Perp 查永续现在的杠杆和持仓模式（只读）。
	Perp(ctx context.Context, s *exSession, in liveInst, k KeyPerms) (perpSetup, error)
	Place(ctx context.Context, s *exSession, in liveInst, o exOrder) (exOrderState, error)
	Query(ctx context.Context, s *exSession, in liveInst, clientID string) (exOrderState, error)
	Cancel(ctx context.Context, s *exSession, in liveInst, clientID, orderID string) (exOrderState, error)
	// OpenOrders 列账户在交易所的全部挂单（只读，全停撤单用）。
	OpenOrders(ctx context.Context, s *exSession, k KeyPerms) ([]LiveOrder, error)
}

/* ---------- 交易规则：精度和最小量 ---------- */

// symbolRules 是一个标的在交易所的下单规则（公开的 exchangeInfo / instruments），0 表示交易所没给这条限制。
type symbolRules struct {
	Tick        fx // 价格最小变动（Binance PRICE_FILTER.tickSize、OKX tickSz）
	MinPrice    fx
	MaxPrice    fx
	Step        fx // 数量步长（Binance LOT_SIZE.stepSize、OKX lotSz）
	MinQty      fx // 最小数量（Binance LOT_SIZE.minQty、OKX minSz）
	MaxQty      fx
	MktStep     fx // 市价单的数量步长（Binance MARKET_LOT_SIZE），0 用 Step
	MktMinQty   fx
	MktMaxQty   fx
	MinNotional fx   // 最小金额（Binance NOTIONAL / MIN_NOTIONAL）
	NotionalMkt bool // 最小金额对市价单也生效
	CtVal       fx   // OKX 永续的合约面值（张数 × 面值 = 币数量），别的为 0
	Trading     bool // 交易所这个标的现在能交易
}

// fitOrder 按交易规则取整并检查：数量按步长向下取整，限价按 tick 往对用户不利的反方向取整（买向下、卖向上，不会比填的价更差），
// 不满足最小量、最小金额、价格区间的在本地拒绝，回原因。ref 是市价单估金额用的参考价。
func (r symbolRules) fitOrder(side, typ string, qty, price, ref fx) (fx, fx, error) {
	if !r.Trading {
		return 0, 0, errors.New("交易所这个标的现在不能交易")
	}
	step, minQ, maxQ := r.Step, r.MinQty, r.MaxQty
	if typ == "market" {
		if r.MktStep > 0 {
			step = r.MktStep
		}
		if r.MktMinQty > 0 {
			minQ = max(minQ, r.MktMinQty)
		}
		if r.MktMaxQty > 0 && (maxQ == 0 || r.MktMaxQty < maxQ) {
			maxQ = r.MktMaxQty
		}
	}
	q := qty
	if step > 0 {
		q = floorLot(qty, step)
	}
	if q <= 0 {
		return 0, 0, fmt.Errorf("数量 %s 按交易所的数量步长 %s 取整后为 0", qty, step)
	}
	if minQ > 0 && q < minQ {
		return 0, 0, fmt.Errorf("数量 %s 小于交易所的最小下单量 %s", q, minQ)
	}
	if maxQ > 0 && q > maxQ {
		return 0, 0, fmt.Errorf("数量 %s 超过交易所的单笔上限 %s", q, maxQ)
	}
	px := price
	if typ == "limit" {
		if px <= 0 {
			return 0, 0, errors.New("限价单要填委托价")
		}
		if r.Tick > 0 {
			fl := floorLot(px, r.Tick)
			if side == "sell" && fl < px {
				fl += r.Tick
			}
			px = fl
		}
		if px <= 0 {
			return 0, 0, fmt.Errorf("委托价 %s 按交易所的价格精度 %s 取整后为 0", price, r.Tick)
		}
		if r.MinPrice > 0 && px < r.MinPrice {
			return 0, 0, fmt.Errorf("委托价 %s 低于交易所允许的最低价 %s", px, r.MinPrice)
		}
		if r.MaxPrice > 0 && px > r.MaxPrice {
			return 0, 0, fmt.Errorf("委托价 %s 高于交易所允许的最高价 %s", px, r.MaxPrice)
		}
	}
	if r.MinNotional > 0 && (typ == "limit" || r.NotionalMkt) {
		ep := px
		if typ == "market" {
			ep = ref
		}
		mult := fx(fxScale)
		if r.CtVal > 0 {
			mult = r.CtVal
		}
		n, err := fxMul3(q, ep, mult)
		if err != nil {
			return 0, 0, errors.New("金额太大")
		}
		if ep > 0 && n < r.MinNotional {
			return 0, 0, fmt.Errorf("金额约 %s 低于交易所的最小下单金额 %s", n, r.MinNotional)
		}
	}
	return q, px, nil
}

// rulesCache 缓存交易规则（公开数据，变得很慢）：同一个标的 rulesTTL 内不重复取。闸门的五项从不缓存。
type rulesCache struct {
	mu sync.Mutex
	m  map[string]cachedRules
}

type cachedRules struct {
	r  symbolRules
	at time.Time
}

const rulesTTL = 10 * time.Minute

func (c *rulesCache) get(key string, now time.Time) (symbolRules, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	x, ok := c.m[key]
	if !ok || now.Sub(x.at) > rulesTTL {
		return symbolRules{}, false
	}
	return x.r, true
}

func (c *rulesCache) put(key string, r symbolRules, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]cachedRules{}
	}
	c.m[key] = cachedRules{r: r, at: now}
}
