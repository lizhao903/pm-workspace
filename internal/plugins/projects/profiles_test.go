package projects

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProfileAPI(t *testing.T) {
	_, h, d := setup(t)
	base := "/api/projects/obj_p1/profile"

	// 没建过档案：空档案，时间为 null
	code, out := call(t, h, "GET", base, "")
	if code != 200 {
		t.Fatalf("读空档案：%d %v", code, out)
	}
	p := out["data"].(map[string]any)
	if p["intro"] != "" || len(p["keywords"].([]any)) != 0 || len(p["commands"].(map[string]any)) != 0 || p["created_at"] != nil {
		t.Fatalf("空档案：%v", p)
	}
	// 任务、不存在的、软删的项目都 404
	for _, path := range []string{"/api/projects/obj_t1/profile", "/api/projects/obj_none/profile"} {
		if code, _ := call(t, h, "GET", path, ""); code != 404 {
			t.Fatalf("%s 应 404，实际 %d", path, code)
		}
	}

	root := t.TempDir()
	code1 := filepath.Join(root, "code")
	proto := filepath.Join(root, "proto")
	if err := os.MkdirAll(code1, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(proto, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "prd-link")
	if err := os.Symlink(proto, link); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "f.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	body := `{"intro":"  工作台 ","keywords":["需求"," 原型","需求","","PRD","prd"],"platforms":["web","桌面"],
		"code_dir":"` + code1 + `/","proto_dir":"` + proto + `","prd_dir":"` + link + `",
		"commands":{"build":{"command":" make build ","dir":"./frontend","timeout_sec":600},"test":{"command":"","dir":"x"}},
		"owner_ids":["stk_a","stk_a"," "],"acceptor_ids":["stk_b"]}`
	code, out = call(t, h, "PATCH", base, body)
	if code != 200 {
		t.Fatalf("写档案：%d %v", code, out)
	}
	p = out["data"].(map[string]any)
	if p["intro"] != "工作台" || strings.Join(strs(p["keywords"]), ",") != "需求,原型,PRD" ||
		strings.Join(strs(p["platforms"]), ",") != "web,桌面" || p["code_dir"] != code1 || p["prd_dir"] != link ||
		strings.Join(strs(p["owner_ids"]), ",") != "stk_a" || strings.Join(strs(p["acceptor_ids"]), ",") != "stk_b" ||
		p["created_at"] == nil {
		t.Fatalf("写回的档案：%v", p)
	}
	cmds := p["commands"].(map[string]any)
	if len(cmds) != 1 {
		t.Fatalf("空命令应当清掉：%v", cmds)
	}
	if b := cmds["build"].(map[string]any); b["command"] != "make build" || b["dir"] != "frontend" || b["timeout_sec"] != 600.0 {
		t.Fatalf("build 命令：%v", b)
	}

	// 只改一项，其余不动
	if code, out := call(t, h, "PATCH", base, `{"intro":"新简介"}`); code != 200 ||
		out["data"].(map[string]any)["intro"] != "新简介" || out["data"].(map[string]any)["code_dir"] != code1 {
		t.Fatalf("改简介：%d %v", code, out)
	}

	// 校验
	for _, bad := range []string{
		`{"code_dir":"relative/dir"}`,
		`{"code_dir":"` + filepath.Join(root, "nope") + `"}`,
		`{"proto_dir":"` + file + `"}`,
		`{"commands":{"deploy":{"command":"x"}}}`,
		`{"commands":{"build":{"command":"x","dir":"/abs"}}}`,
		`{"commands":{"build":{"command":"x","dir":"../out"}}}`,
		`{"commands":{"build":{"command":"x","timeout_sec":-1}}}`,
		`{"commands":{"build":{"command":"x","timeout_sec":90000}}}`,
		`{"owner_ids":["stk_none"]}`,
		`{"acceptor_ids":["stk_x"]}`,
		`{"keywords":["` + strings.Repeat("长", 31) + `"]}`,
		`{"intro":"` + strings.Repeat("长", 2001) + `"}`,
		`not json`,
	} {
		if code, out := call(t, h, "PATCH", base, bad); code != 400 || out["error"].(map[string]any)["code"] != "validation" {
			t.Fatalf("%s 应 400，实际 %d %v", bad, code, out)
		}
	}
	// 校验失败不落库
	if _, out := call(t, h, "GET", base, ""); out["data"].(map[string]any)["code_dir"] != code1 {
		t.Fatalf("校验失败后档案变了：%v", out)
	}
	// 清目录
	if code, out := call(t, h, "PATCH", base, `{"prd_dir":""}`); code != 200 || out["data"].(map[string]any)["prd_dir"] != "" {
		t.Fatalf("清目录：%d %v", code, out)
	}

	// 删掉的联系人读的时候滤掉
	if _, err := d.W.Exec(`DELETE FROM stakeholders WHERE id = 'stk_b'`); err != nil {
		t.Fatal(err)
	}
	if _, out := call(t, h, "GET", base, ""); len(out["data"].(map[string]any)["acceptor_ids"].([]any)) != 0 {
		t.Fatalf("删掉的验收人员应滤掉：%v", out)
	}

	// 软删项目：读写都 404，行还在
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := d.W.Exec(`UPDATE objects SET deleted_at = ? WHERE id = 'obj_p1'`, now); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, h, "PATCH", base, `{"intro":"x"}`); code != 404 {
		t.Fatalf("软删项目应 404，实际 %d", code)
	}
	var n int
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM projects_profiles WHERE project_id = 'obj_p1'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("软删不动档案：%d %v", n, err)
	}
	// 硬删项目级联删档案
	if _, err := d.W.Exec(`DELETE FROM objects WHERE id = 'obj_p1'`); err != nil {
		t.Fatal(err)
	}
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM projects_profiles`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("硬删应级联：%d %v", n, err)
	}
}

func TestProfileSummaryAPI(t *testing.T) {
	_, h, d := setup(t)
	now := time.Now().UTC().Format(time.RFC3339)
	root := t.TempDir()
	if _, err := d.W.Exec(`INSERT INTO objects (id, type_id, ref, title, workdir, created_at, updated_at)
		VALUES ('obj_p2', 'project', 'PRJ-T2', '甲项目', ?, ?, ?), ('obj_p3', 'project', 'PRJ-T3', '丙项目', '', ?, ?)`,
		root, now, now, now, now); err != nil {
		t.Fatal(err)
	}

	if code, out := call(t, h, "GET", "/api/projects/profiles", ""); code != 200 || len(out["data"].([]any)) != 0 {
		t.Fatalf("没档案时为空：%d %v", code, out)
	}
	gone := filepath.Join(root, "gone")
	if err := os.Mkdir(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, x := range [][2]string{
		{"obj_p1", `{"intro":"一","keywords":["k1"],"code_dir":"` + root + `","proto_dir":"` + root + `","prd_dir":"` + root + `","commands":{"test":{"command":"go test"},"build":{"command":"make"}}}`},
		{"obj_p2", `{"intro":"二","platforms":["web"],"proto_dir":"` + gone + `"}`},
		{"obj_p3", `{"intro":"三"}`},
	} {
		if code, out := call(t, h, "PATCH", "/api/projects/"+x[0]+"/profile", x[1]); code != 200 {
			t.Fatalf("建档案 %s：%d %v", x[0], code, out)
		}
	}
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	if _, err := d.W.Exec(`UPDATE objects SET deleted_at = ? WHERE id = 'obj_p3'`, now); err != nil {
		t.Fatal(err)
	}

	code, out := call(t, h, "GET", "/api/projects/profiles", "")
	rows := out["data"].([]any)
	if code != 200 || len(rows) != 2 || out["meta"].(map[string]any)["total"] != 2.0 {
		t.Fatalf("摘要：%d %v", code, out)
	}
	byID := map[string]map[string]any{}
	for _, r := range rows {
		m := r.(map[string]any)
		byID[m["project_id"].(string)] = m
	}
	a, b := byID["obj_p1"], byID["obj_p2"]
	if a["name"] != "项目一" || a["dirs_ready"] != true || strings.Join(strs(a["commands"]), ",") != "build,test" {
		t.Fatalf("项目一：%v", a)
	}
	dirs := b["dirs"].(map[string]any)
	if b["dirs_ready"] != false || b["ref"] != "PRJ-T2" ||
		dirs["code"].(map[string]any)["state"] != "ok" || dirs["code"].(map[string]any)["inherited"] != true ||
		dirs["prototype"].(map[string]any)["state"] != "missing" || dirs["prd"].(map[string]any)["state"] != "unset" {
		t.Fatalf("甲项目：%v", b)
	}
}

func strs(v any) []string {
	out := []string{}
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}
