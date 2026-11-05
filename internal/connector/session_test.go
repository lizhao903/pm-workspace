package connector

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// TestSaveSession：只收 _ 开头的键；只认登记来源；不出脱敏提示；空串清掉；断开时一起删。
func TestSaveSession(t *testing.T) {
	ctx := context.Background()
	s, _, _ := newOAuthStore(t)
	if err := s.defs.Register(Fake()); err != nil {
		t.Fatal(err)
	}
	c, err := s.Create(ctx, Input{Tool: FakeTool, Secrets: map[string]string{"token": "good-token"}})
	if err != nil {
		t.Fatal(err)
	}
	const cookie = "SESSDATA=session-test-only"
	if _, _, err := s.SaveSession(ctx, c.ID, "core", map[string]string{"cookie": cookie}, ""); !errors.Is(err, ErrSessionKey) {
		t.Fatalf("不是 _ 开头的键应拒绝：%v", err)
	}
	if _, _, err := s.SaveSession(ctx, c.ID, "video", map[string]string{"_cookie": cookie}, ""); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("别的来源应按没有这个实例：%v", err)
	}
	got, touched, err := s.SaveSession(ctx, c.ID, "core", map[string]string{"_cookie": cookie, "_csrf": "csrf-test"}, "某 UP 主")
	if err != nil || len(touched) != 2 || got.Account != "某 UP 主" {
		t.Fatalf("写登录态 = %+v %v %v", got, touched, err)
	}
	if _, ok := got.SecretHints["_cookie"]; ok || got.SecretHints["token"] == "" {
		t.Fatalf("会话键不出提示，原有凭证的提示保留：%v", got.SecretHints)
	}
	var seen, tok string
	if err := s.WithConfig(ctx, c.ID, "core", func(cfg Config) error { seen, tok = cfg.Secret("_cookie"), cfg.Secret("token"); return nil }); err != nil || seen != cookie || tok != "good-token" {
		t.Fatalf("回调拿到 %q %q %v", seen, tok, err)
	}
	// 回调错误里的 Cookie 抹掉
	err = s.WithConfig(ctx, c.ID, "core", func(cfg Config) error { return errors.New("对方回：" + cfg.Secret("_cookie")) })
	if err == nil || strings.Contains(err.Error(), cookie) {
		t.Fatalf("错误里不该有 Cookie：%v", err)
	}
	// 清掉一项，账号不给不改
	got, touched, err = s.SaveSession(ctx, c.ID, "core", map[string]string{"_csrf": ""}, "")
	if err != nil || len(touched) != 1 || got.Account != "某 UP 主" {
		t.Fatalf("清掉一项 = %+v %v %v", got, touched, err)
	}
	// 断开：会话键和 OAuth 令牌一样删掉，Token 凭证保留
	if _, cleared, err := s.Disconnect(ctx, c.ID); err != nil || !cleared {
		t.Fatalf("断开 = %v %v", cleared, err)
	}
	cur, _ := s.Get(ctx, c.ID)
	sec, err := s.resolveSecrets(ctx, cur)
	if err != nil || sec["_cookie"] != "" || sec["token"] != "good-token" {
		t.Fatalf("断开后凭证 = %v %v", sec, err)
	}
}
