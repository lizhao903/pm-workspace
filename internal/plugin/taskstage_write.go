package plugin

import (
	"context"
	"fmt"
	"maps"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 插件改任务阶段、所属项目（AUTO-06）：IM 需求自动受理流程里「设置任务阶段」节点用。
// 口径同 PUT /api/objects/{id}/stage：服务端读当前 props、只换 stage 一个键再写回，不会冲掉别人刚写的 props；
// 阶段事件 object.stage_changed 和阶段审计由 store 包装层发，和界面上改的一样。所属项目一起改时同一次写入。
// 只改任务；阶段要是合法 key（domain.TaskStages），项目要是没删的项目。两样都没变时不写，回 Changed 为空。

// TaskChange 是要改的阶段和所属项目，空串不改（本期不提供清掉阶段、解除项目）。
type TaskChange struct {
	Stage     string
	ProjectID string
}

// ChangedTask 是改完的任务。Changed 是这次真的改了的字段（stage、project_id），没变时为空。
type ChangedTask struct {
	ID        string
	Ref       string
	Title     string
	Status    string
	Stage     string
	ProjectID string
	Changed   []string
}

// UpdateTask 改任务的阶段、所属项目，带操作者，改了时记审计。对象不存在、已删除回 domain.ErrNotFound；
// 不是任务、阶段不认、项目不存在回 domain.ErrValidation。改法天然幂等（同样的值再写一次不动），不另查幂等键。
func (w objectWriter) UpdateTask(ctx context.Context, id string, ch TaskChange, m WriteMeta) (ChangedTask, error) {
	oc := w.c.reg.objectCreator()
	if oc == nil {
		return ChangedTask{}, ErrNoObjectWriter
	}
	up, ok := oc.(objectUpdater)
	if !ok {
		return ChangedTask{}, ErrWriteUnsupported
	}
	stage, pid := strings.TrimSpace(ch.Stage), strings.TrimSpace(ch.ProjectID)
	if stage == "" && pid == "" {
		return ChangedTask{}, fmt.Errorf("%w: nothing to change", domain.ErrValidation)
	}
	if stage != "" && !domain.ValidTaskStage(stage) {
		return ChangedTask{}, fmt.Errorf("%w: invalid stage %q", domain.ErrValidation, stage)
	}
	cur, err := up.GetObject(ctx, id)
	if err != nil {
		return ChangedTask{}, err
	}
	if cur.DeletedAt != nil {
		return ChangedTask{}, fmt.Errorf("%w: object %s is deleted", domain.ErrNotFound, id)
	}
	if cur.TypeID != "task" {
		return ChangedTask{}, fmt.Errorf("%w: only tasks have a stage, %s is a %s", domain.ErrValidation, cur.ID, cur.TypeID)
	}
	if pid != "" {
		p, err := up.GetObject(ctx, pid)
		if err != nil || p.DeletedAt != nil || p.TypeID != "project" {
			return ChangedTask{}, fmt.Errorf("%w: project %s not found", domain.ErrValidation, pid)
		}
	}
	var patch domain.ObjectPatch
	var fields []string
	if stage != "" && domain.StageOf(cur.Props) != stage {
		props := maps.Clone(cur.Props)
		if props == nil {
			props = map[string]any{}
		}
		props[domain.PropStage] = stage
		patch.Props = &props
		fields = append(fields, "stage")
	}
	if pid != "" && (cur.ProjectID == nil || *cur.ProjectID != pid) {
		v := &pid
		patch.ProjectID = &v
		fields = append(fields, "project_id")
	}
	out := cur
	if len(fields) > 0 {
		if out, err = up.UpdateObject(ctx, cur.ID, patch, w.c.actor(m)); err != nil {
			return ChangedTask{}, err
		}
		w.c.note(ctx, m, "update", "object", out.ID, objSummary("改", out),
			map[string]any{"ref": out.Ref, "title": out.Title, "type_id": out.TypeID, "fields": fields,
				"from_stage": domain.StageOf(cur.Props), "to_stage": domain.StageOf(out.Props)})
	}
	res := ChangedTask{ID: out.ID, Ref: out.Ref, Title: out.Title, Status: out.Status, Stage: domain.StageOf(out.Props), Changed: fields}
	if out.ProjectID != nil {
		res.ProjectID = *out.ProjectID
	}
	return res, nil
}
