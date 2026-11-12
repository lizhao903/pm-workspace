// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 联系人字段（0026）：建、读、改、清空都要落库，没传的字段不动。
func TestStakeholderContactFieldsRoundTrip(t *testing.T) {
	s, ctx := newStore(t)
	last := time.Date(2026, 10, 28, 9, 30, 0, 0, time.UTC)
	sh, err := s.CreateStakeholder(ctx, &domain.Stakeholder{
		Name: "许知行", Group: " 客户 ", Company: "远川科技", Title: "IT 总监", Phone: "137 2233 4405",
		Email: "xu@example.com", Tags: []string{"试点客户", " 决策人 ", "", "试点客户"},
		Photo: "data:image/png;base64,AAAA", Starred: true, LastContactAt: &last, Note: "试点方",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := s.GetStakeholder(ctx, sh.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Group != "客户" || got.Company != "远川科技" || got.Title != "IT 总监" || got.Phone != "137 2233 4405" ||
		got.Photo != "data:image/png;base64,AAAA" || !got.Starred {
		t.Fatalf("字段没落库: %+v", got)
	}
	if strings.Join(got.Tags, ",") != "试点客户,决策人" {
		t.Fatalf("tags = %v, want 去空白去重后的 [试点客户 决策人]", got.Tags)
	}
	if got.LastContactAt == nil || !got.LastContactAt.Equal(last) {
		t.Fatalf("last_contact_at = %v", got.LastContactAt)
	}

	// 只改星标，其他字段不动
	off := false
	got, err = s.UpdateStakeholder(ctx, sh.ID, domain.StakeholderPatch{Starred: &off})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.Starred || got.Company != "远川科技" || len(got.Tags) != 2 || got.LastContactAt == nil {
		t.Fatalf("只改 starred 却动了别的字段: %+v", got)
	}

	// 清空：last_contact_at 置空、tags 置空数组、photo 置空串
	var none *time.Time
	empty := []string{}
	got, err = s.UpdateStakeholder(ctx, sh.ID, domain.StakeholderPatch{
		LastContactAt: &none, Tags: &empty, Photo: pstr(""), Group: pstr("合作伙伴"),
	})
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if got.LastContactAt != nil || len(got.Tags) != 0 || got.Tags == nil || got.Photo != "" || got.Group != "合作伙伴" {
		t.Fatalf("清空没生效: %+v", got)
	}
}

// 0026 之前建的人：新列取默认值，tags 读出来是空数组不是 nil。
func TestStakeholderContactDefaults(t *testing.T) {
	s, ctx := newStore(t)
	sh := mustStakeholder(t, s, ctx, "老人")
	if sh.Group != "" || sh.Starred || sh.LastContactAt != nil || sh.Tags == nil || len(sh.Tags) != 0 {
		t.Fatalf("默认值不对: %+v", sh)
	}
}

func TestStakeholderPhotoMustBeDataImage(t *testing.T) {
	s, ctx := newStore(t)
	if _, err := s.CreateStakeholder(ctx, &domain.Stakeholder{Name: "甲", Photo: "https://x/y.png"}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("非 data:image/ 应返回 ErrValidation, 得到 %v", err)
	}
	sh := mustStakeholder(t, s, ctx, "乙")
	big := "data:image/png;base64," + strings.Repeat("A", maxStakeholderPhoto)
	if _, err := s.UpdateStakeholder(ctx, sh.ID, domain.StakeholderPatch{Photo: &big}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("超大图片应返回 ErrValidation, 得到 %v", err)
	}
}

// 联系人可能重名，name 仍全局唯一：撞名的 409 要提示加区分。
func TestStakeholderDuplicateNameSuggestsQualifier(t *testing.T) {
	s, ctx := newStore(t)
	mustStakeholder(t, s, ctx, "王磊")
	_, err := s.CreateStakeholder(ctx, &domain.Stakeholder{Name: "王磊", Company: "北岸物流"})
	if !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "qualifier") {
		t.Fatalf("撞名应返回带区分提示的 ErrConflict, 得到 %v", err)
	}
	if _, err := s.CreateStakeholder(ctx, &domain.Stakeholder{Name: "王磊（北岸）", Company: "北岸物流"}); err != nil {
		t.Fatalf("加了区分的名字应能建: %v", err)
	}
}

// 联系人字段不影响计数口径：改了星标、分组，owned_count 照旧。
func TestStakeholderContactFieldsKeepCounts(t *testing.T) {
	s, ctx := newStore(t)
	a := mustStakeholder(t, s, ctx, "甲")
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "任务一", OwnerID: &a.ID})
	on := true
	got, err := s.UpdateStakeholder(ctx, a.ID, domain.StakeholderPatch{Starred: &on, Group: pstr("同事")})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.OwnedCount != 1 || got.ParticipatingCount != 0 {
		t.Fatalf("owned=%d participating=%d, want 1/0", got.OwnedCount, got.ParticipatingCount)
	}
}
