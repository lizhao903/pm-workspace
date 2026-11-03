package im

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 同一工具接多个实例（IM-01d）：两个 Slack 工作区、两个 Telegram Bot 各是一个连接器实例。
// 适配器按实例逐个拉、逐个记同步结果；回调按签名或 secret_token 认出是哪个实例；回复、附件走消息所属的实例。
// 进度仍是 im_cursors 里适配器的一行，值按实例分开存：{"instances": {<连接器 id>: <这个实例的进度>}}。

// InstancePuller 是可选接口：立即同步只拉指定的实例（IM-01d）。cursor 和返回的 next 都是适配器的整份进度，
// 只改这个实例那一份。没实现的适配器立即同步时整个拉一次。
type InstancePuller interface {
	PullConnector(ctx context.Context, connectorID, cursor string) (msgs []Incoming, next string, err error)
}

type instanceCursors struct {
	Instances map[string]json.RawMessage `json:"instances"`
}

// readCursors 拆出各实例的进度；旧格式（只接一个实例时的 {connector, ...}）归到它的 connector 下。
func readCursors(s string) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	if s == "" {
		return out
	}
	var ic instanceCursors
	if json.Unmarshal([]byte(s), &ic) == nil && ic.Instances != nil {
		for k, v := range ic.Instances {
			out[k] = v
		}
		return out
	}
	var old struct {
		Connector string `json:"connector"`
	}
	if json.Unmarshal([]byte(s), &old) == nil && old.Connector != "" {
		out[old.Connector] = json.RawMessage(s)
	}
	return out
}

func writeCursors(m map[string]json.RawMessage) string {
	b, _ := json.Marshal(instanceCursors{Instances: m})
	return string(b)
}

// instancesOf 列这个工具的实例，新建的在前。插件没启用时为空。
func instancesOf(ctx context.Context, c plugin.Core, tool string) ([]plugin.ConnectorInfo, error) {
	if c == nil {
		return nil, nil
	}
	return c.Connectors().List(ctx, tool)
}

// pullErrors 合并一轮里各实例的错误：都失败才算这一轮失败（不存进度、不落库），
// 有成功的照收，失败的已经记在各自实例上。
func pullErrors(tried int, errs []error) error {
	if tried == 0 || len(errs) < tried {
		return nil
	}
	if len(errs) == 1 {
		return errs[0]
	}
	return errors.Join(errs...)
}
