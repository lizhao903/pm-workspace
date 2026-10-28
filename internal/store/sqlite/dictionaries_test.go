package sqlite

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// findDictItem 在列表里按 key 找条目，找不到返回 nil。
func findDictItem(items []*domain.DictItem, key string) *domain.DictItem {
	for _, it := range items {
		if it.Key == key {
			return it
		}
	}
	return nil
}

func mustDictItems(t *testing.T, s *Store, ctx context.Context, dictID string, includeArchived bool) []*domain.DictItem {
	t.Helper()
	items, err := s.ListDictItems(ctx, dictID, nil, includeArchived)
	if err != nil {
		t.Fatalf("list dict items %s: %v", dictID, err)
	}
	return items
}

func TestMigrationSeedsBuiltinDictionaries(t *testing.T) {
	s, ctx := newStore(t)

	dicts, err := s.ListDictionaries(ctx, true)
	if err != nil {
		t.Fatalf("list dictionaries: %v", err)
	}
	if len(dicts) != 3 {
		t.Fatalf("want 3 builtin dictionaries, got %d", len(dicts))
	}

	byID := map[string]*domain.Dictionary{}
	for _, d := range dicts {
		byID[d.ID] = d
	}
	prio, ok := byID[domain.DictPriority]
	if !ok {
		t.Fatal("priority dictionary missing")
	}
	if !prio.Builtin || prio.Scope != domain.ScopeGlobal {
		t.Errorf("priority: builtin=%v scope=%q, want true/global", prio.Builtin, prio.Scope)
	}
	if len(prio.Items) != 4 {
		t.Fatalf("priority items = %d, want 4", len(prio.Items))
	}
	// 排序号决定下拉里的先后，种子给的是 10/20/30/40。
	wantKeys := []string{"P0", "P1", "P2", "P3"}
	for i, it := range prio.Items {
		if it.Key != wantKeys[i] {
			t.Errorf("priority item %d = %q, want %q", i, it.Key, wantKeys[i])
		}
	}
	if p0 := findDictItem(prio.Items, "P0"); p0 == nil || p0.Color != "#c92a2a" || p0.Label != "最高" {
		t.Errorf("P0 = %+v, want 最高/#c92a2a", p0)
	}

	rel, ok := byID[domain.DictLinkRelation]
	if !ok {
		t.Fatal("link_relation dictionary missing")
	}
	if len(rel.Items) != 5 {
		t.Fatalf("link_relation items = %d, want 5", len(rel.Items))
	}
	blocks := findDictItem(rel.Items, "blocks")
	if blocks == nil {
		t.Fatal("blocks relation missing")
	}
	// meta.inverse 供详情页在对端对象上显示反向关系名。
	if blocks.Meta["inverse"] != "被阻塞于" {
		t.Errorf("blocks meta = %+v, want inverse=被阻塞于", blocks.Meta)
	}

	plat, ok := byID[domain.DictArtifactPlatform]
	if !ok {
		t.Fatal("artifact_platform dictionary missing")
	}
	if !plat.Builtin || plat.Scope != domain.ScopeGlobal {
		t.Errorf("artifact_platform: builtin=%v scope=%q, want true/global", plat.Builtin, plat.Scope)
	}
	// local 必须在，而且必须排第一：sqlite 那边 normalizeArtifact 在没给平台、
	// 也没有链接时会落到 "local"。种子里没有它的话，产物会指向一个不存在的
	// 字典项——界面上显示成一个没有名字的灰块，而且不会报错。
	if local := findDictItem(plat.Items, "local"); local == nil {
		t.Error("artifact_platform 缺少 local，本地产物会落到一个不存在的字典项上")
	}
	if other := findDictItem(plat.Items, "other"); other == nil {
		t.Error("artifact_platform 缺少 other，没指定平台的云端产物会落空")
	}

	// meta.hosts 是界面粘链接时自动选平台的依据。它写坏了不会报错，
	// 只会让自动识别安静地永远不命中——所以这里逐条解出来看结构对不对。
	for _, it := range plat.Items {
		raw, ok := it.Meta["hosts"]
		if !ok {
			t.Errorf("平台 %s 缺 meta.hosts", it.Key)
			continue
		}
		hosts, ok := raw.([]any)
		if !ok {
			t.Errorf("平台 %s 的 meta.hosts = %T，期望数组", it.Key, raw)
			continue
		}
		for _, h := range hosts {
			if sv, ok := h.(string); !ok || strings.TrimSpace(sv) == "" {
				t.Errorf("平台 %s 的 hosts 里有空项或非字符串: %#v", it.Key, h)
			}
		}
	}
	// confluence 的特征串要真能匹配上一个 Confluence 链接。
	// 只验「是个数组」的话，写成 [""] 也能过，而那会匹配任何链接。
	conf := findDictItem(plat.Items, "confluence")
	if conf == nil {
		t.Fatal("artifact_platform 缺少 confluence")
	}
	sample := "https://mycorp.atlassian.net/wiki/spaces/PM/pages/123/方案"
	hit := false
	for _, h := range conf.Meta["hosts"].([]any) {
		if strings.Contains(sample, h.(string)) {
			hit = true
		}
	}
	if !hit {
		t.Errorf("confluence 的 hosts %v 匹配不上一个真实的 Confluence 链接", conf.Meta["hosts"])
	}
}

func TestListDictionariesWithoutItems(t *testing.T) {
	s, ctx := newStore(t)

	dicts, err := s.ListDictionaries(ctx, false)
	if err != nil {
		t.Fatalf("list dictionaries: %v", err)
	}
	for _, d := range dicts {
		if d.Items != nil {
			t.Errorf("dict %s: items should stay nil when withItems=false", d.ID)
		}
	}
}

func TestListDictItemsUnknownDictionary(t *testing.T) {
	s, ctx := newStore(t)

	if _, err := s.ListDictItems(ctx, "nope", nil, false); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestCreateDictItemRejectsDuplicateKey(t *testing.T) {
	s, ctx := newStore(t)

	if _, err := s.CreateDictItem(ctx, &domain.DictItem{
		DictID: domain.DictPriority, Key: "P0", Label: "又一个最高",
	}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
}

func TestCreateDictItemRequiresKeyAndLabel(t *testing.T) {
	s, ctx := newStore(t)

	if _, err := s.CreateDictItem(ctx, &domain.DictItem{
		DictID: domain.DictPriority, Key: "  ", Label: "无 key",
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("empty key: err = %v, want ErrValidation", err)
	}
	if _, err := s.CreateDictItem(ctx, &domain.DictItem{
		DictID: domain.DictPriority, Key: "P4", Label: " ",
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("empty label: err = %v, want ErrValidation", err)
	}
}

func TestCreateDictItemAppendsToEnd(t *testing.T) {
	s, ctx := newStore(t)

	p4, err := s.CreateDictItem(ctx, &domain.DictItem{
		DictID: domain.DictPriority, Key: "P4", Label: "最低", Color: "#ced4da",
	})
	if err != nil {
		t.Fatalf("create P4: %v", err)
	}
	// 种子末尾是 40，未指定排序号就该接在 50。
	if p4.SortOrder != 50 {
		t.Errorf("sort_order = %d, want 50", p4.SortOrder)
	}
	if p4.Meta == nil {
		t.Error("meta 应该回一个空对象而不是 nil")
	}

	items := mustDictItems(t, s, ctx, domain.DictPriority, false)
	if len(items) != 5 || items[4].Key != "P4" {
		t.Fatalf("P4 应该排在末尾, got %+v", items)
	}
}

func TestCreateDictItemChecksScopeAgainstTypeID(t *testing.T) {
	s, ctx := newStore(t)

	// priority 是 global 字典，带 type_id 的条目会落到一个谁也查不到的位置。
	if _, err := s.CreateDictItem(ctx, &domain.DictItem{
		DictID: domain.DictPriority, TypeID: pstr("task"), Key: "P4", Label: "最低",
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("global + type_id: err = %v, want ErrValidation", err)
	}

	// 反过来：type 字典漏了 type_id 同样不行。
	if _, err := s.db.W.ExecContext(ctx,
		`INSERT INTO dictionaries (id,name,description,scope,builtin,sort_order,created_at,updated_at)
		 VALUES ('raid_impact','影响分级','','type',0,30,datetime('now'),datetime('now'))`); err != nil {
		t.Fatalf("seed type-scoped dict: %v", err)
	}
	if _, err := s.CreateDictItem(ctx, &domain.DictItem{
		DictID: "raid_impact", Key: "high", Label: "高",
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("type scope without type_id: err = %v, want ErrValidation", err)
	}

	// 带上合法 type_id 就该通过，同一个 key 在不同类型下互不冲突。
	for _, typeID := range []string{"task", "requirement"} {
		if _, err := s.CreateDictItem(ctx, &domain.DictItem{
			DictID: "raid_impact", TypeID: pstr(typeID), Key: "high", Label: "高",
		}); err != nil {
			t.Fatalf("create raid_impact/%s: %v", typeID, err)
		}
	}
	// 未登记引用来源的新字典，引用数一律为 0，不该报错。
	items, err := s.ListDictItems(ctx, "raid_impact", pstr("task"), false)
	if err != nil {
		t.Fatalf("list raid_impact: %v", err)
	}
	if len(items) != 1 || items[0].Usage != 0 {
		t.Fatalf("raid_impact/task = %+v, want 1 item with usage 0", items)
	}
}

func TestCreateDictItemRejectsUnknownType(t *testing.T) {
	s, ctx := newStore(t)

	if _, err := s.db.W.ExecContext(ctx,
		`INSERT INTO dictionaries (id,name,description,scope,builtin,sort_order,created_at,updated_at)
		 VALUES ('adr_status','ADR 状态','','type',0,40,datetime('now'),datetime('now'))`); err != nil {
		t.Fatalf("seed dict: %v", err)
	}
	if _, err := s.CreateDictItem(ctx, &domain.DictItem{
		DictID: "adr_status", TypeID: pstr("ghost"), Key: "draft", Label: "草稿",
	}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestUpdateDictItemCannotChangeKey(t *testing.T) {
	s, ctx := newStore(t)

	items := mustDictItems(t, s, ctx, domain.DictPriority, false)
	p0 := findDictItem(items, "P0")
	if p0 == nil {
		t.Fatal("P0 missing")
	}

	// DictItemPatch 里就没有 Key 字段，这里能做的只有确认改别的字段不会波及 key。
	out, err := s.UpdateDictItem(ctx, p0.ID, domain.DictItemPatch{
		Label: pstr("紧急"), Color: pstr("#ff0000"),
		Meta: &map[string]any{"note": "线上故障级"},
	})
	if err != nil {
		t.Fatalf("update P0: %v", err)
	}
	if out.Key != "P0" {
		t.Fatalf("key = %q, want P0", out.Key)
	}
	if out.Label != "紧急" || out.Color != "#ff0000" || out.Meta["note"] != "线上故障级" {
		t.Errorf("update 没生效: %+v", out)
	}

	reread := findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, false), "P0")
	if reread == nil || reread.Label != "紧急" {
		t.Fatalf("重读后 = %+v", reread)
	}
}

func TestUpdateDictItemRejectsEmptyLabel(t *testing.T) {
	s, ctx := newStore(t)

	p0 := findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, false), "P0")
	if _, err := s.UpdateDictItem(ctx, p0.ID, domain.DictItemPatch{Label: pstr("  ")}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, want ErrValidation", err)
	}
}

func TestUpdateDictItemNotFound(t *testing.T) {
	s, ctx := newStore(t)

	if _, err := s.UpdateDictItem(ctx, "dit_ghost", domain.DictItemPatch{Label: pstr("x")}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestArchiveDictItemHidesItFromDefaultList(t *testing.T) {
	s, ctx := newStore(t)

	p3 := findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, false), "P3")
	out, err := s.ArchiveDictItem(ctx, p3.ID, true)
	if err != nil {
		t.Fatalf("archive P3: %v", err)
	}
	if out.ArchivedAt == nil {
		t.Fatal("archived_at 应该被写上")
	}

	if findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, false), "P3") != nil {
		t.Error("停用的条目不该出现在默认列表里")
	}
	// 停用不是删除：历史数据要靠它取 label 和颜色，includeArchived 必须还能拿到。
	archived := findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, true), "P3")
	if archived == nil {
		t.Fatal("includeArchived=true 应该能拿到停用的条目")
	}
	if archived.ArchivedAt == nil {
		t.Error("列表里的 archived_at 丢了")
	}

	back, err := s.ArchiveDictItem(ctx, p3.ID, false)
	if err != nil {
		t.Fatalf("unarchive P3: %v", err)
	}
	if back.ArchivedAt != nil {
		t.Error("启用后 archived_at 应该清空")
	}
	if findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, false), "P3") == nil {
		t.Error("启用后应该回到默认列表")
	}
}

func TestDeleteDictItemBlockedByUsage(t *testing.T) {
	s, ctx := newStore(t)

	for i := 0; i < 3; i++ {
		mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "急事", Priority: "P0"})
	}
	p0 := findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, false), "P0")
	if p0.Usage != 3 {
		t.Fatalf("usage = %d, want 3", p0.Usage)
	}

	err := s.DeleteDictItem(ctx, p0.ID)
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
	// 数量要进 message：界面据此提示影响面有多大。
	if !strings.Contains(err.Error(), "3") {
		t.Errorf("message = %q, 应该带上引用数", err.Error())
	}
	if !strings.Contains(err.Error(), "priority") {
		t.Errorf("message = %q, 应该说清是哪个字典", err.Error())
	}

	// 软删的对象不该再算数：删掉唯一一批引用后就能删了。
	objs, _, err := s.ListObjects(ctx, domain.ObjectFilter{Priorities: []string{"P0"}})
	if err != nil {
		t.Fatalf("list objects: %v", err)
	}
	for _, o := range objs {
		if err := s.DeleteObject(ctx, o.ID, false, store.DefaultActor); err != nil {
			t.Fatalf("soft delete %s: %v", o.ID, err)
		}
	}
	if err := s.DeleteDictItem(ctx, p0.ID); err != nil {
		t.Fatalf("引用清零后仍删不掉: %v", err)
	}
	if findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, true), "P0") != nil {
		t.Error("P0 应该已经被删掉")
	}
}

func TestDeleteDictItemWithoutUsage(t *testing.T) {
	s, ctx := newStore(t)

	p3 := findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, false), "P3")
	if err := s.DeleteDictItem(ctx, p3.ID); err != nil {
		t.Fatalf("delete P3: %v", err)
	}
	if err := s.DeleteDictItem(ctx, p3.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("重复删除 err = %v, want ErrNotFound", err)
	}
}

func TestDictItemUsageDispatch(t *testing.T) {
	s, ctx := newStore(t)

	a := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "甲", Priority: "P1"})
	b := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "乙", Priority: "P2"})
	if _, err := s.CreateLink(ctx, a.ID, b.ID, "blocks", ""); err != nil {
		t.Fatalf("create link: %v", err)
	}

	p1 := findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, false), "P1")
	n, err := s.DictItemUsage(ctx, p1.ID)
	if err != nil {
		t.Fatalf("usage P1: %v", err)
	}
	if n != 1 {
		t.Errorf("P1 usage = %d, want 1", n)
	}

	blocks := findDictItem(mustDictItems(t, s, ctx, domain.DictLinkRelation, false), "blocks")
	if n, err = s.DictItemUsage(ctx, blocks.ID); err != nil {
		t.Fatalf("usage blocks: %v", err)
	}
	if n != 1 {
		t.Errorf("blocks usage = %d, want 1", n)
	}

	relates := findDictItem(mustDictItems(t, s, ctx, domain.DictLinkRelation, false), "relates")
	if n, err = s.DictItemUsage(ctx, relates.ID); err != nil {
		t.Fatalf("usage relates: %v", err)
	}
	if n != 0 {
		t.Errorf("relates usage = %d, want 0", n)
	}

	if _, err := s.DictItemUsage(ctx, "dit_ghost"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestReorderDictItemsRequiresFullList(t *testing.T) {
	s, ctx := newStore(t)

	items := mustDictItems(t, s, ctx, domain.DictPriority, false)
	ids := make([]string, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}

	// 少传：漏掉的条目会留在旧位置，界面和库就对不上。
	if err := s.ReorderDictItems(ctx, domain.DictPriority, nil, ids[:2]); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("partial ids: err = %v, want ErrValidation", err)
	}
	if err := s.ReorderDictItems(ctx, domain.DictPriority, nil, nil); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("empty ids: err = %v, want ErrValidation", err)
	}
	dup := []string{ids[0], ids[0], ids[1], ids[2]}
	if err := s.ReorderDictItems(ctx, domain.DictPriority, nil, dup); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("duplicated ids: err = %v, want ErrValidation", err)
	}

	// 混进别的字典的条目也要拒。
	blocks := findDictItem(mustDictItems(t, s, ctx, domain.DictLinkRelation, false), "blocks")
	outsider := []string{ids[0], ids[1], ids[2], blocks.ID}
	if err := s.ReorderDictItems(ctx, domain.DictPriority, nil, outsider); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("foreign id: err = %v, want ErrValidation", err)
	}

	if err := s.ReorderDictItems(ctx, "nope", nil, ids); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unknown dict: err = %v, want ErrNotFound", err)
	}

	// 全量倒序：P3 P2 P1 P0。
	rev := []string{ids[3], ids[2], ids[1], ids[0]}
	if err := s.ReorderDictItems(ctx, domain.DictPriority, nil, rev); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	after := mustDictItems(t, s, ctx, domain.DictPriority, false)
	wantKeys := []string{"P3", "P2", "P1", "P0"}
	for i, it := range after {
		if it.Key != wantKeys[i] {
			t.Errorf("位置 %d = %q, want %q", i, it.Key, wantKeys[i])
		}
		if it.SortOrder != (i+1)*10 {
			t.Errorf("%s sort_order = %d, want %d", it.Key, it.SortOrder, (i+1)*10)
		}
	}
}

func TestReorderDictItemsCountsArchived(t *testing.T) {
	s, ctx := newStore(t)

	items := mustDictItems(t, s, ctx, domain.DictPriority, false)
	if _, err := s.ArchiveDictItem(ctx, items[3].ID, true); err != nil {
		t.Fatalf("archive: %v", err)
	}
	// 停用的条目在设置页里仍然可见可拖，全量校验必须把它算进去。
	visible := []string{items[0].ID, items[1].ID, items[2].ID}
	if err := s.ReorderDictItems(ctx, domain.DictPriority, nil, visible); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, want ErrValidation", err)
	}
	all := []string{items[3].ID, items[0].ID, items[1].ID, items[2].ID}
	if err := s.ReorderDictItems(ctx, domain.DictPriority, nil, all); err != nil {
		t.Fatalf("reorder with archived: %v", err)
	}
}

func TestDeleteDictItemMessagePluralization(t *testing.T) {
	s, ctx := newStore(t)

	a := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "唯一一条", Priority: "P2"})
	b := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "对端", Priority: ""})
	if _, err := s.CreateLink(ctx, a.ID, b.ID, "relates", ""); err != nil {
		t.Fatalf("create link: %v", err)
	}

	p2 := findDictItem(mustDictItems(t, s, ctx, domain.DictPriority, false), "P2")
	err := s.DeleteDictItem(ctx, p2.ID)
	if got, want := err.Error(), "priority value is used by 1 object"; got != want {
		t.Errorf("message = %q, want %q", got, want)
	}

	relates := findDictItem(mustDictItems(t, s, ctx, domain.DictLinkRelation, false), "relates")
	err = s.DeleteDictItem(ctx, relates.ID)
	if got, want := err.Error(), "link_relation value is used by 1 link"; got != want {
		t.Errorf("message = %q, want %q", got, want)
	}
}
