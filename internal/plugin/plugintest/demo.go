// Package plugintest 是只给测试用的示例插件，不编译进 cmd/pmw。
// 它按第一方插件的写法来：清单 embed 进来、Register 里只登记、后台活动交给 Job。
package plugintest

import (
	"context"
	_ "embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

// Demo 的计数器给测试断言：Resident 是常驻任务协程还活着几个，Ticks 是定时任务跑了几次。
type Demo struct {
	m     plugin.Manifest
	every time.Duration

	Resident atomic.Int64
	Ticks    atomic.Int64
	Events   atomic.Int64
	Starts   atomic.Int64 // 常驻任务被起过几次，重新启用后应该加一
}

// NewDemo 的定时任务间隔是 every；测试里给几毫秒。
func NewDemo(every time.Duration) *Demo {
	return &Demo{m: plugin.MustParse(manifestJSON), every: every}
}

func (d *Demo) Manifest() plugin.Manifest { return d.m }
func (d *Demo) Migrations() fs.FS         { return nil }

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
	return nil
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
