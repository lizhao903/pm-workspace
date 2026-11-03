package audit

import (
	"context"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// Store 在 store.Store 外面包一层：删除和 Agent 写操作成功之后记审计，失败不记。
// 配置类（类型、字典、服务商）由 api 的 handler 记，这里不重复。没覆盖的方法原样透传。
//
// 不带 Actor 参数的方法从 ctx 取操作者（WithActor，api 的中间件放进去）。
type Store struct {
	store.Store
	log *Log
}

// WrapStore 给 st 接上审计；log 为 nil 时原样返回 st。
func WrapStore(st store.Store, log *Log) store.Store {
	if log == nil {
		return st
	}
	return &Store{Store: st, log: log}
}

func isAgent(a store.Actor) bool { return a.Source == "agent" }

// note 用显式的操作者记一条。
func (s *Store) note(ctx context.Context, a store.Actor, e Entry) {
	e.Actor, e.Source = domain.ComposeActor(a.Name, a.Session), a.Source
	s.log.Note(ctx, e)
}

// agent 只在 Agent 来源时记一条 Agent 写操作。
func (s *Store) agent(ctx context.Context, a store.Actor, action, targetType, targetID, summary string, detail map[string]any) {
	if !isAgent(a) {
		return
	}
	s.note(ctx, a, Entry{Kind: KindAgent, Action: action, TargetType: targetType, TargetID: targetID, Summary: summary, Detail: detail})
}

func (s *Store) deleted(ctx context.Context, targetType, targetID, summary string, detail map[string]any) {
	s.note(ctx, ActorFrom(ctx), Entry{Kind: KindDelete, Action: "delete", TargetType: targetType, TargetID: targetID, Summary: summary, Detail: detail})
}

func objLabel(o *domain.Object, id string) string {
	if o == nil {
		return id
	}
	if o.Ref != "" {
		return o.Ref + " " + o.Title
	}
	return o.Title
}

func objDetail(o *domain.Object) map[string]any {
	if o == nil {
		return map[string]any{}
	}
	return map[string]any{"ref": o.Ref, "title": o.Title, "type_id": o.TypeID}
}

// --- 对象 ---

func (s *Store) DeleteObject(ctx context.Context, id string, hard bool, a store.Actor) error {
	prev, _ := s.Store.GetObject(ctx, id)
	if err := s.Store.DeleteObject(ctx, id, hard, a); err != nil {
		return err
	}
	d := objDetail(prev)
	d["hard"] = hard
	verb := "删除"
	if hard {
		verb = "彻底删除"
	}
	s.note(ctx, a, Entry{Kind: KindDelete, Action: "delete", TargetType: "object", TargetID: id, Summary: verb + " " + objLabel(prev, id), Detail: d})
	return nil
}

func (s *Store) CreateObject(ctx context.Context, o *domain.Object, a store.Actor) (*domain.Object, error) {
	out, err := s.Store.CreateObject(ctx, o, a)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, a, "create", "object", out.ID, "新建 "+objLabel(out, out.ID), objDetail(out))
	return out, nil
}

func (s *Store) UpdateObject(ctx context.Context, id string, p domain.ObjectPatch, a store.Actor) (*domain.Object, error) {
	out, err := s.Store.UpdateObject(ctx, id, p, a)
	if err != nil {
		return nil, err
	}
	if isAgent(a) {
		d := objDetail(out)
		d["fields"] = patchFields(p)
		s.agent(ctx, a, "update", "object", id, "修改 "+objLabel(out, id), d)
	}
	return out, nil
}

func (s *Store) RestoreObject(ctx context.Context, id string, a store.Actor) (*domain.Object, error) {
	out, err := s.Store.RestoreObject(ctx, id, a)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, a, "restore", "object", id, "恢复 "+objLabel(out, id), objDetail(out))
	return out, nil
}

func (s *Store) AppendProgress(ctx context.Context, objectID string, in domain.ProgressInput, a store.Actor) (*domain.Progress, error) {
	out, err := s.Store.AppendProgress(ctx, objectID, in, a)
	if err != nil {
		return nil, err
	}
	if isAgent(a) {
		d := map[string]any{"progress_id": out.ID, "kind": out.Kind}
		if in.Status != "" {
			d["status"] = in.Status
		}
		s.agent(ctx, a, "progress", "object", objectID, "记进展（"+out.Kind+"）", d)
	}
	return out, nil
}

func (s *Store) ClaimObject(ctx context.Context, objectID string, in domain.ClaimInput, a store.Actor) (*domain.ClaimResult, error) {
	out, err := s.Store.ClaimObject(ctx, objectID, in, a)
	if err != nil {
		return nil, err
	}
	if !out.Already {
		s.agent(ctx, a, "claim", "object", objectID, "领取 "+objLabel(out.Object, objectID), objDetail(out.Object))
	}
	return out, nil
}

// patchFields 列出 PATCH 里给了的字段名，和契约的字段名一致；只记名字不记值。
func patchFields(p domain.ObjectPatch) []string {
	var out []string
	add := func(set bool, name string) {
		if set {
			out = append(out, name)
		}
	}
	add(p.Title != nil, "title")
	add(p.Body != nil, "body")
	add(p.Status != nil, "status")
	add(p.Priority != nil, "priority")
	add(p.OwnerID != nil, "owner_id")
	add(p.ParticipantIDs != nil, "participant_ids")
	add(p.CategoryID != nil, "category_id")
	add(p.ProjectID != nil, "project_id")
	add(p.Source != nil, "source")
	add(p.Props != nil, "props")
	add(p.Workdir != nil, "workdir")
	add(p.DueAt != nil, "due_at")
	add(p.Tags != nil, "tags")
	add(p.Archived != nil, "archived")
	return out
}

// --- 关联、产物 ---

func (s *Store) CreateLink(ctx context.Context, fromID, toID, relation, note string) (*domain.Link, error) {
	out, err := s.Store.CreateLink(ctx, fromID, toID, relation, note)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, ActorFrom(ctx), "create", "link", out.ID, "关联 "+fromID+" "+relation+" "+toID,
		map[string]any{"from_id": fromID, "to_id": toID, "relation": relation})
	return out, nil
}

func (s *Store) DeleteLink(ctx context.Context, id string) error {
	if err := s.Store.DeleteLink(ctx, id); err != nil {
		return err
	}
	s.deleted(ctx, "link", id, "删除关联 "+id, nil)
	return nil
}

func artifactDetail(a *domain.Artifact) map[string]any {
	return map[string]any{"title": a.Title, "platform": a.Platform, "source": a.Source}
}

func (s *Store) CreateArtifact(ctx context.Context, in domain.ArtifactInput) (*domain.Artifact, error) {
	out, err := s.Store.CreateArtifact(ctx, in)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, ActorFrom(ctx), "create", "artifact", out.ID, "登记产物 "+out.Title, artifactDetail(out))
	return out, nil
}

func (s *Store) RecordArtifact(ctx context.Context, in domain.ArtifactInput) (*domain.Artifact, error) {
	out, err := s.Store.RecordArtifact(ctx, in)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, ActorFrom(ctx), "record", "artifact", out.ID, "登记产物 "+out.Title, artifactDetail(out))
	return out, nil
}

func (s *Store) UpdateArtifact(ctx context.Context, id string, p domain.ArtifactPatch) (*domain.Artifact, error) {
	out, err := s.Store.UpdateArtifact(ctx, id, p)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, ActorFrom(ctx), "update", "artifact", id, "修改产物 "+out.Title, artifactDetail(out))
	return out, nil
}

func (s *Store) DeleteArtifact(ctx context.Context, id string) error {
	prev, _ := s.Store.GetArtifact(ctx, id)
	if err := s.Store.DeleteArtifact(ctx, id); err != nil {
		return err
	}
	label, d := id, map[string]any{}
	if prev != nil {
		label, d = prev.Title, artifactDetail(prev)
	}
	s.deleted(ctx, "artifact", id, "删除产物 "+label, d)
	return nil
}

// --- 分类、标签、干系人、快捷访问、会话 ---

func (s *Store) CreateCategory(ctx context.Context, c *domain.Category) (*domain.Category, error) {
	out, err := s.Store.CreateCategory(ctx, c)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, ActorFrom(ctx), "create", "category", out.ID, "新建分类 "+out.Name, map[string]any{"name": out.Name, "type_id": out.TypeID})
	return out, nil
}

func (s *Store) UpdateCategory(ctx context.Context, id string, p domain.CategoryPatch) (*domain.Category, error) {
	out, err := s.Store.UpdateCategory(ctx, id, p)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, ActorFrom(ctx), "update", "category", id, "修改分类 "+out.Name, map[string]any{"name": out.Name, "type_id": out.TypeID})
	return out, nil
}

func (s *Store) DeleteCategory(ctx context.Context, id string, reassignTo *string) error {
	prev, _ := s.Store.GetCategory(ctx, id)
	if err := s.Store.DeleteCategory(ctx, id, reassignTo); err != nil {
		return err
	}
	label, d := id, map[string]any{}
	if prev != nil {
		label, d = prev.Name, map[string]any{"name": prev.Name, "type_id": prev.TypeID}
	}
	if reassignTo != nil {
		d["reassign_to"] = *reassignTo
	}
	s.deleted(ctx, "category", id, "删除分类 "+label, d)
	return nil
}

func (s *Store) CreateTag(ctx context.Context, name, color string) (*domain.Tag, error) {
	out, err := s.Store.CreateTag(ctx, name, color)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, ActorFrom(ctx), "create", "tag", out.ID, "新建标签 "+out.Name, map[string]any{"name": out.Name})
	return out, nil
}

func (s *Store) UpdateTag(ctx context.Context, id string, name, color *string) (*domain.Tag, error) {
	out, err := s.Store.UpdateTag(ctx, id, name, color)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, ActorFrom(ctx), "update", "tag", id, "修改标签 "+out.Name, map[string]any{"name": out.Name})
	return out, nil
}

func (s *Store) MergeTags(ctx context.Context, srcID, dstID string) (*domain.Tag, error) {
	out, err := s.Store.MergeTags(ctx, srcID, dstID)
	if err != nil {
		return nil, err
	}
	// 合并会删掉 srcID，按删除记
	s.deleted(ctx, "tag", srcID, "合并标签到 "+out.Name, map[string]any{"merged_into": dstID})
	return out, nil
}

func (s *Store) DeleteTag(ctx context.Context, id string) error {
	if err := s.Store.DeleteTag(ctx, id); err != nil {
		return err
	}
	s.deleted(ctx, "tag", id, "删除标签 "+id, nil)
	return nil
}

func (s *Store) CreateStakeholder(ctx context.Context, sh *domain.Stakeholder) (*domain.Stakeholder, error) {
	out, err := s.Store.CreateStakeholder(ctx, sh)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, ActorFrom(ctx), "create", "stakeholder", out.ID, "新建干系人 "+out.Name, map[string]any{"name": out.Name})
	return out, nil
}

func (s *Store) UpdateStakeholder(ctx context.Context, id string, p domain.StakeholderPatch) (*domain.Stakeholder, error) {
	out, err := s.Store.UpdateStakeholder(ctx, id, p)
	if err != nil {
		return nil, err
	}
	s.agent(ctx, ActorFrom(ctx), "update", "stakeholder", id, "修改干系人 "+out.Name, map[string]any{"name": out.Name})
	return out, nil
}

func (s *Store) DeleteStakeholder(ctx context.Context, id string) error {
	prev, _ := s.Store.GetStakeholder(ctx, id)
	if err := s.Store.DeleteStakeholder(ctx, id); err != nil {
		return err
	}
	label := id
	if prev != nil {
		label = prev.Name
	}
	s.deleted(ctx, "stakeholder", id, "删除干系人 "+label, nil)
	return nil
}

func (s *Store) DeleteShortcut(ctx context.Context, id string) error {
	prev, _ := s.Store.GetShortcut(ctx, id)
	if err := s.Store.DeleteShortcut(ctx, id); err != nil {
		return err
	}
	label := id
	if prev != nil {
		label = prev.Label
	}
	s.deleted(ctx, "shortcut", id, "删除快捷访问 "+label, nil)
	return nil
}

func (s *Store) DeleteShortcutGroup(ctx context.Context, id string) error {
	if err := s.Store.DeleteShortcutGroup(ctx, id); err != nil {
		return err
	}
	s.deleted(ctx, "shortcut_group", id, "删除快捷访问分组 "+id, nil)
	return nil
}

func (s *Store) DeleteAgentSession(ctx context.Context, id string) error {
	prev, _ := s.Store.GetAgentSession(ctx, id)
	if err := s.Store.DeleteAgentSession(ctx, id); err != nil {
		return err
	}
	label := id
	if prev != nil && strings.TrimSpace(prev.Title) != "" {
		label = prev.Title
	}
	s.deleted(ctx, "agent_session", id, "删除 Agent 会话 "+label, nil)
	return nil
}

var _ store.Store = (*Store)(nil)
