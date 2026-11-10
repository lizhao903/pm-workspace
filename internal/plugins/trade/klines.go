// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"time"
)

// K 线缓存（TRD-02a）：收盘了的 K 线落 trade_klines，取过的区间记在 trade_kline_spans（相邻、重叠的合并）。
// 同一区间第二次查直接读库，不再请求交易所；只缺尾巴时只补尾巴。还没收盘的那根放内存，3 秒内重复查不再请求。
// 交易所取不到时有多少给多少，meta.status 标 stale 并带原因；一根都没有才回 502。

const formingTTL = 3 * time.Second

// KlineMeta 是 /api/trade/klines 的 meta（TradeKlineMeta）。
// status 同 Quote；cached 为真表示这次没有请求交易所；fetched_at 是还没收盘那根的取数时间，没有为空串。
type KlineMeta struct {
	Symbol    string `json:"symbol"`
	Interval  string `json:"interval"`
	Source    string `json:"source"`
	Status    string `json:"status"`
	Error     string `json:"error"`
	Cached    bool   `json:"cached"`
	FetchedAt string `json:"fetched_at"`
}

// weekOffset：Unix 纪元是周四，周线从周一 00:00 UTC 开始（Binance、OKX 1Wutc 都是）。
const weekOffset = 4 * 24 * time.Hour

// alignOpen 是 t 所在那根 K 线的开盘时间（UTC 对齐）。
func alignOpen(t time.Time, iv string) time.Time {
	step := Intervals[iv]
	off := time.Duration(0)
	if iv == "1w" {
		off = weekOffset
	}
	ms := t.UnixMilli() - off.Milliseconds()
	s := step.Milliseconds()
	open := ms - ((ms%s)+s)%s
	return time.UnixMilli(open + off.Milliseconds()).UTC()
}

type span struct{ from, to int64 } // 毫秒，开盘时间，含两端

func (m *market) spans(ctx context.Context, sym, iv string) ([]span, error) {
	rows, err := m.c.Store().Query(ctx, `SELECT from_time, to_time FROM trade_kline_spans WHERE symbol = ? AND interval = ? ORDER BY from_time`, sym, iv)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []span
	for rows.Next() {
		var s span
		if err := rows.Scan(&s.from, &s.to); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// addSpan 记一段已取区间，和相邻（差一根以内）、重叠的合并后整体重写。
func (m *market) addSpan(ctx context.Context, sym, iv string, add span, step int64) error {
	list, err := m.spans(ctx, sym, iv)
	if err != nil {
		return err
	}
	list = append(list, add)
	slices.SortFunc(list, func(a, b span) int { return int(a.from - b.from) })
	merged := []span{list[0]}
	for _, s := range list[1:] {
		last := &merged[len(merged)-1]
		if s.from <= last.to+step {
			last.to = max(last.to, s.to)
			continue
		}
		merged = append(merged, s)
	}
	if _, err := m.c.Store().Exec(ctx, `DELETE FROM trade_kline_spans WHERE symbol = ? AND interval = ?`, sym, iv); err != nil {
		return err
	}
	now := fmtT(m.now())
	for _, s := range merged {
		if _, err := m.c.Store().Exec(ctx, `INSERT INTO trade_kline_spans (symbol, interval, from_time, to_time, updated_at) VALUES (?, ?, ?, ?, ?)`,
			sym, iv, s.from, s.to, now); err != nil {
			return err
		}
	}
	return nil
}

func (m *market) saveKlines(ctx context.Context, sym, iv string, bars []Kline) error {
	for _, b := range bars {
		if _, err := m.c.Store().Exec(ctx, `INSERT INTO trade_klines (symbol, interval, open_time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(symbol, interval, open_time) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
			close = excluded.close, volume = excluded.volume`,
			sym, iv, b.Time.UnixMilli(), b.Open, b.High, b.Low, b.Close, b.Volume); err != nil {
			return err
		}
	}
	return nil
}

func (m *market) readKlines(ctx context.Context, sym, iv string, from, to int64) ([]Kline, error) {
	rows, err := m.c.Store().Query(ctx, `SELECT open_time, open, high, low, close, volume FROM trade_klines
		WHERE symbol = ? AND interval = ? AND open_time BETWEEN ? AND ? ORDER BY open_time`, sym, iv, from, to)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Kline{}
	for rows.Next() {
		var k Kline
		var t int64
		if err := rows.Scan(&t, &k.Open, &k.High, &k.Low, &k.Close, &k.Volume); err != nil {
			return nil, err
		}
		k.Time = msTime(t)
		out = append(out, k)
	}
	return out, rows.Err()
}

// klines 取 limit 根截至 end（零值为现在）的 K 线，先读缓存，缺的找交易所补。
func (m *market) klines(ctx context.Context, sym, iv string, limit int, end time.Time) ([]Kline, KlineMeta, error) {
	meta := KlineMeta{Symbol: sym, Interval: iv, Cached: true}
	src := m.p.sourceFor(sym)
	if src == nil {
		meta.Status, meta.Error = "no_source", "这个市场的行情源还没接"
		return []Kline{}, meta, nil
	}
	meta.Source = src.ID()
	step := Intervals[iv].Milliseconds()
	now := m.now()
	if end.IsZero() || end.After(now) {
		end = now
	}
	endOpen := alignOpen(end, iv).UnixMilli()
	formingOpen := alignOpen(now, iv).UnixMilli()
	startOpen := endOpen - int64(limit-1)*step
	withForming := endOpen == formingOpen
	closedTo := endOpen
	if withForming {
		closedTo = formingOpen - step
	}
	key := sym + "|" + iv

	m.klMu.Lock()
	defer m.klMu.Unlock()

	spans, err := m.spans(ctx, sym, iv)
	if err != nil {
		return nil, meta, err
	}
	// 从 startOpen 起连续已取到哪
	coveredTo := startOpen - step
	for _, s := range spans {
		if s.from <= startOpen && s.to >= startOpen {
			coveredTo = s.to
			break
		}
	}
	m.mu.Lock()
	fs, haveForming := m.forming[key]
	m.mu.Unlock()
	formingFresh := haveForming && fs.v.Time.UnixMilli() == formingOpen && now.Sub(fs.fetchedAt) < formingTTL
	need := coveredTo < closedTo || (withForming && !formingFresh)

	status := "live"
	if need {
		from := max(coveredTo+step, startOpen)
		n := int((endOpen-from)/step) + 1
		switch {
		case !m.wait(ctx, src.ID()):
			status, meta.Error = "stale", "行情源 "+src.Name()+" 暂时取不到，先给缓存"
			if h := m.sourceHealth(src.ID()); h.Error != "" {
				meta.Error = h.Error
			}
		default:
			meta.Cached = false
			q := KlineQuery{Symbol: sym, Interval: iv, Limit: min(max(n, 1), 1000)}
			if !withForming {
				q.End = time.UnixMilli(endOpen + step - 1).UTC()
			}
			bars, ferr := src.Klines(ctx, q)
			m.report(ctx, src.ID(), ferr)
			if ferr != nil {
				if symbolErr(ferr) {
					meta.Status, meta.Error = "error", ferr.Error()
					return []Kline{}, meta, nil
				}
				status, meta.Error = "stale", ferr.Error()
				break
			}
			var closed []Kline
			for _, b := range bars {
				t := b.Time.UnixMilli()
				switch {
				case t == formingOpen:
					m.mu.Lock()
					m.forming[key] = snap[Kline]{v: b, ok: true, fetchedAt: now}
					m.mu.Unlock()
				case t <= closedTo:
					closed = append(closed, b)
				}
			}
			if err := m.saveKlines(ctx, sym, iv, closed); err != nil {
				return nil, meta, err
			}
			if closedTo >= from {
				if err := m.addSpan(ctx, sym, iv, span{from, closedTo}, step); err != nil {
					return nil, meta, err
				}
			}
		}
	}

	out, err := m.readKlines(ctx, sym, iv, startOpen, closedTo)
	if err != nil {
		return nil, meta, err
	}
	if withForming {
		m.mu.Lock()
		fs, ok := m.forming[key]
		m.mu.Unlock()
		if ok && fs.v.Time.UnixMilli() == formingOpen {
			out = append(out, fs.v)
			meta.FetchedAt = fmtT(fs.fetchedAt)
		}
	}
	if status == "stale" && len(out) == 0 {
		meta.Status = "error"
		return out, meta, &UpstreamError{Source: src.Name(), Status: http.StatusBadGateway, Msg: meta.Error}
	}
	meta.Status = status
	return out, meta, nil
}

// GET /api/trade/klines?symbol=&interval=&limit=&end=
func (h *handlers) getKlines(w http.ResponseWriter, r *http.Request) {
	qs := r.URL.Query()
	sym := qs.Get("symbol")
	if !ValidSymbol(sym) {
		h.fail(w, r, apiErr(errValidation, "symbol 要写成 交易场所:代码，如 BINANCE:BTCUSDT"))
		return
	}
	iv := qs.Get("interval")
	if iv == "" {
		iv = "15m"
	}
	if _, ok := Intervals[iv]; !ok {
		h.fail(w, r, apiErr(errValidation, "interval 只能是 1m、5m、15m、1h、4h、1d、1w"))
		return
	}
	limit := 200
	if v := qs.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000 {
			h.fail(w, r, apiErr(errValidation, "limit 要在 1 到 1000"))
			return
		}
		limit = n
	}
	var end time.Time
	if v := qs.Get("end"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			h.fail(w, r, apiErr(errValidation, "end 要是 RFC3339 时间"))
			return
		}
		end = t.UTC()
	}
	bars, meta, err := h.p.mkt.klines(r.Context(), sym, iv, limit, end)
	var ue *UpstreamError
	if errors.As(err, &ue) {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": map[string]string{"code": errUpstream.Error(), "message": ue.Msg}})
		return
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": bars, "meta": meta})
}
