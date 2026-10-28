package connector

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
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
	maxName     = 100
	maxValue    = 2000
	maxError    = 300
	maxInterval = 1440
	// callTimeout 是连通测试、拉取工具清单等一次对外调用的上限
	callTimeout = 15 * time.Second
	// SecretKind 是保险箱条目的 kind
	SecretKind = "connector"
)

// 状态，同原型 ConnStatus。
const (
	StatusConnected    = "connected"
	StatusConnecting   = "connecting"
	StatusError        = "error"
	StatusPaused       = "paused"
	StatusDisconnected = "disconnected"
)

// Tool 是实例上的一个工具和它的授权，同原型 ConnTool。
type Tool struct {
	ToolDef
	Mode ToolMode `json:"mode"`
}

// Connector 是对外的样子：凭证只有 secret_hints，没有明文。
type Connector struct {
	ID           string            `json:"id"`
	Tool         string            `json:"tool"`
	Name         string            `json:"name"`
	Account      string            `json:"account"`
	Status       string            `json:"status"`
	Error        string            `json:"error"`
	AuthMode     AuthMode          `json:"auth_mode"`
	Config       map[string]string `json:"config"`
	SecretHints  map[string]string `json:"secret_hints"`
	Direction    string            `json:"direction"`
	Interval     int               `json:"interval"`
	Tools        []Tool            `json:"tools"`
	ToolsAt      *time.Time        `json:"tools_at"`
	LastTestedAt *time.Time        `json:"last_tested_at"`
	LastSyncAt   *time.Time        `json:"last_sync_at"`
	// Available 是定义还在不在（插件提供的定义停用后为 false，测试和拉取工具清单回 409）
	Available bool      `json:"available"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// SecretID 是保险箱条目 id，只给后端内部用，不出接口
	SecretID string `json:"-"`
}

// Input 是新建的字段。Secrets 是凭证字段的明文，只写；Enabled 不给时为 true。
type Input struct {
	Tool      string            `json:"tool"`
	Name      string            `json:"name"`
	AuthMode  AuthMode          `json:"auth_mode"`
	Config    map[string]string `json:"config"`
	Secrets   map[string]string `json:"secrets"`
	Enabled   *bool             `json:"enabled"`
	Direction string            `json:"direction"`
	Interval  *int              `json:"interval"`
}

// Patch 是修改的字段，nil 为不改。Config、Secrets 按键合并：给了的键覆盖，值为空串表示清掉。
type Patch struct {
	Name      *string           `json:"name"`
	AuthMode  *AuthMode         `json:"auth_mode"`
	Config    map[string]string `json:"config"`
	Secrets   map[string]string `json:"secrets"`
	Enabled   *bool             `json:"enabled"`
	Direction *string           `json:"direction"`
	Interval  *int              `json:"interval"`
}

// TestResult 是一次连通测试的结论。失败不是接口错误，ok 为 false。
type TestResult struct {
	OK        bool       `json:"ok"`
	Account   string     `json:"account"`
	Message   string     `json:"message"`
	Connector *Connector `json:"connector"`
}

// ToolsResult 是拉取工具清单的结论：新增、移除的工具名，其余保留原来的授权。
type ToolsResult struct {
	Added     []string   `json:"added"`
	Removed   []string   `json:"removed"`
	Connector *Connector `json:"connector"`
}

// Secrets 是用到的保险箱操作，*vault.Vault 天然满足它。
type Secrets interface {
	Create(ctx context.Context, name, kind, value string) (*vault.Secret, error)
	Rotate(ctx context.Context, id, value string) (*vault.Secret, error)
	Delete(ctx context.Context, id string) error
	Resolve(ctx context.Context, id string) (string, error)
}

// Store 读写 connectors 表。
type Store struct {
	db   *db.DB
	sec  Secrets
	defs *Registry
	log  *slog.Logger
	now  func() time.Time
	// mu 让改同一张表的读改写一个一个来：查重、合并凭证、合并工具授权都是先读后写
	mu sync.Mutex
}

// New 建实例表的读写；sec 为 nil 时写凭证报错，defs 为 nil 时没有任何定义。
func New(d *db.DB, sec Secrets, defs *Registry) *Store {
	if defs == nil {
		defs = NewRegistry()
	}
	return &Store{db: d, sec: sec, defs: defs, log: slog.Default(), now: time.Now}
}

// Defs 是定义注册表。
func (s *Store) Defs() *Registry { return s.defs }

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", domain.ErrValidation, fmt.Sprintf(format, a...))
}

func conflict(format string, a ...any) error {
	return fmt.Errorf("%w: %s", domain.ErrConflict, fmt.Sprintf(format, a...))
}

func notFound(id string) error { return fmt.Errorf("%w: connector %s", domain.ErrNotFound, id) }

func (s *Store) stamp() string { return s.now().UTC().Truncate(time.Millisecond).Format(timeLayout) }

// --- 校验 ---

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

func checkAuthMode(d *Def, m AuthMode) (AuthMode, error) {
	if m == "" {
		return d.Auth[0], nil
	}
	if !slices.Contains(d.Auth, m) {
		return "", invalid("auth_mode %q is not supported by %s (supported: %v)", m, d.Tool, d.Auth)
	}
	return m, nil
}

func checkDirection(d *Def, dir string) (string, error) {
	switch dir {
	case "", "receive":
		return "receive", nil
	case "both":
		if !d.CanSend {
			return "", invalid("%s cannot send, direction must be receive", d.Tool)
		}
		return "both", nil
	}
	return "", invalid("direction must be receive or both")
}

func checkInterval(n int) error {
	if n < 0 || n > maxInterval {
		return invalid("interval must be 0 to %d minutes", maxInterval)
	}
	return nil
}

// mergeValues 把 in 合进 cur：键必须是定义里对应种类的字段，值去首尾空白，空串表示清掉。
func mergeValues(d *Def, cur, in map[string]string, secret bool) (map[string]string, error) {
	out := map[string]string{}
	for k, v := range cur {
		out[k] = v
	}
	for k, v := range in {
		f := d.field(k)
		if f == nil || (f.Kind == "secret") != secret {
			if secret {
				return nil, invalid("secrets.%s is not a secret field of %s", k, d.Tool)
			}
			return nil, invalid("config.%s is not a config field of %s", k, d.Tool)
		}
		if !secret {
			v = strings.TrimSpace(v)
			if utf8.RuneCountInString(v) > maxValue {
				return nil, invalid("config.%s is longer than %d characters", k, maxValue)
			}
			if f.Kind == "select" && v != "" && !slices.Contains(f.Options, v) {
				return nil, invalid("config.%s must be one of %v", k, f.Options)
			}
		} else if v != strings.TrimSpace(v) {
			return nil, invalid("secrets.%s must not start or end with spaces", k)
		}
		if v == "" {
			delete(out, k)
		} else {
			out[k] = v
		}
	}
	return out, nil
}

func checkRequired(d *Def, values, secrets map[string]string) error {
	var missing []string
	for _, f := range d.Fields {
		have := values[f.Key]
		if f.Kind == "secret" {
			have = secrets[f.Key]
		}
		if f.Required && have == "" {
			missing = append(missing, f.Key)
		}
	}
	if len(missing) > 0 {
		return invalid("required fields are missing: %s", strings.Join(missing, ", "))
	}
	return nil
}

// --- 凭证 ---

// hintsOf 是每个凭证字段的脱敏提示，规则同保险箱。
func hintsOf(secrets map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range secrets {
		out[k] = vault.Hint(v)
	}
	return out
}

func (s *Store) resolveSecrets(ctx context.Context, c *Connector) (map[string]string, error) {
	out := map[string]string{}
	if c.SecretID == "" {
		return out, nil
	}
	if s.sec == nil {
		return nil, errors.New("vault is not configured: cannot read connector secrets")
	}
	plain, err := s.sec.Resolve(ctx, c.SecretID)
	if errors.Is(err, domain.ErrNotFound) {
		return out, nil // 保险箱条目被单独删了：当作没填，重新填一次就补上
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(plain), &out); err != nil {
		return nil, fmt.Errorf("connector %s secrets are not valid JSON", c.ID)
	}
	return out, nil
}

// saveSecrets 把整组凭证写进保险箱，返回新的条目 id：原来有就原地轮换，没有就新建，清空了就删掉。
// created 为 true 时是新建的条目，写表失败要删掉。
func (s *Store) saveSecrets(ctx context.Context, id, secretID string, secrets map[string]string) (newID string, created bool, err error) {
	if len(secrets) == 0 {
		if secretID != "" && s.sec != nil {
			if err := s.sec.Delete(ctx, secretID); err != nil && !errors.Is(err, domain.ErrNotFound) {
				return "", false, err
			}
		}
		return "", false, nil
	}
	if s.sec == nil {
		return "", false, errors.New("vault is not configured: cannot store connector secrets")
	}
	value := mustJSON(secrets)
	if secretID != "" {
		_, err := s.sec.Rotate(ctx, secretID, value)
		if err == nil {
			return secretID, false, nil
		}
		if !errors.Is(err, domain.ErrNotFound) {
			return "", false, err
		}
	}
	sec, err := s.sec.Create(ctx, "Connector "+id, SecretKind, value)
	if err != nil {
		return "", false, err
	}
	return sec.ID, true, nil
}

// scrub 把凭证明文从对方的错误文本里抹掉，再截到 maxError 字。
func scrub(msg string, secrets map[string]string) string {
	vals := make([]string, 0, len(secrets))
	for _, v := range secrets {
		if v != "" {
			vals = append(vals, v)
		}
	}
	// 长的先换，免得一个凭证是另一个的子串时只抹掉一半
	sort.Slice(vals, func(i, j int) bool { return len(vals[i]) > len(vals[j]) })
	for _, v := range vals {
		msg = strings.ReplaceAll(msg, v, "***")
	}
	if r := []rune(msg); len(r) > maxError {
		msg = string(r[:maxError]) + "…"
	}
	return msg
}

// --- 增删改查 ---

// Create 新建一个实例。一个工具只接一个账号，已经接过回 409。
// 新建后状态是 connecting（还没测过），不启用时是 paused；连通测试走 Test。
func (s *Store) Create(ctx context.Context, in Input) (*Connector, error) {
	d, ok := s.defs.Get(strings.TrimSpace(in.Tool))
	if !ok {
		return nil, invalid("unknown connector tool %q", in.Tool)
	}
	name := in.Name
	if strings.TrimSpace(name) == "" {
		name = d.Label
	}
	name, err := checkName(name)
	if err != nil {
		return nil, err
	}
	mode, err := checkAuthMode(&d, in.AuthMode)
	if err != nil {
		return nil, err
	}
	dir, err := checkDirection(&d, in.Direction)
	if err != nil {
		return nil, err
	}
	interval := 0
	if in.Interval != nil {
		interval = *in.Interval
	}
	if err := checkInterval(interval); err != nil {
		return nil, err
	}
	values, err := mergeValues(&d, nil, in.Config, false)
	if err != nil {
		return nil, err
	}
	secrets, err := mergeValues(&d, nil, in.Secrets, true)
	if err != nil {
		return nil, err
	}
	if err := checkRequired(&d, values, secrets); err != nil {
		return nil, err
	}
	status := StatusConnecting
	if in.Enabled != nil && !*in.Enabled {
		status = StatusPaused
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	var existing string
	err = s.db.W.QueryRowContext(ctx, `SELECT id FROM connectors WHERE tool = ? LIMIT 1`, d.Tool).Scan(&existing)
	if err == nil {
		return nil, conflict("%s is already connected (%s); one account per tool", d.Tool, existing)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("check connector tool: %w", err)
	}

	id := idgen.Prefixed("cn")
	// 保险箱操作在写表之外：先建条目，写表失败再删掉，不留孤儿
	secretID, _, err := s.saveSecrets(ctx, id, "", secrets)
	if err != nil {
		return nil, err
	}
	now := s.stamp()
	if _, err := s.db.W.ExecContext(ctx, `INSERT INTO connectors
		(id, tool, name, status, auth_mode, config, secret_id, secret_hints, direction, interval, tools, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
		id, d.Tool, name, status, string(mode), mustJSON(values), secretID, mustJSON(hintsOf(secrets)),
		dir, interval, now, now); err != nil {
		if secretID != "" {
			_ = s.sec.Delete(context.WithoutCancel(ctx), secretID)
		}
		return nil, fmt.Errorf("insert connector: %w", err)
	}
	return s.get(ctx, s.db.W, id)
}

const selectCols = `SELECT id, tool, name, account, status, error, auth_mode, config, secret_id, secret_hints,
	direction, interval, tools, tools_at, last_tested_at, last_sync_at, created_at, updated_at FROM connectors`

type scanner interface{ Scan(dest ...any) error }

func (s *Store) scan(r scanner) (*Connector, error) {
	var (
		c                       Connector
		mode, cj, hj, tj        string
		toolsAt, tested, synced sql.NullString
		created, updated        string
	)
	if err := r.Scan(&c.ID, &c.Tool, &c.Name, &c.Account, &c.Status, &c.Error, &mode, &cj, &c.SecretID, &hj,
		&c.Direction, &c.Interval, &tj, &toolsAt, &tested, &synced, &created, &updated); err != nil {
		return nil, err
	}
	c.AuthMode = AuthMode(mode)
	for _, f := range []struct {
		raw string
		dst any
	}{{cj, &c.Config}, {hj, &c.SecretHints}, {tj, &c.Tools}} {
		if err := json.Unmarshal([]byte(f.raw), f.dst); err != nil {
			return nil, fmt.Errorf("connector %s: %w", c.ID, err)
		}
	}
	if c.Config == nil {
		c.Config = map[string]string{}
	}
	if c.SecretHints == nil {
		c.SecretHints = map[string]string{}
	}
	if c.Tools == nil {
		c.Tools = []Tool{}
	}
	c.ToolsAt, c.LastTestedAt, c.LastSyncAt = parseNull(toolsAt), parseNull(tested), parseNull(synced)
	c.CreatedAt, _ = time.Parse(timeLayout, created)
	c.UpdatedAt, _ = time.Parse(timeLayout, updated)
	_, c.Available = s.defs.Get(c.Tool)
	return &c, nil
}

func parseNull(v sql.NullString) *time.Time {
	if !v.Valid {
		return nil
	}
	t, err := time.Parse(timeLayout, v.String)
	if err != nil {
		return nil
	}
	return &t
}

// Get 取一个；不存在回 ErrNotFound。
func (s *Store) Get(ctx context.Context, id string) (*Connector, error) {
	return s.get(ctx, s.db.R, id)
}

func (s *Store) get(ctx context.Context, q *sql.DB, id string) (*Connector, error) {
	c, err := s.scan(q.QueryRowContext(ctx, selectCols+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound(id)
	}
	return c, err
}

// List 全部实例，新建的在前；tool 非空时只要这个工具的。
func (s *Store) List(ctx context.Context, tool string) ([]Connector, error) {
	q, args := selectCols, []any{}
	if tool != "" {
		q += ` WHERE tool = ?`
		args = append(args, tool)
	}
	rows, err := s.db.R.QueryContext(ctx, q+` ORDER BY created_at DESC, rowid DESC`, args...)
	if err != nil {
		return nil, fmt.Errorf("list connectors: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Connector{}
	for rows.Next() {
		c, err := s.scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// Update 改配置和凭证。enabled=false 置为 paused；从 paused 重新启用置为 connecting，等下一次测试。
// 定义不在了（插件停用）时只能改名字和启停。
func (s *Store) Update(ctx context.Context, id string, p Patch) (*Connector, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	d, ok := s.defs.Get(cur.Tool)
	if !ok && (p.AuthMode != nil || p.Config != nil || p.Secrets != nil || p.Direction != nil) {
		return nil, conflict("connector definition %s is not available", cur.Tool)
	}
	if p.Name != nil {
		if cur.Name, err = checkName(*p.Name); err != nil {
			return nil, err
		}
	}
	if p.AuthMode != nil {
		if cur.AuthMode, err = checkAuthMode(&d, *p.AuthMode); err != nil {
			return nil, err
		}
	}
	if p.Direction != nil {
		if cur.Direction, err = checkDirection(&d, *p.Direction); err != nil {
			return nil, err
		}
	}
	if p.Interval != nil {
		if err := checkInterval(*p.Interval); err != nil {
			return nil, err
		}
		cur.Interval = *p.Interval
	}
	if p.Config != nil {
		if cur.Config, err = mergeValues(&d, cur.Config, p.Config, false); err != nil {
			return nil, err
		}
	}
	secretID, createdSecret := cur.SecretID, false
	if p.Config != nil || p.Secrets != nil {
		old, err := s.resolveSecrets(ctx, cur)
		if err != nil {
			return nil, err
		}
		secrets, err := mergeValues(&d, old, p.Secrets, true)
		if err != nil {
			return nil, err
		}
		if err := checkRequired(&d, cur.Config, secrets); err != nil {
			return nil, err
		}
		if p.Secrets != nil {
			if secretID, createdSecret, err = s.saveSecrets(ctx, id, cur.SecretID, secrets); err != nil {
				return nil, err
			}
			cur.SecretHints = hintsOf(secrets)
		}
	}
	if p.Enabled != nil {
		switch {
		case !*p.Enabled:
			cur.Status = StatusPaused
		case cur.Status == StatusPaused:
			cur.Status = StatusConnecting
		}
	}
	_, err = s.db.W.ExecContext(ctx, `UPDATE connectors SET name = ?, status = ?, auth_mode = ?, config = ?,
		secret_id = ?, secret_hints = ?, direction = ?, interval = ?, updated_at = ? WHERE id = ?`,
		cur.Name, cur.Status, string(cur.AuthMode), mustJSON(cur.Config), secretID, mustJSON(cur.SecretHints),
		cur.Direction, cur.Interval, s.stamp(), id)
	if err != nil {
		if createdSecret {
			_ = s.sec.Delete(context.WithoutCancel(ctx), secretID)
		}
		return nil, fmt.Errorf("update connector: %w", err)
	}
	return s.get(ctx, s.db.W, id)
}

// Delete 彻底删除，保险箱里的凭证一起删。删除前的影响检查归 CONN-03。返回删掉的那条，审计要用名字。
func (s *Store) Delete(ctx context.Context, id string) (*Connector, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	if _, err := s.db.W.ExecContext(ctx, `DELETE FROM connectors WHERE id = ?`, id); err != nil {
		return nil, fmt.Errorf("delete connector: %w", err)
	}
	// 表里的行先删，凭证后删：删凭证失败只记日志，留一个没人引用的密文条目
	if s.sec != nil && cur.SecretID != "" {
		if err := s.sec.Delete(context.WithoutCancel(ctx), cur.SecretID); err != nil && !errors.Is(err, domain.ErrNotFound) {
			s.log.Error("connector deleted but its secrets were not", "connector", id, "secret", cur.SecretID, "err", err)
		}
	}
	return cur, nil
}

// callConfig 取定义和解密后的配置，给 Test、RefreshTools 用。
func (s *Store) callConfig(ctx context.Context, cur *Connector) (Def, Config, error) {
	d, ok := s.defs.Get(cur.Tool)
	if !ok {
		return Def{}, Config{}, conflict("connector definition %s is not available", cur.Tool)
	}
	secrets, err := s.resolveSecrets(ctx, cur)
	if err != nil {
		return Def{}, Config{}, err
	}
	return d, Config{Mode: cur.AuthMode, values: cur.Config, secrets: secrets}, nil
}

// Test 做一次连通测试：成功记下账号、置为 connected，失败置为 error 并记下说明（凭证已抹掉）。
// 暂停中的实例照样测，但状态保持 paused。
func (s *Store) Test(ctx context.Context, id string) (*TestResult, error) {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	d, cfg, err := s.callConfig(ctx, cur)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	account, terr := d.Test(cctx, cfg)
	cancel()
	res := &TestResult{OK: terr == nil}
	if terr != nil {
		res.Message = scrub(terr.Error(), cfg.secrets)
		if res.Message == "" {
			res.Message = "连接失败"
		}
	} else {
		res.Account = strings.TrimSpace(account)
		res.Message = "连接正常"
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.stamp()
	q := `UPDATE connectors SET error = ?, last_tested_at = ?, updated_at = ?,
		status = CASE WHEN status = 'paused' THEN status ELSE ? END`
	args := []any{"", now, now, StatusConnected}
	if terr != nil {
		args = []any{res.Message, now, now, StatusError}
	} else if res.Account != "" {
		q += `, account = ?`
		args = append(args, res.Account)
	}
	if _, err := s.db.W.ExecContext(ctx, q+` WHERE id = ?`, append(args, id)...); err != nil {
		return nil, fmt.Errorf("record connector test: %w", err)
	}
	if res.Connector, err = s.get(ctx, s.db.W, id); err != nil {
		return nil, err
	}
	return res, nil
}

// RefreshTools 向对方拉工具清单：保留已经配过的授权，新出现的按默认（写操作需确认、只读自动），对方删掉的去掉。
// 拉取失败回 ErrConflict，说明里的凭证已抹掉；工具清单不变。
func (s *Store) RefreshTools(ctx context.Context, id string) (*ToolsResult, error) {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	d, cfg, err := s.callConfig(ctx, cur)
	if err != nil {
		return nil, err
	}
	found := slices.Clone(d.Tools)
	if d.ListTools != nil {
		cctx, cancel := context.WithTimeout(ctx, callTimeout)
		found, err = d.ListTools(cctx, cfg)
		cancel()
		if err != nil {
			return nil, conflict("fetch tools failed: %s", scrub(err.Error(), cfg.secrets))
		}
	}
	if err := checkToolDefs(d.Tool, found); err != nil {
		return nil, conflict("fetch tools failed: %v", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err = s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	res := &ToolsResult{Added: []string{}, Removed: []string{}}
	old := map[string]ToolMode{}
	for _, t := range cur.Tools {
		old[t.Name] = t.Mode
	}
	tools := make([]Tool, 0, len(found))
	for _, t := range found {
		m, ok := old[t.Name]
		if !ok {
			m = DefaultMode(t)
			res.Added = append(res.Added, t.Name)
		} else if m == ModeConfirm && !t.Write {
			m = ModeAuto // 对方把它改成了只读：只读没有「需确认」
		}
		delete(old, t.Name)
		tools = append(tools, Tool{ToolDef: t, Mode: m})
	}
	for n := range old {
		res.Removed = append(res.Removed, n)
	}
	sort.Strings(res.Removed)
	now := s.stamp()
	if _, err := s.db.W.ExecContext(ctx, `UPDATE connectors SET tools = ?, tools_at = ?, updated_at = ? WHERE id = ?`,
		mustJSON(tools), now, now, id); err != nil {
		return nil, fmt.Errorf("update connector tools: %w", err)
	}
	if res.Connector, err = s.get(ctx, s.db.W, id); err != nil {
		return nil, err
	}
	return res, nil
}

// SetToolModes 改工具授权，modes 是 {工具名: off/confirm/auto}。工具名必须在清单里；只读工具不能设 confirm。
func (s *Store) SetToolModes(ctx context.Context, id string, modes map[string]ToolMode) (*Connector, error) {
	if len(modes) == 0 {
		return nil, invalid("modes is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	idx := map[string]int{}
	for i, t := range cur.Tools {
		idx[t.Name] = i
	}
	for name, m := range modes {
		i, ok := idx[name]
		if !ok {
			return nil, invalid("tool %q is not in the tool list of %s; fetch tools first", name, id)
		}
		switch m {
		case ModeOff, ModeAuto:
		case ModeConfirm:
			if !cur.Tools[i].Write {
				return nil, invalid("tool %s is read-only and cannot be set to confirm", name)
			}
		default:
			return nil, invalid("mode of %s must be off, confirm or auto", name)
		}
		cur.Tools[i].Mode = m
	}
	if _, err := s.db.W.ExecContext(ctx, `UPDATE connectors SET tools = ?, updated_at = ? WHERE id = ?`,
		mustJSON(cur.Tools), s.stamp(), id); err != nil {
		return nil, fmt.Errorf("update connector tool modes: %w", err)
	}
	return s.get(ctx, s.db.W, id)
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // 只编码本包的结构体和字符串表，不会失败
	}
	return string(b)
}
