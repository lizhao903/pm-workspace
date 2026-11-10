// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func (s *Server) handleListLinks(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.ListLinks(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

type createLinkReq struct {
	ToID     string `json:"to_id"`
	Relation string `json:"relation"`
	Note     string `json:"note"`
}

// handleCreateLink 回 LinkView 而不是裸 Link：前端拿到就能直接渲染进关联列表，
// 不用再补一次请求去查对端标题。
func (s *Server) handleCreateLink(w http.ResponseWriter, r *http.Request) {
	var req createLinkReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	req.ToID = strings.TrimSpace(req.ToID)
	req.Relation = strings.TrimSpace(req.Relation)
	if req.ToID == "" {
		s.fail(w, r, validationf("field %q is required", "to_id"))
		return
	}
	if req.Relation == "" {
		s.fail(w, r, validationf("field %q is required", "relation"))
		return
	}
	l, err := s.st.CreateLink(r.Context(), r.PathValue("id"), req.ToID, req.Relation, req.Note)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	view := &domain.LinkView{Link: *l, Direction: "out"}
	// 对端查不到不算失败：关联已经建好，peer 只是展示用。
	if peer, perr := s.st.GetObject(r.Context(), l.ToID); perr == nil {
		view.Peer = peer
	}
	respondData(w, http.StatusCreated, view)
}

func (s *Server) handleDeleteLink(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeleteLink(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}
