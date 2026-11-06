package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
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
	// toolTestSOP、toolExplainIM 是调试（TSK-0491）：只读，归「查 SOP 流程」
	toolTestSOP   = "test_sop"
	toolExplainIM = "explain_im_trigger"

	// ReadSOPAbility / WriteSOPAbility 是查、改 SOP 流程的内置能力
	ReadSOPAbility  = "read_sop"
	WriteSOPAbility = "write_sop"

	// maxSOPList 是 list_sops 和 run_sop 失败时列出的流程数上限
	maxSOPList = 50
)

// sopTriggers 是 trigger.type 能取的值，同编辑器的三种触发方式。
var sopTriggers = []string{"manual", "im", "schedule"}

// sopTriggerKeys 是 create_sop / update_sop 的 trigger 对象里认的键：type、rule（定时规则），
// 以及 IM 触发的过滤、执行顺序、拦截（TSK-0481），映射成保存请求的 im。别的键不报错也不存，结果里写明「没存上」，让模型如实告诉用户。
var sopTriggerKeys = []string{"type", "rule", "conversations", "relevance", "relevance_mode", "order", "stop"}

// sopConvAliases 是模型常写的「会话」别名，都当 conversations。
var sopConvAliases = []string{"conversation", "conversation_id", "conversation_ids"}

func currentSOPCatalog() schedule.SOPCatalog {
	if st := currentSOPStarter(); st != nil {
		if c, ok := st.(schedule.SOPCatalog); ok {
			return c
		}
	}
	return nil
}

// currentSOPDebugger 是发起入口实现了调试接口时的它（TSK-0491），SOP 插件旧版本没有时为 nil。
func currentSOPDebugger() schedule.SOPDebugger {
	if st := currentSOPStarter(); st != nil {
		if d, ok := st.(schedule.SOPDebugger); ok {
			return d
		}
	}
	return nil
}

func (tb *Toolbox) sopCatalogDefs() []ToolDef {
	if tb.sopAgent == nil || currentSOPCatalog() == nil {
		return nil
	}
	return append([]ToolDef{
		{
			Name: toolListSOPs,
			Description: "列出系统里已有的 SOP 流程（id、名称、触发方式、步骤数、所在文件夹），开头列出流程库的文件夹和各自的流程数。" +
				"要发起、查看或修改某个流程前先用它拿到真实的流程 id，不要自己编 id。用户说「某个文件夹里的流程」时用 folder 只列那个文件夹。",
			Parameters: obj(props{
				"query":  str("按名称或说明过滤，可留空列全部"),
				"folder": str("只列这个文件夹里的流程：文件夹名字或 id；写「未分类」列没放进文件夹的；留空列全部"),
			}, nil),
		},
		{
			Name: toolGetSOP,
			Description: "读取一个 SOP 流程的完整定义（输入字段 fields、步骤 steps）、它现在的问题，以及编排说明（能用的节点、每个节点的配置项和输出字段、触发方式自动带入的字段、条件写法）。" +
				"修改流程之前先读它，照着原样改，再用 update_sop 存回去；新建流程前先读一个相近的流程，拿到末尾的编排说明再写。",
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
	}, tb.sopDebugDefs()...)
}

// sopDebugDefs 是调试的两个只读工具（TSK-0491）；SOP 插件没实现调试接口时不给。
func (tb *Toolbox) sopDebugDefs() []ToolDef {
	if currentSOPDebugger() == nil {
		return nil
	}
	return []ToolDef{
		{
			Name: toolTestSOP,
			Description: "调试一个 SOP 流程：用一条真实消息（或给的输入）把流程按真实引擎走一遍，只读、算、调模型的节点真实执行，" +
				"写操作（标记消息、发消息、建任务、写文件、调外部接口……）不执行、只列出将做什么，不建执行记录、不改任何数据。" +
				"回每一步的真实输入输出、条件分支每条条件的真实值和走向、失败原因、实际多返回的没声明字段。" +
				"建完或改完流程后必须先用它调试一遍，再把调试结论（走了哪些步、分支怎么走、将做什么、有没有失败）告诉用户；用户问流程为什么不对时也先用它。",
			Parameters: obj(props{
				"flow_id":     str("流程 id（sop_ 开头），也接受流程名称"),
				"message_id":  str("用作输入的真实消息 id（msg_ 开头）；IM 触发的流程不给时取这条流程最近一次执行或没发起的那条消息"),
				"input":       map[string]any{"type": "object", "description": "手填的输入字段 {key: 值}，和消息带进来的字段合并（手填优先）；可留空"},
				"skip_models": boolean("true 时调模型的节点不调，用占位输出（省时间、省钱）；默认 false 照常调"),
			}, []string{"flow_id"}),
		},
		{
			Name: toolExplainIM,
			Description: "模拟一条 IM 消息触发 IM 流程：按真实口径把每条触发方式是 IM 的流程按执行顺序判一遍——过滤条件哪条不符、" +
				"是否已经为这条消息发起过、必填输入补不补得齐、有没有被前面的流程拦截、发信人是不是被自动忽略，最后会发起哪几条。不真发起、不改数据。" +
				"用户问「这条消息为什么没触发」「这条消息会跑哪些流程」时用它。",
			Parameters: obj(props{
				"message_id": str("消息 id（msg_ 开头）"),
			}, []string{"message_id"}),
		},
	}
}

func (tb *Toolbox) testSOP(ctx context.Context, args map[string]any) ToolResult {
	dbg := currentSOPDebugger()
	if tb.sopAgent == nil || dbg == nil {
		return failed(toolTestSOP, "这个会话不能调试 SOP 流程")
	}
	ref := strings.TrimSpace(argStr(args, "flow_id"))
	if ref == "" {
		return failed(toolTestSOP, "flow_id 是必填的，先用 list_sops 查到流程 id")
	}
	q := schedule.SOPTest{FlowID: ref, MessageID: strings.TrimSpace(argStr(args, "message_id")), SkipModels: argBool(args, "skip_models")}
	if v, ok := args["input"]; ok && v != nil {
		m, ok := v.(map[string]any)
		if !ok {
			if s, isStr := v.(string); isStr && strings.TrimSpace(s) != "" {
				if json.Unmarshal([]byte(s), &m) != nil {
					return failed(toolTestSOP, "input 必须是对象 {key: 值}")
				}
			} else if !isStr {
				return failed(toolTestSOP, "input 必须是对象 {key: 值}")
			}
		}
		q.Input = m
	}
	out, err := dbg.TestSOP(ctx, q)
	if errors.Is(err, schedule.ErrSOPNotFound) {
		if cat := currentSOPCatalog(); cat != nil {
			return notFoundSOP(ctx, toolTestSOP, cat, err)
		}
	}
	if err != nil {
		return failed(toolTestSOP, sopErrText(err))
	}
	return ToolResult{Summary: "调试了 SOP " + ref + "（不真写）", Content: out}
}

func (tb *Toolbox) explainIMTrigger(ctx context.Context, args map[string]any) ToolResult {
	dbg := currentSOPDebugger()
	if tb.sopAgent == nil || dbg == nil {
		return failed(toolExplainIM, "这个会话不能调试 SOP 流程")
	}
	id := strings.TrimSpace(argStr(args, "message_id"))
	if id == "" {
		return failed(toolExplainIM, "message_id 是必填的")
	}
	out, err := dbg.ExplainIMTrigger(ctx, id)
	if err != nil {
		return failed(toolExplainIM, sopErrText(err))
	}
	return ToolResult{Summary: "模拟了消息 " + id + " 触发 IM 流程（不真发起）", Content: out}
}

// sopStepsHint 是 create_sop / update_sop 共用的步骤写法说明；节点目录、配置项、输出字段在 get_sop 末尾的编排说明里（TSK-0490，同编辑器 AI 协助）。
const sopStepsHint = "steps 是步骤数组，每步 " +
	`{"key":"s1","name":"步骤名","kind":"节点类型","after":["上一步 key"],"config":{"配置项":"值"}}，config 只写这个节点声明了的配置项；` +
	`条件分支 kind=decide 写结构化条件 "cond":{"logic":"and","items":[{"field":"字段路径","op":"eq","value":"值"}]}` +
	`（op 是 eq/ne/contains/not_contains/empty/not_empty，logic 是 and 或 or），成立走 yes、不成立走 no，cases 不用写；` +
	"field 只能用这一步真实拿得到的字段（触发方式自动带入的、输入字段、上游节点声明的输出），不要写 rule，也不要把一句话当条件，说明写进 desc；" +
	`分支下的步骤写 "branch":{"of":"分支步骤 key","case":"yes 或 no"}。自动执行（auto）什么都不做，要改数据用对应的写节点。` +
	"能用的节点、配置项和输出字段在 get_sop 结果末尾的编排说明里。存不上时按返回的问题改了再存；存上了但有警告时，结果里会列出来，按警告改掉。" +
	"存上之后先用 test_sop 调试一遍（IM 触发的流程带一条真实消息的 message_id），把调试结论告诉用户再结束，不要只说「建好了」。" + sopIMHint

// sopIMHint 是 IM 触发的流程能拿到什么、现在做不到什么（TSK-0480 重放：模型拿会话名比 Slack 频道编号、拿正文找「@我」，
// 用户要的「优先于其他流程」也没提）。做不到的几条由 TSK-0481 接。
const sopIMHint = "trigger.type=im 时流程输入有 message_id、channel、conversation_id（内核会话 id，cv_ 开头）、relevance（me=@我、all=@所有人、dm=私聊、空串=无关）。" +
	"要只处理某些消息时，优先在 trigger 里写过滤条件，不符合的消息不会发起执行：" +
	`conversations 是会话数组，可以直接写渠道里的会话编号（如 Slack 的 "C0BNCBRL5C0"）、会话名或 cv_ id；` +
	`relevance 是与我的关系数组（me / all / dm / none，none=无关），relevance_mode 是 include（只要这几种，默认）或 exclude（除了这几种），` +
	`比如「除了 @我 的」写 "relevance":["me"],"relevance_mode":"exclude"。` +
	"order 是在所有 IM 流程里排第几（1 最先执行）；stop=true 表示这条流程命中并发起后，排在它后面的 IM 流程不再处理这条消息（「先于其他流程」「处理完别的流程不要再管」就用 order=1 加 stop=true）。" +
	"把消息标为忽略用 IM 插件的标记消息节点（im_mark_message，state=ignore）。"

// sopParams 是 create_sop / update_sop 的参数；update 多 flow_id 和 version。
func sopParams(update bool) props {
	p := props{
		"name": str("流程名称"),
		"desc": str("一句话说明这个流程干什么"),
		"trigger": map[string]any{"type": "object", "description": "触发方式。type 是 manual（手动发起）、im（来一条 IM 消息自动发起，流程输入里有 message_id、conversation_id、relevance 等）、schedule（定时，rule 是定时规则）",
			"properties": map[string]any{
				"type": map[string]any{"type": "string", "enum": sopTriggers},
				"rule": map[string]any{"type": "object", "description": "定时规则，只有 type=schedule 时用"},
				"conversations": map[string]any{"type": "array", "items": map[string]any{"type": "string"},
					"description": "只有 type=im 时用：只处理这些会话的消息，写会话编号（如 Slack 的 C0BNCBRL5C0）、会话名或 cv_ id；空数组表示全部会话"},
				"relevance": map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": []string{"me", "all", "dm", "none"}},
					"description": "只有 type=im 时用：与我的关系，me=@我、all=@所有人、dm=私聊、none=无关；空数组表示不限"},
				"relevance_mode": map[string]any{"type": "string", "enum": []string{"include", "exclude"}, "description": "include 只要 relevance 里的几种（默认），exclude 除了这几种"},
				"order":          map[string]any{"type": "integer", "description": "只有 type=im 时用：在所有 IM 流程里排第几执行，1 最先；不给时新流程排最后"},
				"stop":           map[string]any{"type": "boolean", "description": "只有 type=im 时用：true 表示这条流程命中并发起后，排在后面的 IM 流程不再处理这条消息"},
			}},
		"fields": map[string]any{"type": "array", "description": "发起时要填的输入字段，每项 {key,label,type:text|textarea|select}；可留空", "items": map[string]any{"type": "object"}},
		"steps":  map[string]any{"type": "array", "description": "步骤数组，至少一步", "items": map[string]any{"type": "object"}},
		"folder": str("放进流程库的哪个文件夹：文件夹名字（list_sops 开头列着已有的）；没有这个名字的文件夹会新建一个；写「未分类」放回未分类；不给就不放进文件夹（修改时不给就不动）"),
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
	// 下面按文件夹、关键字原地筛，先拷一份，不动目录回来的切片
	list = slices.Clone(list)
	folders, err := cat.ListSOPFolders(ctx)
	if err != nil {
		return failed(toolListSOPs, sopErrText(err))
	}
	head := sopFoldersText(folders)
	// 按文件夹列（TSK-0482）：认文件夹名字（不分大小写）或 id，「未分类」是没放进文件夹的
	where := ""
	if ref := strings.TrimSpace(argStr(args, "folder")); ref != "" {
		name, ok := matchSOPFolder(folders, ref)
		if !ok {
			return failed(toolListSOPs, fmt.Sprintf("没有叫「%s」的文件夹。%s", ref, head))
		}
		where = "文件夹「" + name + "」"
		if name == sopUncategorized {
			name, where = "", "「未分类」"
		}
		list = slices.DeleteFunc(list, func(f schedule.SOPFlowBrief) bool { return f.Folder != name })
	}
	q := strings.ToLower(strings.TrimSpace(argStr(args, "query")))
	if q != "" {
		list = slices.DeleteFunc(list, func(f schedule.SOPFlowBrief) bool {
			return !strings.Contains(strings.ToLower(f.Name+" "+f.Desc+" "+f.ID), q)
		})
	}
	if len(list) == 0 {
		switch {
		case q != "":
			return ToolResult{Summary: fmt.Sprintf("SOP 流程里没有「%s」", q), Content: "没有匹配的流程。要新建就用 create_sop。" + head}
		case where != "":
			return ToolResult{Summary: where + "里没有 SOP 流程", Content: where + "里还没有流程。" + head}
		}
		return ToolResult{Summary: "还没有 SOP 流程", Content: "系统里还没有任何 SOP 流程。要新建就用 create_sop。"}
	}
	summary := fmt.Sprintf("查看了 %d 个 SOP 流程", len(list))
	if where != "" {
		summary = fmt.Sprintf("查看了%s里的 %d 个 SOP 流程", where, len(list))
	}
	return ToolResult{Summary: summary, Content: head + sopListText(list)}
}

// sopUncategorized 是没放进文件夹的流程的叫法，同流程库界面。
const sopUncategorized = "未分类"

// sopFoldersText 是流程库的文件夹一行，给模型看；一个文件夹都没有时为空串。
func sopFoldersText(f schedule.SOPFolders) string {
	if len(f.Folders) == 0 {
		return ""
	}
	parts := make([]string, 0, len(f.Folders)+1)
	for _, x := range f.Folders {
		parts = append(parts, fmt.Sprintf("%s（%d 个）", x.Name, x.Count))
	}
	parts = append(parts, fmt.Sprintf("%s（%d 个）", sopUncategorized, f.Uncategorized))
	return "文件夹：" + strings.Join(parts, "、") + "\n"
}

// matchSOPFolder 按名字（不分大小写）或 id 认文件夹，回它的名字；「未分类」回 sopUncategorized。
func matchSOPFolder(f schedule.SOPFolders, ref string) (string, bool) {
	if ref == sopUncategorized {
		return sopUncategorized, true
	}
	for _, x := range f.Folders {
		if x.ID == ref || strings.EqualFold(x.Name, ref) {
			return x.Name, true
		}
	}
	return "", false
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
		fmt.Fprintf(&b, "- flow_id=%s 名称=%s 文件夹=%s 触发=%s 步骤=%d 版本=%d", f.ID, f.Name, folderOr(f.Folder), dash(f.Trigger), f.Steps, f.Version)
		if f.IMTrigger != "" {
			fmt.Fprintf(&b, " IM 条件=%s", f.IMTrigger)
		}
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
	fmt.Fprintf(&b, "flow_id=%s 名称=%s 文件夹=%s 触发=%s 版本=%d\n", f.ID, f.Name, folderOr(f.Folder), dash(f.Trigger), f.Version)
	if f.IMTrigger != "" {
		fmt.Fprintf(&b, "IM 触发条件=%s\n", f.IMTrigger)
	}
	if d := strings.TrimSpace(f.Desc); d != "" {
		fmt.Fprintf(&b, "说明=%s\n", d)
	}
	fmt.Fprintf(&b, "fields=%s\n", clip(string(f.Fields), maxBodyRunes/2))
	fmt.Fprintf(&b, "steps=%s\n", clip(string(f.StepDefs), maxBodyRunes))
	if len(f.Warnings) > 0 {
		b.WriteString("这条流程现在的问题（改它时一起改掉）：\n- " + strings.Join(f.Warnings, "\n- ") + "\n")
	}
	b.WriteString(nodeKindsText(ctx, cat))
	return ToolResult{Summary: fmt.Sprintf("读取了 SOP「%s」", f.Name), Content: b.String()}
}

// folderOr 是给模型看的文件夹名，没放进文件夹的写「未分类」。
func folderOr(name string) string {
	if name == "" {
		return sopUncategorized
	}
	return name
}

// nodeKindsText 是编排说明（节点目录、配置项、输出字段、条件写法，TSK-0490），get_sop 和保存没存上时附上；
// SOP 插件给不出说明时退回只列节点类型和必填配置。
func nodeKindsText(ctx context.Context, cat schedule.SOPCatalog) string {
	if g, err := cat.SOPGuide(ctx); err == nil && strings.TrimSpace(g) != "" {
		return "\n编排说明：\n" + g
	}
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
	for _, k := range []string{"name", "desc", "folder"} {
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
		if len(trig.IM) > 0 {
			put("im", trig.IM)
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
	content := fmt.Sprintf("已%s SOP「%s」：flow_id=%s 文件夹=%s 触发=%s 步骤=%d 版本=%d。", verb, f.Name, f.ID, folderOr(f.Folder), dash(f.Trigger), f.Steps, f.Version)
	if f.FolderCreated {
		content += "新建了文件夹「" + f.Folder + "」。"
	}
	if f.IMTrigger != "" {
		content += "IM 触发条件：" + f.IMTrigger + "。"
	}
	if currentSOPDebugger() != nil {
		content += "接着用 test_sop（flow_id=" + f.ID + "）调试一遍，把调试结论告诉用户。"
	}
	summary := fmt.Sprintf("已%s SOP「%s」（%s）", verb, f.Name, f.ID)
	// 保存校验的警告（TSK-0490）：同编辑器保存后的提示
	if len(f.Warnings) > 0 {
		content += "保存校验有这几处警告，多半不是用户想要的，用 update_sop（version=" + fmt.Sprint(f.Version) + "）改掉，改不了的如实告诉用户：" +
			strings.Join(f.Warnings, "；") + "。"
	}
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
		Cond   any            `json:"cond"`
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
		if st.Kind == "decide" && strings.TrimSpace(st.Rule) == "" && st.Cond == nil {
			_, inCfg := st.Config["cond"]
			if _, ok := st.Config["rule"]; ok || inCfg {
				out = append(out, label+"的条件写在了 config 里，要写成步骤上的 cond（和 kind 同级）")
			} else {
				out = append(out, label+"是条件分支但没有 cond，执行到这里会停下等人手动选")
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
	// IM 是保存请求里的 im：conversations、relevance、relevance_mode、order、stop，没给的不带（TSK-0481）
	IM map[string]any
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
	m = maps.Clone(m) // 下面会改别名，不动调用方的参数
	t := &sopTrig{Type: strings.TrimSpace(fmt.Sprint(m["type"]))}
	if m["type"] == nil || !slices.Contains(sopTriggers, t.Type) {
		return nil, nil, fmt.Errorf("trigger.type 只能是 %s 之一", strings.Join(sopTriggers, " / "))
	}
	if r, ok := m["rule"].(map[string]any); ok && t.Type == "schedule" {
		t.Rule = r
	}
	t.IM = map[string]any{}
	for _, k := range sopConvAliases {
		if v, ok := m[k]; ok && m["conversations"] == nil {
			m["conversations"] = v
		}
		delete(m, k)
	}
	for _, k := range []string{"conversations", "relevance"} {
		if v, ok := m[k]; ok && v != nil {
			// 模型常把一个值写成字符串，或写成逗号隔开的一串
			if s, isStr := v.(string); isStr {
				var list []string
				for _, x := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == '，' || r == '、' }) {
					if x = strings.TrimSpace(x); x != "" {
						list = append(list, x)
					}
				}
				v = list
			}
			t.IM[k] = v
		}
	}
	for _, k := range []string{"relevance_mode", "order", "stop"} {
		if v, ok := m[k]; ok && v != nil {
			t.IM[k] = v
		}
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
