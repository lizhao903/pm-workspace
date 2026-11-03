package api

import (
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/imident"
)

// --- 联系人的 IM 身份（CT-01b，0027） ---

func (s *Server) identitiesConfigured(w http.ResponseWriter) bool {
	if s.opt.Identities == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "im identities are not configured on this server"}})
		return false
	}
	return true
}

// auditIdentity 照 CORE-08 的口径：删除一律记；新建、修改只在 Agent 来源时记（和干系人一致）。
func (s *Server) auditIdentity(r *http.Request, action string, it *imident.Identity, summary string, detail map[string]any) {
	kind := audit.KindDelete
	if action != "delete" {
		if actorFrom(r).Source != "agent" {
			return
		}
		kind = audit.KindAgent
	}
	s.opt.Audit.Note(r.Context(), audit.Entry{
		Kind: kind, Action: action, TargetType: "im_identity", TargetID: it.ID, Summary: summary, Detail: detail,
	})
}

func identityLabel(it *imident.Identity) string { return it.Channel + ":" + it.ExternalID }

func (s *Server) handleListIdentities(w http.ResponseWriter, r *http.Request) {
	if !s.identitiesConfigured(w) {
		return
	}
	p := newParams(r)
	items, err := s.opt.Identities.List(r.Context(), imident.Filter{
		StakeholderID: p.str("stakeholder_id"), Channel: p.str("channel"),
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

// resolvedIdentity 是解析的结果：身份和它挂着的联系人。
type resolvedIdentity struct {
	Identity    *imident.Identity   `json:"identity"`
	Stakeholder *domain.Stakeholder `json:"stakeholder"`
}

// handleResolveIdentity 按渠道和编号认人。查不到回 404：收消息时据此决定是否提示「新建联系人」。
func (s *Server) handleResolveIdentity(w http.ResponseWriter, r *http.Request) {
	if !s.identitiesConfigured(w) {
		return
	}
	p := newParams(r)
	it, err := s.opt.Identities.Resolve(r.Context(), p.str("channel"), p.str("external_id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	sh, err := s.st.GetStakeholder(r.Context(), it.StakeholderID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, resolvedIdentity{Identity: it, Stakeholder: sh})
}

func (s *Server) handleGetIdentity(w http.ResponseWriter, r *http.Request) {
	if !s.identitiesConfigured(w) {
		return
	}
	it, err := s.opt.Identities.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, it)
}

func (s *Server) handleCreateIdentity(w http.ResponseWriter, r *http.Request) {
	if !s.identitiesConfigured(w) {
		return
	}
	var req struct {
		StakeholderID string `json:"stakeholder_id"`
		Channel       string `json:"channel"`
		ExternalID    string `json:"external_id"`
		DisplayName   string `json:"display_name"`
		Account       string `json:"account"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	it, err := s.opt.Identities.Create(r.Context(), imident.Identity{
		StakeholderID: req.StakeholderID, Channel: req.Channel, ExternalID: req.ExternalID,
		DisplayName: req.DisplayName, Account: req.Account,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditIdentity(r, "create", it, "新建 IM 身份 "+identityLabel(it),
		map[string]any{"stakeholder_id": it.StakeholderID, "channel": it.Channel})
	respondData(w, http.StatusCreated, it)
}

func (s *Server) handleUpdateIdentity(w http.ResponseWriter, r *http.Request) {
	if !s.identitiesConfigured(w) {
		return
	}
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	raw, err := patchKeys(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var p imident.Patch
	given := map[string]bool{}
	for key, dst := range map[string]**string{
		"stakeholder_id": &p.StakeholderID, "channel": &p.Channel, "external_id": &p.ExternalID,
		"display_name": &p.DisplayName, "account": &p.Account,
	} {
		if *dst, err = patchField[string](raw, key, "a string"); err != nil {
			s.fail(w, r, err)
			return
		}
		given[key] = *dst != nil
	}
	it, err := s.opt.Identities.Update(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditIdentity(r, "update", it, "修改 IM 身份 "+identityLabel(it),
		map[string]any{"stakeholder_id": it.StakeholderID, "fields": givenFields(given)})
	respondData(w, http.StatusOK, it)
}

func (s *Server) handleDeleteIdentity(w http.ResponseWriter, r *http.Request) {
	if !s.identitiesConfigured(w) {
		return
	}
	id := r.PathValue("id")
	it, err := s.opt.Identities.Get(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.opt.Identities.Delete(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditIdentity(r, "delete", it, "删除 IM 身份 "+identityLabel(it),
		map[string]any{"stakeholder_id": it.StakeholderID, "channel": it.Channel})
	respondData(w, http.StatusOK, nil)
}
