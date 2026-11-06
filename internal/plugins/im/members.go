package im

import (
	"net/http"
	"sort"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// @ 候选（0.18.0，不加迁移）：GET /api/im/conversations/{conversation_id}/members。
// 回复框、发消息弹窗里输入 @ 时弹出的人，按渠道编号去重，联系人在前：
//   - 先是这个会话里发过言、认上联系人的人（source=conversation，用联系人名，最近发言的在前）；
//   - 再是联系人里在这个渠道有 IM 身份、没在这个会话发过言的人（source=contact，已归档的不列，按名字排，最多 500 个）；
//   - 最后是发过言、没认上联系人的人（source=conversation，用渠道里的名字，最近发言的在前）。发过言的最多取 200 个。
//
// 不调渠道的成员列表接口（Slack conversations.members 等）：只认工作台里已经知道的人。会话不存在 404。

const (
	maxSpeakers       = 200
	maxContactMembers = 500
)

// Member 是一个 @ 候选。ExternalID 是渠道里的编号（回复、发消息时作 mentions[].external_id 交回）；
// Name 是显示和写进正文的名字（联系人名优先，其次渠道里的名字，都没有用编号）；SenderName 是渠道里的名字，没发过言的为空；
// IdentityID、ContactID 是认上的 IM 身份和联系人，没认上为空串；LastAt 是在这个会话里最近一次发言的时间，没发过言为空串。
type Member struct {
	ExternalID string `json:"external_id"`
	Name       string `json:"name"`
	SenderName string `json:"sender_name"`
	IdentityID string `json:"identity_id"`
	ContactID  string `json:"contact_id"`
	Source     string `json:"source"`
	LastAt     string `json:"last_at"`
	// IsBot 是机器人（Slack 的 B 开头编号，Telegram 用户名以 bot 结尾）；IsSelf 是「我」（编号或名字对上连接器账号、「我的称呼」），
	// 群组管理「全部加为联系人」排除这两种（TSK-0724）
	IsBot  bool `json:"is_bot"`
	IsSelf bool `json:"is_self"`
}

func (in *inbox) listMembers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cv, err := in.conversation(ctx, r.PathValue("conversation_id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	rows, err := in.c.Store().Query(ctx, `SELECT sender_external_id, max(sender_name), max(sent_at) FROM im_messages WHERE `+convCond+`
		AND sender_external_id <> '' GROUP BY sender_external_id ORDER BY max(sent_at) DESC LIMIT ?`,
		append(convArgs(cv.ID, cv.Channel, cv.ExternalID), maxSpeakers)...)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	out := []Member{}
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.ExternalID, &m.SenderName, &m.LastAt); err != nil {
			_ = rows.Close()
			fail(w, r, in.c, err)
			return
		}
		m.Source = "conversation"
		out = append(out, m)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	rs := newResolver(in.c)
	contactName := func(sid string) (string, bool, error) {
		ct, err := cached(rs.contacts, sid, func() (plugin.ContactInfo, error) { return in.c.Contacts().Get(ctx, sid) })
		if err != nil || ct == nil {
			return "", false, err
		}
		return ct.Name, ct.Archived, nil
	}
	seen := map[string]bool{}
	for i := range out {
		m := &out[i]
		seen[normExt(cv.Channel, m.ExternalID)] = true
		idn, err := cached(rs.idents, "ext:"+cv.Channel+":"+m.ExternalID, func() (plugin.IdentityInfo, error) {
			return in.c.Identities().Find(ctx, cv.Channel, m.ExternalID)
		})
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		if idn != nil {
			m.IdentityID, m.ContactID = idn.ID, idn.StakeholderID
			name, _, err := contactName(idn.StakeholderID)
			if err != nil {
				fail(w, r, in.c, err)
				return
			}
			m.Name = name
		}
		m.Name = firstNonEmpty(m.Name, m.SenderName, m.ExternalID)
	}
	ids, err := in.c.Identities().List(ctx, cv.Channel)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	var fromContacts []Member
	for _, idn := range ids {
		if seen[normExt(cv.Channel, idn.ExternalID)] || idn.StakeholderID == "" {
			continue
		}
		name, archived, err := contactName(idn.StakeholderID)
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		if archived || name == "" {
			continue
		}
		seen[normExt(cv.Channel, idn.ExternalID)] = true
		fromContacts = append(fromContacts, Member{ExternalID: idn.ExternalID, Name: name, IdentityID: idn.ID, ContactID: idn.StakeholderID, Source: "contact"})
	}
	sort.SliceStable(fromContacts, func(i, j int) bool { return fromContacts[i].Name < fromContacts[j].Name })
	if len(fromContacts) > maxContactMembers {
		fromContacts = fromContacts[:maxContactMembers]
	}
	// 联系人在前：认上联系人的发言人、别的联系人、没认上的发言人
	var linked, unlinked []Member
	for _, m := range out {
		if m.ContactID != "" {
			linked = append(linked, m)
		} else {
			unlinked = append(unlinked, m)
		}
	}
	out = append(append(append([]Member{}, linked...), fromContacts...), unlinked...)
	connID, err := in.lastConnector(ctx, cv.ID)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	var self []string
	if a := in.adapterFor(Message{Channel: cv.Channel}); a != nil {
		if self, err = newSelfHandles(a).forConnector(ctx, in.c, connID); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	for i := range out {
		out[i].IsBot = botSender(cv.Channel, out[i].ExternalID)
		out[i].IsSelf = selfSender(self, out[i].ExternalID, out[i].SenderName)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// botSender 按编号认机器人：Slack 机器人发的消息发信人是 bot_id（B 开头），Telegram 机器人的用户名必须以 bot 结尾。
func botSender(channel, ext string) bool {
	switch channel {
	case "slack":
		return strings.HasPrefix(ext, "B")
	case "telegram":
		return strings.HasSuffix(strings.ToLower(ext), "bot")
	}
	return false
}

// selfSender 编号或渠道里的名字对上「我」的称呼（不分大小写）。
func selfSender(self []string, ext, name string) bool {
	for _, h := range self {
		if h != "" && (strings.EqualFold(h, ext) || (name != "" && strings.EqualFold(h, name))) {
			return true
		}
	}
	return false
}

// normExt 是去重用的编号：Telegram 的用户名不分大小写、身份里不带 @。
func normExt(channel, ext string) string {
	if channel == "telegram" {
		return strings.ToLower(strings.TrimPrefix(ext, "@"))
	}
	return ext
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s = strings.TrimSpace(s); s != "" {
			return s
		}
	}
	return ""
}
