// Package vault 是凭证保险箱：连接器配置、API Key、Webhook 密钥等用 AES-256-GCM 加密后入库，
// 对外只给脱敏提示。明文只有 Resolve 能取，它不经 HTTP 暴露，只给后端内部（连接器、模型调用）用。
package vault

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// maxValueBytes 限制单条明文：连接器配置可能是一段 JSON，但不该是大文件。
const maxValueBytes = 64 << 10

const maxNameRunes = 80

// DefaultKind 是不传 kind 时的类型。
const DefaultKind = "api_key"

var kindRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

// Secret 是保险箱条目对外的样子：没有明文，也没有密文。
type Secret struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Kind      string     `json:"kind"`
	Hint      string     `json:"hint"`
	Version   int        `json:"version"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	RotatedAt *time.Time `json:"rotated_at"`
}

type Vault struct {
	d     *db.DB
	own   bool // d 是不是 Open 自己开的，Close 时要不要关
	aead  cipher.AEAD
	keyID string
}

// Open 按库路径打开保险箱：主密钥从库所在的数据目录取（或钥匙串）。
// 表由 db.Migrate 建，调用前库必须已经迁移过（sqlite.Open 会做）。
func Open(ctx context.Context, dbPath string, opt KeyOptions) (*Vault, KeySource, error) {
	key, src, err := LoadMasterKey(filepath.Dir(dbPath), opt)
	if err != nil {
		return nil, "", err
	}
	d, err := db.Open(dbPath)
	if err != nil {
		return nil, "", err
	}
	v, err := New(d, key)
	if err != nil {
		_ = d.Close()
		return nil, "", err
	}
	v.own = true
	if err := v.check(ctx); err != nil {
		_ = d.Close()
		return nil, "", err
	}
	return v, src, nil
}

// New 用现成的连接和主密钥建保险箱，测试直接用它。
func New(d *db.DB, key []byte) (*Vault, error) {
	if len(key) != keyLen {
		return nil, errors.New("vault master key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("init cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("init gcm: %w", err)
	}
	return &Vault{d: d, aead: aead, keyID: KeyID(key)}, nil
}

func (v *Vault) Close() error {
	if v.own {
		return v.d.Close()
	}
	return nil
}

func (v *Vault) check(ctx context.Context) error {
	var n int
	if err := v.d.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vault_secrets'`).Scan(&n); err != nil {
		return fmt.Errorf("check vault table: %w", err)
	}
	if n == 0 {
		return errors.New("vault_secrets table missing: run migrations first")
	}
	return nil
}

// --- 增删改查 ---

func (v *Vault) Create(ctx context.Context, name, kind, value string) (*Secret, error) {
	name = strings.TrimSpace(name)
	kind = strings.TrimSpace(kind)
	if kind == "" {
		kind = DefaultKind
	}
	if err := checkName(name); err != nil {
		return nil, err
	}
	if !kindRe.MatchString(kind) {
		return nil, validation("kind must be lowercase letters, digits or underscores (at most 32)")
	}
	if err := checkValue(value); err != nil {
		return nil, err
	}

	id := idgen.Prefixed("sec")
	nonce, ct, err := v.seal(id, 1, value)
	if err != nil {
		return nil, err
	}
	now := nowStr()
	if _, err := v.d.W.ExecContext(ctx, `INSERT INTO vault_secrets
		(id, name, kind, hint, key_id, nonce, ciphertext, version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		id, name, kind, Hint(value), v.keyID, nonce, ct, now, now); err != nil {
		return nil, fmt.Errorf("insert secret: %w", err)
	}
	return v.Get(ctx, id)
}

const secretCols = `id, name, kind, hint, version, created_at, updated_at, rotated_at`

func (v *Vault) List(ctx context.Context) ([]Secret, error) {
	rows, err := v.d.R.QueryContext(ctx,
		`SELECT `+secretCols+` FROM vault_secrets ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("list secrets: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Secret{}
	for rows.Next() {
		s, err := scanSecret(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

func (v *Vault) Get(ctx context.Context, id string) (*Secret, error) {
	s, err := scanSecret(v.d.R.QueryRowContext(ctx,
		`SELECT `+secretCols+` FROM vault_secrets WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound()
	}
	return s, err
}

// Rotate 换成新值：原行覆盖，version 加一。旧密文不留，Resolve 之后只能拿到新值。
func (v *Vault) Rotate(ctx context.Context, id, value string) (*Secret, error) {
	if err := checkValue(value); err != nil {
		return nil, err
	}
	var ver int
	err := v.d.W.QueryRowContext(ctx, `SELECT version FROM vault_secrets WHERE id=?`, id).Scan(&ver)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound()
	}
	if err != nil {
		return nil, fmt.Errorf("read secret version: %w", err)
	}
	nonce, ct, err := v.seal(id, ver+1, value)
	if err != nil {
		return nil, err
	}
	now := nowStr()
	// 带上旧 version 做条件：两个轮换同时到时，后到的那个不会拿错版本号写进去。
	res, err := v.d.W.ExecContext(ctx, `UPDATE vault_secrets
		SET hint=?, key_id=?, nonce=?, ciphertext=?, version=?, updated_at=?, rotated_at=?
		WHERE id=? AND version=?`,
		Hint(value), v.keyID, nonce, ct, ver+1, now, now, id, ver)
	if err != nil {
		return nil, fmt.Errorf("rotate secret: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, &vaultErr{msg: "secret was changed concurrently, retry", sentinel: domain.ErrConflict}
	}
	return v.Get(ctx, id)
}

func (v *Vault) Delete(ctx context.Context, id string) error {
	res, err := v.d.W.ExecContext(ctx, `DELETE FROM vault_secrets WHERE id=?`, id)
	if err != nil {
		return fmt.Errorf("delete secret: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return notFound()
	}
	return nil
}

// Resolve 取明文。只给后端内部用，返回值不许进响应体、日志或错误文本。
func (v *Vault) Resolve(ctx context.Context, id string) (string, error) {
	var (
		keyID     string
		nonce, ct []byte
		ver       int
	)
	err := v.d.R.QueryRowContext(ctx,
		`SELECT key_id, nonce, ciphertext, version FROM vault_secrets WHERE id=?`, id).
		Scan(&keyID, &nonce, &ct, &ver)
	if errors.Is(err, sql.ErrNoRows) {
		return "", notFound()
	}
	if err != nil {
		return "", fmt.Errorf("read secret: %w", err)
	}
	if keyID != v.keyID {
		return "", &vaultErr{sentinel: ErrKeyMismatch, msg: fmt.Sprintf("secret %s was encrypted with master key %s, current key is %s "+
			"(keychain entry or %s replaced?)", id, keyID, v.keyID, KeyFileName)}
	}
	plain, err := v.aead.Open(nil, nonce, ct, aad(id, ver))
	if err != nil {
		return "", fmt.Errorf("decrypt secret %s: ciphertext rejected", id)
	}
	return string(plain), nil
}

// --- 加解密 ---

func (v *Vault) seal(id string, ver int, value string) (nonce, ct []byte, err error) {
	nonce = make([]byte, v.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, fmt.Errorf("generate nonce: %w", err)
	}
	return nonce, v.aead.Seal(nil, nonce, []byte(value), aad(id, ver)), nil
}

// aad 把密文绑在「这一行、这个版本」上。
func aad(id string, ver int) []byte { return []byte(id + "\x00" + strconv.Itoa(ver)) }

// Hint 是脱敏提示：够长的保留前 3 后 4（sk-…3f2a），中等长度只留后 4，
// 短于 12 位一律 ***——短密钥露 7 位几乎等于整个还原。
func Hint(value string) string {
	r := []rune(value)
	switch {
	case len(r) < 12:
		return "***"
	case len(r) < 20:
		return "…" + string(r[len(r)-4:])
	default:
		return string(r[:3]) + "…" + string(r[len(r)-4:])
	}
}

// --- 小工具 ---

type rowScanner interface{ Scan(dest ...any) error }

func scanSecret(sc rowScanner) (*Secret, error) {
	var (
		s                Secret
		created, updated string
		rotated          sql.NullString
	)
	if err := sc.Scan(&s.ID, &s.Name, &s.Kind, &s.Hint, &s.Version, &created, &updated, &rotated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		return nil, fmt.Errorf("scan secret: %w", err)
	}
	s.CreatedAt, s.UpdatedAt = parseTime(created), parseTime(updated)
	if rotated.Valid {
		t := parseTime(rotated.String)
		s.RotatedAt = &t
	}
	return &s, nil
}

func checkName(name string) error {
	if name == "" {
		return validation("name is required")
	}
	if len([]rune(name)) > maxNameRunes {
		return validation("name must be at most " + strconv.Itoa(maxNameRunes) + " characters")
	}
	return nil
}

func checkValue(value string) error {
	if strings.TrimSpace(value) == "" {
		return validation("value is required")
	}
	if len(value) > maxValueBytes {
		return validation("value must be at most " + strconv.Itoa(maxValueBytes) + " bytes")
	}
	return nil
}

func nowStr() string { return time.Now().UTC().Format(time.RFC3339) }

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

// vaultErr 带哨兵错误，api 层据此映射状态码；message 不含任何明文。
type vaultErr struct {
	msg      string
	sentinel error
}

func (e *vaultErr) Error() string { return e.msg }
func (e *vaultErr) Unwrap() error { return e.sentinel }

// ErrKeyMismatch：条目是用另一把主密钥加密的（vault.key 或钥匙串条目换过、丢过），这把密钥解不开。
// 算冲突（409）：数据还在，但要用户重新填一遍凭证才能用。
var ErrKeyMismatch = fmt.Errorf("%w: secret was encrypted with another master key", domain.ErrConflict)

func validation(msg string) error { return &vaultErr{msg: msg, sentinel: domain.ErrValidation} }

func notFound() error { return &vaultErr{msg: "secret not found", sentinel: domain.ErrNotFound} }
