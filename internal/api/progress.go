// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// progressLimitMax 与 sqlite 那边的上限一致；这里先钳一道，meta.limit 才报得准。
const progressLimitMax = 500

func (s *Server) handleListProgress(w http.ResponseWriter, r *http.Request) {
	limit, err := newParams(r).limit("limit", store.DefaultProgressLimit, progressLimitMax)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.st.ListProgress(r.Context(), r.PathValue("id"), limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items), Limit: limit})
}

func (s *Server) handleAppendProgress(w http.ResponseWriter, r *http.Request) {
	var in domain.ProgressInput
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	p, err := s.st.AppendProgress(r.Context(), r.PathValue("id"), in, actorFrom(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, p)
}

func (s *Server) handleClaimObject(w http.ResponseWriter, r *http.Request) {
	var in domain.ClaimInput
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	res, err := s.st.ClaimObject(r.Context(), r.PathValue("id"), in, actorFrom(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 重复领取什么都没写，回 200；真领到了回 201。调用方据此区分「我刚领到」和「本来就是我的」。
	code := http.StatusCreated
	if res.Already {
		code = http.StatusOK
	}
	respondData(w, code, res)
}
