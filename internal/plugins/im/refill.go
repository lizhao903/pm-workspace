// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

// 补全已收消息的正文：早先没解析出来的消息（机器人卡片的正文在 attachments、blocks 里）落库时是空的，
// 按消息编号回渠道重取一次，只覆盖正文为空的，不新增消息、不改状态，也不当新消息通知或触发 SOP。

import (
	"context"
	"errors"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Refiller 能按消息编号（Incoming.ExternalID）重取已收消息；取不到的不回。
type Refiller interface {
	Adapter
	Refetch(ctx context.Context, connectorID string, externalIDs []string) (map[string]Incoming, error)
}

// refillLimit 是一次最多补的条数，免得撞上渠道限流；没补完再调一次。
const refillLimit = 200

// RefillResult 是一次补全的结果：查了几条空正文，补上了几条。
type RefillResult struct {
	ConnectorID string `json:"connector_id"`
	Checked     int    `json:"checked"`
	Filled      int    `json:"filled"`
}

func (in *inbox) refillerFor(tool string) Refiller {
	for _, a := range in.adapters {
		if f, ok := a.(Refiller); ok && a.Key() == tool {
			return f
		}
	}
	return nil
}

// refillConnector：POST /api/im/connectors/{id}/refill。连接器不在 404；渠道不支持、暂停、断开 409；渠道出错 502。
func (in *inbox) refillConnector(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	cn, err := in.c.Connectors().Get(ctx, id)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		fail(w, r, in.c, apiErr(errNotFound, "connector %s not found", id))
		return
	case err != nil:
		fail(w, r, in.c, err)
		return
	}
	f := in.refillerFor(cn.Tool)
	switch {
	case f == nil:
		fail(w, r, in.c, blocked("unsupported", "连接器「"+cn.Name+"」不支持补全消息"))
		return
	case cn.Status == "paused":
		fail(w, r, in.c, blocked("connector_paused", "连接器「"+cn.Name+"」已暂停"))
		return
	case cn.Status == "disconnected":
		fail(w, r, in.c, blocked("connector_disconnected", "连接器「"+cn.Name+"」已断开"))
		return
	}
	res, err := in.refill(ctx, f, id)
	if err != nil {
		in.c.Log().Warn("im refill failed", "connector", id, "err", err)
		fail(w, r, in.c, &actionError{status: http.StatusBadGateway, code: "refill_failed", msg: "补全失败：" + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

func (in *inbox) refill(ctx context.Context, f Refiller, connID string) (RefillResult, error) {
	res := RefillResult{ConnectorID: connID}
	rows, err := in.c.Store().Query(ctx, `SELECT external_id FROM im_messages
		WHERE connector_id = ? AND channel = ? AND text = '' AND attachments = '[]'
		ORDER BY sent_at DESC LIMIT ?`, connID, f.Channel(), refillLimit)
	if err != nil {
		return res, err
	}
	var ids []string
	for rows.Next() {
		var x string
		if err := rows.Scan(&x); err != nil {
			_ = rows.Close()
			return res, err
		}
		ids = append(ids, x)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}
	res.Checked = len(ids)
	if len(ids) == 0 {
		return res, nil
	}
	got, err := f.Refetch(ctx, connID, ids)
	if err != nil && len(got) == 0 {
		return res, err
	}
	for _, x := range ids {
		m, ok := got[x]
		if !ok || (m.Text == "" && len(m.Attachments) == 0) {
			continue
		}
		atts := "[]"
		if len(m.Attachments) > 0 {
			atts = string(m.Attachments)
		}
		r, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET text = ?,
			sender_name = CASE WHEN sender_name = '' THEN ? ELSE sender_name END,
			attachments = CASE WHEN attachments = '[]' THEN ? ELSE attachments END
			WHERE connector_id = ? AND channel = ? AND external_id = ? AND text = ''`,
			clip(m.Text, maxText), m.SenderName, atts, connID, f.Channel(), x)
		if err != nil {
			return res, err
		}
		if n, _ := r.RowsAffected(); n == 1 {
			res.Filled++
		}
	}
	return res, nil
}
