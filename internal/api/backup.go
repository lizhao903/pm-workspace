package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// checksumPrefix 是 checksum 在界面上显示的长度。
const checksumPrefix = 8

// migrationRow 是 /api/admin/migrations 的一行。内核行和原来一样（version、checksum、applied_at）；
// 插件行多 plugin 和 plugin_version，version 是插件内的文件名；待应用的 applied_at 为 null、pending 为 true。
type migrationRow struct {
	Version       string     `json:"version"`
	Checksum      string     `json:"checksum"`
	AppliedAt     *time.Time `json:"applied_at"`
	Plugin        string     `json:"plugin,omitempty"`
	PluginVersion string     `json:"plugin_version,omitempty"`
	Pending       bool       `json:"pending,omitempty"`
}

// handleMigrations 返回 schema_migrations 和插件迁移，供设置页展示库的 schema 状态。
// 不带参数：内核的全部记录在前，插件已应用的在后；?plugin=<id>：只给这个插件的，含待应用的。
func (s *Server) handleMigrations(w http.ResponseWriter, r *http.Request) {
	pluginID := r.URL.Query().Get("plugin")
	out := []migrationRow{}
	if pluginID == "" {
		items, err := s.st.Migrations(r.Context())
		if err != nil {
			s.fail(w, r, err)
			return
		}
		for _, m := range items {
			at := m.AppliedAt
			out = append(out, migrationRow{Version: m.Version, Checksum: shortChecksum(m.Checksum), AppliedAt: &at})
		}
	}
	if s.opt.Plugins != nil {
		steps, err := s.opt.Plugins.MigrationSteps(r.Context(), pluginID)
		if errors.Is(err, plugin.ErrNotFound) {
			s.fail(w, r, notFoundf("no such plugin: %s", pluginID))
			return
		}
		if err != nil {
			s.fail(w, r, err)
			return
		}
		for _, st := range steps {
			row := migrationRow{Version: st.File, Checksum: shortChecksum(st.Checksum), Plugin: st.Plugin, Pending: st.Applied == nil}
			if st.Applied != nil {
				at := st.Applied.AppliedAt
				row.AppliedAt, row.PluginVersion = &at, st.Applied.PluginVersion
			}
			out = append(out, row)
		}
	} else if pluginID != "" {
		s.fail(w, r, notFoundf("no such plugin: %s", pluginID))
		return
	}
	respondList(w, out, Meta{Total: len(out)})
}

// shortChecksum 在这一层截短：设置页只拿它做「文件有没有被换过」的目视比对，
// 完整的 64 位 hash 铺满一整行反而看不出差异。store 那边仍返回完整值。
func shortChecksum(sum string) string {
	if len(sum) > checksumPrefix {
		return sum[:checksumPrefix]
	}
	return sum
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
