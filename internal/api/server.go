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

	"github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/store"
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
}

type Server struct {
	st  store.Store
	opt Options
	log *slog.Logger
	h   http.Handler
	// run 持有所有正在跑的 claude 进程，取消要靠它。它必须是 Server 级的单例：
	// 每次请求新建一个的话，取消接口就找不到别的请求起的那个进程了。
	run *runner.Runner
}

func New(st store.Store, opts Options) *Server {
	s := &Server{st: st, opt: opts, log: opts.Logger}
	if s.log == nil {
		s.log = slog.Default()
	}
	if s.opt.Version == "" {
		s.opt.Version = "dev"
	}
	s.run = &runner.Runner{Bin: opts.ClaudeBin, Timeout: opts.RunTimeout, Logger: s.log}
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

	return s.recoverer(s.logging(limitBody(root)))
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
	m.HandleFunc("GET /api/agent/sessions/{id}/artifacts", s.handleListAgentArtifacts)
	m.HandleFunc("PATCH /api/agent/sessions/{id}", s.handleUpdateAgentSession)
	m.HandleFunc("DELETE /api/agent/sessions/{id}", s.handleDeleteAgentSession)
	m.HandleFunc("POST /api/agent/workdir/check", s.handleCheckWorkdir)
	m.HandleFunc("POST /api/agent/chat", s.handleAgentChat)

	// 目录浏览。browse / shortcuts / mkdir 三个都是固定路径，互不遮挡。
	m.HandleFunc("GET /api/fs/browse", s.handleFsBrowse)
	m.HandleFunc("GET /api/fs/shortcuts", s.handleFsShortcuts)
	m.HandleFunc("POST /api/fs/mkdir", s.handleFsMkdir)

	// 用本机 Claude Code 执行任务。/api/objects/{id}/run 与 .../runs 是两段不同的
	// 字面量，互不遮挡；/api/runs/{id}/cancel 比 /api/runs/{id} 多一段，
	// ServeMux 按最具体的模式匹配。
	m.HandleFunc("GET /api/objects/{id}/runs", s.handleListTaskRuns)
	m.HandleFunc("POST /api/objects/{id}/run", s.handleRunObject)
	m.HandleFunc("GET /api/runs/{id}", s.handleGetTaskRun)
	m.HandleFunc("POST /api/runs/{id}/cancel", s.handleCancelTaskRun)

	m.HandleFunc("GET /api/revisions", s.handleRecentRevisions)

	// 数据与备份。export 直接回文件流，不套 envelope。
	m.HandleFunc("GET /api/admin/migrations", s.handleMigrations)
	m.HandleFunc("POST /api/admin/snapshot", s.handleSnapshot)
	m.HandleFunc("GET /api/admin/export", s.handleExport)
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
		h.Set("Access-Control-Allow-Headers", "Content-Type, X-Actor-Source")
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
