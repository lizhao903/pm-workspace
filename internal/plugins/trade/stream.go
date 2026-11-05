package trade

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// 行情查询和推送（TRD-02a）。推送走插件自己的 SSE 路由，不走事件总线：高频行情会把总线挤满，
// 写法同内核 /api/events（每条一行 data: <json>，类型在 type 字段，空行分隔，注释行当心跳）。

const (
	maxStreamSymbols = 200
	heartbeatEvery   = 15 * time.Second
)

// GET /api/trade/quotes?symbols=A,B：轮询用（SSE 连不上时前端退回这个），没缓存的当场取一次。
func (h *handlers) getQuotes(w http.ResponseWriter, r *http.Request) {
	syms, err := symbolsParam(r.URL.Query().Get("symbols"), maxStreamSymbols)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if len(syms) == 0 {
		h.fail(w, r, apiErr(errValidation, "symbols 必填，逗号分隔"))
		return
	}
	m := h.p.mkt
	now := m.now()
	m.mu.Lock()
	for _, s := range syms {
		m.polled[s] = now
	}
	m.mu.Unlock()
	out := make([]Quote, 0, len(syms))
	for _, s := range syms {
		m.loadCached(r.Context(), s)
		m.ensure(r.Context(), "ticker", s)
		out = append(out, m.quote(r.Context(), s))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handlers) oneSymbol(w http.ResponseWriter, r *http.Request) (string, bool) {
	sym := r.URL.Query().Get("symbol")
	if !ValidSymbol(sym) {
		h.fail(w, r, apiErr(errValidation, "symbol 要写成 交易场所:代码，如 BINANCE:BTCUSDT"))
		return "", false
	}
	return sym, true
}

// GET /api/trade/book?symbol=&depth=：盘口，depth 默认 10、1 到 20。
func (h *handlers) getBook(w http.ResponseWriter, r *http.Request) {
	sym, ok := h.oneSymbol(w, r)
	if !ok {
		return
	}
	depth := 10
	if v := r.URL.Query().Get("depth"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > bookDepth {
			h.fail(w, r, apiErr(errValidation, "depth 要在 1 到 %d", bookDepth))
			return
		}
		depth = n
	}
	m := h.p.mkt
	m.mu.Lock()
	m.bookAt[sym] = m.now()
	m.mu.Unlock()
	m.ensure(r.Context(), "book", sym)
	writeJSON(w, http.StatusOK, map[string]any{"data": m.book(sym, depth)})
}

// GET /api/trade/funding?symbol=：永续资金费率。
func (h *handlers) getFunding(w http.ResponseWriter, r *http.Request) {
	sym, ok := h.oneSymbol(w, r)
	if !ok {
		return
	}
	m := h.p.mkt
	m.mu.Lock()
	m.bookAt[sym] = m.now()
	m.mu.Unlock()
	m.ensure(r.Context(), "funding", sym)
	writeJSON(w, http.StatusOK, map[string]any{"data": m.fundingOf(sym)})
}

// StreamEvent 是 /api/trade/stream 的一条（TradeStreamEvent）：type 是 ready、quote、book、funding、source 之一。
type StreamEvent struct {
	Type    string        `json:"type"`
	Quote   *Quote        `json:"quote,omitempty"`
	Book    *Book         `json:"book,omitempty"`
	Funding *FundingView  `json:"funding,omitempty"`
	Source  *SourceStatus `json:"source,omitempty"`
	At      string        `json:"at"`
}

// SourceStatus 是推送里的源状态：id 加 SourceHealth。
type SourceStatus struct {
	ID string `json:"id"`
	SourceHealth
}

// GET /api/trade/stream?symbols=A,B&focus=C：SSE，连上先发 ready 和全部快照，之后每秒推有变化的；
// focus 是正在看的标的，额外推它的盘口（10 档）和资金费率。15 秒一行注释做心跳。
func (h *handlers) stream(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	syms, err := symbolsParam(q.Get("symbols"), maxStreamSymbols)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	focus := q.Get("focus")
	if focus != "" && !ValidSymbol(focus) {
		h.fail(w, r, apiErr(errValidation, "focus 要写成 交易场所:代码"))
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		h.fail(w, r, fmt.Errorf("响应不支持流式输出"))
		return
	}
	m := h.p.mkt
	defer m.subscribe(syms, focus)()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	send := func(e StreamEvent) bool {
		e.At = fmtT(m.now())
		b, _ := json.Marshal(e)
		if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
			return false
		}
		return true
	}
	ctx := r.Context()
	sentQ := map[string]string{}
	var sentBook, sentFund string
	sentSrc := map[string]string{}
	push := func(first bool) bool {
		for _, s := range h.p.sources {
			st := SourceStatus{ID: s.ID(), SourceHealth: m.sourceHealth(s.ID())}
			sig := st.Status + st.Error + st.RetryAt
			if first || sentSrc[s.ID()] != sig {
				sentSrc[s.ID()] = sig
				if !send(StreamEvent{Type: "source", Source: &st}) {
					return false
				}
			}
		}
		for _, s := range syms {
			qt := m.quote(ctx, s)
			sig := qt.Status + qt.FetchedAt + qt.Error
			if first || sentQ[s] != sig {
				sentQ[s] = sig
				if !send(StreamEvent{Type: "quote", Quote: &qt}) {
					return false
				}
			}
		}
		if focus != "" {
			b := m.book(focus, 10)
			if sig := b.Status + b.FetchedAt + b.Error; first || sentBook != sig {
				sentBook = sig
				if !send(StreamEvent{Type: "book", Book: &b}) {
					return false
				}
			}
			f := m.fundingOf(focus)
			if sig := f.Status + f.FetchedAt + f.Error; first || sentFund != sig {
				sentFund = sig
				if !send(StreamEvent{Type: "funding", Funding: &f}) {
					return false
				}
			}
		}
		flusher.Flush()
		return true
	}
	if !send(StreamEvent{Type: "ready"}) || !push(true) {
		return
	}
	every := h.p.push
	if every <= 0 {
		every = time.Second
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	beat := time.NewTicker(heartbeatEvery)
	defer beat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-beat.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-tick.C:
			if !push(false) {
				return
			}
		}
	}
}
