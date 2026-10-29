package api

import (
	"context"
	"sort"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 自定义技能的替身只够 handler 跑通；校验是 sqlite 实现的事，那边的测试管。

func (f *fakeStore) ListSkills(context.Context) ([]*store.Skill, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*store.Skill, 0, len(f.skills))
	for _, k := range f.skills {
		c := *k
		out = append(out, &c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (f *fakeStore) GetSkill(_ context.Context, id string) (*store.Skill, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k, ok := f.skills[id]
	if !ok {
		return nil, notFoundf("skill not found")
	}
	c := *k
	return &c, nil
}

func (f *fakeStore) CreateSkill(_ context.Context, in store.SkillInput) (*store.Skill, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	k := &store.Skill{ID: idgen.Prefixed("sk"), Source: store.SkillCustom, Uses: []string{}, CreatedAt: now, UpdatedAt: now}
	applyFakeSkill(k, in)
	if f.skills == nil {
		f.skills = map[string]*store.Skill{}
	}
	f.skills[k.ID] = k
	c := *k
	return &c, nil
}

func (f *fakeStore) UpdateSkill(_ context.Context, id string, in store.SkillInput) (*store.Skill, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k, ok := f.skills[id]
	if !ok {
		return nil, notFoundf("skill not found")
	}
	applyFakeSkill(k, in)
	c := *k
	return &c, nil
}

func (f *fakeStore) DeleteSkill(_ context.Context, id string) (*store.Skill, []string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k, ok := f.skills[id]
	if !ok {
		return nil, nil, notFoundf("skill not found")
	}
	delete(f.skills, id)
	detached := []string{}
	for _, a := range f.agents {
		left := []string{}
		for _, s := range a.Skills {
			if s != id {
				left = append(left, s)
			}
		}
		if len(left) != len(a.Skills) {
			a.Skills = left
			detached = append(detached, a.ID)
		}
	}
	return k, detached, nil
}

func applyFakeSkill(k *store.Skill, in store.SkillInput) {
	if in.Name != nil {
		k.Name = *in.Name
	}
	if in.Desc != nil {
		k.Desc = *in.Desc
	}
	if in.Instructions != nil {
		k.Instructions = *in.Instructions
	}
	if in.When != nil {
		k.When = *in.When
	}
	if in.Uses != nil {
		k.Uses = append([]string{}, *in.Uses...)
	}
}
