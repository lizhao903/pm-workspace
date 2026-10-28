package api

import (
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/conversation"
)

// --- IM 会话（CT-02，0028） ---

func (s *Server) conversationsConfigured(w http.ResponseWriter) bool {
	if s.opt.Conversations == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "conversations are not configured on this server"}})
		return false
	}
	return true
}

// auditConversation 照 CORE-08 的口径：删除一律记；新建、修改只在 Agent 来源时记（和 IM 身份一致）。
func (s *Server) auditConversation(r *http.Request, action string, c *conversation.Conversation, summary string, detail map[string]any) {
	kind := audit.KindDelete
	if action != "delete" {
		if actorFrom(r).Source != "agent" {
			return
		}
		kind = audit.KindAgent
	}
	s.opt.Audit.Note(r.Context(), audit.Entry{
		Kind: kind, Action: action, TargetType: "conversation", TargetID: c.ID, Summary: summary, Detail: detail,
	})
}

func conversationLabel(c *conversation.Conversation) string {
	if c.Name != "" {
		return c.Channel + ":" + c.Name
	}
	return c.Channel + ":" + c.ExternalID
}

func (s *Server) handleListConversations(w http.ResponseWriter, r *http.Request) {
	if !s.conversationsConfigured(w) {
		return
	}
	p := newParams(r)
	items, err := s.opt.Conversations.List(r.Context(), conversation.Filter{
		Channel: p.str("channel"), Kind: p.str("kind"),
		IdentityID: p.str("identity_id"), StakeholderID: p.str("stakeholder_id"),
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

// handleResolveConversation 按渠道和编号找会话。查不到回 404：收消息时据此决定是否新建。
func (s *Server) handleResolveConversation(w http.ResponseWriter, r *http.Request) {
	if !s.conversationsConfigured(w) {
		return
	}
	p := newParams(r)
	c, err := s.opt.Conversations.Resolve(r.Context(), p.str("channel"), p.str("external_id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, c)
}

func (s *Server) handleGetConversation(w http.ResponseWriter, r *http.Request) {
	if !s.conversationsConfigured(w) {
		return
	}
	c, err := s.opt.Conversations.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, c)
}

func (s *Server) handleCreateConversation(w http.ResponseWriter, r *http.Request) {
	if !s.conversationsConfigured(w) {
		return
	}
	var req struct {
		Channel    string   `json:"channel"`
		ExternalID string   `json:"external_id"`
		Kind       string   `json:"kind"`
		Name       string   `json:"name"`
		Members    []string `json:"members"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	c, err := s.opt.Conversations.Create(r.Context(), conversation.Conversation{
		Channel: req.Channel, ExternalID: req.ExternalID, Kind: req.Kind, Name: req.Name, Members: req.Members,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConversation(r, "create", c, "新建会话 "+conversationLabel(c),
		map[string]any{"channel": c.Channel, "kind": c.Kind, "members": len(c.Members)})
	respondData(w, http.StatusCreated, c)
}

func (s *Server) handleUpdateConversation(w http.ResponseWriter, r *http.Request) {
	if !s.conversationsConfigured(w) {
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
	// 渠道和类型定了就不改，换了就是另一个会话
	for _, key := range []string{"id", "channel", "kind"} {
		if _, ok := raw[key]; ok {
			s.fail(w, r, validationf("%s cannot be changed; create another conversation instead", key))
			return
		}
	}
	var p conversation.Patch
	given := map[string]bool{}
	if p.ExternalID, err = patchField[string](raw, "external_id", "a string"); err != nil {
		s.fail(w, r, err)
		return
	}
	if p.Name, err = patchField[string](raw, "name", "a string"); err != nil {
		s.fail(w, r, err)
		return
	}
	if p.Members, err = patchField[[]string](raw, "members", "an array of im identity ids"); err != nil {
		s.fail(w, r, err)
		return
	}
	given["external_id"], given["name"], given["members"] = p.ExternalID != nil, p.Name != nil, p.Members != nil
	c, err := s.opt.Conversations.Update(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConversation(r, "update", c, "修改会话 "+conversationLabel(c),
		map[string]any{"channel": c.Channel, "fields": givenFields(given)})
	respondData(w, http.StatusOK, c)
}

// handleAddConversationMember 加一个成员，已在里面照样回 200；真加了才算修改（审计、updated_at）。
func (s *Server) handleAddConversationMember(w http.ResponseWriter, r *http.Request) {
	if !s.conversationsConfigured(w) {
		return
	}
	var req struct {
		IdentityID string `json:"identity_id"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	c, added, err := s.opt.Conversations.AddMember(r.Context(), r.PathValue("id"), req.IdentityID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if added {
		s.auditConversation(r, "add_member", c, "会话 "+conversationLabel(c)+" 加成员",
			map[string]any{"channel": c.Channel, "identity_id": req.IdentityID})
	}
	respondData(w, http.StatusOK, c)
}

func (s *Server) handleRemoveConversationMember(w http.ResponseWriter, r *http.Request) {
	if !s.conversationsConfigured(w) {
		return
	}
	iid := r.PathValue("identity_id")
	c, err := s.opt.Conversations.RemoveMember(r.Context(), r.PathValue("id"), iid)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConversation(r, "remove_member", c, "会话 "+conversationLabel(c)+" 移出成员",
		map[string]any{"channel": c.Channel, "identity_id": iid})
	respondData(w, http.StatusOK, c)
}

func (s *Server) handleDeleteConversation(w http.ResponseWriter, r *http.Request) {
	if !s.conversationsConfigured(w) {
		return
	}
	id := r.PathValue("id")
	c, err := s.opt.Conversations.Get(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.opt.Conversations.Delete(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConversation(r, "delete", c, "删除会话 "+conversationLabel(c),
		map[string]any{"channel": c.Channel, "kind": c.Kind, "members": len(c.Members)})
	respondData(w, http.StatusOK, nil)
}
