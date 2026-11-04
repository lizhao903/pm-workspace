package domain

import "strings"

// 任务的「阶段」和「提出人」（AUTO-05，docs/auto-delivery-flow.md 第 3 节「看板状态」）。
//
// 两者都放在 objects.props 里，不加列：
//   - props 本来就是类型相关自定义字段的落点（acceptance、repo、source_ref 都在这里），阶段只对任务有意义；
//   - 不加迁移，现有任务一行不动；没设阶段的任务 props 里就没有这个键，界面上算「未设阶段」。
//
// 阶段和状态是两套：状态（todo/doing/review/...）是负责人的工作状态，阶段是提出人在看板上看到的流程进度，
// 由自动交付流程推进。阶段不改状态集，也不联动状态。
const (
	// PropStage 是阶段 key，取值见 TaskStages。
	PropStage = "stage"
	// PropRequester 是提出人，对象（map），形状见 Requester。
	PropRequester = "requester"
)

// TaskStage 是一个阶段：key 落库，Label 给界面和 IM 回复用。
type TaskStage struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// TaskStages 是阶段的全集，顺序就是看板从左到右的列序。
var TaskStages = []TaskStage{
	{"received", "已接收"},
	{"confirm_project", "待确认项目"},
	{"designing", "设计中"},
	{"clarifying", "待澄清"},
	{"reviewing", "评审中"},
	{"need_human", "需人工"},
	{"developing", "开发中"},
	{"testing", "测试中"},
	{"accepting", "待验收"},
	{"releasing", "待发布"},
	{"released", "已上线"},
}

// ValidTaskStage 判断 key 是不是合法阶段。
func ValidTaskStage(key string) bool {
	for _, s := range TaskStages {
		if s.Key == key {
			return true
		}
	}
	return false
}

// TaskStageLabel 返回阶段的显示名；不认识的原样返回，空串返回空串。
func TaskStageLabel(key string) string {
	for _, s := range TaskStages {
		if s.Key == key {
			return s.Label
		}
	}
	return key
}

// StageOf 取对象 props.stage；没有或不是字符串返回空串。
func StageOf(props map[string]any) string {
	s, _ := props[PropStage].(string)
	return strings.TrimSpace(s)
}

// Requester 是提出人（props.requester）。
//
// 认得出是哪位联系人时 ContactID 非空、Name 是联系人名；认不出（IM 发送者没绑联系人）时 ContactID 为空，
// 存发送者快照：Channel、SenderID、SenderName，Name 取 SenderName。Name 总有值，界面直接显示它。
// IM 转来的任务 Channel、SenderID 两种情况都带，联系人后来绑上了也能按发送者查到。
type Requester struct {
	ContactID  string `json:"contact_id,omitempty"`
	Name       string `json:"name"`
	Channel    string `json:"channel,omitempty"`
	SenderID   string `json:"sender_id,omitempty"`
	SenderName string `json:"sender_name,omitempty"`
}

// Map 转成写进 props 的 map，空字段不带。
func (r Requester) Map() map[string]any {
	m := map[string]any{"name": r.Name}
	for k, v := range map[string]string{"contact_id": r.ContactID, "channel": r.Channel, "sender_id": r.SenderID, "sender_name": r.SenderName} {
		if v != "" {
			m[k] = v
		}
	}
	return m
}

// RequesterOf 从 props.requester 读回提出人；没有返回 nil。
func RequesterOf(props map[string]any) *Requester {
	m, ok := props[PropRequester].(map[string]any)
	if !ok {
		return nil
	}
	str := func(k string) string { s, _ := m[k].(string); return strings.TrimSpace(s) }
	r := &Requester{ContactID: str("contact_id"), Name: str("name"), Channel: str("channel"), SenderID: str("sender_id"), SenderName: str("sender_name")}
	if r.Name == "" {
		r.Name = r.SenderName
	}
	if r.Name == "" && r.ContactID == "" && r.SenderID == "" {
		return nil
	}
	return r
}

// TaskStageRow 是「按来源消息或提出人查阶段」的一行（GET /api/tasks/stages、插件 ObjectReader.TaskStages）。
type TaskStageRow struct {
	ID         string     `json:"id"`
	Ref        string     `json:"ref"`
	Title      string     `json:"title"`
	Status     string     `json:"status"`
	Stage      string     `json:"stage"`
	StageLabel string     `json:"stage_label"`
	Requester  *Requester `json:"requester"`
	// MessageID 是来源消息（props.source_ref.message_id），不是 IM 转来的为空串。
	MessageID string `json:"message_id"`
	UpdatedAt string `json:"updated_at"`
}
