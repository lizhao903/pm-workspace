package events

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// Store 在 store.Store 外面包一层：写方法成功返回（事务已提交）之后发内核事件，
// 返回错误（事务回滚）时什么都不发。没覆盖的方法原样透传。
//
// 状态变化的 from 取自写之前另读的一次，不在写事务里：两个请求同时改同一条时 from 可能不准，
// 本机单用户场景先接受；要严格就得让 store 把修订差异返回出来。
type Store struct {
	store.Store
	bus *Bus
}

// WrapStore 给 st 接上事件发布；bus 为 nil 时原样返回 st。
func WrapStore(st store.Store, bus *Bus) store.Store {
	if bus == nil {
		return st
	}
	return &Store{Store: st, bus: bus}
}

func (s *Store) publish(ctx context.Context, eventType string, payload any) {
	if err := s.bus.Publish(ctx, eventType, payload); err != nil {
		s.bus.log.Error("event publish failed", "type", eventType, "err", err)
	}
}

// before 读写之前的对象；读不到不拦写入，交给 store 自己报错。
func (s *Store) before(ctx context.Context, id string) *domain.Object {
	o, err := s.Store.GetObject(ctx, id)
	if err != nil {
		return nil
	}
	return o
}

func (s *Store) CreateObject(ctx context.Context, o *domain.Object, a store.Actor) (*domain.Object, error) {
	out, err := s.Store.CreateObject(ctx, o, a)
	if err != nil {
		return nil, err
	}
	s.publish(ctx, ObjectCreated, map[string]any{"id": out.ID, "type_id": out.TypeID})
	return out, nil
}

func (s *Store) UpdateObject(ctx context.Context, id string, p domain.ObjectPatch, a store.Actor) (*domain.Object, error) {
	prev := s.before(ctx, id)
	out, err := s.Store.UpdateObject(ctx, id, p, a)
	if err != nil {
		return nil, err
	}
	s.changed(ctx, prev, out)
	return out, nil
}

func (s *Store) AppendProgress(ctx context.Context, objectID string, in domain.ProgressInput, a store.Actor) (*domain.Progress, error) {
	var prev *domain.Object
	if in.Status != "" {
		prev = s.before(ctx, objectID)
	}
	out, err := s.Store.AppendProgress(ctx, objectID, in, a)
	if err != nil {
		return nil, err
	}
	if prev != nil {
		if cur, err := s.Store.GetObject(ctx, objectID); err == nil {
			s.changed(ctx, prev, cur)
		}
	}
	// 每条进展都发：不带状态的普通进展也要让打开着的抽屉即时刷新（CORE-07c）
	s.publish(ctx, ProgressAppended, map[string]any{"id": out.ObjectID, "kind": out.Kind})
	if out.Kind == domain.ProgressReview {
		s.publish(ctx, TaskReviewRequested, map[string]any{"id": out.ObjectID})
	}
	return out, nil
}

func (s *Store) ClaimObject(ctx context.Context, objectID string, in domain.ClaimInput, a store.Actor) (*domain.ClaimResult, error) {
	prev := s.before(ctx, objectID)
	out, err := s.Store.ClaimObject(ctx, objectID, in, a)
	if err != nil {
		return nil, err
	}
	if !out.Already && out.Object != nil {
		s.changed(ctx, prev, out.Object)
	}
	return out, nil
}

func (s *Store) FinishTaskRun(ctx context.Context, id, status string, exitCode int, output, errMsg string) (*domain.TaskRun, error) {
	out, err := s.Store.FinishTaskRun(ctx, id, status, exitCode, output, errMsg)
	if err != nil {
		return nil, err
	}
	// status、summary（结论开头，最多 runSummaryMax 字）给订阅方直接用：IM 插件据此回复原消息（SPEC-messages-2.50）
	// origin：插件流程里发起的执行（如 SOP 的 Claude Code 节点）为 "plugin:<插件 id>"，人交给 CLI 的为空
	s.publish(ctx, RunFinished, map[string]any{"run_id": out.ID, "object_id": out.ObjectID, "ok": out.Status == domain.RunDone,
		"status": out.Status, "summary": clipRunes(strings.TrimSpace(out.Output), runSummaryMax), "origin": domain.RunOrigin(ctx)})
	return out, nil
}

// changed 比对写前写后，有字段变了发 object.updated（fields 含 status），状态变了再发 object.status_changed。
func (s *Store) changed(ctx context.Context, prev, cur *domain.Object) {
	if prev == nil || cur == nil {
		return
	}
	fields := diffFields(prev, cur)
	if len(fields) == 0 {
		return
	}
	s.publish(ctx, ObjectUpdated, map[string]any{"id": cur.ID, "type_id": cur.TypeID, "fields": fields})
	if prev.Status != cur.Status {
		s.publish(ctx, ObjectStatusChanged, map[string]any{"id": cur.ID, "type_id": cur.TypeID, "from": prev.Status, "to": cur.Status})
	}
	// 阶段在 props.stage（AUTO-05），props 变了再细看阶段；空串是「未设阶段」
	if from, to := domain.StageOf(prev.Props), domain.StageOf(cur.Props); from != to {
		s.publish(ctx, ObjectStageChanged, map[string]any{"id": cur.ID, "type_id": cur.TypeID, "from": from, "to": to})
	}
}

// objectFields 是 object.updated 里 fields 的取值范围，键和 PATCH 的字段名一致。
var objectFields = []struct {
	name string
	get  func(o *domain.Object) any
}{
	{"title", func(o *domain.Object) any { return o.Title }},
	{"body", func(o *domain.Object) any { return o.Body }},
	{"status", func(o *domain.Object) any { return o.Status }},
	{"priority", func(o *domain.Object) any { return o.Priority }},
	{"owner_id", func(o *domain.Object) any { return deref(o.OwnerID) }},
	{"participant_ids", func(o *domain.Object) any {
		ids := make([]string, 0, len(o.Participants))
		for _, p := range o.Participants {
			ids = append(ids, p.ID)
		}
		return sorted(ids)
	}},
	{"category_id", func(o *domain.Object) any { return deref(o.CategoryID) }},
	{"project_id", func(o *domain.Object) any { return deref(o.ProjectID) }},
	{"source", func(o *domain.Object) any { return o.Source }},
	{"props", func(o *domain.Object) any {
		if len(o.Props) == 0 {
			return map[string]any{}
		}
		return o.Props
	}},
	{"workdir", func(o *domain.Object) any { return o.Workdir }},
	{"due_at", func(o *domain.Object) any { return timeOf(o.DueAt) }},
	{"tags", func(o *domain.Object) any { return sorted(o.Tags) }},
	{"archived", func(o *domain.Object) any { return o.ArchivedAt != nil }},
}

func diffFields(prev, cur *domain.Object) []string {
	var out []string
	for _, f := range objectFields {
		if !reflect.DeepEqual(f.get(prev), f.get(cur)) {
			out = append(out, f.name)
		}
	}
	return out
}

// sorted 返回排好序的副本，nil 和空切片算同一个值。
func sorted(in []string) []string {
	out := append([]string{}, in...)
	slices.Sort(out)
	return out
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func timeOf(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

var _ store.Store = (*Store)(nil)

// runSummaryMax 是 run.finished 里 summary 的上限（字）。
const runSummaryMax = 1500

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
