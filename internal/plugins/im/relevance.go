package im

import (
	"context"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 「与我相关」（IM-03）：@我、@所有人、私聊。「我」的称呼不写死，从收这条消息的连接器账号来
// （连通测试时对方给的 account，经 Core.Connectors() 只读读到），再加上适配器自己给的（Handles，例如渠道里的用户编号）。
// 到达时算一次存进 relevance；改了连接器账号，之后到的消息按新称呼认，已存的不重算（见 docs/api-contract.md）。

// allHandles 是 @所有人 的写法，和原型 ALL_HANDLES 一致。
var allHandles = []string{"所有人", "全体成员", "all", "here", "channel", "everyone"}

// selfHandles 是一批消息里「我」的称呼，按连接器缓存，一批只查一次连接器。
type selfHandles struct {
	adapter []string
	byConn  map[string][]string
}

func newSelfHandles(a Adapter) *selfHandles {
	s := &selfHandles{byConn: map[string][]string{}}
	if h, ok := a.(Handles); ok {
		s.adapter = h.Handles()
	}
	return s
}

// forConnector 是这个连接器下「我」的称呼：适配器给的加连接器账号拆出来的。没给连接器、连接器已删时只有适配器给的。
func (s *selfHandles) forConnector(ctx context.Context, c plugin.Core, id string) ([]string, error) {
	if id == "" {
		return s.adapter, nil
	}
	if hs, ok := s.byConn[id]; ok {
		return hs, nil
	}
	hs := s.adapter
	cn, err := c.Connectors().Get(ctx, id)
	switch {
	case err == nil:
		hs = append(append([]string{}, s.adapter...), accountHandles(cn.Account)...)
	case !errors.Is(err, plugin.ErrNoRows):
		return nil, err
	}
	s.byConn[id] = hs
	return hs, nil
}

// accountHandles 把连接器账号拆成能被 @ 到的称呼：整串、括号里外、逗号斜杠分开的各段，开头的 @ 去掉；
// 段里有空格时整段算一个（显示名 Lin Yuan），另把其中 @ 开头的词单拿出来（「Broleez @broleez」）。
// 例：「@broleez」→ broleez；「Zhao（@zhaoli，U012AB）」→ Zhao（@zhaoli，U012AB）、Zhao、zhaoli、U012AB。
// 匹配不分大小写，只差大小写的只留一个。
func accountHandles(account string) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(h string) {
		h = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(h), "@"))
		if h == "" || seen[strings.ToLower(h)] {
			return
		}
		seen[strings.ToLower(h)] = true
		out = append(out, h)
	}
	add(account)
	parts := strings.FieldsFunc(account, func(r rune) bool { return strings.ContainsRune("()（）[]【】<>《》,，、;；/|", r) })
	for _, p := range parts {
		add(p)
		for _, w := range strings.Fields(p) {
			if strings.HasPrefix(w, "@") {
				add(w)
			}
		}
	}
	return out
}

// relevance 是这条消息为什么和我有关：@我 优先于 @所有人，私聊本来就是发给我的；无关为空串。口径同原型 relevance。
// mention 是渠道明确给的提及（me / all），给了就以它为准。
func relevance(mention, text string, self []string, kind string) string {
	if mention != "" {
		return mention
	}
	if mentions(text, self) {
		return "me"
	}
	if mentions(text, allHandles) {
		return "all"
	}
	if kind == "direct" {
		return "dm"
	}
	return ""
}

// mentions：正文里有「@称呼」，称呼后面不紧跟字母数字（@我们 不算 @我）。英文不分大小写。
func mentions(text string, handles []string) bool {
	low := strings.ToLower(text)
	for _, h := range handles {
		h = strings.ToLower(strings.TrimSpace(h))
		if h == "" {
			continue
		}
		needle := "@" + h
		for i := 0; ; {
			j := strings.Index(low[i:], needle)
			if j < 0 {
				break
			}
			end := i + j + len(needle)
			next, _ := utf8.DecodeRuneInString(low[end:])
			if end == len(low) || !(unicode.IsLetter(next) || unicode.IsDigit(next) || next == '_') {
				return true
			}
			i = end
		}
	}
	return false
}
