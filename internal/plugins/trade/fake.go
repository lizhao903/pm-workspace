// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"fmt"
	"math"
	"slices"
	"time"
)

// FakeSource 是不出网的假行情源：几个数币现货和永续，价格只由时间决定（同原型「时间决定价格」），测试和本机演示用。
type FakeSource struct {
	Now func() time.Time // 空则用 time.Now
}

type fakeInst struct {
	Instrument
	base float64
}

var fakeInsts = []fakeInst{
	{Instrument{Symbol: "FAKE:BTCUSDT", Name: "BTC/USDT", Market: "crypto", Kind: "spot", Venue: "Fake", Digits: 1, Lot: 0.0001, Multiplier: 1}, 67000},
	{Instrument{Symbol: "FAKE:ETHUSDT", Name: "ETH/USDT", Market: "crypto", Kind: "spot", Venue: "Fake", Digits: 2, Lot: 0.001, Multiplier: 1}, 3400},
	{Instrument{Symbol: "FAKE:BTCUSDT.P", Name: "BTC 永续", Market: "crypto", Kind: "perp", Venue: "Fake", Digits: 1, Lot: 0.001, Multiplier: 1, Underlying: "FAKE:BTCUSDT"}, 67020},
}

func (f *FakeSource) ID() string   { return "fake" }
func (f *FakeSource) Name() string { return "假行情源" }

func (f *FakeSource) Coverage() []Coverage {
	return []Coverage{{Market: "crypto", Kinds: []string{"spot", "perp"}}}
}

func (f *FakeSource) now() time.Time {
	if f.Now != nil {
		return f.Now().UTC()
	}
	return time.Now().UTC()
}

func (f *FakeSource) find(symbol string) (fakeInst, error) {
	i := slices.IndexFunc(fakeInsts, func(x fakeInst) bool { return x.Symbol == symbol })
	if i < 0 {
		return fakeInst{}, fmt.Errorf("%w：%s", ErrUnknownSymbol, symbol)
	}
	return fakeInsts[i], nil
}

// price 是 t 时刻的价格：基准价上叠两个正弦，同一时刻算几次都一样。
func (fi fakeInst) price(t time.Time) float64 {
	x := float64(t.Unix()) / 3600
	p := fi.base * (1 + 0.02*math.Sin(x/7) + 0.005*math.Sin(x*3))
	pow := math.Pow10(fi.Digits)
	return math.Round(p*pow) / pow
}

func (f *FakeSource) Instruments(_ context.Context, market, kind string) ([]Instrument, error) {
	out := []Instrument{}
	for _, x := range fakeInsts {
		if x.Market == market && x.Kind == kind {
			out = append(out, x.Instrument)
		}
	}
	return out, nil
}

func (f *FakeSource) Ticker(_ context.Context, symbol string) (Ticker, error) {
	fi, err := f.find(symbol)
	if err != nil {
		return Ticker{}, err
	}
	now := f.now()
	last := fi.price(now)
	tick := math.Pow10(-fi.Digits)
	hi, lo := last, last
	for h := 1; h <= 24; h++ {
		p := fi.price(now.Add(-time.Duration(h) * time.Hour))
		hi, lo = math.Max(hi, p), math.Min(lo, p)
	}
	return Ticker{Symbol: symbol, Last: last, Bid: last - tick, Ask: last + tick, Open24h: fi.price(now.Add(-24 * time.Hour)),
		High24h: hi, Low24h: lo, Volume24h: 1000, At: now}, nil
}

func (f *FakeSource) Klines(_ context.Context, q KlineQuery) ([]Kline, error) {
	fi, err := f.find(q.Symbol)
	if err != nil {
		return nil, err
	}
	step, ok := Intervals[q.Interval]
	if !ok {
		return nil, fmt.Errorf("%w：K 线周期 %q", ErrUnsupported, q.Interval)
	}
	if q.Limit < 1 || q.Limit > 1000 {
		return nil, fmt.Errorf("K 线根数要在 1 到 1000：%d", q.Limit)
	}
	end := q.End
	if end.IsZero() {
		end = f.now()
	}
	start := end.Truncate(step).Add(-time.Duration(q.Limit-1) * step)
	out := make([]Kline, 0, q.Limit)
	for i := range q.Limit {
		t := start.Add(time.Duration(i) * step)
		o, c := fi.price(t), fi.price(t.Add(step))
		m := fi.price(t.Add(step / 2))
		out = append(out, Kline{Time: t, Open: o, High: math.Max(math.Max(o, c), m), Low: math.Min(math.Min(o, c), m), Close: c, Volume: 10})
	}
	return out, nil
}

func (f *FakeSource) OrderBook(_ context.Context, symbol string, depth int) (OrderBook, error) {
	fi, err := f.find(symbol)
	if err != nil {
		return OrderBook{}, err
	}
	if depth < 1 || depth > 100 {
		return OrderBook{}, fmt.Errorf("盘口档数要在 1 到 100：%d", depth)
	}
	now := f.now()
	mid := fi.price(now)
	tick := math.Pow10(-fi.Digits)
	ob := OrderBook{Symbol: symbol, At: now}
	for i := 1; i <= depth; i++ {
		sz := float64(i)
		ob.Bids = append(ob.Bids, Level{Price: mid - float64(i)*tick, Size: sz})
		ob.Asks = append(ob.Asks, Level{Price: mid + float64(i)*tick, Size: sz})
	}
	return ob, nil
}

func (f *FakeSource) Funding(_ context.Context, symbol string) (Funding, error) {
	fi, err := f.find(symbol)
	if err != nil {
		return Funding{}, err
	}
	if fi.Kind != "perp" {
		return Funding{}, fmt.Errorf("%w：%s 不是永续合约，没有资金费率", ErrUnsupported, symbol)
	}
	now := f.now()
	return Funding{Symbol: symbol, Rate: 0.0001, NextTime: now.Truncate(8 * time.Hour).Add(8 * time.Hour), At: now}, nil
}
