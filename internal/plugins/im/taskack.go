// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 回执需求方（TSK-0467，迁移 0014_task_ack.sql）：IM 消息转成任务后，在原消息所在的会话里回复需求方一句
// 「已创建任务 TSK-x，开始进行需求规划」。原消息在消息列（thread）里的回在消息列里，口径同消息页的回复（replyTo）。
//
// 为什么不直接用 im_reply_message：它按「运行/步骤/尝试」去重，同一条消息被重新发起、或几条流程（需求自动受理、来消息确认派发、
// 用户自建的消息分流）都为它建了任务时会回好几次；发不出去时这一步失败、流程停下；也不认「我自己发的」「只收不发」。
//
// 节点 im_ack_task：
//   - config.message 消息 id，默认 {{message_id}}；config.task 任务 id，默认 {{task.id}}，取不到再用 {{task_id}}。
//   - config.text 文案，默认 defaultAckText；除了输入里的 {{字段}}，还认 {{task_ref}}、{{task_title}}、{{task_project}}、{{task_url}}
//     （节点自己按任务 id 读出来：编号、标题、所属项目名、看板链接）。
//   - 同一条消息只回一次：按消息在 im_task_acks 占一行，占到的发；已经回过（不管哪条流程、哪次执行）不再回。
//     任务是取回的已有任务（task.reused，消息已经转过任务）时同样按消息判断：这条消息回过就不回，不发「已在跟进」第二条；
//     还没回过（比如先建任务的那条流程没有回执这一步）就照常回一次。
//   - 不回的情况，这一步照常完成，输出 acked.status = skipped、reason 和 reason_text：没有来源消息（no_message）、
//     消息不在了（message_missing）、发信人是我自己（self）、连接器只收不发（receive_only）、这条消息回过了（already）。
//   - 回复失败（连接器暂停、断开、没有适配器、渠道报错）不让这一步失败，任务已经建好不受影响：输出 acked.status = failed、
//     reason（blocked / send_failed）和 reason_text，记一条运行异常（warn，模块「IM 消息」，指纹 im:ack:<流程 id>:<步骤 key>），
//     这一行改成 failed，之后再跑（重新发起、别的流程）可以重新占来再发。
//   - 发成：输出 acked.status = sent，带 reply_id、external_id、text；记审计（action=reply、target_type=message）。
//     服务重启后同一次尝试重跑时按审计（写入键「运行 id/步骤 key#尝试次数」）认发没发过，发过的不再发。
//   - 配置错（没有任务、任务不存在）这一步失败，是流程本身要改。

const (
	NodeAckTask = "im_ack_task"

	defaultAckText = "已创建任务 {{task_ref}}，开始进行需求规划"

	ackSent    = "sent"
	ackSkipped = "skipped"
	ackFailed  = "failed"
	ackSending = "sending"
)

func (in *inbox) registerTaskAck(r plugin.Registrar) {
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeAckTask, Group: "沟通", Required: []plugin.SOPNodeField{}, Run: in.ackTaskNode})
}

// ackReasons 是不回、回失败时给人看的一句。
var ackReasons = map[string]string{
	"no_message":      "没有来源消息，不用回执",
	"message_missing": "来源消息已经不在了，不回执",
	"self":            "消息是我自己发的，不回执",
	"receive_only":    "连接器只收不发，不回执",
	"already":         "这条消息已经回执过了，不重复回",
}

func (in *inbox) ackTaskNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	acked := func(status, reason, text string, extra map[string]any) (map[string]any, error) {
		a := map[string]any{"status": status, "reason": reason, "reason_text": text}
		for k, v := range extra {
			a[k] = v
		}
		return with(n.Input, "acked", a), nil
	}
	skip := func(reason string, extra map[string]any) (map[string]any, error) {
		return acked(ackSkipped, reason, ackReasons[reason], extra)
	}

	// 任务
	taskTpl := n.Config["task"]
	if strings.TrimSpace(taskTpl) == "" {
		taskTpl = "{{task.id}}"
	}
	taskID := strings.TrimSpace(render(taskTpl, n.Input))
	if taskID == "" && strings.TrimSpace(n.Config["task"]) == "" {
		taskID = strings.TrimSpace(render("{{task_id}}", n.Input))
	}
	if taskID == "" {
		return nil, errors.New("没有指定任务：配置里填任务 id，或者输入里要有 task.id、task_id（放在建任务的步骤后面）")
	}
	task, err := c.Objects().Get(ctx, taskID)
	if errors.Is(err, plugin.ErrNoRows) || (err == nil && task.Deleted) {
		return nil, fmt.Errorf("任务 %s 不存在", taskID)
	}
	if err != nil {
		return nil, err
	}
	project := ""
	if task.ProjectID != "" {
		if p, err := c.Objects().Get(ctx, task.ProjectID); err == nil && !p.Deleted {
			project = p.Title
		}
	}
	vars := with(n.Input, "task_ref", task.Ref)
	vars["task_title"], vars["task_project"], vars["task_url"] = task.Title, project, in.boardURL(task.ID)
	info := map[string]any{"task_id": task.ID, "task_ref": task.Ref}
	if b, _ := getPath(n.Input, "task.reused").(bool); b {
		info["task_reused"] = true
	}

	// 消息
	msgTpl := n.Config["message"]
	if strings.TrimSpace(msgTpl) == "" {
		msgTpl = "{{message_id}}"
	}
	msgID := strings.TrimSpace(render(msgTpl, n.Input))
	if msgID == "" {
		return skip("no_message", info)
	}
	info["message_id"] = msgID
	m, err := in.get(ctx, msgID)
	if errors.Is(err, errNotFound) {
		return skip("message_missing", info)
	}
	if err != nil {
		return nil, err
	}

	// 文案
	tpl := n.Config["text"]
	if strings.TrimSpace(tpl) == "" {
		tpl = defaultAckText
	}
	text := cleanReply(render(tpl, vars))
	if text == "" {
		return nil, errors.New("回执内容是空的")
	}
	if utf8.RuneCountInString(text) > maxReply {
		text = string([]rune(text)[:maxReply-1]) + "…"
	}
	info["text"] = text

	// 我自己发的、只收不发的不回
	mine, err := in.fromMe(ctx, m)
	if err != nil {
		return nil, err
	}
	if mine {
		return skip("self", info)
	}
	if m.ConnectorID != "" {
		cn, err := in.c.Connectors().Get(ctx, m.ConnectorID)
		if err == nil && cn.Direction == "receive" {
			info["connector"] = cn.Name
			return skip("receive_only", info)
		}
	}

	// 按消息占一行；占不到说明回过或正在回
	meta := writeMeta(n)
	claimed, prev, err := in.claimAck(ctx, m.ID, task, n)
	if err != nil {
		return nil, err
	}
	if !claimed {
		info["previous"] = prev
		return skip("already", info)
	}
	// 服务重启后同一次尝试重跑：审计里有就是发过了
	if a, found, ferr := c.Audit().Find(ctx, "reply", "message", meta); ferr != nil {
		c.Log().Warn("im ack dedupe lookup failed", "key", meta.Key, "err", ferr)
	} else if found {
		str := func(k string) string { s, _ := a.Detail[k].(string); return s }
		if str("status") == "sent" {
			if err := in.settleAck(ctx, m.ID, ackSent, str("reply_id"), str("external_id"), ""); err != nil {
				return nil, err
			}
			info["reply_id"], info["external_id"], info["reused"] = str("reply_id"), str("external_id"), true
			return acked(ackSent, "", "已回执需求方", info)
		}
	}

	who := m.ContactName
	if who == "" {
		who = m.SenderName
	}
	detail := map[string]any{"channel": m.Channel, "connector_id": m.ConnectorID, "text": clip(text, auditTextMax), "source": "sop",
		"kind": "task_ack", "task_id": task.ID, "task_ref": task.Ref}
	done, err := in.replyTo(ctx, m, text, nil)
	if err != nil {
		var ae *actionError
		if !errors.As(err, &ae) {
			// 库出错之类：放掉占位，让这一步按普通失败处理
			_ = in.settleAck(ctx, m.ID, ackFailed, "", "", err.Error())
			return nil, err
		}
		if ae.extra["reason"] == "receive_only" {
			_ = in.releaseAck(ctx, m.ID, n)
			return skip("receive_only", info)
		}
		reason := "send_failed"
		if ae.code != "send_failed" {
			reason = "blocked"
		}
		detail["status"], detail["error"] = "failed", ae.msg
		c.Audit().Note(ctx, plugin.AuditNote{Action: "reply", TargetType: "message", TargetID: m.ID,
			Summary: "回执 " + who + " 失败", Detail: detail}, meta)
		if err := in.settleAck(ctx, m.ID, ackFailed, "", "", ae.msg); err != nil {
			return nil, err
		}
		in.noteAckIncident(ctx, c, n, m, task, ae.msg)
		return acked(ackFailed, reason, "回执需求方失败："+ae.msg+"；任务 "+task.Ref+" 已建好，不受影响", info)
	}
	detail["status"], detail["reply_id"], detail["external_id"] = "sent", done.ID, done.ExternalID
	c.Audit().Note(ctx, plugin.AuditNote{Action: "reply", TargetType: "message", TargetID: m.ID,
		Summary: "回执 " + who + "：已创建任务 " + task.Ref, Detail: detail}, meta)
	if err := in.settleAck(ctx, m.ID, ackSent, done.ID, done.ExternalID, ""); err != nil {
		return nil, err
	}
	if _, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET reply_error = '' WHERE id = ?`, m.ID); err != nil {
		return nil, err
	}
	info["reply_id"], info["external_id"] = done.ID, done.ExternalID
	return acked(ackSent, "", "已回执需求方", info)
}

// claimAck 按消息占一行：没有就插；发失败过的可以重新占；同一次执行同一步骤占着的（服务重启后重跑）认作自己的。
// 占不到时回之前那一行的摘要（哪个任务、哪条执行、状态）。
func (in *inbox) claimAck(ctx context.Context, msgID string, task plugin.ObjectInfo, n plugin.SOPNodeInput) (bool, map[string]any, error) {
	in.taskMu.Lock()
	defer in.taskMu.Unlock()
	now := in.clock().UTC().Format(timeLayout)
	var status, runID, step, ref, at string
	err := in.c.Store().QueryRow(ctx, `SELECT status, run_id, step, task_ref, updated_at FROM im_task_acks WHERE message_id = ?`, msgID).
		Scan(&status, &runID, &step, &ref, &at)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		_, err := in.c.Store().Exec(ctx, `INSERT INTO im_task_acks (message_id, task_id, task_ref, status, run_id, flow_id, step, attempt,
			created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			msgID, task.ID, task.Ref, ackSending, n.RunID, n.FlowID, n.Step, n.Attempt, now, now)
		return err == nil, nil, err
	case err != nil:
		return false, nil, err
	}
	if status == ackFailed || (status == ackSending && runID == n.RunID && step == n.Step) {
		_, err := in.c.Store().Exec(ctx, `UPDATE im_task_acks SET task_id = ?, task_ref = ?, status = ?, run_id = ?, flow_id = ?, step = ?,
			attempt = ?, error = '', updated_at = ? WHERE message_id = ?`,
			task.ID, task.Ref, ackSending, n.RunID, n.FlowID, n.Step, n.Attempt, now, msgID)
		return err == nil, nil, err
	}
	return false, map[string]any{"status": status, "task_ref": ref, "run_id": runID, "at": at}, nil
}

func (in *inbox) settleAck(ctx context.Context, msgID, status, replyID, ext, errText string) error {
	_, err := in.c.Store().Exec(ctx, `UPDATE im_task_acks SET status = ?, reply_id = ?, external_id = ?, error = ?, updated_at = ?
		WHERE message_id = ?`, status, replyID, ext, clip(errText, maxReplyError), in.clock().UTC().Format(timeLayout), msgID)
	return err
}

// releaseAck 放掉自己刚占的一行（不回的情况，不占着）。
func (in *inbox) releaseAck(ctx context.Context, msgID string, n plugin.SOPNodeInput) error {
	_, err := in.c.Store().Exec(ctx, `DELETE FROM im_task_acks WHERE message_id = ? AND run_id = ? AND step = ? AND status = ?`,
		msgID, n.RunID, n.Step, ackSending)
	return err
}

// noteAckIncident 回执失败记一条运行异常：warn、模块「IM 消息」，同一条流程同一步按指纹合并。记不上只记日志。
func (in *inbox) noteAckIncident(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput, m Message, task plugin.ObjectInfo, reason string) {
	err := c.Incidents().Record(ctx, plugin.Incident{
		Fingerprint: "im:ack:" + n.FlowID + ":" + n.Step,
		Level:       "warn",
		Module:      "IM 消息",
		Title:       "回执需求方失败",
		Message:     fmt.Sprintf("任务 %s 已建好，在原消息里回复需求方没发出去：%s", task.Ref, reason),
		Context: map[string]any{"流程": n.FlowID, "步骤": n.Step, "执行 id": n.RunID, "消息": m.ID, "渠道": m.Channel,
			"连接器": m.ConnectorID, "任务": task.Ref},
	})
	if err != nil {
		c.Log().Warn("im ack incident not recorded", "message", m.ID, "err", err)
	}
}

/* ---------- 内置流程升级 ---------- */

// 「IM 需求自动受理」「来消息确认派发」在建任务之后加了「回执需求方」（TSK-0467）。已经写进 SOP 的旧版按内置流程的升级口径换：
// 还是第 1 版（用户没改过）、没有进行中执行、没被定时任务引用的撤下重写成新版；用户改过的不动，发一条平台通知告诉用户
// 新版加了什么、怎么自己加；用户删掉的不补回来；有进行中执行、被定时任务引用的下次再试。做过一次记一个标记行，不加迁移。
// 注意：在 SOP 编排页改过任何地方（包括把触发方式改成「IM 消息」启用它）都算改过，版本号不再是 1。
const (
	intakeAckMark  = AutoIntakeFlowID + "#ack"
	confirmAckMark = TaskConfirmFlowID + "#ack"
)

// installAcked 写一条带回执的内置流程：没写过的直接写新版并记上升级标记；写过、还没升级的走 upgradeAck。
func (in *inbox) installAcked(ctx context.Context, c plugin.Core, t plugin.SOPFlowTemplate, mark string) error {
	had, err := in.templateDone(ctx, c, t.ID)
	if err != nil {
		return err
	}
	if !had {
		ok, err := in.installOnce(ctx, c, t)
		if err != nil || !ok {
			return err
		}
		return in.markTemplate(ctx, c, mark)
	}
	if done, err := in.templateDone(ctx, c, mark); err != nil || done {
		return err
	}
	return in.upgradeAck(ctx, c, t, mark)
}

// upgradeAck 把已写进 SOP 的旧版换成带「回执需求方」的新版，口径见上。
func (in *inbox) upgradeAck(ctx context.Context, c plugin.Core, t plugin.SOPFlowTemplate, mark string) error {
	return in.upgradeBuiltin(ctx, c, t, mark, func(why string) { in.tellAckNotUpgraded(ctx, c, t, why) })
}

// upgradeBuiltin 是内置流程的升级口径：还是第 1 版、没有进行中执行、没被定时任务引用的撤下按 t 写回；改过的不动、调 edited 提示；
// 删掉的不补回来；这三种记上 mark 不再试。有进行中执行、被定时任务引用的下次再试。
func (in *inbox) upgradeBuiltin(ctx context.Context, c plugin.Core, t plugin.SOPFlowTemplate, mark string, edited func(why string)) error {
	removed, why, err := c.SOP().RemoveFlow(ctx, t.ID)
	if errors.Is(err, plugin.ErrNoSOPFlowInstaller) {
		return nil
	}
	if err != nil {
		return err
	}
	switch {
	case removed:
		if _, err := c.SOP().InstallFlow(ctx, t); err != nil {
			return fmt.Errorf("重写「%s」失败：%w", t.Name, err)
		}
		c.Log().Info("im builtin flow upgraded", "flow", t.ID, "mark", mark)
	case why == "":
		// 用户删掉了：不补回来
	case strings.Contains(why, "改过"):
		c.Log().Info("im builtin flow edited by user, not upgraded", "flow", t.ID, "mark", mark, "why", why)
		edited(why)
	default:
		c.Log().Info("im builtin flow upgrade postponed", "flow", t.ID, "mark", mark, "why", why)
		return nil
	}
	return in.markTemplate(ctx, c, mark)
}

// tellAckNotUpgraded 发一条平台通知：这条内置流程用户改过，没有自动加上回执，怎么自己加。通知中心没接上只记日志。
func (in *inbox) tellAckNotUpgraded(ctx context.Context, c plugin.Core, t plugin.SOPFlowTemplate, why string) {
	after := "「建需求任务」"
	if t.ID == TaskConfirmFlowID {
		after = "「读任务」之后、「私信我确认」之前"
	} else {
		after += "之后"
	}
	in.tellNotUpgraded(ctx, c, t, "内置流程「"+t.Name+"」没有自动加上「回执需求方」",
		"新版在建好任务后会在原消息所在的会话里回复需求方「已创建任务 TSK-x，开始进行需求规划」（同一条消息只回一次）。"+
			"这条流程你改过（"+why+"），为了不覆盖你的改动没有自动升级。要用的话，在 SOP 编排页打开它，在"+after+
			"加一步「回执需求方」（沟通分组，im_ack_task），文案可以在这一步里改。")
}

// tellNotUpgraded 发一条平台通知说明内置流程改过、没自动升级。通知中心没接上只记日志。
func (in *inbox) tellNotUpgraded(ctx context.Context, c plugin.Core, t plugin.SOPFlowTemplate, title, body string) {
	err := c.Notify(ctx, plugin.Notification{Kind: "notify", Level: plugin.NotifyInfo, Title: title, Body: body,
		Data: map[string]any{"flow_id": t.ID}})
	if err != nil && !errors.Is(err, plugin.ErrNoNotifier) {
		c.Log().Warn("im builtin flow upgrade notice not sent", "flow", t.ID, "err", err)
	}
}
