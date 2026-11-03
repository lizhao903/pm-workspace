package im

import (
	"context"
	"fmt"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 删除连接器前的影响（CONN-03）：数这个连接器收过的消息。
// connector_id 不建外键（0001），删连接器后消息原样保留、connector_id 不动，前端显示「渠道已删除」，只能查看。
func messagesImpact(ctx context.Context, c plugin.Core, cn plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
	var n int
	if err := c.Store().QueryRow(ctx, `SELECT count(*) FROM im_messages WHERE connector_id = ?`, cn.ID).Scan(&n); err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, nil
	}
	return &plugin.ConnectorImpactData{Count: n, Effect: plugin.ImpactKeep,
		Text: fmt.Sprintf("%d 条 IM 消息会变成「渠道已删除」，只能查看", n)}, nil
}
