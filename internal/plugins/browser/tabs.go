// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package browser

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// 标签页（BR-01a）：前端标签变化防抖后整体 PUT，启动时 GET 恢复（BR-01b）。

const (
	// MaxTabs 是存后端的上限；前端同时开的仍按 12（SPEC-browser-1）
	MaxTabs    = 50
	maxHistory = 100
	maxURL     = 4096
	maxTitle   = 200
)

// 标签种类，同原型 TabKind
var tabKinds = []string{"home", "proto", "drive", "web"}

var tabIDRe = regexp.MustCompile(`^bt_[A-Za-z0-9_-]{1,40}$`)

// Tab 是一个标签页，字段同原型 BrowserTab，多 position（顺序，从 0 起）、active（是否当前）和 updated_at。
// 原型的 loading 只在前端内存，PUT 带了也不存。
type Tab struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Title     string   `json:"title"`
	Kind      string   `json:"kind"`
	History   []string `json:"history"`
	Cursor    int      `json:"cursor"`
	Pinned    bool     `json:"pinned"`
	Position  int      `json:"position"`
	Active    bool     `json:"active"`
	UpdatedAt string   `json:"updated_at"`
}

func (h *handler) loadTabs(ctx context.Context) ([]Tab, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT id, url, title, kind, history, cursor, pinned, position, active, updated_at
		FROM browser_tabs ORDER BY position, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Tab{}
	for rows.Next() {
		var (
			t      Tab
			hist   string
			pinned int
			active int
		)
		if err := rows.Scan(&t.ID, &t.URL, &t.Title, &t.Kind, &hist, &t.Cursor, &pinned, &t.Position, &active, &t.UpdatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(hist), &t.History); err != nil || t.History == nil {
			t.History = []string{t.URL}
		}
		t.Pinned, t.Active = pinned == 1, active == 1
		out = append(out, t)
	}
	return out, rows.Err()
}

func (h *handler) listTabs(w http.ResponseWriter, r *http.Request) {
	tabs, err := h.loadTabs(r.Context())
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": tabs, "meta": map[string]int{"total": len(tabs)}})
}

// tabURL 认 about: 开头和 http(s) 地址，别的（javascript:、file: 之类）不存。
func tabURL(s, label string) (string, error) {
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return "", apiErr(errValidation, "%s不能为空", label)
	case len(s) > maxURL:
		return "", apiErr(errValidation, "%s最长 %d 个字符", label, maxURL)
	case strings.HasPrefix(s, "about:"):
		return s, nil
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", apiErr(errValidation, "%s要是 http(s) 地址或 about: 开头：%s", label, s)
	}
	return s, nil
}

// tabIn 是 PUT 里的一个标签，字段可缺，缺的按地址补
type tabIn struct {
	ID       *string  `json:"id"`
	URL      *string  `json:"url"`
	Title    *string  `json:"title"`
	Kind     *string  `json:"kind"`
	History  []string `json:"history"`
	Cursor   *int     `json:"cursor"`
	Pinned   *bool    `json:"pinned"`
	Active   *bool    `json:"active"`
	Loading  *bool    `json:"loading"`
	Position *int     `json:"position"`
	Updated  *string  `json:"updated_at"`
}

var tabFields = []string{"id", "url", "title", "kind", "history", "cursor", "pinned", "active", "loading", "position", "updated_at"}

func parseTab(raw json.RawMessage, i int) (Tab, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return Tab{}, apiErr(errValidation, "第 %d 个标签必须是 JSON 对象", i+1)
	}
	for k := range m {
		if !slices.Contains(tabFields, k) {
			return Tab{}, apiErr(errValidation, "第 %d 个标签有不认识的字段 %s", i+1, k)
		}
	}
	var in tabIn
	if err := json.Unmarshal(raw, &in); err != nil {
		return Tab{}, apiErr(errValidation, "第 %d 个标签字段类型不对：%v", i+1, err)
	}
	label := func(f string) string { return "第 " + itoa(i+1) + " 个标签的 " + f }
	var t Tab
	if in.ID != nil && *in.ID != "" {
		if !tabIDRe.MatchString(*in.ID) {
			return Tab{}, apiErr(errValidation, "%s要是 bt_ 开头：%s", label("id "), *in.ID)
		}
		t.ID = *in.ID
	} else {
		t.ID = idgen.Prefixed("bt")
	}
	if in.URL == nil {
		return Tab{}, apiErr(errValidation, "%s必填", label("url "))
	}
	u, err := tabURL(*in.URL, label("url "))
	if err != nil {
		return Tab{}, err
	}
	t.URL = u
	if in.Title != nil {
		t.Title = strings.TrimSpace(*in.Title)
		if utf8.RuneCountInString(t.Title) > maxTitle {
			return Tab{}, apiErr(errValidation, "%s最多 %d 字", label("标题"), maxTitle)
		}
	}
	if in.Kind == nil || !slices.Contains(tabKinds, *in.Kind) {
		return Tab{}, apiErr(errValidation, "%s要是 home、proto、drive、web 之一", label("kind "))
	}
	t.Kind = *in.Kind
	if len(in.History) > maxHistory {
		return Tab{}, apiErr(errValidation, "%s最多 %d 条", label("历史"), maxHistory)
	}
	for j, s := range in.History {
		v, err := tabURL(s, label("历史第 "+itoa(j+1)+" 条"))
		if err != nil {
			return Tab{}, err
		}
		t.History = append(t.History, v)
	}
	if len(t.History) == 0 {
		t.History = []string{t.URL}
	}
	t.Cursor = len(t.History) - 1
	if in.Cursor != nil {
		if *in.Cursor < 0 || *in.Cursor >= len(t.History) {
			return Tab{}, apiErr(errValidation, "%s要在 0 到 %d 之间", label("cursor "), len(t.History)-1)
		}
		t.Cursor = *in.Cursor
	}
	t.Pinned = in.Pinned != nil && *in.Pinned
	t.Active = in.Active != nil && *in.Active
	return t, nil
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

// putTabs 整体替换：body {tabs: BrowserTab[]}，顺序就是数组顺序，最多 50 个，当前标签最多一个。
func (h *handler) putTabs(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r, false, "tabs")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var items []json.RawMessage
	if v, ok := raw["tabs"]; !ok || json.Unmarshal(v, &items) != nil || items == nil {
		fail(w, r, h.c, apiErr(errValidation, "tabs 必须是数组"))
		return
	}
	if len(items) > MaxTabs {
		fail(w, r, h.c, apiErr(errValidation, "标签页最多 %d 个，这次有 %d 个", MaxTabs, len(items)))
		return
	}
	tabs := make([]Tab, 0, len(items))
	seen, actives := map[string]bool{}, 0
	for i, it := range items {
		t, err := parseTab(it, i)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		if seen[t.ID] {
			fail(w, r, h.c, apiErr(errValidation, "标签 id 重复：%s", t.ID))
			return
		}
		seen[t.ID] = true
		if t.Active {
			actives++
		}
		t.Position = i
		tabs = append(tabs, t)
	}
	if actives > 1 {
		fail(w, r, h.c, apiErr(errValidation, "当前标签最多一个，这次有 %d 个", actives))
		return
	}
	if err := h.replaceTabs(r.Context(), tabs); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.loadTabs(r.Context())
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// replaceTabs 先一条语句写入或更新全部，再删掉不在这次里的；两条之间进程退出时多出的旧标签下次 PUT 会清掉。
func (h *handler) replaceTabs(ctx context.Context, tabs []Tab) error {
	h.tabsMu.Lock()
	defer h.tabsMu.Unlock()
	st := h.c.Store()
	if len(tabs) == 0 {
		_, err := st.Exec(ctx, `DELETE FROM browser_tabs`)
		return err
	}
	now := nowStr()
	var (
		vals []string
		args []any
		ids  []any
	)
	for _, t := range tabs {
		hist, _ := json.Marshal(t.History)
		vals = append(vals, "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		args = append(args, t.ID, t.URL, t.Title, t.Kind, string(hist), t.Cursor, b2i(t.Pinned), t.Position, b2i(t.Active), now)
		ids = append(ids, t.ID)
	}
	if _, err := st.Exec(ctx, `INSERT INTO browser_tabs (id, url, title, kind, history, cursor, pinned, position, active, updated_at)
		VALUES `+strings.Join(vals, ", ")+`
		ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, kind = excluded.kind,
		history = excluded.history, cursor = excluded.cursor, pinned = excluded.pinned, position = excluded.position,
		active = excluded.active, updated_at = excluded.updated_at`, args...); err != nil {
		return err
	}
	_, err := st.Exec(ctx, `DELETE FROM browser_tabs WHERE id NOT IN (`+strings.TrimSuffix(strings.Repeat("?, ", len(ids)), ", ")+`)`, ids...)
	return err
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}
