package im

import (
	"errors"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 立即同步一个渠道（IM-01b）：IM 页「渠道配置」里点「立即同步」。不等同步间隔，马上按连接器拉一次，
// 和后台定时拉共用进度、不同时跑。结果记到连接器上（同步时间、失败时置为异常），口径同后台拉。

// SyncResult 是 POST /api/im/connectors/{id}/sync 的结果。
type SyncResult struct {
	ConnectorID string   `json:"connector_id"`
	Adapter     string   `json:"adapter"`
	IDs         []string `json:"ids"`
	Duplicates  int      `json:"duplicates"`
}

// pullerFor 找同步这个连接器的拉取型适配器：key 和连接器 tool 同名的。
func (in *inbox) pullerFor(tool string) Puller {
	for _, a := range in.adapters {
		if p, ok := a.(Puller); ok && a.Key() == tool {
			return p
		}
	}
	return nil
}

// syncConnector：连接器不在 404；不是能同步的渠道、暂停、断开 409（带 reason）；渠道出错 502 sync_failed，连接器已置为异常。
func (in *inbox) syncConnector(w http.ResponseWriter, r *http.Request) {
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
	p := in.pullerFor(cn.Tool)
	switch {
	case p == nil:
		fail(w, r, in.c, blocked("unsupported", "连接器「"+cn.Name+"」不是能同步的 IM 渠道"))
		return
	case cn.Status == "paused":
		fail(w, r, in.c, blocked("connector_paused", "连接器「"+cn.Name+"」已暂停"))
		return
	case cn.Status == "disconnected":
		fail(w, r, in.c, blocked("connector_disconnected", "连接器「"+cn.Name+"」已断开"))
		return
	}
	res, err := in.pullOnce(ctx, p, id)
	if err != nil {
		in.c.Log().Warn("im sync failed", "connector", id, "adapter", p.Key(), "err", err)
		// 适配器的错误前面有 pull <key>: 前缀，给人看的去掉
		msg := errors.Unwrap(err)
		if msg == nil {
			msg = err
		}
		fail(w, r, in.c, &actionError{status: http.StatusBadGateway, code: "sync_failed", msg: "同步失败：" + msg.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": SyncResult{ConnectorID: id, Adapter: p.Key(), IDs: res.IDs, Duplicates: res.Duplicates}})
}
