package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"slices"
	"time"
)

// 后端插件接口（CORE-04a），见 docs/plugin-api.md 2.0、2.1、2.10。
// 这一版只有路由、后台任务、事件订阅三个扩展点；设置分节、对象类型、连接器等随各自的任务加，
// 加的时候升插件 API 的小版本。

// Plugin 是第一方插件的后端入口，编译进二进制，用 Registry.Add 登记。
type Plugin interface {
	// Manifest 返回 embed 进来的 plugin.json 解析结果，见 MustParse。
	Manifest() Manifest
	// Migrations 返回迁移目录；没有自己的表返回 nil（CORE-05 应用）。
	Migrations() fs.FS
	// Register 在启用时调用，只登记，不做 IO、不起协程。每次启用都会重新调一次。
	Register(r Registrar) error
}

// DisableGuard 是可选接口：CanDisable 返回 false 时拒绝停用，reason 给用户看。
type DisableGuard interface {
	CanDisable(ctx context.Context, c Core) (ok bool, reason string)
}

// Registrar 是 Register 拿到的登记入口。登记的东西不对（路径不在 /api/<id>/ 下、
// 订阅了清单里没写的事件）时 Register 整体失败，插件不会被启用。
type Registrar interface {
	Core() Core
	Routes(fn func(m RouteRegistrar))
	Job(j Job)
	Subscribe(eventType string, h EventHandler)
}

// RouteRegistrar 和 internal/api 里的同名接口一致，*http.ServeMux 天然满足。
// pattern 必须带方法，路径以 /api/<插件 id>/ 开头，例 "GET /api/im/messages"。
type RouteRegistrar interface {
	HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request))
}

// Job 是后台任务，内核管启停：启用时起协程，停用时取消 ctx 并等它退出。
type Job struct {
	Name  string        // 本插件内唯一
	Every time.Duration // 定时跑，启用时先跑一次；0 表示常驻，Run 一直跑到 ctx 取消
	Run   func(ctx context.Context, c Core) error
}

// Core 是插件能用的内核能力。这一版只有身份、日志、事件发布，对象、设置、凭证等句柄随各自的任务加。
type Core interface {
	PluginID() string
	Log() *slog.Logger
	// Events 发布本插件的事件，类型必须在清单 emits 里（2.10）。
	Events() Publisher
}

// Publisher 往事件总线上发事件。payload 按 JSON 序列化；总线没接上时什么都不做。
type Publisher interface {
	Publish(ctx context.Context, eventType string, payload any) error
}

// ErrEventNotDeclared：插件发布了清单 emits 里没写的事件类型。
var ErrEventNotDeclared = errors.New("event type not declared in emits")

// Event 是事件总线上的一条事件（CORE-07a 发布）。
type Event struct {
	Type    string
	At      time.Time
	Payload json.RawMessage
}

type EventHandler func(ctx context.Context, c Core, e Event) error

type core struct {
	id    string
	log   *slog.Logger
	emits []string
	reg   *Registry // 发布时取 reg.Events，cmd/pmw 在 Start 之前接上
}

func (c *core) PluginID() string  { return c.id }
func (c *core) Log() *slog.Logger { return c.log }
func (c *core) Events() Publisher { return c }

func (c *core) Publish(ctx context.Context, eventType string, payload any) error {
	if !slices.Contains(c.emits, eventType) {
		return fmt.Errorf("%w: %s", ErrEventNotDeclared, eventType)
	}
	if c.reg == nil || c.reg.Events == nil {
		return nil
	}
	return c.reg.Events.Publish(ctx, eventType, payload)
}

// MustParse 解析 embed 进来的 plugin.json，不合法直接 panic：第一方插件的清单写错是编译期问题。
func MustParse(data []byte) Manifest {
	m, err := Parse(data)
	if err != nil {
		panic("plugin.json: " + err.Error())
	}
	return *m
}
