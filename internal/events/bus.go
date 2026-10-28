// Package events 是进程内的事件总线（CORE-07a，docs/plugin-api.md 2.10）。
//
// 发布方只管发：订阅者在各自的协程里异步执行，出错、panic、超时都只记日志，
// 不回传给发布方，也不影响别的订阅者。订阅者从插件注册表现取，停用的插件收不到。
// 内核事件由 Store（store.go）在写成功之后发，所以事务回滚时什么都不发。
package events

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 内核事件（第一版），和 plugin.KernelEvents 一致。
const (
	ObjectCreated       = "object.created"
	ObjectUpdated       = "object.updated"
	ObjectStatusChanged = "object.status_changed"
	TaskReviewRequested = "task.review_requested"
	RunFinished         = "run.finished"
)

// Source 给出某类事件当前的订阅者，*plugin.Registry 满足它。
type Source interface {
	Subscribers(eventType string) []plugin.Subscriber
}

// Bus 是事件总线。零值不能用，用 New。
type Bus struct {
	src Source
	log *slog.Logger

	// Timeout 是单个订阅者处理一条事件的上限，默认 30 秒；到点取消它的 ctx。
	Timeout time.Duration

	wg sync.WaitGroup

	// taps 是内核内部的订阅者（事件流、通知），见 Tap。
	tapMu sync.RWMutex
	taps  map[int]func(plugin.Event)
	tapN  int
}

func New(src Source, log *slog.Logger) *Bus {
	if log == nil {
		log = slog.Default()
	}
	return &Bus{src: src, log: log.With("component", "events")}
}

func (b *Bus) timeout() time.Duration {
	if b.Timeout > 0 {
		return b.Timeout
	}
	return 30 * time.Second
}

// Publish 发一条事件，立刻返回。只有 payload 序列化失败时返回错误。
// 订阅者拿到的 ctx 和发布方的无关：请求结束了处理照样跑完。
func (b *Bus) Publish(_ context.Context, eventType string, payload any) error {
	if b == nil {
		return nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("event %s: %w", eventType, err)
	}
	ev := plugin.Event{Type: eventType, At: time.Now().UTC(), Payload: raw}
	b.tap(ev)
	if b.src == nil {
		return nil
	}
	for _, s := range b.src.Subscribers(eventType) {
		b.wg.Add(1)
		go b.deliver(s, ev)
	}
	return nil
}

// Tap 给内核内部登记一个订阅者，收所有类型的事件，返回取消函数。
// 和插件订阅者不同：fn 在 Publish 里同步调用、按发布顺序，所以必须很快、不能阻塞，
// 要做重活自己起协程。不经过插件注册表，插件启停不影响它。
func (b *Bus) Tap(fn func(plugin.Event)) (cancel func()) {
	b.tapMu.Lock()
	defer b.tapMu.Unlock()
	if b.taps == nil {
		b.taps = map[int]func(plugin.Event){}
	}
	b.tapN++
	id := b.tapN
	b.taps[id] = fn
	return func() {
		b.tapMu.Lock()
		defer b.tapMu.Unlock()
		delete(b.taps, id)
	}
}

func (b *Bus) tap(ev plugin.Event) {
	b.tapMu.RLock()
	defer b.tapMu.RUnlock()
	for _, fn := range b.taps {
		b.safeTap(fn, ev)
	}
}

func (b *Bus) safeTap(fn func(plugin.Event), ev plugin.Event) {
	defer func() {
		if v := recover(); v != nil {
			b.log.Error("event tap panic", "type", ev.Type, "panic", v, "stack", string(debug.Stack()))
		}
	}()
	fn(ev)
}

func (b *Bus) deliver(s plugin.Subscriber, ev plugin.Event) {
	defer b.wg.Done()
	defer func() {
		if v := recover(); v != nil {
			b.log.Error("event subscriber panic", "plugin", s.Plugin, "type", ev.Type, "panic", v, "stack", string(debug.Stack()))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), b.timeout())
	defer cancel()
	if err := s.Handle(ctx, ev); err != nil {
		b.log.Warn("event subscriber failed", "plugin", s.Plugin, "type", ev.Type, "err", err)
	}
}

// Wait 等在途的订阅者处理完，最多等 timeout；等到了返回 true。进程退出和测试用。
func (b *Bus) Wait(timeout time.Duration) bool {
	if b == nil {
		return true
	}
	done := make(chan struct{})
	go func() {
		b.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		b.log.Warn("event subscribers did not finish in time", "timeout", timeout)
		return false
	}
}
