package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// providerCols 里带着 api_key，是因为脱敏要看密钥长度。scanProvider 拿到之后
// 立刻折成 APIKeyMasked / HasAPIKey，明文不会落进 domain.AgentProvider 的任何字段。
const providerCols = `id, name, kind, base_url, model, api_key, enabled, is_default,
	extra, created_at, updated_at`

// providerDefaultBaseURL 是各 kind 的默认端点。用户建供应商时通常只想填个密钥，
// 端点让它自己补上；填了就以用户填的为准（自建兼容端点、代理都靠这个）。
var providerDefaultBaseURL = map[string]string{
	domain.ProviderOpenAI: "https://api.openai.com/v1",
	domain.ProviderGemini: "https://generativelanguage.googleapis.com/v1beta",
	domain.ProviderOllama: "http://localhost:11434",
}

// providerNeedsKey 标记哪些 kind 必须有密钥。ollama 跑在本机，没有鉴权。
func providerNeedsKey(kind string) bool { return kind != domain.ProviderOllama }

// --- 查询 ---

// ListProviders 默认的排在最前，其余按创建时间。返回值一律脱敏，没有例外。
func (s *Store) ListProviders(ctx context.Context) ([]*domain.AgentProvider, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT `+providerCols+` FROM agent_providers ORDER BY is_default DESC, created_at, id`)
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
	row := s.db.R.QueryRowContext(ctx, `SELECT `+providerCols+` FROM agent_providers WHERE id=?`, id)
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
	row := tx.QueryRowContext(ctx, `SELECT `+providerCols+` FROM agent_providers WHERE id=?`, id)
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
func (s *Store) ProviderAPIKey(ctx context.Context, id string) (string, error) {
	var key string
	err := s.db.R.QueryRowContext(ctx, `SELECT api_key FROM agent_providers WHERE id=?`, id).Scan(&key)
	if noRows(err) {
		return "", notFound("agent provider")
	}
	if err != nil {
		return "", fmt.Errorf("get provider api key: %w", err)
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
	p.BaseURL = normalizeBaseURL(p.BaseURL, p.Kind)
	if providerNeedsKey(p.Kind) && apiKey == "" {
		return nil, validation("api_key", "is required for "+p.Kind+" providers")
	}

	extraJSON, err := encodeProviderExtra(p.Extra)
	if err != nil {
		return nil, err
	}
	p.ID = idgen.Prefixed("apv")
	now := nowStr()

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
			`INSERT INTO agent_providers (`+providerCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
			p.ID, p.Name, p.Kind, p.BaseURL, p.Model, apiKey,
			boolInt(p.Enabled), boolInt(p.IsDefault), extraJSON, now, now)
		if err != nil {
			return fmt.Errorf("insert provider: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	p.APIKeyMasked, p.HasAPIKey = maskAPIKey(apiKey), apiKey != ""
	p.Extra = decodeProviderExtra(extraJSON)
	p.CreatedAt, p.UpdatedAt = parseTime(now), parseTime(now)
	return &p, nil
}

// UpdateProvider 的 APIKey 是三态：nil 不改、空串清除、有值覆盖。
// 改 kind 而没有同时给 base_url 时，base_url 换成新 kind 的默认值——
// 留着上一个 kind 的端点只会在下次「测试连接」时变成一条看不懂的报错。
func (s *Store) UpdateProvider(ctx context.Context, id string, in domain.AgentProviderInput) (*domain.AgentProvider, error) {
	var out *domain.AgentProvider
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := getProviderTx(ctx, tx, id)
		if err != nil {
			return err
		}
		// 明文只在这个局部变量里活着，用于判断「换成需要密钥的 kind 之后还有没有密钥」。
		var curKey string
		if err := tx.QueryRowContext(ctx,
			`SELECT api_key FROM agent_providers WHERE id=?`, id).Scan(&curKey); err != nil {
			return fmt.Errorf("get provider api key: %w", err)
		}

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
		switch {
		case in.BaseURL != nil:
			cur.BaseURL = normalizeBaseURL(*in.BaseURL, cur.Kind)
		case kindChanged:
			cur.BaseURL = providerDefaultBaseURL[cur.Kind]
		}
		if in.Model != nil {
			cur.Model = strings.TrimSpace(*in.Model)
		}
		if in.Enabled != nil {
			cur.Enabled = *in.Enabled
		}
		if in.APIKey != nil {
			curKey = strings.TrimSpace(*in.APIKey)
		}
		if providerNeedsKey(cur.Kind) && curKey == "" {
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
			 enabled=?, extra=?, updated_at=? WHERE id=?`,
			cur.Name, cur.Kind, cur.BaseURL, cur.Model, curKey,
			boolInt(cur.Enabled), extraJSON, now, id); err != nil {
			return fmt.Errorf("update provider: %w", err)
		}

		cur.APIKeyMasked, cur.HasAPIKey = maskAPIKey(curKey), curKey != ""
		cur.Extra = decodeProviderExtra(extraJSON)
		cur.UpdatedAt = parseTime(now)
		out = cur
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteProvider 删掉默认供应商时，把最早创建的那个启用供应商提上来。
// 一个都没有就允许没有默认——总比留一个指向已删行的悬空默认强。
func (s *Store) DeleteProvider(ctx context.Context, id string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := getProviderTx(ctx, tx, id)
		if err != nil {
			return err
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
	var enabled, isDefault int
	if err := sc.Scan(&p.ID, &p.Name, &p.Kind, &p.BaseURL, &p.Model, &apiKey,
		&enabled, &isDefault, &extra, &created, &updated); err != nil {
		return nil, err
	}
	p.Enabled, p.IsDefault = enabled != 0, isDefault != 0
	// 明文到此为止：只留长度信息折出来的掩码。
	p.APIKeyMasked, p.HasAPIKey = maskAPIKey(apiKey), apiKey != ""
	p.Extra = decodeProviderExtra(extra)
	p.CreatedAt, p.UpdatedAt = parseTime(created), parseTime(updated)
	return &p, nil
}

// maskAPIKey 保留前 3 后 4，中间省略，如 sk-…f3a2。
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
	case domain.ProviderOpenAI, domain.ProviderGemini, domain.ProviderOllama:
		return nil
	case "":
		return validation("kind", "is required")
	default:
		return validation("kind", "must be one of openai, gemini, ollama")
	}
}

// normalizeBaseURL 去掉末尾斜杠，拼 /models 时才不会出现 //models。
func normalizeBaseURL(raw, kind string) string {
	u := strings.TrimRight(strings.TrimSpace(raw), "/")
	if u == "" {
		return providerDefaultBaseURL[kind]
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
