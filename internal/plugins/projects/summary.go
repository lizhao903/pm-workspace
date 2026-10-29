package projects

import (
	"context"
	"errors"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 项目汇总（ALIGN-05）：GET /api/projects/summary，项目列表一次拿到每个项目的原型运行数、总数和绑定的会话，
// 不用每个项目各发两次请求。待回复数在 IM 插件的表里，本插件读不到：前端拿一次待处理消息，按这里的会话对上项目。
// 契约见 docs/api-contract.md「项目插件 / 项目汇总」。

// ProjectSummary 是一个项目的汇总；没有原型、没绑会话的项目不列。
type ProjectSummary struct {
	ProjectID     string                `json:"project_id"`
	Prototypes    ProtoCount            `json:"prototypes"`
	Conversations []SummaryConversation `json:"conversations"`
}

// ProtoCount 是原型总数和运行中（status=running）的个数。
type ProtoCount struct {
	Total   int `json:"total"`
	Running int `json:"running"`
}

// SummaryConversation 是绑定的会话：IM 消息认不上会话时按渠道和会话编号对（同 /api/im/messages?conversation_id=）。
type SummaryConversation struct {
	ID         string `json:"id"`
	Channel    string `json:"channel"`
	ExternalID string `json:"external_id"`
}

type summary struct {
	*stakeholders
	m *manager
}

func (h *summary) list(w http.ResponseWriter, r *http.Request) {
	out, err := buildSummary(r.Context(), h.c, func(id string) string { return h.m.runtime(id).Status })
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// buildSummary 按项目汇总；status 给原型当前的运行状态，测试里可以换掉。
// 顺序：先有原型的项目（按第一个原型的添加先后），再只绑了会话的项目。
func buildSummary(ctx context.Context, c plugin.Core, status func(id string) string) ([]ProjectSummary, error) {
	out := []ProjectSummary{}
	at := map[string]int{}
	get := func(pid string) *ProjectSummary {
		i, ok := at[pid]
		if !ok {
			i = len(out)
			at[pid] = i
			out = append(out, ProjectSummary{ProjectID: pid, Conversations: []SummaryConversation{}})
		}
		return &out[i]
	}

	type pair struct{ pid, id string }
	var protos, convs []pair
	scan := func(q string, dst *[]pair) error {
		rows, err := c.Store().Query(ctx, q)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var x pair
			if err := rows.Scan(&x.pid, &x.id); err != nil {
				return err
			}
			*dst = append(*dst, x)
		}
		return rows.Err()
	}
	if err := scan(`SELECT project_id, id FROM projects_prototypes ORDER BY created_at, rowid`, &protos); err != nil {
		return nil, err
	}
	if err := scan(`SELECT project_id, conversation_id FROM projects_conversations ORDER BY created_at, rowid`, &convs); err != nil {
		return nil, err
	}

	for _, x := range protos {
		s := get(x.pid)
		s.Prototypes.Total++
		if status(x.id) == statusRunning {
			s.Prototypes.Running++
		}
	}
	seen := map[string]plugin.ConversationInfo{}
	for _, x := range convs {
		cv, ok := seen[x.id]
		if !ok {
			var err error
			cv, err = c.Conversations().Get(ctx, x.id)
			if errors.Is(err, plugin.ErrNoRows) {
				continue // 外键级联会删掉，这里只防万一
			}
			if err != nil {
				return nil, err
			}
			seen[x.id] = cv
		}
		s := get(x.pid)
		s.Conversations = append(s.Conversations, SummaryConversation{ID: cv.ID, Channel: cv.Channel, ExternalID: cv.ExternalID})
	}
	return out, nil
}
