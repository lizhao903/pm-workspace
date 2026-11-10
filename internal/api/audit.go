// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"sort"

	"github.com/lizhao903/pm-workspace/internal/audit"
)

// withActor 把取证头解析出的操作者放进 ctx：不带 Actor 参数的 store 方法（删分类、删标签、建关联…）
// 在审计包装里靠它知道是谁、是不是 Agent。
func withActor(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(audit.WithActor(r.Context(), actorFrom(r))))
	})
}

// auditConfig 记一条配置变更，在 handler 成功之后调。没接审计时什么都不做。
func (s *Server) auditConfig(r *http.Request, action, targetType, targetID, summary string, detail map[string]any) {
	s.opt.Audit.Note(r.Context(), audit.Entry{
		Kind: audit.KindConfig, Action: action, TargetType: targetType, TargetID: targetID,
		Summary: summary, Detail: detail,
	})
}

// givenFields 列出 PATCH body 里给了的字段名（只记名字不记值），排好序。
func givenFields(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k, ok := range set {
		if ok {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func (s *Server) handleListAudits(w http.ResponseWriter, r *http.Request) {
	if s.opt.Audit == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "audit log is not configured on this server"}})
		return
	}
	p := newParams(r)
	f := audit.Filter{
		TargetType: p.str("target_type"),
		TargetID:   p.str("target_id"),
		Kinds:      p.csv("kind"),
		Action:     p.str("action"),
		Actor:      p.str("actor"),
		Source:     p.str("source"),
	}
	var err error
	if f.Since, err = p.timeAt("since", dayStart); err != nil {
		s.fail(w, r, err)
		return
	}
	if f.Until, err = p.timeAt("until", dayEnd); err != nil {
		s.fail(w, r, err)
		return
	}
	if f.Limit, err = p.limit("limit", defaultLimit, maxLimit); err != nil {
		s.fail(w, r, err)
		return
	}
	if f.Offset, err = p.intRange("offset", 0, 0, 1<<30); err != nil {
		s.fail(w, r, err)
		return
	}
	items, total, err := s.opt.Audit.List(r.Context(), f)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: total, Limit: f.Limit, Offset: f.Offset})
}
