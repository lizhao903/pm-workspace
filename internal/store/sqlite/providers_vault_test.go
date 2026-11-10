// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"crypto/rand"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

func countRows(t *testing.T, s *Store, ctx context.Context, q string, args ...any) int {
	t.Helper()
	var n int
	if err := s.db.R.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}

// TestProviderKeyNeverStoredInPlaintext：新建和更新都只在保险箱里留密文，api_key 列一直是空串。
func TestProviderKeyNeverStoredInPlaintext(t *testing.T) {
	s, ctx := newStore(t)
	const key = "sk-proj-PLAINTEXT-0000-f3a2"
	p := mustProvider(t, s, ctx, "OpenAI", domain.ProviderOpenAI, key)

	if n := countRows(t, s, ctx, `SELECT COUNT(*) FROM agent_providers WHERE api_key <> ''`); n != 0 {
		t.Fatalf("api_key 列里还有 %d 行明文", n)
	}
	if n := countRows(t, s, ctx, `SELECT COUNT(*) FROM vault_secrets WHERE CAST(ciphertext AS TEXT) LIKE '%PLAINTEXT%'`); n != 0 {
		t.Fatal("保险箱里存的不是密文")
	}
	if n := countRows(t, s, ctx, `SELECT COUNT(*) FROM agent_providers p JOIN vault_secrets v ON v.id = p.api_key_secret_id WHERE p.id=?`, p.ID); n != 1 {
		t.Fatalf("新列没指向保险箱条目")
	}

	// 换密钥后旧条目要删掉，保险箱里只留一条。
	next := "sk-proj-NEXT-000000-9999"
	if _, err := s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{APIKey: &next}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if n := countRows(t, s, ctx, `SELECT COUNT(*) FROM vault_secrets`); n != 1 {
		t.Errorf("换密钥后保险箱条目 = %d, 期望 1", n)
	}
	if got, _ := s.ProviderAPIKey(ctx, p.ID); got != next {
		t.Errorf("换密钥后取到 %q", got)
	}

	// 更新失败时新建的条目要收回，原密钥不受影响。
	bad, other := "", "sk-proj-OTHER-000000-7777"
	if _, err := s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{Name: &bad, APIKey: &other}); err == nil {
		t.Fatal("空名字应被拒")
	}
	if n := countRows(t, s, ctx, `SELECT COUNT(*) FROM vault_secrets`); n != 1 {
		t.Errorf("失败的更新留下了条目，共 %d 条", n)
	}
	if got, _ := s.ProviderAPIKey(ctx, p.ID); got != next {
		t.Errorf("失败的更新改动了密钥: %q", got)
	}

	// 删服务商连带删条目。
	if err := s.DeleteProvider(ctx, p.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if n := countRows(t, s, ctx, `SELECT COUNT(*) FROM vault_secrets`); n != 0 {
		t.Errorf("删服务商后保险箱还剩 %d 条", n)
	}
}

// TestProviderSecretDeletedElsewhere：条目从 /api/secrets 单独删掉后按未配置处理，不报错。
func TestProviderSecretDeletedElsewhere(t *testing.T) {
	s, ctx := newStore(t)
	p := mustProvider(t, s, ctx, "OpenAI", domain.ProviderOpenAI, "sk-proj-GONE-000000-1234")
	if _, err := s.db.W.ExecContext(ctx, `DELETE FROM vault_secrets`); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetProvider(ctx, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.HasAPIKey || got.APIKeyMasked != "" {
		t.Errorf("条目没了却显示 has=%v masked=%q", got.HasAPIKey, got.APIKeyMasked)
	}
	key, err := s.ProviderAPIKey(ctx, p.ID)
	if err != nil || key != "" {
		t.Errorf("条目没了 ProviderAPIKey = %q, %v；期望空串、无错", key, err)
	}
}

// TestAttachVaultMovesLegacyPlaintext 模拟 0015 之前留下的明文行：接上保险箱后搬进去、旧列清空，
// 再接一次不重复搬。
func TestAttachVaultMovesLegacyPlaintext(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	const legacy = "sk-legacy-PLAINTEXT-0000-abcd"
	now := nowStr()
	if _, err := s.db.W.ExecContext(ctx, `INSERT INTO agent_providers
		(id, name, kind, base_url, model, api_key, enabled, is_default, extra, created_at, updated_at)
		VALUES ('apv_old', '老服务商', 'openai', 'https://api.openai.com/v1', '', ?, 1, 1, '{}', ?, ?),
		       ('apv_local', '本地', 'ollama', 'http://localhost:11434', '', '', 1, 0, '{}', ?, ?)`,
		legacy, now, now, now, now); err != nil {
		t.Fatal(err)
	}

	// 没接保险箱时老明文照样能读，界面上显示老的掩码。
	if got, _ := s.ProviderAPIKey(ctx, "apv_old"); got != legacy {
		t.Fatalf("迁移前取不到老明文: %q", got)
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	v, err := vault.New(s.db, key)
	if err != nil {
		t.Fatal(err)
	}
	n, err := s.AttachVault(ctx, v)
	if err != nil || n != 1 {
		t.Fatalf("AttachVault = %d, %v；期望搬 1 行", n, err)
	}
	if c := countRows(t, s, ctx, `SELECT COUNT(*) FROM agent_providers WHERE api_key <> ''`); c != 0 {
		t.Errorf("迁移后 api_key 列还有 %d 行", c)
	}
	if c := countRows(t, s, ctx, `SELECT COUNT(*) FROM agent_providers WHERE id='apv_old' AND api_key_secret_id <> ''`); c != 1 {
		t.Error("迁移后新列没值")
	}
	if c := countRows(t, s, ctx, `SELECT COUNT(*) FROM agent_providers WHERE id='apv_local' AND api_key_secret_id = ''`); c != 1 {
		t.Error("没有密钥的行不该建条目")
	}
	if got, err := s.ProviderAPIKey(ctx, "apv_old"); err != nil || got != legacy {
		t.Errorf("迁移后 ProviderAPIKey = %q, %v", got, err)
	}
	p, err := s.GetProvider(ctx, "apv_old")
	if err != nil {
		t.Fatal(err)
	}
	if !p.HasAPIKey || strings.Contains(p.APIKeyMasked, "PLAINTEXT") || p.APIKeyMasked != vault.Hint(legacy) {
		t.Errorf("迁移后 has=%v masked=%q", p.HasAPIKey, p.APIKeyMasked)
	}

	if n, err := s.AttachVault(ctx, v); err != nil || n != 0 {
		t.Errorf("第二次 AttachVault = %d, %v；期望 0", n, err)
	}
	if c := countRows(t, s, ctx, `SELECT COUNT(*) FROM vault_secrets`); c != 1 {
		t.Errorf("保险箱条目 = %d, 期望 1", c)
	}
}

// TestProviderKeyNeedsVault：没接保险箱时拒绝写密钥，不退回明文入库。
func TestProviderKeyNeedsVault(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "novault.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if _, err := s.CreateProvider(ctx, &domain.AgentProvider{Name: "x", Kind: domain.ProviderOpenAI},
		"sk-proj-NOVAULT-0000-0000"); err == nil {
		t.Fatal("没接保险箱也写进去了")
	}
	if c := countRows(t, s, ctx, `SELECT COUNT(*) FROM agent_providers`); c != 0 {
		t.Errorf("写失败却留下了 %d 行", c)
	}
	// ollama 不需要密钥，照常能建。
	if _, err := s.CreateProvider(ctx, &domain.AgentProvider{Name: "本地", Kind: domain.ProviderOllama}, ""); err != nil {
		t.Errorf("ollama 不该依赖保险箱: %v", err)
	}
}
