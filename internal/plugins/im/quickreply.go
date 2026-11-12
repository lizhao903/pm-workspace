// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

// 快捷回复（消息抽屉的「反馈」、列表行的快捷回复菜单）：存在 im_settings 的 quick_replies 里，
// 值是 JSON 数组；没设过用内置的四条。经 GET / PATCH /api/im/settings 的 quick_replies 读写，PATCH 整组替换。

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// quickReply 是一条快捷回复；Done 为真的发完同时把消息标为已处理。
type quickReply struct {
	Text string `json:"text"`
	Done bool   `json:"done"`
}

const (
	settingQuickReplies = "quick_replies"
	maxQuickReplies     = 20
	maxQuickReplyText   = 200
)

// defaultQuickReplies 是没设过时的内置几条（同原型 QUICK_REPLIES）。
var defaultQuickReplies = []quickReply{
	{Text: "收到，我看一下"},
	{Text: "稍后回复你"},
	{Text: "已处理，请查看", Done: true},
	{Text: "这个需求记下了，排期后同步你", Done: true},
}

func (in *inbox) quickReplies(ctx context.Context) ([]quickReply, error) {
	var v string
	err := in.c.Store().QueryRow(ctx, `SELECT value FROM im_settings WHERE key = ?`, settingQuickReplies).Scan(&v)
	if errors.Is(err, plugin.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
		return append([]quickReply(nil), defaultQuickReplies...), nil
	}
	if err != nil {
		return nil, err
	}
	var out []quickReply
	if json.Unmarshal([]byte(v), &out) != nil {
		return append([]quickReply(nil), defaultQuickReplies...), nil
	}
	if out == nil {
		out = []quickReply{}
	}
	return out, nil
}

// cleanQuickReplies 去掉首尾空白，空的、超长的、重复的、超过条数的回 400；空数组表示不要快捷回复。
func cleanQuickReplies(list []quickReply) ([]quickReply, error) {
	if len(list) > maxQuickReplies {
		return nil, apiErr(errValidation, "quick_replies 最多 %d 条", maxQuickReplies)
	}
	out := make([]quickReply, 0, len(list))
	seen := map[string]bool{}
	for i, q := range list {
		t := strings.TrimSpace(q.Text)
		switch {
		case t == "":
			return nil, apiErr(errValidation, "第 %d 条快捷回复是空的", i+1)
		case utf8.RuneCountInString(t) > maxQuickReplyText:
			return nil, apiErr(errValidation, "第 %d 条快捷回复超过 %d 字", i+1, maxQuickReplyText)
		case seen[t]:
			return nil, apiErr(errValidation, "快捷回复「%s」重复了", t)
		}
		seen[t] = true
		out = append(out, quickReply{Text: t, Done: q.Done})
	}
	return out, nil
}

func (in *inbox) saveQuickReplies(ctx context.Context, list []quickReply) error {
	old, err := in.quickReplies(ctx)
	if err != nil {
		return err
	}
	b, _ := json.Marshal(list)
	if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_settings (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		settingQuickReplies, string(b), in.clock().UTC().Format(timeLayout)); err != nil {
		return err
	}
	ob, _ := json.Marshal(old)
	if string(ob) != string(b) {
		in.c.Audit().Note(ctx, plugin.AuditNote{Action: "update", TargetType: "im_settings", TargetID: settingQuickReplies,
			Summary: "快捷回复改为 " + strconv.Itoa(len(list)) + " 条", Detail: map[string]any{"from": old, "to": list}}, plugin.WriteMeta{})
	}
	return nil
}
