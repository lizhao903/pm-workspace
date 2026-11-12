// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// 附件获取用的环境：在 setupActions 上接好数据目录，再加一个异常的连接器
func setupAttachments(t *testing.T) (actEnv, string) {
	t.Helper()
	e := setupActions(t)
	dataDir := t.TempDir()
	e.r.DataDir = dataDir
	exec(t, e.st.DB(), `INSERT INTO connectors (id, tool, name, status, direction, created_at, updated_at) VALUES
	  ('cn_err', 'slack', 'Slack 坏了', 'error', 'both', 'x', 'x')`)
	return e, filepath.Join(dataDir, "attachments", "slack")
}

// att 从消息里按 id 取附件
func att(t *testing.T, m map[string]any, id string) map[string]any {
	t.Helper()
	for _, x := range m["attachments"].([]any) {
		if a := x.(map[string]any); a["id"] == id {
			return a
		}
	}
	t.Fatalf("消息里没有附件 %s：%v", id, m["attachments"])
	return nil
}

func get(t *testing.T, e actEnv, path string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	return w
}

func TestFetchAttachment(t *testing.T) {
	e, dir := setupAttachments(t)
	id := e.push(t, "fake", `{"external_id":"C01:1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product",
	  "sender_id":"U04LIN","text":"清单在附件",
	  "attachments":[{"id":"att1","name":"../权限点清单 v2.xlsx","kind":"file","size":48213,"fetch":"done","local":"/etc/passwd"},
	    {"id":"att2","name":"PRD 评论区","kind":"link","url":"https://example.com/prd"},
	    {"name":"没有 id.png","kind":"image"}]}`)

	// 到达时：文件是未获取，渠道带来的 fetch、local 不算；链接没有获取状态；没 id 的补上 att_
	_, out := call(t, e.h, "GET", "/api/im/messages/"+id, "")
	m := data(out)
	if a := att(t, m, "att1"); a["fetch"] != "idle" || a["local"] != nil || a["size"] != float64(48213) {
		t.Fatalf("到达时的文件附件：%v", a)
	}
	if a := att(t, m, "att2"); a["fetch"] != nil || a["url"] != "https://example.com/prd" {
		t.Fatalf("链接附件：%v", a)
	}
	third := m["attachments"].([]any)[2].(map[string]any)
	if s, _ := third["id"].(string); !strings.HasPrefix(s, "att_") || third["fetch"] != "idle" {
		t.Fatalf("没有 id 的附件要补上：%v", third)
	}

	// 获取：文件落到 attachments/slack/，名字去掉路径分隔符，状态已获取
	code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/attachments/att1/fetch", "")
	if code != 200 {
		t.Fatalf("获取：%d %v", code, out)
	}
	a := att(t, data(out), "att1")
	want := filepath.Join(dir, "_权限点清单 v2.xlsx")
	if a["fetch"] != "done" || a["local"] != want || a["error"] != nil {
		t.Fatalf("获取后：%v", a)
	}
	body, err := os.ReadFile(want)
	if err != nil || !strings.Contains(string(body), "att1") {
		t.Fatalf("本机文件：%q %v", body, err)
	}
	if a["size"] != float64(len(body)) {
		t.Fatalf("size 取实际下载的字节数：%v", a["size"])
	}
	refs := e.fake.Fetched()
	if len(refs) != 1 || refs[0].MessageID != "C01:1" || refs[0].ConnectorID != "cn_ok" || refs[0].ConversationID != "C01" || len(refs[0].Raw) == 0 {
		t.Fatalf("经适配器下载：%+v", refs)
	}
	// 内容经插件自己的接口读
	w := get(t, e, a["download_url"].(string))
	if w.Code != 200 || w.Body.String() != string(body) || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment") ||
		w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("读附件：%d %v %q", w.Code, w.Header(), w.Body.String())
	}

	// 已获取的不再下载；本机文件删了重新下到原路径
	call(t, e.h, "POST", "/api/im/messages/"+id+"/attachments/att1/fetch", "")
	if len(e.fake.Fetched()) != 1 {
		t.Fatalf("已获取的不该重复下载：%d", len(e.fake.Fetched()))
	}
	_ = os.Remove(want)
	code, out = call(t, e.h, "POST", "/api/im/messages/"+id+"/attachments/att1/fetch", "")
	if code != 200 || att(t, data(out), "att1")["local"] != want || len(e.fake.Fetched()) != 2 {
		t.Fatalf("文件删了重新下载：%d %v", code, out)
	}

	// 别的消息里同名附件不覆盖，加序号
	id2 := e.push(t, "fake", `{"external_id":"C01:2","connector_id":"cn_recv","conversation_id":"C01","sender_id":"U04LIN",
	  "attachments":[{"id":"x","name":"_权限点清单 v2.xlsx","kind":"file"}]}`)
	code, out = call(t, e.h, "POST", "/api/im/messages/"+id2+"/attachments/x/fetch", "")
	if a := att(t, data(out), "x"); code != 200 || a["local"] != filepath.Join(dir, "_权限点清单 v2 (2).xlsx") {
		t.Fatalf("同名加序号（只收不发的连接器也能取）：%d %v", code, out)
	}

	// 链接不用获取；附件不存在 404；消息不存在 404
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/attachments/att2/fetch", ""); code != 409 || errOf(out)["reason"] != "link" {
		t.Fatalf("链接：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/messages/"+id+"/attachments/nope/fetch", ""); code != 404 {
		t.Fatalf("附件不存在应 404：%d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/messages/msg_none/attachments/att1/fetch", ""); code != 404 {
		t.Fatalf("消息不存在应 404：%d", code)
	}

	// 附件目录
	_, out = call(t, e.h, "GET", "/api/im/attachments", "")
	if d := data(out); d["dir"] != filepath.Dir(dir) || d["max_bytes"] != float64(maxAttachment) {
		t.Fatalf("附件目录：%v", out)
	}
}

func TestFetchAttachmentBlocked(t *testing.T) {
	e, dir := setupAttachments(t)
	for _, c := range []struct{ adapter, connector, reason, msg string }{
		{"fake", "cn_err", "connector_error", "连接器「Slack 坏了」异常，取不到附件；修好连接器后重试"},
		{"fake", "cn_paused", "connector_paused", "连接器「Slack 备用」已暂停，取不到附件；恢复后重试"},
		{"fake", "cn_gone", "connector_missing", "渠道已删除，取不到附件"},
		{"tg", "", "unsupported", "渠道 telegram 不支持获取附件"},
	} {
		mid := e.push(t, c.adapter, `{"external_id":"`+c.reason+`","connector_id":"`+c.connector+`","conversation_id":"C01","sender_id":"U04LIN",
		  "attachments":[{"id":"a1","name":"合同.docx","kind":"file"}]}`)
		code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/attachments/a1/fetch", "")
		if er := errOf(out); code != 409 || er["code"] != "conflict" || er["reason"] != c.reason || er["message"] != c.msg {
			t.Errorf("%s：%d %v", c.reason, code, out)
			continue
		}
		// 状态是失败，原因记在附件上
		_, out = call(t, e.h, "GET", "/api/im/messages/"+mid, "")
		if a := att(t, data(out), "a1"); a["fetch"] != "error" || a["error"] != c.msg || a["local"] != nil {
			t.Errorf("%s 失败要记下：%v", c.reason, a)
		}
	}
	if len(e.fake.Fetched()) != 0 {
		t.Fatalf("被拦的不该去渠道下载：%d", len(e.fake.Fetched()))
	}

	// 渠道下载失败：502，原因记下，不留半截文件；恢复后重试成功、原因清掉
	mid := e.push(t, "fake", `{"external_id":"C01:9","connector_id":"cn_ok","conversation_id":"C01","sender_id":"U04LIN",
	  "attachments":[{"id":"a1","name":"合同.docx","kind":"file"}]}`)
	e.fake.FailFetches("file_not_found")
	code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/attachments/a1/fetch", "")
	if er := errOf(out); code != 502 || er["code"] != "fetch_failed" || er["message"] != "获取失败：file_not_found" {
		t.Fatalf("下载失败：%d %v", code, out)
	}
	_, out = call(t, e.h, "GET", "/api/im/messages/"+mid, "")
	if a := att(t, data(out), "a1"); a["fetch"] != "error" || a["error"] != "file_not_found" {
		t.Fatalf("下载失败要记下：%v", a)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("失败不该留文件：%v", ents)
	}
	e.fake.FailFetches("")
	code, out = call(t, e.h, "POST", "/api/im/messages/"+mid+"/attachments/a1/fetch", "")
	if a := att(t, data(out), "a1"); code != 200 || a["fetch"] != "done" || a["error"] != nil || a["local"] != filepath.Join(dir, "合同.docx") {
		t.Fatalf("重试成功：%d %v", code, out)
	}

	// 没接数据目录：409 no_storage，不记失败
	e.r.DataDir = ""
	mid = e.push(t, "fake", `{"external_id":"C01:10","conversation_id":"C01","sender_id":"U04LIN","attachments":[{"id":"a1","name":"x.txt","kind":"file"}]}`)
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/attachments/a1/fetch", ""); code != 409 || errOf(out)["reason"] != "no_storage" {
		t.Fatalf("没有附件目录：%d %v", code, out)
	}
	_, out = call(t, e.h, "GET", "/api/im/messages/"+mid, "")
	if a := att(t, data(out), "a1"); a["fetch"] != "idle" {
		t.Fatalf("没有附件目录不算渠道失败：%v", a)
	}
}

func TestFetchAttachmentTooLarge(t *testing.T) {
	e, dir := setupAttachments(t)
	old := maxAttachment
	maxAttachment = 16
	t.Cleanup(func() { maxAttachment = old })

	// 元数据就超了：不下载，409 too_large
	mid := e.push(t, "fake", `{"external_id":"C01:1","conversation_id":"C01","sender_id":"U04LIN","attachments":[{"id":"a1","name":"大.zip","kind":"file","size":4096}]}`)
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/attachments/a1/fetch", ""); code != 409 || errOf(out)["reason"] != "too_large" {
		t.Fatalf("元数据超限：%d %v", code, out)
	}
	// 实际内容超了：502，原因记下，不留文件
	e.fake.SetFetchBody([]byte(strings.Repeat("x", 17)))
	mid = e.push(t, "fake", `{"external_id":"C01:2","conversation_id":"C01","sender_id":"U04LIN","attachments":[{"id":"a1","name":"大.zip","kind":"file"}]}`)
	code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/attachments/a1/fetch", "")
	if code != 502 || !strings.Contains(errOf(out)["message"].(string), "上限") {
		t.Fatalf("内容超限：%d %v", code, out)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("超限不该留文件：%v", ents)
	}
	// 正好在上限内的能下
	e.fake.SetFetchBody([]byte(strings.Repeat("x", 16)))
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/attachments/a1/fetch", ""); code != 200 {
		t.Fatalf("上限以内：%d %v", code, out)
	}
}

func TestDownloadAttachmentConfined(t *testing.T) {
	e, dir := setupAttachments(t)
	mid := e.push(t, "fake", `{"external_id":"C01:1","conversation_id":"C01","sender_id":"U04LIN","attachments":[{"id":"a1","name":"page.html","kind":"file"}]}`)
	e.fake.SetFetchBody([]byte("<script>alert(1)</script>"))
	code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/attachments/a1/fetch", "")
	if code != 200 {
		t.Fatalf("获取：%d %v", code, out)
	}
	if w := get(t, e, "/api/im/attachments/slack/page.html"); w.Code != 200 || w.Header().Get("Content-Security-Policy") != "sandbox" ||
		!strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("HTML 附件按下载给：%d %v", w.Code, w.Header())
	}
	// 预览要 inline：HTML 不行，照旧下载、带沙箱
	if w := get(t, e, "/api/im/attachments/slack/page.html?inline=1"); w.Code != 200 || w.Header().Get("Content-Security-Policy") != "sandbox" ||
		!strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("HTML 不能 inline：%d %v", w.Code, w.Header())
	}

	// 附件目录里没登记的文件、越界的路径、库文件都不给读
	if err := os.WriteFile(filepath.Join(dir, "手放的.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(filepath.Dir(dir)), "pm.db"), []byte("db"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{
		"/api/im/attachments/slack/" + "%E6%89%8B%E6%94%BE%E7%9A%84.txt",
		"/api/im/attachments/slack/..%2F..%2Fpm.db",
		"/api/im/attachments/slack/.fetch-1",
		"/api/im/attachments/Slack/page.html",
		"/api/im/attachments/telegram/page.html",
	} {
		if w := get(t, e, p); w.Code != 404 {
			t.Errorf("%s 应 404：%d %q", p, w.Code, w.Body.String())
		}
	}

	// 登记过的文件被换成指向外面的软链：不给读
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(dir, "page.html")
	_ = os.Remove(local)
	if err := os.Symlink(outside, local); err != nil {
		t.Fatal(err)
	}
	if w := get(t, e, "/api/im/attachments/slack/page.html"); w.Code != 404 {
		t.Fatalf("软链指出去应 404：%d %q", w.Code, w.Body.String())
	}
}

func TestSafeName(t *testing.T) {
	long := strings.Repeat("长", 100) + ".pdf"
	for in, want := range map[string]string{
		"权限点清单 v2.xlsx":      "权限点清单 v2.xlsx",
		"../../etc/passwd":   "_.._etc_passwd",
		`a\b:c.txt`:          "a_b_c.txt",
		"bad\x00\x1f\n名.txt": "bad名.txt",
		"evil‮gpj.exe":       "evilgpj.exe",
		".env":               "env",
		"  ...  ":            defaultFileName,
		"":                   defaultFileName,
		"末尾点.":               "末尾点",
		"\xff\xfe.bin":       "_.bin",
	} {
		if got := safeName(in); got != want {
			t.Errorf("safeName(%q) = %q，应为 %q", in, got, want)
		}
	}
	got := safeName(long)
	if len(got) > maxFileNameByte || !strings.HasSuffix(got, ".pdf") || !utf8.ValidString(got) {
		t.Errorf("超长名字截断后：%d 字节 %q", len(got), got)
	}
	for _, s := range []string{long, "../../etc/passwd", "a (2).txt", " x "} {
		if once := safeName(s); safeName(once) != once {
			t.Errorf("safeName 再过一遍要不变：%q", s)
		}
	}
}

// 预览（?inline=1）：位图、PDF、音视频按 inline 回；PDF 不加沙箱（Chrome 的阅读器在沙箱里打不开），图片照旧带沙箱；SVG 只下载
func TestDownloadAttachmentInline(t *testing.T) {
	e, _ := setupAttachments(t)
	for i, name := range []string{"截屏.png", "合同.pdf", "图.svg"} {
		mid := e.push(t, "fake", fmt.Sprintf(`{"external_id":"C01:%d","conversation_id":"C01","sender_id":"U04LIN","attachments":[{"id":"a1","name":%q,"kind":"file"}]}`, i+1, name))
		e.fake.SetFetchBody([]byte("x"))
		if code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/attachments/a1/fetch", ""); code != 200 {
			t.Fatalf("获取 %s：%d %v", name, code, out)
		}
	}
	png := get(t, e, "/api/im/attachments/slack/"+url.PathEscape("截屏.png")+"?inline=1")
	if !strings.HasPrefix(png.Header().Get("Content-Disposition"), "inline") || png.Header().Get("Content-Security-Policy") != "sandbox" {
		t.Fatalf("png 预览：%v", png.Header())
	}
	if d := get(t, e, "/api/im/attachments/slack/"+url.PathEscape("截屏.png")); !strings.HasPrefix(d.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("不带 inline 照旧下载：%v", d.Header())
	}
	pdf := get(t, e, "/api/im/attachments/slack/"+url.PathEscape("合同.pdf")+"?inline=1")
	if !strings.HasPrefix(pdf.Header().Get("Content-Disposition"), "inline") || pdf.Header().Get("Content-Security-Policy") != "" {
		t.Fatalf("pdf 预览：%v", pdf.Header())
	}
	svg := get(t, e, "/api/im/attachments/slack/"+url.PathEscape("图.svg")+"?inline=1")
	if !strings.HasPrefix(svg.Header().Get("Content-Disposition"), "attachment") || svg.Header().Get("Content-Security-Policy") != "sandbox" {
		t.Fatalf("svg 只能下载：%v", svg.Header())
	}
}
