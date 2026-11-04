package notify

import (
	"context"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// KindReminder 是定时任务动作 remind 到点发的提醒通知。
const KindReminder = "schedule.remind"

// Remind 实现 schedule.Reminder：落一条提醒通知并推进事件流。
// 关联的对象还在时通知带 object_id，data 里放跳转用的 object_id、type_id、ref；内容空着时用对象标题。
// 对象已删（查不到或在回收站）时通知不带跳转，结果里标 ObjectGone。
func (c *Center) Remind(ctx context.Context, q schedule.RemindRequest) (*schedule.RemindResult, error) {
	popup := q.Popup
	if popup != schedule.PopupModal {
		popup = schedule.PopupToast
	}
	// popup 告诉前端怎么弹：toast 右下角，modal 屏幕中间（SPEC-tasks-8.26）
	data := map[string]any{"schedule_id": q.ScheduleID, "run_id": q.RunID, "popup": popup}
	n := Notification{Kind: KindReminder, Level: LevelInfo, Title: q.Title, Body: q.Body, Data: data}
	res := &schedule.RemindResult{}
	if q.ObjectID != "" && c.lookup != nil {
		o, err := c.lookup.GetObject(ctx, q.ObjectID)
		switch {
		case errors.Is(err, domain.ErrNotFound) || (err == nil && o.DeletedAt != nil):
			res.ObjectGone = true
		case err != nil:
			return nil, err
		default:
			n.ObjectID = o.ID
			data["object_id"], data["type_id"], data["ref"] = o.ID, o.TypeID, o.Ref
			res.ObjectID, res.Ref = o.ID, o.Ref
			if n.Body == "" {
				n.Body = o.Title
			}
		}
	} else if q.ObjectID != "" {
		// 没接对象查询：照样带上，前端打开时再说
		n.ObjectID = q.ObjectID
		data["object_id"] = q.ObjectID
		res.ObjectID = q.ObjectID
	}
	got, err := c.Create(ctx, n)
	if err != nil {
		return nil, err
	}
	res.NotificationID = got.ID
	return res, nil
}
