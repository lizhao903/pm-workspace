// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package audit

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

func newLog(t *testing.T) (*Log, *sqlite.Store) {
	t.Helper()
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return New(st.DB(), slog.New(slog.NewTextHandler(io.Discard, nil))), st
}

func ids(es []Entry) []string {
	out := []string{}
	for _, e := range es {
		out = append(out, e.ID)
	}
	return out
}

func TestListFilters(t *testing.T) {
	l, _ := newLog(t)
	ctx := context.Background()
	base := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	rows := []Entry{
		{ID: "a1", At: base, Kind: KindDelete, Action: "delete", TargetType: "object", TargetID: "obj_1", Actor: "me", Source: "ui"},
		{ID: "a2", At: base.Add(time.Hour), Kind: KindAgent, Action: "update", TargetType: "object", TargetID: "obj_1", Actor: "claude-code#s1", Source: "agent"},
		{ID: "a3", At: base.Add(2 * time.Hour), Kind: KindConfig, Action: "update", TargetType: "dict_item", TargetID: "dit_1", Actor: "claude-code#s2", Source: "agent"},
		// 名字是 claude-code 的前缀但不是同一个人
		{ID: "a4", At: base.Add(3*time.Hour + 500*time.Millisecond), Kind: KindConfig, Action: "create", TargetType: "secret", TargetID: "sec_1", Actor: "claude", Source: "api"},
	}
	for _, e := range rows {
		if err := l.Record(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	at := func(d time.Duration) *time.Time { v := base.Add(d); return &v }

	cases := []struct {
		name string
		f    Filter
		want []string
	}{
		{"全部，最近的在前", Filter{}, []string{"a4", "a3", "a2", "a1"}},
		{"按对象", Filter{TargetType: "object", TargetID: "obj_1"}, []string{"a2", "a1"}},
		{"按时间区间，两端都含", Filter{Since: at(time.Hour), Until: at(2 * time.Hour)}, []string{"a3", "a2"}},
		{"上界精确到秒，含毫秒", Filter{Since: at(3 * time.Hour), Until: at(3 * time.Hour)}, []string{"a4"}},
		{"对象加时间", Filter{TargetID: "obj_1", Since: at(30 * time.Minute)}, []string{"a2"}},
		{"按名字含所有会话", Filter{Actor: "claude-code"}, []string{"a3", "a2"}},
		{"按名字和会话", Filter{Actor: "claude-code#s1"}, []string{"a2"}},
		{"名字前缀不算", Filter{Actor: "claude"}, []string{"a4"}},
		{"按分组多选", Filter{Kinds: []string{KindDelete, KindAgent}}, []string{"a2", "a1"}},
		{"按来源", Filter{Source: "agent"}, []string{"a3", "a2"}},
		{"按动作", Filter{Action: "update"}, []string{"a3", "a2"}},
	}
	for _, c := range cases {
		got, total, err := l.List(ctx, c.f)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if g := ids(got); !equal(g, c.want) || total != len(c.want) {
			t.Errorf("%s: got %v total=%d, want %v", c.name, g, total, c.want)
		}
	}

	got, total, err := l.List(ctx, Filter{Limit: 2, Offset: 1})
	if err != nil {
		t.Fatal(err)
	}
	if g := ids(got); !equal(g, []string{"a3", "a2"}) || total != 4 {
		t.Errorf("分页: got %v total=%d", g, total)
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestRecordTakesActorFromContext(t *testing.T) {
	l, _ := newLog(t)
	ctx := WithActor(context.Background(), store.Actor{Name: "claude-code", Source: "agent", Session: "s9"})
	// 请求已结束也要写完
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if err := l.Record(cctx, Entry{Kind: KindConfig, Action: "update", TargetType: "dict_item", TargetID: "x"}); err != nil {
		t.Fatal(err)
	}
	got, _, err := l.List(context.Background(), Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Actor != "claude-code#s9" || got[0].Source != "agent" || got[0].At.IsZero() {
		t.Fatalf("got %+v", got)
	}
}

// 包装层：删除不分来源都记，Agent 写操作只在 agent 来源时记，失败的写不记。
func TestWrapStore(t *testing.T) {
	l, st := newLog(t)
	ws := WrapStore(st, l)
	ctx := context.Background()
	ui := store.Actor{Name: "me", Source: "ui"}
	agent := store.Actor{Name: "claude-code", Source: "agent", Session: "s1"}

	o, err := ws.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "界面建的"}, ui)
	if err != nil {
		t.Fatal(err)
	}
	if _, total, _ := l.List(ctx, Filter{}); total != 0 {
		t.Fatalf("界面新建不该记审计，got %d", total)
	}
	title := "Agent 改的"
	if _, err := ws.UpdateObject(ctx, o.ID, domain.ObjectPatch{Title: &title}, agent); err != nil {
		t.Fatal(err)
	}
	if err := ws.DeleteObject(ctx, o.ID, false, ui); err != nil {
		t.Fatal(err)
	}
	if err := ws.DeleteObject(ctx, "obj_missing", false, ui); err == nil {
		t.Fatal("删不存在的对象应当失败")
	}
	got, _, err := l.List(ctx, Filter{TargetID: o.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 条，got %+v", got)
	}
	del, upd := got[0], got[1]
	if del.Kind != KindDelete || del.Action != "delete" || del.Actor != "me" || del.Source != "ui" || del.Detail["hard"] != false {
		t.Errorf("删除审计不对: %+v", del)
	}
	if upd.Kind != KindAgent || upd.Action != "update" || upd.Actor != "claude-code#s1" {
		t.Errorf("Agent 修改审计不对: %+v", upd)
	}
	if f, _ := upd.Detail["fields"].([]any); len(f) != 1 || f[0] != "title" {
		t.Errorf("fields = %v", upd.Detail["fields"])
	}
	if _, total, _ := l.List(ctx, Filter{}); total != 2 {
		t.Errorf("失败的删除不该记审计，total=%d", total)
	}

	// 不带 Actor 参数的方法从 ctx 取操作者
	actx := WithActor(ctx, agent)
	if _, err := ws.CreateTag(actx, "审计", ""); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := l.List(ctx, Filter{TargetType: "tag"}); len(got) != 1 || got[0].Source != "agent" {
		t.Errorf("Agent 新建标签: %+v", got)
	}
}
