package trade

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 交易所账户接入（TRD-07a 只读，TRD-08d 加实盘下单）：连接器 binance_account、okx_account，凭证（API Key、Secret，OKX 加 Passphrase）
// 经内核连接器框架进保险箱，插件只在 Core.Connectors().With 的回调里拿到明文，用完即丢。
//
// 资金边界（硬约束）：
//   - 永不提币、永不划转：没有任何提币、划转、借贷、万向划转、子账户划转的代码路径；trade_test.go 的 TestExchangeWriteBoundary 扫源码盯着。
//   - 只读接口（Key 权限、余额、持仓、挂单查询、成交历史、公开的交易规则）是 exchangeReadPaths，只能 GET。
//   - 写操作只有下单、撤单、查单三种，是 exchangeTradePaths（按交易所、方法列，exchange_trade.go），范围最小；
//     而且只有带着实盘闸门（livetrade.go 的 withGate）发的令牌的请求才放行：令牌只在那一次调用的 ctx 里，
//     下单令牌要五项闸门逐笔现查全过，撤单查单令牌只要 Key 仍然没有提币、划转权限。
//     出网客户端外面包一层 readOnlyTransport：只读清单之外、没有令牌或令牌不允许的请求一律不发出去。
//   - Key 带提币权限（或能把资金转出这个账户的划转权限）直接拒绝接入；同步时发现了，账户立刻停用、写审计；闸门也不再给它发任何令牌。
//   - 错误文本里不带 Secret、签名和带签名的地址：exchangeErr 只留路径，scrubSecrets 再抹一遍。

// 连接器 tool
const (
	BinanceAccountTool = "binance_account"
	OKXAccountTool     = "okx_account"
)

// exchangeReadPaths 是交易所只读接口的全部路径（host -> 路径），只能 GET。加一个路径要同时改 trade_test.go 里的期望清单。
// 测试网（连接器选「测试网」）的域名用同样的路径：testnet.binance.vision 是 Binance 现货测试网（没有 /sapi/ 权限接口），
// testnet.binancefuture.com 是 U 本位合约测试网；OKX 模拟盘和实盘同一个域名，请求头带 x-simulated-trading: 1。
var exchangeReadPaths = map[string][]string{
	"api.binance.com": {
		"/sapi/v1/account/apiRestrictions", // Key 的权限
		"/api/v3/account",                  // 现货余额
		"/api/v3/openOrders",               // 现货挂单（查询）
		"/api/v3/myTrades",                 // 现货成交历史
		"/api/v3/exchangeInfo",             // 公开的交易规则（tickSize、stepSize、minNotional），TRD-08d
	},
	"fapi.binance.com": {
		"/fapi/v2/account",      // U 本位合约账户
		"/fapi/v2/positionRisk", // U 本位合约持仓（下单前也用它看杠杆和持仓模式）
		"/fapi/v1/openOrders",   // U 本位合约挂单（查询）
		"/fapi/v1/userTrades",   // U 本位合约成交历史
		"/fapi/v1/exchangeInfo", // 公开的交易规则，TRD-08d
	},
	"www.okx.com": {
		"/api/v5/account/config",        // 账户配置，含 Key 的权限 perm、持仓模式 posMode
		"/api/v5/account/balance",       // 余额
		"/api/v5/account/positions",     // 持仓
		"/api/v5/trade/orders-pending",  // 未成交委托（查询）
		"/api/v5/trade/fills",           // 近三天成交明细（查询）
		"/api/v5/public/instruments",    // 公开的交易规则（tickSz、lotSz、minSz、ctVal），TRD-08d
		"/api/v5/account/leverage-info", // 永续现在的杠杆（实盘不改杠杆，只读来过风控），TRD-08d
	},
	"testnet.binance.vision": {
		"/api/v3/account", "/api/v3/openOrders", "/api/v3/myTrades", "/api/v3/exchangeInfo",
	},
	"testnet.binancefuture.com": {
		"/fapi/v2/account", "/fapi/v2/positionRisk", "/fapi/v1/openOrders", "/fapi/v1/userTrades", "/fapi/v1/exchangeInfo",
	},
}

// errNotReadOnly：要发的请求不是只读接口，也没有实盘闸门放行，没有发出去。
var errNotReadOnly = errors.New("交易插件只允许调交易所的只读接口；下单、撤单、查单只能经实盘闸门放行")

// readOnlyTransport 包在内核的出网客户端外面：只放行 GET 且 host + 路径在 exchangeReadPaths 里的，
// 或者 ctx 里带着实盘闸门发的、仍然有效的令牌、且方法 + host + 路径在 exchangeTradePaths 里、令牌的范围允许这一种操作的（tradeAllowed）。
// 内核的域名检查（network:exchanges）在里面那层照样做。
type readOnlyTransport struct{ base http.RoundTripper }

func readOnlyAllowed(method string, u *url.URL) bool {
	if method != http.MethodGet || u == nil {
		return false
	}
	paths, ok := exchangeReadPaths[strings.ToLower(u.Hostname())]
	return ok && slices.Contains(paths, u.Path)
}

func (t readOnlyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !readOnlyAllowed(req.Method, req.URL) && !tradeAllowed(req.Context(), req.Method, req.URL) {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, fmt.Errorf("%w：%s %s%s", errNotReadOnly, req.Method, req.URL.Host, req.URL.Path)
	}
	return t.base.RoundTrip(req)
}

// readOnlyClient 把内核给的客户端包上只读检查（重定向的每一跳也过 RoundTrip）。
func readOnlyClient(hc *http.Client) *http.Client {
	c := *hc
	base := hc.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	c.Transport = readOnlyTransport{base: base}
	return &c
}

// KeyPerms 是一把 Key 在交易所那边的权限。
type KeyPerms struct {
	Read  bool
	Trade bool
	// SpotTrade 是现货交易权限（Binance enableSpotAndMarginTrading；OKX 的 trade 现货、永续都管，同 Trade）
	SpotTrade bool
	Withdraw  bool
	// Transfer 是能把资金转出这个账户的划转权限（Binance 的内部划转、万向划转），和提币同样拒绝
	Transfer []string
	// Futures 是 Binance 的 U 本位合约权限（有才去读合约账户）；OKX 统一账户恒为真
	Futures bool
	// IPRestricted 是 Key 绑了 IP 白名单
	IPRestricted bool
	// Hedge 是合约账户开了双向持仓（OKX posMode long_short_mode）：实盘下单只支持单向持仓
	Hedge bool
	// Testnet 是测试网的连接器：Binance 测试网没有权限查询接口，按「读取 + 交易、没有提币」算（测试网的资金不是真钱）
	Testnet bool
}

// canTrade 是这把 Key 能不能交易 kind（spot / perp）的标的。
func (k KeyPerms) canTrade(kind string) bool {
	if kind == "spot" {
		return k.SpotTrade
	}
	return k.Futures && k.Trade
}

// perms 是给账户看的权限：只读 / 读取 + 交易。
func (k KeyPerms) list() []string {
	if k.Trade {
		return []string{"read", "trade"}
	}
	return []string{"read"}
}

// errWithdrawKey 是 Key 开了提币或转出资金的权限：拒绝接入、停用账户。
type errWithdrawKey struct{ What string }

func (e *errWithdrawKey) Error() string {
	return "这个 API Key 开了" + e.What + "，不能接入。到交易所关掉" + e.What + "后再试（交易套件只需要读取权限）"
}

// checkKey 判断一把 Key 能不能接入：没有读取权限、带提币或转出权限都拒绝。
func checkKey(k KeyPerms) error {
	if k.Withdraw {
		return &errWithdrawKey{What: "提币权限"}
	}
	if len(k.Transfer) > 0 {
		return &errWithdrawKey{What: strings.Join(k.Transfer, "、") + "权限"}
	}
	if !k.Read {
		return errors.New("这个 API Key 没有读取权限，读不到账户；到交易所给它勾上读取")
	}
	return nil
}

// LiveBalance 是交易所返回的一个币种的余额。
type LiveBalance struct {
	Asset  string  `json:"asset"`
	Free   float64 `json:"free"`
	Locked float64 `json:"locked"`
	Total  float64 `json:"total"`
	// Value 是折 USD 的估值（稳定币 1:1，别的按行情缓存的 <币种>USDT 现价，取不到为 0）
	Value  float64 `json:"value"`
	Wallet string  `json:"wallet"` // spot / futures / unified

	total fx
}

// LivePosition 是交易所返回的一个持仓：合约持仓，或现货里非计价币的持有（kind spot）。
type LivePosition struct {
	Symbol   string   `json:"symbol"`
	Name     string   `json:"name"`
	Kind     string   `json:"kind"` // spot / perp
	Side     string   `json:"side"` // long / short
	Qty      float64  `json:"qty"`
	AvgPrice float64  `json:"avg_price"` // 交易所给的开仓均价；现货交易所不给，为 0
	Leverage *int     `json:"leverage,omitempty"`
	LiqPrice *float64 `json:"liq_price,omitempty"`
	Last     float64  `json:"last"` // 行情缓存的现价，没有为 0
	PnL      float64  `json:"pnl"`  // 合约是交易所给的未实现盈亏；现货为 0
	Margin   float64  `json:"margin"`
	// Contracts 是 OKX 永续的张数（qty 是乘了合约面值的币数量）
	Contracts *float64 `json:"contracts,omitempty"`

	// Key 是对账用的持仓键：现货是 spot:<币种>，合约是 symbol（双向持仓加 #long / #short）
	Key string `json:"key"`
	// ID 是平仓用的持仓 id：live:<账户>:<持仓键>（快照接口才填），POST /api/trade/positions/{id}/close 认它（TRD-08d）
	ID        string `json:"id,omitempty"`
	AccountID string `json:"account_id,omitempty"`

	qty fx // 带符号的数量（空为负）
}

// LiveOrder 是交易所上的一笔未成交委托。
type LiveOrder struct {
	ID        string   `json:"id"` // 交易所的委托号
	Symbol    string   `json:"symbol"`
	Side      string   `json:"side"`
	Type      string   `json:"type"`
	Qty       float64  `json:"qty"`
	Price     *float64 `json:"price,omitempty"`
	StopPrice *float64 `json:"stop_price,omitempty"`
	Filled    float64  `json:"filled"`
	Status    string   `json:"status"` // open / partial
	CreatedAt string   `json:"created_at"`
	AccountID string   `json:"account_id,omitempty"`

	qty, price, filled fx
}

// LiveFill 是交易所的一笔成交。
type LiveFill struct {
	ID       string  `json:"id"` // 交易所的成交号（Binance 现货、合约是 trade id，OKX 是 billId）
	OrderID  string  `json:"order_id"`
	Symbol   string  `json:"symbol"`
	Side     string  `json:"side"`
	Qty      float64 `json:"qty"`
	Price    float64 `json:"price"`
	Fee      float64 `json:"fee"`
	FeeAsset string  `json:"fee_asset"`
	At       string  `json:"at"`

	key      string // 改哪个持仓：spot:<币种> 或合约 symbol
	qty, fee fx     // qty 带符号（卖为负）
	feeKey   string // 手续费扣在哪个持仓上（spot:<币种>），计价币上的为空
}

// liveSnapshot 是一次只读同步拉到的全部数据。
type liveSnapshot struct {
	Balances  []LiveBalance
	Positions []LivePosition
	Orders    []LiveOrder
	Fills     []LiveFill // 新的成交（按游标），按时间正序
	Equity    fx         // 估值（USD）
	Available fx
	Margin    fx
	Stale     bool              // 有币种没估上值
	Cursors   map[string]string // 新的成交游标
}

// exSession 是一次调用的上下文：受控出网客户端、连接器配置（只在 With 回调里有效）、时钟。
type exSession struct {
	http *http.Client
	cfg  plugin.ConnectorConfig
	now  time.Time
	// mark 取一个币种折 USD 的价（行情缓存），没有回 false
	mark func(asset string) (fx, bool)
	// inst 查标的表（名称、乘数），没有回 false
	inst func(symbol string) (ledgerInst, bool)
}

// exchangeAccount 是一家交易所的只读账户适配器。接口里没有也不许加下单、撤单、划转、提币。
type exchangeAccount interface {
	Tool() string
	Broker() string // Binance / OKX
	Fields() []connector.Field
	Desc() string
	// Perms 查这把 Key 的权限。
	Perms(ctx context.Context, s *exSession) (KeyPerms, error)
	// Snapshot 拉余额、持仓、挂单，以及游标之后的成交。since 是没有游标的标的从什么时候开始拉成交。
	Snapshot(ctx context.Context, s *exSession, k KeyPerms, cursors map[string]string, since time.Time, track []string) (liveSnapshot, error)
}

// ExchangeError 是交易所回的错误。Auth 为真表示 Key 无效、过期、IP 不在白名单、没权限（不是网络抖动）。
type ExchangeError struct {
	Broker string
	Status int
	Code   string
	Msg    string
	Path   string
	Auth   bool
}

func (e *ExchangeError) Error() string {
	s := fmt.Sprintf("%s %s 返回 %d", e.Broker, e.Path, e.Status)
	if e.Code != "" {
		s += " " + e.Code
	}
	if e.Msg != "" {
		s += "：" + e.Msg
	}
	if e.Auth {
		s += "（API Key 无效、过期、IP 不在白名单或没有权限，到交易所检查后重新连接）"
	}
	return s
}

// exGet 发一个只读 GET：url 是完整地址（含签名），header 是签名头。出错时只留路径，不留查询串（里面有签名）。
func exGet(ctx context.Context, hc *http.Client, broker, rawURL string, header http.Header, decodeErr func(status int, body []byte) *ExchangeError) ([]byte, error) {
	return exDo(ctx, hc, broker, http.MethodGet, rawURL, header, "", decodeErr)
}

// exDo 发一个请求（方法、body 由调用方定；能不能发出去由 readOnlyTransport 判）。
// 请求没送到或没收到回包（网络错误、超时）回 *exNoReplyError：调用方要当成「状态未知」，不能当成失败重发。
func exDo(ctx context.Context, hc *http.Client, broker, method, rawURL string, header http.Header, body string, decodeErr func(status int, body []byte) *ExchangeError) ([]byte, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("%s 地址不对", broker)
	}
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, rd)
	if err != nil {
		return nil, fmt.Errorf("%s 地址不对", broker)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, vs := range header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "pm-workspace-trade/0.7")
	resp, err := hc.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		// 本地拦下的（没发出去）：不是「状态未知」
		if errors.Is(err, errNotReadOnly) || errors.Is(err, plugin.ErrHostNotAllowed) || errors.Is(err, plugin.ErrNotGranted) || errors.Is(err, plugin.ErrNetworkNotDeclared) {
			return nil, err
		}
		cause := err
		if ctx.Err() != nil {
			cause = ctx.Err()
		}
		return nil, &exNoReplyError{msg: fmt.Sprintf("连不上 %s（%s）：%v", broker, u.Path, cause), err: cause}
	}
	defer func() { _ = resp.Body.Close() }()
	rb, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody+1))
	if err != nil {
		return nil, &exNoReplyError{msg: fmt.Sprintf("读 %s 响应失败", broker), err: err}
	}
	if len(rb) > maxUpstreamBody {
		return nil, fmt.Errorf("%s 响应太大", broker)
	}
	if resp.StatusCode/100 != 2 {
		e := decodeErr(resp.StatusCode, rb)
		e.Path = u.Path
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			e.Auth = true
		}
		return nil, e
	}
	return rb, nil
}

// exNoReplyError：请求可能已经到了交易所，但没收到回包（网络错误、超时、读响应失败）。
// 只读接口照常当失败；下单时它表示「状态未知」，要按 clientOrderId 查单确认，不能重发。
type exNoReplyError struct {
	msg string
	err error
}

func (e *exNoReplyError) Error() string { return e.msg }
func (e *exNoReplyError) Unwrap() error { return e.err }

// binanceSign 是 Binance 的签名：HMAC-SHA256(查询串, Secret)，十六进制小写。
func binanceSign(secret, query string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(query))
	return hex.EncodeToString(m.Sum(nil))
}

// okxSign 是 OKX 的签名：Base64(HMAC-SHA256(时间戳 + 方法 + 路径（含查询串）+ body, Secret))。
func okxSign(secret, ts, method, path, body string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(ts + method + path + body))
	return base64.StdEncoding.EncodeToString(m.Sum(nil))
}

// scrubSecrets 把文本里出现的凭证明文换成 ***（错误、日志落库前再抹一遍）。
func scrubSecrets(msg string, cfg plugin.ConnectorConfig) string {
	for _, k := range []string{"api_secret", "passphrase", "api_key"} {
		if v := cfg.Secret(k); len(v) >= 4 {
			msg = strings.ReplaceAll(msg, v, "***")
		}
	}
	return msg
}

// keyHint 是 API Key 的提示：只留后四位。
func keyHint(key string) string {
	r := []rune(strings.TrimSpace(key))
	if len(r) < 8 {
		return "****"
	}
	return "****" + string(r[len(r)-4:])
}

// stableAssets 是按 1:1 折 USD 的计价币。现货里它们算余额，不算持仓；对账不比（受资金费、合约盈亏影响）。
var stableAssets = []string{"USDT", "USDC", "FDUSD", "BUSD", "TUSD", "DAI", "USD", "USDP"}

func isStable(asset string) bool { return slices.Contains(stableAssets, strings.ToUpper(asset)) }

func spotKey(asset string) string { return "spot:" + strings.ToUpper(asset) }

func optFloat(v fx) *float64 {
	if v == 0 {
		return nil
	}
	f := v.Float()
	return &f
}

func mustFx(s string) fx {
	v, err := parseFx(s)
	if err != nil {
		return 0
	}
	return v
}
