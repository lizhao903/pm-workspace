// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- Agent 执行记录（AG-01b4，0036） ---

const agentRunCols = `r.id, r.agent_id, r.trigger_kind, r.trigger, r.source_id, r.event_key, r.session_id, r.status, r.summary, r.prompt,
	r.started_at, r.finished_at,
	(SELECT COUNT(*) FROM agent_tool_calls c WHERE c.run_id = r.id AND c.state = 'pending')`

func scanAgentRun(sc rowScanner) (*store.AgentRun, error) {
	var r store.AgentRun
	var sess, finished sql.NullString
	var started string
	if err := sc.Scan(&r.ID, &r.AgentID, &r.TriggerKind, &r.Trigger, &r.SourceID, &r.EventKey, &sess, &r.Status, &r.Summary, &r.Prompt,
		&started, &finished, &r.Pending); err != nil {
		return nil, err
	}
	if sess.Valid {
		r.SessionID = &sess.String
	}
	r.StartedAt = parseTime(started)
	if finished.Valid {
		t := parseTime(finished.String)
		r.FinishedAt = &t
	}
	return &r, nil
}

func (s *Store) CreateAgentRun(ctx context.Context, in *store.AgentRun) (*store.AgentRun, error) {
	id := idgen.Prefixed("ar")
	res, err := s.db.W.ExecContext(ctx, `INSERT OR IGNORE INTO agent_runs
		(id, agent_id, trigger_kind, trigger, source_id, event_key, session_id, status, summary, prompt, started_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		id, in.AgentID, in.TriggerKind, in.Trigger, in.SourceID, in.EventKey, in.SessionID, store.AgentRunRunning, in.Summary, in.Prompt, agentTime())
	if err != nil {
		return nil, fmt.Errorf("insert agent run: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil
	}
	return s.GetAgentRun(ctx, id)
}

func (s *Store) GetAgentRun(ctx context.Context, id string) (*store.AgentRun, error) {
	r, err := scanAgentRun(s.db.R.QueryRowContext(ctx, `SELECT `+agentRunCols+` FROM agent_runs r WHERE r.id = ?`, id))
	if noRows(err) {
		return nil, notFound("agent run")
	}
	if err != nil {
		return nil, fmt.Errorf("get agent run: %w", err)
	}
	return r, nil
}

func (s *Store) ListAgentRuns(ctx context.Context, f store.AgentRunFilter) ([]*store.AgentRun, int, error) {
	var conds []string
	var args []any
	if f.AgentID != "" {
		conds = append(conds, "r.agent_id = ?")
		args = append(args, f.AgentID)
	}
	if len(f.Statuses) > 0 {
		conds = append(conds, "r.status IN ("+strings.TrimSuffix(strings.Repeat("?,", len(f.Statuses)), ",")+")")
		for _, st := range f.Statuses {
			args = append(args, st)
		}
	}
	if f.Since != nil {
		conds = append(conds, "r.started_at >= ?")
		args = append(args, runTime(*f.Since))
	}
	if f.Until != nil {
		conds = append(conds, "r.started_at <= ?")
		args = append(args, runTime(*f.Until))
	}
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}
	var total int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_runs r`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count agent runs: %w", err)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = store.DefaultAgentRunLimit
	}
	q := `SELECT ` + agentRunCols + ` FROM agent_runs r` + where +
		` ORDER BY (r.status = 'waiting') DESC, r.started_at DESC, r.rowid DESC LIMIT ? OFFSET ?`
	rows, err := s.db.R.QueryContext(ctx, q, append(args, limit, max(f.Offset, 0))...)
	if err != nil {
		return nil, 0, fmt.Errorf("list agent runs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []*store.AgentRun{}
	for rows.Next() {
		r, err := scanAgentRun(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

func (s *Store) SetAgentRunSession(ctx context.Context, id, sessionID string) error {
	if _, err := s.db.W.ExecContext(ctx, `UPDATE agent_runs SET session_id = ? WHERE id = ?`, sessionID, id); err != nil {
		return fmt.Errorf("set agent run session: %w", err)
	}
	return nil
}

func (s *Store) FinishAgentRun(ctx context.Context, id, status, summary string) (*store.AgentRun, error) {
	switch status {
	case store.AgentRunRunning, store.AgentRunDone, store.AgentRunWaiting, store.AgentRunRejected, store.AgentRunFailed, store.AgentRunCanceled:
	default:
		return nil, validation("status", "must be running / done / waiting / rejected / failed / canceled")
	}
	var finished any
	if status != store.AgentRunRunning {
		finished = agentTime()
	}
	res, err := s.db.W.ExecContext(ctx, `UPDATE agent_runs SET status = ?, summary = ?, finished_at = ? WHERE id = ?`,
		status, summary, finished, id)
	if err != nil {
		return nil, fmt.Errorf("finish agent run: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, notFound("agent run")
	}
	return s.GetAgentRun(ctx, id)
}

func (s *Store) ListRunToolCalls(ctx context.Context, runID string) ([]*store.AgentToolCall, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT `+toolCallCols+` FROM agent_tool_calls WHERE run_id = ? ORDER BY created_at, rowid`, runID)
	if err != nil {
		return nil, fmt.Errorf("list run tool calls: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []*store.AgentToolCall{}
	for rows.Next() {
		c, err := scanToolCall(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) FailInterruptedAgentRuns(ctx context.Context, summary string) (int, error) {
	res, err := s.db.W.ExecContext(ctx, `UPDATE agent_runs SET status = ?, summary = ?, finished_at = ? WHERE status = ?`,
		store.AgentRunFailed, summary, agentTime(), store.AgentRunRunning)
	if err != nil {
		return 0, fmt.Errorf("fail interrupted agent runs: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// runTime 和 agentTime 同一个格式，字符串比较即时间比较。
func runTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
