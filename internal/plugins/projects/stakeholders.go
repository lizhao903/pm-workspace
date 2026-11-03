package projects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 项目干系人（PJ-01b）：表 projects_stakeholders，接口 /api/projects/{id}/stakeholders，
// 契约见 docs/api-contract.md「项目插件」。

// Roles 是项目里的五种角色，顺序和原型 STAKE_ROLE 一致。
var Roles = []string{"decider", "contact", "owner", "member", "informed"}

const maxFocus = 500 // 关注点上限（字），原型里是一句话

// Stakeholder 是项目里的一个干系人。
type Stakeholder struct {
	ProjectID     string    `json:"project_id"`
	StakeholderID string    `json:"stakeholder_id"`
	Role          string    `json:"role"`
	Focus         string    `json:"focus"`
	SortOrder     int       `json:"sort_order"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type stakeholders struct{ c plugin.Core }

// 错误分类，对应信封里的 code
var (
	errValidation = errors.New("validation")
	errNotFound   = errors.New("not_found")
	errConflict   = errors.New("conflict")
)

func apiErr(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{kind}, args...)...)
}

func (h *stakeholders) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT project_id, stakeholder_id, role, focus, sort_order, created_at, updated_at
		FROM projects_stakeholders WHERE project_id = ? ORDER BY sort_order, created_at`, pid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Stakeholder{}
	for rows.Next() {
		s, err := scan(rows)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

type addInput struct {
	StakeholderID string  `json:"stakeholder_id"`
	Role          string  `json:"role"`
	Focus         *string `json:"focus"`
}

func (h *stakeholders) add(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	var in addInput
	if err := decode(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	in.StakeholderID = strings.TrimSpace(in.StakeholderID)
	if in.StakeholderID == "" {
		h.fail(w, r, apiErr(errValidation, "stakeholder_id is required"))
		return
	}
	if err := checkRole(in.Role); err != nil {
		h.fail(w, r, err)
		return
	}
	focus, err := cleanFocus(in.Focus)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	ct, err := h.c.Contacts().Get(ctx, in.StakeholderID)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		h.fail(w, r, apiErr(errValidation, "stakeholder %s not found", in.StakeholderID))
		return
	case err != nil:
		h.fail(w, r, err)
		return
	case ct.Archived:
		h.fail(w, r, apiErr(errValidation, "stakeholder %s is archived", ct.Name))
		return
	}
	if _, err := h.get(ctx, pid, in.StakeholderID); err == nil {
		h.fail(w, r, apiErr(errConflict, "stakeholder %s is already in this project; change the role instead", ct.Name))
		return
	} else if !errors.Is(err, errNotFound) {
		h.fail(w, r, err)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	// 排在最后：sort_order 取本项目现有最大值加一
	_, err = h.c.Store().Exec(ctx, `INSERT INTO projects_stakeholders
		(project_id, stakeholder_id, role, focus, sort_order, created_at, updated_at)
		SELECT ?, ?, ?, ?, COALESCE(MAX(sort_order), 0) + 1, ?, ? FROM projects_stakeholders WHERE project_id = ?`,
		pid, in.StakeholderID, in.Role, focus, now, now, pid)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			err = apiErr(errConflict, "stakeholder %s is already in this project; change the role instead", ct.Name)
		}
		h.fail(w, r, err)
		return
	}
	s, err := h.get(ctx, pid, in.StakeholderID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": s})
}

type patchInput struct {
	Role      *string `json:"role"`
	Focus     *string `json:"focus"`
	SortOrder *int    `json:"sort_order"`
}

func (h *stakeholders) update(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid, sid := r.PathValue("id"), r.PathValue("stakeholder_id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	var in patchInput
	if err := decode(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	cur, err := h.get(ctx, pid, sid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if in.Role != nil {
		if err := checkRole(*in.Role); err != nil {
			h.fail(w, r, err)
			return
		}
		cur.Role = *in.Role
	}
	if in.Focus != nil {
		if cur.Focus, err = cleanFocus(in.Focus); err != nil {
			h.fail(w, r, err)
			return
		}
	}
	if in.SortOrder != nil {
		cur.SortOrder = *in.SortOrder
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `UPDATE projects_stakeholders SET role = ?, focus = ?, sort_order = ?, updated_at = ?
		WHERE project_id = ? AND stakeholder_id = ?`, cur.Role, cur.Focus, cur.SortOrder, now, pid, sid); err != nil {
		h.fail(w, r, err)
		return
	}
	s, err := h.get(ctx, pid, sid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s})
}

func (h *stakeholders) remove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid, sid := r.PathValue("id"), r.PathValue("stakeholder_id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	res, err := h.c.Store().Exec(ctx, `DELETE FROM projects_stakeholders WHERE project_id = ? AND stakeholder_id = ?`, pid, sid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		h.fail(w, r, apiErr(errNotFound, "stakeholder %s is not in this project", sid))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// project 确认 id 是一个没进回收站的项目，否则 404。
func (h *stakeholders) project(ctx context.Context, id string) error {
	o, err := h.c.Objects().Get(ctx, id)
	if errors.Is(err, plugin.ErrNoRows) || (err == nil && (o.Type != "project" || o.Deleted)) {
		return apiErr(errNotFound, "project not found")
	}
	return err
}

func (h *stakeholders) get(ctx context.Context, pid, sid string) (Stakeholder, error) {
	s, err := scan(h.c.Store().QueryRow(ctx, `SELECT project_id, stakeholder_id, role, focus, sort_order, created_at, updated_at
		FROM projects_stakeholders WHERE project_id = ? AND stakeholder_id = ?`, pid, sid))
	if errors.Is(err, plugin.ErrNoRows) {
		return Stakeholder{}, apiErr(errNotFound, "stakeholder %s is not in this project", sid)
	}
	return s, err
}

func scan(row plugin.Row) (Stakeholder, error) {
	var s Stakeholder
	var created, updated string
	if err := row.Scan(&s.ProjectID, &s.StakeholderID, &s.Role, &s.Focus, &s.SortOrder, &created, &updated); err != nil {
		return Stakeholder{}, err
	}
	s.CreatedAt, _ = time.Parse(time.RFC3339, created)
	s.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	return s, nil
}

func checkRole(role string) error {
	if !slices.Contains(Roles, role) {
		return apiErr(errValidation, "role must be one of %s", strings.Join(Roles, ", "))
	}
	return nil
}

func cleanFocus(p *string) (string, error) {
	if p == nil {
		return "", nil
	}
	f := strings.TrimSpace(*p)
	if utf8.RuneCountInString(f) > maxFocus {
		return "", apiErr(errValidation, "focus is limited to %d characters", maxFocus)
	}
	return f, nil
}

func decode(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10+1))
	if err != nil {
		return apiErr(errValidation, "read body: %v", err)
	}
	if len(body) > 64<<10 {
		return apiErr(errValidation, "body too large")
	}
	if err := json.Unmarshal(body, v); err != nil {
		return apiErr(errValidation, "invalid json: %v", err)
	}
	return nil
}

// fail 按内核的错误信封写回：{"error":{"code","message"}}。
func (h *stakeholders) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, errNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, errConflict):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, errValidation):
		status, code = http.StatusBadRequest, "validation"
	default:
		h.c.Log().Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		msg = "internal server error"
	}
	if code != "internal" {
		// 去掉 "validation: " 这类分类前缀，只留给人看的部分
		_, msg, _ = strings.Cut(msg, ": ")
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
