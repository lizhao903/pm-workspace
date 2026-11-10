// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 插件调对方接口时拿实例的配置（VID-04a，docs/plugin-api.md 2.5）：只开放本插件登记的连接器实例，
// 回调里拿解密后的配置，回调结束即丢；OAuth 令牌快到期时内核先刷新（CONN-01b）。

// ConnectorConfig 是一次调用的配置：Get 取普通字段，Secret 取凭证明文，AccessToken 取 OAuth 令牌。
// 只在回调期间用，不要留存、不要打日志。
type ConnectorConfig = connector.Config

// ConnectorConfigs 是拿配置的实现，*connector.Store 满足；和 ConnectorActions 一起用 SetConnectors 接上。
type ConnectorConfigs interface {
	WithConfig(ctx context.Context, id, source string, fn func(connector.Config) error) error
}

func (r connectorReader) With(ctx context.Context, id string, fn func(ConnectorConfig) error) error {
	a, ok := r.actions().(ConnectorConfigs)
	if !ok {
		return ErrNoConnectors
	}
	called := false
	err := a.WithConfig(ctx, id, r.c.id, func(cfg connector.Config) error {
		called = true
		return fn(cfg)
	})
	// 没有这个实例、不是本插件的：都按没有这个 id，同 Get
	if !called && errors.Is(err, domain.ErrNotFound) {
		return ErrNoRows
	}
	return err
}
