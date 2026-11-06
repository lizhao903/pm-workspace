package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// DeepSeek 执行器的集成检查（冒烟，TSK-0722）：POST / GET /api/runners/deepseek/smoke。
//
// 设置「执行器」页一键跑一次最小的 dsh 任务，逐项回答「这台机器上 DeepSeek 执行器到底能不能用」：
//
//	spawn     起进程：dsh 进程起来并开了会话
//	model     模型路由：这一轮正常收尾，模型有答复或调了工具
//	mcp       MCP 回写：模型经工作台 MCP（pmw-run）调了 pmw_finish_run，结论到了工作台
//	readonly  只读生效：临时目录里的文件一个都没被改
//	persist   结论落库：检查记录（含结论）写进库再读回来一致
//	cancel    取消收尾：再起一次，起来后取消，按「已取消」收尾
//	timeout   超时收尾：再起一次，超时 3 秒，按「超时」收尾
//	cleanup   进程清理：三次执行收尾后各自的进程组都不在了
//
// 只在系统临时目录里新建的空目录里跑、只读档、固定提示词；不建任务、不写执行记录，
// 结论经 MCP 回到这里（handleFinishTaskRun 先认集成检查的 id）。最近一次的结果存在
// agent_settings 的 runner_smoke_deepseek 下，设置页打开时就能看到上次查的是什么。
//
// 异步：POST 起一次就回 202 和「进行中」的记录，前端轮询 GET 看每一项的进度。
// 同一时间只跑一次，正在跑时再 POST 回 409。

const (
	smokeSettingKey = "runner_smoke_deepseek"

	smokeMainTimeout   = 5 * time.Minute
	smokeTimeoutProbe  = 3 * time.Second
	smokeCancelAfter   = 2 * time.Second
	smokeCleanupWait   = 3 * time.Second
	smokeCheckDone     = "pass"
	smokeCheckFail     = "fail"
	smokeCheckSkip     = "skip"
	smokeCheckPending  = "pending"
	smokeCheckRunning  = "running"
	smokeStatusRunning = "running"
	smokeStatusPassed  = "passed"
	smokeStatusFailed  = "failed"
)

// SmokeCheck 是集成检查的一项。
type SmokeCheck struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	// Status：pending / running / pass / fail / skip
	Status string `json:"status"`
	Detail string `json:"detail"`
	Ms     int64  `json:"ms"`
}

// RunnerSmoke 是一次集成检查。
type RunnerSmoke struct {
	ID      string `json:"id"`
	Harness string `json:"harness"`
	// Status：running / passed（每一项都过了）/ failed
	Status       string     `json:"status"`
	StartedAt    time.Time  `json:"started_at"`
	FinishedAt   *time.Time `json:"finished_at"`
	Bin          string     `json:"bin"`
	Version      string     `json:"version"`
	ProviderID   string     `json:"provider_id"`
	ProviderName string     `json:"provider_name"`
	Model        string     `json:"model"`
	SessionID    string     `json:"session_id"`
	// Conclusion 是模型经 MCP 回报的结论；Answer 是它最后的答复（截到 2000 字）。
	Conclusion string       `json:"conclusion"`
	Answer     string       `json:"answer"`
	Checks     []SmokeCheck `json:"checks"`
}

var smokeCheckDefs = []struct{ key, label string }{
	{"spawn", "起进程"},
	{"model", "模型路由"},
	{"mcp", "MCP 回写"},
	{"readonly", "只读生效"},
	{"persist", "结论落库"},
	{"cancel", "取消收尾"},
	{"timeout", "超时收尾"},
	{"cleanup", "进程清理"},
}

// smokeState 是进程内的集成检查状态：正在跑的那次和它收到的 MCP 回报。
type smokeState struct {
	mu      sync.Mutex
	cur     *RunnerSmoke
	reports map[string]streamReport // 键是检查里那几次执行的 run id
}

func (st *smokeState) snapshot() *RunnerSmoke {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.cur == nil {
		return nil
	}
	cp := *st.cur
	cp.Checks = append([]SmokeCheck(nil), st.cur.Checks...)
	return &cp
}

// begin 占住「正在跑」；已经有一次在跑回 false。
func (st *smokeState) begin(sm *RunnerSmoke) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.cur != nil && st.cur.Status == smokeStatusRunning {
		return false
	}
	st.cur = sm
	st.reports = map[string]streamReport{}
	return true
}

func (st *smokeState) update(f func(*RunnerSmoke)) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.cur != nil {
		f(st.cur)
	}
}

func (st *smokeState) setCheck(key, status, detail string, ms int64) {
	st.update(func(sm *RunnerSmoke) {
		for i := range sm.Checks {
			if sm.Checks[i].Key == key {
				sm.Checks[i].Status, sm.Checks[i].Detail, sm.Checks[i].Ms = status, detail, ms
			}
		}
	})
}

// report 收 pmw_finish_run 的回报。是集成检查正在跑的执行就记下并回 true（第二次回报回 false, true）。
func (st *smokeState) report(runID string, rep streamReport) (accepted, mine bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.reports == nil || st.cur == nil || st.cur.Status != smokeStatusRunning {
		return false, false
	}
	if !strings.HasPrefix(runID, st.cur.ID) {
		return false, false
	}
	if _, dup := st.reports[runID]; dup {
		return false, true
	}
	st.reports[runID] = rep
	return true, true
}

func (st *smokeState) takeReport(runID string) (streamReport, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	rep, ok := st.reports[runID]
	return rep, ok
}

type smokeReq struct {
	ProviderID string `json:"provider_id"`
	Model      string `json:"model"`
}

func (s *Server) handleGetDeepSeekSmoke(w http.ResponseWriter, r *http.Request) {
	if cur := s.smoke.snapshot(); cur != nil {
		respondData(w, http.StatusOK, cur)
		return
	}
	raw, err := s.st.AgentSetting(r.Context(), smokeSettingKey)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if len(raw) == 0 {
		respondData(w, http.StatusOK, nil)
		return
	}
	var last RunnerSmoke
	if err := json.Unmarshal(raw, &last); err != nil {
		s.log.Warn("bad runner smoke setting", "err", err)
		respondData(w, http.StatusOK, nil)
		return
	}
	// 库里停在「进行中」而本进程手上没有：跑的时候工作台重启了
	if last.Status == smokeStatusRunning {
		last.Status = smokeStatusFailed
		for i := range last.Checks {
			if c := &last.Checks[i]; c.Status == smokeCheckPending || c.Status == smokeCheckRunning {
				c.Status, c.Detail = smokeCheckSkip, "工作台重启，这次检查被中断"
			}
		}
	}
	respondData(w, http.StatusOK, &last)
}

// handleStartDeepSeekSmoke 发起一次集成检查。服务商不可用（没有、停用、没模型、协议不支持）
// 在发起前回 400——那是设置问题，同分派；dsh 没装照样发起，「起进程」一项写明找不到。
func (s *Server) handleStartDeepSeekSmoke(w http.ResponseWriter, r *http.Request) {
	var req smokeReq
	if err := decodeOptionalBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	ctx := r.Context()
	route, err := s.deepseekRoute(ctx, req.ProviderID, req.Model)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	providerID, providerName := strings.TrimSpace(req.ProviderID), ""
	if providerID == "" {
		list, _ := s.st.ListProviders(ctx)
		if p, _ := pickDSHProvider(list); p != nil {
			providerID, providerName = p.ID, p.Name
		}
	} else if p, err := s.st.GetProvider(ctx, providerID); err == nil {
		providerName = p.Name
	}
	bin, _ := s.dshBin()
	info, _ := s.bins.get(ctx, "deepseek", bin, true)

	sm := &RunnerSmoke{
		ID: idgen.Prefixed("smk"), Harness: string(runner.HarnessDeepSeek), Status: smokeStatusRunning,
		StartedAt: time.Now().UTC(), Bin: firstNonEmptyStr(info.Path, bin), Version: info.Version,
		ProviderID: providerID, ProviderName: providerName, Model: route.Model,
	}
	for _, d := range smokeCheckDefs {
		sm.Checks = append(sm.Checks, SmokeCheck{Key: d.key, Label: d.label, Status: smokeCheckPending})
	}
	if !s.smoke.begin(sm) {
		s.fail(w, r, conflictf("已经有一次集成检查在跑了，等它跑完"))
		return
	}
	route.Bin = sm.Bin
	go s.runDeepSeekSmoke(context.WithoutCancel(ctx), sm.ID, route)
	respondData(w, http.StatusAccepted, s.smoke.snapshot())
}

// smokePrompt 是集成检查的固定提示词：只读、列目录、经 MCP 回写结论、一句话答复。
func smokePrompt(runID string) string {
	return fmt.Sprintf(`这是「产品工作台」对 DeepSeek 执行器的集成检查，只读，不要创建、修改或删除任何文件。
按顺序做三件事：
1. 用 bash 运行 ls，看当前目录里有哪些文件。
2. 调用工具 mcp__%[1]s__pmw_finish_run，参数 run_id="%[2]s"，status="done"，summary 写「目录里有：」加上文件名（用顿号分隔）。
3. 最后用一句话答复目录里有哪些文件。`, runner.MCPServer, runID)
}

// smokeFiles 是临时目录里预先放的文件：模型要列出它们，只读检查看它们有没有被改。
var smokeFiles = map[string]string{
	"README.md": "# 集成检查\n这个目录是工作台为 DeepSeek 执行器集成检查临时建的，检查完就删。\n",
	"probe.txt": "probe\n",
}

func (s *Server) runDeepSeekSmoke(ctx context.Context, id string, route *runner.DeepSeekRoute) {
	st := &s.smoke
	fail := func(key, detail string) { st.setCheck(key, smokeCheckFail, detail, 0) }
	defer s.finishSmoke(ctx)

	dir, err := os.MkdirTemp("", "pmw-dsh-smoke-")
	if err != nil {
		fail("spawn", "建临时目录失败："+err.Error())
		return
	}
	defer os.RemoveAll(dir)
	for name, body := range smokeFiles {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			fail("spawn", "写临时文件失败："+err.Error())
			return
		}
	}
	// macOS 的 /var/folders 是 /private/var 的软链接，按实际路径给，沙箱才认得工作区
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	mcp, noMCP := s.dshMCP()
	var pgids []int

	// 第一次：正式的一轮
	mainID := id + "_main"
	before := runner.TakeSnapshot(dir)
	for _, k := range []string{"spawn", "model", "mcp"} {
		st.setCheck(k, smokeCheckRunning, "", 0)
	}
	var answer strings.Builder
	tools := []string{}
	started := time.Now()
	var spawnedAt time.Time
	res, err := s.run.Start(ctx, runner.Request{
		RunID: mainID, Workdir: dir, Prompt: smokePrompt(mainID), Timeout: smokeMainTimeout,
		Harness: runner.HarnessDeepSeek, DeepSeek: route, MCP: mcp, Permission: runner.PermReadOnly,
		OnSpawn: func(pgid int) { pgids = append(pgids, pgid); spawnedAt = time.Now() },
	}, func(ev runner.Event) {
		switch ev.Type {
		case runner.EventDelta:
			if answer.Len() < 2000 {
				answer.WriteString(ev.Text)
			}
		case runner.EventTool:
			tools = append(tools, ev.Name)
		}
	})
	elapsed := time.Since(started).Milliseconds()
	rep, reported := st.takeReport(mainID)
	st.update(func(sm *RunnerSmoke) {
		sm.Answer = strings.TrimSpace(answer.String())
		if res != nil {
			sm.SessionID = res.SessionID
		}
		if reported {
			sm.Conclusion = rep.Summary
		}
	})
	if err != nil {
		fail("spawn", "dsh 没起来："+err.Error())
		for _, k := range []string{"model", "mcp", "readonly", "persist", "cancel", "timeout", "cleanup"} {
			st.setCheck(k, smokeCheckSkip, "进程没起来，跳过", 0)
		}
		return
	}
	if res.SessionID == "" {
		fail("spawn", firstNonEmptyStr("进程起来了但没开会话："+res.Error, "进程起来了但没开会话"))
	} else {
		st.setCheck("spawn", smokeCheckDone, "进程起来并开了会话 "+res.SessionID, spawnedAt.Sub(started).Milliseconds())
	}
	switch {
	case res.Status == domain.RunDone && (answer.Len() > 0 || len(tools) > 0):
		st.setCheck("model", smokeCheckDone, fmt.Sprintf("%s 正常收尾，调了 %d 次工具", route.Model, len(tools)), elapsed)
	case res.Status == domain.RunDone:
		fail("model", "正常收尾，但模型既没答复也没调工具")
	default:
		fail("model", firstNonEmptyStr(res.Error, "这一轮没有正常收尾"))
	}
	switch {
	case noMCP != "":
		fail("mcp", "工作台 MCP 没接上："+noMCP)
	case reported:
		st.setCheck("mcp", smokeCheckDone, "经 "+runner.MCPServer+" 回报："+oneLineStr(rep.Summary, 200), 0)
	case hasTool(tools, "pmw_finish_run"):
		fail("mcp", "模型调了 pmw_finish_run，但工作台没收到回报（看执行输出里那次工具调用的报错）")
	default:
		fail("mcp", fmt.Sprintf("模型没调 pmw_finish_run（调过的工具：%s）；换一个工具调用能力更强的模型再试", joinOr(tools, "无")))
	}

	// 只读：临时目录里的文件一个都没变
	if changed, _ := runner.Diff(before, runner.TakeSnapshot(dir)); len(changed) == 0 {
		st.setCheck("readonly", smokeCheckDone, "临时目录里的文件没被改动（dsh 沙箱 read-only）", 0)
	} else {
		paths := make([]string, 0, len(changed))
		for _, c := range changed {
			paths = append(paths, c.Path)
		}
		fail("readonly", "只读执行改了文件："+strings.Join(paths, "、"))
	}

	// 落库：把到这一步的记录写进库再读回来，结论要一致
	st.setCheck("persist", smokeCheckRunning, "", 0)
	if err := s.persistSmoke(ctx, false); err != nil {
		fail("persist", err.Error())
	} else {
		st.setCheck("persist", smokeCheckDone, "检查记录和结论写进库、读回一致", 0)
	}

	// 取消：起来 2 秒后取消
	st.setCheck("cancel", smokeCheckRunning, "", 0)
	cancelID := id + "_cancel"
	t0 := time.Now()
	cres, cerr := s.run.Start(ctx, runner.Request{
		RunID: cancelID, Workdir: dir, Prompt: "用 bash 运行 sleep 30，然后回答 ok。", Timeout: smokeMainTimeout,
		Harness: runner.HarnessDeepSeek, DeepSeek: route, Permission: runner.PermReadOnly,
		OnSpawn: func(pgid int) {
			pgids = append(pgids, pgid)
			time.AfterFunc(smokeCancelAfter, func() { s.run.Cancel(cancelID) })
		},
	}, nil)
	switch {
	case cerr != nil:
		fail("cancel", "没起来："+cerr.Error())
	case cres.Status == domain.RunCanceled:
		st.setCheck("cancel", smokeCheckDone, fmt.Sprintf("起来 %s 后取消，按「已取消」收尾", smokeCancelAfter), time.Since(t0).Milliseconds())
	default:
		fail("cancel", fmt.Sprintf("取消后收尾成了 %s：%s", cres.Status, cres.Error))
	}

	// 超时：3 秒上限
	st.setCheck("timeout", smokeCheckRunning, "", 0)
	t0 = time.Now()
	tres, terr := s.run.Start(ctx, runner.Request{
		RunID: id + "_timeout", Workdir: dir, Prompt: "用 bash 运行 sleep 30，然后回答 ok。", Timeout: smokeTimeoutProbe,
		Harness: runner.HarnessDeepSeek, DeepSeek: route, Permission: runner.PermReadOnly,
		OnSpawn: func(pgid int) { pgids = append(pgids, pgid) },
	}, nil)
	switch {
	case terr != nil:
		fail("timeout", "没起来："+terr.Error())
	case tres.Status == domain.RunFailed && strings.Contains(tres.Error, "超时"):
		st.setCheck("timeout", smokeCheckDone, fmt.Sprintf("上限 %s，到点终止并按「超时」收尾", smokeTimeoutProbe), time.Since(t0).Milliseconds())
	default:
		fail("timeout", fmt.Sprintf("上限 %s，收尾成了 %s：%s", smokeTimeoutProbe, tres.Status, tres.Error))
	}

	// 清理：每次执行的进程组都要不在了；还在的杀掉并判失败
	st.setCheck("cleanup", smokeCheckRunning, "", 0)
	var left []int
	for _, g := range pgids {
		if !waitGroupGone(g, smokeCleanupWait) {
			left = append(left, g)
			runner.KillProcessGroup(g)
		}
	}
	if len(pgids) == 0 {
		fail("cleanup", "没拿到进程组号，没法确认")
	} else if len(left) > 0 {
		fail("cleanup", fmt.Sprintf("%d 个进程组收尾 %s 后还有进程（%v），已强制结束", len(left), smokeCleanupWait, left))
	} else {
		st.setCheck("cleanup", smokeCheckDone, fmt.Sprintf("%d 次执行的进程组都已退干净", len(pgids)), 0)
	}
}

// finishSmoke 定总结论、写库、清掉「正在跑」。
func (s *Server) finishSmoke(ctx context.Context) {
	if err := s.persistSmoke(ctx, true); err != nil {
		s.log.Warn("save runner smoke failed", "err", err)
	}
}

// persistSmoke 把当前记录写进 agent_settings 再读回来比对结论。final 为真时先定总结论：
// 每一项都过了是 passed，否则 failed；没跑到的项记跳过。
func (s *Server) persistSmoke(ctx context.Context, final bool) error {
	if final {
		now := time.Now().UTC()
		s.smoke.update(func(sm *RunnerSmoke) {
			sm.Status = smokeStatusPassed
			for i := range sm.Checks {
				c := &sm.Checks[i]
				if c.Status == smokeCheckPending || c.Status == smokeCheckRunning {
					c.Status, c.Detail = smokeCheckSkip, firstNonEmptyStr(c.Detail, "没跑到")
				}
				if c.Status != smokeCheckDone {
					sm.Status = smokeStatusFailed
				}
			}
			sm.FinishedAt = &now
		})
	}
	sm := s.smoke.snapshot()
	if sm == nil {
		return nil
	}
	raw, err := json.Marshal(sm)
	if err != nil {
		return err
	}
	if err := s.st.SetAgentSetting(ctx, smokeSettingKey, raw); err != nil {
		return fmt.Errorf("写库失败：%w", err)
	}
	back, err := s.st.AgentSetting(ctx, smokeSettingKey)
	if err != nil {
		return fmt.Errorf("读回失败：%w", err)
	}
	var got RunnerSmoke
	if err := json.Unmarshal(back, &got); err != nil {
		return fmt.Errorf("读回的记录解析不了：%w", err)
	}
	if got.ID != sm.ID || got.Conclusion != sm.Conclusion {
		return fmt.Errorf("读回的记录和写进去的不一致")
	}
	return nil
}

func waitGroupGone(pgid int, wait time.Duration) bool {
	deadline := time.Now().Add(wait)
	for {
		if runner.ProcessGroupGone(pgid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func hasTool(tools []string, suffix string) bool {
	for _, t := range tools {
		if strings.HasSuffix(t, suffix) {
			return true
		}
	}
	return false
}

func joinOr(xs []string, empty string) string {
	if len(xs) == 0 {
		return empty
	}
	return strings.Join(xs, "、")
}

func oneLineStr(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
}
