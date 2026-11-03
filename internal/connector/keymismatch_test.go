package connector

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// 主密钥换过（vault.key 丢了重新生成）后旧凭证解不开：重填凭证要能保存（按整组重填），
// 只改配置时回 409 并说清楚要重填，不是 500。
func TestUpdateAfterMasterKeyLost(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "pm.db")
	st, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	open := func() *Store {
		v, _, err := vault.Open(ctx, path, vault.KeyOptions{UseKeychain: false})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = v.Close() })
		defs := NewRegistry()
		if err := defs.Register(Slack(SlackEndpoints{})); err != nil {
			t.Fatal(err)
		}
		s := New(st.DB(), v, defs)
		s.log = slog.New(slog.NewTextHandler(io.Discard, nil))
		return s
	}
	s := open()
	c, err := s.Create(ctx, Input{Tool: "slack", Name: "Slack User", Config: map[string]string{"channels": "#product"},
		Secrets: map[string]string{"bot_token": "xoxp-old", "signing_secret": "sig-old"}})
	if err != nil {
		t.Fatal(err)
	}

	// 主密钥丢了：下次启动生成一把新的
	if err := os.Remove(filepath.Join(dir, vault.KeyFileName)); err != nil {
		t.Fatal(err)
	}
	s = open()

	_, err = s.Update(ctx, c.ID, Patch{Config: map[string]string{"channels": "#feedback"}})
	if !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "重新填") {
		t.Fatalf("只改配置应当 409 并提示重填：%v", err)
	}
	got, err := s.Update(ctx, c.ID, Patch{Secrets: map[string]string{"bot_token": "xoxp-new"}})
	if err != nil {
		t.Fatalf("重填 Token 应当能保存：%v", err)
	}
	if _, ok := got.SecretHints["signing_secret"]; ok {
		t.Fatalf("旧的选填凭证解不开，不该留着提示：%v", got.SecretHints)
	}
	secrets, err := s.resolveSecrets(ctx, got)
	if err != nil || secrets["bot_token"] != "xoxp-new" || len(secrets) != 1 {
		t.Fatalf("重填后：%v %v", secrets, err)
	}
	if _, err := s.Update(ctx, c.ID, Patch{Config: map[string]string{"channels": "#feedback"}}); err != nil {
		t.Fatalf("重填后改配置：%v", err)
	}
}
