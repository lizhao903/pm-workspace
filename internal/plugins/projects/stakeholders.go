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

// Roles 是内置的五种角色，顺序和原型 STAKE_ROLE 一致。TSK-0718 起角色以内核字典 project_role 为准
// （内核迁移 0052 按这五个 key 种进去），这里只在字典还没有条目时兜底。
var Roles = []string{"decider", "contact", "owner", "member", "informed"}

// RoleDict 是项目干系人角色的字典 id（设置 / 枚举值里维护）。
const RoleDict = "project_role"

// roleExpr 是干系人的实际角色：插件迁移 0011 起存在 role_key，老数据 role_key 为空时用 role。
const roleExpr = `CASE WHEN role_key <> '' THEN role_key ELSE role END`

// checkedRole 是写进 role 列的值：0001 的 CHECK 只认内置五个，别的 key 写 member 占位，实际值在 role_key。
func checkedRole(key string) string {
	if slices.Contains(Roles, key) {
		return key
	}
	return "member"
}

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
	rows, err := h.c.Store().Query(ctx, `SELECT project_id, stakeholder_id, `+roleExpr+`, focus, sort_order, created_at, updated_at
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
	if err := h.checkRole(ctx, in.Role, ""); err != nil {
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
		(project_id, stakeholder_id, role, role_key, focus, sort_order, created_at, updated_at)
		SELECT ?, ?, ?, ?, ?, COALESCE(MAX(sort_order), 0) + 1, ?, ? FROM projects_stakeholders WHERE project_id = ?`,
		pid, in.StakeholderID, checkedRole(in.Role), in.Role, focus, now, now, pid)
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
		if err := h.checkRole(ctx, *in.Role, cur.Role); err != nil {
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
	if _, err := h.c.Store().Exec(ctx, `UPDATE projects_stakeholders SET role = ?, role_key = ?, focus = ?, sort_order = ?, updated_at = ?
		WHERE project_id = ? AND stakeholder_id = ?`, checkedRole(cur.Role), cur.Role, cur.Focus, cur.SortOrder, now, pid, sid); err != nil {
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
	s, err := scan(h.c.Store().QueryRow(ctx, `SELECT project_id, stakeholder_id, `+roleExpr+`, focus, sort_order, created_at, updated_at
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

// checkRole 按字典 project_role 校验角色（TSK-0718）：要是字典里没停用的条目；停用的只有和原来的角色相同时放行
// （改关注点、排序时带着原角色不报错）。字典还没有条目（内核迁移没跑）时退回内置五个。
func (h *stakeholders) checkRole(ctx context.Context, role, current string) error {
	items, err := h.c.Dicts().Items(ctx, RoleDict)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		if !slices.Contains(Roles, role) {
			return apiErr(errValidation, "role must be one of %s", strings.Join(Roles, ", "))
		}
		return nil
	}
	var active []string
	for _, it := range items {
		if it.Key == role {
			if it.Archived && role != current {
				return apiErr(errValidation, "role %s (%s) is archived; pick another role or re-enable it in Settings / Enums", role, it.Label)
			}
			return nil
		}
		if !it.Archived {
			active = append(active, it.Key)
		}
	}
	if role != "" && role == current {
		return nil // 字典里删掉了的旧值，原样留着
	}
	return apiErr(errValidation, "role must be one of %s (dictionary %s)", strings.Join(active, ", "), RoleDict)
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
