package im

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestAccountHandles(t *testing.T) {
	for _, c := range []struct {
		account string
		want    []string
	}{
		{"", []string{}},
		{"@broleez", []string{"broleez"}},
		{"Zhao（@zhaoli，U012AB）", []string{"Zhao（@zhaoli，U012AB）", "Zhao", "zhaoli", "U012AB"}},
		{"Lin Zhao", []string{"Lin Zhao"}},
		{"Broleez（@broleez，U012AB）", []string{"Broleez（@broleez，U012AB）", "Broleez", "U012AB"}},
		{"Broleez @broleez", []string{"Broleez @broleez", "broleez"}},
		{"broleez / BROLEEZ", []string{"broleez / BROLEEZ", "broleez"}},
	} {
		if got := accountHandles(c.account); !slices.Equal(got, c.want) {
			t.Errorf("%q：%q，应为 %q", c.account, got, c.want)
		}
	}
}

// 「我」的称呼从连接器账号来：显示名、handle、外部 id 都认；改了账号之后新到的按新称呼认，已存的不动
func TestRelevanceFromConnectorAccount(t *testing.T) {
	e := setup(t) // 假适配器自己的称呼是 Broleez
	exec(t, e.d, `INSERT INTO connectors (id, tool, name, account, status, direction, created_at, updated_at) VALUES
		('cn_slack', 'slack', '公司 Slack', 'Lin Zhao（@zhaoli，U07ME）', 'connected', 'both', 'x', 'x')`)

	n := 0
	send := func(conn, kind, text string) string {
		t.Helper()
		n++
		ext := fmt.Sprintf("C01:r%d", n)
		conv := `"conversation_id":"C01","conversation_name":"#product"`
		if kind == "direct" {
			conv = `"conversation_id":"D01","conversation_kind":"direct"`
		}
		body := fmt.Sprintf(`{"messages":[{"external_id":%q,"connector_id":%q,%s,"sender_id":"U04LIN","text":%q}]}`, ext, conn, conv, text)
		if code, out := call(t, e.h, "POST", "/api/im/callbacks/fake", body); code != 200 {
			t.Fatalf("回调：%d %v", code, out)
		}
		return ext
	}
	relOf := func() map[string]string {
		_, got := list(t, e.h, "")
		out := map[string]string{}
		for k, m := range got {
			out[k] = m["relevance"].(string)
		}
		return out
	}

	cases := []struct{ conn, kind, text, want string }{
		{"cn_slack", "group", "@zhaoli 权限点清单看下", "me"},     // handle
		{"cn_slack", "group", "@Lin Zhao 帮忙评审", "me"},      // 显示名
		{"cn_slack", "group", "<@U07ME> 在吗 @u07me", "me"},  // 外部 id，不分大小写
		{"cn_slack", "group", "@Broleez 适配器给的也认", "me"},    // 适配器自己的称呼
		{"cn_slack", "group", "@zhaolin 不是我", ""},          // 称呼后面紧跟字母不算
		{"cn_slack", "group", "@所有人 下午开会", "all"},          // @所有人
		{"cn_slack", "group", "@channel @zhaoli 发版", "me"}, // @我 优先
		{"cn_slack", "direct", "预发好了", "dm"},               // 私聊
		{"", "group", "@zhaoli 没给连接器只认适配器的", ""},           // 没有连接器
		{"cn_gone", "group", "@zhaoli 连接器已删", ""},          // 连接器不在
		{"cn_gone", "group", "@Broleez 连接器已删", "me"},       // 只剩适配器的称呼
		{"cn_gone", "direct", "连接器已删的私聊", "dm"},
	}
	exts := make([]string, len(cases))
	for i, c := range cases {
		exts[i] = send(c.conn, c.kind, c.text)
	}
	rel := relOf()
	for i, c := range cases {
		if rel[exts[i]] != c.want {
			t.Errorf("%s %q：%q，应为 %q", c.conn, c.text, rel[exts[i]], c.want)
		}
	}

	// 改连接器账号：新到的按新称呼认
	exec(t, e.d, `UPDATE connectors SET account = '@broleez_new' WHERE id = 'cn_slack'`)
	newMe := send("cn_slack", "group", "@broleez_new 换了名字")
	oldName := send("cn_slack", "group", "@zhaoli 旧名字")
	rel2 := relOf()
	if rel2[newMe] != "me" || rel2[oldName] != "" {
		t.Fatalf("改名后：新名字 %q（应为 me），旧名字 %q（应为空）", rel2[newMe], rel2[oldName])
	}
	// 已存的照旧
	if rel2[exts[0]] != "me" {
		t.Fatalf("改名前到的 @我 不重算：%q", rel2[exts[0]])
	}
	// 筛选跟着走
	_, at := list(t, e.h, "?mine=at")
	for k := range at {
		if strings.Contains(k, ":r") && rel2[k] != "me" {
			t.Errorf("mine=at 里有不是 @我 的 %s", k)
		}
	}
	if _, ok := at[newMe]; !ok {
		t.Fatal("mine=at 要有改名后的 @我")
	}
}
