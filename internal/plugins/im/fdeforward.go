package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/imident"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// FDE 反馈转发（TSK-0468，迁移 0015_fde_forward.sql）：我在 IM 消息页手动把消息转成任务时，给联系人（默认 Robot.CyberBroleez
// 的 Slack 身份 U0BQZG8LSTB）私信一条「FDE 反馈」+ 原始消息（发信人、会话、时间、原文、附件名）+ 新任务编号和链接。
//
// 怎么认「手动」：不加 SOP 触发方式，由本插件在两个手动入口之后发起内置流程 sop_im_fde_forward：
//   - 转任务：POST /api/im/messages/{id}/task 建好任务之后（只有界面上的「转任务」走这个接口）；
//   - 拆分任务：从消息发起的 Agent 会话（会话来源 kind = im_message，只有消息页「发起会话 / 拆分任务」会带）里建的任务，
//     在 object.created 里认出来。
// SOP 流程自动建的任务（task 节点的来源是运行、im_to_task 不走转任务接口）两条都不经过，所以不触发。
// 理由：触发方式的代码正在另做（TSK-0463），新加一种触发方式要改 SOP 插件订阅和编辑器；手动入口只在本插件里，在这里认最准。
//
// 同一条消息只发一次：按消息在 im_fde_forward_messages 占位，一次转发（im_fde_forwards）可以带一组消息（拆分时会话带的那组）
// 和几条任务。转任务马上发（下一轮后台任务，几秒内）；拆分时任务是一条条建的，攒到 fdeSplitQuiet 内没有新任务再发一条，
// 列出全部任务编号。已经发起过的消息再转、再拆都不再发。
// 默认停用：IM 设置 fde_forward 为真才排队（GET / PATCH /api/im/settings）；流程本身的触发方式是「手动」，也能在 SOP 页手动发起。
//
// 两个节点：
//   - im_message_digest 整理消息摘要：按消息 id（一组）和任务 id 拼出 digest.messages_text、digest.tasks_text；
//   - im_send_contact 私信联系人：按联系人名字或 id 找到它在渠道上的身份（config.to 指定编号时只认这一个），私信 config.text。
//     找不到联系人、联系人没有这个渠道的身份时失败并写明；发送失败这一步失败（SOP 记运行异常），任务早已建好不受影响。

const (
	NodeMessageDigest = "im_message_digest"
	NodeSendContact   = "im_send_contact"

	// FDEForwardFlowID 是内置流程「FDE 反馈转发」的 id。
	FDEForwardFlowID = "sop_im_fde_forward"

	settingFDEForward = "fde_forward"

	fdePending = "pending"
	fdeStarted = "started"
	fdeFailed  = "failed"

	// 默认收件人：联系人名字和它的 Slack 编号（不是库里的 id，安装、运行时按它们找）
	fdeDefaultContact = "Robot.CyberBroleez"
	fdeDefaultTo      = "U0BQZG8LSTB"
	fdeDefaultText    = "FDE 反馈\n{{digest.messages_text}}\n{{digest.tasks_text}}"
)

var (
	// fdeEvery 是多久看一次该发的转发；测试里调小。
	fdeEvery = 3 * time.Second
	// fdeSplitQuiet 是拆分任务时攒多久：最后一条任务建好后这么久没有新的就发。
	fdeSplitQuiet = 2 * time.Minute
)

func (in *inbox) registerFDEForward(r plugin.Registrar) {
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeMessageDigest, Group: "沟通", Required: []plugin.SOPNodeField{}, Run: in.digestNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeSendContact, Group: "沟通",
		Required: []plugin.SOPNodeField{{Key: "contact", Label: "联系人"}, {Key: "text", Label: "内容"}}, Run: in.sendContactNode})
	r.Job(plugin.Job{Name: "fde_forwards", Every: fdeEvery, Run: in.fdeJob})
}

/* ---------- 设置 ---------- */

func (in *inbox) fdeEnabled(ctx context.Context) (bool, error) {
	var v string
	err := in.c.Store().QueryRow(ctx, `SELECT value FROM im_settings WHERE key = ?`, settingFDEForward).Scan(&v)
	if errors.Is(err, plugin.ErrNoRows) {
		return false, nil
	}
	return v == "1", err
}

func (in *inbox) setFDEEnabled(ctx context.Context, on bool) error {
	v := "0"
	if on {
		v = "1"
	}
	_, err := in.c.Store().Exec(ctx, `INSERT INTO im_settings (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		settingFDEForward, v, in.clock().UTC().Format(timeLayout))
	return err
}

/* ---------- 排队 ---------- */

// queueFDE 记一次手动转任务：msgIDs 是这一组消息（第一条是主消息），taskID 是新任务，delay 是多久后发（转任务 0，拆分 fdeSplitQuiet）。
// 这组里有消息已经发起过转发的不再记；有还在攒的就并进去（加任务、加消息，按这次重新定时间）。设置没开不记。出错只记日志。
func (in *inbox) queueFDE(ctx context.Context, msgIDs []string, taskID string, delay time.Duration) {
	if err := in.queueFDEErr(ctx, msgIDs, taskID, delay); err != nil {
		in.c.Log().Warn("im fde forward not queued", "messages", msgIDs, "task", taskID, "err", err)
	}
}

func (in *inbox) queueFDEErr(ctx context.Context, msgIDs []string, taskID string, delay time.Duration) error {
	if len(msgIDs) == 0 {
		return nil
	}
	on, err := in.fdeEnabled(ctx)
	if err != nil || !on {
		return err
	}
	in.fdeMu.Lock()
	defer in.fdeMu.Unlock()
	now := in.clock().UTC()
	due := now.Add(delay).Format(timeLayout)
	// 这组消息已经占过的转发
	var pending string
	for _, mid := range msgIDs {
		var fid, status string
		err := in.c.Store().QueryRow(ctx, `SELECT f.id, f.status FROM im_fde_forward_messages m JOIN im_fde_forwards f ON f.id = m.forward_id
			WHERE m.message_id = ?`, mid).Scan(&fid, &status)
		if errors.Is(err, plugin.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if status != fdePending {
			return nil // 发起过了：同一条消息只发一次
		}
		pending = fid
	}
	fid := pending
	if fid == "" {
		fid = msgIDs[0]
		ids, _ := json.Marshal(msgIDs)
		tasks, _ := json.Marshal([]string{taskID})
		if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_fde_forwards (id, message_ids, task_ids, status, due_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, fid, string(ids), string(tasks), fdePending, due, now.Format(timeLayout), now.Format(timeLayout)); err != nil {
			return err
		}
	} else {
		var idsJSON, tasksJSON string
		if err := in.c.Store().QueryRow(ctx, `SELECT message_ids, task_ids FROM im_fde_forwards WHERE id = ?`, fid).Scan(&idsJSON, &tasksJSON); err != nil {
			return err
		}
		var ids, tasks []string
		_ = json.Unmarshal([]byte(idsJSON), &ids)
		_ = json.Unmarshal([]byte(tasksJSON), &tasks)
		for _, mid := range msgIDs {
			if !slices.Contains(ids, mid) {
				ids = append(ids, mid)
			}
		}
		if !slices.Contains(tasks, taskID) {
			tasks = append(tasks, taskID)
		}
		ib, _ := json.Marshal(ids)
		tb, _ := json.Marshal(tasks)
		if _, err := in.c.Store().Exec(ctx, `UPDATE im_fde_forwards SET message_ids = ?, task_ids = ?, due_at = ?, updated_at = ? WHERE id = ?`,
			string(ib), string(tb), due, now.Format(timeLayout), fid); err != nil {
			return err
		}
	}
	for _, mid := range msgIDs {
		if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_fde_forward_messages (message_id, forward_id) VALUES (?, ?)
			ON CONFLICT (message_id) DO NOTHING`, mid, fid); err != nil {
			return err
		}
	}
	return nil
}

// onSessionTask 是 object.created 里认出的拆分任务：来源是从消息发起的会话（kind = im_message）。
func (in *inbox) onSessionTask(ctx context.Context, props map[string]any, taskID string, msgIDs []string) {
	ref, _ := props["source_ref"].(map[string]any)
	if ref == nil || ref["kind"] != "im_message" || len(msgIDs) == 0 {
		return
	}
	// 主消息放第一：来源里的 message_id 是这组里最新的一条
	if mid, _ := ref["message_id"].(string); mid != "" {
		msgIDs = append([]string{mid}, slices.DeleteFunc(slices.Clone(msgIDs), func(s string) bool { return s == mid })...)
	}
	// 只认本插件的消息
	known, err := in.byIDs(ctx, msgIDs)
	if err != nil || len(known) == 0 {
		return
	}
	ids := make([]string, 0, len(known))
	for _, m := range known {
		ids = append(ids, m.ID)
	}
	in.queueFDE(ctx, ids, taskID, fdeSplitQuiet)
}

/* ---------- 发起 ---------- */

// fdeJob 把到点的转发发起成 SOP 执行（输入 message_id、message_ids、task_ids），关联到第一条任务。
// SOP 插件没在跑留着下次；流程不在了（用户删了）等别的错误记 failed 和一条运行异常，不再试。
func (in *inbox) fdeJob(ctx context.Context, c plugin.Core) error {
	rows, err := c.Store().Query(ctx, `SELECT id, message_ids, task_ids FROM im_fde_forwards WHERE status = ? AND due_at <= ? ORDER BY due_at`,
		fdePending, in.clock().UTC().Format(timeLayout))
	if err != nil {
		return err
	}
	type fwd struct {
		id           string
		msgs, tasks  []string
		msgsJSON, tj string
	}
	var list []fwd
	for rows.Next() {
		var f fwd
		if err := rows.Scan(&f.id, &f.msgsJSON, &f.tj); err != nil {
			_ = rows.Close()
			return err
		}
		_ = json.Unmarshal([]byte(f.msgsJSON), &f.msgs)
		_ = json.Unmarshal([]byte(f.tj), &f.tasks)
		list = append(list, f)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, f := range list {
		in.fdeMu.Lock()
		// 攒着的期间又来了任务、时间往后挪了的，这一轮不发
		var status, due string
		err := c.Store().QueryRow(ctx, `SELECT status, due_at FROM im_fde_forwards WHERE id = ?`, f.id).Scan(&status, &due)
		if err != nil || status != fdePending || due > in.clock().UTC().Format(timeLayout) {
			in.fdeMu.Unlock()
			continue
		}
		obj := ""
		if len(f.tasks) > 0 {
			obj = f.tasks[0]
		}
		runID, serr := c.Runs().StartSOP(ctx, plugin.SOPRunStart{Flow: FDEForwardFlowID, ObjectID: obj,
			Input: map[string]any{"message_id": f.id, "message_ids": f.msgs, "task_ids": f.tasks}})
		now := in.clock().UTC().Format(timeLayout)
		switch {
		case errors.Is(serr, plugin.ErrNoSOPStarter):
			in.fdeMu.Unlock()
			continue
		case serr != nil:
			_, err = c.Store().Exec(ctx, `UPDATE im_fde_forwards SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
				fdeFailed, clip(serr.Error(), maxReplyError), now, f.id)
			in.noteFDEIncident(ctx, c, f.id, f.tasks, serr.Error())
		default:
			_, err = c.Store().Exec(ctx, `UPDATE im_fde_forwards SET status = ?, run_id = ?, updated_at = ? WHERE id = ?`, fdeStarted, runID, now, f.id)
		}
		in.fdeMu.Unlock()
		if err != nil {
			return err
		}
	}
	return nil
}

func (in *inbox) noteFDEIncident(ctx context.Context, c plugin.Core, msgID string, tasks []string, reason string) {
	err := c.Incidents().Record(ctx, plugin.Incident{
		Fingerprint: "im:fde_forward:start",
		Level:       "warn",
		Module:      "IM 消息",
		Title:       "FDE 反馈没转发",
		Message:     "手动转任务后发起「FDE 反馈转发」失败：" + reason + "。任务已建好，不受影响；流程删了的话关掉 IM 设置里的「FDE 反馈转发」，或重新建这条流程",
		Context:     map[string]any{"消息": msgID, "任务": tasks},
	})
	if err != nil {
		c.Log().Warn("im fde incident not recorded", "message", msgID, "err", err)
	}
}

/* ---------- 节点：整理消息摘要 ---------- */

// idList 认 JSON 数组、逗号或空白分隔的 id。
func idList(v any) []string {
	var out []string
	add := func(s string) {
		if s = strings.TrimSpace(s); s != "" && !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			add(txt(e))
		}
	case []string:
		for _, e := range x {
			add(e)
		}
	case string:
		var arr []string
		if json.Unmarshal([]byte(x), &arr) == nil {
			for _, e := range arr {
				add(e)
			}
			break
		}
		for _, e := range strings.FieldsFunc(x, func(r rune) bool { return r == ',' || r == '，' || r == '、' || r == ' ' || r == '\n' }) {
			add(e)
		}
	}
	return out
}

// cfgIDs：配置填了按配置渲染；没填取输入的 key。
func cfgIDs(cfg map[string]string, input map[string]any, cfgKey, inputKey string) []string {
	if tpl := strings.TrimSpace(cfg[cfgKey]); tpl != "" {
		return idList(render(tpl, input))
	}
	return idList(getPath(input, inputKey))
}

// digestNode：config.messages 消息 id（一组，留空取输入的 message_ids，再没有取 message_id）、config.tasks 任务 id
// （留空取输入的 task_ids，再没有取这些消息转成的、拆出来的任务）。输出加 digest：messages_text、tasks_text、task_refs、messages、tasks。
func (in *inbox) digestNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	mids := cfgIDs(n.Config, n.Input, "messages", "message_ids")
	if len(mids) == 0 {
		mids = idList(txt(getPath(n.Input, "message_id")))
	}
	if len(mids) == 0 {
		return nil, errors.New("没有指定消息：配置里填消息 id，或者输入里要有 message_ids、message_id")
	}
	ms, err := in.byIDs(ctx, mids)
	if err != nil {
		return nil, err
	}
	if len(ms) == 0 {
		return nil, fmt.Errorf("消息 %s 不存在", strings.Join(mids, "、"))
	}
	if ms, err = in.filled(ctx, ms); err != nil {
		return nil, err
	}
	tids := cfgIDs(n.Config, n.Input, "tasks", "task_ids")
	if len(tids) == 0 {
		for _, m := range ms {
			if m.TaskID != nil {
				tids = append(tids, *m.TaskID)
			}
			for _, s := range m.SplitTasks {
				tids = append(tids, s.ID)
			}
		}
		tids = idList(tids)
	}
	var blocks []string
	for _, m := range ms {
		blocks = append(blocks, digestOf(m))
	}
	var lines, refs []string
	for _, id := range tids {
		o, err := c.Objects().Get(ctx, id)
		if err != nil || o.Deleted {
			continue
		}
		refs = append(refs, o.Ref)
		lines = append(lines, fmt.Sprintf("%s「%s」%s", o.Ref, o.Title, in.boardURL(o.ID)))
	}
	tasksText := "任务：（没有）"
	if len(lines) == 1 {
		tasksText = "任务：" + lines[0]
	} else if len(lines) > 1 {
		tasksText = fmt.Sprintf("任务（%d 条）：\n%s", len(lines), strings.Join(lines, "\n"))
	}
	return with(n.Input, "digest", map[string]any{
		"messages_text": strings.Join(blocks, "\n\n"), "tasks_text": tasksText, "task_refs": strings.Join(refs, "、"),
		"messages": len(ms), "tasks": len(refs),
	}), nil
}

// filled 读出带附件、拆分任务的完整消息（byIDs 只有列）。
func (in *inbox) filled(ctx context.Context, ms []Message) ([]Message, error) {
	out := make([]Message, 0, len(ms))
	for _, m := range ms {
		full, err := in.get(ctx, m.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, full)
	}
	return out, nil
}

// digestOf 一条消息的摘要：发信人、会话、时间（本机时区，YYYY-MM-DD HH:mm）、原文、附件名。
func digestOf(m Message) string {
	who := m.ContactName
	if who == "" {
		who = m.SenderName
	}
	if who == "" {
		who = m.SenderID
	}
	conv := m.Conversation
	if conv == "" {
		conv = "私聊"
	}
	at := m.At
	if t, err := time.Parse(time.RFC3339Nano, m.At); err == nil {
		at = t.Local().Format("2006-01-02 15:04")
	}
	lines := []string{"发信人：" + who, "会话：" + conv + "（" + m.Channel + "）", "时间：" + at, "原文：" + m.Text}
	var atts []struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(m.Attachments, &atts)
	var names []string
	for _, a := range atts {
		if a.Name != "" {
			names = append(names, a.Name)
		}
	}
	if len(names) > 0 {
		lines = append(lines, "附件："+strings.Join(names, "、"))
	}
	return strings.Join(lines, "\n")
}

/* ---------- 节点：私信联系人 ---------- */

// sendContactNode：config.contact 联系人名字或 id、config.to 渠道编号（留空用联系人在这个渠道上第一个不是我的身份）、
// config.channel 渠道（默认 slack）、config.connector 连接器（留空同私信我）、config.text 内容，都支持 {{字段}}。
// 输出加 sent_to：{contact, to, text, external_id, at}。同一次尝试重跑按审计取回，不重发。
func (in *inbox) sendContactNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	input := in.withTaskURL(n.Input)
	text := strings.TrimSpace(render(n.Config["text"], input))
	if text == "" {
		return nil, errors.New("要发的内容是空的")
	}
	if r := []rune(text); len(r) > maxReply {
		text = string(r[:maxReply-1]) + "…"
	}
	name := strings.TrimSpace(render(n.Config["contact"], input))
	if name == "" {
		return nil, errors.New("没有指定联系人")
	}
	ch := strings.TrimSpace(render(n.Config["channel"], input))
	if ch == "" {
		ch = connector.SlackTool
	}
	ch, err := imident.NormalizeChannel(ch)
	if err != nil {
		return nil, fmt.Errorf("渠道「%s」不认", n.Config["channel"])
	}
	chLabel := map[string]string{connector.SlackTool: "Slack", "telegram": "Telegram"}[ch]
	if chLabel == "" {
		chLabel = ch
	}
	ct, err := c.Contacts().Get(ctx, name)
	if errors.Is(err, plugin.ErrNoRows) {
		ct, err = c.Contacts().FindByName(ctx, name)
	}
	if errors.Is(err, plugin.ErrNoRows) {
		return nil, fmt.Errorf("联系人 %s 不存在", name)
	}
	if err != nil {
		return nil, err
	}
	ids, err := c.Identities().List(ctx, ch)
	if err != nil {
		return nil, err
	}
	want := strings.TrimPrefix(strings.TrimSpace(render(n.Config["to"], input)), "@")
	to := ""
	var mine []string
	for _, id := range ids {
		if id.StakeholderID != ct.ID {
			continue
		}
		if want != "" {
			if strings.EqualFold(id.ExternalID, want) {
				to = id.ExternalID
			}
			continue
		}
		mine = append(mine, id.ExternalID)
	}
	if want != "" && to == "" {
		return nil, fmt.Errorf("联系人 %s 没有 %s 身份 %s", ct.Name, chLabel, want)
	}
	if want == "" && len(mine) == 0 {
		return nil, fmt.Errorf("联系人 %s 没有 %s 身份", ct.Name, chLabel)
	}
	targetOf := func(to string) (askTarget, error) {
		cfg := map[string]string{"channel": ch, "connector": n.Config["connector"], "to": to}
		return in.askTargetOf(ctx, plugin.SOPNodeInput{RunID: n.RunID, FlowID: n.FlowID, Step: n.Step, Attempt: n.Attempt, Input: input, Config: cfg})
	}
	if want == "" {
		// 没指定编号：第一个不是我的身份（「我」按要用的连接器认，同「与我相关」）
		probe, err := targetOf(mine[0])
		if err != nil {
			return nil, fmt.Errorf("私信 %s 发不出去：%w", ct.Name, err)
		}
		for _, x := range mine {
			self, err := in.fromMe(ctx, Message{Channel: ch, ConnectorID: probe.connectorID, Adapter: probe.adapter, SenderID: x})
			if err != nil {
				return nil, err
			}
			if !self {
				to = x
				break
			}
		}
		if to == "" {
			return nil, fmt.Errorf("联系人 %s 没有 %s 身份（只有你自己的）", ct.Name, chLabel)
		}
	}
	meta := writeMeta(n)
	if ext, _, found, err := in.sentToMeBefore(ctx, meta); found {
		if err != nil {
			return nil, errors.New(strings.Replace(err.Error(), "私信发不出去", "私信 "+ct.Name+" 发不出去", 1))
		}
		return with(input, "sent_to", map[string]any{"contact": ct.Name, "to": to, "text": text, "external_id": ext, "reused": true}), nil
	}
	t, err := targetOf(to)
	if err != nil {
		return nil, fmt.Errorf("私信 %s 发不出去：%w", ct.Name, err)
	}
	ext, _, err := in.sendDirect(ctx, t, "", text, "", n.RunID, meta, "私信 "+ct.Name)
	if err != nil {
		return nil, errors.New(strings.Replace(err.Error(), "私信发不出去", "私信 "+ct.Name+" 发不出去", 1))
	}
	return with(input, "sent_to", map[string]any{"contact": ct.Name, "to": to, "text": text, "external_id": ext,
		"at": in.clock().UTC().Format(timeLayout)}), nil
}

/* ---------- 内置流程 ---------- */

func fdeForwardFlow() plugin.SOPFlowTemplate {
	steps := []intakeStep{
		{Key: "digest", Name: "整理消息摘要", Kind: NodeMessageDigest, After: []string{},
			Desc: "拼出原始消息（发信人、会话、时间、原文、附件名）和新任务编号、链接；拆分出几条任务时都列上"},
		{Key: "send", Name: "私信 FDE 反馈收件人", Kind: NodeSendContact, After: []string{"digest"},
			Desc:   "收件人和开头文字在这一步里改；联系人没有这个 Slack 身份时失败并写明，发送失败记运行异常，任务不受影响",
			Config: map[string]string{"contact": fdeDefaultContact, "to": fdeDefaultTo, "channel": connector.SlackTool, "text": fdeDefaultText}},
	}
	fields := []map[string]any{
		{"key": "message_id", "label": "IM 消息", "type": "text", "required": true, "placeholder": "消息 id；手动转任务时自动带上"},
		{"key": "message_ids", "label": "同组消息", "type": "text", "placeholder": "拆分任务时会话带的一组消息 id，可空"},
		{"key": "task_ids", "label": "任务", "type": "text", "placeholder": "新建的任务 id，可空（空时取这条消息转成、拆出来的任务）"},
	}
	sb, _ := json.Marshal(steps)
	fb, _ := json.Marshal(fields)
	return plugin.SOPFlowTemplate{
		ID: FDEForwardFlowID, Name: "FDE 反馈转发", Trigger: "manual", Fields: fb, Steps: sb,
		Desc: "我在 IM 消息页手动把消息转成任务（转任务、拆分任务）后，私信 Robot.CyberBroleez 一条「FDE 反馈」+ 原始消息 + 任务编号和链接；" +
			"同一条消息只发一次，拆分出几条任务汇成一条。默认停用：在 IM 消息页「渠道配置」里打开「FDE 反馈转发」才会自动发；收件人、开头文字在「私信 FDE 反馈收件人」这一步里改",
	}
}
