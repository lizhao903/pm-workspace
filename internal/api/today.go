package api

import "net/http"

// handleToday 是今日页的聚合接口：一次请求拿全内核卡片。
// type 的语义和 /api/counts 一样，前端拿同一个 type 去比对徽标。
func (s *Server) handleToday(w http.ResponseWriter, r *http.Request) {
	t, err := s.st.Today(r.Context(), newParams(r).str("type"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, t)
}
