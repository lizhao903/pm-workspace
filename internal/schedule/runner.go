package schedule

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 调度的节奏。
const (
	// DefaultInterval 是多久看一次有没有到点的。
	DefaultInterval = 10 * time.Second
	// DefaultGrace 是到点后多久内还算准时：超过的不补跑，记为错过（服务没在跑、机器睡眠都算）。
	DefaultGrace = 2 * time.Minute
	// maxMissedCount 是数错过次数的上限，游标停得很久、规则又很密时不一直往后算。
	maxMissedCount = 10000
)

// TaskCreator 是建任务要用的 store 方法；传入外层包装过的 store，事件和审计照常发。
type TaskCreator interface {
	CreateObject(ctx context.Context, o *domain.Object, a store.Actor) (*domain.Object, error)
}

// AgentRequest 是定时任务交给 Agent 的一次执行（AG-01b4）。RunID 是这次定时任务执行记录的 id，Agent 那边按它去重。
type AgentRequest struct {
	AgentID      string
	ScheduleID   string
	ScheduleName string
	RunID        string
	Prompt       string
}

// AgentStarted 是发起的结果。Failed 是 Agent 执行记录建了但没跑起来（服务商、模型不对之类），Reason 是原因。
type AgentStarted struct {
	RunID     string
	AgentName string
	Failed    bool
	Reason    string
}

// AgentStarter 发起一次 Agent 执行，不等它跑完。Agent 不存在、已停用时回错误，错误文字给人看。
type AgentStarter interface {
	StartAgent(ctx context.Context, q AgentRequest) (*AgentStarted, error)
}

// Runner 是调度器：每隔 Interval 看一遍定时任务，到点的执行，错过的只记一条，不补跑。
//
// 防重有两道：schedules.checked_at 游标（处理过的时刻不再看），和执行记录上「定时任务 + 计划时刻」的唯一索引
// （游标没来得及推进就重启时，同一时刻插不进第二条，也就不会再建一次任务）。
// 时间取 Store 的时钟，测试用 Store.SetClock 换成假时钟，直接调 Tick。
type Runner struct {
	s        *Store
	tasks    TaskCreator
	log      *slog.Logger
	Interval time.Duration
	Grace    time.Duration
	// Agents 执行动作 agent（AG-01b4）；为 nil 时记 unsupported
	Agents AgentStarter
	// SOPs 执行动作 sop（SOP-01d），接插件注册表；为 nil 或 SOP 插件没启用时记 unsupported
	SOPs SOPStarter
	// Incidents 执行动作 incident_sweep（INC-01a），接 internal/incident；为 nil 时记 unsupported
	Incidents IncidentSweeper
	// Reminders 执行动作 remind，接 internal/notify；为 nil 时记 unsupported
	Reminders Reminder

	mu     sync.Mutex // Tick 串行
	cancel context.CancelFunc
	done   chan struct{}
}

// NewRunner 建一个调度器，还没开始跑。
func NewRunner(s *Store, tasks TaskCreator, log *slog.Logger) *Runner {
	if log == nil {
		log = slog.Default()
	}
	return &Runner{s: s, tasks: tasks, log: log.With("component", "schedule"), Interval: DefaultInterval, Grace: DefaultGrace}
}

// Start 先把上次退出时没做完的记录记为失败，再在后台按 Interval 跑 Tick。
func (r *Runner) Start(ctx context.Context) error {
	if n, err := r.s.failInterrupted(ctx); err != nil {
		return err
	} else if n > 0 {
		r.log.Warn("上次退出时有没做完的定时任务执行，已记为失败", "count", n)
	}
	ctx, r.cancel = context.WithCancel(ctx)
	r.done = make(chan struct{})
	go r.loop(ctx)
	return nil
}

// Stop 停掉后台循环，等在途的 Tick 做完。没 Start 过时什么都不做。
func (r *Runner) Stop() {
	if r.cancel == nil {
		return
	}
	r.cancel()
	<-r.done
}

func (r *Runner) loop(ctx context.Context) {
	defer close(r.done)
	t := time.NewTicker(r.Interval)
	defer t.Stop()
	for {
		if err := r.Tick(ctx); err != nil && ctx.Err() == nil {
			r.log.Error("定时任务调度出错", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Tick 看一遍所有定时任务，处理游标到现在之间的计划时刻。单个定时任务出错只记日志，不影响别的。
func (r *Runner) Tick(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows, err := r.s.listDue(ctx)
	if err != nil {
		return err
	}
	now := r.s.now()
	for i := range rows {
		if err := r.handle(ctx, &rows[i], now); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			r.log.Error("定时任务执行出错", "schedule", rows[i].ID, "err", err)
		}
	}
	return nil
}

// handle 处理一个定时任务在 (游标, now] 里的计划时刻：
// 最后一个在 Grace 以内的执行（停用的记「已停用」），其余的都算错过，合成一条 missed；然后推进游标。
func (r *Runner) handle(ctx context.Context, d *dueRow, now time.Time) error {
	from := d.checked
	if !now.After(from) {
		return nil
	}
	loc := r.s.loc
	// 准时的那一次：Grace 窗口里最后一个计划时刻
	ws := now.Add(-r.Grace)
	if ws.Before(from) {
		ws = from
	}
	var due *time.Time
	for t := Next(d.Rule, ws, loc); t != nil && !t.After(now); t = Next(d.Rule, *t, loc) {
		v := *t
		due = &v
	}
	n := 0
	if d.Enabled {
		first := Next(d.Rule, from, loc)
		for t := first; t != nil && !t.After(now) && n < maxMissedCount; t = Next(d.Rule, *t, loc) {
			if due != nil && t.Equal(*due) {
				break
			}
			n++
		}
		if n > 0 {
			if _, err := r.s.insertRun(ctx, d.ID, *first, false, runResult{status: RunMissed, text: missedText(*first, n, loc)}, n); err != nil {
				return err
			}
		}
	}
	if due != nil {
		if d.Enabled {
			if _, err := r.execute(ctx, &d.Schedule, *due, false); err != nil {
				return err
			}
		} else if _, err := r.s.insertRun(ctx, d.ID, *due, false, runResult{status: RunSkipped, text: "没执行：已停用"}, 0); err != nil {
			return err
		}
	}
	// 一次性提醒到点了（提醒了或错过了）就停用，列表里显示「已提醒」
	if d.Enabled && (due != nil || n > 0) && onceDone(&d.Schedule) {
		if err := r.s.disableDone(ctx, d.ID); err != nil {
			return err
		}
	}
	return r.s.setChecked(ctx, d.ID, now)
}

func missedText(first time.Time, n int, loc *time.Location) string {
	at := first.In(loc).Format("01-02 15:04")
	if n == 1 {
		return fmt.Sprintf("没执行：%s 到点时服务没在运行，没有补跑", at)
	}
	more := ""
	if n >= maxMissedCount {
		more = "多"
	}
	return fmt.Sprintf("没执行：服务没在运行，从 %s 起错过了 %d %s次，没有补跑", at, n, more)
}

// RunNow 手动执行一次：不看启停，不影响游标和下次执行时间，记录带 manual。
func (r *Runner) RunNow(ctx context.Context, id string) (*Run, error) {
	sc, err := r.s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	return r.execute(ctx, sc, r.s.now(), true)
}

// execute 按动作执行一次并写执行记录；自动执行碰上已有的同一时刻记录时什么都不做，回 nil。
func (r *Runner) execute(ctx context.Context, sc *Schedule, planned time.Time, manual bool) (*Run, error) {
	switch sc.Action.Kind {
	case ActionSOP:
		if r.SOPs == nil {
			return r.s.insertRun(ctx, sc.ID, planned, manual, runResult{status: RunUnsupported, text: sopUnavailableText}, 0)
		}
	case ActionAgent:
		if r.Agents == nil {
			return r.s.insertRun(ctx, sc.ID, planned, manual, runResult{status: RunUnsupported, text: "没执行：让 Agent 去做暂不支持，M4 之后才有"}, 0)
		}
	case ActionIncidentSweep:
		if r.Incidents == nil {
			return r.s.insertRun(ctx, sc.ID, planned, manual, runResult{status: RunUnsupported, text: incidentUnavailableText}, 0)
		}
	case ActionRemind:
		if r.Reminders == nil {
			return r.s.insertRun(ctx, sc.ID, planned, manual, runResult{status: RunUnsupported, text: remindUnavailableText}, 0)
		}
	case ActionTask:
	default:
		if r.s.plugins == nil {
			return r.s.insertRun(ctx, sc.ID, planned, manual, runResult{status: RunFailed, text: fmt.Sprintf("没执行：不认识的动作 %q", sc.Action.Kind)}, 0)
		}
	}
	// 先占住这个时刻再建任务：撞上唯一索引说明这一刻已经处理过
	run, err := r.s.insertRun(ctx, sc.ID, planned, manual, runResult{status: RunRunning}, 0)
	if err != nil || run == nil {
		return nil, err
	}
	var res runResult
	switch sc.Action.Kind {
	case ActionAgent:
		res = r.startAgent(ctx, sc, run.ID)
	case ActionSOP:
		res = r.startSOP(ctx, sc)
	case ActionTask:
		res = r.createTask(ctx, sc, planned)
	case ActionIncidentSweep:
		res = r.sweepIncidents(ctx, sc, run)
	case ActionRemind:
		res = r.remind(ctx, sc, run, planned, manual)
	default:
		res = r.runPlugin(ctx, sc, run, planned, manual)
	}
	if err := r.s.finishRun(ctx, run, res); err != nil {
		return nil, err
	}
	if res.status != RunOK {
		r.log.Warn("定时任务没执行成", "schedule", sc.ID, "text", res.text)
	}
	return run, nil
}

// startAgent 交给 Agent 去做，不等它跑完；结果文字指到 Agent 的执行记录。
func (r *Runner) startAgent(ctx context.Context, sc *Schedule, runID string) runResult {
	got, err := r.Agents.StartAgent(ctx, AgentRequest{
		AgentID: sc.Action.AgentID, ScheduleID: sc.ID, ScheduleName: sc.Name, RunID: runID, Prompt: sc.Action.Prompt,
	})
	if err != nil {
		return runResult{status: RunFailed, text: "没执行：" + err.Error()}
	}
	if got.Failed {
		return runResult{status: RunFailed, text: fmt.Sprintf("Agent「%s」没跑起来：%s，执行记录 %s", got.AgentName, got.Reason, got.RunID)}
	}
	return runResult{status: RunOK, text: fmt.Sprintf("交给了 Agent「%s」，执行记录 %s", got.AgentName, got.RunID)}
}

var datePlaceholder = regexp.MustCompile(`\{\{\s*date\s*\}\}`)

// createTask 建一条来源为 schedule 的任务。标题里的 {{date}} 换成计划时刻那天（和原型一样写成 2026/10/29）；
// 截止日是那天往后 due_days 天的零点；assignee 是干系人 id 时设为负责人，干系人已删就不设。
func (r *Runner) createTask(ctx context.Context, sc *Schedule, planned time.Time) runResult {
	a := sc.Action
	day := planned.In(r.s.loc)
	due := time.Date(day.Year(), day.Month(), day.Day()+a.DueDays, 0, 0, 0, 0, r.s.loc)
	o := &domain.Object{
		TypeID:   "task",
		Title:    datePlaceholder.ReplaceAllString(a.Title, day.Format("2006/1/2")),
		Body:     a.Desc,
		Priority: a.Priority,
		Source:   domain.TaskSourceSchedule,
		DueAt:    &due,
		Props:    map[string]any{domain.PropSourceRef: map[string]any{"schedule_id": sc.ID, "name": sc.Name}},
	}
	note := ""
	if owner := a.Assignee; strings.HasPrefix(owner, "stk_") {
		o.OwnerID = &owner
	}
	actor := store.Actor{Name: "schedule", Source: "schedule", Session: sc.ID}
	out, err := r.tasks.CreateObject(ctx, o, actor)
	if err != nil && o.OwnerID != nil && errors.Is(err, domain.ErrNotFound) {
		o.OwnerID, note = nil, "（负责人已删除，没设负责人）"
		out, err = r.tasks.CreateObject(ctx, o, actor)
	}
	if err != nil {
		return runResult{status: RunFailed, text: "没建成任务：" + err.Error()}
	}
	return runResult{status: RunOK, text: "建了任务 " + out.Ref + note, objectID: out.ID, ref: out.Ref}
}
