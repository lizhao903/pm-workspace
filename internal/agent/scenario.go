package agent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 场景默认 Agent（0045 agent_settings 的 scenario:<场景>） ---
//
// 调模型的地方按调用点归成这几类：
//   - Agent 会话（会话模块、调试、触发器、插件 RunAgent、SOP 的 agent 节点）：本来就挂着 Agent，按它的配置走，不需要场景设置；
//   - SOP 流程里调模型的节点（ai、extract、classifier、iterate）：节点上自己选 Agent，不选时算「其他后台调用」；
//   - SOP 编排助手（sop/assist.go）：用户在编辑器里和它对话、改流程，单独一个场景；
//   - 其他后台调用：插件经 Core.Agent().Complete 调模型、又没指定 Agent 和服务商的（没选 Agent 的 SOP 节点也在这）。
// 场景选了 Agent 就用它的服务商、模型、思考档位和指令；没选、Agent 删了或停用了，退回默认服务商、思考 default。

const (
	ScenarioSOPAssist  = "sop_assist"
	ScenarioBackground = "background"
	// ScenarioTaskRun 是任务交给工作台 Agent 执行（TSK-0460）时默认用哪个 Agent；交的时候还能换
	ScenarioTaskRun = "task_run"
)

// Scenario 是一个场景和它选的 Agent，AgentID 空串表示没选。
type Scenario struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	Desc    string `json:"desc"`
	AgentID string `json:"agent_id"`
}

// Scenarios 是全部场景，按界面上的顺序。
var Scenarios = []Scenario{
	{Key: ScenarioSOPAssist, Label: "SOP 编排助手", Desc: "流程编辑器里帮你搭流程、改节点的助手"},
	{Key: ScenarioBackground, Label: "其他后台调用", Desc: "插件在后台调模型、又没指定 Agent 的地方，包括没选 Agent 的 SOP 节点（AI 处理、提取、分类、逐项处理）"},
	{Key: ScenarioTaskRun, Label: "执行任务", Desc: "任务交给工作台 Agent 执行时默认用的 Agent，交的时候还能换；没选时用第一个启用的 Agent"},
}

func scenarioKey(k string) string { return "scenario:" + k }

// IsScenario 判断 k 是不是认识的场景。
func IsScenario(k string) bool {
	for _, s := range Scenarios {
		if s.Key == k {
			return true
		}
	}
	return false
}

// ListScenarios 回全部场景和各自选的 Agent id。
func ListScenarios(ctx context.Context, st store.Store) ([]Scenario, error) {
	out := make([]Scenario, len(Scenarios))
	copy(out, Scenarios)
	for i := range out {
		id, err := ScenarioAgent(ctx, st, out[i].Key)
		if err != nil {
			return nil, err
		}
		out[i].AgentID = id
	}
	return out, nil
}

// ScenarioAgent 回场景选的 Agent id，没选回空串。
func ScenarioAgent(ctx context.Context, st store.Store, key string) (string, error) {
	raw, err := st.AgentSetting(ctx, scenarioKey(key))
	if err != nil || raw == nil {
		return "", err
	}
	var id string
	_ = json.Unmarshal(raw, &id) // 坏数据按没选
	return strings.TrimSpace(id), nil
}

// SetScenarioAgent 给场景选 Agent，空串是清掉。场景和 Agent 是否存在由调用方先查。
func SetScenarioAgent(ctx context.Context, st store.Store, key, agentID string) error {
	b, _ := json.Marshal(strings.TrimSpace(agentID))
	return st.SetAgentSetting(ctx, scenarioKey(key), b)
}

// completeAgent 按 CompleteRequest 的 Agent / Scenario 换成具体的服务商、模型和系统提示，回思考档位。
// 明确指定的 Agent 找不到或停用了要报错（是配置错了）；场景默认的找不到只记日志、照老样子跑。
func (s *Service) completeAgent(ctx context.Context, req CompleteRequest) (CompleteRequest, string, error) {
	var a *domain.Agent
	if ref := strings.TrimSpace(req.Agent); ref != "" {
		var err error
		if a, err = s.findAgent(ctx, ref); err != nil {
			return req, "", err
		}
	} else if strings.TrimSpace(req.Provider) == "" && strings.TrimSpace(req.Model) == "" {
		scene := strings.TrimSpace(req.Scenario)
		if scene == "" {
			scene = ScenarioBackground
		}
		id, err := ScenarioAgent(ctx, s.Store, scene)
		if err != nil {
			return req, "", err
		}
		if id != "" {
			if a, err = s.findAgent(ctx, id); err != nil {
				thinkingLog().Warn("场景默认 Agent 用不了，退回默认服务商", "scenario", scene, "agent", id, "err", err.Error())
				a = nil
			}
		}
	}
	if a == nil {
		return req, "", nil
	}
	req.Provider, req.Model = a.ProviderID, a.Model
	if ins := strings.TrimSpace(a.Instructions); ins != "" {
		if strings.TrimSpace(req.System) != "" {
			req.System = ins + "\n\n" + req.System
		} else {
			req.System = ins
		}
	}
	return req, a.Thinking, nil
}
