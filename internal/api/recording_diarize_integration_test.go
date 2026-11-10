// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakePythonEmbedding 生成 192 维、L2 归一化的确定性 embedding：前半/后半各占一半，两个向量正交。
func fakePythonEmbedding(secondHalf bool) string {
	const dim = 192
	vec := make([]float32, dim)
	norm := float32(1.0 / math.Sqrt(float64(dim/2)))
	for i := 0; i < dim/2; i++ {
		if secondHalf {
			vec[dim/2+i] = norm
		} else {
			vec[i] = norm
		}
	}
	buf := make([]byte, 4*dim)
	for i, v := range vec {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(v))
	}
	return base64.StdEncoding.EncodeToString(buf)
}

// writeFakePython 写一个假 Python：忽略参数，从 --out 找到输出路径后写固定两人的分离结果。
// 插件经 process:spawn 直接 exec 它，不依赖本机真 Python。
func writeFakePython(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "python3")
	body := fmt.Sprintf(`#!/bin/sh
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--out" ]; then out="$a"; fi
  prev="$a"
done
if [ -z "$out" ]; then echo "fake python: 没有 --out" >&2; exit 2; fi
cat > "$out" <<'JSON'
{"model":"campplus_cn_common","dim":192,"speakers":[
 {"label":"spk_1","embedding":"%s","segments":[[0,32000]]},
 {"label":"spk_2","embedding":"%s","segments":[[32000,66000]]}]}
JSON
`, fakePythonEmbedding(false), fakePythonEmbedding(true))
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// diarizeSettings 是打开自动声纹识别的全量设置；fakePython 为假 Python 路径。
func diarizeSettings(modelDir, fakePython string) string {
	return fmt.Sprintf(`{"default_engine":"whisper_local","model":"small","model_dir":%q,`+
		`"whisper_path":"","ffmpeg_path":"","language":"zh","threads":0,"default_project_id":"",`+
		`"minutes_provider":"","minutes_model":"","minutes_flow":"","minutes_threshold":0.7,`+
		`"auto_diarize":true,"python_path":%q,"voiceprint_model_dir":"","max_speakers":4,"match_threshold":0.65,`+
		`"auto_summarize":false,"retention_mode":"keep"}`, modelDir, fakePython)
}

// TestRecordingPluginDiarizeE2E：M5 全链路：假 Python sidecar + 真 whisper 转写 → 自动说话人分离 →
// 段落标签/说话人列表/列表 speaker_count → 建联系人 → 绑定写声纹 → 重跑自动认人 → 改名 → 删声纹 →
// 假 Python 失效时任务失败但录音状态不变。
func TestRecordingPluginDiarizeE2E(t *testing.T) {
	wav, modelDir := recordingFixtures(t)
	s, _ := newRecordingServer(t)
	fakePython := writeFakePython(t)

	if got := mustOK(t, s, http.MethodPut, "/api/recording/settings", diarizeSettings(modelDir, fakePython)); got["auto_diarize"] != true {
		t.Fatalf("设置没保存 auto_diarize：%v", got)
	}

	// 建录音 + 上传音频（后台自动转写，转完自动排 diarize）。
	cw := do(s, http.MethodPost, "/api/recording/recordings", `{"title":"声纹集成测试"}`)
	if cw.Code != http.StatusCreated {
		t.Fatalf("新建录音 = %d：%s", cw.Code, cw.Body.String())
	}
	rec := envelopeData(t, cw)
	id, _ := rec["id"].(string)
	if w := uploadRecordingAudio(t, s, id, wav); w.Code != http.StatusAccepted {
		t.Fatalf("上传音频 = %d：%s", w.Code, w.Body.String())
	}

	// 等转写 + 自动 diarize 出说话人。
	deadline := time.Now().Add(2 * time.Minute)
	var detail map[string]any
	for {
		detail = mustOK(t, s, http.MethodGet, "/api/recording/recordings/"+id, "")
		if speakers, _ := detail["speakers"].([]any); len(speakers) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("2 分钟内没识别出说话人，状态 %v，job=%v", detail["status"], detail["job"])
		}
		time.Sleep(300 * time.Millisecond)
	}
	if detail["status"] != "transcribed" {
		t.Fatalf("diarize 不该改录音状态：%v", detail["status"])
	}

	speakers, _ := detail["speakers"].([]any)
	if len(speakers) != 2 {
		t.Fatalf("应该识别出 2 个说话人：%v", speakers)
	}
	labels := map[string]bool{}
	for _, x := range speakers {
		sp, _ := x.(map[string]any)
		label, _ := sp["label"].(string)
		labels[label] = true
		if n, _ := sp["segments"].(float64); n <= 0 {
			t.Fatalf("说话人没有段落：%v", sp)
		}
		if d, _ := sp["duration_ms"].(float64); d <= 0 {
			t.Fatalf("说话人没有时长：%v", sp)
		}
	}
	if !labels["spk_1"] || !labels["spk_2"] {
		t.Fatalf("说话人 label 不对：%v", labels)
	}

	// 段落都打上了说话人 label。
	segs, _ := detail["segments"].([]any)
	segSpeakers := map[string]bool{}
	for _, x := range segs {
		m, _ := x.(map[string]any)
		sp, _ := m["speaker"].(string)
		if sp == "" {
			t.Fatalf("有段落没打说话人：%v", m)
		}
		segSpeakers[sp] = true
	}
	if !segSpeakers["spk_1"] || !segSpeakers["spk_2"] {
		t.Fatalf("段落说话人分布不对：%v", segSpeakers)
	}

	// 列表 summary 的 speaker_count。
	list := mustList(t, s, "/api/recording/recordings")
	found := false
	for _, x := range list {
		m, _ := x.(map[string]any)
		if m["id"] == id {
			found = true
			if m["speaker_count"] != float64(2) {
				t.Fatalf("speaker_count = %v", m["speaker_count"])
			}
		}
	}
	if !found {
		t.Fatal("列表里没找到刚建的录音")
	}

	// 建联系人（stakeholder）并绑定 spk_1。
	sw := do(s, http.MethodPost, "/api/stakeholders", `{"name":"声纹测试联系人"}`)
	if sw.Code != http.StatusCreated {
		t.Fatalf("建联系人 = %d：%s", sw.Code, sw.Body.String())
	}
	contactID, _ := envelopeData(t, sw)["id"].(string)
	bound := mustOK(t, s, http.MethodPost, "/api/recording/recordings/"+id+"/speakers/spk_1/bind",
		`{"contact_id":"`+contactID+`"}`)
	if bound["contact_id"] != contactID || bound["detected"] != false {
		t.Fatalf("绑定后 = %v", bound)
	}

	// 声纹列表里有这条联系人声纹。
	vps := mustList(t, s, "/api/recording/voiceprints")
	if len(vps) != 1 {
		t.Fatalf("声纹列表 = %v", vps)
	}
	vp, _ := vps[0].(map[string]any)
	if vp["contact_id"] != contactID || vp["model"] != "campplus_cn_common" || vp["source_recording_id"] != id {
		t.Fatalf("声纹条目 = %v", vp)
	}

	// 重跑 diarize：spk_1 应自动认回联系人（同 embedding，相似度 1）。
	if w := do(s, http.MethodPost, "/api/recording/recordings/"+id+"/diarize", ""); w.Code != http.StatusAccepted {
		t.Fatalf("重跑 diarize = %d：%s", w.Code, w.Body.String())
	}
	deadline = time.Now().Add(60 * time.Second)
	matched := false
	for {
		detail = mustOK(t, s, http.MethodGet, "/api/recording/recordings/"+id, "")
		for _, x := range detail["speakers"].([]any) {
			sp, _ := x.(map[string]any)
			if sp["contact_id"] == contactID && sp["detected"] == true {
				if sim, _ := sp["similarity"].(float64); math.Abs(sim-1) > 1e-6 {
					t.Fatalf("自动匹配相似度不是 1：%v", sp)
				}
				matched = true
			}
		}
		if matched {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("重跑后没自动认回联系人：%v", detail["speakers"])
		}
		time.Sleep(300 * time.Millisecond)
	}

	// 改名只改显示名。
	renamed := mustOK(t, s, http.MethodPatch, "/api/recording/recordings/"+id+"/speakers/spk_2", `{"name":"李四"}`)
	if renamed["name"] != "李四" {
		t.Fatalf("改名后 = %v", renamed)
	}

	// 删声纹。
	mustOK(t, s, http.MethodDelete, "/api/recording/voiceprints/"+contactID, "")
	if vps := mustList(t, s, "/api/recording/voiceprints"); len(vps) != 0 {
		t.Fatalf("删声纹后还有：%v", vps)
	}

	// 假 Python 失效：diarize 任务失败，但录音状态保持 transcribed。
	if got := mustOK(t, s, http.MethodPut, "/api/recording/settings", diarizeSettings(modelDir, "/nonexistent/python3")); got["python_path"] != "/nonexistent/python3" {
		t.Fatalf("设置没保存坏 python_path：%v", got)
	}
	if w := do(s, http.MethodPost, "/api/recording/recordings/"+id+"/diarize", ""); w.Code != http.StatusAccepted {
		t.Fatalf("坏 Python 重跑 diarize = %d：%s", w.Code, w.Body.String())
	}
	deadline = time.Now().Add(60 * time.Second)
	for {
		detail = mustOK(t, s, http.MethodGet, "/api/recording/recordings/"+id, "")
		job, _ := detail["job"].(map[string]any)
		if job != nil && job["kind"] == "diarize" && job["status"] == "failed" {
			if le, _ := job["last_error"].(string); le == "" {
				t.Fatalf("失败任务没有 last_error：%v", job)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("坏 Python 的 diarize 没失败：%v", detail["job"])
		}
		time.Sleep(300 * time.Millisecond)
	}
	detail = mustOK(t, s, http.MethodGet, "/api/recording/recordings/"+id, "")
	if detail["status"] != "transcribed" {
		t.Fatalf("diarize 失败后录音状态被改了：%v", detail["status"])
	}

	// 删录音（speakers 一起删，声纹已删）。
	mustOK(t, s, http.MethodDelete, "/api/recording/recordings/"+id, "")
	assertError(t, do(s, http.MethodGet, "/api/recording/recordings/"+id, ""), http.StatusNotFound, "not_found")
}

// TestRecordingPluginDiarizeRealFunASR 是真机验证（默认跳过）：本机已装 funasr 的 Python +
// FunASR 模型缓存 + 双人对话 wav，跑完整 whisper 转写 + 真声纹分离，确认能认出 2 个说话人。
// 运行：
//
//	RECORDING_REAL_FUNASR=1 \
//	RECORDING_PYTHON=/tmp/m5-poc/venv/bin/python \
//	RECORDING_REAL_WAV=/tmp/m5-poc/audio/dialog16k.wav \
//	RECORDING_REAL_MODEL_DIR=/tmp/whisper-bench/models \
//	go test ./internal/api -run TestRecordingPluginDiarizeRealFunASR -count=1 -v
func TestRecordingPluginDiarizeRealFunASR(t *testing.T) {
	if os.Getenv("RECORDING_REAL_FUNASR") != "1" {
		t.Skip("设 RECORDING_REAL_FUNASR=1 才跑真 FunASR 声纹验证")
	}
	python := os.Getenv("RECORDING_PYTHON")
	wav := os.Getenv("RECORDING_REAL_WAV")
	modelDir := os.Getenv("RECORDING_REAL_MODEL_DIR")
	if python == "" || wav == "" || modelDir == "" {
		t.Skip("需要 RECORDING_PYTHON / RECORDING_REAL_WAV / RECORDING_REAL_MODEL_DIR")
	}
	if _, err := os.Stat(wav); err != nil {
		t.Fatalf("测试音频不存在: %v", err)
	}
	s, _ := newRecordingServer(t)
	settings := fmt.Sprintf(`{"default_engine":"whisper_local","model":"large-v3-turbo","model_dir":%q,`+
		`"whisper_path":"","ffmpeg_path":"","language":"zh","threads":0,"default_project_id":"",`+
		`"minutes_provider":"","minutes_model":"","minutes_flow":"","minutes_threshold":0.7,`+
		`"auto_diarize":true,"python_path":%q,"voiceprint_model_dir":"","max_speakers":4,"match_threshold":0.65,`+
		`"auto_summarize":false,"retention_mode":"keep"}`, modelDir, python)
	mustOK(t, s, http.MethodPut, "/api/recording/settings", settings)

	cw := do(s, http.MethodPost, "/api/recording/recordings", `{"title":"真 FunASR 声纹验证"}`)
	if cw.Code != http.StatusCreated {
		t.Fatalf("新建录音 = %d：%s", cw.Code, cw.Body.String())
	}
	id, _ := envelopeData(t, cw)["id"].(string)
	if w := uploadRecordingAudio(t, s, id, wav); w.Code != http.StatusAccepted {
		t.Fatalf("上传音频 = %d：%s", w.Code, w.Body.String())
	}

	deadline := time.Now().Add(5 * time.Minute)
	var detail map[string]any
	for {
		detail = mustOK(t, s, http.MethodGet, "/api/recording/recordings/"+id, "")
		if speakers, _ := detail["speakers"].([]any); len(speakers) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("5 分钟内没识别出说话人，状态 %v，job=%v", detail["status"], detail["job"])
		}
		time.Sleep(time.Second)
	}
	speakers := detail["speakers"].([]any)
	if len(speakers) < 2 {
		t.Fatalf("双人对话应识别出至少 2 个说话人，实际 %v", speakers)
	}
	t.Logf("识别出 %d 个说话人：%v", len(speakers), speakers)
	segs := detail["segments"].([]any)
	labeled := 0
	for _, x := range segs {
		if m, _ := x.(map[string]any); m["speaker"] != "" {
			labeled++
		}
	}
	if labeled == 0 {
		t.Fatal("没有段落被标上说话人")
	}
	t.Logf("共 %d 段，%d 段有说话人 label", len(segs), labeled)
}
