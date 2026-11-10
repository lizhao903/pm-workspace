// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/localdir"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

func newKbServer(t *testing.T) (*Server, *sqlite.Store, string) {
	t.Helper()
	dataDir := t.TempDir()
	st, err := sqlite.Open(context.Background(), filepath.Join(dataDir, "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	return New(audit.WrapStore(st, al), Options{Version: "test", Logger: log, Audit: al,
		LocalDirs: localdir.New(st.DB()), DataDir: dataDir}), st, dataDir
}

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

type kbResp struct {
	ID       string         `json:"id"`
	Sources  []string       `json:"sources"`
	Counts   store.KbCounts `json:"counts"`
	Agents   []skillAgent   `json:"agents"`
	Settings struct {
		ChunkSize int         `json:"chunk_size"`
		Overlap   int         `json:"overlap"`
		Dirs      []kbDirView `json:"dirs"`
	} `json:"settings"`
}

func decodeData[T any](t *testing.T, body []byte) T {
	t.Helper()
	var env struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return env.Data
}

func kbDocs(t *testing.T, s *Server, id string) []store.KbDoc {
	t.Helper()
	w := do(s, "GET", "/api/knowledge-bases/"+id+"/docs", "")
	mustCode(t, w, http.StatusOK, "list docs")
	return decodeData[[]store.KbDoc](t, w.Body.Bytes())
}

func docByTitle(docs []store.KbDoc, title string) *store.KbDoc {
	for i := range docs {
		if docs[i].Title == title {
			return &docs[i]
		}
	}
	return nil
}

var longText = strings.Repeat("权限点改完写入变更队列，网关缓存按租户失效。\n", 30)

// 验收：工作台文档、本地目录、手写笔记加进来后状态为 indexed，段数和 KbSettings 一致；
// 目录里的密钥证书、库文件、隐藏文件不收（沿用 DOC-01a 的拦截）。
func TestKbSourcesIndexedAndDirGuard(t *testing.T) {
	s, st, dataDir := newKbServer(t)
	ctx := context.Background()
	cat := "cat_doc_prd"
	obj, err := st.CreateObject(ctx, &domain.Object{TypeID: "doc", Title: "权限模型 PRD", Body: longText, CategoryID: &cat}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	dir := tmpDirUnderTmp(t)
	writeFiles(t, dir, map[string]string{
		"a.md":               longText,
		"sub/b.txt":          "导出要校验 object.export 权限点",
		"vault.key":          "secret",
		"cert.pem":           "-----BEGIN CERTIFICATE-----",
		"server.key":         "secret",
		"pm.db":              "sqlite",
		"pm.db-wal":          "wal",
		"id.p12":             "p12",
		".env":               "TOKEN=1",
		".secret/c.md":       "藏起来的",
		"node_modules/d.md":  "依赖",
		"data.json":          `{"a":1}`,
		"keys/deploy.pem.md": "名字像证书但其实是 md",
	})

	w := do(s, "POST", "/api/knowledge-bases", `{"name":"产品文档库","sources":["`+cat+`"],
		"settings":{"chunk_size":200,"overlap":30,"dirs":[{"path":`+jsonStr(dir+"/")+`,"auto_sync":true}]}}`)
	mustCode(t, w, http.StatusCreated, "create "+w.Body.String())
	k := decodeData[kbResp](t, w.Body.Bytes())
	if !strings.HasPrefix(k.ID, "kb_") || k.Settings.ChunkSize != 200 || len(k.Settings.Dirs) != 1 || k.Settings.Dirs[0].Path != dir {
		t.Fatalf("新建 = %+v", k)
	}

	w = do(s, "POST", "/api/knowledge-bases/"+k.ID+"/docs", `{"type":"note","title":"合规口径备忘","text":`+jsonStr(longText)+`}`)
	mustCode(t, w, http.StatusCreated, "add note "+w.Body.String())

	docs := kbDocs(t, s, k.ID)
	titles := []string{}
	for _, d := range docs {
		titles = append(titles, d.Title)
	}
	slices.Sort(titles)
	if want := []string{"a.md", "b.txt", "deploy.pem.md", "合规口径备忘", "权限模型 PRD"}; !slices.Equal(titles, want) {
		t.Fatalf("收进来的 = %v，期望 %v", titles, want)
	}
	want := len(kb.Split(longText, 200, 30))
	for _, title := range []string{"a.md", "合规口径备忘", "权限模型 PRD"} {
		d := docByTitle(docs, title)
		if d.Status != store.KbIndexed || d.Chunks != want || d.Error != "" {
			t.Errorf("%s = %s %d 段（期望 indexed %d 段）%s", title, d.Status, d.Chunks, want, d.Error)
		}
	}
	if d := docByTitle(docs, "权限模型 PRD"); d.Source.Type != "library" || d.Source.Ref != obj.ID {
		t.Errorf("工作台文档来源 = %+v", d.Source)
	}
	if d := docByTitle(docs, "a.md"); d.Source.Type != "dir" || d.Source.Ref != filepath.Join(dir, "a.md") {
		t.Errorf("目录文件来源 = %+v", d.Source)
	}

	// 改切分设置不自动重新索引；重新索引后段数按新设置
	mustCode(t, do(s, "PATCH", "/api/knowledge-bases/"+k.ID, `{"settings":{"chunk_size":500,"overlap":50}}`), http.StatusOK, "patch chunk")
	if d := docByTitle(kbDocs(t, s, k.ID), "a.md"); d.Chunks != want {
		t.Errorf("改设置后段数不该变：%d", d.Chunks)
	}
	w = do(s, "POST", "/api/knowledge-bases/"+k.ID+"/reindex", "")
	mustCode(t, w, http.StatusOK, "reindex")
	if d := docByTitle(kbDocs(t, s, k.ID), "a.md"); d.Chunks != len(kb.Split(longText, 500, 50)) {
		t.Errorf("重新索引后段数 = %d", d.Chunks)
	}

	w = do(s, "GET", "/api/knowledge-bases/"+k.ID, "")
	mustCode(t, w, http.StatusOK, "get")
	got := decodeData[kbResp](t, w.Body.Bytes())
	if got.Counts.Docs != 5 || got.Counts.Indexed != 5 || got.Settings.Dirs[0].Files != 3 || got.Settings.Dirs[0].SyncedAt == nil {
		t.Errorf("统计 = %+v，目录 = %+v", got.Counts, got.Settings.Dirs)
	}

	// 同步：改了的重新索引，删了的移出，新的收进来
	writeFiles(t, dir, map[string]string{"a.md": "只剩一句。", "new.md": "新加的说明"})
	if err := os.Remove(filepath.Join(dir, "sub", "b.txt")); err != nil {
		t.Fatal(err)
	}
	w = do(s, "POST", "/api/knowledge-bases/"+k.ID+"/sync", `{"path":`+jsonStr(dir)+`}`)
	mustCode(t, w, http.StatusOK, "sync")
	res := decodeData[struct {
		Result kb.SyncResult `json:"result"`
	}](t, w.Body.Bytes()).Result
	if res.Added != 1 || res.Updated != 1 || res.Removed != 1 || res.Unchanged != 1 {
		t.Errorf("同步结果 = %+v", res)
	}
	mustCode(t, do(s, "POST", "/api/knowledge-bases/"+k.ID+"/sync", `{"path":"/tmp/nope"}`), http.StatusNotFound, "sync unknown dir")

	// 卸下目录：收进来的文件一起移出
	mustCode(t, do(s, "PATCH", "/api/knowledge-bases/"+k.ID, `{"settings":{"dirs":[]}}`), http.StatusOK, "remove dir")
	for _, d := range kbDocs(t, s, k.ID) {
		if d.Source.Type == "dir" {
			t.Errorf("卸下目录后还有 %s", d.Title)
		}
	}
	_ = dataDir
}

func TestKbDirBounds(t *testing.T) {
	s, _, dataDir := newKbServer(t)
	w := do(s, "POST", "/api/knowledge-bases", `{"name":"库"}`)
	mustCode(t, w, http.StatusCreated, "create")
	id := decodeData[kbResp](t, w.Body.Bytes()).ID
	dir := tmpDirUnderTmp(t)
	writeFiles(t, dir, map[string]string{".hidden/a.md": "x"})
	for _, c := range []struct {
		path string
		code int
	}{
		{"relative/dir", http.StatusBadRequest},
		{"/etc", http.StatusForbidden},
		{filepath.Join(dir, ".hidden"), http.StatusForbidden},
		{dataDir, http.StatusForbidden},
		{filepath.Join(dir, "none"), http.StatusBadRequest},
	} {
		w := do(s, "PATCH", "/api/knowledge-bases/"+id, `{"settings":{"dirs":[{"path":`+jsonStr(c.path)+`}]}}`)
		mustCode(t, w, c.code, "mount "+c.path+" "+w.Body.String())
	}
	if docs := kbDocs(t, s, id); len(docs) != 0 {
		t.Errorf("挂不上的目录不该收文件：%v", docs)
	}
}

// 上传、网页链接、检索、排除；删除知识库后 Agent 的 kbs 里不再有它，上传的原文件一起删。
func TestKbUploadLinkSearchDelete(t *testing.T) {
	s, st, dataDir := newKbServer(t)
	ctx := context.Background()
	w := do(s, "POST", "/api/knowledge-bases", `{"name":"客户反馈库","settings":{"chunk_size":200,"overlap":30}}`)
	mustCode(t, w, http.StatusCreated, "create")
	id := decodeData[kbResp](t, w.Body.Bytes()).ID

	md := base64.StdEncoding.EncodeToString([]byte("# 财务部审批流诉求\n\n金额大于 5 万元的，部门负责人审批后还要总监审批"))
	w = do(s, "POST", "/api/knowledge-bases/"+id+"/docs", `{"type":"upload","ref":"诉求.md","data":"`+md+`"}`)
	mustCode(t, w, http.StatusCreated, "upload "+w.Body.String())
	up := decodeData[[]store.KbDoc](t, w.Body.Bytes())[0]
	if up.Status != store.KbIndexed || up.Title != "诉求.md" {
		t.Fatalf("上传 = %+v", up)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "kb", id, up.ID, "诉求.md")); err != nil {
		t.Errorf("原文件该存在数据目录 kb/ 下：%v", err)
	}
	w = do(s, "POST", "/api/knowledge-bases/"+id+"/docs", `{"type":"upload","ref":"设计稿.pdf","data":"JVBERi0="}`)
	mustCode(t, w, http.StatusCreated, "upload pdf")
	if d := decodeData[[]store.KbDoc](t, w.Body.Bytes())[0]; d.Status != store.KbFailed || !strings.Contains(d.Error, "PDF") {
		t.Errorf("PDF = %+v", d)
	}
	mustCode(t, do(s, "POST", "/api/knowledge-bases/"+id+"/docs", `{"type":"upload","ref":"a.exe","data":""}`), http.StatusBadRequest, "upload exe")
	mustCode(t, do(s, "POST", "/api/knowledge-bases/"+id+"/docs", `{"type":"link","ref":"ftp://x"}`), http.StatusBadRequest, "bad url")
	w = do(s, "POST", "/api/knowledge-bases/"+id+"/docs", `{"type":"link","ref":"https://wiki.local/q4"}`)
	mustCode(t, w, http.StatusCreated, "link no text")
	if d := decodeData[[]store.KbDoc](t, w.Body.Bytes())[0]; d.Status != store.KbFailed || d.Title != "https://wiki.local/q4" {
		t.Errorf("没贴正文的链接 = %+v", d)
	}
	mustCode(t, do(s, "POST", "/api/knowledge-bases/"+id+"/docs", `{"type":"note","title":"只有标题"}`), http.StatusBadRequest, "note no text")
	mustCode(t, do(s, "POST", "/api/knowledge-bases/"+id+"/docs", `{"type":"dir","ref":"/tmp/a.md"}`), http.StatusBadRequest, "add dir doc")

	w = do(s, "POST", "/api/knowledge-bases/"+id+"/search", `{"q":"远川财务部审批流怎么走"}`)
	mustCode(t, w, http.StatusOK, "search")
	sr := decodeData[struct {
		Terms []string       `json:"terms"`
		Hits  []kb.SearchHit `json:"hits"`
		Scope map[string]int `json:"scope"`
	}](t, w.Body.Bytes())
	if len(sr.Hits) != 1 || sr.Hits[0].DocID != up.ID || !slices.Contains(sr.Hits[0].Terms, "审批") || sr.Scope["searchable"] != 1 || sr.Scope["skipped"] != 2 {
		t.Fatalf("检索 = %+v", sr)
	}
	mustCode(t, do(s, "POST", "/api/knowledge-bases/"+id+"/search", `{"q":" "}`), http.StatusBadRequest, "empty q")

	mustCode(t, do(s, "PATCH", "/api/knowledge-bases/"+id+"/docs/"+up.ID, `{"excluded":true}`), http.StatusOK, "exclude")
	w = do(s, "POST", "/api/knowledge-bases/"+id+"/search", `{"q":"审批流"}`)
	if got := decodeData[struct {
		Hits []kb.SearchHit `json:"hits"`
	}](t, w.Body.Bytes()); len(got.Hits) != 0 {
		t.Errorf("排除后还命中：%+v", got.Hits)
	}
	mustCode(t, do(s, "PATCH", "/api/knowledge-bases/"+id+"/docs/"+up.ID, `{"text":"改上传的"}`), http.StatusBadRequest, "edit upload text")

	p, err := st.CreateProvider(ctx, &domain.AgentProvider{Name: "本机", Kind: domain.ProviderOllama, Model: "m", Enabled: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	kbs := []string{"kb_keep", id}
	name := "助手"
	a, err := st.CreateAgent(ctx, domain.AgentInput{Name: &name, ProviderID: &p.ID, KBs: &kbs})
	if err != nil {
		t.Fatal(err)
	}
	w = do(s, "DELETE", "/api/knowledge-bases/"+id, "")
	mustCode(t, w, http.StatusOK, "delete")
	if del := decodeData[kbResp](t, w.Body.Bytes()); len(del.Agents) != 1 || del.Agents[0].ID != a.ID || del.Agents[0].Name != "助手" {
		t.Errorf("删除回的 agents = %+v", del.Agents)
	}
	if got, _ := st.GetAgent(ctx, a.ID); !slices.Equal(got.KBs, []string{"kb_keep"}) {
		t.Errorf("删除后 Agent 的 kbs = %v", got.KBs)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "kb", id)); !os.IsNotExist(err) {
		t.Errorf("上传的原文件该一起删：%v", err)
	}
	mustCode(t, do(s, "GET", "/api/knowledge-bases/"+id, ""), http.StatusNotFound, "get deleted")
}
