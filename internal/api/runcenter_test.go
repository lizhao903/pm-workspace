// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 统一运行中心（P0-O1）：GET /api/runs/all ---

// runCenterStore 在 fakeStore 上补 Agent 侧的执行记录。
//
// fakeStore 的 ListAgentRuns 恒回空列表（fakestore_agentruns_test.go 是别人的文件），
// 而运行中心的价值就在两类执行合并，所以测试包一层，而不是去改别人的替身文件。
type runCenterStore struct {
	*fakeStore
	agentRuns []*store.AgentRun
}

var _ store.Store = (*runCenterStore)(nil)

// ListAgentRuns 和真实实现同构：状态过滤、started_at 倒序、total 不受分页影响、分页切好。
// 真实实现会把 waiting 排在最前，但 handler 合并后会自己再排一次，这里按时间排不影响被测逻辑。
func (f *runCenterStore) ListAgentRuns(_ context.Context, flt store.AgentRunFilter) ([]*store.AgentRun, int, error) {
	var hits []*store.AgentRun
	for _, r := range f.agentRuns {
		if len(flt.Statuses) > 0 && !slices.Contains(flt.Statuses, r.Status) {
			continue
		}
		hits = append(hits, r)
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].StartedAt.After(hits[j].StartedAt) })
	total := len(hits)
	limit := flt.Limit
	if limit <= 0 {
		limit = store.DefaultAgentRunLimit
	}
	offset := flt.Offset
	if offset < 0 {
		offset = 0
	}
	if offset >= len(hits) {
		hits = nil
	} else {
		hits = hits[offset:]
	}
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, total, nil
}

func newRunCenterServer(t *testing.T) (*Server, *runCenterStore) {
	t.Helper()
	f := &runCenterStore{fakeStore: newFakeStore()}
	s := New(f, Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	return s, f
}

// callRunCenter 直接调 handler，不走路由：路由由别的任务统一注册，这里只测 handler 本身。
func callRunCenter(t *testing.T, s *Server, target string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleListRunsAll(w, httptest.NewRequest(http.MethodGet, target, nil))
	return w
}

func runCenterRows(t *testing.T, w *httptest.ResponseRecorder) ([]map[string]any, map[string]any) {
	t.Helper()
	m := decodeEnvelope(t, w)
	meta, ok := m["meta"].(map[string]any)
	if !ok {
		t.Fatalf("列表响应缺 meta: %s", w.Body.String())
	}
	raw, ok := m["data"].([]any)
	if !ok {
		t.Fatalf("data 应为数组: %s", w.Body.String())
	}
	out := make([]map[string]any, 0, len(raw))
	for _, it := range raw {
		row, ok := it.(map[string]any)
		if !ok {
			t.Fatalf("data 里出现非对象: %v", it)
		}
		out = append(out, row)
	}
	return out, meta
}

func addRunCenterObject(f *runCenterStore, id, ref, title string) {
	f.objs[id] = &domain.Object{ID: id, TypeID: "task", Ref: ref, Title: title}
}

func seedAgentRun(f *runCenterStore, id, agentID, status string, started time.Time) *store.AgentRun {
	r := &store.AgentRun{ID: id, AgentID: agentID, Status: status, StartedAt: started}
	f.agentRuns = append(f.agentRuns, r)
	return r
}

// seedTaskRun 直接写内存表，好把 started_at 定为确定值（CreateTaskRun 只会用当前时间）。
func seedTaskRun(f *runCenterStore, id, objectID, status string, started time.Time) *domain.TaskRun {
	f.runsMap()
	r := &domain.TaskRun{
		ID: id, ObjectID: objectID, Workdir: "/tmp/demo", Status: status,
		StartedAt: started, Mode: domain.RunModeStream,
	}
	if status == domain.RunDone || status == domain.RunFailed || status == domain.RunCanceled {
		finished := started.Add(time.Second)
		r.FinishedAt = &finished
	}
	f.taskRuns[id] = r
	f.taskRunSeq[id] = len(f.taskRunSeq) + 1
	return r
}

func kindAndID(t *testing.T, row map[string]any) (string, string) {
	t.Helper()
	kind, _ := row["kind"].(string)
	id, _ := row["id"].(string)
	return kind, id
}

// 空列表要回 []、total 0，不能回 null。
func TestRunCenterEmpty(t *testing.T) {
	s, _ := newRunCenterServer(t)
	w := callRunCenter(t, s, "/api/runs/all")
	mustCode(t, w, http.StatusOK, "empty run center")
	if !strings.Contains(w.Body.String(), `"data":[]`) {
		t.Fatalf("空列表应为 []: %s", w.Body.String())
	}
	rows, meta := runCenterRows(t, w)
	if len(rows) != 0 {
		t.Fatalf("空库应回 0 行，得到 %d", len(rows))
	}
	if meta["total"] != float64(0) || meta["limit"] != float64(50) || meta["offset"] != float64(0) {
		t.Fatalf("meta = %v", meta)
	}
}

// 两类执行按 started_at 倒序合并，task 行补对象编号/标题和执行器中文名，agent 行补 Agent 名。
func TestRunCenterAggregatesBothKinds(t *testing.T) {
	s, f := newRunCenterServer(t)
	now := time.Now()

	f.agents = map[string]*domain.Agent{"ag_1": {ID: "ag_1", Name: "助理"}}
	done := seedAgentRun(f, "ar_done", "ag_1", store.AgentRunDone, now.Add(-3*time.Hour))
	done.Trigger, done.Summary = "任务分配 · TSK-0001", "跑完了"
	session := "ags_1"
	done.SessionID = &session
	running := seedAgentRun(f, "ar_run", "ag_1", store.AgentRunRunning, now.Add(-time.Hour))
	running.Trigger, running.Pending = "定时 · 每天", 2

	addRunCenterObject(f, "obj_a", "TSK-0001", "写测试")
	addRunCenterObject(f, "obj_b", "", "无编号")
	deepseek := seedTaskRun(f, "run_deepseek", "obj_a", domain.RunDone, now.Add(-2*time.Hour))
	deepseek.Harness = domain.RunHarnessDeepSeek
	claude := seedTaskRun(f, "run_claude", "obj_b", domain.RunRunning, now.Add(-10*time.Second))
	claude.Harness = domain.RunHarnessClaude

	w := callRunCenter(t, s, "/api/runs/all")
	mustCode(t, w, http.StatusOK, "aggregate")
	rows, meta := runCenterRows(t, w)
	if meta["total"] != float64(4) {
		t.Fatalf("total = %v，想要 4", meta["total"])
	}
	want := [][2]string{{"task", "run_claude"}, {"agent", "ar_run"}, {"task", "run_deepseek"}, {"agent", "ar_done"}}
	if len(rows) != len(want) {
		t.Fatalf("行数 = %d，想要 %d: %v", len(rows), len(want), rows)
	}
	for i, w := range want {
		if kind, id := kindAndID(t, rows[i]); kind != w[0] || id != w[1] {
			t.Fatalf("第 %d 行 = %s/%s，想要 %s/%s", i, kind, id, w[0], w[1])
		}
	}

	taskRow := rows[0]
	if taskRow["status"] != domain.RunRunning || taskRow["title"] != "无编号" || taskRow["sub"] != "Claude Code" {
		t.Fatalf("task 行 = %v", taskRow)
	}
	if taskRow["harness"] != domain.RunHarnessClaude || taskRow["object_id"] != "obj_b" ||
		taskRow["object_ref"] != "" || taskRow["object_title"] != "无编号" {
		t.Fatalf("task 行对象字段 = %v", taskRow)
	}
	if taskRow["finished_at"] != nil || taskRow["pending"] != float64(0) {
		t.Fatalf("task 行未用字段 = %v", taskRow)
	}

	agentRow := rows[1]
	if agentRow["title"] != "助理" || agentRow["agent_name"] != "助理" || agentRow["agent_id"] != "ag_1" {
		t.Fatalf("agent 行名字 = %v", agentRow)
	}
	if agentRow["sub"] != "定时 · 每天" || agentRow["trigger"] != "定时 · 每天" ||
		agentRow["pending"] != float64(2) || agentRow["session_id"] != "" || agentRow["summary"] != "" {
		t.Fatalf("agent 行字段 = %v", agentRow)
	}
	if agentRow["object_id"] != "" || agentRow["harness"] != "" {
		t.Fatalf("agent 行不该有 task 字段 = %v", agentRow)
	}

	if rows[2]["title"] != "TSK-0001 写测试" || rows[2]["sub"] != "DeepSeek Harness" {
		t.Fatalf("task 标题/执行器 = %v", rows[2])
	}
	if rows[3]["status"] != domain.RunDone || rows[3]["session_id"] != "ags_1" || rows[3]["summary"] != "跑完了" {
		t.Fatalf("agent 完成行 = %v", rows[3])
	}
	if meta["limit"] != float64(50) || meta["offset"] != float64(0) {
		t.Fatalf("meta = %v", meta)
	}
}

// Agent 删除后，title 回退到 agent_id，agent_name 留空。
func TestRunCenterDeletedAgentFallback(t *testing.T) {
	s, f := newRunCenterServer(t)
	seedAgentRun(f, "ar_1", "ag_gone", store.AgentRunDone, time.Now().Add(-time.Hour))

	rows, _ := runCenterRows(t, callRunCenter(t, s, "/api/runs/all"))
	if len(rows) != 1 {
		t.Fatalf("行数 = %d", len(rows))
	}
	if rows[0]["title"] != "ag_gone" || rows[0]["agent_name"] != "" {
		t.Fatalf("删掉的 Agent 应回退到 agent_id: %v", rows[0])
	}
}

// source 过滤：缺省两类都查，只给一侧就只回那一侧。
func TestRunCenterSourceFilter(t *testing.T) {
	s, f := newRunCenterServer(t)
	now := time.Now()
	seedAgentRun(f, "ar_1", "ag_1", store.AgentRunDone, now.Add(-3*time.Hour))
	seedTaskRun(f, "run_1", "obj_a", domain.RunDone, now.Add(-2*time.Hour))
	seedTaskRun(f, "run_2", "obj_a", domain.RunFailed, now.Add(-time.Hour))

	cases := []struct {
		target    string
		wantTotal int
		wantKinds []string
	}{
		{"/api/runs/all", 3, []string{"task", "task", "agent"}},
		{"/api/runs/all?source=task", 2, []string{"task", "task"}},
		{"/api/runs/all?source=agent", 1, []string{"agent"}},
		{"/api/runs/all?source=agent,task", 3, []string{"task", "task", "agent"}},
		{"/api/runs/all?source=agent,agent", 1, []string{"agent"}},
	}
	for _, tc := range cases {
		rows, meta := runCenterRows(t, callRunCenter(t, s, tc.target))
		if meta["total"] != float64(tc.wantTotal) || len(rows) != tc.wantTotal {
			t.Fatalf("%s: total=%v rows=%d，想要 %d", tc.target, meta["total"], len(rows), tc.wantTotal)
		}
		for i, want := range tc.wantKinds {
			if kind, _ := kindAndID(t, rows[i]); kind != want {
				t.Fatalf("%s 第 %d 行 kind = %s，想要 %s", tc.target, i, kind, want)
			}
		}
	}
}

// status 过滤：允许六种状态，过滤后的 total 是两类相加；非法值 400。
func TestRunCenterStatusFilter(t *testing.T) {
	s, f := newRunCenterServer(t)
	now := time.Now()
	seedAgentRun(f, "ar_running", "ag_1", store.AgentRunRunning, now.Add(-time.Hour))
	seedAgentRun(f, "ar_waiting", "ag_1", store.AgentRunWaiting, now.Add(-2*time.Hour))
	seedAgentRun(f, "ar_done", "ag_1", store.AgentRunDone, now.Add(-3*time.Hour))
	seedTaskRun(f, "run_done", "obj_a", domain.RunDone, now.Add(-4*time.Hour))
	seedTaskRun(f, "run_failed", "obj_a", domain.RunFailed, now.Add(-5*time.Hour))

	cases := []struct {
		target    string
		wantTotal int
	}{
		{"/api/runs/all?status=done", 2},
		{"/api/runs/all?status=waiting", 1},
		{"/api/runs/all?status=running", 1},
		{"/api/runs/all?status=rejected", 0},
		{"/api/runs/all?status=done,failed", 3},
		{"/api/runs/all?status=done,%20waiting", 3},
	}
	for _, tc := range cases {
		rows, meta := runCenterRows(t, callRunCenter(t, s, tc.target))
		if meta["total"] != float64(tc.wantTotal) || len(rows) != tc.wantTotal {
			t.Fatalf("%s: total=%v rows=%d，想要 %d", tc.target, meta["total"], len(rows), tc.wantTotal)
		}
	}

	for _, target := range []string{"/api/runs/all?status=bogus", "/api/runs/all?status=running,bogus"} {
		w := callRunCenter(t, s, target)
		e := assertError(t, w, http.StatusBadRequest, "validation")
		if msg, _ := e["message"].(string); !strings.Contains(msg, "status") {
			t.Fatalf("%s: message = %q，应指明 status", target, msg)
		}
	}
}

// 分页在合并之后切：offset/limit 作用在两类执行合成的一条时间线上，total 不受分页影响。
func TestRunCenterPagination(t *testing.T) {
	s, f := newRunCenterServer(t)
	now := time.Now()
	seedAgentRun(f, "ar_new", "ag_1", store.AgentRunDone, now.Add(-10*time.Second))
	seedTaskRun(f, "run_2", "obj_a", domain.RunDone, now.Add(-30*time.Minute))
	seedAgentRun(f, "ar_old", "ag_1", store.AgentRunDone, now.Add(-50*time.Minute))
	seedTaskRun(f, "run_3", "obj_a", domain.RunDone, now.Add(-70*time.Minute))

	rows, meta := runCenterRows(t, callRunCenter(t, s, "/api/runs/all?limit=2&offset=1"))
	if meta["total"] != float64(4) || meta["limit"] != float64(2) || meta["offset"] != float64(1) {
		t.Fatalf("meta = %v", meta)
	}
	if len(rows) != 2 {
		t.Fatalf("本页 2 行，得到 %d", len(rows))
	}
	if kind, id := kindAndID(t, rows[0]); kind != "task" || id != "run_2" {
		t.Fatalf("第 1 行 = %s/%s，想要 task/run_2", kind, id)
	}
	if kind, id := kindAndID(t, rows[1]); kind != "agent" || id != "ar_old" {
		t.Fatalf("第 2 行 = %s/%s，想要 agent/ar_old", kind, id)
	}

	rows, meta = runCenterRows(t, callRunCenter(t, s, "/api/runs/all?offset=10"))
	if len(rows) != 0 || meta["total"] != float64(4) {
		t.Fatalf("offset 越界应回空页 + total 4: rows=%d meta=%v", len(rows), meta)
	}
	if !strings.Contains(callRunCenter(t, s, "/api/runs/all?offset=10").Body.String(), `"data":[]`) {
		t.Fatal("越界页的 data 应为 []，不是 null")
	}

	// limit 缺省 50、上限 200。
	_, meta = runCenterRows(t, callRunCenter(t, s, "/api/runs/all?limit=1000"))
	if meta["limit"] != float64(200) {
		t.Fatalf("limit 上限应为 200，得到 %v", meta["limit"])
	}
}

// 读取时收尾残留的 running 执行：库里有、本进程手上没有且超过宽限期，输出前标成 failed。
func TestRunCenterReapsStaleTaskRun(t *testing.T) {
	s, f := newRunCenterServer(t)
	seedTaskRun(f, "run_stale", "obj_a", domain.RunRunning, time.Now().Add(-2*time.Minute))

	rows, meta := runCenterRows(t, callRunCenter(t, s, "/api/runs/all"))
	if len(rows) != 1 || meta["total"] != float64(1) {
		t.Fatalf("rows=%d meta=%v", len(rows), meta)
	}
	if rows[0]["status"] != domain.RunFailed {
		t.Fatalf("残留记录应收尾为 failed，得到 %v", rows[0]["status"])
	}
	if rows[0]["finished_at"] == nil {
		t.Fatal("收尾后要带上 finished_at")
	}
}

// 非法参数一律 400，并且 message 指明是哪个参数。
func TestRunCenterBadParams(t *testing.T) {
	s, _ := newRunCenterServer(t)
	for _, tc := range []struct{ target, param string }{
		{"/api/runs/all?status=bogus", "status"},
		{"/api/runs/all?source=sop", "source"},
		{"/api/runs/all?limit=abc", "limit"},
		{"/api/runs/all?offset=abc", "offset"},
	} {
		w := callRunCenter(t, s, tc.target)
		e := assertError(t, w, http.StatusBadRequest, "validation")
		if msg, _ := e["message"].(string); !strings.Contains(msg, tc.param) {
			t.Fatalf("%s: message = %q，应指明 %s", tc.target, msg, tc.param)
		}
	}
}
