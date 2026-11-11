package sop

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	pmrunner "github.com/lizhao903/pm-workspace/internal/runner"
)

// 执行任务、更新任务（TSK-0411）。
//
// 执行任务 task_run：把一条工作台任务交给本机 Claude Code 去做。和 claude_code 共用发起、等待、并发名额、需求预算（nodes_claude.go、
// governance.go），区别是工作目录不用配：按任务自己的工作目录 → 所属项目的工作目录继承（同任务页「执行」，内核 ResolveWorkdir 的口径），
// 都没有、目录不存在或不可写时这一步失败并写明是哪条任务、哪个项目、哪个目录；提示词由任务拼出来（编号、标题、验收标准，
// 要 Claude Code 先经工作台 MCP 读任务全文），config.prompt 是附加要求。一律可写（派它去做就是要改代码），执行记录留在任务上。
// config.on_fail 为 continue 时，没有工作目录、发起失败、执行失败都不让这一步失败，输出 status=failed 和 error，交给下游回报；
// 留空（默认）同 claude_code，失败就是这一步失败。
//
// 更新任务 task_update：改已有任务的负责人、状态；都没配时只读取任务。负责人认联系人 id 或名字，名册里没有时不改、
// 不失败，输出 assign_ok=no 和 assign_note（「没找到「X」，任务留着没分配」），流程按它分支回话。状态是任务类型的状态 key。
// 输出在输入上加 task：id、ref、title、status、owner_id、assignee、project_id、project、workdir（继承后的有效目录）、
// assign_ok、assign_note、changed。

const (
	taskRunKind    = "task_run"
	taskUpdateKind = "task_update"
)

// isClaudeKind 是要交给 Claude Code、走并发名额和预算的节点。
func isClaudeKind(kind string) bool { return kind == claudeKind || kind == taskRunKind }

// checkTaskRun 是保存时对执行任务节点配置的检查：超时写法、失败时怎么办。
func checkTaskRun(cfg map[string]string) []string {
	var out []string
	if _, err := claudeTimeout(cfg["timeout"]); err != nil {
		out = append(out, err.Error())
	}
	switch strings.TrimSpace(cfg["on_fail"]) {
	case "", "stop", "continue":
	default:
		out = append(out, "失败时只能是停下（stop）或继续（continue）")
	}
	return out
}

// claudeParams 是一次 Claude Code 发起要的参数。
type claudeParams struct {
	workdir, prompt, task, preset, executor string
	writes, follow                          bool
	timeout                                 time.Duration
}

// taskRunContinue 是这一步失败时不停、把失败交给下游。
func taskRunContinue(def stepDef) bool {
	return def.Kind == taskRunKind && strings.TrimSpace(def.Config["on_fail"]) == "continue"
}

// taskTarget 是要执行、要改的任务：配置的 task（支持 {{字段}}），留空取输入的 task.id，再取 task_id。
func taskTarget(cfg map[string]string, input Json) string {
	tpl := strings.TrimSpace(cfg["task"])
	if tpl == "" {
		tpl = "{{task.id}}"
	}
	id := strings.TrimSpace(render(tpl, input))
	if id == "" && strings.TrimSpace(cfg["task"]) == "" {
		id = strings.TrimSpace(txt(input["task_id"]))
	}
	return id
}

// loadTask 读任务：认 id 或编号；不存在、已删除、不是任务回给人看的原因。
func loadTask(ctx context.Context, c plugin.Core, id string) (plugin.ObjectInfo, string) {
	o, err := c.Objects().Get(ctx, id)
	if errors.Is(err, plugin.ErrNoRows) {
		o, err = c.Objects().Find(ctx, "task", id)
	}
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		return o, fmt.Sprintf("任务 %s 不存在", id)
	case err != nil:
		return o, "读任务失败：" + err.Error()
	case o.Deleted:
		return o, fmt.Sprintf("任务 %s 已删除", id)
	case o.Type != "task":
		return o, fmt.Sprintf("%s 不是任务", id)
	}
	return o, ""
}

// taskWorkdir 是任务的有效工作目录：任务自己设的，没设取所属项目的（同内核 ResolveWorkdir）；from 说明是从哪来的。
func taskWorkdir(ctx context.Context, c plugin.Core, t plugin.ObjectInfo) (dir, from string, proj plugin.ObjectInfo) {
	if t.ProjectID != "" {
		if p, err := c.Objects().Get(ctx, t.ProjectID); err == nil && !p.Deleted {
			proj = p
		}
	}
	if d := strings.TrimSpace(t.Workdir); d != "" {
		return d, "任务", proj
	}
	if d := strings.TrimSpace(proj.Workdir); d != "" {
		return d, "所属项目「" + proj.Title + "」", proj
	}
	return "", "", proj
}

// taskRunParams 拼执行任务的发起参数；不能发起时回原因（写给人看，说清是哪条任务、哪个项目、哪个目录）。
func taskRunParams(ctx context.Context, c plugin.Core, def stepDef, input Json) (claudeParams, string) {
	cfg := def.Config
	id := taskTarget(cfg, input)
	if id == "" {
		return claudeParams{}, "没有指定任务：配置里填任务 id，或者输入里要有 task.id"
	}
	t, why := loadTask(ctx, c, id)
	if why != "" {
		return claudeParams{}, why
	}
	dir, from, proj := taskWorkdir(ctx, c, t)
	if dir == "" {
		where := "任务没有所属项目"
		if proj.ID != "" {
			where = "所属项目「" + proj.Title + "」也没设"
		}
		return claudeParams{}, fmt.Sprintf("任务 %s 没有工作目录：任务自己没设，%s；在任务或项目上设好工作目录再执行", t.Ref, where)
	}
	if _, err := pmrunner.CheckWorkdir(dir); err != nil {
		return claudeParams{}, fmt.Sprintf("任务 %s 的工作目录（继承自%s）不能用：%s", t.Ref, from, err.Error())
	}
	timeout, err := claudeTimeout(cfg["timeout"])
	if err != nil {
		return claudeParams{}, err.Error()
	}
	preset := strings.TrimSpace(cfg["preset"])
	return claudeParams{
		workdir: dir, prompt: taskRunPrompt(t, proj, dir, strings.TrimSpace(render(cfg["prompt"], input))),
		task: t.ID, preset: preset, writes: true, timeout: timeout,
	}, ""
}

// taskRunPrompt 由任务拼提示词：插件读不到任务正文，要 Claude Code 先经工作台 MCP 读全文（发起时接着回写用的 MCP）。
func taskRunPrompt(t plugin.ObjectInfo, proj plugin.ObjectInfo, dir, extra string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "按工作台任务 %s「%s」开工（任务 id %s）。\n", t.Ref, t.Title, t.ID)
	if proj.ID != "" {
		fmt.Fprintf(&b, "所属项目：%s（%s）。\n", proj.Title, proj.Ref)
	}
	fmt.Fprintf(&b, "工作目录：%s，只在这个目录里改。\n", dir)
	b.WriteString("先用工作台 MCP 的 pmw_get_object 读这条任务的正文、验收标准和最近进展，再动手；做完逐条对照验收标准自查。\n")
	if acc, _ := t.Props[domain.PropAcceptance].(string); strings.TrimSpace(acc) != "" {
		b.WriteString("\n验收标准：\n" + strings.TrimSpace(acc) + "\n")
	}
	if extra != "" {
		b.WriteString("\n附加要求：\n" + extra + "\n")
	}
	return b.String()
}

// taskRunFailed 是 on_fail=continue 时失败的输出：输入加 status=failed、error、task（编号、标题、看板以外的链接由下游拼）。
func taskRunFailed(input Json, why string) Json {
	out := with(input, "status", "failed")
	out["error"] = why
	out["summary"] = ""
	return out
}

/* ---------- 更新任务 ---------- */

func writeTaskUpdate(ctx context.Context, c plugin.Core, w writeRun, def stepDef, input Json) nodeResult {
	cfg := def.Config
	id := taskTarget(cfg, input)
	if id == "" {
		return nodeResult{err: "没有指定任务：配置里填任务 id，或者输入里要有 task.id"}
	}
	t, why := loadTask(ctx, c, id)
	if why != "" {
		return nodeResult{err: why}
	}
	var logs []string
	ch := plugin.TaskChange{Status: strings.TrimSpace(render(cfg["status"], input))}
	assignOK, assignNote, assignee := "", "", ""
	if raw := cleanName(render(cfg["assignee"], input)); strings.TrimSpace(cfg["assignee"]) != "" {
		switch info, ok := findContact(ctx, c, raw); {
		case raw == "":
			assignOK, assignNote = "no", "没说分配给谁，任务留着没分配"
		case !ok:
			assignOK, assignNote = "no", fmt.Sprintf("没找到「%s」，任务留着没分配", raw)
		default:
			assignOK, assignee = "yes", info.Name
			ch.OwnerID = &info.ID
		}
		if assignNote != "" {
			logs = append(logs, assignNote)
		}
	}
	changed := []string{}
	res := plugin.ChangedTask{ID: t.ID, Ref: t.Ref, Title: t.Title, Status: t.Status, ProjectID: t.ProjectID}
	if ch.Status != "" || ch.OwnerID != nil {
		out, err := c.ObjectWriter().UpdateTask(ctx, t.ID, ch, w.meta())
		switch {
		case errors.Is(err, domain.ErrValidation):
			return nodeResult{err: fmt.Sprintf("改任务 %s 失败：%v", t.Ref, err)}
		case err != nil:
			return nodeResult{err: writeErr("改任务", err)}
		}
		res, changed = out, out.Changed
		if changed == nil {
			changed = []string{}
		}
	}
	switch {
	case len(changed) > 0:
		logs = append(logs, fmt.Sprintf("改了任务 %s 的 %s", t.Ref, strings.Join(changed, "、")))
	case ch.Status != "" || ch.OwnerID != nil:
		logs = append(logs, fmt.Sprintf("任务 %s 已经是这样，没有改", t.Ref))
	case assignNote == "":
		logs = append(logs, fmt.Sprintf("没有要改的，只读取了任务 %s", t.Ref))
	}
	// 输出的是改后的值：再读一次拿负责人、工作目录
	if cur, err := c.Objects().Get(ctx, t.ID); err == nil {
		t = cur
	}
	dir, _, proj := taskWorkdir(ctx, c, t)
	res.Status, res.ProjectID, res.OwnerID = t.Status, t.ProjectID, t.OwnerID
	if assignee == "" && res.OwnerID != "" {
		if info, err := c.Contacts().Get(ctx, res.OwnerID); err == nil {
			assignee = info.Name
		}
	}
	return nodeResult{output: with(input, "task", map[string]any{
		"id": res.ID, "ref": res.Ref, "title": res.Title, "status": res.Status, "owner_id": res.OwnerID, "assignee": assignee,
		"project_id": res.ProjectID, "project": proj.Title, "workdir": dir,
		"assign_ok": assignOK, "assign_note": assignNote, "changed": changed,
	}), log: strings.Join(logs, "；")}
}

// cleanName 去掉人名首尾的空白、@、引号和标点（回复里常带）。
func cleanName(s string) string {
	return strings.Trim(strings.TrimSpace(s), "@「」\"'`。.，,！!？? \n")
}

// taskOfMessage 是这条消息已经由别的执行建过的任务（props.source_ref.message_id，TSK-0411）：消息分流的 task 节点、
// IM 的转成任务、来消息确认派发都记这一项。同一个执行自己建的不算（一个流程可以从一条消息建几条任务）。
func taskOfMessage(ctx context.Context, c plugin.Core, msgID, runID string) (plugin.ChangedTask, bool) {
	rows, err := c.Objects().TaskStages(ctx, plugin.TaskStageQuery{MessageID: msgID, Limit: 20})
	if err != nil {
		return plugin.ChangedTask{}, false
	}
	for _, r := range rows {
		o, err := c.Objects().Get(ctx, r.ID)
		if err != nil || o.Deleted {
			continue
		}
		if ref, ok := o.Props[domain.PropSourceRef].(map[string]any); ok && txt(ref["run_id"]) == runID && runID != "" {
			continue
		}
		return plugin.ChangedTask{ID: o.ID, Ref: o.Ref, Title: o.Title, Status: o.Status, ProjectID: o.ProjectID}, true
	}
	return plugin.ChangedTask{}, false
}
