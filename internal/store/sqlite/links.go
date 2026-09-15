package sqlite

import (
	"context"
	"fmt"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

var allowedRelations = map[string]bool{
	domain.RelRelates:    true,
	domain.RelBlocks:     true,
	domain.RelDuplicates: true,
	domain.RelParent:     true,
	domain.RelReferences: true,
}

// ListLinks 同时返回出边和入边，详情面板要在一处展示「阻塞谁」和「被谁阻塞」。
func (s *Store) ListLinks(ctx context.Context, objectID string) ([]*domain.LinkView, error) {
	if _, err := s.GetObject(ctx, objectID); err != nil {
		return nil, err
	}
	// created_at 是秒级，同刻建的多条关联在它上面是平的，必须用 rowid 兜底定先后。
	// 原来只按 created_at 排，平局时 SQLite 不保证任何顺序，详情面板刷新一次就可能换个次序。
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT id, from_id, to_id, relation, note, created_at
		 FROM links WHERE from_id = ? OR to_id = ? ORDER BY created_at, rowid`, objectID, objectID)
	if err != nil {
		return nil, fmt.Errorf("list links: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.LinkView{}
	peerIDs := []string{}
	for rows.Next() {
		var l domain.Link
		var created string
		if err := rows.Scan(&l.ID, &l.FromID, &l.ToID, &l.Relation, &l.Note, &created); err != nil {
			return nil, err
		}
		l.CreatedAt = parseTime(created)
		v := &domain.LinkView{Link: l, Direction: "out"}
		peer := l.ToID
		if l.FromID != objectID {
			v.Direction, peer = "in", l.FromID
		}
		peerIDs = append(peerIDs, peer)
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}

	peers, err := s.objectsByIDs(ctx, peerIDs)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Peer = peers[peerIDs[i]]
	}
	return out, nil
}

// objectsByIDs 批量取对端摘要，一条 SQL 搞定，不在循环里查库。
func (s *Store) objectsByIDs(ctx context.Context, ids []string) (map[string]*domain.Object, error) {
	out := map[string]*domain.Object{}
	if len(ids) == 0 {
		return out, nil
	}
	uniq := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			uniq = append(uniq, id)
		}
	}
	rows, err := s.db.R.QueryContext(ctx,
		objectSelect+` WHERE o.id IN (`+placeholders(len(uniq))+`)`, anySlice(uniq)...)
	if err != nil {
		return nil, fmt.Errorf("load link peers: %w", err)
	}
	defer func() { _ = rows.Close() }()

	items := []*domain.Object{}
	for rows.Next() {
		o, err := scanObject(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, o)
		out[o.ID] = o
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.fillTags(ctx, items); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) CreateLink(ctx context.Context, fromID, toID, relation, note string) (*domain.Link, error) {
	if fromID == toID {
		return nil, validation("to_id", "must differ from from_id")
	}
	if !allowedRelations[relation] {
		return nil, validation("relation", "is not supported: "+relation)
	}
	if _, err := s.GetObject(ctx, fromID); err != nil {
		return nil, err
	}
	if _, err := s.GetObject(ctx, toID); err != nil {
		return nil, err
	}

	l := &domain.Link{
		ID: idgen.Prefixed("lnk"), FromID: fromID, ToID: toID,
		Relation: relation, Note: note,
	}
	now := nowStr()
	_, err := s.db.W.ExecContext(ctx,
		`INSERT INTO links (id, from_id, to_id, relation, note, created_at) VALUES (?,?,?,?,?,?)`,
		l.ID, l.FromID, l.ToID, l.Relation, l.Note, now)
	if isUnique(err) {
		return nil, conflict("link already exists")
	}
	if err != nil {
		return nil, fmt.Errorf("insert link: %w", err)
	}
	l.CreatedAt = parseTime(now)
	return l, nil
}

func (s *Store) DeleteLink(ctx context.Context, id string) error {
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM links WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete link: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return notFound("link")
	}
	return nil
}
