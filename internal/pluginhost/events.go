// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 事件投递（docs/plugin-spec-v2.md 2.10、7.5）：
//   - 内核事件 -> 宿主 tap -> 订阅了该事件且被授予 events:subscribe 的运行中插件（plugin.event.deliver）；
//   - 插件 -> host.events.publish -> 校验清单 emits -> 事件总线（会再经 tap 分发给其它订阅者）。
// 事件名必须已在清单 events 里声明；未声明的发布会回 validation。

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

const eventDeliverTimeout = 5 * time.Second

// onKernelEvent 是事件总线 tap：把内核事件分发给订阅了它的外部插件。
// 不阻塞发布方：每个插件一个 goroutine，超时 5s；失败只记日志。
func (h *Host) onKernelEvent(ev plugin.Event) {
	if h == nil || ev.Type == "" {
		return
	}
	h.mu.Lock()
	procs := make([]*pluginProcess, 0, len(h.procs))
	for _, p := range h.procs {
		if p.isRunning() {
			procs = append(procs, p)
		}
	}
	h.mu.Unlock()
	for _, p := range procs {
		if !slices.Contains(p.manifest.Subscribes, ev.Type) || !p.hasGranted("events:subscribe") {
			continue
		}
		p := p
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), eventDeliverTimeout)
			defer cancel()
			params, err := json.Marshal(map[string]any{
				"event": map[string]any{
					"type":    ev.Type,
					"at":      ev.At.UTC().Format(time.RFC3339Nano),
					"payload": ev.Payload,
				},
			})
			if err != nil {
				return
			}
			if _, err := p.call(ctx, "plugin.event.deliver", params); err != nil {
				h.log.Warn("投递内核事件失败", "plugin", p.id, "event", ev.Type, "err", err)
			}
		}()
	}
}

// EventsPublish 是 broker 的 host.events.publish：只允许发布清单 emits 里声明过的事件。
func (p *pluginProcess) eventsPublish(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return nil, rpcErrorf("invalid_params", "事件参数不是合法 JSON：%v", err)
	}
	if in.Type == "" {
		return nil, rpcErrorf("validation", "事件 type 不能为空")
	}
	if !slices.Contains(p.manifest.Emits, in.Type) {
		return nil, rpcErrorf("validation", "事件 %s 没有在清单 emits 里声明", in.Type)
	}
	if p.host.opts.Events == nil {
		return nil, rpcErrorf("unavailable", "宿主未接事件总线")
	}
	var payload any
	if len(in.Payload) > 0 && string(in.Payload) != "null" {
		payload = in.Payload
	}
	if err := p.host.opts.Events.Publish(ctx, in.Type, payload); err != nil {
		return nil, rpcErrorf("internal", "发布事件失败：%v", err)
	}
	return map[string]any{"ok": true}, nil
}
