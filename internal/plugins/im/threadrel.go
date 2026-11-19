// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 串相关（0.32.0）：消息列（串）里的回复，父消息和我相关时记「串相关」，SOP 的 IM 过滤可以选「相关串里的回复按 @我 算」，
// 别人在我关心的串里的回复不 @我 也能自动分诊。不改 relevance（那是这一条本身「与我相关」的显示口径）。
//
// 父消息「和我相关」按 IM 插件自己知道的认，先到先得：
//   - mine：我发起的串（父消息是我发的，适配器给的 ThreadParentMine，或库里记成了我的回复）；
//   - mention：父消息 @我（relevance = me）；
//   - dm：父消息是私信（relevance = dm 或会话是私聊）；
//   - task：父消息转过任务（im_messages.task_id，或 im_message_tasks 里有）。
// 「父消息被这条流程分诊过」IM 插件不知道（执行在 SOP 插件里），由 SOP 按 thread_parent_message_id 自己查，口径见 sop/imfilter.go。
// 不是串里回复、父消息不在库里又不是我发起的，都不算。自己的消息不落成消息、被自动忽略的不发 im.message_received，照旧不触发。

const (
	ThreadRelMine    = "mine"
	ThreadRelMention = "mention"
	ThreadRelDM      = "dm"
	ThreadRelTask    = "task"
)

// threadRel 是一条串里回复和它的串：reason 空表示不相关；parentID 是父消息在库里的 id，不在为空串。
type threadRel struct {
	reason   string
	parentID string
}

// threadRelOf 认一条串里回复的串和我相不相关。parentExt 为空（不是串里回复）时回空。
// mine 是已经知道父消息是我发的（适配器给了 ThreadParentMine，或 prepare 已查过）。
func (in *inbox) threadRelOf(ctx context.Context, ch, connID, parentExt string, mine bool) (threadRel, error) {
	var out threadRel
	if parentExt == "" {
		return out, nil
	}
	var (
		id, rel, kind string
		task          *string
	)
	err := in.c.Store().QueryRow(ctx, `SELECT id, relevance, conversation_kind, task_id FROM im_messages
		WHERE channel = ? AND external_id = ? LIMIT 1`, ch, parentExt).Scan(&id, &rel, &kind, &task)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
	case err != nil:
		return out, err
	default:
		out.parentID = id
	}
	if !mine {
		if mine, err = in.parentIsMine(ctx, ch, connID, parentExt); err != nil {
			return out, err
		}
	}
	switch {
	case mine:
		out.reason = ThreadRelMine
	case out.parentID == "":
	case rel == "me":
		out.reason = ThreadRelMention
	case rel == "dm" || kind == "direct":
		out.reason = ThreadRelDM
	case task != nil && *task != "":
		out.reason = ThreadRelTask
	default:
		var x int
		err := in.c.Store().QueryRow(ctx, `SELECT 1 FROM im_message_tasks WHERE message_id = ? LIMIT 1`, out.parentID).Scan(&x)
		switch {
		case errors.Is(err, plugin.ErrNoRows):
		case err != nil:
			return out, err
		default:
			out.reason = ThreadRelTask
		}
	}
	return out, nil
}

// threadRelFor 是读出来的一条消息的串相关（im_get_message 用）；不是串里回复的回空。
func (in *inbox) threadRelFor(ctx context.Context, m Message) (threadRel, error) {
	if m.Thread == nil {
		return threadRel{}, nil
	}
	return in.threadRelOf(ctx, m.Channel, m.ConnectorID, m.Thread.ParentExternalID, false)
}

// out 是 im_get_message 输出里的三项：thread_related、thread_reason、thread_parent_message_id（父消息不在库里为 nil）。
func (t threadRel) out() map[string]any {
	var pid any
	if t.parentID != "" {
		pid = t.parentID
	}
	return map[string]any{"thread_related": t.reason != "", "thread_reason": t.reason, "thread_parent_message_id": pid}
}

// strOrNil 空串为 nil，事件里的可空字段用。
func strOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
