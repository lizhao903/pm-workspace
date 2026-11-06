package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// --- SOP 流程的查询与编辑（TSK-0480）：list_sops / get_sop 只读，create_sop 新建、update_sop 修改 ---
// 经内核注册表（schedule.SOPCatalog）交给 SOP 插件，校验和 POST / PATCH /api/sop/flows 同一套。
// 之前助手只有 run_sop，flow_id 只能靠猜，「建一个流程」只能拿 create_object 建任务凑（会话 ags_06gtxj0d159ynhvd）。

const (
	toolListSOPs  = "list_sops"
	toolGetSOP    = "get_sop"
	toolCreateSOP = "create_sop"
	toolUpdateSOP = "update_sop"

	// ReadSOPAbility / WriteSOPAbility 是查、改 SOP 流程的内置能力
	ReadSOPAbility  = "read_sop"
	WriteSOPAbility = "write_sop"

	// maxSOPList 是 list_sops 和 run_sop 失败时列出的流程数上限
	maxSOPList = 50
)

// sopTriggers 是 trigger.type 能取的值，同编辑器的三种触发方式。
var sopTriggers = []string{"manual", "im", "schedule"}

// sopTriggerKeys 是 create_sop / update_sop 的 trigger 对象里现在认的键。别的键（按会话过滤、只要 @我、执行顺序……）
// 还不支持（TSK-0481 接），不报错也不存，结果里写明「没存上」，让模型如实告诉用户。
var sopTriggerKeys = []string{"type", "rule"}

func currentSOPCatalog() schedule.SOPCatalog {
	if st := currentSOPStarter(); st != nil {
		if c, ok := st.(schedule.SOPCatalog); ok {
			return c
		}
	}
	return nil
}

func (tb *Toolbox) sopCatalogDefs() []ToolDef {
	if tb.sopAgent == nil || currentSOPCatalog() == nil {
		return nil
	}
	return []ToolDef{
		{
			Name: toolListSOPs,
			Description: "列出系统里已有的 SOP 流程（id、名称、触发方式、步骤数）。" +
				"要发起、查看或修改某个流程前先用它拿到真实的流程 id，不要自己编 id。",
			Parameters: obj(props{
				"query": str("按名称或说明过滤，可留空列全部"),
			}, nil),
		},
		{
			Name: toolGetSOP,
			Description: "读取一个 SOP 流程的完整定义（输入字段 fields、步骤 steps）和能用的节点类型。" +
				"修改流程之前先读它，照着原样改，再用 update_sop 存回去；结果末尾有能用的节点类型，新建流程前也可以读一个相近的流程参考。",
			Parameters: obj(props{
				"flow_id": str("流程 id（sop_ 开头），也接受流程名称"),
			}, []string{"flow_id"}),
		},
		{
			Name: toolCreateSOP,
			Description: "新建一个 SOP 流程（标准工作流）。用户说「建一个流程/工作流/SOP」时用它，不要用 create_object 建任务代替，也不要拿已有流程去改。" +
				"新流程的 id 由系统生成，不要自己编。" + sopStepsHint,
			Parameters: obj(sopParams(false), []string{"name", "steps"}),
		},
		{
			Name: toolUpdateSOP,
			Description: "修改一个已有的 SOP 流程，只在用户明确要改那条流程时用；只改给了的字段。" +
				"先用 get_sop 读出它和版本号，version 必须带上读到的版本号。" + sopStepsHint,
			Parameters: obj(sopParams(true), []string{"flow_id", "version"}),
		},
	}
}

// sopStepsHint 是 create_sop / update_sop 共用的步骤写法说明。
const sopStepsHint = "steps 是步骤数组，每步 " +
	`{"key":"s1","name":"步骤名","kind":"节点类型","after":["上一步 key"],"config":{"配置项":"值"}}；` +
	`条件分支 kind=decide 再写 "rule":"字段 等于 值"（也支持 不等于/包含/不包含），成立走 yes、不成立走 no，cases 不用写；` +
	`分支下的步骤写 "branch":{"of":"分支步骤 key","case":"yes 或 no"}。` +
	"能用的节点类型和必填配置在 get_sop 的结果末尾。存不上时按返回的问题改了再存。" + sopIMHint

// sopIMHint 是 IM 触发的流程能拿到什么、现在做不到什么（TSK-0480 重放：模型拿会话名比 Slack 频道编号、拿正文找「@我」，
// 用户要的「优先于其他流程」也没提）。做不到的几条由 TSK-0481 接。
const sopIMHint = "trigger.type=im 时流程输入有 message_id、channel、conversation_id（内核会话 id，cv_ 开头，不是 Slack / Telegram 的频道编号，" +
	"现在没有工具能把频道编号换成它）、relevance（me=@我、all=@所有人、dm=私聊、空串=无关），条件分支直接用这些字段，比如 relevance 不等于 me。" +
	"现在不支持：流程之间的执行顺序 / 优先级；在触发这一层按会话或 @我 过滤（每条新消息都会起一次执行，过滤只能写在条件分支里）。" +
	"用户要求这些时，回复里要明确说哪几条没做到，不要说全部完成。"

// sopParams 是 create_sop / update_sop 的参数；update 多 flow_id 和 version。
func sopParams(update bool) props {
	p := props{
		"name": str("流程名称"),
		"desc": str("一句话说明这个流程干什么"),
		"trigger": map[string]any{"type": "object", "description": "触发方式。type 是 manual（手动发起）、im（来一条 IM 消息自动发起，流程输入里有 message_id、conversation_id、relevance 等）、schedule（定时，rule 是定时规则）",
			"properties": map[string]any{
				"type": map[string]any{"type": "string", "enum": sopTriggers},
				"rule": map[string]any{"type": "object", "description": "定时规则，只有 type=schedule 时用"},
			}},
		"fields": map[string]any{"type": "array", "description": "发起时要填的输入字段，每项 {key,label,type:text|textarea|select}；可留空", "items": map[string]any{"type": "object"}},
		"steps":  map[string]any{"type": "array", "description": "步骤数组，至少一步", "items": map[string]any{"type": "object"}},
	}
	if update {
		p["flow_id"] = str("要修改的流程 id（sop_ 开头），也接受流程名称")
		p["version"] = num("get_sop 读到的版本号，防止覆盖别人的改动")
		p["steps"] = map[string]any{"type": "array", "description": "给了就是整套替换；不改步骤就别给", "items": map[string]any{"type": "object"}}
	}
	return p
}

func (tb *Toolbox) listSOPs(ctx context.Context, args map[string]any) ToolResult {
	cat := currentSOPCatalog()
	if tb.sopAgent == nil || cat == nil {
		return failed(toolListSOPs, "这个会话不能查 SOP 流程")
	}
	list, err := cat.ListSOPs(ctx)
	if err != nil {
		return failed(toolListSOPs, sopErrText(err))
	}
	q := strings.ToLower(strings.TrimSpace(argStr(args, "query")))
	if q != "" {
		list = slices.DeleteFunc(list, func(f schedule.SOPFlowBrief) bool {
			return !strings.Contains(strings.ToLower(f.Name+" "+f.Desc+" "+f.ID), q)
		})
	}
	if len(list) == 0 {
		if q != "" {
			return ToolResult{Summary: fmt.Sprintf("SOP 流程里没有「%s」", q), Content: "没有匹配的流程。要新建就用 create_sop。"}
		}
		return ToolResult{Summary: "还没有 SOP 流程", Content: "系统里还没有任何 SOP 流程。要新建就用 create_sop。"}
	}
	return ToolResult{
		Summary: fmt.Sprintf("查看了 %d 个 SOP 流程", len(list)),
		Content: sopListText(list),
	}
}

// sopListText 是给模型看的流程清单，一行一条，超过上限截断并说明。
func sopListText(list []schedule.SOPFlowBrief) string {
	var b strings.Builder
	fmt.Fprintf(&b, "共 %d 个流程：\n", len(list))
	for i, f := range list {
		if i == maxSOPList {
			fmt.Fprintf(&b, "……还有 %d 个没列出，用 query 缩小范围\n", len(list)-maxSOPList)
			break
		}
		fmt.Fprintf(&b, "- flow_id=%s 名称=%s 触发=%s 步骤=%d 版本=%d", f.ID, f.Name, dash(f.Trigger), f.Steps, f.Version)
		if d := strings.TrimSpace(f.Desc); d != "" {
			fmt.Fprintf(&b, " 说明=%s", clip(oneLine(d), 60))
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (tb *Toolbox) getSOP(ctx context.Context, args map[string]any) ToolResult {
	cat := currentSOPCatalog()
	if tb.sopAgent == nil || cat == nil {
		return failed(toolGetSOP, "这个会话不能查 SOP 流程")
	}
	ref := strings.TrimSpace(argStr(args, "flow_id"))
	if ref == "" {
		return failed(toolGetSOP, "flow_id 是必填的，先用 list_sops 查到流程 id")
	}
	f, err := cat.GetSOP(ctx, ref)
	if errors.Is(err, schedule.ErrSOPNotFound) {
		return notFoundSOP(ctx, toolGetSOP, cat, err)
	}
	if err != nil {
		return failed(toolGetSOP, sopErrText(err))
	}
	var b strings.Builder
	fmt.Fprintf(&b, "flow_id=%s 名称=%s 触发=%s 版本=%d\n", f.ID, f.Name, dash(f.Trigger), f.Version)
	if d := strings.TrimSpace(f.Desc); d != "" {
		fmt.Fprintf(&b, "说明=%s\n", d)
	}
	fmt.Fprintf(&b, "fields=%s\n", clip(string(f.Fields), maxBodyRunes/2))
	fmt.Fprintf(&b, "steps=%s\n", clip(string(f.StepDefs), maxBodyRunes))
	b.WriteString(nodeKindsText(ctx, cat))
	return ToolResult{Summary: fmt.Sprintf("读取了 SOP「%s」", f.Name), Content: b.String()}
}

// nodeKindsText 是能用的节点类型，get_sop 和保存没存上时附上。
func nodeKindsText(ctx context.Context, cat schedule.SOPCatalog) string {
	kinds, err := cat.SOPNodeKinds(ctx)
	if err != nil || len(kinds) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n能用的节点类型 kind（括号里是必填的 config 项）：\n")
	for _, k := range kinds {
		fmt.Fprintf(&b, "- %s", k.Kind)
		if k.Label != "" {
			fmt.Fprintf(&b, " %s", k.Label)
		}
		if len(k.Required) > 0 {
			fmt.Fprintf(&b, "（%s）", strings.Join(k.Required, "、"))
		}
		if k.Branching {
			fmt.Fprintf(&b, " 分支出口=%s", strings.Join(k.Cases, "/"))
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (tb *Toolbox) createSOP(ctx context.Context, args map[string]any) ToolResult {
	return tb.saveSOP(ctx, toolCreateSOP, args)
}

func (tb *Toolbox) updateSOP(ctx context.Context, args map[string]any) ToolResult {
	return tb.saveSOP(ctx, toolUpdateSOP, args)
}

// saveSOP 是 create_sop、update_sop 共用的一段：新建不认 flow_id，修改要 flow_id 和 version。
func (tb *Toolbox) saveSOP(ctx context.Context, tool string, args map[string]any) ToolResult {
	cat := currentSOPCatalog()
	if tb.sopAgent == nil || cat == nil {
		return failed(tool, "这个会话不能改 SOP 流程")
	}
	update := tool == toolUpdateSOP
	id := ""
	body := map[string]json.RawMessage{}
	put := func(k string, v any) {
		b, _ := json.Marshal(v)
		body[k] = b
	}
	if update {
		if id = strings.TrimSpace(argStr(args, "flow_id")); id == "" {
			return failed(tool, "flow_id 是必填的，先用 list_sops 查到流程 id；要建新流程用 create_sop")
		}
		v := argInt(args, "version", 0)
		if v <= 0 {
			return failed(tool, "version 是必填的：先用 get_sop 读出这条流程，带上读到的版本号")
		}
		put("version", v)
	} else if strings.TrimSpace(argStr(args, "name")) == "" {
		return failed(tool, "name 是必填的")
	}
	for _, k := range []string{"name", "desc"} {
		if v, ok := argStrOK(args, k); ok {
			put(k, v)
		}
	}
	for _, k := range []string{"fields", "steps"} {
		v, ok := args[k]
		if !ok || v == nil {
			continue
		}
		arr, err := jsonArray(v)
		if err != nil {
			return failed(tool, k+" 必须是数组")
		}
		body[k] = arr
	}
	if _, ok := body["steps"]; !ok && !update {
		return failed(tool, "steps 是必填的（步骤数组），至少一步")
	}
	trig, ignored, err := sopTrigger(args["trigger"])
	if err != nil {
		return failed(tool, err.Error())
	}
	if trig != nil {
		put("trigger", trig.Type)
		if trig.Rule != nil {
			put("schedule", map[string]any{"rule": trig.Rule})
		}
	}
	f, err := cat.SaveSOP(ctx, schedule.SOPSave{ID: id, Body: body})
	if err != nil {
		if errors.Is(err, schedule.ErrSOPNotFound) {
			return notFoundSOP(ctx, tool, cat, err)
		}
		res := failed(tool, sopErrText(err))
		switch msg := sopErrText(err); {
		case strings.HasPrefix(msg, "流程没存上"):
			res.Content += "\n" + nodeKindsText(ctx, cat)
		case strings.Contains(msg, "改过"):
			res.Content += "。用 get_sop 重新读出最新的版本号和内容，在那个基础上改"
		}
		return res
	}
	verb := "新建"
	if update {
		verb = "修改"
	}
	content := fmt.Sprintf("已%s SOP「%s」：flow_id=%s 触发=%s 步骤=%d 版本=%d。", verb, f.Name, f.ID, dash(f.Trigger), f.Steps, f.Version)
	summary := fmt.Sprintf("已%s SOP「%s」（%s）", verb, f.Name, f.ID)
	if warns := stepWarnings(f.StepDefs); len(warns) > 0 {
		content += "存上了，但下面几处多半不是你想要的，用 update_sop（version=" + fmt.Sprint(f.Version) + "）改掉：" + strings.Join(warns, "；") + "。"
	}
	if len(ignored) > 0 {
		content += fmt.Sprintf("注意：trigger 里的 %s 现在还不支持，没有存上，流程不会按这些条件过滤或排序。"+
			"回复用户时要如实说明这一部分没做到，不要说已经全部完成。", strings.Join(ignored, "、"))
		summary += fmt.Sprintf("，触发条件 %s 不支持没存上", strings.Join(ignored, "、"))
	}
	return ToolResult{Summary: summary, Content: content}
}

// stepWarnings 是保存校验不拦、但模型常写错的结构（TSK-0480 临时实例重放）：条件分支没写 rule（会停下等人选）、
// rule 写进了 config、第一步以外的步骤既没有 after 也不在分支下（会和第一步同时开始）。
func stepWarnings(raw json.RawMessage) []string {
	var steps []struct {
		Key    string         `json:"key"`
		Name   string         `json:"name"`
		Kind   string         `json:"kind"`
		Rule   string         `json:"rule"`
		After  []string       `json:"after"`
		Branch map[string]any `json:"branch"`
		Config map[string]any `json:"config"`
	}
	if json.Unmarshal(raw, &steps) != nil {
		return nil
	}
	var out []string
	for i, st := range steps {
		label := fmt.Sprintf("第 %d 步「%s」", i+1, st.Name)
		if st.Kind == "decide" && strings.TrimSpace(st.Rule) == "" {
			if _, ok := st.Config["rule"]; ok {
				out = append(out, label+"的 rule 写在了 config 里，要写在步骤上（和 kind 同级）")
			} else {
				out = append(out, label+"是条件分支但没有 rule，执行到这里会停下等人手动选")
			}
		}
		if i > 0 && len(st.After) == 0 && len(st.Branch) == 0 {
			out = append(out, label+"没有 after 也不在分支下，会和第 1 步同时开始")
		}
	}
	return out
}

type sopTrig struct {
	Type string
	Rule map[string]any
}

// sopTrigger 解析 create_sop / update_sop 的 trigger：对象 {type, rule, …}，也认一个字符串（当成 type）和对象的 JSON 字符串。
// 回解析结果和不认识、没存上的键（排好序）。没给 trigger 回 nil。
func sopTrigger(v any) (*sopTrig, []string, error) {
	var m map[string]any
	switch x := v.(type) {
	case nil:
		return nil, nil, nil
	case string:
		x = strings.TrimSpace(x)
		if x == "" {
			return nil, nil, nil
		}
		if strings.HasPrefix(x, "{") {
			if err := json.Unmarshal([]byte(x), &m); err != nil {
				return nil, nil, errors.New("trigger 必须是对象 {type, …}")
			}
		} else {
			m = map[string]any{"type": x}
		}
	case map[string]any:
		m = x
	default:
		return nil, nil, errors.New("trigger 必须是对象 {type, …}")
	}
	t := &sopTrig{Type: strings.TrimSpace(fmt.Sprint(m["type"]))}
	if m["type"] == nil || !slices.Contains(sopTriggers, t.Type) {
		return nil, nil, fmt.Errorf("trigger.type 只能是 %s 之一", strings.Join(sopTriggers, " / "))
	}
	if r, ok := m["rule"].(map[string]any); ok && t.Type == "schedule" {
		t.Rule = r
	}
	var ignored []string
	for k := range m {
		if !slices.Contains(sopTriggerKeys, k) {
			ignored = append(ignored, k)
		}
	}
	sort.Strings(ignored)
	return t, ignored, nil
}

// jsonArray 认数组，也认数组的 JSON 字符串（小模型常把嵌套结构写成字符串）。
func jsonArray(v any) (json.RawMessage, error) {
	if s, ok := v.(string); ok {
		s = strings.TrimSpace(s)
		var arr []any
		if err := json.Unmarshal([]byte(s), &arr); err != nil {
			return nil, err
		}
		v = arr
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, errors.New("not an array")
	}
	return json.Marshal(arr)
}

// notFoundSOP 是「流程不存在」时的失败结果：给人看的一句话不变，回给模型的后面接上真实存在的流程，
// 模型照着选，不再编 id（会话 ags_06gtxj0d159ynhvd 里连编了 workflow_default、sopr_123456）。
func notFoundSOP(ctx context.Context, tool string, cat schedule.SOPCatalog, err error) ToolResult {
	res := failed(tool, sopErrText(err))
	list, lerr := cat.ListSOPs(ctx)
	switch {
	case lerr != nil:
	case len(list) == 0:
		res.Content += "。系统里还没有任何 SOP 流程，要建新流程用 create_sop"
	default:
		res.Content += "。不要编 flow_id，只能从下面这些里选；都不对就如实告诉用户，或者用 create_sop 新建：\n" + sopListText(list)
	}
	return res
}

// sopErrText 是给模型看的错误：插件没启用换成一句能照做的话，其余原样。
func sopErrText(err error) string {
	if errors.Is(err, schedule.ErrSOPUnavailable) {
		return "SOP 编排插件没启用，告诉用户先在设置里启用它"
	}
	s := err.Error()
	// 包了 ErrSOPNotFound 的错误末尾是「：流程不存在」，去掉重复
	return strings.TrimSuffix(s, "："+schedule.ErrSOPNotFound.Error())
}
