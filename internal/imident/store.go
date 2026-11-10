// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package imident 读写联系人的 IM 身份（CT-01b，0027）。
// 一个联系人多个渠道身份；同一渠道同一编号只属于一个联系人，收消息时按它认人，不按名字。
package imident

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// timeLayout 定长毫秒 UTC，字符串比较即时间比较。
const timeLayout = "2006-01-02T15:04:05.000Z"

const (
	maxExternalID = 200
	maxText       = 100
)

// channelRe：渠道 key 只收小写字母、数字、下划线、连字符。渠道可扩展，不写死清单。
var channelRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

// Identity 是联系人在某个渠道的一个身份。
type Identity struct {
	ID            string    `json:"id"`
	StakeholderID string    `json:"stakeholder_id"`
	Channel       string    `json:"channel"`
	ExternalID    string    `json:"external_id"`
	DisplayName   string    `json:"display_name"`
	Account       string    `json:"account"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// Patch 只改给了的字段；改 StakeholderID 就是把身份改挂到另一个联系人（认错人时用）。
type Patch struct {
	StakeholderID *string
	Channel       *string
	ExternalID    *string
	DisplayName   *string
	Account       *string
}

// Filter 列表条件，空串表示不限。
type Filter struct {
	StakeholderID string
	Channel       string
}

// Store 读写 contact_identities。
type Store struct {
	db  *db.DB
	now func() time.Time
}

func New(d *db.DB) *Store { return &Store{db: d, now: time.Now} }

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", domain.ErrValidation, fmt.Sprintf(format, a...))
}

// conflict 是给人看的 409：message 原样进界面（SPEC-messages-2.29），不带 "conflict: " 前缀。
type conflict struct{ msg string }

func (e *conflict) Error() string { return e.msg }
func (e *conflict) Unwrap() error { return domain.ErrConflict }

func notFound(id string) error {
	return fmt.Errorf("%w: im identity %s", domain.ErrNotFound, id)
}

const cols = `id, stakeholder_id, channel, external_id, display_name, account, created_at, updated_at`

type scanner interface{ Scan(...any) error }

func scan(r scanner) (*Identity, error) {
	var it Identity
	var created, updated string
	if err := r.Scan(&it.ID, &it.StakeholderID, &it.Channel, &it.ExternalID, &it.DisplayName, &it.Account,
		&created, &updated); err != nil {
		return nil, err
	}
	it.CreatedAt, _ = time.Parse(timeLayout, created)
	it.UpdatedAt, _ = time.Parse(timeLayout, updated)
	return &it, nil
}

// NormalizeChannel 去首尾空白转小写，校验格式。
func NormalizeChannel(ch string) (string, error) {
	ch = strings.ToLower(strings.TrimSpace(ch))
	if ch == "" {
		return "", invalid("channel is required")
	}
	if !channelRe.MatchString(ch) {
		return "", invalid("channel must be a lowercase key like wechat, lark, slack, telegram, qq")
	}
	return ch, nil
}

// NormalizeExternalID 去首尾空白；telegram 的用户名去掉开头的 @（原型提示填「@name」，链接里不带 @）。
// 其余渠道原样保留大小写：Slack Member ID、飞书 ou_ 编号都区分大小写。
func NormalizeExternalID(channel, id string) (string, error) {
	id = strings.TrimSpace(id)
	if channel == "telegram" {
		id = strings.TrimPrefix(id, "@")
	}
	if id == "" {
		return "", invalid("external_id is required")
	}
	if utf8.RuneCountInString(id) > maxExternalID {
		return "", invalid("external_id: at most %d characters", maxExternalID)
	}
	return id, nil
}

func cleanText(field, v string) (string, error) {
	v = strings.TrimSpace(v)
	if utf8.RuneCountInString(v) > maxText {
		return "", invalid("%s: at most %d characters", field, maxText)
	}
	return v, nil
}

// List 按联系人、渠道筛，联系人内按渠道再按编号排。
func (s *Store) List(ctx context.Context, f Filter) ([]Identity, error) {
	q := `SELECT ` + cols + ` FROM contact_identities`
	var where []string
	var args []any
	if f.StakeholderID != "" {
		where = append(where, "stakeholder_id = ?")
		args = append(args, f.StakeholderID)
	}
	if f.Channel != "" {
		where = append(where, "channel = ?")
		args = append(args, strings.ToLower(strings.TrimSpace(f.Channel)))
	}
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	q += ` ORDER BY stakeholder_id, channel, external_id`
	rows, err := s.db.R.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list im identities: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Identity{}
	for rows.Next() {
		it, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *it)
	}
	return out, rows.Err()
}

// Get 取一个；不存在回 ErrNotFound。
func (s *Store) Get(ctx context.Context, id string) (*Identity, error) {
	return s.get(ctx, s.db.R, id)
}

func (s *Store) get(ctx context.Context, q *sql.DB, id string) (*Identity, error) {
	it, err := scan(q.QueryRowContext(ctx, `SELECT `+cols+` FROM contact_identities WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound(id)
	}
	return it, err
}

// Resolve 按渠道和编号找身份，编号按 NormalizeExternalID 规整后再查；找不到回 ErrNotFound。
func (s *Store) Resolve(ctx context.Context, channel, externalID string) (*Identity, error) {
	ch, err := NormalizeChannel(channel)
	if err != nil {
		return nil, err
	}
	ext, err := NormalizeExternalID(ch, externalID)
	if err != nil {
		return nil, err
	}
	it, err := scan(s.db.R.QueryRowContext(ctx,
		`SELECT `+cols+` FROM contact_identities WHERE channel = ? AND external_id = ?`, ch, ext))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: no contact has %s identity %s", domain.ErrNotFound, ch, ext)
	}
	if err != nil {
		return nil, fmt.Errorf("resolve im identity: %w", err)
	}
	return it, nil
}

// taken 是撞唯一索引时的 409：说清这个身份已经挂在谁身上。
func (s *Store) taken(ctx context.Context, ch, ext, want string) error {
	var owner, name string
	err := s.db.W.QueryRowContext(ctx, `SELECT ci.stakeholder_id, COALESCE(s.name, '')
		FROM contact_identities ci LEFT JOIN stakeholders s ON s.id = ci.stakeholder_id
		WHERE ci.channel = ? AND ci.external_id = ?`, ch, ext).Scan(&owner, &name)
	if err != nil || name == "" {
		return &conflict{fmt.Sprintf("%s 编号 %s 已经挂在别的联系人身上，一个编号只能属于一个联系人", ch, ext)}
	}
	if owner == want {
		return &conflict{fmt.Sprintf("%s 已经有 %s 编号 %s 了", name, ch, ext)}
	}
	return &conflict{fmt.Sprintf("%s 编号 %s 已经挂在 %s 身上，一个编号只能属于一个联系人", ch, ext, name)}
}

func (s *Store) checkStakeholder(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return invalid("stakeholder_id is required")
	}
	var one int
	err := s.db.W.QueryRowContext(ctx, `SELECT 1 FROM stakeholders WHERE id = ?`, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return invalid("stakeholder_id: no such stakeholder %s", id)
	}
	return err
}

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// Create 给联系人加一个身份。同一渠道同一编号已存在（不论挂在谁身上）回 ErrConflict。
func (s *Store) Create(ctx context.Context, in Identity) (*Identity, error) {
	ch, err := NormalizeChannel(in.Channel)
	if err != nil {
		return nil, err
	}
	ext, err := NormalizeExternalID(ch, in.ExternalID)
	if err != nil {
		return nil, err
	}
	display, err := cleanText("display_name", in.DisplayName)
	if err != nil {
		return nil, err
	}
	account, err := cleanText("account", in.Account)
	if err != nil {
		return nil, err
	}
	sid := strings.TrimSpace(in.StakeholderID)
	if err := s.checkStakeholder(ctx, sid); err != nil {
		return nil, err
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	it := &Identity{ID: idgen.Prefixed("idn"), StakeholderID: sid, Channel: ch, ExternalID: ext,
		DisplayName: display, Account: account, CreatedAt: now, UpdatedAt: now}
	_, err = s.db.W.ExecContext(ctx, `INSERT INTO contact_identities (`+cols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		it.ID, it.StakeholderID, it.Channel, it.ExternalID, it.DisplayName, it.Account,
		now.Format(timeLayout), now.Format(timeLayout))
	// 唯一性只有数据库说了算，不先查再插
	if isUnique(err) {
		return nil, s.taken(ctx, ch, ext, sid)
	}
	if err != nil {
		return nil, fmt.Errorf("insert im identity: %w", err)
	}
	return it, nil
}

// Update 改给了的字段。改渠道时编号按新渠道重新规整；撞上已有身份回 ErrConflict。
func (s *Store) Update(ctx context.Context, id string, p Patch) (*Identity, error) {
	cur, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	next := *cur
	if p.StakeholderID != nil {
		next.StakeholderID = strings.TrimSpace(*p.StakeholderID)
		if next.StakeholderID != cur.StakeholderID {
			if err := s.checkStakeholder(ctx, next.StakeholderID); err != nil {
				return nil, err
			}
		}
	}
	if p.Channel != nil {
		if next.Channel, err = NormalizeChannel(*p.Channel); err != nil {
			return nil, err
		}
	}
	ext := cur.ExternalID
	if p.ExternalID != nil {
		ext = *p.ExternalID
	}
	if p.Channel != nil || p.ExternalID != nil {
		if next.ExternalID, err = NormalizeExternalID(next.Channel, ext); err != nil {
			return nil, err
		}
	}
	if p.DisplayName != nil {
		if next.DisplayName, err = cleanText("display_name", *p.DisplayName); err != nil {
			return nil, err
		}
	}
	if p.Account != nil {
		if next.Account, err = cleanText("account", *p.Account); err != nil {
			return nil, err
		}
	}
	if next == *cur {
		return cur, nil
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	_, err = s.db.W.ExecContext(ctx, `UPDATE contact_identities
		SET stakeholder_id = ?, channel = ?, external_id = ?, display_name = ?, account = ?, updated_at = ?
		WHERE id = ?`,
		next.StakeholderID, next.Channel, next.ExternalID, next.DisplayName, next.Account, now.Format(timeLayout), id)
	if isUnique(err) {
		return nil, s.taken(ctx, next.Channel, next.ExternalID, next.StakeholderID)
	}
	if err != nil {
		return nil, fmt.Errorf("update im identity: %w", err)
	}
	return s.get(ctx, s.db.W, id)
}

// Delete 删一个身份，不动联系人。
func (s *Store) Delete(ctx context.Context, id string) error {
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM contact_identities WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete im identity: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return notFound(id)
	}
	return nil
}
