// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

var (
	errValidation = errors.New("validation")
	errNotFound   = errors.New("not_found")
	errConflict   = errors.New("conflict")
)

// apiErr 包一层错误类别，fail 按类别映射状态码。
func apiErr(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{kind}, args...)...)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// fail 按内核的错误信封写回：{"error":{"code","message"}}。
func (h *handlers) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, errNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, errValidation):
		status, code = http.StatusBadRequest, "validation"
	case errors.Is(err, errConflict):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, plugin.ErrNotGranted):
		status, code = http.StatusForbidden, "readonly"
	default:
		h.c.Log().Error("recording request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		msg = "internal server error"
	}
	if code != "internal" {
		_, msg, _ = strings.Cut(msg, ": ")
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

// decodeBody 解析 JSON body：不认识的字段直接 400，空 body 当空结构体。
func decodeBody(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return apiErr(errValidation, "请求内容不合法：%v", err)
	}
	return nil
}

// ---------- 视图 ----------

// jobView 是任务在界面上的样子。
type jobView struct {
	Kind      string `json:"kind"`
	Status    string `json:"status"`
	Progress  int    `json:"progress"`
	Attempts  int    `json:"attempts"`
	LastError string `json:"last_error"`
}

// RecordingSummary 是列表里的一条录音（不带全文和段落）。
type RecordingSummary struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	Status       string   `json:"status"`
	Model        string   `json:"model"`
	Language     string   `json:"language"`
	DurationMs   int64    `json:"duration_ms"`
	AudioSize    int64    `json:"audio_size"`
	HasAudio     bool     `json:"has_audio"`
	HasMinutes   bool     `json:"has_minutes"`
	ProjectID    string   `json:"project_id"`
	ProjectTitle string   `json:"project_title"`
	Error        string   `json:"error"`
	Attempts     int      `json:"attempts"`
	Job          *jobView `json:"job"`
	TaskCount    int      `json:"task_count"`
	TodosPending int      `json:"todos_pending"`
	SpeakerCount int      `json:"speaker_count"`
	CreatedAt    string   `json:"created_at"`
	UpdatedAt    string   `json:"updated_at"`
}

// RecordingDetail 是详情（含段落和可编辑全文）。
type RecordingDetail struct {
	RecordingSummary
	Engine       string             `json:"engine"`
	AudioMime    string             `json:"audio_mime"`
	Transcript   string             `json:"transcript"`
	Segments     []Segment          `json:"segments"`
	Minutes      *RecordingMinutes  `json:"minutes"`
	MinutesModel string             `json:"minutes_model"`
	Todos        []RecordingTodo    `json:"todos"`
	Speakers     []RecordingSpeaker `json:"speakers"`
}

// MetaView 是 GET /meta 的返回：工具、模型、设置、默认值。
type MetaView struct {
	Tools    Tools          `json:"tools"`
	Models   []ModelInfo    `json:"models"`
	Settings Settings       `json:"settings"`
	ModelDir string         `json:"model_dir"`
	Defaults map[string]any `json:"defaults"`
}

// toJobView 把库里的任务转成视图。
func toJobView(j *jobRow) *jobView {
	if j == nil {
		return nil
	}
	return &jobView{Kind: j.Kind, Status: j.Status, Progress: j.Progress, Attempts: j.Attempts, LastError: j.LastError}
}

// projectTitle 查项目标题；查不到或没挂项目返回空串（不拦请求）。
func (h *handlers) projectTitle(r *http.Request, projectID string) string {
	if projectID == "" {
		return ""
	}
	obj, err := h.c.Objects().Get(r.Context(), projectID)
	if err != nil {
		return ""
	}
	return obj.Title
}

// summary 由库里的行拼列表视图（不查段落）。
func (h *handlers) summary(r *http.Request, rec recordingRow) RecordingSummary {
	job, err := latestJob(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.c.Log().Warn("recording: 查任务失败", "recording", rec.ID, "err", err)
	}
	tasks, err := taskCount(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.c.Log().Warn("recording: 查任务数失败", "recording", rec.ID, "err", err)
	}
	pending, err := todosPending(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.c.Log().Warn("recording: 查待确认候选失败", "recording", rec.ID, "err", err)
	}
	speakers, err := speakerCount(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.c.Log().Warn("recording: 查说话人数失败", "recording", rec.ID, "err", err)
	}
	return RecordingSummary{
		ID: rec.ID, Title: rec.Title, Status: rec.Status, Model: rec.Model, Language: rec.Language,
		DurationMs: rec.DurationMs, AudioSize: rec.AudioSize, HasAudio: rec.AudioPath != "",
		HasMinutes: rec.MinutesJSON != "", ProjectID: rec.ProjectID, ProjectTitle: h.projectTitle(r, rec.ProjectID),
		Error: rec.Error, Attempts: rec.Attempts, Job: toJobView(job), TaskCount: tasks, TodosPending: pending,
		SpeakerCount: speakers, CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt,
	}
}

// view 由库里的行拼详情视图，含段落、纪要和候选。
func (h *handlers) view(r *http.Request, rec recordingRow) (RecordingDetail, error) {
	segs, err := loadSegments(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		return RecordingDetail{}, err
	}
	todos, err := loadTodos(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		return RecordingDetail{}, err
	}
	speakers, err := h.speakerViews(r, rec.ID)
	if err != nil {
		return RecordingDetail{}, err
	}
	return RecordingDetail{
		RecordingSummary: h.summary(r, rec),
		Engine:           rec.Engine,
		AudioMime:        rec.AudioMIME,
		Transcript:       rec.Transcript,
		Segments:         segs,
		Minutes:          parseStoredMinutes(rec.MinutesJSON),
		MinutesModel:     rec.MinutesModel,
		Todos:            todoViews(todos),
		Speakers:         speakers,
	}, nil
}

// speakerViews 拼一条录音的说话人视图。
// 显示名优先级（设计 §14.5）：用户改的名字 > 联系人现名 > 绑定快照 >「说话人 N」。
func (h *handlers) speakerViews(r *http.Request, recordingID string) ([]RecordingSpeaker, error) {
	rows, err := loadSpeakers(r.Context(), h.c.Store(), recordingID)
	if err != nil {
		return nil, err
	}
	out := make([]RecordingSpeaker, 0, len(rows))
	for _, row := range rows {
		live := liveContactName(r.Context(), h.c, row.ContactID)
		out = append(out, speakerView(row, live))
	}
	return out, nil
}

// speakerView 把库里的说话人行转成视图；liveContactName 是联系人现名（查不到空串）。
func speakerView(row speakerRow, liveContactName string) RecordingSpeaker {
	contactName := strings.TrimSpace(liveContactName)
	if contactName == "" {
		contactName = row.ContactName
	}
	return RecordingSpeaker{
		Label:       row.Label,
		Name:        speakerDisplayName(row.Name, liveContactName, row.ContactName, row.Label),
		ContactID:   row.ContactID,
		ContactName: contactName,
		Similarity:  row.Similarity,
		Segments:    row.Segments,
		DurationMs:  row.DurationMs,
		Detected:    row.Detected,
	}
}

// parseStoredMinutes 把库里的 minutes_json 解析成视图；空串或坏数据回 nil（列表/详情不因为坏数据 500）。
func parseStoredMinutes(raw string) *RecordingMinutes {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var mins RecordingMinutes
	if err := json.Unmarshal([]byte(raw), &mins); err != nil {
		return nil
	}
	return &mins
}

// loadRecording 按路径里的 {id} 读一条录音；不存在时写 404 并返回 false。
func (h *handlers) loadRecording(w http.ResponseWriter, r *http.Request) (recordingRow, bool) {
	id := r.PathValue("id")
	rec, err := loadRecording(r.Context(), h.c.Store(), id)
	if err != nil {
		h.fail(w, r, apiErr(errNotFound, "录音 %s 不存在", id))
		return recordingRow{}, false
	}
	return rec, true
}

// ---------- 录音 ----------

func (h *handlers) listRecordings(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := clampInt(q.Get("limit"), 50, 1, 200)
	offset := clampInt(q.Get("offset"), 0, 0, 1<<31-1)
	rows, total, err := listRecordings(r.Context(), h.c.Store(), listFilter{
		status: q.Get("status"), projectID: q.Get("project_id"), q: strings.TrimSpace(q.Get("q")), limit: limit, offset: offset,
	})
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := make([]RecordingSummary, 0, len(rows))
	for _, rec := range rows {
		out = append(out, h.summary(r, rec))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total, "limit": limit, "offset": offset}})
}

func (h *handlers) createRecording(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title     string `json:"title"`
		ProjectID string `json:"project_id"`
		Model     string `json:"model"`
		Language  string `json:"language"`
	}
	if err := decodeBody(r, &req); err != nil {
		h.fail(w, r, err)
		return
	}
	s, err := loadSettings(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "录音 " + timeNowTitle()
	}
	if len([]rune(title)) > 200 {
		h.fail(w, r, apiErr(errValidation, "标题最多 200 个字"))
		return
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = s.Model
	}
	if _, ok := catalogByName[model]; !ok {
		h.fail(w, r, apiErr(errValidation, "模型只能是 %s", modelNameList()))
		return
	}
	language := strings.TrimSpace(req.Language)
	if language == "" {
		language = s.Language
	}
	if !languageRe.MatchString(language) {
		h.fail(w, r, apiErr(errValidation, "语言要用 whisper 的语言码（zh、en、yue、ja…）或 auto"))
		return
	}
	projectID := strings.TrimSpace(req.ProjectID)
	if projectID == "" {
		projectID = s.DefaultProjectID
	}
	now := nowRFC()
	rec := recordingRow{
		ID: newID("rec_"), Title: title, Status: "draft", Engine: "whisper_local", Model: model, Language: language,
		ProjectID: projectID, CreatedAt: now, UpdatedAt: now,
	}
	if err := insertRecording(r.Context(), h.c.Store(), rec); err != nil {
		h.fail(w, r, err)
		return
	}
	view, err := h.view(r, rec)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": view})
}

func (h *handlers) getRecording(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	view, err := h.view(r, rec)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": view})
}

func (h *handlers) patchRecording(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	var req struct {
		Title      *string `json:"title"`
		ProjectID  *string `json:"project_id"`
		Transcript *string `json:"transcript"`
	}
	if err := decodeBody(r, &req); err != nil {
		h.fail(w, r, err)
		return
	}
	title, projectID, transcript := rec.Title, rec.ProjectID, rec.Transcript
	if req.Title != nil {
		title = strings.TrimSpace(*req.Title)
		if title == "" {
			h.fail(w, r, apiErr(errValidation, "标题不能为空"))
			return
		}
		if len([]rune(title)) > 200 {
			h.fail(w, r, apiErr(errValidation, "标题最多 200 个字"))
			return
		}
	}
	if req.ProjectID != nil {
		projectID = strings.TrimSpace(*req.ProjectID)
	}
	if req.Transcript != nil {
		transcript = *req.Transcript
		if len([]rune(transcript)) > 2_000_000 {
			h.fail(w, r, apiErr(errValidation, "转写文本太长（上限约 200 万字）"))
			return
		}
	}
	var project any
	if projectID != "" {
		project = projectID
	}
	if _, err := h.c.Store().Exec(r.Context(), `UPDATE recording_recordings SET title = ?, project_id = ?, transcript = ?, updated_at = ? WHERE id = ?`,
		title, project, transcript, nowRFC(), rec.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	rec2, err := loadRecording(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	// 每录音一个文件夹：改了标题或全文就把 transcript.md 重写一遍（写失败只记日志）
	if req.Title != nil || req.Transcript != nil {
		writeTranscriptFile(h.c, rec2)
	}
	view, err := h.view(r, rec2)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": view})
}

func (h *handlers) deleteRecording(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if err := plugin.Require(h.c, "fs:write:attachments"); err != nil {
		h.fail(w, r, err)
		return
	}
	if err := os.RemoveAll(audioDir(h.c, rec.ID)); err != nil {
		h.fail(w, r, fmt.Errorf("删音频文件失败：%w", err))
		return
	}
	if err := deleteRecordingRows(r.Context(), h.c.Store(), rec.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	h.c.Audit().Note(r.Context(), plugin.AuditNote{
		Action: "delete", TargetType: "recording", TargetID: rec.ID,
		Summary: "删除录音「" + clip(rec.Title, 60) + "」",
	}, plugin.WriteMeta{})
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]bool{"ok": true}})
}

// retranscribe 重新排队转写：失败了重试，或者换了模型想重跑。
func (h *handlers) retranscribe(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if err := plugin.Require(h.c, "process:spawn"); err != nil {
		h.fail(w, r, err)
		return
	}
	if rec.AudioPath == "" {
		h.fail(w, r, apiErr(errValidation, "这条录音还没有音频，先录一段"))
		return
	}
	busy, err := activeJob(r.Context(), h.c.Store(), rec.ID, "transcribe")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if busy {
		h.fail(w, r, apiErr(errConflict, "这条录音已经在转写了"))
		return
	}
	if _, err := h.c.Store().Exec(r.Context(), `UPDATE recording_recordings SET status = 'uploaded', error = '', updated_at = ? WHERE id = ?`,
		nowRFC(), rec.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	if _, err := createJob(r.Context(), h.c.Store(), rec.ID, "transcribe"); err != nil {
		h.fail(w, r, err)
		return
	}
	rec2, err := loadRecording(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	view, err := h.view(r, rec2)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": view})
}

// ---------- M4a：纪要、SOP、文件、候选 ----------

// postMinutes 重新生成纪要（插件内直连 Agent，不等跑完）：没转写 400，正在生成 409，回 202 + Recording。
func (h *handlers) postMinutes(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if strings.TrimSpace(rec.Transcript) == "" {
		h.fail(w, r, apiErr(errValidation, "这条录音还没有转写全文，先转写再生成纪要"))
		return
	}
	busy, err := activeJob(r.Context(), h.c.Store(), rec.ID, "summarize")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	// 只认「有排队/在跑的 summarize 任务」；状态停在 summarizing 但没有活任务（比如进程重启过）允许重新生成。
	if busy {
		h.fail(w, r, apiErr(errConflict, "这条录音正在生成纪要，等它跑完"))
		return
	}
	if _, err := h.c.Store().Exec(r.Context(), `UPDATE recording_recordings SET status = 'summarizing', error = '', updated_at = ? WHERE id = ?`,
		nowRFC(), rec.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	if _, err := createJob(r.Context(), h.c.Store(), rec.ID, "summarize"); err != nil {
		// 没排上任务就把状态改回去，别让界面一直停在「生成中」。
		if _, rbErr := h.c.Store().Exec(r.Context(), `UPDATE recording_recordings SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
			rec.Status, rec.Error, nowRFC(), rec.ID); rbErr != nil {
			h.c.Log().Warn("recording: 回滚状态失败", "recording", rec.ID, "err", rbErr)
		}
		h.fail(w, r, err)
		return
	}
	rec2, err := loadRecording(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	view, err := h.view(r, rec2)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": view})
}

// postSOP 发起纪要 SOP（body {flow?}：空用设置 minutes_flow，再空用内置流程）。
// SOP 编排插件没启用 409，流程不存在 400；回 202 {flow, run_id}。
func (h *handlers) postSOP(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	var req struct {
		Flow string `json:"flow"`
	}
	if err := decodeBody(r, &req); err != nil {
		h.fail(w, r, err)
		return
	}
	flow := strings.TrimSpace(req.Flow)
	if flow == "" {
		s, err := loadSettings(r.Context(), h.c)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		flow = strings.TrimSpace(s.MinutesFlow)
	}
	if flow == "" {
		flow = MinutesFlowID
	}
	runID, err := h.c.Runs().StartSOP(r.Context(), plugin.SOPRunStart{
		Flow:     flow,
		Input:    map[string]any{"recording_id": rec.ID},
		ObjectID: rec.ProjectID,
	})
	if err != nil {
		if errors.Is(err, plugin.ErrNoSOPStarter) {
			h.fail(w, r, apiErr(errConflict, "SOP 编排插件没启用，装好并启用后再发起；也可以直接用「生成纪要」"))
			return
		}
		h.fail(w, r, apiErr(errValidation, "发起 SOP 失败：%v", err))
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": map[string]any{
		"flow":   flow,
		"run_id": runID,
	}})
}

// listFiles 现查磁盘列生成的文件。
func (h *handlers) listFiles(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if err := plugin.Require(h.c, "fs:read:attachments"); err != nil {
		h.fail(w, r, err)
		return
	}
	files := listRecordingFiles(h.c, rec.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"data": files,
		"meta": map[string]int{"total": len(files)},
	})
}

// downloadFile 下载一个生成的文件；name 只认白名单（嵌套名字要用 %2F 编码，如 diagrams%2Fflow.mmd）。
func (h *handlers) downloadFile(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if err := plugin.Require(h.c, "fs:read:attachments"); err != nil {
		h.fail(w, r, err)
		return
	}
	name := r.PathValue("name")
	abs := recordingFilePath(h.c, rec.ID, name)
	if abs == "" {
		h.fail(w, r, apiErr(errNotFound, "文件 %s 不在可下载清单里", name))
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		h.fail(w, r, apiErr(errNotFound, "文件 %s 还没生成", name))
		return
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		h.fail(w, r, apiErr(errNotFound, "文件 %s 不可读", name))
		return
	}
	ct := "text/plain; charset=utf-8"
	if strings.HasSuffix(name, ".json") {
		ct = "application/json; charset=utf-8"
	} else if strings.HasSuffix(name, ".md") {
		ct = "text/markdown; charset=utf-8"
	}
	header := w.Header()
	header.Set("Content-Type", ct)
	header.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(name)}))
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, filepath.Base(name), fi.ModTime(), f)
}

// postConfirmTodo 确认一条候选；任务/目标建任务，项目候选挂项目。
func (h *handlers) postConfirmTodo(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	index, err := strconv.Atoi(r.PathValue("index"))
	if err != nil || index < 0 {
		h.fail(w, r, apiErr(errValidation, "候选序号不合法"))
		return
	}
	var req confirmTodoRequest
	if err := decodeBody(r, &req); err != nil {
		h.fail(w, r, err)
		return
	}
	todo, err := h.confirmTodo(r.Context(), rec, index, req)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": todo})
}

// postIgnoreTodo 忽略一条候选。
func (h *handlers) postIgnoreTodo(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	index, err := strconv.Atoi(r.PathValue("index"))
	if err != nil || index < 0 {
		h.fail(w, r, apiErr(errValidation, "候选序号不合法"))
		return
	}
	todo, err := h.ignoreTodo(r.Context(), rec, index)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": todo})
}

// ---------- M5：说话人分离与声纹 ----------

// postDiarize 手工重跑说话人识别（不等跑完）：没音频/没转写段落 400，已经在识别 409，回 202 + Recording。
// 识别不改录音 status（设计 §14.4）；失败只体现在 job.last_error。
func (h *handlers) postDiarize(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if err := plugin.Require(h.c, "process:spawn"); err != nil {
		h.fail(w, r, err)
		return
	}
	if rec.AudioPath == "" {
		h.fail(w, r, apiErr(errValidation, "这条录音还没有音频，先录一段"))
		return
	}
	segs, err := loadSegments(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if len(segs) == 0 {
		h.fail(w, r, apiErr(errValidation, "这条录音还没有转写段落，先转写再识别说话人"))
		return
	}
	busy, err := activeJob(r.Context(), h.c.Store(), rec.ID, "diarize")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if busy {
		h.fail(w, r, apiErr(errConflict, "这条录音正在识别说话人，等它跑完"))
		return
	}
	if _, err := createJob(r.Context(), h.c.Store(), rec.ID, "diarize"); err != nil {
		h.fail(w, r, err)
		return
	}
	rec2, err := loadRecording(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	view, err := h.view(r, rec2)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": view})
}

// listSpeakers 列一条录音识别出的说话人，按 label 顺序，带 meta.total。
func (h *handlers) listSpeakers(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	speakers, err := h.speakerViews(r, rec.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": speakers, "meta": map[string]int{"total": len(speakers)}})
}

// patchSpeaker 只改显示名（不动声纹、不动联系人绑定）：名字空或超 40 字 400，label 不存在 404。
func (h *handlers) patchSpeaker(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	label := r.PathValue("label")
	var req struct {
		Name string `json:"name"`
	}
	if err := decodeBody(r, &req); err != nil {
		h.fail(w, r, err)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		h.fail(w, r, apiErr(errValidation, "说话人名字不能为空"))
		return
	}
	if len([]rune(name)) > 40 {
		h.fail(w, r, apiErr(errValidation, "说话人名字最多 40 个字"))
		return
	}
	row, err := loadSpeaker(r.Context(), h.c.Store(), rec.ID, label)
	if err != nil {
		if errors.Is(err, plugin.ErrNoRows) {
			h.fail(w, r, apiErr(errNotFound, "说话人 %s 不存在", label))
			return
		}
		h.fail(w, r, err)
		return
	}
	if err := updateSpeakerName(r.Context(), h.c.Store(), rec.ID, label, name); err != nil {
		h.fail(w, r, err)
		return
	}
	row.Name = name
	row.UpdatedAt = nowRFC()
	writeJSON(w, http.StatusOK, map[string]any{"data": speakerView(row, liveContactName(r.Context(), h.c, row.ContactID))})
}

// bindSpeaker 绑定联系人并登记声纹（已有声纹会被这次覆盖）：联系人不存在 400，label 不存在 404。
func (h *handlers) bindSpeaker(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	label := r.PathValue("label")
	var req struct {
		ContactID string `json:"contact_id"`
	}
	if err := decodeBody(r, &req); err != nil {
		h.fail(w, r, err)
		return
	}
	contactID := strings.TrimSpace(req.ContactID)
	if contactID == "" {
		h.fail(w, r, apiErr(errValidation, "contact_id 不能为空"))
		return
	}
	contact, err := h.c.Contacts().Get(r.Context(), contactID)
	if err != nil {
		h.fail(w, r, apiErr(errValidation, "联系人 %s 不存在", contactID))
		return
	}
	row, err := loadSpeaker(r.Context(), h.c.Store(), rec.ID, label)
	if err != nil {
		if errors.Is(err, plugin.ErrNoRows) {
			h.fail(w, r, apiErr(errNotFound, "说话人 %s 不存在", label))
			return
		}
		h.fail(w, r, err)
		return
	}
	if len(row.Embedding) == 0 {
		h.fail(w, r, apiErr(errValidation, "这个说话人没有声纹质心，重新识别一次再绑定"))
		return
	}
	now := nowRFC()
	model := row.Model
	if model == "" {
		model = voiceprintModelName
	}
	created := now
	if old, err := loadVoiceprint(r.Context(), h.c.Store(), contactID); err == nil {
		created = old.CreatedAt
	}
	if err := upsertVoiceprint(r.Context(), h.c.Store(), voiceprintRow{
		ContactID: contactID, Embedding: row.Embedding, Model: model, SourceRecordingID: rec.ID,
		CreatedAt: created, UpdatedAt: now,
	}); err != nil {
		h.fail(w, r, err)
		return
	}
	row.ContactID, row.ContactName = contact.ID, contact.Name
	row.Similarity, row.Detected, row.UpdatedAt = 1, false, now
	if err := updateSpeakerBinding(r.Context(), h.c.Store(), row); err != nil {
		h.fail(w, r, err)
		return
	}
	h.c.Audit().Note(r.Context(), plugin.AuditNote{
		Action: "bind", TargetType: "recording_speaker", TargetID: rec.ID + "/" + label,
		Summary: "把录音说话人 " + label + " 绑定到联系人「" + clip(contact.Name, 60) + "」",
	}, plugin.WriteMeta{})
	writeJSON(w, http.StatusOK, map[string]any{"data": speakerView(row, contact.Name)})
}

// listVoiceprints 列已登记的联系人声纹，带 meta.total；联系人名现查，查不到空串。
func (h *handlers) listVoiceprints(w http.ResponseWriter, r *http.Request) {
	rows, err := loadVoiceprints(r.Context(), h.c.Store())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := make([]Voiceprint, 0, len(rows))
	for _, v := range rows {
		out = append(out, Voiceprint{
			ContactID:         v.ContactID,
			ContactName:       liveContactName(r.Context(), h.c, v.ContactID),
			Model:             v.Model,
			SourceRecordingID: v.SourceRecordingID,
			CreatedAt:         v.CreatedAt,
			UpdatedAt:         v.UpdatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// deleteVoiceprint 删掉某个联系人的声纹；没有 404。
func (h *handlers) deleteVoiceprint(w http.ResponseWriter, r *http.Request) {
	contactID := r.PathValue("contact_id")
	deleted, err := deleteVoiceprint(r.Context(), h.c.Store(), contactID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if !deleted {
		h.fail(w, r, apiErr(errNotFound, "联系人 %s 没有登记声纹", contactID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]bool{"ok": true}})
}

// ---------- 音频上传与播放 ----------

// uploadAudio 收浏览器录好的音频（multipart，字段 audio），存到附件目录并排转写任务。
func (h *handlers) uploadAudio(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if err := plugin.Require(h.c, "fs:write:attachments"); err != nil {
		h.fail(w, r, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<30)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		h.fail(w, r, apiErr(errValidation, "音频上传解析失败：%v", err))
		return
	}
	file, header, err := r.FormFile("audio")
	if err != nil {
		h.fail(w, r, apiErr(errValidation, "缺少 audio 文件"))
		return
	}
	defer func() { _ = file.Close() }()
	dir := audioDir(h.c, rec.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		h.fail(w, r, fmt.Errorf("建音频目录失败：%w", err))
		return
	}
	tmp := filepath.Join(dir, "upload.tmp")
	out, err := os.Create(tmp)
	if err != nil {
		h.fail(w, r, fmt.Errorf("写音频文件失败：%w", err))
		return
	}
	size, copyErr := io.Copy(out, file)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tmp)
		if copyErr != nil {
			h.fail(w, r, fmt.Errorf("收音频失败：%w", copyErr))
		} else {
			h.fail(w, r, fmt.Errorf("收音频失败：%w", closeErr))
		}
		return
	}
	if size == 0 {
		_ = os.Remove(tmp)
		h.fail(w, r, apiErr(errValidation, "音频是空的，检查一下麦克风"))
		return
	}
	ext := sniffAudioExt(tmp, header.Header.Get("Content-Type"))
	abs := filepath.Join(dir, "audio."+ext)
	if err := os.Rename(tmp, abs); err != nil {
		_ = os.Remove(tmp)
		h.fail(w, r, fmt.Errorf("保存音频失败：%w", err))
		return
	}
	durationMs := int64(0)
	if v := r.FormValue("duration_ms"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
			durationMs = n
		}
	}
	rel := audioRel(rec.ID, ext)
	// 重新上传时旧任务作废，避免重复转写
	_, _ = h.c.Store().Exec(r.Context(), `UPDATE recording_jobs SET status = 'failed', last_error = '音频已重新上传', updated_at = ? WHERE recording_id = ? AND status IN ('pending','running')`,
		nowRFC(), rec.ID)
	if _, err := h.c.Store().Exec(r.Context(), `UPDATE recording_recordings SET status = 'uploaded', audio_path = ?, audio_mime = ?, audio_size = ?, duration_ms = ?, error = '', attempts = 0, updated_at = ? WHERE id = ?`,
		rel, audioMIMEByExt(ext), size, durationMs, nowRFC(), rec.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	if _, err := createJob(r.Context(), h.c.Store(), rec.ID, "transcribe"); err != nil {
		h.fail(w, r, err)
		return
	}
	rec2, err := loadRecording(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	view, err := h.view(r, rec2)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.c.Audit().Note(r.Context(), plugin.AuditNote{
		Action: "upload", TargetType: "recording", TargetID: rec.ID,
		Summary: "保存录音音频「" + clip(rec2.Title, 60) + "」",
	}, plugin.WriteMeta{})
	writeJSON(w, http.StatusAccepted, map[string]any{"data": view})
}

// getAudio 流式回音频（支持 Range，播放器能拖动进度条）。
func (h *handlers) getAudio(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if err := plugin.Require(h.c, "fs:read:attachments"); err != nil {
		h.fail(w, r, err)
		return
	}
	abs, err := resolveAudioPath(h.c, rec.AudioPath)
	if err != nil {
		h.fail(w, r, apiErr(errNotFound, "这条录音还没有音频"))
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		h.fail(w, r, apiErr(errNotFound, "音频文件不见了"))
		return
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		h.fail(w, r, apiErr(errNotFound, "音频文件不可读"))
		return
	}
	ct := rec.AudioMIME
	if ct == "" {
		ct = mime.TypeByExtension(filepath.Ext(abs))
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	header := w.Header()
	header.Set("Content-Type", ct)
	header.Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": rec.ID + filepath.Ext(abs)}))
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// sniffAudioExt 看文件头判断格式：webm / wav / m4a / mp3 / ogg / flac。
func sniffAudioExt(path, contentType string) string {
	head := make([]byte, 16)
	if f, err := os.Open(path); err == nil {
		_, _ = io.ReadFull(f, head)
		_ = f.Close()
	}
	switch {
	case bytes.HasPrefix(head, []byte{0x1A, 0x45, 0xDF, 0xA3}):
		return "webm"
	case len(head) >= 12 && string(head[0:4]) == "RIFF" && string(head[8:12]) == "WAVE":
		return "wav"
	case len(head) >= 8 && string(head[4:8]) == "ftyp":
		return "m4a"
	case bytes.HasPrefix(head, []byte("ID3")):
		return "mp3"
	case len(head) >= 2 && head[0] == 0xFF && head[1]&0xE0 == 0xE0:
		return "mp3"
	case bytes.HasPrefix(head, []byte("OggS")):
		return "ogg"
	case bytes.HasPrefix(head, []byte("fLaC")):
		return "flac"
	}
	mt, _, _ := mime.ParseMediaType(contentType)
	switch mt {
	case "audio/webm":
		return "webm"
	case "audio/mp4", "audio/aac", "audio/x-m4a":
		return "m4a"
	case "audio/mpeg":
		return "mp3"
	case "audio/wav", "audio/x-wav":
		return "wav"
	case "audio/ogg":
		return "ogg"
	case "audio/flac", "audio/x-flac":
		return "flac"
	}
	return "webm"
}

func audioMIMEByExt(ext string) string {
	switch ext {
	case "webm":
		return "audio/webm"
	case "wav":
		return "audio/wav"
	case "m4a":
		return "audio/mp4"
	case "mp3":
		return "audio/mpeg"
	case "ogg":
		return "audio/ogg"
	case "flac":
		return "audio/flac"
	}
	return "application/octet-stream"
}

// ---------- 设置、模型与元信息 ----------

func (h *handlers) getSettings(w http.ResponseWriter, r *http.Request) {
	s, err := loadSettings(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s})
}

func (h *handlers) putSettings(w http.ResponseWriter, r *http.Request) {
	var s Settings
	if err := decodeBody(r, &s); err != nil {
		h.fail(w, r, err)
		return
	}
	if err := validateSettings(&s); err != nil {
		h.fail(w, r, err)
		return
	}
	if err := saveSettings(r.Context(), h.c, s); err != nil {
		h.fail(w, r, err)
		return
	}
	saved, err := loadSettings(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": saved})
}

func (h *handlers) listModels(w http.ResponseWriter, r *http.Request) {
	s, err := loadSettings(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	models, dir, err := h.p.modelInfos(h.c, s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": models, "meta": map[string]any{"total": len(models), "model_dir": dir}})
}

func (h *handlers) downloadModel(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	s, err := loadSettings(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	info, err := h.p.startModelDownload(h.c, s, name)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.c.Audit().Note(r.Context(), plugin.AuditNote{
		Action: "download", TargetType: "recording_model", TargetID: name,
		Summary: "下载本地转写模型 " + name,
	}, plugin.WriteMeta{})
	writeJSON(w, http.StatusAccepted, map[string]any{"data": info})
}

func (h *handlers) deleteModel(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	s, err := loadSettings(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	info, err := h.p.deleteModel(h.c, s, name)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": info})
}

func (h *handlers) getMeta(w http.ResponseWriter, r *http.Request) {
	s, err := loadSettings(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	models, dir, err := h.p.modelInfos(h.c, s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": MetaView{
		Tools:    detectTools(r.Context(), s),
		Models:   models,
		Settings: s,
		ModelDir: dir,
		Defaults: map[string]any{"model": "small", "language": "zh", "threads": effectiveThreads(s)},
	}})
}

// ---------- 小工具 ----------

func timeNowTitle() string {
	return timeNow().Format("2006-01-02 15:04")
}

func clampInt(raw string, def, min, max int) int {
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}
