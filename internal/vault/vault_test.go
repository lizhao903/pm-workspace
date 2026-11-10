// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package vault

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

const plain = "sk-test-123"

// openTest 建一个迁移过的临时库，主密钥一律走密钥文件，不碰钥匙串。
func openTest(t *testing.T) (*Vault, string) {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "pm.db")
	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	_ = d.Close()
	v, src, err := Open(ctx, path, KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatal(err)
	}
	if src != SourceFile {
		t.Fatalf("source = %s, 测试必须走密钥文件", src)
	}
	t.Cleanup(func() { _ = v.Close() })
	return v, path
}

func TestCreateListResolve(t *testing.T) {
	v, _ := openTest(t)
	ctx := context.Background()
	s, err := v.Create(ctx, "OpenAI", "", plain)
	if err != nil {
		t.Fatal(err)
	}
	if s.Kind != DefaultKind || s.Version != 1 || s.Hint == "" || strings.Contains(s.Hint, plain) {
		t.Fatalf("unexpected secret %+v", s)
	}
	list, err := v.List(ctx)
	if err != nil || len(list) != 1 || list[0].ID != s.ID {
		t.Fatalf("list = %+v, %v", list, err)
	}
	got, err := v.Resolve(ctx, s.ID)
	if err != nil || got != plain {
		t.Fatalf("resolve = %q, %v", got, err)
	}
}

func TestRotateDropsOldValue(t *testing.T) {
	v, _ := openTest(t)
	ctx := context.Background()
	s, _ := v.Create(ctx, "k", "api_key", plain)

	var oldNonce, oldCT []byte
	if err := v.d.R.QueryRow(`SELECT nonce, ciphertext FROM vault_secrets WHERE id=?`, s.ID).
		Scan(&oldNonce, &oldCT); err != nil {
		t.Fatal(err)
	}

	r, err := v.Rotate(ctx, s.ID, "sk-new-value-456789012345")
	if err != nil {
		t.Fatal(err)
	}
	if r.Version != 2 || r.RotatedAt == nil || r.Hint != "sk-…2345" {
		t.Fatalf("rotated = %+v", r)
	}
	got, _ := v.Resolve(ctx, s.ID)
	if got != "sk-new-value-456789012345" {
		t.Fatalf("resolve after rotate = %q", got)
	}
	// 把旧密文塞回去也解不开：version 在附加数据里，旧版本的密文过不了校验。
	if _, err := v.d.W.Exec(`UPDATE vault_secrets SET nonce=?, ciphertext=? WHERE id=?`,
		oldNonce, oldCT, s.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := v.Resolve(ctx, s.ID); err == nil {
		t.Fatalf("旧密文回放后居然解出了 %q", got)
	}
}

func TestSwappedCiphertextRejected(t *testing.T) {
	v, _ := openTest(t)
	ctx := context.Background()
	a, _ := v.Create(ctx, "a", "", plain)
	b, _ := v.Create(ctx, "b", "", "another-secret-value")
	if _, err := v.d.W.Exec(`UPDATE vault_secrets SET nonce=(SELECT nonce FROM vault_secrets WHERE id=?),
		ciphertext=(SELECT ciphertext FROM vault_secrets WHERE id=?) WHERE id=?`, a.ID, a.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Resolve(ctx, b.ID); err == nil {
		t.Fatal("挪到别的行的密文不该解得开")
	}
}

func TestWrongMasterKey(t *testing.T) {
	v, path := openTest(t)
	ctx := context.Background()
	s, _ := v.Create(ctx, "k", "", plain)

	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	other, _ := New(d, bytes.Repeat([]byte{7}, 32))
	_, err = other.Resolve(ctx, s.ID)
	if err == nil || !strings.Contains(err.Error(), "master key") {
		t.Fatalf("err = %v, 期望说明主密钥不对", err)
	}
	if strings.Contains(err.Error(), plain) {
		t.Fatal("错误文本带了明文")
	}
}

func TestDeleteAndNotFound(t *testing.T) {
	v, _ := openTest(t)
	ctx := context.Background()
	s, _ := v.Create(ctx, "k", "", plain)
	if err := v.Delete(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Resolve(ctx, s.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("resolve deleted = %v", err)
	}
	if err := v.Delete(ctx, s.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("delete twice = %v", err)
	}
	if _, err := v.Rotate(ctx, s.ID, "x-long-enough-value"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("rotate deleted = %v", err)
	}
}

func TestValidation(t *testing.T) {
	v, _ := openTest(t)
	ctx := context.Background()
	cases := []struct{ name, kind, value string }{
		{"", "", plain},
		{"k", "", "   "},
		{"k", "Bad Kind", plain},
		{strings.Repeat("名", maxNameRunes+1), "", plain},
		{"k", "", strings.Repeat("x", maxValueBytes+1)},
	}
	for _, c := range cases {
		if _, err := v.Create(ctx, c.name, c.kind, c.value); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("Create(%q,%q,len %d) = %v, 期望 validation", c.name, c.kind, len(c.value), err)
		}
	}
}

// TestPlaintextNotInDBFile 直接搜库文件（含 WAL）的原始字节。
func TestPlaintextNotInDBFile(t *testing.T) {
	v, path := openTest(t)
	ctx := context.Background()
	s, _ := v.Create(ctx, "k", "", plain)
	if _, err := v.Rotate(ctx, s.ID, plain+"-rotated"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.d.W.Exec(`PRAGMA wal_checkpoint(FULL)`); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(path + "*")
	if len(files) == 0 {
		t.Fatal("没找到库文件")
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(b, []byte(plain)) {
			t.Errorf("%s 里搜到了明文", filepath.Base(f))
		}
	}
}

func TestHint(t *testing.T) {
	cases := map[string]string{
		plain:                        "***",
		"abcdefghijklmn":             "…klmn",
		"sk-proj-abcdefghijklmn3f2a": "sk-…3f2a",
		"短":                          "***",
	}
	for in, want := range cases {
		if got := Hint(in); got != want {
			t.Errorf("Hint(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestKeyFile(t *testing.T) {
	dir := t.TempDir()
	k1, src, err := LoadMasterKey(dir, KeyOptions{})
	if err != nil || src != SourceFile || len(k1) != keyLen {
		t.Fatalf("first load: %v %s", err, src)
	}
	fi, err := os.Stat(filepath.Join(dir, KeyFileName))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode = %v, %v", fi.Mode().Perm(), err)
	}
	k2, _, err := LoadMasterKey(dir, KeyOptions{})
	if err != nil || !bytes.Equal(k1, k2) {
		t.Fatal("第二次加载换了一把密钥")
	}
	if err := os.Chmod(filepath.Join(dir, KeyFileName), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadMasterKey(dir, KeyOptions{}); err == nil || !strings.Contains(err.Error(), "0600") {
		t.Fatalf("权限放宽后应拒绝，got %v", err)
	}
}
