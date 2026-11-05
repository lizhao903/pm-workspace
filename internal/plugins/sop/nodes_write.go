package sop

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 写节点（SOP-02a）：task 建任务、doc 新建或追加文档、contact 新建或合并联系人，经内核的写入句柄（internal/plugin/writes.go）。
// 操作者记为 sop#<运行 id>，每次写入一条审计，detail 带流程和步骤 key。
// 幂等键是「运行 id/步骤 key#尝试次数」：同一次尝试只写一次，断点续跑重跑同一次尝试（engine.go 的 resume 不加尝试次数）时取回上次写的，
// 重试、退回重做是新的一次尝试，会再写。
// doc、contact 原型里没有单独的类型（用 auto 模拟「存为内容摘录」「归档到内容」「写入新联系人」），这里新加。

// writeRun 是写节点要的运行上下文，派发时从 runner 取。
type writeRun struct {
	runID, flowID, flowName, step string
	attempt                       int
}

// afterWrite 在写入之后、结果发回之前调，测试用它模拟写完还没落库时进程退出。
var afterWrite func(ctx context.Context, step string) error

// local_append 写的是本机文件（nodes_local.go），也按写节点的口径重跑、去重。
// task_update（更新任务，TSK-0411，nodes_taskrun.go）改已有任务，改法天然幂等，同样按写节点的口径重跑。
func isWriteKind(kind string) bool {
	return kind == "task" || kind == "doc" || kind == "contact" || kind == localAppendKind || kind == taskUpdateKind
}

func (w writeRun) key() string { return fmt.Sprintf("%s/%s#%d", w.runID, w.step, w.attempt) }

func (w writeRun) meta() plugin.WriteMeta {
	return plugin.WriteMeta{Session: w.runID, Key: w.key(), Detail: map[string]any{
		"run_id": w.runID, "flow_id": w.flowID, "flow": w.flowName, "step": w.step, "attempt": w.attempt,
	}}
}

// sourceRef 是建出来的对象 props.source_ref：指回运行和步骤。
func (w writeRun) sourceRef() map[string]any {
	return map[string]any{"run_id": w.runID, "flow_id": w.flowID, "flow": w.flowName, "step": w.step, "attempt": w.attempt}
}

func runWrite(ctx context.Context, c plugin.Core, w writeRun, def stepDef, input Json) nodeResult {
	var res nodeResult
	switch def.Kind {
	case "task":
		res = writeTask(ctx, c, w, def, input)
	case "doc":
		res = writeDoc(ctx, c, w, def, input)
	case "contact":
		res = writeContact(ctx, c, w, def, input)
	case localAppendKind:
		res = writeLocal(ctx, c, w, def, input)
	case taskUpdateKind:
		res = writeTaskUpdate(ctx, c, w, def, input)
	default:
		return nodeResult{err: notWired}
	}
	if h := afterWrite; h != nil && res.err == "" {
		if err := h(ctx, w.step); err != nil {
			return nodeResult{err: err.Error()}
		}
	}
	return res
}

// writeErr 把句柄的错误转成给人看的一句话。
func writeErr(what string, err error) string {
	switch {
	case errors.Is(err, plugin.ErrNoObjectWriter), errors.Is(err, plugin.ErrWriteUnsupported):
		return what + "失败：内核没有接上写入句柄"
	case errors.Is(err, domain.ErrNotFound):
		return what + "失败：" + strings.TrimPrefix(err.Error(), domain.ErrNotFound.Error()+": ") + " 不存在"
	}
	return what + "失败：" + err.Error()
}

func reuseLog(reused bool, text string) string {
	if reused {
		return "这次尝试已经写过（服务重启后重跑），没有重复写：" + text
	}
	return text
}

// writeTask 同原型 task 节点：标题（必填，支持 {{字段}}）、优先级（默认 P2）、负责人（联系人 id 或名字，「我」和留空不指派）。
// 输出在输入上加 task: {id, ref, title, priority, assignee, status}。
func writeTask(ctx context.Context, c plugin.Core, w writeRun, def stepDef, input Json) nodeResult {
	cfg := def.Config
	title := strings.TrimSpace(render(cfg["title"], input))
	if title == "" {
		return nodeResult{err: "任务标题是空的：检查「标题」里的 {{字段}} 在输入里有没有值"}
	}
	priority := orDefault(strings.TrimSpace(cfg["priority"]), "P2")
	var logs []string
	var owner *string
	assignee := strings.TrimSpace(render(cfg["assignee"], input))
	if assignee != "" && assignee != "我" {
		if info, ok := findContact(ctx, c, assignee); ok {
			owner = &info.ID
			assignee = info.Name
		} else {
			logs = append(logs, fmt.Sprintf("负责人「%s」不在联系人里，没有指派", assignee))
		}
	}
	if owner == nil {
		assignee = "我"
	}
	body := render(cfg["body"], input)
	// 项目认 id、ref 或名字（同写进项目目录），认不出来不建，免得建出一条没挂上项目的任务
	var project *string
	projectName := ""
	if p := strings.TrimSpace(render(cfg["project"], input)); p != "" {
		info, err := c.Objects().Find(ctx, "project", p)
		if errors.Is(err, plugin.ErrNoRows) {
			return nodeResult{err: fmt.Sprintf("项目「%s」不存在：填项目 id、编号或名字，已删除的项目不算", p)}
		}
		if err != nil {
			return nodeResult{err: "读项目失败：" + err.Error()}
		}
		project, projectName = &info.ID, info.Title
	}
	// 来消息发起的执行（输入带 message_id，TSK-0411）：来源记上这条消息；这条消息已经被别的执行（别的流程、重新发起）建过任务时
	// 取回那条，不再建第二条（消息分流、IM 需求自动受理、来消息确认派发同时开着时同一条消息只建一次任务）
	ref := w.sourceRef()
	if msgID := strings.TrimSpace(txt(input["message_id"])); msgID != "" {
		ref["message_id"] = msgID
		if ex, ok := taskOfMessage(ctx, c, msgID, w.runID); ok {
			return nodeResult{output: with(input, "task", map[string]any{
				"id": ex.ID, "ref": ex.Ref, "title": ex.Title, "priority": "", "assignee": "", "status": ex.Status,
				"project_id": ex.ProjectID, "project": "", "reused": true,
			}), log: fmt.Sprintf("消息 %s 已经建过任务 %s %s，取回那条，没有再建", msgID, ex.Ref, ex.Title)}
		}
	}
	t, err := c.ObjectWriter().CreateAs(ctx, plugin.NewObject{
		TypeID: "task", Title: title, Body: body, Priority: priority, OwnerID: owner, ProjectID: project,
		Props: map[string]any{domain.PropSourceRef: ref},
	}, w.meta())
	if err != nil {
		return nodeResult{err: writeErr("建任务", err)}
	}
	logs = append(logs, reuseLog(t.Reused, fmt.Sprintf("建了任务 %s %s", t.Ref, t.Title)))
	return nodeResult{output: with(input, "task", map[string]any{
		"id": t.ID, "ref": t.Ref, "title": t.Title, "priority": priority, "assignee": assignee, "status": t.Status,
		"project_id": deref(project), "project": projectName,
	}), log: strings.Join(logs, "；")}
}

// findContact 认联系人 id 或名字。
func findContact(ctx context.Context, c plugin.Core, s string) (plugin.ContactInfo, bool) {
	if info, err := c.Contacts().Get(ctx, s); err == nil && !info.Archived {
		return info, true
	}
	info, err := c.Contacts().FindByName(ctx, s)
	return info, err == nil
}

// writeDoc 写文档：mode 为 new（默认）时新建一篇，标题默认「流程名 · 步骤名」，分类是 category（文档分类 id，可空）；
// mode 为 append 时把正文追加到 doc（文档 id，支持 {{字段}}）末尾。正文 content 支持 {{字段}}，留空时是输入的 JSON。
// 输出在输入上加 content_id（同原型）和 doc: {id, ref, title, mode}。
func writeDoc(ctx context.Context, c plugin.Core, w writeRun, def stepDef, input Json) nodeResult {
	cfg := def.Config
	content := strings.TrimSpace(render(cfg["content"], input))
	if strings.TrimSpace(cfg["content"]) == "" {
		content = "```json\n" + inputJSON(input) + "\n```"
	}
	mode := orDefault(strings.TrimSpace(cfg["mode"]), "new")
	var d plugin.CreatedObject
	var err error
	switch mode {
	case "new":
		title := strings.TrimSpace(render(cfg["title"], input))
		if title == "" {
			title = w.flowName + " · " + orDefault(def.Name, def.Key)
		}
		var cat *string
		if s := strings.TrimSpace(cfg["category"]); s != "" {
			cat = &s
		}
		d, err = c.ObjectWriter().CreateAs(ctx, plugin.NewObject{
			TypeID: "doc", Title: title, Body: content, CategoryID: cat,
			Props: map[string]any{domain.PropSourceRef: w.sourceRef()},
		}, w.meta())
		if err != nil {
			return nodeResult{err: writeErr("新建文档", err)}
		}
	case "append":
		id := strings.TrimSpace(render(cfg["doc"], input))
		if id == "" {
			return nodeResult{err: "追加到哪篇文档是空的：在「文档」里填文档 id 或 {{字段}}"}
		}
		info, gerr := c.Objects().Get(ctx, id)
		if gerr != nil || info.Deleted {
			return nodeResult{err: fmt.Sprintf("追加文档失败：文档 %s 不存在", id)}
		}
		if info.Type != "doc" {
			return nodeResult{err: fmt.Sprintf("追加文档失败：%s 不是文档", id)}
		}
		d, err = c.ObjectWriter().AppendBody(ctx, id, content, w.meta())
		if err != nil {
			return nodeResult{err: writeErr("追加文档", err)}
		}
	default:
		return nodeResult{err: fmt.Sprintf("写文档的方式「%s」不认，要是 new 或 append", mode)}
	}
	verb := "新建了文档"
	if mode == "append" {
		verb = "追加到文档"
	}
	return nodeResult{output: with(with(input, "content_id", d.ID), "doc", map[string]any{
		"id": d.ID, "ref": d.Ref, "title": d.Title, "mode": mode,
	}), log: reuseLog(d.Reused, fmt.Sprintf("%s %s %s", verb, d.Ref, d.Title))}
}

// contactFields 是联系人节点认的字段，配置留空时取输入里同名的字段（原型「AI 解析字段」的输出就是这几个）。
var contactFields = []string{"name", "company", "title", "phone", "email", "group", "note"}

// writeContact 写联系人：mode 为 new（默认）时新建，name 必填；mode 为 merge 时把非空的字段写进 id 指的联系人（id 支持 {{字段}}）。
// 输出在输入上加 contact_id（同原型）和 contact: {id, name, mode, fields}。
func writeContact(ctx context.Context, c plugin.Core, w writeRun, def stepDef, input Json) nodeResult {
	cfg := def.Config
	vals := map[string]string{}
	for _, f := range contactFields {
		v := cfg[f]
		if strings.TrimSpace(v) == "" {
			v = txt(getPath(input, f))
		} else {
			v = render(v, input)
		}
		if v = strings.TrimSpace(v); v != "" {
			vals[f] = v
		}
	}
	mode := orDefault(strings.TrimSpace(cfg["mode"]), "new")
	var out plugin.WrittenContact
	var err error
	switch mode {
	case "new":
		if vals["name"] == "" {
			return nodeResult{err: "联系人姓名是空的：输入里没有 name，也没有在「姓名」里配置"}
		}
		out, err = c.ContactWriter().Create(ctx, plugin.NewContact{Name: vals["name"], Company: vals["company"], Title: vals["title"],
			Phone: vals["phone"], Email: vals["email"], Group: vals["group"], Note: vals["note"]}, w.meta())
		if err != nil {
			return nodeResult{err: writeErr("新建联系人", err)}
		}
	case "merge":
		id := strings.TrimSpace(render(cfg["id"], input))
		if id == "" {
			id = strings.TrimSpace(txt(getPath(input, "contact_id")))
		}
		if id == "" {
			return nodeResult{err: "合并到哪个联系人是空的：在「联系人」里填 id 或 {{字段}}"}
		}
		if _, gerr := c.Contacts().Get(ctx, id); gerr != nil {
			return nodeResult{err: fmt.Sprintf("合并联系人失败：联系人 %s 不存在", id)}
		}
		ptr := func(k string) *string {
			if v, ok := vals[k]; ok {
				return &v
			}
			return nil
		}
		if len(vals) == 0 {
			return nodeResult{err: "没有要合并的字段"}
		}
		out, err = c.ContactWriter().Merge(ctx, id, plugin.ContactPatch{Name: ptr("name"), Company: ptr("company"), Title: ptr("title"),
			Phone: ptr("phone"), Email: ptr("email"), Group: ptr("group"), Note: ptr("note")}, w.meta())
		if err != nil {
			return nodeResult{err: writeErr("合并联系人", err)}
		}
	default:
		return nodeResult{err: fmt.Sprintf("写联系人的方式「%s」不认，要是 new 或 merge", mode)}
	}
	fields := out.Fields
	if fields == nil {
		fields = []string{}
	}
	verb := "新建了联系人"
	if mode == "merge" {
		verb = "合并到联系人"
	}
	return nodeResult{output: with(with(input, "contact_id", out.ID), "contact", map[string]any{
		"id": out.ID, "name": out.Name, "mode": mode, "fields": fields,
	}), log: reuseLog(out.Reused, verb+" "+out.Name)}
}
