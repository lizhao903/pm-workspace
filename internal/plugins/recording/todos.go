// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 候选确认 / 忽略（M4a，设计 §13.4）。候选表 recording_todos 一条一行：
// 项目候选确认后把录音挂到项目（不建对象）；任务/目标候选确认后用 ObjectWriter().CreateAs 建任务，
// 幂等键 recording/<录音 id>/todo/<index>，props 记录音、goal、confidence；负责人名字先按联系人匹配。

// confirmTodoRequest 是 confirm 接口的 body（都可空，空时用候选里的建议值）。
type confirmTodoRequest struct {
	Title     string `json:"title"`
	ProjectID string `json:"project_id"`
	OwnerID   string `json:"owner_id"`
	Priority  string `json:"priority"`
	DueAt     string `json:"due_at"`
}

// confirmTodo 确认一条候选，返回确认后的候选。
func (h *handlers) confirmTodo(ctx context.Context, rec recordingRow, index int, req confirmTodoRequest) (RecordingTodo, error) {
	t, err := loadTodo(ctx, h.c.Store(), rec.ID, index)
	if err != nil {
		if errors.Is(err, plugin.ErrNoRows) {
			return RecordingTodo{}, apiErr(errNotFound, "第 %d 条候选不存在", index)
		}
		return RecordingTodo{}, err
	}
	if t.Status == "confirmed" {
		return RecordingTodo{}, apiErr(errConflict, "这条候选已经确认过了")
	}
	if t.Status != "pending" {
		return RecordingTodo{}, apiErr(errConflict, "这条候选已经忽略了，不能再确认")
	}
	now := nowRFC()
	switch t.Kind {
	case "project":
		projectID := strings.TrimSpace(req.ProjectID)
		if projectID == "" {
			projectID = t.ProjectID
		}
		if projectID == "" {
			return RecordingTodo{}, apiErr(errValidation, "这条项目候选没匹配到已有项目，请在请求里给出 project_id")
		}
		obj, err := h.c.Objects().Get(ctx, projectID)
		if err != nil || obj.Type != "project" {
			return RecordingTodo{}, apiErr(errValidation, "project_id %s 不是已有项目", projectID)
		}
		if _, err := h.c.Store().Exec(ctx, `UPDATE recording_recordings SET project_id = ?, updated_at = ? WHERE id = ?`,
			projectID, now, rec.ID); err != nil {
			return RecordingTodo{}, err
		}
		t.Status, t.ProjectID, t.ProjectTitle, t.UpdatedAt = "confirmed", projectID, obj.Title, now
	case "task", "goal":
		updated, err := h.createTaskFromTodo(ctx, rec, t, req, now)
		if err != nil {
			return RecordingTodo{}, err
		}
		t = updated
	default:
		return RecordingTodo{}, apiErr(errValidation, "候选类型不认识：%s", t.Kind)
	}
	if err := updateTodo(ctx, h.c.Store(), t); err != nil {
		return RecordingTodo{}, err
	}
	h.c.Audit().Note(ctx, plugin.AuditNote{
		Action: "confirm", TargetType: "recording_todo", TargetID: fmt.Sprintf("%s/%d", rec.ID, t.Index),
		Summary: "确认录音候选「" + clip(t.Title, 60) + "」",
	}, plugin.WriteMeta{})
	return todoToView(t), nil
}

// createTaskFromTodo 把任务/目标候选建出来（幂等），回填候选的 object_id / object_ref。
func (h *handlers) createTaskFromTodo(ctx context.Context, rec recordingRow, t todoRow, req confirmTodoRequest, now string) (todoRow, error) {
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = t.Title
	}
	if title == "" {
		return todoRow{}, apiErr(errValidation, "任务标题不能为空")
	}
	// 项目：请求给的 > 候选匹配到的 > 录音自己的
	projectID := strings.TrimSpace(req.ProjectID)
	if projectID == "" {
		projectID = t.ProjectID
	}
	if projectID == "" {
		projectID = rec.ProjectID
	}
	var projectPtr *string
	if projectID != "" {
		obj, err := h.c.Objects().Get(ctx, projectID)
		if err != nil || obj.Type != "project" {
			return todoRow{}, apiErr(errValidation, "project_id %s 不是已有项目", projectID)
		}
		projectPtr = &projectID
		t.ProjectID, t.ProjectTitle = projectID, obj.Title
	}
	// 负责人：请求里给的联系人 id > 候选里建议的负责人名字（按名字匹配）
	ownerID := strings.TrimSpace(req.OwnerID)
	if ownerID != "" {
		if _, err := h.c.Contacts().Get(ctx, ownerID); err != nil {
			return todoRow{}, apiErr(errValidation, "owner_id %s 不是已有联系人", ownerID)
		}
	} else if name := strings.TrimSpace(t.OwnerName); name != "" {
		if contact, err := h.c.Contacts().FindByName(ctx, name); err == nil {
			ownerID = contact.ID
		}
	}
	var ownerPtr *string
	if ownerID != "" {
		ownerPtr = &ownerID
	}
	// 截止时间：请求给的（格式不对 400）> 候选建议的（解析不了就忽略）
	dueRaw := strings.TrimSpace(req.DueAt)
	fromRequest := dueRaw != ""
	if !fromRequest {
		dueRaw = strings.TrimSpace(t.DueAt)
	}
	due, err := parseDueAt(dueRaw)
	if err != nil {
		if fromRequest {
			return todoRow{}, apiErr(errValidation, "due_at 格式不对：%s（用 YYYY-MM-DD 或 RFC3339）", req.DueAt)
		}
		due = nil
	}
	props := map[string]any{
		"recording_id":    rec.ID,
		"recording_title": rec.Title,
		"goal":            t.Kind == "goal",
		"confidence":      t.Confidence,
	}
	created, err := h.c.ObjectWriter().CreateAs(ctx, plugin.NewObject{
		TypeID:    "task",
		Title:     title,
		Body:      t.Detail,
		Priority:  strings.TrimSpace(req.Priority),
		ProjectID: projectPtr,
		OwnerID:   ownerPtr,
		DueAt:     due,
		Props:     props,
	}, plugin.WriteMeta{
		Session: rec.ID,
		Key:     fmt.Sprintf("recording/%s/todo/%d", rec.ID, t.Index),
		Detail:  map[string]any{"recording_id": rec.ID, "todo_index": t.Index, "kind": t.Kind},
	})
	if err != nil {
		return todoRow{}, mapObjectWriteErr(err)
	}
	t.Title = title
	t.Status, t.ObjectID, t.ObjectRef, t.UpdatedAt = "confirmed", created.ID, created.Ref, now
	if due != nil {
		t.DueAt = due.Format(time.RFC3339)
	}
	return t, nil
}

// ignoreTodo 忽略一条候选；已经忽略的再点一次按幂等直接回当前状态。
func (h *handlers) ignoreTodo(ctx context.Context, rec recordingRow, index int) (RecordingTodo, error) {
	t, err := loadTodo(ctx, h.c.Store(), rec.ID, index)
	if err != nil {
		if errors.Is(err, plugin.ErrNoRows) {
			return RecordingTodo{}, apiErr(errNotFound, "第 %d 条候选不存在", index)
		}
		return RecordingTodo{}, err
	}
	if t.Status == "confirmed" {
		return RecordingTodo{}, apiErr(errConflict, "这条候选已经确认过了，不能再忽略")
	}
	if t.Status != "pending" {
		return todoToView(t), nil
	}
	t.Status, t.UpdatedAt = "ignored", nowRFC()
	if err := updateTodo(ctx, h.c.Store(), t); err != nil {
		return RecordingTodo{}, err
	}
	h.c.Audit().Note(ctx, plugin.AuditNote{
		Action: "ignore", TargetType: "recording_todo", TargetID: fmt.Sprintf("%s/%d", rec.ID, t.Index),
		Summary: "忽略录音候选「" + clip(t.Title, 60) + "」",
	}, plugin.WriteMeta{})
	return todoToView(t), nil
}

// parseDueAt 解析截止时间：RFC3339、带时间的本地时间或纯日期；空串回 nil。
func parseDueAt(raw string) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04", "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, raw, time.Local); err == nil {
			v := t
			return &v, nil
		}
	}
	return nil, fmt.Errorf("不认识的日期格式：%s", raw)
}

// mapObjectWriteErr 把内核对象写入的错误映射成接口的错误类别。
func mapObjectWriteErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, domain.ErrValidation):
		return apiErr(errValidation, "%s", strings.TrimPrefix(err.Error(), domain.ErrValidation.Error()+": "))
	case errors.Is(err, domain.ErrNotFound):
		return apiErr(errNotFound, "%s", strings.TrimPrefix(err.Error(), domain.ErrNotFound.Error()+": "))
	default:
		return err
	}
}
