// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

// 回复、发消息里的 @（0.18.0）：渲染成渠道写法、请求里的 mentions、@ 候选。

func TestFindMentions(t *testing.T) {
	lin := Mention{ExternalID: "U04LIN", Name: "林原"}
	linye := Mention{ExternalID: "U05YE", Name: "林原野"}
	ann := Mention{ExternalID: "U07ANN", Name: "Ann"}
	for _, c := range []struct {
		text string
		ms   []Mention
		want []string // 认出来的编号，按出现顺序
	}{
		{"@林原 看下", []Mention{lin}, []string{"U04LIN"}},
		{"@林原你好", []Mention{lin}, []string{"U04LIN"}},                    // 中文名后面直接接正文
		{"@林原 和 @林原 都要看", []Mention{lin}, []string{"U04LIN", "U04LIN"}},  // 同名多次
		{"@林原野 先看", []Mention{lin, linye}, []string{"U05YE"}},            // 互为前缀时先认长的
		{"@林原、@林原野", []Mention{lin, linye}, []string{"U04LIN", "U05YE"}}, // 多个
		{"@Anna 来", []Mention{ann}, nil},                                 // 英文名连着字母不算
		{"@Ann, 来", []Mention{ann}, []string{"U07ANN"}},                  // 标点隔开算
		{"mail ann@Ann.com", []Mention{ann}, nil},                        // 邮箱里的不算
		{"@王五 手打的", []Mention{lin}, nil},                                 // 不在 mentions 里的不认
		{"没有 @", nil, nil},
	} {
		var got []string
		for _, s := range findMentions(c.text, c.ms) {
			got = append(got, s.M.ExternalID)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q：%v，应 %v", c.text, got, c.want)
		}
	}
}

func TestRenderSlackMentions(t *testing.T) {
	ms := []Mention{{ExternalID: "U04LIN", Name: "林原"}, {ExternalID: "U09ZHOU", Name: "周宇"}, {ExternalID: "B01BOT", Name: "机器人"}, {ExternalID: "", Name: "无名"}}
	for _, c := range []struct{ in, want string }{
		{"@林原 看下", "<@U04LIN> 看下"},
		{"@林原 @周宇 一起看，@林原 你先", "<@U04LIN> <@U09ZHOU> 一起看，<@U04LIN> 你先"}, // 多个、同名多次
		{"@机器人 和 @无名 不能 @", "@机器人 和 @无名 不能 @"},                          // 编号不是 Member ID、没有编号的照原样
		{"@王五 手打的", "@王五 手打的"},                                          // 认不出的照原样
		{"没有 mention", "没有 mention"},
	} {
		if got := renderSlackMentions(c.in, ms); got != c.want {
			t.Errorf("%q → %q，应 %q", c.in, got, c.want)
		}
	}
}

func TestRenderTelegramMentions(t *testing.T) {
	ms := []Mention{
		{ExternalID: "linyuan", Name: "林原"},  // 有用户名
		{ExternalID: "@zhouyu", Name: "周宇"},  // 带 @ 的用户名
		{ExternalID: "555666", Name: "阿青"},   // 没有用户名，只有数字编号
		{ExternalID: "-100200", Name: "产品群"}, // 频道、群的编号，不能 @
	}
	text, ents := renderTelegramMentions("@林原 @周宇 看下", ms)
	if text != "@linyuan @zhouyu 看下" || ents != nil {
		t.Fatalf("用户名：%q %v", text, ents)
	}
	// 没有用户名：文字不变，加 text_mention；偏移按 UTF-16（😀 占 2），用户名替换后的偏移跟着变
	text, ents = renderTelegramMentions("😀 @林原 和 @阿青、@阿青 看下 @产品群", ms)
	if text != "😀 @linyuan 和 @阿青、@阿青 看下 @产品群" {
		t.Fatalf("文字：%q", text)
	}
	want := []tgEntity{
		{Type: "text_mention", Offset: 14, Length: 3, User: &tgUser{ID: 555666}},
		{Type: "text_mention", Offset: 18, Length: 3, User: &tgUser{ID: 555666}},
	}
	if !reflect.DeepEqual(ents, want) {
		b, _ := json.Marshal(ents)
		t.Fatalf("实体：%s", b)
	}
	if text, ents := renderTelegramMentions("@王五 手打的", ms); text != "@王五 手打的" || ents != nil {
		t.Fatalf("认不出的照原样：%q %v", text, ents)
	}
}

func TestReplyAndSendWithMentions(t *testing.T) {
	e := setupActions(t)
	id := e.push(t, "fake", `{"external_id":"C01:1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","sender_name":"lin","text":"能看下吗"}`)
	e.push(t, "fake", `{"external_id":"C01:2","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U09ZHOU","sender_name":"周宇","text":"我也看"}`)

	// external_id 和 identity_id 都认；名字去掉开头的 @；正文原样记，工作台里显示仍是「@名字」
	code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/reply",
		`{"text":"@林原 @周宇 收到","mentions":[{"identity_id":"idn_lin","name":"林原"},{"external_id":"U09ZHOU","name":"@周宇"},{"external_id":"U09ZHOU","name":"周宇"}]}`)
	if code != http.StatusOK {
		t.Fatalf("回复：%d %v", code, out)
	}
	sent := e.fake.Sent()
	want := []Mention{{ExternalID: "U04LIN", Name: "林原"}, {ExternalID: "U09ZHOU", Name: "周宇"}}
	if g := sent[len(sent)-1]; g.Text != "@林原 @周宇 收到" || !reflect.DeepEqual(g.Mentions, want) {
		t.Fatalf("交给适配器的：%+v", g)
	}
	if rp := data(out)["replies"].([]any)[0].(map[string]any); rp["text"] != "@林原 @周宇 收到" {
		t.Fatalf("记下的是原文：%v", rp)
	}
	// 不带 mentions：照旧
	call(t, e.h, "POST", "/api/im/messages/"+id+"/reply", `{"text":"好"}`)
	if g := e.fake.Sent(); g[len(g)-1].Mentions != nil {
		t.Fatalf("不带 mentions：%+v", g[len(g)-1])
	}
	for _, c := range []struct{ body, why string }{
		{`{"text":"@x","mentions":[{"external_id":"U1","name":" "}]}`, "名字为空"},
		{`{"text":"@x","mentions":[{"name":"x"}]}`, "没有编号"},
		{`{"text":"@x","mentions":[{"identity_id":"idn_nope","name":"x"}]}`, "身份不存在"},
	} {
		if code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/reply", c.body); code != 400 || errOf(out)["code"] != "validation" {
			t.Errorf("%s 应 400：%d %v", c.why, code, out)
		}
	}
	exec(t, e.st.DB(), `INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_lin_tg', 'stk_lin', 'telegram', 'linyuan', 'x', 'x')`)
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/reply", `{"text":"@林原","mentions":[{"identity_id":"idn_lin_tg","name":"林原"}]}`); code != 400 {
		t.Errorf("别的渠道的身份应 400：%d %v", code, out)
	}

	// 主动发消息同一套
	_, all := list(t, e.h, "")
	cv := all["C01:1"]["conversation_id"].(string)
	code, out = call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"`+cv+`","text":"@周宇 周五发版","mentions":[{"external_id":"U09ZHOU","name":"周宇"}]}`)
	if code != http.StatusOK || data(out)["text"] != "@周宇 周五发版" {
		t.Fatalf("发消息：%d %v", code, out)
	}
	if g := e.fake.Sent(); !reflect.DeepEqual(g[len(g)-1].Mentions, []Mention{{ExternalID: "U09ZHOU", Name: "周宇"}}) {
		t.Fatalf("发消息带 mentions：%+v", g[len(g)-1])
	}
	if code, _ := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"`+cv+`","text":"@x","mentions":[{"name":"x"}]}`); code != 400 {
		t.Fatalf("发消息 mentions 不对应 400：%d", code)
	}
}

func TestConversationMembers(t *testing.T) {
	e := setupActions(t)
	e.push(t, "fake", `{"external_id":"C01:1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","sender_name":"lin","text":"一","at":"2026-10-01T00:00:00Z"}`)
	e.push(t, "fake", `{"external_id":"C01:2","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U09ZHOU","sender_name":"周宇","text":"二","at":"2026-10-02T00:00:00Z"}`)
	e.push(t, "fake", `{"external_id":"C01:3","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U08NEW","sender_name":"新人","text":"四","at":"2026-10-03T00:00:00Z"}`)
	e.push(t, "fake", `{"external_id":"C02:1","connector_id":"cn_ok","conversation_id":"C02","conversation_name":"#other","sender_id":"U77OTHER","sender_name":"别的群","text":"三"}`)
	exec(t, e.st.DB(),
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_chen', '陈晨', 'x', 'x'), ('stk_old', '老同事', 'x', 'x'), ('stk_tg', '阿青', 'x', 'x')`,
		`UPDATE stakeholders SET archived_at = 'x' WHERE id = 'stk_old'`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES
		  ('idn_chen', 'stk_chen', 'slack', 'U05CHEN', 'x', 'x'),
		  ('idn_old', 'stk_old', 'slack', 'U06OLD', 'x', 'x'),
		  ('idn_tg', 'stk_tg', 'telegram', 'aqing', 'x', 'x')`,
	)
	_, all := list(t, e.h, "")
	cv := all["C01:1"]["conversation_id"].(string)
	code, out := call(t, e.h, "GET", "/api/im/conversations/"+cv+"/members", "")
	if code != http.StatusOK {
		t.Fatalf("候选：%d %v", code, out)
	}
	type row struct{ ext, name, source, identity string }
	var got []row
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		got = append(got, row{m["external_id"].(string), m["name"].(string), m["source"].(string), m["identity_id"].(string)})
	}
	// 联系人在前：发过言、认上联系人的（用联系人名）→ 这个渠道有身份的别的联系人（不含已归档的、别的渠道的）→
	// 发过言、没认上的（用渠道里的名字，最近的在前）
	want := []row{
		{"U04LIN", "林原", "conversation", "idn_lin"},
		{"U05CHEN", "陈晨", "contact", "idn_chen"},
		{"U08NEW", "新人", "conversation", ""},
		{"U09ZHOU", "周宇", "conversation", ""},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("候选：%v", got)
	}
	if code, _ := call(t, e.h, "GET", "/api/im/conversations/cv_nope/members", ""); code != http.StatusNotFound {
		t.Fatalf("会话不存在应 404：%d", code)
	}
}
