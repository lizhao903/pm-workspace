// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// --- Agent 调试对话（AG-02c）：用没保存的配置跑，不写会话和消息；要确认的调用只存在进程内存里 ---

// DebugCallPrefix 是调试里待确认调用的 id 前缀，确认、拒绝接口据此分流。
const DebugCallPrefix = "dbg"

// DebugCallTTL 是调试里待确认调用的有效期，过期或进程重启后回 404。
const DebugCallTTL = 10 * time.Minute

// IsDebugCall 判断一个待确认调用 id 是不是调试里的。
func IsDebugCall(id string) bool { return strings.HasPrefix(id, DebugCallPrefix+"_") }

// Debug 让 Runner 不落库：历史从 History 来，过程记在内存里，要确认的调用记进 Calls。
type Debug struct {
	// History 是这次之前的调试对话，只有 user / assistant
	History []Message
	Calls   *DebugCalls
	// log 是这次跑出来的记录，口径同落库后 buildHistory 读回来的
	log []Message
	// held 是这次记下的待确认调用 id，跑完后补上完整历史
	held []string
}

// DebugCall 是调试里一次待确认的调用，连同确认后接着跑要用的配置快照。
type DebugCall struct {
	ID       string
	CallID   string
	Tool     string
	Args     string
	GrantKey string
	// Agent 是调试时的配置（没保存的），Grants 是它的工具授权，Workdir 是产物目录
	Agent   domain.Agent
	Grants  map[string]string
	Workdir string
	// History 是确认卡片出现时的完整调试对话（含这一轮的回复）
	History   []Message
	ExpiresAt time.Time
}

// DebugCalls 是进程内存里的待确认调用，过期的取不到。
type DebugCalls struct {
	mu  sync.Mutex
	m   map[string]*DebugCall
	now func() time.Time
}

func NewDebugCalls() *DebugCalls {
	return &DebugCalls{m: map[string]*DebugCall{}, now: time.Now}
}

func (d *DebugCalls) put(c *DebugCall) {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := d.now()
	for id, x := range d.m {
		if now.After(x.ExpiresAt) {
			delete(d.m, id)
		}
	}
	c.ExpiresAt = now.Add(DebugCallTTL)
	d.m[c.ID] = c
}

func (d *DebugCalls) setHistory(id string, h []Message) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if c, ok := d.m[id]; ok {
		c.History = h
	}
}

// Get 取一次没过期的调用（副本），不取走。
func (d *DebugCalls) Get(id string) (*DebugCall, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	c, ok := d.m[id]
	if !ok || d.now().After(c.ExpiresAt) {
		return nil, false
	}
	cp := *c
	cp.History = append([]Message(nil), c.History...)
	return &cp, true
}

// Take 取走一次调用；已经被取走（两个页面同时点）回 false。
func (d *DebugCalls) Take(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.m[id]; !ok {
		return false
	}
	delete(d.m, id)
	return true
}

// holdDebugCall 记下一次要确认的调用，回它的 id。
func (r *Runner) holdDebugCall(call ToolCall, key string) string {
	c := &DebugCall{
		ID: idgen.Prefixed("dbg"), CallID: call.ID, Tool: call.Name, Args: defaultArgs(call.Args), GrantKey: key,
		Workdir: r.Session.Workdir, History: r.debugTranscript(),
	}
	if r.Agent != nil {
		c.Agent = *r.Agent
	}
	if r.Policy != nil {
		c.Grants = map[string]string{}
		for k, v := range r.Policy.Grants {
			c.Grants[k] = v
		}
	}
	r.Debug.Calls.put(c)
	r.Debug.held = append(r.Debug.held, c.ID)
	return c.ID
}

// debugTranscript 是到目前为止的调试对话：传进来的历史加上这次的记录。
func (r *Runner) debugTranscript() []Message {
	out := make([]Message, 0, len(r.Debug.History)+len(r.Debug.log))
	out = append(out, r.Debug.History...)
	return append(out, r.Debug.log...)
}

// historyMessage 把一条落库的消息转成喂回模型的历史，口径见 buildHistory。
func historyMessage(m *domain.AgentMessage) (Message, bool) {
	switch m.Role {
	case domain.RoleUser:
		return Message{Role: domain.RoleUser, Content: m.Content}, true
	case domain.RoleAssistant:
		if strings.TrimSpace(m.Content) != "" {
			return Message{Role: domain.RoleAssistant, Content: m.Content}, true
		}
	case domain.RoleTool:
		// 转述成 user 视角的一句事实：历史里的 tool 消息已经没有配对的 tool_call 了，
		// 直接按 tool 角色塞回去，OpenAI 会因为「找不到对应的 tool_call_id」而拒绝整个请求。
		return Message{Role: domain.RoleUser, Content: "（系统记录：之前 " + m.Content + "）"}, true
	}
	return Message{}, false
}
