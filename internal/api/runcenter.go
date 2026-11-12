// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 统一运行中心（P0-O1）：GET /api/runs/all ---
//
// 一页看到「正在跑 / 等确认 / 失败」的执行。数据来自两张表：Agent 触发执行
// （agent_runs，kind=agent）和交给执行器的 task 执行（task_runs，kind=task）。
// SOP 执行不进这里——它有自己的页面和运行记录，混进来会让「一页看完」变成三套状态机。
//
// 合并与分页放在接口层而不是 SQL：两张表在库这一层是分开的，没有跨表 UNION 的 store
// 读法可用。两侧各自按 offset+limit 取一页，再按 started_at 归并、切出本页。

// runCenterStatuses 是运行中心允许的 status 值。Agent 侧六个状态都有；task 侧只有
// running/done/failed/canceled（waiting 是 Agent 执行等确认时的状态，task 记录走不到
// rejected）。过滤值取并集，某一侧没有的状态自然筛不出东西。
var runCenterStatuses = []string{
	store.AgentRunRunning, store.AgentRunWaiting, store.AgentRunDone,
	store.AgentRunFailed, store.AgentRunCanceled, store.AgentRunRejected,
}

// runCenterSources 是 source 参数允许的值。
var runCenterSources = []string{"agent", "task"}

// runCenterItem 是运行中心一行。字段名就是契约里的 JSON 名，前端按它开发。
// 一种执行用不到的字段给空串 / null / 0，好让前端不必按 kind 造两套读取逻辑。
type runCenterItem struct {
	Kind   string `json:"kind"`   // agent | task
	ID     string `json:"id"`     // ar_... | run_...
	Status string `json:"status"` // 原样：agent 有 waiting/rejected，task 没有
	// Title 是这一行最显眼的标题：agent 是 Agent 名（Agent 删了回 agent_id），
	// task 是「编号 标题」（编号为空时就是标题）。
	Title string `json:"title"`
	// Sub 是副标题：agent 是触发说明，task 是执行器的中文名。
	Sub        string     `json:"sub"`
	Summary    string     `json:"summary"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	Pending    int        `json:"pending"`

	AgentID   string `json:"agent_id"`
	AgentName string `json:"agent_name"`
	Trigger   string `json:"trigger"`
	SessionID string `json:"session_id"`

	ObjectID    string `json:"object_id"`
	ObjectRef   string `json:"object_ref"`
	ObjectTitle string `json:"object_title"`
	Harness     string `json:"harness"`

	// ModuleKey / CacheHitRatio 是模块前缀复用（0058）：task 行是这次执行复用的模块和
	// dsh 会话的缓存命中率（0~1，无 token 为 0）；agent 行没有这个概念，恒空串 / 0。
	ModuleKey     string  `json:"module_key"`
	CacheHitRatio float64 `json:"cache_hit_ratio"`
}

// runCenterHarnessLabel 把执行器的内部 key 翻成界面上给人看的名字。
// 空串（0049 之前的老记录、工作台 Agent 之外的执行没有 harness）按「本机执行」。
func runCenterHarnessLabel(h string) string {
	switch h {
	case domain.RunHarnessClaude:
		return "Claude Code"
	case domain.RunHarnessDeepSeek:
		return "DeepSeek Harness"
	case domain.RunHarnessAgent:
		return "工作台 Agent"
	default:
		return "本机执行"
	}
}

// handleListRunsAll 是 GET /api/runs/all 的 handler。路由在 server.go 统一注册。
func (s *Server) handleListRunsAll(w http.ResponseWriter, r *http.Request) {
	p := newParams(r)

	statuses := p.csv("status")
	for _, st := range statuses {
		if !slices.Contains(runCenterStatuses, st) {
			s.fail(w, r, validationf("invalid %q: expected running / waiting / done / failed / canceled / rejected", "status"))
			return
		}
	}

	// source 缺省两类都查；给了就只查给出的那些。
	wantAgent, wantTask := true, true
	if sources := p.csv("source"); len(sources) > 0 {
		wantAgent, wantTask = false, false
		for _, src := range sources {
			if !slices.Contains(runCenterSources, src) {
				s.fail(w, r, validationf("invalid %q: expected agent / task", "source"))
				return
			}
			switch src {
			case "agent":
				wantAgent = true
			case "task":
				wantTask = true
			}
		}
	}

	limit, err := p.limit("limit", defaultLimit, maxLimit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	offset, err := p.intRange("offset", 0, 0, 1<<30)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	// 两侧各取 offset+limit 条：合并后往前切掉 offset 条，本页的数据一定在这批里。
	// 只取 limit 条是不够的——第二页会从两侧各自的第 limit 条开始缺数据。
	fetch := offset + limit
	ctx := r.Context()

	items := []runCenterItem{}
	total := 0

	if wantAgent {
		runs, n, err := s.st.ListAgentRuns(ctx, store.AgentRunFilter{Statuses: statuses, Limit: fetch})
		if err != nil {
			s.fail(w, r, err)
			return
		}
		total += n
		var names map[string]string
		if len(runs) > 0 {
			if names, err = s.runCenterAgentNames(ctx); err != nil {
				s.fail(w, r, err)
				return
			}
		}
		for _, run := range runs {
			name := names[run.AgentID]
			title := name
			if title == "" {
				// Agent 删了：记录里的 agent_id 还在，用它当标题比留一行空白强。
				title = run.AgentID
			}
			sessionID := ""
			if run.SessionID != nil {
				sessionID = *run.SessionID
			}
			items = append(items, runCenterItem{
				Kind:       "agent",
				ID:         run.ID,
				Status:     run.Status,
				Title:      title,
				Sub:        run.Trigger,
				Summary:    run.Summary,
				StartedAt:  run.StartedAt,
				FinishedAt: run.FinishedAt,
				Pending:    run.Pending,
				AgentID:    run.AgentID,
				AgentName:  name,
				Trigger:    run.Trigger,
				SessionID:  sessionID,
			})
		}
	}

	if wantTask {
		taskRuns, n, err := s.st.ListAllTaskRuns(ctx, statuses, fetch, 0)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		total += n
		// 先收尾再输出：工作台重启后残留的 running 记录要在这里变成 failed，
		// 否则运行中心会一直显示一条永远不结束的执行。和任务抽屉同一个口径。
		domainRuns := make([]*domain.TaskRun, 0, len(taskRuns))
		for _, tr := range taskRuns {
			domainRuns = append(domainRuns, tr.Run)
		}
		s.reapStale(ctx, domainRuns)
		for _, tr := range taskRuns {
			run := tr.Run
			items = append(items, runCenterItem{
				Kind:          "task",
				ID:            run.ID,
				Status:        run.Status,
				Title:         strings.TrimSpace(tr.ObjectRef + " " + tr.ObjectTitle),
				Sub:           runCenterHarnessLabel(run.Harness),
				StartedAt:     run.StartedAt,
				FinishedAt:    run.FinishedAt,
				ObjectID:      run.ObjectID,
				ObjectRef:     tr.ObjectRef,
				ObjectTitle:   tr.ObjectTitle,
				Harness:       run.Harness,
				ModuleKey:     run.ModuleKey,
				CacheHitRatio: runCacheHitRatio(run),
			})
		}
	}

	// 统一按开始时间倒序；同一时刻按 kind 稳定排（agent 在前），不然两类记录的顺序
	// 会取决于哪一张表先查——同一份数据两次请求可能给出不同顺序。
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].StartedAt.Equal(items[j].StartedAt) {
			return items[i].Kind < items[j].Kind
		}
		return items[i].StartedAt.After(items[j].StartedAt)
	})

	out := []runCenterItem{}
	if offset < len(items) {
		end := offset + limit
		if end > len(items) {
			end = len(items)
		}
		out = items[offset:end]
	}
	respondList(w, out, Meta{Total: total, Limit: limit, Offset: offset})
}

// runCenterAgentNames 批量取 Agent id -> 名字，给 agent 行补显示名。
// 逐行 GetAgent 就是 N+1，而运行中心一页最多 200 行。
func (s *Server) runCenterAgentNames(ctx context.Context) (map[string]string, error) {
	agents, err := s.st.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(agents))
	for _, a := range agents {
		out[a.ID] = a.Name
	}
	return out, nil
}

// runCacheHitRatio 是 task 行的缓存命中率：命中前缀缓存的输入 / 全部输入（0~1）。
// 没有输入 token（老记录、claude 执行、日志还没写）时为 0——0 在这里表示「没有数据」，
// 和「命中率 0%」在界面上要靠 ModuleKey / Harness 一起区分。
func runCacheHitRatio(run *domain.TaskRun) float64 {
	if run == nil {
		return 0
	}
	total := run.CacheReadTokens + run.UncachedInputTokens
	if total <= 0 {
		return 0
	}
	return float64(run.CacheReadTokens) / float64(total)
}
