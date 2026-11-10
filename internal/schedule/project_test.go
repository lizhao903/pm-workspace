// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package schedule_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func ptr[T any](v T) *T { return &v }

// 定时任务归到项目（0055）：保存时核对是项目、按项目列、改和清空；动作 task 建的任务挂到同一个项目。
func TestScheduleProject(t *testing.T) {
	f := newFixture(t)
	f.ss.SetObjects(f.st)
	ctx := context.Background()
	actor := store.Actor{Name: "test"}
	proj, err := f.st.CreateObject(ctx, &domain.Object{TypeID: "project", Title: "官网改版"}, actor)
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.st.CreateObject(ctx, &domain.Object{TypeID: "project", Title: "别的项目"}, actor)
	if err != nil {
		t.Fatal(err)
	}
	task, err := f.st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "不是项目"}, actor)
	if err != nil {
		t.Fatal(err)
	}
	rule := schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"}
	act := schedule.Action{Kind: schedule.ActionTask, Title: "整理 {{date}} 周报"}

	sc := f.create(t, schedule.Input{Name: "周报", Rule: rule, Action: act, ProjectID: ptr(" " + proj.ID + " ")})
	if sc.ProjectID == nil || *sc.ProjectID != proj.ID {
		t.Fatalf("project_id = %v", sc.ProjectID)
	}
	none := f.create(t, schedule.Input{Name: "不归项目", Rule: rule, Action: act, ProjectID: ptr("")})
	if none.ProjectID != nil {
		t.Fatalf("空串应为不属于任何项目：%v", *none.ProjectID)
	}

	for _, c := range []struct {
		id, want string
	}{{"obj_nope", "not found"}, {task.ID, "is not a project"}} {
		_, err := f.ss.Create(ctx, schedule.Input{Name: "x", Rule: rule, Action: act, ProjectID: ptr(c.id)})
		if !errors.Is(err, domain.ErrValidation) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s：应回 %q，得 %v", c.id, c.want, err)
		}
	}

	got, err := f.ss.ListByProject(ctx, proj.ID)
	if err != nil || len(got) != 1 || got[0].ID != sc.ID {
		t.Fatalf("按项目列：%+v，%v", got, err)
	}
	if g, _ := f.ss.Get(ctx, sc.ID); g.ProjectID == nil || *g.ProjectID != proj.ID {
		t.Fatalf("读回来应带项目：%+v", g)
	}

	// 到点建的任务挂到这个项目
	f.clk.set(f.at(9, 0, 5))
	f.tick(t)
	var mine *domain.Object
	for _, o := range f.scheduleTasks(t) {
		if ref, _ := o.Props[domain.PropSourceRef].(map[string]any); ref["schedule_id"] == sc.ID {
			mine = o
		}
	}
	if mine == nil || mine.ProjectID == nil || *mine.ProjectID != proj.ID {
		t.Fatalf("建的任务应挂到项目：%+v", mine)
	}

	// 改到别的项目；只改名字不动项目；清空
	moved := ptr(ptr(other.ID))
	up, err := f.ss.Update(ctx, sc.ID, schedule.Patch{ProjectID: moved})
	if err != nil || up.ProjectID == nil || *up.ProjectID != other.ID {
		t.Fatalf("改项目：%+v，%v", up, err)
	}
	up, err = f.ss.Update(ctx, sc.ID, schedule.Patch{Name: ptr("周报 2")})
	if err != nil || up.ProjectID == nil || *up.ProjectID != other.ID {
		t.Fatalf("只改名字不应动项目：%+v，%v", up, err)
	}
	var cleared *string
	up, err = f.ss.Update(ctx, sc.ID, schedule.Patch{ProjectID: &cleared})
	if err != nil || up.ProjectID != nil {
		t.Fatalf("清空：%+v，%v", up, err)
	}
	if _, err := f.ss.Update(ctx, sc.ID, schedule.Patch{ProjectID: ptr(ptr(task.ID))}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("改成非项目应 400：%v", err)
	}
}
