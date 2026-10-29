package browser

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 地址白名单（BR-01a 存，BR-02a 用）：主机名在这里的地址按能嵌入处理。
// 本机地址是内置的，不落表、删不掉；内网域名后缀由前端带上（插件之间不互读）。

// BuiltinHosts 是内置在白名单里的本机地址
var BuiltinHosts = []string{"127.0.0.1", "localhost"}

const (
	maxHost = 253
	maxNote = 200
)

// AllowEntry 是白名单里的一项；内置的 builtin 为 true、created_at 为 null。
type AllowEntry struct {
	Host      string  `json:"host"`
	Note      string  `json:"note"`
	Builtin   bool    `json:"builtin"`
	CreatedAt *string `json:"created_at"`
}

// 主机名：小写字母、数字、连字符，点隔开；开头可以是 *.（所有子域名）
var hostLabelRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// normHost 把输入规整成主机名：去掉协议、路径、端口，转小写；不合法回错误。
func normHost(raw string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil || u.Hostname() == "" {
			return "", apiErr(errValidation, "主机名不合法：%s", raw)
		}
		s = u.Hostname()
	} else {
		if i := strings.IndexAny(s, "/?#"); i >= 0 {
			s = s[:i]
		}
		if h, _, err := net.SplitHostPort(s); err == nil {
			s = h
		}
	}
	s = strings.TrimSuffix(s, ".")
	if s == "" || len(s) > maxHost {
		return "", apiErr(errValidation, "主机名不能为空，最长 %d 个字符", maxHost)
	}
	if net.ParseIP(strings.Trim(s, "[]")) != nil {
		return strings.Trim(s, "[]"), nil
	}
	name := strings.TrimPrefix(s, "*.")
	for _, l := range strings.Split(name, ".") {
		if !hostLabelRe.MatchString(l) {
			return "", apiErr(errValidation, "主机名不合法：%s", raw)
		}
	}
	return s, nil
}

func (h *handler) listAllow(w http.ResponseWriter, r *http.Request) {
	out := make([]AllowEntry, 0, len(BuiltinHosts))
	for _, host := range BuiltinHosts {
		out = append(out, AllowEntry{Host: host, Builtin: true})
	}
	rows, err := h.c.Store().Query(r.Context(), `SELECT host, note, created_at FROM browser_allowlist ORDER BY created_at, rowid`)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			e  AllowEntry
			at string
		)
		if err := rows.Scan(&e.Host, &e.Note, &at); err != nil {
			fail(w, r, h.c, err)
			return
		}
		e.CreatedAt = &at
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// addAllow 加一项：body {host, note?}，回 201 + AllowEntry；已经有了（含内置的）409。
func (h *handler) addAllow(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r, false, "host", "note")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var hostIn, note string
	if v, ok := raw["host"]; !ok || json.Unmarshal(v, &hostIn) != nil {
		fail(w, r, h.c, apiErr(errValidation, "host 必填，要是字符串"))
		return
	}
	if v, ok := raw["note"]; ok && !isNull(v) {
		if json.Unmarshal(v, &note) != nil {
			fail(w, r, h.c, apiErr(errValidation, "note 必须是字符串"))
			return
		}
		if note = strings.TrimSpace(note); utf8.RuneCountInString(note) > maxNote {
			fail(w, r, h.c, apiErr(errValidation, "备注最多 %d 字", maxNote))
			return
		}
	}
	host, err := normHost(hostIn)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if slices.Contains(BuiltinHosts, host) {
		fail(w, r, h.c, apiErr(errConflict, "%s 是本机地址，已经内置在白名单里", host))
		return
	}
	now := nowStr()
	res, err := h.c.Store().Exec(r.Context(), `INSERT INTO browser_allowlist (host, note, created_at) VALUES (?, ?, ?)
		ON CONFLICT(host) DO NOTHING`, host, note, now)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, r, h.c, apiErr(errConflict, "白名单里已经有 %s 了", host))
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": AllowEntry{Host: host, Note: note, CreatedAt: &now}})
}

// removeAllow 删一项：DELETE /api/browser/allowlist?host=；内置的 409，没有 404。
func (h *handler) removeAllow(w http.ResponseWriter, r *http.Request) {
	host, err := normHost(r.URL.Query().Get("host"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if slices.Contains(BuiltinHosts, host) {
		fail(w, r, h.c, apiErr(errConflict, "本机地址 %s 是内置的，不能移出白名单", host))
		return
	}
	var got string
	err = h.c.Store().QueryRow(r.Context(), `SELECT host FROM browser_allowlist WHERE host = ?`, host).Scan(&got)
	if errors.Is(err, plugin.ErrNoRows) {
		fail(w, r, h.c, apiErr(errNotFound, "白名单里没有 %s", host))
		return
	}
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(r.Context(), `DELETE FROM browser_allowlist WHERE host = ?`, host); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

func isNull(v json.RawMessage) bool { return strings.TrimSpace(string(v)) == "null" }
