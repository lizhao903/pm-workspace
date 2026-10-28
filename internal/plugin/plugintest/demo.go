// Package plugintest 是只给测试用的示例插件，不编译进 cmd/pmw。迁移在 migrations/ 下，表前缀 demo_。
// 它按第一方插件的写法来：清单 embed 进来、Register 里只登记、后台活动交给 Job。
package plugintest

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Demo 的计数器给测试断言：Resident 是常驻任务协程还活着几个，Ticks 是定时任务跑了几次。
type Demo struct {
	m     plugin.Manifest
	every time.Duration
	migs  fs.FS

	Resident atomic.Int64
	Ticks    atomic.Int64
	Events   atomic.Int64
	Starts   atomic.Int64 // 常驻任务被起过几次，重新启用后应该加一
}

// NewDemo 的定时任务间隔是 every；测试里给几毫秒。
func NewDemo(every time.Duration) *Demo {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		panic(err)
	}
	return &Demo{m: plugin.MustParse(manifestJSON), every: every, migs: sub}
}

func (d *Demo) Manifest() plugin.Manifest { return d.m }
func (d *Demo) Migrations() fs.FS         { return d.migs }

// WithMigrations 换掉迁移目录，测试用来模拟「已应用的迁移文件被改过」。
func (d *Demo) WithMigrations(fsys fs.FS) *Demo {
	d.migs = fsys
	return d
}

func (d *Demo) Register(r plugin.Registrar) error {
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/demo/ping", d.ping)
		m.HandleFunc("GET /api/demo/items/{id}", d.item)
	})
	r.Job(plugin.Job{Name: "tick", Every: d.every, Run: func(context.Context, plugin.Core) error {
		d.Ticks.Add(1)
		return nil
	}})
	r.Job(plugin.Job{Name: "resident", Run: func(ctx context.Context, _ plugin.Core) error {
		d.Starts.Add(1)
		d.Resident.Add(1)
		defer d.Resident.Add(-1)
		<-ctx.Done()
		return nil
	}})
	r.Subscribe("object.created", func(context.Context, plugin.Core, plugin.Event) error {
		d.Events.Add(1)
		return nil
	})
	r.TodayCard(plugin.TodayCardDef{Key: "demo_inbox", Title: "示例收件箱", Order: 50, Load: d.inbox})
	r.Connector(EchoConnector())
	return nil
}

// EchoTool 是示例插件登记的连接器。
const EchoTool = "demo_echo"

// EchoConnector 不联网：Token 认证，token 里含 invalid 时测试失败，账号名取配置里的 account。
func EchoConnector() plugin.ConnectorDef {
	return plugin.ConnectorDef{
		Tool: EchoTool, Label: "示例连接器", Category: "other", Color: "#0ea5e9",
		Desc: "示例插件登记的连接器，只给测试用", Auth: []connector.AuthMode{connector.AuthToken},
		Fields: []connector.Field{
			{Key: "account", Label: "账号名", Kind: "text", Required: true},
			{Key: "token", Label: "Token", Kind: "secret", Required: true},
		},
		Tools: []connector.ToolDef{{Name: "echo", Desc: "原样返回"}, {Name: "post", Desc: "发一条", Write: true}},
		Test: func(_ context.Context, cfg connector.Config) (string, error) {
			if strings.Contains(cfg.Secret("token"), "invalid") {
				return "", errors.New("token 无效")
			}
			return cfg.Get("account"), nil
		},
	}
}

// DemoCardItem 是示例卡片里的一条。
type DemoCardItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// inbox 给今日聚合一张卡片：总数 3，带前 2 条。
func (d *Demo) inbox(context.Context, plugin.Core) (*plugin.TodayCardData, error) {
	return &plugin.TodayCardData{Total: 3, Items: []DemoCardItem{
		{ID: "d1", Title: "示例一"}, {ID: "d2", Title: "示例二"},
	}}, nil
}

func (d *Demo) ping(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{"data": map[string]any{"pong": true, "ticks": d.Ticks.Load()}})
}

func (d *Demo) item(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"data": map[string]any{"id": r.PathValue("id")}})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}
