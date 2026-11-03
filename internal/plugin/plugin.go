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
	"sync/atomic"
	"time"
)

// 后端插件接口（CORE-04a），见 docs/plugin-api.md 2.0、2.1、2.10。
// 这一版有路由、后台任务、事件订阅、今日卡片、连接器、技能、SOP 节点七个扩展点；设置分节、对象类型等随各自的任务加，
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

// Installer 是可选接口：安装时迁移跑完后调一次，做表以外的初始化（4.1）。
type Installer interface {
	OnInstall(ctx context.Context, c Core) error
}

// Uninstaller 是可选接口：卸载时调，deleteData 为 true 时插件前缀的表已经备份、马上要删（4.4）。
// 出错整次卸载失败，表和状态都不动。
type Uninstaller interface {
	OnUninstall(ctx context.Context, c Core, deleteData bool) error
}

// Registrar 是 Register 拿到的登记入口。登记的东西不对（路径不在 /api/<id>/ 下、
// 订阅了清单里没写的事件）时 Register 整体失败，插件不会被启用。
type Registrar interface {
	Core() Core
	Routes(fn func(m RouteRegistrar))
	Job(j Job)
	Subscribe(eventType string, h EventHandler)
	// TodayCard 登记一张今日卡片，Key 必须在清单 provides.today_cards 里（2.8）。
	TodayCard(c TodayCardDef)
	// Connector 登记一个连接器定义，Tool 必须在清单 provides.connectors 里（2.5，CONN-02）。
	Connector(d ConnectorDef)
	// ConnectorImpact 登记一项删除连接器前的影响检查，Key 本插件内唯一（CONN-03，impact.go）。
	ConnectorImpact(d ConnectorImpactDef)
	// Skill 登记一个技能，ID 必须在清单 provides.skills 里、以 sk_ 开头（2.6，AG-01b2，skill.go）。
	Skill(s SkillDef)
	// SOPNode 登记一个 SOP 节点类型，Kind 必须在清单 provides.sop_nodes 里、以 <id>_ 开头（2.7，SOP-03a，sopnode.go）。
	SOPNode(n SOPNodeDef)
	// SOPEngine 只给 SOP 编排插件用：登记唤醒挂起步骤的入口（SOP-03a）。
	SOPEngine(e SOPEngine)
	// SOPStarter 登记「发起 SOP」的入口，只有 provides.modules 含 sop 的插件能登记，同一时间只有一个（SOP-01d，soplaunch.go）。
	SOPStarter(st SOPStarter)
	// HostHandler 登记按 Host 分发的处理器，要声明 network:localhost，每个插件最多一个（DOM-02a，host.go）。
	HostHandler(d HostHandlerDef)
	// ScheduleAction 登记一种定时任务动作，Kind 必须在清单 provides.schedule_actions 里、以 <id>_ 开头（2.12，VID-06a，scheduleaction.go）。
	ScheduleAction(d ScheduleActionDef)
	// ProjectPrototypes 登记「列出项目原型目录」的入口，只有 provides.modules 含 projects 的插件能登记（projectprotos.go）。
	ProjectPrototypes(fn ProjectPrototypeLister)
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

// Core 是插件能用的内核能力。这一版有身份、日志、事件发布、本插件的表和对象、联系人、会话的只读查询（store.go），
// 设置、凭证等句柄随各自的任务加。
type Core interface {
	PluginID() string
	Log() *slog.Logger
	// Events 发布本插件的事件，类型必须在清单 emits 里（2.10）。
	Events() Publisher
	// Store 读写本插件 table_prefix 开头的表（PJ-01b 起）。
	Store() Store
	// Objects、Contacts、Conversations 只读查内核对象、联系人和 IM 会话，写要走内核接口。
	Objects() ObjectReader
	Contacts() ContactReader
	Conversations() ConversationReader
	// ConversationWriter 收消息时登记还没登记的会话，只建不改（PR-02，conversations_write.go）。
	ConversationWriter() ConversationWriter
	// Identities 只读查 IM 身份（IM-01a，identities.go）。
	Identities() IdentityReader
	// ObjectWriter 建内核对象，只能建、来源记为本插件（IM-02a，objects_write.go）。
	ObjectWriter() ObjectWriter
	// ContactWriter 建联系人、按 id 合并字段，带操作者、幂等键，记审计（SOP-02a，writes.go）。
	ContactWriter() ContactWriter
	// Connectors 只读查连接器实例（IM-02a，connectors_read.go）；With 拿本插件登记的实例的配置（VID-04a）。
	Connectors() ConnectorReader
	// HTTP 回只能访问 network:<group> 域名清单的客户端，组要在清单里声明并经用户确认（VID-04a，network.go）。
	HTTP(group string) (*http.Client, error)
	// AttachmentDir 是本机附件目录的绝对路径（IM-04a，datadir.go），没接数据目录时为空串。
	AttachmentDir() string
	// Agent 用默认服务商补全、按 Agent 的授权跑一轮、搜指定知识库（SOP-01c，agent.go）。
	Agent() AgentService
	// Granted 看用户确认过这项权限没有，只认状态表里确认过的（SEC-01，permissions.go）。
	Granted(perm string) bool
	// SOP 查插件登记的 SOP 节点、执行插件节点、唤醒挂起的步骤（SOP-03a，sopnode.go）。
	SOP() SOPService
	// Audit 记插件替用户做的对外动作，操作者记为插件，记在审计 agent 一组（SOP-02b，audit_note.go）。
	Audit() AuditLog
	// Notify 以本插件的名义发通知：kind 补插件前缀、来源记插件 id，停用后回错误（VID-06b，notify.go）。
	Notify(ctx context.Context, n Notification) error
	// Runs 发起 Agent、SOP 运行或交给 Claude Code，回运行 id；跑完给本插件投 run.finished（VID-03a，runs.go）。
	Runs() RunService
	// Incidents 记运行异常，来源记为 plugin:<插件 id>，按指纹合并（INC-01a，incidents.go）。
	Incidents() IncidentService
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
	id     string
	log    *slog.Logger
	emits  []string
	prefix string                   // 清单的 table_prefix，Store 只许碰这些表
	reg    *Registry                // 发布时取 reg.Events，cmd/pmw 在 Start 之前接上
	perms  atomic.Pointer[[]string] // 用户确认过的权限，状态变了由 Registry.setState 换掉
}

func (c *core) PluginID() string  { return c.id }
func (c *core) Log() *slog.Logger { return c.log }
func (c *core) Events() Publisher { return c }

func (c *core) Publish(ctx context.Context, eventType string, payload any) error {
	if !slices.Contains(c.emits, eventType) {
		return fmt.Errorf("%w: %s", ErrEventNotDeclared, eventType)
	}
	if eventType == sopRunStatusEvent {
		c.reg.watchSOPRun(payload)
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
