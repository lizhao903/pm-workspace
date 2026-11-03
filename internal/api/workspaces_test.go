package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/workspace"
)

func newWorkspaceServer(t *testing.T) (*Server, *audit.Log) {
	t.Helper()
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	return New(audit.WrapStore(st, al), Options{Version: "test", Logger: log, Audit: al, Workspaces: workspace.New(st.DB())}), al
}

func decodeWorkspace(t *testing.T, body []byte) workspace.Workspace {
	t.Helper()
	var env struct {
		Data workspace.Workspace `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return env.Data
}

func listWorkspaces(t *testing.T, s *Server) []workspace.Workspace {
	t.Helper()
	w := do(s, "GET", "/api/workspaces", "")
	mustCode(t, w, http.StatusOK, "list")
	var env struct {
		Data []workspace.Workspace `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	return env.Data
}

// 预设和原型 web-next/src/workspacedata.ts 的 TEMPLATES 对齐。
func TestWorkspacePresets(t *testing.T) {
	s, _ := newWorkspaceServer(t)

	w := do(s, "GET", "/api/workspaces/templates", "")
	mustCode(t, w, http.StatusOK, "templates")
	var tpl struct {
		Data []workspace.Template `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &tpl); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, x := range tpl.Data {
		ids = append(ids, x.ID)
	}
	if got := strings.Join(ids, ","); got != "ws_pm,ws_dev,ws_ops,ws_video,ws_trader,ws_all,custom" {
		t.Fatalf("templates = %s", got)
	}
	trader := tpl.Data[4]
	if trader.Role != "交易员" || trader.Home != "markets" || trader.Mark == nil || trader.Mark.Icon != "candles" ||
		strings.Join(trader.Plugins, ",") != "markets,monitor,strategy,trading,im,browser,terminal" {
		t.Errorf("交易模板 = %+v", trader)
	}

	list := listWorkspaces(t, s)
	if len(list) != 6 {
		t.Fatalf("预设工作台 %d 个，应为 6（自定义模板不建工作台）", len(list))
	}
	all := list[5]
	if all.ID != "ws_all" || all.Name != "0xBroleez" || all.Mark == nil || all.Mark.Text != "0x" || all.Template != "ws_all" {
		t.Fatalf("ws_all = %+v", all)
	}
	if len(all.Modules) != 15 || len(all.Groups) != 6 || all.Groups[0].ID != "g1" || all.Groups[3].Name != "交易" {
		t.Errorf("ws_all 分组 = %+v", all.Groups)
	}
	if all.Groups[0].Modules == nil || all.Groups[0].Collapsed {
		t.Errorf("分组 = %+v", all.Groups[0])
	}
	if len(all.Plugins) != 10 {
		t.Errorf("ws_all plugins = %v", all.Plugins)
	}
}

func TestWorkspacesCRUD(t *testing.T) {
	s, al := newWorkspaceServer(t)

	// 从模板建：没给的字段取模板，名字可改
	w := do(s, "POST", "/api/workspaces", `{"template":"ws_trader","name":" 交易工作台 2 "}`)
	mustCode(t, w, http.StatusCreated, "create from template")
	ws := decodeWorkspace(t, w.Body.Bytes())
	if !strings.HasPrefix(ws.ID, "ws_") || ws.ID == "ws_trader" || ws.Name != "交易工作台 2" || ws.Home != "markets" ||
		ws.Template != "ws_trader" || ws.Position != 7 || len(ws.Groups) != 5 || ws.Groups[4].ID != "g5" {
		t.Fatalf("create = %+v", ws)
	}

	// 空白新建：只有今日
	w = do(s, "POST", "/api/workspaces", `{"name":"空白"}`)
	mustCode(t, w, http.StatusCreated, "create blank")
	blank := decodeWorkspace(t, w.Body.Bytes())
	if strings.Join(blank.Modules, ",") != "today" || blank.Home != "today" || blank.Mark != nil || len(blank.Plugins) != 0 {
		t.Fatalf("blank = %+v", blank)
	}

	// 改分组：默认模块被关掉时换成第一个；mark 传 null 清掉
	w = do(s, "PATCH", "/api/workspaces/"+ws.ID, `{"groups":[{"id":"g9","name":"工具","modules":["tasks","terminal"]},{"name":"","modules":["today"]}],"mark":null,"plugins":["terminal","terminal"]}`)
	mustCode(t, w, http.StatusOK, "update")
	up := decodeWorkspace(t, w.Body.Bytes())
	if up.Home != "tasks" || up.Mark != nil || up.Groups[1].ID != "g1" || strings.Join(up.Plugins, ",") != "terminal" ||
		strings.Join(up.Modules, ",") != "tasks,terminal,today" {
		t.Fatalf("update = %+v", up)
	}
	w = do(s, "GET", "/api/workspaces/"+ws.ID, "")
	mustCode(t, w, http.StatusOK, "get")
	if got := decodeWorkspace(t, w.Body.Bytes()); got.Home != "tasks" || got.Mark != nil {
		t.Fatalf("get = %+v", got)
	}

	// 校验
	for name, c := range map[string]struct{ method, path, body string }{
		"模板不存在":    {"POST", "/api/workspaces", `{"template":"nope"}`},
		"缺名字":      {"POST", "/api/workspaces", `{"name":"  "}`},
		"模块重复":     {"POST", "/api/workspaces", `{"name":"x","groups":[{"modules":["today"]},{"modules":["today"]}]}`},
		"没有模块":     {"POST", "/api/workspaces", `{"name":"x","groups":[{"modules":[]}]}`},
		"默认模块不在里面": {"PATCH", "/api/workspaces/" + ws.ID, `{"home":"markets"}`},
		"插件 id 不对": {"PATCH", "/api/workspaces/" + ws.ID, `{"plugins":["Bad-Id"]}`},
		"颜色不对":     {"PATCH", "/api/workspaces/" + ws.ID, `{"mark":{"text":"x","color":"red"}}`},
	} {
		w := do(s, c.method, c.path, c.body)
		mustCode(t, w, http.StatusBadRequest, name)
	}
	mustCode(t, do(s, "GET", "/api/workspaces/ws_nope", ""), http.StatusNotFound, "get missing")

	// 删：预设也能删，模板还在；最后一个不让删
	mustCode(t, do(s, "DELETE", "/api/workspaces/ws_pm", ""), http.StatusOK, "delete preset")
	mustCode(t, do(s, "DELETE", "/api/workspaces/ws_pm", ""), http.StatusNotFound, "delete again")
	for _, x := range listWorkspaces(t, s) {
		if x.ID == "ws_pm" {
			t.Fatal("ws_pm 删了还在")
		}
	}
	list := listWorkspaces(t, s)
	for _, x := range list[:len(list)-1] {
		mustCode(t, do(s, "DELETE", "/api/workspaces/"+x.ID, ""), http.StatusOK, "delete "+x.ID)
	}
	mustCode(t, do(s, "DELETE", "/api/workspaces/"+list[len(list)-1].ID, ""), http.StatusConflict, "delete last")
	mustCode(t, do(s, "POST", "/api/workspaces", `{"template":"ws_pm"}`), http.StatusCreated, "rebuild from template")

	// 审计：配置类，记字段名
	entries, _, err := al.List(context.Background(), audit.Filter{TargetType: "workspace", Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	actions := map[string]int{}
	for _, e := range entries {
		if e.Kind != audit.KindConfig {
			t.Errorf("kind = %s", e.Kind)
		}
		actions[e.Action]++
		if e.Action == "update" {
			if f, _ := json.Marshal(e.Detail["fields"]); string(f) != `["groups","mark","plugins"]` {
				t.Errorf("fields = %s", f)
			}
		}
	}
	if actions["create"] != 3 || actions["update"] != 1 || actions["delete"] != 7 {
		t.Errorf("审计 = %v", actions)
	}
}

func TestWorkspacesNotConfigured(t *testing.T) {
	s := New(nil, Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	w := do(s, "GET", "/api/workspaces", "")
	mustCode(t, w, http.StatusInternalServerError, "not configured")
	if !strings.Contains(w.Body.String(), "workspaces are not configured") {
		t.Errorf("body = %s", w.Body.String())
	}
}
