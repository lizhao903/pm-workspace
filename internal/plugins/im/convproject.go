// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 群组默认归属的项目（0007）：一个会话最多一个默认项目，表 im_conversation_projects。
// GET /api/im/conversation-projects 列出全部设置（项目删了的不列）；
// PUT /api/im/conversation-projects/{conversation_id}，body {"project_id": "<项目 id、ref 或名字>"}，null 或空串是清除，
// 回 {conversation_id, project_id, project_ref, project_name, updated_at}，清除后 project_id 为 null。
// 改了（值有变化）记一条审计（0.15.0，noteConvProject）。批量设和会话统计见 convsummary.go。
// 消息自己没归项目时读出按所在会话的默认项目兜底（resolver.fillProject），project_source 为 conversation；
// GET /api/im/messages?project_id= 也把这些消息算进来（list 里的条件）。读时兜底而不是收消息时写入：
// 设了默认项目马上对这个群以前的消息生效，改默认项目、清除都不用回写消息；消息上手动或 SOP 设的归属始终优先。

// ConversationProject 是一个会话的默认项目。
type ConversationProject struct {
	ConversationID string  `json:"conversation_id"`
	ProjectID      *string `json:"project_id"`
	ProjectRef     string  `json:"project_ref"`
	ProjectName    string  `json:"project_name"`
	UpdatedAt      string  `json:"updated_at"`
}

// loadDefaults 读出全部会话的默认项目 id（会话 id -> 项目 id）。设置数量和群组数同级，一次读完。
func loadDefaults(ctx context.Context, c plugin.Core) (map[string]string, error) {
	rows, err := c.Store().Query(ctx, `SELECT conversation_id, project_id FROM im_conversation_projects`)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for rows.Next() {
		var cid, pid string
		if err := rows.Scan(&cid, &pid); err != nil {
			_ = rows.Close()
			return nil, err
		}
		out[cid] = pid
	}
	err = rows.Err()
	_ = rows.Close()
	return out, err
}

func (in *inbox) listConversationProjects(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := in.c.Store().Query(ctx, `SELECT conversation_id, project_id, updated_at FROM im_conversation_projects ORDER BY updated_at, rowid`)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	var found []ConversationProject
	for rows.Next() {
		var x ConversationProject
		var pid string
		if err := rows.Scan(&x.ConversationID, &pid, &x.UpdatedAt); err != nil {
			_ = rows.Close()
			fail(w, r, in.c, err)
			return
		}
		x.ProjectID = &pid
		found = append(found, x)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	rs := newResolver(in.c)
	out := []ConversationProject{}
	for _, x := range found {
		o, err := rs.project(ctx, *x.ProjectID)
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		if o == nil {
			continue // 项目删了按没设
		}
		x.ProjectRef, x.ProjectName = o.Ref, o.Title
		out = append(out, x)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (in *inbox) setConversationProject(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cid := r.PathValue("conversation_id")
	cv, err := in.c.Conversations().Get(ctx, cid)
	if err != nil {
		if errors.Is(err, plugin.ErrNoRows) {
			err = apiErr(errNotFound, "conversation %s not found", cid)
		}
		fail(w, r, in.c, err)
		return
	}
	var body map[string]*string
	if err := decode(r, &body, 4<<10); err != nil {
		fail(w, r, in.c, err)
		return
	}
	raw, ok := body["project_id"]
	if !ok {
		fail(w, r, in.c, apiErr(errValidation, "project_id is required (null to clear)"))
		return
	}
	now := in.clock().UTC().Format(timeLayout)
	// 原来的默认项目，记审计用（0.15.0）
	var from string
	if err := in.c.Store().QueryRow(ctx, `SELECT project_id FROM im_conversation_projects WHERE conversation_id = ?`, cid).Scan(&from); err != nil && !errors.Is(err, plugin.ErrNoRows) {
		fail(w, r, in.c, err)
		return
	}
	key := strings.TrimSpace(deref(raw))
	if key == "" {
		if _, err := in.c.Store().Exec(ctx, `DELETE FROM im_conversation_projects WHERE conversation_id = ?`, cid); err != nil {
			fail(w, r, in.c, err)
			return
		}
		in.noteConvProject(ctx, newResolver(in.c), cv, from, "", false)
		writeJSON(w, http.StatusOK, map[string]any{"data": ConversationProject{ConversationID: cid, UpdatedAt: now}})
		return
	}
	o, err := in.findProject(ctx, key)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_conversation_projects (conversation_id, project_id, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (conversation_id) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at`,
		cid, o.ID, now); err != nil {
		fail(w, r, in.c, err)
		return
	}
	in.noteConvProject(ctx, newResolver(in.c), cv, from, o.ID, false)
	id := o.ID
	writeJSON(w, http.StatusOK, map[string]any{"data": ConversationProject{
		ConversationID: cid, ProjectID: &id, ProjectRef: o.Ref, ProjectName: o.Title, UpdatedAt: now,
	}})
}
