package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// --- 发起 SOP 工具（SOP-01d）：经内核「发起 SOP」钩子起一条执行，流程里的人工检查点照常停下 ---

const toolRunSOP = "run_sop"

// RunSOPAbility 是 run_sop 归属的内置能力，写操作，可以设成需确认。
const RunSOPAbility = "run_sop"

type sopStarterBox struct{ s schedule.SOPStarter }

var sopStarter atomic.Pointer[sopStarterBox]

// SetSOPStarter 接上发起 SOP 的实现（插件注册表），cmd/pmw 启动时调；传 nil 摘掉。
// 放在包级而不是 Runner 字段上：Runner 在接口层好几处现建，钩子全进程只有一个。
func SetSOPStarter(s schedule.SOPStarter) {
	if s == nil {
		sopStarter.Store(nil)
		return
	}
	sopStarter.Store(&sopStarterBox{s})
}

func currentSOPStarter() schedule.SOPStarter {
	if b := sopStarter.Load(); b != nil {
		return b.s
	}
	return nil
}

// withAgentSOP 记下会话挂的 Agent；没挂 Agent 的老会话不给 run_sop，要在 Agent 上授权才有。
func (tb *Toolbox) withAgentSOP(a *domain.Agent) {
	if a != nil && currentSOPStarter() != nil {
		tb.sopAgent = a
	}
}

func (tb *Toolbox) sopDefs() []ToolDef {
	if tb.sopAgent == nil {
		return nil
	}
	return []ToolDef{{
		Name: toolRunSOP,
		Description: "按标准流程（SOP）发起一次执行，不等它跑完。用户让你「走一遍某某流程」「按 SOP 处理」时用它。" +
			"流程里的人工检查点会停下等人处理，你只负责发起，把执行记录 id 告诉用户。",
		Parameters: obj(props{
			"flow_id": str("流程 id（sop_ 开头），也接受流程名称"),
			"input":   map[string]any{"type": "object", "description": "流程的输入字段，key 是字段 key；没给的取流程的默认值"},
		}, []string{"flow_id"}),
	}}
}

func (tb *Toolbox) runSOP(ctx context.Context, args map[string]any) ToolResult {
	st := currentSOPStarter()
	if tb.sopAgent == nil || st == nil {
		return failed(toolRunSOP, "这个会话不能发起 SOP")
	}
	flow := strings.TrimSpace(argStr(args, "flow_id"))
	if flow == "" {
		return failed(toolRunSOP, "flow_id 是必填的")
	}
	input, err := sopInput(args["input"])
	if err != nil {
		return failed(toolRunSOP, err.Error())
	}
	// 会话挂在工作对象上（任务分配给 Agent 触发的、在任务详情里对话的）时，这次执行关联到那个对象（SOP-06），任务详情里能看到
	req := schedule.SOPRequest{FlowID: flow, Input: input, Source: "agent", SourceID: tb.sopAgent.ID, SourceName: tb.sopAgent.Name}
	if tb.session != nil && tb.session.ObjectID != nil {
		req.ObjectID = *tb.session.ObjectID
	}
	got, err := st.StartSOP(ctx, req)
	if errors.Is(err, schedule.ErrSOPUnavailable) {
		return failed(toolRunSOP, "SOP 编排插件没启用，发起不了，告诉用户先在设置里启用它")
	}
	if err != nil {
		return failed(toolRunSOP, err.Error())
	}
	state := "已开始执行"
	if got.Status == "waiting" {
		state = "停在人工检查点，等人处理"
	}
	return ToolResult{
		Summary: fmt.Sprintf("发起了 SOP「%s」，执行记录 %s", got.FlowName, got.RunID),
		Content: fmt.Sprintf("已发起 SOP「%s」（流程 %s），执行记录 %s，当前状态 %s：%s。"+
			"流程里的人工检查点会停下等人在 SOP 运行页处理，你不用等它跑完。", got.FlowName, got.FlowID, got.RunID, got.Status, state),
	}
}

// sopInput 认对象，也认对象的 JSON 字符串（小模型常把嵌套对象写成字符串）。
func sopInput(v any) (map[string]any, error) {
	switch x := v.(type) {
	case nil:
		return map[string]any{}, nil
	case map[string]any:
		return x, nil
	case string:
		if strings.TrimSpace(x) == "" {
			return map[string]any{}, nil
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(x), &m); err == nil && m != nil {
			return m, nil
		}
	}
	return nil, errors.New("input 必须是对象，key 是流程的输入字段")
}
