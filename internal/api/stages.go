package api

import (
	"encoding/json"
	"maps"
	"net/http"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 任务的阶段与提出人（AUTO-05，domain/stage.go）。
//
// 阶段存 props.stage。改阶段走专门的 PUT /api/objects/{id}/stage，而不是让调用方 PATCH 整个 props：
// PATCH props 是整体替换，调用方手上的 props 旧了就会把别人刚写的验收标准、来源冲掉；
// 这里在服务端读当前 props、只换 stage 一个键再写回。事件 object.stage_changed 和审计在 store 包装层发（events、audit），
// 所以 PATCH props 改了 stage 也照样有事件和审计。

// handleTaskStageDefs 列出阶段全集（看板列序、显示名）。
func (s *Server) handleTaskStageDefs(w http.ResponseWriter, _ *http.Request) {
	respondList(w, domain.TaskStages, Meta{Total: len(domain.TaskStages), Limit: len(domain.TaskStages)})
}

type setStageReq struct {
	// Stage 为空串表示清掉阶段（回到「未设阶段」）
	Stage *string `json:"stage"`
}

func (s *Server) handleSetObjectStage(w http.ResponseWriter, r *http.Request) {
	var req setStageReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if req.Stage == nil {
		s.fail(w, r, validationf("field %q is required", "stage"))
		return
	}
	stage := strings.TrimSpace(*req.Stage)
	if stage != "" && !domain.ValidTaskStage(stage) {
		s.fail(w, r, validationf("invalid stage %q", stage))
		return
	}
	o, err := s.st.GetObject(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if o.TypeID != "task" {
		s.fail(w, r, validationf("only tasks have a stage, %s is a %s", o.ID, o.TypeID))
		return
	}
	if domain.StageOf(o.Props) == stage {
		respondData(w, http.StatusOK, o)
		return
	}
	props := maps.Clone(o.Props)
	if props == nil {
		props = map[string]any{}
	}
	if stage == "" {
		delete(props, domain.PropStage)
	} else {
		props[domain.PropStage] = stage
	}
	out, err := s.st.UpdateObject(r.Context(), o.ID, domain.ObjectPatch{Props: &props}, actorFrom(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

// stageQueryMax 是 GET /api/tasks/stages 一次最多回多少条：同一个人提的任务一般几十条，够用。
const stageQueryMax = 200

// handleTaskStages 按来源消息或提出人查任务阶段，给 IM 插件「问进度」用（本期只做接口）。
// 条件至少给一个：message_id；requester_id（联系人）；channel + sender_id（IM 发送者）。多个条件是「且」。
// 不含已删除、已归档的任务；最近更新的在前。
func (s *Server) handleTaskStages(w http.ResponseWriter, r *http.Request) {
	p := newParams(r)
	f := domain.ObjectFilter{
		TypeIDs:           []string{"task"},
		SourceMessageID:   p.str("message_id"),
		RequesterID:       p.str("requester_id"),
		RequesterChannel:  p.str("channel"),
		RequesterSenderID: p.str("sender_id"),
		Sort:              "-updated_at",
		Limit:             stageQueryMax,
	}
	if (f.RequesterChannel == "") != (f.RequesterSenderID == "") {
		s.fail(w, r, validationf("channel and sender_id must be given together"))
		return
	}
	if f.SourceMessageID == "" && f.RequesterID == "" && f.RequesterSenderID == "" {
		s.fail(w, r, validationf("one of message_id, requester_id, channel+sender_id is required"))
		return
	}
	items, total, err := s.st.ListObjects(r.Context(), f)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	rows := make([]domain.TaskStageRow, 0, len(items))
	for _, o := range items {
		rows = append(rows, stageRow(o))
	}
	respondList(w, rows, Meta{Total: total, Limit: stageQueryMax})
}

func stageRow(o *domain.Object) domain.TaskStageRow {
	st := domain.StageOf(o.Props)
	row := domain.TaskStageRow{
		ID: o.ID, Ref: o.Ref, Title: o.Title, Status: o.Status,
		Stage: st, StageLabel: domain.TaskStageLabel(st), Requester: domain.RequesterOf(o.Props),
		UpdatedAt: o.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if ref, ok := o.Props[domain.PropSourceRef].(map[string]any); ok {
		row.MessageID, _ = ref["message_id"].(string)
	}
	return row
}

// validStageProps 校验建对象、PATCH 时带的 props.stage 和 props.requester：
// stage 要么不给、要么是合法阶段；requester 要么不给、要么是对象且至少有名字或联系人。
// 只在 API 入口用，插件写入走 ObjectWriter 不经过这里。
func validStageProps(props map[string]any) error {
	if raw, ok := props[domain.PropStage]; ok && raw != nil {
		st, isStr := raw.(string)
		if !isStr || (strings.TrimSpace(st) != "" && !domain.ValidTaskStage(strings.TrimSpace(st))) {
			return validationf("invalid props.stage %v", raw)
		}
	}
	raw, ok := props[domain.PropRequester]
	if !ok || raw == nil {
		return nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return validationf("invalid props.requester")
	}
	var rq domain.Requester
	if err := json.Unmarshal(b, &rq); err != nil {
		return validationf("props.requester must be an object")
	}
	if strings.TrimSpace(rq.Name) == "" && strings.TrimSpace(rq.ContactID) == "" {
		return validationf("props.requester needs name or contact_id")
	}
	return nil
}
