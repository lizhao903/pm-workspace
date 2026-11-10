// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"errors"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 插件建内核对象的受限句柄（IM-02a 起）：只能建，不能改、不能删；SOP-02a 加了带操作者和审计的建对象、追加正文（writes.go）。
// 建对象走 cmd/pmw 交进来的外层 store（审计、事件包装过的），修订、审计、事件和界面上新建的一样；
// 来源（objects.source）固定写成插件 id，操作者记为插件 id、来源 plugin，插件自己填的来源会被覆盖。
// 改对象、建关联等更宽的写能力等 plugin-api.md 2.0 的 ObjectService 落地时再加。

// ObjectCreator 是内核 store 里建对象的方法；cmd/pmw 交外层包装过的 store。
type ObjectCreator interface {
	CreateObject(ctx context.Context, o *domain.Object, a store.Actor) (*domain.Object, error)
}

// ErrNoObjectWriter：注册表没接上建对象的 store（测试里没接时）。
var ErrNoObjectWriter = errors.New("plugin object writer is not configured")

// ActorSourcePlugin 是插件写内核数据时操作者的来源（revisions.source、审计的 source）。
const ActorSourcePlugin = "plugin"

// NewObject 是插件要建的对象；状态空时取类型的第一个状态，校验同 POST /api/objects。
type NewObject struct {
	TypeID    string
	Title     string
	Body      string
	Status    string
	Priority  string
	ProjectID *string
	OwnerID   *string
	DueAt     *time.Time
	// CategoryID 是分类 id（SOP-02a 起，写文档时用），nil 是未分类
	CategoryID *string
	Props      map[string]any
	Tags       []string
}

// CreatedObject 是建好的对象里插件常用的几项。
type CreatedObject struct {
	ID     string
	Ref    string
	TypeID string
	Title  string
	Status string
	Source string
	// Reused 为真表示按幂等键取回的上次结果，没有再写（CreateAs、AppendBody，writes.go）
	Reused bool
}

// ObjectWriter 只建对象。校验失败返回的错误可以用 errors.Is 对 domain.ErrValidation、domain.ErrNotFound 判断。
type ObjectWriter interface {
	Create(ctx context.Context, o NewObject) (CreatedObject, error)
	// CreateAs 建对象，带操作者、幂等键，记审计（SOP-02a，writes.go）
	CreateAs(ctx context.Context, o NewObject, m WriteMeta) (CreatedObject, error)
	// AppendBody 在对象正文末尾追加一段，带操作者、幂等键，记审计（SOP-02a，writes.go）
	AppendBody(ctx context.Context, id, text string, m WriteMeta) (CreatedObject, error)
	// UpdateTask 改任务的阶段（props.stage）和所属项目，带操作者，记审计（AUTO-06，taskstage_write.go）
	UpdateTask(ctx context.Context, id string, ch TaskChange, m WriteMeta) (ChangedTask, error)
}

// objectCreatorBox 包一层，atomic.Pointer 才能放接口值。
type objectCreatorBox struct{ oc ObjectCreator }

// SetObjectCreator 接上插件建对象用的 store，可以在 Start 之后调（建对象时现取）。
func (r *Registry) SetObjectCreator(oc ObjectCreator) { r.objects.Store(&objectCreatorBox{oc}) }

func (r *Registry) objectCreator() ObjectCreator {
	if r == nil {
		return nil
	}
	if b := r.objects.Load(); b != nil {
		return b.oc
	}
	return nil
}

func (c *core) ObjectWriter() ObjectWriter { return objectWriter{c} }

type objectWriter struct{ c *core }

func (w objectWriter) Create(ctx context.Context, in NewObject) (CreatedObject, error) {
	oc := w.c.reg.objectCreator()
	if oc == nil {
		return CreatedObject{}, ErrNoObjectWriter
	}
	o := &domain.Object{
		TypeID:    in.TypeID,
		Title:     in.Title,
		Body:      in.Body,
		Status:    in.Status,
		Priority:  in.Priority,
		ProjectID: in.ProjectID,
		OwnerID:   in.OwnerID,
		DueAt:     in.DueAt,
		Props:     in.Props,
		Tags:      in.Tags,
		Source:    w.c.id,
	}
	out, err := oc.CreateObject(ctx, o, store.Actor{Name: w.c.id, Source: ActorSourcePlugin})
	if err != nil {
		return CreatedObject{}, err
	}
	return CreatedObject{ID: out.ID, Ref: out.Ref, TypeID: out.TypeID, Title: out.Title, Status: out.Status, Source: out.Source}, nil
}
