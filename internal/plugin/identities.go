package plugin

import (
	"context"
	"database/sql"

	"github.com/lizhao903/pm-workspace/internal/imident"
)

// IM 身份的只读句柄（IM-01a 起）：收消息时按渠道编号认人，不按名字。写身份走内核 /api/im-identities。

// IdentityInfo 是联系人的一个 IM 身份（CT-01b，0027）。
type IdentityInfo struct {
	ID            string
	StakeholderID string
	Channel       string
	ExternalID    string
	DisplayName   string
}

// IdentityReader 只读查 IM 身份。查不到返回 ErrNoRows。
type IdentityReader interface {
	Get(ctx context.Context, id string) (IdentityInfo, error)
	// Find 按渠道和编号找，编号的规整规则同 imident（telegram 去掉开头的 @）。
	Find(ctx context.Context, channel, externalID string) (IdentityInfo, error)
	// List 列一个渠道的全部身份，按编号排序；渠道格式不对回空（IM 插件从渠道资料补联系人邮箱时用）。
	List(ctx context.Context, channel string) ([]IdentityInfo, error)
}

func (c *core) Identities() IdentityReader { return identityReader{c} }

type identityReader struct{ c *core }

const identityCols = `SELECT id, stakeholder_id, channel, external_id, display_name FROM contact_identities`

func scanIdentity(row *sql.Row) (IdentityInfo, error) {
	var info IdentityInfo
	err := row.Scan(&info.ID, &info.StakeholderID, &info.Channel, &info.ExternalID, &info.DisplayName)
	return info, err
}

func (r identityReader) Get(ctx context.Context, id string) (IdentityInfo, error) {
	d := r.c.db()
	if d == nil {
		return IdentityInfo{}, ErrNoStore
	}
	return scanIdentity(d.R.QueryRowContext(ctx, identityCols+` WHERE id = ?`, id))
}

func (r identityReader) Find(ctx context.Context, channel, externalID string) (IdentityInfo, error) {
	d := r.c.db()
	if d == nil {
		return IdentityInfo{}, ErrNoStore
	}
	ch, ext, ok := normalizeIM(channel, externalID)
	if !ok {
		return IdentityInfo{}, ErrNoRows
	}
	return scanIdentity(d.R.QueryRowContext(ctx, identityCols+` WHERE channel = ? AND external_id = ?`, ch, ext))
}

func (r identityReader) List(ctx context.Context, channel string) ([]IdentityInfo, error) {
	d := r.c.db()
	if d == nil {
		return nil, ErrNoStore
	}
	ch, err := imident.NormalizeChannel(channel)
	if err != nil {
		return nil, nil
	}
	rows, err := d.R.QueryContext(ctx, identityCols+` WHERE channel = ? ORDER BY external_id, id`, ch)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []IdentityInfo
	for rows.Next() {
		var info IdentityInfo
		if err := rows.Scan(&info.ID, &info.StakeholderID, &info.Channel, &info.ExternalID, &info.DisplayName); err != nil {
			return nil, err
		}
		out = append(out, info)
	}
	return out, rows.Err()
}

// Find 按渠道和会话编号找会话，规整规则同 IM 身份。
func (r conversationReader) Find(ctx context.Context, channel, externalID string) (ConversationInfo, error) {
	d := r.c.db()
	if d == nil {
		return ConversationInfo{}, ErrNoStore
	}
	ch, ext, ok := normalizeIM(channel, externalID)
	if !ok {
		return ConversationInfo{}, ErrNoRows
	}
	var info ConversationInfo
	err := d.R.QueryRowContext(ctx, `SELECT id, channel, external_id, kind, name FROM conversations WHERE channel = ? AND external_id = ?`, ch, ext).
		Scan(&info.ID, &info.Channel, &info.ExternalID, &info.Kind, &info.Name)
	return info, err
}

// normalizeIM 规整渠道和编号；格式不对的当查不到，不报校验错误。
func normalizeIM(channel, externalID string) (string, string, bool) {
	ch, err := imident.NormalizeChannel(channel)
	if err != nil {
		return "", "", false
	}
	ext, err := imident.NormalizeExternalID(ch, externalID)
	if err != nil {
		return "", "", false
	}
	return ch, ext, true
}
