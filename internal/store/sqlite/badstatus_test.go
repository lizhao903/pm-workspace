// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// TSK-0480：状态不在类型状态集里时报错带上合法 key，新建、改、记进展、领取四处同一句。
// 以前只说 not allowed，Agent 里的小模型拿 planning（项目的状态）建任务连错三次。
func TestBadStatusListsAllowedKeys(t *testing.T) {
	s, ctx := newStore(t)
	const want = "status is not allowed for type task: planning (allowed: todo, doing, review, blocked, done, cancelled)"
	check := func(where string, err error) {
		t.Helper()
		if !errors.Is(err, domain.ErrValidation) || !strings.Contains(err.Error(), want) {
			t.Errorf("%s：%v", where, err)
		}
	}
	_, err := s.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "x", Status: "planning"}, store.Actor{})
	check("新建", err)

	o, err := s.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "x"}, store.Actor{})
	if err != nil {
		t.Fatal(err)
	}
	bad := "planning"
	_, err = s.UpdateObject(ctx, o.ID, domain.ObjectPatch{Status: &bad}, store.Actor{})
	check("修改", err)
	_, err = s.AppendProgress(ctx, o.ID, domain.ProgressInput{Kind: domain.ProgressNote, Text: "x", Status: bad}, store.Actor{})
	check("记进展", err)
}
