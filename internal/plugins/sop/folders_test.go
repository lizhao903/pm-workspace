package sop

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 流程库的文件夹（TSK-0482）

const folderSteps = `"steps":[{"key":"a","name":"甲","kind":"auto","after":[]}]`

func dataOf(out map[string]any) map[string]any { d, _ := out["data"].(map[string]any); return d }

// 建、改名、删；名字去空白、不分大小写唯一、不能用「全部」「未分类」；列表带流程数，meta 带未分类数
func TestFolderCRUD(t *testing.T) {
	_, h := setup(t, New())
	code, out := call(t, h, "POST", "/api/sop/folders", `{"name":"  产品经理 "}`)
	if code != 201 || dataOf(out)["name"] != "产品经理" || !strings.HasPrefix(dataOf(out)["id"].(string), "sfd_") || dataOf(out)["count"] != 0.0 {
		t.Fatalf("新建 %d %v", code, out)
	}
	pm := dataOf(out)["id"].(string)
	for body, want := range map[string]string{
		`{"name":"产品经理"}`:                            "已经有叫「产品经理」的文件夹了",
		`{"name":"未分类"}`:                             "「未分类」是界面上已经占用的叫法，换个名字",
		`{"name":"全部"}`:                              "「全部」是界面上已经占用的叫法，换个名字",
		`{"name":"   "}`:                             "文件夹名称不能为空",
		`{"name":"` + strings.Repeat("长", 31) + `"}`: "文件夹名称最多 30 字",
		`{}`: "name 是必填的",
	} {
		if code, out := call(t, h, "POST", "/api/sop/folders", body); code < 400 || errMsg(out) != want {
			t.Fatalf("%s：%d %q，要 %q", body, code, errMsg(out), want)
		}
	}
	_, out = call(t, h, "POST", "/api/sop/folders", `{"name":"Video"}`)
	video := dataOf(out)["id"].(string)
	if code, out := call(t, h, "POST", "/api/sop/folders", `{"name":"video"}`); code != 409 {
		t.Fatalf("不分大小写重名应当 409：%d %v", code, out)
	}
	// 改名：撞别人 409，改成自己的另一种大小写可以
	if code, _ := call(t, h, "PATCH", "/api/sop/folders/"+video, `{"name":"产品经理"}`); code != 409 {
		t.Fatalf("改名撞名 %d", code)
	}
	if code, out := call(t, h, "PATCH", "/api/sop/folders/"+video, `{"name":"视频"}`); code != 200 || dataOf(out)["name"] != "视频" {
		t.Fatalf("改名 %d %v", code, out)
	}
	if code, _ := call(t, h, "PATCH", "/api/sop/folders/sfd_nope", `{"name":"x"}`); code != 404 {
		t.Fatalf("改不存在的 %d", code)
	}

	newFlow(t, h, `{"name":"写周报","folder_id":"`+pm+`",`+folderSteps+`}`)
	newFlow(t, h, `{"name":"没分类",`+folderSteps+`}`)
	code, out = call(t, h, "GET", "/api/sop/folders", "")
	list := out["data"].([]any)
	meta := out["meta"].(map[string]any)
	if code != 200 || len(list) != 2 || list[0].(map[string]any)["name"] != "产品经理" || list[0].(map[string]any)["count"] != 1.0 ||
		list[1].(map[string]any)["count"] != 0.0 || meta["total"] != 2.0 || meta["uncategorized"] != 1.0 {
		t.Fatalf("列表 %d %v", code, out)
	}
}

// 流程读写带 folder_id：新建时给、不存在 400；PATCH 不给不动，给 null 回未分类；改了算一版
func TestFlowFolderField(t *testing.T) {
	_, h := setup(t, New())
	_, out := call(t, h, "POST", "/api/sop/folders", `{"name":"开发者"}`)
	fid := dataOf(out)["id"].(string)
	if code, out := call(t, h, "POST", "/api/sop/flows", `{"name":"x","folder_id":"sfd_nope",`+folderSteps+`}`); code != 400 || errMsg(out) != "文件夹 sfd_nope 不存在" {
		t.Fatalf("不存在的文件夹 %d %q", code, errMsg(out))
	}
	if code, out := call(t, h, "POST", "/api/sop/flows", `{"name":"x","folder_id":3,`+folderSteps+`}`); code != 400 || errMsg(out) != "folder_id 必须是字符串或 null" {
		t.Fatalf("folder_id 类型 %d %q", code, errMsg(out))
	}
	id := newFlow(t, h, `{"name":"缺陷转任务","folder_id":"`+fid+`",`+folderSteps+`}`)
	_, out = call(t, h, "GET", "/api/sop/flows/"+id, "")
	if dataOf(out)["folder_id"] != fid {
		t.Fatalf("读回 folder_id = %v", dataOf(out)["folder_id"])
	}
	_, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"desc":"改说明"}`)
	if dataOf(out)["folder_id"] != fid || dataOf(out)["version"] != 2.0 {
		t.Fatalf("不给 folder_id 应当不动：%v", dataOf(out))
	}
	_, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"folder_id":null}`)
	if v, ok := dataOf(out)["folder_id"]; !ok || v != nil || dataOf(out)["version"] != 3.0 {
		t.Fatalf("给 null 回未分类：%v", dataOf(out))
	}
	// 列表里未分类的也带这个键，值为 null
	_, out = call(t, h, "GET", "/api/sop/flows", "")
	if v, ok := out["data"].([]any)[0].(map[string]any)["folder_id"]; !ok || v != nil {
		t.Fatalf("列表 folder_id = %v %v", v, ok)
	}
}

// 移动：批量、不升版本、不改 updated_at；文件夹不存在 404，流程不存在 400；删文件夹时流程回未分类
func TestMoveAndDeleteFolder(t *testing.T) {
	_, h := setup(t, New())
	_, out := call(t, h, "POST", "/api/sop/folders", `{"name":"商务对接"}`)
	fid := dataOf(out)["id"].(string)
	a := newFlow(t, h, `{"name":"询价",`+folderSteps+`}`)
	b := newFlow(t, h, `{"name":"合同",`+folderSteps+`}`)
	_, out = call(t, h, "GET", "/api/sop/flows/"+a, "")
	before := dataOf(out)["updated_at"]
	time.Sleep(1100 * time.Millisecond) // updated_at 精确到秒，隔开一秒才看得出改没改

	for body, want := range map[string]struct {
		code int
		msg  string
	}{
		`{"flow_ids":[],"folder_id":null}`:                       {400, "flow_ids 要是 1 到 200 个流程 id"},
		`{"flow_ids":["` + a + `"]}`:                             {400, "folder_id 是必填的：文件夹 id，移回未分类写 null"},
		`{"flow_ids":["` + a + `"],"folder_id":"sfd_nope"}`:      {404, "文件夹 sfd_nope 不存在"},
		`{"flow_ids":["` + a + `","sop_nope"],"folder_id":null}`: {400, "流程 sop_nope 不存在"},
	} {
		if code, out := call(t, h, "POST", "/api/sop/flows/move", body); code != want.code || errMsg(out) != want.msg {
			t.Fatalf("%s：%d %q", body, code, errMsg(out))
		}
	}
	code, out := call(t, h, "POST", "/api/sop/flows/move", `{"flow_ids":["`+a+`","`+b+`","`+a+`"],"folder_id":"`+fid+`"}`)
	if code != 200 || dataOf(out)["moved"] != 2.0 {
		t.Fatalf("移动 %d %v", code, out)
	}
	_, out = call(t, h, "GET", "/api/sop/flows/"+a, "")
	if f := dataOf(out); f["folder_id"] != fid || f["version"] != 1.0 || f["updated_at"] != before {
		t.Fatalf("移动后 %v（之前 updated_at %v）", f, before)
	}

	code, out = call(t, h, "DELETE", "/api/sop/folders/"+fid, "")
	if code != 200 || dataOf(out)["moved"] != 2.0 {
		t.Fatalf("删文件夹 %d %v", code, out)
	}
	for _, id := range []string{a, b} {
		_, out = call(t, h, "GET", "/api/sop/flows/"+id, "")
		if f := dataOf(out); f["folder_id"] != nil || f["name"] == nil || f["version"] != 1.0 {
			t.Fatalf("删文件夹后流程 %v", f)
		}
	}
	if code, _ := call(t, h, "DELETE", "/api/sop/folders/"+fid, ""); code != 404 {
		t.Fatalf("再删 %d", code)
	}
}

// waitSeeded 等启用时那一次 folder_seed 跑完（后台任务，和测试并发）
func waitSeeded(t *testing.T, c plugin.Core) {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < 200; i++ {
		var v string
		if c.Store().QueryRow(ctx, `SELECT value FROM sop_settings WHERE key = ?`, folderSeedKey).Scan(&v) == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("folder_seed 没跑")
}

func TestFolderPrefix(t *testing.T) {
	for name, want := range map[string]string{
		"产品经理 · 写周报":                     "产品经理",
		"产品经理 · 写周报 · 二":                 "产品经理",
		"  视频博主  ·  选题":                  "视频博主", // 分隔是「空格 · 空格」，多出来的空格在两边去掉
		"视频博主 ·  选题":                     "视频博主",
		"消息分诊：要不要我处理":                    "",
		"A·B":                            "",
		" · 没有前缀":                        "",
		"只有前缀 · ":                        "",
		"未分类 · 什么":                       "",
		strings.Repeat("长", 31) + " · x": "",
	} {
		if got := folderPrefix(name); got != want {
			t.Errorf("folderPrefix(%q) = %q，要 %q", name, got, want)
		}
	}
}

// 按前缀自动归类：只归未分类的、不改名不升版本；同前缀（不分大小写）一个文件夹；已有同名文件夹直接用；只做一次
func TestSeedFolders(t *testing.T) {
	ctx := context.Background()
	p := New()
	_, h := setup(t, p)
	c := p.core
	waitSeeded(t, c)

	_, out := call(t, h, "POST", "/api/sop/folders", `{"name":"商务对接"}`)
	biz := dataOf(out)["id"].(string)
	_, out = call(t, h, "POST", "/api/sop/folders", `{"name":"我自己的"}`)
	mine := dataOf(out)["id"].(string)
	ids := map[string]string{}
	for _, n := range []string{"产品经理 · 写周报", "视频博主 · 选题评估", "产品经理 · 需求评审", "商务对接 · 商单询价", "PM · a", "pm · b", "消息分诊", "未分类 · 不算"} {
		ids[n] = newFlow(t, h, `{"name":"`+n+`",`+folderSteps+`}`)
	}
	// 用户已经放好的不动
	moved := newFlow(t, h, `{"name":"产品经理 · 已归类","folder_id":"`+mine+`",`+folderSteps+`}`)
	if _, err := c.Store().Exec(ctx, `DELETE FROM sop_settings WHERE key = ?`, folderSeedKey); err != nil {
		t.Fatal(err)
	}

	res, err := seedFolders(ctx, c)
	if err != nil || !res.Done {
		t.Fatalf("seed %+v %v", res, err)
	}
	if strings.Join(res.Folders, ",") != "产品经理,视频博主,商务对接,PM" || res.Moved["产品经理"] != 2 || res.Moved["PM"] != 2 || res.Moved["商务对接"] != 1 {
		t.Fatalf("结果 %+v", res)
	}
	folderOf := func(id string) (string, map[string]any) {
		_, out := call(t, h, "GET", "/api/sop/flows/"+id, "")
		f := dataOf(out)
		s, _ := f["folder_id"].(string)
		return s, f
	}
	_, out = call(t, h, "GET", "/api/sop/folders", "")
	byName := map[string]string{}
	for _, x := range out["data"].([]any) {
		byName[x.(map[string]any)["name"].(string)] = x.(map[string]any)["id"].(string)
	}
	if len(byName) != 5 || byName["商务对接"] != biz {
		t.Fatalf("文件夹 %v", byName)
	}
	for name, want := range map[string]string{
		"产品经理 · 写周报": byName["产品经理"], "产品经理 · 需求评审": byName["产品经理"], "视频博主 · 选题评估": byName["视频博主"],
		"商务对接 · 商单询价": biz, "PM · a": byName["PM"], "pm · b": byName["PM"], "消息分诊": "", "未分类 · 不算": "",
	} {
		got, f := folderOf(ids[name])
		if got != want || f["name"] != name || f["version"] != 1.0 {
			t.Fatalf("%s：folder=%q 要 %q（%v）", name, got, want, f)
		}
	}
	if got, _ := folderOf(moved); got != mine {
		t.Fatalf("用户放好的被改了：%s", got)
	}

	// 只做一次：再跑什么都不做，用户之后建的同前缀流程不自动归类
	late := newFlow(t, h, `{"name":"产品经理 · 后来的",`+folderSteps+`}`)
	if res, err := seedFolders(ctx, c); err != nil || res.Done {
		t.Fatalf("第二次 %+v %v", res, err)
	}
	if got, _ := folderOf(late); got != "" {
		t.Fatalf("第二次不该归类：%s", got)
	}
	var note string
	_ = c.Store().QueryRow(ctx, `SELECT value FROM sop_settings WHERE key = ?`, folderSeedKey).Scan(&note)
	var m map[string]any
	if json.Unmarshal([]byte(note), &m) != nil || m["at"] == nil {
		t.Fatalf("标记 %q", note)
	}
}

// 内置流程：用户放进文件夹的，插件撤下时不删（重装不会回到未分类）；重装时已有同 id 的不动
func TestInstalledFlowKeepsFolder(t *testing.T) {
	ctx := context.Background()
	p := New()
	_, h := setup(t, p)
	e := &engine{c: p.core}
	tpl := plugin.SOPFlowTemplate{ID: "sop_im_probe", Name: "探针", Steps: json.RawMessage(`[{"key":"a","name":"甲","kind":"auto"}]`)}
	if ok, err := e.InstallFlow(ctx, "im", tpl); !ok || err != nil {
		t.Fatalf("装 %v %v", ok, err)
	}
	_, out := call(t, h, "POST", "/api/sop/folders", `{"name":"IM"}`)
	fid := dataOf(out)["id"].(string)
	if code, _ := call(t, h, "POST", "/api/sop/flows/move", `{"flow_ids":["sop_im_probe"],"folder_id":"`+fid+`"}`); code != 200 {
		t.Fatal(code)
	}
	removed, why, err := e.RemoveFlow(ctx, "im", "sop_im_probe")
	if err != nil || removed || why != "流程放进了文件夹，留给用户" {
		t.Fatalf("撤下 %v %q %v", removed, why, err)
	}
	if ok, err := e.InstallFlow(ctx, "im", tpl); ok || err != nil {
		t.Fatalf("重装应当不动 %v %v", ok, err)
	}
	_, out = call(t, h, "GET", "/api/sop/flows/sop_im_probe", "")
	if dataOf(out)["folder_id"] != fid {
		t.Fatalf("重装后文件夹 %v", dataOf(out)["folder_id"])
	}
	// 放回未分类、还是第 1 版的照旧能撤下
	call(t, h, "POST", "/api/sop/flows/move", `{"flow_ids":["sop_im_probe"],"folder_id":null}`)
	if removed, why, err := e.RemoveFlow(ctx, "im", "sop_im_probe"); !removed || err != nil {
		t.Fatalf("未分类的撤下 %v %q %v", removed, why, err)
	}
}

// Agent 的流程目录：列文件夹、按名字放进文件夹（没有就建）、流程没存上时不留下新建的空文件夹
func TestCatalogFolders(t *testing.T) {
	ctx := context.Background()
	reg, h := setup(t, New())
	_, out := call(t, h, "POST", "/api/sop/folders", `{"name":"产品经理"}`)
	pm := dataOf(out)["id"].(string)
	newFlow(t, h, `{"name":"写周报","folder_id":"`+pm+`",`+folderSteps+`}`)
	raw := func(m map[string]any) map[string]json.RawMessage {
		o := map[string]json.RawMessage{}
		for k, v := range m {
			b, _ := json.Marshal(v)
			o[k] = b
		}
		return o
	}
	steps := []any{map[string]any{"key": "a", "name": "甲", "kind": "auto"}}
	doc, err := reg.SaveSOP(ctx, plugin.SOPSave{Body: raw(map[string]any{"name": "选题", "steps": steps, "folder": "视频博主"})})
	if err != nil || doc.Folder != "视频博主" || !doc.FolderCreated {
		t.Fatalf("新建并建文件夹 %+v %v", doc, err)
	}
	doc, err = reg.SaveSOP(ctx, plugin.SOPSave{ID: doc.ID, Body: raw(map[string]any{"folder": "产品经理", "version": 1})})
	if err != nil || doc.Folder != "产品经理" || doc.FolderCreated || doc.Version != 2 {
		t.Fatalf("移到已有的 %+v %v", doc, err)
	}
	doc, err = reg.SaveSOP(ctx, plugin.SOPSave{ID: doc.ID, Body: raw(map[string]any{"folder": "未分类"})})
	if err != nil || doc.Folder != "" {
		t.Fatalf("放回未分类 %+v %v", doc, err)
	}
	// 流程没存上（没有步骤）：为它新建的文件夹删掉
	if _, err := reg.SaveSOP(ctx, plugin.SOPSave{Body: raw(map[string]any{"name": "坏的", "steps": []any{}, "folder": "临时"})}); err == nil {
		t.Fatal("没有步骤应当存不上")
	}
	if _, err := reg.SaveSOP(ctx, plugin.SOPSave{Body: raw(map[string]any{"name": "坏名", "steps": steps, "folder": "未分类 "})}); err != nil {
		t.Fatalf("「未分类 」去空白后是未分类：%v", err)
	}
	fs, err := reg.ListSOPFolders(ctx)
	if err != nil || len(fs.Folders) != 2 || fs.Folders[0].Name != "产品经理" || fs.Folders[0].Count != 1 || fs.Folders[1].Name != "视频博主" ||
		fs.Folders[1].Count != 0 || fs.Uncategorized != 2 {
		t.Fatalf("文件夹 %+v %v", fs, err)
	}
	list, err := reg.ListSOPs(ctx)
	if err != nil || list[0].Name != "写周报" || list[0].Folder != "产品经理" || list[1].Folder != "" {
		t.Fatalf("列表 %+v %v", list, err)
	}
}
