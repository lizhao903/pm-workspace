package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func (s *Server) handleListObjects(w http.ResponseWriter, r *http.Request) {
	f, err := objectFilter(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, total, err := s.st.ListObjects(r.Context(), f)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: total, Limit: f.Limit, Offset: f.Offset})
}

// createObjectReq 对应 web 的 CreateObjectInput。due_at 收成 RawMessage 是因为
// 前端既可能传 RFC3339 也可能传 YYYY-MM-DD（日期选择器）。
type createObjectReq struct {
	TypeID     string          `json:"type_id"`
	Title      string          `json:"title"`
	Body       string          `json:"body"`
	Status     string          `json:"status"`
	Priority   string          `json:"priority"`
	Owner      string          `json:"owner"`
	Source     string          `json:"source"`
	CategoryID *string         `json:"category_id"`
	ProjectID  *string         `json:"project_id"`
	Props      map[string]any  `json:"props"`
	Workdir    string          `json:"workdir"`
	DueAt      json.RawMessage `json:"due_at"`
	Tags       []string        `json:"tags"`
}

func (s *Server) handleCreateObject(w http.ResponseWriter, r *http.Request) {
	var req createObjectReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if strings.TrimSpace(req.TypeID) == "" {
		s.fail(w, r, validationf("field %q is required", "type_id"))
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		s.fail(w, r, validationf("field %q is required", "title"))
		return
	}
	due, err := parseJSONTime("due_at", req.DueAt)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	o := &domain.Object{
		TypeID:     strings.TrimSpace(req.TypeID),
		Title:      strings.TrimSpace(req.Title),
		Body:       req.Body,
		Status:     req.Status,
		Priority:   req.Priority,
		Owner:      req.Owner,
		Source:     req.Source,
		CategoryID: req.CategoryID,
		ProjectID:  req.ProjectID,
		Props:      req.Props,
		Workdir:    strings.TrimSpace(req.Workdir),
		DueAt:      due,
		Tags:       req.Tags,
	}
	out, err := s.st.CreateObject(r.Context(), o, actorFrom(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, out)
}

func (s *Server) handleGetObject(w http.ResponseWriter, r *http.Request) {
	o, err := s.st.GetObject(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, o)
}

func (s *Server) handleUpdateObject(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	p, err := parseObjectPatch(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	o, err := s.st.UpdateObject(r.Context(), r.PathValue("id"), p, actorFrom(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, o)
}

func (s *Server) handleDeleteObject(w http.ResponseWriter, r *http.Request) {
	hard, err := newParams(r).boolean("hard")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.st.DeleteObject(r.Context(), r.PathValue("id"), hard, actorFrom(r)); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}

func (s *Server) handleRestoreObject(w http.ResponseWriter, r *http.Request) {
	o, err := s.st.RestoreObject(r.Context(), r.PathValue("id"), actorFrom(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, o)
}

func (s *Server) handleObjectRevisions(w http.ResponseWriter, r *http.Request) {
	limit, err := newParams(r).limit("limit", defaultLimit, maxLimit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.st.ListRevisions(r.Context(), r.PathValue("id"), limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items), Limit: limit})
}

// --- PATCH 解析 ---

// parseObjectPatch 手工解析 PATCH 体，因为 encoding/json 直接 unmarshal 到 **T 时
// 无法区分「字段缺失」与「字段为 null」——两者都留下 nil。这里先看 key 在不在，
// 再决定是不改（nil）、置空（指向 nil 的指针）还是赋值。
func parseObjectPatch(body []byte) (domain.ObjectPatch, error) {
	var p domain.ObjectPatch
	raw, err := patchKeys(body)
	if err != nil {
		return p, err
	}
	if p.Title, err = patchField[string](raw, "title", "a string"); err != nil {
		return p, err
	}
	if p.Body, err = patchField[string](raw, "body", "a string"); err != nil {
		return p, err
	}
	if p.Status, err = patchField[string](raw, "status", "a string"); err != nil {
		return p, err
	}
	if p.Priority, err = patchField[string](raw, "priority", "a string"); err != nil {
		return p, err
	}
	if p.Owner, err = patchField[string](raw, "owner", "a string"); err != nil {
		return p, err
	}
	if p.Source, err = patchField[string](raw, "source", "a string"); err != nil {
		return p, err
	}
	if p.Props, err = patchField[map[string]any](raw, "props", "an object"); err != nil {
		return p, err
	}
	// Workdir 是单指针：空串本身就是「没有工作区」的合法取值，不需要区分 null 和 ""。
	if p.Workdir, err = patchField[string](raw, "workdir", "a string"); err != nil {
		return p, err
	}
	if p.Tags, err = patchField[[]string](raw, "tags", "an array of strings"); err != nil {
		return p, err
	}
	if p.Archived, err = patchField[bool](raw, "archived", "a boolean"); err != nil {
		return p, err
	}
	if p.CategoryID, err = patchNullable[string](raw, "category_id", "a string or null"); err != nil {
		return p, err
	}
	if p.ProjectID, err = patchNullable[string](raw, "project_id", "a string or null"); err != nil {
		return p, err
	}

	// due_at 要兼容 YYYY-MM-DD，不能直接走泛型分支。
	if v, ok := raw["due_at"]; ok {
		var inner *time.Time
		if !isJSONNull(v) {
			t, perr := parseJSONTime("due_at", v)
			if perr != nil {
				return p, perr
			}
			inner = t
		}
		p.DueAt = &inner
	}
	return p, nil
}

func isJSONNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

// patchField 处理普通字段：缺失返回 nil（不改），出现则取值。这类字段不支持置空，
// 传 null 直接报错，免得静默变成零值。
func patchField[T any](raw map[string]json.RawMessage, key, want string) (*T, error) {
	v, ok := raw[key]
	if !ok {
		return nil, nil
	}
	if isJSONNull(v) {
		return nil, validationf("invalid %q: null is not allowed, expected %s", key, want)
	}
	var out T
	if err := json.Unmarshal(v, &out); err != nil {
		return nil, validationf("invalid %q: expected %s", key, want)
	}
	return &out, nil
}

// patchNullable 处理可置空字段：缺失 nil，null 返回指向 nil 的指针，有值返回双层指针。
func patchNullable[T any](raw map[string]json.RawMessage, key, want string) (**T, error) {
	v, ok := raw[key]
	if !ok {
		return nil, nil
	}
	var inner *T
	if isJSONNull(v) {
		return &inner, nil
	}
	var out T
	if err := json.Unmarshal(v, &out); err != nil {
		return nil, validationf("invalid %q: expected %s", key, want)
	}
	inner = &out
	return &inner, nil
}

// parseJSONTime 解析 JSON 里的时间：缺省/null 返回 nil，字符串支持 RFC3339 与 YYYY-MM-DD。
func parseJSONTime(field string, raw json.RawMessage) (*time.Time, error) {
	if len(bytes.TrimSpace(raw)) == 0 || isJSONNull(raw) {
		return nil, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, validationf("invalid %q: expected an RFC3339 string", field)
	}
	if s = strings.TrimSpace(s); s == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return &t, nil
	}
	if d, err := time.ParseInLocation("2006-01-02", s, time.Local); err == nil {
		t := d.Add(24*time.Hour - time.Second)
		return &t, nil
	}
	return nil, validationf("invalid %q: expected RFC3339 or YYYY-MM-DD", field)
}
