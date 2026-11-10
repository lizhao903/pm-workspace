// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 写进项目目录（local_append）：把一段文字写进项目挂着的本地目录（项目 props.related 里列的目录之一）下的一个文件，
// 文件已有就追加（前面空一行），没有就新建，中间目录自动建。要 fs:write:project 权限。
//
// 配置：project 是项目 id、ref 或名字（支持 {{字段}}）；dir 选写进哪个关联目录，留空是第一个，填数字是第几个（从 1 起），
// 否则按目录的 label 认；path 是关联目录下的相对路径；content 是要写的内容。path、content 支持 {{字段}}，
// 另有日期占位 {{date}}（本机时区 YYYY-MM-DD）、{{month}}（YYYY-MM）、{{time}}（HH:MM，路径里写成 HHMM），输入里有同名字段时以输入为准。
//
// 路径校验：不许绝对路径、不许出现 ..；拼好后逐级解析符号链接，解析后的位置必须还在关联目录（也解析过符号链接）里面；
// 目标文件本身是符号链接时按它指向的位置校验、写到指向的文件；目标不是普通文件不写。关联目录本身不存在时失败，不替用户建根目录。
// 单次内容最多 64 KB。
//
// 幂等：同写节点，键是「运行 id/步骤 key#尝试次数」，写完记一条审计（action append、target_type file）；
// 服务重启后重跑同一次尝试时按审计查，写过的不再写，回上次的输出。
//
// 输出在输入上加 file: {path, rel, dir, dir_label, project: {id, ref, name}, bytes, created}。

const (
	localAppendKind  = "local_append"
	localContentMax  = 64 << 10
	localWritePerm   = "fs:write:project"
	localAuditAction = "append"
	localAuditTarget = "file"
)

// localNow 是取日期占位用的时间，测试里换掉。
var localNow = time.Now

// localVars 在输入上补日期占位，输入里有同名字段的不动。
func localVars(input Json, forPath bool) Json {
	t := localNow().Local()
	tm := t.Format("15:04")
	if forPath {
		tm = t.Format("1504")
	}
	out := make(Json, len(input)+3)
	for k, v := range map[string]string{"date": t.Format("2006-01-02"), "month": t.Format("2006-01"), "time": tm} {
		out[k] = v
	}
	for k, v := range input {
		out[k] = v
	}
	return out
}

// relatedDir 是项目 props.related 里的一项。
type relatedDir struct{ label, path string }

func relatedDirs(props map[string]any) []relatedDir {
	arr, _ := props["related"].([]any)
	var out []relatedDir
	for _, x := range arr {
		m, ok := x.(map[string]any)
		if !ok {
			continue
		}
		p, _ := m["path"].(string)
		l, _ := m["label"].(string)
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, relatedDir{label: strings.TrimSpace(l), path: p})
		}
	}
	return out
}

// pickDir 按 dir 配置挑关联目录：空是第一个，数字是第几个（从 1 起），否则按 label。
func pickDir(dirs []relatedDir, sel string, project string) (relatedDir, error) {
	if len(dirs) == 0 {
		return relatedDir{}, fmt.Errorf("项目「%s」没有关联本地目录：先在项目设置里加一个", project)
	}
	sel = strings.TrimSpace(sel)
	if sel == "" {
		return dirs[0], nil
	}
	if n, err := strconv.Atoi(sel); err == nil {
		if n < 1 || n > len(dirs) {
			return relatedDir{}, fmt.Errorf("项目「%s」只有 %d 个关联目录，没有第 %d 个", project, len(dirs), n)
		}
		return dirs[n-1], nil
	}
	labels := make([]string, 0, len(dirs))
	for _, d := range dirs {
		if d.label == sel {
			return d, nil
		}
		labels = append(labels, "「"+orDefault(d.label, d.path)+"」")
	}
	return relatedDir{}, fmt.Errorf("项目「%s」没有叫「%s」的关联目录，有：%s", project, sel, strings.Join(labels, "、"))
}

// cleanRel 校验相对路径：非空、不是绝对路径、没有 ..、不是目录，回按本机分隔符清理过的路径。
func cleanRel(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", errors.New("文件路径是空的：检查「文件路径」里的 {{字段}} 在输入里有没有值")
	}
	if strings.ContainsRune(p, 0) {
		return "", errors.New("文件路径里有非法字符")
	}
	if filepath.IsAbs(p) || strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`) || filepath.VolumeName(p) != "" {
		return "", fmt.Errorf("文件路径「%s」要写成项目目录下的相对路径，不能是绝对路径", p)
	}
	for _, seg := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == ".." {
			return "", fmt.Errorf("文件路径「%s」不能有 ..，只能写进项目目录里面", p)
		}
	}
	if strings.HasSuffix(p, "/") || strings.HasSuffix(p, `\`) {
		return "", fmt.Errorf("文件路径「%s」是目录，要写到文件名", p)
	}
	c := filepath.Clean(filepath.FromSlash(p))
	if c == "." {
		return "", fmt.Errorf("文件路径「%s」是目录，要写到文件名", p)
	}
	return c, nil
}

// within 看 p 是不是 root 或在 root 下面（两个都是解析过符号链接的绝对路径）。
func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// resolveExisting 从 p 往上找第一个存在的路径，解析符号链接后回它，没有存在的祖先回错误。
func resolveExisting(p string) (string, error) {
	for cur := p; ; cur = filepath.Dir(cur) {
		rp, err := filepath.EvalSymlinks(cur)
		if err == nil {
			return rp, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		if filepath.Dir(cur) == cur {
			return "", err
		}
	}
}

// localTarget 定要写的文件：校验后回实际写入的绝对路径（目标是符号链接时是它指向的文件）、是否要新建。
func localTarget(base, rel string) (target string, created bool, err error) {
	if !filepath.IsAbs(base) {
		return "", false, fmt.Errorf("项目目录「%s」不是绝对路径", base)
	}
	root, err := filepath.EvalSymlinks(base)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, fmt.Errorf("项目目录「%s」不存在", base)
	}
	if err != nil {
		return "", false, fmt.Errorf("项目目录「%s」读不了：%v", base, err)
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return "", false, fmt.Errorf("项目目录「%s」不是目录", base)
	}
	escape := fmt.Errorf("文件路径「%s」解析符号链接后越出了项目目录，不写", filepath.ToSlash(rel))
	target = filepath.Join(root, rel)
	// 中间目录：已有的部分解析符号链接后要在项目目录里，再建缺的
	dir := filepath.Dir(target)
	rp, err := resolveExisting(dir)
	if err != nil {
		return "", false, fmt.Errorf("目录读不了：%v", err)
	}
	if !within(root, rp) {
		return "", false, escape
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", false, fmt.Errorf("建目录失败：%v", err)
	}
	if rd, err := filepath.EvalSymlinks(dir); err != nil || !within(root, rd) {
		return "", false, escape
	}
	st, err := os.Lstat(target)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return target, true, nil
	case err != nil:
		return "", false, fmt.Errorf("文件读不了：%v", err)
	case st.Mode()&fs.ModeSymlink != 0:
		real, err := filepath.EvalSymlinks(target)
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, fmt.Errorf("文件路径「%s」是指向不存在位置的符号链接，不写", filepath.ToSlash(rel))
		}
		if err != nil || !within(root, real) {
			return "", false, escape
		}
		if st, err := os.Stat(real); err != nil || !st.Mode().IsRegular() {
			return "", false, fmt.Errorf("文件路径「%s」不是普通文件，不写", filepath.ToSlash(rel))
		}
		return real, false, nil
	case !st.Mode().IsRegular():
		return "", false, fmt.Errorf("文件路径「%s」不是普通文件，不写", filepath.ToSlash(rel))
	}
	return target, false, nil
}

// appendText 追加：文件非空时补到前面空一行，内容末尾补换行。回写进去的字节数。
func appendText(target, content string) (int, error) {
	f, err := os.OpenFile(target, os.O_RDWR|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()
	st, err := f.Stat()
	if err != nil {
		return 0, err
	}
	prefix := ""
	if n := st.Size(); n > 0 {
		k := min(n, 2)
		tail := make([]byte, k)
		if _, err := f.ReadAt(tail, n-k); err != nil && !errors.Is(err, io.EOF) {
			return 0, err
		}
		switch {
		case strings.HasSuffix(string(tail), "\n\n") || (n == 1 && string(tail) == "\n"):
		case strings.HasSuffix(string(tail), "\n"):
			prefix = "\n"
		default:
			prefix = "\n\n"
		}
	}
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	return f.WriteString(prefix + content)
}

func writeLocal(ctx context.Context, c plugin.Core, w writeRun, def stepDef, input Json) nodeResult {
	cfg := def.Config
	if err := plugin.Require(c, localWritePerm); err != nil {
		return nodeResult{err: err.Error()}
	}
	meta := w.meta()
	if a, found, err := c.Audit().Find(ctx, localAuditAction, localAuditTarget, meta); err != nil {
		c.Log().Warn("sop local append dedupe lookup failed", "key", meta.Key, "err", err)
	} else if found {
		if out, ok := a.Detail["output"].(map[string]any); ok {
			return nodeResult{output: with(input, "file", out), log: reuseLog(true, "写进 "+a.TargetID)}
		}
	}
	key := strings.TrimSpace(render(cfg["project"], input))
	if key == "" {
		return nodeResult{err: "没有指定项目：在「项目」里选一个，或者填 {{字段}}，确认输入里有值"}
	}
	p, err := c.Objects().Find(ctx, "project", key)
	if errors.Is(err, plugin.ErrNoRows) {
		return nodeResult{err: fmt.Sprintf("项目「%s」不存在：填项目 id、编号或名字，已删除的项目不算", key)}
	}
	if err != nil {
		return nodeResult{err: "读项目失败：" + err.Error()}
	}
	d, err := pickDir(relatedDirs(p.Props), render(cfg["dir"], input), p.Title)
	if err != nil {
		return nodeResult{err: err.Error()}
	}
	rel, err := cleanRel(render(cfg["path"], localVars(input, true)))
	if err != nil {
		return nodeResult{err: err.Error()}
	}
	content := render(cfg["content"], localVars(input, false))
	if strings.TrimSpace(content) == "" {
		return nodeResult{err: "要写的内容是空的：检查「内容」里的 {{字段}} 在输入里有没有值"}
	}
	if len(content) > localContentMax {
		return nodeResult{err: fmt.Sprintf("要写的内容有 %d KB，一次最多 64 KB", (len(content)+1023)/1024)}
	}
	if !utf8.ValidString(content) {
		return nodeResult{err: "要写的内容不是 UTF-8 文字"}
	}
	base := plugin.LocalDir(d.path)
	target, created, err := localTarget(base, rel)
	if err != nil {
		return nodeResult{err: "写进项目目录失败：" + err.Error()}
	}
	n, err := appendText(target, content)
	if err != nil {
		return nodeResult{err: "写进项目目录失败：" + err.Error()}
	}
	out := map[string]any{
		"path": target, "rel": filepath.ToSlash(rel), "dir": base, "dir_label": d.label,
		"project": map[string]any{"id": p.ID, "ref": p.Ref, "name": p.Title}, "bytes": n, "created": created,
	}
	verb := "追加到"
	if created {
		verb = "新建了"
	}
	c.Audit().Note(ctx, plugin.AuditNote{Action: localAuditAction, TargetType: localAuditTarget, TargetID: target,
		Summary: fmt.Sprintf("%s项目「%s」目录下的 %s", verb, p.Title, filepath.ToSlash(rel)),
		Detail:  map[string]any{"project_id": p.ID, "bytes": n, "created": created, "output": out}}, meta)
	return nodeResult{output: with(input, "file", out), log: fmt.Sprintf("%s %s（%d 字节）", verb, target, n)}
}
