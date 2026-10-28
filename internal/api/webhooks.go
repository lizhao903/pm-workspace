package api

import (
	"encoding/json"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/webhook"
)

// --- Webhook 配置（TASK-02a）。收件、映射执行、去重归 TASK-02b ---

func (s *Server) webhooksConfigured(w http.ResponseWriter) bool {
	if s.opt.Webhooks == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "webhooks are not configured on this server"}})
		return false
	}
	return true
}

// webhookWithSecret 是新建和轮换的响应：服务端生成的密钥明文只在这一次给出，之后只有 secret_hint。
type webhookWithSecret struct {
	*webhook.Webhook
	Secret string `json:"secret,omitempty"`
}

func (s *Server) handleListWebhooks(w http.ResponseWriter, r *http.Request) {
	if !s.webhooksConfigured(w) {
		return
	}
	items, err := s.opt.Webhooks.List(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

func (s *Server) handleCreateWebhook(w http.ResponseWriter, r *http.Request) {
	if !s.webhooksConfigured(w) {
		return
	}
	var in webhook.Input
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	wh, plain, err := s.opt.Webhooks.Create(r.Context(), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "create", "webhook", wh.ID, "新建 Webhook「"+wh.Name+"」",
		map[string]any{"name": wh.Name, "secret": audit.SecretSet})
	respondData(w, http.StatusCreated, webhookWithSecret{wh, plain})
}

func (s *Server) handleGetWebhook(w http.ResponseWriter, r *http.Request) {
	if !s.webhooksConfigured(w) {
		return
	}
	wh, err := s.opt.Webhooks.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, wh)
}

func (s *Server) handleUpdateWebhook(w http.ResponseWriter, r *http.Request) {
	if !s.webhooksConfigured(w) {
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
	// 密钥走 rotate-secret，接收地址不可改；写在 PATCH 里直接拒绝，免得以为改成了
	for _, k := range []string{"secret", "token"} {
		if _, ok := keys[k]; ok {
			s.fail(w, r, validationf("%s cannot be changed by PATCH; use POST /api/webhooks/{id}/rotate-secret for the secret", k))
			return
		}
	}
	var p webhook.Patch
	if err := json.Unmarshal(body, &p); err != nil {
		s.fail(w, r, validationf("malformed JSON body: %v", err))
		return
	}
	wh, err := s.opt.Webhooks.Update(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	fields := map[string]bool{}
	for k := range keys {
		fields[k] = true
	}
	s.auditConfig(r, "update", "webhook", wh.ID, "修改 Webhook「"+wh.Name+"」", map[string]any{"fields": givenFields(fields)})
	respondData(w, http.StatusOK, wh)
}

// handleRotateWebhookSecret 是 POST /api/webhooks/{id}/rotate-secret：body 可空，空则服务端生成新密钥。
func (s *Server) handleRotateWebhookSecret(w http.ResponseWriter, r *http.Request) {
	if !s.webhooksConfigured(w) {
		return
	}
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var req struct {
		Secret string `json:"secret"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			s.fail(w, r, validationf("malformed JSON body: %v", err))
			return
		}
	}
	wh, plain, err := s.opt.Webhooks.RotateSecret(r.Context(), r.PathValue("id"), req.Secret)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "rotate_secret", "webhook", wh.ID, "轮换 Webhook「"+wh.Name+"」的密钥",
		map[string]any{"name": wh.Name, "secret": audit.SecretUpdated, "version": wh.SecretVersion})
	respondData(w, http.StatusOK, webhookWithSecret{wh, plain})
}

// handleWebhookUsage 是 GET /api/webhooks/{id}/usage：删除前的确认依据。
func (s *Server) handleWebhookUsage(w http.ResponseWriter, r *http.Request) {
	if !s.webhooksConfigured(w) {
		return
	}
	u, err := s.opt.Webhooks.Usage(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, u)
}

// handleDeleteWebhook 彻底删除，密钥一起删；回删除时的影响，建出来的任务保留。
func (s *Server) handleDeleteWebhook(w http.ResponseWriter, r *http.Request) {
	if !s.webhooksConfigured(w) {
		return
	}
	id := r.PathValue("id")
	u, err := s.opt.Webhooks.Usage(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	wh, err := s.opt.Webhooks.Delete(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "delete", "webhook", id, "删除 Webhook「"+wh.Name+"」",
		map[string]any{"name": wh.Name, "tasks": u.Tasks, "open_tasks": u.OpenTasks, "secret": audit.SecretCleared})
	respondData(w, http.StatusOK, u)
}
