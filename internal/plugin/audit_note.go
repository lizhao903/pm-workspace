package plugin

import "context"

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

// AuditLog 记审计。
type AuditLog interface {
	Note(ctx context.Context, n AuditNote, m WriteMeta)
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
