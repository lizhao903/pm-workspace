package plugin

import "context"

// 连接器实例的只读句柄（IM-02a 起）：回复前看收消息的连接器还在不在、是否连着、是不是只收不发。
// 凭证、配置不给；写连接器走内核 /api/connectors。

// ConnectorInfo 是连接器实例里插件常用的几项（0029）。
type ConnectorInfo struct {
	ID        string
	Tool      string
	Name      string
	Status    string // connected / connecting / error / paused / disconnected
	Error     string // 最近一次失败的说明
	Direction string // receive / both
}

// ConnectorReader 只读查连接器实例。没有这个 id 返回 ErrNoRows。
type ConnectorReader interface {
	Get(ctx context.Context, id string) (ConnectorInfo, error)
}

func (c *core) Connectors() ConnectorReader { return connectorReader{c} }

type connectorReader struct{ c *core }

func (r connectorReader) Get(ctx context.Context, id string) (ConnectorInfo, error) {
	d := r.c.db()
	if d == nil {
		return ConnectorInfo{}, ErrNoStore
	}
	var info ConnectorInfo
	err := d.R.QueryRowContext(ctx, `SELECT id, tool, name, status, error, direction FROM connectors WHERE id = ?`, id).
		Scan(&info.ID, &info.Tool, &info.Name, &info.Status, &info.Error, &info.Direction)
	return info, err
}
