package sqlite

import (
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 0045：Agent 的思考档位，和 agent_settings 的读写。
func TestAgentThinkingAndSettings(t *testing.T) {
	s, ctx := newStore(t)
	p, err := s.CreateProvider(ctx, &domain.AgentProvider{Name: "本机", Kind: domain.ProviderOllama, Model: "m", Enabled: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.CreateAgent(ctx, domain.AgentInput{Name: sp("分诊"), ProviderID: &p.ID})
	if err != nil || a.Thinking != domain.ThinkingDefault {
		t.Fatalf("新建默认 default：%+v %v", a, err)
	}
	if a, err = s.UpdateAgent(ctx, a.ID, domain.AgentInput{Thinking: sp("off")}); err != nil || a.Thinking != "off" {
		t.Fatalf("改成 off：%v %v", a, err)
	}
	if _, err = s.UpdateAgent(ctx, a.ID, domain.AgentInput{Thinking: sp("max")}); err == nil {
		t.Fatal("不认识的档位应报错")
	}
	if a, err = s.UpdateAgent(ctx, a.ID, domain.AgentInput{Thinking: sp("")}); err != nil || a.Thinking != "default" {
		t.Fatalf("空串按 default：%v %v", a, err)
	}

	if v, err := s.AgentSetting(ctx, "scenario:background"); v != nil || err != nil {
		t.Fatalf("没有的设置回 nil：%s %v", v, err)
	}
	for _, v := range []string{`"ag_1"`, `"ag_2"`} {
		if err := s.SetAgentSetting(ctx, "scenario:background", []byte(v)); err != nil {
			t.Fatal(err)
		}
	}
	if v, _ := s.AgentSetting(ctx, "scenario:background"); string(v) != `"ag_2"` {
		t.Fatalf("覆盖写：%s", v)
	}
	if err := s.SetAgentSetting(ctx, "k", []byte("{")); err == nil {
		t.Fatal("坏 JSON 应报错")
	}
}
