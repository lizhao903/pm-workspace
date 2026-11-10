// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// 群组管理（0.15.0）：会话统计、批量设默认项目（逐条校验、成功和失败明细、审计）、单个设也记审计。

func summaryRows(t *testing.T, e sopEnv, query string) map[string]map[string]any {
	t.Helper()
	code, out := call(t, e.h, "GET", "/api/im/conversations/summary"+query, "")
	if code != 200 {
		t.Fatalf("会话统计：%d %v", code, out)
	}
	rows := map[string]map[string]any{}
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		rows[m["conversation_id"].(string)] = m
	}
	if int(out["meta"].(map[string]any)["total"].(float64)) != len(rows) {
		t.Fatalf("meta.total 要等于行数：%v", out["meta"])
	}
	return rows
}

func TestConversationSummary(t *testing.T) {
	e := setupSOP(t)
	seedProjects(t, e)
	// 消息时间是 3 月的，过期任务启用时先跑的那一次和下面的推送谁先谁后不定，后跑就会把它们标成过期；
	// 这个测试不看过期，关掉
	if code, out := call(t, e.h, "PATCH", "/api/im/settings", `{"expire_days":0}`); code != 200 {
		t.Fatalf("关过期：%d %v", code, out)
	}
	e.push(t, `{"external_id":"C01:s1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"一","at":"2026-03-01T10:00:00Z"}`)
	e.push(t, `{"external_id":"C01:s2","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U2","sender_name":"周舟","text":"二","at":"2026-03-02T10:00:00Z"}`)
	e.push(t, `{"external_id":"C01:s3","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"三","at":"2026-03-03T10:00:00Z"}`)
	e.push(t, `{"external_id":"D9:s4","connector_id":"cn_ok","conversation_id":"D9","conversation_kind":"direct","sender_id":"U3","sender_name":"阿青","text":"私聊","at":"2026-03-04T10:00:00Z"}`)
	_, all := list(t, e.h, "")
	// 一条处理完、一条稍后，待处理只剩一条；处理、稍后、打开都算读过
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+all["C01:s1"]["id"].(string)+"/done", "{}"); code != 200 {
		t.Fatalf("标已处理：%d %v", code, out)
	}
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+all["C01:s2"]["id"].(string)+"/snooze", `{"until":"`+time.Now().Add(48*time.Hour).UTC().Format(time.RFC3339)+`"}`); code != 200 {
		t.Fatalf("稍后：%d %v", code, out)
	}
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+all["C01:s3"]["id"].(string)+"/read", "{}"); code != 200 {
		t.Fatalf("已读：%d %v", code, out)
	}
	dmID := all["D9:s4"]["conversation_id"].(string)

	rows := summaryRows(t, e, "")
	g := rows["cv_prod"]
	if g == nil || g["name"] != "#product" || g["connector_id"] != "cn_ok" || g["kind"] != "group" || g["channel"] != "slack" || g["external_id"] != "C01" ||
		g["total"] != 3.0 || g["pending"] != 1.0 || g["unread"] != 0.0 || !strings.HasPrefix(g["last_at"].(string), "2026-03-03") ||
		g["project_id"] != nil || g["project_name"] != "" {
		t.Fatalf("群的统计：%v", g)
	}
	if ps := g["participants"].([]any); len(ps) != 2 || ps[0] != "林原" || ps[1] != "周舟" {
		t.Fatalf("发信人按最近发言排、同人只列一次：%v", ps)
	}
	d := rows[dmID]
	if d == nil || d["kind"] != "direct" || d["name"] != "" || d["total"] != 1.0 || d["pending"] != 1.0 || d["unread"] != 1.0 || d["participants"].([]any)[0] != "阿青" {
		t.Fatalf("私聊：名字为空、对方在 participants：%v", d)
	}
	// 没消息、没设默认项目的会话不列
	if rows["cv_empty"] != nil {
		t.Fatalf("没消息的会话不列：%v", rows["cv_empty"])
	}

	// 设了默认项目：带上项目；没消息的会话也列出来
	if code, out := call(t, e.h, "PUT", "/api/im/conversation-projects", `{"items":[{"conversation_id":"cv_prod","project_id":"PRJ-0001"},{"conversation_id":"cv_empty","project_id":"Globex"}]}`); code != 200 {
		t.Fatalf("批量设：%d %v", code, out)
	}
	rows = summaryRows(t, e, "")
	if g := rows["cv_prod"]; g["project_id"] != "obj_acme" || g["project_ref"] != "PRJ-0001" || g["project_name"] != "Acme" {
		t.Fatalf("默认项目：%v", g)
	}
	if x := rows["cv_empty"]; x == nil || x["total"] != 0.0 || x["last_at"] != nil || x["name"] != "#empty" || x["project_name"] != "Globex" {
		t.Fatalf("设了默认项目的空会话也列：%v", x)
	}
	// 最近有消息的在前，没消息的在最后
	code, out := call(t, e.h, "GET", "/api/im/conversations/summary", "")
	if xs := out["data"].([]any); code != 200 || xs[0].(map[string]any)["conversation_id"] != dmID || xs[len(xs)-1].(map[string]any)["conversation_id"] != "cv_empty" {
		t.Fatalf("排序：%v", out)
	}
	// 按渠道筛
	if rows := summaryRows(t, e, "?channel=telegram"); len(rows) != 0 {
		t.Fatalf("别的渠道没有：%v", rows)
	}
	if rows := summaryRows(t, e, "?channel=SLACK"); len(rows) != 3 {
		t.Fatalf("渠道不分大小写：%v", rows)
	}
	// 项目进了回收站按没设
	exec(t, e.st.DB(), `UPDATE objects SET deleted_at = '2026-03-01' WHERE id = 'obj_acme'`)
	if g := summaryRows(t, e, "")["cv_prod"]; g["project_id"] != nil || g["project_name"] != "" {
		t.Fatalf("项目删了按没设：%v", g)
	}
}

func TestBatchConversationProjects(t *testing.T) {
	e := setupSOP(t)
	seedProjects(t, e)
	e.push(t, `{"external_id":"C01:b1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"一"}`)
	e.push(t, `{"external_id":"C02:b2","connector_id":"cn_ok","conversation_id":"C02","conversation_name":"#readonly","sender_id":"U1","sender_name":"林原","text":"二"}`)

	// 逐条校验：能写的写上，不能写的列出原因
	code, out := call(t, e.h, "PUT", "/api/im/conversation-projects", `{"items":[
		{"conversation_id":"cv_prod","project_id":"PRJ-0001"},
		{"conversation_id":"cv_recv","project_id":"Globex"},
		{"conversation_id":"cv_none","project_id":"Acme"},
		{"conversation_id":"cv_empty","project_id":"旧项目"},
		{"conversation_id":"cv_prod","project_id":"Globex"},
		{"conversation_id":"","project_id":"Globex"}]}`)
	if code != 200 {
		t.Fatalf("批量：%d %v", code, out)
	}
	d := data(out)
	upd, failed := d["updated"].([]any), d["failed"].([]any)
	if len(upd) != 2 || len(failed) != 4 {
		t.Fatalf("2 条成功 4 条失败：%v", out)
	}
	if m := out["meta"].(map[string]any); m["total"] != 6.0 || m["updated"] != 2.0 || m["failed"] != 4.0 {
		t.Fatalf("meta：%v", m)
	}
	if u := upd[0].(map[string]any); u["conversation_id"] != "cv_prod" || u["project_id"] != "obj_acme" || u["project_name"] != "Acme" || u["project_ref"] != "PRJ-0001" {
		t.Fatalf("成功明细：%v", u)
	}
	codes := []string{}
	for _, f := range failed {
		x := f.(map[string]any)
		codes = append(codes, fmt.Sprint(x["conversation_id"], "/", x["code"]))
		if x["message"] == "" {
			t.Fatalf("失败要写原因：%v", x)
		}
	}
	if got := strings.Join(codes, ","); got != "cv_none/not_found,cv_empty/validation,cv_prod/validation,/validation" {
		t.Fatalf("失败明细：%s", got)
	}
	_, all := list(t, e.h, "")
	if all["C01:b1"]["project_id"] != "obj_acme" || all["C02:b2"]["project_id"] != "obj_globex" || all["C02:b2"]["project_source"] != "conversation" {
		t.Fatalf("写上后消息按群组默认兜底：%v %v", all["C01:b1"], all["C02:b2"])
	}

	// 审计：每个改了的会话一条，没变的不记
	var n int
	var summary, detail string
	if err := e.st.DB().R.QueryRow(`SELECT count(*), max(summary), max(detail) FROM audits WHERE action = 'update' AND target_type = 'conversation' AND target_id = 'cv_prod'`).
		Scan(&n, &summary, &detail); err != nil || n != 1 || summary != "群组默认归属「#product」不归项目 → Acme" ||
		!strings.Contains(detail, `"batch":true`) || !strings.Contains(detail, `"to":"obj_acme"`) || !strings.Contains(detail, `"from":null`) {
		t.Fatalf("审计：%v %d %s %s", err, n, summary, detail)
	}
	call(t, e.h, "PUT", "/api/im/conversation-projects", `{"conversation_ids":["cv_prod"],"project_id":"Acme"}`)
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM audits WHERE target_type = 'conversation' AND target_id = 'cv_prod'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("没变不记审计：%v %d", err, n)
	}

	// 同一个项目设给多个会话；再一起清除
	code, out = call(t, e.h, "PUT", "/api/im/conversation-projects", `{"conversation_ids":["cv_prod","cv_recv","cv_empty"],"project_id":"obj_globex"}`)
	if code != 200 || len(data(out)["updated"].([]any)) != 3 || len(data(out)["failed"].([]any)) != 0 {
		t.Fatalf("同一项目设多个：%d %v", code, out)
	}
	if n, _ := list(t, e.h, "?project_id=obj_globex"); n != 2 {
		t.Fatalf("两个群的消息都归 Globex：%d", n)
	}
	code, out = call(t, e.h, "PUT", "/api/im/conversation-projects", `{"items":[{"conversation_id":"cv_prod","project_id":null},{"conversation_id":"cv_recv","project_id":""},{"conversation_id":"cv_empty","project_id":"Acme"}]}`)
	if code != 200 || len(data(out)["updated"].([]any)) != 3 {
		t.Fatalf("清除和设混在一批：%d %v", code, out)
	}
	if u := data(out)["updated"].([]any)[0].(map[string]any); u["project_id"] != nil || u["project_name"] != "" {
		t.Fatalf("清除后 project_id 为 null：%v", u)
	}
	if code, out := call(t, e.h, "GET", "/api/im/conversation-projects", ""); code != 200 || len(out["data"].([]any)) != 1 {
		t.Fatalf("只剩 cv_empty：%v", out)
	}
	if err := e.st.DB().R.QueryRow(`SELECT summary FROM audits WHERE target_id = 'cv_prod' ORDER BY at DESC, rowid DESC LIMIT 1`).Scan(&summary); err != nil || summary != "群组默认归属「#product」Globex → 不归项目" {
		t.Fatalf("清除的审计：%v %s", err, summary)
	}

	// 整批的校验
	ids := make([]string, maxConvBatch+1)
	for i := range ids {
		ids[i] = `"cv_prod"`
	}
	for _, body := range []string{
		`{}`,
		`{"items":[]}`,
		`{"items":[{"conversation_id":"cv_prod"}]}`,
		`{"conversation_ids":["cv_prod"]}`,
		`{"items":[{"conversation_id":"cv_prod","project_id":null}],"conversation_ids":["cv_prod"],"project_id":null}`,
		`{"items":"x"}`,
		`{"conversation_ids":[` + strings.Join(ids, ",") + `],"project_id":null}`,
	} {
		if code, out := call(t, e.h, "PUT", "/api/im/conversation-projects", body); code != 400 || errOf(out)["code"] != "validation" {
			t.Fatalf("%.80s 要 400：%d %v", body, code, out)
		}
	}
}

func TestSingleConversationProjectAudit(t *testing.T) {
	e := setupSOP(t)
	seedProjects(t, e)
	for _, body := range []string{`{"project_id":"Acme"}`, `{"project_id":"Acme"}`, `{"project_id":null}`, `{"project_id":null}`} {
		if code, out := call(t, e.h, "PUT", "/api/im/conversation-projects/cv_prod", body); code != 200 {
			t.Fatalf("%s：%d %v", body, code, out)
		}
	}
	rows, err := e.st.DB().R.Query(`SELECT summary, detail FROM audits WHERE target_type = 'conversation' AND target_id = 'cv_prod' ORDER BY at, rowid`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var got []string
	for rows.Next() {
		var s, d string
		if err := rows.Scan(&s, &d); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(d, `"batch"`) {
			t.Fatalf("单个设不带 batch：%s", d)
		}
		got = append(got, s)
	}
	if strings.Join(got, "|") != "群组默认归属「#product」不归项目 → Acme|群组默认归属「#product」Acme → 不归项目" {
		t.Fatalf("单个设：设、清除各一条，重复的不记：%v", got)
	}
}
