// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	pmrunner "github.com/lizhao903/pm-workspace/internal/runner"
)

// Claude Code 执行节点（AUTO-01）：在 SOP 里交给本机 Claude Code 跑一次，等它结束，把结论交给下游。
//
// 经内核 Core.Runs().StartClaudeCode 发起（ReportBack：要 Claude Code 结束前用 pmw_finish_run 回报结论和结构化 result）；
// 配了关联任务时在任务上留执行记录（RecordOnTask）。发起后运行 id、关联任务落在步骤的 claude 上（StepClaude），步骤停在 running，
// 引擎起一个协程等：收到 run.finished（onRunFinished 唤醒）或每隔 claudePoll 看一次运行结束没有。
// 结束了：done 时步骤完成，输出是输入加 status、summary、result、run_id；失败、取消、超时步骤失败，可以重试。
// 终止执行、退回、重试时取消这次运行；服务重启后运行记录（只在内存里）没了，步骤失败，重试会重新执行。

const claudeKind = "claude_code"

// StepClaude 是 Claude Code 节点这一步发起的运行：运行 id、关联任务（在任务上留了执行记录时，界面据此跳到那次执行）、工作目录。
type StepClaude struct {
	RunID   string `json:"run_id"`
	TaskID  string `json:"task_id,omitempty"`
	Workdir string `json:"workdir,omitempty"`
}

// claudeDefaultTimeout 是没配超时的上限，claudeMaxTimeout 是能配的最大值。
const (
	claudeDefaultTimeout = 2 * time.Hour
	claudeMaxTimeout     = 24 * time.Hour
)

// claudePoll 是等 Claude Code 时兜底看一次运行的间隔，claudeGrace 是过了超时多久还没收尾就由 SOP 取消；测试里调小。
var (
	claudePoll  = 5 * time.Second
	claudeGrace = time.Minute
)

// claudeSummaryMax 是运行没回报摘要时，从过程记录末尾截给下游的字数。
const claudeSummaryMax = 1500

// claudeTimeout 解析「超时」，写法同等待节点；留空 2 小时，最多 24 小时。
func claudeTimeout(s string) (time.Duration, error) {
	if strings.TrimSpace(s) == "" {
		return claudeDefaultTimeout, nil
	}
	d, err := parseWait(s)
	if err != nil {
		return 0, fmt.Errorf("超时「%s」写法不对，要写成「30 分钟」「2 小时」这样", strings.TrimSpace(s))
	}
	if d <= 0 || d > claudeMaxTimeout {
		return 0, fmt.Errorf("超时要在 0 到 24 小时之间")
	}
	return d, nil
}

// checkClaude 是保存时对 Claude Code 节点配置的检查：权限只能是 read、write，超时写法要对。
func checkClaude(cfg map[string]string) []string {
	var out []string
	switch cfg["permission"] {
	case "", "read", "write":
	default:
		out = append(out, "权限只能是只读（read）或可写（write）")
	}
	if _, err := claudeTimeout(cfg["timeout"]); err != nil {
		out = append(out, err.Error())
	}
	return out
}

/* ---------- 唤醒 ---------- */

// claudeWaiters 是在等的 Claude Code 运行：run.finished 来了按运行 id 戳一下等它的协程。
type claudeWaiters struct {
	mu sync.Mutex
	m  map[string]chan struct{}
}

func (w *claudeWaiters) add(id string) (chan struct{}, func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.m == nil {
		w.m = map[string]chan struct{}{}
	}
	ch := make(chan struct{}, 1)
	w.m[id] = ch
	return ch, func() {
		w.mu.Lock()
		defer w.mu.Unlock()
		if w.m[id] == ch {
			delete(w.m, id)
		}
	}
}

func (w *claudeWaiters) poke(id string) {
	w.mu.Lock()
	ch := w.m[id]
	w.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- struct{}{}:
	default:
	}
}

// onRunFinished 是 run.finished 的处理：本插件发起的 Claude Code 运行结束了，叫醒等它的步骤。
// 内核的任务执行也叫 run.finished，对不上在等的运行 id 就什么都不做。
func (e *engine) onRunFinished(_ context.Context, _ plugin.Core, ev plugin.Event) error {
	var p struct {
		RunID string `json:"run_id"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.RunID == "" {
		return nil
	}
	e.claude.poke(p.RunID)
	return nil
}

/* ---------- 发起与等待 ---------- */

// startClaude 发起这一步的 Claude Code 运行，记下运行 id 后开始等。release 是占着的 Claude Code 并发名额（AUTO-12），
// 没发起成功时马上还，发起了等运行结束（或这一步被收掉）再还。发起前再按需求的次数、时长上限查一次，超了就暂停这一步。
func (r *runner) startClaude(ctx context.Context, i int, release func()) {
	s := &r.run.Steps[i]
	t := now()
	started := false
	defer func() {
		if !started {
			release()
		}
	}()
	def := r.defs[i]
	input := orEmpty(s.Input)
	var p claudeParams
	if def.Kind == taskRunKind {
		// 执行任务（TSK-0411，nodes_taskrun.go）：工作目录按任务 → 所属项目继承，提示词由任务拼
		var why string
		if p, why = taskRunParams(ctx, r.e.c, def, input); why != "" {
			r.claudeFail(i, t, why)
			return
		}
	} else {
		var ok bool
		if p, ok = r.claudeCodeParams(i, t, def, input); !ok {
			return
		}
	}
	workdir, task, preset, writes, follow, timeout := p.workdir, p.task, p.preset, p.writes, p.follow, p.timeout
	if r.holdIfOverBudget(ctx, i, task) {
		return
	}
	id, err := r.e.c.Runs().StartClaudeCode(ctx, plugin.ClaudeCodeStart{
		Workdir: workdir, Prompt: p.prompt, AllowWrites: writes, ObjectID: task, RecordOnTask: task != "",
		ReportBack: true, PresetID: preset, FollowPreset: follow, Timeout: timeout,
	})
	if err != nil {
		r.claudeFail(i, t, "交给 Claude Code 失败："+claudeStartErr(err))
		return
	}
	s.Claude = &StepClaude{RunID: id, TaskID: task, Workdir: workdir}
	started = true
	r.recordUsage(ctx, i, id, task, t)
	mode := "只读"
	switch {
	case follow:
		mode = "权限按角色 " + preset
	case writes:
		mode = "可写"
	}
	where := ""
	if task != "" {
		where = "，执行记录留在任务 " + task + " 上"
	}
	r.log(i, t, fmt.Sprintf("交给 Claude Code（执行 %s，%s，目录 %s，最多 %s%s），等它结束", id, mode, workdir, humanDuration(timeout), where))
	r.watchClaude(ctx, i, release)
}

// claudeCodeParams 是 claude_code 节点的发起参数，配置不对时让这一步失败、回 false。
func (r *runner) claudeCodeParams(i int, t time.Time, def stepDef, input Json) (claudeParams, bool) {
	s := &r.run.Steps[i]
	cfg := def.Config
	workdir := strings.TrimSpace(render(cfg["workdir"], input))
	if workdir == "" {
		r.fail(i, t, "工作目录是空的："+fieldHint(cfg["workdir"]))
		return claudeParams{}, false
	}
	prompt := strings.TrimSpace(render(cfg["prompt"], input))
	if prompt == "" {
		r.fail(i, t, "提示词是空的："+fieldHint(cfg["prompt"]))
		return claudeParams{}, false
	}
	timeout, err := claudeTimeout(cfg["timeout"])
	if err != nil {
		r.fail(i, t, err.Error())
		return claudeParams{}, false
	}
	// 被条件回退退回重做的那一步（AUTO-02，记着 rework_reason），把退回意见附在提示词后面，模板里没引用 feedback 也看得到；
	// 下游步骤的输入里也带着 feedback（透传），但不是退给它的，不附
	if fb, ok := input["feedback"].(map[string]any); ok && s.ReworkReason != "" && !strings.Contains(cfg["prompt"], "feedback") {
		prompt += feedbackSection(fb)
	}
	preset := strings.TrimSpace(cfg["preset"])
	// 权限留空、选了角色时按角色的权限（只读 / 可写）；角色只读时内核一律不放开写
	return claudeParams{
		workdir: workdir, prompt: prompt, task: strings.TrimSpace(render(cfg["task"], input)), preset: preset,
		writes: cfg["permission"] == "write", follow: cfg["permission"] == "" && preset != "", timeout: timeout,
	}, true
}

// claudeFail 是发起前、发起时失败：执行任务配了 on_fail=continue 时这一步照样完成，输出 status=failed 和原因，交给下游回报；
// 别的情况这一步失败。
func (r *runner) claudeFail(i int, t time.Time, why string) {
	if !taskRunContinue(r.defs[i]) {
		r.fail(i, t, why)
		return
	}
	s := &r.run.Steps[i]
	s.Status, s.Output, s.EndedAt = stDone, taskRunFailed(orEmpty(s.Input), why), &t
	r.log(i, t, "没能执行，按配置继续往下走："+why)
}

// fieldHint 说清空值从哪来：配置里引用了输入字段时提示字段取不到。
func fieldHint(tpl string) string {
	if strings.Contains(tpl, "{{") {
		return "配置「" + strings.TrimSpace(tpl) + "」引用的字段在输入里取不到"
	}
	return "还没配"
}

func claudeStartErr(err error) string {
	switch {
	case errors.Is(err, plugin.ErrNoClaudeRunner):
		return "本机 Claude Code 还没接上"
	case errors.Is(err, plugin.ErrNotGranted):
		return "可写模式要先在插件管理里给 SOP 插件确认「起子进程」（process:spawn）权限"
	}
	return err.Error()
}

func humanDuration(d time.Duration) string {
	switch {
	case d%time.Hour == 0:
		return fmt.Sprintf("%d 小时", int(d/time.Hour))
	case d%time.Minute == 0:
		return fmt.Sprintf("%d 分钟", int(d/time.Minute))
	}
	return d.String()
}

// watchClaude 起协程等这一步的 Claude Code 运行结束，结果按普通节点结果发回 runner。
// 协程被取消时：引擎还在（终止、退回、重试收掉了这一步）就取消那次运行；引擎停了（停用、关服务）不取消，恢复后接着等。
// 协程退出时还掉 Claude Code 并发名额，并在账本上记下这次运行的结束（AUTO-12；引擎停了不记，恢复后接着等的那次会记）。
func (r *runner) watchClaude(ctx context.Context, i int, release func()) {
	s := r.run.Steps[i]
	timeout, err := claudeTimeout(r.defs[i].Config["timeout"])
	if err != nil {
		timeout = claudeDefaultTimeout
	}
	started := now()
	if s.StartedAt != nil {
		started = *s.StartedAt
	}
	deadline := started.Add(timeout + claudeGrace)
	r.seq++
	token := r.seq
	sctx, cancel := context.WithCancel(ctx)
	r.inflight[i] = inflight{token: token, cancel: cancel}
	runID, input := s.Claude.RunID, orEmpty(clone(s.Input))
	cont := taskRunContinue(r.defs[i])
	runs := r.e.c.Runs()
	st := r.e.c.Store()
	poke, done := r.e.claude.add(runID)
	r.e.wg.Add(1)
	go func() {
		defer r.e.wg.Done()
		defer cancel()
		defer done()
		defer release()
		res, ok := waitClaude(sctx, runs, runID, input, deadline, poke)
		if !ok {
			if ctx.Err() == nil {
				// 这一步被收掉了，引擎还在：取消那次运行
				_ = runs.Cancel(runID)
				finishUsage(st, runID, usageCanceled)
			}
			return
		}
		if res.err != "" {
			finishUsage(st, runID, usageFailed)
			if cont {
				// 执行任务配了 on_fail=continue：执行失败也交给下游回报（TSK-0411）
				out := taskRunFailed(input, res.err)
				out["run_id"] = runID
				res = nodeResult{output: out, log: "Claude Code 没成功，按配置继续往下走：" + res.err}
			}
		} else {
			finishUsage(st, runID, usageDone)
		}
		select {
		case r.inbox <- resultMsg{step: i, token: token, res: res}:
		case <-sctx.Done():
		}
	}()
}

// waitClaude 等运行结束，回节点结果；ctx 取消时回 false。
func waitClaude(ctx context.Context, runs plugin.RunService, runID string, input Json, deadline time.Time, poke <-chan struct{}) (nodeResult, bool) {
	tick := time.NewTicker(claudePoll)
	defer tick.Stop()
	for {
		info, err := runs.Get(runID)
		switch {
		case errors.Is(err, plugin.ErrRunNotFound):
			return nodeResult{err: "这次 Claude Code 运行（" + runID + "）的结果拿不到了，工作台可能重启过；重试这一步会重新执行"}, true
		case err == nil && info.Finished:
			return claudeResult(info, input), true
		case now().After(deadline):
			_ = runs.Cancel(runID)
			return nodeResult{err: "Claude Code 超时没跑完，已取消这次运行"}, true
		}
		select {
		case <-ctx.Done():
			return nodeResult{}, false
		case <-poke:
		case <-tick.C:
		}
	}
}

// claudeResult 把结束的运行翻成节点结果：done 时输出是输入加 status、summary、result、run_id，
// 下游的条件分支能直接判断 result.verdict；别的结果这一步失败。
func claudeResult(info plugin.RunInfo, input Json) nodeResult {
	summary := info.Summary
	if summary == "" {
		// 没回报结论时取过程记录里的结论（最后一次工具调用之后的文字），不带执行过程（TSK-0470）
		summary = tail(pmrunner.Conclusion(info.Output), claudeSummaryMax)
	}
	if info.Status != plugin.RunDone {
		why := map[string]string{plugin.RunCanceled: "被取消", plugin.RunFailed: "失败"}[info.Status]
		if why == "" {
			why = "没成功（" + info.Status + "）"
		}
		msg := "Claude Code 执行" + why
		if e := strings.TrimSpace(info.Error); e != "" {
			msg += "：" + e
		}
		return nodeResult{err: msg}
	}
	var result any
	if info.Result != nil {
		b, _ := json.Marshal(info.Result)
		var m Json
		_ = json.Unmarshal(b, &m)
		result = m
	}
	out := with(input, "status", info.Status)
	out["summary"] = summary
	out["result"] = result
	out["run_id"] = info.ID
	log := "Claude Code 跑完了，没有回报结构化结论"
	if v, ok := info.Result["verdict"]; ok {
		log = fmt.Sprintf("Claude Code 跑完了，回报结论 %v", v)
	} else if info.Result != nil {
		log = "Claude Code 跑完了，回报了结构化结论"
	}
	return nodeResult{output: out, log: log}
}

// feedbackSection 是被退回重做时附在提示词后面的一节：第几轮、原因、上一轮的结论摘要和结构化结论。
func feedbackSection(fb Json) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\n\n## 上一轮被退回（这是第 %s 轮）\n", txt(fb["round"]))
	if r := txt(fb["reason"]); r != "" {
		b.WriteString("退回原因：" + r + "\n")
	}
	if sm := txt(fb["summary"]); sm != "" {
		b.WriteString("上一轮的意见：\n" + sm + "\n")
	}
	if res, ok := fb["result"].(map[string]any); ok {
		j, _ := json.MarshalIndent(res, "", "  ")
		b.WriteString("结构化意见：\n```json\n" + string(j) + "\n```\n")
	}
	b.WriteString("请逐条处理上面的意见后再交付。")
	return b.String()
}

func tail(s string, n int) string {
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return "…" + string(rs[len(rs)-n:])
}
