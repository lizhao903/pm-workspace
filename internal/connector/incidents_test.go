package connector

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/incident"
)

type noted struct{ got []incident.Report }

func (n *noted) Note(_ context.Context, r incident.Report) { n.got = append(n.got, r) }

// TestIncidentsOnFailure：连通测试失败记错误级 conn:<id>:auth，同步失败记警告 conn:<id>:sync；说明里没有凭证原文。
func TestIncidentsOnFailure(t *testing.T) {
	ctx := context.Background()
	s, _, _ := newOAuthStore(t)
	if err := s.defs.Register(Fake()); err != nil {
		t.Fatal(err)
	}
	n := &noted{}
	s.SetIncidents(n)
	bad := "expired-token-abcdefghijk"
	c, err := s.Create(ctx, Input{Tool: FakeTool, Name: "测试账号", AuthMode: AuthToken, Secrets: map[string]string{"token": bad}})
	if err != nil {
		t.Fatal(err)
	}
	if res, err := s.Test(ctx, c.ID); err != nil || res.OK {
		t.Fatalf("应当测试失败：%+v %v", res, err)
	}
	if _, err := s.RecordSync(ctx, c.ID, "", errors.New("拉取失败：token "+bad+" rejected")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordSync(ctx, c.ID, "", nil); err != nil {
		t.Fatal(err)
	}
	if len(n.got) != 2 {
		t.Fatalf("应记两条（成功的同步不记）：%+v", n.got)
	}
	auth, sync := n.got[0], n.got[1]
	if auth.Fingerprint != "conn:"+c.ID+":auth" || auth.Level != "error" || auth.Module != "连接器" || auth.Title != "测试账号连接失败" {
		t.Fatalf("连接失败那条不对：%+v", auth)
	}
	if sync.Fingerprint != "conn:"+c.ID+":sync" || sync.Level != "warn" || sync.Title != "测试账号同步失败" {
		t.Fatalf("同步失败那条不对：%+v", sync)
	}
	for _, r := range n.got {
		if strings.Contains(r.Message, bad) || r.Source != incident.SourceBackend {
			t.Fatalf("说明里有凭证或来源不对：%+v", r)
		}
	}
}
