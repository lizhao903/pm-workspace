package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 自定义技能（AG-01b2，0033） ---

const skillCols = `id, name, description, instructions, when_to_use, uses, created_at, updated_at`

// 长度上限按字符数
const (
	skillNameMax         = 100
	skillDescMax         = 500
	skillWhenMax         = 500
	skillInstructionsMax = 20000
	skillUsesMax         = 50
	skillUseMax          = 100
)

func scanSkill(sc rowScanner) (*store.Skill, error) {
	var k store.Skill
	var uses, created, updated string
	if err := sc.Scan(&k.ID, &k.Name, &k.Desc, &k.Instructions, &k.When, &uses, &created, &updated); err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(uses), &k.Uses)
	k.Uses = nonNilStrs(k.Uses)
	k.Source = store.SkillCustom
	k.CreatedAt, k.UpdatedAt = parseTime(created), parseTime(updated)
	return &k, nil
}

func (s *Store) ListSkills(ctx context.Context) ([]*store.Skill, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT `+skillCols+` FROM skills ORDER BY created_at DESC, rowid DESC`)
	if err != nil {
		return nil, fmt.Errorf("list skills: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []*store.Skill{}
	for rows.Next() {
		k, err := scanSkill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *Store) GetSkill(ctx context.Context, id string) (*store.Skill, error) {
	k, err := scanSkill(s.db.R.QueryRowContext(ctx, `SELECT `+skillCols+` FROM skills WHERE id = ?`, id))
	if noRows(err) {
		return nil, notFound("skill")
	}
	if err != nil {
		return nil, fmt.Errorf("get skill: %w", err)
	}
	return k, nil
}

// CreateSkill 名称和怎么做必填（SPEC-settings-16.10）。
func (s *Store) CreateSkill(ctx context.Context, in store.SkillInput) (*store.Skill, error) {
	k := &store.Skill{Uses: []string{}}
	if err := applySkillInput(k, in); err != nil {
		return nil, err
	}
	k.ID = idgen.Prefixed("sk")
	now := agentTime()
	uses, _ := json.Marshal(k.Uses)
	if _, err := s.db.W.ExecContext(ctx, `INSERT INTO skills (`+skillCols+`) VALUES (?,?,?,?,?,?,?,?)`,
		k.ID, k.Name, k.Desc, k.Instructions, k.When, string(uses), now, now); err != nil {
		return nil, fmt.Errorf("insert skill: %w", err)
	}
	return s.GetSkill(ctx, k.ID)
}

// UpdateSkill 只改给了的字段；改了的照建时同样校验。
func (s *Store) UpdateSkill(ctx context.Context, id string, in store.SkillInput) (*store.Skill, error) {
	k, err := s.GetSkill(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := applySkillInput(k, in); err != nil {
		return nil, err
	}
	uses, _ := json.Marshal(k.Uses)
	res, err := s.db.W.ExecContext(ctx, `UPDATE skills SET name=?, description=?, instructions=?, when_to_use=?, uses=?, updated_at=? WHERE id=?`,
		k.Name, k.Desc, k.Instructions, k.When, string(uses), agentTime(), id)
	if err != nil {
		return nil, fmt.Errorf("update skill: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, notFound("skill")
	}
	return s.GetSkill(ctx, id)
}

// DeleteSkill 删技能，同一个事务里从挂着它的 Agent 的 skills 里摘掉（SPEC-settings-16.11）。
func (s *Store) DeleteSkill(ctx context.Context, id string) (*store.Skill, []string, error) {
	k, err := s.GetSkill(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	detached := []string{}
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM skills WHERE id = ?`, id)
		if err != nil {
			return fmt.Errorf("delete skill: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return notFound("skill")
		}
		rows, err := tx.QueryContext(ctx, `SELECT id, skills FROM agents
			WHERE EXISTS (SELECT 1 FROM json_each(agents.skills) WHERE value = ?)
			ORDER BY created_at DESC, rowid DESC`, id)
		if err != nil {
			return fmt.Errorf("find agents with skill: %w", err)
		}
		type hit struct {
			id     string
			skills []string
		}
		var hits []hit
		for rows.Next() {
			var h hit
			var raw string
			if err := rows.Scan(&h.id, &raw); err != nil {
				_ = rows.Close()
				return err
			}
			_ = json.Unmarshal([]byte(raw), &h.skills)
			hits = append(hits, h)
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		now := agentTime()
		for _, h := range hits {
			left, _ := json.Marshal(nonNilStrs(slices.DeleteFunc(h.skills, func(x string) bool { return x == id })))
			if _, err := tx.ExecContext(ctx, `UPDATE agents SET skills = ?, updated_at = ? WHERE id = ?`, string(left), now, h.id); err != nil {
				return fmt.Errorf("detach skill: %w", err)
			}
			detached = append(detached, h.id)
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return k, detached, nil
}

// applySkillInput 把给了的字段校验后写到 k 上。
func applySkillInput(k *store.Skill, in store.SkillInput) error {
	if in.Name != nil {
		k.Name = strings.TrimSpace(*in.Name)
	}
	if k.Name == "" {
		return agentInvalid("名称还没填")
	}
	if utf8.RuneCountInString(k.Name) > skillNameMax {
		return agentInvalid("名称最多 %d 字", skillNameMax)
	}
	if in.Desc != nil {
		k.Desc = strings.TrimSpace(*in.Desc)
		if utf8.RuneCountInString(k.Desc) > skillDescMax {
			return agentInvalid("一句话说明最多 %d 字", skillDescMax)
		}
	}
	if in.When != nil {
		k.When = strings.TrimSpace(*in.When)
		if utf8.RuneCountInString(k.When) > skillWhenMax {
			return agentInvalid("什么时候用最多 %d 字", skillWhenMax)
		}
	}
	if in.Instructions != nil {
		k.Instructions = strings.TrimSpace(*in.Instructions)
	}
	if k.Instructions == "" {
		return agentInvalid("怎么做还没填")
	}
	if utf8.RuneCountInString(k.Instructions) > skillInstructionsMax {
		return agentInvalid("怎么做最多 %d 字", skillInstructionsMax)
	}
	if in.Uses != nil {
		uses := []string{}
		for _, u := range *in.Uses {
			u = strings.TrimSpace(u)
			if u == "" || slices.Contains(uses, u) {
				continue
			}
			if utf8.RuneCountInString(u) > skillUseMax {
				return agentInvalid("工具名最多 %d 字", skillUseMax)
			}
			uses = append(uses, u)
		}
		if len(uses) > skillUsesMax {
			return agentInvalid("用到的工具最多 %d 个", skillUsesMax)
		}
		k.Uses = uses
	}
	return nil
}
