package schedule

import (
	"encoding/json"
	"strings"
)

// 动作。
const (
	ActionTask  = "task"
	ActionSOP   = "sop"
	ActionAgent = "agent"
)

// Action 与原型 ScheduleAction 同形，三种 kind 的字段放在一起，用不到的省略。
// 插件登记的动作（VID-06a，plugin_action.go）的参数在 Params 里，JSON 里和 kind 平铺。
type Action struct {
	Kind string `json:"kind"`

	// kind = task：到点建一条任务
	Title    string `json:"title"`
	Desc     string `json:"desc"`
	Priority string `json:"priority"`
	Assignee string `json:"assignee"`
	// DueDays 是截止日距执行当天几天，0 为当天
	DueDays int `json:"due_days"`

	// kind = sop
	SOPID string `json:"sop_id"`

	// kind = agent
	AgentID string `json:"agent_id"`
	Prompt  string `json:"prompt"`

	// 插件动作：除 kind 外的全部字段，校验交给插件
	Params map[string]any `json:"-"`
}

// Normalize 去掉首尾空白，清掉不属于这个 kind 的字段，存进库里的只有自己用的字段。
func (a Action) Normalize() Action {
	a.Kind = strings.TrimSpace(a.Kind)
	switch a.Kind {
	case ActionTask:
		return Action{Kind: a.Kind, Title: strings.TrimSpace(a.Title), Desc: a.Desc,
			Priority: strings.TrimSpace(a.Priority), Assignee: strings.TrimSpace(a.Assignee), DueDays: a.DueDays}
	case ActionSOP:
		return Action{Kind: a.Kind, SOPID: strings.TrimSpace(a.SOPID)}
	case ActionAgent:
		return Action{Kind: a.Kind, AgentID: strings.TrimSpace(a.AgentID), Prompt: a.Prompt}
	}
	return Action{Kind: a.Kind, Params: a.Params}
}

// Validate 只查必填项；SOP、Agent 的 id 是否存在不查，到点执行时找不到记失败（SOP 是插件，可能还没装）。
func (a Action) Validate() error {
	switch a.Kind {
	case ActionTask:
		if a.Title == "" {
			return invalid("action.title is required for kind task")
		}
		if a.DueDays < 0 || a.DueDays > 365 {
			return invalid("action.due_days must be 0..365, got %d", a.DueDays)
		}
	case ActionSOP:
		if a.SOPID == "" {
			return invalid("action.sop_id is required for kind sop")
		}
	case ActionAgent:
		if a.AgentID == "" {
			return invalid("action.agent_id is required for kind agent")
		}
	default:
		return invalid("action.kind must be task / sop / agent, got %q", a.Kind)
	}
	return nil
}

// MarshalJSON 只输出这个 kind 用到的字段，零值也输出（due_days 为 0 时照样有这个键）。
func (a Action) MarshalJSON() ([]byte, error) {
	m := map[string]any{"kind": a.Kind}
	switch a.Kind {
	case ActionTask:
		m["title"], m["desc"], m["priority"], m["assignee"], m["due_days"] = a.Title, a.Desc, a.Priority, a.Assignee, a.DueDays
	case ActionSOP:
		m["sop_id"] = a.SOPID
	case ActionAgent:
		m["agent_id"], m["prompt"] = a.AgentID, a.Prompt
	default:
		for k, v := range a.Params {
			if k != "kind" {
				m[k] = v
			}
		}
	}
	return json.Marshal(m)
}

// UnmarshalJSON 按 kind 读：内核的三种读进各自字段，其余的除 kind 外全部放进 Params。
func (a *Action) UnmarshalJSON(b []byte) error {
	var head struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(b, &head); err != nil {
		return err
	}
	if builtinKind(strings.TrimSpace(head.Kind)) {
		type plain Action
		var p plain
		if err := json.Unmarshal(b, &p); err != nil {
			return err
		}
		*a = Action(p)
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	delete(m, "kind")
	*a = Action{Kind: head.Kind, Params: m}
	return nil
}
