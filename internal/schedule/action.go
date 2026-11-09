package schedule

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

// 动作。
const (
	ActionTask  = "task"
	ActionSOP   = "sop"
	ActionAgent = "agent"
	// ActionIncidentSweep 是运行异常巡检（INC-01a），内核动作，见 incident_sweep.go
	ActionIncidentSweep = "incident_sweep"
	// ActionRemind 是到点在工作台里发一条提醒通知，可以关联一个对象（任务），内核动作，见 remind.go
	ActionRemind = "remind"
	// ActionGitPull 是到点在本机一个 git 仓库里 git pull --ff-only，内核动作，见 git_pull.go
	ActionGitPull = "git_pull"
)

// 运行异常巡检的默认值。
const (
	DefaultSweepLevel = "error"
	DefaultSweepCount = 1
	maxSweepCount     = 1000000
)

// Action 与原型 ScheduleAction 同形，三种 kind 的字段放在一起，用不到的省略。
// 插件登记的动作（VID-06a，plugin_action.go）的参数在 Params 里，JSON 里和 kind 平铺。
type Action struct {
	Kind string `json:"kind"`

	// kind = task：到点建一条任务；kind = remind 时 Title 是提醒的标题
	Title    string `json:"title"`
	Desc     string `json:"desc"`
	Priority string `json:"priority"`
	Assignee string `json:"assignee"`
	// DueDays 是截止日距执行当天几天，0 为当天
	DueDays int `json:"due_days"`

	// kind = sop
	SOPID string `json:"sop_id"`
	// Managed 是「随流程管理」（TSK-0463，flowsched.go）：流程触发方式选「定时」时 SOP 插件建的那一条，一个流程最多一条。
	// 只有 SOP 插件经 SaveFlowSchedule 能置真；/api/schedules 新建时忽略、修改时保持原值
	Managed bool `json:"managed"`

	// kind = agent
	AgentID string `json:"agent_id"`
	Prompt  string `json:"prompt"`

	// kind = incident_sweep：MinLevel 是 error（只看错误）或 warn（警告和错误都看），MinCount 是次数下限
	MinLevel string `json:"min_level"`
	MinCount int    `json:"min_count"`

	// kind = remind：Body 是提醒的内容，ObjectID 是关联的对象（任务），点通知打开它；都可以空
	Body     string `json:"body"`
	ObjectID string `json:"object_id"`
	// Popup 是提醒怎么弹（SPEC-tasks-8.26）：toast 右下角非模态（默认），modal 屏幕中间模态弹窗、点了才关
	Popup string `json:"popup"`

	// kind = git_pull：Repo 是仓库的绝对路径；Remote、Branch 可空，空时按仓库自己的上游拉，Branch 非空时 Remote 必填
	Repo   string `json:"repo"`
	Remote string `json:"remote"`
	Branch string `json:"branch"`

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
		return Action{Kind: a.Kind, SOPID: strings.TrimSpace(a.SOPID), Managed: a.Managed}
	case ActionAgent:
		return Action{Kind: a.Kind, AgentID: strings.TrimSpace(a.AgentID), Prompt: a.Prompt}
	case ActionIncidentSweep:
		lv, n := strings.TrimSpace(a.MinLevel), a.MinCount
		if lv == "" {
			lv = DefaultSweepLevel
		}
		if n == 0 {
			n = DefaultSweepCount
		}
		return Action{Kind: a.Kind, MinLevel: lv, MinCount: n}
	case ActionRemind:
		popup := strings.TrimSpace(a.Popup)
		if popup == "" {
			popup = PopupToast
		}
		return Action{Kind: a.Kind, Title: strings.TrimSpace(a.Title), Body: strings.TrimSpace(a.Body), ObjectID: strings.TrimSpace(a.ObjectID), Popup: popup}
	case ActionGitPull:
		repo := strings.TrimSpace(a.Repo)
		if repo != "" {
			repo = filepath.Clean(repo)
		}
		return Action{Kind: a.Kind, Repo: repo, Remote: strings.TrimSpace(a.Remote), Branch: strings.TrimSpace(a.Branch)}
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
	case ActionIncidentSweep:
		if a.MinLevel != "error" && a.MinLevel != "warn" {
			return invalid("action.min_level must be error or warn, got %q", a.MinLevel)
		}
		if a.MinCount < 1 || a.MinCount > maxSweepCount {
			return invalid("action.min_count must be 1..%d, got %d", maxSweepCount, a.MinCount)
		}
	case ActionRemind:
		return a.validateRemind()
	case ActionGitPull:
		return a.validateGitPull()
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
		m["sop_id"], m["managed"] = a.SOPID, a.Managed
	case ActionAgent:
		m["agent_id"], m["prompt"] = a.AgentID, a.Prompt
	case ActionIncidentSweep:
		m["min_level"], m["min_count"] = a.MinLevel, a.MinCount
	case ActionRemind:
		m["title"], m["body"], m["object_id"], m["popup"] = a.Title, a.Body, a.ObjectID, a.Popup
	case ActionGitPull:
		m["repo"], m["remote"], m["branch"] = a.Repo, a.Remote, a.Branch
	default:
		for k, v := range a.Params {
			if k != "kind" {
				m[k] = v
			}
		}
	}
	return json.Marshal(m)
}

// UnmarshalJSON 按 kind 读：内核的几种读进各自字段，其余的除 kind 外全部放进 Params。
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
