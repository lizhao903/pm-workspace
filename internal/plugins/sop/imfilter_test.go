package sop

import (
	"context"
	"encoding/json"
	"io/fs"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// IM 触发的过滤条件、执行顺序与拦截（TSK-0481）。

func addConv(t *testing.T, d *db.DB, id, channel, ext, name string) {
	t.Helper()
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if _, err := d.W.Exec(`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, 'group', ?, ?, ?)`,
		id, channel, ext, name, now, now); err != nil {
		t.Fatal(err)
	}
}

// 保存：会话认 cv_ id、渠道编号、渠道:编号、会话名，存成 cv_ id；与我的关系、方式、顺序、拦截校验；给哪项改哪项。
func TestIMTriggerSave(t *testing.T) {
	_, h, d := setupDB(t, New())
	addConv(t, d, "cv_octok", "slack", "C0BNCBRL5C0", "ai-octok-platform")
	addConv(t, d, "cv_other", "slack", "C0OTHER", "random")
	addConv(t, d, "cv_tg", "telegram", "C0OTHER", "tg 群")

	steps := `"steps":[{"key":"a","name":"甲","kind":"review"}]`
	code, out := call(t, h, "POST", "/api/sop/flows", `{"name":"群消息忽略","trigger":"im",`+steps+`,
		"im":{"conversations":["C0BNCBRL5C0","cv_octok","#AI-Octok-Platform"],"relevance":["me"],"relevance_mode":"exclude","stop":true}}`)
	if code != 201 {
		t.Fatalf("新建：%d %s", code, errMsg(out))
	}
	f := out["data"].(map[string]any)
	im := f["im"].(map[string]any)
	if b, _ := json.Marshal(im); string(b) != `{"conversations":["cv_octok"],"order":1,"relevance":["me"],"relevance_mode":"exclude","stop":true}` {
		t.Fatalf("im = %s", b)
	}
	id := f["id"].(string)

	// 只改 relevance：会话、拦截不动
	code, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"im":{"relevance":["dm","me","me",""]}}`)
	if code != 200 {
		t.Fatalf("修改：%d %s", code, errMsg(out))
	}
	im = out["data"].(map[string]any)["im"].(map[string]any)
	if b, _ := json.Marshal(im); string(b) != `{"conversations":["cv_octok"],"order":1,"relevance":["me","dm","none"],"relevance_mode":"exclude","stop":true}` {
		t.Fatalf("只改 relevance 后 im = %s", b)
	}
	// 渠道:编号
	code, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"im":{"conversations":["telegram:C0OTHER"]}}`)
	if code != 200 || out["data"].(map[string]any)["im"].(map[string]any)["conversations"].([]any)[0] != "cv_tg" {
		t.Fatalf("渠道:编号：%d %v", code, out)
	}

	bad := []struct{ body, msg string }{
		{`{"im":{"conversations":["C0NONE"]}}`, "找不到会话 C0NONE"},
		{`{"im":{"conversations":["cv_none"]}}`, "会话 cv_none 不存在"},
		{`{"im":{"conversations":["C0OTHER"]}}`, "会话 C0OTHER 对上了 2 个"},
		{`{"im":{"relevance":["boss"]}}`, "im.relevance 只能是"},
		{`{"im":{"relevance_mode":"maybe"}}`, "im.relevance_mode 只能是"},
		{`{"im":{"order":0}}`, "im.order 要是从 1 起的整数"},
		{`{"im":{"order":1.5}}`, "im.order 要是从 1 起的整数"},
		{`{"im":"x"}`, "im 必须是对象"},
	}
	for _, c := range bad {
		code, out := call(t, h, "PATCH", "/api/sop/flows/"+id, c.body)
		if code != 400 || !strings.Contains(errMsg(out), c.msg) {
			t.Errorf("%s：%d %s", c.body, code, errMsg(out))
		}
	}

	// 不是 im 的流程也带 im，order 为 0；没给 im 时不过滤、不拦截
	code, out = call(t, h, "POST", "/api/sop/flows", `{"name":"手动的","trigger":"manual",`+steps+`}`)
	if code != 201 {
		t.Fatal(errMsg(out))
	}
	if b, _ := json.Marshal(out["data"].(map[string]any)["im"]); string(b) != `{"conversations":[],"order":0,"relevance":[],"relevance_mode":"include","stop":false}` {
		t.Fatalf("手动流程的 im = %s", b)
	}
}

// 顺序：新 IM 流程排最后；给 order 插到那个位置、其余顺延；改成别的触发方式退出顺序，再改回 im 排最后。
func TestIMTriggerOrder(t *testing.T) {
	_, h := setup(t, New())
	steps := `"steps":[{"key":"a","name":"甲","kind":"review"}]`
	mk := func(name, extra string) string {
		return newFlow(t, h, `{"name":"`+name+`","trigger":"im",`+steps+extra+`}`)
	}
	a, b, c := mk("甲", ""), mk("乙", ""), mk("丙", "")
	manual := newFlow(t, h, `{"name":"手动","trigger":"manual",`+steps+`}`)
	order := func() []string {
		t.Helper()
		_, out := call(t, h, "GET", "/api/sop/flows", "")
		type row struct {
			id string
			n  int
		}
		var rows []row
		for _, x := range out["data"].([]any) {
			m := x.(map[string]any)
			n := int(m["im"].(map[string]any)["order"].(float64))
			if m["trigger"] != "im" {
				if n != 0 {
					t.Fatalf("不是 im 的流程 order 应为 0：%v", m["name"])
				}
				continue
			}
			rows = append(rows, row{m["id"].(string), n})
		}
		slices.SortFunc(rows, func(x, y row) int { return x.n - y.n })
		ids := make([]string, len(rows))
		for i, r := range rows {
			if r.n != i+1 {
				t.Fatalf("order 应从 1 连续编号：%v", rows)
			}
			ids[i] = r.id
		}
		return ids
	}
	if got := order(); !slices.Equal(got, []string{a, b, c}) {
		t.Fatalf("默认按新建先后：%v", got)
	}
	d := mk("丁", `,"im":{"order":1}`)
	if got := order(); !slices.Equal(got, []string{d, a, b, c}) {
		t.Fatalf("插到第 1：%v", got)
	}
	if code, out := call(t, h, "PATCH", "/api/sop/flows/"+c, `{"im":{"order":2}}`); code != 200 {
		t.Fatal(errMsg(out))
	}
	if got := order(); !slices.Equal(got, []string{d, c, a, b}) {
		t.Fatalf("挪到第 2：%v", got)
	}
	if code, out := call(t, h, "PATCH", "/api/sop/flows/"+a, `{"im":{"order":99}}`); code != 200 {
		t.Fatal(errMsg(out))
	}
	if got := order(); !slices.Equal(got, []string{d, c, b, a}) {
		t.Fatalf("超过总数排最后：%v", got)
	}
	call(t, h, "PATCH", "/api/sop/flows/"+d, `{"trigger":"manual"}`)
	if got := order(); !slices.Equal(got, []string{c, b, a}) {
		t.Fatalf("改成手动退出顺序：%v", got)
	}
	call(t, h, "PATCH", "/api/sop/flows/"+d, `{"trigger":"im"}`)
	call(t, h, "PATCH", "/api/sop/flows/"+manual, `{"trigger":"im","im":{"order":1}}`)
	if got := order(); !slices.Equal(got, []string{manual, c, b, a, d}) {
		t.Fatalf("改回 im 排最后、带 order 的插进去：%v", got)
	}
}

// 触发：按顺序逐条判断，不符合过滤的不发起、不留记录；拦截流程命中并发起后，后面的不再发起；没命中时照常往下。
// 这就是用户要的样例：C0BNCBRL5C0 里非 @我 的消息由第一条流程接住（标为忽略），其他 IM 流程不再接；@我 的照常走其他流程。
func TestIMTriggerFilterAndStop(t *testing.T) {
	ctx := context.Background()
	reg, h, d := setupDB(t, New())
	addConv(t, d, "cv_octok", "slack", "C0BNCBRL5C0", "ai-octok-platform")
	addConv(t, d, "cv_other", "slack", "C0OTHER", "random")
	steps := `"steps":[{"key":"a","name":"甲","kind":"review"}]`
	other := newFlow(t, h, `{"name":"消息分流","trigger":"im",`+steps+`}`)
	onlyMe := newFlow(t, h, `{"name":"只看 @我","trigger":"im","im":{"relevance":["me","dm"]},`+steps+`}`)
	ignore := newFlow(t, h, `{"name":"群消息忽略","trigger":"im",`+steps+`,
		"im":{"conversations":["C0BNCBRL5C0"],"relevance":["me"],"relevance_mode":"exclude","order":1,"stop":true}}`)

	deliver := func(id, conv, rel string) {
		t.Helper()
		var cv any
		if conv != "" {
			cv = conv
		}
		payload, _ := json.Marshal(map[string]any{"message_id": id, "channel": "slack", "connector_id": "cn_1",
			"conversation_id": cv, "relevance": rel, "at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")})
		if err := reg.Subscribers(imReceivedEvent)[0].Handle(ctx, plugin.Event{Type: imReceivedEvent, At: time.Now(), Payload: payload}); err != nil {
			t.Fatal(err)
		}
	}
	flowsFor := func(msg string) []string {
		t.Helper()
		_, out := call(t, h, "GET", "/api/sop/runs?limit=500", "")
		var got []string
		for _, x := range out["data"].([]any) {
			m := x.(map[string]any)
			if m["source_ref"] == msg {
				got = append(got, m["flow_id"].(string))
			}
		}
		slices.Sort(got)
		return got
	}
	sorted := func(ids ...string) []string { slices.Sort(ids); return ids }

	deliver("m_plain", "cv_octok", "")
	if got := flowsFor("m_plain"); !slices.Equal(got, []string{ignore}) {
		t.Fatalf("群里非 @我：只该忽略流程接住，后面的被拦：%v", got)
	}
	deliver("m_all", "cv_octok", "all")
	if got := flowsFor("m_all"); !slices.Equal(got, []string{ignore}) {
		t.Fatalf("群里 @所有人 也不是 @我：%v", got)
	}
	deliver("m_me", "cv_octok", "me")
	if got := flowsFor("m_me"); !slices.Equal(got, sorted(other, onlyMe)) {
		t.Fatalf("群里 @我：忽略流程不命中、不留记录，其他照常：%v", got)
	}
	deliver("m_else", "cv_other", "")
	if got := flowsFor("m_else"); !slices.Equal(got, []string{other}) {
		t.Fatalf("别的群：只有不过滤的流程：%v", got)
	}
	deliver("m_noconv", "", "dm")
	if got := flowsFor("m_noconv"); !slices.Equal(got, sorted(other, onlyMe)) {
		t.Fatalf("没有会话的私聊：选了会话的不命中：%v", got)
	}
	// 同一条消息再投一次：已发起过的拦截流程照样拦，后面的不补发起
	deliver("m_plain", "cv_octok", "")
	if got := flowsFor("m_plain"); !slices.Equal(got, []string{ignore}) {
		t.Fatalf("重投：%v", got)
	}
	// 拦截流程发起失败（必填补不齐）不算命中，后面的照常
	call(t, h, "PATCH", "/api/sop/flows/"+ignore, `{"fields":[{"key":"customer","label":"客户","type":"text","required":true}]}`)
	deliver("m_fail", "cv_octok", "")
	if got := flowsFor("m_fail"); !slices.Equal(got, []string{other}) {
		t.Fatalf("发起失败不拦：%v", got)
	}
	// 关掉拦截：都发起
	call(t, h, "PATCH", "/api/sop/flows/"+ignore, `{"fields":[],"im":{"stop":false}}`)
	deliver("m_nostop", "cv_octok", "")
	if got := flowsFor("m_nostop"); !slices.Equal(got, sorted(ignore, other)) {
		t.Fatalf("不拦截时后面的照常：%v", got)
	}
}

// 迁移：已有流程不过滤、不拦截，顺序按新建先后（和以前逐条发起的顺序一致）。
func TestIMTriggerMigration(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	mig := New().Migrations()
	files, _ := fs.Glob(mig, "*.sql")
	run := func(name string) {
		b, err := fs.ReadFile(mig, name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := d.W.Exec(string(b)); err != nil {
			t.Fatalf("%s：%v", name, err)
		}
	}
	for _, f := range files {
		if f < "0008" {
			run(f)
		}
	}
	for _, x := range []struct{ id, at string }{{"sop_c", "2026-11-03T00:00:00Z"}, {"sop_a", "2026-11-01T00:00:00Z"}, {"sop_b", "2026-11-01T00:00:00Z"}} {
		if _, err := d.W.Exec(`INSERT INTO sop_flows (id, name, trigger_desc, created_at, updated_at) VALUES (?, ?, 'im', ?, ?)`, x.id, x.id, x.at, x.at); err != nil {
			t.Fatal(err)
		}
	}
	run("0008_im_trigger.sql")
	rows, err := d.R.Query(`SELECT id, im_filter, im_order, im_stop FROM sop_flows ` + imOrderBy)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var got []string
	for rows.Next() {
		var id, filter string
		var order, stop int
		if err := rows.Scan(&id, &filter, &order, &stop); err != nil {
			t.Fatal(err)
		}
		if filter != "{}" || stop != 0 || order != 0 {
			t.Fatalf("%s：filter %s stop %d", id, filter, stop)
		}
		got = append(got, id)
	}
	// 同一时间建的按 rowid（插入先后）
	if !slices.Equal(got, []string{"sop_a", "sop_b", "sop_c"}) {
		t.Fatalf("顺序 = %v", got)
	}
}

// Agent 的 create_sop 经流程目录带 im 保存，list_sops / get_sop 看得到一句 IM 触发条件。
func TestIMTriggerViaCatalog(t *testing.T) {
	ctx := context.Background()
	reg, _, d := setupDB(t, New())
	addConv(t, d, "cv_octok", "slack", "C0BNCBRL5C0", "ai-octok-platform")
	body := map[string]json.RawMessage{
		"name":    json.RawMessage(`"群消息忽略"`),
		"trigger": json.RawMessage(`"im"`),
		"steps":   json.RawMessage(`[{"key":"a","name":"甲","kind":"review"}]`),
		"im":      json.RawMessage(`{"conversations":["C0BNCBRL5C0"],"relevance":["me"],"relevance_mode":"exclude","order":1,"stop":true}`),
	}
	doc, err := reg.SaveSOP(ctx, plugin.SOPSave{Body: body})
	if err != nil {
		t.Fatal(err)
	}
	want := "会话 ai-octok-platform（slack C0BNCBRL5C0，cv_octok）；排除 @我；第 1 个判断；命中后不再触发后面的 IM 流程"
	if doc.IMTrigger != want {
		t.Fatalf("IMTrigger = %q", doc.IMTrigger)
	}
	list, _ := reg.ListSOPs(ctx)
	if len(list) != 1 || list[0].IMTrigger != want {
		t.Fatalf("列表：%+v", list)
	}
	body["im"] = json.RawMessage(`{"conversations":["C0NONE"]}`)
	if _, err := reg.SaveSOP(ctx, plugin.SOPSave{Body: body}); err == nil || !strings.HasPrefix(err.Error(), "找不到会话 C0NONE") {
		t.Fatalf("会话找不到：%v", err)
	}
}
