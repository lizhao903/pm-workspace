package sqlite

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func sp(s string) *string { return &s }

func TestSkillCRUDAndDetach(t *testing.T) {
	s, ctx := newStore(t)

	for name, in := range map[string]store.SkillInput{
		"名称为空":  {Name: sp(" "), Instructions: sp("做")},
		"怎么做为空": {Name: sp("竞品")},
		"名称太长":  {Name: sp(strings.Repeat("字", skillNameMax+1)), Instructions: sp("做")},
	} {
		if _, err := s.CreateSkill(ctx, in); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("%s：err = %v，期望校验错误", name, err)
		}
	}

	uses := []string{" 网页搜索 ", "网页搜索", "", "写文档"}
	k, err := s.CreateSkill(ctx, store.SkillInput{Name: sp(" 竞品分析 "), Desc: sp("对比"), Instructions: sp("每家一行"), When: sp("要对比时"), Uses: &uses})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(k.ID, "sk_") || k.Name != "竞品分析" || k.Source != store.SkillCustom || k.When != "要对比时" ||
		!slices.Equal(k.Uses, []string{"网页搜索", "写文档"}) || k.CreatedAt.IsZero() {
		t.Fatalf("新建 = %+v", k)
	}
	k2, err := s.CreateSkill(ctx, store.SkillInput{Name: sp("周报"), Instructions: sp("按项目")})
	if err != nil {
		t.Fatal(err)
	}
	if k2.Uses == nil || len(k2.Uses) != 0 {
		t.Errorf("uses 应当是空数组：%v", k2.Uses)
	}

	if _, err := s.UpdateSkill(ctx, k.ID, store.SkillInput{Instructions: sp(" ")}); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("怎么做改成空应当报错：%v", err)
	}
	u, err := s.UpdateSkill(ctx, k.ID, store.SkillInput{Desc: sp("按功能、价格对比")})
	if err != nil || u.Desc != "按功能、价格对比" || u.Instructions != "每家一行" {
		t.Fatalf("改 = %+v, %v", u, err)
	}
	list, err := s.ListSkills(ctx)
	if err != nil || len(list) != 2 || list[0].ID != k2.ID {
		t.Fatalf("列表应当新建的在前：%v, %v", list, err)
	}

	// 两个 Agent 挂着它，一个没挂；删了之后挂着的摘掉，其余技能顺序不变
	p, err := s.CreateProvider(ctx, &domain.AgentProvider{Name: "本机", Kind: domain.ProviderOllama, Model: "m", Enabled: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	mk := func(name string, skills ...string) *domain.Agent {
		a, err := s.CreateAgent(ctx, domain.AgentInput{Name: sp(name), ProviderID: &p.ID, Skills: &skills})
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	a1 := mk("甲", "sk_weekly", k.ID, k2.ID)
	a2 := mk("乙", k.ID)
	a3 := mk("丙", k2.ID)

	gone, detached, err := s.DeleteSkill(ctx, k.ID)
	if err != nil || gone.ID != k.ID {
		t.Fatalf("删除 = %v, %v", gone, err)
	}
	if !slices.Equal(detached, []string{a2.ID, a1.ID}) {
		t.Errorf("摘掉的 Agent = %v，期望 [%s %s]", detached, a2.ID, a1.ID)
	}
	for _, c := range []struct {
		a    *domain.Agent
		want []string
	}{{a1, []string{"sk_weekly", k2.ID}}, {a2, []string{}}, {a3, []string{k2.ID}}} {
		got, err := s.GetAgent(ctx, c.a.ID)
		if err != nil || !slices.Equal(got.Skills, c.want) {
			t.Errorf("%s 的技能 = %v，期望 %v（%v）", c.a.Name, got.Skills, c.want, err)
		}
	}
	if _, err := s.GetSkill(ctx, k.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("删了还取得到：%v", err)
	}
	if _, _, err := s.DeleteSkill(ctx, k.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("再删应当 404：%v", err)
	}
}
