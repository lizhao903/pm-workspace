package plugin

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// TaskStageQuery 是 ObjectReader.TaskStages 的条件，至少给一个；多个是「且」。
// 口径同 GET /api/tasks/stages（internal/api/stages.go）。
type TaskStageQuery struct {
	MessageID   string // props.source_ref.message_id
	RequesterID string // props.requester.contact_id（联系人）
	// Channel + SenderID 成对给：props.requester 里的 IM 发送者
	Channel  string
	SenderID string
	// Limit 默认 50，最多 200
	Limit int
}

// TaskStages 只看没删、没归档的任务，最近更新的在前。条件一个都没给返回空。
func (o objectReader) TaskStages(ctx context.Context, q TaskStageQuery) ([]domain.TaskStageRow, error) {
	d := o.c.db()
	if d == nil {
		return nil, ErrNoStore
	}
	conds := []string{"type_id = 'task'", "deleted_at IS NULL", "archived_at IS NULL"}
	var args []any
	if v := strings.TrimSpace(q.MessageID); v != "" {
		conds = append(conds, "json_extract(props, '$.source_ref.message_id') = ?")
		args = append(args, v)
	}
	if v := strings.TrimSpace(q.RequesterID); v != "" {
		conds = append(conds, "json_extract(props, '$.requester.contact_id') = ?")
		args = append(args, v)
	}
	if ch, sid := strings.TrimSpace(q.Channel), strings.TrimSpace(q.SenderID); ch != "" && sid != "" {
		conds = append(conds, "json_extract(props, '$.requester.channel') = ? AND json_extract(props, '$.requester.sender_id') = ?")
		args = append(args, ch, sid)
	}
	if len(args) == 0 {
		return []domain.TaskStageRow{}, nil
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := d.R.QueryContext(ctx, `SELECT id, ref, title, status, props, updated_at FROM objects
		WHERE `+strings.Join(conds, " AND ")+` ORDER BY updated_at DESC, id LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []domain.TaskStageRow{}
	for rows.Next() {
		var r domain.TaskStageRow
		var props string
		if err := rows.Scan(&r.ID, &r.Ref, &r.Title, &r.Status, &props, &r.UpdatedAt); err != nil {
			return nil, err
		}
		var pm map[string]any
		_ = json.Unmarshal([]byte(props), &pm)
		r.Stage = domain.StageOf(pm)
		r.StageLabel = domain.TaskStageLabel(r.Stage)
		r.Requester = domain.RequesterOf(pm)
		if ref, ok := pm[domain.PropSourceRef].(map[string]any); ok {
			r.MessageID, _ = ref["message_id"].(string)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
