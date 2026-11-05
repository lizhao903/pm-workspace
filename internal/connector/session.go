package connector

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// --- 插件写登录态（TSK-0455，plugin.Core.Connectors().SaveSession） ---

// ErrSessionKey：会话键不是 _ 开头，或太长。
var ErrSessionKey = errors.New("会话凭证的键必须以 _ 开头")

// maxSessionValue 是一项会话凭证的上限（Cookie 整串也在这个量级以内）。
const maxSessionValue = 8 << 10

// SaveSession 把插件自己拿到的登录态（如扫码登录得到的 Cookie）合进实例的凭证：键必须以 _ 开头
// （同 OAuth 令牌：不出脱敏提示、不在配置表单里、断开时一起删），值为空串表示清掉这一项。
// account 非空时记成实例的账号。状态不动，成功与否由调用方再记一次 RecordSync。
// source 非空时只认这个来源登记的定义，同 WithConfig。返回实例和这次动到的键（审计只记键名）。
func (s *Store) SaveSession(ctx context.Context, id, source string, secrets map[string]string, account string) (*Connector, []string, error) {
	for k, v := range secrets {
		if !isTokenKey(k) || len(k) > 33 || !fieldRe.MatchString(k[1:]) {
			return nil, nil, fmt.Errorf("%w：%s", ErrSessionKey, k)
		}
		if utf8.RuneCountInString(v) > maxSessionValue || v != strings.TrimSpace(v) {
			return nil, nil, invalid("session value %s is too long or has surrounding spaces", k)
		}
	}
	account = strings.TrimSpace(account)
	if utf8.RuneCountInString(account) > maxName {
		return nil, nil, invalid("account is longer than %d characters", maxName)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, nil, err
	}
	if d, ok := s.defs.Get(cur.Tool); source != "" && (!ok || d.Source != source) {
		return nil, nil, fmt.Errorf("%w: %s", ErrNotOwned, id)
	}
	old, err := s.resolveSecrets(ctx, cur)
	if err != nil {
		return nil, nil, err
	}
	next := map[string]string{}
	for k, v := range old {
		next[k] = v
	}
	var touched []string
	for k, v := range secrets {
		if v == "" {
			if _, had := next[k]; had {
				touched = append(touched, k)
			}
			delete(next, k)
			continue
		}
		next[k] = v
		touched = append(touched, k)
	}
	secretID, created, err := s.saveSecrets(ctx, id, cur.SecretID, next)
	if err != nil {
		return nil, nil, err
	}
	q, args := `UPDATE connectors SET secret_id = ?, updated_at = ?`, []any{secretID, s.stamp()}
	if account != "" {
		q += `, account = ?`
		args = append(args, account)
	}
	if _, err := s.db.W.ExecContext(ctx, q+` WHERE id = ?`, append(args, id)...); err != nil {
		if created {
			_ = s.sec.Delete(context.WithoutCancel(ctx), secretID)
		}
		return nil, nil, fmt.Errorf("save connector session: %w", err)
	}
	c, err := s.get(ctx, s.db.W, id)
	return c, touched, err
}
