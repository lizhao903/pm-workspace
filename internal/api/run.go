package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/incident"
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
		// 终端执行（0048）的进程本来就不归工作台管，收尾靠 MCP 回写或手动标记，不在这里判失败。
		if run == nil || run.FinishedAt != nil || run.Mode == domain.RunModeTerminal || s.run.Running(run.ID) || s.agentTasks.running(run.ID) {
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
		var obj *domain.Object
		if o, err := s.st.GetObject(ctx, run.ObjectID); err == nil {
			obj = o
		}
		s.noteRunFailed(ctx, out, obj, false, -1, out.Error, out.Output)
	}
}

// noteRunFailed Claude Code 执行失败记一条运行异常（INC-01a）；取消不记。没接运行异常时什么都不做。
func (s *Server) noteRunFailed(ctx context.Context, run *domain.TaskRun, obj *domain.Object, allowWrites bool,
	exitCode int, errMsg, output string) {
	if s.opt.Incidents == nil || run == nil {
		return
	}
	c := incident.ClaudeRun{RunID: run.ID, ObjectID: run.ObjectID, Workdir: run.Workdir, ExitCode: exitCode,
		Error: errMsg, Output: output, AllowWrites: allowWrites, Via: "task"}
	if obj != nil {
		c.ObjectRef, c.ObjectTitle = obj.Ref, obj.Title
	}
	s.opt.Incidents.Note(ctx, incident.ClaudeRunReport(c))
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
	if run.Mode == domain.RunModeTerminal {
		// 终端里的进程不归工作台管：只把记录标成取消，终端标签和里面的 claude 照旧，用户自己关。
		out, err := s.st.FinishTaskRun(r.Context(), id, domain.RunCanceled, -1, run.Output,
			"在终端里执行的会话不归工作台管，记录已标记为取消；终端标签需要自己关")
		if err != nil {
			s.fail(w, r, err)
			return
		}
		s.dropHandoff(id)
		respondData(w, http.StatusOK, out)
		return
	}
	if s.run.Cancel(id) || s.agentTasks.cancel(id) {
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
	// PresetID 是选的角色（SPEC-tasks-6.18，AUTO-03），空表示不用；只读角色会把 AllowWrites 压成 false。
	PresetID string `json:"preset_id"`
	// Permission 是权限档位（TSK-0499）：read_only / accept_edits / edits_and_tests / custom。
	// 给了以它为准（AllowWrites 跟着档位走），没给按 AllowWrites；只读角色一律压成 read_only。只对 claude 生效。
	Permission string `json:"permission"`
	// Harness 是执行器：空或 claude 走本机 claude CLI，deepseek 走 deepseek-harness
	// 的 headless 模式（dsh）。别的值 400，不兜底成 claude——
	// 用户以为自己换了执行器其实没换，比直接报错更糟。
	Harness string `json:"harness"`
	// ProviderID 在 harness=deepseek 时是把哪个模型服务商交给 dsh，空用默认服务商；
	// harness=agent 时是这次用哪个服务商，空用 Agent 设置的。
	ProviderID string `json:"provider_id"`
	// ResumeSession 在 harness=deepseek / agent 时用：接着这个对象上一次同一执行器的会话继续跑。
	// 默认 false——续跑会把上一次的上下文一起带进来，那该是用户明确要的，
	// 而不是每次点「执行」都悄悄发生。
	ResumeSession bool `json:"resume_session"`

	// 以下只在 harness=agent（TSK-0460）时用，见 runagent.go。
	// AgentID 是交给哪个 Agent，空用场景「执行任务」选的，没选用第一个启用的；续跑时用上次会话的 Agent，这项忽略。
	AgentID string `json:"agent_id"`
	// Model 是这次用的模型，空用服务商（没给服务商时用 Agent）设置的。
	Model string `json:"model"`
	// MaxSteps / MaxMinutes 是步数和时长上限，ConfirmWaitMinutes 是等人确认多久后按拒绝处理；0 用默认值。
	MaxSteps           int `json:"max_steps"`
	MaxMinutes         int `json:"max_minutes"`
	ConfirmWaitMinutes int `json:"confirm_wait_minutes"`
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

	// 工作台 Agent 不起进程、工作目录可选，走自己的一支（runagent.go）
	if h, err := runner.ParseHarness(req.Harness); err == nil && h == runner.HarnessAgent {
		s.runObjectWithAgent(w, r, flusher, obj, req)
		return
	}

	workdir, err := s.workdirFor(ctx, objID, req.Workdir)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	// 提示词带上所属项目（文档、原型在哪里操作），和预览同一套拼法（runterminal.go）
	preset, err := s.presetOf(ctx, req.PresetID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 只读角色不放开文件编辑，勾了「允许写入」也不行（AUTO-03）；允许改文件的角色仍以请求里的为准，
	// 弹窗选角色时把勾选跟着角色走，用户还能取消。档位（TSK-0499）同理，只读角色压成 read_only。
	perm, err := effectivePerm(req.Permission, req.AllowWrites, preset != nil && preset.ReadOnly)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	req.AllowWrites = runner.PermWrites(perm)

	// 执行器和模型路由都必须在开流之前定死：这两样出错是「参数不对」，
	// 用户改一下就能重试，而 SSE 的响应头一旦发出去就只能当流里的 error。
	harness, err := runner.ParseHarness(req.Harness)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 交给 Claude Code 的才接工作台 MCP、按档位放行（TSK-0499）；dsh 没有这两样，提示词也不写回写一节。
	claude := harness != runner.HarnessDeepSeek
	var allowed []string
	if claude {
		perms, err := s.runPerms(ctx)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		allowed = runner.PermAllowed(perm, perms.Custom)
	}
	var wb *runner.WriteBack
	if claude {
		wb = &runner.WriteBack{RunID: previewRunID, ObjectID: obj.ID, Stream: true}
	}
	prompt := s.promptWith(ctx, obj, workdir, req.ExtraPrompt, preset, wb)
	var dsRoute *runner.DeepSeekRoute
	var sessionID string
	if harness == runner.HarnessDeepSeek {
		dsRoute, err = s.deepseekRoute(ctx, req.ProviderID)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if req.ResumeSession {
			sessionID, err = s.lastHarnessSession(ctx, objID, domain.RunHarnessDeepSeek)
			if err != nil {
				s.fail(w, r, err)
				return
			}
			if sessionID == "" {
				// 没有可续的会话不该静默新开一段：用户勾的是「接着上次」，
				// 悄悄变成新会话，他会以为上下文带过去了。
				s.fail(w, r, validationf("这个对象还没有可续的 DeepSeek 会话，先跑一次再续"))
				return
			}
		}
	}

	run, err := s.st.CreateTaskRun(ctx, &domain.TaskRun{
		ObjectID: objID,
		Workdir:  workdir,
		Prompt:   prompt,
		Status:   domain.RunRunning,
		Mode:     domain.RunModeStream,
		Harness:  string(harness),
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}

	// 工作台 MCP：配置写进数据目录的临时目录，执行收尾时删；接不上照跑，提示词写明原因。
	// 提示词要带执行 id，建记录之后重拼一次补进记录（同终端交接）。
	mcpPath, cleanupMCP := "", func() {}
	if claude {
		var noMCP string
		mcpPath, noMCP, cleanupMCP = s.streamMCP(run.ID)
		wb.RunID, wb.NoMCP = run.ID, noMCP
		if mcpPath != "" {
			allowed = append([]string{runner.MCPAllowRule()}, allowed...)
		} else {
			s.log.Warn("task run has no workbench mcp", "run", run.ID, "reason", noMCP)
		}
		prompt = s.promptWith(ctx, obj, workdir, req.ExtraPrompt, preset, wb)
		if err := s.st.SetTaskRunPrompt(ctx, run.ID, prompt); err != nil {
			s.log.Warn("task run prompt not saved", "run", run.ID, "err", err)
		}
	}
	defer cleanupMCP()

	s.markDoing(ctx, r, obj, cliExecutor(string(harness)))

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
		if err := writeRunSSE(w, ev); err != nil {
			// 丢一条事件不该中断整条流，但必须留痕——见 writeRunSSE 的注释。
			s.log.Error("run sse event dropped", "run", run.ID, "type", ev.Type, "err", err)
			return
		}
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

	// 执行前拍一张工作目录的快照，收尾时和执行后的比对，差集就是这次的产出。
	//
	// 必须在 Start 之前拍。放到 Start 之后的话，claude 启动最初那几百毫秒里写的
	// 文件会同时出现在两张快照里、大小和 mtime 也一致，差集为空——
	// 它们会被安静地漏掉，而且这个漏是随机的（取决于两边谁快）。
	before := runner.TakeSnapshot(workdir)

	res, err := s.run.Start(bg, runner.Request{
		RunID:        run.ID,
		Workdir:      workdir,
		Prompt:       prompt,
		AllowWrites:  req.AllowWrites,
		Harness:      harness,
		DeepSeek:     dsRoute,
		SessionID:    sessionID,
		MCPConfig:    mcpPath,
		AllowedTools: allowed,
		Permission:   perm,
	}, emit)
	// 经 MCP 回报的结论（pmw_finish_run）取走合进收尾结果；进程没起来时也要取，免得留在内存里。
	rep, reported := s.streamReports.take(run.ID)
	if err != nil {
		// 进程根本没起来。记录必须收尾，否则它会永远停在 running。
		s.log.Warn("task run failed to start", "run", run.ID, "object", objID, "err", err)
		s.finishRun(bg, run.ID, domain.RunFailed, -1, "", err.Error())
		s.noteRunFailed(bg, run, obj, req.AllowWrites, -1, err.Error(), "")
		emit(runner.Event{Type: runner.EventError, Message: err.Error()})
		emit(runner.Event{Type: runner.EventDone, RunID: run.ID, ExitCode: -1})
		return
	}

	if reported {
		applyStreamReport(res, rep)
	}

	// 会话 id 要赶在收尾之前落：下一次续跑靠它找上次的会话，
	// 而收尾（FinishTaskRun）之后就只剩 reading 的份了。
	if res.SessionID != "" {
		if err := s.st.SetTaskRunSession(bg, run.ID, res.SessionID); err != nil {
			s.log.Warn("save dsh session failed", "run", run.ID, "err", err)
		}
	}

	// 先落库再发 done：前端看到 done 就认为「这次执行已经留痕」，
	// 顺序反了的话，刷新页面会发现历史里根本没有刚跑完的那一条。
	if ferr := s.finishRun(bg, run.ID, res.Status, res.ExitCode, res.Output, res.Error); ferr != nil {
		emit(runner.Event{Type: runner.EventError, Message: "执行已结束，但记录落库失败：" + ferr.Error()})
	} else if res.Error != "" {
		emit(runner.Event{Type: runner.EventError, Message: res.Error})
	}
	if res.Status == domain.RunFailed {
		s.noteRunFailed(bg, run, obj, req.AllowWrites, res.ExitCode, res.Error, res.Output)
	}

	// 产物登记在 done 之前：done 的语义是「这次执行的一切都已留痕」。
	// 放到 done 之后的话，前端收到 done 就去刷产物列表，而登记还没写完，
	// 刷出来是空的——用户会以为这次执行什么都没产出。
	s.recordRunArtifacts(bg, run.ID, objID, workdir, before, emit)

	emit(runner.Event{Type: runner.EventDone, RunID: run.ID, ExitCode: res.ExitCode})
}

// recordRunArtifacts 把这次执行改动过的文件登记成产物，每条发一个 artifact 事件。
//
// 登记失败一律只记日志、不打断流：文件已经真的写出来了，一条索引没记上
// 不该让用户以为执行失败。这跟内置 agent 的 write_file 是同一个取舍。
func (s *Server) recordRunArtifacts(ctx context.Context, runID, objID, workdir string,
	before runner.Snapshot, emit func(runner.Event)) {

	changed, truncated := runner.Diff(before, runner.TakeSnapshot(workdir))
	if len(changed) == 0 {
		return
	}
	// 超过上限时必须说出来。安静地只记前 N 条，会让用户以为这次执行
	// 就产出了这些——而「产物清单是全的」正是这个功能的全部价值。
	if truncated {
		emit(runner.Event{Type: runner.EventError, Message: fmt.Sprintf(
			"这次执行改动的文件超过 %d 个，只登记了前 %d 个产物。"+
				"通常意味着工作目录选得太大，或者跑了一次构建。",
			runner.MaxRecordedArtifacts, runner.MaxRecordedArtifacts)})
	}

	for _, c := range changed {
		art, err := s.st.RecordArtifact(ctx, domain.ArtifactInput{
			ObjectID: &objID,
			RunID:    &runID,
			Path:     c.Path,
			BaseDir:  workdir,
			Platform: "local",
			Size:     c.Size,
			Source:   domain.ArtifactSourceRun,
		})
		if err != nil {
			s.log.Warn("record run artifact failed", "run", runID, "path", c.Path, "err", err)
			continue
		}
		emit(runner.Event{
			Type: runner.EventArtifact, ArtifactID: art.ID,
			Path: art.RelPath, Size: art.Size, IsNew: c.New,
		})
	}
}

// markDoing 交给 Claude Code（流式或终端）、DeepSeek、工作台 Agent 时把任务改成进行中（SPEC-tasks-6.17），
// 负责人设为这次的执行者（TSK-0500，SPEC-tasks-6.33）：只改任务，已完成、已取消的都不动；
// 待验收、受阻的重新交出去算重新开工。状态和负责人一次写，负责人变了另记一条进展。
// 改不动只记日志：执行已经建好了，不能因为状态没改成让这次执行起不来。
func (s *Server) markDoing(ctx context.Context, r *http.Request, o *domain.Object, ex runExecutor) {
	if o == nil || o.TypeID != "task" {
		return
	}
	switch o.Status {
	case "done", "cancelled":
		return
	}
	var p domain.ObjectPatch
	if o.Status != taskDoing {
		st := taskDoing
		p.Status = &st
	}
	// 负责人设为这次的执行者（TSK-0500）：原来是谁都覆盖，覆盖前是谁记进展；执行结束不改回。
	owner := s.runOwner(ctx, ex)
	prev, prevName := "", strings.TrimSpace(o.OwnerName)
	if o.OwnerID != nil {
		prev = *o.OwnerID
	}
	if owner != nil && owner.ID != prev {
		p.OwnerID = &owner.ID
	}
	if p.Status == nil && p.OwnerID == nil {
		return
	}
	if _, err := s.st.UpdateObject(ctx, o.ID, p, actorFrom(r)); err != nil {
		s.log.Warn("mark task doing on run failed", "object", o.ID, "err", err)
		return
	}
	if p.OwnerID != nil {
		text := fmt.Sprintf("负责人由「%s」改为「%s」（%s）", prevName, owner.Name, ex.label())
		if prevName == "" {
			text = fmt.Sprintf("负责人设为「%s」（%s）", owner.Name, ex.label())
		}
		if _, err := s.st.AppendProgress(ctx, o.ID, domain.ProgressInput{Kind: domain.ProgressNote, Text: text}, actorFrom(r)); err != nil {
			s.log.Warn("record run owner change failed", "object", o.ID, "err", err)
		}
	}
}

// taskDoing 是任务的「进行中」状态 key（0002_seed_types）。
const taskDoing = "doing"

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
	// 开发任务的约定字段，见 domain.PropAcceptance / PropRepo。不是字符串就当没有。
	t.Acceptance, _ = o.Props[domain.PropAcceptance].(string)
	t.Repo, _ = o.Props[domain.PropRepo].(string)
	if o.DueAt != nil {
		t.DueAt = o.DueAt.Local().Format("2006-01-02")
	}
	t.Source = imSourceOf(o)
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
// writeRunSSE 把一条事件写进流。序列化失败时返回 error 而不是静默丢掉。
//
// 原来这里是 `if err != nil { return }`。Event.MarshalJSON 对认不出的事件类型
// 会报错，于是新加一种事件、忘了在 MarshalJSON 里加分支时，那种事件就从流上
// 彻底消失——后端日志干净、前端没有报错、状态码 200，只是界面上少了一截。
// 这个坑真的踩到过（加 artifact 事件那次），排查花的时间远超这三行。
func writeRunSSE(w http.ResponseWriter, ev runner.Event) error {
	b, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("事件 %q 序列化失败: %w", ev.Type, err)
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
	return nil
}

// imSourceOf 从 props.source_ref 认出 IM 来源（IM 转任务时写的：message_id、channel、conversation、sender、text），
// reply_on_done 为真表示 IM 插件建了回执 SOP，执行完成会回复原消息。不是 IM 来的回 nil。
func imSourceOf(o *domain.Object) *runner.Source {
	ref, _ := o.Props[domain.PropSourceRef].(map[string]any)
	if ref == nil {
		return nil
	}
	str := func(k string) string { v, _ := ref[k].(string); return strings.TrimSpace(v) }
	if str("message_id") == "" {
		return nil
	}
	reply, _ := ref["reply_on_done"].(bool)
	return &runner.Source{Channel: str("channel"), Conversation: str("conversation"), Sender: str("sender"), Text: str("text"), Reply: reply}
}

// deepseekRoute 把工作台的模型服务商翻译成 dsh 的模型路由。
//
// 为什么要翻译：dsh 读不到工作台的库，它只认自己 profile 里的 provider 配置。
// 所以每次执行现生成一份临时 patch（见 internal/runner 的 writeDSHPatch），
// 服务商地址、模型、密钥都从工作台这一侧带过去——密钥只经进程环境，
// 不落文件、不进命令行。
func (s *Server) deepseekRoute(ctx context.Context, providerID string) (*runner.DeepSeekRoute, error) {
	p, err := s.resolveProvider(ctx, providerID)
	if err != nil {
		return nil, err
	}
	key, err := s.st.ProviderAPIKey(ctx, p.ID)
	if err != nil {
		return nil, err
	}
	route := &runner.DeepSeekRoute{
		Kind:    p.Kind,
		BaseURL: p.BaseURL,
		Model:   p.Model,
		APIKey:  key,
	}
	// 在这里就把「这条路由 dsh 能不能用」判掉：协议不支持、没设模型这类问题
	// 用户改一下设置就能重试，不该变成流里的一条 error。
	if err := route.Validate(); err != nil {
		return nil, err
	}
	return route, nil
}

// lastHarnessSession 找这个对象上一次用这个执行器（deepseek / agent）的执行留下的会话 id，给续跑用。
//
// 不新加一个 store 方法：执行历史本来就能按对象列最近 N 条，
// 而「最近一条带会话的同执行器执行」拿几十条就够（中间夹着别的执行器的执行很正常）。
func (s *Server) lastHarnessSession(ctx context.Context, objectID, harness string) (string, error) {
	runs, err := s.st.ListTaskRuns(ctx, objectID, 20)
	if err != nil {
		return "", err
	}
	for _, run := range runs {
		if run.Harness == harness && strings.TrimSpace(run.HarnessSession) != "" {
			return run.HarnessSession, nil
		}
	}
	return "", nil
}
