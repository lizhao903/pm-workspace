package sqlite

import (
	"context"
	"errors"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func mustStakeholder(t *testing.T, s *Store, ctx context.Context, name string) *domain.Stakeholder {
	t.Helper()
	sh, err := s.CreateStakeholder(ctx, &domain.Stakeholder{Name: name})
	if err != nil {
		t.Fatalf("create stakeholder %q: %v", name, err)
	}
	return sh
}

func namesOf(items []*domain.Stakeholder) []string {
	out := make([]string, 0, len(items))
	for _, sh := range items {
		out = append(out, sh.Name)
	}
	return out
}

func participantIDs(o *domain.Object) []string {
	out := make([]string, 0, len(o.Participants))
	for _, ref := range o.Participants {
		out = append(out, ref.ID)
	}
	return out
}

// 同名不许重复：干系人靠名字辨认，出现两个「张三」时用户无从选择，
// 而错选的后果是任务分配到了另一个人身上。
func TestCreateStakeholderRejectsDuplicateName(t *testing.T) {
	s, ctx := newStore(t)
	mustStakeholder(t, s, ctx, "张三")

	if _, err := s.CreateStakeholder(ctx, &domain.Stakeholder{Name: "张三"}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("重名应返回 ErrConflict, 得到 %v", err)
	}
	// 改名撞上已有的人同样要拦：否则绕一圈就能造出两个同名的人。
	other := mustStakeholder(t, s, ctx, "王闯")
	if _, err := s.UpdateStakeholder(ctx, other.ID,
		domain.StakeholderPatch{Name: pstr("张三")}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("改成重名应返回 ErrConflict, 得到 %v", err)
	}
	if _, err := s.CreateStakeholder(ctx, &domain.Stakeholder{Name: "   "}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("空名字应返回 ErrValidation, 得到 %v", err)
	}
}

// 归档的人不出现在默认列表里（选人时用），但名册管理页要看得到。
func TestListStakeholdersArchivedVisibility(t *testing.T) {
	s, ctx := newStore(t)
	mustStakeholder(t, s, ctx, "在岗的")
	left := mustStakeholder(t, s, ctx, "离职的")

	yes := true
	if _, err := s.UpdateStakeholder(ctx, left.ID, domain.StakeholderPatch{Archived: &yes}); err != nil {
		t.Fatalf("archive: %v", err)
	}

	active, err := s.ListStakeholders(ctx, false)
	if err != nil {
		t.Fatalf("list active: %v", err)
	}
	if got := namesOf(active); len(got) != 1 || got[0] != "在岗的" {
		t.Fatalf("默认列表 = %v, want [在岗的]（归档的人不该出现在选人下拉里）", got)
	}

	all, err := s.ListStakeholders(ctx, true)
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("includeArchived 列表 = %v, want 2 条（名册管理页要看得到离职的人）", namesOf(all))
	}

	// 复岗要能把人放回默认列表，否则归档就成了不可逆操作。
	no := false
	if _, err := s.UpdateStakeholder(ctx, left.ID, domain.StakeholderPatch{Archived: &no}); err != nil {
		t.Fatalf("unarchive: %v", err)
	}
	active, err = s.ListStakeholders(ctx, false)
	if err != nil {
		t.Fatalf("list active: %v", err)
	}
	if len(active) != 2 {
		t.Fatalf("复岗后默认列表 = %v, want 2 条", namesOf(active))
	}
}

// 有引用不许删，只能归档：人被历史对象引用过，删掉会在列表里留下一个查不出来源的空位。
func TestDeleteStakeholderBlockedByReferences(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustStakeholder(t, s, ctx, "负责的人")
	part := mustStakeholder(t, s, ctx, "参与的人")
	free := mustStakeholder(t, s, ctx, "没事做的人")

	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "某任务", OwnerID: &owner.ID,
		Participants: []domain.StakeholderRef{{ID: part.ID}},
	})

	if err := s.DeleteStakeholder(ctx, owner.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("删负责人应返回 ErrConflict, 得到 %v", err)
	}
	if err := s.DeleteStakeholder(ctx, part.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("删参与人应返回 ErrConflict, 得到 %v", err)
	}
	if err := s.DeleteStakeholder(ctx, free.ID); err != nil {
		t.Fatalf("零引用的人应能删除: %v", err)
	}
	if _, err := s.GetStakeholder(ctx, free.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("删掉之后应查不到, 得到 %v", err)
	}
	if err := s.DeleteStakeholder(ctx, "stk_nobody"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("删不存在的人应返回 ErrNotFound, 得到 %v", err)
	}
}

// 回收站里的对象也算引用：owner_id 是 ON DELETE SET NULL，删人之后那条对象
// 恢复回来时负责人已经没了，而这个丢失不报错、不崩溃，只是那一行从此空着。
func TestDeleteStakeholderCountsSoftDeletedObjects(t *testing.T) {
	s, ctx := newStore(t)
	sh := mustStakeholder(t, s, ctx, "张三")
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "扔进回收站的", OwnerID: &sh.ID})
	if err := s.DeleteObject(ctx, o.ID, false, store.DefaultActor); err != nil {
		t.Fatalf("soft delete object: %v", err)
	}

	// 展示口径不算回收站里的：名册页上的「他手上有多少事」不该把扔掉的事算进去。
	got, err := s.GetStakeholder(ctx, sh.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.OwnedCount != 0 {
		t.Errorf("OwnedCount = %d, want 0（回收站里的对象不算「手上的事」）", got.OwnedCount)
	}
	// 但删除检查要算：否则恢复回来的对象会静默丢掉负责人。
	if err := s.DeleteStakeholder(ctx, sh.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("仍被软删对象引用时应拒绝删除, 得到 %v", err)
	}
}

// 引用数要一次查询带出来，调用方不该逐个回查（N+1）。
func TestStakeholderCounts(t *testing.T) {
	s, ctx := newStore(t)
	a := mustStakeholder(t, s, ctx, "甲")
	b := mustStakeholder(t, s, ctx, "乙")

	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "任务一", OwnerID: &a.ID,
		Participants: []domain.StakeholderRef{{ID: b.ID}},
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "任务二", OwnerID: &a.ID,
		Participants: []domain.StakeholderRef{{ID: b.ID}},
	})

	items, err := s.ListStakeholders(ctx, false)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	byID := map[string]*domain.Stakeholder{}
	for _, sh := range items {
		byID[sh.ID] = sh
	}
	if got := byID[a.ID]; got.OwnedCount != 2 || got.ParticipatingCount != 0 {
		t.Errorf("甲 owned=%d participating=%d, want 2/0", got.OwnedCount, got.ParticipatingCount)
	}
	if got := byID[b.ID]; got.OwnedCount != 0 || got.ParticipatingCount != 2 {
		t.Errorf("乙 owned=%d participating=%d, want 0/2", got.OwnedCount, got.ParticipatingCount)
	}
}

// 读路径要把人名和参与人带出来，否则列表里每行都得按 id 回查一次。
func TestObjectCarriesOwnerNameAndParticipants(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustStakeholder(t, s, ctx, "陈一")
	p1 := mustStakeholder(t, s, ctx, "张三")
	p2 := mustStakeholder(t, s, ctx, "陈二")

	created := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "三个人一起做的事", OwnerID: &owner.ID,
		Participants: []domain.StakeholderRef{{ID: p1.ID}, {ID: p2.ID}},
	})
	if created.OwnerName != "陈一" {
		t.Errorf("CreateObject 回的 OwnerName = %q, want 陈一", created.OwnerName)
	}

	got, err := s.GetObject(ctx, created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.OwnerID == nil || *got.OwnerID != owner.ID {
		t.Fatalf("OwnerID = %v, want %s", got.OwnerID, owner.ID)
	}
	if got.OwnerName != "陈一" {
		t.Errorf("OwnerName = %q, want 陈一", got.OwnerName)
	}
	// 参与人按写入顺序返回：那是界面上头像的排列顺序。
	if ids := participantIDs(got); len(ids) != 2 || ids[0] != p1.ID || ids[1] != p2.ID {
		t.Errorf("Participants = %v, want [%s %s]", ids, p1.ID, p2.ID)
	}
	if got.Participants[0].Name != "张三" {
		t.Errorf("参与人没带上名字: %+v", got.Participants[0])
	}

	// 列表路径要和详情一致，这是 N+1 最容易被绕开的地方。
	items, _, err := s.ListObjects(ctx, domain.ObjectFilter{TypeIDs: []string{"requirement"}})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("list = %d 条, want 1", len(items))
	}
	if items[0].OwnerName != "陈一" || len(items[0].Participants) != 2 {
		t.Errorf("列表里的 owner_name/participants 没填: %+v", items[0])
	}
}

// owner_id 为空而 owner 文本非空时，界面仍要显示得出个人名来——
// 迁移漏了某条的话，不能因此变成一片空白。
func TestOwnerNameFallsBackToLegacyText(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "老数据", Owner: "某个没迁移的人"})
	got, err := s.GetObject(ctx, o.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.OwnerName != "某个没迁移的人" {
		t.Errorf("OwnerName = %q, want 回退到 owner 文本", got.OwnerName)
	}
}

// participant_ids 是全量替换：nil 不改、空切片清空。
// 增量语义在 PATCH 上表达不了「删到一个不剩」和「没提这个字段」的差别。
func TestUpdateObjectParticipantsFullReplace(t *testing.T) {
	s, ctx := newStore(t)
	a := mustStakeholder(t, s, ctx, "甲")
	b := mustStakeholder(t, s, ctx, "乙")
	c := mustStakeholder(t, s, ctx, "丙")
	o := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "某任务",
		Participants: []domain.StakeholderRef{{ID: a.ID}, {ID: b.ID}},
	})

	// 不提这个字段 = 不改。
	got, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{Title: pstr("改个标题")}, store.DefaultActor)
	if err != nil {
		t.Fatalf("update title: %v", err)
	}
	if len(got.Participants) != 2 {
		t.Fatalf("没提 participant_ids 时参与人被改动了: %v", participantIDs(got))
	}

	// 给一份新名单 = 整份替换，不是追加。
	next := []string{c.ID}
	got, err = s.UpdateObject(ctx, o.ID, domain.ObjectPatch{ParticipantIDs: &next}, store.DefaultActor)
	if err != nil {
		t.Fatalf("replace participants: %v", err)
	}
	if ids := participantIDs(got); len(ids) != 1 || ids[0] != c.ID {
		t.Fatalf("替换后 = %v, want [%s]（全量替换而不是追加）", ids, c.ID)
	}

	// 空切片 = 清空。
	empty := []string{}
	got, err = s.UpdateObject(ctx, o.ID, domain.ObjectPatch{ParticipantIDs: &empty}, store.DefaultActor)
	if err != nil {
		t.Fatalf("clear participants: %v", err)
	}
	if len(got.Participants) != 0 {
		t.Fatalf("participant_ids: [] 没能清空, 仍是 %v", participantIDs(got))
	}

	// 不存在的 id 要当场报出是哪个字段错了，而不是抛一句 FOREIGN KEY constraint failed。
	bad := []string{"stk_nobody"}
	if _, err := s.UpdateObject(ctx, o.ID,
		domain.ObjectPatch{ParticipantIDs: &bad}, store.DefaultActor); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("未知参与人应返回 ErrValidation, 得到 %v", err)
	}
}

// owner_id 传空串就是清空：owner_id 没有「空串」和「未设置」的语义差别。
func TestUpdateObjectOwnerIDClearAndValidate(t *testing.T) {
	s, ctx := newStore(t)
	sh := mustStakeholder(t, s, ctx, "张三")
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "某任务", OwnerID: &sh.ID})

	got, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{OwnerID: pstr("")}, store.DefaultActor)
	if err != nil {
		t.Fatalf("clear owner: %v", err)
	}
	if got.OwnerID != nil {
		t.Fatalf(`owner_id: "" 没能清空, 仍是 %v`, *got.OwnerID)
	}
	if got.OwnerName != "" {
		t.Errorf("清空负责人后 OwnerName = %q, want 空", got.OwnerName)
	}

	if _, err := s.UpdateObject(ctx, o.ID,
		domain.ObjectPatch{OwnerID: pstr("stk_nobody")}, store.DefaultActor); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("未知负责人应返回 ErrNotFound, 得到 %v", err)
	}
	if _, err := s.CreateObject(ctx, &domain.Object{
		TypeID: "task", Title: "坏负责人", OwnerID: pstr("stk_nobody"),
	}, store.DefaultActor); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("建对象时未知负责人应返回 ErrNotFound, 得到 %v", err)
	}
}

// 人员调整要落修订：日报是从 revisions 读的，不记的话「这事换人了」在日报里看不出来。
func TestParticipantChangeWritesRevision(t *testing.T) {
	s, ctx := newStore(t)
	a := mustStakeholder(t, s, ctx, "甲")
	b := mustStakeholder(t, s, ctx, "乙")
	o := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "某任务",
		Participants: []domain.StakeholderRef{{ID: a.ID}},
	})

	next := []string{b.ID}
	before, err := s.GetObject(ctx, o.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if _, err := s.UpdateObject(ctx, o.ID,
		domain.ObjectPatch{ParticipantIDs: &next}, store.DefaultActor); err != nil {
		t.Fatalf("update: %v", err)
	}

	revs, err := s.ListRevisions(ctx, o.ID, 0)
	if err != nil {
		t.Fatalf("revisions: %v", err)
	}
	var found *domain.Revision
	for _, r := range revs {
		if r.Field == "participants" {
			found = r
			break
		}
	}
	if found == nil {
		t.Fatalf("参与人变更没有落修订, 现有字段 = %v", revisionFields(revs))
	}
	if found.OldValue != a.ID || found.NewValue != b.ID {
		t.Errorf("修订内容 = %q -> %q, want %q -> %q", found.OldValue, found.NewValue, a.ID, b.ID)
	}

	// 关联表的写入不动 objects.updated_at 的话，刚调过人的对象会被算成「停滞」。
	after, err := s.GetObject(ctx, o.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !after.UpdatedAt.After(before.UpdatedAt) && !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Errorf("updated_at 回退了: %v -> %v", before.UpdatedAt, after.UpdatedAt)
	}

	// 同一份名单再提交一次不该产生第二条修订，否则日报会被噪音淹没。
	same := []string{b.ID}
	if _, err := s.UpdateObject(ctx, o.ID,
		domain.ObjectPatch{ParticipantIDs: &same}, store.DefaultActor); err != nil {
		t.Fatalf("update again: %v", err)
	}
	revs, err = s.ListRevisions(ctx, o.ID, 0)
	if err != nil {
		t.Fatalf("revisions: %v", err)
	}
	n := 0
	for _, r := range revs {
		if r.Field == "participants" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("participants 修订 = %d 条, want 1（没变化不该记）", n)
	}
}

func revisionFields(revs []*domain.Revision) []string {
	out := make([]string, 0, len(revs))
	for _, r := range revs {
		out = append(out, r.Field)
	}
	return out
}
