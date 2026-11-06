// Package im 是「IM 消息」插件的后端（IM-01a 起）。清单 plugin.json 只有这一份，前端构建时也读它。
// 每个渠道一个适配器（拉取或回调，adapter.go），消息落在插件表 im_messages，按 IM 身份 id 认人、按会话 id 归档，
// 到达时发 im.message_received。接口契约见 docs/api-contract.md「IM 消息插件 im」。
// 真实渠道的适配器：Slack（IM-01b，slack.go）、Telegram（IM-01c）；另有测试和演练用的假适配器。
package im

import (
	"embed"
	"fmt"
	"io/fs"
	"strings"
	"sync"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

// EventReceived 是新消息落库后发的事件，payload 见 Received。
const EventReceived = "im.message_received"

// EventMuted 是发信人被自动忽略、入库即已忽略的消息（0.28.0，TSK-0491），不发 EventReceived，改发它。
const EventMuted = "im.message_muted"

// Plugin 是 IM 插件的入口，cmd/pmw 用 Registry.Add 登记。适配器在 New 时给定，启用后不再变。
type Plugin struct {
	m        plugin.Manifest
	adapters []Adapter
	// publicURL 是浏览器访问工作台的地址（--public-url），回执里的看板链接拼在它后面（AUTO-06）
	publicURL string
}

func New(adapters ...Adapter) *Plugin {
	return &Plugin{m: plugin.MustParse(manifestJSON), adapters: adapters}
}

// WithPublicURL 设浏览器访问工作台的地址（cmd/pmw 传 --public-url），IM 需求自动受理的回执里拼看板链接用（AUTO-06）。
func (p *Plugin) WithPublicURL(u string) *Plugin {
	p.publicURL = strings.TrimRight(strings.TrimSpace(u), "/")
	return p
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
	in := &inbox{c: r.Core(), adapters: p.adapters, pullMu: map[string]*sync.Mutex{}, publicURL: p.publicURL}
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
	emails := newEmailFiller(in)
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/im/messages", in.list)
		m.HandleFunc("GET /api/im/adapters", in.listAdapters)
		m.HandleFunc("POST /api/im/callbacks/{adapter}", in.callback)
		// 立即同步一个渠道（IM-01b，sync.go）
		m.HandleFunc("POST /api/im/connectors/{id}/sync", in.syncConnector)
		// 补全以前没解析出来的空正文，只改已有消息（refill.go）
		m.HandleFunc("POST /api/im/connectors/{id}/refill", in.refillConnector)
		// 补拉最近几天里有回复的串（0010，threads.go）
		m.HandleFunc("POST /api/im/connectors/{id}/backfill-threads", in.backfillThreads)
		// 列 Token 看得到的群组会话，给「监听频道」勾选（channels.go）
		m.HandleFunc("GET /api/im/connectors/{id}/conversations", in.listConversations)
		// 从渠道资料补联系人邮箱，只填空的（emails.go）
		m.HandleFunc("POST /api/im/connectors/{id}/backfill-emails", emails.handle)
		// 处理动作（IM-02a，actions.go）
		m.HandleFunc("GET /api/im/messages/{id}", in.getOne)
		for _, k := range []string{"done", "ignore", "reopen", "read"} {
			m.HandleFunc("POST /api/im/messages/{id}/"+k, in.setState(k))
		}
		m.HandleFunc("POST /api/im/messages/{id}/snooze", in.snooze)
		m.HandleFunc("POST /api/im/messages/{id}/reply", in.reply)
		m.HandleFunc("POST /api/im/messages/{id}/task", in.toTask)
		// 归到项目、清除归属（0006，project.go）
		m.HandleFunc("POST /api/im/messages/{id}/project", in.setProject)
		// 群组默认归属的项目（0007，convproject.go）
		m.HandleFunc("GET /api/im/conversation-projects", in.listConversationProjects)
		m.HandleFunc("PUT /api/im/conversation-projects/{conversation_id}", in.setConversationProject)
		// 群组管理：会话统计、批量设默认项目（0.15.0，convsummary.go）
		m.HandleFunc("GET /api/im/conversations/summary", in.conversationSummary)
		m.HandleFunc("PUT /api/im/conversation-projects", in.setConversationProjects)
		// 查询回填：只显示渠道编号的人名、群名回渠道查了补上（TSK-0494，names.go）
		m.HandleFunc("POST /api/im/conversations/refill-names", in.refillNamesBatch)
		m.HandleFunc("POST /api/im/conversations/{conversation_id}/refill-names", in.refillNamesOne)
		// 补全消息：回渠道拉单个会话的历史、补空正文，补进来的不当新消息（TSK-0724，history.go）
		m.HandleFunc("POST /api/im/conversations/{conversation_id}/backfill", in.backfillConversation)
		// 群组管理里主动发消息、发出的记录（0.17.0，outbox.go）
		m.HandleFunc("POST /api/im/send", in.send)
		m.HandleFunc("GET /api/im/conversations/{conversation_id}/sent", in.listSent)
		// @ 候选（0.18.0，members.go）：会话里发过言的人 + 联系人里在这个渠道有 IM 身份的人
		m.HandleFunc("GET /api/im/conversations/{conversation_id}/members", in.listMembers)
		// 自动忽略发信人（TSK-0495，mutes.go）
		m.HandleFunc("GET /api/im/mutes", in.listMutes)
		m.HandleFunc("GET /api/im/mutes/pending", in.mutePendingCount)
		m.HandleFunc("POST /api/im/mutes", in.createMute)
		m.HandleFunc("DELETE /api/im/mutes/{mute_id}", in.deleteMute)
		// 批量处理完、忽略（PR-03，actions.go）
		m.HandleFunc("POST /api/im/messages/batch", in.batch)
		// 附件获取（IM-04a，attachments.go）
		m.HandleFunc("POST /api/im/messages/{id}/attachments/{attachment_id}/fetch", in.fetch)
		m.HandleFunc("GET /api/im/attachments", in.attachmentsInfo)
		m.HandleFunc("GET /api/im/attachments/{channel}/{name}", in.download)
		// 过期天数（IM-07，expiry.go）
		m.HandleFunc("GET /api/im/settings", in.getSettings)
		m.HandleFunc("PATCH /api/im/settings", in.patchSettings)
		// 从消息发起的会话（0008，sessions.go）
		m.HandleFunc("POST /api/im/sessions", in.linkSession)
		// 消息转成的项目资料（0009，materials.go）
		m.HandleFunc("POST /api/im/materials", in.linkMaterial)
		m.HandleFunc("GET /api/im/materials", in.listMaterials)
		m.HandleFunc("DELETE /api/im/materials/{material_id}", in.unlinkMaterial)
	})
	// 会话里拆出来的任务：来源指向消息的记下来（0008）
	r.Subscribe("object.created", in.onObjectCreated)
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
	r.Job(plugin.Job{Name: "expire", Every: expireEvery, Run: in.expireJob})
	// 顺带补联系人邮箱：新身份、新发送人下一轮查到（emails.go）
	r.Job(plugin.Job{Name: "backfill_emails", Every: emailEvery, Run: emails.job})
	// 补登记之前没登记的会话，启用时跑一次（PR-02）
	r.Job(plugin.Job{Name: "register_conversations", Run: in.registerJob})
	r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "messages", Load: messagesImpact})
	// SOP 节点：发消息、等回复（SOP-02b，sopnodes.go）；登记时按 kind 补上节点声明（TSK-0490，sopspec.go）
	r = plugin.WithSOPSpecs(r, sopSpecs)
	in.registerSOPNodes(r)
	in.registerTaskReply(r)
	in.registerAskMe(r)      // 私信我确认（TSK-0411，askme.go）
	in.registerTaskAck(r)    // 回执需求方（TSK-0467，taskack.go）
	in.registerFDEForward(r) // FDE 反馈转发（TSK-0468，fdeforward.go）
	// IM 需求自动受理：转成任务、设置任务阶段两个节点和内置流程（AUTO-06，autointake.go）
	in.registerAutoIntake(r)
	return nil
}
