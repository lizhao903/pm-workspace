package im

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/imident"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 收消息（IM-01a）：规整、认人、认会话（没登记的登记上，PR-02）、算「与我相关」、去重落库，新落库的发 im.message_received。

// timeLayout 定长毫秒 UTC，字符串比较即时间比较。
const timeLayout = "2006-01-02T15:04:05.000Z"

const (
	maxText = 20000 // 正文上限（字），超出截断
	maxName = 200
)

// Received 是 im.message_received 的 payload。只带 id 和归类，正文用 /api/im/messages 取。
type Received struct {
	MessageID      string  `json:"message_id"`
	Channel        string  `json:"channel"`
	ConnectorID    string  `json:"connector_id"`
	ConversationID *string `json:"conversation_id"`
	IdentityID     *string `json:"identity_id"`
	StakeholderID  *string `json:"stakeholder_id"`
	Relevance      string  `json:"relevance"`
	At             string  `json:"at"`
}

// IngestResult 是一批消息的落库结果。
type IngestResult struct {
	IDs        []string `json:"ids"`        // 新落库的消息 id
	Duplicates int      `json:"duplicates"` // 已经收过的
}

type inbox struct {
	c        plugin.Core
	adapters []Adapter
	now      func() time.Time
	taskMu   sync.Mutex             // 转任务串行，同一条消息连点两次不建两条任务
	fdeMu    sync.Mutex             // FDE 反馈转发排队、发起串行（TSK-0468）
	pullMu   map[string]*sync.Mutex // 按适配器 key：定时拉和立即同步不同时跑，进度不打架（IM-01b）
	fetchMu  sync.Mutex             // 获取附件串行，挑文件名和落库不打架（IM-04a）
	// publicURL 是浏览器访问工作台的地址，回执里的看板链接用（AUTO-06）；空串时链接只有路径
	publicURL string
}

func (in *inbox) clock() time.Time {
	if in.now != nil {
		return in.now()
	}
	return time.Now()
}

// ingest 落一批。strict（回调）时有一条不合法整批拒绝、回 400；拉取时跳过不合法的并记日志，免得进度卡住。
// 落到一半出错不回滚：重来一次时靠去重跳过已落的。
func (in *inbox) ingest(ctx context.Context, a Adapter, msgs []Incoming, strict bool) (IngestResult, error) {
	res := IngestResult{IDs: []string{}}
	ch, err := imident.NormalizeChannel(a.Channel())
	if err != nil {
		return res, fmt.Errorf("适配器 %s 的渠道不对：%w", a.Key(), err)
	}
	me := newSelfHandles(a)
	rows := make([]row, 0, len(msgs))
	var mine []Incoming
	for i, m := range msgs {
		// 我对「私信我确认」的回复（TSK-0411，askme.go）：记到等待上，不当消息落库、不触发 IM 流程
		if ok, err := in.captureAsk(ctx, ch, m, m.FromSelf); err != nil {
			return res, err
		} else if ok {
			continue
		}
		if m.FromSelf {
			// 等这一批别人的消息落完再记，回的可能就是同一批里的
			mine = append(mine, m)
			continue
		}
		self, err := me.forConnector(ctx, in.c, strings.TrimSpace(m.ConnectorID))
		if err != nil {
			return res, err
		}
		r, err := in.prepare(ctx, ch, self, m)
		var bi *badInput
		switch {
		case errors.As(err, &bi) && !strict:
			in.c.Log().Warn("skip invalid im message", "adapter", a.Key(), "index", i, "err", err)
			continue
		case errors.As(err, &bi):
			return res, apiErr(errValidation, "messages[%d]: %s", i, err)
		case err != nil:
			return res, err
		}
		r.adapter = a.Key()
		rows = append(rows, r)
	}
	for _, r := range rows {
		in.register(ctx, &r)
		ok, err := in.insert(ctx, r)
		if err != nil {
			return res, err
		}
		if !ok {
			res.Duplicates++
			// 早先当普通消息收进来的（串里回复同时发到频道的，0010 之前不记串），补上属于哪个串
			if err := in.fillThread(ctx, r); err != nil {
				return res, err
			}
			continue
		}
		res.IDs = append(res.IDs, r.id)
		ev := Received{MessageID: r.id, Channel: r.channel, ConnectorID: r.connectorID, ConversationID: r.convID,
			IdentityID: r.identityID, StakeholderID: r.stakeholderID, Relevance: r.relevance, At: r.sentAt}
		if err := in.c.Events().Publish(ctx, EventReceived, ev); err != nil {
			in.c.Log().Warn("publish im event failed", "message", r.id, "err", err)
		}
	}
	for _, m := range mine {
		if err := in.recordSelf(ctx, ch, m); err != nil {
			return res, err
		}
	}
	return res, nil
}

// sameReplySQL 找同渠道、同连接器、同会话里已记过的同一外部编号的回复；参数依次是 external_id、channel、connector_id、
// conversation_external_id。外部编号只在会话内唯一（Telegram 的 message_id），所以按会话圈。
const sameReplySQL = `SELECT 1 FROM im_replies rp JOIN im_messages mm ON mm.id = rp.message_id
	WHERE rp.external_id = ? AND mm.channel = ? AND mm.connector_id = ? AND mm.conversation_external_id = ?`

// recordSelf 把「我」自己在渠道里发的一条（FromSelf，IM-06）记成回复：挂在同渠道、同连接器、同会话里
// 发送时间不晚于它的最近一条消息上，状态 sent，时间用它的发送时间，那条标为已读，处理状态不动（要不要算处理完由人定）。
// 同一外部编号已记过（在工作台里回复的，拉回来时又看到）、是工作台主动发出的（im_outbox）、没有会话编号、会话里还没收过消息的跳过。
func (in *inbox) recordSelf(ctx context.Context, ch string, m Incoming) error {
	ext, conv := strings.TrimSpace(m.ExternalID), strings.TrimSpace(m.ConversationID)
	if ext == "" || conv == "" {
		return nil
	}
	convExt, err := imident.NormalizeExternalID(ch, conv)
	if err != nil {
		return nil
	}
	at := m.At
	if at.IsZero() {
		at = in.clock()
	}
	sentAt := at.UTC().Format(timeLayout)
	// 工作台主动发出去的（0.17.0，outbox.go）已在发件记录里，不再记成回复
	if dup, err := in.sentOutside(ctx, ch, strings.TrimSpace(m.ConnectorID), ext); err != nil || dup {
		return err
	}
	var msgID string
	err = plugin.ErrNoRows
	if tp := strings.TrimSpace(m.ThreadParentID); tp != "" {
		// 串里的回复（0010）：记在这个串里在它之前最近一条（父消息或更早的回复）上；串里一条都没收过再按会话找
		err = in.c.Store().QueryRow(ctx, `SELECT id FROM im_messages WHERE channel = ? AND connector_id = ?
			AND (external_id = ? OR thread_parent_external_id = ?) AND sent_at <= ? ORDER BY sent_at DESC LIMIT 1`,
			ch, strings.TrimSpace(m.ConnectorID), tp, tp, sentAt).Scan(&msgID)
	}
	if errors.Is(err, plugin.ErrNoRows) {
		err = in.c.Store().QueryRow(ctx, `SELECT id FROM im_messages WHERE channel = ? AND connector_id = ? AND conversation_external_id = ?
			AND sent_at <= ? ORDER BY sent_at DESC LIMIT 1`, ch, strings.TrimSpace(m.ConnectorID), convExt, sentAt).Scan(&msgID)
	}
	if errors.Is(err, plugin.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	// 查重和插入在同一条语句里：工作台回复正在落库时不会插进第二条；回复那边后落库的话由它清掉这一条（见 reply）
	res, err := in.c.Store().Exec(ctx, `INSERT INTO im_replies (id, message_id, text, status, external_id, created_at)
		SELECT ?, ?, ?, 'sent', ?, ? WHERE NOT EXISTS (`+sameReplySQL+`)`,
		idgen.Prefixed("rp"), msgID, clip(m.Text, maxText), ext, sentAt, ext, ch, strings.TrimSpace(m.ConnectorID), convExt)
	if err != nil {
		return fmt.Errorf("record self reply: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil
	}
	_, err = in.c.Store().Exec(ctx, `UPDATE im_messages SET is_read = 1 WHERE id = ?`, msgID)
	return err
}

// row 是规整好、待插入的一条。
type row struct {
	id, channel, connectorID, externalID string
	convID                               *string
	convExt, convKind, convName          string
	identityID, stakeholderID            *string
	senderExt, senderName, text          string
	attachments, relevance               string
	sentAt, receivedAt                   string
	adapter                              string
	// 串里的回复（0010）：父消息的 external_id 和到达时的父消息快照
	threadParent, threadSender, threadText string
}

// badInput 是一条消息本身不合法（和查库出错区分开）。
type badInput struct{ msg string }

func (e *badInput) Error() string { return e.msg }

func bad(format string, args ...any) error { return &badInput{fmt.Sprintf(format, args...)} }

func (in *inbox) prepare(ctx context.Context, ch string, self []string, m Incoming) (row, error) {
	now := in.clock().UTC()
	r := row{id: idgen.Prefixed("msg"), channel: ch, receivedAt: now.Format(timeLayout)}
	r.externalID = strings.TrimSpace(m.ExternalID)
	if r.externalID == "" {
		return r, bad("external_id is required")
	}
	r.connectorID = strings.TrimSpace(m.ConnectorID)
	sender, err := imident.NormalizeExternalID(ch, m.SenderID)
	if err != nil {
		return r, bad("sender_id is required")
	}
	r.senderExt = sender
	r.senderName = clip(strings.TrimSpace(m.SenderName), maxName)
	r.text = clip(m.Text, maxText)
	r.convName = clip(strings.TrimSpace(m.ConversationName), maxName)
	if s := strings.TrimSpace(m.ConversationID); s != "" {
		if r.convExt, err = imident.NormalizeExternalID(ch, s); err != nil {
			return r, bad("conversation_id: %v", err)
		}
	}
	switch k := strings.TrimSpace(m.ConversationKind); k {
	case "group", "direct":
		r.convKind = k
	case "":
		r.convKind = "group"
		if r.convName == "" {
			r.convKind = "direct"
		}
	default:
		return r, bad("conversation_kind must be group or direct")
	}
	switch m.Mention {
	case "", "me", "all":
	default:
		return r, bad("mention must be me, all or empty")
	}
	r.attachments = "[]"
	if a := strings.TrimSpace(string(m.Attachments)); a != "" && a != "null" {
		// 没有 id 或 id 重复的附件补上 id，获取时按 id 找（IM-04a）
		if r.attachments, err = normalizeAttachments(a); err != nil {
			return r, err
		}
	}
	at := m.At
	if at.IsZero() {
		at = now
	}
	r.sentAt = at.UTC().Format(timeLayout)

	// 按编号认发送人和会话；没登记的发送人留空、读的时候再补认，没登记的会话落库前登记（register）
	if idn, err := in.c.Identities().Find(ctx, ch, r.senderExt); err == nil {
		r.identityID, r.stakeholderID = &idn.ID, &idn.StakeholderID
	} else if !errors.Is(err, plugin.ErrNoRows) {
		return r, err
	}
	if r.convExt != "" {
		if cv, err := in.c.Conversations().Find(ctx, ch, r.convExt); err == nil {
			r.convID, r.convKind = &cv.ID, cv.Kind
		} else if !errors.Is(err, plugin.ErrNoRows) {
			return r, err
		}
	}
	r.relevance = relevance(m.Mention, r.text, self, r.convKind)
	if tp := strings.TrimSpace(m.ThreadParentID); tp != "" && tp != r.externalID {
		r.threadParent = tp
		r.threadSender = clip(strings.TrimSpace(m.ThreadParentSender), maxName)
		r.threadText = clip(strings.TrimSpace(m.ThreadParentText), threadTextMax)
		// 我发起的串（父消息是我发的）里别人的回复算与我相关，记 me；@所有人、无关的升上来，私聊本来就相关不动
		if r.relevance == "" || r.relevance == "all" {
			mine := m.ThreadParentMine
			if !mine {
				if mine, err = in.parentIsMine(ctx, ch, r.connectorID, tp); err != nil {
					return r, err
				}
			}
			if mine {
				r.relevance = "me"
			}
		}
	}
	return r, nil
}

// threadTextMax 是父消息正文快照的字数（0010）。
const threadTextMax = 80

// parentIsMine 父消息是不是我发的：我发的不落成消息，记成了回复（工作台回复、本人身份拉到的自己发的，im_replies.external_id）。
func (in *inbox) parentIsMine(ctx context.Context, ch, connID, parent string) (bool, error) {
	var x int
	err := in.c.Store().QueryRow(ctx, `SELECT 1 FROM im_replies rp JOIN im_messages mm ON mm.id = rp.message_id
		WHERE rp.external_id = ? AND rp.status = 'sent' AND mm.channel = ? AND mm.connector_id = ? LIMIT 1`, parent, ch, connID).Scan(&x)
	if errors.Is(err, plugin.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// fillThread 已收过的消息补上属于哪个串（只补没记过的），不改别的。
func (in *inbox) fillThread(ctx context.Context, r row) error {
	if r.threadParent == "" {
		return nil
	}
	_, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET thread_parent_external_id = ?,
		thread_parent_sender = CASE WHEN thread_parent_sender = '' THEN ? ELSE thread_parent_sender END,
		thread_parent_text = CASE WHEN thread_parent_text = '' THEN ? ELSE thread_parent_text END
		WHERE channel = ? AND external_id = ? AND (thread_parent_external_id = '' OR thread_parent_external_id = ?)`,
		r.threadParent, r.threadSender, r.threadText, r.channel, r.externalID, r.threadParent)
	return err
}

// register 会话还没登记时登记上（渠道、编号、群名、类型，私聊带上对方的身份），项目绑定面板才列得出来（PR-02）。
// 登记失败只记日志，消息照常落库，读的时候再按编号补认。
func (in *inbox) register(ctx context.Context, r *row) {
	if r.convID != nil || r.convExt == "" {
		return
	}
	nc := plugin.NewConversation{Channel: r.channel, ExternalID: r.convExt, Kind: r.convKind, Name: r.convName}
	if r.convKind == "direct" && r.identityID != nil {
		nc.Members = []string{*r.identityID}
	}
	cv, _, err := in.c.ConversationWriter().Ensure(ctx, nc)
	if err != nil {
		in.c.Log().Warn("register im conversation failed", "channel", r.channel, "conversation", r.convExt, "err", err)
		return
	}
	r.convID, r.convKind = &cv.ID, cv.Kind
}

// registerJob 启用时跑一次：之前收到、会话还没登记的消息补登记会话并回写会话 id（PR-02）。
// 只在启用时跑，用户删掉的会话不会被定时补回来；之后再收到这个会话的消息会重新登记。
func (in *inbox) registerJob(ctx context.Context, _ plugin.Core) error {
	rows, err := in.c.Store().Query(ctx, `SELECT channel, conversation_external_id, conversation_kind, conversation_name,
		sender_external_id, MAX(sent_at) FROM im_messages
		WHERE conversation_id IS NULL AND conversation_external_id <> '' GROUP BY channel, conversation_external_id`)
	if err != nil {
		return err
	}
	var todo []row
	for rows.Next() {
		var r row
		var at string
		if err := rows.Scan(&r.channel, &r.convExt, &r.convKind, &r.convName, &r.senderExt, &at); err != nil {
			_ = rows.Close()
			return err
		}
		todo = append(todo, r)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, r := range todo {
		// 私聊的成员取最近一条的发送人
		if r.convKind == "direct" {
			if idn, err := in.c.Identities().Find(ctx, r.channel, r.senderExt); err == nil {
				r.identityID = &idn.ID
			}
		}
		in.register(ctx, &r)
		if r.convID == nil {
			continue
		}
		if _, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET conversation_id = ?
			WHERE conversation_id IS NULL AND channel = ? AND conversation_external_id = ?`, *r.convID, r.channel, r.convExt); err != nil {
			return err
		}
	}
	return nil
}

// insert 落一条，同一渠道的同一消息编号已在时跳过，返回 false。
func (in *inbox) insert(ctx context.Context, r row) (bool, error) {
	res, err := in.c.Store().Exec(ctx, `INSERT INTO im_messages (id, channel, connector_id, external_id,
		conversation_id, conversation_external_id, conversation_kind, conversation_name,
		sender_identity_id, sender_external_id, sender_name, text, attachments, relevance, sent_at, received_at, adapter,
		thread_parent_external_id, thread_parent_sender, thread_parent_text)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (channel, external_id) DO NOTHING`,
		r.id, r.channel, r.connectorID, r.externalID, r.convID, r.convExt, r.convKind, r.convName,
		r.identityID, r.senderExt, r.senderName, r.text, r.attachments, r.relevance, r.sentAt, r.receivedAt, r.adapter,
		r.threadParent, r.threadSender, r.threadText)
	if err != nil {
		return false, fmt.Errorf("insert im message: %w", err)
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// pullJob 是一个拉取型适配器的后台任务：适配器实现了 Scheduler 的先问这一轮到没到点。
func (in *inbox) pullJob(p Puller) func(ctx context.Context, c plugin.Core) error {
	return func(ctx context.Context, _ plugin.Core) error {
		if s, ok := p.(Scheduler); ok && !s.Due(ctx, in.clock()) {
			return nil
		}
		_, err := in.pullOnce(ctx, p, "")
		return err
	}
}

// pullOnce 拉一次：读进度、拉、落库、存进度。同一个适配器一次只跑一个。
// connectorID 非空且适配器实现了 InstancePuller 时只拉这个实例（立即同步，IM-01d）。
func (in *inbox) pullOnce(ctx context.Context, p Puller, connectorID string) (IngestResult, error) {
	res := IngestResult{IDs: []string{}}
	if mu := in.pullMu[p.Key()]; mu != nil {
		mu.Lock()
		defer mu.Unlock()
	}
	var cursor string
	err := in.c.Store().QueryRow(ctx, `SELECT cursor FROM im_cursors WHERE adapter = ?`, p.Key()).Scan(&cursor)
	if err != nil && !errors.Is(err, plugin.ErrNoRows) {
		return res, err
	}
	var (
		msgs []Incoming
		next string
	)
	if ip, ok := p.(InstancePuller); ok && connectorID != "" {
		msgs, next, err = ip.PullConnector(ctx, connectorID, cursor)
	} else {
		msgs, next, err = p.Pull(ctx, cursor)
	}
	if err != nil {
		return res, fmt.Errorf("pull %s: %w", p.Key(), err)
	}
	if len(msgs) > 0 {
		if res, err = in.ingest(ctx, p, msgs, false); err != nil {
			return res, fmt.Errorf("pull %s: %w", p.Key(), err)
		}
	}
	if next == cursor {
		return res, nil
	}
	_, err = in.c.Store().Exec(ctx, `INSERT INTO im_cursors (adapter, cursor, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (adapter) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
		p.Key(), next, in.clock().UTC().Format(timeLayout))
	return res, err
}
