package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// checksumPrefix 是 checksum 在界面上显示的长度。
const checksumPrefix = 8

// handleMigrations 返回 schema_migrations，供设置页展示库的 schema 状态。
func (s *Server) handleMigrations(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.Migrations(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// checksum 在这一层截短：设置页只拿它做「文件有没有被换过」的目视比对，
	// 完整的 64 位 hash 铺满一整行反而看不出差异。store 那边仍返回完整值。
	out := make([]domain.MigrationRecord, 0, len(items))
	for _, m := range items {
		if len(m.Checksum) > checksumPrefix {
			m.Checksum = m.Checksum[:checksumPrefix]
		}
		out = append(out, m)
	}
	respondList(w, out, Meta{Total: len(out)})
}

type snapshotReq struct {
	Dir string `json:"dir"`
}

// handleSnapshot 触发一次 VACUUM INTO 快照。
func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	var req snapshotReq
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 前端的「立即备份」不带请求体，空 body 等同 {}（用默认目录）。
	// 这里不能沿用 decodeBody——它把空 body 当成参数错误。
	if len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			s.fail(w, r, validationf("malformed JSON body: %v", err))
			return
		}
	}

	info, err := s.st.Snapshot(r.Context(), req.Dir)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, info)
}

// handleExport 直接回文件流，不套 envelope：前端是开新窗口下载，不走 fetch。
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "" {
		format = "json"
	}

	name, data, err := s.st.Export(r.Context(), format)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	ct := "application/json; charset=utf-8"
	if format == "markdown" {
		ct = "text/markdown; charset=utf-8"
	}
	w.Header().Set("Content-Type", ct)
	// 没有附件头的话浏览器会把 JSON / Markdown 直接渲染在新窗口里，下载不下来。
	// 文件名只含 pm-export-日期.后缀，不需要转义。
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
