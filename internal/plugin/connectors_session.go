package plugin

import (
	"context"
	"errors"
	"sort"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 插件写登录态（TSK-0455）：视频插件扫码登录 B 站网页端拿到 Cookie，经这里进本插件登记的实例的保险箱条目。
// 键必须以 _ 开头（同 OAuth 令牌：不出脱敏提示、不在配置表单里，断开实例时一起删掉）；只开放本插件登记的实例，同 With。
// 记一条审计（action: connector_session），detail 只有键名和「已更新 / 已清除」，不记值。

// ConnectorSessions 是写登录态的实现，*connector.Store 满足；和 ConnectorActions 一起用 SetConnectors 接上。
type ConnectorSessions interface {
	SaveSession(ctx context.Context, id, source string, secrets map[string]string, account string) (*connector.Connector, []string, error)
}

func (r connectorReader) SaveSession(ctx context.Context, id string, secrets map[string]string, account string) (ConnectorInfo, error) {
	a, ok := r.actions().(ConnectorSessions)
	if !ok {
		return ConnectorInfo{}, ErrNoConnectors
	}
	cn, touched, err := a.SaveSession(ctx, id, r.c.id, secrets, account)
	if err != nil {
		// 没有这个实例、不是本插件的：都按没有这个 id，同 Get
		if errors.Is(err, domain.ErrNotFound) {
			return ConnectorInfo{}, ErrNoRows
		}
		return ConnectorInfo{}, err
	}
	if len(touched) > 0 {
		sort.Strings(touched)
		marks := map[string]string{}
		summary := "更新连接器「" + cn.Name + "」的登录态"
		for _, k := range touched {
			if secrets[k] == "" {
				marks[k] = audit.SecretCleared
			} else {
				marks[k] = audit.SecretUpdated
			}
		}
		if len(secrets) > 0 && allEmpty(secrets) {
			summary = "清除连接器「" + cn.Name + "」的登录态"
		}
		r.c.note(ctx, WriteMeta{}, "connector_session", "connector", cn.ID, summary, map[string]any{"tool": cn.Tool, "secrets": marks})
	}
	return r.Get(ctx, id)
}

func allEmpty(m map[string]string) bool {
	for _, v := range m {
		if v != "" {
			return false
		}
	}
	return true
}
