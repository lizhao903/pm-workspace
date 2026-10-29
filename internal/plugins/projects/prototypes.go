package projects

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 项目原型（PJ-04a）：定义在表 projects_prototypes（插件迁移 0004），运行状态和日志在 manager（procman.go），
// 接口 /api/projects/{id}/prototypes，契约见 docs/api-contract.md「项目原型」。

const (
	maxArgs    = 64
	maxArgLen  = 4096
	maxCommand = 8192
	defaultLog = 200
)

// Prototype 是一个原型：定义加上当前的运行状态、最近一次崩溃。
type Prototype struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Name      string    `json:"name"`
	Dir       string    `json:"dir"`
	Command   string    `json:"command"`
	Argv      []string  `json:"argv"`
	Port      int       `json:"port"`
	URL       string    `json:"url"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Runtime
	LastCrash *Crash `json:"last_crash"`
}

// Crash 是一次崩溃：非 0 退出或被信号结束，且不是用户点的停止。
type Crash struct {
	ID          int64     `json:"id"`
	PrototypeID string    `json:"prototype_id"`
	ProjectID   string    `json:"project_id"`
	ExitCode    int       `json:"exit_code"`
	Signal      string    `json:"signal"`
	Reason      string    `json:"reason"`
	Log         []string  `json:"log"`
	StartedAt   time.Time `json:"started_at"`
	ExitedAt    time.Time `json:"exited_at"`
}

type prototypes struct {
	*stakeholders
	m *manager
}

const protoCols = `id, project_id, name, dir, command, argv, port, created_at, updated_at`

func (h *prototypes) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT `+protoCols+` FROM projects_prototypes
		WHERE project_id = ? ORDER BY created_at, rowid`, pid)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := []Prototype{}
	for rows.Next() {
		p, err := scanPrototype(rows)
		if err != nil {
			_ = rows.Close()
			h.fail(w, r, err)
			return
		}
		out = append(out, p)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		h.fail(w, r, err)
		return
	}
	for i := range out {
		if err := h.fill(ctx, &out[i]); err != nil {
			h.fail(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *prototypes) show(w http.ResponseWriter, r *http.Request) {
	p, err := h.load(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.reply(w, r, http.StatusOK, p)
}

type protoInput struct {
	Name    *string   `json:"name"`
	Dir     *string   `json:"dir"`
	Command *string   `json:"command"`
	Argv    *[]string `json:"argv"`
	Port    *int      `json:"port"`
}

func (h *prototypes) add(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pid := r.PathValue("id")
	if err := h.project(ctx, pid); err != nil {
		h.fail(w, r, err)
		return
	}
	var in protoInput
	if err := decode(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	if in.Dir == nil || (in.Command == nil && in.Argv == nil) || in.Port == nil {
		h.fail(w, r, apiErr(errValidation, "dir, command (or argv) and port are required"))
		return
	}
	p := Prototype{ProjectID: pid}
	if err := applyPrototype(&p, in, selfPort(r)); err != nil {
		h.fail(w, r, err)
		return
	}
	p.ID = idgen.Prefixed("pt")
	argv, _ := json.Marshal(p.Argv)
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO projects_prototypes (`+protoCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, pid, p.Name, p.Dir, p.Command, string(argv), p.Port, now, now); err != nil {
		h.fail(w, r, err)
		return
	}
	got, err := h.get(ctx, pid, p.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.reply(w, r, http.StatusCreated, got)
}

func (h *prototypes) update(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, err := h.load(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var in protoInput
	if err := decode(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	if h.m.active(p.ID) {
		h.fail(w, r, apiErr(errConflict, "原型「%s」在运行，先停止再改", p.Name))
		return
	}
	if err := applyPrototype(&p, in, selfPort(r)); err != nil {
		h.fail(w, r, err)
		return
	}
	argv, _ := json.Marshal(p.Argv)
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `UPDATE projects_prototypes SET name = ?, dir = ?, command = ?, argv = ?, port = ?, updated_at = ?
		WHERE id = ? AND project_id = ?`, p.Name, p.Dir, p.Command, string(argv), p.Port, now, p.ID, p.ProjectID); err != nil {
		h.fail(w, r, err)
		return
	}
	got, err := h.get(ctx, p.ProjectID, p.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.reply(w, r, http.StatusOK, got)
}

func (h *prototypes) remove(w http.ResponseWriter, r *http.Request) {
	p, err := h.load(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if h.m.active(p.ID) {
		h.fail(w, r, apiErr(errConflict, "原型「%s」在运行，先停止再删", p.Name))
		return
	}
	if _, err := h.c.Store().Exec(r.Context(), `DELETE FROM projects_prototypes WHERE id = ? AND project_id = ?`, p.ID, p.ProjectID); err != nil {
		h.fail(w, r, err)
		return
	}
	h.m.forget(p.ID)
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

func (h *prototypes) start(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, err := h.load(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	o, err := h.c.Objects().Get(ctx, p.ProjectID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if err := h.m.start(p, o.Title, selfPort(r)); err != nil {
		h.fail(w, r, err)
		return
	}
	h.reply(w, r, http.StatusOK, p)
}

func (h *prototypes) stop(w http.ResponseWriter, r *http.Request) {
	p, err := h.load(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.m.stop(p.ID)
	h.reply(w, r, http.StatusOK, p)
}

// logs 回日志行，?after=<seq> 只要更新的（轮询用），?limit= 最多多少行（默认 200，上限同缓冲）。
func (h *prototypes) logs(w http.ResponseWriter, r *http.Request) {
	p, err := h.load(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	q := r.URL.Query()
	after, limit := int64(0), defaultLog
	if s := q.Get("after"); s != "" {
		if after, err = strconv.ParseInt(s, 10, 64); err != nil || after < 0 {
			h.fail(w, r, apiErr(errValidation, "after must be a non-negative integer"))
			return
		}
	}
	if s := q.Get("limit"); s != "" {
		if limit, err = strconv.Atoi(s); err != nil || limit < 1 || limit > logLines {
			h.fail(w, r, apiErr(errValidation, "limit must be between 1 and %d", logLines))
			return
		}
	}
	lines, last := h.m.logs(p.ID, after, limit)
	writeJSON(w, http.StatusOK, map[string]any{"data": lines, "meta": map[string]any{"last_seq": last, "status": h.m.runtime(p.ID).Status}})
}

// crashes 回崩溃记录，新的在前，最多 50 条。
func (h *prototypes) crashes(w http.ResponseWriter, r *http.Request) {
	p, err := h.load(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := listCrashes(r.Context(), h.c.Store(), p.ID, 50)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *prototypes) reply(w http.ResponseWriter, r *http.Request, status int, p Prototype) {
	if err := h.fill(r.Context(), &p); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, status, map[string]any{"data": p})
}

// fill 拼上运行状态和最近一次崩溃。
func (h *prototypes) fill(ctx context.Context, p *Prototype) error {
	p.Runtime = h.m.runtime(p.ID)
	cs, err := listCrashes(ctx, h.c.Store(), p.ID, 1)
	if err != nil {
		return err
	}
	if len(cs) > 0 {
		p.LastCrash = &cs[0]
	}
	return nil
}

func (h *prototypes) load(r *http.Request) (Prototype, error) {
	pid := r.PathValue("id")
	if err := h.project(r.Context(), pid); err != nil {
		return Prototype{}, err
	}
	return h.get(r.Context(), pid, r.PathValue("prototype_id"))
}

func (h *prototypes) get(ctx context.Context, pid, id string) (Prototype, error) {
	p, err := scanPrototype(h.c.Store().QueryRow(ctx, `SELECT `+protoCols+` FROM projects_prototypes
		WHERE id = ? AND project_id = ?`, id, pid))
	if errors.Is(err, plugin.ErrNoRows) {
		return Prototype{}, apiErr(errNotFound, "prototype %s is not in this project", id)
	}
	return p, err
}

func scanPrototype(row plugin.Row) (Prototype, error) {
	var p Prototype
	var argv, created, updated string
	if err := row.Scan(&p.ID, &p.ProjectID, &p.Name, &p.Dir, &p.Command, &argv, &p.Port, &created, &updated); err != nil {
		return Prototype{}, err
	}
	if err := json.Unmarshal([]byte(argv), &p.Argv); err != nil {
		return Prototype{}, err
	}
	p.URL = "http://127.0.0.1:" + strconv.Itoa(p.Port)
	p.CreatedAt, _ = time.Parse(time.RFC3339, created)
	p.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	return p, nil
}

// applyPrototype 校验并合并输入；name 不填取命令的第一个词。
func applyPrototype(p *Prototype, in protoInput, self int) error {
	if in.Command != nil && in.Argv != nil {
		return apiErr(errValidation, "pass either command or argv, not both")
	}
	if in.Dir != nil {
		d := strings.TrimSpace(plugin.LocalDir(*in.Dir))
		if d == "" || strings.ContainsRune(d, 0) || !filepath.IsAbs(d) {
			return apiErr(errValidation, "dir must be an absolute path")
		}
		d = filepath.Clean(d)
		if st, err := os.Stat(d); err != nil || !st.IsDir() {
			return apiErr(errValidation, "dir %s does not exist or is not a folder", d)
		}
		p.Dir = d
	}
	switch {
	case in.Command != nil:
		c := strings.TrimSpace(*in.Command)
		if len(c) > maxCommand {
			return apiErr(errValidation, "command is limited to %d bytes", maxCommand)
		}
		argv, err := splitCommand(c)
		if err != nil {
			return err
		}
		p.Argv, p.Command = argv, c
	case in.Argv != nil:
		if err := checkArgv(*in.Argv); err != nil {
			return err
		}
		p.Argv, p.Command = *in.Argv, joinCommand(*in.Argv)
	}
	if err := checkArgv(p.Argv); err != nil {
		return err
	}
	if in.Port != nil {
		port := *in.Port
		if port < 1024 || port > 65535 {
			return apiErr(errValidation, "端口要在 1024 到 65535 之间")
		}
		if why := reservedReason(port, self); why != "" {
			return apiErr(errValidation, "%s", why)
		}
		p.Port = port
	}
	if in.Name != nil {
		p.Name = strings.TrimSpace(*in.Name)
	}
	if utf8.RuneCountInString(p.Name) > maxName {
		return apiErr(errValidation, "name is limited to %d characters", maxName)
	}
	if p.Name == "" {
		p.Name = filepath.Base(p.Argv[0])
	}
	return nil
}

func checkArgv(argv []string) error {
	if len(argv) == 0 || strings.TrimSpace(argv[0]) == "" {
		return apiErr(errValidation, "command is required")
	}
	if len(argv) > maxArgs {
		return apiErr(errValidation, "command is limited to %d arguments", maxArgs)
	}
	for _, a := range argv {
		if len(a) > maxArgLen || strings.ContainsRune(a, 0) {
			return apiErr(errValidation, "argument too long or contains NUL")
		}
	}
	return nil
}

// selfPort 是这次请求进来的端口，即工作台服务自己的端口；测试里没有就是 0。
func selfPort(r *http.Request) int {
	if a, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
		if t, ok := a.(*net.TCPAddr); ok {
			return t.Port
		}
	}
	return 0
}

func saveCrash(ctx context.Context, s plugin.Store, c Crash) error {
	_, err := s.Exec(ctx, `INSERT INTO projects_prototype_crashes
		(prototype_id, project_id, exit_code, signal, reason, log, started_at, exited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		c.PrototypeID, c.ProjectID, c.ExitCode, c.Signal, c.Reason, strings.Join(c.Log, "\n"),
		c.StartedAt.Format(time.RFC3339Nano), c.ExitedAt.Format(time.RFC3339Nano))
	return err
}

func listCrashes(ctx context.Context, s plugin.Store, protoID string, limit int) ([]Crash, error) {
	rows, err := s.Query(ctx, `SELECT id, prototype_id, project_id, exit_code, signal, reason, log, started_at, exited_at
		FROM projects_prototype_crashes WHERE prototype_id = ? ORDER BY id DESC LIMIT ?`, protoID, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Crash{}
	for rows.Next() {
		var c Crash
		var log, started, exited string
		if err := rows.Scan(&c.ID, &c.PrototypeID, &c.ProjectID, &c.ExitCode, &c.Signal, &c.Reason, &log, &started, &exited); err != nil {
			return nil, err
		}
		c.Log = []string{}
		if log != "" {
			c.Log = strings.Split(log, "\n")
		}
		c.StartedAt, _ = time.Parse(time.RFC3339Nano, started)
		c.ExitedAt, _ = time.Parse(time.RFC3339Nano, exited)
		out = append(out, c)
	}
	return out, rows.Err()
}

// splitCommand 把一行命令拆成参数数组，规则是 shell 的一个小子集：空白分隔，单引号原样，
// 双引号里 \" 和 \\ 转义，引号外反斜杠转义下一个字符。命令不经 shell 执行，所以引号外出现管道、
// 重定向、变量、通配、命令替换、开头的 ~ 或 VAR=x 赋值都直接拒绝，免得看着像能用实际不生效。
// 真要用 shell 的写成 sh -c '...'，那是用户自己明确要的。
func splitCommand(s string) ([]string, error) {
	var out []string
	var cur strings.Builder
	inWord, quote := false, rune(0)
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case quote == '\'':
			if c == '\'' {
				quote = 0
			} else {
				cur.WriteRune(c)
			}
		case quote == '"':
			switch {
			case c == '"':
				quote = 0
			case c == '\\' && i+1 < len(rs) && (rs[i+1] == '"' || rs[i+1] == '\\'):
				i++
				cur.WriteRune(rs[i])
			default:
				cur.WriteRune(c)
			}
		case c == '\'' || c == '"':
			quote, inWord = c, true
		case c == '\\':
			if i+1 >= len(rs) {
				return nil, apiErr(errValidation, "command ends with a dangling backslash")
			}
			i++
			cur.WriteRune(rs[i])
			inWord = true
		case c == ' ' || c == '\t':
			if inWord {
				out = append(out, cur.String())
				cur.Reset()
				inWord = false
			}
		case c == '\n' || c == '\r':
			return nil, apiErr(errValidation, "command must be a single line")
		case strings.ContainsRune("|&;<>()$`*?", c):
			return nil, apiErr(errValidation, "命令不经 shell 执行，%q 这类管道、重定向、变量、通配写法不生效；要用 shell 请写成 sh -c '...'", string(c))
		case c == '~' && !inWord:
			return nil, apiErr(errValidation, "命令不经 shell 执行，~ 不会展开成主目录，请写绝对路径")
		default:
			cur.WriteRune(c)
			inWord = true
		}
	}
	if quote != 0 {
		return nil, apiErr(errValidation, "command has an unclosed quote")
	}
	if inWord {
		out = append(out, cur.String())
	}
	if len(out) > 0 && strings.Contains(out[0], "=") {
		return nil, apiErr(errValidation, "命令开头的 VAR=value 环境变量赋值不支持；端口会以 PORT 环境变量传给原型")
	}
	return out, nil
}

// joinCommand 把参数数组拼回给人看的一行，需要时加单引号。
func joinCommand(argv []string) string {
	parts := make([]string, len(argv))
	for i, a := range argv {
		if a != "" && !strings.ContainsAny(a, " \t\n'\"\\|&;<>()$`*?~#") {
			parts[i] = a
			continue
		}
		parts[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
	}
	return strings.Join(parts, " ")
}
