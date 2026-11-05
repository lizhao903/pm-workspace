package trade

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 策略落库和接口（TRD-04b）：表 trade_strategies（迁移 0004），整份策略存 JSON，形状同原型 Strategy。
// 编辑页改动自动保存，走 PATCH 只传改了的字段；删策略不删回测记录（回测里有发起时的快照）。

const (
	maxStrategyName  = 80
	maxStrategyDesc  = 2000
	maxStrategyCode  = 32 << 10
	maxStrategySyms  = 20
	maxStrategyTags  = 20
	maxStrategyRules = 50
	maxStrategyParam = 50
)

// strategyFields 是 POST、PATCH 认的字段；id 和时间由后端管。
var strategyFields = []string{"name", "desc", "mode", "symbols", "interval", "direction", "entry", "exit",
	"stop_loss", "take_profit", "position_pct", "code", "params", "tags"}

// stamp 是毫秒精度、定长的 RFC3339 UTC，字符串比较就是时间先后。
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// newStrategy 是「新建策略」的默认值（SPEC-strategy-3.21）。
func newStrategy() Strategy {
	return Strategy{
		Name: "新策略", Mode: "rules", Symbols: []string{}, Interval: "1h", Direction: "long",
		Entry: RuleGroup{Logic: "all", Rules: []Rule{}}, Exit: RuleGroup{Logic: "any", Rules: []Rule{}},
		PositionPct: 20, Params: Params{}, Tags: []string{},
	}
}

// uniqTrim 去首尾空白、去空、按出现顺序去重。
func uniqTrim(xs []string) []string {
	out := []string{}
	for _, x := range xs {
		x = strings.TrimSpace(x)
		if x != "" && !slices.Contains(out, x) {
			out = append(out, x)
		}
	}
	return out
}

// normalize 补空值、修规则 id，再做长度和取值检查。
func (s *Strategy) normalize() error {
	s.Name = strings.TrimSpace(s.Name)
	s.Symbols = uniqTrim(s.Symbols)
	s.Tags = uniqTrim(s.Tags)
	if s.Params == nil {
		s.Params = Params{}
	}
	var errs []string
	seen := map[string]bool{}
	for _, g := range []*RuleGroup{&s.Entry, &s.Exit} {
		if g.Rules == nil {
			g.Rules = []Rule{}
		}
		if len(g.Rules) > maxStrategyRules {
			errs = append(errs, "一组条件最多 50 条")
		}
		for i := range g.Rules {
			r := &g.Rules[i]
			r.ID = strings.TrimSpace(r.ID)
			// 规则 id 只是策略里的下标，前端新加的可以先自己起；空的、重复的由后端补
			if r.ID == "" || seen[r.ID] || len(r.ID) > 40 {
				r.ID = idgen.Prefixed("rl")
			}
			seen[r.ID] = true
			for _, o := range []*Operand{&r.Left, &r.Right} {
				if o.Kind == "ind" && o.Params == nil {
					o.Params = []float64{}
				}
				if len(o.Params) > 3 {
					errs = append(errs, "指标参数最多 3 个")
				}
			}
		}
	}
	switch {
	case utf8.RuneCountInString(s.Name) > maxStrategyName:
		errs = append(errs, "名称最多 80 字")
	case utf8.RuneCountInString(s.Desc) > maxStrategyDesc:
		errs = append(errs, "说明最多 2000 字")
	case len(s.Code) > maxStrategyCode:
		errs = append(errs, "代码最多 32KB")
	case len(s.Symbols) > maxStrategySyms:
		errs = append(errs, "标的最多 20 个")
	case len(s.Tags) > maxStrategyTags:
		errs = append(errs, "标签最多 20 个")
	case len(s.Params) > maxStrategyParam:
		errs = append(errs, "参数最多 50 个")
	}
	for _, p := range s.Params {
		if strings.TrimSpace(p.Key) == "" || len(p.Key) > 40 {
			errs = append(errs, "参数名不能为空、最多 40 个字符")
			break
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "；"))
	}
	return s.Validate()
}

// applyStrategy 把请求体里出现的字段盖到 st 上，校验通过才改 st。
func applyStrategy(st *Strategy, raw map[string]json.RawMessage) error {
	for k := range raw {
		if !slices.Contains(strategyFields, k) {
			return apiErr(errValidation, "不认识的字段 %s", k)
		}
	}
	base, err := json.Marshal(st)
	if err != nil {
		return err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(base, &m); err != nil {
		return err
	}
	for k, v := range raw {
		m[k] = v
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	var out Strategy
	if err := json.Unmarshal(b, &out); err != nil {
		return apiErr(errValidation, "字段的类型不对：%v", err)
	}
	if err := out.normalize(); err != nil {
		return apiErr(errValidation, "%v", err)
	}
	out.ID, out.CreatedAt, out.UpdatedAt = st.ID, st.CreatedAt, st.UpdatedAt
	*st = out
	return nil
}

func scanStrategy(row plugin.Row) (Strategy, error) {
	var st Strategy
	var id, body, created, updated string
	if err := row.Scan(&id, &body, &created, &updated); err != nil {
		return st, err
	}
	if err := json.Unmarshal([]byte(body), &st); err != nil {
		return st, err
	}
	_ = st.normalizeRead()
	st.ID, st.CreatedAt, st.UpdatedAt = id, created, updated
	return st, nil
}

// normalizeRead 只补空值，读库时用（库里的已经校验过）。
func (s *Strategy) normalizeRead() error {
	if s.Symbols == nil {
		s.Symbols = []string{}
	}
	if s.Tags == nil {
		s.Tags = []string{}
	}
	if s.Params == nil {
		s.Params = Params{}
	}
	for _, g := range []*RuleGroup{&s.Entry, &s.Exit} {
		if g.Rules == nil {
			g.Rules = []Rule{}
		}
	}
	return nil
}

const strategyCols = `id, body, created_at, updated_at`

func loadStrategy(ctx context.Context, c plugin.Core, id string) (Strategy, error) {
	st, err := scanStrategy(c.Store().QueryRow(ctx, `SELECT `+strategyCols+` FROM trade_strategies WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return st, apiErr(errNotFound, "策略 %s 不存在", id)
	}
	return st, err
}

func saveStrategy(ctx context.Context, c plugin.Core, st Strategy, insert bool) error {
	body := st
	body.ID, body.CreatedAt, body.UpdatedAt = "", "", ""
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	if insert {
		_, err = c.Store().Exec(ctx, `INSERT INTO trade_strategies (id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
			st.ID, st.Name, string(b), st.CreatedAt, st.UpdatedAt)
		return err
	}
	_, err = c.Store().Exec(ctx, `UPDATE trade_strategies SET name = ?, body = ?, updated_at = ? WHERE id = ?`, st.Name, string(b), st.UpdatedAt, st.ID)
	return err
}

// GET /api/trade/strategies：全部策略，按更新时间新的在前，不分页。
func (h *handlers) listStrategies(w http.ResponseWriter, r *http.Request) {
	rows, err := h.c.Store().Query(r.Context(), `SELECT `+strategyCols+` FROM trade_strategies ORDER BY updated_at DESC, id`)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Strategy{}
	for rows.Next() {
		st, err := scanStrategy(rows)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, st)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handlers) getStrategy(w http.ResponseWriter, r *http.Request) {
	st, err := loadStrategy(r.Context(), h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": st})
}

// POST /api/trade/strategies：没传的字段取「新建策略」的默认值。
func (h *handlers) addStrategy(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	st := newStrategy()
	if err := applyStrategy(&st, raw); err != nil {
		h.fail(w, r, err)
		return
	}
	now := stamp(time.Now())
	st.ID, st.CreatedAt, st.UpdatedAt = idgen.Prefixed("st"), now, now
	if err := saveStrategy(r.Context(), h.c, st, true); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": st})
}

// PATCH /api/trade/strategies/{id}：只改出现的字段，每次都更新 updated_at。
func (h *handlers) updateStrategy(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	st, err := loadStrategy(ctx, h.c, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if err := applyStrategy(&st, raw); err != nil {
		h.fail(w, r, err)
		return
	}
	st.UpdatedAt = stamp(time.Now())
	if err := saveStrategy(ctx, h.c, st, false); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": st})
}

// DELETE /api/trade/strategies/{id}：回测记录保留（带快照）。部署（TRD-05）还没有，不用停。
func (h *handlers) removeStrategy(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := loadStrategy(ctx, h.c, id); err != nil {
		h.fail(w, r, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM trade_strategies WHERE id = ?`, id); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}
