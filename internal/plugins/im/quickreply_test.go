// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"fmt"
	"strings"
	"testing"
)

// 快捷回复可以设置：没设过回内置四条；PATCH 整组替换、去首尾空白；空的、重复的、超长的、太多的回 400 且不改；
// 空数组表示不要快捷回复；只改快捷回复不动过期天数。
func TestQuickRepliesSetting(t *testing.T) {
	e := setupActions(t)
	get := func() map[string]any {
		code, out := call(t, e.h, "GET", "/api/im/settings", "")
		if code != 200 {
			t.Fatalf("GET：%d %v", code, out)
		}
		return data(out)
	}
	patch := func(body string) (int, map[string]any) { return call(t, e.h, "PATCH", "/api/im/settings", body) }

	qr := get()["quick_replies"].([]any)
	if len(qr) != 4 || qr[0].(map[string]any)["text"] != "收到，我看一下" || qr[2].(map[string]any)["done"] != true {
		t.Fatalf("默认四条：%v", qr)
	}

	code, out := patch(`{"quick_replies":[{"text":"  好的 ","done":false},{"text":"已安排","done":true}]}`)
	got := data(out)
	qr, _ = got["quick_replies"].([]any)
	if code != 200 || len(qr) != 2 || qr[0].(map[string]any)["text"] != "好的" || qr[1].(map[string]any)["done"] != true || got["expire_days"] != float64(7) {
		t.Fatalf("改成两条：%d %v", code, out)
	}

	for _, bad := range []string{
		`{"quick_replies":[{"text":" "}]}`,
		`{"quick_replies":[{"text":"a"},{"text":"a "}]}`,
		`{"quick_replies":[{"text":"` + strings.Repeat("长", 201) + `"}]}`,
		`{"quick_replies":[` + strings.TrimSuffix(strings.Repeat(`{"text":"x"},`, 21), ",") + `]}`,
	} {
		if code, out := patch(bad); code != 400 {
			t.Fatalf("应当 400：%s → %d %v", bad[:min(len(bad), 60)], code, out)
		}
	}
	if n := len(get()["quick_replies"].([]any)); n != 2 {
		t.Fatalf("报错不该改：%d", n)
	}

	// 同时改天数和非法回复：整个请求不生效
	if code, _ := patch(`{"expire_days":3,"quick_replies":[{"text":""}]}`); code != 400 || get()["expire_days"] != float64(7) {
		t.Fatal("回复不合法时天数也不该存")
	}

	if code, out := patch(`{"quick_replies":[]}`); code != 200 || len(data(out)["quick_replies"].([]any)) != 0 {
		t.Fatalf("清空：%d %v", code, out)
	}
	if n := len(get()["quick_replies"].([]any)); n != 0 {
		t.Fatal(fmt.Sprint("清空后应为 0：", n))
	}
}
