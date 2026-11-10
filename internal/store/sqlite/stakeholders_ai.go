// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// 名册里的 AI 成员（TSK-0500，0051）。负责人仍只指向名册，所以给每个工作台 Agent、每种 CLI
// 在名册里各维护一条；这里只管把名册和「应该有哪些」对齐，「应该有哪些」由调用方
// （internal/aimember）从 Agent 表和执行器列表算出来。

// AIMemberGroup 是 AI 成员建出来时的分组，联系人页按它把 AI 和人分开。
const AIMemberGroup = "AI 成员"

// legacyAIRole 是 pmw-mcp 第一次领任务时自建「Claude Code」用的角色。同名、角色是它、
// 还没标成 AI 成员的那条直接收编，不另建一条「Claude Code（CLI）」——已有任务的负责人就是它。
const legacyAIRole = "AI Agent"

func aiRole(kind string) string {
	if kind == domain.AIKindAgent {
		return "工作台 Agent"
	}
	return "CLI 执行器"
}

// aiSuffix 是和人撞名时加在名字后的区分。
func aiSuffix(kind string) string {
	if kind == domain.AIKindAgent {
		return "（Agent）"
	}
	return "（CLI）"
}

func (s *Store) GetAIMember(ctx context.Context, kind, ref string) (*domain.Stakeholder, error) {
	row := s.db.R.QueryRowContext(ctx, stakeholderSelect+` WHERE s.ai_kind = ? AND s.ai_ref = ?`, kind, ref)
	sh, err := scanStakeholder(row)
	if noRows(err) {
		return nil, notFound("ai member")
	}
	if err != nil {
		return nil, fmt.Errorf("get ai member: %w", err)
	}
	return sh, nil
}

func (s *Store) SyncAIMembers(ctx context.Context, want []domain.AIMember) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		now := nowStr()
		keep := map[string]bool{}
		for _, m := range want {
			m.Name = strings.TrimSpace(m.Name)
			if m.Kind == "" || m.Ref == "" || m.Name == "" {
				continue
			}
			keep[m.Kind+"\x00"+m.Ref] = true
			if err := syncAIMember(ctx, tx, m, now); err != nil {
				return err
			}
		}
		// 删掉的 Agent：名册里那条归档，负责过的任务仍显示名字；不删，删了 owner_id 会被置空。
		rows, err := tx.QueryContext(ctx,
			`SELECT id, ai_ref FROM stakeholders WHERE ai_kind = ? AND archived_at IS NULL`, domain.AIKindAgent)
		if err != nil {
			return fmt.Errorf("list agent members: %w", err)
		}
		var gone []string
		for rows.Next() {
			var id, ref string
			if err := rows.Scan(&id, &ref); err != nil {
				_ = rows.Close()
				return err
			}
			if !keep[domain.AIKindAgent+"\x00"+ref] {
				gone = append(gone, id)
			}
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range gone {
			if _, err := tx.ExecContext(ctx,
				`UPDATE stakeholders SET archived_at = ?, updated_at = ? WHERE id = ?`, now, now, id); err != nil {
				return fmt.Errorf("archive agent member: %w", err)
			}
		}
		return nil
	})
}

func syncAIMember(ctx context.Context, tx *sql.Tx, m domain.AIMember, now string) error {
	var (
		id, name string
		archived sql.NullString
	)
	err := tx.QueryRowContext(ctx,
		`SELECT id, name, archived_at FROM stakeholders WHERE ai_kind = ? AND ai_ref = ?`, m.Kind, m.Ref).
		Scan(&id, &name, &archived)
	if noRows(err) {
		// 收编 pmw-mcp 自建的那条（见 legacyAIRole）
		err = tx.QueryRowContext(ctx,
			`SELECT id, name, archived_at FROM stakeholders WHERE name = ? AND ai_kind = '' AND role = ?`,
			m.Name, legacyAIRole).Scan(&id, &name, &archived)
		if err == nil {
			if _, err := tx.ExecContext(ctx,
				`UPDATE stakeholders SET ai_kind = ?, ai_ref = ?, updated_at = ?,
				   contact_group = CASE WHEN contact_group = '' THEN ? ELSE contact_group END
				 WHERE id = ?`, m.Kind, m.Ref, now, AIMemberGroup, id); err != nil {
				return fmt.Errorf("adopt ai member: %w", err)
			}
		} else if !noRows(err) {
			return fmt.Errorf("find legacy ai member: %w", err)
		} else {
			return insertAIMember(ctx, tx, m, now)
		}
	} else if err != nil {
		return fmt.Errorf("find ai member: %w", err)
	}

	sets, args := []string{}, []any{}
	if archived.Valid {
		sets = append(sets, "archived_at = NULL")
	}
	if name != m.Name && name != m.Name+aiSuffix(m.Kind) {
		free, err := aiFreeName(ctx, tx, m, id)
		if err != nil {
			return err
		}
		if free != name {
			sets, args = append(sets, "name = ?"), append(args, free)
		}
	}
	if len(sets) == 0 {
		return nil
	}
	sets, args = append(sets, "updated_at = ?"), append(args, now, id)
	if _, err := tx.ExecContext(ctx,
		`UPDATE stakeholders SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
		return fmt.Errorf("update ai member: %w", err)
	}
	return nil
}

func insertAIMember(ctx context.Context, tx *sql.Tx, m domain.AIMember, now string) error {
	name, err := aiFreeName(ctx, tx, m, "")
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO stakeholders
		(id, name, role, note, color, created_at, updated_at, contact_group, ai_kind, ai_ref)
		VALUES (?,?,?,?,?,?,?,?,?,?)`,
		idgen.Prefixed("stk"), name, aiRole(m.Kind), m.Note, m.Color, now, now, AIMemberGroup, m.Kind, m.Ref); err != nil {
		return fmt.Errorf("insert ai member: %w", err)
	}
	return nil
}

// aiFreeName 取一个不和别人撞的名字：先用原名，被占了加「（Agent）/（CLI）」，还占着再加 Agent id 尾巴。
// 名字全局唯一（0010），AI 成员不能因为和某个人同名就建不出来、或者抢走人的名字。
func aiFreeName(ctx context.Context, tx *sql.Tx, m domain.AIMember, selfID string) (string, error) {
	tail := m.Ref
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	for _, cand := range []string{m.Name, m.Name + aiSuffix(m.Kind), m.Name + "（" + tail + "）"} {
		var other string
		err := tx.QueryRowContext(ctx, `SELECT id FROM stakeholders WHERE name = ?`, cand).Scan(&other)
		if noRows(err) || (err == nil && other == selfID) {
			return cand, nil
		}
		if err != nil {
			return "", fmt.Errorf("check ai member name: %w", err)
		}
	}
	return "", conflict("stakeholder " + m.Name + " already exists for both the name and its qualifiers")
}
