// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 串的父消息（0.32.0）：消息列（串）里的回复转任务、交给 Claude Code、给 SOP 流程读时，要带上串的父消息全文，
// 不然执行方只看到「这个华哥看一下吧」这类回复，不知道原始诉求（TSK-0837：父消息是我发的，我自己的消息不落 im_messages，
// 任务正文里只有两条回复，库里只有 80 字快照）。
//
// 全文按下面的顺序取，先到先得（source）：
//   - message：父消息在库里（别人发的），取它的发信人（认上联系人用联系人名）和全文，带工作台深链、原平台链接；
//   - self：父消息是我发的，用拉取时记下的我自己的消息（recordSelf 记进 im_replies，external_id 是它）或工作台主动发出的
//     （im_outbox.external_id），发信人写「我」；
//   - fetched：前两样都没有、又允许联网（fetch）时，问适配器要（Slack 调 conversations.replies 取串的第一条），按渠道+编号记在内存里；
//   - snapshot：都拿不到，用回复到达时记的 80 字快照，partial 为真（拼正文时标「（摘要）」）。
// 发信人在 self 以外取不到时用快照里的名字。列表接口不带它（不为一页消息去查、去联网），要用时单独取：
// GET /api/im/messages/{id}/thread-parent、im_get_message 的 message.thread_parent、转任务写进来源的 source_ref.thread_parent。

// ThreadParent 是一条串里回复的父消息。
type ThreadParent struct {
	ExternalID string  `json:"external_id"`
	MessageID  *string `json:"message_id"`
	Sender     string  `json:"sender"`
	Text       string  `json:"text"`
	// Source 是全文从哪来：message / self / fetched / snapshot
	Source string `json:"source"`
	// Partial 为真时 Text 只是 80 字快照
	Partial   bool   `json:"partial"`
	Link      string `json:"link"`
	Permalink string `json:"permalink"`
}

const (
	ParentFromMessage  = "message"
	ParentFromSelf     = "self"
	ParentFromFetched  = "fetched"
	ParentFromSnapshot = "snapshot"
)

// ThreadParentFetcher 是可选接口：适配器能按编号向渠道取一条串的父消息（0.32.0）。取不到回空串、不报错；
// 出错（限流、没权限、断网）回错误，调用方退回快照。
type ThreadParentFetcher interface {
	Adapter
	FetchThreadParent(ctx context.Context, connectorID, parentExternalID string) (sender, text string, err error)
}

// parentCache 是联网取到的父消息全文，按「渠道:编号」记，进程内有效。
var parentCache sync.Map

// threadParentOf 取 m 所在串的父消息；不是串里回复回 nil。fetch 为真时库里没有全文会问适配器。
func (in *inbox) threadParentOf(ctx context.Context, m Message, fetch bool) (*ThreadParent, error) {
	if m.Thread == nil || m.Thread.ParentExternalID == "" {
		return nil, nil
	}
	ext := m.Thread.ParentExternalID
	p := &ThreadParent{ExternalID: ext, Sender: m.Thread.ParentSenderName, Permalink: in.parentPermalink(ctx, m, ext)}
	// 1. 库里的父消息
	var id string
	err := in.c.Store().QueryRow(ctx, `SELECT id FROM im_messages WHERE channel = ? AND external_id = ? LIMIT 1`, m.Channel, ext).Scan(&id)
	switch {
	case err == nil:
		pm, err := in.get(ctx, id)
		if err != nil {
			return nil, err
		}
		p.MessageID, p.Text, p.Source, p.Link, p.Permalink = &pm.ID, pm.Text, ParentFromMessage, pm.Link, pm.Permalink
		if s := whoOf(pm); s != "" {
			p.Sender = s
		}
		return p, nil
	case !errors.Is(err, plugin.ErrNoRows):
		return nil, err
	}
	// 2. 我自己发的：拉回来记成回复的，或工作台发出去的
	var text string
	err = in.c.Store().QueryRow(ctx, `SELECT rp.text FROM im_replies rp JOIN im_messages mm ON mm.id = rp.message_id
		WHERE rp.external_id = ? AND rp.status = 'sent' AND mm.channel = ? ORDER BY rp.created_at LIMIT 1`, ext, m.Channel).Scan(&text)
	if errors.Is(err, plugin.ErrNoRows) {
		err = in.c.Store().QueryRow(ctx, `SELECT text FROM im_outbox WHERE external_id = ? AND channel = ? AND status = 'sent'
			ORDER BY created_at LIMIT 1`, ext, m.Channel).Scan(&text)
	}
	switch {
	case err == nil && strings.TrimSpace(text) != "":
		p.Text, p.Source = text, ParentFromSelf
		if p.Sender == "" {
			p.Sender = "我"
		}
		return p, nil
	case err != nil && !errors.Is(err, plugin.ErrNoRows):
		return nil, err
	}
	// 3. 问渠道（只在要用全文时）
	key := m.Channel + ":" + ext
	if v, ok := parentCache.Load(key); ok {
		p.Text, p.Source = v.(string), ParentFromFetched
		return p, nil
	}
	if fetch {
		if f, ok := in.adapterFor(m).(ThreadParentFetcher); ok {
			sender, text, err := f.FetchThreadParent(ctx, m.ConnectorID, ext)
			if err != nil {
				in.c.Log().Warn("im fetch thread parent failed", "message", m.ID, "parent", ext, "err", err)
			} else if strings.TrimSpace(text) != "" {
				parentCache.Store(key, text)
				p.Text, p.Source = text, ParentFromFetched
				if p.Sender == "" {
					p.Sender = sender
				}
				return p, nil
			}
		}
	}
	// 4. 快照
	p.Text, p.Source, p.Partial = m.Thread.ParentText, ParentFromSnapshot, true
	return p, nil
}

// parentPermalink 是父消息在原平台的链接（按编号拼，不联网），拼不出为空串。
func (in *inbox) parentPermalink(ctx context.Context, m Message, ext string) string {
	if pl, ok := in.adapterFor(m).(Permalinker); ok {
		return pl.Permalink(ctx, Message{Channel: m.Channel, ConnectorID: m.ConnectorID, Adapter: m.Adapter, ExternalID: ext})
	}
	return ""
}

// whoOf 是消息的发信人显示名：认上联系人用联系人名。
func whoOf(m Message) string {
	if m.ContactName != "" {
		return m.ContactName
	}
	return m.SenderName
}

// out 是 im_get_message、source_ref 里的样子；nil 时为 nil。
func (p *ThreadParent) out() any {
	if p == nil {
		return nil
	}
	return map[string]any{"external_id": p.ExternalID, "message_id": derefOr(p.MessageID), "sender": p.Sender, "text": p.Text,
		"source": p.Source, "partial": p.Partial, "link": p.Link, "permalink": p.Permalink}
}

func derefOr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// getThreadParent 是 GET /api/im/messages/{id}/thread-parent：这条消息所在串的父消息，不是串里回复为 null。
// 库里没有全文时会问渠道（Slack conversations.replies），取不到回 80 字快照（partial 为真），不报错。
func (in *inbox) getThreadParent(w http.ResponseWriter, r *http.Request) {
	m, err := in.get(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	p, err := in.threadParentOf(r.Context(), m, true)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": p})
}

// withThreadParent 给转任务写进的来源（source_ref）补上串的父消息（0.32.0）：交给 Claude Code 的提示词「来源消息」一节据此写出父消息全文。
// 取不到不影响转任务，只记日志。回 ref 本身。
func (in *inbox) withThreadParent(ctx context.Context, m Message, ref map[string]any) map[string]any {
	p, err := in.threadParentOf(ctx, m, true)
	if err != nil {
		in.c.Log().Warn("im thread parent for task failed", "message", m.ID, "err", err)
		return ref
	}
	if p != nil {
		ref["thread_parent"] = map[string]any{"sender": p.Sender, "text": clip(p.Text, sourceTextMax), "external_id": p.ExternalID,
			"permalink": p.Permalink, "partial": p.Partial}
	}
	return ref
}
