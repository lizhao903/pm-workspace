package plugin

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 插件记审计（SOP-02b）：替用户做的对外动作（例：IM 插件在 SOP 里发消息）没有内核写入可挂，插件自己记一条。
// 和 writes.go 的写入审计同一口径：kind agent、source plugin，操作者「插件 id#WriteMeta.Session」，
// WriteMeta.Detail 补进 detail，Key 记成 detail.write_key；写失败只记日志（同 CORE-08）。

// AuditNote 是一条审计。Action 例 send，TargetType 例 conversation。
type AuditNote struct {
	Action     string
	TargetType string
	TargetID   string
	Summary    string
	Detail     map[string]any
}

// NotedAudit 是查回来的一条审计，At 同库里的写法（UTC，到毫秒）。
type NotedAudit struct {
	TargetID string
	Summary  string
	At       string
	Detail   map[string]any
}

// AuditLog 记审计。Find 按幂等键查本插件、同一会话记过的同一动作（POL-02），取最早一条；没有回 false，m.Key 为空也回 false。
type AuditLog interface {
	Note(ctx context.Context, n AuditNote, m WriteMeta)
	Find(ctx context.Context, action, targetType string, m WriteMeta) (NotedAudit, bool, error)
}

func (c *core) Audit() AuditLog { return auditWriter{c} }

type auditWriter struct{ c *core }

func (w auditWriter) Note(ctx context.Context, n AuditNote, m WriteMeta) {
	detail := make(map[string]any, len(n.Detail)+len(m.Detail)+1)
	for k, v := range n.Detail {
		detail[k] = v
	}
	w.c.note(ctx, m, n.Action, n.TargetType, n.TargetID, n.Summary, detail)
}

func (w auditWriter) Find(ctx context.Context, action, targetType string, m WriteMeta) (NotedAudit, bool, error) {
	if m.Key == "" {
		return NotedAudit{}, false, nil
	}
	d := w.c.db()
	if d == nil {
		return NotedAudit{}, false, ErrNoStore
	}
	a := w.c.actor(m)
	var n NotedAudit
	var detail string
	err := d.R.QueryRowContext(ctx, `SELECT target_id, summary, at, detail FROM audits WHERE actor = ? AND action = ? AND target_type = ?
		AND json_extract(detail, '$.write_key') = ? ORDER BY at, rowid LIMIT 1`,
		domain.ComposeActor(a.Name, a.Session), action, targetType, m.Key).Scan(&n.TargetID, &n.Summary, &n.At, &detail)
	if errors.Is(err, sql.ErrNoRows) {
		return NotedAudit{}, false, nil
	}
	if err != nil {
		return NotedAudit{}, false, err
	}
	_ = json.Unmarshal([]byte(detail), &n.Detail)
	return n, true, nil
}
