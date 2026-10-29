package connector

import (
	"context"
	"fmt"
)

// --- 插件记一次同步结果（IM-01b，plugin.Core.Connectors().RecordSync） ---

// RecordSync 记一次同步：成功记 last_sync_at，原来异常或连接中的回到 connected 并清掉原因；
// 失败置为 error、原因是 syncErr（凭证原文换成 ***，截到 300 字），last_sync_at 不动。暂停、断开的状态不改。
// source 非空时只认这个来源登记的定义，同 WithConfig。不记审计，同连通测试。
func (s *Store) RecordSync(ctx context.Context, id, source string, syncErr error) (*Connector, error) {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if d, ok := s.defs.Get(cur.Tool); source != "" && (!ok || d.Source != source) {
		return nil, fmt.Errorf("%w: %s", ErrNotOwned, id)
	}
	q := `UPDATE connectors SET last_sync_at = ?, error = CASE WHEN status = 'error' THEN '' ELSE error END,
		status = CASE WHEN status IN ('error', 'connecting') THEN 'connected' ELSE status END WHERE id = ?`
	args := []any{s.stamp(), id}
	if syncErr != nil {
		secrets, err := s.resolveSecrets(ctx, cur)
		if err != nil {
			return nil, err
		}
		msg := scrub(syncErr.Error(), secrets)
		if msg == "" {
			msg = "同步失败"
		}
		q = `UPDATE connectors SET error = ?, updated_at = ?,
			status = CASE WHEN status IN ('paused', 'disconnected') THEN status ELSE 'error' END WHERE id = ?`
		args = []any{msg, s.stamp(), id}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.W.ExecContext(ctx, q, args...); err != nil {
		return nil, fmt.Errorf("record connector sync: %w", err)
	}
	return s.get(ctx, s.db.W, id)
}
