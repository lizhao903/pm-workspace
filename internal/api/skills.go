// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 技能（AG-01b2，0033）。内置在 internal/agent，自定义在 store，插件的从 Registry 取，这里合成一个列表 ---

// skillAgent 是挂着这个技能的 Agent（SPEC-settings-15.5「在用的 Agent」、16.11 删除确认文案）。
type skillAgent struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type skillView struct {
	store.Skill
	Agents []skillAgent `json:"agents"`
}

// allSkills 是内置、在跑的插件、自定义三种来源的技能，按这个顺序；插件技能 id 撞了前面的就跳过。
func (s *Server) allSkills(ctx context.Context) ([]store.Skill, error) {
	out := agent.BuiltinSkills()
	seen := map[string]bool{}
	for _, k := range out {
		seen[k.ID] = true
	}
	if s.opt.Plugins != nil {
		for _, k := range s.opt.Plugins.Skills() {
			if seen[k.ID] {
				s.log.Warn("plugin skill id taken, skipped", "skill", k.ID, "plugin", k.Source)
				continue
			}
			seen[k.ID] = true
			out = append(out, k)
		}
	}
	custom, err := s.st.ListSkills(ctx)
	if err != nil {
		return nil, err
	}
	for _, k := range custom {
		if !seen[k.ID] {
			out = append(out, *k)
		}
	}
	return out, nil
}

// findSkill 按 id 取一个技能，来源依次是内置、在跑的插件、自定义；都没有回 404。
func (s *Server) findSkill(ctx context.Context, id string) (*store.Skill, error) {
	if k, ok := agent.BuiltinSkill(id); ok {
		return &k, nil
	}
	if s.opt.Plugins != nil {
		for _, k := range s.opt.Plugins.Skills() {
			if k.ID == id {
				return &k, nil
			}
		}
	}
	return s.st.GetSkill(ctx, id)
}

// skillAgents 是 技能 id -> 挂着它的 Agent，Agent 按新建的在前。
func (s *Server) skillAgents(ctx context.Context) (map[string][]skillAgent, error) {
	agents, err := s.st.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string][]skillAgent{}
	for _, a := range agents {
		for _, id := range a.Skills {
			out[id] = append(out[id], skillAgent{ID: a.ID, Name: a.Name})
		}
	}
	return out, nil
}

func (s *Server) skillView(ctx context.Context, k *store.Skill) (skillView, error) {
	m, err := s.skillAgents(ctx)
	if err != nil {
		return skillView{}, err
	}
	return newSkillView(*k, m), nil
}

func newSkillView(k store.Skill, m map[string][]skillAgent) skillView {
	if k.Uses == nil {
		k.Uses = []string{}
	}
	ag := m[k.ID]
	if ag == nil {
		ag = []skillAgent{}
	}
	return skillView{Skill: k, Agents: ag}
}

// agentSkills 是 Agent 挂的技能，按挂载顺序；取不到的（插件停用、已删除）跳过，不报错。
func (s *Server) agentSkills(ctx context.Context, a *domain.Agent) []store.Skill {
	if a == nil {
		return nil
	}
	var out []store.Skill
	for _, id := range a.Skills {
		k, err := s.findSkill(ctx, id)
		if err != nil {
			s.log.Debug("agent skill unavailable, skipped", "agent", a.ID, "skill", id, "err", err)
			continue
		}
		out = append(out, *k)
	}
	return out
}

// readonlySkill 内置和插件技能只读，改、删回 409；verb 是「改」或「删」。
func readonlySkill(k *store.Skill, verb string) error {
	switch k.Source {
	case store.SkillCustom:
		return nil
	case store.SkillBuiltin:
		return conflictf("内置技能不能%s；要按自己的习惯调，先复制一份", verb)
	default:
		return conflictf("技能「%s」由插件 %s 提供，不能在这里%s", k.Name, k.Source, verb)
	}
}

func (s *Server) handleListSkills(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	all, err := s.allSkills(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	m, err := s.skillAgents(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	source := strings.TrimSpace(r.URL.Query().Get("source"))
	items := []skillView{}
	for _, k := range all {
		if source == "" || k.Source == source {
			items = append(items, newSkillView(k, m))
		}
	}
	respondList(w, items, Meta{Total: len(items)})
}

func (s *Server) handleGetSkill(w http.ResponseWriter, r *http.Request) {
	k, err := s.findSkill(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	v, err := s.skillView(r.Context(), k)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, v)
}

// skillCreateReq：copy_from 给了时没给的字段从那个技能复制，名称默认加「（副本）」（SPEC-settings-16.9）。
type skillCreateReq struct {
	store.SkillInput
	CopyFrom string `json:"copy_from"`
}

func (s *Server) handleCreateSkill(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in skillCreateReq
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	from := strings.TrimSpace(in.CopyFrom)
	if from != "" {
		src, err := s.findSkill(ctx, from)
		if err != nil {
			if errors.Is(err, domain.ErrNotFound) {
				s.fail(w, r, validationf("要复制的技能 %s 不存在", from))
				return
			}
			s.fail(w, r, err)
			return
		}
		name := src.Name + "（副本）"
		uses := append([]string{}, src.Uses...)
		fill := func(p **string, v string) {
			if *p == nil {
				*p = &v
			}
		}
		fill(&in.Name, name)
		fill(&in.Desc, src.Desc)
		fill(&in.Instructions, src.Instructions)
		fill(&in.When, src.When)
		if in.Uses == nil {
			in.Uses = &uses
		}
	}
	k, err := s.st.CreateSkill(ctx, in.SkillInput)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	detail := map[string]any{"name": k.Name}
	if from != "" {
		detail["copy_from"] = from
	}
	s.auditConfig(r, "create", "skill", k.ID, "新建技能「"+k.Name+"」", detail)
	v, err := s.skillView(ctx, k)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, v)
}

// skillFields 是 PATCH 认的字段，审计只记这些名字；其余键（id、source、agents）忽略。
var skillFields = map[string]bool{"name": true, "desc": true, "instructions": true, "when": true, "uses": true}

func (s *Server) handleUpdateSkill(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	keys, err := patchKeys(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var in store.SkillInput
	if err := json.Unmarshal(body, &in); err != nil {
		s.fail(w, r, validationf("malformed JSON body: %v", err))
		return
	}
	cur, err := s.findSkill(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := readonlySkill(cur, "改"); err != nil {
		s.fail(w, r, err)
		return
	}
	k, err := s.st.UpdateSkill(ctx, cur.ID, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	fields := map[string]bool{}
	for key := range keys {
		fields[key] = skillFields[key]
	}
	s.auditConfig(r, "update", "skill", k.ID, "修改技能「"+k.Name+"」", map[string]any{"fields": givenFields(fields)})
	v, err := s.skillView(ctx, k)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, v)
}

// handleDeleteSkill 回删掉的那条，agents 是被摘掉它的 Agent（SPEC-settings-16.11）。
func (s *Server) handleDeleteSkill(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cur, err := s.findSkill(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := readonlySkill(cur, "删"); err != nil {
		s.fail(w, r, err)
		return
	}
	before, err := s.skillAgents(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	k, detached, err := s.st.DeleteSkill(ctx, cur.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	names := map[string]string{}
	for _, a := range before[k.ID] {
		names[a.ID] = a.Name
	}
	ag := make([]skillAgent, 0, len(detached))
	for _, id := range detached {
		ag = append(ag, skillAgent{ID: id, Name: names[id]})
	}
	s.auditConfig(r, "delete", "skill", k.ID, "删除技能「"+k.Name+"」",
		map[string]any{"name": k.Name, "detached_agents": detached})
	respondData(w, http.StatusOK, skillView{Skill: *k, Agents: ag})
}
