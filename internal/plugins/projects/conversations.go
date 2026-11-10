// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 项目绑定的 IM 会话（PJ-02a）：表 projects_conversations，接口 /api/projects/{id}/conversations，
// 契约见 docs/api-contract.md「项目插件」。按会话 id 绑，改群名不断；会话信息每次从内核读，名字总是最新的。

// ProjectConversation 是项目里绑定的一个会话。
type ProjectConversation struct {
	ProjectID      string            `json:"project_id"`
	ConversationID string            `json:"conversation_id"`
	Conversation   ConversationBrief `json:"conversation"`
	CreatedAt      time.Time         `json:"created_at"`
}

// ConversationBrief 是会话的几项，成员从 /api/conversations/{id} 取。
type ConversationBrief struct {
	ID         string `json:"id"`
	Channel    string `json:"channel"`
	ExternalID string `json:"external_id"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
}

// chats 和干系人共用项目校验、错误信封。
type chats struct{ *stakeholders }

func brief(c plugin.ConversationInfo) ConversationBrief {
	return ConversationBrief{ID: c.ID, Channel: c.Channel, ExternalID: c.ExternalID, Kind: c.Kind, Name: c.Name}
}

func (h *chats) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT conversation_id, created_at FROM projects_conversations
		WHERE project_id = ? ORDER BY created_at, rowid`, pid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	type row struct {
		id      string
		created string
	}
	var found []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.id, &x.created); err != nil {
			_ = rows.Close()
			h.fail(w, r, err)
			return
		}
		found = append(found, x)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := []ProjectConversation{}
	for _, x := range found {
		c, err := h.c.Conversations().Get(ctx, x.id)
		if errors.Is(err, plugin.ErrNoRows) {
			continue // 外键级联会删掉，这里只防万一
		}
		if err != nil {
			h.fail(w, r, err)
			return
		}
		at, _ := time.Parse(time.RFC3339, x.created)
		out = append(out, ProjectConversation{ProjectID: pid, ConversationID: x.id, Conversation: brief(c), CreatedAt: at})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *chats) bind(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	var in struct {
		ConversationID string `json:"conversation_id"`
	}
	if err := decode(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	cid := strings.TrimSpace(in.ConversationID)
	if cid == "" {
		h.fail(w, r, apiErr(errValidation, "conversation_id is required"))
		return
	}
	c, err := h.c.Conversations().Get(ctx, cid)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		h.fail(w, r, apiErr(errValidation, "conversation %s not found", cid))
		return
	case err != nil:
		h.fail(w, r, err)
		return
	}
	now := time.Now().UTC()
	_, err = h.c.Store().Exec(ctx, `INSERT INTO projects_conversations (project_id, conversation_id, created_at) VALUES (?, ?, ?)`,
		pid, cid, now.Format(time.RFC3339))
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") || strings.Contains(err.Error(), "PRIMARY KEY") {
			err = apiErr(errConflict, "conversation %s is already bound to this project", label(c))
		}
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": ProjectConversation{
		ProjectID: pid, ConversationID: cid, Conversation: brief(c), CreatedAt: now.Truncate(time.Second),
	}})
}

func (h *chats) unbind(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid, cid := r.PathValue("id"), r.PathValue("conversation_id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	res, err := h.c.Store().Exec(ctx, `DELETE FROM projects_conversations WHERE project_id = ? AND conversation_id = ?`, pid, cid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		h.fail(w, r, apiErr(errNotFound, "conversation %s is not bound to this project", cid))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// label 是报错里给人看的会话名：群名，私聊没名字时用渠道编号。
func label(c plugin.ConversationInfo) string {
	if c.Name != "" {
		return c.Name
	}
	return c.Channel + " " + c.ExternalID
}
