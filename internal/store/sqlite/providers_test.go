package sqlite

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func mustProvider(t *testing.T, s *Store, ctx context.Context, name, kind, key string) *domain.AgentProvider {
	t.Helper()
	p, err := s.CreateProvider(ctx, &domain.AgentProvider{Name: name, Kind: kind, Enabled: true}, key)
	if err != nil {
		t.Fatalf("创建供应商 %s: %v", name, err)
	}
	return p
}

func TestCreateProviderFillsDefaultBaseURL(t *testing.T) {
	s, ctx := newStore(t)

	cases := []struct{ kind, key, want string }{
		{domain.ProviderOpenAI, "sk-test-0001-abcd", "https://api.openai.com/v1"},
		{domain.ProviderGemini, "AIza-test-0001-abcd", "https://generativelanguage.googleapis.com/v1beta"},
		{domain.ProviderOllama, "", "http://localhost:11434"},
	}
	for _, c := range cases {
		p := mustProvider(t, s, ctx, c.kind+" 默认端点", c.kind, c.key)
		if p.BaseURL != c.want {
			t.Errorf("kind=%s base_url = %q, 期望 %q", c.kind, p.BaseURL, c.want)
		}
	}

	// 用户填了就以用户填的为准，末尾斜杠去掉，拼 /models 时才不会变成 //models。
	p, err := s.CreateProvider(ctx, &domain.AgentProvider{
		Name: "自建兼容端点", Kind: domain.ProviderOpenAI, BaseURL: "https://llm.internal/v1/", Enabled: true,
	}, "sk-internal-0001")
	if err != nil {
		t.Fatalf("创建自建端点: %v", err)
	}
	if p.BaseURL != "https://llm.internal/v1" {
		t.Errorf("base_url = %q, 期望去掉末尾斜杠后的 https://llm.internal/v1", p.BaseURL)
	}
}

func TestCreateProviderKeyRequirementByKind(t *testing.T) {
	s, ctx := newStore(t)

	// ollama 跑在本机没有鉴权，不给 key 也必须建得出来。
	if _, err := s.CreateProvider(ctx,
		&domain.AgentProvider{Name: "本地 Ollama", Kind: domain.ProviderOllama, Enabled: true}, ""); err != nil {
		t.Fatalf("ollama 不该要求 api_key: %v", err)
	}

	for _, kind := range []string{domain.ProviderOpenAI, domain.ProviderGemini} {
		_, err := s.CreateProvider(ctx,
			&domain.AgentProvider{Name: "缺密钥的 " + kind, Kind: kind, Enabled: true}, "  ")
		if !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("kind=%s 缺 api_key 应报 ErrValidation, got %v", kind, err)
		}
		if !strings.Contains(err.Error(), kind) {
			t.Errorf("kind=%s 的报错没说清是哪种 kind 需要密钥: %q", kind, err.Error())
		}
	}
}

func TestCreateProviderRejectsUnknownKind(t *testing.T) {
	s, ctx := newStore(t)
	for _, kind := range []string{"", "anthropic", "OpenAI"} {
		_, err := s.CreateProvider(ctx,
			&domain.AgentProvider{Name: "野 kind", Kind: kind, Enabled: true}, "sk-x-0001-abcd")
		if !errors.Is(err, domain.ErrValidation) {
			t.Errorf("kind=%q 应报 ErrValidation, got %v", kind, err)
		}
	}
}

// TestProviderReadPathsNeverReturnPlaintext 是这个模块最关键的一条：
// 只要有任何一条读取路径漏出原文，密钥就会一路流到界面和日志里。
func TestProviderReadPathsNeverReturnPlaintext(t *testing.T) {
	s, ctx := newStore(t)
	const key = "sk-proj-VERYSECRET-f3a2"
	created := mustProvider(t, s, ctx, "OpenAI", domain.ProviderOpenAI, key)

	assertMasked := func(label string, p *domain.AgentProvider) {
		t.Helper()
		if p.APIKeyMasked == key || strings.Contains(p.APIKeyMasked, "VERYSECRET") {
			t.Fatalf("%s 漏出了明文: %q", label, p.APIKeyMasked)
		}
		if p.APIKeyMasked != "sk-…f3a2" {
			t.Errorf("%s 的掩码 = %q, 期望 sk-…f3a2", label, p.APIKeyMasked)
		}
		if !p.HasAPIKey {
			t.Errorf("%s 的 has_api_key = false, 期望 true", label)
		}
	}
	assertMasked("CreateProvider", created)

	got, err := s.GetProvider(ctx, created.ID)
	if err != nil {
		t.Fatalf("get provider: %v", err)
	}
	assertMasked("GetProvider", got)

	list, err := s.ListProviders(ctx)
	if err != nil {
		t.Fatalf("list providers: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("供应商数 = %d, 期望 1", len(list))
	}
	assertMasked("ListProviders", list[0])

	// 明文只有这一个入口。
	plain, err := s.ProviderAPIKey(ctx, created.ID)
	if err != nil {
		t.Fatalf("provider api key: %v", err)
	}
	if plain != key {
		t.Errorf("ProviderAPIKey = %q, 期望原样返回明文", plain)
	}
}

func TestMaskAPIKeyShortKeys(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"a", "***"},
		{"sk-1234", "***"},       // 7 位：前 3 后 4 会把它整个还原出来
		{"sk-12345", "sk-…2345"}, // 8 位起才够掩
		{"sk-proj-abcdef-f3a2", "sk-…f3a2"},
	}
	for _, c := range cases {
		if got := maskAPIKey(c.in); got != c.want {
			t.Errorf("maskAPIKey(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

func TestProviderMaskedWhenNoKey(t *testing.T) {
	s, ctx := newStore(t)
	p := mustProvider(t, s, ctx, "本地 Ollama", domain.ProviderOllama, "")
	if p.HasAPIKey || p.APIKeyMasked != "" {
		t.Errorf("没有密钥时 has_api_key=%v masked=%q, 期望 false/空串", p.HasAPIKey, p.APIKeyMasked)
	}
}

func TestFirstProviderBecomesDefault(t *testing.T) {
	s, ctx := newStore(t)
	first := mustProvider(t, s, ctx, "第一个", domain.ProviderOllama, "")
	if !first.IsDefault {
		t.Error("第一个供应商应自动成为默认")
	}
	second := mustProvider(t, s, ctx, "第二个", domain.ProviderOllama, "")
	if second.IsDefault {
		t.Error("第二个供应商不该自动抢走默认")
	}
}

func TestSetDefaultProviderIsExclusive(t *testing.T) {
	s, ctx := newStore(t)
	a := mustProvider(t, s, ctx, "A", domain.ProviderOllama, "")
	b := mustProvider(t, s, ctx, "B", domain.ProviderOllama, "")

	if err := s.SetDefaultProvider(ctx, b.ID); err != nil {
		t.Fatalf("set default: %v", err)
	}
	list, err := s.ListProviders(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	defaults := map[string]bool{}
	for _, p := range list {
		defaults[p.ID] = p.IsDefault
	}
	if defaults[a.ID] {
		t.Error("设 B 为默认后 A 仍是默认")
	}
	if !defaults[b.ID] {
		t.Error("B 没有成为默认")
	}

	// 重复设同一个不该撞上部分唯一索引。
	if err := s.SetDefaultProvider(ctx, b.ID); err != nil {
		t.Fatalf("重复设默认失败: %v", err)
	}
	if err := s.SetDefaultProvider(ctx, "apv_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("设不存在的供应商为默认应报 ErrNotFound, got %v", err)
	}
}

func TestDeleteDefaultProviderPromotesOldestEnabled(t *testing.T) {
	s, ctx := newStore(t)
	first := mustProvider(t, s, ctx, "最早的", domain.ProviderOllama, "")
	second := mustProvider(t, s, ctx, "后来的", domain.ProviderOllama, "")

	// 让 second 当默认，删掉它之后应该由最早创建的 first 顶上。
	if err := s.SetDefaultProvider(ctx, second.ID); err != nil {
		t.Fatalf("set default: %v", err)
	}
	if err := s.DeleteProvider(ctx, second.ID); err != nil {
		t.Fatalf("delete default provider: %v", err)
	}
	got, err := s.GetProvider(ctx, first.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.IsDefault {
		t.Error("删掉默认供应商后没有把最早创建的那个提为默认")
	}

	// 删到一个不剩时允许没有默认，不该报错。
	if err := s.DeleteProvider(ctx, first.ID); err != nil {
		t.Fatalf("删最后一个供应商: %v", err)
	}
	list, err := s.ListProviders(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("剩余供应商 = %d, 期望 0", len(list))
	}
	if err := s.DeleteProvider(ctx, first.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("重复删除应报 ErrNotFound, got %v", err)
	}
}

func TestDeleteDefaultSkipsDisabledCandidates(t *testing.T) {
	s, ctx := newStore(t)
	disabled, err := s.CreateProvider(ctx,
		&domain.AgentProvider{Name: "停用的", Kind: domain.ProviderOllama, Enabled: false}, "")
	if err != nil {
		t.Fatalf("create disabled: %v", err)
	}
	cur := mustProvider(t, s, ctx, "当前默认", domain.ProviderOllama, "")
	if err := s.SetDefaultProvider(ctx, cur.ID); err != nil {
		t.Fatalf("set default: %v", err)
	}
	if err := s.DeleteProvider(ctx, cur.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, err := s.GetProvider(ctx, disabled.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.IsDefault {
		t.Error("停用的供应商不该被提为默认")
	}
}

// TestUpdateProviderAPIKeyTriState 覆盖指针三态：不传 / 空串 / 有值。
func TestUpdateProviderAPIKeyTriState(t *testing.T) {
	s, ctx := newStore(t)
	p := mustProvider(t, s, ctx, "OpenAI", domain.ProviderOpenAI, "sk-old-000000-1111")

	// 1) 不传：密钥原样保留。
	name := "改个名字"
	out, err := s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{Name: &name})
	if err != nil {
		t.Fatalf("update without api_key: %v", err)
	}
	// 18 位的密钥按保险箱的脱敏规则只留后 4。
	if !out.HasAPIKey || out.APIKeyMasked != "…1111" {
		t.Errorf("不传 api_key 时掩码 = %q has=%v, 期望保留原密钥", out.APIKeyMasked, out.HasAPIKey)
	}
	if plain, _ := s.ProviderAPIKey(ctx, p.ID); plain != "sk-old-000000-1111" {
		t.Errorf("不传 api_key 却把库里的明文改成了 %q", plain)
	}

	// 2) 有值：覆盖。
	newKey := "sk-new-000000-9999"
	out, err = s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{APIKey: &newKey})
	if err != nil {
		t.Fatalf("update with api_key: %v", err)
	}
	if out.APIKeyMasked != "…9999" {
		t.Errorf("覆盖后掩码 = %q, 期望 …9999", out.APIKeyMasked)
	}
	if plain, _ := s.ProviderAPIKey(ctx, p.ID); plain != newKey {
		t.Errorf("覆盖后明文 = %q, 期望 %q", plain, newKey)
	}

	// 3) 空串清除：openai 必须有密钥，所以清空会被拒。
	empty := ""
	if _, err := s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{APIKey: &empty}); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("清空 openai 的密钥应报 ErrValidation, got %v", err)
	}

	// 3') 换成 ollama 之后再清空就该成功。
	ollama := domain.ProviderOllama
	if _, err := s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{Kind: &ollama, APIKey: &empty}); err != nil {
		t.Fatalf("ollama 清空密钥: %v", err)
	}
	cleared, err := s.GetProvider(ctx, p.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if cleared.HasAPIKey || cleared.APIKeyMasked != "" {
		t.Errorf("清空后 has=%v masked=%q, 期望 false/空串", cleared.HasAPIKey, cleared.APIKeyMasked)
	}
	if plain, _ := s.ProviderAPIKey(ctx, p.ID); plain != "" {
		t.Errorf("清空后库里还留着 %q", plain)
	}
}

func TestUpdateProviderKindChangeResetsBaseURL(t *testing.T) {
	s, ctx := newStore(t)
	p := mustProvider(t, s, ctx, "OpenAI", domain.ProviderOpenAI, "sk-000000-1111")

	gemini := domain.ProviderGemini
	out, err := s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{Kind: &gemini})
	if err != nil {
		t.Fatalf("switch kind: %v", err)
	}
	if out.BaseURL != "https://generativelanguage.googleapis.com/v1beta" {
		t.Errorf("换 kind 后 base_url = %q, 期望换成新 kind 的默认端点", out.BaseURL)
	}

	// 同时显式给了 base_url 就以它为准。
	custom := "https://proxy.internal/gemini/"
	out, err = s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{Kind: &gemini, BaseURL: &custom})
	if err != nil {
		t.Fatalf("switch kind with base_url: %v", err)
	}
	if out.BaseURL != "https://proxy.internal/gemini" {
		t.Errorf("base_url = %q, 期望 https://proxy.internal/gemini", out.BaseURL)
	}
}

func TestUpdateProviderValidatesAndNotFound(t *testing.T) {
	s, ctx := newStore(t)
	p := mustProvider(t, s, ctx, "OpenAI", domain.ProviderOpenAI, "sk-000000-1111")

	blank := "   "
	if _, err := s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{Name: &blank}); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("空 name 应报 ErrValidation, got %v", err)
	}
	bad := "anthropic"
	if _, err := s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{Kind: &bad}); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("非法 kind 应报 ErrValidation, got %v", err)
	}
	if _, err := s.UpdateProvider(ctx, "apv_nope", domain.AgentProviderInput{}); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("不存在的 id 应报 ErrNotFound, got %v", err)
	}
	if _, err := s.GetProvider(ctx, "apv_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("GetProvider 不存在应报 ErrNotFound, got %v", err)
	}
	if _, err := s.ProviderAPIKey(ctx, "apv_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("ProviderAPIKey 不存在应报 ErrNotFound, got %v", err)
	}
}

func TestUpdateProviderExtraRoundTrip(t *testing.T) {
	s, ctx := newStore(t)
	p := mustProvider(t, s, ctx, "本地", domain.ProviderOllama, "")
	if len(p.Extra) != 0 {
		t.Errorf("默认 extra = %v, 期望空对象", p.Extra)
	}

	extra := map[string]any{"temperature": 0.2}
	out, err := s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{Extra: &extra})
	if err != nil {
		t.Fatalf("update extra: %v", err)
	}
	if got, _ := out.Extra["temperature"].(float64); got != 0.2 {
		t.Errorf("extra.temperature = %v, 期望 0.2", out.Extra["temperature"])
	}
	// 不传 extra 时不该被清掉。
	name := "改名"
	out, err = s.UpdateProvider(ctx, p.ID, domain.AgentProviderInput{Name: &name})
	if err != nil {
		t.Fatalf("update name: %v", err)
	}
	if _, ok := out.Extra["temperature"]; !ok {
		t.Error("不传 extra 时把已有的 extra 清掉了")
	}
}

func TestListProvidersOrdersDefaultFirst(t *testing.T) {
	s, ctx := newStore(t)
	mustProvider(t, s, ctx, "A", domain.ProviderOllama, "")
	b := mustProvider(t, s, ctx, "B", domain.ProviderOllama, "")
	if err := s.SetDefaultProvider(ctx, b.ID); err != nil {
		t.Fatalf("set default: %v", err)
	}
	list, err := s.ListProviders(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 || list[0].ID != b.ID {
		t.Fatalf("列表首位 = %v, 期望默认供应商 %s 排最前", list, b.ID)
	}
}
