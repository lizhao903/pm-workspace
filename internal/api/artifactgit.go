// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
)

// --- 提交、分支产出物的查看（DEV-08b 补，见 artifactview.go 开头） ---
//
// 仓库只从产出物自己取：备注里的 repo=，没有就用登记的 path（契约「代码类产物」：只在本地的提交、分支把仓库目录填进 path）。
// 仓库目录过同一道边界（允许根 + artifactPathAllowed），sha 只认十六进制，分支名过 git check-ref-format，
// 都不会被当成 git 的选项。git 只跑只读命令，关掉外部 diff、textconv、fsmonitor，不弹交互，15 秒超时，输出有上限。

const (
	gitTimeout = 15 * time.Second
	// maxDiffBytes 是一次提交 diff 最多回的字节数，超出截断（truncated=true）。整份塞进 JSON 会让抽屉卡住。
	maxDiffBytes = 512 << 10
	// maxBranchCommits 是分支提交列表最多回的条数；maxChangedFiles 是改动文件最多回的条数。
	maxBranchCommits = 200
	maxChangedFiles  = 1000
)

var hexSHA = regexp.MustCompile(`^[0-9a-fA-F]{4,64}$`)

// ghCommitURL 从 GitHub 提交链接里取 sha（只登记了链接、备注没写 sha 的提交）。
var ghCommitURL = regexp.MustCompile(`/commit/([0-9a-fA-F]{7,64})`)

// ArtifactChangedFile 是一个改动的文件。status 是 git 的 A/M/D/R/C/T；改名时 old_path 是原路径；二进制文件 binary=true、行数为 0。
type ArtifactChangedFile struct {
	Path      string `json:"path"`
	OldPath   string `json:"old_path"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary"`
}

// ArtifactCommit 是 GET /api/artifacts/{id}/commit 的响应。
type ArtifactCommit struct {
	ArtifactID     string                `json:"artifact_id"`
	Repo           string                `json:"repo"`
	SHA            string                `json:"sha"`
	Parents        []string              `json:"parents"`
	Author         string                `json:"author"`
	AuthorEmail    string                `json:"author_email"`
	AuthoredAt     string                `json:"authored_at"`
	Subject        string                `json:"subject"`
	Body           string                `json:"body"`
	Files          []ArtifactChangedFile `json:"files"`
	FilesTruncated bool                  `json:"files_truncated"`
	Diff           string                `json:"diff"`
	Truncated      bool                  `json:"truncated"`
	Limit          int                   `json:"limit"`
}

// ArtifactBranchCommit 是分支提交列表的一行。
type ArtifactBranchCommit struct {
	SHA        string `json:"sha"`
	Author     string `json:"author"`
	AuthoredAt string `json:"authored_at"`
	Subject    string `json:"subject"`
}

// ArtifactBranch 是 GET /api/artifacts/{id}/branch 的响应：分支相对主分支（main / master / origin/HEAD）多出来的提交和改动文件。
type ArtifactBranch struct {
	ArtifactID       string                 `json:"artifact_id"`
	Repo             string                 `json:"repo"`
	Branch           string                 `json:"branch"`
	Ref              string                 `json:"ref"`
	Base             string                 `json:"base"`
	Ahead            int                    `json:"ahead"`
	Behind           int                    `json:"behind"`
	Commits          []ArtifactBranchCommit `json:"commits"`
	CommitsTruncated bool                   `json:"commits_truncated"`
	Files            []ArtifactChangedFile  `json:"files"`
	FilesTruncated   bool                   `json:"files_truncated"`
}

// gitViewError 是查看提交、分支时给用户看的失败：code 是 repo_unavailable（仓库取不到）或 not_found（仓库里没有）。
type gitViewError struct {
	status int
	code   string
	msg    string
}

func (e *gitViewError) Error() string { return e.msg }

func repoUnavailable(msg string) error {
	return &gitViewError{status: http.StatusConflict, code: "repo_unavailable", msg: msg}
}

func gitNotFound(msg string) error {
	return &gitViewError{status: http.StatusNotFound, code: "not_found", msg: msg}
}

func (s *Server) failGit(w http.ResponseWriter, r *http.Request, err error) {
	var ge *gitViewError
	if errors.As(err, &ge) {
		writeJSON(w, ge.status, errBody{Error: errPayload{Code: ge.code, Message: ge.msg}})
		return
	}
	s.fail(w, r, err)
}

// capWriter 只留前 limit 字节，多出来的丢掉并记 over。
type capWriter struct {
	buf   bytes.Buffer
	limit int
	over  bool
}

func (c *capWriter) Write(p []byte) (int, error) {
	if room := c.limit - c.buf.Len(); room < len(p) {
		c.over = true
		if room > 0 {
			c.buf.Write(p[:room])
		}
		return len(p), nil
	}
	return c.buf.Write(p)
}

// gitRead 在 repo 里跑一条只读 git 命令，stdout 最多留 limit 字节。
func gitRead(ctx context.Context, repo string, limit int, args ...string) (string, bool, error) {
	base := []string{"-C", repo, "--no-pager", "--no-optional-locks",
		"-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false"}
	cmd := exec.CommandContext(ctx, "git", append(base, args...)...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C", "GIT_PAGER=cat", "PAGER=cat")
	out := &capWriter{limit: limit}
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = out, &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return "", false, repoUnavailable("本机没有找到 git 命令，看不了提交和分支")
		}
		if ctx.Err() != nil {
			return "", false, repoUnavailable("git 读仓库超时（" + gitTimeout.String() + "）：" + repo)
		}
		return out.buf.String(), out.over, &gitCmdError{msg: strings.TrimSpace(stderr.String()), err: err}
	}
	return out.buf.String(), out.over, nil
}

type gitCmdError struct {
	msg string
	err error
}

func (e *gitCmdError) Error() string {
	if e.msg != "" {
		return e.msg
	}
	return e.err.Error()
}

// artifactRepo 定位产出物的仓库：备注 repo=，没有就用 path。回 git 仓库顶层的真实路径。
func (s *Server) artifactRepo(ctx context.Context, a *domain.Artifact, n codeNote) (string, error) {
	cand := strings.TrimSpace(n.repo)
	from := "备注里的 repo="
	if cand == "" {
		cand, from = strings.TrimSpace(a.Path), "登记的本机路径"
	}
	if cand == "" {
		return "", repoUnavailable("这条产出物没有登记仓库目录（备注里没有 repo=，也没有本机路径），只能看链接")
	}
	dir, err := fsbrowse.ResolveDir(cand)
	if err != nil {
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return "", repoUnavailable("仓库目录不在了（" + from + "）：" + cand + "。工作区可能已经清理，或仓库挪了位置")
		case errors.Is(err, fsbrowse.ErrNotDir):
			return "", repoUnavailable(from + "不是目录：" + cand)
		}
		return "", repoUnavailable("仓库目录读不了（" + from + "）：" + err.Error())
	}
	if ok, why := s.artifactPathAllowed(dir); !ok {
		return "", repoUnavailable(why)
	}
	top, _, err := gitRead(ctx, dir, 4096, "rev-parse", "--show-toplevel")
	if err != nil {
		var ge *gitViewError
		if errors.As(err, &ge) {
			return "", err
		}
		return "", repoUnavailable("不是 git 仓库（" + from + "）：" + cand)
	}
	top = strings.TrimSpace(top)
	if ok, why := s.artifactPathAllowed(realPath(top)); !ok {
		return "", repoUnavailable(why)
	}
	return top, nil
}

// resolveCommit 把十六进制 sha 解析成仓库里的完整提交号。
func resolveCommit(ctx context.Context, repo, sha string) (string, error) {
	if !hexSHA.MatchString(sha) {
		return "", validationf("sha 只能是 4 到 64 位十六进制：%s", sha)
	}
	out, _, err := gitRead(ctx, repo, 256, "rev-parse", "--verify", "--quiet", "--end-of-options", sha+"^{commit}")
	if err != nil {
		var ge *gitViewError
		if errors.As(err, &ge) {
			return "", err
		}
		return "", gitNotFound("仓库 " + repo + " 里找不到提交 " + sha + "（可能还没拉取，或者提交在别的仓库）")
	}
	return strings.TrimSpace(out), nil
}

// changedFiles 合并 --name-status 和 --numstat（都用 -z）：sub 是 show / diff，args 是其余选项和范围。
func changedFiles(ctx context.Context, repo, sub string, args ...string) ([]ArtifactChangedFile, bool, error) {
	ns, _, err := gitRead(ctx, repo, 4<<20, append([]string{sub, "--name-status", "-z", "-M"}, args...)...)
	if err != nil {
		return nil, false, err
	}
	num, _, err := gitRead(ctx, repo, 4<<20, append([]string{sub, "--numstat", "-z", "-M"}, args...)...)
	if err != nil {
		return nil, false, err
	}
	files := []ArtifactChangedFile{}
	idx := map[string]int{}
	f := strings.Split(ns, "\x00")
	for i := 0; i < len(f); {
		st := f[i]
		if st == "" {
			i++
			continue
		}
		c := ArtifactChangedFile{Status: st[:1]}
		if (c.Status == "R" || c.Status == "C") && i+2 < len(f) {
			c.OldPath, c.Path = f[i+1], f[i+2]
			i += 3
		} else if i+1 < len(f) {
			c.Path = f[i+1]
			i += 2
		} else {
			break
		}
		idx[c.Path] = len(files)
		files = append(files, c)
	}
	// numstat -z：「增\t删\t路径\0」，改名时路径为空、后面跟「原路径\0新路径\0」；二进制的增删是「-」
	g := strings.Split(num, "\x00")
	for i := 0; i < len(g); i++ {
		parts := strings.SplitN(g[i], "\t", 3)
		if len(parts) != 3 {
			continue
		}
		p := parts[2]
		if p == "" && i+2 < len(g) {
			p = g[i+2]
			i += 2
		}
		k, ok := idx[p]
		if !ok {
			continue
		}
		if parts[0] == "-" {
			files[k].Binary = true
			continue
		}
		files[k].Additions, _ = strconv.Atoi(parts[0])
		files[k].Deletions, _ = strconv.Atoi(parts[1])
	}
	if len(files) > maxChangedFiles {
		return files[:maxChangedFiles], true, nil
	}
	return files, false, nil
}

// handleArtifactCommit 是 GET /api/artifacts/{id}/commit[?sha=]：提交说明、改动文件、diff。
// 提交产出物看自己的 sha（备注 sha=，没有就从 GitHub 链接里取）；分支产出物可以带 ?sha= 看分支上的某个提交，
// 这个提交必须在分支上（是分支的祖先），不是分支产出物给 sha 回 400。
func (s *Server) handleArtifactCommit(w http.ResponseWriter, r *http.Request) {
	a, err := s.st.GetArtifact(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	n := parseCodeNote(a.Note)
	kind := n.kind
	if kind == "" {
		kind = a.Kind
	}
	qsha := strings.TrimSpace(r.URL.Query().Get("sha"))
	sha := n.sha
	switch {
	case kind == "commit" && qsha != "":
		s.fail(w, r, validationf("提交产出物只能看它自己的提交，不接受 sha 参数"))
		return
	case kind == "commit":
		if sha == "" {
			if m := ghCommitURL.FindStringSubmatch(a.URL); m != nil {
				sha = m[1]
			}
		}
		if sha == "" {
			s.fail(w, r, validationf("这条提交产出物的备注里没有 sha="))
			return
		}
	case kind == "branch" && qsha != "":
		sha = qsha
	default:
		s.fail(w, r, validationf("只有提交产出物（或分支产出物带 ?sha=）能看提交"))
		return
	}
	if !hexSHA.MatchString(sha) {
		s.fail(w, r, validationf("sha 只能是 4 到 64 位十六进制：%s", sha))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), gitTimeout)
	defer cancel()
	repo, err := s.artifactRepo(ctx, a, n)
	if err != nil {
		s.failGit(w, r, err)
		return
	}
	full, err := resolveCommit(ctx, repo, sha)
	if err != nil {
		s.failGit(w, r, err)
		return
	}
	if kind == "branch" {
		ref, err := branchRef(ctx, repo, n.branch)
		if err != nil {
			s.failGit(w, r, err)
			return
		}
		if _, _, err := gitRead(ctx, repo, 0, "merge-base", "--is-ancestor", full, ref); err != nil {
			s.failGit(w, r, gitNotFound("提交 "+sha+" 不在分支 "+n.branch+" 上"))
			return
		}
	}
	out, err := commitView(ctx, repo, full)
	if err != nil {
		s.failGit(w, r, err)
		return
	}
	out.ArtifactID = a.ID
	respondData(w, http.StatusOK, out)
}

func commitView(ctx context.Context, repo, full string) (*ArtifactCommit, error) {
	meta, _, err := gitRead(ctx, repo, 256<<10, "show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b", full)
	if err != nil {
		return nil, err
	}
	p := strings.SplitN(strings.TrimRight(meta, "\n"), "\x1f", 7)
	for len(p) < 7 {
		p = append(p, "")
	}
	out := &ArtifactCommit{Repo: repo, SHA: p[0], Parents: strings.Fields(p[1]), Author: p[2], AuthorEmail: p[3],
		AuthoredAt: p[4], Subject: p[5], Body: strings.TrimSpace(p[6]), Limit: maxDiffBytes}
	diffArgs := []string{"--no-ext-diff", "--no-textconv", "--diff-merges=first-parent", "--format=", full}
	if out.Files, out.FilesTruncated, err = changedFiles(ctx, repo, "show", diffArgs...); err != nil {
		return nil, err
	}
	out.Diff, out.Truncated, err = gitRead(ctx, repo, maxDiffBytes, append([]string{"show", "--patch", "-M"}, diffArgs...)...)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// branchRef 校验分支名、找到它的引用：先本地 refs/heads/，再 refs/remotes/origin/。
func branchRef(ctx context.Context, repo, branch string) (string, error) {
	if branch == "" {
		return "", validationf("这条分支产出物的备注里没有 branch=")
	}
	if strings.HasPrefix(branch, "-") {
		return "", validationf("分支名不合法：%s", branch)
	}
	if _, _, err := gitRead(ctx, repo, 0, "check-ref-format", "--branch", branch); err != nil {
		var ge *gitViewError
		if errors.As(err, &ge) {
			return "", err
		}
		return "", validationf("分支名不合法：%s", branch)
	}
	for _, ref := range []string{"refs/heads/" + branch, "refs/remotes/origin/" + branch} {
		if _, _, err := gitRead(ctx, repo, 256, "rev-parse", "--verify", "--quiet", "--end-of-options", ref+"^{commit}"); err == nil {
			return ref, nil
		}
	}
	return "", gitNotFound("仓库 " + repo + " 里没有分支 " + branch + "（可能合并后删掉了，或者还没推到这台机器）")
}

// baseRef 找主分支：本地 main、master，再 origin/HEAD 指向的、origin/main、origin/master。
func baseRef(ctx context.Context, repo string) (ref, name string, err error) {
	cands := []string{"refs/heads/main", "refs/heads/master"}
	if out, _, e := gitRead(ctx, repo, 256, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"); e == nil {
		if r := strings.TrimSpace(out); strings.HasPrefix(r, "refs/remotes/") {
			cands = append(cands, r)
		}
	}
	cands = append(cands, "refs/remotes/origin/main", "refs/remotes/origin/master")
	for _, c := range cands {
		if _, _, e := gitRead(ctx, repo, 256, "rev-parse", "--verify", "--quiet", "--end-of-options", c+"^{commit}"); e == nil {
			return c, shortRef(c), nil
		}
	}
	return "", "", repoUnavailable("仓库 " + repo + " 里找不到主分支（main、master、origin/HEAD 都没有），没法对比")
}

func shortRef(ref string) string {
	for _, p := range []string{"refs/heads/", "refs/remotes/"} {
		if strings.HasPrefix(ref, p) {
			return strings.TrimPrefix(ref, p)
		}
	}
	return ref
}

// handleArtifactBranch 是 GET /api/artifacts/{id}/branch：分支相对主分支多出来的提交（最多 200 条）和改动文件。
func (s *Server) handleArtifactBranch(w http.ResponseWriter, r *http.Request) {
	a, err := s.st.GetArtifact(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	n := parseCodeNote(a.Note)
	kind := n.kind
	if kind == "" {
		kind = a.Kind
	}
	if kind != "branch" {
		s.fail(w, r, validationf("只有分支产出物能看分支"))
		return
	}
	if n.branch == "" {
		s.fail(w, r, validationf("这条分支产出物的备注里没有 branch="))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), gitTimeout)
	defer cancel()
	repo, err := s.artifactRepo(ctx, a, n)
	if err != nil {
		s.failGit(w, r, err)
		return
	}
	ref, err := branchRef(ctx, repo, n.branch)
	if err != nil {
		s.failGit(w, r, err)
		return
	}
	base, baseName, err := baseRef(ctx, repo)
	if err != nil {
		s.failGit(w, r, err)
		return
	}
	out := &ArtifactBranch{ArtifactID: a.ID, Repo: repo, Branch: n.branch, Ref: ref, Base: baseName,
		Commits: []ArtifactBranchCommit{}, Files: []ArtifactChangedFile{}}
	if base == ref {
		respondData(w, http.StatusOK, out)
		return
	}
	cnt, _, err := gitRead(ctx, repo, 256, "rev-list", "--left-right", "--count", base+"..."+ref)
	if err != nil {
		s.failGit(w, r, err)
		return
	}
	if f := strings.Fields(cnt); len(f) == 2 {
		out.Behind, _ = strconv.Atoi(f[0])
		out.Ahead, _ = strconv.Atoi(f[1])
	}
	log, _, err := gitRead(ctx, repo, 1<<20, "log", "--no-color", "-n", strconv.Itoa(maxBranchCommits+1),
		"--format=%H%x1f%an%x1f%aI%x1f%s%x1e", base+".."+ref)
	if err != nil {
		s.failGit(w, r, err)
		return
	}
	for _, rec := range strings.Split(log, "\x1e") {
		rec = strings.TrimLeft(rec, "\n")
		if rec == "" {
			continue
		}
		p := strings.SplitN(rec, "\x1f", 4)
		if len(p) < 4 {
			continue
		}
		out.Commits = append(out.Commits, ArtifactBranchCommit{SHA: p[0], Author: p[1], AuthoredAt: p[2], Subject: p[3]})
	}
	if len(out.Commits) > maxBranchCommits {
		out.Commits, out.CommitsTruncated = out.Commits[:maxBranchCommits], true
	}
	if out.Files, out.FilesTruncated, err = changedFiles(ctx, repo, "diff", "--no-ext-diff", "--no-textconv", base+"..."+ref); err != nil {
		s.failGit(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}
