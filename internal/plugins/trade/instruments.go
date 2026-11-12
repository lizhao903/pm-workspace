// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// SourceInfo 是行情源在接口里的样子：id、显示名、覆盖的市场和品种。
// health 是源的连接状态（TRD-02a），见 SourceHealth。
type SourceInfo struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Coverage []Coverage   `json:"coverage"`
	Health   SourceHealth `json:"health"`
}

// SyncResult 是一次标的同步的结果；skipped 是源交回来但校验没过的，errors 最多列 10 条原因。
type SyncResult struct {
	Source   string   `json:"source"`
	Upserted int      `json:"upserted"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors"`
}

var errUpstream = errors.New("upstream")

func (h *handlers) listSources(w http.ResponseWriter, _ *http.Request) {
	out := make([]SourceInfo, 0, len(h.p.sources))
	for _, s := range h.p.sources {
		out = append(out, SourceInfo{ID: s.ID(), Name: s.Name(), Coverage: s.Coverage(), Health: h.p.mkt.sourceHealth(s.ID())})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// syncSource 把源覆盖的每个市场、品种的标的拉一遍，按 symbol 新建或覆盖；源里没有了的不删（自选可能还引用着）。
func (h *handlers) syncSource(w http.ResponseWriter, r *http.Request) {
	s := h.p.source(r.PathValue("id"))
	if s == nil {
		h.fail(w, r, apiErr(errNotFound, "行情源 %s 不存在", r.PathValue("id")))
		return
	}
	res, err := runSync(r.Context(), h.c, s)
	var ue *syncUpstreamError
	if errors.As(err, &ue) {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": map[string]string{"code": errUpstream.Error(), "message": ue.Error()}})
		return
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

// syncUpstreamError 是同步时行情源出的错（接口回 502）。
type syncUpstreamError struct{ msg string }

func (e *syncUpstreamError) Error() string { return e.msg }

// runSync 是同步一个源的标的，接口和每日任务共用。
func runSync(ctx context.Context, c plugin.Core, s Source) (SyncResult, error) {
	res := SyncResult{Source: s.ID(), Errors: []string{}}
	now := time.Now().UTC().Format(time.RFC3339)
	for _, cv := range s.Coverage() {
		for _, k := range cv.Kinds {
			list, err := s.Instruments(ctx, cv.Market, k)
			if err != nil {
				c.Log().Warn("sync instruments failed", "source", s.ID(), "market", cv.Market, "kind", k, "err", err)
				return res, &syncUpstreamError{"行情源 " + s.ID() + " 取 " + cv.Market + "/" + k + " 的标的失败：" + err.Error()}
			}
			for _, in := range list {
				if err := checkInstrument(s, in); err != nil {
					res.Skipped++
					if len(res.Errors) < 10 {
						res.Errors = append(res.Errors, err.Error())
					}
					continue
				}
				if err := upsertInstrument(ctx, c, in, s.ID(), now); err != nil {
					return res, err
				}
				res.Upserted++
			}
		}
	}
	return res, nil
}

func upsertInstrument(ctx context.Context, c plugin.Core, in Instrument, source, now string) error {
	_, err := c.Store().Exec(ctx, `INSERT INTO trade_instruments (`+instCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, market = excluded.market, kind = excluded.kind, venue = excluded.venue,
		digits = excluded.digits, lot = excluded.lot, multiplier = excluded.multiplier, expiry = excluded.expiry,
		underlying = excluded.underlying, strike = excluded.strike, opt_right = excluded.opt_right,
		price_limit = excluded.price_limit, source = excluded.source, updated_at = excluded.updated_at`,
		in.Symbol, in.Name, in.Market, in.Kind, in.Venue, in.Digits, in.Lot, in.Multiplier,
		in.Expiry, in.Underlying, in.Strike, in.Right, in.Limit, source, now)
	return err
}

const instCols = `symbol, name, market, kind, venue, digits, lot, multiplier, expiry, underlying, strike, opt_right, price_limit, source, updated_at`

func scanInstrument(row plugin.Row) (Instrument, error) {
	var in Instrument
	err := row.Scan(&in.Symbol, &in.Name, &in.Market, &in.Kind, &in.Venue, &in.Digits, &in.Lot, &in.Multiplier,
		&in.Expiry, &in.Underlying, &in.Strike, &in.Right, &in.Limit, &in.Source, &in.UpdatedAt)
	return in, err
}

// listInstruments：market、kind 过滤，q 按 symbol 或名称包含（不分大小写），limit 默认 200、最多 1000。
func (h *handlers) listInstruments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	qs := r.URL.Query()
	where, args := []string{"1 = 1"}, []any{}
	if v := qs.Get("market"); v != "" {
		if !slices.Contains(Markets, v) {
			h.fail(w, r, apiErr(errValidation, "market 只能是 %s", strings.Join(Markets, "、")))
			return
		}
		where, args = append(where, "market = ?"), append(args, v)
	}
	if v := qs.Get("kind"); v != "" {
		if !slices.Contains(Kinds, v) {
			h.fail(w, r, apiErr(errValidation, "kind 只能是 %s", strings.Join(Kinds, "、")))
			return
		}
		where, args = append(where, "kind = ?"), append(args, v)
	}
	if v := strings.TrimSpace(qs.Get("q")); v != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(strings.ToLower(v)) + "%"
		where, args = append(where, `(lower(symbol) LIKE ? ESCAPE '\' OR lower(name) LIKE ? ESCAPE '\')`), append(args, like, like)
	}
	limit, offset := 200, 0
	if v := qs.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000 {
			h.fail(w, r, apiErr(errValidation, "limit 要在 1 到 1000"))
			return
		}
		limit = n
	}
	if v := qs.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			h.fail(w, r, apiErr(errValidation, "offset 要是非负整数"))
			return
		}
		offset = n
	}
	cond := strings.Join(where, " AND ")
	var total int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM trade_instruments WHERE `+cond, args...).Scan(&total); err != nil {
		h.fail(w, r, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT `+instCols+` FROM trade_instruments WHERE `+cond+` ORDER BY market, kind, symbol LIMIT ? OFFSET ?`,
		append(args, limit, offset)...)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Instrument{}
	for rows.Next() {
		in, err := scanInstrument(rows)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, in)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total, "limit": limit, "offset": offset}})
}

func (h *handlers) getInstrument(w http.ResponseWriter, r *http.Request) {
	sym := r.PathValue("symbol")
	in, err := scanInstrument(h.c.Store().QueryRow(r.Context(), `SELECT `+instCols+` FROM trade_instruments WHERE symbol = ?`, sym))
	if errors.Is(err, plugin.ErrNoRows) {
		h.fail(w, r, apiErr(errNotFound, "标的 %s 不存在", sym))
		return
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": in})
}
