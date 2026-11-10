// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

const revisionLimitDefault = 50
const revisionLimitMax = 500

// addRevision 落一条字段级变更。ts 由调用方传，保证同一次更新里的多条修订时间戳一致。
func addRevision(ctx context.Context, tx *sql.Tx, objectID, field, oldVal, newVal string, a store.Actor, ts string) error {
	_, err := insertRevision(ctx, tx, objectID, field, oldVal, newVal, a, ts)
	return err
}

// insertRevision 和 addRevision 一样，只是把新行的 id 交回来——进展要用它作为自己的 id。
func insertRevision(ctx context.Context, tx *sql.Tx, objectID, field, oldVal, newVal string, a store.Actor, ts string) (string, error) {
	actor := a.Name
	if actor == "" {
		actor = store.DefaultActor.Name
	}
	source := a.Source
	if source == "" {
		source = store.DefaultActor.Source
	}
	id := idgen.Prefixed("rev")
	if _, err := tx.ExecContext(ctx, `INSERT INTO revisions
		(id, object_id, field, old_value, new_value, actor, source, created_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		id, objectID, field, oldVal, newVal, domain.ComposeActor(actor, a.Session), source, ts); err != nil {
		return "", fmt.Errorf("insert revision: %w", err)
	}
	return id, nil
}

// tiebreak 用 rowid 而不是 id：created_at 是秒级，同一次多字段更新写出的多条修订
// created_at 完全相同；而 idgen 的 id 只有毫秒前缀，同刻生成时大小由随机位决定。
// rowid 按插入顺序单调递增，表达的正是「谁先写进去」。修订历史是日报周报和
// 周期时间的唯一数据源，顺序错了指标全错，且每个数字看起来都合理，不会有人发现。
func (s *Store) ListRevisions(ctx context.Context, objectID string, limit int) ([]*domain.Revision, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT id, object_id, field, old_value, new_value, actor, source, created_at
		 FROM revisions WHERE object_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
		objectID, clampRevisionLimit(limit))
	if err != nil {
		return nil, fmt.Errorf("list revisions: %w", err)
	}
	return scanRevisions(rows)
}

func (s *Store) RecentRevisions(ctx context.Context, limit int) ([]*domain.Revision, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT id, object_id, field, old_value, new_value, actor, source, created_at
		 FROM revisions ORDER BY created_at DESC, rowid DESC LIMIT ?`, clampRevisionLimit(limit))
	if err != nil {
		return nil, fmt.Errorf("list recent revisions: %w", err)
	}
	return scanRevisions(rows)
}

func scanRevisions(rows *sql.Rows) ([]*domain.Revision, error) {
	defer func() { _ = rows.Close() }()
	out := []*domain.Revision{}
	for rows.Next() {
		var r domain.Revision
		var created string
		if err := rows.Scan(&r.ID, &r.ObjectID, &r.Field, &r.OldValue, &r.NewValue,
			&r.Actor, &r.Source, &created); err != nil {
			return nil, err
		}
		r.CreatedAt = parseTime(created)
		r.ActorName, r.SessionID = domain.SplitActor(r.Actor)
		out = append(out, &r)
	}
	return out, rows.Err()
}

func clampRevisionLimit(limit int) int {
	if limit <= 0 {
		return revisionLimitDefault
	}
	if limit > revisionLimitMax {
		return revisionLimitMax
	}
	return limit
}
