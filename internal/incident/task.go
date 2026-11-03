package incident

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// SweepTag 是巡检建的任务带的标签：交给 Claude Code 修。
const SweepTag = "claude-code"

// TaskInput 是转任务的字段，都可省：标题默认「[异常] <模块>：<标题>」，正文默认 TaskDesc，
// 优先级按级别和次数（LevelPriority），负责人是干系人 id。
type TaskInput struct {
	Title      *string `json:"title"`
	Body       *string `json:"body"`
	Priority   *string `json:"priority"`
	AssigneeID *string `json:"assignee_id"`
}

// TaskResult 是转任务的结果：建出的任务和转完的异常。
type TaskResult struct {
	Task     *domain.Object `json:"task"`
	Incident *Incident      `json:"incident"`
}

// TaskTitle 是转任务的默认标题。
func TaskTitle(x *Incident) string { return fmt.Sprintf("[异常] %s：%s", x.Module, x.Title) }

// LevelPriority 同原型 levelPriority（SPEC-settings-19.7）：错误 5 次以上 P0、错误 P1、警告 P2。
func LevelPriority(x *Incident) string {
	if x.Level == LevelError {
		if x.Count >= 5 {
			return "P0"
		}
		return "P1"
	}
	return "P2"
}

func (s *Store) local(t time.Time) string { return t.In(s.loc).Format("2006/1/2 15:04:05") }

// TaskDesc 同原型 taskDesc（SPEC-settings-19.6）：现象、频率、上下文、报错、期望。上下文按键名排序。
func (s *Store) TaskDesc(x *Incident) string {
	lv := "错误"
	if x.Level == LevelWarn {
		lv = "警告"
	}
	parts := []string{
		fmt.Sprintf("【运行异常】%s · %s", x.Module, lv),
		"现象：" + x.Message,
		fmt.Sprintf("频率：共 %d 次，首次 %s，最近 %s", x.Count, s.local(x.FirstAt), s.local(x.LastAt)),
	}
	if ctx := contextLines(x.Context); ctx != "" {
		parts = append(parts, "上下文：\n"+ctx)
	}
	if x.Stack != "" {
		parts = append(parts, "报错：\n"+x.Stack)
	}
	parts = append(parts, "期望：系统能自己处理这种情况，或者给出明确的修复指引。")
	return strings.Join(parts, "\n\n")
}

func contextLines(m map[string]any) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		lines = append(lines, fmt.Sprintf("- %s：%s", k, valueText(m[k])))
	}
	return strings.Join(lines, "\n")
}

func valueText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return "null"
	case map[string]any, []any:
		b, _ := json.Marshal(t)
		return string(b)
	}
	return fmt.Sprint(v)
}

// sweepAcceptance 是巡检任务的验收清单，写进正文「改完怎么验收」和 props.acceptance。
func sweepAcceptance(x *Incident) string {
	return strings.Join([]string{
		"- [ ] 按「怎么复现」的步骤操作，不再出现这条报错，也没有换成别的报错",
		"- [ ] 补一条能复现这个问题的测试（后端 Go 测试或前端冒烟），改之前失败、改之后通过",
		"- [ ] gofmt、go vet ./...、go test ./... 通过；动了前端的跑 make smoke-frontend 通过",
		fmt.Sprintf("- [ ] 到「设置 / 运行异常」把这条异常（%s）标为已解决；再出现时会自动重新打开", x.ID),
	}, "\n")
}

// sweepBody 是巡检任务的正文：TaskDesc 再加「怎么复现」「改完怎么验收」。
func (s *Store) sweepBody(x *Incident) string {
	repro := []string{"怎么复现："}
	if u, ok := x.Context["页面地址"].(string); ok && u != "" {
		repro = append(repro, "1. 打开 "+u+"，按上下文里的操作走一遍（异常来自前端时，第一次进入页面就要试，不要先刷新）")
	} else {
		repro = append(repro, fmt.Sprintf("1. 按上面的上下文找到出事的%s对象，重做一次出事时的操作", x.Module))
	}
	repro = append(repro,
		"2. 对照「报错」里的堆栈或原始报错，确认能稳定复现；复现不了的在任务里写明试过哪些步骤",
		fmt.Sprintf("3. 指纹 %s，这条异常在「设置 / 运行异常」里能看到最近 %d 次的发生时间", x.Fingerprint, MaxOccurrences))
	return s.TaskDesc(x) + "\n\n" + strings.Join(repro, "\n") + "\n\n改完怎么验收：\n" + sweepAcceptance(x)
}

// ToTask 把一条异常转成任务（SPEC-settings-19.8）：来源 incident、props.source_ref 指向异常，异常变已转任务、记下任务 id。
// 已经有任务的回 409；已忽略、已解决的先重新打开才能转。
func (s *Store) ToTask(ctx context.Context, id string, in TaskInput, a store.Actor) (*TaskResult, error) {
	return s.toTask(ctx, id, func(x *Incident) (*domain.Object, error) {
		o := &domain.Object{TypeID: "task", Title: TaskTitle(x), Body: s.TaskDesc(x), Priority: LevelPriority(x),
			Source: domain.TaskSourceIncident,
			Props:  map[string]any{domain.PropSourceRef: map[string]any{"incident_id": x.ID, "title": x.Title}}}
		if in.Title != nil && strings.TrimSpace(*in.Title) != "" {
			o.Title = strings.TrimSpace(*in.Title)
		}
		if in.Body != nil {
			o.Body = *in.Body
		}
		if in.Priority != nil && strings.TrimSpace(*in.Priority) != "" {
			o.Priority = strings.TrimSpace(*in.Priority)
		}
		if in.AssigneeID != nil && strings.TrimSpace(*in.AssigneeID) != "" {
			v := strings.TrimSpace(*in.AssigneeID)
			o.OwnerID = &v
		}
		return o, nil
	}, a, nil)
}

// toTask 建任务并挂到异常上；build 给出要建的任务。extra 补进审计 detail。
func (s *Store) toTask(ctx context.Context, id string, build func(*Incident) (*domain.Object, error), a store.Actor,
	extra map[string]any) (*TaskResult, error) {
	if s.Tasks == nil {
		return nil, errors.New("incident: task creator is not configured")
	}
	if err := s.reconcile(ctx); err != nil {
		return nil, err
	}
	// 建任务和挂任务之间不许别人插进来，否则同一条异常会建出两条任务
	s.mu.Lock()
	defer s.mu.Unlock()
	x, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	if x.TaskID != nil {
		ref := x.TaskRef
		if ref == "" {
			ref = *x.TaskID
		}
		return nil, conflict("incident %s already has task %s", id, ref)
	}
	if x.Status == StatusIgnored || x.Status == StatusResolved {
		return nil, conflict("incident %s is %s; reopen it before creating a task", id, x.Status)
	}
	o, err := build(x)
	if err != nil {
		return nil, err
	}
	task, err := s.Tasks.CreateObject(ctx, o, a)
	if err != nil {
		if o.OwnerID != nil && errors.Is(err, domain.ErrNotFound) {
			return nil, invalid("assignee_id: stakeholder %s not found", *o.OwnerID)
		}
		return nil, err
	}
	if _, err := s.db.W.ExecContext(ctx, `UPDATE incidents SET task_id = ?, status = 'tasked', note = '' WHERE id = ? AND task_id IS NULL`,
		task.ID, id); err != nil {
		return nil, fmt.Errorf("attach incident task: %w", err)
	}
	out, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	detail := map[string]any{"task_id": task.ID, "ref": task.Ref}
	for k, v := range extra {
		detail[k] = v
	}
	s.audit(ctx, a, audit.Entry{Kind: audit.KindConfig, Action: "create_task", TargetType: "incident", TargetID: id,
		Summary: fmt.Sprintf("运行异常「%s」转为任务 %s", x.Title, task.Ref), Detail: detail})
	s.publish(ctx, out, "tasked")
	return &TaskResult{Task: task, Incident: out}, nil
}

// SweepIncidents 是定时任务动作 incident_sweep：未处理、还没有任务、级别和次数够的各建一条任务交给 Claude Code 修，
// 标题「[异常] <模块>：<标题>」，正文是 TaskDesc 加「怎么复现」「改完怎么验收」，标签 claude-code，优先级按 LevelPriority。
// 已经有任务的不会再建（转任务时同一把锁里查 task_id）。两类留给用户自己处理、不自动建（用户 2026-10-30 定的）：
// 修复任务被删过的（删任务就是「先不修」，再出现时 note 清掉才重新算）；Claude Code 执行失败的（修复任务本身又失败，
// 自动再建会一层套一层）。
func (s *Store) SweepIncidents(ctx context.Context, q schedule.IncidentSweepRequest) (*schedule.IncidentSweepResult, error) {
	levels := []string{LevelError}
	switch q.MinLevel {
	case "", LevelError:
	case LevelWarn:
		levels = append(levels, LevelWarn)
	default:
		return nil, invalid("min_level must be error or warn, got %q", q.MinLevel)
	}
	minCount := max(q.MinCount, 1)
	open, err := s.List(ctx, Filter{Status: []string{StatusOpen}})
	if err != nil {
		return nil, err
	}
	res := &schedule.IncidentSweepResult{}
	actor := store.Actor{Name: "schedule", Source: "schedule", Session: q.ScheduleID}
	// 先建老的：List 是最近的在前
	for i := len(open) - 1; i >= 0; i-- {
		x := open[i]
		if x.TaskID != nil {
			continue
		}
		if !slices.Contains(levels, x.Level) || x.Count < minCount {
			res.Skipped++
			continue
		}
		if x.Note == noteTaskDeleted || strings.HasPrefix(x.Fingerprint, ClaudeFingerprintPrefix) {
			res.Held++
			continue
		}
		got, err := s.toTask(ctx, x.ID, func(cur *Incident) (*domain.Object, error) {
			return &domain.Object{TypeID: "task", Title: TaskTitle(cur), Body: s.sweepBody(cur), Priority: LevelPriority(cur),
				Source: domain.TaskSourceIncident, Tags: []string{SweepTag},
				Props: map[string]any{
					domain.PropSourceRef:  map[string]any{"incident_id": cur.ID, "title": cur.Title, "schedule_id": q.ScheduleID, "run_id": q.RunID},
					domain.PropAcceptance: sweepAcceptance(cur),
				}}, nil
		}, actor, map[string]any{"schedule_id": q.ScheduleID, "run_id": q.RunID, "via": "incident_sweep"})
		switch {
		case errors.Is(err, domain.ErrConflict):
			// 这一轮里别处已经转了任务，或者刚被忽略、解决：不算跳过也不算失败
			continue
		case err != nil:
			res.Failed = append(res.Failed, fmt.Sprintf("「%s」%s", x.Title, err.Error()))
			continue
		}
		res.Created = append(res.Created, schedule.SweptTask{IncidentID: x.ID, ObjectID: got.Task.ID, Ref: got.Task.Ref})
	}
	return res, nil
}
