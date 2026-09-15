package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/store"
)

const (
	maxRunLimit = 100

	// staleRunGrace 是「多久没收尾才算残留」的门槛。
	//
	// 它存在只为了避开一个窄窗口：CreateTaskRun 之后、runner 把进程登记进
	// 活进程表之前，这条记录在库里已经是 running，但 Running() 还回 false。
	// 那段窗口只有起进程那么长（毫秒级），一分钟的余量足够宽。
	// 代价是工作台重启后的头一分钟内，残留记录还会显示成「进行中」。
	staleRunGrace = time.Minute
)

// conflictf 构造 409。respond.go 只给了 validation 和 not_found 两个构造器，
// 取消一次已经结束的执行正好是第三种。
func conflictf(format string, a ...any) error {
	return &apiError{msg: fmt.Sprintf(format, a...), err: domain.ErrConflict}
}

// --- 历史记录 ---

func (s *Server) handleListTaskRuns(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// 先确认对象存在：直接查执行记录的话，一个不存在的对象会安静地回一个空列表。
	if _, err := s.st.GetObject(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	limit, err := newParams(r).limit("limit", store.DefaultRunLimit, maxRunLimit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.st.ListTaskRuns(r.Context(), id, limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.reapStale(r.Context(), items)
	respondList(w, nonNil(items), Meta{Total: len(items), Limit: limit})
}

func (s *Server) handleGetTaskRun(w http.ResponseWriter, r *http.Request) {
	run, err := s.st.GetTaskRun(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.reapStale(r.Context(), []*domain.TaskRun{run})
	respondData(w, http.StatusOK, run)
}

// reapStale 把「库里写着在跑、但本进程手上没有」的执行记录收尾成 failed，
// 并就地改掉传进来的那几条，让这次响应就是修好之后的样子。
//
// 为什么需要：进程活在内存里，记录活在库里。工作台一重启，上一轮还在跑的
// 执行就永远停在 running——界面上那条记录会一直转圈，而且它也永远不会被取消
// （Cancel 找不到对应的进程）。没人会去手工改库，所以只能由读取方顺手修。
//
// 为什么放在读取路径而不是启动时扫一遍：`Open` 之后扫一遍要动 cmd/ 和 store
// 契约，而这两处都不归这条线管；惰性修的效果一样（用户只有打开面板才看得见
// 那条记录），代价只是多一次写。
func (s *Server) reapStale(ctx context.Context, runs []*domain.TaskRun) {
	for _, run := range runs {
		if run == nil || run.FinishedAt != nil || s.run.Running(run.ID) {
			continue
		}
		if time.Since(run.StartedAt) < staleRunGrace {
			continue
		}
		out, err := s.st.FinishTaskRun(ctx, run.ID, domain.RunFailed, -1, run.Output,
			"工作台重启，这次执行被中断（进程已不在）")
		if err != nil {
			// 修不动就算了，下次读还会再试。最坏情况是界面上多转一会儿圈，
			// 为此让「查看历史」整个失败是不划算的。
			s.log.Warn("reap stale task run failed", "run", run.ID, "err", err)
			continue
		}
		*run = *out
	}
}

// handleCancelTaskRun 停掉一次正在跑的执行。
//
// 只发出取消请求就返回，不等进程真的死：SIGTERM 到 SIGKILL 之间有几秒宽限期，
// 让用户的「取消」按钮转三秒圈毫无必要。真正的收尾（落库）在流那一侧完成。
func (s *Server) handleCancelTaskRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	run, err := s.st.GetTaskRun(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if run.FinishedAt != nil {
		s.fail(w, r, conflictf("这次执行已经结束了，无需取消"))
		return
	}
	if s.run.Cancel(id) {
		respondData(w, http.StatusOK, run)
		return
	}

	// 库里写着在跑，但本进程手上没有它：工作台重启过，那个进程（如果还活着）
	// 已经不归我们管。不能就这么把记录晾在 running 上——那样它永远不会收尾，
	// 详情面板会一直转圈。标成取消并说清原因，是这里唯一诚实的做法。
	out, err := s.st.FinishTaskRun(r.Context(), id, domain.RunCanceled, -1,
		run.Output, "执行进程已不存在（工作台可能重启过），记录已标记为取消")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

// --- 执行 ---

type runObjectReq struct {
	Workdir     string `json:"workdir"`
	ExtraPrompt string `json:"extra_prompt"`
	// AllowWrites 必须由用户在界面上显式勾选，默认 false。
	// 我们不替用户放宽 claude 的安全边界——那个决定只能他自己做。
	AllowWrites bool `json:"allow_writes"`
}

// handleRunObject 把一个工作对象交给本机 claude 执行，过程以 SSE 流式回推。
//
// 错误处理在这里是两段式的：SSE 的响应头一旦发出就改不了状态码，所以
// 「还没开始写流」的那几步（对象不存在、没有工作区、目录不可用、建记录失败）
// 走普通 JSON 错误，之后的一切只能作为 error 事件写进流里。
func (s *Server) handleRunObject(w http.ResponseWriter, r *http.Request) {
	var req runObjectReq
	// workdir 和 extra_prompt 都可选，空 body 等同于「就按这条任务本身跑」。
	if err := decodeOptionalBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	// 没有 Flusher 就没法做流式，这种情况只可能是中间件包错了，属于服务端 bug。
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.fail(w, r, fmt.Errorf("response writer does not support streaming"))
		return
	}

	ctx := r.Context()
	objID := r.PathValue("id")
	obj, err := s.st.GetObject(ctx, objID)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	workdir, err := s.workdirFor(ctx, objID, req.Workdir)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	prompt := runner.BuildPrompt(s.taskOf(ctx, obj, workdir, req.ExtraPrompt))
	run, err := s.st.CreateTaskRun(ctx, &domain.TaskRun{
		ObjectID: objID,
		Workdir:  workdir,
		Prompt:   prompt,
		Status:   domain.RunRunning,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}

	// 从这里开始就是流了。
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// 关掉 nginx 一类反代的缓冲，否则增量会被攒起来一次性吐出，流式就白做了。
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	emit := func(ev runner.Event) {
		writeRunSSE(w, ev)
		flusher.Flush()
	}

	// 先导事件：先于一切内容发出去，而且发的时候库里已经有这条记录了。
	//
	// 前端必须尽早拿到 run_id，否则「停止」按钮只能靠「查这个对象里状态是
	// running 的那条」去猜——同一个对象上有两次执行在跑（或者上一次的记录还没
	// 收尾）时就会挑错，停掉别人。
	//
	// workdir 一起给：用户没传时它是 ResolveWorkdir 从所属项目继承来的，
	// 只有后端知道最终解析成了哪个目录，而界面要显示「正在 XXX 里执行」。
	emit(runner.Event{Type: runner.EventStart, RunID: run.ID, Workdir: workdir})

	// 客户端断开不该连带杀掉 claude：它可能已经改了一半文件，而且这条记录
	// 还没收尾。让进程跑完把结果落库，用户想停有 /cancel 接口——
	// 这正是「长跑的进程不能只靠用户关页面」那条要求的另一面。
	bg := context.WithoutCancel(ctx)

	res, err := s.run.Start(bg, runner.Request{
		RunID:       run.ID,
		Workdir:     workdir,
		Prompt:      prompt,
		AllowWrites: req.AllowWrites,
	}, emit)
	if err != nil {
		// 进程根本没起来。记录必须收尾，否则它会永远停在 running。
		s.log.Warn("task run failed to start", "run", run.ID, "object", objID, "err", err)
		s.finishRun(bg, run.ID, domain.RunFailed, -1, "", err.Error())
		emit(runner.Event{Type: runner.EventError, Message: err.Error()})
		emit(runner.Event{Type: runner.EventDone, RunID: run.ID, ExitCode: -1})
		return
	}

	// 先落库再发 done：前端看到 done 就认为「这次执行已经留痕」，
	// 顺序反了的话，刷新页面会发现历史里根本没有刚跑完的那一条。
	if ferr := s.finishRun(bg, run.ID, res.Status, res.ExitCode, res.Output, res.Error); ferr != nil {
		emit(runner.Event{Type: runner.EventError, Message: "执行已结束，但记录落库失败：" + ferr.Error()})
	} else if res.Error != "" {
		emit(runner.Event{Type: runner.EventError, Message: res.Error})
	}
	emit(runner.Event{Type: runner.EventDone, RunID: run.ID, ExitCode: res.ExitCode})
}

// finishRun 收尾并把失败记进日志。落库失败不该让流断掉——过程已经发生了，
// 用户至少要能在界面上看完它。
func (s *Server) finishRun(ctx context.Context, runID, status string, exitCode int, output, errMsg string) error {
	if _, err := s.st.FinishTaskRun(ctx, runID, status, exitCode, output, errMsg); err != nil {
		s.log.Error("finish task run failed", "run", runID, "status", status, "err", err)
		return err
	}
	return nil
}

// workdirFor 定出这次执行的落脚目录：请求里带了就用它，否则问 store 要
// 这个对象的有效工作区（自身没设时回退到所属项目的）。
//
// 拿不到目录是硬错误。退化成进程的当前目录意味着 claude 会在工作台自己的
// 源码目录里动手，这是绝对不能有的默认值。
func (s *Server) workdirFor(ctx context.Context, objID, given string) (string, error) {
	wd := strings.TrimSpace(given)
	if wd == "" {
		resolved, err := s.st.ResolveWorkdir(ctx, objID)
		if err != nil {
			return "", err
		}
		wd = strings.TrimSpace(resolved)
	}
	// CheckWorkdir 对空串回的就是那句「请先为这个任务或它所属的项目设置工作区目录」。
	return runner.CheckWorkdir(wd)
}

// taskOf 把工作对象整理成喂给 claude 的任务描述。
//
// 类型名与状态标签要查一次 object_types：提示词里写「doing」不如写「进行中」，
// 模型对人类语言的理解远好于对我们内部 key 的理解。查不到就退回用 key，
// 不能因为拼提示词的辅助信息缺失就让整次执行起不来。
func (s *Server) taskOf(ctx context.Context, o *domain.Object, workdir, extra string) runner.Task {
	t := runner.Task{
		Ref:      o.Ref,
		Title:    o.Title,
		Body:     o.Body,
		Status:   o.Status,
		Priority: o.Priority,
		Workdir:  workdir,
		Extra:    extra,
	}
	if o.DueAt != nil {
		t.DueAt = o.DueAt.Local().Format("2006-01-02")
	}
	if ot, err := s.st.GetObjectType(ctx, o.TypeID); err == nil && ot != nil {
		t.TypeName = ot.Name
		for _, st := range ot.Statuses {
			if st.Key == o.Status && st.Label != "" {
				t.Status = st.Label
				break
			}
		}
	}
	if links, err := s.st.ListLinks(ctx, o.ID); err == nil {
		for _, l := range links {
			if l.Peer == nil {
				continue
			}
			label := strings.TrimSpace(l.Peer.Ref + " " + l.Peer.Title)
			if l.Relation != "" {
				label = l.Relation + "：" + label
			}
			t.Links = append(t.Links, label)
		}
	}
	return t
}

// writeRunSSE 写一条 SSE 事件。事件类型放在 JSON 的 type 字段里而不是 SSE 的
// event: 行，前端只需监听默认的 message 事件按 type 分发（契约见 types.ts 的 TaskRunEvent）。
func writeRunSSE(w http.ResponseWriter, ev runner.Event) {
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
}
