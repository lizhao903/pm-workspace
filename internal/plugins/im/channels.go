package im

// 列会话给「监听频道」选：连接器配置里这一项原来是逗号分隔的文本框，群组一多就记不住编号和名字。
// 这里按连接器实例的 Token 列出它看得到的群组会话（频道、私有频道、多人私信），界面勾选后仍存回同一个字段（逗号分隔的编号）。
// 只读，不改进度、不记同步结果。暂停、断开的不列（内核按实例取配置时就拒绝这两种），界面退回文本框。

import (
	"context"
	"errors"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// ConversationLister 能列出一个连接器实例的 Token 看得到的群组会话；私信不在里面（私信本来就全收）。
type ConversationLister interface {
	Adapter
	ListConversations(ctx context.Context, connectorID string) (ConversationList, error)
}

// 会话种类：公开频道、私有频道、多人私信。
const (
	ConvPublic  = "public"
	ConvPrivate = "private"
	ConvMPIM    = "mpim"
)

// ConversationOption 是可选的一个会话。Name 是渠道里的名字（频道不带 #；多人私信是渠道给的 mpdm-… 名字）。
type ConversationOption struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	IsMember   bool   `json:"is_member"`
	IsArchived bool   `json:"is_archived"`
}

// ConversationList 是 GET /api/im/connectors/{id}/conversations 的结果。Complete 为 false 时只列了一部分，Note 写原因。
type ConversationList struct {
	ConnectorID string               `json:"connector_id"`
	Items       []ConversationOption `json:"items"`
	Complete    bool                 `json:"complete"`
	Note        string               `json:"note"`
}

// errNoToken：连接器还没填 Token，列不了。
var errNoToken = errors.New("no token")

func (in *inbox) listerFor(tool string) ConversationLister {
	for _, a := range in.adapters {
		if l, ok := a.(ConversationLister); ok && a.Key() == tool {
			return l
		}
	}
	return nil
}

// listConversations：连接器不在 404；渠道不支持、已暂停、已断开、没填 Token 409（带 reason）；渠道出错 502 list_failed。
func (in *inbox) listConversations(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	cn, err := in.c.Connectors().Get(ctx, id)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		fail(w, r, in.c, apiErr(errNotFound, "connector %s not found", id))
		return
	case err != nil:
		fail(w, r, in.c, err)
		return
	}
	l := in.listerFor(cn.Tool)
	switch {
	case l == nil:
		fail(w, r, in.c, blocked("unsupported", "连接器「"+cn.Name+"」不能列出会话"))
		return
	case cn.Status == "paused":
		fail(w, r, in.c, blocked("connector_paused", "连接器「"+cn.Name+"」已暂停，启用后才能列出频道"))
		return
	case cn.Status == "disconnected":
		fail(w, r, in.c, blocked("connector_disconnected", "连接器「"+cn.Name+"」已断开"))
		return
	}
	res, err := l.ListConversations(ctx, id)
	switch {
	case errors.Is(err, errNoToken):
		fail(w, r, in.c, blocked("no_token", "连接器「"+cn.Name+"」还没填 Token"))
		return
	case errors.Is(err, plugin.ErrNoRows):
		fail(w, r, in.c, apiErr(errNotFound, "connector %s not found", id))
		return
	case err != nil:
		in.c.Log().Warn("im list conversations failed", "connector", id, "adapter", l.Key(), "err", err)
		fail(w, r, in.c, &actionError{status: http.StatusBadGateway, code: "list_failed", msg: "列会话失败：" + err.Error()})
		return
	}
	if res.Items == nil {
		res.Items = []ConversationOption{}
	}
	res.ConnectorID = id
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}
