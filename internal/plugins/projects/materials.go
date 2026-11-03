package projects

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 项目资料（PJ-03a）：表 projects_materials，接口 /api/projects/{id}/materials，
// 契约见 docs/api-contract.md「项目插件」。支持材料和项目文档合成一种，项目文档就是带 category 的资料。

// Kinds 是资料的四种，和原型 MaterialKind 一致。
var Kinds = []string{"file", "folder", "link", "note"}

// DocStatuses 是项目文档的状态，空串表示不跟踪，和原型 DOC_STATUS 一致。
var DocStatuses = []string{"", "draft", "review", "final"}

const (
	dirMime     = "inode/directory"
	maxName     = 200
	maxPath     = 4096
	maxURL      = 2048
	maxNote     = 5000
	maxCategory = 50
	maxTags     = 20
	maxTag      = 30
)

// Material 是项目里的一条资料。value 按种类：文件、文件夹是绝对路径，链接是网址，笔记是正文。
type Material struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Kind      string    `json:"kind"`
	Name      string    `json:"name"`
	Value     string    `json:"value"`
	Category  string    `json:"category"`
	Status    string    `json:"status"`
	Tags      []string  `json:"tags"`
	Source    string    `json:"source"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// materials 和干系人共用项目校验、错误信封。
type materials struct{ *stakeholders }

const materialCols = `id, project_id, path, url, note, mime, name, category, status, props, source, created_at, updated_at`

func (h *materials) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind != "" && !slices.Contains(Kinds, kind) {
		h.fail(w, r, apiErr(errValidation, "kind must be one of %s", strings.Join(Kinds, ", ")))
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT `+materialCols+` FROM projects_materials
		WHERE project_id = ? ORDER BY created_at, rowid`, pid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Material{}
	for rows.Next() {
		m, err := scanMaterial(rows)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		if kind == "" || m.Kind == kind {
			out = append(out, m)
		}
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *materials) show(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	m, err := h.getMaterial(ctx, pid, r.PathValue("material_id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": m})
}

type materialInput struct {
	Kind     *string   `json:"kind"`
	Name     *string   `json:"name"`
	Value    *string   `json:"value"`
	Category *string   `json:"category"`
	Status   *string   `json:"status"`
	Tags     *[]string `json:"tags"`
}

func (h *materials) add(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	var in materialInput
	if err := decode(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	if in.Kind == nil || !slices.Contains(Kinds, *in.Kind) {
		h.fail(w, r, apiErr(errValidation, "kind must be one of %s", strings.Join(Kinds, ", ")))
		return
	}
	m := Material{ProjectID: pid, Kind: *in.Kind, Tags: []string{}, Source: "manual"}
	if in.Value == nil {
		h.fail(w, r, apiErr(errValidation, "value is required"))
		return
	}
	if err := applyMaterial(&m, in); err != nil {
		h.fail(w, r, err)
		return
	}
	loc := locate(m)
	props, _ := json.Marshal(map[string]any{"tags": m.Tags})
	now := time.Now().UTC().Format(time.RFC3339)
	m.ID = idgen.Prefixed("mt")
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO projects_materials
		(id, project_id, path, url, note, mime, name, category, status, props, source, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, pid, loc.path, loc.url, loc.note, loc.mime, m.Name, m.Category, m.Status, string(props), m.Source, now, now); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.getMaterial(ctx, pid, m.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

func (h *materials) update(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid, mid := r.PathValue("id"), r.PathValue("material_id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	var in materialInput
	if err := decode(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	m, props, err := h.loadMaterial(ctx, pid, mid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if in.Kind != nil && *in.Kind != m.Kind {
		// 换种类只在笔记和链接之间、文件和文件夹之间；值按新种类重新校验（没传 value 时校验原来的值）
		if !canSwitchKind(m.Kind, *in.Kind) {
			h.fail(w, r, apiErr(errValidation, "kind can only change between note and link, or between file and folder"))
			return
		}
		if in.Value == nil {
			v := m.Value
			in.Value = &v
		}
		m.Kind = *in.Kind
	}
	if err := applyMaterial(&m, in); err != nil {
		h.fail(w, r, err)
		return
	}
	// props 里除 tags 以外的 key 原样保留
	props["tags"] = m.Tags
	pj, _ := json.Marshal(props)
	loc := locate(m)
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `UPDATE projects_materials SET path = ?, url = ?, note = ?, mime = ?, name = ?,
		category = ?, status = ?, props = ?, updated_at = ? WHERE project_id = ? AND id = ?`,
		loc.path, loc.url, loc.note, loc.mime, m.Name, m.Category, m.Status, string(pj), now, pid, mid); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.getMaterial(ctx, pid, mid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (h *materials) remove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid, mid := r.PathValue("id"), r.PathValue("material_id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	// 只删登记行，不动本机文件
	res, err := h.c.Store().Exec(ctx, `DELETE FROM projects_materials WHERE project_id = ? AND id = ?`, pid, mid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		h.fail(w, r, apiErr(errNotFound, "material %s is not in this project", mid))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// kindGroups 是能互换种类的组：笔记和链接都是一段文本，文件和文件夹都是本机路径（0.9.1 起）。
var kindGroups = [][]string{{"note", "link"}, {"file", "folder"}}

func canSwitchKind(from, to string) bool {
	for _, g := range kindGroups {
		if slices.Contains(g, from) && slices.Contains(g, to) {
			return true
		}
	}
	return false
}

// applyMaterial 把传了的字段校验后写进 m，m.Kind 已定。
func applyMaterial(m *Material, in materialInput) error {
	if in.Value != nil {
		v, err := cleanValue(m.Kind, *in.Value)
		if err != nil {
			return err
		}
		m.Value = v
	}
	if in.Name != nil {
		m.Name = strings.TrimSpace(*in.Name)
	}
	if m.Name == "" {
		m.Name = defaultName(m.Kind, m.Value)
	}
	if utf8.RuneCountInString(m.Name) > maxName {
		return apiErr(errValidation, "name is limited to %d characters", maxName)
	}
	if in.Category != nil {
		m.Category = strings.TrimSpace(*in.Category)
		if utf8.RuneCountInString(m.Category) > maxCategory {
			return apiErr(errValidation, "category is limited to %d characters", maxCategory)
		}
	}
	if in.Status != nil {
		if !slices.Contains(DocStatuses, *in.Status) {
			return apiErr(errValidation, "status must be empty or one of draft, review, final")
		}
		m.Status = *in.Status
	}
	if in.Tags != nil {
		tags, err := cleanTags(*in.Tags)
		if err != nil {
			return err
		}
		m.Tags = tags
	}
	return nil
}

func cleanValue(kind, raw string) (string, error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", apiErr(errValidation, "value is required")
	}
	switch kind {
	case "file", "folder":
		if strings.ContainsRune(v, 0) || !filepath.IsAbs(v) {
			return "", apiErr(errValidation, "value must be an absolute path")
		}
		v = filepath.Clean(v)
		if len(v) > maxPath {
			return "", apiErr(errValidation, "path is limited to %d bytes", maxPath)
		}
	case "link":
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return "", apiErr(errValidation, "value must be an http or https url")
		}
		if len(v) > maxURL {
			return "", apiErr(errValidation, "url is limited to %d bytes", maxURL)
		}
	case "note":
		if utf8.RuneCountInString(v) > maxNote {
			return "", apiErr(errValidation, "note is limited to %d characters", maxNote)
		}
	}
	return v, nil
}

// defaultName 是没给名字时的名字：文件取文件名，链接取网址，笔记取第一行。
func defaultName(kind, value string) string {
	switch kind {
	case "file", "folder":
		return filepath.Base(value)
	case "note":
		line, _, _ := strings.Cut(value, "\n")
		line = strings.TrimSpace(line)
		if rs := []rune(line); len(rs) > 40 {
			line = string(rs[:40])
		}
		return line
	}
	if rs := []rune(value); len(rs) > maxName {
		return string(rs[:maxName])
	}
	return value
}

func cleanTags(in []string) ([]string, error) {
	out := []string{}
	for _, t := range in {
		t = strings.TrimSpace(t)
		if t == "" || slices.Contains(out, t) {
			continue
		}
		if utf8.RuneCountInString(t) > maxTag {
			return nil, apiErr(errValidation, "each tag is limited to %d characters", maxTag)
		}
		out = append(out, t)
	}
	if len(out) > maxTags {
		return nil, apiErr(errValidation, "at most %d tags", maxTags)
	}
	return out, nil
}

type location struct{ path, url, note, mime string }

func locate(m Material) location {
	switch m.Kind {
	case "file":
		return location{path: m.Value}
	case "folder":
		return location{path: m.Value, mime: dirMime}
	case "link":
		return location{url: m.Value}
	}
	return location{note: m.Value}
}

func (h *materials) getMaterial(ctx context.Context, pid, mid string) (Material, error) {
	m, _, err := h.loadMaterial(ctx, pid, mid)
	return m, err
}

// loadMaterial 连 props 一起读回，改的时候保留 tags 以外的 key。
func (h *materials) loadMaterial(ctx context.Context, pid, mid string) (Material, map[string]any, error) {
	row := h.c.Store().QueryRow(ctx, `SELECT `+materialCols+` FROM projects_materials WHERE project_id = ? AND id = ?`, pid, mid)
	m, props, err := scanMaterialProps(row)
	if errors.Is(err, plugin.ErrNoRows) {
		return Material{}, nil, apiErr(errNotFound, "material %s is not in this project", mid)
	}
	return m, props, err
}

func scanMaterial(row plugin.Row) (Material, error) {
	m, _, err := scanMaterialProps(row)
	return m, err
}

func scanMaterialProps(row plugin.Row) (Material, map[string]any, error) {
	var m Material
	var loc location
	var props, created, updated string
	if err := row.Scan(&m.ID, &m.ProjectID, &loc.path, &loc.url, &loc.note, &loc.mime, &m.Name,
		&m.Category, &m.Status, &props, &m.Source, &created, &updated); err != nil {
		return Material{}, nil, err
	}
	switch {
	case loc.path != "" && loc.mime == dirMime:
		m.Kind, m.Value = "folder", loc.path
	case loc.path != "":
		m.Kind, m.Value = "file", loc.path
	case loc.url != "":
		m.Kind, m.Value = "link", loc.url
	default:
		m.Kind, m.Value = "note", loc.note
	}
	p := map[string]any{}
	_ = json.Unmarshal([]byte(props), &p)
	m.Tags = []string{}
	if ts, ok := p["tags"].([]any); ok {
		for _, t := range ts {
			if s, ok := t.(string); ok {
				m.Tags = append(m.Tags, s)
			}
		}
	}
	m.CreatedAt, _ = time.Parse(time.RFC3339, created)
	m.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	return m, p, nil
}
