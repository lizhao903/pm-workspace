package api

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// typeIDRe 对应契约里的「小写英文短名」：它会拼进 URL 和 ref 前缀，格式必须收紧。
var typeIDRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

func (s *Server) handleListObjectTypes(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.ListObjectTypes(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

func (s *Server) handleCreateObjectType(w http.ResponseWriter, r *http.Request) {
	var t domain.ObjectType
	if err := decodeBody(r, &t); err != nil {
		s.fail(w, r, err)
		return
	}
	t.ID = strings.TrimSpace(strings.ToLower(t.ID))
	t.Name = strings.TrimSpace(t.Name)
	if !typeIDRe.MatchString(t.ID) {
		s.fail(w, r, validationf("invalid %q: expected a short lowercase name like task", "id"))
		return
	}
	if t.Name == "" {
		s.fail(w, r, validationf("field %q is required", "name"))
		return
	}
	t.Builtin = false // builtin 只能由迁移种子产生，不接受客户端声明。
	out, err := s.st.CreateObjectType(r.Context(), &t)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "create", "object_type", out.ID, "新建类型 "+out.Name, map[string]any{"name": out.Name})
	respondData(w, http.StatusCreated, out)
}

func (s *Server) handleUpdateObjectType(w http.ResponseWriter, r *http.Request) {
	var p domain.ObjectTypePatch
	if err := decodeBody(r, &p); err != nil {
		s.fail(w, r, err)
		return
	}
	// builtin 类型只准改 icon/color/sort_order/statuses，这条规则由 store 兜底。
	out, err := s.st.UpdateObjectType(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "update", "object_type", out.ID, "修改类型 "+out.Name, map[string]any{"name": out.Name, "fields": givenFields(map[string]bool{
		"name": p.Name != nil, "plural": p.Plural != nil, "ref_prefix": p.RefPrefix != nil, "icon": p.Icon != nil,
		"color": p.Color != nil, "sort_order": p.SortOrder != nil, "statuses": p.Statuses != nil,
	})})
	respondData(w, http.StatusOK, out)
}

func (s *Server) handleDeleteObjectType(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	label := id
	if t, err := s.st.GetObjectType(r.Context(), id); err == nil {
		label = t.Name
	}
	if err := s.st.DeleteObjectType(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "delete", "object_type", id, "删除类型 "+label, nil)
	respondData(w, http.StatusOK, nil)
}
