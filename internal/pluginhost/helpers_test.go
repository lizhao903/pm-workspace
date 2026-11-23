// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 测试公共夹具：临时内核库、外部插件状态表、测试包目录、tar.gz 构造、fake 插件客户端。

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
)

// externalPluginsDDL 与 internal/db/migrations/0059_external_plugins.sql 保持一致
// （A2 负责迁移文件；A1 的测试自己建表，不依赖 0059 是否已合入）。
const externalPluginsDDL = `
CREATE TABLE IF NOT EXISTS external_plugins (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL, source_ref TEXT NOT NULL, package_sha256 TEXT NOT NULL DEFAULT '',
  install_dir TEXT NOT NULL, manifest TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]', granted TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  previous_version TEXT NOT NULL DEFAULT '', previous_install_dir TEXT NOT NULL DEFAULT '',
  previous_manifest TEXT NOT NULL DEFAULT '', previous_permissions TEXT NOT NULL DEFAULT '[]',
  previous_granted TEXT NOT NULL DEFAULT '[]', previous_package_sha256 TEXT NOT NULL DEFAULT '',
  previous_source_type TEXT NOT NULL DEFAULT '', previous_source_ref TEXT NOT NULL DEFAULT '',
  publisher_id TEXT NOT NULL DEFAULT '', publisher_verified INTEGER NOT NULL DEFAULT 0
);`

// objectsDDL 是 broker 测试用的最小对象表（真实 schema 见 internal/db/migrations/0001_init.sql）。
const objectsDDL = `
CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY, type_id TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT '',
  props TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT
);`

// newTestDB 建一个临时内核库；withObjects 为真时顺带建 objects 表。
func newTestDB(t *testing.T, withObjects bool) *db.DB {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatalf("打开测试库失败：%v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if _, err := d.W.Exec(externalPluginsDDL); err != nil {
		t.Fatalf("建 external_plugins 表失败：%v", err)
	}
	if withObjects {
		if _, err := d.W.Exec(objectsDDL); err != nil {
			t.Fatalf("建 objects 表失败：%v", err)
		}
	}
	return d
}

// newTestHost 建一个测试用宿主（DB 一定有 external_plugins 表）。
func newTestHost(t *testing.T, opts Options) *Host {
	t.Helper()
	if opts.DataDir == "" {
		opts.DataDir = t.TempDir()
	}
	if opts.DB == nil {
		opts.DB = newTestDB(t, false)
	}
	if opts.Version == "" {
		opts.Version = "0.3.0"
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return New(opts)
}

// testManifestObj 返回一份合法清单的 map（平台 entry 用参数指定）。
func testManifestObj(platform, binEntry string) map[string]any {
	return map[string]any{
		"manifest_version": 2,
		"id":               "hello_world",
		"name":             "Hello World",
		"description":      "测试插件",
		"version":          "0.1.0",
		"api":              ">=2.0.0 <3.0.0",
		"pmw":              ">=0.3.0 <1.0.0",
		"license":          "MIT",
		"repository":       "https://github.com/example/hello_world",
		"publisher":        map[string]any{"id": "github:example"},
		"icon":             "assets/icon.svg",
		"provides": map[string]any{
			"modules":     []any{"hello_world"},
			"settings":    []any{"hello_world"},
			"today_cards": []any{"hello_world_tip"},
			"commands":    []any{"hello_world.say_hi"},
		},
		"permissions": []any{"objects:read", "notify"},
		"permissions_reason": map[string]any{
			"objects:read": "在模块页展示最近对象标题，作为只读示例",
			"notify":       "点按钮时发一条演示通知",
		},
		"migrations": "migrations",
		"runtime": map[string]any{
			"backend": map[string]any{
				"kind":     "process",
				"protocol": "pmw-plugin-rpc/1",
				"entry":    map[string]any{platform: binEntry},
			},
			"web": map[string]any{
				"entry":  "web/entry.js",
				"styles": []any{"web/style.css"},
			},
		},
	}
}

// writeTestPackage 在 root 下写一个完整的测试插件包，返回 plugin.json 原文。
func writeTestPackage(t *testing.T, root string, manifest map[string]any) []byte {
	t.Helper()
	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatalf("序列化测试清单失败：%v", err)
	}
	files := map[string][]byte{
		"plugin.json":             manifestJSON,
		"LICENSE":                 []byte("MIT License\n"),
		"bin/hello_world":         []byte("#!/bin/sh\nexit 0\n"),
		"web/entry.js":            []byte("export default {};\n"),
		"web/style.css":           []byte("[data-pmw-plugin=\"hello_world\"]{}\n"),
		"assets/icon.svg":         []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`),
		"migrations/001_init.sql": []byte("CREATE TABLE hello_items (id TEXT PRIMARY KEY, name TEXT NOT NULL);\n"),
	}
	for rel, data := range files {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("创建测试包目录失败：%v", err)
		}
		mode := os.FileMode(0o644)
		if strings.HasPrefix(rel, "bin/") {
			mode = 0o755
		}
		if err := os.WriteFile(full, data, mode); err != nil {
			t.Fatalf("写测试包文件失败：%v", err)
		}
	}
	return manifestJSON
}

// newTestPackageDir 建一个可直接 Resolve 的插件目录。
func newTestPackageDir(t *testing.T) (dir string, manifestJSON []byte) {
	t.Helper()
	dir = t.TempDir()
	manifestJSON = writeTestPackage(t, dir, testManifestObj(platformKey(), "bin/hello_world"))
	return dir, manifestJSON
}

type tarEntry struct {
	name     string
	body     []byte
	mode     int64
	typeflag byte
	linkname string
}

func buildTarGz(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for _, e := range entries {
		flag := e.typeflag
		if flag == 0 {
			flag = tar.TypeReg
		}
		hdr := &tar.Header{
			Name:     e.name,
			Mode:     e.mode,
			Size:     int64(len(e.body)),
			Typeflag: flag,
			Linkname: e.linkname,
		}
		if hdr.Mode == 0 {
			hdr.Mode = 0o644
		}
		if flag != tar.TypeReg {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("写 tar header 失败：%v", err)
		}
		if flag == tar.TypeReg {
			if _, err := tw.Write(e.body); err != nil {
				t.Fatalf("写 tar body 失败：%v", err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("关闭 tar 失败：%v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("关闭 gzip 失败：%v", err)
	}
	return buf.Bytes()
}

// packTestPackage 把插件目录打成 tar.gz（文件都在包根下）。
func packTestPackage(t *testing.T, dir string) []byte {
	t.Helper()
	var entries []tarEntry
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		mode := int64(0o644)
		if info, err := d.Info(); err == nil && info.Mode()&0o111 != 0 {
			mode = 0o755
		}
		entries = append(entries, tarEntry{name: filepath.ToSlash(rel), body: data, mode: mode})
		return nil
	})
	if err != nil {
		t.Fatalf("遍历测试包失败：%v", err)
	}
	return buildTarGz(t, entries)
}

// installTestPlugin 通过 Host.Resolve/Install 装一个测试包。
func installTestPlugin(t *testing.T, h *Host, dir string) Info {
	t.Helper()
	pv, err := h.Resolve(context.Background(), Source{Type: "dir", Path: dir})
	if err != nil {
		t.Fatalf("Resolve 失败：%v", err)
	}
	if !pv.Compatible {
		t.Fatalf("测试包应兼容，checks=%+v", pv.Checks)
	}
	info, err := h.Install(context.Background(), Source{Type: "dir", Path: dir},
		[]string{"objects:read", "notify"})
	if err != nil {
		t.Fatalf("Install 失败：%v", err)
	}
	return info
}

// seedObject 往 objects 表插一行（broker 测试用）。
func seedObject(t *testing.T, d *db.DB, id, typ, title string) {
	t.Helper()
	now := formatStateTime(time.Now())
	_, err := d.W.Exec(`INSERT INTO objects (id, type_id, title, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)`, id, typ, title, now, now)
	if err != nil {
		t.Fatalf("插入测试对象失败：%v", err)
	}
}

// fakePlugin 是测试里的 fake 插件客户端：连 host 的 Unix socket 完成
// hello → welcome → activate → health，并响应宿主后续请求。
type fakePlugin struct {
	t       *testing.T
	proc    *pluginProcess
	helloOK bool
	ready   chan struct{}
	errCh   chan error
	events  chan map[string]any
}

func startFakePlugin(t *testing.T, p *pluginProcess) *fakePlugin {
	f := &fakePlugin{t: t, proc: p, ready: make(chan struct{}), errCh: make(chan error, 8), events: make(chan map[string]any, 8)}
	go f.run()
	return f
}

// waitReady 等 fake 客户端完成 hello/welcome；出错或超时直接失败。
func (f *fakePlugin) waitReady() {
	f.t.Helper()
	select {
	case <-f.ready:
	case err := <-f.errCh:
		f.t.Fatalf("fake 插件握手失败：%v", err)
	case <-time.After(5 * time.Second):
		f.t.Fatal("fake 插件 5s 内没有完成握手")
	}
}

// checkErr 检查 fake 客户端在后台报告的错误。
func (f *fakePlugin) checkErr() {
	f.t.Helper()
	select {
	case err := <-f.errCh:
		f.t.Fatalf("fake 插件报告错误：%v", err)
	default:
	}
}

func (f *fakePlugin) report(format string, args ...any) {
	select {
	case f.errCh <- fmt.Errorf(format, args...):
	default:
	}
}

func (f *fakePlugin) run() {
	conn, err := net.DialTimeout("unix", f.proc.socketPath, 5*time.Second)
	if err != nil {
		f.report("fake 插件连接 socket 失败：%v", err)
		return
	}
	defer conn.Close()
	br := bufio.NewReader(conn)
	writeFrame := func(v any) error {
		data, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = conn.Write(append(data, '\n'))
		return err
	}
	readFrame := func() ([]byte, error) {
		line, err := br.ReadBytes('\n')
		return bytes.TrimSpace(line), err
	}

	hello := map[string]any{
		"jsonrpc": "2.0",
		"id":      "hello-1",
		"method":  "plugin.hello",
		"params": map[string]any{
			"protocol":       ProtocolVersion,
			"plugin_id":      f.proc.id,
			"plugin_version": f.proc.version,
			"token":          f.proc.token,
			"api":            ">=2.0.0 <3.0.0",
			"capabilities":   []string{},
		},
	}
	if err := writeFrame(hello); err != nil {
		f.report("fake 插件发 hello 失败：%v", err)
		return
	}
	frame, err := readFrame()
	if err != nil {
		f.report("fake 插件读 welcome 失败：%v", err)
		return
	}
	var welcome struct {
		ID     json.RawMessage `json:"id"`
		Result struct {
			Protocol string `json:"protocol"`
			Host     struct {
				PMWVersion string `json:"pmw_version"`
				APIVersion string `json:"api_version"`
			} `json:"host"`
			Plugin struct {
				ID      string `json:"id"`
				Version string `json:"version"`
			} `json:"plugin"`
			Limits struct {
				MaxMessageBytes int `json:"max_message_bytes"`
			} `json:"limits"`
			Permissions []string `json:"permissions"`
		} `json:"result"`
		Error *rpcError `json:"error"`
	}
	if err := json.Unmarshal(frame, &welcome); err != nil {
		f.report("fake 插件解析 welcome 失败：%v（%s）", err, frame)
		return
	}
	if welcome.Error != nil {
		f.report("fake 插件收到 welcome 错误：%s", welcome.Error.Message)
		return
	}
	if welcome.Result.Protocol != ProtocolVersion {
		f.report("welcome.protocol 不对：%q", welcome.Result.Protocol)
	}
	if welcome.Result.Host.APIVersion != ExternalAPIVersion {
		f.report("welcome.host.api_version 不对：%q", welcome.Result.Host.APIVersion)
	}
	if welcome.Result.Plugin.ID != f.proc.id {
		f.report("welcome.plugin.id 不对：%q", welcome.Result.Plugin.ID)
	}
	if welcome.Result.Limits.MaxMessageBytes != MaxFrameBytes {
		f.report("welcome.limits.max_message_bytes 不对：%d", welcome.Result.Limits.MaxMessageBytes)
	}
	f.helloOK = true
	close(f.ready)

	for {
		line, err := readFrame()
		if err != nil {
			return
		}
		var probe struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(line, &probe); err != nil {
			f.report("fake 插件收到无法解析的帧：%v", err)
			continue
		}
		if probe.Method == "" {
			continue // 宿主对 fake 插件请求的响应（本测试里 fake 不发请求）
		}
		var result any = map[string]any{"ok": true}
		switch probe.Method {
		case "plugin.activate":
			result = map[string]any{"ok": true}
		case "plugin.health":
			result = map[string]any{"status": "ok", "detail": map[string]any{"plugin": f.proc.id}}
		case "plugin.command.run":
			result = map[string]any{"result": "你好，来自 fake 插件"}
		case "plugin.http.request":
			var p struct {
				RequestID string `json:"request_id"`
				Path      string `json:"path"`
			}
			_ = json.Unmarshal(probe.Params, &p)
			if strings.Contains(p.Path, "stream") {
				// 先回开始帧，再用 host.http.chunk/end 推块。
				if err := writeFrame(map[string]any{
					"jsonrpc": "2.0", "id": probe.ID,
					"result": map[string]any{"stream": true, "status": 200,
						"headers": map[string]string{"content-type": "text/event-stream"}},
				}); err != nil {
					return
				}
				for i, chunk := range []string{"data: one\n\n", "data: two\n\n"} {
					_ = writeFrame(map[string]any{
						"jsonrpc": "2.0", "id": fmt.Sprintf("chunk-%d", i),
						"method": "host.http.chunk",
						"params": map[string]any{
							"request_id": p.RequestID, "seq": i,
							"data_b64": base64.StdEncoding.EncodeToString([]byte(chunk)),
						},
					})
				}
				_ = writeFrame(map[string]any{
					"jsonrpc": "2.0", "id": "end-1", "method": "host.http.end",
					"params": map[string]any{"request_id": p.RequestID, "seq": 2},
				})
				continue
			}
			result = map[string]any{
				"stream": false, "status": 201,
				"headers":  map[string]string{"content-type": "application/json", "x-plugin": "fake"},
				"body_b64": base64.StdEncoding.EncodeToString([]byte(`{"ok":true}`)),
			}
		case "plugin.http.upgrade":
			var p struct {
				StreamID string `json:"stream_id"`
			}
			_ = json.Unmarshal(probe.Params, &p)
			result = map[string]any{"ok": true}
		case "plugin.http.ws_message":
			var p struct {
				StreamID string `json:"stream_id"`
				DataB64  string `json:"data_b64"`
			}
			_ = json.Unmarshal(probe.Params, &p)
			_ = writeFrame(map[string]any{
				"jsonrpc": "2.0", "id": "ws-echo", "method": "host.ws.send",
				"params": map[string]any{"stream_id": p.StreamID, "type": "text", "data_b64": p.DataB64},
			})
			result = map[string]any{"ok": true}
		case "plugin.event.deliver":
			var payload map[string]any
			_ = json.Unmarshal(probe.Params, &payload)
			select {
			case f.events <- payload:
			default:
			}
			result = map[string]any{"ok": true}
		case "plugin.deactivate":
			result = map[string]any{"ok": true}
		default:
			_ = writeFrame(map[string]any{
				"jsonrpc": "2.0",
				"id":      probe.ID,
				"error":   rpcErrorf("method_not_found", "fake 插件未实现 %s", probe.Method),
			})
			continue
		}
		if err := writeFrame(map[string]any{"jsonrpc": "2.0", "id": probe.ID, "result": result}); err != nil {
			return
		}
		if probe.Method == "plugin.deactivate" {
			return
		}
	}
}

// writeTestManifest 只写 plugin.json（给只测 manifest 的场景）。
func writeTestManifest(t *testing.T, dir string, m map[string]any) {
	t.Helper()
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("序列化清单失败：%v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plugin.json"), data, 0o644); err != nil {
		t.Fatalf("写 plugin.json 失败：%v", err)
	}
}
