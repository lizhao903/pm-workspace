package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/webhook"
)

// --- Webhook 收件和投递记录（TASK-02b，0024） ---

// handleReceiveHook 是 POST /api/hooks/{token}：外部系统推送的入口。
// 签名不对回 401、超限回 413，都不留记录；签名对上之后建了任务回 201，没建（停用、过滤、重复、失败）回 200，
// 响应都是这次的投递记录，对方不必因为没建任务而重试。
func (s *Server) handleReceiveHook(w http.ResponseWriter, r *http.Request) {
	if !s.webhooksConfigured(w) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, webhook.MaxPayload))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errBody{Error: errPayload{Code: "payload_too_large",
				Message: fmt.Sprintf("webhook payload exceeds %d KB", webhook.MaxPayload>>10)}})
			return
		}
		s.fail(w, r, validationf("cannot read request body: %v", err))
		return
	}
	d, err := s.opt.Webhooks.Receive(r.Context(), r.PathValue("token"), body,
		r.Header.Get(webhook.SignatureHeader), r.Header.Get(webhook.DeliveryHeader), s.st)
	if errors.Is(err, webhook.ErrBadSignature) {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: errPayload{Code: "unauthorized", Message: err.Error()}})
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	status := http.StatusOK
	if d.Result == webhook.ResultCreated {
		status = http.StatusCreated
	}
	respondData(w, status, d)
}

// handleListWebhookDeliveries 是 GET /api/webhooks/{id}/deliveries：投递记录，新的在前。
func (s *Server) handleListWebhookDeliveries(w http.ResponseWriter, r *http.Request) {
	if !s.webhooksConfigured(w) {
		return
	}
	p := newParams(r)
	limit, err := p.limit("limit", webhook.DefaultDeliveryLimit, webhook.MaxDeliveryLimit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	offset, err := p.intRange("offset", 0, 0, 1<<30)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, total, err := s.opt.Webhooks.ListDeliveries(r.Context(), r.PathValue("id"), p.str("result"), limit, offset)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: total, Limit: limit, Offset: offset})
}
