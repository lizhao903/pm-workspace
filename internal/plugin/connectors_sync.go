// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 插件记一次同步结果（IM-01b）：IM 插件拉完消息后记同步时间；渠道出错（Token 失效等）时实例置为异常、记下原因，
// 回复、取附件随之被拦，界面上显示「渠道异常」。只开放本插件登记的实例，同 With。

// ConnectorSyncs 是记同步结果的实现，*connector.Store 满足；和 ConnectorActions 一起用 SetConnectors 接上。
type ConnectorSyncs interface {
	RecordSync(ctx context.Context, id, source string, syncErr error) (*connector.Connector, error)
}

func (r connectorReader) RecordSync(ctx context.Context, id string, syncErr error) (ConnectorInfo, error) {
	a, ok := r.actions().(ConnectorSyncs)
	if !ok {
		return ConnectorInfo{}, ErrNoConnectors
	}
	if _, err := a.RecordSync(ctx, id, r.c.id, syncErr); err != nil {
		// 没有这个实例、不是本插件的：都按没有这个 id，同 Get
		if errors.Is(err, domain.ErrNotFound) {
			return ConnectorInfo{}, ErrNoRows
		}
		return ConnectorInfo{}, err
	}
	return r.Get(ctx, id)
}
