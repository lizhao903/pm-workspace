// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* ---------- 测试工具 ---------- */

// oneHotEmbedding 是 192 维里只有第 i 位是 1 的单位向量；不同 i 的余弦为 0，自己与自己是 1。
func oneHotEmbedding(i int) []float32 {
	vec := make([]float32, voiceprintDim)
	if i >= 0 && i < voiceprintDim {
		vec[i] = 1
	}
	return vec
}

// encodeEmbedding 按 sidecar 协议把小端 float32 向量编码成 base64。
func encodeEmbedding(vec []float32) string {
	buf := make([]byte, 4*len(vec))
	for i, v := range vec {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(v))
	}
	return base64.StdEncoding.EncodeToString(buf)
}

// diarizeJSON 拼一份 sidecar 输出；speakers 参数是 (embedding, segments)。
type testDiarizeSpeaker struct {
	embedding []float32
	segments  [][]int64
}

func diarizeJSON(t *testing.T, dim int, upstreamModel string, speakers []testDiarizeSpeaker) []byte {
	t.Helper()
	out := map[string]any{"model": upstreamModel, "dim": dim}
	list := make([]map[string]any, 0, len(speakers))
	for i, sp := range speakers {
		item := map[string]any{"label": "raw_" + strings.Repeat("x", i), "segments": sp.segments}
		if sp.embedding != nil {
			item["embedding"] = encodeEmbedding(sp.embedding)
		}
		list = append(list, item)
	}
	out["speakers"] = list
	body, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

/* ---------- sidecar JSON 解析 ---------- */

func TestParseDiarizeOutput(t *testing.T) {
	body := diarizeJSON(t, voiceprintDim, "campplus_cn_common", []testDiarizeSpeaker{
		// 故意把时间晚的放前面：label 应按首次出现顺序重排。
		{embedding: oneHotEmbedding(1), segments: [][]int64{{5000, 7000}}},
		{embedding: oneHotEmbedding(0), segments: [][]int64{{0, 3000}, {3000, 5000}}},
	})
	got, err := parseDiarizeOutput(body)
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if got.Model != "campplus_cn_common" || got.Dim != voiceprintDim {
		t.Fatalf("model/dim 不对：%+v", got)
	}
	if len(got.Speakers) != 2 {
		t.Fatalf("说话人数不对：%+v", got.Speakers)
	}
	if got.Speakers[0].Label != "spk_1" || got.Speakers[1].Label != "spk_2" {
		t.Errorf("label 应按首次出现顺序重排：%+v", got.Speakers)
	}
	if v := got.Speakers[0].Embedding; len(v) != voiceprintDim || v[0] != 1 {
		t.Errorf("spk_1 的 embedding 解错了：%v", v)
	}
	if v := got.Speakers[1].Embedding; len(v) != voiceprintDim || v[1] != 1 {
		t.Errorf("spk_2 的 embedding 解错了：%v", v)
	}
	if len(got.Speakers[0].Segments) != 2 || got.Speakers[0].Segments[1][0] != 3000 {
		t.Errorf("segments 不对：%+v", got.Speakers[0].Segments)
	}
}

func TestParseDiarizeOutputRejectsBadData(t *testing.T) {
	valid := oneHotEmbedding(0)
	cases := []struct {
		name string
		body []byte
	}{
		{"不是 JSON", []byte("not json")},
		{"缺 model", diarizeJSON(t, voiceprintDim, "", []testDiarizeSpeaker{{embedding: valid, segments: [][]int64{{0, 1}}}})},
		{"维度不对", diarizeJSON(t, voiceprintDim-1, "campplus_cn_common", []testDiarizeSpeaker{{embedding: oneHotEmbedding(0)[:voiceprintDim-1], segments: [][]int64{{0, 1}}}})},
		{"embedding 长度不对", diarizeJSON(t, voiceprintDim, "campplus_cn_common", []testDiarizeSpeaker{{embedding: oneHotEmbedding(0)[:10], segments: [][]int64{{0, 1}}}})},
		{"缺 embedding", []byte(`{"model":"campplus_cn_common","dim":192,"speakers":[{"label":"spk_1","segments":[[0,1]]}]}`)},
		{"embedding 不是 base64", []byte(`{"model":"campplus_cn_common","dim":192,"speakers":[{"label":"spk_1","embedding":"@@@","segments":[[0,1]]}]}`)},
		{"段不是两个数", []byte(`{"model":"campplus_cn_common","dim":192,"speakers":[{"label":"spk_1","embedding":"` + encodeEmbedding(valid) + `","segments":[[0,1,2]]}]}`)},
		{"负时间", []byte(`{"model":"campplus_cn_common","dim":192,"speakers":[{"label":"spk_1","embedding":"` + encodeEmbedding(valid) + `","segments":[[-5,1]]}]}`)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := parseDiarizeOutput(c.body); err == nil {
				t.Fatalf("坏数据应该解析失败：%s", c.body)
			}
		})
	}
}

func TestParseDiarizeOutputEmptySpeakers(t *testing.T) {
	got, err := parseDiarizeOutput([]byte(`{"model":"campplus_cn_common","dim":192,"speakers":[]}`))
	if err != nil {
		t.Fatalf("没检测到说话人是合法结果：%v", err)
	}
	if len(got.Speakers) != 0 {
		t.Errorf("应该是 0 个说话人：%+v", got.Speakers)
	}
}

/* ---------- 重叠归属 ---------- */

func TestAssignSegmentSpeakerLabelsByOverlap(t *testing.T) {
	speakers := []diarizeSpeaker{
		{Label: "spk_1", Segments: [][2]int64{{0, 600}}},
		{Label: "spk_2", Segments: [][2]int64{{500, 2000}}},
	}
	segs := []Segment{
		{Seq: 0, StartMs: 0, EndMs: 1000},    // 与 spk_1 重叠 600，与 spk_2 重叠 500 → spk_1
		{Seq: 1, StartMs: 1000, EndMs: 2000}, // 只与 spk_2 重叠 → spk_2
	}
	got := assignSegmentSpeakerLabels(segs, speakers)
	if len(got) != 2 || got[0] != "spk_1" || got[1] != "spk_2" {
		t.Fatalf("重叠最大者归属不对：%v", got)
	}
}

func TestAssignSegmentSpeakerLabelsInheritsPrevious(t *testing.T) {
	speakers := []diarizeSpeaker{{Label: "spk_1", Segments: [][2]int64{{0, 500}}}}
	segs := []Segment{
		{Seq: 0, StartMs: 0, EndMs: 400},
		{Seq: 1, StartMs: 900, EndMs: 1000}, // 没有任何重叠 → 继承前一段 spk_1
	}
	got := assignSegmentSpeakerLabels(segs, speakers)
	if len(got) != 2 || got[0] != "spk_1" || got[1] != "spk_1" {
		t.Fatalf("无重叠应继承前一段：%v", got)
	}
}

func TestAssignSegmentSpeakerLabelsFallsBackToNearest(t *testing.T) {
	speakers := []diarizeSpeaker{
		{Label: "spk_1", Segments: [][2]int64{{0, 1000}}},
		{Label: "spk_2", Segments: [][2]int64{{9000, 10000}}},
	}
	segs := []Segment{{Seq: 0, StartMs: 5000, EndMs: 6000}}
	got := assignSegmentSpeakerLabels(segs, speakers)
	if len(got) != 1 || got[0] != "spk_2" {
		t.Fatalf("第一段无重叠应选时间最近的：%v", got)
	}
}

func TestIntervalOverlapMs(t *testing.T) {
	if got := intervalOverlapMs(0, 100, 50, 150); got != 50 {
		t.Errorf("重叠 50ms，实际 %d", got)
	}
	if got := intervalOverlapMs(0, 100, 100, 200); got != 0 {
		t.Errorf("首尾相接不算重叠，实际 %d", got)
	}
	if got := intervalOverlapMs(0, 100, 200, 300); got != 0 {
		t.Errorf("不相交应为 0，实际 %d", got)
	}
}

/* ---------- 余弦与阈值 ---------- */

func TestCosineSimilarity(t *testing.T) {
	a := []float32{1, 0}
	b := []float32{0, 1}
	if sim, ok := cosineSimilarity(a, a); !ok || math.Abs(sim-1) > 1e-9 {
		t.Errorf("自己和自己的余弦应为 1：%v %v", sim, ok)
	}
	if sim, ok := cosineSimilarity(a, b); !ok || math.Abs(sim) > 1e-9 {
		t.Errorf("正交向量余弦应为 0：%v %v", sim, ok)
	}
	if sim, ok := cosineSimilarity(a, []float32{-1, 0}); !ok || math.Abs(sim+1) > 1e-9 {
		t.Errorf("反向余弦应为 -1：%v %v", sim, ok)
	}
	if _, ok := cosineSimilarity(a, []float32{1}); ok {
		t.Error("长度不同应无效")
	}
	if _, ok := cosineSimilarity([]float32{0, 0}, a); ok {
		t.Error("零向量应无效")
	}
}

// matchVoiceprints 的阈值边界：0（等于阈值也算匹配）、1（只有完全相同才匹配）、超阈值不匹配。
func TestMatchVoiceprintsThresholdBoundaries(t *testing.T) {
	rows := []speakerRow{
		{Label: "spk_1", Model: "campplus_cn_common", Embedding: embeddingBytes(oneHotEmbedding(0))},
		{Label: "spk_2", Model: "campplus_cn_common", Embedding: embeddingBytes(oneHotEmbedding(1))},
	}
	vps := []voiceprintRow{
		{ContactID: "sh_a", Model: "campplus_cn_common", Embedding: embeddingBytes(oneHotEmbedding(0))},
	}

	// 阈值 0：spk_1 余弦 1、spk_2 余弦 0（刚好等于阈值）都算匹配。
	got, _ := matchVoiceprints(rows, vps, 0)
	if got[0] == nil || got[0].ContactID != "sh_a" || got[1] == nil || got[1].ContactID != "sh_a" {
		t.Fatalf("阈值 0 下应匹配同一个联系人：%+v %+v", got[0], got[1])
	}
	// 阈值 1：只有完全相同的才算（刚好等于阈值）。
	got, _ = matchVoiceprints(rows, vps, 1)
	if got[0] == nil || math.Abs(got[0].Similarity-1) > 1e-9 {
		t.Fatalf("阈值 1 下完全相同应匹配：%+v", got[0])
	}
	if got[1] != nil {
		t.Fatalf("阈值 1 下正交向量不该匹配：%+v", got[1])
	}
	// 阈值 0.65：spk_2 不匹配。
	got, _ = matchVoiceprints(rows, vps, 0.65)
	if got[0] == nil || got[1] != nil {
		t.Fatalf("阈值 0.65 下只应有 spk_1 匹配：%+v %+v", got[0], got[1])
	}
}

func TestMatchVoiceprintsSkipsMismatchedModelAndDim(t *testing.T) {
	rows := []speakerRow{{Label: "spk_1", Model: "campplus_cn_common", Embedding: embeddingBytes(oneHotEmbedding(0))}}
	vps := []voiceprintRow{
		{ContactID: "sh_other_model", Model: "other", Embedding: embeddingBytes(oneHotEmbedding(0))},
		{ContactID: "sh_bad_dim", Model: "campplus_cn_common", Embedding: []byte{1, 2, 3}},
	}
	got, skipped := matchVoiceprints(rows, vps, 0)
	if got[0] != nil {
		t.Fatalf("模型/维度不一致的声纹应跳过：%+v", got[0])
	}
	if skipped != 2 {
		t.Errorf("应跳过 2 条：%d", skipped)
	}
}

/* ---------- 重跑继承 ---------- */

func TestInheritSpeakerRows(t *testing.T) {
	old := []speakerRow{
		{Label: "spk_1", Name: "老张", ContactID: "sh_zhang", ContactName: "张三", Embedding: embeddingBytes(oneHotEmbedding(0))},
		{Label: "spk_2", Name: "用户改的名", Embedding: embeddingBytes(oneHotEmbedding(1))},
	}
	rows := []speakerRow{
		{Label: "spk_1", Embedding: embeddingBytes(oneHotEmbedding(0))}, // 与旧 spk_1 相同 → 继承名字/绑定
		{Label: "spk_2", Embedding: embeddingBytes(oneHotEmbedding(2))}, // 与旧 spk_2 正交 → 不继承
	}
	inheritSpeakerRows(rows, old, 0.65)
	if rows[0].Name != "老张" || rows[0].ContactID != "sh_zhang" || rows[0].ContactName != "张三" {
		t.Errorf("质心相同的旧 row 应继承 name/绑定：%+v", rows[0])
	}
	if rows[0].Detected {
		t.Error("继承的手动绑定不该是自动匹配")
	}
	if rows[1].Name != "" || rows[1].ContactID != "" {
		t.Errorf("质心不同的旧 row 不该继承：%+v", rows[1])
	}
}

func TestInheritSpeakerRowsKeepsAutoMatch(t *testing.T) {
	old := []speakerRow{{Label: "spk_1", ContactID: "sh_old", ContactName: "旧绑定", Embedding: embeddingBytes(oneHotEmbedding(0))}}
	rows := []speakerRow{{
		Label: "spk_1", ContactID: "sh_new", ContactName: "新匹配", Detected: true,
		Embedding: embeddingBytes(oneHotEmbedding(0)),
	}}
	inheritSpeakerRows(rows, old, 0.65)
	if rows[0].ContactID != "sh_new" || !rows[0].Detected {
		t.Errorf("自动匹配的联系人不应被旧绑定覆盖：%+v", rows[0])
	}
}

/* ---------- 视图 name 优先级 ---------- */

func TestSpeakerDisplayNamePriority(t *testing.T) {
	cases := []struct {
		name, user, live, snapshot, label, want string
	}{
		{"用户改的名字最优先", "小明", "张三", "快照名", "spk_1", "小明"},
		{"没有用户名字用联系人现名", "", "张三", "快照名", "spk_1", "张三"},
		{"查不到联系人用快照", "", "", "快照名", "spk_2", "快照名"},
		{"都没有用说话人 N", "  ", " ", "", "spk_3", "说话人 3"},
		{"label 不合法兜底", "", "", "", "weird", "说话人"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := speakerDisplayName(c.user, c.live, c.snapshot, c.label); got != c.want {
				t.Errorf("name priority = %q，期望 %q", got, c.want)
			}
		})
	}
}

func TestSpeakerNumber(t *testing.T) {
	if n := speakerNumber("spk_12"); n != 12 {
		t.Errorf("spk_12 = %d", n)
	}
	for _, bad := range []string{"", "spk_", "spk_x", "spk_0", "speaker_1"} {
		if n := speakerNumber(bad); n != 0 {
			t.Errorf("%q 应回 0，实际 %d", bad, n)
		}
	}
}

/* ---------- 设置校验 ---------- */

func TestValidateSettingsM5(t *testing.T) {
	base := func() Settings {
		s := Settings{DefaultEngine: "whisper_local", Model: "small", Language: "zh", RetentionMode: "keep"}
		return s
	}
	// 空设置补默认值：max_speakers 0 → 8，match_threshold 0 原样保留。
	s := base()
	if err := validateSettings(&s); err != nil {
		t.Fatalf("默认设置应合法：%v", err)
	}
	if s.MaxSpeakers != defaultMaxSpeakers {
		t.Errorf("max_speakers 0 应补默认 8，实际 %d", s.MaxSpeakers)
	}
	if s.MatchThreshold != 0 {
		t.Errorf("match_threshold 0 是合法值应原样保留，实际 %v", s.MatchThreshold)
	}
	// max_speakers 边界 1/16 合法，17/-1 非法。
	for _, n := range []int{1, 16} {
		s = base()
		s.MaxSpeakers = n
		if err := validateSettings(&s); err != nil {
			t.Errorf("max_speakers %d 应合法：%v", n, err)
		}
	}
	for _, n := range []int{-1, 17} {
		s = base()
		s.MaxSpeakers = n
		if err := validateSettings(&s); !errors.Is(err, errValidation) {
			t.Errorf("max_speakers %d 应校验失败：%v", n, err)
		}
	}
	// match_threshold 0/0.65/1 合法，-0.1/1.1 非法。
	for _, v := range []float64{0, 0.65, 1} {
		s = base()
		s.MatchThreshold = v
		if err := validateSettings(&s); err != nil || s.MatchThreshold != v {
			t.Errorf("match_threshold %v 应合法且原样保留：%v %v", v, s.MatchThreshold, err)
		}
	}
	for _, v := range []float64{-0.1, 1.1} {
		s = base()
		s.MatchThreshold = v
		if err := validateSettings(&s); !errors.Is(err, errValidation) {
			t.Errorf("match_threshold %v 应校验失败：%v", v, err)
		}
	}
	// python_path / voiceprint_model_dir trim 后保存；超 512 字 400。
	s = base()
	s.PythonPath = "  /usr/local/bin/python3  "
	s.VoiceprintModelDir = " /tmp/models "
	if err := validateSettings(&s); err != nil {
		t.Fatalf("合法路径应通过：%v", err)
	}
	if s.PythonPath != "/usr/local/bin/python3" || s.VoiceprintModelDir != "/tmp/models" {
		t.Errorf("路径应 trim：%q %q", s.PythonPath, s.VoiceprintModelDir)
	}
	s = base()
	s.PythonPath = strings.Repeat("a", 513)
	if err := validateSettings(&s); !errors.Is(err, errValidation) {
		t.Errorf("超长 Python 路径应校验失败：%v", err)
	}
	s = base()
	s.VoiceprintModelDir = strings.Repeat("a", 513)
	if err := validateSettings(&s); !errors.Is(err, errValidation) {
		t.Errorf("超长声纹模型目录应校验失败：%v", err)
	}
}

func TestSettingsM5RoundTrip(t *testing.T) {
	store := &fakeStore{}
	// settingsCols：default_engine, model, model_dir, whisper_path, ffmpeg_path, language, threads,
	// default_project_id, minutes_provider, minutes_model, minutes_flow, minutes_threshold,
	// auto_diarize, python_path, voiceprint_model_dir, max_speakers, match_threshold,
	// auto_summarize, retention_mode, updated_at
	store.row = []any{"whisper_local", "small", "", "", "", "zh", 0, "", "", "", "", 0.7,
		1, "/opt/py/bin/python3", "/models", 4, 0.0, 1, "keep", "2026-11-10T00:00:00Z"}
	c := &fakeCore{store: store}
	got, err := loadSettings(context.Background(), c)
	if err != nil {
		t.Fatalf("读设置失败：%v", err)
	}
	if !got.AutoDiarize || got.PythonPath != "/opt/py/bin/python3" || got.VoiceprintModelDir != "/models" ||
		got.MaxSpeakers != 4 || got.MatchThreshold != 0 {
		t.Fatalf("M5 设置读出来不对：%+v", got)
	}
	if err := saveSettings(context.Background(), c, got); err != nil {
		t.Fatalf("存设置失败：%v", err)
	}
	q, args := store.lastExec()
	for _, col := range []string{"auto_diarize = ?", "python_path = ?", "voiceprint_model_dir = ?", "max_speakers = ?", "match_threshold = ?"} {
		if !strings.Contains(q, col) {
			t.Errorf("保存语句里没写 %s：%s", col, q)
		}
	}
	// 参数顺序：... minutes_threshold(11), auto_diarize(12), python_path(13), voiceprint_model_dir(14),
	// max_speakers(15), match_threshold(16), auto_summarize(17)...
	if len(args) < 20 {
		t.Fatalf("保存参数数量不对：%d", len(args))
	}
	if args[12] != 1 || args[13] != "/opt/py/bin/python3" || args[14] != "/models" || args[15] != 4 || args[16] != float64(0) {
		t.Errorf("保存的 M5 参数顺序/值不对：%v", args)
	}
}

/* ---------- worker：自动排队与失败处理 ---------- */

func TestAutoDiarizeQueuesJob(t *testing.T) {
	c, store, _, _ := newPipelineCore(t)
	store.row = []any{0} // activeJob 查没有在跑的任务
	p := &Plugin{}
	p.autoDiarize(context.Background(), c, recordingRow{ID: "rec_1"}, Settings{AutoDiarize: true}, true)
	q, args := store.lastExec()
	if !strings.Contains(q, "INSERT INTO recording_jobs") {
		t.Fatalf("没排 diarize 任务：%v", store.execs)
	}
	if len(args) < 3 || args[2] != "diarize" {
		t.Errorf("任务类型不对：%v", args)
	}
}

func TestAutoDiarizeSkips(t *testing.T) {
	p := &Plugin{}
	for _, c := range []struct {
		name     string
		settings Settings
		hasSegs  bool
	}{
		{"没开自动识别", Settings{AutoDiarize: false}, true},
		{"没有转写段落", Settings{AutoDiarize: true}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			core, store, _, _ := newPipelineCore(t)
			core.store = store
			p.autoDiarize(context.Background(), core, recordingRow{ID: "rec_1"}, c.settings, c.hasSegs)
			if len(store.execs) != 0 {
				t.Errorf("不该排任务：%v", store.execs)
			}
		})
	}
}

func TestFailDiarizeJobDoesNotTouchRecording(t *testing.T) {
	c, store, _, _ := newPipelineCore(t)
	p := &Plugin{}
	p.failDiarizeJob(context.Background(), c, jobRow{ID: "job_1", RecordingID: "rec_1"}, errors.New("Python 没装"))
	for _, q := range store.execs {
		if strings.Contains(q, "recording_recordings") {
			t.Fatalf("diarize 失败不该改录音 status：%s", q)
		}
	}
	q, args := store.lastExec()
	if !strings.Contains(q, "UPDATE recording_jobs SET status = 'failed'") {
		t.Fatalf("应把任务标 failed：%s", q)
	}
	if len(args) < 2 || args[0] != "Python 没装" {
		t.Errorf("last_error 应是失败原因：%v", args)
	}
}

func TestFailDiarizeJobRequeuesWhenPluginStopped(t *testing.T) {
	c, store, _, _ := newPipelineCore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p := &Plugin{}
	p.failDiarizeJob(ctx, c, jobRow{ID: "job_1", RecordingID: "rec_1"}, errors.New("插件停用"))
	for _, q := range store.execs {
		if strings.Contains(q, "recording_recordings") {
			t.Fatalf("插件停用也不该改录音：%s", q)
		}
	}
	q, _ := store.lastExec()
	if !strings.Contains(q, "status = 'pending'") {
		t.Fatalf("插件停用应把任务放回队列：%s", q)
	}
}

/* ---------- sidecar 脚本与执行 ---------- */

func TestEnsureVoiceprintScript(t *testing.T) {
	c := &fakeCore{cacheDir: t.TempDir()}
	path, err := ensureVoiceprintScript(c)
	if err != nil {
		t.Fatalf("写脚本失败：%v", err)
	}
	if !strings.HasSuffix(path, filepath.Join("recording", "voiceprint.py")) {
		t.Errorf("脚本路径不对：%s", path)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读脚本失败：%v", err)
	}
	if len(body) == 0 || !strings.Contains(string(body), "funasr") {
		t.Errorf("内嵌脚本内容不对：%d 字节", len(body))
	}
	// 再调一次不报错（内容没变不重写）。
	if _, err := ensureVoiceprintScript(c); err != nil {
		t.Fatalf("再次写脚本失败：%v", err)
	}
}

func TestRunVoiceprintSidecarMissingDependency(t *testing.T) {
	dir := t.TempDir()
	fake := filepath.Join(dir, "python3")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\necho '缺少 Python 依赖 funasr：请先 pip install funasr' >&2\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, stderr, err := runVoiceprintSidecar(context.Background(), Settings{PythonPath: fake, MaxSpeakers: 4}, fake, "in.wav", filepath.Join(dir, "out.json"))
	if err == nil {
		t.Fatal("退出码 3 应报错")
	}
	if !strings.Contains(err.Error(), "funasr") {
		t.Errorf("错误信息应说明缺 funasr：%v", err)
	}
	if !strings.Contains(stderr, "funasr") {
		t.Errorf("应带回 stderr：%q", stderr)
	}
	var p *permanentError
	if !errors.As(err, &p) {
		t.Errorf("缺依赖应是不可重试错误：%v", err)
	}
}

/* ---------- 行数/时长统计 ---------- */

func TestBuildSpeakerRows(t *testing.T) {
	body := diarizeJSON(t, voiceprintDim, "campplus_cn_common", []testDiarizeSpeaker{
		{embedding: oneHotEmbedding(0), segments: [][]int64{{0, 1000}}},
		{embedding: oneHotEmbedding(1), segments: [][]int64{{1000, 3000}}},
	})
	res, err := parseDiarizeOutput(body)
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	segs := []Segment{{Seq: 0, StartMs: 0, EndMs: 800}, {Seq: 1, StartMs: 1000, EndMs: 2500}}
	labels := assignSegmentSpeakerLabels(segs, res.Speakers)
	rows := buildSpeakerRows("rec_1", res, segs, labels, "2026-11-10T00:00:00Z")
	if len(rows) != 2 {
		t.Fatalf("说话人行数不对：%d", len(rows))
	}
	if rows[0].Segments != 1 || rows[0].DurationMs != 800 {
		t.Errorf("spk_1 统计不对：%+v", rows[0])
	}
	if rows[1].Segments != 1 || rows[1].DurationMs != 1500 {
		t.Errorf("spk_2 统计不对：%+v", rows[1])
	}
	if len(rows[0].Embedding) != voiceprintDim*4 {
		t.Errorf("质心字节长度不对：%d", len(rows[0].Embedding))
	}
}
