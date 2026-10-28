package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// maxArtifactLimit 是一页最多返回的产物数。产物页要「统计全部」，所以上限
// 比对象列表宽松；但仍然要有上限——没有的话一个 limit=999999 就会把整张表
// 连同每条的 note 一次序列化进内存。
const maxArtifactLimit = 500

// artifactFilter 把 query string 翻成领域过滤器。
// 列表和统计两个接口共用它，这样「筛选后的列表」和「筛选后的统计」永远同源。
func artifactFilter(r *http.Request) (domain.ArtifactFilter, error) {
	p := newParams(r)
	f := domain.ArtifactFilter{
		ObjectID:  p.str("object_id"),
		SessionID: p.str("session_id"),
		RunID:     p.str("run_id"),
		Platform:  p.str("platform"),
		Source:    p.str("source"),
		Q:         p.str("q"),
	}

	var err error
	if f.Unscoped, err = p.boolean("unscoped"); err != nil {
		return f, err
	}
	if f.HasURL, err = p.triBool("has_url"); err != nil {
		return f, err
	}
	if f.HasPath, err = p.triBool("has_path"); err != nil {
		return f, err
	}
	if f.Limit, err = p.limit("limit", store.DefaultArtifactLimit, maxArtifactLimit); err != nil {
		return f, err
	}
	if f.Offset, err = p.intRange("offset", 0, 0, 1<<30); err != nil {
		return f, err
	}

	// object_id 和 unscoped 同时给是自相矛盾的（「属于 X」且「不属于任何对象」），
	// 结果必然是空列表。静默返回空会让用户以为这个对象没有产物，所以直接报错。
	if f.ObjectID != "" && f.Unscoped {
		return f, validationf("object_id 与 unscoped 不能同时使用")
	}
	return f, nil
}

func (s *Server) handleListArtifacts(w http.ResponseWriter, r *http.Request) {
	f, err := artifactFilter(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, total, err := s.st.ListArtifacts(r.Context(), f)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: total, Limit: f.Limit, Offset: f.Offset})
}

func (s *Server) handleArtifactStats(w http.ResponseWriter, r *http.Request) {
	f, err := artifactFilter(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 统计不分页：Limit/Offset 在这里没有意义，留着只会让人以为
	// 「统计的是当前这一页」。
	f.Limit, f.Offset = 0, 0

	st, err := s.st.ArtifactStats(r.Context(), f)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, st)
}

// artifactSourceOf 把调用方身份翻成产物来源。
//
// X-Actor-Source=agent 唯一的实际来源是 pmw-mcp（内置 Agent 的 write_file
// 直接调 store，根本不走 HTTP），所以它对应 mcp——「别的 Agent 通过 MCP 回写」。
// 其余一律算手工登记：界面登记是 ui，拿 curl 手工补一条是 api，
// 两者在用户眼里都是「我自己记的」。
//
// agent / run 这两个来源不可能从这个接口进来，也就不需要在这里能表达出来。
func artifactSourceOf(r *http.Request) string {
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Actor-Source")), "agent") {
		return domain.ArtifactSourceMCP
	}
	return domain.ArtifactSourceManual
}

func (s *Server) handleGetArtifact(w http.ResponseWriter, r *http.Request) {
	a, err := s.st.GetArtifact(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, a)
}

func (s *Server) handleCreateArtifact(w http.ResponseWriter, r *http.Request) {
	var in domain.ArtifactInput
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	// source 由**请求头**定，无条件覆盖请求体里的值。
	//
	// 两件事：
	//   1. 必须覆盖而不是「没给才补」。写成默认值的话，请求体里带一个
	//      source:"agent" 就原样穿过去了，统计页上「AI 助手产出了多少」
	//      看起来完全正常——只是数字是假的。
	//   2. 用 X-Actor-Source 而不是请求体字段。这个头是这个项目既有的调用方
	//      标识（见 actorFrom），pmw-mcp 发的是 agent、界面发的是 ui。
	//      判据放在头上，调用方改不了自己的身份标签。
	in.Source = artifactSourceOf(r)
	a, err := s.st.CreateArtifact(r.Context(), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, a)
}

// artifactPatchBody 手工解一层 object_id，因为它要区分三种情况：
// 字段没出现（不改）、显式 null（清空归属）、有值（改挂过去）。
// 直接用 *string 的话，前两种在 JSON 解码后都是 nil，
// 「把产物移出这个对象」这个操作就永远无法表达——而且不会报错，只是没生效。
type artifactPatchBody struct {
	ObjectID json.RawMessage `json:"object_id"`
	Title    *string         `json:"title"`
	Path     *string         `json:"path"`
	BaseDir  *string         `json:"base_dir"`
	URL      *string         `json:"url"`
	Platform *string         `json:"platform"`
	Note     *string         `json:"note"`
}

func (s *Server) handleUpdateArtifact(w http.ResponseWriter, r *http.Request) {
	var b artifactPatchBody
	if err := decodeBody(r, &b); err != nil {
		s.fail(w, r, err)
		return
	}

	p := domain.ArtifactPatch{
		Title:    b.Title,
		Path:     b.Path,
		BaseDir:  b.BaseDir,
		URL:      b.URL,
		Platform: b.Platform,
		Note:     b.Note,
	}
	if len(b.ObjectID) > 0 {
		var id *string
		if err := json.Unmarshal(b.ObjectID, &id); err != nil {
			s.fail(w, r, validationf("invalid object_id: expected a string or null"))
			return
		}
		p.ObjectID = &id
	}

	a, err := s.st.UpdateArtifact(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, a)
}

// handleDeleteArtifact 删的是登记记录，磁盘上的文件和云端的页面都不动。
// 见 sqlite.DeleteArtifact 的注释。
func (s *Server) handleDeleteArtifact(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeleteArtifact(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
