// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// IM 转出的任务执行完成后回复原消息（SPEC-messages-2.50）。
//
// 转任务时（勾着「完成后回复原消息」，默认勾上）发起一条内置 SOP「IM 任务回执」，关联到新任务上：
//   1. 等任务执行完成（im_wait_task）：任务交给 Claude Code 执行、成功结束时（内核 run.finished，ok 为真），
//      或者任务被改成已完成时，唤醒这一步，输出 task：id、ref、title、status、summary（执行结论开头）、via。
//      执行失败、取消不算完成，接着等，用户可以改了再交一次。到点（默认 14 天）还没完成就让这一步失败。
//   2. 回复原消息（im_reply_message）：在原消息所在的串里回复，口径同消息页的回复（replyTo）。
// 流程是普通的 SOP，用户可以在 SOP 里改回复内容、加步骤；写过一次就不再写，删了也不加回来（im_sop_templates）。

const (
	NodeWaitTask     = "im_wait_task"
	NodeReplyMessage = "im_reply_message"

	// TaskReplyFlowID 是内置流程的 id，前缀 sop_<插件 id>_ 是内核要求的。
	TaskReplyFlowID = "sop_im_task_reply"

	defaultTaskWait = 14 * 24 * time.Hour
	taskDone        = "done"
)

// taskWaitEvery 是多久看一次挂起中的任务等待；测试里调小。
var taskWaitEvery = 3 * time.Second

func (in *inbox) registerTaskReply(r plugin.Registrar) {
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeWaitTask, Group: "沟通", Required: []plugin.SOPNodeField{}, Run: in.waitTaskNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeReplyMessage, Group: "沟通",
		Required: []plugin.SOPNodeField{{Key: "text", Label: "内容"}}, Run: in.replyMessageNode})
	r.Subscribe("run.finished", in.onTaskRunFinished)
	r.Subscribe("object.status_changed", in.onTaskStatusChanged)
	r.Job(plugin.Job{Name: "task_waits", Every: taskWaitEvery, Run: in.taskWaitJob})
}

/* ---------- 内置流程 ---------- */

// taskReplyText 是「IM 任务回执」的回复：状态 + 结果（TSK-0470）。没有结论时「结果：」这一行是空的，发送前去掉（cleanReply）。
const taskReplyText = "「{{task.title}}」（{{task.ref}}）已完成。\n结果：{{task.summary}}"

// taskReplyUpgradeMark 记在 im_sop_templates 里，表示「IM 任务回执」已经换成只回状态和结果的版本（或者用户改过、删了，不再换）。
const taskReplyUpgradeMark = TaskReplyFlowID + "#result"

func taskReplyFlow() plugin.SOPFlowTemplate {
	type step struct {
		Key    string            `json:"key"`
		Name   string            `json:"name"`
		Kind   string            `json:"kind"`
		Desc   string            `json:"desc"`
		Config map[string]string `json:"config"`
	}
	steps := []step{
		{Key: "wait", Name: "等任务执行完成", Kind: NodeWaitTask,
			Desc:   "任务交给 Claude Code 执行成功结束，或者被改成已完成时往下走；执行失败、取消接着等",
			Config: map[string]string{"task": "{{task_id}}", "timeout": "14 天"}},
		{Key: "reply", Name: "回复原消息", Kind: NodeReplyMessage,
			Desc:   "在原消息所在的串里回复对方：只回状态和结论，不带执行过程；没有结论时只回状态一行（TSK-0470）",
			Config: map[string]string{"message": "{{message_id}}", "text": taskReplyText}},
	}
	fields := []map[string]any{
		{"key": "message_id", "label": "原消息", "type": "text", "required": true, "placeholder": "IM 消息 id"},
		{"key": "task_id", "label": "任务", "type": "text", "required": true, "placeholder": "任务 id"},
	}
	sb, _ := json.Marshal(steps)
	fb, _ := json.Marshal(fields)
	return plugin.SOPFlowTemplate{
		ID: TaskReplyFlowID, Name: "IM 任务回执", Trigger: "manual", Fields: fb, Steps: sb,
		Desc: "IM 消息转成任务时自动发起：任务执行完成后在原消息里回复对方状态和结果（不带执行过程）。要改回复内容直接改这条流程",
	}
}

// ensureTaskReplyFlow 确保内置流程写进过 SOP，回能不能用：SOP 插件没在跑回 false 和原因；
// 写过一次但用户删掉了，也回 false。
func (in *inbox) ensureTaskReplyFlow(ctx context.Context) (bool, string, error) {
	var n int
	if err := in.c.Store().QueryRow(ctx, `SELECT count(*) FROM im_sop_templates WHERE flow_id = ?`, TaskReplyFlowID).Scan(&n); err != nil {
		return false, "", err
	}
	if n == 0 {
		_, err := in.c.SOP().InstallFlow(ctx, taskReplyFlow())
		if errors.Is(err, plugin.ErrNoSOPFlowInstaller) {
			return false, "SOP 编排插件没在运行，执行完成后不会自动回复", nil
		}
		if err != nil {
			return false, "", err
		}
		if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_sop_templates (flow_id, installed_at) VALUES (?, ?) ON CONFLICT (flow_id) DO NOTHING`,
			TaskReplyFlowID, in.clock().UTC().Format(timeLayout)); err != nil {
			return false, "", err
		}
		// 新写的就是只回状态和结果的版本（TSK-0470）
		if err := in.markTemplate(ctx, in.c, taskReplyUpgradeMark); err != nil {
			return false, "", err
		}
		return true, "", nil
	}
	// 写过：看 SOP 里还在不在（用户可能删了）。InstallFlow 对已有的不动，回 created=false；
	// 回 true 说明被删过又写了一遍——用户删了就不该加回来，撤掉。
	created, err := in.c.SOP().InstallFlow(ctx, taskReplyFlow())
	if errors.Is(err, plugin.ErrNoSOPFlowInstaller) {
		return false, "SOP 编排插件没在运行，执行完成后不会自动回复", nil
	}
	if err != nil {
		return false, "", err
	}
	if created {
		if _, _, err := in.c.SOP().RemoveFlow(ctx, TaskReplyFlowID); err != nil {
			in.c.Log().Warn("im task reply flow re-remove failed", "err", err)
		}
		return false, "「IM 任务回执」流程已在 SOP 里删掉，执行完成后不会自动回复", nil
	}
	return true, "", nil
}

// startTaskReply 发起回执流程，关联到任务上；回 SOP 执行发起后的运行 id（插件运行 id）。
func (in *inbox) startTaskReply(ctx context.Context, messageID, taskID string) (string, error) {
	return in.c.Runs().StartSOP(ctx, plugin.SOPRunStart{Flow: TaskReplyFlowID, ObjectID: taskID,
		Input: map[string]any{"message_id": messageID, "task_id": taskID}})
}

/* ---------- 等任务执行完成 ---------- */

func (in *inbox) waitTaskNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	tpl := n.Config["task"]
	if strings.TrimSpace(tpl) == "" {
		tpl = "{{task_id}}"
	}
	id := strings.TrimSpace(render(tpl, n.Input))
	if id == "" {
		return nil, errors.New("没有指定任务")
	}
	o, err := in.c.Objects().Get(ctx, id)
	if errors.Is(err, plugin.ErrNoRows) || (err == nil && o.Deleted) {
		return nil, fmt.Errorf("任务 %s 不存在", id)
	}
	if err != nil {
		return nil, err
	}
	if o.Status == taskDone {
		return with(n.Input, "task", taskOut(o, "", "status")), nil
	}
	d := defaultTaskWait
	if strings.TrimSpace(n.Config["timeout"]) != "" {
		if d, err = parseTimeout(n.Config["timeout"]); err != nil {
			return nil, err
		}
	}
	b, err := json.Marshal(orEmptyMap(n.Input))
	if err != nil {
		return nil, fmt.Errorf("输入不能转成 JSON：%w", err)
	}
	now := in.clock().UTC()
	if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_task_waits (run_id, step, attempt, task_id, input, since, deadline)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (run_id, step) DO UPDATE SET attempt = excluded.attempt, task_id = excluded.task_id, input = excluded.input,
		since = excluded.since, deadline = excluded.deadline, done_via = '', summary = ''`,
		n.RunID, n.Step, n.Attempt, o.ID, string(b), now.Format(timeLayout), now.Add(d).Format(timeLayout)); err != nil {
		return nil, err
	}
	label := o.Ref
	if label == "" {
		label = o.Title
	}
	return nil, fmt.Errorf("等任务 %s 执行完成，最多等 %s：%w", label, humanDur(d), plugin.ErrWaiting)
}

// taskOut 的 summary 只留结论：run.finished 带的已经是结论，这里再去掉万一混进来的工具行（TSK-0470）。
func taskOut(o plugin.ObjectInfo, summary, via string) map[string]any {
	return map[string]any{"id": o.ID, "ref": o.Ref, "title": o.Title, "status": o.Status, "summary": cleanReply(summary), "via": via}
}

// onTaskRunFinished：任务执行成功结束，记到等这条任务的行上。只认内核的任务执行（带 object_id），
// 本插件自己发起的运行（回执流程本身）也会投 run.finished，那种没有 object_id，跳过。
func (in *inbox) onTaskRunFinished(ctx context.Context, c plugin.Core, ev plugin.Event) error {
	var p struct {
		ObjectID string `json:"object_id"`
		OK       bool   `json:"ok"`
		Summary  string `json:"summary"`
		Origin   string `json:"origin"`
	}
	// 插件流程里的一步（如自动交付的产品、评审阶段）跑完不算任务做完，只认人交给 CLI 的执行和改成已完成
	if json.Unmarshal(ev.Payload, &p) != nil || p.ObjectID == "" || !p.OK || p.Origin != "" {
		return nil
	}
	_, err := c.Store().Exec(ctx, `UPDATE im_task_waits SET done_via = 'run', summary = ? WHERE task_id = ? AND done_via = ''`,
		strings.TrimSpace(p.Summary), p.ObjectID)
	return err
}

// onTaskStatusChanged：任务改成已完成，记到等这条任务的行上；执行已经记过结论的不覆盖。
func (in *inbox) onTaskStatusChanged(ctx context.Context, c plugin.Core, ev plugin.Event) error {
	var p struct {
		ID string `json:"id"`
		To string `json:"to"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" || p.To != taskDone {
		return nil
	}
	_, err := c.Store().Exec(ctx, `UPDATE im_task_waits SET done_via = 'status' WHERE task_id = ? AND done_via = ''`, p.ID)
	return err
}

type taskWait struct {
	runID, step, taskID, input, since, deadline, via, summary string
}

// taskWaitJob 唤醒等到了的、让到点的失败。事件漏掉（插件停用期间改成已完成）时按任务当前状态补认。
// 唤醒出错（执行还没调度上、SOP 插件没在跑）留着下次再试。
func (in *inbox) taskWaitJob(ctx context.Context, c plugin.Core) error {
	rows, err := c.Store().Query(ctx, `SELECT run_id, step, task_id, input, since, deadline, done_via, summary FROM im_task_waits ORDER BY since`)
	if err != nil {
		return err
	}
	var ws []taskWait
	for rows.Next() {
		var w taskWait
		if err := rows.Scan(&w.runID, &w.step, &w.taskID, &w.input, &w.since, &w.deadline, &w.via, &w.summary); err != nil {
			_ = rows.Close()
			return err
		}
		ws = append(ws, w)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, w := range ws {
		if err := ctx.Err(); err != nil {
			return err
		}
		o, oerr := c.Objects().Get(ctx, w.taskID)
		if oerr != nil && !errors.Is(oerr, plugin.ErrNoRows) {
			return oerr
		}
		if w.via == "" && oerr == nil && !o.Deleted && o.Status == taskDone {
			w.via = "status"
		}
		switch {
		case w.via != "" && oerr == nil:
			var input map[string]any
			_ = json.Unmarshal([]byte(w.input), &input)
			if err := c.SOP().Resume(ctx, w.runID, w.step, with(input, "task", taskOut(o, w.summary, w.via))); err != nil {
				// 执行已经结束（在 SOP 里被停掉）、或者到点了还唤醒不了的，删掉这一行，不再重试
				if !strings.Contains(err.Error(), "已经结束") && in.clock().UTC().Format(timeLayout) < w.deadline {
					c.Log().Debug("im task wait resume failed, retry later", "run", w.runID, "step", w.step, "err", err)
					continue
				}
				c.Log().Info("im task wait dropped", "run", w.runID, "step", w.step, "err", err)
			}
		case in.clock().UTC().Format(timeLayout) >= w.deadline || errors.Is(oerr, plugin.ErrNoRows) || (oerr == nil && o.Deleted):
			reason := fmt.Sprintf("等了 %s，任务还没执行完成（超时）", humanDur(timeBetween(w.since, w.deadline)))
			if oerr != nil || o.Deleted {
				reason = "任务已经删掉了，不再等"
			}
			if err := c.SOP().Fail(ctx, w.runID, w.step, reason); err != nil {
				if errors.Is(err, plugin.ErrNoSOPEngine) {
					continue
				}
				c.Log().Debug("im task wait fail", "run", w.runID, "step", w.step, "err", err)
			}
		default:
			continue
		}
		if _, err := c.Store().Exec(ctx, `DELETE FROM im_task_waits WHERE run_id = ? AND step = ?`, w.runID, w.step); err != nil {
			return err
		}
	}
	return nil
}

/* ---------- 回复原消息 ---------- */

// replyMessageNode 在原消息所在的串里回复。config.message 是消息 id（支持 {{字段}}，留空取输入的 message_id），
// config.text 是内容。超长的截到上限。幂等键同发消息：「运行 id/步骤 key#尝试次数」，发过的按审计认，不再发。
func (in *inbox) replyMessageNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	tpl := n.Config["message"]
	if strings.TrimSpace(tpl) == "" {
		tpl = "{{message_id}}"
	}
	id := strings.TrimSpace(render(tpl, n.Input))
	if id == "" {
		return nil, errors.New("没有指定要回复的消息")
	}
	// 回给对方的只有状态和结论：去掉执行过程的工具行、末尾没填上的「结果：」（TSK-0470，cleanReply）
	text := cleanReply(render(n.Config["text"], n.Input))
	if text == "" {
		return nil, errors.New("要回复的内容是空的")
	}
	if utf8.RuneCountInString(text) > maxReply {
		text = string([]rune(text)[:maxReply-1]) + "…"
	}
	m, err := in.get(ctx, id)
	if err != nil {
		return nil, err
	}
	meta := plugin.WriteMeta{Session: n.RunID, Key: fmt.Sprintf("%s/%s#%d", n.RunID, n.Step, n.Attempt), Detail: map[string]any{
		"run_id": n.RunID, "flow_id": n.FlowID, "step": n.Step, "attempt": n.Attempt,
	}}
	if a, found, ferr := c.Audit().Find(ctx, "reply", "message", meta); ferr != nil {
		c.Log().Warn("im sop reply dedupe lookup failed", "key", meta.Key, "err", ferr)
	} else if found {
		str := func(k string) string { s, _ := a.Detail[k].(string); return s }
		if str("status") != "sent" {
			return nil, errors.New("回复失败：" + str("error"))
		}
		return with(n.Input, "replied", map[string]any{"message_id": m.ID, "reply_id": str("reply_id"),
			"external_id": str("external_id"), "text": text, "reused": true}), nil
	}
	who := m.ContactName
	if who == "" {
		who = m.SenderName
	}
	detail := map[string]any{"channel": m.Channel, "connector_id": m.ConnectorID, "text": clip(text, auditTextMax), "source": "sop"}
	done, err := in.replyTo(ctx, m, text, nil)
	var ae *actionError
	if err != nil && errors.As(err, &ae) && ae.code == "send_failed" {
		detail["status"], detail["error"] = "failed", ae.msg
		c.Audit().Note(ctx, plugin.AuditNote{Action: "reply", TargetType: "message", TargetID: m.ID,
			Summary: "回复 " + who + " 的消息失败", Detail: detail}, meta)
		return nil, errors.New(ae.msg)
	}
	if err != nil {
		return nil, err
	}
	detail["status"], detail["reply_id"], detail["external_id"] = "sent", done.ID, done.ExternalID
	c.Audit().Note(ctx, plugin.AuditNote{Action: "reply", TargetType: "message", TargetID: m.ID,
		Summary: "回复 " + who + " 的消息", Detail: detail}, meta)
	if _, err := c.Store().Exec(ctx, `UPDATE im_messages SET reply_error = '' WHERE id = ?`, m.ID); err != nil {
		return nil, err
	}
	return with(n.Input, "replied", map[string]any{"message_id": m.ID, "reply_id": done.ID, "external_id": done.ExternalID, "text": text}), nil
}

/* ---------- 回复内容兜底（TSK-0470） ---------- */

// cleanReply 是发给需求方、发给我的文字的兜底：去掉执行过程里的工具行（「[工具] 」「[工具失败] 」开头），
// 去掉末尾值是空的标签行（如没有结论时的「结果：」），去首尾空白。中间的「验收清单：」后面接着列表的不动。
func cleanReply(text string) string {
	var keep []string
	for _, l := range strings.Split(text, "\n") {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "[工具] ") || strings.HasPrefix(t, "[工具失败] ") {
			continue
		}
		keep = append(keep, l)
	}
	for len(keep) > 0 {
		t := strings.TrimSpace(keep[len(keep)-1])
		if t == "" || bareLabelRe.MatchString(t) {
			keep = keep[:len(keep)-1]
			continue
		}
		break
	}
	return strings.TrimSpace(strings.Join(keep, "\n"))
}

// bareLabelRe 是只有标签、冒号后面什么都没有的一行，最多 8 个字的标签。
var bareLabelRe = regexp.MustCompile(`^[\p{Han}A-Za-z ]{1,8}[：:]$`)

// upgradeTaskReply 把已写进 SOP 的「IM 任务回执」换成只回状态和结果的版本（口径同 upgradeBuiltin），改过的发通知提示。
func (in *inbox) upgradeTaskReply(ctx context.Context, c plugin.Core) error {
	if had, err := in.templateDone(ctx, c, TaskReplyFlowID); err != nil || !had {
		return err
	}
	if done, err := in.templateDone(ctx, c, taskReplyUpgradeMark); err != nil || done {
		return err
	}
	t := taskReplyFlow()
	return in.upgradeBuiltin(ctx, c, t, taskReplyUpgradeMark, func(why string) {
		in.tellNotUpgraded(ctx, c, t, "内置流程「IM 任务回执」没有自动换成新的回复内容",
			"新版回复需求方时只回状态和结果：「「标题」（TSK-x）已完成。」加一行「结果：<结论>」，没有结论只回状态，不带执行过程。"+
				"这条流程你改过（"+why+"），为了不覆盖你的改动没有自动升级。要用的话，在 SOP 编排页打开它，把「回复原消息」的内容改成："+
				"「{{task.title}}」（{{task.ref}}）已完成。换行 结果：{{task.summary}}。发送前仍会去掉执行过程的工具行。")
	})
}
