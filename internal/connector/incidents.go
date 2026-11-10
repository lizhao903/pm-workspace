// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

import (
	"context"

	"github.com/lizhao903/pm-workspace/internal/incident"
)

// 连接器出问题记运行异常（INC-01a，规格 SPEC-settings-3 联动「运行异常」）：
// 连接失败（连通测试失败、OAuth 令牌刷新失败）记错误级 conn:<id>:auth，同步失败（插件经 RecordSync 记的失败）记警告 conn:<id>:sync。
// 同一指纹由运行异常合并；说明是已经抹掉凭证的那句话，同连接器上的 error。

// IncidentRecorder 落一条运行异常，*incident.Store 满足它。
type IncidentRecorder interface {
	Note(ctx context.Context, r incident.Report)
}

// SetIncidents 接上运行异常；没接时不记。在开始处理请求之前调。
func (s *Store) SetIncidents(r IncidentRecorder) { s.incidents = r }

func (s *Store) noteIncident(ctx context.Context, cur *Connector, kind, msg string) {
	if s.incidents == nil || cur == nil {
		return
	}
	r := incident.Report{
		Fingerprint: "conn:" + cur.ID + ":" + kind,
		Level:       incident.LevelError,
		Module:      "连接器",
		Title:       cur.Name + "连接失败",
		Message:     msg,
		Context:     map[string]any{"连接器": cur.Name, "工具": cur.Tool, "认证方式": string(cur.AuthMode)},
		Source:      incident.SourceBackend,
	}
	if kind == "sync" {
		r.Level, r.Title = incident.LevelWarn, cur.Name+"同步失败"
	}
	s.incidents.Note(ctx, r)
}
