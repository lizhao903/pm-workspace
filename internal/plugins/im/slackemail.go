// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

// Slack 资料里的邮箱（补联系人邮箱，emails.go）：users.info 的 profile.email，Token 要有 users:read.email。
// 没有这个 scope 时 Slack 不报错，只是 profile 里没有 email，所以先用 auth.test 的响应头 X-OAuth-Scopes 看有没有；
// 响应里没有这个头时（联调的假服务等），查到的真人都没有邮箱就当缺权限。
// 收消息时查发送人名字（lookupUsers）顺手把邮箱记进缓存，补的时候先用缓存，少调 users.info。

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

const (
	slackMailTTL  = 24 * time.Hour // 缓存的邮箱多久内直接用
	slackScopeTTL = time.Hour      // 查过的 scope 多久内直接用
)

// slackMail 是邮箱缓存和各实例的 scope；零值可用。
type slackMail struct {
	mu     sync.Mutex
	emails map[string]slackMailEntry // Member ID -> 邮箱
	scopes map[string]slackScopeInfo // 连接器 id -> 有没有 users:read.email
}

type slackMailEntry struct {
	email string
	at    time.Time
}

type slackScopeInfo struct {
	known, has bool
	at         time.Time
}

// remember 记一个人资料里的邮箱，空的不记。
func (m *slackMail) remember(id, email string) {
	email = strings.TrimSpace(email)
	if id == "" || email == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.emails == nil || len(m.emails) >= slackNameCacheN {
		m.emails = map[string]slackMailEntry{}
	}
	m.emails[id] = slackMailEntry{email: email, at: time.Now()}
}

func (m *slackMail) cached(id string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.emails[id]
	if !ok || time.Since(e.at) > slackMailTTL {
		return "", false
	}
	return e.email, true
}

func (m *slackMail) scope(connID string) (slackScopeInfo, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sc, ok := m.scopes[connID]
	if !ok || time.Since(sc.at) > slackScopeTTL {
		return slackScopeInfo{}, false
	}
	return sc, true
}

func (m *slackMail) setScope(connID string, sc slackScopeInfo) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.scopes == nil {
		m.scopes = map[string]slackScopeInfo{}
	}
	sc.at = time.Now()
	m.scopes[connID] = sc
}

// slackScopeHint 按缺的 scope 给提示：连 users:read 都没有时两个一起加。
func slackScopeHint(needed string) string {
	if strings.Contains(needed, "users:read") && !strings.Contains(needed, connector.SlackEmailScope) {
		return "Slack 应用要加 users:read 和 users:read.email 权限并重新安装：OAuth & Permissions 里 Bot Token Scopes（身份是我本人时加在 User Token Scopes）加上这两个，再点 Reinstall to Workspace"
	}
	return connector.SlackEmailScopeHint
}

// LookupEmails 按 Member ID 查资料里的邮箱。不在这个工作区的（user_not_found）不回；被限流时停下，剩下的记进 Pending。
// Token 失效等别的错误整次失败。
func (s *Slack) LookupEmails(ctx context.Context, connID string, ids []string) (EmailLookup, error) {
	out := EmailLookup{Found: map[string]string{}}
	c := s.core()
	if c == nil {
		return out, errors.New("IM 插件还没启用")
	}
	err := c.Connectors().With(ctx, connID, func(cfg plugin.ConnectorConfig) error {
		hc, err := s.client()
		if err != nil {
			return err
		}
		token := cfg.Secret("bot_token")
		if err := connector.SlackTokenError(cfg.Get(connector.SlackIdentityField), token); err != nil {
			return err
		}
		// 只缓存「有权限」：缺权限时用户加上 scope、重新安装后手动再点一次就该认出来
		sc, ok := s.mail.scope(connID)
		if !ok || !sc.has {
			scopes, known, err := connector.SlackScopes(ctx, hc, s.api, token)
			if err != nil {
				return err
			}
			sc = slackScopeInfo{known: known, has: slices.Contains(scopes, connector.SlackEmailScope)}
			s.mail.setScope(connID, sc)
		}
		if sc.known && !sc.has {
			out.MissingScope, out.Hint = true, connector.SlackEmailScopeHint
			return nil
		}
		humans, withEmail := 0, 0
		for i, id := range ids {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if email, ok := s.mail.cached(id); ok {
				out.Found[id] = email
				humans++
				withEmail++
				continue
			}
			var u struct {
				User struct {
					Deleted bool `json:"deleted"`
					IsBot   bool `json:"is_bot"`
					Profile struct {
						Email string `json:"email"`
					} `json:"profile"`
				} `json:"user"`
			}
			err := s.call(ctx, hc, token, "users.info", url.Values{"user": {id}}, &u)
			var se *connector.SlackError
			switch {
			case errors.As(err, &se) && se.RateLimited():
				out.Pending = len(ids) - i
				c.Log().Info("slack rate limited while looking up emails", "connector", connID, "pending", out.Pending)
				return nil
			case errors.As(err, &se) && se.Code == "missing_scope":
				out.MissingScope, out.Hint = true, slackScopeHint(se.Needed)
				return nil
			case errors.As(err, &se) && (se.Code == "user_not_found" || se.Code == "user_not_visible"):
				continue
			case err != nil:
				return err
			}
			email := strings.TrimSpace(u.User.Profile.Email)
			out.Found[id] = email
			s.mail.remember(id, email)
			if u.User.IsBot || id == "USLACKBOT" {
				continue
			}
			humans++
			if email != "" {
				withEmail++
			}
		}
		// 判断不了 scope 时：查到的真人一个邮箱都没有，当缺权限
		if !sc.known && humans > 0 && withEmail == 0 {
			out.MissingScope, out.Hint = true, connector.SlackEmailScopeHint
		}
		return nil
	})
	if errors.Is(err, plugin.ErrNoRows) {
		return out, errors.New("连接器已删除")
	}
	return out, err
}
