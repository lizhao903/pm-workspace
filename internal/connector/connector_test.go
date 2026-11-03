package connector

import (
	"context"
	"errors"
	"testing"
)

func TestRegistry(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(Fake()); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(Fake()); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("重复登记应该失败，得到 %v", err)
	}
	d, ok := r.Get(FakeTool)
	if !ok || d.Source != "core" || len(r.List()) != 1 {
		t.Fatalf("get = %v %v", d, ok)
	}
	bad := []Def{
		{Tool: "Bad", Label: "x", Auth: []AuthMode{AuthNone}, Test: Fake().Test},
		{Tool: "x", Auth: []AuthMode{AuthNone}, Test: Fake().Test},
		{Tool: "x", Label: "x", Test: Fake().Test},
		{Tool: "x", Label: "x", Auth: []AuthMode{"basic"}, Test: Fake().Test},
		{Tool: "x", Label: "x", Auth: []AuthMode{AuthNone}},
		{Tool: "x", Label: "x", Auth: []AuthMode{AuthNone}, Test: Fake().Test, Fields: []Field{{Key: "a", Kind: "file"}}},
		{Tool: "x", Label: "x", Auth: []AuthMode{AuthNone}, Test: Fake().Test, Tools: []ToolDef{{Name: "a"}, {Name: "a"}}},
		// 选择器只给 text，且得是认识的
		{Tool: "x", Label: "x", Auth: []AuthMode{AuthNone}, Test: Fake().Test, Fields: []Field{{Key: "a", Kind: "select", Options: []string{"1"}, Picker: PickerIMChannels}}},
		{Tool: "x", Label: "x", Auth: []AuthMode{AuthNone}, Test: Fake().Test, Fields: []Field{{Key: "a", Kind: "text", Picker: "colors"}}},
	}
	for i, d := range bad {
		if err := r.Register(d); err == nil {
			t.Errorf("bad[%d] 应该登记失败", i)
		}
	}
	if err := r.Register(Slack(SlackEndpoints{})); err != nil {
		t.Fatalf("Slack 定义（监听频道带选择器）应能登记：%v", err)
	}
	if d, _ := r.Get(SlackTool); d.field("channels").Picker != PickerIMChannels {
		t.Error("Slack 的监听频道应该用 im_channels 选择器")
	}
	ok2 := Def{Tool: "plain", Label: "x", Auth: []AuthMode{AuthNone}, Test: Fake().Test}
	if err := r.Register(ok2); err != nil {
		t.Fatal(err)
	}
	if d, _ := r.Get("plain"); d.Fields == nil || d.Tools == nil {
		t.Error("空的字段和工具目录应该是 []，不是 nil")
	}
}

func TestScrub(t *testing.T) {
	sec := map[string]string{"a": "abcdef", "b": "abcdefghij", "c": ""}
	if got := scrub("x abcdefghij y abcdef z", sec); got != "x *** y *** z" {
		t.Fatalf("scrub = %q", got)
	}
	long := make([]rune, 400)
	for i := range long {
		long[i] = '错'
	}
	if got := []rune(scrub(string(long), nil)); len(got) != maxError+1 {
		t.Fatalf("应截到 %d 字加省略号，得到 %d", maxError, len(got))
	}
}

func TestFakeConnector(t *testing.T) {
	f := Fake()
	ctx := context.Background()
	if a, err := f.Test(ctx, NewConfig(AuthToken, nil, map[string]string{"token": "good"})); err != nil || a != "fake-user" {
		t.Fatalf("good = %q %v", a, err)
	}
	if _, err := f.Test(ctx, NewConfig(AuthToken, nil, map[string]string{"token": "expired-1"})); err == nil {
		t.Fatal("expired 应该失败")
	}
	ts, _ := f.ListTools(ctx, NewConfig(AuthToken, map[string]string{"variant": "v2"}, nil))
	if len(ts) != 3 || ts[2].Name != "delete_item" {
		t.Fatalf("v2 tools = %v", ts)
	}
	if DefaultMode(ts[0]) != ModeAuto || DefaultMode(ts[1]) != ModeConfirm {
		t.Fatal("默认授权：只读自动、写操作需确认")
	}
}
