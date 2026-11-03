package im

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 回复和主动发消息里的 @（0.18.0，不加迁移）：
// 前端正文里写的是「@名字」，另把 mentions [{external_id 或 identity_id, name}] 一起交上来；
// 插件只做校验和把 identity_id 换成渠道编号，正文原样存（工作台里显示仍是「@名字」），
// 渠道写法由适配器在发送时渲染（Outgoing.Mentions）：Slack 换成 <@MemberID>，
// Telegram 有用户名的换成 @用户名、只有数字编号的用 text_mention 实体；取不到能用的编号的照原样文字发。
// 正文里手打、不在 mentions 里的 @ 照原样发。
//
// 放在适配器里渲染而不是插件层拼好文字，是因为 Telegram 的 text_mention 不是文字而是实体（按 UTF-16 偏移），
// 只有适配器知道怎么交给渠道；Fake 记下的 Outgoing 也就带着 mentions，测试能看到交上来的是什么。

// maxMentions 是一次最多带几个 @。
const maxMentions = 50

// maxMentionName 是 @ 的名字最多几个字。
const maxMentionName = 80

// Mention 是正文里的一个「@名字」对应的人：ExternalID 是这个人在渠道里的编号（同消息的 sender_id）。
type Mention struct {
	ExternalID string `json:"external_id"`
	Name       string `json:"name"`
}

// mentionInput 是请求体里的一项：external_id、identity_id 给一个就行，都给时以 identity_id 为准。
type mentionInput struct {
	ExternalID string `json:"external_id"`
	IdentityID string `json:"identity_id"`
	Name       string `json:"name"`
}

// resolveMentions 校验并规整请求里的 mentions：名字去掉开头的 @ 和首尾空白，identity_id 换成这个渠道的编号；
// 同一个编号同一个名字只留一项。identity 不存在、不是这个渠道的 400。
func (in *inbox) resolveMentions(ctx context.Context, channel string, raw []mentionInput) ([]Mention, error) {
	if len(raw) > maxMentions {
		return nil, apiErr(errValidation, "mentions must have at most %d items", maxMentions)
	}
	var out []Mention // 没有时为 nil，Outgoing 里不出现
	seen := map[string]bool{}
	for i, x := range raw {
		name := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(x.Name), "@"))
		if name == "" {
			return nil, apiErr(errValidation, "mentions[%d].name is required", i)
		}
		if utf8.RuneCountInString(name) > maxMentionName {
			return nil, apiErr(errValidation, "mentions[%d].name must be at most %d characters", i, maxMentionName)
		}
		ext := strings.TrimSpace(x.ExternalID)
		if id := strings.TrimSpace(x.IdentityID); id != "" {
			idn, err := in.c.Identities().Get(ctx, id)
			switch {
			case errors.Is(err, plugin.ErrNoRows):
				return nil, apiErr(errValidation, "mentions[%d]: identity %s not found", i, id)
			case err != nil:
				return nil, err
			}
			if idn.Channel != channel {
				return nil, apiErr(errValidation, "mentions[%d]: identity %s is %s, conversation is %s", i, id, idn.Channel, channel)
			}
			ext = idn.ExternalID
		}
		if ext == "" {
			return nil, apiErr(errValidation, "mentions[%d]: external_id or identity_id is required", i)
		}
		k := ext + "\x00" + name
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, Mention{ExternalID: ext, Name: name})
	}
	return out, nil
}

// mentionSpan 是正文里一个认出来的「@名字」：[Start, End) 是字节位置，含开头的 @。
type mentionSpan struct {
	Start, End int
	M          Mention
}

// findMentions 在正文里找 mentions 的「@名字」，同名出现几次认几次；名字互为前缀时先认长的（@林原野 不当成 @林原）。
// 「@」前面紧挨着字母数字（邮箱 a@b）的不算；名字以字母数字结尾而后面紧跟着字母数字的不算（@Ann 不认 @Anna 里的）。
// 中文名后面直接接正文（@林原你好）照样认。
func findMentions(text string, ms []Mention) []mentionSpan {
	if len(ms) == 0 || !strings.Contains(text, "@") {
		return nil
	}
	order := append([]Mention(nil), ms...)
	sort.SliceStable(order, func(i, j int) bool { return len(order[i].Name) > len(order[j].Name) })
	var out []mentionSpan
	for i := 0; i < len(text); {
		if text[i] != '@' || (i > 0 && wordBefore(text[:i])) {
			i++
			continue
		}
		hit := false
		for _, m := range order {
			end := i + 1 + len(m.Name)
			if m.Name == "" || !strings.HasPrefix(text[i+1:], m.Name) || wordJoin(m.Name, text[end:]) {
				continue
			}
			out = append(out, mentionSpan{Start: i, End: end, M: m})
			i, hit = end, true
			break
		}
		if !hit {
			i++
		}
	}
	return out
}

func isWordRune(r rune) bool {
	return r < utf8.RuneSelf && (r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r))
}

// wordBefore 是 @ 前面紧挨着的是不是 ASCII 字母数字（邮箱、a@b 这类）。
func wordBefore(s string) bool {
	r, _ := utf8.DecodeLastRuneInString(s)
	return isWordRune(r)
}

// wordJoin 是名字和后面的字连成了一个词：名字以 ASCII 字母数字结尾、后面紧跟 ASCII 字母数字。
func wordJoin(name, rest string) bool {
	last, _ := utf8.DecodeLastRuneInString(name)
	next, _ := utf8.DecodeRuneInString(rest)
	return rest != "" && isWordRune(last) && isWordRune(next)
}

// slackMemberRe 是能 @ 的 Slack 编号：Member ID（U、W 开头）；Bot（B 开头）等不能 @，照原样文字。
var slackMemberRe = regexp.MustCompile(`^[UW][A-Z0-9]{2,}$`)

// renderSlackMentions 把正文里认出来的「@名字」换成 <@MemberID>；编号不是 Member ID 的照原样。
func renderSlackMentions(text string, ms []Mention) string {
	spans := findMentions(text, ms)
	if len(spans) == 0 {
		return text
	}
	var b strings.Builder
	last := 0
	for _, s := range spans {
		b.WriteString(text[last:s.Start])
		if slackMemberRe.MatchString(s.M.ExternalID) {
			b.WriteString("<@" + s.M.ExternalID + ">")
		} else {
			b.WriteString(text[s.Start:s.End])
		}
		last = s.End
	}
	b.WriteString(text[last:])
	return b.String()
}

// tgEntity 是 Telegram 的消息实体；这里只用 text_mention（给没有用户名的人 @）。偏移和长度按 UTF-16。
type tgEntity struct {
	Type   string  `json:"type"`
	Offset int     `json:"offset"`
	Length int     `json:"length"`
	User   *tgUser `json:"user,omitempty"`
}

var (
	// tgUsernameRe 是 Telegram 用户名（5 到 32 位，字母开头）；收消息时有用户名的发送人编号就是用户名。
	tgUsernameRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{3,31}$`)
	// tgUserIDRe 是没有用户名的人的数字编号（正数；负数是频道、群，不能 @）。
	tgUserIDRe = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
)

// renderTelegramMentions 把正文里认出来的「@名字」换成渠道写法：编号是用户名的换成 @用户名（Telegram 会通知），
// 只有数字编号的保留「@名字」文字，加一个 text_mention 实体指向这个人；都不是的照原样。
func renderTelegramMentions(text string, ms []Mention) (string, []tgEntity) {
	spans := findMentions(text, ms)
	if len(spans) == 0 {
		return text, nil
	}
	var b strings.Builder
	var ents []tgEntity
	u16 := 0 // 已写出部分的 UTF-16 长度
	write := func(s string) {
		b.WriteString(s)
		u16 += utf16Len(s)
	}
	last := 0
	for _, s := range spans {
		write(text[last:s.Start])
		ext := strings.TrimPrefix(s.M.ExternalID, "@")
		seg := text[s.Start:s.End]
		switch {
		case tgUserIDRe.MatchString(ext):
			id, ok := parseTgID(ext)
			if ok {
				ents = append(ents, tgEntity{Type: "text_mention", Offset: u16, Length: utf16Len(seg), User: &tgUser{ID: id}})
			}
			write(seg)
		case tgUsernameRe.MatchString(ext):
			write("@" + ext)
		default:
			write(seg)
		}
		last = s.End
	}
	write(text[last:])
	return b.String(), ents
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

func parseTgID(s string) (int64, bool) {
	var n int64
	for _, c := range s {
		d := int64(c - '0')
		if n > (1<<63-1-d)/10 {
			return 0, false
		}
		n = n*10 + d
	}
	return n, n > 0
}
