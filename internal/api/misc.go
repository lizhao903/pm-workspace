// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import "net/http"

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	// health 不查库，只证明进程活着；库是否可用看 /api/stats。
	respondData(w, http.StatusOK, map[string]any{"ok": true, "version": s.opt.Version})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	st, err := s.st.Stats(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if st == nil {
		st = map[string]any{}
	}
	// 版本号只有 API 层知道，顺手拼进状态栏数据。
	st["version"] = s.opt.Version
	respondData(w, http.StatusOK, st)
}

func (s *Server) handleCounts(w http.ResponseWriter, r *http.Request) {
	// type 只收窄聚焦类计数器；by_type / total 等恒为全局，见 store.Store.Counts 的注释。
	c, err := s.st.Counts(r.Context(), r.URL.Query().Get("type"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, c)
}

// handleRecentRevisions 是日报的数据源：全局最近变更。
func (s *Server) handleRecentRevisions(w http.ResponseWriter, r *http.Request) {
	limit, err := newParams(r).limit("limit", 100, 500)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.st.RecentRevisions(r.Context(), limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items), Limit: limit})
}

// nonNil 保证列表接口回 [] 而不是 null，前端就不用到处兜底。
func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
