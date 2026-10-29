package plugin

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 带操作者、幂等键和审计的写入（SOP-02a）：插件替用户自动写内核数据时用（SOP 写节点）。
// 和 ObjectWriter.Create 的区别：操作者记为「插件 id#会话」，每次成功写入记一条审计（kind agent、source plugin），
// 带了幂等键时同一个键只写一次，再写回第一次的结果。
//
// 幂等按审计查：同一操作者、detail.write_key 相同的审计已经有了就不再写；建对象另外按 props.source_ref.write_key 查，
// 写成了但审计没来得及落（进程正好在这之间退出）时也不会重复建。追加正文、写联系人没有这层兜底。

// WriteMeta 是一次写入的来源说明。
type WriteMeta struct {
	// Session 拼在插件 id 后面当操作者（revisions.actor、审计的 actor），例 SOP 的运行 id；空串时操作者就是插件 id
	Session string
	// Key 是幂等键，非空时同一个键只写一次
	Key string
	// Detail 补进审计的 detail，例 SOP 的流程、步骤 key
	Detail map[string]any
}

// NewContact 是插件要建的联系人，Name 必填，校验同 POST /api/stakeholders。
type NewContact struct {
	Name    string
	Company string
	Title   string
	Phone   string
	Email   string
	Group   string
	Note    string
	Tags    []string
}

// ContactPatch 是合并进已有联系人的字段，nil 不改。
type ContactPatch struct {
	Name    *string
	Company *string
	Title   *string
	Phone   *string
	Email   *string
	Group   *string
	Note    *string
}

// WrittenContact 是写好的联系人；Fields 是这次改了的字段（新建时为空），Reused 为真表示按幂等键取回的上次结果。
type WrittenContact struct {
	ID     string
	Name   string
	Fields []string
	Reused bool
}

// ContactWriter 建联系人、按 id 合并字段，都要带 WriteMeta。
type ContactWriter interface {
	Create(ctx context.Context, in NewContact, m WriteMeta) (WrittenContact, error)
	Merge(ctx context.Context, id string, p ContactPatch, m WriteMeta) (WrittenContact, error)
}

// ErrWriteUnsupported：接上的 store 没有对应的写方法（测试替身）。
var ErrWriteUnsupported = errors.New("plugin writer does not support this write")

type objectUpdater interface {
	GetObject(ctx context.Context, id string) (*domain.Object, error)
	UpdateObject(ctx context.Context, id string, p domain.ObjectPatch, a store.Actor) (*domain.Object, error)
}

type contactStore interface {
	GetStakeholder(ctx context.Context, id string) (*domain.Stakeholder, error)
	CreateStakeholder(ctx context.Context, sh *domain.Stakeholder) (*domain.Stakeholder, error)
	UpdateStakeholder(ctx context.Context, id string, p domain.StakeholderPatch) (*domain.Stakeholder, error)
}

func (c *core) actor(m WriteMeta) store.Actor {
	return store.Actor{Name: c.id, Session: m.Session, Source: ActorSourcePlugin}
}

// written 按幂等键查上次写的目标 id，没有返回空串。
func (c *core) written(ctx context.Context, m WriteMeta, targetType string) (string, error) {
	if m.Key == "" {
		return "", nil
	}
	d := c.db()
	if d == nil {
		return "", ErrNoStore
	}
	a := c.actor(m)
	var id string
	err := d.R.QueryRowContext(ctx, `SELECT target_id FROM audits WHERE actor = ? AND target_type = ?
		AND json_extract(detail, '$.write_key') = ? ORDER BY at LIMIT 1`, domain.ComposeActor(a.Name, a.Session), targetType, m.Key).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// note 记一条审计，写失败只记日志（同 CORE-08）。
func (c *core) note(ctx context.Context, m WriteMeta, action, targetType, targetID, summary string, detail map[string]any) {
	d := c.db()
	if d == nil {
		return
	}
	for k, v := range m.Detail {
		if _, has := detail[k]; !has {
			detail[k] = v
		}
	}
	if m.Key != "" {
		detail["write_key"] = m.Key
	}
	a := c.actor(m)
	audit.New(d, c.log).Note(ctx, audit.Entry{Kind: audit.KindAgent, Action: action, TargetType: targetType, TargetID: targetID,
		Actor: domain.ComposeActor(a.Name, a.Session), Source: a.Source, Summary: summary, Detail: detail})
}

func objSummary(verb string, o *domain.Object) string {
	if o.Ref != "" {
		return verb + " " + o.Ref + " " + o.Title
	}
	return verb + " " + o.Title
}

func created(o *domain.Object, reused bool) CreatedObject {
	return CreatedObject{ID: o.ID, Ref: o.Ref, TypeID: o.TypeID, Title: o.Title, Status: o.Status, Source: o.Source, Reused: reused}
}

// CreateAs 建对象，操作者、审计、幂等见文件头。Key 非空时 props.source_ref.write_key 写成 Key。
func (w objectWriter) CreateAs(ctx context.Context, in NewObject, m WriteMeta) (CreatedObject, error) {
	oc := w.c.reg.objectCreator()
	if oc == nil {
		return CreatedObject{}, ErrNoObjectWriter
	}
	up, _ := oc.(objectUpdater)
	if id, err := w.c.dedupeObject(ctx, m); err != nil {
		return CreatedObject{}, err
	} else if id != "" {
		if up == nil {
			return CreatedObject{ID: id, Reused: true}, nil
		}
		o, err := up.GetObject(ctx, id)
		if err == nil {
			return created(o, true), nil
		}
		if !errors.Is(err, domain.ErrNotFound) {
			return CreatedObject{}, err
		}
		return CreatedObject{ID: id, Reused: true}, nil
	}
	props := map[string]any{}
	for k, v := range in.Props {
		props[k] = v
	}
	if m.Key != "" {
		ref := map[string]any{}
		if old, ok := props[domain.PropSourceRef].(map[string]any); ok {
			for k, v := range old {
				ref[k] = v
			}
		}
		ref["write_key"] = m.Key
		props[domain.PropSourceRef] = ref
	}
	o := &domain.Object{TypeID: in.TypeID, Title: in.Title, Body: in.Body, Status: in.Status, Priority: in.Priority,
		ProjectID: in.ProjectID, OwnerID: in.OwnerID, CategoryID: in.CategoryID, DueAt: in.DueAt, Props: props, Tags: in.Tags, Source: w.c.id}
	out, err := oc.CreateObject(ctx, o, w.c.actor(m))
	if err != nil {
		return CreatedObject{}, err
	}
	w.c.note(ctx, m, "create", "object", out.ID, objSummary("新建", out), map[string]any{"ref": out.Ref, "title": out.Title, "type_id": out.TypeID})
	return created(out, false), nil
}

// dedupeObject 按幂等键找上次建的或改的对象：先查审计，再查 props.source_ref.write_key。
func (c *core) dedupeObject(ctx context.Context, m WriteMeta) (string, error) {
	if m.Key == "" {
		return "", nil
	}
	id, err := c.written(ctx, m, "object")
	if err != nil || id != "" {
		return id, err
	}
	d := c.db()
	if d == nil {
		return "", ErrNoStore
	}
	err = d.R.QueryRowContext(ctx, `SELECT id FROM objects WHERE source = ? AND json_extract(props, '$.source_ref.write_key') = ? LIMIT 1`, c.id, m.Key).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// AppendBody 在对象正文末尾追加一段（和原文之间空一行），对象不存在或已删除返回 domain.ErrNotFound。
func (w objectWriter) AppendBody(ctx context.Context, id, text string, m WriteMeta) (CreatedObject, error) {
	oc := w.c.reg.objectCreator()
	if oc == nil {
		return CreatedObject{}, ErrNoObjectWriter
	}
	up, ok := oc.(objectUpdater)
	if !ok {
		return CreatedObject{}, ErrWriteUnsupported
	}
	if prev, err := w.c.written(ctx, m, "object"); err != nil {
		return CreatedObject{}, err
	} else if prev != "" {
		o, err := up.GetObject(ctx, prev)
		if err != nil {
			return CreatedObject{}, err
		}
		return created(o, true), nil
	}
	cur, err := up.GetObject(ctx, id)
	if err != nil {
		return CreatedObject{}, err
	}
	if cur.DeletedAt != nil {
		return CreatedObject{}, fmt.Errorf("%w: object %s is deleted", domain.ErrNotFound, id)
	}
	body := strings.TrimRight(cur.Body, "\n")
	if body != "" {
		body += "\n\n"
	}
	body += strings.TrimSpace(text)
	out, err := up.UpdateObject(ctx, id, domain.ObjectPatch{Body: &body}, w.c.actor(m))
	if err != nil {
		return CreatedObject{}, err
	}
	w.c.note(ctx, m, "update", "object", out.ID, objSummary("追加正文到", out),
		map[string]any{"ref": out.Ref, "title": out.Title, "type_id": out.TypeID, "fields": []string{"body"}, "mode": "append"})
	return created(out, false), nil
}

func (c *core) ContactWriter() ContactWriter { return contactWriter{c} }

type contactWriter struct{ c *core }

func (w contactWriter) store() (contactStore, error) {
	oc := w.c.reg.objectCreator()
	if oc == nil {
		return nil, ErrNoObjectWriter
	}
	cs, ok := oc.(contactStore)
	if !ok {
		return nil, ErrWriteUnsupported
	}
	return cs, nil
}

func (w contactWriter) reused(ctx context.Context, cs contactStore, m WriteMeta) (WrittenContact, bool, error) {
	prev, err := w.c.written(ctx, m, "stakeholder")
	if err != nil || prev == "" {
		return WrittenContact{}, false, err
	}
	sh, err := cs.GetStakeholder(ctx, prev)
	if err != nil {
		return WrittenContact{}, false, err
	}
	return WrittenContact{ID: sh.ID, Name: sh.Name, Reused: true}, true, nil
}

func (w contactWriter) Create(ctx context.Context, in NewContact, m WriteMeta) (WrittenContact, error) {
	cs, err := w.store()
	if err != nil {
		return WrittenContact{}, err
	}
	if out, ok, err := w.reused(ctx, cs, m); err != nil || ok {
		return out, err
	}
	ctx = audit.WithActor(ctx, w.c.actor(m))
	out, err := cs.CreateStakeholder(ctx, &domain.Stakeholder{Name: in.Name, Company: in.Company, Title: in.Title,
		Phone: in.Phone, Email: in.Email, Group: in.Group, Note: in.Note, Tags: in.Tags})
	if err != nil {
		return WrittenContact{}, err
	}
	w.c.note(ctx, m, "create", "stakeholder", out.ID, "新建联系人 "+out.Name, map[string]any{"name": out.Name})
	return WrittenContact{ID: out.ID, Name: out.Name}, nil
}

func (w contactWriter) Merge(ctx context.Context, id string, p ContactPatch, m WriteMeta) (WrittenContact, error) {
	cs, err := w.store()
	if err != nil {
		return WrittenContact{}, err
	}
	if out, ok, err := w.reused(ctx, cs, m); err != nil || ok {
		return out, err
	}
	var fields []string
	for _, f := range []struct {
		name string
		v    *string
	}{{"name", p.Name}, {"company", p.Company}, {"title", p.Title}, {"phone", p.Phone}, {"email", p.Email}, {"group", p.Group}, {"note", p.Note}} {
		if f.v != nil {
			fields = append(fields, f.name)
		}
	}
	ctx = audit.WithActor(ctx, w.c.actor(m))
	out, err := cs.UpdateStakeholder(ctx, id, domain.StakeholderPatch{Name: p.Name, Company: p.Company, Title: p.Title,
		Phone: p.Phone, Email: p.Email, Group: p.Group, Note: p.Note})
	if err != nil {
		return WrittenContact{}, err
	}
	w.c.note(ctx, m, "update", "stakeholder", out.ID, "合并联系人 "+out.Name, map[string]any{"name": out.Name, "fields": fields})
	return WrittenContact{ID: out.ID, Name: out.Name, Fields: fields}, nil
}

// FindByName 按名字找一个没归档的联系人，重名取最早建的；没有返回 ErrNoRows。
func (r contactReader) FindByName(ctx context.Context, name string) (ContactInfo, error) {
	d := r.c.db()
	if d == nil {
		return ContactInfo{}, ErrNoStore
	}
	var info ContactInfo
	err := d.R.QueryRowContext(ctx, `SELECT id, name FROM stakeholders WHERE name = ? AND archived_at IS NULL ORDER BY created_at, id LIMIT 1`,
		strings.TrimSpace(name)).Scan(&info.ID, &info.Name)
	return info, err
}
