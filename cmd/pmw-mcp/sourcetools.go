// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package main

// 读任务的来源消息（TSK-0837）：IM 转来的任务交给 Claude Code 后台执行时，模型要读原帖和整串回复。
// 后台执行（claude -p）只放行工作台 MCP（pmw-run），Slack 自己的 MCP 工具没放行、调了被拒；
// 这里复用 IM 插件的接口（读消息、串的父消息、按会话列消息），不另开渠道权限，也不联网之外多做什么：
// 父消息全文由 IM 插件按「库里 → 我发的 → 问渠道 → 80 字快照」取（im 0.32.0）。

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// imThread 对应 IM 消息的 thread（消息列回复属于哪个串）。
type imThread struct {
	ParentExternalID string  `json:"parent_external_id"`
	ParentMessageID  *string `json:"parent_message_id"`
	ParentSenderName string  `json:"parent_sender_name"`
	ParentText       string  `json:"parent_text"`
}

// imMessage 是 GET /api/im/messages/{id} 里这里用得到的字段。
type imMessage struct {
	ID             string    `json:"id"`
	Channel        string    `json:"channel"`
	ExternalID     string    `json:"external_id"`
	ConversationID *string   `json:"conversation_id"`
	Conversation   string    `json:"conversation"`
	SenderName     string    `json:"sender_name"`
	ContactName    string    `json:"contact_name"`
	Text           string    `json:"text"`
	At             string    `json:"at"`
	Link           string    `json:"link"`
	Permalink      string    `json:"permalink"`
	Thread         *imThread `json:"thread"`
	ReplyCount     int       `json:"reply_count"`
	Replies        []struct {
		Text   string `json:"text"`
		Status string `json:"status"`
		At     string `json:"at"`
	} `json:"replies"`
}

// imThreadParent 对应 GET /api/im/messages/{id}/thread-parent。
type imThreadParent struct {
	Sender    string `json:"sender"`
	Text      string `json:"text"`
	Source    string `json:"source"`
	Partial   bool   `json:"partial"`
	Link      string `json:"link"`
	Permalink string `json:"permalink"`
}

func (m imMessage) who() string {
	if m.ContactName != "" {
		return m.ContactName
	}
	return m.SenderName
}

type getSourceMessageArgs struct {
	ObjectID string `json:"object_id" jsonschema:"任务的对象 id（obj_…），也接受 TSK-0001 这样的 ref"`
}

const getSourceMessageDesc = `【只读】读一条任务的来源 IM 消息：消息全文、所在消息列（串）的原消息全文、串里收到的全部回复，以及工作台和原平台（Slack 等）的链接。

什么时候用：任务是从 IM 消息转来的（任务里有「来源消息」），要读原帖、上下文或别人在串里的补充时。后台执行时用它，不要用 Slack 等渠道自己的 MCP 工具——那些没放行，调了会被拒。

要点：
- 原消息全文由 IM 插件按「库里的消息 → 我自己发的 → 向渠道取 → 80 字摘要」取，取不到全文时注明「只有摘要」。
- 串里的回复是工作台收到的（同一会话最近 200 条里属于这个串的），按时间从旧到新；我在渠道里回的不在里面。
- 任务不是 IM 转来的、或 IM 插件没启用时，回一句说明（IM 插件没启用时给出任务里记的来源快照）。`

func addGetSourceMessage(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_get_source_message",
		Description: getSourceMessageDesc,
		Annotations: readOnly("读取任务的来源消息和整串回复"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in getSourceMessageArgs) (*mcp.CallToolResult, any, error) {
		id := strings.TrimSpace(in.ObjectID)
		if id == "" {
			return nil, nil, fmt.Errorf("object_id 不能为空")
		}
		o, err := c.getObject(ctx, id)
		if err != nil {
			o2, ok := c.resolveRef(ctx, id)
			if !ok {
				return nil, nil, err
			}
			o = o2
		}
		out, err := c.sourceMessage(ctx, o)
		if err != nil {
			return nil, nil, err
		}
		return textResult(out), nil, nil
	})
}

// sourceMessage 拼来源消息的全文说明。
func (c *client) sourceMessage(ctx context.Context, o *domain.Object) (string, error) {
	ref, _ := o.Props[domain.PropSourceRef].(map[string]any)
	mid, _ := ref["message_id"].(string)
	mid = strings.TrimSpace(mid)
	if mid == "" {
		return fmt.Sprintf("%s 不是从 IM 消息转来的，没有来源消息。", joinNonEmpty(" ", o.Ref, o.Title)), nil
	}
	var m imMessage
	if _, err := c.do(ctx, http.MethodGet, "/api/im/messages/"+url.PathEscape(mid), nil, nil, &m); err != nil {
		if !strings.Contains(err.Error(), "not_found") {
			return "", err
		}
		// IM 插件没启用或消息删了：退回任务里记的快照
		text, _ := ref["text"].(string)
		sender, _ := ref["sender"].(string)
		return fmt.Sprintf("读不到来源消息 %s（IM 插件没启用，或消息已删除）。任务里记的来源快照：\n发信人：%s\n%s",
			mid, sender, strings.TrimSpace(text)), nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "来源消息 %s（%s%s，%s）\n", m.ID, m.Channel, prefixed(" ", m.Conversation), m.At)
	fmt.Fprintf(&b, "发信人：%s\n", m.who())
	writeLinks(&b, m.Link, m.Permalink)
	b.WriteString("正文：\n" + strings.TrimSpace(m.Text) + "\n")

	// 串：这条是串里的回复时，串根是它的父消息；它自己是串根（有回复）时，串根是它
	root := ""
	if m.Thread != nil && m.Thread.ParentExternalID != "" {
		root = m.Thread.ParentExternalID
		var p *imThreadParent
		if _, err := c.do(ctx, http.MethodGet, "/api/im/messages/"+url.PathEscape(mid)+"/thread-parent", nil, nil, &p); err != nil || p == nil {
			// 旧版 IM 没有这个接口：用消息里带的 80 字快照
			p = &imThreadParent{Sender: m.Thread.ParentSenderName, Text: m.Thread.ParentText, Partial: true}
		}
		b.WriteString("\n这条是消息列（串）里的一条回复。串的原消息")
		if p.Sender != "" {
			b.WriteString("（" + p.Sender + "）")
		}
		if p.Partial {
			b.WriteString("（只有摘要，全文没取到）")
		}
		b.WriteString("：\n")
		writeLinks(&b, p.Link, p.Permalink)
		b.WriteString(strings.TrimSpace(p.Text) + "\n")
	} else if m.ReplyCount > 0 {
		root = m.ExternalID
	}
	if root != "" && m.ConversationID != nil && *m.ConversationID != "" {
		var list []imMessage
		q := url.Values{"conversation_id": {*m.ConversationID}, "limit": {"200"}}
		if _, err := c.do(ctx, http.MethodGet, "/api/im/messages", q, nil, &list); err == nil {
			var rs []imMessage
			for _, x := range list {
				if x.Thread != nil && x.Thread.ParentExternalID == root {
					rs = append(rs, x)
				}
			}
			sort.SliceStable(rs, func(i, j int) bool { return rs[i].At < rs[j].At })
			fmt.Fprintf(&b, "\n串里收到的回复（%d 条，旧→新；我在渠道里回的不在这里）：\n", len(rs))
			for _, x := range rs {
				mark := ""
				if x.ID == m.ID {
					mark = "（就是这条来源消息）"
				}
				fmt.Fprintf(&b, "- [%s] %s%s：%s\n", x.At, x.who(), mark, strings.TrimSpace(x.Text))
			}
		}
	}
	if len(m.Replies) > 0 {
		b.WriteString("\n我在工作台里对这条消息的回复：\n")
		for _, r := range m.Replies {
			fmt.Fprintf(&b, "- [%s] %s（%s）\n", r.At, strings.TrimSpace(r.Text), r.Status)
		}
	}
	return strings.TrimRight(b.String(), "\n"), nil
}

func writeLinks(b *strings.Builder, link, permalink string) {
	if link != "" {
		b.WriteString("工作台链接：" + link + "\n")
	}
	if permalink != "" {
		b.WriteString("原平台链接：" + permalink + "\n")
	}
}

func prefixed(sep, s string) string {
	if s == "" {
		return ""
	}
	return sep + s
}
