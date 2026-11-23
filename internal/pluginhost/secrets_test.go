// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/vault"
)

// memSecrets 是内存版保险箱，只实现 SecretStore 要的几个方法。
type memSecrets struct {
	mu   sync.Mutex
	n    int
	meta map[string]vault.Secret
	val  map[string]string
}

func newMemSecrets() *memSecrets {
	return &memSecrets{meta: map[string]vault.Secret{}, val: map[string]string{}}
}

func (m *memSecrets) List(context.Context) ([]vault.Secret, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []vault.Secret
	for _, s := range m.meta {
		out = append(out, s)
	}
	return out, nil
}

func (m *memSecrets) Create(_ context.Context, name, kind, value string) (*vault.Secret, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.n++
	s := vault.Secret{ID: "sec_" + strconv.Itoa(m.n), Name: name, Kind: kind, Version: 1}
	m.meta[s.ID] = s
	m.val[s.ID] = value
	return &s, nil
}

func (m *memSecrets) Rotate(_ context.Context, id, value string) (*vault.Secret, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.meta[id]
	if !ok {
		return nil, errors.New("not found")
	}
	s.Version++
	m.meta[id] = s
	m.val[id] = value
	return &s, nil
}

func (m *memSecrets) Delete(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.meta, id)
	delete(m.val, id)
	return nil
}

func (m *memSecrets) Resolve(_ context.Context, id string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.val[id]
	if !ok {
		return "", errors.New("not found")
	}
	return v, nil
}

func secretCall(t *testing.T, fn func(context.Context, json.RawMessage) (any, error), params map[string]any) (map[string]any, error) {
	t.Helper()
	raw, _ := json.Marshal(params)
	out, err := fn(context.Background(), raw)
	if err != nil {
		return nil, err
	}
	m, _ := out.(map[string]any)
	return m, nil
}

func TestHostSecrets(t *testing.T) {
	obj := testManifestObj(platformKey(), "bin/hello_world")
	obj["permissions"] = []any{"secrets:alpha"}
	obj["permissions_reason"] = map[string]any{"secrets:alpha": "存登录令牌"}
	dir := t.TempDir()
	writeTestPackage(t, dir, obj)
	store := newMemSecrets()
	h, _ := newFakeHost(t, Options{Secrets: store})
	ctx := context.Background()
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"secrets:alpha"}); err != nil {
		t.Fatalf("安装失败：%v", err)
	}
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	p := h.lookupProc("hello_world")
	if p == nil {
		t.Fatal("进程没起来")
	}

	// 没存过：空值，不报错
	got, err := secretCall(t, p.secretsGet, map[string]any{"scope": "alpha"})
	if err != nil || got["value"] != "" {
		t.Fatalf("没存过应回空值：%v %v", got, err)
	}
	// 存、读、覆盖
	if _, err := secretCall(t, p.secretsSet, map[string]any{"scope": "alpha", "value": `{"t":1}`}); err != nil {
		t.Fatalf("set: %v", err)
	}
	if _, err := secretCall(t, p.secretsSet, map[string]any{"scope": "alpha", "value": `{"t":2}`}); err != nil {
		t.Fatalf("覆盖 set: %v", err)
	}
	got, _ = secretCall(t, p.secretsGet, map[string]any{"scope": "alpha"})
	if got["value"] != `{"t":2}` {
		t.Fatalf("读回不对：%v", got)
	}
	list, _ := store.List(ctx)
	if len(list) != 1 || list[0].Name != "plugin:hello_world:alpha" || list[0].Kind != pluginSecretKind {
		t.Fatalf("保险箱里应只有一条按插件命名的凭证：%+v", list)
	}
	// 别的插件同名 scope 的凭证读不到（按名字隔离）
	_, _ = store.Create(ctx, "plugin:other:alpha", pluginSecretKind, "x")
	got, _ = secretCall(t, p.secretsGet, map[string]any{"scope": "alpha"})
	if got["value"] != `{"t":2}` {
		t.Fatalf("不该读到别的插件的凭证：%v", got)
	}
	// 没声明的 scope、非法 scope 拒绝
	if _, err := secretCall(t, p.secretsGet, map[string]any{"scope": "beta"}); err == nil {
		t.Fatal("没声明 secrets:beta 应拒绝")
	}
	if _, err := secretCall(t, p.secretsGet, map[string]any{"scope": "../x"}); err == nil {
		t.Fatal("非法 scope 应拒绝")
	}
	// 空值等于删除；delete 幂等
	if _, err := secretCall(t, p.secretsSet, map[string]any{"scope": "alpha", "value": ""}); err != nil {
		t.Fatalf("空值 set: %v", err)
	}
	got, _ = secretCall(t, p.secretsGet, map[string]any{"scope": "alpha"})
	if got["value"] != "" {
		t.Fatalf("空值 set 后应删掉：%v", got)
	}
	if _, err := secretCall(t, p.secretsDelete, map[string]any{"scope": "alpha"}); err != nil {
		t.Fatalf("重复 delete 应幂等：%v", err)
	}
}

func TestHostSecretsWithoutVault(t *testing.T) {
	obj := testManifestObj(platformKey(), "bin/hello_world")
	obj["permissions"] = []any{"secrets:alpha"}
	obj["permissions_reason"] = map[string]any{"secrets:alpha": "存登录令牌"}
	dir := t.TempDir()
	writeTestPackage(t, dir, obj)
	h, _ := newFakeHost(t, Options{})
	ctx := context.Background()
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"secrets:alpha"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	p := h.lookupProc("hello_world")
	if _, err := secretCall(t, p.secretsGet, map[string]any{"scope": "alpha"}); err == nil {
		t.Fatal("没接保险箱时应回 unavailable")
	}
}
