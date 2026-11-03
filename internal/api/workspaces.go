package api

import (
	"encoding/json"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/workspace"
)

// --- 工作台配置（CORE-10a，0023）：只决定菜单和插件组合，不隔离数据 ---

func (s *Server) workspacesConfigured(w http.ResponseWriter) bool {
	if s.opt.Workspaces == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "workspaces are not configured on this server"}})
		return false
	}
	return true
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	if !s.workspacesConfigured(w) {
		return
	}
	items, err := s.opt.Workspaces.List(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

func (s *Server) handleListWorkspaceTemplates(w http.ResponseWriter, r *http.Request) {
	if !s.workspacesConfigured(w) {
		return
	}
	items, err := s.opt.Workspaces.Templates(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

func (s *Server) handleGetWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.workspacesConfigured(w) {
		return
	}
	ws, err := s.opt.Workspaces.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, ws)
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.workspacesConfigured(w) {
		return
	}
	var in workspace.Input
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	ws, err := s.opt.Workspaces.Create(r.Context(), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "create", "workspace", ws.ID, "新建工作台「"+ws.Name+"」", map[string]any{"template": ws.Template})
	respondData(w, http.StatusCreated, ws)
}

func (s *Server) handleUpdateWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.workspacesConfigured(w) {
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
	var p workspace.Patch
	if err := json.Unmarshal(body, &p); err != nil {
		s.fail(w, r, validationf("malformed JSON body: %v", err))
		return
	}
	ws, err := s.opt.Workspaces.Update(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	fields := map[string]bool{}
	for k := range keys {
		fields[k] = true
	}
	s.auditConfig(r, "update", "workspace", ws.ID, "修改工作台「"+ws.Name+"」", map[string]any{"fields": givenFields(fields)})
	respondData(w, http.StatusOK, ws)
}

func (s *Server) handleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.workspacesConfigured(w) {
		return
	}
	id := r.PathValue("id")
	ws, err := s.opt.Workspaces.Get(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.opt.Workspaces.Delete(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "delete", "workspace", id, "删除工作台「"+ws.Name+"」", map[string]any{"template": ws.Template})
	respondData(w, http.StatusOK, nil)
}
