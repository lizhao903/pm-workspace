package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- Agent 工具授权（AG-02a）：给模型的工具列表只放实际档位不是关闭的，硬调没授权的不执行 ---

// Ability 是一项内置能力，同原型 web-next/src/agentdata.ts 的 ABILITIES。只读的没有「需确认」。
type Ability struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Group string `json:"group"`
	Write bool   `json:"write"`
}

// Abilities 同原型 ABILITIES，顺序也一样。
var Abilities = []Ability{
	{"read_messages", "读 IM 消息", "IM 消息", false},
	{"reply_message", "回复 IM 消息", "IM 消息", true},
	{"read_contacts", "查联系人", "联系人", false},
	{"write_contacts", "新建 / 修改联系人", "联系人", true},
	{"read_tasks", "查任务", "任务", false},
	{"write_tasks", "新建 / 更新任务", "任务", true},
	{"read_content", "读文档", "文档", false},
	{"write_content", "写文档", "文档", true},
	{"read_sop", "查 SOP 流程", "SOP", false},
	{"write_sop", "新建 / 修改 SOP 流程", "SOP", true},
	{"run_sop", "发起 SOP", "SOP", true},
}

// AbilityOf 按 key 取内置能力。
func AbilityOf(key string) (Ability, bool) {
	for _, a := range Abilities {
		if a.Key == key {
			return a, true
		}
	}
	return Ability{}, false
}

// ToolAbility 是内置工具归哪项能力，契约「Agent 工具授权」一节有同一张表。
// 空串表示不需要授权：ask_user 是反问用户，list_types 只列类型和状态 key，都不碰用户数据。
var ToolAbility = map[string]string{
	"search_objects": "read_tasks",
	"get_object":     "read_tasks",
	toolProgress:     "write_tasks",
	"list_types":     "",
	"create_object":  "write_tasks",
	"update_object":  "write_tasks",
	"write_file":     "write_content",
	toolKbSearch:     KbSearchAbility,
	toolRunSOP:       RunSOPAbility,
	toolListSOPs:     ReadSOPAbility,
	toolGetSOP:       ReadSOPAbility,
	toolCreateSOP:    WriteSOPAbility,
	toolUpdateSOP:    WriteSOPAbility,
	toolAskUser:      "",
}

var grantRank = map[string]int{store.GrantOff: 0, store.GrantConfirm: 1, store.GrantAuto: 2}

// MinMode 取两个档位里低的那个，顺序 关闭 < 需确认 < 自动；认不出的按关闭。
func MinMode(a, b string) string {
	ra, oka := grantRank[a]
	rb, okb := grantRank[b]
	if !oka || !okb {
		return store.GrantOff
	}
	if ra <= rb {
		return a
	}
	return b
}

// ConnTool 是挂在 Agent 上的一个连接器工具。Mode 是算好的实际档位：min(Agent 授权, 连接器上限)。
type ConnTool struct {
	// Name 是给模型的工具名，见 ConnToolName
	Name          string
	Key           string // conn:<连接器 id>:<工具名>
	ConnectorID   string
	ConnectorName string
	Tool          string // 连接器上的工具名
	Desc          string
	Write         bool
	Mode          string
	// Schema 是参数的 JSON Schema（自定义 MCP、OpenAPI 才有），没有时给模型一个空对象
	Schema json.RawMessage
	// Call 真正调对方，args 是模型给的参数 JSON 原文
	Call func(ctx context.Context, args string) (string, error)
}

var connNameRe = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// ConnToolName 是连接器工具给模型的名字：<连接器定义 key>__<工具名>，各家都只认字母数字、下划线和短横，最长 64。
// 同一定义接了多个实例、或截断后撞名时由 UniqueConnNames 加序号。
func ConnToolName(defTool, tool string) string {
	n := connNameRe.ReplaceAllString(defTool+"__"+tool, "_")
	if len(n) > 64 {
		n = n[:64]
	}
	return n
}

// UniqueConnNames 让给模型的名字不重（CONN-04，同一工具可以接多个实例）：按挂载顺序，
// 第一个保持原名，后面撞名的在定义 key 后加序号，如 custom_mcp_2__search。
func UniqueConnNames(conns []ConnTool) {
	seen := map[string]bool{}
	for i := range conns {
		n := conns[i].Name
		if seen[n] {
			head, tail, _ := strings.Cut(n, "__")
			for k := 2; seen[n]; k++ {
				n = ConnToolName(fmt.Sprintf("%s_%d", head, k), tail)
			}
			conns[i].Name = n
		}
		seen[n] = true
	}
}

// Policy 是一个 Agent 的工具授权。nil 是没挂 Agent 的老会话：内置工具都能用，没有连接器工具。
type Policy struct {
	// Grants 是 Agent 存着的授权 key -> confirm / auto，没有的就是关闭
	Grants map[string]string
	// Conn 是挂着的连接器的工具，关闭的也在里面（硬调时回「没有授权」）
	Conn []ConnTool
}

// ModeOf 是一个工具的实际档位和授权 key。不认识的名字回 auto，交给 Toolbox 回「没有这个工具」。
func (p *Policy) ModeOf(name string) (mode, key string) {
	if p == nil {
		return store.GrantAuto, ""
	}
	if c := p.conn(name); c != nil {
		return c.Mode, c.Key
	}
	ab, ok := ToolAbility[name]
	if !ok {
		return store.GrantAuto, ""
	}
	if ab == "" {
		return store.GrantAuto, ""
	}
	m := p.Grants[ab]
	if m == "" {
		m = store.GrantOff
	}
	// 只读能力没有「需确认」
	if a, ok := AbilityOf(ab); ok && !a.Write && m == store.GrantConfirm {
		m = store.GrantAuto
	}
	return m, ab
}

func (p *Policy) conn(name string) *ConnTool {
	if p == nil {
		return nil
	}
	for i := range p.Conn {
		if p.Conn[i].Name == name {
			return &p.Conn[i]
		}
	}
	return nil
}

// ReadOnly 是只读的一份：写能力的授权去掉、会改对方数据的连接器工具关掉（TSK-0460，只读角色交给 Agent 执行）。
// 不改原来那份；nil 回 nil（没挂 Agent 的会话不会走到这里，任务执行一定挂着 Agent）。
func (p *Policy) ReadOnly() *Policy {
	if p == nil {
		return nil
	}
	out := &Policy{Grants: map[string]string{}}
	for k, v := range p.Grants {
		if a, ok := AbilityOf(k); ok && a.Write {
			continue
		}
		out.Grants[k] = v
	}
	for _, c := range p.Conn {
		if c.Write {
			c.Mode = store.GrantOff
		}
		out.Conn = append(out.Conn, c)
	}
	return out
}

// Tools 是给模型的工具列表：内置的去掉关闭的，后面接上没关闭的连接器工具。
func (p *Policy) Tools(builtin []ToolDef) []ToolDef {
	if p == nil {
		return builtin
	}
	out := make([]ToolDef, 0, len(builtin)+len(p.Conn))
	for _, d := range builtin {
		if m, _ := p.ModeOf(d.Name); m != store.GrantOff {
			out = append(out, d)
		}
	}
	for _, c := range p.Conn {
		if c.Mode == store.GrantOff {
			continue
		}
		desc := fmt.Sprintf("连接器「%s」的工具 %s：%s", c.ConnectorName, c.Tool, dash(c.Desc))
		if c.Write {
			desc += "。会改动对方的数据"
		}
		var params map[string]any
		if len(c.Schema) > 0 {
			_ = json.Unmarshal(c.Schema, &params)
		}
		if params == nil {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, ToolDef{Name: c.Name, Description: desc, Parameters: params})
	}
	return out
}

// deniedResult 是硬调没授权的工具时回给模型的结果，不执行。
func deniedResult(name string) ToolResult {
	return ToolResult{
		Failed:  true,
		Summary: fmt.Sprintf("%s 没有授权，没有执行", name),
		Content: "错误：没有授权。这个工具没有开给你，不要再调它；确实需要的话，请用户在 Agent 设置的「工具与权限」里打开。",
	}
}

// invoke 执行一次调用：连接器工具走它的 Call，其余交给 Toolbox。
func (r *Runner) invoke(ctx context.Context, tb *Toolbox, call ToolCall) ToolResult {
	c := r.Policy.conn(call.Name)
	if c == nil {
		return tb.Invoke(ctx, call)
	}
	if c.Call == nil {
		return failed(call.Name, "这个连接器的工具还不能调用")
	}
	out, err := c.Call(ctx, defaultArgs(call.Args))
	if err != nil {
		return failed(call.Name, err.Error())
	}
	return ToolResult{
		Summary: fmt.Sprintf("已调用「%s」的 %s", c.ConnectorName, c.Tool),
		Content: clip(out, maxBodyRunes),
	}
}

// callBrief 是一次调用给人看的一句话，确认卡片和落库的记录用。
func (r *Runner) callBrief(call ToolCall) string {
	if c := r.Policy.conn(call.Name); c != nil {
		return fmt.Sprintf("调用「%s」的 %s", c.ConnectorName, c.Tool)
	}
	args := map[string]any{}
	_ = json.Unmarshal([]byte(defaultArgs(call.Args)), &args)
	switch call.Name {
	case "create_object":
		return fmt.Sprintf("新建「%s」", oneLine(argStr(args, "title")))
	case "update_object":
		return fmt.Sprintf("修改 %s", argStr(args, "ref"))
	case toolProgress:
		return fmt.Sprintf("给 %s 记进展", argStr(args, "ref"))
	case "write_file":
		return fmt.Sprintf("写文件 %s", argStr(args, "path"))
	case toolRunSOP:
		return fmt.Sprintf("发起 SOP %s", argStr(args, "flow_id"))
	case toolCreateSOP:
		return fmt.Sprintf("新建 SOP「%s」", oneLine(argStr(args, "name")))
	case toolUpdateSOP:
		return fmt.Sprintf("修改 SOP %s", argStr(args, "flow_id"))
	}
	return "调用 " + call.Name
}

// Decision 是人对一次要确认的调用的决定，交给 Resume 接着跑。
type Decision struct {
	Call     *store.AgentToolCall
	Approved bool
	// Result 是执行结果或拒绝说明（给人看的一句话），Resume 跑完后由调用方记进 agent_tool_calls
	Result string
}

// requestConfirm 记下一次要确认的调用并发 confirm 事件；回落库用的一句话。
func (r *Runner) requestConfirm(ctx context.Context, call ToolCall, key string, emit func(StreamEvent)) (string, error) {
	if r.Agent == nil {
		return "", fmt.Errorf("没有挂 Agent 的会话不需要确认")
	}
	var id string
	if r.Debug != nil {
		id = r.holdDebugCall(call, key)
	} else {
		sid := r.Session.ID
		tc, err := r.Store.CreateAgentToolCall(ctx, &store.AgentToolCall{
			AgentID: r.Agent.ID, SessionID: &sid, RunID: r.runRef(), CallID: call.ID, Tool: call.Name, GrantKey: key, Args: defaultArgs(call.Args),
		})
		if err != nil {
			return "", fmt.Errorf("保存待确认的调用失败")
		}
		id = tc.ID
	}
	brief := r.callBrief(call)
	if _, err := r.record(ctx, &domain.AgentMessage{
		SessionID: r.Session.ID, Role: domain.RoleTool, Content: "等待确认：" + brief,
		ToolName: call.Name, ToolArgs: call.Args,
	}); err != nil {
		return "", fmt.Errorf("保存工具调用记录失败")
	}
	emit(StreamEvent{Type: "confirm", ID: id, Name: call.Name, Args: defaultArgs(call.Args), Summary: brief})
	return brief, nil
}

// applyDecision 执行（确认）或回绝（拒绝）那次调用，落库、发事件，回给模型的说明。
// 也回执行结果，记进这一轮的执行情况（拒绝的回空结果）。
func (r *Runner) applyDecision(ctx context.Context, tb *Toolbox, d *Decision, emit func(StreamEvent)) (string, ToolResult, error) {
	call := ToolCall{ID: d.Call.CallID, Name: d.Call.Tool, Args: d.Call.Args}
	brief := r.callBrief(call)
	var res ToolResult
	var note string
	if d.Approved {
		emit(StreamEvent{Type: "tool_call", Name: call.Name, Args: call.Args})
		res = r.invoke(ctx, tb, call)
		note = fmt.Sprintf("用户确认了你上一轮提出的调用（%s），已经执行，结果：\n%s\n接着完成用户的请求，不要再重复这次调用。", brief, res.Content)
	} else {
		res = ToolResult{Summary: "用户拒绝了：" + brief + "，没有执行"}
		note = fmt.Sprintf("用户拒绝了你上一轮提出的调用（%s %s），没有执行。不要再提出同样的调用；向用户说明情况，或者换别的办法。", call.Name, clip(call.Args, 300))
	}
	d.Result = res.Summary
	if _, err := r.record(ctx, &domain.AgentMessage{
		SessionID: r.Session.ID, Role: domain.RoleTool, Content: res.Summary, ToolName: call.Name, ToolArgs: call.Args,
	}); err != nil {
		return "", ToolResult{}, fmt.Errorf("保存工具调用记录失败")
	}
	emit(StreamEvent{Type: "tool_result", Name: call.Name, Summary: res.Summary, ObjectID: res.ObjectID})
	if a := res.Artifact; a != nil {
		size := a.Size
		emit(StreamEvent{Type: "artifact", Path: a.RelPath, Size: &size})
	}
	return note, res, nil
}

// renderConfirm 是并进最终回复的一句，历史回放时只剩纯文本也看得懂。
func renderConfirm(brief string) string {
	return "【等你确认】" + strings.TrimSpace(brief) + "，确认后才会执行。\n"
}
