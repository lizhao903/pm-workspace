package trade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
)

// Binance 账户接入（TRD-07a 只读，TRD-08d 下单在 exchange_binance_trade.go）：现货走 api.binance.com，U 本位合约走 fapi.binance.com，
// 读只调 exchangeReadPaths 里的 GET；连接器选了测试网时现货走 testnet.binance.vision、合约走 testnet.binancefuture.com。
// 签名按 Binance 文档：查询串（含 timestamp、recvWindow）用 Secret 做 HMAC-SHA256，十六进制放 signature；API Key 放 X-MBX-APIKEY 头。
// 权限按 /sapi/v1/account/apiRestrictions：enableWithdrawals（提币）、enableInternalTransfer（内部划转）、
// permitsUniversalTransfer（万向划转）任一为真都拒绝接入；enableSpotAndMarginTrading、enableFutures、enableMargin 等算交易权限（只当只读用）。
type binanceAccount struct {
	SpotBase string // 默认 https://api.binance.com
	PerpBase string // 默认 https://fapi.binance.com
}

func newBinanceAccount() *binanceAccount {
	return &binanceAccount{SpotBase: "https://api.binance.com", PerpBase: "https://fapi.binance.com"}
}

func (b *binanceAccount) Tool() string   { return BinanceAccountTool }
func (b *binanceAccount) Broker() string { return "Binance" }
func (b *binanceAccount) Desc() string {
	return "Binance 交易账户：同步现货余额、U 本位合约持仓、挂单和成交历史，用来对账。在币安「API 管理」创建 Key：只读就只勾「允许读取」；" +
		"要实盘下单再勾现货 / 合约交易。不要勾提币和划转（带了会拒绝接入），建议绑 IP 白名单。实盘下单要过实盘评审、授予 trade:live、打开实盘开关，" +
		"账户接入时选「读取 + 交易」，每笔都在下单时现查这些条件"
}

// testnet 是连接器选了测试网（env = testnet）。
func isTestnet(s *exSession) bool { return s != nil && s.cfg.Get("env") == "testnet" }

// envField 是「网络」：正式网或测试网（测试网的资金不是真钱，只给联调用）。
var envField = connector.Field{Key: "env", Label: "网络", Kind: "select", Options: []string{"mainnet", "testnet"}, Default: "mainnet",
	Placeholder: "mainnet 正式网；testnet 测试网（Binance 现货测试网、OKX 模拟盘），只给联调用"}

func (b *binanceAccount) Fields() []connector.Field {
	return []connector.Field{
		{Key: "api_key", Label: "API Key", Kind: "secret", Placeholder: "币安「API 管理」里的 API Key", Required: true},
		{Key: "api_secret", Label: "API Secret", Kind: "secret", Placeholder: "创建时只显示一次的 Secret Key", Required: true},
		envField,
	}
}

// spot、perp 是这次调用用的现货、合约地址：测试网换成测试网的域名。
func (b *binanceAccount) spot(s *exSession) string {
	if isTestnet(s) {
		return "https://testnet.binance.vision"
	}
	return b.SpotBase
}

func (b *binanceAccount) perp(s *exSession) string {
	if isTestnet(s) {
		return "https://testnet.binancefuture.com"
	}
	return b.PerpBase
}

// binanceErrBody 认 Binance 的错误体 {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}。
func binanceErrBody(status int, body []byte) *ExchangeError {
	var e struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	_ = json.Unmarshal(body, &e)
	out := &ExchangeError{Broker: "Binance", Status: status, Msg: e.Msg}
	if e.Code != 0 {
		out.Code = strconv.Itoa(e.Code)
	}
	switch e.Code {
	case -2014, -2015, -1022, -2008: // API Key 格式不对、Key / IP / 权限不对、签名不对、Key 不存在
		out.Auth = true
	}
	if out.Msg == "" {
		out.Msg = strings.TrimSpace(string(body[:min(len(body), 200)]))
	}
	return out
}

// get 发一个签名的只读 GET。
func (b *binanceAccount) get(ctx context.Context, s *exSession, base, path string, q url.Values, out any) error {
	return b.signed(ctx, s, http.MethodGet, base, path, q, out)
}

// signed 发一个签名请求：参数（含 timestamp、recvWindow）都放查询串，签名算在整个查询串上，body 为空。
// recvWindow 5 秒：请求晚到超过 5 秒交易所直接拒，下单状态未知时据此判断「查不到 = 没下成」。
func (b *binanceAccount) signed(ctx context.Context, s *exSession, method, base, path string, q url.Values, out any) error {
	if q == nil {
		q = url.Values{}
	}
	q.Set("recvWindow", "5000")
	q.Set("timestamp", strconv.FormatInt(s.now.UnixMilli(), 10))
	query := q.Encode()
	sig := binanceSign(s.cfg.Secret("api_secret"), query)
	h := http.Header{}
	h.Set("X-MBX-APIKEY", s.cfg.Secret("api_key"))
	body, err := exDo(ctx, s.http, "Binance", method, base+path+"?"+query+"&signature="+sig, h, "", binanceErrBody)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("Binance %s 响应不是预期的 JSON", path)
	}
	return nil
}

func (b *binanceAccount) Perms(ctx context.Context, s *exSession) (KeyPerms, error) {
	var r struct {
		IPRestrict                   bool `json:"ipRestrict"`
		EnableReading                bool `json:"enableReading"`
		EnableSpotAndMarginTrading   bool `json:"enableSpotAndMarginTrading"`
		EnableWithdrawals            bool `json:"enableWithdrawals"`
		EnableInternalTransfer       bool `json:"enableInternalTransfer"`
		EnableMargin                 bool `json:"enableMargin"`
		EnableFutures                bool `json:"enableFutures"`
		PermitsUniversalTransfer     bool `json:"permitsUniversalTransfer"`
		EnableVanillaOptions         bool `json:"enableVanillaOptions"`
		EnablePortfolioMarginTrading bool `json:"enablePortfolioMarginTrading"`
	}
	if isTestnet(s) {
		// 测试网没有 /sapi/ 权限接口：按「读取 + 现货交易、没有提币和划转」算（测试网的资金不是真钱）。
		// U 本位合约测试网的域名内核的 network:exchanges 还没放行，测试网先只有现货。
		return KeyPerms{Read: true, Trade: true, SpotTrade: true, Testnet: true}, nil
	}
	if err := b.get(ctx, s, b.SpotBase, "/sapi/v1/account/apiRestrictions", nil, &r); err != nil {
		return KeyPerms{}, err
	}
	k := KeyPerms{Read: r.EnableReading, Withdraw: r.EnableWithdrawals, Futures: r.EnableFutures, IPRestricted: r.IPRestrict, SpotTrade: r.EnableSpotAndMarginTrading,
		Trade: r.EnableSpotAndMarginTrading || r.EnableFutures || r.EnableMargin || r.EnableVanillaOptions || r.EnablePortfolioMarginTrading}
	if r.EnableInternalTransfer {
		k.Transfer = append(k.Transfer, "内部划转")
	}
	if r.PermitsUniversalTransfer {
		k.Transfer = append(k.Transfer, "万向划转")
	}
	return k, nil
}

func (b *binanceAccount) Snapshot(ctx context.Context, s *exSession, k KeyPerms, cursors map[string]string, since time.Time, track []string) (liveSnapshot, error) {
	out := liveSnapshot{Cursors: map[string]string{}}
	for key, v := range cursors {
		out.Cursors[key] = v
	}
	// 现货余额
	var acct struct {
		Balances []struct {
			Asset  string `json:"asset"`
			Free   string `json:"free"`
			Locked string `json:"locked"`
		} `json:"balances"`
	}
	if err := b.get(ctx, s, b.spot(s), "/api/v3/account", url.Values{"omitZeroBalances": {"true"}}, &acct); err != nil {
		return out, err
	}
	spotSyms := map[string]bool{}
	for _, x := range acct.Balances {
		free, locked := mustFx(x.Free), mustFx(x.Locked)
		total := free + locked
		if total == 0 {
			continue
		}
		asset := strings.ToUpper(x.Asset)
		bal := LiveBalance{Asset: asset, Free: free.Float(), Locked: locked.Float(), Total: total.Float(), Wallet: "spot", total: total}
		if px, ok := s.mark(asset); ok {
			v, _ := fxMul(total, px)
			bal.Value = v.Float()
			out.Equity += v
		} else {
			out.Stale = true
		}
		if asset == "USDT" {
			out.Available += free
		}
		out.Balances = append(out.Balances, bal)
		if !isStable(asset) {
			sym := "BINANCE:" + asset + "USDT"
			spotSyms[asset+"USDT"] = true
			pos := LivePosition{Symbol: sym, Name: asset + "/USDT", Kind: "spot", Side: "long", Qty: total.Float(), Key: spotKey(asset), qty: total}
			if in, ok := s.inst(sym); ok {
				pos.Name = in.Name
			}
			if px, ok := s.mark(asset); ok {
				pos.Last = px.Float()
			}
			out.Positions = append(out.Positions, pos)
		}
	}
	// 现货挂单
	var spotOrders []binanceOrder
	if err := b.get(ctx, s, b.spot(s), "/api/v3/openOrders", nil, &spotOrders); err != nil {
		return out, err
	}
	for _, o := range spotOrders {
		out.Orders = append(out.Orders, o.live("BINANCE:"+o.Symbol))
		spotSyms[o.Symbol] = true
	}
	// U 本位合约（Key 有合约权限才读）
	perpSyms := map[string]bool{}
	if k.Futures {
		var fa struct {
			TotalMarginBalance string `json:"totalMarginBalance"`
			AvailableBalance   string `json:"availableBalance"`
			TotalInitialMargin string `json:"totalInitialMargin"`
		}
		if err := b.get(ctx, s, b.perp(s), "/fapi/v2/account", nil, &fa); err != nil {
			return out, err
		}
		out.Equity += mustFx(fa.TotalMarginBalance)
		out.Available += mustFx(fa.AvailableBalance)
		out.Margin += mustFx(fa.TotalInitialMargin)
		if eq := mustFx(fa.TotalMarginBalance); eq != 0 {
			out.Balances = append(out.Balances, LiveBalance{Asset: "USDT", Free: mustFx(fa.AvailableBalance).Float(), Total: eq.Float(), Value: eq.Float(), Wallet: "futures", total: eq})
		}
		var pr []struct {
			Symbol           string `json:"symbol"`
			PositionAmt      string `json:"positionAmt"`
			EntryPrice       string `json:"entryPrice"`
			MarkPrice        string `json:"markPrice"`
			UnRealizedProfit string `json:"unRealizedProfit"`
			LiquidationPrice string `json:"liquidationPrice"`
			Leverage         string `json:"leverage"`
			PositionSide     string `json:"positionSide"`
			IsolatedMargin   string `json:"isolatedMargin"`
			Notional         string `json:"notional"`
		}
		if err := b.get(ctx, s, b.perp(s), "/fapi/v2/positionRisk", nil, &pr); err != nil {
			return out, err
		}
		for _, x := range pr {
			q := mustFx(x.PositionAmt)
			if q == 0 {
				continue
			}
			sym := "BINANCE:" + x.Symbol + ".P"
			key := sym
			if ps := strings.ToLower(x.PositionSide); ps == "long" || ps == "short" {
				key += "#" + ps
			}
			side := "long"
			if q < 0 {
				side = "short"
			}
			lev, _ := strconv.Atoi(x.Leverage)
			pos := LivePosition{Symbol: sym, Name: x.Symbol + " 永续", Kind: "perp", Side: side, Qty: q.abs().Float(), AvgPrice: mustFx(x.EntryPrice).Float(),
				LiqPrice: optFloat(mustFx(x.LiquidationPrice)), Last: mustFx(x.MarkPrice).Float(), PnL: mustFx(x.UnRealizedProfit).Float(), Key: key, qty: q}
			if lev > 0 {
				pos.Leverage = &lev
				if m := mustFx(x.IsolatedMargin); m != 0 {
					pos.Margin = m.Float()
				} else {
					pos.Margin = mustFx(x.Notional).abs().Float() / float64(lev)
				}
			}
			if in, ok := s.inst(sym); ok {
				pos.Name = in.Name
			}
			out.Positions = append(out.Positions, pos)
			perpSyms[x.Symbol] = true
		}
		var po []binanceOrder
		if err := b.get(ctx, s, b.perp(s), "/fapi/v1/openOrders", nil, &po); err != nil {
			return out, err
		}
		for _, o := range po {
			out.Orders = append(out.Orders, o.live("BINANCE:"+o.Symbol+".P"))
			perpSyms[o.Symbol] = true
		}
	}
	// 本地记录里有、这次交易所没返回的标的也要拉成交（卖光了、平掉了）
	for _, key := range track {
		switch {
		case strings.HasPrefix(key, "spot:"):
			if a := strings.TrimPrefix(key, "spot:"); !isStable(a) {
				spotSyms[a+"USDT"] = true
			}
		case strings.HasPrefix(key, "BINANCE:") && strings.Contains(key, ".P"):
			code, _, _ := strings.Cut(strings.TrimPrefix(key, "BINANCE:"), ".P")
			if k.Futures {
				perpSyms[code] = true
			}
		case strings.HasPrefix(key, "BINANCE:"):
			spotSyms[strings.TrimPrefix(key, "BINANCE:")] = true
		}
	}
	// 成交：每个标的按成交号游标接着拉
	for _, sym := range sortedKeys(spotSyms) {
		fs, cur, err := b.trades(ctx, s, b.spot(s), "/api/v3/myTrades", "spot:"+sym, sym, out.Cursors["spot:"+sym], since)
		if err != nil {
			return out, err
		}
		for _, f := range fs {
			out.Fills = append(out.Fills, f.spotFill("BINANCE:"+sym, strings.TrimSuffix(sym, "USDT")))
		}
		if cur != "" {
			out.Cursors["spot:"+sym] = cur
		}
	}
	for _, sym := range sortedKeys(perpSyms) {
		fs, cur, err := b.trades(ctx, s, b.perp(s), "/fapi/v1/userTrades", "perp:"+sym, sym, out.Cursors["perp:"+sym], since)
		if err != nil {
			return out, err
		}
		for _, f := range fs {
			out.Fills = append(out.Fills, f.perpFill("BINANCE:"+sym+".P"))
		}
		if cur != "" {
			out.Cursors["perp:"+sym] = cur
		}
	}
	sort.SliceStable(out.Fills, func(i, j int) bool { return out.Fills[i].At < out.Fills[j].At })
	return out, nil
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

type binanceOrder struct {
	Symbol      string `json:"symbol"`
	OrderID     int64  `json:"orderId"`
	Price       string `json:"price"`
	OrigQty     string `json:"origQty"`
	ExecutedQty string `json:"executedQty"`
	Status      string `json:"status"`
	Type        string `json:"type"`
	Side        string `json:"side"`
	StopPrice   string `json:"stopPrice"`
	Time        int64  `json:"time"`
}

func (o binanceOrder) live(sym string) LiveOrder {
	st := "open"
	if o.Status == "PARTIALLY_FILLED" {
		st = "partial"
	}
	q, px, filled := mustFx(o.OrigQty), mustFx(o.Price), mustFx(o.ExecutedQty)
	return LiveOrder{ID: strconv.FormatInt(o.OrderID, 10), Symbol: sym, Side: strings.ToLower(o.Side), Type: strings.ToLower(o.Type), Qty: q.Float(),
		Price: optFloat(px), StopPrice: optFloat(mustFx(o.StopPrice)), Filled: filled.Float(), Status: st, CreatedAt: msStamp(o.Time),
		qty: q, price: px, filled: filled}
}

type binanceTrade struct {
	ID              int64  `json:"id"`
	OrderID         int64  `json:"orderId"`
	Price           string `json:"price"`
	Qty             string `json:"qty"`
	Commission      string `json:"commission"`
	CommissionAsset string `json:"commissionAsset"`
	Time            int64  `json:"time"`
	IsBuyer         bool   `json:"isBuyer"`
	Side            string `json:"side"`         // 合约
	PositionSide    string `json:"positionSide"` // 合约
}

// trades 拉一个标的游标之后的成交；没有游标时从 since 开始。回新的游标（最大成交号）。
func (b *binanceAccount) trades(ctx context.Context, s *exSession, base, path, _, sym, cursor string, since time.Time) ([]binanceTrade, string, error) {
	q := url.Values{"symbol": {sym}, "limit": {"1000"}}
	if n, err := strconv.ParseInt(cursor, 10, 64); err == nil && cursor != "" {
		q.Set("fromId", strconv.FormatInt(n+1, 10))
	} else {
		q.Set("startTime", strconv.FormatInt(since.UnixMilli(), 10))
	}
	var out []binanceTrade
	if err := b.get(ctx, s, base, path, q, &out); err != nil {
		var ee *ExchangeError
		// 交易所没有这个交易对（比如没有 <币种>USDT）：这个标的不拉成交
		if errors.As(err, &ee) && (ee.Code == "-1121" || ee.Code == "-1122") {
			return nil, cursor, nil
		}
		return nil, cursor, err
	}
	cur := cursor
	for _, t := range out {
		if n, _ := strconv.ParseInt(cur, 10, 64); t.ID > n || cur == "" {
			cur = strconv.FormatInt(t.ID, 10)
		}
	}
	return out, cur, nil
}

func (t binanceTrade) spotFill(sym, base string) LiveFill {
	q := mustFx(t.Qty)
	side := "sell"
	if t.IsBuyer {
		side = "buy"
	}
	signed := q
	if side == "sell" {
		signed = -q
	}
	fee := mustFx(t.Commission)
	f := LiveFill{ID: "spot:" + strings.TrimPrefix(sym, "BINANCE:") + ":" + strconv.FormatInt(t.ID, 10), OrderID: strconv.FormatInt(t.OrderID, 10), Symbol: sym, Side: side, Qty: q.Float(),
		Price: mustFx(t.Price).Float(), Fee: fee.Float(), FeeAsset: strings.ToUpper(t.CommissionAsset), At: msStamp(t.Time),
		key: spotKey(base), qty: signed, fee: -fee}
	if f.FeeAsset != "" && !isStable(f.FeeAsset) {
		f.feeKey = spotKey(f.FeeAsset)
	}
	return f
}

func (t binanceTrade) perpFill(sym string) LiveFill {
	q := mustFx(t.Qty)
	side := strings.ToLower(t.Side)
	signed := q
	if side == "sell" {
		signed = -q
	}
	key := sym
	if ps := strings.ToLower(t.PositionSide); ps == "long" || ps == "short" {
		key += "#" + ps
	}
	return LiveFill{ID: "perp:" + strings.TrimPrefix(sym, "BINANCE:") + ":" + strconv.FormatInt(t.ID, 10), OrderID: strconv.FormatInt(t.OrderID, 10), Symbol: sym, Side: side, Qty: q.Float(),
		Price: mustFx(t.Price).Float(), Fee: mustFx(t.Commission).Float(), FeeAsset: strings.ToUpper(t.CommissionAsset), At: msStamp(t.Time),
		key: key, qty: signed}
}
