// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package schedule

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// 执行记录的状态。
const (
	RunRunning     = "running"
	RunOK          = "ok"
	RunFailed      = "failed"
	RunSkipped     = "skipped"
	RunUnsupported = "unsupported"
	RunMissed      = "missed"
)

// DefaultRunLimit、MaxRunLimit 是执行记录列表的条数。
const (
	DefaultRunLimit = 50
	MaxRunLimit     = 500
)

// Run 是一次执行，对应原型 ScheduleRun {at, ok, text, ref, manual}，多带状态和建出的任务 id。
type Run struct {
	ID         string     `json:"id"`
	ScheduleID string     `json:"schedule_id"`
	At         time.Time  `json:"at"`
	Status     string     `json:"status"`
	OK         bool       `json:"ok"`
	Text       string     `json:"text"`
	Manual     bool       `json:"manual"`
	Missed     int        `json:"missed"`
	ObjectID   *string    `json:"object_id"`
	Ref        *string    `json:"ref"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
}

// runResult 是动作执行完的结果，写回执行记录。
type runResult struct {
	status   string
	text     string
	objectID string
	ref      string
}

func ts(t time.Time) string { return t.UTC().Truncate(time.Millisecond).Format(timeLayout) }

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// insertRun 插一条执行记录；自动执行撞上同一计划时刻已有的记录时不插，回 nil。
func (s *Store) insertRun(ctx context.Context, scheduleID string, planned time.Time, manual bool, res runResult, missed int) (*Run, error) {
	now := s.now()
	run := &Run{ID: idgen.Prefixed("srn"), ScheduleID: scheduleID, At: planned, Status: res.status, Manual: manual,
		Text: res.text, Missed: missed, StartedAt: now}
	var finished any
	if res.status != RunRunning {
		finished = ts(now)
		run.FinishedAt = &now
	}
	q := `INSERT OR IGNORE INTO schedule_runs (id, schedule_id, planned_at, manual, status, text, missed, object_id, ref, started_at, finished_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	r, err := s.db.W.ExecContext(ctx, q, run.ID, scheduleID, ts(planned), boolInt(manual), res.status, res.text, missed,
		nullStr(res.objectID), nullStr(res.ref), ts(now), finished)
	if err != nil {
		return nil, fmt.Errorf("insert schedule run: %w", err)
	}
	if n, _ := r.RowsAffected(); n == 0 {
		return nil, nil
	}
	s.fillRun(run, res)
	return run, nil
}

// finishRun 把 running 的记录写成结果。
func (s *Store) finishRun(ctx context.Context, run *Run, res runResult) error {
	now := s.now()
	if _, err := s.db.W.ExecContext(ctx,
		`UPDATE schedule_runs SET status = ?, text = ?, object_id = ?, ref = ?, finished_at = ? WHERE id = ?`,
		res.status, res.text, nullStr(res.objectID), nullStr(res.ref), ts(now), run.ID); err != nil {
		return fmt.Errorf("finish schedule run: %w", err)
	}
	run.FinishedAt = &now
	s.fillRun(run, res)
	return nil
}

func (s *Store) fillRun(run *Run, res runResult) {
	run.Status, run.Text, run.OK = res.status, res.text, res.status == RunOK
	run.ObjectID, run.Ref = nil, nil
	if res.objectID != "" {
		run.ObjectID = &res.objectID
	}
	if res.ref != "" {
		run.Ref = &res.ref
	}
	run.At = run.At.In(s.loc)
	run.StartedAt = run.StartedAt.In(s.loc)
	if run.FinishedAt != nil {
		f := run.FinishedAt.In(s.loc)
		run.FinishedAt = &f
	}
}

// failInterrupted 把上次退出时还停在 running 的记录记为失败：动作可能做了一半，不重跑，留给人看。
func (s *Store) failInterrupted(ctx context.Context) (int64, error) {
	r, err := s.db.W.ExecContext(ctx,
		`UPDATE schedule_runs SET status = ?, text = ?, finished_at = ? WHERE status = ?`,
		RunFailed, "执行中服务退出了，结果不确定，没有重跑", ts(s.now()), RunRunning)
	if err != nil {
		return 0, fmt.Errorf("fail interrupted schedule runs: %w", err)
	}
	return r.RowsAffected()
}

// ListRuns 一个定时任务的执行记录，计划时刻新的在前；定时任务不存在回 ErrNotFound。
func (s *Store) ListRuns(ctx context.Context, scheduleID string, limit int) ([]Run, error) {
	if _, err := s.Get(ctx, scheduleID); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = DefaultRunLimit
	}
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT id, schedule_id, planned_at, manual, status, text, missed, object_id, ref, started_at, finished_at
		 FROM schedule_runs WHERE schedule_id = ? ORDER BY planned_at DESC, started_at DESC, rowid DESC LIMIT ?`,
		scheduleID, limit)
	if err != nil {
		return nil, fmt.Errorf("list schedule runs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Run{}
	for rows.Next() {
		var (
			run                Run
			manual             int
			planned, started   string
			objectID, ref, fin sql.NullString
		)
		var res runResult
		if err := rows.Scan(&run.ID, &run.ScheduleID, &planned, &manual, &res.status, &res.text, &run.Missed,
			&objectID, &ref, &started, &fin); err != nil {
			return nil, err
		}
		run.Manual = manual != 0
		run.At, _ = time.Parse(timeLayout, planned)
		run.StartedAt, _ = time.Parse(timeLayout, started)
		if fin.Valid {
			f, _ := time.Parse(timeLayout, fin.String)
			run.FinishedAt = &f
		}
		res.objectID, res.ref = objectID.String, ref.String
		s.fillRun(&run, res)
		out = append(out, run)
	}
	return out, rows.Err()
}

// dueRow 是调度要看的一行：定义加游标。
type dueRow struct {
	Schedule
	checked time.Time
}

func (s *Store) listDue(ctx context.Context) ([]dueRow, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT id, name, enabled, rule, action, project_id, created_at, updated_at, COALESCE(checked_at, created_at) FROM schedules ORDER BY created_at, rowid`)
	if err != nil {
		return nil, fmt.Errorf("list schedules to run: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []dueRow
	for rows.Next() {
		var (
			d                    dueRow
			enabled              int
			rule, action, ca, ua string
			checked              string
			project              sql.NullString
		)
		if err := rows.Scan(&d.ID, &d.Name, &enabled, &rule, &action, &project, &ca, &ua, &checked); err != nil {
			return nil, err
		}
		d.Enabled = enabled != 0
		if project.Valid && project.String != "" {
			d.ProjectID = &project.String
		}
		if err := json.Unmarshal([]byte(rule), &d.Rule); err != nil {
			return nil, fmt.Errorf("schedule %s rule: %w", d.ID, err)
		}
		if err := json.Unmarshal([]byte(action), &d.Action); err != nil {
			return nil, fmt.Errorf("schedule %s action: %w", d.ID, err)
		}
		d.Rule = d.Rule.Normalize()
		d.CreatedAt, _ = time.Parse(timeLayout, ca)
		d.checked, _ = time.Parse(timeLayout, checked)
		out = append(out, d)
	}
	return out, rows.Err()
}

// setChecked 推进游标；只往后推，不往回改。
func (s *Store) setChecked(ctx context.Context, id string, t time.Time) error {
	_, err := s.db.W.ExecContext(ctx,
		`UPDATE schedules SET checked_at = ? WHERE id = ? AND COALESCE(checked_at, '') < ?`, ts(t), id, ts(t))
	if err != nil {
		return fmt.Errorf("advance schedule cursor: %w", err)
	}
	return nil
}
