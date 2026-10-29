package plugin

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// 发通知句柄（VID-06b），见 docs/plugin-api.md 2.0。
// 实现是 internal/notify 的 Center，cmd/pmw 用 SetNotifier 接上；没接上时回 ErrNoNotifier。

// 通知级别，和 internal/notify 一致。
const (
	NotifyInfo    = "info"
	NotifySuccess = "success"
	NotifyError   = "error"
)

// Notification 是插件发的一条通知。Kind 不带插件前缀也行，内核统一补成「<插件 id>.<kind>」；
// Level 为空记 info；Data 里的 source 键由内核写成插件 id，插件给的会被覆盖。
type Notification struct {
	Kind     string
	Level    string
	Title    string
	Body     string
	ObjectID string
	Data     map[string]any
}

// Notifier 落通知并推进事件流，n.Kind 已带前缀、n.Data["source"] 已是插件 id。
type Notifier interface {
	NotifyFromPlugin(ctx context.Context, n Notification) error
}

var (
	// ErrNoNotifier：注册表没接上通知中心（测试里没接时）。
	ErrNoNotifier = errors.New("通知中心还没接上")
	// ErrNotifyInactive：插件没在跑（停用了或还没启用），不能发通知。
	ErrNotifyInactive = errors.New("插件没在跑，不能发通知")
)

// notifyKindRe 是去掉插件前缀后的 kind：小写字母开头，点分段。
var notifyKindRe = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`)

type notifierBox struct{ n Notifier }

// SetNotifier 接上通知中心，可以在 Start 之后调（用时现取）。
func (r *Registry) SetNotifier(n Notifier) { r.notifier.Store(&notifierBox{n}) }

// Notify 以本插件的名义发一条通知：kind 补插件前缀、来源记插件 id；插件没在跑时回 ErrNotifyInactive。
func (c *core) Notify(ctx context.Context, n Notification) error {
	kind, err := c.notifyKind(n.Kind)
	if err != nil {
		return err
	}
	if strings.TrimSpace(n.Title) == "" {
		return errors.New("通知标题不能为空")
	}
	switch n.Level {
	case "":
		n.Level = NotifyInfo
	case NotifyInfo, NotifySuccess, NotifyError:
	default:
		return fmt.Errorf("通知级别不合法：%s", n.Level)
	}
	if c.reg == nil {
		return ErrNoNotifier
	}
	if e := c.reg.entries[c.id]; e == nil || e.active.Load() == nil {
		return fmt.Errorf("%w：%s", ErrNotifyInactive, c.id)
	}
	b := c.reg.notifier.Load()
	if b == nil || b.n == nil {
		return ErrNoNotifier
	}
	data := make(map[string]any, len(n.Data)+1)
	for k, v := range n.Data {
		data[k] = v
	}
	data["source"] = c.id
	n.Kind, n.Data = kind, data
	return b.n.NotifyFromPlugin(ctx, n)
}

// notifyKind 补插件前缀；插件 id 撞上内核事件的命名空间时拒绝，免得冒充内核的通知。
func (c *core) notifyKind(kind string) (string, error) {
	kind = strings.TrimPrefix(strings.TrimSpace(kind), c.id+".")
	if !notifyKindRe.MatchString(kind) {
		return "", fmt.Errorf("通知 kind 不合法：%q", kind)
	}
	if slices.Contains(kernelEventNamespaces, c.id) || slices.Contains(ReservedIDs, c.id) {
		return "", fmt.Errorf("插件 %s 的 id 是内核命名空间，不能发通知", c.id)
	}
	full := c.id + "." + kind
	if slices.Contains(KernelEvents, full) {
		return "", fmt.Errorf("通知 kind %s 是内核的", full)
	}
	return full, nil
}
