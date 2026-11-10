// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 统一运行中心（P0-O1）：task 执行一侧 ---

// runCenterSelectCols 给 taskRunCols 的每一列补上 r. 前缀。
//
// 不能直接 `SELECT taskRunCols FROM task_runs r LEFT JOIN objects o ...`：task_runs 和
// objects 都有 id 列，不限定表名的 id 会被 SQLite 判成 ambiguous column——而且是运行时
// 才报，编译和测试替身都看不见。列清单仍然只有 taskRunCols 一份，这里只是在它前面
// 补前缀，不另抄一遍列名。
var runCenterSelectCols = func() string {
	cols := strings.Split(taskRunCols, ", ")
	for i := range cols {
		cols[i] = "r." + cols[i]
	}
	return strings.Join(cols, ", ")
}()

// scanRunCenterTaskRun 在 scanTaskRun 的列之外多读 join 出来的对象 ref / title。
// LEFT JOIN 没命中对象时这两列是 NULL，要按可空读，否则 Scan 会报类型错误。
func scanRunCenterTaskRun(sc rowScanner) (*store.RunCenterTaskRun, error) {
	var (
		out      store.RunCenterTaskRun
		r        domain.TaskRun
		started  string
		finished sql.NullString
		ref      sql.NullString
		title    sql.NullString
	)
	if err := sc.Scan(&r.ID, &r.ObjectID, &r.Workdir, &r.Prompt, &r.Status,
		&r.ExitCode, &r.Output, &r.Error, &started, &finished, &r.Mode, &r.Harness,
		&r.HarnessSession, &ref, &title); err != nil {
		return nil, err
	}
	r.StartedAt = parseTime(started)
	r.FinishedAt = parseNullTime(finished)
	out.Run = &r
	if ref.Valid {
		out.ObjectRef = ref.String
	}
	if title.Valid {
		out.ObjectTitle = title.String
	}
	return &out, nil
}

// ListAllTaskRuns 见 store.Store。
//
// 排序与 ListTaskRuns 同一口径：started_at 倒序，时间戳撞车时用 rowid 兜底（idgen 的 id
// 只到毫秒有序，同一毫秒内的低位是随机数，按 id 排会乱）。total 用同一条 WHERE 单独
// COUNT，不能拿 len(本轮结果) 冒充——那样第二页开始就会出现「共 N 条」随页码变小。
func (s *Store) ListAllTaskRuns(ctx context.Context, statuses []string, limit, offset int) ([]*store.RunCenterTaskRun, int, error) {
	var conds []string
	var args []any
	if len(statuses) > 0 {
		conds = append(conds, "r.status IN ("+strings.TrimSuffix(strings.Repeat("?,", len(statuses)), ",")+")")
		for _, st := range statuses {
			args = append(args, st)
		}
	}
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}

	var total int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM task_runs r`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count task runs: %w", err)
	}

	if limit <= 0 {
		limit = store.DefaultRunLimit
	}
	if offset < 0 {
		offset = 0
	}
	q := `SELECT ` + runCenterSelectCols + `, o.ref, o.title FROM task_runs r
		  LEFT JOIN objects o ON o.id = r.object_id` + where +
		` ORDER BY r.started_at DESC, r.rowid DESC LIMIT ? OFFSET ?`
	rows, err := s.db.R.QueryContext(ctx, q, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, fmt.Errorf("list task runs: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*store.RunCenterTaskRun{}
	for rows.Next() {
		item, err := scanRunCenterTaskRun(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, item)
	}
	return out, total, rows.Err()
}
