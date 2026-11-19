// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 消息链接与任务关联（0.32.0）：
//   - 每条消息带两个链接：link 是工作台里的深链（--public-url 加 /messages?m=<消息 id>，打开就是这条消息的抽屉），
//     permalink 是原平台的链接（Slack 用拉取时 auth.test 回的工作区地址拼 /archives/<会话>/p<ts 去点>，
//     Telegram 只有超级群拼得出 https://t.me/c/<群>/<消息>），拼不出为空串，界面上不显示「在 Slack 打开」。
//   - 任务关联来源消息：im_message_tasks 一条任务可以记多条消息、一条消息可以记多条任务（0008 的表）。
//     SOP 的 task 节点建的任务（props.source_ref 带 run_id 和 message_id）除了记关联，主来源消息还没有转成的任务时
//     把这条记为转成的任务（task_id、task_ref），口径同 im_to_task 和 IM 需求自动受理取回别的流程建的任务。
//     会话里拆出来的任务只记关联，不占 task_id（同 0008）。
//   - 历史数据：SOP 插件扫自己的执行记录，按条发 sop.task_created（backfill 为 true），这里按同样的口径记，幂等。

// EventSOPTaskCreated 是 SOP 的 task 节点建了任务（SOP 0.23.0 起发，历史回填时也发）。本插件弱依赖 sop，订阅它补关联。
const EventSOPTaskCreated = "sop.task_created"

// Permalinker 是可选接口：能给出消息在原平台的链接（0.32.0）。拼不出回空串；不许为此去调渠道的接口。
type Permalinker interface {
	Adapter
	Permalink(ctx context.Context, m Message) string
}

// messageLink 是消息在工作台里的深链；没配 --public-url（测试）时是站内相对地址。
func (in *inbox) messageLink(id string) string {
	return in.publicURL + "/messages?m=" + url.QueryEscape(id)
}

// fillLinks 补 link、permalink。
func (in *inbox) fillLinks(ctx context.Context, ms []Message) {
	for i := range ms {
		ms[i].Link = in.messageLink(ms[i].ID)
		if p, ok := in.adapterFor(ms[i]).(Permalinker); ok {
			ms[i].Permalink = p.Permalink(ctx, ms[i])
		}
	}
}

// slackPermalink 按工作区地址（https://acme.slack.com/）和消息编号（<会话>:<ts>）拼 Slack 的消息链接；
// 串里的回复带上 thread_ts、cid，点开定位到串里那条。拼不出回空串。
func slackPermalink(base, externalID, threadParent string) string {
	if !strings.HasPrefix(base, "https://") {
		return ""
	}
	ch, ts, ok := strings.Cut(externalID, ":")
	if !ok || ch == "" || !slackTSOK(ts) {
		return ""
	}
	u := strings.TrimRight(base, "/") + "/archives/" + url.PathEscape(ch) + "/p" + strings.Replace(ts, ".", "", 1)
	if pch, pts, ok := strings.Cut(threadParent, ":"); ok && pch == ch && slackTSOK(pts) && pts != ts {
		u += "?thread_ts=" + url.QueryEscape(pts) + "&cid=" + url.QueryEscape(ch)
	}
	return u
}

// slackTSOK：Slack 的 ts 是「秒.微秒」，只认数字和一个点。
func slackTSOK(ts string) bool {
	if ts == "" || strings.Count(ts, ".") > 1 {
		return false
	}
	return strings.Trim(ts, "0123456789.") == ""
}

// telegramPermalink：只有超级群（会话编号 -100 开头）有 t.me/c 链接，群成员点开能定位；私聊、普通群拼不出。
// 消息编号是「会话:消息」，私聊再带 @Bot。
func telegramPermalink(externalID string) string {
	chat, msg, ok := strings.Cut(externalID, ":")
	if !ok || !strings.HasPrefix(chat, "-100") || len(chat) <= 4 {
		return ""
	}
	msg, _, _ = strings.Cut(msg, "@")
	if strings.Trim(chat[4:], "0123456789") != "" || msg == "" || strings.Trim(msg, "0123456789") != "" {
		return ""
	}
	return "https://t.me/c/" + chat[4:] + "/" + msg
}

// linkTask 把任务记到一组来源消息上，回新记上的条数（已记过的不算）。primary 是主来源消息（SOP task 节点输入里的那条），
// 为空时只记关联。消息不存在的跳过；任务不存在、已删或不是任务的不记。
func (in *inbox) linkTask(ctx context.Context, c plugin.Core, o plugin.ObjectInfo, ids []string, primary string) (int, error) {
	if o.Type != "task" || o.Deleted || len(ids) == 0 {
		return 0, nil
	}
	now := in.clock().UTC().Format(timeLayout)
	n := 0
	for _, mid := range ids {
		res, err := c.Store().Exec(ctx, `INSERT INTO im_message_tasks (message_id, task_id, created_at)
			SELECT id, ?, ? FROM im_messages WHERE id = ? ON CONFLICT(message_id, task_id) DO NOTHING`, o.ID, now, mid)
		if err != nil {
			return n, err
		}
		if k, _ := res.RowsAffected(); k > 0 {
			n++
		}
	}
	if primary != "" && slices.Contains(ids, primary) {
		// 同转任务、im_to_task 的锁：手动转任务查过 task_id 到写回之间不被这里插进来
		in.taskMu.Lock()
		_, err := c.Store().Exec(ctx, `UPDATE im_messages SET task_id = ?, task_ref = ? WHERE id = ? AND task_id IS NULL`, o.ID, o.Ref, primary)
		in.taskMu.Unlock()
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

// primaryOf 是 SOP task 节点建的任务的主来源消息：source_ref 带 run_id 时取 message_id，别的来源（会话拆分、手动转任务）为空。
func primaryOf(props map[string]any) string {
	ref, _ := props[domain.PropSourceRef].(map[string]any)
	if ref == nil {
		return ""
	}
	if run, _ := ref["run_id"].(string); strings.TrimSpace(run) == "" {
		return ""
	}
	mid, _ := ref["message_id"].(string)
	return strings.TrimSpace(mid)
}

// sopTaskCreated 是 sop.task_created 的 payload 里本插件要的几项（契约「SOP 编排插件 sop」的「事件」）。
type sopTaskCreated struct {
	TaskID     string   `json:"task_id"`
	RunID      string   `json:"run_id"`
	MessageID  string   `json:"message_id"`
	MessageIDs []string `json:"message_ids"`
	Backfill   bool     `json:"backfill"`
}

// onSOPTaskCreated 按 SOP 发来的「建了任务」记关联：新建时 object.created 已经按 source_ref 记过一遍，这里再记不重复；
// 历史回填（backfill）时任务的 source_ref 里没有 message_id，只能靠这里记。出错回错误，内核记日志。
func (in *inbox) onSOPTaskCreated(ctx context.Context, c plugin.Core, ev plugin.Event) error {
	var p sopTaskCreated
	if err := json.Unmarshal(ev.Payload, &p); err != nil || strings.TrimSpace(p.TaskID) == "" {
		return nil
	}
	var ids []string
	add := func(s string) {
		if s = strings.TrimSpace(s); s != "" && !slices.Contains(ids, s) && len(ids) < sessionLinkMax {
			ids = append(ids, s)
		}
	}
	add(p.MessageID)
	for _, s := range p.MessageIDs {
		add(s)
	}
	if len(ids) == 0 {
		return nil
	}
	o, err := c.Objects().Get(ctx, p.TaskID)
	if errors.Is(err, plugin.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = in.linkTask(ctx, c, o, ids, strings.TrimSpace(p.MessageID))
	return err
}
