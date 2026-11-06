// Package api 是工作台的 HTTP 层：解析参数、调 store、按契约写响应。
// 业务规则一律留在 store，这里只做协议转换。
package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/conversation"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/imident"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/localdir"
	"github.com/lizhao903/pm-workspace/internal/notify"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/selfupdate"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/webhook"
	"github.com/lizhao903/pm-workspace/internal/workspace"
)

// maxBodyBytes 限制单次请求体，避免手滑把大文件 POST 进来撑爆内存。
const maxBodyBytes = 2 << 20

type Options struct {
	Version string
	UI      http.Handler // 为 nil 时非 /api 路径直接 404（--dev 下前端由 vite 提供）
	Dev     bool         // 开发模式：放开 CORS 供 vite 的 5173 直连
	Logger  *slog.Logger // 为 nil 时用 slog.Default()

	// ClaudeBin / RunTimeout 只给「用本机 Claude Code 执行任务」那条链路用。
	// 都留空即 runner 的默认值（PATH 里的 claude、10 分钟）。
	// 测试靠 ClaudeBin 指向一个假的 CLI，不必装真的 claude 也不联网。
	ClaudeBin  string
	RunTimeout time.Duration

	// DSHBin 是 deepseek-harness 的 dsh 可执行文件，空则走 PATH（--dsh-bin 或 DSH_BIN）。
	// 和 ClaudeBin 分开：npx / nvm 装出来的 dsh 常常不在服务进程的 PATH 里，
	// 而把 claude 的路径复用过来只会让两边都错。
	DSHBin string

	// MCPBin / PublicURL 只给「切换到终端」执行用（0048，runterminal.go）：生成接回本工作台的 MCP 配置，
	// command 是 MCPBin，--api 是 PublicURL。MCPBin 为空或文件不在时发起终端执行回 409。
	MCPBin    string
	PublicURL string

	// Vault 是凭证保险箱；为 nil 时 /api/secrets 一律回 500 并说明未配置。
	Vault SecretVault

	// Plugins 是插件注册表；为 nil 时没有插件路由。必须在 New 之前 Start，路由在 New 时挂上。
	Plugins *plugin.Registry

	// Audit 是审计日志（CORE-08）；为 nil 时不记，GET /api/audits 回 500。
	// 删除和 Agent 写操作由 audit.WrapStore 记，这里只给配置类 handler 和查询接口用。
	Audit *audit.Log

	// Notify 是通知（CORE-07b，0019）；为 nil 时 /api/notifications 回 500。
	Notify *notify.Center
	// Stream 是推给前端的事件流，来源是事件总线（Bus.Tap）；为 nil 时 GET /api/events 回 500。
	Stream *events.Stream

	// Schedules 是定时任务的定义（TASK-03a，0020）；为 nil 时 /api/schedules 回 500。
	Schedules *schedule.Store
	// ScheduleRunner 是调度器（TASK-03b），手动执行要用；为 nil 时 POST /api/schedules/{id}/run 回 500。
	ScheduleRunner *schedule.Runner

	// Agent 是插件句柄背后那个 agent.Service（cmd/pmw 建一份，插件和任务执行共用，熔断状态也共用）。
	// 任务交给工作台 Agent 执行（TSK-0460）经它拿带熔断、重试、失败改用的模型客户端；为 nil 时 New 自己建一份。
	Agent *agent.Service

	// AgentRuns 是 Agent 的触发和执行记录（AG-01b4，0036）；New 给它接上 Prepare。为 nil 时不自动触发，列表照常读库。
	AgentRuns *agent.Dispatcher

	// Webhooks 是 Webhook 配置（TASK-02a，0022），密钥在保险箱里；为 nil 时 /api/webhooks 回 500。
	Webhooks *webhook.Store

	// Workspaces 是工作台配置（CORE-10a，0023）；为 nil 时 /api/workspaces 回 500。
	Workspaces *workspace.Store

	// LocalDirs 是文档挂载的本机目录（DOC-01a，0025）；为 nil 时 /api/local-dirs 回 500。
	LocalDirs *localdir.Store

	// Identities 是联系人的 IM 身份（CT-01b，0027）；为 nil 时 /api/im-identities 回 500。
	Identities *imident.Store

	// Conversations 是 IM 会话（CT-02，0028）；为 nil 时 /api/conversations 回 500。
	Conversations *conversation.Store

	// Connectors 是连接器的定义和实例（CONN-01a，0029），凭证在保险箱里；为 nil 时 /api/connectors 回 500。
	Connectors *connector.Store

	// Incidents 是运行异常（INC-01a，0043）；为 nil 时 /api/incidents 回 500。
	Incidents *incident.Store

	// DataDir 是库文件所在目录（含 vault.key、backups/），读文件和挂载一律不许进去；空串表示不限制。
	DataDir string
	// Updater 是设置页「版本更新」（SYS-UPD）：看源码目录比正在跑的新多少、按步骤更新并原地重启；nil 时接口回「这个实例不支持就地更新」
	Updater *selfupdate.Updater
}

type Server struct {
	st  store.Store
	opt Options
	log *slog.Logger
	h   http.Handler
	// run 持有所有正在跑的 claude 进程，取消要靠它。它必须是 Server 级的单例：
	// 每次请求新建一个的话，取消接口就找不到别的请求起的那个进程了。
	run *runner.Runner
	// kbSync 记知识库正在跑的同步和进度，同一个知识库同时只跑一次；和 run 一样要是 Server 级的
	kbSync *kb.Tracker
	// turns 记会话里正在跑的一轮对话，「停止」靠它（agentstop.go）
	turns activeTurns
	// agentSvc 给任务交给工作台 Agent 执行用（runagent.go）；agentTasks 记在跑的这类执行和它们在等的确认
	agentSvc   *agent.Service
	agentTasks agentTaskRuns
	// agentTimeUnit 是预算里「一分钟」有多长，零值是一分钟；测试调短
	agentTimeUnit time.Duration
	// streamReports 记后台执行经 MCP 回报、还没收尾的结论（TSK-0499，runperms.go）
	streamReports streamReports
}

func New(st store.Store, opts Options) *Server {
	s := &Server{st: st, opt: opts, log: opts.Logger, kbSync: kb.NewTracker()}
	if s.log == nil {
		s.log = slog.Default()
	}
	if s.opt.Version == "" {
		s.opt.Version = "dev"
	}
	s.run = &runner.Runner{Bin: opts.ClaudeBin, DSHBin: opts.DSHBin, Timeout: opts.RunTimeout, Logger: s.log}
	if opts.Plugins != nil {
		// 插件交给 Claude Code 的运行和任务执行共用一个执行器（AUTO-01）：在任务上留了记录的，
		// 任务抽屉里取消、判残留都认得它；回写结论用的 MCP、预置提示词同任务执行
		opts.Plugins.SetClaudeRunner(s.run)
		opts.Plugins.SetRunCallback(opts.MCPBin, opts.PublicURL)
		opts.Plugins.SetRunPresets(s.presetLookup)
		// 插件同步知识库（TSK-0721）：读文件的拦截、和目录同步互斥都走这个 Server 的
		opts.Plugins.SetKnowledge(pluginKB{s})
	}
	if opts.AgentRuns != nil {
		opts.AgentRuns.Prepare = s.agentRunner
	}
	s.agentSvc = opts.Agent
	if s.agentSvc == nil {
		s.agentSvc = &agent.Service{Store: st}
		if opts.Connectors != nil {
			s.agentSvc.Connectors = opts.Connectors
		}
	}
	s.loadFsRoots()
	s.h = s.build()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.h.ServeHTTP(w, r) }

func (s *Server) build() http.Handler {
	api := http.NewServeMux()
	s.routes(api)
	// 兜底：/api 下任何未注册路径返回 JSON 404，而不是掉进 SPA fallback 回 index.html。
	api.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
	})

	var apiH http.Handler = api
	if s.opt.Dev {
		apiH = devCORS(apiH)
	}

	root := http.NewServeMux()
	root.Handle("/api/", apiH)
	if s.opt.UI != nil {
		root.Handle("/", s.opt.UI)
	} else {
		root.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
		})
	}

	return s.recoverer(s.logging(limitBody(withActor(root))))
}

// routes 逐条对应 docs/api-contract.md 的表格，顺序保持一致便于比对。
// routeRegistrar 只为了让测试能把整张路由表收下来——*http.ServeMux 天然满足它。
// 路由表是「API 表面」的唯一真相，能枚举它，才能拿它去比对 docs/api-contract.md。
type routeRegistrar interface {
	HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request))
}

func (s *Server) routes(m routeRegistrar) {
	m.HandleFunc("GET /api/health", s.handleHealth)
	m.HandleFunc("GET /api/stats", s.handleStats)
	m.HandleFunc("GET /api/counts", s.handleCounts)
	m.HandleFunc("GET /api/today", s.handleToday)

	m.HandleFunc("GET /api/object-types", s.handleListObjectTypes)
	m.HandleFunc("POST /api/object-types", s.handleCreateObjectType)
	m.HandleFunc("PATCH /api/object-types/{id}", s.handleUpdateObjectType)
	m.HandleFunc("DELETE /api/object-types/{id}", s.handleDeleteObjectType)

	m.HandleFunc("GET /api/categories", s.handleListCategories)
	m.HandleFunc("POST /api/categories", s.handleCreateCategory)
	m.HandleFunc("PATCH /api/categories/{id}", s.handleUpdateCategory)
	m.HandleFunc("POST /api/categories/{id}/move", s.handleMoveCategory)
	m.HandleFunc("DELETE /api/categories/{id}", s.handleDeleteCategory)

	m.HandleFunc("GET /api/objects", s.handleListObjects)
	m.HandleFunc("POST /api/objects", s.handleCreateObject)
	m.HandleFunc("GET /api/objects/{id}", s.handleGetObject)
	m.HandleFunc("PATCH /api/objects/{id}", s.handleUpdateObject)
	m.HandleFunc("DELETE /api/objects/{id}", s.handleDeleteObject)
	m.HandleFunc("POST /api/objects/{id}/restore", s.handleRestoreObject)
	m.HandleFunc("GET /api/objects/{id}/links", s.handleListLinks)
	m.HandleFunc("POST /api/objects/{id}/links", s.handleCreateLink)
	m.HandleFunc("GET /api/objects/{id}/revisions", s.handleObjectRevisions)

	// 开发任务闭环：进展与领取。进展是服务端追加（只插入不更新），
	// 不走 PATCH body——读出来拼一段再整体写回，两个会话同时写就会丢一段。
	m.HandleFunc("GET /api/objects/{id}/progress", s.handleListProgress)
	m.HandleFunc("POST /api/objects/{id}/progress", s.handleAppendProgress)
	m.HandleFunc("POST /api/objects/{id}/claim", s.handleClaimObject)
	// 任务阶段与提出人（AUTO-05，stages.go）
	m.HandleFunc("PUT /api/objects/{id}/stage", s.handleSetObjectStage)
	m.HandleFunc("GET /api/task-stages", s.handleTaskStageDefs)
	m.HandleFunc("GET /api/tasks/stages", s.handleTaskStages)

	// /api/shortcuts/reorder 必须先于 /api/shortcuts/{id} 注册，否则 reorder 会被当成一个 id。
	m.HandleFunc("GET /api/shortcuts", s.handleListShortcuts)
	m.HandleFunc("POST /api/shortcuts", s.handleCreateShortcut)
	m.HandleFunc("POST /api/shortcuts/reorder", s.handleReorderShortcuts)
	m.HandleFunc("PATCH /api/shortcuts/{id}", s.handleUpdateShortcut)
	m.HandleFunc("DELETE /api/shortcuts/{id}", s.handleDeleteShortcut)
	m.HandleFunc("POST /api/shortcuts/{id}/visit", s.handleVisitShortcut)

	m.HandleFunc("GET /api/shortcut-groups", s.handleListShortcutGroups)
	m.HandleFunc("POST /api/shortcut-groups", s.handleCreateShortcutGroup)
	m.HandleFunc("PATCH /api/shortcut-groups/{id}", s.handleUpdateShortcutGroup)
	m.HandleFunc("DELETE /api/shortcut-groups/{id}", s.handleDeleteShortcutGroup)

	// /api/tags/{id}/merge 比 /api/tags/{id} 多一段，ServeMux 按最具体的模式匹配，
	// merge 不会被当成一个 id 吃掉。
	m.HandleFunc("GET /api/tags", s.handleListTags)
	m.HandleFunc("POST /api/tags", s.handleCreateTag)
	m.HandleFunc("PATCH /api/tags/{id}", s.handleUpdateTag)
	m.HandleFunc("POST /api/tags/{id}/merge", s.handleMergeTags)
	m.HandleFunc("DELETE /api/tags/{id}", s.handleDeleteTag)

	m.HandleFunc("DELETE /api/links/{id}", s.handleDeleteLink)

	// 字典（可配置枚举）。{id}/items/reorder 比 {id}/items 多一段，
	// ServeMux 按最具体的模式匹配，两者不会互相吃掉。
	m.HandleFunc("GET /api/dictionaries", s.handleListDictionaries)
	m.HandleFunc("GET /api/dictionaries/{id}/items", s.handleListDictItems)
	m.HandleFunc("POST /api/dictionaries/{id}/items/reorder", s.handleReorderDictItems)
	m.HandleFunc("POST /api/dictionaries/{id}/items", s.handleCreateDictItem)
	m.HandleFunc("PATCH /api/dict-items/{id}", s.handleUpdateDictItem)
	m.HandleFunc("POST /api/dict-items/{id}/archive", s.handleArchiveDictItem)
	m.HandleFunc("DELETE /api/dict-items/{id}", s.handleDeleteDictItem)
	m.HandleFunc("GET /api/dict-items/{id}/usage", s.handleDictItemUsage)

	// 干系人名册。负责人与参与人都指向这里。
	m.HandleFunc("GET /api/stakeholders", s.handleListStakeholders)
	m.HandleFunc("POST /api/stakeholders", s.handleCreateStakeholder)
	m.HandleFunc("PATCH /api/stakeholders/{id}", s.handleUpdateStakeholder)
	m.HandleFunc("DELETE /api/stakeholders/{id}", s.handleDeleteStakeholder)
	// 联系人的 IM 身份（CT-01b）：resolve 是字面路径，优先于 {id}
	m.HandleFunc("GET /api/im-identities", s.handleListIdentities)
	m.HandleFunc("POST /api/im-identities", s.handleCreateIdentity)
	m.HandleFunc("GET /api/im-identities/resolve", s.handleResolveIdentity)
	m.HandleFunc("GET /api/im-identities/{id}", s.handleGetIdentity)
	m.HandleFunc("PATCH /api/im-identities/{id}", s.handleUpdateIdentity)
	m.HandleFunc("DELETE /api/im-identities/{id}", s.handleDeleteIdentity)
	// IM 会话（CT-02）：resolve 是字面路径，优先于 {id}
	m.HandleFunc("GET /api/conversations", s.handleListConversations)
	m.HandleFunc("POST /api/conversations", s.handleCreateConversation)
	m.HandleFunc("GET /api/conversations/resolve", s.handleResolveConversation)
	m.HandleFunc("GET /api/conversations/{id}", s.handleGetConversation)
	m.HandleFunc("PATCH /api/conversations/{id}", s.handleUpdateConversation)
	m.HandleFunc("DELETE /api/conversations/{id}", s.handleDeleteConversation)
	m.HandleFunc("POST /api/conversations/{id}/members", s.handleAddConversationMember)
	m.HandleFunc("DELETE /api/conversations/{id}/members/{identity_id}", s.handleRemoveConversationMember)

	// Agent 供应商。{id}/default 和 {id}/test 比 {id} 多一段，
	// ServeMux 按最具体的模式匹配，不会被 {id} 吃掉；仍按从具体到宽泛的顺序写，便于目视核对。
	m.HandleFunc("GET /api/agent-providers", s.handleListProviders)
	m.HandleFunc("POST /api/agent-providers", s.handleCreateProvider)
	m.HandleFunc("POST /api/agent-providers/{id}/default", s.handleSetDefaultProvider)
	m.HandleFunc("POST /api/agent-providers/{id}/test", s.handleTestProvider)
	m.HandleFunc("PATCH /api/agent-providers/{id}", s.handleUpdateProvider)
	m.HandleFunc("DELETE /api/agent-providers/{id}", s.handleDeleteProvider)

	// Agent 会话与对话。/api/agent/sessions/{id}/messages 与 .../artifacts 比 {id} 多一段，
	// ServeMux 按最具体的模式匹配；workdir/check 与 chat 是固定路径，与 sessions 不同前缀，
	// 不存在被 {id} 吃掉的问题。
	m.HandleFunc("GET /api/agent/sessions", s.handleListAgentSessions)
	m.HandleFunc("POST /api/agent/sessions", s.handleCreateAgentSession)
	m.HandleFunc("GET /api/agent/sessions/{id}/messages", s.handleListAgentMessages)
	m.HandleFunc("POST /api/agent/sessions/{id}/messages/remove", s.handleRemoveAgentMessages)
	m.HandleFunc("GET /api/agent/sessions/{id}/artifacts", s.handleListAgentArtifacts)
	m.HandleFunc("PATCH /api/agent/sessions/{id}", s.handleUpdateAgentSession)
	m.HandleFunc("DELETE /api/agent/sessions/{id}", s.handleDeleteAgentSession)
	m.HandleFunc("POST /api/agent/sessions/{id}/stop", s.handleStopAgentSession)
	m.HandleFunc("GET /api/agent/running", s.handleRunningAgentSessions)
	m.HandleFunc("POST /api/agent/workdir/check", s.handleCheckWorkdir)
	m.HandleFunc("POST /api/agent/chat", s.handleAgentChat)

	// Agent 配置（AG-01b1，0032）
	m.HandleFunc("GET /api/agents", s.handleListAgents)
	m.HandleFunc("POST /api/agents", s.handleCreateAgent)
	m.HandleFunc("GET /api/agents/scenarios", s.handleListAgentScenarios)
	m.HandleFunc("PATCH /api/agents/scenarios", s.handlePatchAgentScenarios)
	m.HandleFunc("GET /api/agents/{id}", s.handleGetAgent)
	m.HandleFunc("PATCH /api/agents/{id}", s.handleUpdateAgent)
	m.HandleFunc("DELETE /api/agents/{id}", s.handleDeleteAgent)
	m.HandleFunc("GET /api/agents/{id}/impact", s.handleAgentImpact)
	// Agent 工具授权（AG-02a，0035）
	m.HandleFunc("GET /api/agents/{id}/grants", s.handleGetAgentGrants)
	m.HandleFunc("PUT /api/agents/{id}/grants", s.handlePutAgentGrants)
	m.HandleFunc("POST /api/agent/tool-calls/{id}/confirm", s.handleConfirmToolCall)
	m.HandleFunc("POST /api/agent/tool-calls/{id}/reject", s.handleRejectToolCall)
	// Agent 执行记录（AG-01b4，0036）
	m.HandleFunc("GET /api/agent-runs", s.handleListAgentRuns)
	m.HandleFunc("GET /api/agent-runs/{id}", s.handleGetAgentRun)
	// Agent 调试对话（AG-02c）
	m.HandleFunc("POST /api/agents/debug/chat", s.handleAgentDebugChat)
	m.HandleFunc("GET /api/skills", s.handleListSkills)
	m.HandleFunc("POST /api/skills", s.handleCreateSkill)
	m.HandleFunc("GET /api/skills/{id}", s.handleGetSkill)
	m.HandleFunc("PATCH /api/skills/{id}", s.handleUpdateSkill)
	m.HandleFunc("DELETE /api/skills/{id}", s.handleDeleteSkill)
	m.HandleFunc("GET /api/knowledge-bases", s.handleListKnowledgeBases)
	m.HandleFunc("POST /api/knowledge-bases", s.handleCreateKnowledgeBase)
	m.HandleFunc("GET /api/knowledge-bases/{id}", s.handleGetKnowledgeBase)
	m.HandleFunc("PATCH /api/knowledge-bases/{id}", s.handleUpdateKnowledgeBase)
	m.HandleFunc("DELETE /api/knowledge-bases/{id}", s.handleDeleteKnowledgeBase)
	m.HandleFunc("GET /api/knowledge-bases/{id}/docs", s.handleListKbDocs)
	m.HandleFunc("POST /api/knowledge-bases/{id}/docs", s.handleAddKbDocs)
	m.HandleFunc("PATCH /api/knowledge-bases/{id}/docs/{doc_id}", s.handleUpdateKbDoc)
	m.HandleFunc("DELETE /api/knowledge-bases/{id}/docs/{doc_id}", s.handleDeleteKbDoc)
	m.HandleFunc("GET /api/knowledge-bases/{id}/missing", s.handleKbMissing)
	m.HandleFunc("POST /api/knowledge-bases/{id}/reindex", s.handleReindexKb)
	m.HandleFunc("POST /api/knowledge-bases/{id}/sync", s.handleSyncKb)
	m.HandleFunc("GET /api/knowledge-bases/{id}/sync", s.handleKbSyncProgress)
	m.HandleFunc("POST /api/knowledge-bases/{id}/search", s.handleSearchKb)

	// 输出产物。/api/artifacts/stats 是字面量，比 /api/artifacts/{id} 更具体，
	// ServeMux 优先匹配它——不会有 id="stats" 的请求打到 GetArtifact 上。
	m.HandleFunc("GET /api/artifacts", s.handleListArtifacts)
	m.HandleFunc("GET /api/artifacts/stats", s.handleArtifactStats)
	m.HandleFunc("GET /api/artifacts/by-object", s.handleArtifactsByObject)
	m.HandleFunc("POST /api/artifacts", s.handleCreateArtifact)
	m.HandleFunc("GET /api/artifacts/{id}", s.handleGetArtifact)
	m.HandleFunc("PATCH /api/artifacts/{id}", s.handleUpdateArtifact)
	m.HandleFunc("DELETE /api/artifacts/{id}", s.handleDeleteArtifact)

	// 目录浏览。browse / shortcuts / mkdir 三个都是固定路径，互不遮挡。
	m.HandleFunc("GET /api/fs/browse", s.handleFsBrowse)
	m.HandleFunc("GET /api/fs/shortcuts", s.handleFsShortcuts)
	m.HandleFunc("POST /api/fs/mkdir", s.handleFsMkdir)
	// 额外可浏览目录（FS-01）：删除用 ?path=，路径带 /
	m.HandleFunc("GET /api/fs/roots", s.handleListFsRoots)
	m.HandleFunc("POST /api/fs/roots", s.handleAddFsRoot)
	m.HandleFunc("DELETE /api/fs/roots", s.handleRemoveFsRoot)
	// 读文件（DOC-01a）：只读、同一套允许根，越界 403
	m.HandleFunc("GET /api/fs/read", s.handleFsRead)
	// 原样读能预览的文件（PDF、图片）、用本机应用打开或在访达中显示（全部文档），边界同 read
	m.HandleFunc("GET /api/fs/raw", s.handleFsRaw)
	m.HandleFunc("POST /api/fs/open", s.handleFsOpen)

	// 文档挂载的本机目录。reorder 是字面量，比 {id} 更具体；{id}/files 多一段，不会被吃掉。
	m.HandleFunc("GET /api/local-dirs", s.handleListLocalDirs)
	m.HandleFunc("POST /api/local-dirs", s.handleCreateLocalDir)
	m.HandleFunc("POST /api/local-dirs/reorder", s.handleReorderLocalDirs)
	m.HandleFunc("PATCH /api/local-dirs/{id}", s.handleUpdateLocalDir)
	m.HandleFunc("DELETE /api/local-dirs/{id}", s.handleDeleteLocalDir)
	m.HandleFunc("GET /api/local-dirs/{id}/files", s.handleListLocalDirFiles)
	// 项目设置里的文档目录下的文件（TSK-0718，projectdocs.go）；读、预览、打开同挂载目录走 /api/fs/*
	m.HandleFunc("GET /api/objects/{id}/docs-dir/files", s.handleListProjectDocFiles)

	// 用本机 Claude Code 执行任务。/api/objects/{id}/run 与 .../runs 是两段不同的
	// 字面量，互不遮挡；/api/runs/{id}/cancel 比 /api/runs/{id} 多一段，
	// ServeMux 按最具体的模式匹配。
	m.HandleFunc("GET /api/objects/{id}/runs", s.handleListTaskRuns)
	m.HandleFunc("POST /api/objects/{id}/run", s.handleRunObject)
	m.HandleFunc("GET /api/runs/{id}", s.handleGetTaskRun)
	m.HandleFunc("POST /api/runs/{id}/cancel", s.handleCancelTaskRun)
	// 交给 Claude Code 的另一种方式：切换到终端（0048，runterminal.go）
	m.HandleFunc("GET /api/objects/{id}/run/prompt", s.handleRunPrompt)
	m.HandleFunc("GET /api/run-prompts", s.handleListRunPrompts)
	m.HandleFunc("PUT /api/run-prompts", s.handlePutRunPrompts)
	// 后台执行的权限档位与自定义白名单（TSK-0499）
	m.HandleFunc("GET /api/run-permissions", s.handleGetRunPermissions)
	m.HandleFunc("PUT /api/run-permissions", s.handlePutRunPermissions)
	m.HandleFunc("POST /api/objects/{id}/run/terminal", s.handleRunTerminal)
	m.HandleFunc("POST /api/runs/{id}/finish", s.handleFinishTaskRun)

	m.HandleFunc("GET /api/revisions", s.handleRecentRevisions)

	// 审计日志：只读，写入点在各处的 handler 和 audit.WrapStore。
	m.HandleFunc("GET /api/audits", s.handleListAudits)

	// 通知与事件流。read-all 是字面量，和 {id}/read 段数不同，互不遮挡。
	m.HandleFunc("GET /api/notifications", s.handleListNotifications)
	m.HandleFunc("POST /api/notifications/read-all", s.handleReadAllNotifications)
	m.HandleFunc("POST /api/notifications/{id}/read", s.handleReadNotification)
	m.HandleFunc("GET /api/events", s.handleEvents)

	// 定时任务。preview 是字面量，POST /api/schedules/{id} 没有注册，不会被吃掉。
	m.HandleFunc("GET /api/schedules", s.handleListSchedules)
	m.HandleFunc("POST /api/schedules", s.handleCreateSchedule)
	m.HandleFunc("POST /api/schedules/preview", s.handlePreviewSchedule)
	m.HandleFunc("GET /api/schedules/{id}", s.handleGetSchedule)
	m.HandleFunc("PATCH /api/schedules/{id}", s.handleUpdateSchedule)
	m.HandleFunc("DELETE /api/schedules/{id}", s.handleDeleteSchedule)
	m.HandleFunc("GET /api/schedules/{id}/runs", s.handleListScheduleRuns)
	m.HandleFunc("POST /api/schedules/{id}/run", s.handleRunSchedule)

	// 运行异常（INC-01a）。report 是字面量，比 {id} 更具体；{id}/task 多一段，不会被吃掉。
	m.HandleFunc("GET /api/incidents", s.handleListIncidents)
	m.HandleFunc("POST /api/incidents/report", s.handleReportIncident)
	m.HandleFunc("GET /api/incidents/{id}", s.handleGetIncident)
	m.HandleFunc("PATCH /api/incidents/{id}", s.handleUpdateIncident)
	m.HandleFunc("POST /api/incidents/{id}/task", s.handleIncidentTask)

	// Webhook 配置。{id}/usage、{id}/rotate-secret 比 {id} 多一段，不会被吃掉。
	m.HandleFunc("GET /api/webhooks", s.handleListWebhooks)
	m.HandleFunc("POST /api/webhooks", s.handleCreateWebhook)
	m.HandleFunc("GET /api/webhooks/{id}", s.handleGetWebhook)
	m.HandleFunc("PATCH /api/webhooks/{id}", s.handleUpdateWebhook)
	m.HandleFunc("DELETE /api/webhooks/{id}", s.handleDeleteWebhook)
	m.HandleFunc("GET /api/webhooks/{id}/usage", s.handleWebhookUsage)
	m.HandleFunc("POST /api/webhooks/{id}/rotate-secret", s.handleRotateWebhookSecret)
	// 投递记录和收件地址（TASK-02b）。收件在 /api/hooks 下，和配置分开：它不走前端，只认签名。
	m.HandleFunc("GET /api/webhooks/{id}/deliveries", s.handleListWebhookDeliveries)
	m.HandleFunc("POST /api/hooks/{token}", s.handleReceiveHook)

	// 工作台配置。templates 是字面量，比 {id} 更具体，不会被当成 id。
	m.HandleFunc("GET /api/workspaces", s.handleListWorkspaces)
	m.HandleFunc("POST /api/workspaces", s.handleCreateWorkspace)
	m.HandleFunc("GET /api/workspaces/templates", s.handleListWorkspaceTemplates)
	m.HandleFunc("GET /api/workspaces/{id}", s.handleGetWorkspace)
	m.HandleFunc("PATCH /api/workspaces/{id}", s.handleUpdateWorkspace)
	m.HandleFunc("DELETE /api/workspaces/{id}", s.handleDeleteWorkspace)

	// 凭证保险箱。只回脱敏提示，明文没有任何读接口；{id}/rotate 比 {id} 多一段，不会被吃掉。
	m.HandleFunc("GET /api/secrets", s.handleListSecrets)
	m.HandleFunc("POST /api/secrets", s.handleCreateSecret)
	m.HandleFunc("POST /api/secrets/{id}/rotate", s.handleRotateSecret)
	m.HandleFunc("DELETE /api/secrets/{id}", s.handleDeleteSecret)

	// 连接器。defs 是字面量，比 {id} 更具体；{id}/test、{id}/tools 多一段，不会被吃掉。
	m.HandleFunc("GET /api/connectors/defs", s.handleListConnectorDefs)
	m.HandleFunc("GET /api/connectors", s.handleListConnectors)
	m.HandleFunc("POST /api/connectors", s.handleCreateConnector)
	m.HandleFunc("GET /api/connectors/{id}", s.handleGetConnector)
	m.HandleFunc("PATCH /api/connectors/{id}", s.handleUpdateConnector)
	m.HandleFunc("DELETE /api/connectors/{id}", s.handleDeleteConnector)
	m.HandleFunc("GET /api/connectors/{id}/impact", s.handleConnectorImpact)
	m.HandleFunc("POST /api/connectors/{id}/test", s.handleTestConnector)
	m.HandleFunc("POST /api/connectors/{id}/tools/refresh", s.handleRefreshConnectorTools)
	m.HandleFunc("PATCH /api/connectors/{id}/tools", s.handleSetConnectorToolModes)
	// OAuth（CONN-01b）：callback 是字面路径，优先于 {id}
	m.HandleFunc("GET /api/connectors/oauth/callback", s.handleConnectorOAuthCallback)
	m.HandleFunc("POST /api/connectors/{id}/oauth/start", s.handleStartConnectorOAuth)
	m.HandleFunc("POST /api/connectors/{id}/oauth/refresh", s.handleRefreshConnectorOAuth)
	m.HandleFunc("POST /api/connectors/{id}/disconnect", s.handleDisconnectConnector)

	// 数据与备份。export 直接回文件流，不套 envelope。
	m.HandleFunc("GET /api/admin/migrations", s.handleMigrations)
	m.HandleFunc("POST /api/admin/snapshot", s.handleSnapshot)
	m.HandleFunc("GET /api/admin/update", s.handleUpdateStatus)
	m.HandleFunc("POST /api/admin/update", s.handleStartUpdate)
	m.HandleFunc("GET /api/admin/export", s.handleExport)

	// 插件路由：/api/<插件 id>/...，停用时回 404（见 plugins.go）。
	s.pluginRoutes(m)
}

// --- 中间件 ---

// statusWriter 记录状态码供日志使用；透传 Flush 是为将来上 SSE 留口子。
type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wrote {
		w.status, w.wrote = code, true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.status, w.wrote = http.StatusOK, true
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap 让 http.ResponseController 和 WebSocket 库拿到底下的 Hijacker（终端插件的 ws，TERM-01a）。
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		s.log.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", sw.status,
			"dur", time.Since(start).Round(time.Microsecond).String(),
		)
	})
}

// recoverer 把 panic 转成 500，并把调用栈留在日志里。
func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				s.log.Error("panic recovered",
					"method", r.Method, "path", r.URL.Path,
					"panic", v, "stack", string(debug.Stack()))
				writeJSON(w, http.StatusInternalServerError,
					errBody{Error: errPayload{Code: "internal", Message: "internal server error"}})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil && r.Body != http.NoBody {
			r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		}
		next.ServeHTTP(w, r)
	})
}

// devCORS 仅在 --dev 下挂上：同源部署时前端和 API 一个端口，不需要 CORS。
func devCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		if origin := r.Header.Get("Origin"); origin != "" {
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Vary", "Origin")
		} else {
			h.Set("Access-Control-Allow-Origin", "*")
		}
		h.Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type, X-Actor-Source, X-Actor-Name, X-Actor-Session")
		h.Set("Access-Control-Max-Age", "600")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- 请求体读取 ---

func readBody(r *http.Request) ([]byte, error) {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, validationf("request body exceeds %d bytes", mbe.Limit)
		}
		return nil, validationf("cannot read request body: %v", err)
	}
	return b, nil
}

func decodeBody(r *http.Request, dst any) error {
	b, err := readBody(r)
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return validationf("request body is required")
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return validationf("malformed JSON body: %v", err)
	}
	return nil
}
