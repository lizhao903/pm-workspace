package trade

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
)

// OKX 账户接入（TRD-07a 只读，TRD-08d 下单在 exchange_okx_trade.go）：www.okx.com 的 /api/v5/account/ 和 /api/v5/trade/ 下的查询接口，只调 exchangeReadPaths 里的 GET。
// 签名按 OKX 文档：时间戳（ISO 毫秒）+ 方法 + 路径（含查询串）+ body，用 Secret 做 HMAC-SHA256 再 Base64，
// 放 OK-ACCESS-SIGN；OK-ACCESS-KEY、OK-ACCESS-PASSPHRASE、OK-ACCESS-TIMESTAMP 一起带上。
// 权限按 /api/v5/account/config 的 perm（read_only、trade、withdraw 逗号分隔）：带 withdraw 拒绝接入。
// 只接统一账户的现货持有和 USDT 本位永续（SWAP）；永续数量对账用张数，给人看时乘合约面值（行情源同步的标的表）。
type okxAccount struct {
	Base string // 默认 https://www.okx.com
}

func newOKXAccount() *okxAccount { return &okxAccount{Base: "https://www.okx.com"} }

func (o *okxAccount) Tool() string   { return OKXAccountTool }
func (o *okxAccount) Broker() string { return "OKX" }
func (o *okxAccount) Desc() string {
	return "OKX 交易账户：同步余额、永续持仓、挂单和近三天成交，用来对账。在 OKX「API」里创建 V5 Key：只读就只勾「读取」；要实盘下单再勾「交易」。" +
		"不要勾提现（带了会拒绝接入），建议绑 IP。实盘下单要过实盘评审、授予 trade:live、打开实盘开关，账户接入时选「读取 + 交易」，每笔都在下单时现查这些条件；" +
		"测试网选 testnet（OKX 模拟盘，要用模拟盘的 Key）"
}

func (o *okxAccount) Fields() []connector.Field {
	return []connector.Field{
		{Key: "api_key", Label: "API Key", Kind: "secret", Placeholder: "OKX V5 API Key", Required: true},
		{Key: "api_secret", Label: "Secret Key", Kind: "secret", Placeholder: "创建时只显示一次的 Secret Key", Required: true},
		{Key: "passphrase", Label: "Passphrase", Kind: "secret", Placeholder: "创建 Key 时自己设的口令", Required: true},
		envField,
	}
}

// okxAuthCodes 是 OKX 表示 Key 不对、过期、IP 不在白名单、没权限、签名不对的错误码。
var okxAuthCodes = map[string]bool{"50100": true, "50101": true, "50102": true, "50103": true, "50104": true, "50105": true,
	"50110": true, "50111": true, "50112": true, "50113": true, "50114": true, "50119": true, "50120": true, "50121": true}

func okxErrBody(status int, body []byte) *ExchangeError {
	var e struct {
		Code string `json:"code"`
		Msg  string `json:"msg"`
	}
	_ = json.Unmarshal(body, &e)
	out := &ExchangeError{Broker: "OKX", Status: status, Code: e.Code, Msg: e.Msg, Auth: okxAuthCodes[e.Code]}
	if out.Msg == "" {
		out.Msg = strings.TrimSpace(string(body[:min(len(body), 200)]))
	}
	return out
}

// get 发一个签名的只读 GET，解开 {code, msg, data}。
func (o *okxAccount) get(ctx context.Context, s *exSession, path string, q url.Values, data any) error {
	reqPath := path
	if len(q) > 0 {
		reqPath += "?" + q.Encode()
	}
	ts := s.now.UTC().Format("2006-01-02T15:04:05.000Z")
	h := http.Header{}
	h.Set("OK-ACCESS-KEY", s.cfg.Secret("api_key"))
	h.Set("OK-ACCESS-SIGN", okxSign(s.cfg.Secret("api_secret"), ts, http.MethodGet, reqPath, ""))
	h.Set("OK-ACCESS-TIMESTAMP", ts)
	h.Set("OK-ACCESS-PASSPHRASE", s.cfg.Secret("passphrase"))
	if isTestnet(s) {
		h.Set("x-simulated-trading", "1")
	}
	body, err := exGet(ctx, s.http, "OKX", o.Base+reqPath, h, okxErrBody)
	if err != nil {
		return err
	}
	var env struct {
		Code string          `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return fmt.Errorf("OKX %s 响应不是预期的 JSON", path)
	}
	if env.Code != "0" {
		return &ExchangeError{Broker: "OKX", Status: http.StatusOK, Code: env.Code, Msg: env.Msg, Path: path, Auth: okxAuthCodes[env.Code]}
	}
	if err := json.Unmarshal(env.Data, data); err != nil {
		return fmt.Errorf("OKX %s 响应不是预期的 JSON", path)
	}
	return nil
}

func (o *okxAccount) Perms(ctx context.Context, s *exSession) (KeyPerms, error) {
	var cfg []struct {
		Perm    string `json:"perm"`
		IP      string `json:"ip"`
		PosMode string `json:"posMode"`
	}
	if err := o.get(ctx, s, "/api/v5/account/config", nil, &cfg); err != nil {
		return KeyPerms{}, err
	}
	if len(cfg) == 0 {
		return KeyPerms{}, fmt.Errorf("OKX 没返回账户配置")
	}
	k := KeyPerms{Futures: true, IPRestricted: strings.TrimSpace(cfg[0].IP) != "", Hedge: cfg[0].PosMode == "long_short_mode", Testnet: isTestnet(s)}
	for _, p := range strings.Split(cfg[0].Perm, ",") {
		switch strings.TrimSpace(p) {
		case "read_only":
			k.Read = true
		case "trade":
			k.Trade, k.SpotTrade = true, true
		case "withdraw":
			k.Withdraw = true
		}
	}
	return k, nil
}

// okxCtVal 是永续的合约面值：标的表里 OKX 永续的乘数就是 ctVal（行情源同步标的时写的），没有按 1。
func okxCtVal(s *exSession, instID string) (fx, bool) {
	if in, ok := s.inst("OKX:" + instID); ok && in.Mult > 0 {
		return in.Mult, true
	}
	return fxScale, false
}

func (o *okxAccount) Snapshot(ctx context.Context, s *exSession, k KeyPerms, cursors map[string]string, since time.Time, _ []string) (liveSnapshot, error) {
	out := liveSnapshot{Cursors: map[string]string{}}
	for key, v := range cursors {
		out.Cursors[key] = v
	}
	var bal []struct {
		TotalEq string `json:"totalEq"`
		Imr     string `json:"imr"`
		Details []struct {
			Ccy       string `json:"ccy"`
			CashBal   string `json:"cashBal"`
			AvailBal  string `json:"availBal"`
			FrozenBal string `json:"frozenBal"`
			EqUsd     string `json:"eqUsd"`
		} `json:"details"`
	}
	if err := o.get(ctx, s, "/api/v5/account/balance", nil, &bal); err != nil {
		return out, err
	}
	if len(bal) > 0 {
		out.Equity = mustFx(bal[0].TotalEq)
		out.Margin = mustFx(bal[0].Imr)
		for _, d := range bal[0].Details {
			total := mustFx(d.CashBal)
			if total == 0 {
				continue
			}
			ccy := strings.ToUpper(d.Ccy)
			out.Balances = append(out.Balances, LiveBalance{Asset: ccy, Free: mustFx(d.AvailBal).Float(), Locked: mustFx(d.FrozenBal).Float(), Total: total.Float(),
				Value: mustFx(d.EqUsd).Float(), Wallet: "unified", total: total})
			if ccy == "USDT" {
				out.Available += mustFx(d.AvailBal)
			}
			if !isStable(ccy) {
				sym := "OKX:" + ccy + "-USDT"
				pos := LivePosition{Symbol: sym, Name: ccy + "/USDT", Kind: "spot", Side: "long", Qty: total.Float(), Key: spotKey(ccy), qty: total}
				if in, ok := s.inst(sym); ok {
					pos.Name = in.Name
				}
				if px, ok := s.mark(ccy); ok {
					pos.Last = px.Float()
				}
				out.Positions = append(out.Positions, pos)
			}
		}
	}
	var ps []struct {
		InstID  string `json:"instId"`
		Pos     string `json:"pos"`
		PosSide string `json:"posSide"`
		AvgPx   string `json:"avgPx"`
		Lever   string `json:"lever"`
		LiqPx   string `json:"liqPx"`
		Upl     string `json:"upl"`
		Imr     string `json:"imr"`
		Margin  string `json:"margin"`
		MarkPx  string `json:"markPx"`
	}
	if err := o.get(ctx, s, "/api/v5/account/positions", url.Values{"instType": {"SWAP"}}, &ps); err != nil {
		return out, err
	}
	for _, x := range ps {
		q := mustFx(x.Pos)
		if q == 0 || !strings.HasSuffix(x.InstID, "-USDT-SWAP") {
			continue
		}
		sym := "OKX:" + x.InstID
		key := sym
		if x.PosSide == "long" || x.PosSide == "short" {
			key += "#" + x.PosSide
			if x.PosSide == "short" && q > 0 {
				q = -q
			}
		}
		side := "long"
		if q < 0 {
			side = "short"
		}
		ct, _ := okxCtVal(s, x.InstID)
		base, _ := fxMul(q.abs(), ct)
		lev, _ := strconv.Atoi(strings.Split(x.Lever, ".")[0])
		margin := mustFx(x.Imr)
		if margin == 0 {
			margin = mustFx(x.Margin)
		}
		contracts := q.abs().Float()
		pos := LivePosition{Symbol: sym, Name: x.InstID, Kind: "perp", Side: side, Qty: base.Float(), AvgPrice: mustFx(x.AvgPx).Float(),
			LiqPrice: optFloat(mustFx(x.LiqPx)), Last: mustFx(x.MarkPx).Float(), PnL: mustFx(x.Upl).Float(), Margin: margin.Float(),
			Contracts: &contracts, Key: key, qty: q}
		if lev > 0 {
			pos.Leverage = &lev
		}
		if in, ok := s.inst(sym); ok {
			pos.Name = in.Name
		}
		out.Positions = append(out.Positions, pos)
	}
	var od []struct {
		InstID    string `json:"instId"`
		OrdID     string `json:"ordId"`
		Side      string `json:"side"`
		OrdType   string `json:"ordType"`
		Px        string `json:"px"`
		Sz        string `json:"sz"`
		AccFillSz string `json:"accFillSz"`
		State     string `json:"state"`
		CTime     string `json:"cTime"`
	}
	if err := o.get(ctx, s, "/api/v5/trade/orders-pending", url.Values{"limit": {"100"}}, &od); err != nil {
		return out, err
	}
	for _, x := range od {
		st := "open"
		if x.State == "partially_filled" {
			st = "partial"
		}
		q, px, filled := mustFx(x.Sz), mustFx(x.Px), mustFx(x.AccFillSz)
		out.Orders = append(out.Orders, LiveOrder{ID: x.OrdID, Symbol: "OKX:" + x.InstID, Side: x.Side, Type: x.OrdType, Qty: q.Float(), Price: optFloat(px),
			Filled: filled.Float(), Status: st, CreatedAt: msStamp(msOf(x.CTime)), qty: q, price: px, filled: filled})
	}
	// 成交：按 billId 游标拉更新的（before），没有游标从 since 开始；一次最多翻 10 页
	cursor := out.Cursors["okx:bill"]
	for range 10 {
		q := url.Values{"limit": {"100"}}
		if cursor != "" {
			q.Set("before", cursor)
		} else {
			q.Set("begin", strconv.FormatInt(since.UnixMilli(), 10))
		}
		var fs []struct {
			InstType string `json:"instType"`
			InstID   string `json:"instId"`
			OrdID    string `json:"ordId"`
			BillID   string `json:"billId"`
			Side     string `json:"side"`
			PosSide  string `json:"posSide"`
			FillSz   string `json:"fillSz"`
			FillPx   string `json:"fillPx"`
			Fee      string `json:"fee"`
			FeeCcy   string `json:"feeCcy"`
			Ts       string `json:"ts"`
		}
		if err := o.get(ctx, s, "/api/v5/trade/fills", q, &fs); err != nil {
			return out, err
		}
		if len(fs) == 0 {
			break
		}
		maxBill := cursor
		for _, x := range fs {
			if billLess(maxBill, x.BillID) {
				maxBill = x.BillID
			}
			qty := mustFx(x.FillSz)
			signed := qty
			if x.Side == "sell" {
				signed = -qty
			}
			f := LiveFill{ID: "okx:" + x.BillID, OrderID: x.OrdID, Symbol: "OKX:" + x.InstID, Side: x.Side, Qty: qty.Float(), Price: mustFx(x.FillPx).Float(),
				Fee: mustFx(x.Fee).abs().Float(), FeeAsset: strings.ToUpper(x.FeeCcy), At: msStamp(msOf(x.Ts)), qty: signed, fee: mustFx(x.Fee)}
			switch x.InstType {
			case "SPOT":
				baseCcy, _, _ := strings.Cut(x.InstID, "-")
				f.key = spotKey(baseCcy)
				if f.FeeAsset != "" && !isStable(f.FeeAsset) {
					f.feeKey = spotKey(f.FeeAsset)
				}
			case "SWAP":
				if !strings.HasSuffix(x.InstID, "-USDT-SWAP") {
					continue
				}
				f.key = "OKX:" + x.InstID
				if x.PosSide == "long" || x.PosSide == "short" {
					f.key += "#" + x.PosSide
				}
			default:
				continue
			}
			out.Fills = append(out.Fills, f)
		}
		if maxBill == cursor || len(fs) < 100 {
			cursor = maxBill
			break
		}
		cursor = maxBill
	}
	if cursor != "" {
		out.Cursors["okx:bill"] = cursor
	}
	sort.SliceStable(out.Fills, func(i, j int) bool { return out.Fills[i].At < out.Fills[j].At })
	return out, nil
}

// billLess 比较两个 billId（十进制数字串）。
func billLess(a, b string) bool {
	if a == "" {
		return b != ""
	}
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return a < b
}
