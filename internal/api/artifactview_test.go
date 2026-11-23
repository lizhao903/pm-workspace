// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 产出物查看（DEV-08b 补）：按产出物 id 读登记的文件、提交、分支。重点守边界：
// 接口不接受路径参数，登记里的路径还要过允许根、隐藏段、敏感文件、数据目录四道。

func writeFile(t *testing.T, p, body string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// recordPath 登记一条产出物，回 id。
func recordArtifact(t *testing.T, s *Server, path, note string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"path": path, "note": note, "title": filepath.Base(path)})
	w := do(s, http.MethodPost, "/api/artifacts", string(body))
	mustCode(t, w, http.StatusCreated, "登记 "+path)
	return artifactData(t, w)["id"].(string)
}

func TestArtifactFilePreview(t *testing.T) {
	root := tmpDirUnderTmp(t)
	data := filepath.Join(root, "data")
	s := newTestServer(newFakeStore(), func(o *Options) { o.DataDir = data })

	cases := []struct {
		name, path, preview string
	}{
		{"markdown", writeFile(t, filepath.Join(root, "docs", "方案.md"), "# 标题\n正文"), "markdown"},
		{"源码按文本", writeFile(t, filepath.Join(root, "main.go"), "package main\n"), "text"},
		{"html 回源码", writeFile(t, filepath.Join(root, "proto.html"), "<h1>hi</h1>"), "html"},
		{"二进制", writeFile(t, filepath.Join(root, "blob.bin"), "a\x00b"), "binary"},
		{"图片只回元信息", writeFile(t, filepath.Join(root, "shot.png"), "\x89PNG"), "image"},
		{"数据目录里的发布报告", writeFile(t, filepath.Join(data, "releases", "p", "T-1", "r1", "report.md"), "# 报告"), "markdown"},
		{"Claude Code 工作树", writeFile(t, filepath.Join(root, "repo", ".claude", "worktrees", "x", "a.txt"), "hi"), "text"},
	}
	for _, c := range cases {
		id := recordArtifact(t, s, c.path, "")
		w := do(s, http.MethodGet, "/api/artifacts/"+id+"/file", "")
		mustCode(t, w, http.StatusOK, c.name)
		d := artifactData(t, w)
		if d["preview"] != c.preview || d["artifact_id"] != id {
			t.Errorf("%s: preview = %v, want %s (%s)", c.name, d["preview"], c.preview, w.Body.String())
		}
	}
	id := recordArtifact(t, s, filepath.Join(root, "docs", "方案.md"), "")
	if d := artifactData(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/file", "")); d["content"] != "# 标题\n正文" {
		t.Errorf("content = %v", d["content"])
	}
}

// TestArtifactFileBoundary 守「登记了就能读」这条反面：登记接口能写任意路径，读接口不能因此变成任意读。
func TestArtifactFileBoundary(t *testing.T) {
	root := tmpDirUnderTmp(t)
	data := filepath.Join(root, "data")
	s := newTestServer(newFakeStore(), func(o *Options) { o.DataDir = data })

	forbidden := map[string]string{
		"隐藏目录":        writeFile(t, filepath.Join(root, ".ssh", "id_rsa"), "secret"),
		"隐藏文件":        writeFile(t, filepath.Join(root, "proj", ".env"), "TOKEN=1"),
		"git 目录里":     writeFile(t, filepath.Join(root, "proj", ".git", "config"), "[core]"),
		"工作树后面又隐藏":    writeFile(t, filepath.Join(root, ".claude", "worktrees", "x", ".env"), "TOKEN=1"),
		"密钥":          writeFile(t, filepath.Join(root, "proj", "server.pem"), "-----"),
		"库文件":         writeFile(t, filepath.Join(root, "proj", "x.db"), "sqlite"),
		"数据目录根上":      writeFile(t, filepath.Join(data, "notes.txt"), "x"),
		"数据目录里的备份":    writeFile(t, filepath.Join(data, "backups", "a.txt"), "x"),
		"数据目录的 vault": writeFile(t, filepath.Join(data, "vault.key"), "k"),
	}
	for name, p := range forbidden {
		id := recordArtifact(t, s, p, "")
		assertError(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/file", ""), http.StatusForbidden, "forbidden")
		assertError(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/raw", ""), http.StatusForbidden, "forbidden")
		_ = name
	}
	// 软链：允许的目录里放个软链指向隐藏目录，按真实路径拦
	link := filepath.Join(root, "proj", "innocent.txt")
	if err := os.Symlink(forbidden["隐藏目录"], link); err != nil {
		t.Fatal(err)
	}
	id := recordArtifact(t, s, link, "")
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/file", ""), http.StatusForbidden, "forbidden")

	// 允许根之外
	id = recordArtifact(t, s, "/etc/hosts", "")
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/file", ""), http.StatusForbidden, "forbidden")

	// 文件不在了 404，目录 400，只有链接 400，没有这条 404
	id = recordArtifact(t, s, filepath.Join(root, "gone.md"), "")
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/file", ""), http.StatusNotFound, "not_found")
	id = recordArtifact(t, s, root, "")
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/file", ""), http.StatusBadRequest, "validation")
	w := do(s, http.MethodPost, "/api/artifacts", `{"url":"https://x/1"}`)
	id = artifactData(t, w)["id"].(string)
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/file", ""), http.StatusBadRequest, "validation")
	assertError(t, do(s, http.MethodGet, "/api/artifacts/art_nope/file", ""), http.StatusNotFound, "not_found")

	// 接口不认路径参数：带 ?path= 读的还是登记的那个
	ok := recordArtifact(t, s, writeFile(t, filepath.Join(root, "ok.txt"), "ok"), "")
	d := artifactData(t, do(s, http.MethodGet, "/api/artifacts/"+ok+"/file?path="+forbidden["隐藏目录"], ""))
	if d["content"] != "ok" {
		t.Fatalf("带 path 参数读到了 %v", d["content"])
	}
}

func TestArtifactRawAndOpen(t *testing.T) {
	root := tmpDirUnderTmp(t)
	s := newTestServer(newFakeStore())
	html := recordArtifact(t, s, writeFile(t, filepath.Join(root, "p.html"), "<script>alert(1)</script><h1>x</h1>"), "")
	w := do(s, http.MethodGet, "/api/artifacts/"+html+"/raw", "")
	mustCode(t, w, http.StatusOK, "raw html")
	if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox") || strings.Contains(csp, "allow-scripts") {
		t.Errorf("HTML 的 CSP = %q，要 sandbox 且不许脚本", csp)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q", ct)
	}
	png := recordArtifact(t, s, writeFile(t, filepath.Join(root, "a.png"), "\x89PNG"), "")
	w = do(s, http.MethodGet, "/api/artifacts/"+png+"/raw", "")
	mustCode(t, w, http.StatusOK, "raw png")
	if ct := w.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q", ct)
	}
	txt := recordArtifact(t, s, writeFile(t, filepath.Join(root, "a.go"), "package a"), "")
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+txt+"/raw", ""), http.StatusBadRequest, "validation")

	var opened []string
	old := openLocal
	openLocal = func(p string, reveal bool) error { opened = append(opened, p); return nil }
	defer func() { openLocal = old }()
	mustCode(t, do(s, http.MethodPost, "/api/artifacts/"+png+"/open", `{}`), http.StatusOK, "open png")
	// 源码不在文档种类里：不许直接打开（交给 open 可能就是执行），在访达中显示可以
	assertError(t, do(s, http.MethodPost, "/api/artifacts/"+txt+"/open", `{}`), http.StatusForbidden, "forbidden")
	mustCode(t, do(s, http.MethodPost, "/api/artifacts/"+txt+"/open", `{"reveal":true}`), http.StatusOK, "reveal go")
	if len(opened) != 2 {
		t.Errorf("opened = %v", opened)
	}
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=T", "-c", "user.email=t@x", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func newRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("本机没有 git")
	}
	repo := tmpDirUnderTmp(t)
	git(t, repo, "init", "-q", "-b", "main")
	writeFile(t, filepath.Join(repo, "a.txt"), "one\n")
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "init")
	return repo
}

func TestArtifactCommitView(t *testing.T) {
	repo := newRepo(t)
	writeFile(t, filepath.Join(repo, "a.txt"), "one\ntwo\n")
	writeFile(t, filepath.Join(repo, "b.md"), "# b\n")
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "feat: 加 b", "-m", "说明第二段")
	sha := git(t, repo, "rev-parse", "HEAD")
	s := newTestServer(newFakeStore())

	id := recordArtifact(t, s, repo, "[commit] sha="+sha[:7]+" branch=main repo="+repo+"  改了 a")
	w := do(s, http.MethodGet, "/api/artifacts/"+id+"/commit", "")
	mustCode(t, w, http.StatusOK, "commit")
	d := artifactData(t, w)
	if d["sha"] != sha || d["subject"] != "feat: 加 b" || d["body"] != "说明第二段" || d["author"] != "T" {
		t.Fatalf("commit = %s", w.Body.String())
	}
	files := d["files"].([]any)
	if len(files) != 2 {
		t.Fatalf("files = %v", files)
	}
	f0 := files[0].(map[string]any)
	if f0["path"] != "a.txt" || f0["status"] != "M" || f0["additions"] != float64(1) || f0["deletions"] != float64(0) {
		t.Errorf("a.txt = %v", f0)
	}
	if !strings.Contains(d["diff"].(string), "+two") {
		t.Errorf("diff = %v", d["diff"])
	}
	// 提交产出物不接受 sha 参数
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/commit?sha="+sha, ""), http.StatusBadRequest, "validation")

	// sha 不是十六进制（含想冒充选项的）400
	for _, bad := range []string{"--output=/tmp/x", "HEAD", "zzzzzzz"} {
		bid := recordArtifact(t, s, repo, "[commit] sha="+bad+" repo="+repo)
		assertError(t, do(s, http.MethodGet, "/api/artifacts/"+bid+"/commit", ""), http.StatusBadRequest, "validation")
	}
	// 十六进制但仓库里没有 404
	nid := recordArtifact(t, s, repo, "[commit] sha=deadbeef repo="+repo)
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+nid+"/commit", ""), http.StatusNotFound, "not_found")

	// 仓库取不到：目录不在了、不是 git 仓库、没登记仓库，都是 409 repo_unavailable 且说明原因
	gone := recordArtifact(t, s, repo, "[commit] sha="+sha+" repo="+filepath.Join(repo, "nope"))
	e := assertError(t, do(s, http.MethodGet, "/api/artifacts/"+gone+"/commit", ""), http.StatusConflict, "repo_unavailable")
	if msg, _ := e["message"].(string); !strings.Contains(msg, "不在了") {
		t.Errorf("message = %q", msg)
	}
	plain := tmpDirUnderTmp(t)
	nogit := recordArtifact(t, s, plain, "[commit] sha="+sha)
	e = assertError(t, do(s, http.MethodGet, "/api/artifacts/"+nogit+"/commit", ""), http.StatusConflict, "repo_unavailable")
	if msg, _ := e["message"].(string); !strings.Contains(msg, "不是 git 仓库") {
		t.Errorf("message = %q", msg)
	}
	w = do(s, http.MethodPost, "/api/artifacts", `{"url":"https://github.com/a/b/commit/`+sha+`","note":"[commit] sha=`+sha+`"}`)
	urlOnly := artifactData(t, w)["id"].(string)
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+urlOnly+"/commit", ""), http.StatusConflict, "repo_unavailable")

	// 文件产出物不能当提交看
	fid := recordArtifact(t, s, filepath.Join(repo, "a.txt"), "")
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+fid+"/commit", ""), http.StatusBadRequest, "validation")
}

func TestArtifactBranchView(t *testing.T) {
	repo := newRepo(t)
	git(t, repo, "checkout", "-q", "-b", "feat/x")
	writeFile(t, filepath.Join(repo, "c.txt"), "c\n")
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "feat: c")
	writeFile(t, filepath.Join(repo, "c.txt"), "c2\n")
	git(t, repo, "commit", "-q", "-am", "fix: c2")
	onBranch := git(t, repo, "rev-parse", "HEAD")
	git(t, repo, "checkout", "-q", "main")
	writeFile(t, filepath.Join(repo, "m.txt"), "m\n")
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "main only")
	mainOnly := git(t, repo, "rev-parse", "HEAD")
	s := newTestServer(newFakeStore())

	id := recordArtifact(t, s, repo, "[branch] branch=feat/x repo="+repo)
	w := do(s, http.MethodGet, "/api/artifacts/"+id+"/branch", "")
	mustCode(t, w, http.StatusOK, "branch")
	d := artifactData(t, w)
	commits := d["commits"].([]any)
	if d["base"] != "main" || d["ref"] != "refs/heads/feat/x" || d["ahead"] != float64(2) || d["behind"] != float64(1) || len(commits) != 2 {
		t.Fatalf("branch = %s", w.Body.String())
	}
	if c0 := commits[0].(map[string]any); c0["subject"] != "fix: c2" || c0["sha"] != onBranch {
		t.Errorf("最新的在前：%v", c0)
	}
	if files := d["files"].([]any); len(files) != 1 || files[0].(map[string]any)["path"] != "c.txt" {
		t.Errorf("files = %v（分支相对分叉点，main 上的 m.txt 不算）", files)
	}

	// 分支上的提交能看，不在分支上的 404
	mustCode(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/commit?sha="+onBranch[:10], ""), http.StatusOK, "commit on branch")
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/commit?sha="+mainOnly, ""), http.StatusNotFound, "not_found")
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+id+"/commit?sha=-p", ""), http.StatusBadRequest, "validation")

	// 分支删了 404；分支名不合法 400
	gone := recordArtifact(t, s, repo, "[branch] branch=feat/gone repo="+repo)
	assertError(t, do(s, http.MethodGet, "/api/artifacts/"+gone+"/branch", ""), http.StatusNotFound, "not_found")
	for _, bad := range []string{"--all", "a..b"} {
		bid := recordArtifact(t, s, repo, "[branch] branch="+bad+" repo="+repo)
		assertError(t, do(s, http.MethodGet, "/api/artifacts/"+bid+"/branch", ""), http.StatusBadRequest, "validation")
	}
	// 主分支本身：没有可对比的，空列表
	mid := recordArtifact(t, s, repo, "[branch] branch=main repo="+repo)
	if d := artifactData(t, do(s, http.MethodGet, "/api/artifacts/"+mid+"/branch", "")); len(d["commits"].([]any)) != 0 {
		t.Errorf("main 对 main 应为空：%v", d["commits"])
	}
}

func TestParseCodeNote(t *testing.T) {
	n := parseCodeNote("  [commit] sha=abc1234 branch=feat/x repo=/a/b  自由 备注 repo=/x")
	if n.kind != "commit" || n.sha != "abc1234" || n.branch != "feat/x" || n.repo != "/a/b" {
		t.Errorf("%+v", n)
	}
	if n := parseCodeNote("普通文件 [commit] sha=1"); n.kind != "" {
		t.Errorf("没有前缀的不算：%+v", n)
	}
	if n := parseCodeNote("[branch] sha= branch=x"); n.sha != "" || n.branch != "x" {
		t.Errorf("空值当没给：%+v", n)
	}
}
