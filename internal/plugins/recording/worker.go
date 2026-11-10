// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

const (
	// workerTick 是后台队列的轮询间隔。
	workerTick = 2 * time.Second
	// maxJobAttempts 是同一任务最多试几次。
	maxJobAttempts = 3
)

// permanentError 是不该自动重试的错误：工具没装、模型没下载、音频丢了、
// 参数不对这类，重试只会重复失败，直接把原因给用户。
type permanentError struct{ err error }

func (e *permanentError) Error() string { return e.err.Error() }
func (e *permanentError) Unwrap() error { return e.err }

func permanent(err error) error {
	if err == nil {
		return nil
	}
	return &permanentError{err: err}
}

func isPermanent(err error) bool {
	var p *permanentError
	return errors.As(err, &p)
}

// runWorker 是常驻后台任务：每 2 秒取一条到期的 pending 任务跑，一次只跑一条。
// 转写串行是故意的：同时跑多个 whisper 会抢 CPU/内存，还会互相拖慢。
func runWorker(ctx context.Context, p *Plugin, c plugin.Core) error {
	p.mu.Lock()
	p.workerCtx = ctx
	p.mu.Unlock()
	tick := time.NewTicker(workerTick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		// 进程重启/插件重装时，库里可能留着上一次「running」的任务（真正在跑的那次已经随进程没了）。
		// 启动时统一放回 pending 重跑，避免录音永远停在 summarizing/transcribing。
		if _, err := c.Store().Exec(ctx, `UPDATE recording_jobs SET status = 'pending', progress = 0, updated_at = ? WHERE status = 'running'`, nowRFC()); err != nil {
			c.Log().Warn("recording worker: 重置中断任务失败", "err", err)
		}
		j, ok, err := claimJob(ctx, c.Store())
		if err != nil {
			c.Log().Error("recording worker: 取任务失败", "err", err)
		}
		if !ok {
			select {
			case <-ctx.Done():
				return nil
			case <-tick.C:
			}
			continue
		}
		p.runJob(ctx, c, j)
	}
}

// runJob 跑一条任务：transcribe（M1）、summarize（M4a）或 diarize（M5）。
func (p *Plugin) runJob(ctx context.Context, c plugin.Core, j jobRow) {
	settings, err := loadSettings(ctx, c)
	if err != nil {
		p.failAnyJob(ctx, c, j, err)
		return
	}
	rec, err := loadRecording(ctx, c.Store(), j.RecordingID)
	if err != nil {
		p.failAnyJob(ctx, c, j, permanent(fmt.Errorf("找不到录音：%w", err)))
		return
	}
	switch j.Kind {
	case "transcribe":
		p.runTranscribeJob(ctx, c, j, rec, settings)
	case "summarize":
		p.runSummarizeJob(ctx, c, j, rec, settings)
	case "diarize":
		p.runDiarizeJob(ctx, c, j, rec, settings)
	default:
		p.failJob(ctx, c, j, permanent(fmt.Errorf("不认识的任务类型：%s", j.Kind)))
	}
}

// failAnyJob 在还没进到具体任务分支时处理失败：diarize 走独立逻辑（不改录音 status），其它走 failJob。
func (p *Plugin) failAnyJob(ctx context.Context, c plugin.Core, j jobRow, cause error) {
	if j.Kind == "diarize" {
		p.failDiarizeJob(ctx, c, j, cause)
		return
	}
	p.failJob(ctx, c, j, cause)
}

// runTranscribeJob 跑转写：ffmpeg + whisper → 段落/全文落库 → 写 transcript.md → 自动纪要。
func (p *Plugin) runTranscribeJob(ctx context.Context, c plugin.Core, j jobRow, rec recordingRow, settings Settings) {
	if _, err := c.Store().Exec(ctx, `UPDATE recording_recordings SET status = 'transcribing', error = '', updated_at = ? WHERE id = ?`,
		nowRFC(), rec.ID); err != nil {
		p.failJob(ctx, c, j, err)
		return
	}
	// 每条录音可以单独指定模型/语言；没指定用设置的默认值
	eff := settings
	if rec.Model != "" {
		eff.Model = rec.Model
	}
	if rec.Language != "" {
		eff.Language = rec.Language
	}
	var lastWrite time.Time
	onProgress := func(pct int) {
		if pct < 0 {
			pct = 0
		}
		if pct > 100 {
			pct = 100
		}
		if !lastWrite.IsZero() && time.Since(lastWrite) < time.Second {
			return
		}
		lastWrite = time.Now()
		p.setJobProgress(c, j.ID, pct)
	}
	segs, transcript, err := transcribeAudio(ctx, c, eff, rec, onProgress)
	if err != nil {
		p.failJob(ctx, c, j, err)
		return
	}
	if err := replaceSegments(ctx, c.Store(), rec.ID, segs); err != nil {
		p.failJob(ctx, c, j, err)
		return
	}
	now := nowRFC()
	if _, err := c.Store().Exec(ctx, `UPDATE recording_recordings SET status = 'transcribed', transcript = ?, model = ?, language = ?, error = '', updated_at = ? WHERE id = ?`,
		transcript, eff.Model, eff.Language, now, rec.ID); err != nil {
		p.failJob(ctx, c, j, err)
		return
	}
	if _, err := c.Store().Exec(ctx, `UPDATE recording_jobs SET status = 'done', progress = 100, last_error = '', updated_at = ? WHERE id = ?`,
		nowRFC(), j.ID); err != nil {
		c.Log().Warn("recording worker: 收尾任务失败", "job", j.ID, "err", err)
	}
	rec.Transcript, rec.Model, rec.Language, rec.Status, rec.UpdatedAt = transcript, eff.Model, eff.Language, "transcribed", now
	// 每录音一个文件夹：转写成功写 transcript.md（失败只记日志）
	writeTranscriptFile(c, rec)
	if err := c.Events().Publish(ctx, "recording.transcribed", map[string]any{
		"recording_id": rec.ID,
		"title":        rec.Title,
		"segments":     len(segs),
		"duration_ms":  rec.DurationMs,
	}); err != nil {
		c.Log().Warn("recording worker: 发事件失败", "err", err)
	}
	c.Log().Info("录音转写完成", "recording", rec.ID, "segments", len(segs), "model", eff.Model)
	// 先排说话人识别，再排自动纪要：同一条 worker 串行跑，说话人结果先进库。
	p.autoDiarize(ctx, c, rec, settings, len(segs) > 0)
	p.autoSummarize(ctx, c, rec, settings)
}

// runSummarizeJob 跑纪要：生成纪要 + 提取候选，状态 summarizing → ready。
func (p *Plugin) runSummarizeJob(ctx context.Context, c plugin.Core, j jobRow, rec recordingRow, settings Settings) {
	if _, err := c.Store().Exec(ctx, `UPDATE recording_recordings SET status = 'summarizing', error = '', updated_at = ? WHERE id = ?`,
		nowRFC(), rec.ID); err != nil {
		p.failJob(ctx, c, j, err)
		return
	}
	p.setJobProgress(c, j.ID, 3)
	mins, todos, err := p.summarizeRecording(ctx, c, rec, settings, func(pct int) {
		p.setJobProgress(c, j.ID, pct)
	})
	if err != nil {
		p.failJob(ctx, c, j, err)
		return
	}
	if _, err := c.Store().Exec(ctx, `UPDATE recording_jobs SET status = 'done', progress = 100, last_error = '', updated_at = ? WHERE id = ?`,
		nowRFC(), j.ID); err != nil {
		c.Log().Warn("recording worker: 收尾任务失败", "job", j.ID, "err", err)
	}
	if err := c.Events().Publish(ctx, "recording.minutes_ready", map[string]any{
		"recording_id":  rec.ID,
		"title":         rec.Title,
		"todos":         len(todos),
		"actions":       len(mins.Actions),
		"conclusions":   len(mins.Conclusions),
		"minutes_model": mins.Model,
	}); err != nil {
		c.Log().Warn("recording worker: 发事件失败", "err", err)
	}
	c.Log().Info("录音纪要完成", "recording", rec.ID, "todos", len(todos), "model", mins.Model)
}

// autoSummarize 转写完成后的自动纪要：minutes_flow 非空走 SOP；为空或 SOP 没启用就排队 summarize。
func (p *Plugin) autoSummarize(ctx context.Context, c plugin.Core, rec recordingRow, settings Settings) {
	if !settings.AutoSummarize {
		return
	}
	if strings.TrimSpace(rec.Transcript) == "" {
		c.Log().Warn("recording: 转写结果为空，不自动生成纪要", "recording", rec.ID)
		return
	}
	if flow := strings.TrimSpace(settings.MinutesFlow); flow != "" {
		_, err := c.Runs().StartSOP(ctx, plugin.SOPRunStart{
			Flow:     flow,
			Input:    map[string]any{"recording_id": rec.ID},
			ObjectID: rec.ProjectID,
		})
		if err == nil {
			c.Log().Info("录音转写后发起纪要 SOP", "recording", rec.ID, "flow", flow)
			return
		}
		// SOP 没启用（ErrNoSOPStarter）或流程有问题：回退到插件内直连，不因为 SOP 没开而失败
		c.Log().Warn("recording: 发起纪要 SOP 失败，回退到插件内直连", "recording", rec.ID, "flow", flow, "err", err)
	}
	if _, err := createJob(ctx, c.Store(), rec.ID, "summarize"); err != nil {
		c.Log().Warn("recording: 排纪要任务失败", "recording", rec.ID, "err", err)
	}
}

// setJobProgress 写进度；用独立的短超时，插件停用（ctx 取消）时也尽量把最后进度落库。
func (p *Plugin) setJobProgress(c plugin.Core, jobID string, pct int) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := c.Store().Exec(ctx, `UPDATE recording_jobs SET progress = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
		pct, nowRFC(), jobID); err != nil {
		c.Log().Warn("recording worker: 写进度失败", "job", jobID, "err", err)
	}
}

// failJob 处理任务失败：插件停用放回队列；可重试的错误按退避重试；否则落 failed。
// 转写失败退回 uploaded（可重试转写）；纪要失败退回 transcribed（可重新生成）。
func (p *Plugin) failJob(ctx context.Context, c plugin.Core, j jobRow, cause error) {
	msg := clip(cause.Error(), 1000)
	revert := "uploaded"
	if j.Kind == "summarize" {
		revert = "transcribed"
	}
	if ctx.Err() != nil {
		// 插件停用/进程正在退出：把任务放回队列，下次启用接着跑
		bg, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = c.Store().Exec(bg, `UPDATE recording_jobs SET status = 'pending', next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
			nowRFC(), "插件停用，任务稍后继续", nowRFC(), j.ID)
		_, _ = c.Store().Exec(bg, `UPDATE recording_recordings SET status = ?, error = '', updated_at = ? WHERE id = ?`,
			revert, nowRFC(), j.RecordingID)
		return
	}
	retry := !isPermanent(cause) && j.Attempts < maxJobAttempts
	if retry {
		next := time.Now().Add(retryBackoff(j.Attempts)).UTC().Format(time.RFC3339)
		if _, err := c.Store().Exec(ctx, `UPDATE recording_jobs SET status = 'pending', next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
			next, msg, nowRFC(), j.ID); err != nil {
			c.Log().Warn("recording worker: 重排任务失败", "job", j.ID, "err", err)
		}
		_, _ = c.Store().Exec(ctx, `UPDATE recording_recordings SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
			revert, msg, nowRFC(), j.RecordingID)
		return
	}
	if _, err := c.Store().Exec(ctx, `UPDATE recording_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
		msg, nowRFC(), j.ID); err != nil {
		c.Log().Warn("recording worker: 标记失败任务失败", "job", j.ID, "err", err)
	}
	_, _ = c.Store().Exec(ctx, `UPDATE recording_recordings SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
		revert, msg, nowRFC(), j.RecordingID)
	c.Log().Warn("录音任务失败", "recording", j.RecordingID, "kind", j.Kind, "job", j.ID, "attempts", j.Attempts, "err", msg)
}
