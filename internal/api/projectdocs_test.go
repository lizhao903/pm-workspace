// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
)

// TSK-0718：项目设置里的文档目录。相对项目目录或绝对路径；列出认得的文件；
// 目录里的文件不用挂载就能读，隐藏段、密钥类文件照旧拦；没设、相对路径没项目目录、越界、不存在都有明确的错。
func TestProjectDocsDir(t *testing.T) {
	s, _ := newLocalDirServer(t)
	root := tmpDirUnderTmp(t)
	docs := filepath.Join(root, "docs")
	for _, p := range []string{filepath.Join(docs, "prd"), filepath.Join(docs, ".private")} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range map[string]string{
		"docs/a.md": "# 方案", "docs/prd/b.pdf": "%PDF-1.4", "docs/c.docx": "x", "docs/run.sh": "echo", "docs/.private/x.md": "no",
		"docs/k.pem": "secret", "outside.md": "out",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	create := func(body string) string {
		w := do(s, "POST", "/api/objects", body)
		mustCode(t, w, http.StatusCreated, "create")
		var env struct {
			Data struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &env)
		return env.Data.ID
	}
	files := func(id string) (int, fsbrowse.FileList, string) {
		w := do(s, "GET", "/api/objects/"+id+"/docs-dir/files", "")
		var env struct {
			Data fsbrowse.FileList `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &env)
		return w.Code, env.Data, w.Body.String()
	}

	// 相对项目目录
	rel := create(`{"type_id":"project","title":"相对","workdir":` + jsonStr(root) + `,"props":{"docs_dir":" docs "}}`)
	code, list, body := files(rel)
	var got []string
	for _, f := range list.Files {
		got = append(got, f.Rel+":"+f.Kind)
	}
	// k.pem 不认得计入 skipped；.private 是隐藏目录不走
	if code != http.StatusOK || list.Path != docs || strings.Join(got, ",") != "a.md:text,c.docx:office,prd/b.pdf:pdf" {
		t.Fatalf("相对路径列文件 = %d %s", code, body)
	}
	// 不挂载也能读、能原样取；隐藏段、密钥类文件、目录外的照旧拦
	mustCode(t, do(s, "GET", "/api/fs/read?path="+filepath.Join(docs, "a.md"), ""), http.StatusOK, "read in docs dir")
	mustCode(t, do(s, "GET", "/api/fs/raw?path="+filepath.Join(docs, "prd", "b.pdf"), ""), http.StatusOK, "raw in docs dir")
	mustCode(t, do(s, "GET", "/api/fs/read?path="+filepath.Join(docs, ".private", "x.md"), ""), http.StatusForbidden, "hidden in docs dir")
	mustCode(t, do(s, "GET", "/api/fs/read?path="+filepath.Join(docs, "k.pem"), ""), http.StatusForbidden, "secret in docs dir")
	mustCode(t, do(s, "GET", "/api/fs/read?path="+filepath.Join(root, "outside.md"), ""), http.StatusForbidden, "outside docs dir")

	// 绝对路径、file:// 前缀
	abs := create(`{"type_id":"project","title":"绝对","props":{"docs_dir":` + jsonStr("file://"+filepath.Join(docs, "prd")) + `}}`)
	if code, list, body := files(abs); code != http.StatusOK || len(list.Files) != 1 || list.Files[0].Rel != "b.pdf" {
		t.Fatalf("绝对路径 = %d %s", code, body)
	}

	// 没设、相对路径但没项目目录 400；不存在 404；越界、隐藏目录 403；不是项目 400；软删的项目不再给读
	for _, c := range []struct {
		name, body string
		code       int
	}{
		{"没设", `{"type_id":"project","title":"空"}`, http.StatusBadRequest},
		{"相对没根", `{"type_id":"project","title":"无根","props":{"docs_dir":"docs"}}`, http.StatusBadRequest},
		{"不存在", `{"type_id":"project","title":"无","props":{"docs_dir":` + jsonStr(filepath.Join(root, "nope")) + `}}`, http.StatusNotFound},
		{"越界", `{"type_id":"project","title":"越界","props":{"docs_dir":"/etc"}}`, http.StatusForbidden},
		{"相对越界", `{"type_id":"project","title":"穿越","workdir":` + jsonStr(root) + `,"props":{"docs_dir":"../../../../../../etc"}}`, http.StatusForbidden},
		{"隐藏", `{"type_id":"project","title":"隐藏","props":{"docs_dir":` + jsonStr(filepath.Join(docs, ".private")) + `}}`, http.StatusForbidden},
		{"是文件", `{"type_id":"project","title":"文件","props":{"docs_dir":` + jsonStr(filepath.Join(docs, "a.md")) + `}}`, http.StatusBadRequest},
	} {
		if code, _, body := files(create(c.body)); code != c.code {
			t.Errorf("%s = %d %s, want %d", c.name, code, body, c.code)
		}
	}
	mustCode(t, do(s, "GET", "/api/objects/obj_none/docs-dir/files", ""), http.StatusNotFound, "unknown object")
	mustCode(t, do(s, "DELETE", "/api/objects/"+rel, ""), http.StatusOK, "soft delete")
	mustCode(t, do(s, "DELETE", "/api/objects/"+abs, ""), http.StatusOK, "soft delete abs")
	if code, _, _ := files(rel); code != http.StatusNotFound {
		t.Errorf("软删项目列文件 = %d, want 404", code)
	}
	mustCode(t, do(s, "GET", "/api/fs/read?path="+filepath.Join(docs, "a.md"), ""), http.StatusForbidden, "read after project deleted")
}

// 提示词「文档在哪里操作」优先用项目设置里的文档目录（相对路径接在项目目录后面），没设时才取第一个关联目录。
func TestRunPromptUsesProjectDocsDir(t *testing.T) {
	s, f, task, _ := terminalFixture(t)
	prj, err := f.GetObject(t.Context(), *task.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	prj.Props["docs_dir"] = "docs/prd"
	p := decodeEnvelope(t, do(s, "GET", "/api/objects/"+task.ID+"/run/prompt", ""))["data"].(map[string]any)["prompt"].(string)
	want := "文档在哪里操作：" + filepath.Join(prj.Workdir, "docs/prd") + "（项目设置里的文档目录）"
	if !strings.Contains(p, want) || strings.Contains(p, "acme-project概况") {
		t.Fatalf("提示词应用项目设置里的文档目录 %q:\n%s", want, p)
	}
}
