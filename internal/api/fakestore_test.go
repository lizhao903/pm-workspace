package api

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// fakeStore 是给 API 层用的内存实现：只保证 handler 能跑通并把参数原样记下来，
// 不复刻任何业务规则（那些是 sqlite 实现的责任）。
type fakeStore struct {
	mu sync.Mutex

	types     map[string]*domain.ObjectType
	sgroups   map[string]*domain.ShortcutGroup
	shortcuts map[string]*domain.Shortcut
	cats      map[string]*domain.Category
	objs      map[string]*domain.Object
	refSeq    map[string]int // type_id -> 已发出的编号数，用于造 TSK-0001 这样的 ref
	tags      map[string]*domain.Tag
	links     map[string]*domain.Link
	revs      []*domain.Revision
	dicts     map[string]*domain.Dictionary
	dictItems map[string]*domain.DictItem

	// providers 存脱敏后的记录，明文密钥单独放 providerKeys——
	// 和 sqlite 实现同构，这样 API 层的「响应里不许有明文」才是真的在被验证。
	providers    map[string]*domain.AgentProvider
	providerKeys map[string]string

	sessions  map[string]*domain.AgentSession
	messages  map[string][]*domain.AgentMessage  // sessionID -> 按追加顺序
	artifacts map[string][]*domain.AgentArtifact // sessionID -> 按记录顺序

	// 错误注入：非 nil 时对应方法直接返回它，用来测错误码映射。
	errGetObject      error
	errDeleteType     error
	errCreateObject   error
	errDeleteCategory error
	errMoveCategory   error
	errCreateShortcut error
	errDeleteDictItem error
	errCreateProvider error
	errGetProvider    error
	errCreateTaskRun  error

	// 最后一次调用的入参，供断言。
	lastFilter   domain.ObjectFilter
	lastPatch    domain.ObjectPatch
	lastActor    store.Actor
	lastParentID *string
	lastSort     int
	lastHard     bool

	lastShortcutPatch domain.ShortcutPatch
	lastReorderGroup  *string
	lastReorderIDs    []string

	lastDictWithItems   bool
	lastDictID          string
	lastDictTypeID      *string
	lastDictArchived    bool
	lastDictItemPatch   domain.DictItemPatch
	lastDictReorderIDs  []string
	lastDictReorderType *string

	lastProviderInput  domain.AgentProviderInput
	lastProviderKey    string
	lastProviderDefID  string
	lastProviderDelID  string
	lastProviderTestID string
	taskRuns           map[string]*domain.TaskRun
	// taskRunSeq 记插入顺序。sqlite 那边时间戳撞车时用 rowid 兜底，
	// 替身用 map 存就没有插入顺序可言，只能自己记一个——否则两边在
	// 「同一时刻的两条记录谁在前」上会分叉，而那正好是 sqlite 侧有测试压着的性质。
	taskRunSeq map[string]int

	stakeholders map[string]*domain.Stakeholder
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		types:     map[string]*domain.ObjectType{},
		sgroups:   map[string]*domain.ShortcutGroup{},
		shortcuts: map[string]*domain.Shortcut{},
		cats:      map[string]*domain.Category{},
		objs:      map[string]*domain.Object{},
		refSeq:    map[string]int{},
		tags:      map[string]*domain.Tag{},
		links:     map[string]*domain.Link{},
		dicts:     map[string]*domain.Dictionary{},
		dictItems: map[string]*domain.DictItem{},

		providers:    map[string]*domain.AgentProvider{},
		providerKeys: map[string]string{},
		sessions:     map[string]*domain.AgentSession{},
		messages:     map[string][]*domain.AgentMessage{},
		artifacts:    map[string][]*domain.AgentArtifact{},
	}
}

var _ store.Store = (*fakeStore)(nil)

func (f *fakeStore) Close() error               { return nil }
func (f *fakeStore) Ping(context.Context) error { return nil }
func (f *fakeStore) Stats(context.Context) (map[string]any, error) {
	return map[string]any{"db_path": ":memory:", "db_size": 0, "objects": len(f.objs)}, nil
}

func (f *fakeStore) ListObjectTypes(context.Context) ([]*domain.ObjectType, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*domain.ObjectType, 0, len(f.types))
	for _, t := range f.types {
		out = append(out, t)
	}
	return out, nil
}

func (f *fakeStore) GetObjectType(_ context.Context, id string) (*domain.ObjectType, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.types[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return t, nil
}

func (f *fakeStore) CreateObjectType(_ context.Context, t *domain.ObjectType) (*domain.ObjectType, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, dup := f.types[t.ID]; dup {
		return nil, domain.ErrConflict
	}
	f.types[t.ID] = t
	return t, nil
}

func (f *fakeStore) UpdateObjectType(_ context.Context, id string, p domain.ObjectTypePatch) (*domain.ObjectType, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.types[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if p.Name != nil {
		t.Name = *p.Name
	}
	if p.Icon != nil {
		t.Icon = *p.Icon
	}
	return t, nil
}

func (f *fakeStore) DeleteObjectType(_ context.Context, id string) error {
	if f.errDeleteType != nil {
		return f.errDeleteType
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.types[id]; !ok {
		return domain.ErrNotFound
	}
	delete(f.types, id)
	return nil
}

func (f *fakeStore) ListCategories(_ context.Context, typeID string, _ bool) ([]*domain.Category, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*domain.Category, 0, len(f.cats))
	for _, c := range f.cats {
		if typeID == "" || c.TypeID == typeID {
			out = append(out, c)
		}
	}
	return out, nil
}

func (f *fakeStore) CategoryTree(ctx context.Context, typeID string, withCounts bool) ([]*domain.Category, error) {
	return f.ListCategories(ctx, typeID, withCounts)
}

func (f *fakeStore) GetCategory(_ context.Context, id string) (*domain.Category, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.cats[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return c, nil
}

func (f *fakeStore) CreateCategory(_ context.Context, c *domain.Category) (*domain.Category, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c.ID == "" {
		c.ID = idgen.Prefixed("cat")
	}
	f.cats[c.ID] = c
	return c, nil
}

func (f *fakeStore) UpdateCategory(_ context.Context, id string, p domain.CategoryPatch) (*domain.Category, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.cats[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if p.Name != nil {
		c.Name = *p.Name
	}
	return c, nil
}

func (f *fakeStore) MoveCategory(_ context.Context, id string, parentID *string, sortOrder int) (*domain.Category, error) {
	if f.errMoveCategory != nil {
		return nil, f.errMoveCategory
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastParentID, f.lastSort = parentID, sortOrder
	c, ok := f.cats[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	c.ParentID, c.SortOrder = parentID, sortOrder
	return c, nil
}

func (f *fakeStore) DeleteCategory(_ context.Context, id string, reassignTo *string) error {
	if f.errDeleteCategory != nil {
		return f.errDeleteCategory
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastParentID = reassignTo
	if _, ok := f.cats[id]; !ok {
		return domain.ErrNotFound
	}
	delete(f.cats, id)
	return nil
}

func (f *fakeStore) ListObjects(_ context.Context, fl domain.ObjectFilter) ([]*domain.Object, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastFilter = fl
	out := make([]*domain.Object, 0, len(f.objs))
	for _, o := range f.objs {
		out = append(out, o)
	}
	return out, len(out), nil
}

func (f *fakeStore) GetObject(_ context.Context, id string) (*domain.Object, error) {
	if f.errGetObject != nil {
		return nil, f.errGetObject
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objs[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return o, nil
}

func (f *fakeStore) CreateObject(_ context.Context, o *domain.Object, a store.Actor) (*domain.Object, error) {
	if f.errCreateObject != nil {
		return nil, f.errCreateObject
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastActor = a
	if o.ID == "" {
		o.ID = idgen.Prefixed("obj")
	}
	if o.Ref == "" {
		// 与 sqlite 实现同构地发一个 PREFIX-0001 形式的编号。Agent 的 tool_result
		// 要靠 ref 给前端做跳转，不造出来这条契约就测不到。
		prefix := "OBJ"
		if t, ok := f.types[o.TypeID]; ok && t.RefPrefix != "" {
			prefix = t.RefPrefix
		}
		f.refSeq[o.TypeID]++
		o.Ref = fmt.Sprintf("%s-%04d", prefix, f.refSeq[o.TypeID])
	}
	// 负责人姓名与参与人的展示字段由 store 填，和 sqlite 的 JOIN 同构——
	// 替身不填的话，「列表要显示人名」这条性质在 API 层永远测不到。
	o.OwnerName = f.ownerNameLocked(o.OwnerID, o.Owner)
	o.Participants = f.refsLocked(idsOfRefs(o.Participants))
	f.objs[o.ID] = o
	return o, nil
}

// idsOfRefs 取 StakeholderRef 上的 id。CreateObject 的入参是整个 domain.Object，
// 没有单独的 participant_ids 通道，调用方只填 ID，Name/Color 由 store 查回来。
func idsOfRefs(refs []domain.StakeholderRef) []string {
	out := make([]string, 0, len(refs))
	for _, r := range refs {
		out = append(out, r.ID)
	}
	return out
}

// refsLocked 把 id 列表翻成展示投影。调用方必须已持锁。
func (f *fakeStore) refsLocked(ids []string) []domain.StakeholderRef {
	out := []domain.StakeholderRef{}
	seen := map[string]bool{}
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ref := domain.StakeholderRef{ID: id}
		if sh, ok := f.stakeholdersMap()[id]; ok {
			ref.Name, ref.Color = sh.Name, sh.Color
		}
		out = append(out, ref)
	}
	return out
}

// ownerNameLocked 与 sqlite 同构：owner_id 指向的人名，没有 owner_id 时回退到
// 0010 之前的自由文本。调用方必须已持锁。
func (f *fakeStore) ownerNameLocked(ownerID *string, legacy string) string {
	if ownerID != nil && *ownerID != "" {
		if sh, ok := f.stakeholdersMap()[*ownerID]; ok {
			return sh.Name
		}
	}
	return legacy
}

func (f *fakeStore) UpdateObject(_ context.Context, id string, p domain.ObjectPatch, a store.Actor) (*domain.Object, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastPatch, f.lastActor = p, a
	o, ok := f.objs[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if p.Title != nil {
		o.Title = *p.Title
	}
	if p.CategoryID != nil {
		o.CategoryID = *p.CategoryID
	}
	if p.DueAt != nil {
		o.DueAt = *p.DueAt
	}
	// owner_id 的空串就是「没有负责人」，和 sqlite 落 NULL 同义。
	if p.OwnerID != nil {
		if v := strings.TrimSpace(*p.OwnerID); v == "" {
			o.OwnerID = nil
		} else {
			o.OwnerID = &v
		}
		o.OwnerName = f.ownerNameLocked(o.OwnerID, o.Owner)
	}
	// 全量替换，不是增量：nil = 不改，空切片 = 清空。
	if p.ParticipantIDs != nil {
		o.Participants = f.refsLocked(*p.ParticipantIDs)
	}
	return o, nil
}

func (f *fakeStore) DeleteObject(_ context.Context, id string, hard bool, a store.Actor) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastHard, f.lastActor = hard, a
	if _, ok := f.objs[id]; !ok {
		return domain.ErrNotFound
	}
	delete(f.objs, id)
	return nil
}

func (f *fakeStore) RestoreObject(_ context.Context, id string, a store.Actor) (*domain.Object, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastActor = a
	o, ok := f.objs[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	o.DeletedAt = nil
	return o, nil
}

func (f *fakeStore) ListTags(context.Context) ([]*domain.Tag, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*domain.Tag, 0, len(f.tags))
	for _, t := range f.tags {
		out = append(out, t)
	}
	return out, nil
}

func (f *fakeStore) CreateTag(_ context.Context, name, color string) (*domain.Tag, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t := &domain.Tag{ID: idgen.Prefixed("tag"), Name: name, Color: color}
	f.tags[t.ID] = t
	return t, nil
}

func (f *fakeStore) DeleteTag(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.tags[id]; !ok {
		return domain.ErrNotFound
	}
	delete(f.tags, id)
	return nil
}

func (f *fakeStore) ListLinks(_ context.Context, objectID string) ([]*domain.LinkView, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*domain.LinkView
	for _, l := range f.links {
		switch objectID {
		case l.FromID:
			out = append(out, &domain.LinkView{Link: *l, Direction: "out", Peer: f.objs[l.ToID]})
		case l.ToID:
			out = append(out, &domain.LinkView{Link: *l, Direction: "in", Peer: f.objs[l.FromID]})
		}
	}
	return out, nil
}

func (f *fakeStore) CreateLink(_ context.Context, fromID, toID, relation, note string) (*domain.Link, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	l := &domain.Link{ID: idgen.Prefixed("lnk"), FromID: fromID, ToID: toID, Relation: relation, Note: note}
	f.links[l.ID] = l
	return l, nil
}

func (f *fakeStore) DeleteLink(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.links[id]; !ok {
		return domain.ErrNotFound
	}
	delete(f.links, id)
	return nil
}

func (f *fakeStore) ListRevisions(_ context.Context, objectID string, limit int) ([]*domain.Revision, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*domain.Revision
	for _, rv := range f.revs {
		if rv.ObjectID == objectID && len(out) < limit {
			out = append(out, rv)
		}
	}
	return out, nil
}

func (f *fakeStore) RecentRevisions(_ context.Context, limit int) ([]*domain.Revision, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if limit > len(f.revs) {
		limit = len(f.revs)
	}
	return f.revs[:limit], nil
}

func (f *fakeStore) Counts(context.Context, string) (*domain.Counts, error) {
	return &domain.Counts{ByType: map[string]int{}, ByStatus: map[string]int{}, Total: len(f.objs)}, nil
}

// --- 快捷访问 ---
// 同样只做够用的内存实现：排序与校验的正经逻辑在 sqlite 那边测。

func (f *fakeStore) ListShortcutGroups(context.Context) ([]*domain.ShortcutGroup, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*domain.ShortcutGroup, 0, len(f.sgroups))
	for _, g := range f.sgroups {
		out = append(out, g)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SortOrder < out[j].SortOrder })
	return out, nil
}

func (f *fakeStore) CreateShortcutGroup(_ context.Context, g *domain.ShortcutGroup) (*domain.ShortcutGroup, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.TrimSpace(g.Name) == "" {
		return nil, domain.ErrValidation
	}
	if g.ID == "" {
		g.ID = idgen.Prefixed("sgr")
	}
	f.sgroups[g.ID] = g
	return g, nil
}

func (f *fakeStore) UpdateShortcutGroup(_ context.Context, id string, p domain.ShortcutGroupPatch) (*domain.ShortcutGroup, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	g, ok := f.sgroups[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if p.Name != nil {
		g.Name = *p.Name
	}
	if p.Collapsed != nil {
		g.Collapsed = *p.Collapsed
	}
	if p.SortOrder != nil {
		g.SortOrder = *p.SortOrder
	}
	return g, nil
}

func (f *fakeStore) DeleteShortcutGroup(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.sgroups[id]; !ok {
		return domain.ErrNotFound
	}
	delete(f.sgroups, id)
	for _, sc := range f.shortcuts {
		if sc.GroupID != nil && *sc.GroupID == id {
			sc.GroupID = nil
		}
	}
	return nil
}

func (f *fakeStore) ListShortcuts(context.Context) ([]*domain.Shortcut, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*domain.Shortcut, 0, len(f.shortcuts))
	for _, sc := range f.shortcuts {
		out = append(out, sc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SortOrder < out[j].SortOrder })
	return out, nil
}

func (f *fakeStore) GetShortcut(_ context.Context, id string) (*domain.Shortcut, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sc, ok := f.shortcuts[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return sc, nil
}

func (f *fakeStore) CreateShortcut(_ context.Context, sc *domain.Shortcut) (*domain.Shortcut, error) {
	if f.errCreateShortcut != nil {
		return nil, f.errCreateShortcut
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if sc.ID == "" {
		sc.ID = idgen.Prefixed("sct")
	}
	f.shortcuts[sc.ID] = sc
	return sc, nil
}

func (f *fakeStore) UpdateShortcut(_ context.Context, id string, p domain.ShortcutPatch) (*domain.Shortcut, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastShortcutPatch = p
	sc, ok := f.shortcuts[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if p.GroupID != nil {
		sc.GroupID = *p.GroupID
	}
	if p.Label != nil {
		sc.Label = *p.Label
	}
	if p.Pinned != nil {
		sc.Pinned = *p.Pinned
	}
	return sc, nil
}

func (f *fakeStore) DeleteShortcut(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.shortcuts[id]; !ok {
		return domain.ErrNotFound
	}
	delete(f.shortcuts, id)
	return nil
}

func (f *fakeStore) VisitShortcut(_ context.Context, id string) (*domain.Shortcut, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sc, ok := f.shortcuts[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	sc.UseCount++
	now := time.Now()
	sc.LastUsedAt = &now
	return sc, nil
}

func (f *fakeStore) ReorderShortcuts(_ context.Context, groupID *string, ids []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastReorderGroup, f.lastReorderIDs = groupID, ids
	if len(ids) == 0 {
		return domain.ErrValidation
	}
	for i, id := range ids {
		sc, ok := f.shortcuts[id]
		if !ok {
			return domain.ErrValidation
		}
		sc.SortOrder = (i + 1) * 10
	}
	return nil
}

// --- 字典 ---
// 同样只做最小记账：唯一性、scope 校验、引用数守卫这些规则都是 sqlite 实现的责任。

func (f *fakeStore) ListDictionaries(_ context.Context, withItems bool) ([]*domain.Dictionary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastDictWithItems = withItems
	out := make([]*domain.Dictionary, 0, len(f.dicts))
	for _, d := range f.dicts {
		c := *d
		if withItems {
			c.Items = f.dictItemsOf(d.ID, nil, false)
		} else {
			c.Items = nil
		}
		out = append(out, &c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (f *fakeStore) ListDictItems(_ context.Context, dictID string, typeID *string, includeArchived bool) ([]*domain.DictItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastDictID, f.lastDictTypeID, f.lastDictArchived = dictID, typeID, includeArchived
	if _, ok := f.dicts[dictID]; !ok {
		return nil, domain.ErrNotFound
	}
	return f.dictItemsOf(dictID, typeID, includeArchived), nil
}

func (f *fakeStore) dictItemsOf(dictID string, typeID *string, includeArchived bool) []*domain.DictItem {
	out := []*domain.DictItem{}
	for _, it := range f.dictItems {
		if it.DictID != dictID {
			continue
		}
		if typeID != nil && (it.TypeID == nil || *it.TypeID != *typeID) {
			continue
		}
		if !includeArchived && it.ArchivedAt != nil {
			continue
		}
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SortOrder < out[j].SortOrder })
	return out
}

func (f *fakeStore) CreateDictItem(_ context.Context, in *domain.DictItem) (*domain.DictItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.dicts[in.DictID]; !ok {
		return nil, domain.ErrNotFound
	}
	if strings.TrimSpace(in.Key) == "" {
		return nil, domain.ErrValidation
	}
	for _, it := range f.dictItems {
		if it.DictID == in.DictID && it.Key == in.Key {
			return nil, domain.ErrConflict
		}
	}
	it := *in
	it.ID = idgen.Prefixed("dit")
	if it.Meta == nil {
		it.Meta = map[string]any{}
	}
	f.dictItems[it.ID] = &it
	return &it, nil
}

func (f *fakeStore) UpdateDictItem(_ context.Context, id string, p domain.DictItemPatch) (*domain.DictItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastDictItemPatch = p
	it, ok := f.dictItems[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if p.Label != nil {
		it.Label = *p.Label
	}
	if p.Color != nil {
		it.Color = *p.Color
	}
	if p.SortOrder != nil {
		it.SortOrder = *p.SortOrder
	}
	if p.Meta != nil {
		it.Meta = *p.Meta
	}
	return it, nil
}

func (f *fakeStore) ArchiveDictItem(_ context.Context, id string, archived bool) (*domain.DictItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastDictArchived = archived
	it, ok := f.dictItems[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if archived {
		now := time.Now()
		it.ArchivedAt = &now
	} else {
		it.ArchivedAt = nil
	}
	return it, nil
}

func (f *fakeStore) DeleteDictItem(_ context.Context, id string) error {
	if f.errDeleteDictItem != nil {
		return f.errDeleteDictItem
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.dictItems[id]; !ok {
		return domain.ErrNotFound
	}
	delete(f.dictItems, id)
	return nil
}

func (f *fakeStore) DictItemUsage(_ context.Context, id string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	it, ok := f.dictItems[id]
	if !ok {
		return 0, domain.ErrNotFound
	}
	return it.Usage, nil
}

func (f *fakeStore) ReorderDictItems(_ context.Context, dictID string, typeID *string, ids []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastDictID, f.lastDictReorderType, f.lastDictReorderIDs = dictID, typeID, ids
	if len(ids) == 0 {
		return domain.ErrValidation
	}
	for i, id := range ids {
		it, ok := f.dictItems[id]
		if !ok {
			return domain.ErrValidation
		}
		it.SortOrder = (i + 1) * 10
	}
	return nil
}

// --- Agent 供应商 ---

// fakeMask 复刻 sqlite 的脱敏规则：前 3 后 4，短于 8 位一律 ***。
func fakeMask(key string) string {
	if key == "" {
		return ""
	}
	r := []rune(key)
	if len(r) < 8 {
		return "***"
	}
	return string(r[:3]) + "\u2026" + string(r[len(r)-4:])
}

func (f *fakeStore) putProvider(p *domain.AgentProvider, key string) {
	p.APIKeyMasked, p.HasAPIKey = fakeMask(key), key != ""
	f.providers[p.ID] = p
	f.providerKeys[p.ID] = key
}

func (f *fakeStore) ListProviders(context.Context) ([]*domain.AgentProvider, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*domain.AgentProvider, 0, len(f.providers))
	for _, p := range f.providers {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (f *fakeStore) GetProvider(_ context.Context, id string) (*domain.AgentProvider, error) {
	if f.errGetProvider != nil {
		return nil, f.errGetProvider
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.providers[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return p, nil
}

func (f *fakeStore) CreateProvider(_ context.Context, p *domain.AgentProvider, apiKey string) (*domain.AgentProvider, error) {
	if f.errCreateProvider != nil {
		return nil, f.errCreateProvider
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastProviderKey = apiKey
	out := *p
	out.ID = idgen.Prefixed("apv")
	if out.Extra == nil {
		out.Extra = map[string]any{}
	}
	f.putProvider(&out, apiKey)
	return &out, nil
}

func (f *fakeStore) UpdateProvider(_ context.Context, id string, in domain.AgentProviderInput) (*domain.AgentProvider, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastProviderInput = in
	p, ok := f.providers[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	key := f.providerKeys[id]
	if in.Name != nil {
		p.Name = *in.Name
	}
	if in.Model != nil {
		p.Model = *in.Model
	}
	if in.Enabled != nil {
		p.Enabled = *in.Enabled
	}
	if in.APIKey != nil {
		key = *in.APIKey
	}
	f.putProvider(p, key)
	return p, nil
}

func (f *fakeStore) DeleteProvider(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastProviderDelID = id
	if _, ok := f.providers[id]; !ok {
		return domain.ErrNotFound
	}
	delete(f.providers, id)
	delete(f.providerKeys, id)
	return nil
}

func (f *fakeStore) SetDefaultProvider(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastProviderDefID = id
	if _, ok := f.providers[id]; !ok {
		return domain.ErrNotFound
	}
	for pid, p := range f.providers {
		p.IsDefault = pid == id
	}
	return nil
}

func (f *fakeStore) ProviderAPIKey(_ context.Context, id string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastProviderTestID = id
	key, ok := f.providerKeys[id]
	if !ok {
		return "", domain.ErrNotFound
	}
	return key, nil
}

// --- 标签维护 ---

func (f *fakeStore) UpdateTag(_ context.Context, id string, name, color *string) (*domain.Tag, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.tags[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if name != nil {
		for _, other := range f.tags {
			if other.ID != id && other.Name == *name {
				return nil, domain.ErrConflict
			}
		}
		t.Name = *name
	}
	if color != nil {
		t.Color = *color
	}
	return t, nil
}

func (f *fakeStore) MergeTags(_ context.Context, srcID, dstID string) (*domain.Tag, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if srcID == dstID {
		return nil, domain.ErrValidation
	}
	src, ok := f.tags[srcID]
	if !ok {
		return nil, domain.ErrNotFound
	}
	dst, ok := f.tags[dstID]
	if !ok {
		return nil, domain.ErrNotFound
	}
	dst.Count += src.Count
	delete(f.tags, srcID)
	return dst, nil
}

// --- 数据与备份 ---

// fakeChecksum 故意超过 8 位，好验证 API 层真的截短了。
const fakeChecksum = "0123456789abcdef0123456789abcdef"

func (f *fakeStore) Migrations(context.Context) ([]domain.MigrationRecord, error) {
	return []domain.MigrationRecord{
		{Version: "0001_init.sql", Checksum: fakeChecksum, AppliedAt: time.Unix(0, 0).UTC()},
	}, nil
}

// Snapshot 把 dir 原样拼进返回的 Path，handler 有没有把参数透传下来一看便知。
func (f *fakeStore) Snapshot(_ context.Context, dir string) (*domain.BackupInfo, error) {
	if dir == "" {
		dir = "/default/backups"
	}
	return &domain.BackupInfo{
		Path:      dir + "/pm-fake.db",
		Size:      4096,
		CreatedAt: time.Unix(0, 0).UTC(),
	}, nil
}

// Export 同理，把 format 回显进文件名和内容，不做真导出。
func (f *fakeStore) Export(_ context.Context, format string) (string, []byte, error) {
	switch format {
	case "json":
		return "pm-export-fake.json", []byte(`{"objects":[]}`), nil
	case "markdown":
		return "pm-export-fake.md", []byte("# 产品工作台数据导出\n"), nil
	}
	return "", nil, domain.ErrValidation
}

// --- Agent 会话 / 消息 / 产物 ---
// 同样只做够用的内存实现：会话列表按 updated_at 倒序（和界面一致），
// 消息和产物保持追加顺序，真正的排序与分页语义在 sqlite 那边测。

func (f *fakeStore) ListAgentSessions(_ context.Context, flt domain.AgentSessionFilter) ([]*domain.AgentSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*domain.AgentSession, 0, len(f.sessions))
	for _, sess := range f.sessions {
		// 两个字段都不给 = 零条，不是全部。照 store.ListAgentSessions 的契约，
		// 替身在这里放宽的话，「忘了传 filter 会看到别人的会话」这件事就只能在生产上验证。
		switch {
		case flt.ObjectID != "":
			if sess.ObjectID == nil || *sess.ObjectID != flt.ObjectID {
				continue
			}
		case flt.Unscoped:
			if sess.ObjectID != nil {
				continue
			}
		default:
			continue
		}
		c := *sess
		c.MessageCount = len(f.messages[c.ID])
		out = append(out, &c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].ID < out[j].ID
		}
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	return out, nil
}

func (f *fakeStore) GetAgentSession(_ context.Context, id string) (*domain.AgentSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sess, ok := f.sessions[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	c := *sess
	c.MessageCount = len(f.messages[id])
	return &c, nil
}

func (f *fakeStore) CreateAgentSession(_ context.Context, sess *domain.AgentSession) (*domain.AgentSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// 和 sqlite 同构：挂给一个不存在的对象是 ErrNotFound，空串当没传。
	// 替身放过它的话，「显式指定的归属猜错了会话就出现在错误的地方」这条
	// 只能在生产上验证。
	if sess.ObjectID != nil {
		if id := strings.TrimSpace(*sess.ObjectID); id == "" {
			sess.ObjectID = nil
		} else if _, ok := f.objs[id]; !ok {
			return nil, domain.ErrNotFound
		}
	}
	if sess.ID == "" {
		sess.ID = idgen.Prefixed("ses")
	}
	if sess.CreatedAt.IsZero() {
		sess.CreatedAt = time.Now()
	}
	sess.UpdatedAt = sess.CreatedAt
	f.sessions[sess.ID] = sess
	return sess, nil
}

func (f *fakeStore) UpdateAgentSession(_ context.Context, id string, title, workdir, providerID, model *string) (*domain.AgentSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sess, ok := f.sessions[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if title != nil {
		sess.Title = *title
	}
	if workdir != nil {
		sess.Workdir = *workdir
	}
	if providerID != nil {
		sess.ProviderID = *providerID
	}
	if model != nil {
		sess.Model = *model
	}
	sess.UpdatedAt = time.Now()
	c := *sess
	c.MessageCount = len(f.messages[id])
	return &c, nil
}

// DeleteAgentSession 连消息和产物一起删：它们没有会话就是孤儿。
func (f *fakeStore) DeleteAgentSession(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.sessions[id]; !ok {
		return domain.ErrNotFound
	}
	delete(f.sessions, id)
	delete(f.messages, id)
	delete(f.artifacts, id)
	return nil
}

// ListAgentMessages 取**最近** limit 条、按时间正序返回，limit <= 0 表示全部。
// 不是最早 N 条：对话框要的是「最近说了什么」。会话不存在时回空列表而不是报错，
// 这两条都跟 sqlite 实现对齐——fake 在被测到的性质上必须同构，否则 API 测试会绿着骗人。
func (f *fakeStore) ListAgentMessages(_ context.Context, sessionID string, limit int) ([]*domain.AgentMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	all := f.messages[sessionID]
	if limit > 0 && limit < len(all) {
		all = all[len(all)-limit:]
	}
	out := make([]*domain.AgentMessage, len(all))
	copy(out, all)
	return out, nil
}

func (f *fakeStore) AppendAgentMessage(_ context.Context, m *domain.AgentMessage) (*domain.AgentMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.sessions[m.SessionID]; !ok {
		return nil, domain.ErrNotFound
	}
	if m.ID == "" {
		m.ID = idgen.Prefixed("msg")
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = time.Now()
	}
	f.messages[m.SessionID] = append(f.messages[m.SessionID], m)
	// 追加消息算会话有活动，刷新 updated_at，列表排序才对得上。
	if sess, ok := f.sessions[m.SessionID]; ok {
		sess.UpdatedAt = m.CreatedAt
	}
	return m, nil
}

// 同样跟 sqlite 对齐：会话不存在回空列表，不报 not found。
func (f *fakeStore) ListAgentArtifacts(_ context.Context, sessionID string) ([]*domain.AgentArtifact, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*domain.AgentArtifact, len(f.artifacts[sessionID]))
	copy(out, f.artifacts[sessionID])
	return out, nil
}

func (f *fakeStore) RecordAgentArtifact(_ context.Context, a *domain.AgentArtifact) (*domain.AgentArtifact, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.sessions[a.SessionID]; !ok {
		return nil, domain.ErrNotFound
	}
	if a.ID == "" {
		a.ID = idgen.Prefixed("art")
	}
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now()
	}
	f.artifacts[a.SessionID] = append(f.artifacts[a.SessionID], a)
	return a, nil
}

// ResolveWorkdir 复刻「自身没设就回退到所属项目」这一条规则——API 层的 fake
// 一般不复刻业务规则，但这条规则本身就是契约，handler 的行为依赖它。
func (f *fakeStore) ResolveWorkdir(_ context.Context, objectID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objs[objectID]
	if !ok {
		return "", domain.ErrNotFound
	}
	if o.Workdir != "" {
		return o.Workdir, nil
	}
	if o.ProjectID == nil || *o.ProjectID == "" {
		return "", nil
	}
	p, ok := f.objs[*o.ProjectID]
	if !ok {
		return "", nil
	}
	return p.Workdir, nil
}

// ---- 任务执行记录 ----
//
// 同样只做够用的内存记账。但有三条性质必须和 sqlite 实现同构，因为 handler
// 的行为直接压在它们上面，fake 对不上的话 API 测试会绿着骗人：
//   - 历史按 started_at 倒序（最近一次在最前）
//   - workdir 为空一律拒绝
//   - 已经收尾的记录不能再收一次（取消与自然结束撞车时，先到的那个才是真相）

func (f *fakeStore) runsMap() map[string]*domain.TaskRun {
	if f.taskRuns == nil {
		f.taskRuns = map[string]*domain.TaskRun{}
		f.taskRunSeq = map[string]int{}
	}
	return f.taskRuns
}

func (f *fakeStore) ListTaskRuns(_ context.Context, objectID string, limit int) ([]*domain.TaskRun, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []*domain.TaskRun{}
	for _, r := range f.runsMap() {
		if r.ObjectID == objectID {
			c := *r
			out = append(out, &c)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt.Equal(out[j].StartedAt) {
			// 后插入的在前，和 sqlite 的 rowid DESC 同构。不能比 ID：
			// idgen 的 id 只到毫秒有序，同一毫秒内的低位是随机数。
			return f.taskRunSeq[out[i].ID] > f.taskRunSeq[out[j].ID]
		}
		return out[i].StartedAt.After(out[j].StartedAt)
	})
	// limit <= 0 走 store.DefaultRunLimit，不是「全部」——照 store.ListTaskRuns 的契约。
	// 替身在这里放宽的话，「不传 limit 会不会拉爆内存」这件事就只能在生产上验证。
	if limit <= 0 {
		limit = store.DefaultRunLimit
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeStore) GetTaskRun(_ context.Context, id string) (*domain.TaskRun, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.runsMap()[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	c := *r
	return &c, nil
}

func (f *fakeStore) CreateTaskRun(_ context.Context, in *domain.TaskRun) (*domain.TaskRun, error) {
	if f.errCreateTaskRun != nil {
		return nil, f.errCreateTaskRun
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if in == nil || strings.TrimSpace(in.ObjectID) == "" {
		return nil, domain.ErrValidation
	}
	// workdir 必填是这条链路最要紧的一道校验，fake 也得守着，
	// 否则「空目录被拒」的 handler 测试会因为 fake 放行而失去意义。
	if strings.TrimSpace(in.Workdir) == "" {
		return nil, domain.ErrValidation
	}
	if _, ok := f.objs[in.ObjectID]; !ok {
		return nil, domain.ErrNotFound
	}
	c := *in
	c.ID = idgen.Prefixed("run")
	if c.Status == "" {
		c.Status = domain.RunPending
	}
	c.StartedAt = time.Now()
	c.FinishedAt = nil
	f.runsMap()[c.ID] = &c
	f.taskRunSeq[c.ID] = len(f.taskRunSeq) + 1
	out := c
	return &out, nil
}

func (f *fakeStore) FinishTaskRun(_ context.Context, id, status string, exitCode int, output, errMsg string) (*domain.TaskRun, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.runsMap()[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if r.FinishedAt != nil {
		return nil, domain.ErrConflict
	}
	now := time.Now()
	r.Status, r.ExitCode, r.Output, r.Error, r.FinishedAt = status, exitCode, output, errMsg, &now
	c := *r
	return &c, nil
}

// ---- 干系人名册 ----
//
// 这批是主会话随契约一起放的**可用实现**，不是 panic 桩：并行的 agent 要靠它编译。
// stakeholder-backend 落地 sqlite 实现后，如果发现这里和真实现有语义分歧，
// **改这里让它跟上**，不要在测试里绕开——替身比真实现宽松，等于那条性质永远测不到。

func (f *fakeStore) stakeholdersMap() map[string]*domain.Stakeholder {
	if f.stakeholders == nil {
		f.stakeholders = map[string]*domain.Stakeholder{}
	}
	return f.stakeholders
}

func (f *fakeStore) ListStakeholders(_ context.Context, includeArchived bool) ([]*domain.Stakeholder, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []*domain.Stakeholder{}
	for _, sh := range f.stakeholdersMap() {
		if !includeArchived && sh.ArchivedAt != nil {
			continue
		}
		c := *sh
		c.OwnedCount, c.ParticipatingCount = f.stakeholderUsage(sh.ID)
		out = append(out, &c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SortOrder != out[j].SortOrder {
			return out[i].SortOrder < out[j].SortOrder
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// stakeholderReferencedLocked 判断还有没有任何对象引用这个人，软删的也算。
// 调用方必须已持锁。
func (f *fakeStore) stakeholderReferencedLocked(id string) bool {
	for _, o := range f.objs {
		if o.OwnerID != nil && *o.OwnerID == id {
			return true
		}
		for _, p := range o.Participants {
			if p.ID == id {
				return true
			}
		}
	}
	return false
}

// stakeholderUsage 数引用。调用方必须已持锁。
func (f *fakeStore) stakeholderUsage(id string) (owned, participating int) {
	for _, o := range f.objs {
		if o.DeletedAt != nil {
			continue
		}
		if o.OwnerID != nil && *o.OwnerID == id {
			owned++
		}
		for _, p := range o.Participants {
			if p.ID == id {
				participating++
			}
		}
	}
	return
}

func (f *fakeStore) GetStakeholder(_ context.Context, id string) (*domain.Stakeholder, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sh, ok := f.stakeholdersMap()[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	c := *sh
	c.OwnedCount, c.ParticipatingCount = f.stakeholderUsage(id)
	return &c, nil
}

func (f *fakeStore) CreateStakeholder(_ context.Context, sh *domain.Stakeholder) (*domain.Stakeholder, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	name := strings.TrimSpace(sh.Name)
	if name == "" {
		return nil, domain.ErrValidation
	}
	for _, e := range f.stakeholdersMap() {
		if e.Name == name {
			return nil, domain.ErrConflict // 同名唯一，和 0010 的唯一索引一致
		}
	}
	c := *sh
	c.Name = name
	if c.ID == "" {
		c.ID = "stk_fake_" + strconv.Itoa(len(f.stakeholdersMap())+1)
	}
	now := time.Now()
	c.CreatedAt, c.UpdatedAt = now, now
	f.stakeholdersMap()[c.ID] = &c
	out := c
	return &out, nil
}

func (f *fakeStore) UpdateStakeholder(_ context.Context, id string, p domain.StakeholderPatch) (*domain.Stakeholder, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sh, ok := f.stakeholdersMap()[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if p.Name != nil {
		if strings.TrimSpace(*p.Name) == "" {
			return nil, domain.ErrValidation
		}
		for _, e := range f.stakeholdersMap() {
			if e.ID != id && e.Name == *p.Name {
				return nil, domain.ErrConflict
			}
		}
		sh.Name = *p.Name
	}
	if p.Role != nil {
		sh.Role = *p.Role
	}
	if p.Email != nil {
		sh.Email = *p.Email
	}
	if p.Note != nil {
		sh.Note = *p.Note
	}
	if p.Color != nil {
		sh.Color = *p.Color
	}
	if p.SortOrder != nil {
		sh.SortOrder = *p.SortOrder
	}
	if p.Archived != nil {
		if *p.Archived {
			now := time.Now()
			sh.ArchivedAt = &now
		} else {
			sh.ArchivedAt = nil
		}
	}
	sh.UpdatedAt = time.Now()
	c := *sh
	c.OwnedCount, c.ParticipatingCount = f.stakeholderUsage(id)
	return &c, nil
}

func (f *fakeStore) DeleteStakeholder(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.stakeholdersMap()[id]; !ok {
		return domain.ErrNotFound
	}
	// 删除检查连回收站里的软删对象一起数，和 sqlite 一致：owner_id 是
	// ON DELETE SET NULL，删了人之后那条对象恢复回来时负责人已经没了。
	// 展示用的 OwnedCount 不算软删的——那是「他手上有多少事」，两个口径不能合并。
	if f.stakeholderReferencedLocked(id) {
		return domain.ErrConflict // 有引用只能归档
	}
	delete(f.stakeholdersMap(), id)
	return nil
}
