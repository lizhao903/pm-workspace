// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"strings"
	"testing"
)

func TestMaterialsAPI(t *testing.T) {
	r, h, d := setup(t)
	base := "/api/projects/obj_p1/materials"

	if code, out := call(t, h, "GET", base, ""); code != 200 || len(out["data"].([]any)) != 0 {
		t.Fatalf("空列表：%d %v", code, out)
	}

	// 四种各加一条
	adds := []struct{ body, kind, name, value string }{
		{`{"kind":"file","value":" /Volumes/p/docs/refs/dify.png ","tags":["参考"," SOP ","参考",""]}`, "file", "dify.png", "/Volumes/p/docs/refs/dify.png"},
		{`{"kind":"folder","name":"旧版截图","value":"/Volumes/p/docs/screenshots/"}`, "folder", "旧版截图", "/Volumes/p/docs/screenshots"},
		{`{"kind":"link","name":"接口契约","value":"https://example.com/api-contract"}`, "link", "接口契约", "https://example.com/api-contract"},
		{`{"kind":"note","value":"侧栏太宽\n设置项散落在各页"}`, "note", "侧栏太宽", "侧栏太宽\n设置项散落在各页"},
	}
	ids := map[string]string{}
	for _, a := range adds {
		code, out := call(t, h, "POST", base, a.body)
		if code != 201 {
			t.Fatalf("新增 %s：%d %v", a.kind, code, out)
		}
		m := out["data"].(map[string]any)
		if m["kind"] != a.kind || m["name"] != a.name || m["value"] != a.value || m["source"] != "manual" ||
			m["project_id"] != "obj_p1" || !strings.HasPrefix(m["id"].(string), "mt_") {
			t.Fatalf("新增 %s 返回：%v", a.kind, m)
		}
		ids[a.kind] = m["id"].(string)
	}
	_, out := call(t, h, "GET", base+"/"+ids["file"], "")
	if tags := out["data"].(map[string]any)["tags"].([]any); len(tags) != 2 || tags[0] != "参考" || tags[1] != "SOP" {
		t.Fatalf("标签去空白去重：%v", out)
	}

	// 项目文档就是带 category、status 的文件资料
	code, out := call(t, h, "POST", base, `{"kind":"file","name":"信息架构","value":"/Volumes/p/web-next/README.md","category":"交互说明","status":"draft"}`)
	if m := out["data"].(map[string]any); code != 201 || m["category"] != "交互说明" || m["status"] != "draft" {
		t.Fatalf("项目文档：%d %v", code, out)
	}
	docID := out["data"].(map[string]any)["id"].(string)

	// 校验
	for _, body := range []string{
		`{}`, `[]`, `{"kind":"image","value":"/a"}`, `{"kind":"file"}`, `{"kind":"file","value":"  "}`,
		`{"kind":"file","value":"docs/a.md"}`, `{"kind":"folder","value":"~/x"}`,
		`{"kind":"link","value":"docs/api.md"}`, `{"kind":"link","value":"javascript:alert(1)"}`, `{"kind":"link","value":"https://"}`,
		`{"kind":"note","value":"x","status":"done"}`, `{"kind":"note","value":"` + strings.Repeat("长", maxNote+1) + `"}`,
		`{"kind":"note","value":"x","name":"` + strings.Repeat("名", maxName+1) + `"}`,
		`{"kind":"note","value":"x","tags":["` + strings.Repeat("签", maxTag+1) + `"]}`,
	} {
		if code, out := call(t, h, "POST", base, body); code != 400 {
			t.Fatalf("%.60s 应 400：%d %v", body, code, out)
		}
	}
	// 不是项目、不存在的项目 404
	if code, _ := call(t, h, "GET", "/api/projects/obj_t1/materials", ""); code != 404 {
		t.Fatalf("任务不是项目应 404：%d", code)
	}
	if code, _ := call(t, h, "POST", "/api/projects/obj_none/materials", `{"kind":"note","value":"x"}`); code != 404 {
		t.Fatalf("不存在的项目应 404：%d", code)
	}

	// 列表按添加先后，可按种类筛
	_, out = call(t, h, "GET", base, "")
	if list := out["data"].([]any); len(list) != 5 || list[0].(map[string]any)["id"] != ids["file"] || out["meta"].(map[string]any)["total"] != 5.0 {
		t.Fatalf("列表：%v", out)
	}
	_, out = call(t, h, "GET", base+"?kind=file", "")
	if list := out["data"].([]any); len(list) != 2 {
		t.Fatalf("按种类筛：%v", out)
	}
	if code, _ := call(t, h, "GET", base+"?kind=doc", ""); code != 400 {
		t.Fatalf("不认识的种类应 400：%d", code)
	}

	// 改：四种都改一遍
	patches := []struct{ kind, body, field, want string }{
		{"file", `{"value":"/Volumes/p/docs/refs/dify-v2.png"}`, "value", "/Volumes/p/docs/refs/dify-v2.png"},
		{"folder", `{"name":"界面截图"}`, "name", "界面截图"},
		{"link", `{"value":"http://example.com/v2"}`, "value", "http://example.com/v2"},
		{"note", `{"value":"侧栏改窄了"}`, "value", "侧栏改窄了"},
	}
	for _, p := range patches {
		code, out := call(t, h, "PATCH", base+"/"+ids[p.kind], p.body)
		if code != 200 || out["data"].(map[string]any)[p.field] != p.want || out["data"].(map[string]any)["kind"] != p.kind {
			t.Fatalf("修改 %s：%d %v", p.kind, code, out)
		}
	}
	// 只改标签不动别的；改名字成空串回到默认名
	code, out = call(t, h, "PATCH", base+"/"+ids["file"], `{"tags":[]}`)
	if m := out["data"].(map[string]any); code != 200 || len(m["tags"].([]any)) != 0 || m["value"] != "/Volumes/p/docs/refs/dify-v2.png" {
		t.Fatalf("只改标签：%d %v", code, out)
	}
	if _, out := call(t, h, "PATCH", base+"/"+ids["folder"], `{"name":""}`); out["data"].(map[string]any)["name"] != "screenshots" {
		t.Fatalf("名字清空回到默认：%v", out)
	}
	code, out = call(t, h, "PATCH", base+"/"+docID, `{"status":"final","category":""}`)
	if m := out["data"].(map[string]any); code != 200 || m["status"] != "final" || m["category"] != "" {
		t.Fatalf("改状态和类别：%d %v", code, out)
	}
	for _, c := range [][2]string{
		{ids["note"], `{"kind":"link"}`}, {ids["link"], `{"value":"ftp://x"}`}, {ids["file"], `{"value":"rel/path"}`}, {docID, `{"status":"x"}`},
	} {
		if code, out := call(t, h, "PATCH", base+"/"+c[0], c[1]); code != 400 {
			t.Fatalf("%s 应 400：%d %v", c[1], code, out)
		}
	}
	// 同种类时带上 kind 不算改种类
	if code, _ := call(t, h, "PATCH", base+"/"+ids["note"], `{"kind":"note","name":"反馈"}`); code != 200 {
		t.Fatalf("带同样的 kind：%d", code)
	}
	// 换种类（0.9.1）：笔记和链接互换、文件和文件夹互换，值按新种类校验；跨组 400
	_, out = call(t, h, "POST", base, `{"kind":"note","value":"https://example.com/spec"}`)
	nid := out["data"].(map[string]any)["id"].(string)
	if code, out := call(t, h, "PATCH", base+"/"+nid, `{"kind":"link"}`); code != 200 || out["data"].(map[string]any)["kind"] != "link" ||
		out["data"].(map[string]any)["value"] != "https://example.com/spec" {
		t.Fatalf("笔记改成链接：%d %v", code, out)
	}
	if code, out := call(t, h, "PATCH", base+"/"+nid, `{"kind":"note","value":"改回笔记\n第二行"}`); code != 200 || out["data"].(map[string]any)["kind"] != "note" {
		t.Fatalf("链接改成笔记：%d %v", code, out)
	}
	if code, out := call(t, h, "PATCH", base+"/"+ids["file"], `{"kind":"folder"}`); code != 200 || out["data"].(map[string]any)["kind"] != "folder" {
		t.Fatalf("文件改成文件夹：%d %v", code, out)
	}
	if code, _ := call(t, h, "PATCH", base+"/"+ids["file"], `{"kind":"file"}`); code != 200 {
		t.Fatalf("文件夹改回文件：%d", code)
	}
	for _, c := range []string{`{"kind":"file","value":"/tmp/a"}`, `{"kind":"folder"}`, `{"kind":"x"}`} {
		if code, _ := call(t, h, "PATCH", base+"/"+nid, c); code != 400 {
			t.Fatalf("%s 应 400：%d", c, code)
		}
	}
	// 别的项目的资料用本项目路径改不到
	if code, _ := call(t, h, "PATCH", base+"/mt_none", `{"name":"x"}`); code != 404 {
		t.Fatalf("改不存在的资料应 404：%d", code)
	}

	// props 里 tags 以外的 key 保留
	if _, err := d.W.Exec(`UPDATE projects_materials SET props = '{"tags":["a"],"keep":1}' WHERE id = ?`, ids["link"]); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, h, "PATCH", base+"/"+ids["link"], `{"tags":["b"]}`); code != 200 {
		t.Fatalf("改标签：%d", code)
	}
	var props string
	if err := d.R.QueryRow(`SELECT props FROM projects_materials WHERE id = ?`, ids["link"]).Scan(&props); err != nil ||
		!strings.Contains(props, `"keep":1`) || !strings.Contains(props, `"tags":["b"]`) {
		t.Fatalf("props 合并：%s %v", props, err)
	}

	// 删
	for _, k := range []string{"file", "folder", "link", "note"} {
		if code, _ := call(t, h, "DELETE", base+"/"+ids[k], ""); code != 200 {
			t.Fatalf("删除 %s：%d", k, code)
		}
		if code, _ := call(t, h, "GET", base+"/"+ids[k], ""); code != 404 {
			t.Fatalf("删除后读 %s 应 404：%d", k, code)
		}
	}
	if code, _ := call(t, h, "DELETE", base+"/"+ids["note"], ""); code != 404 {
		t.Fatalf("删两次应 404：%d", code)
	}

	// 硬删项目连带删资料
	if _, err := d.W.Exec(`DELETE FROM objects WHERE id = 'obj_p1'`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM projects_materials`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("硬删项目后资料还在：%d %v", n, err)
	}

	// 停用后 404
	if err := r.Disable(context.Background(), "projects"); err != nil {
		t.Fatal(err)
	}
	for _, c := range [][2]string{{"GET", base}, {"POST", base}, {"GET", base + "/" + docID}, {"PATCH", base + "/" + docID}, {"DELETE", base + "/" + docID}} {
		if code, _ := call(t, h, c[0], c[1], `{"kind":"note","value":"x"}`); code != 404 {
			t.Fatalf("停用后 %s %s 应 404：%d", c[0], c[1], code)
		}
	}
}
