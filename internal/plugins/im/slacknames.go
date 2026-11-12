// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

// Slack 按编号查名字（TSK-0494，names.go 的 NameResolver）：人用 users.info（机器人编号 B… 用 bots.info），
// 会话用 conversations.info。查到的人名顺手记进适配器的名字缓存，之后收到这个人的消息直接带名字。

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// slackUser 是 users.info 回的人。
type slackUser struct {
	Name    string `json:"name"`
	Deleted bool   `json:"deleted"`
	Profile struct {
		Display string `json:"display_name"`
		Real    string `json:"real_name"`
		Email   string `json:"email"`
	} `json:"profile"`
}

func (u slackUser) displayName() string {
	return firstNonEmpty(u.Profile.Display, u.Profile.Real, u.Name)
}

// ResolveNames 用会话所属的实例查；撞上限流就停，Limited 为真。Token 失效等整次调不了的回 error。
func (s *Slack) ResolveNames(ctx context.Context, connectorID string, q NameQuery) (NameAnswer, error) {
	ans := NameAnswer{Users: map[string]string{}, Conversations: map[string]string{},
		FailedUsers: map[string]NameFailure{}, FailedConversations: map[string]NameFailure{}}
	c := s.core()
	if c == nil {
		return ans, errors.New("IM 插件还没启用")
	}
	err := c.Connectors().With(ctx, connectorID, func(cfg plugin.ConnectorConfig) error {
		hc, err := s.client()
		if err != nil {
			return err
		}
		token := cfg.Secret("bot_token")
		// 一个个查；第一个就是 Token 问题时整次失败
		stop := func(err error) (bool, error) {
			var se *connector.SlackError
			switch {
			case slackRateLimited(err):
				ans.Limited = true
				return true, nil
			case errors.As(err, &se) && se.Auth():
				return true, err
			}
			return false, nil
		}
		for _, id := range q.Conversations {
			var out struct {
				Channel slackConv `json:"channel"`
			}
			err := s.call(ctx, hc, token, "conversations.info", url.Values{"channel": {id}}, &out)
			if done, ferr := stop(err); done {
				return ferr
			}
			if err != nil {
				ans.FailedConversations[id] = slackNameFailure(err, "conversation")
				continue
			}
			s.remember(out.Channel)
			if name := out.Channel.title(); name != "" && name != "#" {
				ans.Conversations[id] = name
			} else {
				ans.FailedConversations[id] = NameFailure{Code: "empty", Message: "Slack 没返回这个会话的名字（私信本来没有名字）"}
			}
		}
		for _, id := range q.Users {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			name, err := s.lookupOne(ctx, hc, token, id)
			if done, ferr := stop(err); done {
				return ferr
			}
			switch {
			case err != nil:
				ans.FailedUsers[id] = slackNameFailure(err, "user")
			case name == "":
				ans.FailedUsers[id] = NameFailure{Code: "empty", Message: "Slack 没返回这个人的名字"}
			default:
				ans.Users[id] = name
			}
		}
		return nil
	})
	return ans, err
}

// lookupOne 查一个人（B 开头是机器人，用 bots.info），查到的记进缓存。
func (s *Slack) lookupOne(ctx context.Context, hc *http.Client, token, id string) (string, error) {
	if strings.HasPrefix(id, "B") {
		var out struct {
			Bot struct {
				Name string `json:"name"`
			} `json:"bot"`
		}
		if err := s.call(ctx, hc, token, "bots.info", url.Values{"bot": {id}}, &out); err != nil {
			return "", err
		}
		return strings.TrimSpace(out.Bot.Name), nil
	}
	var out struct {
		User slackUser `json:"user"`
	}
	if err := s.call(ctx, hc, token, "users.info", url.Values{"user": {id}}, &out); err != nil {
		return "", err
	}
	s.mail.remember(id, out.User.Profile.Email)
	name := strings.TrimSpace(out.User.displayName())
	s.rememberUser(id, name)
	return name, nil
}

func (s *Slack) rememberUser(id, name string) {
	if name == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.users) >= slackNameCacheN {
		s.users = map[string]string{}
	}
	s.users[id] = name
}

// slackNameFailure 把查名字的错误换成给人看的原因。
func slackNameFailure(err error, kind string) NameFailure {
	var se *connector.SlackError
	if !errors.As(err, &se) {
		return NameFailure{Code: "error", Message: err.Error()}
	}
	switch se.Code {
	case "user_not_found", "bot_not_found":
		return NameFailure{Code: se.Code, Message: "Slack 里查不到这个人：可能是别的工作区的外部成员（Slack Connect），或已被删除"}
	case "user_not_visible":
		return NameFailure{Code: se.Code, Message: "这个人对机器人不可见（别的工作区的外部成员），Slack 不给查"}
	case "account_inactive":
		return NameFailure{Code: se.Code, Message: "连接器的账号已停用"}
	case "channel_not_found", "not_in_channel":
		return NameFailure{Code: se.Code, Message: "机器人不在这个会话里或会话不存在，查不了会话名"}
	case "missing_scope":
		need := "users:read"
		if kind == "conversation" {
			need = "channels:read、groups:read、im:read、mpim:read"
		}
		if se.Needed != "" {
			need = se.Needed
		}
		return NameFailure{Code: se.Code, Message: "机器人没权限：Slack App 缺 " + need + "，加上后重新安装到工作区"}
	}
	return NameFailure{Code: se.Code, Message: se.Error()}
}
