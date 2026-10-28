package api

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
)

// --- 连接器（CONN-01a，0029）。定义在代码里注册，实例存表，凭证在保险箱里 ---

func (s *Server) connectorsConfigured(w http.ResponseWriter) bool {
	if s.opt.Connectors == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "connectors are not configured on this server"}})
		return false
	}
	return true
}

func (s *Server) handleListConnectorDefs(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	items := s.opt.Connectors.Defs().List()
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

func (s *Server) handleListConnectors(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	items, err := s.opt.Connectors.List(r.Context(), newParams(r).str("tool"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

// secretAudit 只记凭证字段名和「已设置」「已清除」，不记值和 hint。
func secretAudit(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		if v == "" {
			out[k] = audit.SecretCleared
		} else {
			out[k] = audit.SecretSet
		}
	}
	return out
}

func (s *Server) handleCreateConnector(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	var in connector.Input
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	c, err := s.opt.Connectors.Create(r.Context(), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "create", "connector", c.ID, "接入连接器「"+c.Name+"」",
		map[string]any{"tool": c.Tool, "name": c.Name, "secrets": secretAudit(in.Secrets)})
	respondData(w, http.StatusCreated, c)
}

func (s *Server) handleGetConnector(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	c, err := s.opt.Connectors.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, c)
}

func (s *Server) handleUpdateConnector(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	keys, err := patchKeys(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 工具和状态有各自的接口，写在 PATCH 里直接拒绝，免得以为改成了
	for _, k := range []string{"tool", "tools", "status", "account"} {
		if _, ok := keys[k]; ok {
			s.fail(w, r, validationf("%s cannot be changed by PATCH; use /tools for tool modes, /test for status and account", k))
			return
		}
	}
	var p connector.Patch
	if err := json.Unmarshal(body, &p); err != nil {
		s.fail(w, r, validationf("malformed JSON body: %v", err))
		return
	}
	c, err := s.opt.Connectors.Update(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	fields := map[string]bool{}
	for k := range keys {
		fields[k] = k != "secrets"
	}
	detail := map[string]any{"fields": givenFields(fields)}
	if p.Secrets != nil {
		detail["secrets"] = secretAudit(p.Secrets)
	}
	s.auditConfig(r, "update", "connector", c.ID, "修改连接器「"+c.Name+"」", detail)
	respondData(w, http.StatusOK, c)
}

// handleDeleteConnector 彻底删除，凭证一起删；回删掉的那条（凭证只有 hint）。
func (s *Server) handleDeleteConnector(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	c, err := s.opt.Connectors.Delete(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	detail := map[string]any{"tool": c.Tool, "name": c.Name}
	if c.SecretID != "" {
		detail["secrets"] = audit.SecretCleared
	}
	s.auditConfig(r, "delete", "connector", c.ID, "删除连接器「"+c.Name+"」", detail)
	respondData(w, http.StatusOK, c)
}

// handleTestConnector 做一次连通测试。连不上是正常的业务结果：200 + ok=false，不是接口错误。
func (s *Server) handleTestConnector(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	res, err := s.opt.Connectors.Test(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !res.OK {
		s.log.Warn("connector test failed", "connector", res.Connector.ID, "tool", res.Connector.Tool, "reason", res.Message)
	}
	respondData(w, http.StatusOK, res)
}

// handleRefreshConnectorTools 向对方拉工具清单，保留已配过的授权。
func (s *Server) handleRefreshConnectorTools(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	res, err := s.opt.Connectors.RefreshTools(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, res)
}

// handleSetConnectorToolModes 是 PATCH /api/connectors/{id}/tools：body {modes: {工具名: off/confirm/auto}}。
func (s *Server) handleSetConnectorToolModes(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	var req struct {
		Modes map[string]connector.ToolMode `json:"modes"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	c, err := s.opt.Connectors.SetToolModes(r.Context(), r.PathValue("id"), req.Modes)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	names := make([]string, 0, len(req.Modes))
	for n := range req.Modes {
		names = append(names, n)
	}
	sort.Strings(names)
	// 授权是权限配置不是凭证，新值一起记（这张表没有 revisions 可查）
	s.auditConfig(r, "set_tool_modes", "connector", c.ID, "修改连接器「"+c.Name+"」的工具授权",
		map[string]any{"tools": names, "modes": req.Modes})
	respondData(w, http.StatusOK, c)
}
