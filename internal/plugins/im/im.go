// Package im 是「IM 消息」插件的后端（IM-01a 起）。清单 plugin.json 只有这一份，前端构建时也读它。
// 每个渠道一个适配器（拉取或回调，adapter.go），消息落在插件表 im_messages，按 IM 身份 id 认人、按会话 id 归档，
// 到达时发 im.message_received。接口契约见 docs/api-contract.md「IM 消息插件 im」。
// 真实渠道的适配器：Slack（IM-01b，slack.go）、Telegram（IM-01c）；另有测试和演练用的假适配器。
package im

import (
	"embed"
	"fmt"
	"io/fs"
	"sync"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

// EventReceived 是新消息落库后发的事件，payload 见 Received。
const EventReceived = "im.message_received"

// Plugin 是 IM 插件的入口，cmd/pmw 用 Registry.Add 登记。适配器在 New 时给定，启用后不再变。
type Plugin struct {
	m        plugin.Manifest
	adapters []Adapter
}

func New(adapters ...Adapter) *Plugin {
	return &Plugin{m: plugin.MustParse(manifestJSON), adapters: adapters}
}

func (p *Plugin) Manifest() plugin.Manifest { return p.m }

// Migrations 是 migrations/ 下的 .sql，安装时由内核按文件名顺序应用（CORE-05）。
func (p *Plugin) Migrations() fs.FS {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

func (p *Plugin) Register(r plugin.Registrar) error {
	seen := map[string]bool{}
	for _, a := range p.adapters {
		k := a.Key()
		if !keyRe.MatchString(k) {
			return fmt.Errorf("适配器 key %q 只能是小写字母、数字、下划线", k)
		}
		if seen[k] {
			return fmt.Errorf("适配器 %s 登记了两次", k)
		}
		seen[k] = true
	}
	in := &inbox{c: r.Core(), adapters: p.adapters, pullMu: map[string]*sync.Mutex{}}
	for _, a := range p.adapters {
		in.pullMu[a.Key()] = &sync.Mutex{}
		// 真实渠道（IM-01b 起）：交插件句柄，登记自带的连接器定义
		if b, ok := a.(Binder); ok {
			b.Bind(r.Core())
		}
		if cp, ok := a.(ConnectorProvider); ok {
			r.Connector(cp.ConnectorDef())
		}
	}
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/im/messages", in.list)
		m.HandleFunc("GET /api/im/adapters", in.listAdapters)
		m.HandleFunc("POST /api/im/callbacks/{adapter}", in.callback)
		// 立即同步一个渠道（IM-01b，sync.go）
		m.HandleFunc("POST /api/im/connectors/{id}/sync", in.syncConnector)
		// 处理动作（IM-02a，actions.go）
		m.HandleFunc("GET /api/im/messages/{id}", in.getOne)
		for _, k := range []string{"done", "ignore", "reopen", "read"} {
			m.HandleFunc("POST /api/im/messages/{id}/"+k, in.setState(k))
		}
		m.HandleFunc("POST /api/im/messages/{id}/snooze", in.snooze)
		m.HandleFunc("POST /api/im/messages/{id}/reply", in.reply)
		m.HandleFunc("POST /api/im/messages/{id}/task", in.toTask)
		// 批量处理完、忽略（PR-03，actions.go）
		m.HandleFunc("POST /api/im/messages/batch", in.batch)
		// 附件获取（IM-04a，attachments.go）
		m.HandleFunc("POST /api/im/messages/{id}/attachments/{attachment_id}/fetch", in.fetch)
		m.HandleFunc("GET /api/im/attachments", in.attachmentsInfo)
		m.HandleFunc("GET /api/im/attachments/{channel}/{name}", in.download)
	})
	for _, a := range p.adapters {
		if pl, ok := a.(Puller); ok {
			every := pl.Interval()
			if every <= 0 {
				every = defaultPullEvery
			}
			r.Job(plugin.Job{Name: "pull_" + a.Key(), Every: every, Run: in.pullJob(pl)})
		}
	}
	r.Job(plugin.Job{Name: "snooze_wake", Every: snoozeEvery, Run: in.wakeJob})
	// 补登记之前没登记的会话，启用时跑一次（PR-02）
	r.Job(plugin.Job{Name: "register_conversations", Run: in.registerJob})
	r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "messages", Load: messagesImpact})
	// SOP 节点：发消息、等回复（SOP-02b，sopnodes.go）
	in.registerSOPNodes(r)
	return nil
}
