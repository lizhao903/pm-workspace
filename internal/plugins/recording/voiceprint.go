// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// M5 声纹（设计 §14）：把 POC 的 VAD + CAM++ 分块 + 谱聚类 sidecar 内嵌进插件，
// 运行时写到 CacheDir()/recording/voiceprint.py 用本机 Python 跑；Go 侧按时间重叠给
// whisper 段落分配 label，再拿各簇质心与 recording_voiceprints 做余弦匹配。
// 说话人识别失败只影响说话人区，不改录音 status，转写/纪要照常。

const (
	// voiceprintModelName 是本插件认可的声纹模型名（CAM++ 中文通用，192 维）。
	voiceprintModelName = "campplus_cn_common"
	// voiceprintDim 是 CAM++ embedding 维度；sidecar 输出的维度必须等于它，否则整次失败。
	voiceprintDim = 192
	// diarizeTimeout 是一次 sidecar 的上限（设计 §14.3）。
	diarizeTimeout = 10 * time.Minute
	// sidecarLogLimit 是写日志时 stdout/stderr 各自的截断长度（按字）。
	sidecarLogLimit = 4000
	// sidecarCaptureLimit 是捕获子进程输出时最多留多少字节，防止日志把内存撑爆。
	sidecarCaptureLimit = 64 * 1024
	// voiceprintScriptName 是运行时写到缓存目录的 sidecar 文件名。
	voiceprintScriptName = "voiceprint.py"
)

/* ---------- sidecar 协议 ---------- */

// diarizeOutput 是 voiceprint.py 输出的 JSON（内部协议，不进契约文档）。
type diarizeOutput struct {
	Model    string                 `json:"model"`
	Dim      int                    `json:"dim"`
	Speakers []diarizeOutputSpeaker `json:"speakers"`
}

type diarizeOutputSpeaker struct {
	Label     string    `json:"label"`
	Embedding string    `json:"embedding"` // base64 小端 float32 x dim
	Segments  [][]int64 `json:"segments"`  // 合并后的连续段 [[start_ms,end_ms],...]
}

// diarizeSpeaker 是解析校验后的一个说话人：embedding 解开成 float32，label 已按首次出现顺序重排。
type diarizeSpeaker struct {
	Label     string
	Embedding []float32
	Segments  [][2]int64
}

// diarizeResult 是解析后的 sidecar 结果。
type diarizeResult struct {
	Model    string
	Dim      int
	Speakers []diarizeSpeaker
}

// parseDiarizeOutput 解析并校验 sidecar 输出：model 非空、dim==192、embedding 长度匹配、
// segments 是 [start,end] 合法区间；再按首次出现顺序把 label 重排成 spk_1、spk_2…
// 纯函数，单测覆盖 base64/dim/坏数据。
func parseDiarizeOutput(body []byte) (diarizeResult, error) {
	var raw diarizeOutput
	if err := json.Unmarshal(body, &raw); err != nil {
		return diarizeResult{}, fmt.Errorf("声纹 sidecar 输出的 JSON 解不开：%w", err)
	}
	model := strings.TrimSpace(raw.Model)
	if model == "" {
		return diarizeResult{}, errors.New("声纹 sidecar 输出缺少 model")
	}
	if raw.Dim != voiceprintDim {
		return diarizeResult{}, fmt.Errorf("声纹维度不对：期望 %d 维，实际 %d 维", voiceprintDim, raw.Dim)
	}
	out := diarizeResult{Model: model, Dim: raw.Dim, Speakers: make([]diarizeSpeaker, 0, len(raw.Speakers))}
	for i, sp := range raw.Speakers {
		encoded := strings.TrimSpace(sp.Embedding)
		if encoded == "" {
			return diarizeResult{}, fmt.Errorf("第 %d 个说话人没有 embedding", i+1)
		}
		blob, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return diarizeResult{}, fmt.Errorf("第 %d 个说话人的 embedding 不是合法 base64：%w", i+1, err)
		}
		if want := raw.Dim * 4; len(blob) != want {
			return diarizeResult{}, fmt.Errorf("第 %d 个说话人的 embedding 长度不对：期望 %d 字节（%d 维 float32），实际 %d 字节",
				i+1, want, raw.Dim, len(blob))
		}
		vec := make([]float32, raw.Dim)
		for k := range vec {
			vec[k] = math.Float32frombits(binary.LittleEndian.Uint32(blob[k*4:]))
		}
		segments := make([][2]int64, 0, len(sp.Segments))
		for k, seg := range sp.Segments {
			if len(seg) != 2 {
				return diarizeResult{}, fmt.Errorf("第 %d 个说话人的第 %d 段不是 [start_ms,end_ms]", i+1, k+1)
			}
			if seg[0] < 0 || seg[1] < seg[0] {
				return diarizeResult{}, fmt.Errorf("第 %d 个说话人的第 %d 段时间不合法：[%d,%d]", i+1, k+1, seg[0], seg[1])
			}
			segments = append(segments, [2]int64{seg[0], seg[1]})
		}
		out.Speakers = append(out.Speakers, diarizeSpeaker{Embedding: vec, Segments: segments})
	}
	// label 按首次出现顺序（最早一段的开始时间）重排；sidecar 给的 label 不作数。
	sort.SliceStable(out.Speakers, func(i, j int) bool {
		return firstSegmentStart(out.Speakers[i]) < firstSegmentStart(out.Speakers[j])
	})
	for i := range out.Speakers {
		out.Speakers[i].Label = fmt.Sprintf("spk_%d", i+1)
	}
	return out, nil
}

// firstSegmentStart 是一个说话人最早一段的开始时间；没段落排到最后。
func firstSegmentStart(sp diarizeSpeaker) int64 {
	if len(sp.Segments) == 0 {
		return math.MaxInt64
	}
	start := sp.Segments[0][0]
	for _, seg := range sp.Segments[1:] {
		if seg[0] < start {
			start = seg[0]
		}
	}
	return start
}

/* ---------- 段落归属 ---------- */

// assignSegmentSpeakerLabels 给 whisper 段落分配说话人 label：与哪个说话人的区间重叠最多就归谁；
// 一点重叠都没有时继承前一段的 label（第一段没有前一段就找时间上最近的）。
func assignSegmentSpeakerLabels(segs []Segment, speakers []diarizeSpeaker) []string {
	out := make([]string, len(segs))
	prev := ""
	for i, seg := range segs {
		best := -1
		var bestOverlap int64
		for j, sp := range speakers {
			var overlap int64
			for _, iv := range sp.Segments {
				overlap += intervalOverlapMs(seg.StartMs, seg.EndMs, iv[0], iv[1])
			}
			if overlap > bestOverlap {
				bestOverlap, best = overlap, j
			}
		}
		label := ""
		switch {
		case best >= 0 && bestOverlap > 0:
			label = speakers[best].Label
		case prev != "":
			label = prev
		default:
			label = nearestSpeakerLabel(seg, speakers)
		}
		out[i] = label
		if label != "" {
			prev = label
		}
	}
	return out
}

// intervalOverlapMs 是两段时间的重叠毫秒数。
func intervalOverlapMs(aStart, aEnd, bStart, bEnd int64) int64 {
	start, end := max(aStart, bStart), min(aEnd, bEnd)
	if end > start {
		return end - start
	}
	return 0
}

// nearestSpeakerLabel 找时间上离段落最近的说话人（第一段没有任何重叠时的兜底）。
func nearestSpeakerLabel(seg Segment, speakers []diarizeSpeaker) string {
	bestLabel := ""
	bestDist := int64(math.MaxInt64)
	for _, sp := range speakers {
		for _, iv := range sp.Segments {
			var dist int64
			switch {
			case seg.EndMs < iv[0]:
				dist = iv[0] - seg.EndMs
			case seg.StartMs > iv[1]:
				dist = seg.StartMs - iv[1]
			default:
				dist = 0
			}
			if dist < bestDist {
				bestDist, bestLabel = dist, sp.Label
			}
		}
	}
	return bestLabel
}

/* ---------- embedding 与余弦 ---------- */

// embeddingBytes 把 float32 质心转成库里存的小端字节（192 维 x 4 = 768 字节）。
func embeddingBytes(vec []float32) []byte {
	buf := make([]byte, 4*len(vec))
	for i, v := range vec {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(v))
	}
	return buf
}

// embeddingFloats 把库里的小端字节解回 float32；长度不是 4 的整数倍算坏数据。
func embeddingFloats(blob []byte) ([]float32, bool) {
	if len(blob) == 0 || len(blob)%4 != 0 {
		return nil, false
	}
	vec := make([]float32, len(blob)/4)
	for i := range vec {
		vec[i] = math.Float32frombits(binary.LittleEndian.Uint32(blob[i*4:]))
	}
	return vec, true
}

// cosineSimilarity 是两段等长向量的余弦相似度；长度不同/零向量算无效。
func cosineSimilarity(a, b []float32) (float64, bool) {
	if len(a) == 0 || len(a) != len(b) {
		return 0, false
	}
	var dot, na, nb float64
	for i := range a {
		x, y := float64(a[i]), float64(b[i])
		dot += x * y
		na += x * x
		nb += y * y
	}
	if na == 0 || nb == 0 {
		return 0, false
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb)), true
}

// voiceprintMatch 是一个说话人与已登记声纹的最佳匹配。
type voiceprintMatch struct {
	ContactID  string
	Similarity float64
}

// matchVoiceprints 给每个说话人找余弦最高且 ≥ threshold 的联系人；模型不一致的声纹跳过
// （skipped 返回跳过的条数，调用方记日志）。纯函数，单测覆盖 0/1/刚好等于阈值。
func matchVoiceprints(rows []speakerRow, vps []voiceprintRow, threshold float64) ([]*voiceprintMatch, int) {
	out := make([]*voiceprintMatch, len(rows))
	skipped := 0
	for i := range rows {
		vec, ok := embeddingFloats(rows[i].Embedding)
		if !ok || len(vec) != voiceprintDim {
			continue
		}
		best := -1
		bestSim := math.Inf(-1)
		for j := range vps {
			if vps[j].Model != rows[i].Model {
				skipped++
				continue
			}
			vpVec, ok := embeddingFloats(vps[j].Embedding)
			if !ok || len(vpVec) != len(vec) {
				skipped++
				continue
			}
			sim, ok := cosineSimilarity(vec, vpVec)
			if !ok {
				continue
			}
			if sim > bestSim {
				bestSim, best = sim, j
			}
		}
		if best >= 0 && bestSim >= threshold {
			// 相似度按契约收敛到 0–1（浮点误差可能让余弦略超 1）。
			out[i] = &voiceprintMatch{ContactID: vps[best].ContactID, Similarity: math.Min(1, math.Max(0, bestSim))}
		}
	}
	return out, skipped
}

// inheritSpeakerRows 是重跑继承规则（设计 §14.4/14.5）：新说话人质心与旧 row 质心余弦 ≥ threshold 时，
// 继承用户改过的显示名和手动联系人绑定；自动匹配已经填了联系人的不再改。
func inheritSpeakerRows(rows []speakerRow, old []speakerRow, threshold float64) {
	if len(old) == 0 {
		return
	}
	oldVecs := make([][]float32, len(old))
	for j := range old {
		if vec, ok := embeddingFloats(old[j].Embedding); ok {
			oldVecs[j] = vec
		}
	}
	for i := range rows {
		newVec, ok := embeddingFloats(rows[i].Embedding)
		if !ok {
			continue
		}
		best := -1
		bestSim := math.Inf(-1)
		for j := range oldVecs {
			if oldVecs[j] == nil {
				continue
			}
			sim, ok := cosineSimilarity(newVec, oldVecs[j])
			if !ok {
				continue
			}
			if sim > bestSim {
				bestSim, best = sim, j
			}
		}
		if best < 0 || bestSim < threshold {
			continue
		}
		prev := old[best]
		if strings.TrimSpace(rows[i].Name) == "" {
			rows[i].Name = prev.Name
		}
		if rows[i].ContactID == "" && prev.ContactID != "" {
			rows[i].ContactID = prev.ContactID
			rows[i].ContactName = prev.ContactName
			rows[i].Detected = false
		}
	}
}

/* ---------- 视图显示名 ---------- */

// speakerDisplayName 是说话人视图的名字优先级：用户改的名字 > 联系人现名 > 绑定快照 > 「说话人 N」。
func speakerDisplayName(userName, liveContactName, snapshotContactName, label string) string {
	if name := strings.TrimSpace(userName); name != "" {
		return name
	}
	if name := strings.TrimSpace(liveContactName); name != "" {
		return name
	}
	if name := strings.TrimSpace(snapshotContactName); name != "" {
		return name
	}
	if n := speakerNumber(label); n > 0 {
		return fmt.Sprintf("说话人 %d", n)
	}
	return "说话人"
}

// speakerNumber 从 spk_3 里取出 3；不是这个格式回 0。
func speakerNumber(label string) int {
	rest, ok := strings.CutPrefix(label, "spk_")
	if !ok {
		return 0
	}
	n, err := strconv.Atoi(rest)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

/* ---------- sidecar 执行 ---------- */

// ensureVoiceprintScript 把内嵌的 voiceprint.py 写到 CacheDir()/recording/voiceprint.py；
// 内容没变就不重写。返回脚本绝对路径。
func ensureVoiceprintScript(c plugin.Core) (string, error) {
	cache := c.CacheDir()
	if cache == "" {
		return "", errors.New("没有可用的缓存目录，跑不了说话人识别")
	}
	dir := filepath.Join(cache, "recording")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("建声纹脚本目录失败：%w", err)
	}
	path := filepath.Join(dir, voiceprintScriptName)
	if body, err := os.ReadFile(path); err == nil && bytes.Equal(body, voiceprintScript) {
		return path, nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, voiceprintScript, 0o644); err != nil {
		return "", fmt.Errorf("写声纹脚本失败：%w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("写声纹脚本失败：%w", err)
	}
	return path, nil
}

// limitedWriter 只保留前 max 字节，超出丢弃（日志只留开头足够定位问题）。
type limitedWriter struct {
	buf bytes.Buffer
	max int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if remain := w.max - w.buf.Len(); remain > 0 {
		if len(p) > remain {
			w.buf.Write(p[:remain])
		} else {
			w.buf.Write(p)
		}
	}
	return len(p), nil
}

func (w *limitedWriter) String() string { return w.buf.String() }

// runVoiceprintSidecar 启动 Python sidecar，最多等 10 分钟；stdout/stderr 各截断。
// 退出码 3 表示缺依赖（stderr 是给用户看的中文提示），按不可重试的错误返回。
func runVoiceprintSidecar(ctx context.Context, s Settings, script, input, out string) (string, string, error) {
	python := strings.TrimSpace(s.PythonPath)
	if python == "" {
		python = "python3"
	}
	ctx, cancel := context.WithTimeout(ctx, diarizeTimeout)
	defer cancel()
	args := []string{script, "--input", input, "--out", out}
	if dir := strings.TrimSpace(s.VoiceprintModelDir); dir != "" {
		args = append(args, "--model-dir", dir)
	}
	args = append(args, "--max-speakers", strconv.Itoa(effectiveMaxSpeakers(s)))
	cmd := exec.CommandContext(ctx, python, args...)
	// 不在缓存目录里留 __pycache__，日志/进度及时刷出来。
	cmd.Env = append(os.Environ(), "PYTHONDONTWRITEBYTECODE=1", "PYTHONUNBUFFERED=1")
	stdout := &limitedWriter{max: sidecarCaptureLimit}
	stderr := &limitedWriter{max: sidecarCaptureLimit}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	stdoutText, stderrText := stdout.String(), stderr.String()
	if err == nil {
		return stdoutText, stderrText, nil
	}
	// 先看上下文：超时/插件停用会把子进程杀掉，cmd.Run 只回 exit code -1，
	// 不能当成普通失败（超时要给用户明确提示，插件停用要放回队列）。
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return stdoutText, stderrText, permanent(fmt.Errorf("说话人识别超时（超过 %s），等机器闲一点再试", diarizeTimeout))
	}
	if ctx.Err() != nil {
		return stdoutText, stderrText, ctx.Err()
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if code := exitErr.ExitCode(); code == 3 {
			return stdoutText, stderrText, permanent(fmt.Errorf("本机 Python 缺少 funasr 依赖：%s", clip(strings.TrimSpace(stderrText), 1000)))
		}
		msg := strings.TrimSpace(stderrText)
		if msg == "" {
			msg = err.Error()
		}
		return stdoutText, stderrText, fmt.Errorf("说话人识别 sidecar 失败（python 退出码 %d）：%s", exitErr.ExitCode(), clip(msg, 1000))
	}
	return stdoutText, stderrText, permanent(fmt.Errorf("启动 Python 失败：%v，检查「设置 → 录音转写」里的 Python 路径", err))
}

/* ---------- 后台任务 ---------- */

// runDiarizeJob 跑一次说话人识别：转码 → sidecar → 段落标 label → 声纹匹配 → 整表替换说话人。
// 只动段落说话人/recording_speakers，不改录音 status 和 error（设计 §14.4）。
func (p *Plugin) runDiarizeJob(ctx context.Context, c plugin.Core, j jobRow, rec recordingRow, settings Settings) {
	segs, err := loadSegments(ctx, c.Store(), rec.ID)
	if err != nil {
		p.failDiarizeJob(ctx, c, j, err)
		return
	}
	if len(segs) == 0 {
		p.failDiarizeJob(ctx, c, j, permanent(errors.New("这条录音还没有转写段落，先转写再识别说话人")))
		return
	}
	if rec.AudioPath == "" {
		p.failDiarizeJob(ctx, c, j, permanent(errors.New("这条录音没有音频文件，识别不了说话人")))
		return
	}
	tools := detectTools(ctx, settings)
	if !tools.FFmpeg.OK {
		p.failDiarizeJob(ctx, c, j, permanent(errors.New(tools.FFmpeg.Error)))
		return
	}
	audioAbs, err := resolveAudioPath(c, rec.AudioPath)
	if err != nil {
		p.failDiarizeJob(ctx, c, j, permanent(err))
		return
	}
	cache := c.CacheDir()
	if cache == "" {
		p.failDiarizeJob(ctx, c, j, permanent(errors.New("没有可用的缓存目录，跑不了说话人识别")))
		return
	}
	script, err := ensureVoiceprintScript(c)
	if err != nil {
		p.failDiarizeJob(ctx, c, j, permanent(err))
		return
	}
	tmpDir := filepath.Join(cache, "tmp", rec.ID+"-diarize")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		p.failDiarizeJob(ctx, c, j, fmt.Errorf("建临时目录失败：%w", err))
		return
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	p.setJobProgress(c, j.ID, 5)
	wav := filepath.Join(tmpDir, "audio16k.wav")
	if err := convertToWav(ctx, tools.FFmpeg.Path, audioAbs, wav); err != nil {
		p.failDiarizeJob(ctx, c, j, err)
		return
	}
	p.setJobProgress(c, j.ID, 35)
	outPath := filepath.Join(tmpDir, "diarize.json")
	stdout, stderr, err := runVoiceprintSidecar(ctx, settings, script, wav, outPath)
	if err != nil {
		p.failDiarizeJob(ctx, c, j, err)
		return
	}
	if text := clip(strings.TrimSpace(stdout), sidecarLogLimit); text != "" {
		c.Log().Info("录音说话人识别 sidecar stdout", "recording", rec.ID, "text", text)
	}
	if text := clip(strings.TrimSpace(stderr), sidecarLogLimit); text != "" {
		c.Log().Info("录音说话人识别 sidecar stderr", "recording", rec.ID, "text", text)
	}
	p.setJobProgress(c, j.ID, 75)

	body, err := os.ReadFile(outPath)
	if err != nil {
		p.failDiarizeJob(ctx, c, j, fmt.Errorf("读不到声纹 sidecar 的输出：%w", err))
		return
	}
	res, err := parseDiarizeOutput(body)
	if err != nil {
		p.failDiarizeJob(ctx, c, j, permanent(err))
		return
	}
	labels := assignSegmentSpeakerLabels(segs, res.Speakers)
	newSegs := make([]Segment, len(segs))
	copy(newSegs, segs)
	for i := range newSegs {
		newSegs[i].Speaker = labels[i]
	}
	if err := replaceSegments(ctx, c.Store(), rec.ID, newSegs); err != nil {
		p.failDiarizeJob(ctx, c, j, err)
		return
	}

	now := nowRFC()
	rows := buildSpeakerRows(rec.ID, res, segs, labels, now)
	threshold := effectiveMatchThreshold(settings)
	vps, err := loadVoiceprints(ctx, c.Store())
	if err != nil {
		c.Log().Warn("录音说话人识别：读已登记声纹失败，跳过自动认人", "recording", rec.ID, "err", err)
		vps = nil
	}
	matches, skipped := matchVoiceprints(rows, vps, threshold)
	if skipped > 0 {
		c.Log().Warn("录音说话人识别：跳过模型/维度不一致的声纹", "recording", rec.ID, "count", skipped)
	}
	for i, m := range matches {
		if m == nil {
			continue
		}
		rows[i].ContactID = m.ContactID
		rows[i].Similarity = m.Similarity
		rows[i].Detected = true
		rows[i].ContactName = liveContactName(ctx, c, m.ContactID)
	}
	old, err := loadSpeakers(ctx, c.Store(), rec.ID)
	if err != nil {
		c.Log().Warn("录音说话人识别：读旧说话人失败，跳过继承", "recording", rec.ID, "err", err)
	} else {
		inheritSpeakerRows(rows, old, threshold)
	}
	if err := replaceSpeakers(ctx, c.Store(), rec.ID, rows); err != nil {
		p.failDiarizeJob(ctx, c, j, err)
		return
	}
	if _, err := c.Store().Exec(ctx, `UPDATE recording_jobs SET status = 'done', progress = 100, last_error = '', updated_at = ? WHERE id = ?`,
		nowRFC(), j.ID); err != nil {
		c.Log().Warn("recording worker: 收尾任务失败", "job", j.ID, "err", err)
	}
	c.Log().Info("录音说话人识别完成", "recording", rec.ID, "speakers", len(rows), "segments", len(newSegs))
}

// buildSpeakerRows 按 sidecar 结果拼 recording_speakers 行，段落数/总时长从分配结果算。
func buildSpeakerRows(recordingID string, res diarizeResult, segs []Segment, labels []string, now string) []speakerRow {
	type stat struct {
		segments   int
		durationMs int64
	}
	stats := make(map[string]*stat, len(res.Speakers))
	for i, label := range labels {
		if label == "" {
			continue
		}
		st := stats[label]
		if st == nil {
			st = &stat{}
			stats[label] = st
		}
		st.segments++
		if d := segs[i].EndMs - segs[i].StartMs; d > 0 {
			st.durationMs += d
		}
	}
	rows := make([]speakerRow, 0, len(res.Speakers))
	for _, sp := range res.Speakers {
		row := speakerRow{
			RecordingID: recordingID, Label: sp.Label, Embedding: embeddingBytes(sp.Embedding),
			Model: res.Model, CreatedAt: now, UpdatedAt: now,
		}
		if st := stats[sp.Label]; st != nil {
			row.Segments, row.DurationMs = st.segments, st.durationMs
		}
		rows = append(rows, row)
	}
	return rows
}

// autoDiarize 转写成功后按设置自动排一条 diarize 任务（排在自动纪要之前，同一条 worker 串行跑）。
func (p *Plugin) autoDiarize(ctx context.Context, c plugin.Core, rec recordingRow, settings Settings, hasSegments bool) {
	if !settings.AutoDiarize || !hasSegments {
		return
	}
	busy, err := activeJob(ctx, c.Store(), rec.ID, "diarize")
	if err != nil {
		c.Log().Warn("recording: 查说话人识别任务失败", "recording", rec.ID, "err", err)
		return
	}
	if busy {
		return
	}
	if _, err := createJob(ctx, c.Store(), rec.ID, "diarize"); err != nil {
		c.Log().Warn("recording: 排说话人识别任务失败", "recording", rec.ID, "err", err)
	}
}

// failDiarizeJob 处理说话人识别失败：只把任务标 failed 写 last_error，
// 绝不改录音 status/error（转写/纪要不受影响）。插件停用时放回队列。
func (p *Plugin) failDiarizeJob(ctx context.Context, c plugin.Core, j jobRow, cause error) {
	msg := clip(cause.Error(), 1000)
	if ctx.Err() != nil {
		bg, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = c.Store().Exec(bg, `UPDATE recording_jobs SET status = 'pending', next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
			nowRFC(), "插件停用，任务稍后继续", nowRFC(), j.ID)
		return
	}
	if _, err := c.Store().Exec(ctx, `UPDATE recording_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
		msg, nowRFC(), j.ID); err != nil {
		c.Log().Warn("recording worker: 标记说话人识别任务失败失败", "job", j.ID, "err", err)
	}
	c.Log().Warn("录音说话人识别失败（录音状态不变）", "recording", j.RecordingID, "job", j.ID, "err", msg)
}

// liveContactName 现查联系人名；查不到（已删/已归档不可见）回空串，视图会退回快照。
func liveContactName(ctx context.Context, c plugin.Core, contactID string) string {
	if contactID == "" {
		return ""
	}
	info, err := c.Contacts().Get(ctx, contactID)
	if err != nil {
		return ""
	}
	return info.Name
}
