// Package conversation 读写 IM 会话（CT-02，0028）。
// 群聊和私聊有稳定 id，项目绑定、消息都指向 id；改名只改 name，id 和渠道里的编号不变。
package conversation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/imident"
)

// timeLayout 定长毫秒 UTC，字符串比较即时间比较。
const timeLayout = "2006-01-02T15:04:05.000Z"

const (
	maxName    = 100
	maxMembers = 500
	// 私聊最多两个人：对方，加上自己账号的身份（登记了的话）
	maxDirectMembers = 2
)

// Kinds 是会话类型：group 群聊（含频道），direct 私聊。
var Kinds = []string{"group", "direct"}

// Conversation 是一个群聊或私聊。Members 是成员的 IM 身份 id（contact_identities），按加入先后排。
type Conversation struct {
	ID         string    `json:"id"`
	Channel    string    `json:"channel"`
	ExternalID string    `json:"external_id"`
	Kind       string    `json:"kind"`
	Name       string    `json:"name"`
	Members    []string  `json:"members"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Patch 只改给了的字段。渠道和类型不能改：换了就是另一个会话。
// 编号可以改：Telegram 群升级成超级群会换 chat id，会话 id 要保住。
type Patch struct {
	ExternalID *string
	Name       *string
	Members    *[]string // 整体替换
}

// Filter 列表条件，空串表示不限。
type Filter struct {
	Channel       string
	Kind          string
	IdentityID    string // 这个身份在里面的会话
	StakeholderID string // 这个联系人的任一身份在里面的会话
}

// Store 读写 conversations、conversation_members。
type Store struct {
	db  *db.DB
	now func() time.Time
}

func New(d *db.DB) *Store { return &Store{db: d, now: time.Now} }

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", domain.ErrValidation, fmt.Sprintf(format, a...))
}

func notFound(id string) error {
	return fmt.Errorf("%w: conversation %s", domain.ErrNotFound, id)
}

const cols = `id, channel, external_id, kind, name, created_at, updated_at`

type scanner interface{ Scan(...any) error }

func scan(r scanner) (*Conversation, error) {
	var c Conversation
	var created, updated string
	if err := r.Scan(&c.ID, &c.Channel, &c.ExternalID, &c.Kind, &c.Name, &created, &updated); err != nil {
		return nil, err
	}
	c.CreatedAt, _ = time.Parse(timeLayout, created)
	c.UpdatedAt, _ = time.Parse(timeLayout, updated)
	c.Members = []string{}
	return &c, nil
}

func normalizeKind(k string) (string, error) {
	k = strings.ToLower(strings.TrimSpace(k))
	if k == "" {
		return "", invalid("kind is required (group or direct)")
	}
	if !slices.Contains(Kinds, k) {
		return "", invalid("kind must be group or direct")
	}
	return k, nil
}

func cleanName(kind, v string) (string, error) {
	v = strings.TrimSpace(v)
	if utf8.RuneCountInString(v) > maxName {
		return "", invalid("name: at most %d characters", maxName)
	}
	if v == "" && kind == "group" {
		return "", invalid("name is required for a group conversation")
	}
	return v, nil
}

// cleanMembers 去空白、去重，保持给的顺序。
func cleanMembers(kind string, ids []string) ([]string, error) {
	out := []string{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || slices.Contains(out, id) {
			continue
		}
		out = append(out, id)
	}
	if len(out) > maxMembers {
		return nil, invalid("members: at most %d", maxMembers)
	}
	if kind == "direct" && len(out) > maxDirectMembers {
		return nil, invalid("members: a direct conversation has at most %d members", maxDirectMembers)
	}
	return out, nil
}

type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// checkMembers 成员必须是已有身份，且和会话同一渠道。
func checkMembers(ctx context.Context, q querier, channel string, ids []string) error {
	for _, id := range ids {
		var ch string
		err := q.QueryRowContext(ctx, `SELECT channel FROM contact_identities WHERE id = ?`, id).Scan(&ch)
		if errors.Is(err, sql.ErrNoRows) {
			return invalid("members: no such im identity %s", id)
		}
		if err != nil {
			return err
		}
		if ch != channel {
			return invalid("members: im identity %s is on %s, not %s", id, ch, channel)
		}
	}
	return nil
}

func (s *Store) loadMembers(ctx context.Context, q querier, items []*Conversation) error {
	if len(items) == 0 {
		return nil
	}
	byID := map[string]*Conversation{}
	args := make([]any, 0, len(items))
	for _, c := range items {
		byID[c.ID] = c
		args = append(args, c.ID)
	}
	rows, err := q.QueryContext(ctx, `SELECT conversation_id, identity_id FROM conversation_members
		WHERE conversation_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(args)), ",")+`)
		ORDER BY created_at, rowid`, args...)
	if err != nil {
		return fmt.Errorf("list conversation members: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var cid, iid string
		if err := rows.Scan(&cid, &iid); err != nil {
			return err
		}
		if c := byID[cid]; c != nil {
			c.Members = append(c.Members, iid)
		}
	}
	return rows.Err()
}

// List 按渠道、类型、成员筛，按渠道再按名字排。
func (s *Store) List(ctx context.Context, f Filter) ([]Conversation, error) {
	q := `SELECT ` + cols + ` FROM conversations`
	var where []string
	var args []any
	if f.Channel != "" {
		where = append(where, "channel = ?")
		args = append(args, strings.ToLower(strings.TrimSpace(f.Channel)))
	}
	if f.Kind != "" {
		where = append(where, "kind = ?")
		args = append(args, strings.ToLower(strings.TrimSpace(f.Kind)))
	}
	if f.IdentityID != "" {
		where = append(where, "id IN (SELECT conversation_id FROM conversation_members WHERE identity_id = ?)")
		args = append(args, f.IdentityID)
	}
	if f.StakeholderID != "" {
		where = append(where, `id IN (SELECT m.conversation_id FROM conversation_members m
			JOIN contact_identities ci ON ci.id = m.identity_id WHERE ci.stakeholder_id = ?)`)
		args = append(args, f.StakeholderID)
	}
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	q += ` ORDER BY channel, name, external_id`
	rows, err := s.db.R.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list conversations: %w", err)
	}
	var ptrs []*Conversation
	for rows.Next() {
		c, err := scan(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		ptrs = append(ptrs, c)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.loadMembers(ctx, s.db.R, ptrs); err != nil {
		return nil, err
	}
	out := make([]Conversation, 0, len(ptrs))
	for _, c := range ptrs {
		out = append(out, *c)
	}
	return out, nil
}

// Get 取一个；不存在回 ErrNotFound。
func (s *Store) Get(ctx context.Context, id string) (*Conversation, error) {
	return s.get(ctx, s.db.R, id)
}

func (s *Store) get(ctx context.Context, q querier, id string) (*Conversation, error) {
	c, err := scan(q.QueryRowContext(ctx, `SELECT `+cols+` FROM conversations WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound(id)
	}
	if err != nil {
		return nil, err
	}
	if err := s.loadMembers(ctx, q, []*Conversation{c}); err != nil {
		return nil, err
	}
	return c, nil
}

// Resolve 按渠道和编号找会话，编号规整规则和 IM 身份相同；找不到回 ErrNotFound。
func (s *Store) Resolve(ctx context.Context, channel, externalID string) (*Conversation, error) {
	ch, err := imident.NormalizeChannel(channel)
	if err != nil {
		return nil, err
	}
	ext, err := imident.NormalizeExternalID(ch, externalID)
	if err != nil {
		return nil, err
	}
	var id string
	err = s.db.R.QueryRowContext(ctx, `SELECT id FROM conversations WHERE channel = ? AND external_id = ?`, ch, ext).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: no %s conversation %s", domain.ErrNotFound, ch, ext)
	}
	if err != nil {
		return nil, fmt.Errorf("resolve conversation: %w", err)
	}
	return s.get(ctx, s.db.R, id)
}

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func taken(ch, ext string) error {
	return fmt.Errorf("%w: %s conversation %s already exists", domain.ErrConflict, ch, ext)
}

func insertMembers(ctx context.Context, tx *sql.Tx, cid string, ids []string, now time.Time) error {
	// 同一批 created_at 相同，列成员时靠 rowid 保持给的顺序
	for _, iid := range ids {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO conversation_members (conversation_id, identity_id, created_at)
			VALUES (?, ?, ?)`, cid, iid, now.Format(timeLayout)); err != nil {
			return fmt.Errorf("insert conversation member: %w", err)
		}
	}
	return nil
}

// Create 建一个会话。同一渠道同一编号已存在回 ErrConflict。
func (s *Store) Create(ctx context.Context, in Conversation) (*Conversation, error) {
	ch, err := imident.NormalizeChannel(in.Channel)
	if err != nil {
		return nil, err
	}
	ext, err := imident.NormalizeExternalID(ch, in.ExternalID)
	if err != nil {
		return nil, err
	}
	kind, err := normalizeKind(in.Kind)
	if err != nil {
		return nil, err
	}
	name, err := cleanName(kind, in.Name)
	if err != nil {
		return nil, err
	}
	members, err := cleanMembers(kind, in.Members)
	if err != nil {
		return nil, err
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	id := idgen.Prefixed("cv")

	tx, err := s.db.W.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := checkMembers(ctx, tx, ch, members); err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO conversations (`+cols+`) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, ch, ext, kind, name, now.Format(timeLayout), now.Format(timeLayout))
	// 唯一性只有数据库说了算，不先查再插
	if isUnique(err) {
		return nil, taken(ch, ext)
	}
	if err != nil {
		return nil, fmt.Errorf("insert conversation: %w", err)
	}
	if err := insertMembers(ctx, tx, id, members, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.get(ctx, s.db.W, id)
}

// Update 改名、改编号、整体替换成员。改编号撞上已有会话回 ErrConflict。
func (s *Store) Update(ctx context.Context, id string, p Patch) (*Conversation, error) {
	tx, err := s.db.W.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	cur, err := s.get(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	next := *cur
	if p.ExternalID != nil {
		if next.ExternalID, err = imident.NormalizeExternalID(cur.Channel, *p.ExternalID); err != nil {
			return nil, err
		}
	}
	if p.Name != nil {
		if next.Name, err = cleanName(cur.Kind, *p.Name); err != nil {
			return nil, err
		}
	}
	membersChanged := false
	if p.Members != nil {
		if next.Members, err = cleanMembers(cur.Kind, *p.Members); err != nil {
			return nil, err
		}
		membersChanged = !slices.Equal(next.Members, cur.Members)
		if membersChanged {
			if err := checkMembers(ctx, tx, cur.Channel, next.Members); err != nil {
				return nil, err
			}
		}
	}
	if next.ExternalID == cur.ExternalID && next.Name == cur.Name && !membersChanged {
		return cur, nil
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	_, err = tx.ExecContext(ctx, `UPDATE conversations SET external_id = ?, name = ?, updated_at = ? WHERE id = ?`,
		next.ExternalID, next.Name, now.Format(timeLayout), id)
	if isUnique(err) {
		return nil, taken(cur.Channel, next.ExternalID)
	}
	if err != nil {
		return nil, fmt.Errorf("update conversation: %w", err)
	}
	if membersChanged {
		// 留下的成员保留原来的加入时间，只删走了的、补新来的
		for _, old := range cur.Members {
			if !slices.Contains(next.Members, old) {
				if _, err := tx.ExecContext(ctx, `DELETE FROM conversation_members WHERE conversation_id = ? AND identity_id = ?`, id, old); err != nil {
					return nil, fmt.Errorf("remove conversation member: %w", err)
				}
			}
		}
		if err := insertMembers(ctx, tx, id, next.Members, now); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.get(ctx, s.db.W, id)
}

// AddMember 加一个成员，已在里面不报错（收消息时见到新发言人就加，可重复调）。
// 回加完的会话和这次是否真的加了。
func (s *Store) AddMember(ctx context.Context, id, identityID string) (*Conversation, bool, error) {
	identityID = strings.TrimSpace(identityID)
	if identityID == "" {
		return nil, false, invalid("identity_id is required")
	}
	tx, err := s.db.W.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	cur, err := s.get(ctx, tx, id)
	if err != nil {
		return nil, false, err
	}
	if slices.Contains(cur.Members, identityID) {
		return cur, false, nil
	}
	if _, err := cleanMembers(cur.Kind, append(slices.Clone(cur.Members), identityID)); err != nil {
		return nil, false, err
	}
	if err := checkMembers(ctx, tx, cur.Channel, []string{identityID}); err != nil {
		return nil, false, err
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	if err := insertMembers(ctx, tx, id, []string{identityID}, now); err != nil {
		return nil, false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE conversations SET updated_at = ? WHERE id = ?`, now.Format(timeLayout), id); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	c, err := s.get(ctx, s.db.W, id)
	return c, true, err
}

// RemoveMember 移出一个成员；不在里面回 ErrNotFound。
func (s *Store) RemoveMember(ctx context.Context, id, identityID string) (*Conversation, error) {
	tx, err := s.db.W.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := s.get(ctx, tx, id); err != nil {
		return nil, err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM conversation_members WHERE conversation_id = ? AND identity_id = ?`, id, identityID)
	if err != nil {
		return nil, fmt.Errorf("remove conversation member: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, fmt.Errorf("%w: %s is not a member of conversation %s", domain.ErrNotFound, identityID, id)
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	if _, err := tx.ExecContext(ctx, `UPDATE conversations SET updated_at = ? WHERE id = ?`, now.Format(timeLayout), id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.get(ctx, s.db.W, id)
}

// Delete 删一个会话，成员关系跟着删，不动身份和联系人。
func (s *Store) Delete(ctx context.Context, id string) error {
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM conversations WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete conversation: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return notFound(id)
	}
	return nil
}
