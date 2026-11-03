package projects

import (
	"os/exec"
	"strconv"
	"testing"
	"time"
)

func TestSummaryAPI(t *testing.T) {
	_, h, d := setup(t)
	now := time.Now().UTC().Format(time.RFC3339)
	for _, q := range []string{
		`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at) VALUES ('obj_p2', 'project', 'PRJ-T2', '项目二', '` + now + `', '` + now + `')`,
		`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at) VALUES ('obj_p3', 'project', 'PRJ-T3', '项目三', '` + now + `', '` + now + `')`,
		`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES ('cv_g', 'slack', 'C01', 'group', '#product', '` + now + `', '` + now + `')`,
		`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES ('cv_d', 'feishu', 'oc_9', 'direct', '', '` + now + `', '` + now + `')`,
	} {
		if _, err := d.W.Exec(q); err != nil {
			t.Fatal(err)
		}
	}

	// 什么都没有时是空数组
	if code, out := call(t, h, "GET", "/api/projects/summary", ""); code != 200 || len(out["data"].([]any)) != 0 || out["meta"].(map[string]any)["total"] != 0.0 {
		t.Fatalf("空汇总：%d %v", code, out)
	}

	dir := t.TempDir()
	for _, body := range []string{
		`{"dir":"` + dir + `","command":"sleep 30","port":` + strconv.Itoa(freePort(t)) + `}`,
		`{"dir":"` + dir + `","command":"sleep 31","port":` + strconv.Itoa(freePort(t)) + `}`,
	} {
		if code, out := call(t, h, "POST", "/api/projects/obj_p1/prototypes", body); code != 201 {
			t.Fatalf("加原型：%d %v", code, out)
		}
	}
	for _, x := range [][2]string{{"obj_p2", "cv_g"}, {"obj_p2", "cv_d"}, {"obj_p1", "cv_g"}} {
		if code, out := call(t, h, "POST", "/api/projects/"+x[0]+"/conversations", `{"conversation_id":"`+x[1]+`"}`); code != 201 {
			t.Fatalf("绑会话：%d %v", code, out)
		}
	}

	byID := func() map[string]map[string]any {
		code, out := call(t, h, "GET", "/api/projects/summary", "")
		if code != 200 {
			t.Fatalf("汇总：%d %v", code, out)
		}
		m := map[string]map[string]any{}
		for _, x := range out["data"].([]any) {
			s := x.(map[string]any)
			m[s["project_id"].(string)] = s
		}
		return m
	}
	m := byID()
	if len(m) != 2 || m["obj_p3"] != nil {
		t.Fatalf("只列有原型或绑了会话的项目：%v", m)
	}
	if pt := m["obj_p1"]["prototypes"].(map[string]any); pt["total"] != 2.0 || pt["running"] != 0.0 {
		t.Fatalf("项目一的原型：%v", pt)
	}
	cs := m["obj_p2"]["conversations"].([]any)
	if len(cs) != 2 || cs[0].(map[string]any)["id"] != "cv_g" || cs[1].(map[string]any)["channel"] != "feishu" || cs[1].(map[string]any)["external_id"] != "oc_9" {
		t.Fatalf("项目二的会话按绑定先后：%v", cs)
	}
	if pt := m["obj_p2"]["prototypes"].(map[string]any); pt["total"] != 0.0 {
		t.Fatalf("项目二没有原型：%v", pt)
	}

	// 真的监听端口的原型算运行中；启动中的不算
	py, err := exec.LookPath("python3")
	if err != nil {
		return
	}
	port := freePort(t)
	_, out := call(t, h, "POST", "/api/projects/obj_p1/prototypes", argvBody(t, "静态站", dir, port, py, "-m", "http.server", strconv.Itoa(port), "--bind", "127.0.0.1"))
	path := "/api/projects/obj_p1/prototypes/" + out["data"].(map[string]any)["id"].(string)
	call(t, h, "POST", path+"/start", "")
	t.Cleanup(func() { call(t, h, "POST", path+"/stop", "") })
	waitProto(t, h, path, func(p map[string]any) bool { return p["status"] == "running" })
	if pt := byID()["obj_p1"]["prototypes"].(map[string]any); pt["total"] != 3.0 || pt["running"] != 1.0 {
		t.Fatalf("运行中计数：%v", pt)
	}
}
