// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 项目档案（AUTO-04）：表 projects_profiles（迁移 0005），给分类 Agent 和各 pipeline 用。
// 接口：GET/PATCH /api/projects/{id}/profile 读写一个项目的档案；GET /api/projects/profiles 列档案摘要（分类用）。
// 没建过档案的项目读出来是空档案，PATCH 时才落一行。契约见 docs/api-contract.md「项目插件 / 项目档案」。

// CommandKeys 是档案里能存的命令，顺序即界面上的顺序：
// 测试环境用的构建、测试、起测试环境、冒烟（测试环境上，AUTO-08）；
// 发布用的版本号与更新日志、打包、发布前检查（备份与密钥核对）、发布、线上冒烟、回滚（AUTO-10，release.go）。
// smoke 一直是测试环境上的冒烟；线上冒烟是 prod_smoke（AUTO-10 加的 key，旧数据不用迁）。
var CommandKeys = []string{"build", "test", "test_env", "smoke", "version", "package", "preflight", "release", "prod_smoke", "rollback"}

const (
	maxIntro          = 2000  // 简介（字）
	maxProfileTag     = 30    // 一个关键词、平台标签（字）
	maxKeywords       = 50    // 关键词个数
	maxPlatforms      = 10    // 平台标签个数
	maxPeople         = 50    // 负责人、验收人员各自的人数
	maxProfileCommand = 4000  // 一条命令（字）
	maxTimeoutSec     = 86400 // 超时上限一天
	maxProfilePath    = 4096
)

// Command 是档案里的一条命令。build、test、test_env、smoke 由测试环境（AUTO-08，testenv.go）在工作区里执行；
// version、package、preflight、release、prod_smoke、rollback 由发布（AUTO-10，release.go）在工作区里执行。
type Command struct {
	Command string `json:"command"`
	// Dir 相对代码库目录，空串表示就在代码库目录里执行
	Dir string `json:"dir"`
	// TimeoutSec 为 0 表示用执行方的默认值
	TimeoutSec int `json:"timeout_sec"`
	// Ready 只有 test_env 用：测试环境就绪检查。空串等 PORT 能连上；/ 开头 GET http://127.0.0.1:PORT<路径>；
	// http:// 或 https:// 开头 GET 这个地址（可用 {{PORT}} 等占位）。2xx、3xx 算就绪（AUTO-08）
	Ready string `json:"ready,omitempty"`
}

// Profile 是一个项目的档案。
type Profile struct {
	ProjectID string   `json:"project_id"`
	Intro     string   `json:"intro"`
	Keywords  []string `json:"keywords"`
	Platforms []string `json:"platforms"`
	CodeDir   string   `json:"code_dir"`
	ProtoDir  string   `json:"proto_dir"`
	PRDDir    string   `json:"prd_dir"`
	// Commands 只含设了的命令，key 见 CommandKeys
	Commands    map[string]Command `json:"commands"`
	OwnerIDs    []string           `json:"owner_ids"`
	AcceptorIDs []string           `json:"acceptor_ids"`
	// Root 是项目本身的目录（对象 workdir 列），只读；代码库目录没设时摘要里用它
	Root string `json:"root"`
	// CreatedAt、UpdatedAt 没建过档案时为 null
	CreatedAt *time.Time `json:"created_at"`
	UpdatedAt *time.Time `json:"updated_at"`
}

type profiles struct{ *stakeholders }

func (h *profiles) show(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	o, err := h.liveProject(ctx, pid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	p, err := h.load(ctx, o)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": p})
}

// profilePatch 每个字段都是整体替换，没传的不动；commands 也是整体替换（不在里面的命令清掉）。
type profilePatch struct {
	Intro       *string             `json:"intro"`
	Keywords    *[]string           `json:"keywords"`
	Platforms   *[]string           `json:"platforms"`
	CodeDir     *string             `json:"code_dir"`
	ProtoDir    *string             `json:"proto_dir"`
	PRDDir      *string             `json:"prd_dir"`
	Commands    *map[string]Command `json:"commands"`
	OwnerIDs    *[]string           `json:"owner_ids"`
	AcceptorIDs *[]string           `json:"acceptor_ids"`
}

func (h *profiles) update(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	o, err := h.liveProject(ctx, pid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var in profilePatch
	if err := decode(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	cur, err := h.load(ctx, o)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if err := h.apply(ctx, &cur, in); err != nil {
		h.fail(w, r, err)
		return
	}
	enc := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	// 冲突时只改这次传了的列：同一项目的两次 PATCH 并发时（前端目录和其它字段分开存）不会互相盖掉
	sets := []string{}
	for _, c := range []struct {
		col  string
		sent bool
	}{
		{"intro", in.Intro != nil}, {"keywords", in.Keywords != nil}, {"platforms", in.Platforms != nil},
		{"code_dir", in.CodeDir != nil}, {"proto_dir", in.ProtoDir != nil}, {"prd_dir", in.PRDDir != nil},
		{"commands", in.Commands != nil}, {"owner_ids", in.OwnerIDs != nil}, {"acceptor_ids", in.AcceptorIDs != nil},
	} {
		if c.sent {
			sets = append(sets, c.col+" = excluded."+c.col)
		}
	}
	sets = append(sets, "updated_at = excluded.updated_at")
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = h.c.Store().Exec(ctx, `INSERT INTO projects_profiles
		(project_id, intro, keywords, platforms, code_dir, proto_dir, prd_dir, commands, owner_ids, acceptor_ids, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (project_id) DO UPDATE SET `+strings.Join(sets, ", "),
		pid, cur.Intro, enc(cur.Keywords), enc(cur.Platforms), cur.CodeDir, cur.ProtoDir, cur.PRDDir,
		enc(cur.Commands), enc(cur.OwnerIDs), enc(cur.AcceptorIDs), now, now)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	p, err := h.load(ctx, o)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": p})
}

// apply 校验并把 patch 合进 p；出错时 p 可能改了一半，调用方不要再用。
func (h *profiles) apply(ctx context.Context, p *Profile, in profilePatch) error {
	if in.Intro != nil {
		s := strings.TrimSpace(*in.Intro)
		if utf8.RuneCountInString(s) > maxIntro {
			return apiErr(errValidation, "intro is limited to %d characters", maxIntro)
		}
		p.Intro = s
	}
	var err error
	if in.Keywords != nil {
		if p.Keywords, err = cleanProfileTags("keywords", *in.Keywords, maxKeywords); err != nil {
			return err
		}
	}
	if in.Platforms != nil {
		if p.Platforms, err = cleanProfileTags("platforms", *in.Platforms, maxPlatforms); err != nil {
			return err
		}
	}
	for _, d := range []struct {
		name string
		in   *string
		out  *string
	}{{"code_dir", in.CodeDir, &p.CodeDir}, {"proto_dir", in.ProtoDir, &p.ProtoDir}, {"prd_dir", in.PRDDir, &p.PRDDir}} {
		if d.in == nil {
			continue
		}
		if *d.out, err = checkProfileDir(d.name, *d.in); err != nil {
			return err
		}
	}
	if in.Commands != nil {
		if p.Commands, err = cleanCommands(*in.Commands); err != nil {
			return err
		}
	}
	if in.OwnerIDs != nil {
		if p.OwnerIDs, err = h.cleanPeople(ctx, "owner_ids", *in.OwnerIDs); err != nil {
			return err
		}
	}
	if in.AcceptorIDs != nil {
		if p.AcceptorIDs, err = h.cleanPeople(ctx, "acceptor_ids", *in.AcceptorIDs); err != nil {
			return err
		}
	}
	return nil
}

// cleanProfileTags 去首尾空白、去空、去重（不分大小写，留第一次出现的写法）。
func cleanProfileTags(field string, in []string, max int) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if utf8.RuneCountInString(s) > maxProfileTag {
			return nil, apiErr(errValidation, "%s: %q is longer than %d characters", field, s, maxProfileTag)
		}
		k := strings.ToLower(s)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, s)
	}
	if len(out) > max {
		return nil, apiErr(errValidation, "%s is limited to %d items", field, max)
	}
	return out, nil
}

// checkProfileDir：空串表示清掉；否则要是本机绝对路径、存在且是目录（软链跟过去看）。存原样（去首尾空白和末尾斜杠），不展开软链。
func checkProfileDir(field, s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	if len(s) > maxProfilePath || strings.ContainsRune(s, 0) || !filepath.IsAbs(s) {
		return "", apiErr(errValidation, "%s must be an absolute path", field)
	}
	if len(s) > 1 {
		s = strings.TrimRight(s, "/")
	}
	st, err := os.Stat(s)
	if err != nil {
		return "", apiErr(errValidation, "%s: directory %s does not exist", field, s)
	}
	if !st.IsDir() {
		return "", apiErr(errValidation, "%s: %s is not a directory", field, s)
	}
	return s, nil
}

// cleanCommands：key 只认 CommandKeys；command 去首尾空白后为空的那条当没设（清掉）；
// dir 相对代码库目录，不能是绝对路径、不能用 .. 跑出代码库；超时 0 到一天。
func cleanCommands(in map[string]Command) (map[string]Command, error) {
	out := map[string]Command{}
	for k, c := range in {
		if !slices.Contains(CommandKeys, k) {
			return nil, apiErr(errValidation, "commands: unknown key %q, must be one of %s", k, strings.Join(CommandKeys, ", "))
		}
		c.Command = strings.TrimSpace(c.Command)
		if c.Command == "" {
			continue
		}
		if utf8.RuneCountInString(c.Command) > maxProfileCommand || strings.ContainsRune(c.Command, 0) {
			return nil, apiErr(errValidation, "commands.%s: command is limited to %d characters", k, maxProfileCommand)
		}
		d := strings.TrimSpace(c.Dir)
		if d != "" {
			if filepath.IsAbs(d) || strings.ContainsRune(d, 0) {
				return nil, apiErr(errValidation, "commands.%s: dir must be relative to the code directory", k)
			}
			d = filepath.Clean(d)
			if d == ".." || strings.HasPrefix(d, "../") {
				return nil, apiErr(errValidation, "commands.%s: dir must stay inside the code directory", k)
			}
			if d == "." {
				d = ""
			}
		}
		c.Dir = d
		if c.TimeoutSec < 0 || c.TimeoutSec > maxTimeoutSec {
			return nil, apiErr(errValidation, "commands.%s: timeout_sec must be between 0 and %d", k, maxTimeoutSec)
		}
		c.Ready = strings.TrimSpace(c.Ready)
		if c.Ready != "" {
			if k != "test_env" {
				return nil, apiErr(errValidation, "commands.%s: ready is only for test_env", k)
			}
			if err := checkReady(c.Ready); err != nil {
				return nil, err
			}
		}
		out[k] = c
	}
	return out, nil
}

const maxReady = 500

// checkReady：就绪检查要是 / 开头的路径，或 http(s):// 开头的地址，最多 500 字。
func checkReady(s string) error {
	if utf8.RuneCountInString(s) > maxReady || strings.ContainsAny(s, "\x00\n\r ") {
		return apiErr(errValidation, "commands.test_env: ready must be a path or URL without spaces, at most %d characters", maxReady)
	}
	if !strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		return apiErr(errValidation, "commands.test_env: ready must start with /, http:// or https://")
	}
	if !strings.HasPrefix(s, "/") {
		// 占位换成随便一个值再看主机：就绪检查只连本机，不让插件借它往外发请求
		u, err := url.Parse(placeholderRe.ReplaceAllString(s, "1"))
		if err != nil || !loopbackHost(u.Hostname()) {
			return apiErr(errValidation, "commands.test_env: ready must point to this machine (127.0.0.1, localhost or ::1)")
		}
	}
	return nil
}

// cleanPeople：去空、去重，每个 id 要在联系人名册里且没归档。
func (h *profiles) cleanPeople(ctx context.Context, field string, ids []string) ([]string, error) {
	out := []string{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || slices.Contains(out, id) {
			continue
		}
		ct, err := h.c.Contacts().Get(ctx, id)
		switch {
		case errors.Is(err, plugin.ErrNoRows):
			return nil, apiErr(errValidation, "%s: contact %s not found", field, id)
		case err != nil:
			return nil, err
		case ct.Archived:
			return nil, apiErr(errValidation, "%s: contact %s is archived", field, ct.Name)
		}
		out = append(out, id)
	}
	if len(out) > maxPeople {
		return nil, apiErr(errValidation, "%s is limited to %d people", field, maxPeople)
	}
	return out, nil
}

// liveProject 同 project，但把对象带回来（要它的 workdir）。
func (h *profiles) liveProject(ctx context.Context, id string) (plugin.ObjectInfo, error) {
	o, err := h.c.Objects().Get(ctx, id)
	if errors.Is(err, plugin.ErrNoRows) || (err == nil && (o.Type != "project" || o.Deleted)) {
		return plugin.ObjectInfo{}, apiErr(errNotFound, "project not found")
	}
	return o, err
}

const profileCols = `project_id, intro, keywords, platforms, code_dir, proto_dir, prd_dir, commands, owner_ids, acceptor_ids, created_at, updated_at`

// load 读一个项目的档案，没有行时回空档案。人员按名册过滤掉已经删掉的联系人。
func (h *profiles) load(ctx context.Context, o plugin.ObjectInfo) (Profile, error) {
	p, err := scanProfile(h.c.Store().QueryRow(ctx, `SELECT `+profileCols+` FROM projects_profiles WHERE project_id = ?`, o.ID))
	if errors.Is(err, plugin.ErrNoRows) {
		p, err = emptyProfile(o.ID), nil
	}
	if err != nil {
		return Profile{}, err
	}
	p.Root = o.Workdir
	if p.OwnerIDs, err = h.existing(ctx, p.OwnerIDs); err != nil {
		return Profile{}, err
	}
	if p.AcceptorIDs, err = h.existing(ctx, p.AcceptorIDs); err != nil {
		return Profile{}, err
	}
	return p, nil
}

func (h *profiles) existing(ctx context.Context, ids []string) ([]string, error) {
	out := []string{}
	for _, id := range ids {
		_, err := h.c.Contacts().Get(ctx, id)
		if errors.Is(err, plugin.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, nil
}

func emptyProfile(pid string) Profile {
	return Profile{ProjectID: pid, Keywords: []string{}, Platforms: []string{}, Commands: map[string]Command{}, OwnerIDs: []string{}, AcceptorIDs: []string{}}
}

func scanProfile(row plugin.Row) (Profile, error) {
	var p Profile
	var kw, pf, cmds, owners, acceptors, created, updated string
	if err := row.Scan(&p.ProjectID, &p.Intro, &kw, &pf, &p.CodeDir, &p.ProtoDir, &p.PRDDir, &cmds, &owners, &acceptors, &created, &updated); err != nil {
		return Profile{}, err
	}
	e := emptyProfile(p.ProjectID)
	p.Keywords, p.Platforms, p.Commands, p.OwnerIDs, p.AcceptorIDs = e.Keywords, e.Platforms, e.Commands, e.OwnerIDs, e.AcceptorIDs
	// 解不开当空：表里只有接口写进去的 JSON，坏了也不该让整个档案读不出来
	_ = json.Unmarshal([]byte(kw), &p.Keywords)
	_ = json.Unmarshal([]byte(pf), &p.Platforms)
	_ = json.Unmarshal([]byte(cmds), &p.Commands)
	_ = json.Unmarshal([]byte(owners), &p.OwnerIDs)
	_ = json.Unmarshal([]byte(acceptors), &p.AcceptorIDs)
	for _, s := range []*[]string{&p.Keywords, &p.Platforms, &p.OwnerIDs, &p.AcceptorIDs} {
		if *s == nil {
			*s = []string{}
		}
	}
	if p.Commands == nil {
		p.Commands = map[string]Command{}
	}
	if t, err := time.Parse(time.RFC3339, created); err == nil {
		p.CreatedAt = &t
	}
	if t, err := time.Parse(time.RFC3339, updated); err == nil {
		p.UpdatedAt = &t
	}
	return p, nil
}

// --- 档案摘要（分类用）---

// DirState 是摘要里一个目录的情况：path 是生效的路径（代码库没设时用项目目录，inherited 为 true），
// state 是 ok（存在且是目录）、missing（设了但现在找不到或不是目录）、unset（没设）。
type DirState struct {
	Path      string `json:"path"`
	State     string `json:"state"`
	Inherited bool   `json:"inherited,omitempty"`
}

// ProfileSummary 是档案摘要的一行。
type ProfileSummary struct {
	ProjectID string              `json:"project_id"`
	Name      string              `json:"name"`
	Ref       string              `json:"ref"`
	Intro     string              `json:"intro"`
	Keywords  []string            `json:"keywords"`
	Platforms []string            `json:"platforms"`
	Dirs      map[string]DirState `json:"dirs"`
	// DirsReady：三个目录都是 ok
	DirsReady bool `json:"dirs_ready"`
	// Commands 是设了的命令 key，按 CommandKeys 的顺序
	Commands  []string  `json:"commands"`
	UpdatedAt time.Time `json:"updated_at"`
}

// list：GET /api/projects/profiles。只列建过档案、项目没进回收站的，按项目名排序。
// 插件读不到对象列表（Store 只能读本插件的表），没建档案的项目由调用方从 /api/objects?type=project 补。
func (h *profiles) list(w http.ResponseWriter, r *http.Request) {
	out, err := listProfileSummaries(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func listProfileSummaries(ctx context.Context, c plugin.Core) ([]ProfileSummary, error) {
	rows, err := c.Store().Query(ctx, `SELECT `+profileCols+` FROM projects_profiles`)
	if err != nil {
		return nil, err
	}
	var ps []Profile
	for rows.Next() {
		p, err := scanProfile(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		ps = append(ps, p)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()

	out := []ProfileSummary{}
	for _, p := range ps {
		o, err := c.Objects().Get(ctx, p.ProjectID)
		if errors.Is(err, plugin.ErrNoRows) || (err == nil && (o.Type != "project" || o.Deleted)) {
			continue
		}
		if err != nil {
			return nil, err
		}
		s := ProfileSummary{
			ProjectID: o.ID, Name: o.Title, Ref: o.Ref, Intro: p.Intro, Keywords: p.Keywords, Platforms: p.Platforms,
			Dirs: map[string]DirState{}, DirsReady: true, Commands: []string{},
		}
		if p.UpdatedAt != nil {
			s.UpdatedAt = *p.UpdatedAt
		}
		code := dirState(p.CodeDir)
		if p.CodeDir == "" && o.Workdir != "" {
			code = dirState(o.Workdir)
			code.Inherited = true
		}
		s.Dirs["code"], s.Dirs["prototype"], s.Dirs["prd"] = code, dirState(p.ProtoDir), dirState(p.PRDDir)
		for _, d := range s.Dirs {
			if d.State != "ok" {
				s.DirsReady = false
			}
		}
		for _, k := range CommandKeys {
			if _, ok := p.Commands[k]; ok {
				s.Commands = append(s.Commands, k)
			}
		}
		out = append(out, s)
	}
	slices.SortStableFunc(out, func(a, b ProfileSummary) int { return strings.Compare(a.Name, b.Name) })
	return out, nil
}

func dirState(p string) DirState {
	if p == "" {
		return DirState{State: "unset"}
	}
	if st, err := os.Stat(p); err == nil && st.IsDir() {
		return DirState{Path: p, State: "ok"}
	}
	return DirState{Path: p, State: "missing"}
}
