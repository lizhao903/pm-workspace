// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/recording"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// recordingFixtures 是本机做真转写用的音频和模型；CI 上没有就跳过这条用例。
// 音频是 65 秒中文 TTS（16k 单声道 wav），模型目录里有 whisper.cpp 的 ggml-small.bin。
func recordingFixtures(t *testing.T) (wav, modelDir string) {
	t.Helper()
	wav = "/tmp/whisper-bench/speech16k.wav"
	modelDir = "/tmp/whisper-bench/models"
	if _, err := os.Stat(wav); err != nil {
		t.Skipf("没有测试音频（%s），跳过真转写集成用例", wav)
	}
	if _, err := os.Stat(filepath.Join(modelDir, "ggml-small.bin")); err != nil {
		t.Skipf("没有 small 模型（%s），跳过真转写集成用例", modelDir)
	}
	return wav, modelDir
}

// newRecordingServer 用临时库起一个真插件注册表，装上、启用 recording，返回 API 服务和注册表。
func newRecordingServer(t *testing.T) (*Server, *plugin.Registry) {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	st, err := sqlite.Open(ctx, filepath.Join(dir, "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	reg := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), logger)
	reg.Migrations = plugin.NewSQLMigrationStore(st.DB())
	reg.DataDir = dir
	reg.SetObjectCreator(st)
	if err := reg.Add(recording.New()); err != nil {
		t.Fatal(err)
	}
	if err := reg.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	s := New(st, Options{Version: "test", Logger: logger, Plugins: reg})
	mustOK(t, s, http.MethodPost, "/api/plugins/recording/install",
		`{"permissions":["fs:read:attachments","fs:write:attachments","process:spawn","network:model"]}`)
	mustOK(t, s, http.MethodPost, "/api/plugins/recording/enable", "")
	return s, reg
}

// TestRecordingPluginM1E2E：真装真跑一条链路：装/启用 → 存设置 → 建录音 → 上传 → 后台转写
// （ffmpeg + whisper-cli）→ 读段落/音频 Range → 改标题和全文 → 删除。只在有本机音频和模型时跑。
func TestRecordingPluginM1E2E(t *testing.T) {
	wav, modelDir := recordingFixtures(t)
	s, _ := newRecordingServer(t)

	// 设置：用本机已有的模型目录，small 模型，中文。
	settings := `{"default_engine":"whisper_local","model":"small","model_dir":"` + modelDir + `",` +
		`"whisper_path":"","ffmpeg_path":"","language":"zh","threads":0,"default_project_id":"",` +
		`"minutes_provider":"","minutes_model":"","auto_summarize":false,"retention_mode":"keep"}`
	got := mustOK(t, s, http.MethodPut, "/api/recording/settings", settings)
	if got["model"] != "small" || got["model_dir"] != modelDir {
		t.Fatalf("设置没保存：%v", got)
	}

	// 工具和模型状态：本机 whisper-cli、ffmpeg 应该都在，small 应该 ready。
	meta := mustOK(t, s, http.MethodGet, "/api/recording/meta", "")
	tools, _ := meta["tools"].(map[string]any)
	for _, k := range []string{"whisper", "ffmpeg"} {
		if tool, _ := tools[k].(map[string]any); tool["ok"] != true {
			t.Fatalf("%s 应该可用：%v", k, tool)
		}
	}
	// 建一条录音（回 201）。
	cw := do(s, http.MethodPost, "/api/recording/recordings", `{"title":"集成测试录音"}`)
	if cw.Code != http.StatusCreated {
		t.Fatalf("新建录音 = %d：%s", cw.Code, cw.Body.String())
	}
	rec := envelopeData(t, cw)
	id, _ := rec["id"].(string)
	if !strings.HasPrefix(id, "rec_") || rec["status"] != "draft" {
		t.Fatalf("新建录音 = %v", rec)
	}

	// 上传音频（multipart），后台会自动排转写任务。
	w := uploadRecordingAudio(t, s, id, wav)
	if w.Code != http.StatusAccepted {
		t.Fatalf("上传音频 = %d：%s", w.Code, w.Body.String())
	}
	up := envelopeData(t, w)
	if up["status"] != "uploaded" || up["has_audio"] != true {
		t.Fatalf("上传后 = %v", up)
	}
	if job, _ := up["job"].(map[string]any); job == nil || job["kind"] != "transcribe" {
		t.Fatalf("上传后应该排了转写任务：%v", up["job"])
	}

	// 等后台 worker 转完。
	deadline := time.Now().Add(2 * time.Minute)
	var detail map[string]any
	for {
		detail = mustOK(t, s, http.MethodGet, "/api/recording/recordings/"+id, "")
		switch detail["status"] {
		case "transcribed":
			goto done
		case "failed":
			t.Fatalf("转写失败：%v", detail["error"])
		}
		if time.Now().After(deadline) {
			t.Fatalf("2 分钟内没转完，状态 %v，job=%v", detail["status"], detail["job"])
		}
		time.Sleep(500 * time.Millisecond)
	}
done:
	transcript, _ := detail["transcript"].(string)
	if strings.TrimSpace(transcript) == "" {
		t.Fatalf("转写文本是空的：%v", detail)
	}
	segs, _ := detail["segments"].([]any)
	if len(segs) == 0 {
		t.Fatalf("没有段落：%v", detail)
	}
	first, _ := segs[0].(map[string]any)
	if first["text"] == "" || first["end_ms"].(float64) <= first["start_ms"].(float64) {
		t.Fatalf("第一段不对：%v", first)
	}
	if detail["has_minutes"] != false || detail["minutes"] != nil {
		t.Fatalf("M1 不该有纪要：%v", detail)
	}

	// 音频支持 Range（播放器拖动进度条要用）。
	req := httptest.NewRequest(http.MethodGet, "/api/recording/recordings/"+id+"/audio", nil)
	req.Header.Set("Range", "bytes=0-99")
	w = httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != http.StatusPartialContent || w.Body.Len() != 100 {
		t.Fatalf("Range 请求 = %d，%d 字节", w.Code, w.Body.Len())
	}

	// 改标题和全文（详情页编辑）。
	patched := mustOK(t, s, http.MethodPatch, "/api/recording/recordings/"+id,
		`{"title":"改名后的录音","transcript":"人工改过的全文"}`)
	if patched["title"] != "改名后的录音" || patched["transcript"] != "人工改过的全文" {
		t.Fatalf("PATCH 之后 = %v", patched)
	}

	// 删除：录音、段落、音频都没了。
	mustOK(t, s, http.MethodDelete, "/api/recording/recordings/"+id, "")
	w = do(s, http.MethodGet, "/api/recording/recordings/"+id, "")
	assertError(t, w, http.StatusNotFound, "not_found")
}

// uploadRecordingAudio 发一条 multipart 上传，字段和浏览器录音一致（audio + duration_ms）。
func uploadRecordingAudio(t *testing.T, s *Server, id, wav string) *httptest.ResponseRecorder {
	t.Helper()
	f, err := os.Open(wav)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("audio", filepath.Base(wav))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(part, f); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("duration_ms", "65700"); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/recording/recordings/"+id+"/audio", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}

// TestRecordingPluginRequiresEnable：没启用的插件路由回 404，不是 500 或空响应。
func TestRecordingPluginRequiresEnable(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st, err := sqlite.Open(ctx, filepath.Join(dir, "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	reg := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), logger)
	reg.Migrations = plugin.NewSQLMigrationStore(st.DB())
	reg.DataDir = dir
	reg.SetObjectCreator(st)
	if err := reg.Add(recording.New()); err != nil {
		t.Fatal(err)
	}
	if err := reg.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	s := New(st, Options{Version: "test", Logger: logger, Plugins: reg})
	assertError(t, do(s, http.MethodGet, "/api/recording/meta", ""), http.StatusNotFound, "not_found")
}

// zeroTransport 是假下载端：按模型清单里的大小吐零字节，不真联网。
type zeroTransport struct{ size int64 }

func (z zeroTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode:    http.StatusOK,
		Status:        "200 OK",
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Request:       r,
		ContentLength: z.size,
		Header:        http.Header{"Content-Length": []string{strconv.FormatInt(z.size, 10)}},
		Body:          io.NopCloser(io.LimitReader(zeroReader{}, z.size)),
	}, nil
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	return len(p), nil
}

// TestRecordingPluginModelDownload：模型下载走 network:model 组的 HTTP 客户端，落盘后大小校验，
// 状态从 downloading 变 ready，重复下载 409，删除后文件消失。用假下载端，不联网。
func TestRecordingPluginModelDownload(t *testing.T) {
	s, reg := newRecordingServer(t)
	modelDir := filepath.Join(t.TempDir(), "models")
	if err := os.MkdirAll(modelDir, 0o755); err != nil {
		t.Fatal(err)
	}
	settings := `{"default_engine":"whisper_local","model":"small","model_dir":"` + modelDir + `",` +
		`"whisper_path":"","ffmpeg_path":"","language":"zh","threads":0,"default_project_id":"",` +
		`"minutes_provider":"","minutes_model":"","auto_summarize":false,"retention_mode":"keep"}`
	mustOK(t, s, http.MethodPut, "/api/recording/settings", settings)

	base := int64(147951465) // ggml-base.bin 的官方大小
	reg.SetHTTPTransport(zeroTransport{size: base})
	t.Cleanup(func() { reg.SetHTTPTransport(nil) })

	w := do(s, http.MethodPost, "/api/recording/models/base/download", "")
	if w.Code != http.StatusAccepted {
		t.Fatalf("开始下载 = %d：%s", w.Code, w.Body.String())
	}
	// 下载完之前再点一次：409。
	assertError(t, do(s, http.MethodPost, "/api/recording/models/base/download", ""), http.StatusConflict, "conflict")

	deadline := time.Now().Add(60 * time.Second)
	var info map[string]any
	for {
		meta := mustOK(t, s, http.MethodGet, "/api/recording/meta", "")
		found := false
		for _, m := range meta["models"].([]any) {
			row := m.(map[string]any)
			if row["name"] == "base" {
				info, found = row, true
			}
		}
		if !found {
			t.Fatal("模型列表里没有 base")
		}
		switch info["status"] {
		case "ready":
			goto ready
		case "error":
			t.Fatalf("下载失败：%v", info["error"])
		}
		if time.Now().After(deadline) {
			t.Fatalf("60 秒没下载完：%v", info)
		}
		time.Sleep(100 * time.Millisecond)
	}
ready:
	path := filepath.Join(modelDir, "ggml-base.bin")
	fi, err := os.Stat(path)
	if err != nil || fi.Size() != base {
		t.Fatalf("模型文件不对：%v %v", fi, err)
	}
	if info["size"] != float64(base) {
		t.Fatalf("返回的 size = %v", info["size"])
	}
	// 已经好了再下载：409。
	assertError(t, do(s, http.MethodPost, "/api/recording/models/base/download", ""), http.StatusConflict, "conflict")
	// 不认识的模型名：400。
	assertError(t, do(s, http.MethodPost, "/api/recording/models/nope/download", ""), http.StatusBadRequest, "validation")
	// 删除：文件没了，状态回 missing。
	got := mustOK(t, s, http.MethodDelete, "/api/recording/models/base", "")
	if got["status"] != "missing" {
		t.Fatalf("删除后状态 = %v", got["status"])
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("删除后文件还在：%v", err)
	}
}
