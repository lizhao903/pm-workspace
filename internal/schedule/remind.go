package schedule

import (
	"context"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 动作 remind「提醒」：内核动作，到点在工作台里发一条通知（只进通知列表、推事件流，不外发 IM）。
// 可以关联一个对象（任务抽屉里「设个提醒」建的就关联那条任务），通知带上 object_id，点了打开它。
// 通知中心在 internal/notify，它实现 Reminder，cmd/pmw 接到 Runner.Reminders；请求和结果的类型放在这里。
//
// 规则用一次性 once 时，到点（准时执行或错过）后自动停用，列表里显示「已提醒」；重复规则照常每次都提醒。

// 提醒的字数上限。
const (
	maxRemindTitle = 100
	maxRemindBody  = 2000
)

// RemindRequest 是到点发的一条提醒。At 是计划时刻，手动执行为点按钮的时刻。
type RemindRequest struct {
	Title        string
	Body         string
	ObjectID     string
	ScheduleID   string
	ScheduleName string
	RunID        string
	At           time.Time
	Manual       bool
}

// RemindResult 是发出的通知。ObjectID、Ref 是关联的对象（还在时）；ObjectGone 是关联的对象已经删了，通知不带跳转。
type RemindResult struct {
	NotificationID string
	ObjectID       string
	Ref            string
	ObjectGone     bool
}

// Reminder 发提醒通知。
type Reminder interface {
	Remind(ctx context.Context, q RemindRequest) (*RemindResult, error)
}

// ObjectLookup 是保存提醒时查关联对象在不在，store.Store 满足它。
type ObjectLookup interface {
	GetObject(ctx context.Context, id string) (*domain.Object, error)
}

// SetObjects 接上对象查询：保存提醒时关联的对象不存在（或已删）回 400。没接时不查，到点发通知时再说。
func (s *Store) SetObjects(o ObjectLookup) { s.objects = o }

// remindUnavailableText 是没接通知时执行记录的文字。
const remindUnavailableText = "没执行：通知没接上"

func (a Action) validateRemind() error {
	if a.Title == "" {
		return invalid("action.title is required for kind remind")
	}
	if n := utf8.RuneCountInString(a.Title); n > maxRemindTitle {
		return invalid("action.title is longer than %d characters", maxRemindTitle)
	}
	if n := utf8.RuneCountInString(a.Body); n > maxRemindBody {
		return invalid("action.body is longer than %d characters", maxRemindBody)
	}
	return nil
}

// checkRemindObject 查关联的对象还在不在；没接对象查询、没关联时不查。
func (s *Store) checkRemindObject(ctx context.Context, a Action) error {
	if a.Kind != ActionRemind || a.ObjectID == "" || s.objects == nil {
		return nil
	}
	o, err := s.objects.GetObject(ctx, a.ObjectID)
	if errors.Is(err, domain.ErrNotFound) || (err == nil && o.DeletedAt != nil) {
		return invalid("action.object_id: object %s not found", a.ObjectID)
	}
	if err != nil {
		return fmt.Errorf("check remind object: %w", err)
	}
	return nil
}

// ListByObject 是关联这个对象的提醒（动作 remind、object_id 是它），排序同 List；停用的、已提醒过的也在。
func (s *Store) ListByObject(ctx context.Context, objectID string) ([]Schedule, error) {
	all, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	out := []Schedule{}
	for _, sc := range all {
		if sc.Action.Kind == ActionRemind && sc.Action.ObjectID == objectID {
			out = append(out, sc)
		}
	}
	return out, nil
}

// onceDone 说这个定时任务处理过计划时刻后要不要自动停用：只管一次性的提醒。
func onceDone(sc *Schedule) bool {
	return sc.Rule.Freq == FreqOnce && sc.Action.Kind == ActionRemind
}

// disableDone 一次性提醒到点后停用；已经停用的不动。
func (s *Store) disableDone(ctx context.Context, id string) error {
	_, err := s.db.W.ExecContext(ctx, `UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1`, ts(s.now()), id)
	if err != nil {
		return fmt.Errorf("disable finished reminder: %w", err)
	}
	return nil
}

// remind 发一条提醒通知；结果文字带上关联的对象编号，执行记录的 object_id、ref 指向它（点了打开）。
func (r *Runner) remind(ctx context.Context, sc *Schedule, run *Run, planned time.Time, manual bool) runResult {
	a := sc.Action
	got, err := r.Reminders.Remind(ctx, RemindRequest{
		Title: a.Title, Body: a.Body, ObjectID: a.ObjectID, ScheduleID: sc.ID, ScheduleName: sc.Name,
		RunID: run.ID, At: planned, Manual: manual,
	})
	if err != nil {
		return runResult{status: RunFailed, text: "没提醒成：" + err.Error()}
	}
	if got == nil {
		got = &RemindResult{}
	}
	res := runResult{status: RunOK, text: fmt.Sprintf("提醒了「%s」", a.Title)}
	switch {
	case got.ObjectGone:
		res.text += "（关联的任务已删除，通知不带跳转）"
	case got.Ref != "":
		res.text += "，关联 " + got.Ref
		res.objectID, res.ref = got.ObjectID, got.Ref
	case got.ObjectID != "":
		res.objectID = got.ObjectID
	}
	return res
}
