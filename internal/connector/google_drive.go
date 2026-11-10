// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

// Google Drive 连接器（CONN-01e1）：只读，范围 drive.readonly。工具：搜文件、列目录、取文件信息、读文档正文。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// GoogleDriveTool 是 Google Drive 连接器的 key，同原型 gdrive。
const GoogleDriveTool = "gdrive"

const (
	driveScope       = "https://www.googleapis.com/auth/drive.readonly"
	driveFileFields  = "id,name,mimeType,parents,modifiedTime,size,shared,webViewLink,owners(displayName,emailAddress)"
	drivePageDefault = 20
	drivePageMax     = 100
	driveReadDefault = 20000
	driveReadMax     = 100000
)

var driveIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`)

// driveTools 是 Drive 的工具目录，全部只读。
func driveTools() []ToolDef {
	return []ToolDef{
		{Name: "search_files", Desc: "按名称和内容搜文件，参数 {query, page_size?, page_token?}", Write: false},
		{Name: "list_folder", Desc: "列出一个文件夹里的文件，参数 {folder_id?（默认我的云端硬盘）, page_size?, page_token?}", Write: false},
		{Name: "get_file", Desc: "取一个文件的信息，参数 {file_id}", Write: false},
		{Name: "read_file", Desc: "读文档、表格、幻灯片或文本文件的正文，参数 {file_id, max_chars?}", Write: false},
	}
}

// GoogleDrive 是 Google Drive 连接器的定义。e 为零值时用正式的 Google 地址，测试传本机假服务的地址。
func GoogleDrive(e GoogleEndpoints) Def {
	e = e.withDefaults()
	return Def{
		Tool: GoogleDriveTool, Label: "Google Drive", Category: "docs", Color: "#0f9d58",
		Desc: "搜文件、读文档内容（只读）", Auth: []AuthMode{AuthOAuth2},
		Fields: googleFields(),
		OAuth:  googleOAuth(e, driveScope),
		Tools:  driveTools(),
		Test:   googleTest(e),
		Call: func(ctx context.Context, cfg Config, tool string, args json.RawMessage) (string, error) {
			return driveCall(ctx, e, cfg, tool, args)
		},
	}
}

type driveArgs struct {
	Query     string `json:"query"`
	FolderID  string `json:"folder_id"`
	FileID    string `json:"file_id"`
	PageSize  int    `json:"page_size"`
	PageToken string `json:"page_token"`
	MaxChars  int    `json:"max_chars"`
}

type driveOwner struct {
	DisplayName  string `json:"displayName"`
	EmailAddress string `json:"emailAddress"`
}

// driveFile 是 Drive 返回的文件信息；回给模型时换成 driveFileOut 的下划线命名。
type driveFile struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	MimeType     string       `json:"mimeType"`
	Parents      []string     `json:"parents"`
	ModifiedTime string       `json:"modifiedTime"`
	Size         string       `json:"size"`
	Shared       bool         `json:"shared"`
	WebViewLink  string       `json:"webViewLink"`
	Owners       []driveOwner `json:"owners"`
}

type driveFileOut struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	MimeType     string   `json:"mime_type"`
	Parents      []string `json:"parents,omitempty"`
	ModifiedTime string   `json:"modified_time,omitempty"`
	Size         string   `json:"size,omitempty"`
	Shared       bool     `json:"shared"`
	WebViewLink  string   `json:"web_view_link,omitempty"`
	Owners       []string `json:"owners,omitempty"`
}

func (f driveFile) out() driveFileOut {
	o := driveFileOut{ID: f.ID, Name: f.Name, MimeType: f.MimeType, Parents: f.Parents, ModifiedTime: f.ModifiedTime,
		Size: f.Size, Shared: f.Shared, WebViewLink: f.WebViewLink}
	for _, w := range f.Owners {
		name := w.DisplayName
		if w.EmailAddress != "" {
			name = strings.TrimSpace(name + " <" + w.EmailAddress + ">")
		}
		o.Owners = append(o.Owners, name)
	}
	return o
}

// driveQuote 把文本放进 Drive 查询语句的单引号里。
func driveQuote(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
}

func driveCall(ctx context.Context, e GoogleEndpoints, cfg Config, tool string, raw json.RawMessage) (string, error) {
	var a driveArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		return "", fmt.Errorf("参数不是合法的 JSON 对象：%w", err)
	}
	var out any
	var err error
	switch tool {
	case "search_files":
		q := strings.TrimSpace(a.Query)
		if q == "" {
			return "", errors.New("query 必填")
		}
		out, err = driveList(ctx, e, cfg, fmt.Sprintf("(name contains %s or fullText contains %s) and trashed = false",
			driveQuote(q), driveQuote(q)), a)
	case "list_folder":
		id := a.FolderID
		if id == "" {
			id = "root"
		}
		if !driveIDRe.MatchString(id) {
			return "", errors.New("folder_id 不合法")
		}
		out, err = driveList(ctx, e, cfg, driveQuote(id)+" in parents and trashed = false", a)
	case "get_file":
		var f *driveFile
		if f, err = driveGetFile(ctx, e, cfg, a.FileID); err == nil {
			out = f.out()
		}
	case "read_file":
		out, err = driveRead(ctx, e, cfg, a)
	default:
		return "", fmt.Errorf("unknown tool %s", tool)
	}
	if err != nil {
		return "", err
	}
	// 结果给模型看，< > & 不转义
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

func driveList(ctx context.Context, e GoogleEndpoints, cfg Config, query string, a driveArgs) (any, error) {
	size := a.PageSize
	if size <= 0 {
		size = drivePageDefault
	}
	size = min(size, drivePageMax)
	q := url.Values{"q": {query}, "pageSize": {fmt.Sprint(size)}, "orderBy": {"modifiedTime desc"},
		"fields": {"nextPageToken,files(" + driveFileFields + ")"}, "supportsAllDrives": {"true"},
		"includeItemsFromAllDrives": {"true"}}
	if a.PageToken != "" {
		q.Set("pageToken", a.PageToken)
	}
	var res struct {
		NextPageToken string      `json:"nextPageToken"`
		Files         []driveFile `json:"files"`
	}
	if err := googleGet(ctx, cfg, e.DriveAPI+"/files", q, &res); err != nil {
		return nil, err
	}
	files := make([]driveFileOut, 0, len(res.Files))
	for _, f := range res.Files {
		files = append(files, f.out())
	}
	out := map[string]any{"files": files}
	if res.NextPageToken != "" {
		out["next_page_token"] = res.NextPageToken
	}
	return out, nil
}

func driveGetFile(ctx context.Context, e GoogleEndpoints, cfg Config, id string) (*driveFile, error) {
	if !driveIDRe.MatchString(id) {
		return nil, errors.New("file_id 必填且只能是字母、数字、- 和 _")
	}
	var f driveFile
	q := url.Values{"fields": {driveFileFields}, "supportsAllDrives": {"true"}}
	if err := googleGet(ctx, cfg, e.DriveAPI+"/files/"+id, q, &f); err != nil {
		return nil, err
	}
	return &f, nil
}

// driveExports 是 Google 原生文档导出正文用的格式；表格只导出第一个工作表。
var driveExports = map[string]string{
	"application/vnd.google-apps.document":     "text/plain",
	"application/vnd.google-apps.spreadsheet":  "text/csv",
	"application/vnd.google-apps.presentation": "text/plain",
}

func isTextMime(m string) bool {
	return strings.HasPrefix(m, "text/") || m == "application/json" || m == "application/xml" ||
		strings.HasSuffix(m, "+json") || strings.HasSuffix(m, "+xml")
}

func driveRead(ctx context.Context, e GoogleEndpoints, cfg Config, a driveArgs) (any, error) {
	f, err := driveGetFile(ctx, e, cfg, a.FileID)
	if err != nil {
		return nil, err
	}
	var (
		body   []byte
		format = f.MimeType
	)
	if exp, ok := driveExports[f.MimeType]; ok {
		format = exp
		body, err = googleFetch(ctx, cfg, e.DriveAPI+"/files/"+f.ID+"/export", url.Values{"mimeType": {exp}}, nil)
	} else if isTextMime(f.MimeType) {
		body, err = googleFetch(ctx, cfg, e.DriveAPI+"/files/"+f.ID,
			url.Values{"alt": {"media"}, "supportsAllDrives": {"true"}}, nil)
	} else {
		return nil, fmt.Errorf("「%s」是 %s，读不了正文：只支持 Google 文档、表格、幻灯片和文本文件", f.Name, f.MimeType)
	}
	if err != nil {
		return nil, err
	}
	limit := a.MaxChars
	if limit <= 0 {
		limit = driveReadDefault
	}
	limit = min(limit, driveReadMax)
	text := strings.ToValidUTF8(string(body), "")
	truncated := utf8.RuneCountInString(text) > limit
	if truncated {
		text = string([]rune(text)[:limit])
	}
	return map[string]any{"id": f.ID, "name": f.Name, "mime_type": f.MimeType, "format": format,
		"content": text, "truncated": truncated}, nil
}
