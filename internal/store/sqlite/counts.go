package sqlite

import (
	"context"
	"fmt"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// liveCond 是所有徽标共用的口径：不看回收站，也不看已归档。
const liveCond = `o.deleted_at IS NULL AND o.archived_at IS NULL`

// stalledDays 是「停滞」的阈值。Counts.Stalled 和 ObjectFilter.Stalled 必须同一个口径，
// 徽标和列表才不会各说各话，所以阈值只此一份，两边共用。
const stalledDays = 14

// stalledBefore 返回停滞的时间分界：早于它就算停滞。
func stalledBefore(now time.Time) string {
	return timeStr(now.AddDate(0, 0, -stalledDays))
}

// startOfDay 取本地自然日的零点。产品经理看的是日历上的今天，不是 UTC 的今天。
func startOfDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

// overdueBefore 返回「逾期」的分界：早于**今天零点**才算逾期，而不是早于此刻。
// 到期日虽然带时分，但业务粒度是「天」：今天 10:00 到期的任务，下午 3 点仍然是
// 今天的活，过完今天才算逾期。按此刻判的话，同一条数据上午在「今日」、下午会
// 自己跳进「逾期」，用户盯着看板会以为数据乱了。
// Counts.Overdue 与 ObjectFilter.Overdue 共用这一个分界，两处不会漂。
func overdueBefore(now time.Time) string {
	return timeStr(startOfDay(now))
}

// Counts 的口径是有意混合的：ByType/ByStatus/UncategorizedByType/Total 恒为全局，
// 因为侧栏要用它们做跨类型导航；聚焦类计数器（Inbox/Today/Week/Overdue/Stalled）
// 在 typeID 非空时收窄到该类型，因为它们挨着按类型过滤的列表显示，不收窄就会
// 出现「徽标 2 / 列表 0 行」的矛盾。
func (s *Store) Counts(ctx context.Context, typeID string) (*domain.Counts, error) {
	c := &domain.Counts{
		ByType:              map[string]int{},
		ByStatus:            map[string]int{},
		UncategorizedByType: map[string]int{},
	}

	if err := s.groupCount(ctx, "o.type_id", "", c.ByType); err != nil {
		return nil, err
	}
	// 不同类型的状态集有重名（需求和待办都有 doing），key 必须带上类型才有业务含义。
	if err := s.groupCount(ctx, "o.type_id || ':' || o.status", "", c.ByStatus); err != nil {
		return nil, err
	}
	// 侧栏「未分类」行的徽标。走同一个 groupCount 是为了和 by_type 共用 liveCond，
	// 两个数字出自同一套口径，不会出现分类行有数、未分类行对不上的情况。
	if err := s.groupCount(ctx, "o.type_id", "o.category_id IS NULL", c.UncategorizedByType); err != nil {
		return nil, err
	}

	fc, err := s.focusConds(ctx, time.Now(), typeID)
	if err != nil {
		return nil, err
	}

	type q struct {
		dst *int
		fc  focusCond
	}
	queries := []q{
		// Total 恒为全局，不吃 scope。
		{&c.Total, focusCond{liveCond, nil}},
		{&c.Inbox, fc.inbox},
		{&c.Today, fc.today},
		{&c.Week, fc.week},
		{&c.Overdue, fc.overdue},
		{&c.Stalled, fc.stalled},
	}
	for _, item := range queries {
		if err := s.db.R.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM objects o WHERE `+item.fc.cond, item.fc.args...).Scan(item.dst); err != nil {
			return nil, fmt.Errorf("count objects: %w", err)
		}
	}
	return c, nil
}

// focusCond 是一个聚焦类计数器的 WHERE 条件（表别名 o）。
type focusCond struct {
	cond string
	args []any
}

// focusConds 是聚焦类计数器的全部条件。Counts 拿它数条数，Today 拿它取行，
// 两边用的是同一份条件，今日页的条数和侧栏徽标不会分叉。
type focusConds struct {
	inbox, today, week, overdue, stalled focusCond
}

// focusConds 按 now 和 typeID 拼出聚焦类计数器的条件。typeID 为空时是全局。
func (s *Store) focusConds(ctx context.Context, now time.Time, typeID string) (*focusConds, error) {
	notTerminal, targs, err := s.terminalClause(ctx, "o")
	if err != nil {
		return nil, err
	}

	// 今天/本周按本地自然日切，产品经理看的是日历上的今天，不是 UTC 的今天。
	dayStart := startOfDay(now)
	dayEnd := dayStart.AddDate(0, 0, 1)
	weekEnd := dayStart.AddDate(0, 0, 7)

	// 聚焦类计数器统一追加的类型过滤。typeID 为空时是空条件，全局统计。
	scopeCond, scopeArgs := "", []any{}
	if typeID != "" {
		scopeCond, scopeArgs = " AND o.type_id = ?", []any{typeID}
	}

	return &focusConds{
		inbox: focusCond{liveCond + ` AND (o.source = 'inbox' OR o.category_id IS NULL)` + scopeCond,
			scopeArgs},
		today: focusCond{liveCond + ` AND o.due_at >= ? AND o.due_at < ? AND ` + notTerminal + scopeCond,
			concatArgs([]any{timeStr(dayStart), timeStr(dayEnd)}, targs, scopeArgs)},
		week: focusCond{liveCond + ` AND o.due_at >= ? AND o.due_at < ? AND ` + notTerminal + scopeCond,
			concatArgs([]any{timeStr(dayStart), timeStr(weekEnd)}, targs, scopeArgs)},
		overdue: focusCond{liveCond + ` AND o.due_at IS NOT NULL AND o.due_at < ? AND ` + notTerminal + scopeCond,
			concatArgs([]any{overdueBefore(now)}, targs, scopeArgs)},
		stalled: focusCond{liveCond + ` AND o.updated_at < ? AND ` + notTerminal + scopeCond,
			concatArgs([]any{stalledBefore(now)}, targs, scopeArgs)},
	}, nil
}

// groupCount 按给定表达式分组计数，extra 是追加的过滤条件（可为空）。
// expr 与 extra 都只来自本文件的字面量，不接受外部输入。
func (s *Store) groupCount(ctx context.Context, expr, extra string, dst map[string]int) error {
	cond := liveCond
	if extra != "" {
		cond += " AND " + extra
	}
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT `+expr+`, COUNT(*) FROM objects o WHERE `+cond+` GROUP BY `+expr)
	if err != nil {
		return fmt.Errorf("group count by %s: %w", expr, err)
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var key string
		var n int
		if err := rows.Scan(&key, &n); err != nil {
			return err
		}
		dst[key] = n
	}
	return rows.Err()
}

// concatArgs 按顺序拼参数。占位符的顺序必须和这里一致，所以单独抽出来避免
// append 复用底层数组导致的串位。
func concatArgs(groups ...[]any) []any {
	out := []any{}
	for _, g := range groups {
		out = append(out, g...)
	}
	return out
}
