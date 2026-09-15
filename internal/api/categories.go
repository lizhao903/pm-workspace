package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func (s *Server) handleListCategories(w http.ResponseWriter, r *http.Request) {
	p := newParams(r)
	typeID := p.str("type")
	tree, err := p.boolean("tree")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	counts, err := p.boolean("counts")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var items []*domain.Category
	if tree {
		items, err = s.st.CategoryTree(r.Context(), typeID, counts)
	} else {
		items, err = s.st.ListCategories(r.Context(), typeID, counts)
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

type createCategoryReq struct {
	TypeID      string  `json:"type_id"`
	ParentID    *string `json:"parent_id"`
	Name        string  `json:"name"`
	Slug        string  `json:"slug"`
	Color       string  `json:"color"`
	Description string  `json:"description"`
	SortOrder   int     `json:"sort_order"`
}

func (s *Server) handleCreateCategory(w http.ResponseWriter, r *http.Request) {
	var req createCategoryReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if strings.TrimSpace(req.TypeID) == "" {
		s.fail(w, r, validationf("field %q is required", "type_id"))
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		s.fail(w, r, validationf("field %q is required", "name"))
		return
	}
	// slug 为空时由 store 按 name 生成，它才知道同层是否重名。
	c := &domain.Category{
		TypeID:      strings.TrimSpace(req.TypeID),
		ParentID:    req.ParentID,
		Name:        strings.TrimSpace(req.Name),
		Slug:        strings.TrimSpace(req.Slug),
		Color:       req.Color,
		Description: req.Description,
		SortOrder:   req.SortOrder,
	}
	out, err := s.st.CreateCategory(r.Context(), c)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, out)
}

func (s *Server) handleUpdateCategory(w http.ResponseWriter, r *http.Request) {
	var p domain.CategoryPatch
	if err := decodeBody(r, &p); err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.st.UpdateCategory(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

// handleMoveCategory 的 parent_id 传 null 表示移到根；缺省同样按根处理。
func (s *Server) handleMoveCategory(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	parentID, sortOrder, err := parseMoveRequest(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.st.MoveCategory(r.Context(), r.PathValue("id"), parentID, sortOrder)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

func parseMoveRequest(body []byte) (*string, int, error) {
	var raw map[string]json.RawMessage
	if len(body) == 0 {
		return nil, 0, validationf("request body is required")
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, 0, validationf("malformed JSON body: %v", err)
	}
	var parentID *string
	if v, ok := raw["parent_id"]; ok && !isJSONNull(v) {
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			return nil, 0, validationf("invalid %q: expected a string or null", "parent_id")
		}
		if s = strings.TrimSpace(s); s != "" {
			parentID = &s
		}
	}
	var sortOrder int
	if v, ok := raw["sort_order"]; ok && !isJSONNull(v) {
		if err := json.Unmarshal(v, &sortOrder); err != nil {
			return nil, 0, validationf("invalid %q: expected an integer", "sort_order")
		}
	}
	return parentID, sortOrder, nil
}

func (s *Server) handleDeleteCategory(w http.ResponseWriter, r *http.Request) {
	var reassign *string
	if v := newParams(r).str("reassign_to"); v != "" {
		reassign = &v
	}
	if err := s.st.DeleteCategory(r.Context(), r.PathValue("id"), reassign); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}
