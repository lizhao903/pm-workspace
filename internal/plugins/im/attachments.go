package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 附件获取（IM-04a）：经适配器把附件下载到数据目录下的 attachments/<渠道>/，状态记在 im_attachments，
// 读消息时叠到附件上；内容只能经 GET /api/im/attachments/{channel}/{name} 读（数据目录不给 /api/fs/read 读）。
// 口径照原型 App.tsx 的 fetchAttachment 和 messages.tsx 的 fetchBlocker。契约见 docs/api-contract.md「IM 消息插件 im」。

const (
	fetchTimeout    = 60 * time.Second
	maxFetchError   = 500
	maxFileNameByte = 200 // 文件名上限（字节），文件系统一般是 255
	defaultFileName = "附件"
)

// maxAttachment 是单个附件的大小上限；测试里调小。
var maxAttachment int64 = 50 << 20

// attState 是 im_attachments 的一行。
type attState struct {
	status, local, err string
	size               *int64
}

// attachmentStates 读一批消息的附件状态，键是「消息 id / 附件 id」。
func (in *inbox) attachmentStates(ctx context.Context, ids []string) (map[string]attState, error) {
	out := map[string]attState{}
	if len(ids) == 0 {
		return out, nil
	}
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i], args[i] = "?", id
	}
	rows, err := in.c.Store().Query(ctx, `SELECT message_id, attachment_id, status, local_path, size, error FROM im_attachments
		WHERE message_id IN (`+strings.Join(ph, ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var mid, aid string
		var s attState
		if err := rows.Scan(&mid, &aid, &s.status, &s.local, &s.size, &s.err); err != nil {
			return nil, err
		}
		out[mid+"/"+aid] = s
	}
	return out, rows.Err()
}

// fillAttachments 把获取状态叠到附件上：fetch 是 idle / done / error，done 带 local 和 download_url，error 带原因。
// 链接不用获取，去掉这几项。渠道带来的同名字段一律以插件为准。
func (in *inbox) fillAttachments(ctx context.Context, ms []Message) error {
	ids := make([]string, len(ms))
	for i := range ms {
		ids[i] = ms[i].ID
	}
	states, err := in.attachmentStates(ctx, ids)
	if err != nil {
		return err
	}
	for i := range ms {
		var list []json.RawMessage
		if json.Unmarshal(ms[i].Attachments, &list) != nil || len(list) == 0 {
			continue
		}
		for j, raw := range list {
			var a map[string]any
			if json.Unmarshal(raw, &a) != nil || a == nil {
				continue
			}
			for _, k := range []string{"fetch", "local", "error", "download_url"} {
				delete(a, k)
			}
			if kind, _ := a["kind"].(string); kind != "link" {
				id, _ := a["id"].(string)
				st, ok := states[ms[i].ID+"/"+id]
				switch {
				case !ok:
					a["fetch"] = "idle"
				case st.status == "done":
					a["fetch"], a["local"] = "done", st.local
					a["download_url"] = downloadURL(ms[i].Channel, filepath.Base(st.local))
					if st.size != nil {
						a["size"] = *st.size
					}
				default:
					a["fetch"], a["error"] = "error", st.err
				}
			}
			b, err := json.Marshal(a)
			if err != nil {
				return err
			}
			list[j] = b
		}
		b, err := json.Marshal(list)
		if err != nil {
			return err
		}
		ms[i].Attachments = b
	}
	return nil
}

func downloadURL(channel, name string) string {
	return "/api/im/attachments/" + channel + "/" + url.PathEscape(name)
}

// normalizeAttachments 在到达时给没有 id 或 id 重复的附件补 att_ 开头的 id，获取时按 id 找；都有 id 的原样存。
func normalizeAttachments(raw string) (string, error) {
	var list []json.RawMessage
	if json.Unmarshal([]byte(raw), &list) != nil {
		return "", bad("attachments must be an array")
	}
	seen := map[string]bool{}
	changed := false
	for i, el := range list {
		var a map[string]any
		if json.Unmarshal(el, &a) != nil || a == nil {
			continue
		}
		id, _ := a["id"].(string)
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			id = idgen.Prefixed("att")
			a["id"] = id
			b, err := json.Marshal(a)
			if err != nil {
				return "", err
			}
			list[i], changed = b, true
		}
		seen[id] = true
	}
	if !changed {
		return raw, nil
	}
	b, err := json.Marshal(list)
	return string(b), err
}

// findAttachment 在消息的附件里按 id 找，回元数据原文和解析后的几项。
func findAttachment(m Message, id string) (AttachmentRef, bool) {
	var list []json.RawMessage
	if json.Unmarshal(m.Attachments, &list) != nil {
		return AttachmentRef{}, false
	}
	for _, raw := range list {
		var a struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Kind string `json:"kind"`
			URL  string `json:"url"`
		}
		if json.Unmarshal(raw, &a) != nil || a.ID != id {
			continue
		}
		ref := AttachmentRef{ConnectorID: m.ConnectorID, ConversationID: m.ConversationExternalID, MessageID: m.ExternalID,
			ID: a.ID, Name: a.Name, Kind: a.Kind, URL: a.URL, Raw: raw}
		return ref, true
	}
	return AttachmentRef{}, false
}

// fetchBlocker 是取不到附件的原因：连接器口径同 replyBlocker（只收不发不拦，下载属于收），文案照原型 fetchBlocker；
// incident 为真的是连接器异常，原型里记运行异常，这里记一条 warn 日志。
func (in *inbox) fetchBlocker(ctx context.Context, m Message) (f Fetcher, reason, msg string, incident bool, err error) {
	if m.ConnectorID != "" {
		cn, err := in.c.Connectors().Get(ctx, m.ConnectorID)
		switch {
		case errors.Is(err, plugin.ErrNoRows):
			return nil, "connector_missing", "渠道已删除，取不到附件", false, nil
		case err != nil:
			return nil, "", "", false, err
		}
		switch cn.Status {
		case "error":
			return nil, "connector_error", fmt.Sprintf("连接器「%s」异常，取不到附件；修好连接器后重试", cn.Name), true, nil
		case "paused":
			return nil, "connector_paused", fmt.Sprintf("连接器「%s」已暂停，取不到附件；恢复后重试", cn.Name), false, nil
		case "disconnected":
			return nil, "connector_disconnected", fmt.Sprintf("连接器「%s」已断开，取不到附件；去设置里重新连接", cn.Name), false, nil
		case "connecting":
			return nil, "connector_connecting", fmt.Sprintf("连接器「%s」正在连接，连上后重试", cn.Name), false, nil
		}
	}
	a := in.adapterFor(m)
	if a == nil {
		return nil, "no_adapter", fmt.Sprintf("渠道 %s 没有可用的适配器，取不到附件", m.Channel), false, nil
	}
	fe, ok := a.(Fetcher)
	if !ok {
		return nil, "unsupported", fmt.Sprintf("渠道 %s 不支持获取附件", m.Channel), false, nil
	}
	return fe, "", "", false, nil
}

// fetch 下载一个附件。成功 200 回整条消息；被拦 409（带 reason）、渠道下载失败 502 fetch_failed，两种都把原因记在附件上。
// 已获取且本机文件还在的不重新下载；文件被删了的重新下载到原来的路径。
func (in *inbox) fetch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	m, err := in.get(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	attID := r.PathValue("attachment_id")
	ref, ok := findAttachment(m, attID)
	if !ok {
		fail(w, r, in.c, apiErr(errNotFound, "attachment %s is not in message %s", attID, m.ID))
		return
	}
	if ref.Kind == "link" {
		fail(w, r, in.c, blocked("link", "链接不用获取，直接加进资料"))
		return
	}
	base := in.c.AttachmentDir()
	if base == "" || !keyRe.MatchString(m.Channel) {
		fail(w, r, in.c, blocked("no_storage", "附件目录没有配置，取不到附件"))
		return
	}

	in.fetchMu.Lock()
	defer in.fetchMu.Unlock()
	var prev attState
	err = in.c.Store().QueryRow(ctx, `SELECT status, local_path FROM im_attachments WHERE message_id = ? AND attachment_id = ?`,
		m.ID, attID).Scan(&prev.status, &prev.local)
	if err != nil && !errors.Is(err, plugin.ErrNoRows) {
		fail(w, r, in.c, err)
		return
	}
	if prev.status == "done" {
		if fi, err := os.Stat(prev.local); err == nil && fi.Mode().IsRegular() {
			in.respond(w, r, m.ID)
			return
		}
	}

	fe, reason, msg, incident, err := in.fetchBlocker(ctx, m)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if fe == nil {
		if incident {
			in.c.Log().Warn("im attachment fetch blocked", "message", m.ID, "attachment", attID, "connector", m.ConnectorID, "reason", reason)
		}
		if err := in.markFailed(ctx, m.ID, attID, prev.local, msg); err != nil {
			fail(w, r, in.c, err)
			return
		}
		fail(w, r, in.c, blocked(reason, msg))
		return
	}
	if sz := metaSize(ref.Raw); sz > maxAttachment {
		msg := fmt.Sprintf("附件 %s，超过 %s 的上限", humanSize(sz), humanSize(maxAttachment))
		if err := in.markFailed(ctx, m.ID, attID, prev.local, msg); err != nil {
			fail(w, r, in.c, err)
			return
		}
		fail(w, r, in.c, blocked("too_large", msg))
		return
	}

	dir := filepath.Join(base, m.Channel)
	target := prev.local
	if target == "" {
		if target, err = in.pickPath(ctx, dir, safeName(ref.Name)); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	fetchCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	size, fetchErr := save(fetchCtx, fe, ref, dir, target)
	cancel()
	if fetchErr != nil {
		reason := clip(fetchErr.Error(), maxFetchError)
		in.c.Log().Warn("im attachment fetch failed", "message", m.ID, "attachment", attID, "adapter", fe.Key(), "err", fetchErr)
		if err := in.markFailed(ctx, m.ID, attID, target, reason); err != nil {
			fail(w, r, in.c, err)
			return
		}
		fail(w, r, in.c, &actionError{status: http.StatusBadGateway, code: "fetch_failed", msg: "获取失败：" + reason})
		return
	}
	now := in.clock().UTC().Format(timeLayout)
	if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_attachments (message_id, attachment_id, status, local_path, size, error, fetched_at, updated_at)
		VALUES (?, ?, 'done', ?, ?, '', ?, ?)
		ON CONFLICT (message_id, attachment_id) DO UPDATE SET status = 'done', local_path = excluded.local_path, size = excluded.size,
		  error = '', fetched_at = excluded.fetched_at, updated_at = excluded.updated_at`,
		m.ID, attID, target, size, now, now); err != nil {
		fail(w, r, in.c, err)
		return
	}
	in.respond(w, r, m.ID)
}

func (in *inbox) respond(w http.ResponseWriter, r *http.Request, id string) {
	m, err := in.get(r.Context(), id)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": m})
}

// markFailed 记失败和原因；之前占的路径留着，重试时还下到那里。
func (in *inbox) markFailed(ctx context.Context, mid, aid, local, reason string) error {
	now := in.clock().UTC().Format(timeLayout)
	_, err := in.c.Store().Exec(ctx, `INSERT INTO im_attachments (message_id, attachment_id, status, local_path, error, updated_at)
		VALUES (?, ?, 'error', ?, ?, ?)
		ON CONFLICT (message_id, attachment_id) DO UPDATE SET status = 'error', error = excluded.error, updated_at = excluded.updated_at`,
		mid, aid, local, reason, now)
	return err
}

// pickPath 在渠道目录里挑一个没被占的文件名：同名的加「 (2)」「 (3)」，本机已有的文件和别的附件占着的都算占用。
func (in *inbox) pickPath(ctx context.Context, dir, name string) (string, error) {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; i <= 1000; i++ {
		cand := name
		if i > 1 {
			cand = safeName(fmt.Sprintf("%s (%d)%s", stem, i, ext))
		}
		p := filepath.Join(dir, cand)
		if _, err := os.Lstat(p); err == nil {
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		var n int
		if err := in.c.Store().QueryRow(ctx, `SELECT count(*) FROM im_attachments WHERE local_path = ?`, p).Scan(&n); err != nil {
			return "", err
		}
		if n == 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("no free file name for %s in %s", name, dir)
}

// save 经适配器下载，先写临时文件、读完且没超上限再改名到 target，失败不留半截文件。
func save(ctx context.Context, fe Fetcher, ref AttachmentRef, dir, target string) (int64, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return 0, fmt.Errorf("建附件目录失败：%w", err)
	}
	rc, err := fe.Fetch(ctx, ref)
	if err != nil {
		return 0, err
	}
	defer func() { _ = rc.Close() }()
	tmp, err := os.CreateTemp(dir, ".fetch-*")
	if err != nil {
		return 0, fmt.Errorf("写附件失败：%w", err)
	}
	tmpName := tmp.Name()
	n, err := io.Copy(tmp, io.LimitReader(rc, maxAttachment+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > maxAttachment {
		err = fmt.Errorf("附件超过 %s 的上限", humanSize(maxAttachment))
	}
	if err == nil {
		err = os.Rename(tmpName, target)
	}
	if err != nil {
		_ = os.Remove(tmpName)
		return 0, err
	}
	return n, nil
}

// safeName 是落盘用的文件名：路径分隔符、冒号换成下划线，控制字符和不可见的格式字符（含 RTL 改向）去掉，
// 开头的点去掉（不生成隐藏文件），首尾空白和结尾的点去掉，超长时保留扩展名截断。结果再过一遍不变。
func safeName(name string) string {
	name = strings.ToValidUTF8(name, "_")
	var b strings.Builder
	for _, r := range name {
		switch {
		case r == '/' || r == '\\' || r == ':':
			b.WriteRune('_')
		case unicode.IsControl(r) || unicode.Is(unicode.Cf, r):
		default:
			b.WriteRune(r)
		}
	}
	s := strings.TrimLeft(strings.TrimSpace(b.String()), ".")
	s = strings.TrimRight(strings.TrimSpace(s), ". ")
	if len(s) > maxFileNameByte {
		ext := filepath.Ext(s)
		if len(ext) > 20 {
			ext = ""
		}
		s = truncBytes(strings.TrimSuffix(s, ext), maxFileNameByte-len(ext)) + ext
		s = strings.TrimRight(strings.TrimSpace(s), ". ")
	}
	if s == "" {
		return defaultFileName
	}
	return s
}

// truncBytes 按字节截断，不切开多字节字符。
func truncBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func metaSize(raw json.RawMessage) int64 {
	var a struct {
		Size json.Number `json:"size"`
	}
	if json.Unmarshal(raw, &a) != nil {
		return 0
	}
	n, _ := a.Size.Int64()
	return n
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MB"
	case n >= 1<<10:
		return strconv.FormatFloat(float64(n)/(1<<10), 'f', 1, 64) + " KB"
	}
	return strconv.FormatInt(n, 10) + " B"
}

// AttachmentsInfo 是 GET /api/im/attachments：附件目录和大小上限，前端据此认出项目资料里哪些文件是消息附件。
func (in *inbox) attachmentsInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"dir": in.c.AttachmentDir(), "max_bytes": maxAttachment}})
}

// download 读已获取的附件内容：只认附件目录里、登记为已获取的文件，名字不规整、越界、是链接的一律 404。
// 一律按下载给（Content-Disposition: attachment），加 nosniff 和 sandbox，HTML 之类不会在本站打开执行。
func (in *inbox) download(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ch, name := r.PathValue("channel"), r.PathValue("name")
	base := in.c.AttachmentDir()
	notFound := func() { fail(w, r, in.c, apiErr(errNotFound, "attachment file %s/%s not found", ch, name)) }
	if base == "" || !keyRe.MatchString(ch) || name == "" || safeName(name) != name {
		notFound()
		return
	}
	p := filepath.Join(base, ch, name)
	if filepath.Dir(p) != filepath.Join(base, ch) {
		notFound()
		return
	}
	var n int
	if err := in.c.Store().QueryRow(ctx, `SELECT count(*) FROM im_attachments WHERE local_path = ? AND status = 'done'`, p).Scan(&n); err != nil {
		fail(w, r, in.c, err)
		return
	}
	if n == 0 {
		notFound()
		return
	}
	// 软链指出去的不给读：真实路径也得在附件目录里
	realBase, err1 := filepath.EvalSymlinks(base)
	real, err2 := filepath.EvalSymlinks(p)
	if err1 != nil || err2 != nil || filepath.Dir(real) != filepath.Join(realBase, ch) {
		notFound()
		return
	}
	f, err := os.Open(real)
	if err != nil {
		notFound()
		return
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		notFound()
		return
	}
	ct := mime.TypeByExtension(filepath.Ext(name))
	if ct == "" {
		ct = "application/octet-stream"
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox")
	h.Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, "", fi.ModTime(), f)
}
