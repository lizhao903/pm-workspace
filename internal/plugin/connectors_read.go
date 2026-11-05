package plugin

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
)

// 连接器实例句柄（IM-02a 起）：回复前看收消息的连接器还在不在、是否连着、是不是只收不发。
// 凭证、配置不给；建、改、删实例走内核 /api/connectors。
// BR-01a 加了按工具列实例、发起 OAuth 授权和断开：浏览器插件把 Google Drive 实例当作自己的 Google 账号。

// ConnectorInfo 是连接器实例里插件常用的几项（0029）。
type ConnectorInfo struct {
	ID        string
	Tool      string
	Name      string
	Account   string // 连接器连着的账号（连通测试时由对方给），IM 插件拿它认「我」（IM-03）
	Status    string // connected / connecting / error / paused / disconnected
	Error     string // 最近一次失败的说明
	Direction string // receive / both
	Interval  int    // 同步间隔（分钟），0 是不定时同步（IM-01b）
	// Scope 是 OAuth 授权下来的范围，空格分隔；没授权或不是 OAuth 为空串（0030，BR-01a）
	Scope string
	// AuthorizedAt 是最近一次 OAuth 授权完成的时间，没授权为 nil（BR-01a）
	AuthorizedAt *time.Time
	// SelfNames 是配置里用户自己填的「我的称呼」（config.self_names，逗号分隔），没填为空串；IM 插件和 Account 一起认「我」（PR-19）
	SelfNames string
}

// OAuthStart 是发起授权的结果：浏览器打开 AuthorizeURL。
type OAuthStart = connector.OAuthStart

// ConnectorReader 查连接器实例，外加发起授权、断开两个动作。没有这个 id 返回 ErrNoRows。
type ConnectorReader interface {
	Get(ctx context.Context, id string) (ConnectorInfo, error)
	// List 按工具列实例，新建的在前；tool 为空列全部（BR-01a）。
	List(ctx context.Context, tool string) ([]ConnectorInfo, error)
	// StartOAuth 发起这个实例的 OAuth 授权，口径同 POST /api/connectors/{id}/oauth/start（BR-01a）。
	// returnTo 是授权完回到哪：站内路径或本机地址，空串时回调页自己显示结果。
	StartOAuth(ctx context.Context, id, returnTo string) (OAuthStart, error)
	// Disconnect 断开这个实例，口径同 POST /api/connectors/{id}/disconnect：状态置为 disconnected，
	// OAuth 令牌删掉、授权状态清空；记一条审计，操作者是插件（BR-01a）。
	Disconnect(ctx context.Context, id string) (ConnectorInfo, error)
	// With 把本插件登记的实例解密后的配置交给 fn，fn 返回后即丢；别的插件和内核的实例回 ErrNoRows（VID-04a，connectors_config.go）。
	With(ctx context.Context, id string, fn func(ConnectorConfig) error) error
	// RecordSync 记本插件登记的实例的一次同步：syncErr 为 nil 记同步时间、异常的回到已连接，否则置为异常并记原因（IM-01b，connectors_sync.go）。
	RecordSync(ctx context.Context, id string, syncErr error) (ConnectorInfo, error)
	// SaveSession 把插件自己拿到的登录态（键以 _ 开头，值空串为清掉）写进本插件登记的实例的保险箱条目，
	// account 非空时记成实例账号；状态不动，记一条只有键名的审计（TSK-0455，connectors_session.go）。
	SaveSession(ctx context.Context, id string, secrets map[string]string, account string) (ConnectorInfo, error)
}

// ConnectorActions 是发起授权和断开的实现，*connector.Store 满足；cmd/pmw 用 SetConnectors 接上。
type ConnectorActions interface {
	StartOAuth(ctx context.Context, id, returnTo string) (*connector.OAuthStart, error)
	Disconnect(ctx context.Context, id string) (*connector.Connector, bool, error)
}

// ErrNoConnectors：注册表没接上连接器的实现（测试里没接时）。
var ErrNoConnectors = errors.New("连接器还没接上")

type connectorsBox struct{ s ConnectorActions }

// SetConnectors 接上连接器的实现，可以在 Start 之后调（用时现取）。
func (r *Registry) SetConnectors(s ConnectorActions) { r.connActions.Store(&connectorsBox{s}) }

func (c *core) Connectors() ConnectorReader { return connectorReader{c} }

type connectorReader struct{ c *core }

const connectorCols = `SELECT id, tool, name, account, status, error, direction, oauth_scope, oauth_authorized_at, interval,
	CASE WHEN json_valid(config) THEN COALESCE(json_extract(config, '$.self_names'), '') ELSE '' END FROM connectors`

func scanConnector(s interface{ Scan(...any) error }) (ConnectorInfo, error) {
	var (
		info ConnectorInfo
		at   sql.NullString
	)
	if err := s.Scan(&info.ID, &info.Tool, &info.Name, &info.Account, &info.Status, &info.Error, &info.Direction,
		&info.Scope, &at, &info.Interval, &info.SelfNames); err != nil {
		return ConnectorInfo{}, err
	}
	if at.Valid {
		if t, err := time.Parse(time.RFC3339Nano, at.String); err == nil {
			t = t.UTC()
			info.AuthorizedAt = &t
		}
	}
	return info, nil
}

func (r connectorReader) Get(ctx context.Context, id string) (ConnectorInfo, error) {
	d := r.c.db()
	if d == nil {
		return ConnectorInfo{}, ErrNoStore
	}
	return scanConnector(d.R.QueryRowContext(ctx, connectorCols+` WHERE id = ?`, id))
}

func (r connectorReader) List(ctx context.Context, tool string) ([]ConnectorInfo, error) {
	d := r.c.db()
	if d == nil {
		return nil, ErrNoStore
	}
	q, args := connectorCols, []any{}
	if tool != "" {
		q += ` WHERE tool = ?`
		args = append(args, tool)
	}
	rows, err := d.R.QueryContext(ctx, q+` ORDER BY created_at DESC, rowid DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []ConnectorInfo{}
	for rows.Next() {
		info, err := scanConnector(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, info)
	}
	return out, rows.Err()
}

func (r connectorReader) actions() ConnectorActions {
	if r.c.reg != nil {
		if b := r.c.reg.connActions.Load(); b != nil && b.s != nil {
			return b.s
		}
	}
	return nil
}

func (r connectorReader) StartOAuth(ctx context.Context, id, returnTo string) (OAuthStart, error) {
	a := r.actions()
	if a == nil {
		return OAuthStart{}, ErrNoConnectors
	}
	out, err := a.StartOAuth(ctx, id, returnTo)
	if err != nil {
		return OAuthStart{}, err
	}
	return *out, nil
}

func (r connectorReader) Disconnect(ctx context.Context, id string) (ConnectorInfo, error) {
	a := r.actions()
	if a == nil {
		return ConnectorInfo{}, ErrNoConnectors
	}
	cn, cleared, err := a.Disconnect(ctx, id)
	if err != nil {
		return ConnectorInfo{}, err
	}
	detail := map[string]any{"tool": cn.Tool}
	if cleared {
		detail["secrets"] = map[string]string{"access_token": audit.SecretCleared, "refresh_token": audit.SecretCleared}
	}
	r.c.note(ctx, WriteMeta{}, "disconnect", "connector", cn.ID, "断开连接器「"+cn.Name+"」", detail)
	return r.Get(ctx, id)
}
