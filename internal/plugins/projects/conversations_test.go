// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/api"
	"github.com/lizhao903/pm-workspace/internal/conversation"
	"github.com/lizhao903/pm-workspace/internal/imident"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

func TestConversationsAPI(t *testing.T) {
	r, h, d := setup(t)
	now := time.Now().UTC().Format(time.RFC3339)
	for _, q := range []string{
		`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at) VALUES ('obj_p2', 'project', 'PRJ-T2', '项目二', '` + now + `', '` + now + `')`,
		`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES ('cv_g', 'slack', 'C01', 'group', '#product', '` + now + `', '` + now + `')`,
		`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES ('cv_d', 'feishu', 'oc_9', 'direct', '', '` + now + `', '` + now + `')`,
	} {
		if _, err := d.W.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	base := "/api/projects/obj_p1/conversations"

	if code, out := call(t, h, "GET", base, ""); code != 200 || len(out["data"].([]any)) != 0 {
		t.Fatalf("空列表：%d %v", code, out)
	}
	code, out := call(t, h, "POST", base, `{"conversation_id":" cv_g "}`)
	if code != 201 {
		t.Fatalf("绑定：%d %v", code, out)
	}
	if b := out["data"].(map[string]any); b["conversation_id"] != "cv_g" || b["conversation"].(map[string]any)["name"] != "#product" {
		t.Fatalf("绑定返回：%v", out)
	}
	if code, _ := call(t, h, "POST", base, `{"conversation_id":"cv_d"}`); code != 201 {
		t.Fatalf("绑私聊：%d", code)
	}
	// 重复绑定 409；没有这个会话、没给 id 400；不是项目 404
	if code, _ := call(t, h, "POST", base, `{"conversation_id":"cv_g"}`); code != 409 {
		t.Fatalf("重复绑定应 409：%d", code)
	}
	for _, body := range []string{`{"conversation_id":"cv_none"}`, `{"conversation_id":""}`, `{}`, `[]`} {
		if code, _ := call(t, h, "POST", base, body); code != 400 {
			t.Fatalf("%s 应 400：%d", body, code)
		}
	}
	if code, _ := call(t, h, "GET", "/api/projects/obj_t1/conversations", ""); code != 404 {
		t.Fatalf("任务不是项目应 404：%d", code)
	}
	if code, _ := call(t, h, "POST", "/api/projects/obj_none/conversations", `{"conversation_id":"cv_g"}`); code != 404 {
		t.Fatalf("不存在的项目应 404：%d", code)
	}
	// 一个会话可以绑多个项目
	if code, _ := call(t, h, "POST", "/api/projects/obj_p2/conversations", `{"conversation_id":"cv_g"}`); code != 201 {
		t.Fatalf("同一会话绑第二个项目：%d", code)
	}

	_, out = call(t, h, "GET", base, "")
	if list := out["data"].([]any); len(list) != 2 || list[0].(map[string]any)["conversation_id"] != "cv_g" ||
		list[1].(map[string]any)["conversation"].(map[string]any)["kind"] != "direct" || out["meta"].(map[string]any)["total"] != 2.0 {
		t.Fatalf("列表按绑定先后：%v", out)
	}

	if code, _ := call(t, h, "DELETE", base+"/cv_d", ""); code != 200 {
		t.Fatalf("解绑：%d", code)
	}
	if code, _ := call(t, h, "DELETE", base+"/cv_d", ""); code != 404 {
		t.Fatalf("解绑两次应 404：%d", code)
	}
	// 解绑不删会话
	var n int
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM conversations WHERE id = 'cv_d'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("解绑后会话应还在：%d %v", n, err)
	}

	// 删会话连带删绑定，两个项目都删
	if _, err := d.W.Exec(`DELETE FROM conversations WHERE id = 'cv_g'`); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{base, "/api/projects/obj_p2/conversations"} {
		if _, out := call(t, h, "GET", p, ""); len(out["data"].([]any)) != 0 {
			t.Fatalf("删了会话绑定还在：%s %v", p, out)
		}
	}

	// 停用后 404
	if err := r.Disable(context.Background(), "projects"); err != nil {
		t.Fatal(err)
	}
	for _, c := range [][2]string{{"GET", base}, {"POST", base}, {"DELETE", base + "/cv_d"}} {
		if code, _ := call(t, h, c[0], c[1], `{"conversation_id":"cv_d"}`); code != 404 {
			t.Fatalf("停用后 %s 应 404：%d", c[0], code)
		}
	}
}

// 验收：改会话名后绑定不断。走完整服务，调内核的会话改名接口，再查项目绑定。
func TestRenameConversationKeepsBinding(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	reg := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), log)
	reg.Migrations = plugin.NewSQLMigrationStore(st.DB())
	if err := reg.Add(New()); err != nil {
		t.Fatal(err)
	}
	if err := reg.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	s := api.New(st, api.Options{Version: "test", Logger: log, Plugins: reg,
		Identities: imident.New(st.DB()), Conversations: conversation.New(st.DB())})

	if code, out := call(t, s, "POST", "/api/plugins/projects/install", `{"permissions":["process:spawn"]}`); code != 200 {
		t.Fatalf("安装：%d %v", code, out)
	}
	if code, out := call(t, s, "POST", "/api/plugins/projects/enable", `{}`); code != 200 {
		t.Fatalf("启用：%d %v", code, out)
	}
	code, out := call(t, s, "POST", "/api/objects", `{"type_id":"project","title":"官网改版"}`)
	if code != 201 {
		t.Fatalf("建项目：%d %v", code, out)
	}
	pid := out["data"].(map[string]any)["id"].(string)
	code, out = call(t, s, "POST", "/api/conversations", `{"channel":"slack","external_id":"C0WEB","kind":"group","name":"#web"}`)
	if code != 201 {
		t.Fatalf("建会话：%d %v", code, out)
	}
	cid := out["data"].(map[string]any)["id"].(string)
	if code, out := call(t, s, "POST", "/api/projects/"+pid+"/conversations", `{"conversation_id":"`+cid+`"}`); code != 201 {
		t.Fatalf("绑定：%d %v", code, out)
	}

	if code, out := call(t, s, "PATCH", "/api/conversations/"+cid, `{"name":"#web-redesign"}`); code != 200 {
		t.Fatalf("改名：%d %v", code, out)
	}
	code, out = call(t, s, "GET", "/api/projects/"+pid+"/conversations", "")
	if code != 200 {
		t.Fatalf("查绑定：%d %v", code, out)
	}
	list := out["data"].([]any)
	if len(list) != 1 {
		t.Fatalf("改名后绑定断了：%v", out)
	}
	b := list[0].(map[string]any)
	if b["conversation_id"] != cid || b["conversation"].(map[string]any)["name"] != "#web-redesign" {
		t.Fatalf("改名后应返回新名字：%v", b)
	}
}
