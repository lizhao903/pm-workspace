package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

const taskRunCols = `id, object_id, workdir, prompt, status, exit_code, output, error, started_at, finished_at`

// runTimeLayout 与 agent 三张表用的是同一套格式：带固定 9 位小数的 RFC3339。
//
// 不能用 store 通用的 nowStr()——它只到秒。用户连点两下「执行」、或者一次执行
// 秒级内跑完接着再发一次，两条记录的 started_at 就完全相同，排序退化成按 id 比较；
// 而 idgen 的 id 只到毫秒有序，同一毫秒内的低位是随机数，历史列表会乱序显示。
// 小数位必须补满 9 位（不能用 time.RFC3339Nano，它会去掉末尾的 0），
// 定长才能让 TEXT 的字典序等于时间序。
const runTimeLayout = agentTimeLayout

func nowRun() string { return time.Now().UTC().Format(runTimeLayout) }

func scanTaskRun(sc rowScanner) (*domain.TaskRun, error) {
	var (
		r        domain.TaskRun
		started  string
		finished sql.NullString
	)
	if err := sc.Scan(&r.ID, &r.ObjectID, &r.Workdir, &r.Prompt, &r.Status,
		&r.ExitCode, &r.Output, &r.Error, &started, &finished); err != nil {
		return nil, err
	}
	r.StartedAt = parseTime(started)
	r.FinishedAt = parseNullTime(finished)
	return &r, nil
}

// ListTaskRuns 返回某个对象的执行历史，最近的在前。
//
// 有意带上完整 output：详情面板点开任意一条就要能看全过程，再为此多跑一次
// GetTaskRun 只是把同一份数据分两次搬。limit <= 0 时用默认条数而不是「全部」——
// 一个跑了半年的对象，全量返回可能是几十 MB。
func (s *Store) ListTaskRuns(ctx context.Context, objectID string, limit int) ([]*domain.TaskRun, error) {
	if strings.TrimSpace(objectID) == "" {
		return nil, validation("object_id", "is required")
	}
	if limit <= 0 {
		limit = store.DefaultRunLimit
	}
	// tiebreak 用 rowid 而不是 id。
	//
	// idgen 的 id 只到毫秒有序，同一毫秒内的低位是 4 字节随机数，拿它排序等于掷骰子。
	// 纳秒级的 started_at 让撞车概率变得极低，但没有消除它——真撞上时 rowid
	// （= 插入顺序）才是唯一还能保证时间序的东西。「跑多少次没复现」只说明概率低。
	//
	// 这条查询是平铺的，rowid 直接可见。如果哪天改成嵌套「先取最近 N 条再拼装」，
	// 记得在子查询里 SELECT rowid AS rid 带出来：外层看不到底表的隐式 rowid，
	// SQLite 不会报错，只是顺序不保证——是一次静默的空转。
	//
	// 0009 的索引尾列写的仍是 id DESC。那个迁移已经应用到线上库并被 checksum 锁死，
	// 改文件会让下次启动直接失败，所以不动它。索引前两列（object_id, started_at）
	// 照常生效，尾列只是用不上而已；排序的正确性在这条 ORDER BY 上，不在索引上。
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT `+taskRunCols+` FROM task_runs WHERE object_id = ?
		  ORDER BY started_at DESC, rowid DESC LIMIT ?`, objectID, limit)
	if err != nil {
		return nil, fmt.Errorf("list task runs: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.TaskRun{}
	for rows.Next() {
		r, err := scanTaskRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) GetTaskRun(ctx context.Context, id string) (*domain.TaskRun, error) {
	row := s.db.R.QueryRowContext(ctx, `SELECT `+taskRunCols+` FROM task_runs WHERE id = ?`, id)
	r, err := scanTaskRun(row)
	if noRows(err) {
		return nil, notFound("task run")
	}
	if err != nil {
		return nil, fmt.Errorf("get task run: %w", err)
	}
	return r, nil
}

// CreateTaskRun 开一条执行记录。workdir 必填：没有工作目录的执行会落到进程的
// 当前目录，也就是工作台自己的源码目录——那是必须在入库前就堵死的事故。
// 目录是否真的存在可写由 internal/runner 实测，库这层只保证字段不是空的。
func (s *Store) CreateTaskRun(ctx context.Context, in *domain.TaskRun) (*domain.TaskRun, error) {
	if in == nil {
		return nil, validation("run", "is required")
	}
	r := *in
	r.ObjectID = strings.TrimSpace(r.ObjectID)
	r.Workdir = strings.TrimSpace(r.Workdir)
	if r.ObjectID == "" {
		return nil, validation("object_id", "is required")
	}
	if r.Workdir == "" {
		return nil, validation("workdir", "is required")
	}
	if r.Status == "" {
		r.Status = domain.RunPending
	}

	// 先确认对象存在：外键失败回的是一条驱动层的字符串，映射成 500，
	// 而「这个对象不存在」显然该是 404。
	var exists int
	if err := s.db.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM objects WHERE id = ?`, r.ObjectID).Scan(&exists); err != nil {
		return nil, fmt.Errorf("check object: %w", err)
	}
	if exists == 0 {
		return nil, notFound("object")
	}

	r.ID = idgen.Prefixed("run")
	now := nowRun()
	if _, err := s.db.W.ExecContext(ctx,
		`INSERT INTO task_runs (`+taskRunCols+`) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		r.ID, r.ObjectID, r.Workdir, r.Prompt, r.Status, r.ExitCode, r.Output, r.Error, now, nil,
	); err != nil {
		return nil, fmt.Errorf("insert task run: %w", err)
	}
	r.StartedAt = parseTime(now)
	r.FinishedAt = nil
	return &r, nil
}

// FinishTaskRun 落最终状态与完整输出。
//
// 已经结束的记录不再改：一次执行只有一个结局，重复收尾只可能来自
// 「取消」和「进程自己退出」撞在一起，那时先到的那个才是真相。
func (s *Store) FinishTaskRun(ctx context.Context, id, status string, exitCode int, output, errMsg string) (*domain.TaskRun, error) {
	switch status {
	case domain.RunDone, domain.RunFailed, domain.RunCanceled:
	default:
		return nil, validation("status", "must be one of done, failed, canceled")
	}

	var out *domain.TaskRun
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		row := tx.QueryRowContext(ctx, `SELECT `+taskRunCols+` FROM task_runs WHERE id = ?`, id)
		cur, err := scanTaskRun(row)
		if noRows(err) {
			return notFound("task run")
		}
		if err != nil {
			return fmt.Errorf("get task run: %w", err)
		}
		if cur.FinishedAt != nil {
			return conflict("这次执行已经结束了")
		}

		now := nowRun()
		if _, err := tx.ExecContext(ctx,
			`UPDATE task_runs SET status = ?, exit_code = ?, output = ?, error = ?, finished_at = ?
			  WHERE id = ?`, status, exitCode, output, errMsg, now, id); err != nil {
			return fmt.Errorf("finish task run: %w", err)
		}

		cur.Status, cur.ExitCode, cur.Output, cur.Error = status, exitCode, output, errMsg
		t := parseTime(now)
		cur.FinishedAt = &t
		out = cur
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
