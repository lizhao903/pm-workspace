// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// reviewStore 在 taskRunStore 上加改待验收要的读写：一条任务 obj_task，状态集同内置任务类型。
type reviewStore struct {
	taskRunStore
	rmu      sync.Mutex
	status   string
	progress []domain.ProgressInput
	actors   []store.Actor
}

func (s *reviewStore) GetObject(_ context.Context, id string) (*domain.Object, error) {
	s.rmu.Lock()
	defer s.rmu.Unlock()
	return &domain.Object{ID: id, TypeID: "task", Status: s.status}, nil
}

func (s *reviewStore) GetObjectType(context.Context, string) (*domain.ObjectType, error) {
	return &domain.ObjectType{ID: "task", Statuses: []domain.Status{{Key: "todo"}, {Key: "doing"}, {Key: "review"},
		{Key: "done", Terminal: true}, {Key: "cancelled", Terminal: true}}}, nil
}

// ListTaskRuns：收尾已经落库，同一任务没有别的执行
func (s *reviewStore) ListTaskRuns(context.Context, string, int) ([]*domain.TaskRun, error) {
	now := time.Now()
	return []*domain.TaskRun{{ID: "run_task1", FinishedAt: &now}}, nil
}

func (s *reviewStore) AppendProgress(_ context.Context, id string, in domain.ProgressInput, a store.Actor) (*domain.Progress, error) {
	s.rmu.Lock()
	defer s.rmu.Unlock()
	if in.Status != "" {
		s.status = in.Status
	}
	s.progress = append(s.progress, in)
	s.actors = append(s.actors, a)
	return &domain.Progress{ObjectID: id, Text: in.Text, Status: in.Status}, nil
}

func (s *reviewStore) snapshot() (string, []domain.ProgressInput, []store.Actor) {
	s.rmu.Lock()
	defer s.rmu.Unlock()
	return s.status, append([]domain.ProgressInput(nil), s.progress...), append([]store.Actor(nil), s.actors...)
}

// TestClaudeRunReviewOnDone（TSK-0861）：ReviewOnDone 的运行成功完成后任务改待验收、记一条进展；
// 回报 failed、没传 ReviewOnDone、执行中状态被改过的都不改。
func TestClaudeRunReviewOnDone(t *testing.T) {
	cases := []struct {
		name         string
		review       bool
		report       string // Claude Code 经 pmw_finish_run 回报的结果，空为没回报
		changeTo     string // 执行中把任务改成什么，空为不改
		wantStatus   string
		wantProgress int
	}{
		{name: "成功完成", review: true, wantStatus: "review", wantProgress: 1},
		{name: "回报做不下去", review: true, report: "failed", wantStatus: "todo"},
		{name: "没要求改状态", review: false, wantStatus: "todo"},
		{name: "执行中人改成已完成", review: true, changeTo: "done", wantStatus: "done"},
		{name: "执行中人改成进行中", review: true, changeTo: "doing", wantStatus: "doing"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx := context.Background()
			r, demo, runs, g := reportEnv(t)
			st := &reviewStore{status: "todo"}
			r.SetObjectCreator(st)
			id, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "p", ObjectID: "obj_task",
				RecordOnTask: true, ReportBack: true, ReviewOnDone: c.review})
			if err != nil {
				t.Fatal(err)
			}
			<-g.got
			if c.changeTo != "" {
				st.rmu.Lock()
				st.status = c.changeTo
				st.rmu.Unlock()
			}
			if c.report != "" {
				if _, err := r.ReportRun(id, c.report, "缺权限", nil); err != nil {
					t.Fatal(err)
				}
			}
			g.release <- &runner.Result{Status: domain.RunDone, Output: "过程"}
			finished(t, demo, id)
			waitFor(t, "任务执行记录收尾", func() bool {
				st.mu.Lock()
				defer st.mu.Unlock()
				_, ok := st.finished[id]
				return ok
			})
			r.WaitRuns(5 * time.Second)
			status, progress, actors := st.snapshot()
			if status != c.wantStatus || len(progress) != c.wantProgress {
				t.Fatalf("状态 = %s（要 %s），进展 %d 条（要 %d）", status, c.wantStatus, len(progress), c.wantProgress)
			}
			if c.wantProgress == 1 {
				if p := progress[0]; p.Status != "review" || !strings.HasPrefix(p.Text, "Claude Code 执行完成（执行记录 "+store.ShortRunID("run_task1")+"）") {
					t.Fatalf("进展 = %+v", p)
				}
				if a := actors[0]; a.Name != "demo" || a.Source != plugin.ActorSourcePlugin {
					t.Fatalf("操作者 = %+v，应是发起的插件", a)
				}
			}
		})
	}
}
