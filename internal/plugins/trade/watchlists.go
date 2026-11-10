// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Watchlist 同原型 Watchlist，多了顺序和时间。symbols 有序、不重复，不要求已在标的表里（行情源还没同步时也能加）。
type Watchlist struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Symbols   []string `json:"symbols"`
	Position  int      `json:"position"`
	CreatedAt string   `json:"created_at"`
	UpdatedAt string   `json:"updated_at"`
}

const (
	maxWatchSymbols = 200
	maxWatchName    = 40
)

const watchCols = `id, name, symbols, position, created_at, updated_at`

func scanWatchlist(row plugin.Row) (Watchlist, error) {
	var wl Watchlist
	var syms string
	if err := row.Scan(&wl.ID, &wl.Name, &syms, &wl.Position, &wl.CreatedAt, &wl.UpdatedAt); err != nil {
		return wl, err
	}
	if err := json.Unmarshal([]byte(syms), &wl.Symbols); err != nil || wl.Symbols == nil {
		wl.Symbols = []string{}
	}
	return wl, nil
}

func (h *handlers) loadWatchlist(ctx context.Context, id string) (Watchlist, error) {
	wl, err := scanWatchlist(h.c.Store().QueryRow(ctx, `SELECT `+watchCols+` FROM trade_watchlists WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return wl, apiErr(errNotFound, "自选分组 %s 不存在", id)
	}
	return wl, err
}

func (h *handlers) listWatchlists(w http.ResponseWriter, r *http.Request) {
	rows, err := h.c.Store().Query(r.Context(), `SELECT `+watchCols+` FROM trade_watchlists ORDER BY position, created_at, rowid`)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Watchlist{}
	for rows.Next() {
		wl, err := scanWatchlist(rows)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, wl)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handlers) getWatchlist(w http.ResponseWriter, r *http.Request) {
	wl, err := h.loadWatchlist(r.Context(), r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": wl})
}

func (h *handlers) addWatchlist(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	wl := Watchlist{Symbols: []string{}}
	if _, ok := raw["name"]; !ok {
		h.fail(w, r, apiErr(errValidation, "缺少 name"))
		return
	}
	if err := applyWatchlist(&wl, raw); err != nil {
		h.fail(w, r, err)
		return
	}
	var pos int
	if err := h.c.Store().QueryRow(ctx, `SELECT COALESCE(MAX(position), -1) + 1 FROM trade_watchlists`).Scan(&pos); err != nil {
		h.fail(w, r, err)
		return
	}
	wl.ID = idgen.Prefixed("wl")
	now := time.Now().UTC().Format(time.RFC3339)
	syms, _ := json.Marshal(wl.Symbols)
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO trade_watchlists (`+watchCols+`) VALUES (?, ?, ?, ?, ?, ?)`,
		wl.ID, wl.Name, string(syms), pos, now, now); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.loadWatchlist(ctx, wl.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

// updateWatchlist 只改 body 里出现的字段；symbols 整体替换。
func (h *handlers) updateWatchlist(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	wl, err := h.loadWatchlist(ctx, id)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if err := applyWatchlist(&wl, raw); err != nil {
		h.fail(w, r, err)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	syms, _ := json.Marshal(wl.Symbols)
	if _, err := h.c.Store().Exec(ctx, `UPDATE trade_watchlists SET name = ?, symbols = ?, position = ?, updated_at = ? WHERE id = ?`,
		wl.Name, string(syms), wl.Position, now, id); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.loadWatchlist(ctx, id)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (h *handlers) removeWatchlist(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.loadWatchlist(ctx, id); err != nil {
		h.fail(w, r, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM trade_watchlists WHERE id = ?`, id); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// applyWatchlist 认 name、symbols、position；id 和时间忽略，别的字段 400。
func applyWatchlist(wl *Watchlist, raw map[string]json.RawMessage) error {
	for k, v := range raw {
		var err error
		switch k {
		case "name":
			err = json.Unmarshal(v, &wl.Name)
			wl.Name = strings.TrimSpace(wl.Name)
		case "symbols":
			var syms []string
			if err = json.Unmarshal(v, &syms); err == nil {
				wl.Symbols, err = normSymbols(syms)
				if err != nil {
					return err
				}
			}
		case "position":
			err = json.Unmarshal(v, &wl.Position)
			if err == nil && wl.Position < 0 {
				return apiErr(errValidation, "position 不能是负数")
			}
		case "id", "created_at", "updated_at":
			continue
		default:
			return apiErr(errValidation, "不认识的字段 %s", k)
		}
		if err != nil {
			return apiErr(errValidation, "%s 的类型不对", k)
		}
	}
	if wl.Name == "" {
		return apiErr(errValidation, "分组名不能为空")
	}
	if len([]rune(wl.Name)) > maxWatchName {
		return apiErr(errValidation, "分组名最多 %d 字", maxWatchName)
	}
	return nil
}

// normSymbols 去掉空白，按出现顺序去重，格式不对 400。
func normSymbols(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if !ValidSymbol(s) {
			return nil, apiErr(errValidation, "标的 %q 格式不对，要写成 交易场所:代码，如 BINANCE:BTCUSDT", s)
		}
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	if len(out) > maxWatchSymbols {
		return nil, apiErr(errValidation, "一个分组最多 %d 个标的", maxWatchSymbols)
	}
	return out, nil
}
