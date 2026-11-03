package connector

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector/oauthfake"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

// TestWithConfig：只认登记来源；快到期先刷新再交出新令牌；暂停回冲突；回调的错误里凭证换成 ***。
func TestWithConfig(t *testing.T) {
	ctx := context.Background()
	s, _, clk := newOAuthStore(t)
	fs := oauthfake.New(3600)
	defer fs.Close()
	c := newOAuthConnector(t, s, fs)

	// 没授权：不交出配置
	called := false
	if err := s.WithConfig(ctx, c.ID, "core", func(Config) error { called = true; return nil }); !errors.Is(err, domain.ErrConflict) || called {
		t.Fatalf("没授权应冲突：%v", err)
	}
	state, code := authorize(t, s, c.ID)
	if res, err := s.CompleteOAuth(ctx, state, code, "", ""); err != nil || !res.OK {
		t.Fatalf("回调 = %+v %v", res, err)
	}
	access, _ := fs.Tokens()

	// 别的来源：按没有这个实例
	if err := s.WithConfig(ctx, c.ID, "video", func(Config) error { called = true; return nil }); !errors.Is(err, ErrNotOwned) ||
		!errors.Is(err, domain.ErrNotFound) || called {
		t.Fatalf("别的来源应拿不到：%v", err)
	}
	if err := s.WithConfig(ctx, "cn_missing", "core", func(Config) error { return nil }); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("没有的实例：%v", err)
	}

	// 离到期还远：不刷新，拿到当前令牌和配置
	var got, base string
	if err := s.WithConfig(ctx, c.ID, "core", func(cfg Config) error {
		got, base = cfg.AccessToken(), cfg.Get("base_url")
		return nil
	}); err != nil || got != access || base != fs.URL {
		t.Fatalf("拿配置 = %q %q %v", got, base, err)
	}

	// 到期前 4 分钟：先刷新，交出新令牌
	clk.add(time.Hour - 4*time.Minute)
	if err := s.WithConfig(ctx, c.ID, "", func(cfg Config) error { got = cfg.AccessToken(); return nil }); err != nil {
		t.Fatal(err)
	}
	if access2, _ := fs.Tokens(); access2 == access || got != access2 {
		t.Fatalf("快到期应先刷新：拿到 %q，服务端 %q", got, access2)
	}

	// 回调的错误：带了凭证原文的抹掉，没带的原样返回
	err := s.WithConfig(ctx, c.ID, "core", func(cfg Config) error { return errors.New("对方回 401：" + cfg.AccessToken()) })
	if err == nil || strings.Contains(err.Error(), got) || !strings.Contains(err.Error(), "***") {
		t.Fatalf("错误里不该有令牌：%v", err)
	}
	if err := s.WithConfig(ctx, c.ID, "core", func(Config) error { return context.Canceled }); !errors.Is(err, context.Canceled) {
		t.Fatalf("没带凭证的错误应原样返回：%v", err)
	}

	// 快到期但刷新失败：令牌还没过期，先用着
	fs.SetFailRefresh(true)
	clk.add(time.Hour - 4*time.Minute)
	if err := s.WithConfig(ctx, c.ID, "core", func(cfg Config) error { called = cfg.AccessToken() == got; return nil }); err != nil || !called {
		t.Fatalf("没过期的令牌应照用：%v", err)
	}
	if cur, _ := s.Get(ctx, c.ID); cur.Status != StatusError || cur.OAuth.RefreshFailedAt == nil {
		t.Fatalf("刷新失败应置为 error：%+v", cur)
	}
	// 过期了、还在退避期：不再去刷，回冲突，不交出过期令牌
	clk.add(5 * time.Minute)
	called = false
	if err := s.WithConfig(ctx, c.ID, "core", func(Config) error { called = true; return nil }); !errors.Is(err, domain.ErrConflict) ||
		!strings.Contains(err.Error(), "令牌已过期") || called {
		t.Fatalf("过期应冲突：%v", err)
	}
	// 过了退避期：再刷一次，仍失败就回刷新的说明
	clk.add(RefreshBackoff)
	if err := s.WithConfig(ctx, c.ID, "core", func(Config) error { called = true; return nil }); !errors.Is(err, domain.ErrConflict) ||
		!strings.Contains(err.Error(), "令牌刷新失败") || called {
		t.Fatalf("刷新失败应冲突：%v", err)
	}

	// 暂停：冲突
	off := false
	if _, err := s.Update(ctx, c.ID, Patch{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if err := s.WithConfig(ctx, c.ID, "core", func(Config) error { called = true; return nil }); !errors.Is(err, domain.ErrConflict) || called {
		t.Fatalf("暂停应冲突：%v", err)
	}
}
