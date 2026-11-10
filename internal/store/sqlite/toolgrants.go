// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- Agent 工具授权和要人确认的调用（AG-02a，0035） ---

// newAgentGrants 是新建 Agent 的默认授权，同原型 newAgent：只开查任务、查联系人。
var newAgentGrants = map[string]string{"read_tasks": store.GrantAuto, "read_contacts": store.GrantAuto}

func (s *Store) AgentGrants(ctx context.Context, agentID string) (map[string]string, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT key, mode FROM agent_tool_grants WHERE agent_id = ?`, agentID)
	if err != nil {
		return nil, fmt.Errorf("list agent grants: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]string{}
	for rows.Next() {
		var k, m string
		if err := rows.Scan(&k, &m); err != nil {
			return nil, err
		}
		out[k] = m
	}
	return out, rows.Err()
}

func (s *Store) SetAgentGrants(ctx context.Context, agentID string, grants map[string]string) error {
	if _, err := s.GetAgent(ctx, agentID); err != nil {
		return err
	}
	return s.withTx(ctx, func(tx *sql.Tx) error {
		return replaceGrants(ctx, tx, agentID, grants)
	})
}

func replaceGrants(ctx context.Context, tx *sql.Tx, agentID string, grants map[string]string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM agent_tool_grants WHERE agent_id = ?`, agentID); err != nil {
		return fmt.Errorf("clear agent grants: %w", err)
	}
	now := agentTime()
	for k, m := range grants {
		if m == store.GrantOff || m == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO agent_tool_grants (agent_id, key, mode, updated_at) VALUES (?,?,?,?)`,
			agentID, k, m, now); err != nil {
			return fmt.Errorf("insert agent grant: %w", err)
		}
	}
	return nil
}

func (s *Store) DetachConnector(ctx context.Context, connectorID string) ([]string, error) {
	detached := []string{}
	prefix := store.ConnGrantPrefix + connectorID + ":"
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		// 不用 LIKE：连接器 id 里的下划线是 LIKE 的通配符
		if _, err := tx.ExecContext(ctx, `DELETE FROM agent_tool_grants WHERE substr(key, 1, ?) = ?`,
			len(prefix), prefix); err != nil {
			return fmt.Errorf("delete connector grants: %w", err)
		}
		rows, err := tx.QueryContext(ctx, `SELECT id, mcps FROM agents
			WHERE EXISTS (SELECT 1 FROM json_each(agents.mcps) WHERE value = ?)
			ORDER BY created_at DESC, rowid DESC`, connectorID)
		if err != nil {
			return fmt.Errorf("find agents with connector: %w", err)
		}
		type hit struct {
			id   string
			mcps []string
		}
		var hits []hit
		for rows.Next() {
			var h hit
			var raw string
			if err := rows.Scan(&h.id, &raw); err != nil {
				_ = rows.Close()
				return err
			}
			_ = json.Unmarshal([]byte(raw), &h.mcps)
			hits = append(hits, h)
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		now := agentTime()
		for _, h := range hits {
			left, _ := json.Marshal(nonNilStrs(slices.DeleteFunc(h.mcps, func(x string) bool { return x == connectorID })))
			if _, err := tx.ExecContext(ctx, `UPDATE agents SET mcps = ?, updated_at = ? WHERE id = ?`, string(left), now, h.id); err != nil {
				return fmt.Errorf("detach connector: %w", err)
			}
			detached = append(detached, h.id)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return detached, nil
}

const toolCallCols = `id, agent_id, session_id, run_id, call_id, tool, grant_key, args, state, result, created_at, decided_at`

func scanToolCall(sc rowScanner) (*store.AgentToolCall, error) {
	var c store.AgentToolCall
	var sess, run, decided sql.NullString
	var created string
	if err := sc.Scan(&c.ID, &c.AgentID, &sess, &run, &c.CallID, &c.Tool, &c.GrantKey, &c.Args, &c.State, &c.Result,
		&created, &decided); err != nil {
		return nil, err
	}
	if sess.Valid {
		c.SessionID = &sess.String
	}
	if run.Valid {
		c.RunID = &run.String
	}
	c.CreatedAt = parseTime(created)
	if decided.Valid {
		t := parseTime(decided.String)
		c.DecidedAt = &t
	}
	return &c, nil
}

func (s *Store) CreateAgentToolCall(ctx context.Context, c *store.AgentToolCall) (*store.AgentToolCall, error) {
	id := idgen.Prefixed("atc")
	args := c.Args
	if args == "" {
		args = "{}"
	}
	if _, err := s.db.W.ExecContext(ctx, `INSERT INTO agent_tool_calls (id, agent_id, session_id, run_id, call_id, tool, grant_key, args, state, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, id, c.AgentID, c.SessionID, c.RunID, c.CallID, c.Tool, c.GrantKey, args,
		store.ToolCallPending, agentTime()); err != nil {
		return nil, fmt.Errorf("insert agent tool call: %w", err)
	}
	return s.GetAgentToolCall(ctx, id)
}

func (s *Store) GetAgentToolCall(ctx context.Context, id string) (*store.AgentToolCall, error) {
	c, err := scanToolCall(s.db.R.QueryRowContext(ctx, `SELECT `+toolCallCols+` FROM agent_tool_calls WHERE id = ?`, id))
	if noRows(err) {
		return nil, notFound("tool call")
	}
	if err != nil {
		return nil, fmt.Errorf("get agent tool call: %w", err)
	}
	return c, nil
}

func (s *Store) DecideAgentToolCall(ctx context.Context, id, state string) (*store.AgentToolCall, error) {
	if state != store.ToolCallConfirmed && state != store.ToolCallRejected {
		return nil, validation("state", "must be confirmed or rejected")
	}
	cur, err := s.GetAgentToolCall(ctx, id)
	if err != nil {
		return nil, err
	}
	// 只从 pending 改一次：两个标签页同时点确认，只有一个能执行
	res, err := s.db.W.ExecContext(ctx, `UPDATE agent_tool_calls SET state = ?, decided_at = ? WHERE id = ? AND state = ?`,
		state, agentTime(), id, store.ToolCallPending)
	if err != nil {
		return nil, fmt.Errorf("decide agent tool call: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if cur.State == store.ToolCallConfirmed {
			return nil, conflict("这次调用已经确认过了")
		}
		return nil, conflict("这次调用已经处理过了")
	}
	return s.GetAgentToolCall(ctx, id)
}

func (s *Store) SetAgentToolCallResult(ctx context.Context, id, result string) error {
	if _, err := s.db.W.ExecContext(ctx, `UPDATE agent_tool_calls SET result = ? WHERE id = ?`, result, id); err != nil {
		return fmt.Errorf("set agent tool call result: %w", err)
	}
	return nil
}

// 等确认聚合接口（P0-O3）一次最多回这么多条：界面要的是「现在有几处等我」，不是全量历史。
const attentionToolCallLimit = 100

func (s *Store) ListPendingToolCalls(ctx context.Context, sessionID string) ([]*store.AgentToolCall, error) {
	q := `SELECT ` + toolCallCols + ` FROM agent_tool_calls WHERE state = ?`
	args := []any{store.ToolCallPending}
	// 用 = ? 而不是 LIKE：session_id 里可能有下划线，LIKE 会当通配符。
	if sessionID != "" {
		q += ` AND session_id = ?`
		args = append(args, sessionID)
	}
	// created_at 只到秒，同一秒里先记的靠 rowid 兜底，顺序才稳定。
	q += ` ORDER BY created_at, rowid LIMIT ?`
	args = append(args, attentionToolCallLimit)
	rows, err := s.db.R.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list pending agent tool calls: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []*store.AgentToolCall{}
	for rows.Next() {
		c, err := scanToolCall(rows)
		if err != nil {
			return nil, fmt.Errorf("scan pending agent tool call: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) CountPendingToolCalls(ctx context.Context, agentID string) (int, error) {
	var n int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_tool_calls WHERE agent_id = ? AND state = ?`,
		agentID, store.ToolCallPending).Scan(&n); err != nil {
		return 0, fmt.Errorf("count pending tool calls: %w", err)
	}
	return n, nil
}
