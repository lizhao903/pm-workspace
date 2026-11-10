// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"time"
)

// 行情源适配接口（TRD-01a）：Binance、OKX 的真实适配器在 TRD-01b、TRD-01c，本包只有接口和测试用的假实现。
// 只读行情：接口里没有也不许加下单、撤单、划转、提币。

// 市场和品种，同原型 MarketKey、InstKind
var (
	Markets = []string{"crypto", "cn", "hk", "us"}
	Kinds   = []string{"spot", "perp", "future", "option"}
)

// ErrUnsupported：这个源不提供这项数据（比如现货没有资金费率）。
var ErrUnsupported = errors.New("行情源不支持")

// ErrUnknownSymbol：源里没有这个标的。
var ErrUnknownSymbol = errors.New("没有这个标的")

// symbolRe：交易场所大写加冒号加代码，如 BINANCE:BTCUSDT、OKX:ETH-USDT-SWAP、BINANCE:BTCUSDT.P
var symbolRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,15}:[A-Za-z0-9][A-Za-z0-9._-]{0,47}$`)

// ValidSymbol 判断全局 symbol 的格式。
func ValidSymbol(s string) bool { return symbolRe.MatchString(s) }

// Instrument 同原型 Instrument，去掉模拟用的 base、vol，多了 source 和 updated_at。
// right 是期权的看涨看跌，limit 是 A 股涨跌停幅度（0.1 即 10%），没有就省略。
type Instrument struct {
	Symbol     string  `json:"symbol"`
	Name       string  `json:"name"`
	Market     string  `json:"market"`
	Kind       string  `json:"kind"`
	Venue      string  `json:"venue"`
	Digits     int     `json:"digits"`
	Lot        float64 `json:"lot"`
	Multiplier float64 `json:"multiplier"`
	Expiry     string  `json:"expiry,omitempty"`
	Underlying string  `json:"underlying,omitempty"`
	Strike     float64 `json:"strike,omitempty"`
	Right      string  `json:"right,omitempty"`
	Limit      float64 `json:"limit,omitempty"`
	Source     string  `json:"source"`
	UpdatedAt  string  `json:"updated_at"`
}

// Coverage 是一个源覆盖的一个市场和其中的品种。
type Coverage struct {
	Market string   `json:"market"`
	Kinds  []string `json:"kinds"`
}

// Ticker 是最新价和 24 小时统计。
type Ticker struct {
	Symbol    string    `json:"symbol"`
	Last      float64   `json:"last"`
	Bid       float64   `json:"bid"`
	Ask       float64   `json:"ask"`
	Open24h   float64   `json:"open_24h"`
	High24h   float64   `json:"high_24h"`
	Low24h    float64   `json:"low_24h"`
	Volume24h float64   `json:"volume_24h"`
	At        time.Time `json:"at"`
}

// Kline 是一根 K 线，Time 是开盘时间。
type Kline struct {
	Time   time.Time `json:"time"`
	Open   float64   `json:"open"`
	High   float64   `json:"high"`
	Low    float64   `json:"low"`
	Close  float64   `json:"close"`
	Volume float64   `json:"volume"`
}

// KlineQuery：Interval 是 1m、5m、15m、1h、4h、1d、1w 之一；Limit 1 到 1000；End 为零表示到现在。
type KlineQuery struct {
	Symbol   string
	Interval string
	Limit    int
	End      time.Time
}

// Intervals 是 K 线周期和它的时长。
var Intervals = map[string]time.Duration{
	"1m": time.Minute, "5m": 5 * time.Minute, "15m": 15 * time.Minute,
	"1h": time.Hour, "4h": 4 * time.Hour, "1d": 24 * time.Hour, "1w": 7 * 24 * time.Hour,
}

// Level 是盘口一档。
type Level struct {
	Price float64 `json:"price"`
	Size  float64 `json:"size"`
}

// OrderBook：买盘价格从高到低，卖盘从低到高。
type OrderBook struct {
	Symbol string    `json:"symbol"`
	Bids   []Level   `json:"bids"`
	Asks   []Level   `json:"asks"`
	At     time.Time `json:"at"`
}

// Funding 是永续合约的资金费率。
type Funding struct {
	Symbol   string    `json:"symbol"`
	Rate     float64   `json:"rate"`
	NextTime time.Time `json:"next_time"`
	At       time.Time `json:"at"`
}

// Source 是一个行情源。每个方法只读；没有的数据返回 ErrUnsupported，标的不认识返回 ErrUnknownSymbol。
type Source interface {
	ID() string   // 小写字母、数字、下划线，如 binance、okx、futu
	Name() string // 显示名
	// Coverage 声明覆盖哪些市场和品种；Instruments 只会被问到声明过的组合
	Coverage() []Coverage
	Instruments(ctx context.Context, market, kind string) ([]Instrument, error)
	Ticker(ctx context.Context, symbol string) (Ticker, error)
	Klines(ctx context.Context, q KlineQuery) ([]Kline, error)
	OrderBook(ctx context.Context, symbol string, depth int) (OrderBook, error)
	Funding(ctx context.Context, symbol string) (Funding, error)
}

var sourceIDRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,23}$`)

// checkSource 校验源的 id 和覆盖声明：市场、品种都要认识，不能重复。
func checkSource(s Source) error {
	if !sourceIDRe.MatchString(s.ID()) {
		return fmt.Errorf("行情源 id %q 只能是小写字母、数字、下划线", s.ID())
	}
	seen := map[string]bool{}
	for _, c := range s.Coverage() {
		if !slices.Contains(Markets, c.Market) {
			return fmt.Errorf("行情源 %s 声明了不认识的市场 %q", s.ID(), c.Market)
		}
		if seen[c.Market] {
			return fmt.Errorf("行情源 %s 的市场 %s 声明了两次", s.ID(), c.Market)
		}
		seen[c.Market] = true
		if len(c.Kinds) == 0 {
			return fmt.Errorf("行情源 %s 的市场 %s 没有品种", s.ID(), c.Market)
		}
		for _, k := range c.Kinds {
			if !slices.Contains(Kinds, k) {
				return fmt.Errorf("行情源 %s 声明了不认识的品种 %q", s.ID(), k)
			}
		}
	}
	return nil
}

// covers 判断源是否覆盖这个市场和品种。
func covers(s Source, market, kind string) bool {
	for _, c := range s.Coverage() {
		if c.Market == market && slices.Contains(c.Kinds, kind) {
			return true
		}
	}
	return false
}

// checkInstrument 校验源交回来的标的：格式对、市场和品种在源的覆盖里、数值合理。
func checkInstrument(s Source, in Instrument) error {
	switch {
	case !ValidSymbol(in.Symbol):
		return fmt.Errorf("symbol %q 格式不对", in.Symbol)
	case in.Name == "" || in.Venue == "":
		return fmt.Errorf("%s 缺名称或交易场所", in.Symbol)
	case !covers(s, in.Market, in.Kind):
		return fmt.Errorf("%s 的 %s/%s 不在行情源 %s 的覆盖里", in.Symbol, in.Market, in.Kind, s.ID())
	case in.Digits < 0 || in.Digits > 12 || in.Lot <= 0 || in.Multiplier <= 0 || in.Strike < 0 || in.Limit < 0:
		return fmt.Errorf("%s 的精度、最小下单量、合约乘数、行权价或涨跌停不合理", in.Symbol)
	case in.Kind == "option" && in.Right != "call" && in.Right != "put":
		return fmt.Errorf("期权 %s 要写看涨看跌", in.Symbol)
	case in.Kind != "option" && in.Right != "":
		return fmt.Errorf("%s 不是期权，不该有看涨看跌", in.Symbol)
	case in.Underlying != "" && !ValidSymbol(in.Underlying):
		return fmt.Errorf("%s 的标的 %q 格式不对", in.Symbol, in.Underlying)
	case in.Expiry != "" && !validDate(in.Expiry):
		return fmt.Errorf("%s 的到期日 %q 要是 YYYY-MM-DD", in.Symbol, in.Expiry)
	}
	return nil
}

func validDate(s string) bool {
	_, err := time.Parse(time.DateOnly, s)
	return err == nil
}
