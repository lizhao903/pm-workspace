// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// 交给 Claude Code 的两种方式（0048）：流式执行走 run.go，这里是另外三件事——
//   - 提示词预览：弹窗里看将要发给 Claude Code 的完整提示词，和真发起时同一套拼法；
//   - 切换到终端：建一条 mode=terminal 的执行记录，把提示词和接回工作台的 MCP 配置写成临时文件，
//     前端再让终端插件开标签执行用户配的启动命令（命令只在用户点击后执行）；
//   - 收尾：终端里的 claude 经 MCP（pmw_finish_run）回写结论，或用户手动「标记结束」。
//
// 临时文件放在数据目录下的 tmp/handoff/<执行 id>/，不进仓库；执行收尾时删掉，
// 发起新的终端执行时顺手清掉超过 handoffKeep 的残留（没收尾就被丢下的那些）。

const (
	// handoffSubdir 是临时文件在数据目录下的位置。
	handoffSubdir = "tmp/handoff"
	// handoffKeep 是残留的临时目录留多久。终端会话可能开很久，一天不够稳妥。
	handoffKeep = 7 * 24 * time.Hour
	// maxRunSummary 是收尾时结论摘要的上限，和一次流式输出落库的量级一致就够了。
	maxRunSummary = 200 << 10
	// previewRunID 是预览时执行 id 的占位：真发起时才有 id。
	previewRunID = "<发起时生成的执行 id>"
	// MCPServerName 是写进 MCP 配置的 server 名，提示词里也按这个名字说。
	// 终端交接、后台执行、插件运行共用 runner.MCPServer（TSK-0499）：不叫 pm-workspace，
	// 免得和工作目录里 .mcp.json 的同名 server（可能指向别的工作台）撞名。
	MCPServerName = runner.MCPServer
)

// projectOf 拼任务所属项目的上下文；没挂项目、项目已删时回 nil。
//
// 文档目录取项目设置里的文档目录（props.docs_dir，TSK-0718），没设时取 props.related 的第一个关联目录；原型目录经插件钩子问项目插件
// （原型登记在它自己的表里）。项目插件没启用或查询出错时按「没有登记原型目录」写，
// 不能因为辅助信息缺失让整次执行起不来。
func (s *Server) projectOf(ctx context.Context, o *domain.Object) *runner.Project {
	if o.ProjectID == nil || strings.TrimSpace(*o.ProjectID) == "" {
		return nil
	}
	p, err := s.st.GetObject(ctx, *o.ProjectID)
	if err != nil || p == nil || p.DeletedAt != nil {
		return nil
	}
	out := &runner.Project{Name: p.Title, Ref: p.Ref, Workdir: strings.TrimSpace(p.Workdir)}
	// 项目设置里的文档目录优先（TSK-0718）；没设（或相对路径但没项目目录）时退回第一个关联目录
	if _, abs, err := projectDocsDir(p); err == nil && abs != "" {
		out.DocsDir, out.DocsSetting = abs, true
	} else {
		out.DocsDir, out.DocsLabel = firstRelated(p.Props)
	}
	if s.opt.Plugins != nil {
		protos, err := s.opt.Plugins.ProjectPrototypes(ctx, p.ID)
		if err != nil && !errors.Is(err, plugin.ErrNoProjectPrototypes) {
			s.log.Warn("list project prototypes failed", "project", p.ID, "err", err)
		}
		for _, x := range protos {
			if d := strings.TrimSpace(x.Dir); d != "" {
				out.Prototypes = append(out.Prototypes, runner.PrototypeDir{Name: strings.TrimSpace(x.Name), Dir: d})
			}
		}
	}
	return out
}

// firstRelated 取 props.related（[{path, label}]）里第一个有路径的目录；file:// 地址转成本机路径。
func firstRelated(props map[string]any) (string, string) {
	list, _ := props["related"].([]any)
	for _, it := range list {
		m, _ := it.(map[string]any)
		path, _ := m["path"].(string)
		path = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(path), "file://"))
		if path == "" {
			continue
		}
		label, _ := m["label"].(string)
		return path, strings.TrimSpace(label)
	}
	return "", ""
}

// promptFor 是两种方式共用的提示词拼法：任务本身加所属项目，再加回写一节——
// 终端方式按交互执行写；流式（后台执行 Claude Code）按无人值守写，MCP 接不上时写明原因（TSK-0499）。
func (s *Server) promptFor(ctx context.Context, o *domain.Object, workdir, extra, mode, runID string, preset *runner.Preset) string {
	var wb *runner.WriteBack
	switch mode {
	case domain.RunModeTerminal:
		wb = &runner.WriteBack{RunID: runID, ObjectID: o.ID}
	case domain.RunModeStream:
		if runID == "" {
			runID = previewRunID
		}
		wb = &runner.WriteBack{RunID: runID, ObjectID: o.ID, Stream: true}
		if err := runner.CheckMCP(s.opt.MCPBin, s.opt.PublicURL); err != nil {
			wb.NoMCP = err.Error()
		}
	}
	return s.promptWith(ctx, o, workdir, extra, preset, wb)
}

// promptWith 拼提示词，回写一节由调用方给（nil 不写，如交给 DeepSeek 的执行：dsh 没有工作台 MCP）。
func (s *Server) promptWith(ctx context.Context, o *domain.Object, workdir, extra string, preset *runner.Preset, wb *runner.WriteBack) string {
	t := s.taskOf(ctx, o, workdir, extra)
	t.Project = s.projectOf(ctx, o)
	t.Preset = preset
	t.WriteBack = wb
	return runner.BuildPrompt(t)
}

// handleRunPrompt 预览提示词：GET /api/objects/{id}/run/prompt?mode=&workdir=&extra_prompt=。
//
// 只拼不校验目录：用户还在弹窗里改目录，目录不可用时发起那一步会拦。
// workdir 不传时同发起，按任务、所属项目逐级继承。
func (s *Server) handleRunPrompt(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	mode := strings.TrimSpace(q.Get("mode"))
	if mode == "" {
		mode = domain.RunModeStream
	}
	if mode != domain.RunModeStream && mode != domain.RunModeTerminal {
		s.fail(w, r, validationf("mode 只能是 stream 或 terminal"))
		return
	}
	o, err := s.st.GetObject(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	wd := strings.TrimSpace(q.Get("workdir"))
	if wd == "" {
		if wd, err = s.st.ResolveWorkdir(ctx, o.ID); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	preset, err := s.presetOf(ctx, q.Get("preset_id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// harness=agent（TSK-0460）预览交给工作台 Agent 的那一份；resume=true 是续跑的说法
	var prompt string
	switch strings.TrimSpace(q.Get("harness")) {
	case string(runner.HarnessAgent):
		prompt = s.agentPromptFor(ctx, o, strings.TrimSpace(wd), q.Get("extra_prompt"), preset, q.Get("resume") == "true")
	case string(runner.HarnessDeepSeek):
		// dsh 也接工作台 MCP（TSK-0722）：回写一节按后台执行口径、权限说法换成 dsh 沙箱（同 run.go）
		_, noMCP := s.dshMCP()
		wb := &runner.WriteBack{RunID: previewRunID, ObjectID: o.ID, Stream: true, DSH: true, NoMCP: noMCP}
		prompt = s.promptWith(ctx, o, strings.TrimSpace(wd), q.Get("extra_prompt"), preset, wb)
		// 预览要和后台执行一致（0058）：deepseek 的提示词开头也拼模块简报。
		// 预览只算 key 和 seed，不写执行记录；claude / agent 预览不加。
		if _, prefix, _ := s.modulePrefixForRun(ctx, o, strings.TrimSpace(wd)); prefix != "" {
			prompt = modulePrompt(prefix, prompt)
		}
	default:
		prompt = s.promptFor(ctx, o, strings.TrimSpace(wd), q.Get("extra_prompt"), mode, previewRunID, preset)
	}
	respondData(w, http.StatusOK, map[string]string{"prompt": prompt, "workdir": strings.TrimSpace(wd)})
}

type runTerminalReq struct {
	Workdir     string `json:"workdir"`
	ExtraPrompt string `json:"extra_prompt"`
	PresetID    string `json:"preset_id"`
}

// TerminalHandoff 是 POST /api/objects/{id}/run/terminal 的响应：执行记录和交给终端的两个文件。
type TerminalHandoff struct {
	Run        *domain.TaskRun `json:"run"`
	Workdir    string          `json:"workdir"`
	PromptFile string          `json:"prompt_file"`
	MCPConfig  string          `json:"mcp_config"`
}

// handleRunTerminal 发起一次终端执行：建记录、写提示词和 MCP 配置，不起任何进程。
// 真正执行的是前端随后让终端插件开的那个标签——命令只在用户点击后执行。
func (s *Server) handleRunTerminal(w http.ResponseWriter, r *http.Request) {
	var req runTerminalReq
	if err := decodeOptionalBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	ctx := r.Context()
	o, err := s.st.GetObject(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	workdir, err := s.workdirFor(ctx, o.ID, req.Workdir)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	preset, err := s.presetOf(ctx, req.PresetID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	mcpBin, err := s.mcpBin()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	root, err := s.handoffRoot()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	cleanHandoff(root, time.Now(), handoffKeep, s.log)

	// 先建记录拿到 id，提示词里要写它；提示词随后补进记录（建记录时先写不带 id 的版本兜底）。
	run, err := s.st.CreateTaskRun(ctx, &domain.TaskRun{
		ObjectID: o.ID, Workdir: workdir, Status: domain.RunRunning, Mode: domain.RunModeTerminal,
		Prompt: s.promptFor(ctx, o, workdir, req.ExtraPrompt, domain.RunModeTerminal, previewRunID, preset),
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	prompt := s.promptFor(ctx, o, workdir, req.ExtraPrompt, domain.RunModeTerminal, run.ID, preset)
	run.Prompt = prompt

	dir := filepath.Join(root, run.ID)
	promptFile, mcpFile, werr := writeHandoff(dir, prompt, MCPConfig(mcpBin, s.opt.PublicURL))
	if werr == nil {
		werr = s.st.SetTaskRunPrompt(ctx, run.ID, prompt)
	}
	if werr != nil {
		// 文件没写成，这条记录不能晾在进行中。
		s.log.Error("write terminal handoff failed", "run", run.ID, "err", werr)
		_ = os.RemoveAll(dir)
		_, _ = s.st.FinishTaskRun(context.WithoutCancel(ctx), run.ID, domain.RunFailed, -1, "", "准备终端执行的临时文件失败")
		s.fail(w, r, werr)
		return
	}
	s.markDoing(ctx, r, o, cliExecutor(domain.RunHarnessClaude))
	respondData(w, http.StatusCreated, TerminalHandoff{Run: run, Workdir: workdir, PromptFile: promptFile, MCPConfig: mcpFile})
}

type finishRunReq struct {
	Status  string `json:"status"`
	Summary string `json:"summary"`
	// Result 是结构化结论（AUTO-01），JSON 对象，如 {verdict, issues, artifacts}；只对插件交给 Claude Code 的运行生效
	Result json.RawMessage `json:"result"`
}

// maxRunResult 是结构化结论的上限。
const maxRunResult = 64 << 10

// handleFinishTaskRun 给终端执行收尾：POST /api/runs/{id}/finish {status, summary?}。
// 终端里的 claude 经 MCP 的 pmw_finish_run 调它，界面上的「标记结束」也调它。
// 流式执行由工作台自己收尾：还在跑时只记下回报的结论（TSK-0499），进程退出收尾时放在输出最前面；
// 已经结束的、或不是这个工作台进程在跑的回 409。
func (s *Server) handleFinishTaskRun(w http.ResponseWriter, r *http.Request) {
	var req finishRunReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	status := strings.TrimSpace(req.Status)
	switch status {
	case domain.RunDone, domain.RunFailed, domain.RunCanceled:
	default:
		s.fail(w, r, validationf("status 只能是 done、failed 或 canceled"))
		return
	}
	summary := strings.TrimSpace(req.Summary)
	if len(summary) > maxRunSummary {
		s.fail(w, r, validationf("summary 最多 %d KB", maxRunSummary>>10))
		return
	}
	if !utf8.ValidString(summary) {
		s.fail(w, r, validationf("summary 要是 UTF-8 文本"))
		return
	}
	var result map[string]any
	if raw := strings.TrimSpace(string(req.Result)); raw != "" && raw != "null" {
		if len(raw) > maxRunResult {
			s.fail(w, r, validationf("result 最多 %d KB", maxRunResult>>10))
			return
		}
		if err := json.Unmarshal(req.Result, &result); err != nil || result == nil {
			s.fail(w, r, validationf("result 要是 JSON 对象"))
			return
		}
	}
	ctx := r.Context()
	id := r.PathValue("id")
	// 插件交给 Claude Code 的运行（SOP 的 Claude Code 节点，AUTO-01）：只记下回报，进程退出时由内核收尾
	if s.opt.Plugins != nil {
		info, perr := s.opt.Plugins.ReportRun(id, status, summary, result)
		switch {
		case perr == nil:
			respondData(w, http.StatusOK, s.reportedRun(ctx, info))
			return
		case errors.Is(perr, plugin.ErrRunEnded):
			s.fail(w, r, conflictf("这次执行已经结束了，或者已经回报过结论"))
			return
		case !errors.Is(perr, plugin.ErrRunNotFound):
			s.fail(w, r, conflictf("%s", perr.Error()))
			return
		}
	}
	// 执行器集成检查（TSK-0722，runnersmoke.go）里那几次 dsh 执行：不在 task_runs 里，结论记在检查上
	if ok, mine := s.smoke.report(id, streamReport{Status: status, Summary: summary}); mine {
		if !ok {
			s.fail(w, r, conflictf("这次执行已经回报过结论了"))
			return
		}
		respondData(w, http.StatusOK, map[string]any{"id": id, "status": domain.RunRunning, "mode": domain.RunModeStream,
			"output": summary, "started_at": time.Now().UTC()})
		return
	}
	run, err := s.st.GetTaskRun(ctx, id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if run.Mode != domain.RunModeTerminal {
		if run.FinishedAt != nil || !s.run.Running(id) {
			s.fail(w, r, conflictf("流式执行由工作台自己收尾，这次执行已经结束了，不能再回报结论"))
			return
		}
		if !s.streamReports.put(id, streamReport{Status: status, Summary: summary}) {
			s.fail(w, r, conflictf("这次执行已经回报过结论了"))
			return
		}
		respondData(w, http.StatusOK, run)
		return
	}
	if run.FinishedAt != nil {
		s.fail(w, r, conflictf("这次执行已经结束了"))
		return
	}
	errMsg := ""
	if status == domain.RunFailed && summary == "" {
		errMsg = "标记为失败，没写原因"
	}
	out, err := s.st.FinishTaskRun(ctx, id, status, 0, summary, errMsg)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.dropHandoff(id)
	respondData(w, http.StatusOK, out)
}

// reportedRun 是插件运行回报后的响应：在任务上留了执行记录的回那条记录，没有的拼一条同形状的（状态仍是进行中）。
func (s *Server) reportedRun(ctx context.Context, info plugin.RunInfo) *domain.TaskRun {
	if info.TaskRun {
		if run, err := s.st.GetTaskRun(ctx, info.ID); err == nil {
			return run
		}
	}
	return &domain.TaskRun{ID: info.ID, Status: info.Status, Mode: domain.RunModeStream, Output: info.Summary, StartedAt: info.StartedAt}
}

// MCPConfig 生成接回工作台的 MCP 配置：一个 stdio server，名字 runner.MCPServer，
// 命令是本机工作台的 MCP 程序，--api 指向当前工作台实例。不含任何凭证。
// 和后台执行、插件运行是同一份生成逻辑（runner.MCPConfigJSON，TSK-0499）。
func MCPConfig(bin, api string) []byte { return runner.MCPConfigJSON(bin, api) }

// mcpBin 是写进 MCP 配置的 MCP 程序；没配或文件不在时回 409，说清怎么补。
func (s *Server) mcpBin() (string, error) {
	bin := strings.TrimSpace(s.opt.MCPBin)
	if bin == "" {
		return "", conflictf("找不到工作台的 MCP 程序，终端里的 Claude Code 没法回写；先 make build-mcp，或启动时用 --mcp-bin 指定")
	}
	if st, err := os.Stat(bin); err != nil || st.IsDir() {
		return "", conflictf("工作台的 MCP 程序 %s 不存在，终端里的 Claude Code 没法回写；先 make build-mcp，或启动时用 --mcp-bin 指定", bin)
	}
	if strings.TrimSpace(s.opt.PublicURL) == "" {
		return "", conflictf("不知道工作台自己的地址（--public-url），MCP 接不回来")
	}
	return bin, nil
}

// handoffRoot 是数据目录下放临时文件的目录，不存在就建（只有本人可读写）。
func (s *Server) handoffRoot() (string, error) {
	if strings.TrimSpace(s.opt.DataDir) == "" {
		return "", fmt.Errorf("no data dir configured for terminal handoff")
	}
	root, err := filepath.Abs(filepath.Join(s.opt.DataDir, handoffSubdir))
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("create handoff dir: %w", err)
	}
	return root, nil
}

// dropHandoff 删掉一次执行的临时文件；没有就算了。
func (s *Server) dropHandoff(runID string) {
	if strings.TrimSpace(s.opt.DataDir) == "" || !safeRunID(runID) {
		return
	}
	root, err := filepath.Abs(filepath.Join(s.opt.DataDir, handoffSubdir))
	if err != nil {
		return
	}
	_ = os.RemoveAll(filepath.Join(root, runID))
}

// safeRunID：执行 id 当目录名用，只许字母、数字、下划线，挡住 .. 和斜杠。
func safeRunID(id string) bool {
	if id == "" {
		return false
	}
	for _, c := range id {
		if !(c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return false
		}
	}
	return true
}

// writeHandoff 写提示词和 MCP 配置，文件只有本人可读写。
func writeHandoff(dir, prompt string, mcp []byte) (string, string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	pf, mf := filepath.Join(dir, "prompt.md"), filepath.Join(dir, "mcp.json")
	if err := os.WriteFile(pf, []byte(prompt), 0o600); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(mf, mcp, 0o600); err != nil {
		return "", "", err
	}
	return pf, mf, nil
}

// cleanHandoff 清掉修改时间早于 keep 的残留临时目录。
func cleanHandoff(root string, now time.Time, keep time.Duration, log interface {
	Warn(msg string, args ...any)
}) {
	ents, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, e := range ents {
		if !e.IsDir() || !safeRunID(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) < keep {
			continue
		}
		if err := os.RemoveAll(filepath.Join(root, e.Name())); err != nil {
			log.Warn("clean handoff dir failed", "dir", e.Name(), "err", err)
		}
	}
}
