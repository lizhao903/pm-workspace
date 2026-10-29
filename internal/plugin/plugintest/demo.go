// Package plugintest 是只给测试用的示例插件，不编译进 cmd/pmw。迁移在 migrations/ 下，表前缀 demo_。
// 它按第一方插件的写法来：清单 embed 进来、Register 里只登记、后台活动交给 Job。
package plugintest

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"sync"
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

	core    atomic.Value // plugin.Core，Register 时存下，Resume 用
	Waiting atomic.Value // plugin.SOPNodeInput，最近一次挂起的节点
	Actions atomic.Int64 // 定时任务动作 demo_note 执行了几次

	// Finished 是收到 run.finished 后按运行 id 查回来的 plugin.RunInfo（VID-03a），只记本插件发起的
	Finished sync.Map
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
	r.Subscribe(plugin.RunFinishedEvent, d.runFinished)
	r.TodayCard(plugin.TodayCardDef{Key: "demo_inbox", Title: "示例收件箱", Order: 50, Load: d.inbox})
	r.Connector(EchoConnector())
	r.Skill(plugin.SkillDef{ID: SkillID, Name: "示例摘要", Desc: "把示例收件箱整理成三条要点",
		When: "用户要看示例收件箱的摘要时", Instructions: "每条要点一句话，先写最紧急的。", Tools: []string{"示例回声"}})
	d.core.Store(r.Core())
	r.SOPNode(plugin.SOPNodeDef{Kind: SOPNodeKind, Group: "示例", Required: []plugin.SOPNodeField{{Key: "to", Label: "发给"}}, Run: d.waitReply})
	r.ScheduleAction(plugin.ScheduleActionDef{Kind: ScheduleActionKind, Validate: validateNote, Run: d.runNote})
	return nil
}

// ScheduleActionKind 是示例插件登记的定时任务动作：参数 text 必填，执行时把它写进执行记录；text 为 fail 时执行失败。
const ScheduleActionKind = "demo_note"

func validateNote(_ context.Context, _ plugin.Core, params map[string]any) (map[string]any, error) {
	text, _ := params["text"].(string)
	if text = strings.TrimSpace(text); text == "" {
		return nil, errors.New("text 必填")
	}
	return map[string]any{"text": text}, nil
}

func (d *Demo) runNote(_ context.Context, _ plugin.Core, in plugin.ScheduleActionInput) (*plugin.ScheduleActionResult, error) {
	d.Actions.Add(1)
	text, _ := in.Params["text"].(string)
	if text == "fail" {
		return nil, errors.New("示例动作按要求失败")
	}
	return &plugin.ScheduleActionResult{Text: fmt.Sprintf("示例动作「%s」：%s", in.ScheduleName, text)}, nil
}

// SOPNodeKind 是示例插件登记的 SOP 节点：配置 mode 为 wait 时挂起，等 Resume；否则把输入和 to 原样回。
const SOPNodeKind = "demo_wait_reply"

func (d *Demo) waitReply(_ context.Context, _ plugin.Core, in plugin.SOPNodeInput) (map[string]any, error) {
	if in.Config["mode"] == "wait" {
		d.Waiting.Store(in)
		return nil, fmt.Errorf("等 %s 回复：%w", in.Config["to"], plugin.ErrWaiting)
	}
	return map[string]any{"to": in.Config["to"], "input": in.Input}, nil
}

// Resume 以示例插件的身份唤醒挂起的步骤。
func (d *Demo) Resume(ctx context.Context, runID, step string, output map[string]any) error {
	c, ok := d.core.Load().(plugin.Core)
	if !ok {
		return errors.New("示例插件还没登记")
	}
	return c.SOP().Resume(ctx, runID, step, output)
}

// Runs 以示例插件的身份发起运行（VID-03a）。
func (d *Demo) Runs() (plugin.RunService, error) {
	c, ok := d.core.Load().(plugin.Core)
	if !ok {
		return nil, errors.New("示例插件还没登记")
	}
	return c.Runs(), nil
}

// runFinished 按运行 id 查回结果记进 Finished；内核任务执行的 run.finished 查不到，跳过。
func (d *Demo) runFinished(_ context.Context, c plugin.Core, e plugin.Event) error {
	var p struct {
		RunID string `json:"run_id"`
	}
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return err
	}
	info, err := c.Runs().Get(p.RunID)
	if errors.Is(err, plugin.ErrRunNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	d.Finished.Store(p.RunID, info)
	return nil
}

// Notify 以示例插件的身份发一条通知（VID-06b）。
func (d *Demo) Notify(ctx context.Context, n plugin.Notification) error {
	c, ok := d.core.Load().(plugin.Core)
	if !ok {
		return errors.New("示例插件还没登记")
	}
	return c.Notify(ctx, n)
}

// SkillID 是示例插件登记的技能。
const SkillID = "sk_demo_digest"

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
