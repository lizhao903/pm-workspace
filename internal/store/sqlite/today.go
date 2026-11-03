package sqlite

import (
	"context"
	"fmt"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// Today 拼今日页的内核卡片。逾期、今天到期直接用 Counts 的那份条件（focusConds），
// 卡片的 Total 和 counts.overdue / counts.today 是同一条 SQL 数出来的。
//
// typeID 的语义和 Counts 一样：空是全局，非空收窄到该类型。等确认只看待办的 review，
// 状态集按类型隔离，别的类型就算有同名的 review 也不是「待验收」。
func (s *Store) Today(ctx context.Context, typeID string) (*domain.Today, error) {
	fc, err := s.focusConds(ctx, time.Now(), typeID)
	if err != nil {
		return nil, err
	}
	scopeCond, scopeArgs := "", []any{}
	if typeID != "" {
		scopeCond, scopeArgs = " AND o.type_id = ?", []any{typeID}
	}
	review := focusCond{liveCond + ` AND o.type_id = 'task' AND o.status = ?` + scopeCond,
		concatArgs([]any{domain.TaskStatusReview}, scopeArgs)}

	cards := []*domain.TodayCard{}
	for _, c := range []struct {
		key, title string
		order      int
		fc         focusCond
		sort       string
	}{
		// 等确认最近提交的在前；逾期截止早的在前；今天到期按截止时间。
		{domain.TodayCardReview, "等确认", 10, review, "o.updated_at DESC, o.id DESC"},
		{domain.TodayCardOverdue, "逾期", 20, fc.overdue, "o.due_at ASC, o.id ASC"},
		{domain.TodayCardDueToday, "今天到期", 30, fc.today, "o.due_at ASC, o.id ASC"},
	} {
		items, total, err := s.todayObjects(ctx, c.fc, c.sort)
		if err != nil {
			return nil, fmt.Errorf("today %s: %w", c.key, err)
		}
		cards = append(cards, &domain.TodayCard{Key: c.key, Title: c.title, Order: c.order, Total: total, Items: items})
	}

	runs, total, err := s.todayRuns(ctx, typeID)
	if err != nil {
		return nil, fmt.Errorf("today running: %w", err)
	}
	cards = append(cards, &domain.TodayCard{Key: domain.TodayCardRunning, Title: "运行中", Order: 40, Total: total, Items: runs})
	return &domain.Today{Cards: cards}, nil
}

// todayObjects 按条件取对象，最多 TodayCardLimit 条。Total 和 Counts 用的是同一句 COUNT。
func (s *Store) todayObjects(ctx context.Context, fc focusCond, order string) ([]*domain.Object, int, error) {
	var total int
	if err := s.db.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM objects o WHERE `+fc.cond, fc.args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count objects: %w", err)
	}
	rows, err := s.db.R.QueryContext(ctx,
		objectSelect+` WHERE `+fc.cond+` ORDER BY `+order+` LIMIT ?`,
		concatArgs(fc.args, []any{domain.TodayCardLimit})...)
	if err != nil {
		return nil, 0, fmt.Errorf("list objects: %w", err)
	}
	defer func() { _ = rows.Close() }()

	items := []*domain.Object{}
	for rows.Next() {
		o, err := scanObject(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, o)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := s.fillTags(ctx, items); err != nil {
		return nil, 0, err
	}
	if err := s.fillParticipants(ctx, items); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

// todayRuns 取未结束的执行（finished_at 为空，即 pending / running），最近开始的在前。
// 对象在回收站里也照样列：进程还在跑，今日页得让人看见。
func (s *Store) todayRuns(ctx context.Context, typeID string) ([]*domain.TodayRun, int, error) {
	cond, args := `r.finished_at IS NULL`, []any{}
	if typeID != "" {
		cond, args = cond+` AND o.type_id = ?`, []any{typeID}
	}
	from := ` FROM task_runs r LEFT JOIN objects o ON o.id = r.object_id WHERE ` + cond

	var total int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*)`+from, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count runs: %w", err)
	}
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT r.id, r.object_id, IFNULL(o.ref,''), IFNULL(o.title,''), IFNULL(o.type_id,''),
		        r.workdir, r.status, r.started_at`+from+
			` ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?`,
		concatArgs(args, []any{domain.TodayCardLimit})...)
	if err != nil {
		return nil, 0, fmt.Errorf("list runs: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.TodayRun{}
	for rows.Next() {
		var (
			r       domain.TodayRun
			started string
		)
		if err := rows.Scan(&r.ID, &r.ObjectID, &r.ObjectRef, &r.ObjectTitle, &r.ObjectType,
			&r.Workdir, &r.Status, &started); err != nil {
			return nil, 0, err
		}
		r.StartedAt = parseTime(started)
		out = append(out, &r)
	}
	return out, total, rows.Err()
}
