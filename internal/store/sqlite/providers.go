package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// ProviderKeyVault 是存服务商密钥要用的保险箱操作，*vault.Vault 天然满足它。
type ProviderKeyVault interface {
	Create(ctx context.Context, name, kind, value string) (*vault.Secret, error)
	Delete(ctx context.Context, id string) error
	Resolve(ctx context.Context, id string) (string, error)
}

// errNoVault：没接保险箱时不能写密钥，也不退回明文入库。
var errNoVault = errors.New("vault is not attached: provider api keys cannot be stored")

// providerInsertCols 是写入用的列。api_key 一律写空串，只有 0015 之前的老行里还有明文，
// 启动时 AttachVault 会把它们搬进保险箱。
const providerInsertCols = `id, name, kind, base_url, model, api_key, api_key_secret_id,
	enabled, is_default, extra, created_at, updated_at`

// providerCols 连带保险箱条目的脱敏提示一起读：hint 为 NULL 表示条目不存在。
// 老行的 api_key 仍要读出来，没迁移之前脱敏要看它；scanProvider 拿到后立刻折掉。
const providerCols = `p.id, p.name, p.kind, p.base_url, p.model, p.api_key, v.hint,
	p.enabled, p.is_default, p.extra, p.created_at, p.updated_at`

const providerFrom = ` FROM agent_providers p
	LEFT JOIN vault_secrets v ON p.api_key_secret_id <> '' AND v.id = p.api_key_secret_id`

// AttachVault 接上保险箱，并把还存着明文的老行搬进去（加密需要主密钥，迁移 SQL 做不了）。
// 每行先建保险箱条目，再带着原明文做条件清空旧列；条件不中（期间被改过）就删掉刚建的条目。
// 中途失败时明文还在原处，下次启动会接着搬。返回搬了几行。
func (s *Store) AttachVault(ctx context.Context, v ProviderKeyVault) (int, error) {
	s.keys = v
	type legacy struct{ id, key, oldSecret string }
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT id, api_key, api_key_secret_id FROM agent_providers WHERE api_key <> ''`)
	if err != nil {
		return 0, fmt.Errorf("list plaintext provider keys: %w", err)
	}
	var todo []legacy
	for rows.Next() {
		var l legacy
		if err := rows.Scan(&l.id, &l.key, &l.oldSecret); err != nil {
			_ = rows.Close()
			return 0, fmt.Errorf("scan provider key: %w", err)
		}
		todo = append(todo, l)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("list plaintext provider keys: %w", err)
	}

	moved := 0
	for _, l := range todo {
		sec, err := v.Create(ctx, providerSecretName(l.id), vault.DefaultKind, l.key)
		if err != nil {
			return moved, fmt.Errorf("move provider %s key into vault: %w", l.id, err)
		}
		res, err := s.db.W.ExecContext(ctx,
			`UPDATE agent_providers SET api_key='', api_key_secret_id=? WHERE id=? AND api_key=?`,
			sec.ID, l.id, l.key)
		if err != nil {
			_ = v.Delete(ctx, sec.ID)
			return moved, fmt.Errorf("clear provider %s plaintext key: %w", l.id, err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			_ = v.Delete(ctx, sec.ID)
			continue
		}
		// 老行同时挂着条目说明明文是后写的（旧版程序写入），以明文为准，旧条目作废。
		if l.oldSecret != "" {
			s.dropProviderSecret(ctx, l.oldSecret)
		}
		moved++
	}
	return moved, nil
}

// providerSecretName 是保险箱条目名，按 id 起，服务商改名不用跟着改。
func providerSecretName(id string) string { return "模型服务商 " + id }

// dropProviderSecret 删条目尽力而为：删不掉只是留一条没人引用的密文，不影响服务商本身。
func (s *Store) dropProviderSecret(ctx context.Context, id string) {
	if id == "" || s.keys == nil {
		return
	}
	_ = s.keys.Delete(ctx, id)
}

// sealProviderKey 把明文放进保险箱，返回条目 id 和脱敏提示；空串不建条目。
// 保险箱另有连接，必须在 store 的写事务之外调用，否则会等写锁。
func (s *Store) sealProviderKey(ctx context.Context, providerID, key string) (*vault.Secret, error) {
	if key == "" {
		return nil, nil
	}
	if s.keys == nil {
		return nil, errNoVault
	}
	sec, err := s.keys.Create(ctx, providerSecretName(providerID), vault.DefaultKind, key)
	if err != nil {
		return nil, fmt.Errorf("store provider api key: %w", err)
	}
	return sec, nil
}

// providerDefaultBaseURL 是各 kind 的默认端点。用户建供应商时通常只想填个密钥，
// 端点让它自己补上；填了就以用户填的为准（自建兼容端点、代理都靠这个）。
var providerDefaultBaseURL = map[string]string{
	domain.ProviderOpenAI:    "https://api.openai.com/v1",
	domain.ProviderAnthropic: "https://api.anthropic.com",
	domain.ProviderGemini:    "https://generativelanguage.googleapis.com/v1beta",
	domain.ProviderOllama:    "http://localhost:11434",
}

// providerPresetBaseURL 是 openai 兼容厂商的默认端点，按 extra.preset 取。
// 不认识的 preset 只当标签，回落到 kind 的默认端点。
var providerPresetBaseURL = map[string]string{
	domain.ProviderPresetDeepSeek: "https://api.deepseek.com",
}

// defaultBaseURL 先看 preset 再看 kind。preset 只对 openai 协议生效。
func defaultBaseURL(kind string, extra map[string]any) string {
	if kind == domain.ProviderOpenAI {
		if preset, _ := extra["preset"].(string); providerPresetBaseURL[preset] != "" {
			return providerPresetBaseURL[preset]
		}
	}
	return providerDefaultBaseURL[kind]
}

// providerNeedsKey 标记哪些 kind 必须有密钥。ollama 跑在本机，没有鉴权。
func providerNeedsKey(kind string) bool { return kind != domain.ProviderOllama }

// --- 查询 ---

// ListProviders 默认的排在最前，其余按创建时间。返回值一律脱敏，没有例外。
func (s *Store) ListProviders(ctx context.Context) ([]*domain.AgentProvider, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT `+providerCols+providerFrom+` ORDER BY p.is_default DESC, p.created_at, p.id`)
	if err != nil {
		return nil, fmt.Errorf("list providers: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.AgentProvider{}
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetProvider(ctx context.Context, id string) (*domain.AgentProvider, error) {
	row := s.db.R.QueryRowContext(ctx, `SELECT `+providerCols+providerFrom+` WHERE p.id=?`, id)
	p, err := scanProvider(row)
	if noRows(err) {
		return nil, notFound("agent provider")
	}
	if err != nil {
		return nil, fmt.Errorf("get provider: %w", err)
	}
	return p, nil
}

func getProviderTx(ctx context.Context, tx *sql.Tx, id string) (*domain.AgentProvider, error) {
	row := tx.QueryRowContext(ctx, `SELECT `+providerCols+providerFrom+` WHERE p.id=?`, id)
	p, err := scanProvider(row)
	if noRows(err) {
		return nil, notFound("agent provider")
	}
	if err != nil {
		return nil, fmt.Errorf("get provider: %w", err)
	}
	return p, nil
}

// ProviderAPIKey 是取明文的唯一入口，只给服务端调模型时用。
//
// 返回值绝不能进 HTTP 响应，也绝不能进日志（含 error 文本、slog 的任何字段、
// 以及拼进 URL 后再被回显的上游错误）——Gemini 把 key 放在 query 上，
// 上游 4xx 的错误体经常把整个 URL 原样吐回来，那条路径必须掐在调用方。
//
// 密钥在保险箱里；条目被单独删掉时按「未配置」回空串。0015 之前的老行还没搬时直接回明文。
func (s *Store) ProviderAPIKey(ctx context.Context, id string) (string, error) {
	var legacyKey, secretID string
	err := s.db.R.QueryRowContext(ctx,
		`SELECT api_key, api_key_secret_id FROM agent_providers WHERE id=?`, id).Scan(&legacyKey, &secretID)
	if noRows(err) {
		return "", notFound("agent provider")
	}
	if err != nil {
		return "", fmt.Errorf("get provider api key: %w", err)
	}
	if legacyKey != "" || secretID == "" {
		return legacyKey, nil
	}
	if s.keys == nil {
		return "", errNoVault
	}
	key, err := s.keys.Resolve(ctx, secretID)
	if errors.Is(err, domain.ErrNotFound) {
		return "", nil
	}
	if err != nil {
		// vault 的错误文本只有条目 id 和主密钥指纹，不含明文。
		return "", fmt.Errorf("resolve provider api key: %w", err)
	}
	return key, nil
}

// --- 写入 ---

// CreateProvider 的 apiKey 是独立入参而不是结构体字段：domain.AgentProvider 里
// 压根没有放明文的地方，这样「读出来的东西不小心又写回去」在类型上就不成立。
func (s *Store) CreateProvider(ctx context.Context, in *domain.AgentProvider, apiKey string) (*domain.AgentProvider, error) {
	if in == nil {
		return nil, validation("provider", "is required")
	}
	p := *in
	p.Name = strings.TrimSpace(p.Name)
	p.Kind = strings.TrimSpace(p.Kind)
	p.Model = strings.TrimSpace(p.Model)
	apiKey = strings.TrimSpace(apiKey)

	if p.Name == "" {
		return nil, validation("name", "is required")
	}
	if err := checkProviderKind(p.Kind); err != nil {
		return nil, err
	}
	p.BaseURL = normalizeBaseURL(p.BaseURL, defaultBaseURL(p.Kind, p.Extra))
	if providerNeedsKey(p.Kind) && apiKey == "" {
		return nil, validation("api_key", "is required for "+p.Kind+" providers")
	}

	extraJSON, err := encodeProviderExtra(p.Extra)
	if err != nil {
		return nil, err
	}
	p.ID = idgen.Prefixed("apv")
	now := nowStr()

	sec, err := s.sealProviderKey(ctx, p.ID, apiKey)
	if err != nil {
		return nil, err
	}
	secretID, hint := "", ""
	if sec != nil {
		secretID, hint = sec.ID, sec.Hint
	}

	err = s.withTx(ctx, func(tx *sql.Tx) error {
		// 第一个供应商自动成为默认，否则用户建完还得再点一次「设为默认」才能用。
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_providers`).Scan(&n); err != nil {
			return fmt.Errorf("count providers: %w", err)
		}
		if n == 0 {
			p.IsDefault = true
		}
		if p.IsDefault {
			if err := clearDefaultTx(ctx, tx); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx,
			`INSERT INTO agent_providers (`+providerInsertCols+`) VALUES (?,?,?,?,?,'',?,?,?,?,?,?)`,
			p.ID, p.Name, p.Kind, p.BaseURL, p.Model, secretID,
			boolInt(p.Enabled), boolInt(p.IsDefault), extraJSON, now, now)
		if err != nil {
			return fmt.Errorf("insert provider: %w", err)
		}
		return nil
	})
	if err != nil {
		s.dropProviderSecret(ctx, secretID)
		return nil, err
	}

	p.APIKeyMasked, p.HasAPIKey = hint, secretID != ""
	p.Extra = decodeProviderExtra(extraJSON)
	p.CreatedAt, p.UpdatedAt = parseTime(now), parseTime(now)
	return &p, nil
}

// UpdateProvider 的 APIKey 是三态：nil 不改、空串清除、有值覆盖。
// 改 kind 而没有同时给 base_url 时，base_url 换成新 kind 的默认值——
// 留着上一个 kind 的端点只会在下次「测试连接」时变成一条看不懂的报错。
//
// 换密钥时先在事务外建新条目，提交成功后删旧条目；中途失败删掉新条目，旧密钥不受影响。
func (s *Store) UpdateProvider(ctx context.Context, id string, in domain.AgentProviderInput) (*domain.AgentProvider, error) {
	var newSec *vault.Secret
	if in.APIKey != nil {
		var err error
		if newSec, err = s.sealProviderKey(ctx, id, strings.TrimSpace(*in.APIKey)); err != nil {
			return nil, err
		}
	}
	newSecretID := ""
	if newSec != nil {
		newSecretID = newSec.ID
	}

	var out *domain.AgentProvider
	var oldSecretID string
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := getProviderTx(ctx, tx, id)
		if err != nil {
			return err
		}
		// legacyKey 是 0015 之前的老明文，只在没搬进保险箱的行里有；不换密钥时原样保留。
		var legacyKey string
		if err := tx.QueryRowContext(ctx,
			`SELECT api_key, api_key_secret_id FROM agent_providers WHERE id=?`, id).
			Scan(&legacyKey, &oldSecretID); err != nil {
			return fmt.Errorf("get provider api key: %w", err)
		}
		secretID, hasKey := oldSecretID, cur.HasAPIKey

		kindChanged := false
		if in.Kind != nil {
			kind := strings.TrimSpace(*in.Kind)
			if err := checkProviderKind(kind); err != nil {
				return err
			}
			kindChanged = kind != cur.Kind
			cur.Kind = kind
		}
		if in.Name != nil {
			name := strings.TrimSpace(*in.Name)
			if name == "" {
				return validation("name", "is required")
			}
			cur.Name = name
		}
		extra := cur.Extra
		if in.Extra != nil {
			extra = *in.Extra
		}
		switch {
		case in.BaseURL != nil:
			cur.BaseURL = normalizeBaseURL(*in.BaseURL, defaultBaseURL(cur.Kind, extra))
		case kindChanged:
			cur.BaseURL = defaultBaseURL(cur.Kind, extra)
		}
		if in.Model != nil {
			cur.Model = strings.TrimSpace(*in.Model)
		}
		if in.Enabled != nil {
			cur.Enabled = *in.Enabled
		}
		if in.APIKey != nil {
			legacyKey, secretID, hasKey = "", newSecretID, newSecretID != ""
			cur.APIKeyMasked = ""
			if newSec != nil {
				cur.APIKeyMasked = newSec.Hint
			}
		}
		if providerNeedsKey(cur.Kind) && !hasKey {
			return validation("api_key", "is required for "+cur.Kind+" providers")
		}

		if in.Extra != nil {
			cur.Extra = *in.Extra
		}
		extraJSON, err := encodeProviderExtra(cur.Extra)
		if err != nil {
			return err
		}

		now := nowStr()
		if _, err := tx.ExecContext(ctx,
			`UPDATE agent_providers SET name=?, kind=?, base_url=?, model=?, api_key=?,
			 api_key_secret_id=?, enabled=?, extra=?, updated_at=? WHERE id=?`,
			cur.Name, cur.Kind, cur.BaseURL, cur.Model, legacyKey, secretID,
			boolInt(cur.Enabled), extraJSON, now, id); err != nil {
			return fmt.Errorf("update provider: %w", err)
		}

		cur.HasAPIKey = hasKey
		cur.Extra = decodeProviderExtra(extraJSON)
		cur.UpdatedAt = parseTime(now)
		out = cur
		return nil
	})
	if err != nil {
		s.dropProviderSecret(ctx, newSecretID)
		return nil, err
	}
	if in.APIKey != nil {
		s.dropProviderSecret(ctx, oldSecretID)
	}
	return out, nil
}

// DeleteProvider 删掉默认供应商时，把最早创建的那个启用供应商提上来。
// 一个都没有就允许没有默认——总比留一个指向已删行的悬空默认强。
//
// 保险箱条目在事务提交之后再删。
func (s *Store) DeleteProvider(ctx context.Context, id string) error {
	var secretID string
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := getProviderTx(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx,
			`SELECT api_key_secret_id FROM agent_providers WHERE id=?`, id).Scan(&secretID); err != nil {
			return fmt.Errorf("get provider secret: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM agent_providers WHERE id=?`, id); err != nil {
			return fmt.Errorf("delete provider: %w", err)
		}
		if !cur.IsDefault {
			return nil
		}
		var next string
		err = tx.QueryRowContext(ctx,
			`SELECT id FROM agent_providers WHERE enabled=1 ORDER BY created_at, id LIMIT 1`).Scan(&next)
		if noRows(err) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("pick next default provider: %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE agent_providers SET is_default=1, updated_at=? WHERE id=?`, nowStr(), next); err != nil {
			return fmt.Errorf("promote default provider: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.dropProviderSecret(ctx, secretID)
	return nil
}

// SetDefaultProvider 先清后置，两条语句而不是一条 CASE：
// 部分唯一索引是逐行校验的，一条语句里新旧默认会短暂同时存在而撞索引。
func (s *Store) SetDefaultProvider(ctx context.Context, id string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := getProviderTx(ctx, tx, id); err != nil {
			return err
		}
		if err := clearDefaultTx(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE agent_providers SET is_default=1, updated_at=? WHERE id=?`, nowStr(), id); err != nil {
			return fmt.Errorf("set default provider: %w", err)
		}
		return nil
	})
}

func clearDefaultTx(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx,
		`UPDATE agent_providers SET is_default=0 WHERE is_default=1`); err != nil {
		return fmt.Errorf("clear default provider: %w", err)
	}
	return nil
}

// --- 辅助 ---

func scanProvider(sc rowScanner) (*domain.AgentProvider, error) {
	var p domain.AgentProvider
	var apiKey, extra, created, updated string
	var hint sql.NullString
	var enabled, isDefault int
	if err := sc.Scan(&p.ID, &p.Name, &p.Kind, &p.BaseURL, &p.Model, &apiKey, &hint,
		&enabled, &isDefault, &extra, &created, &updated); err != nil {
		return nil, err
	}
	p.Enabled, p.IsDefault = enabled != 0, isDefault != 0
	// 明文到此为止：老行只留折出来的掩码，搬进保险箱的用保险箱的脱敏提示。
	switch {
	case apiKey != "":
		p.APIKeyMasked, p.HasAPIKey = maskAPIKey(apiKey), true
	case hint.Valid:
		p.APIKeyMasked, p.HasAPIKey = hint.String, true
	}
	p.Extra = decodeProviderExtra(extra)
	p.CreatedAt, p.UpdatedAt = parseTime(created), parseTime(updated)
	return &p, nil
}

// maskAPIKey 只给还没搬进保险箱的老明文用，保留前 3 后 4，中间省略，如 sk-…f3a2。
// 短于 8 位一律回 ***：前 3 后 4 会把一条短密钥几乎整个还原出来。
func maskAPIKey(key string) string {
	if key == "" {
		return ""
	}
	r := []rune(key)
	if len(r) < 8 {
		return "***"
	}
	return string(r[:3]) + "…" + string(r[len(r)-4:])
}

func checkProviderKind(kind string) error {
	switch kind {
	case domain.ProviderOpenAI, domain.ProviderAnthropic, domain.ProviderGemini, domain.ProviderOllama:
		return nil
	case "":
		return validation("kind", "is required")
	default:
		return validation("kind", "must be one of openai, anthropic, gemini, ollama")
	}
}

// normalizeBaseURL 去掉末尾斜杠，拼 /models 时才不会出现 //models。
func normalizeBaseURL(raw, fallback string) string {
	u := strings.TrimRight(strings.TrimSpace(raw), "/")
	if u == "" {
		return fallback
	}
	return u
}

func encodeProviderExtra(m map[string]any) (string, error) {
	if len(m) == 0 {
		return "{}", nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", validation("extra", "must be a JSON object")
	}
	return string(b), nil
}

// decodeProviderExtra 解析失败回空对象：一条坏掉的 extra 不该让整个列表接口挂掉。
func decodeProviderExtra(raw string) map[string]any {
	out := map[string]any{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return map[string]any{}
	}
	return out
}
