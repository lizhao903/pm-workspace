// Package webhook 存 Webhook 配置（TASK-02a，0022）：名称、字段映射、过滤条件、去重路径、默认值。
// 接收密钥存在保险箱里，表里只有条目 id；对外只给脱敏提示，服务端生成的明文只在新建和轮换那一次给出。
// 收件、映射执行、去重和投递记录（TASK-02b，0024）在 delivery.go、mapping.go。
package webhook

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// timeLayout 定长毫秒 UTC，字符串比较即时间比较。
const timeLayout = "2006-01-02T15:04:05.000Z"

const (
	maxName   = 100
	maxPath   = 200
	maxFilter = 300
	maxSample = 64 << 10
	maxDefVal = 100
	// 自带的密钥至少 16 位：签名用的密钥太短等于没有
	minSecret = 16
	maxSecret = 512
	// SecretKind 是保险箱条目的 kind
	SecretKind = "webhook"
	// DefaultPriority 是不给默认优先级时用的，和原型新建时一致
	DefaultPriority = "P2"
)

// Mapping 是任务字段到推送 JSON 路径的映射，形如 event.title、items[0].name；留空不取。
type Mapping struct {
	Title    string `json:"title"`
	Desc     string `json:"desc"`
	Priority string `json:"priority"`
	Assignee string `json:"assignee"`
	Due      string `json:"due"`
}

// Defaults 是映射取不到时用的默认值。
type Defaults struct {
	Priority string `json:"priority"`
	Assignee string `json:"assignee"`
}

// Webhook 是对外的样子：没有密钥明文，只有提示。
type Webhook struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Token           string     `json:"token"`
	Enabled         bool       `json:"enabled"`
	Mapping         Mapping    `json:"mapping"`
	Filter          string     `json:"filter"`
	Dedupe          string     `json:"dedupe"`
	Defaults        Defaults   `json:"defaults"`
	Sample          string     `json:"sample"`
	SecretHint      string     `json:"secret_hint"`
	SecretVersion   int        `json:"secret_version"`
	SecretRotatedAt *time.Time `json:"secret_rotated_at"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	// SecretID 是保险箱条目 id，只给后端内部（TASK-02b 验签）用，不出接口
	SecretID string `json:"-"`
}

// Input 是新建的字段。Secret 留空由服务端生成；Enabled 不给时为 true。
type Input struct {
	Name     string    `json:"name"`
	Enabled  *bool     `json:"enabled"`
	Mapping  Mapping   `json:"mapping"`
	Filter   string    `json:"filter"`
	Dedupe   string    `json:"dedupe"`
	Defaults *Defaults `json:"defaults"`
	Sample   string    `json:"sample"`
	Secret   string    `json:"secret"`
}

// Patch 是修改的字段，nil 为不改；mapping、defaults 整体替换。密钥走 RotateSecret。
type Patch struct {
	Name     *string   `json:"name"`
	Enabled  *bool     `json:"enabled"`
	Mapping  *Mapping  `json:"mapping"`
	Filter   *string   `json:"filter"`
	Dedupe   *string   `json:"dedupe"`
	Defaults *Defaults `json:"defaults"`
	Sample   *string   `json:"sample"`
}

// Usage 是删除前要告诉人的影响。
type Usage struct {
	// Tasks 是这个 Webhook 建出来、还没删的任务；OpenTasks 是其中没到终态的
	Tasks     int `json:"tasks"`
	OpenTasks int `json:"open_tasks"`
}

// Secrets 是用到的保险箱操作，*vault.Vault 天然满足它。
type Secrets interface {
	Create(ctx context.Context, name, kind, value string) (*vault.Secret, error)
	Rotate(ctx context.Context, id, value string) (*vault.Secret, error)
	Delete(ctx context.Context, id string) error
}

// Store 读写 webhooks 表。
type Store struct {
	db  *db.DB
	sec Secrets
	log *slog.Logger
	now func() time.Time
	// mu 让收件一个一个来：去重是先查后建
	mu sync.Mutex
}

// New 建一个 Webhook 表的读写；sec 为 nil 时新建和轮换密钥报错。
func New(d *db.DB, sec Secrets) *Store {
	return &Store{db: d, sec: sec, log: slog.Default(), now: time.Now}
}

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", domain.ErrValidation, fmt.Sprintf(format, a...))
}

func notFound(id string) error { return fmt.Errorf("%w: webhook %s", domain.ErrNotFound, id) }

// --- 校验 ---

// filterRe 和原型 passFilter 同一写法：路径 == 值 / 路径 != 值
var filterRe = regexp.MustCompile(`^\s*([\w.\[\]]+)\s*(==|!=)\s*(.+?)\s*$`)

func checkName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", invalid("name is required")
	}
	if utf8.RuneCountInString(name) > maxName {
		return "", invalid("name is longer than %d characters", maxName)
	}
	return name, nil
}

func checkPath(field, p string) (string, error) {
	p = strings.TrimSpace(p)
	if utf8.RuneCountInString(p) > maxPath {
		return "", invalid("%s is longer than %d characters", field, maxPath)
	}
	if strings.ContainsAny(p, " \t\r\n") {
		return "", invalid("%s must be a JSON path without spaces, like event.title or items[0].name", field)
	}
	return p, nil
}

func checkMapping(m Mapping) (Mapping, error) {
	var err error
	for _, f := range []struct {
		name string
		v    *string
	}{{"mapping.title", &m.Title}, {"mapping.desc", &m.Desc}, {"mapping.priority", &m.Priority},
		{"mapping.assignee", &m.Assignee}, {"mapping.due", &m.Due}} {
		if *f.v, err = checkPath(f.name, *f.v); err != nil {
			return m, err
		}
	}
	if m.Title == "" {
		return m, invalid("mapping.title is required")
	}
	return m, nil
}

func checkFilter(f string) (string, error) {
	f = strings.TrimSpace(f)
	if f == "" {
		return "", nil
	}
	if utf8.RuneCountInString(f) > maxFilter {
		return "", invalid("filter is longer than %d characters", maxFilter)
	}
	if !filterRe.MatchString(f) {
		return "", invalid("filter must look like 'path == value' or 'path != value', got %q", f)
	}
	return f, nil
}

func checkDefaults(d *Defaults) (Defaults, error) {
	out := Defaults{Priority: DefaultPriority}
	if d == nil {
		return out, nil
	}
	out.Priority = strings.TrimSpace(d.Priority)
	if out.Priority == "" {
		out.Priority = DefaultPriority
	}
	out.Assignee = strings.TrimSpace(d.Assignee)
	if utf8.RuneCountInString(out.Priority) > maxDefVal || utf8.RuneCountInString(out.Assignee) > maxDefVal {
		return out, invalid("defaults values are longer than %d characters", maxDefVal)
	}
	return out, nil
}

func checkSample(s string) error {
	if len(s) > maxSample {
		return invalid("sample is larger than %d KB", maxSample>>10)
	}
	return nil
}

func checkSecret(s string) error {
	if s != strings.TrimSpace(s) {
		return invalid("secret must not start or end with spaces")
	}
	if n := utf8.RuneCountInString(s); n < minSecret || n > maxSecret {
		return invalid("secret must be %d to %d characters", minSecret, maxSecret)
	}
	return nil
}

// --- 随机值 ---

func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand: %v", err)) // 取不到随机数时不能退回到弱随机
	}
	return b
}

var tokenEnc = base32.StdEncoding.WithPadding(base32.NoPadding)

// newToken 是接收地址的最后一段：15 字节随机，24 位小写 base32
func newToken() string { return strings.ToLower(tokenEnc.EncodeToString(randBytes(15))) }

// newSecret 是服务端生成的接收密钥：32 字节随机，whsec_ 开头
func newSecret() string { return "whsec_" + base64.RawURLEncoding.EncodeToString(randBytes(32)) }

// --- 增删改查 ---

// Create 新建一个 Webhook，接收密钥存进保险箱。in.Secret 留空时服务端生成，返回的 plain 就是它，只此一次；
// 自带密钥时 plain 为空，不回显。
func (s *Store) Create(ctx context.Context, in Input) (wh *Webhook, plain string, err error) {
	name, err := checkName(in.Name)
	if err != nil {
		return nil, "", err
	}
	mapping, err := checkMapping(in.Mapping)
	if err != nil {
		return nil, "", err
	}
	filter, err := checkFilter(in.Filter)
	if err != nil {
		return nil, "", err
	}
	dedupe, err := checkPath("dedupe", in.Dedupe)
	if err != nil {
		return nil, "", err
	}
	defaults, err := checkDefaults(in.Defaults)
	if err != nil {
		return nil, "", err
	}
	if err := checkSample(in.Sample); err != nil {
		return nil, "", err
	}
	secret := in.Secret
	if secret == "" {
		secret = newSecret()
		plain = secret
	} else if err := checkSecret(secret); err != nil {
		return nil, "", err
	}
	if s.sec == nil {
		return nil, "", errors.New("vault is not configured: cannot store webhook secret")
	}

	id := idgen.Prefixed("wh")
	// 保险箱操作在写表之外：先建条目，写表失败再删掉，不留孤儿
	sec, err := s.sec.Create(ctx, "Webhook "+id, SecretKind, secret)
	if err != nil {
		return nil, "", err
	}
	enabled := in.Enabled == nil || *in.Enabled
	now := s.now().UTC().Truncate(time.Millisecond).Format(timeLayout)
	mj, dj := mustJSON(mapping), mustJSON(defaults)
	if _, err := s.db.W.ExecContext(ctx, `INSERT INTO webhooks
		(id, name, token, secret_id, enabled, mapping, filter, dedupe, defaults, sample, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, name, newToken(), sec.ID, boolInt(enabled), mj, filter, dedupe, dj, in.Sample, now, now); err != nil {
		_ = s.sec.Delete(context.WithoutCancel(ctx), sec.ID)
		return nil, "", fmt.Errorf("insert webhook: %w", err)
	}
	wh, err = s.Get(ctx, id)
	return wh, plain, err
}

const selectCols = `SELECT w.id, w.name, w.token, w.secret_id, w.enabled, w.mapping, w.filter, w.dedupe,
	w.defaults, w.sample, w.created_at, w.updated_at, v.hint, v.version, v.rotated_at
	FROM webhooks w LEFT JOIN vault_secrets v ON v.id = w.secret_id`

type scanner interface{ Scan(dest ...any) error }

func scan(r scanner) (*Webhook, error) {
	var (
		w                Webhook
		enabled          int
		mj, dj           string
		created, updated string
		hint, rotated    sql.NullString
		version          sql.NullInt64
	)
	if err := r.Scan(&w.ID, &w.Name, &w.Token, &w.SecretID, &enabled, &mj, &w.Filter, &w.Dedupe,
		&dj, &w.Sample, &created, &updated, &hint, &version, &rotated); err != nil {
		return nil, err
	}
	w.Enabled = enabled != 0
	if err := json.Unmarshal([]byte(mj), &w.Mapping); err != nil {
		return nil, fmt.Errorf("webhook %s mapping: %w", w.ID, err)
	}
	if err := json.Unmarshal([]byte(dj), &w.Defaults); err != nil {
		return nil, fmt.Errorf("webhook %s defaults: %w", w.ID, err)
	}
	w.CreatedAt, _ = time.Parse(timeLayout, created)
	w.UpdatedAt, _ = time.Parse(timeLayout, updated)
	// 保险箱条目被单独删了时提示为空、版本为 0，轮换一次就能补上
	w.SecretHint = hint.String
	w.SecretVersion = int(version.Int64)
	if rotated.Valid {
		if t, err := time.Parse(time.RFC3339, rotated.String); err == nil {
			w.SecretRotatedAt = &t
		}
	}
	return &w, nil
}

// Get 取一个；不存在回 ErrNotFound。
func (s *Store) Get(ctx context.Context, id string) (*Webhook, error) {
	return s.get(ctx, s.db.R, id)
}

func (s *Store) get(ctx context.Context, q *sql.DB, id string) (*Webhook, error) {
	w, err := scan(q.QueryRowContext(ctx, selectCols+` WHERE w.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound(id)
	}
	return w, err
}

// List 全部 Webhook，新建的在前。
func (s *Store) List(ctx context.Context) ([]Webhook, error) {
	rows, err := s.db.R.QueryContext(ctx, selectCols+` ORDER BY w.created_at DESC, w.rowid DESC`)
	if err != nil {
		return nil, fmt.Errorf("list webhooks: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Webhook{}
	for rows.Next() {
		w, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *w)
	}
	return out, rows.Err()
}

// Update 改配置；改完标题映射仍不能为空。
func (s *Store) Update(ctx context.Context, id string, p Patch) (*Webhook, error) {
	cur, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	if p.Name != nil {
		if cur.Name, err = checkName(*p.Name); err != nil {
			return nil, err
		}
	}
	if p.Enabled != nil {
		cur.Enabled = *p.Enabled
	}
	if p.Mapping != nil {
		if cur.Mapping, err = checkMapping(*p.Mapping); err != nil {
			return nil, err
		}
	}
	if p.Filter != nil {
		if cur.Filter, err = checkFilter(*p.Filter); err != nil {
			return nil, err
		}
	}
	if p.Dedupe != nil {
		if cur.Dedupe, err = checkPath("dedupe", *p.Dedupe); err != nil {
			return nil, err
		}
	}
	if p.Defaults != nil {
		if cur.Defaults, err = checkDefaults(p.Defaults); err != nil {
			return nil, err
		}
	}
	if p.Sample != nil {
		if err := checkSample(*p.Sample); err != nil {
			return nil, err
		}
		cur.Sample = *p.Sample
	}
	now := s.now().UTC().Truncate(time.Millisecond).Format(timeLayout)
	res, err := s.db.W.ExecContext(ctx, `UPDATE webhooks SET name = ?, enabled = ?, mapping = ?, filter = ?,
		dedupe = ?, defaults = ?, sample = ?, updated_at = ? WHERE id = ?`,
		cur.Name, boolInt(cur.Enabled), mustJSON(cur.Mapping), cur.Filter, cur.Dedupe, mustJSON(cur.Defaults),
		cur.Sample, now, id)
	if err != nil {
		return nil, fmt.Errorf("update webhook: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, notFound(id)
	}
	return s.Get(ctx, id)
}

// RotateSecret 换接收密钥：保险箱条目原地轮换、版本加一，旧密钥随即失效。
// value 留空时服务端生成，plain 就是它，只此一次；保险箱条目已被单独删掉时新建一条补上。
func (s *Store) RotateSecret(ctx context.Context, id, value string) (wh *Webhook, plain string, err error) {
	cur, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, "", err
	}
	if value == "" {
		value = newSecret()
		plain = value
	} else if err := checkSecret(value); err != nil {
		return nil, "", err
	}
	if s.sec == nil {
		return nil, "", errors.New("vault is not configured: cannot store webhook secret")
	}
	if cur.SecretVersion > 0 {
		if _, err := s.sec.Rotate(ctx, cur.SecretID, value); err != nil {
			return nil, "", err
		}
	} else {
		sec, err := s.sec.Create(ctx, "Webhook "+id, SecretKind, value)
		if err != nil {
			return nil, "", err
		}
		now := s.now().UTC().Truncate(time.Millisecond).Format(timeLayout)
		if _, err := s.db.W.ExecContext(ctx, `UPDATE webhooks SET secret_id = ?, updated_at = ? WHERE id = ?`,
			sec.ID, now, id); err != nil {
			_ = s.sec.Delete(context.WithoutCancel(ctx), sec.ID)
			return nil, "", fmt.Errorf("update webhook secret: %w", err)
		}
	}
	wh, err = s.Get(ctx, id)
	return wh, plain, err
}

// Usage 是删除的影响：这个 Webhook 建出来的任务（objects.source=webhook、props.source_ref.hook_id 是它）。
// 任务删了不算；终态按类型的 statuses 定义判断。
func (s *Store) Usage(ctx context.Context, id string) (*Usage, error) {
	if _, err := s.Get(ctx, id); err != nil {
		return nil, err
	}
	var u Usage
	err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(CASE WHEN EXISTS (
			SELECT 1 FROM object_types t, json_each(t.statuses) j
			WHERE t.id = o.type_id AND json_extract(j.value, '$.key') = o.status
			  AND json_extract(j.value, '$.terminal') = 1) THEN 0 ELSE 1 END), 0)
		FROM objects o
		WHERE o.deleted_at IS NULL AND o.source = ? AND json_extract(o.props, '$.source_ref.hook_id') = ?`,
		domain.TaskSourceWebhook, id).Scan(&u.Tasks, &u.OpenTasks)
	if err != nil {
		return nil, fmt.Errorf("webhook usage: %w", err)
	}
	return &u, nil
}

// Delete 彻底删除，保险箱里的密钥一起删；建出来的任务保留。返回删掉的那条，审计要用名字。
func (s *Store) Delete(ctx context.Context, id string) (*Webhook, error) {
	cur, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM webhooks WHERE id = ?`, id)
	if err != nil {
		return nil, fmt.Errorf("delete webhook: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, notFound(id)
	}
	// 表里的行先删，密钥后删：删密钥失败只记日志，留一个没人引用的密文条目，不影响别的
	if s.sec != nil && cur.SecretVersion > 0 {
		if err := s.sec.Delete(context.WithoutCancel(ctx), cur.SecretID); err != nil && !errors.Is(err, domain.ErrNotFound) {
			s.log.Error("webhook deleted but its secret was not", "webhook", id, "secret", cur.SecretID, "err", err)
		}
	}
	return cur, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // 只编码本包的结构体，不会失败
	}
	return string(b)
}
