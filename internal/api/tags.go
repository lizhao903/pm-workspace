// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"strings"
)

func (s *Server) handleListTags(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.ListTags(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

type createTagReq struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (s *Server) handleCreateTag(w http.ResponseWriter, r *http.Request) {
	var req createTagReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		s.fail(w, r, validationf("field %q is required", "name"))
		return
	}
	t, err := s.st.CreateTag(r.Context(), req.Name, req.Color)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, t)
}

func (s *Server) handleDeleteTag(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeleteTag(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}

type updateTagReq struct {
	Name  *string `json:"name"`
	Color *string `json:"color"`
}

func (s *Server) handleUpdateTag(w http.ResponseWriter, r *http.Request) {
	var req updateTagReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			s.fail(w, r, validationf("field %q must not be empty", "name"))
			return
		}
		req.Name = &name
	}
	t, err := s.st.UpdateTag(r.Context(), r.PathValue("id"), req.Name, req.Color)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, t)
}

type mergeTagsReq struct {
	TargetID string `json:"target_id"`
}

// handleMergeTags 把路径上的标签并进 target_id，返回合并后的目标标签。
func (s *Server) handleMergeTags(w http.ResponseWriter, r *http.Request) {
	var req mergeTagsReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	req.TargetID = strings.TrimSpace(req.TargetID)
	if req.TargetID == "" {
		s.fail(w, r, validationf("field %q is required", "target_id"))
		return
	}
	t, err := s.st.MergeTags(r.Context(), r.PathValue("id"), req.TargetID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, t)
}
