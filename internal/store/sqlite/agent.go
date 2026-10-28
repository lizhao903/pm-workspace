package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

const sessionCols = `id, title, object_id, provider_id, model, workdir, created_at, updated_at`

// agentTimeLayout 是这三张表专用的时间格式：带固定 9 位小数的 RFC3339。
//
// 不能用 store 通用的 nowStr()——它只到秒。一轮对话里「用户提问、工具调用、
// 模型回复」这三条消息几乎必然落在同一秒内，秒级精度下它们的 created_at 完全相同，
// 排序就退化成按 id 比较，而 id 的低位是随机数：对话会以乱序显示在界面上。
//
// 小数位必须补满 9 位、不能用 time.RFC3339Nano。后者会把末尾的 0 去掉，
// 于是 "…:00.5Z" 和 "…:00Z" 在 TEXT 字典序下的大小关系是反的（'.' < 'Z'），
// 而这张表的排序全靠字典序。定长才能让字典序等于时间序。
const agentTimeLayout = "2006-01-02T15:04:05.000000000Z07:00"

func nowAgent() string { return time.Now().UTC().Format(agentTimeLayout) }

// --- 会话 ---

// ListAgentSessions 按 filter 取一批会话，最近活跃倒序，并带上消息数供侧栏显示。
//
// filter 两个字段都不给返回零条（契约见 store.ListAgentSessions）。过滤条件放在
// LEFT JOIN 之后的 WHERE 上而不是 HAVING：它筛的是会话自己的列，越早筛掉
// 越少行进聚合，而且 idx_agent_sessions_object 只有在 WHERE 上才用得到。
// 计数走一次 LEFT JOIN 而不是逐行子查询：会话数不多，但 N+1 在这种「一进页面就拉」
// 的接口上是白送的延迟。
//
// tiebreak 用 rowid 不用 id：idgen 前 10 字符是毫秒时间戳、之后是 4 字节随机，
// 同一毫秒创建的两个会话按 id 排序结果是随机的。updated_at 已经是纳秒精度、
// 本身就够分辨，rowid 是第二层——两层失效的原因不相关（一个是时间精度、
// 一个是插入序），留着零成本。
func (s *Store) ListAgentSessions(ctx context.Context, f domain.AgentSessionFilter) ([]*domain.AgentSession, error) {
	var (
		where string
		args  []any
	)
	switch objectID := strings.TrimSpace(f.ObjectID); {
	case objectID != "":
		where = `WHERE s.object_id = ?`
		args = append(args, objectID)
	case f.Unscoped:
		where = `WHERE s.object_id IS NULL`
	default:
		// 两个都不给 = 零条。这里直接返回而不是拼一个恒假条件去查一次库：
		// 结果一样，但少一次往返，而且「没说要哪一批」本来就不该到达 SQL。
		return []*domain.AgentSession{}, nil
	}

	rows, err := s.db.R.QueryContext(ctx, `
		SELECT s.id, s.title, s.object_id, s.provider_id, s.model, s.workdir, s.created_at, s.updated_at,
		       COUNT(m.id)
		  FROM agent_sessions s
		  LEFT JOIN agent_messages m ON m.session_id = s.id
		 `+where+`
		 GROUP BY s.id
		 ORDER BY s.updated_at DESC, s.rowid DESC`, args...)
	if err != nil {
		return nil, fmt.Errorf("list agent sessions: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.AgentSession{}
	for rows.Next() {
		sess, err := scanSession(rows, true)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

func (s *Store) GetAgentSession(ctx context.Context, id string) (*domain.AgentSession, error) {
	row := s.db.R.QueryRowContext(ctx, `
		SELECT s.id, s.title, s.object_id, s.provider_id, s.model, s.workdir, s.created_at, s.updated_at,
		       (SELECT COUNT(*) FROM agent_messages WHERE session_id = s.id)
		  FROM agent_sessions s WHERE s.id = ?`, id)
	sess, err := scanSession(row, true)
	if noRows(err) {
		return nil, notFound("agent session")
	}
	if err != nil {
		return nil, fmt.Errorf("get agent session: %w", err)
	}
	return sess, nil
}

// CreateAgentSession 不校验 workdir 是否存在：目录检查是 internal/agent 的事，
// 而且用户完全可以先建会话、之后再指目录。
//
// ObjectID 是例外，它要先查一遍对象在不在：外键失败回的是一条驱动层的字符串，
// 会被映射成 500，而「挂给一个不存在的对象」显然该是 404。和 CreateTaskRun 同一处理。
// 空指针和空字符串都当全局会话——前端漏传和显式传空在这里没有区别，
// 让它们走同一条路，省得库里出现一列空字符串的 object_id 永远 join 不上。
func (s *Store) CreateAgentSession(ctx context.Context, in *domain.AgentSession) (*domain.AgentSession, error) {
	if in == nil {
		return nil, validation("session", "is required")
	}
	sess := *in
	sess.Title = strings.TrimSpace(sess.Title)
	sess.Workdir = strings.TrimSpace(sess.Workdir)
	if sess.Title == "" {
		sess.Title = "新对话"
	}

	// objectID 保持 any：nil 才会写成 SQL NULL，写空字符串进去索引上是另一个值。
	var objectID any
	if sess.ObjectID != nil {
		if id := strings.TrimSpace(*sess.ObjectID); id == "" {
			sess.ObjectID = nil
		} else {
			var exists int
			if err := s.db.R.QueryRowContext(ctx,
				`SELECT COUNT(*) FROM objects WHERE id = ?`, id).Scan(&exists); err != nil {
				return nil, fmt.Errorf("check object: %w", err)
			}
			if exists == 0 {
				return nil, notFound("object")
			}
			sess.ObjectID = &id
			objectID = id
		}
	}

	sess.ID = idgen.Prefixed("ags")
	now := nowAgent()
	if _, err := s.db.W.ExecContext(ctx,
		`INSERT INTO agent_sessions (`+sessionCols+`) VALUES (?,?,?,?,?,?,?,?)`,
		sess.ID, sess.Title, objectID, sess.ProviderID, sess.Model, sess.Workdir, now, now); err != nil {
		return nil, fmt.Errorf("insert agent session: %w", err)
	}
	sess.CreatedAt, sess.UpdatedAt = parseTime(now), parseTime(now)
	sess.MessageCount = 0
	return &sess, nil
}

// UpdateAgentSession 的四个字段都是 nil 表示不改。空标题会被回退成默认值，
// 而 workdir 允许被清空——用户可以主动取消产物目录。
func (s *Store) UpdateAgentSession(ctx context.Context, id string, title, workdir, providerID, model *string) (*domain.AgentSession, error) {
	var out *domain.AgentSession
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		row := tx.QueryRowContext(ctx, `SELECT `+sessionCols+` FROM agent_sessions WHERE id = ?`, id)
		cur, err := scanSession(row, false)
		if noRows(err) {
			return notFound("agent session")
		}
		if err != nil {
			return fmt.Errorf("get agent session: %w", err)
		}

		if title != nil {
			if t := strings.TrimSpace(*title); t != "" {
				cur.Title = t
			}
		}
		if workdir != nil {
			cur.Workdir = strings.TrimSpace(*workdir)
		}
		if providerID != nil {
			cur.ProviderID = strings.TrimSpace(*providerID)
		}
		if model != nil {
			cur.Model = strings.TrimSpace(*model)
		}

		now := nowAgent()
		if _, err := tx.ExecContext(ctx,
			`UPDATE agent_sessions SET title=?, provider_id=?, model=?, workdir=?, updated_at=? WHERE id=?`,
			cur.Title, cur.ProviderID, cur.Model, cur.Workdir, now, id); err != nil {
			return fmt.Errorf("update agent session: %w", err)
		}
		cur.UpdatedAt = parseTime(now)

		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM agent_messages WHERE session_id = ?`, id).Scan(&cur.MessageCount); err != nil {
			return fmt.Errorf("count agent messages: %w", err)
		}
		out = cur
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteAgentSession 靠 schema 上的 ON DELETE CASCADE 带走消息和产物。
// 注意只删库里的索引，不动 workdir 里的文件——那些是用户的产出，
// 删一条对话记录就顺手删掉他磁盘上的文档，是任何工具都不该有的行为。
func (s *Store) DeleteAgentSession(ctx context.Context, id string) error {
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM agent_sessions WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete agent session: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete agent session: %w", err)
	}
	if n == 0 {
		return notFound("agent session")
	}
	return nil
}

// --- 消息 ---

// ListAgentMessages 按时间正序返回。limit > 0 时取最近 N 条，但返回顺序仍是正序
// ——对话框要的是「最近这一段按顺序读」，倒序回去会让前端每次都得再翻一遍。
func (s *Store) ListAgentMessages(ctx context.Context, sessionID string, limit int) ([]*domain.AgentMessage, error) {
	if err := s.assertSession(ctx, sessionID); err != nil {
		return nil, err
	}
	q := `SELECT id, session_id, role, content, tool_name, tool_args, created_at
	        FROM agent_messages WHERE session_id = ? ORDER BY created_at, rowid`
	args := []any{sessionID}
	if limit > 0 {
		// 先按倒序取 N 条，再在外层翻回正序。
		// rowid 要在子查询里显式选出来（起名 rid）：子查询只投影了列清单，
		// 外层看不到底表的隐式 rowid，不带出来的话外层这个 ORDER BY 就是空转。
		q = `SELECT id, session_id, role, content, tool_name, tool_args, created_at FROM (` +
			`SELECT rowid AS rid, id, session_id, role, content, tool_name, tool_args, created_at
			   FROM agent_messages WHERE session_id = ? ORDER BY created_at DESC, rid DESC LIMIT ?` +
			`) ORDER BY created_at, rid`
		args = append(args, limit)
	}

	rows, err := s.db.R.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list agent messages: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.AgentMessage{}
	for rows.Next() {
		var m domain.AgentMessage
		var created string
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Content,
			&m.ToolName, &m.ToolArgs, &created); err != nil {
			return nil, err
		}
		m.CreatedAt = parseTime(created)
		out = append(out, &m)
	}
	return out, rows.Err()
}

// AppendAgentMessage 顺带把会话的 updated_at 推到当前时间，
// 会话列表按它排序，不推的话刚聊过的会话会沉在底下。
func (s *Store) AppendAgentMessage(ctx context.Context, in *domain.AgentMessage) (*domain.AgentMessage, error) {
	if in == nil {
		return nil, validation("message", "is required")
	}
	m := *in
	if strings.TrimSpace(m.SessionID) == "" {
		return nil, validation("session_id", "is required")
	}
	if err := checkRole(m.Role); err != nil {
		return nil, err
	}

	m.ID = idgen.Prefixed("agm")
	now := nowAgent()
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var exists int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM agent_sessions WHERE id = ?`, m.SessionID).Scan(&exists)
		if noRows(err) {
			return notFound("agent session")
		}
		if err != nil {
			return fmt.Errorf("get agent session: %w", err)
		}

		if _, err := tx.ExecContext(ctx,
			`INSERT INTO agent_messages (id, session_id, role, content, tool_name, tool_args, created_at)
			 VALUES (?,?,?,?,?,?,?)`,
			m.ID, m.SessionID, m.Role, m.Content, m.ToolName, m.ToolArgs, now); err != nil {
			return fmt.Errorf("insert agent message: %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE agent_sessions SET updated_at = ? WHERE id = ?`, now, m.SessionID); err != nil {
			return fmt.Errorf("touch agent session: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	m.CreatedAt = parseTime(now)
	return &m, nil
}

// --- 辅助 ---

func scanSession(sc rowScanner, withCount bool) (*domain.AgentSession, error) {
	var s domain.AgentSession
	var created, updated string
	// object_id 可空，必须过一层 NullString——直接扫进 *string 会在 NULL 上报错。
	var objectID sql.NullString
	dest := []any{&s.ID, &s.Title, &objectID, &s.ProviderID, &s.Model, &s.Workdir, &created, &updated}
	if withCount {
		dest = append(dest, &s.MessageCount)
	}
	if err := sc.Scan(dest...); err != nil {
		return nil, err
	}
	if objectID.Valid {
		id := objectID.String
		s.ObjectID = &id
	}
	s.CreatedAt, s.UpdatedAt = parseTime(created), parseTime(updated)
	return &s, nil
}

// assertSession 确认会话存在。读接口必须先过这一关：写接口对不存在的会话报
// ErrNotFound，读接口若反而安静地回空列表，界面就会把「会话已被删掉」显示成
// 「这个会话是空的」——用户会以为消息丢了。读写两侧的语义必须一致。
func (s *Store) assertSession(ctx context.Context, sessionID string) error {
	var exists int
	err := s.db.R.QueryRowContext(ctx,
		`SELECT 1 FROM agent_sessions WHERE id = ?`, sessionID).Scan(&exists)
	if noRows(err) {
		return notFound("agent session")
	}
	if err != nil {
		return fmt.Errorf("get agent session: %w", err)
	}
	return nil
}

func checkRole(role string) error {
	switch role {
	case domain.RoleUser, domain.RoleAssistant, domain.RoleTool:
		return nil
	case "":
		return validation("role", "is required")
	default:
		return validation("role", "must be one of user, assistant, tool")
	}
}
