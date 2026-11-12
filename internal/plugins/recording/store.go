// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// recordingRow 是 recording_recordings 一行。
type recordingRow struct {
	ID           string
	Title        string
	Status       string
	Engine       string
	Model        string
	Language     string
	AudioPath    string
	AudioMIME    string
	AudioSize    int64
	DurationMs   int64
	Transcript   string
	MinutesJSON  string
	MinutesModel string
	ProjectID    string
	Error        string
	Attempts     int
	CreatedAt    string
	UpdatedAt    string
}

// jobRow 是 recording_jobs 一行（界面只需要这几项）。
type jobRow struct {
	ID          string
	RecordingID string
	Kind        string
	Status      string
	Progress    int
	Attempts    int
	NextRunAt   string
	LastError   string
	CreatedAt   string
	UpdatedAt   string
}

// listFilter 是列表查询条件。
type listFilter struct {
	status    string
	projectID string
	q         string
	limit     int
	offset    int
}

func newID(prefix string) string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return prefix + hex.EncodeToString(b[:])
}

// recordingCols 是查询用的列（project_id 可空，统一读成空串）；insertCols 是插入用的，不能用 COALESCE。
const recordingCols = `id, title, status, engine, model, language, audio_path, audio_mime, audio_size, duration_ms,
	transcript, minutes_json, minutes_model, COALESCE(project_id, ''), error, attempts, created_at, updated_at`

const insertCols = `id, title, status, engine, model, language, audio_path, audio_mime, audio_size, duration_ms,
	transcript, minutes_json, minutes_model, project_id, error, attempts, created_at, updated_at`

func scanRecording(row plugin.Row) (recordingRow, error) {
	var r recordingRow
	err := row.Scan(&r.ID, &r.Title, &r.Status, &r.Engine, &r.Model, &r.Language, &r.AudioPath, &r.AudioMIME,
		&r.AudioSize, &r.DurationMs, &r.Transcript, &r.MinutesJSON, &r.MinutesModel, &r.ProjectID, &r.Error,
		&r.Attempts, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

func loadRecording(ctx context.Context, st plugin.Store, id string) (recordingRow, error) {
	return scanRecording(st.QueryRow(ctx, `SELECT `+recordingCols+` FROM recording_recordings WHERE id = ?`, id))
}

func insertRecording(ctx context.Context, st plugin.Store, r recordingRow) error {
	_, err := st.Exec(ctx, `INSERT INTO recording_recordings (`+insertCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		r.ID, r.Title, r.Status, r.Engine, r.Model, r.Language, r.AudioPath, r.AudioMIME, r.AudioSize, r.DurationMs,
		r.Transcript, r.MinutesJSON, r.MinutesModel, r.ProjectID, r.Error, r.Attempts, r.CreatedAt, r.UpdatedAt)
	return err
}

func listRecordings(ctx context.Context, st plugin.Store, f listFilter) ([]recordingRow, int, error) {
	var where []string
	var args []any
	if f.status != "" {
		where = append(where, "status = ?")
		args = append(args, f.status)
	}
	if f.projectID != "" {
		where = append(where, "COALESCE(project_id, '') = ?")
		args = append(args, f.projectID)
	}
	if f.q != "" {
		where = append(where, "(title LIKE ? OR transcript LIKE ?)")
		like := "%" + f.q + "%"
		args = append(args, like, like)
	}
	cond := ""
	if len(where) > 0 {
		cond = " WHERE " + strings.Join(where, " AND ")
	}
	var total int
	if err := st.QueryRow(ctx, `SELECT count(*) FROM recording_recordings`+cond, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	pageArgs := append(append([]any{}, args...), f.limit, f.offset)
	rows, err := st.Query(ctx, `SELECT `+recordingCols+` FROM recording_recordings`+cond+` ORDER BY created_at DESC LIMIT ? OFFSET ?`, pageArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	out := []recordingRow{}
	for rows.Next() {
		r, err := scanRecording(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

// replaceSegments 用新段落覆盖一条录音的旧段落。
func replaceSegments(ctx context.Context, st plugin.Store, recordingID string, segs []Segment) error {
	if _, err := st.Exec(ctx, `DELETE FROM recording_segments WHERE recording_id = ?`, recordingID); err != nil {
		return err
	}
	for _, s := range segs {
		if _, err := st.Exec(ctx, `INSERT INTO recording_segments (recording_id, seq, start_ms, end_ms, text, speaker) VALUES (?,?,?,?,?,?)`,
			recordingID, s.Seq, s.StartMs, s.EndMs, s.Text, s.Speaker); err != nil {
			return err
		}
	}
	return nil
}

func loadSegments(ctx context.Context, st plugin.Store, recordingID string) ([]Segment, error) {
	rows, err := st.Query(ctx, `SELECT seq, start_ms, end_ms, text, speaker FROM recording_segments WHERE recording_id = ? ORDER BY seq`, recordingID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Segment{}
	for rows.Next() {
		var s Segment
		if err := rows.Scan(&s.Seq, &s.StartMs, &s.EndMs, &s.Text, &s.Speaker); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// createJob 建一条 pending 任务，立刻可以跑。
func createJob(ctx context.Context, st plugin.Store, recordingID, kind string) (jobRow, error) {
	now := nowRFC()
	j := jobRow{ID: newID("job_"), RecordingID: recordingID, Kind: kind, Status: "pending", NextRunAt: now, CreatedAt: now, UpdatedAt: now}
	_, err := st.Exec(ctx, `INSERT INTO recording_jobs (id, recording_id, kind, status, progress, attempts, next_run_at, last_error, created_at, updated_at)
		VALUES (?,?,?,'pending',0,0,?,'',?,?)`, j.ID, j.RecordingID, j.Kind, j.NextRunAt, j.CreatedAt, j.UpdatedAt)
	return j, err
}

// activeJob 看一条录音有没有正在排/在跑的某类任务。
func activeJob(ctx context.Context, st plugin.Store, recordingID, kind string) (bool, error) {
	var n int
	err := st.QueryRow(ctx, `SELECT count(*) FROM recording_jobs WHERE recording_id = ? AND kind = ? AND status IN ('pending','running')`,
		recordingID, kind).Scan(&n)
	return n > 0, err
}

// latestJob 是一条录音最近的一条任务（列表/详情展示进度用）。
func latestJob(ctx context.Context, st plugin.Store, recordingID string) (*jobRow, error) {
	row := st.QueryRow(ctx, `SELECT id, recording_id, kind, status, progress, attempts, next_run_at, last_error, created_at, updated_at
		FROM recording_jobs WHERE recording_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, recordingID)
	var j jobRow
	if err := row.Scan(&j.ID, &j.RecordingID, &j.Kind, &j.Status, &j.Progress, &j.Attempts, &j.NextRunAt, &j.LastError, &j.CreatedAt, &j.UpdatedAt); err != nil {
		if errors.Is(err, plugin.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &j, nil
}

func claimJob(ctx context.Context, st plugin.Store) (jobRow, bool, error) {
	now := nowRFC()
	row := st.QueryRow(ctx, `SELECT id, recording_id, kind, attempts FROM recording_jobs
		WHERE status = 'pending' AND next_run_at <= ? ORDER BY created_at, rowid LIMIT 1`, now)
	var j jobRow
	if err := row.Scan(&j.ID, &j.RecordingID, &j.Kind, &j.Attempts); err != nil {
		if errors.Is(err, plugin.ErrNoRows) {
			return jobRow{}, false, nil
		}
		return jobRow{}, false, err
	}
	res, err := st.Exec(ctx, `UPDATE recording_jobs SET status = 'running', attempts = attempts + 1, progress = 0, updated_at = ? WHERE id = ? AND status = 'pending'`,
		now, j.ID)
	if err != nil {
		return jobRow{}, false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return jobRow{}, false, nil
	}
	j.Status = "running"
	j.Attempts++
	return j, true, nil
}

func taskCount(ctx context.Context, st plugin.Store, recordingID string) (int, error) {
	var n int
	err := st.QueryRow(ctx, `SELECT count(*) FROM recording_todos WHERE recording_id = ? AND status = 'confirmed'
		AND kind IN ('task','goal') AND object_id <> ''`, recordingID).Scan(&n)
	return n, err
}

// speakerRow 是 recording_speakers 一行：一条录音识别出的一个说话人。
type speakerRow struct {
	RecordingID string
	Label       string
	Name        string
	ContactID   string
	ContactName string
	Similarity  float64
	Detected    bool
	Embedding   []byte
	Model       string
	Segments    int
	DurationMs  int64
	CreatedAt   string
	UpdatedAt   string
}

// voiceprintRow 是 recording_voiceprints 一行：一个联系人的声纹质心。
type voiceprintRow struct {
	ContactID         string
	Embedding         []byte
	Model             string
	SourceRecordingID string
	CreatedAt         string
	UpdatedAt         string
}

const speakerCols = `recording_id, label, name, contact_id, contact_name, similarity, detected, embedding,
	model, segments, duration_ms, created_at, updated_at`

const voiceprintCols = `contact_id, embedding, model, source_recording_id, created_at, updated_at`

func scanSpeaker(row plugin.Row) (speakerRow, error) {
	var r speakerRow
	var detected int
	err := row.Scan(&r.RecordingID, &r.Label, &r.Name, &r.ContactID, &r.ContactName, &r.Similarity, &detected,
		&r.Embedding, &r.Model, &r.Segments, &r.DurationMs, &r.CreatedAt, &r.UpdatedAt)
	r.Detected = detected != 0
	return r, err
}

func scanVoiceprint(row plugin.Row) (voiceprintRow, error) {
	var v voiceprintRow
	err := row.Scan(&v.ContactID, &v.Embedding, &v.Model, &v.SourceRecordingID, &v.CreatedAt, &v.UpdatedAt)
	return v, err
}

// loadSpeakers 读一条录音的说话人，按 label 排（spk_1、spk_2…）。
func loadSpeakers(ctx context.Context, st plugin.Store, recordingID string) ([]speakerRow, error) {
	rows, err := st.Query(ctx, `SELECT `+speakerCols+` FROM recording_speakers WHERE recording_id = ? ORDER BY label`, recordingID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []speakerRow{}
	for rows.Next() {
		r, err := scanSpeaker(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// loadSpeaker 按录音 id + label 读一个说话人；没有时回 plugin.ErrNoRows。
func loadSpeaker(ctx context.Context, st plugin.Store, recordingID, label string) (speakerRow, error) {
	return scanSpeaker(st.QueryRow(ctx, `SELECT `+speakerCols+` FROM recording_speakers WHERE recording_id = ? AND label = ?`,
		recordingID, label))
}

// speakerCount 是一条录音识别出的说话人数（列表徽标用）。
func speakerCount(ctx context.Context, st plugin.Store, recordingID string) (int, error) {
	var n int
	err := st.QueryRow(ctx, `SELECT count(*) FROM recording_speakers WHERE recording_id = ?`, recordingID).Scan(&n)
	return n, err
}

// replaceSpeakers 用新的说话人整表覆盖一条录音的旧说话人。
func replaceSpeakers(ctx context.Context, st plugin.Store, recordingID string, rows []speakerRow) error {
	if _, err := st.Exec(ctx, `DELETE FROM recording_speakers WHERE recording_id = ?`, recordingID); err != nil {
		return err
	}
	for _, r := range rows {
		if _, err := st.Exec(ctx, `INSERT INTO recording_speakers (`+speakerCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			recordingID, r.Label, r.Name, r.ContactID, r.ContactName, r.Similarity, boolToInt(r.Detected), r.Embedding,
			r.Model, r.Segments, r.DurationMs, r.CreatedAt, r.UpdatedAt); err != nil {
			return err
		}
	}
	return nil
}

// updateSpeakerName 只改显示名（改名不动声纹、不动联系人绑定）。
func updateSpeakerName(ctx context.Context, st plugin.Store, recordingID, label, name string) error {
	_, err := st.Exec(ctx, `UPDATE recording_speakers SET name = ?, updated_at = ? WHERE recording_id = ? AND label = ?`,
		name, nowRFC(), recordingID, label)
	return err
}

// updateSpeakerBinding 写绑定结果：联系人、绑定快照、相似度、是否自动匹配。
func updateSpeakerBinding(ctx context.Context, st plugin.Store, r speakerRow) error {
	_, err := st.Exec(ctx, `UPDATE recording_speakers SET contact_id = ?, contact_name = ?, similarity = ?, detected = ?, updated_at = ?
		WHERE recording_id = ? AND label = ?`,
		r.ContactID, r.ContactName, r.Similarity, boolToInt(r.Detected), r.UpdatedAt, r.RecordingID, r.Label)
	return err
}

// loadVoiceprints 读全部已登记的联系人声纹，按更新时间倒序。
func loadVoiceprints(ctx context.Context, st plugin.Store) ([]voiceprintRow, error) {
	rows, err := st.Query(ctx, `SELECT `+voiceprintCols+` FROM recording_voiceprints ORDER BY updated_at DESC, contact_id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []voiceprintRow{}
	for rows.Next() {
		v, err := scanVoiceprint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// loadVoiceprint 读一个联系人的声纹；没有时回 plugin.ErrNoRows。
func loadVoiceprint(ctx context.Context, st plugin.Store, contactID string) (voiceprintRow, error) {
	return scanVoiceprint(st.QueryRow(ctx, `SELECT `+voiceprintCols+` FROM recording_voiceprints WHERE contact_id = ?`, contactID))
}

// upsertVoiceprint 登记/覆盖一个联系人的声纹（同一联系人只留一条）。
func upsertVoiceprint(ctx context.Context, st plugin.Store, v voiceprintRow) error {
	_, err := st.Exec(ctx, `INSERT INTO recording_voiceprints (`+voiceprintCols+`) VALUES (?,?,?,?,?,?)
		ON CONFLICT(contact_id) DO UPDATE SET embedding = excluded.embedding, model = excluded.model,
		source_recording_id = excluded.source_recording_id, updated_at = excluded.updated_at`,
		v.ContactID, v.Embedding, v.Model, v.SourceRecordingID, v.CreatedAt, v.UpdatedAt)
	return err
}

// deleteVoiceprint 删一个联系人的声纹；返回是否真的删了一条。
func deleteVoiceprint(ctx context.Context, st plugin.Store, contactID string) (bool, error) {
	res, err := st.Exec(ctx, `DELETE FROM recording_voiceprints WHERE contact_id = ?`, contactID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

type todoRow struct {
	RecordingID  string
	Index        int
	Kind         string
	Title        string
	Detail       string
	Confidence   float64
	Status       string
	ProjectID    string
	ProjectTitle string
	ObjectID     string
	ObjectRef    string
	Reason       string
	OwnerName    string
	DueAt        string
	CreatedAt    string
	UpdatedAt    string
}

const todoCols = `recording_id, todo_index, kind, title, detail, confidence, status, project_id, project_title,
	object_id, object_ref, reason, owner_name, due_at, created_at, updated_at`

func scanTodo(row plugin.Row) (todoRow, error) {
	var t todoRow
	err := row.Scan(&t.RecordingID, &t.Index, &t.Kind, &t.Title, &t.Detail, &t.Confidence, &t.Status,
		&t.ProjectID, &t.ProjectTitle, &t.ObjectID, &t.ObjectRef, &t.Reason, &t.OwnerName, &t.DueAt,
		&t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// loadTodos 读一条录音的全部候选，按 todo_index。
func loadTodos(ctx context.Context, st plugin.Store, recordingID string) ([]todoRow, error) {
	rows, err := st.Query(ctx, `SELECT `+todoCols+` FROM recording_todos WHERE recording_id = ? ORDER BY todo_index`, recordingID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []todoRow{}
	for rows.Next() {
		t, err := scanTodo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// loadTodo 按录音 id + 序号读一条候选；没有时回 plugin.ErrNoRows。
func loadTodo(ctx context.Context, st plugin.Store, recordingID string, index int) (todoRow, error) {
	return scanTodo(st.QueryRow(ctx, `SELECT `+todoCols+` FROM recording_todos WHERE recording_id = ? AND todo_index = ?`,
		recordingID, index))
}

// replaceTodos 用新候选覆盖一条录音的旧候选（重新生成纪要时整体替换）。
func replaceTodos(ctx context.Context, st plugin.Store, recordingID string, todos []todoRow) error {
	if _, err := st.Exec(ctx, `DELETE FROM recording_todos WHERE recording_id = ?`, recordingID); err != nil {
		return err
	}
	for _, t := range todos {
		if _, err := st.Exec(ctx, `INSERT INTO recording_todos (recording_id, todo_index, task_id, kind, title, detail,
			confidence, status, project_id, project_title, object_id, object_ref, reason, owner_name, due_at, created_at, updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			recordingID, t.Index, t.ObjectID, t.Kind, t.Title, t.Detail, t.Confidence, t.Status, t.ProjectID,
			t.ProjectTitle, t.ObjectID, t.ObjectRef, t.Reason, t.OwnerName, t.DueAt, t.CreatedAt, t.UpdatedAt); err != nil {
			return err
		}
	}
	return nil
}

// updateTodo 整行写回一条候选（确认 / 忽略后改状态和关联对象）。
func updateTodo(ctx context.Context, st plugin.Store, t todoRow) error {
	_, err := st.Exec(ctx, `UPDATE recording_todos SET kind = ?, title = ?, detail = ?, confidence = ?, status = ?,
		project_id = ?, project_title = ?, object_id = ?, object_ref = ?, reason = ?, owner_name = ?, due_at = ?,
		task_id = ?, updated_at = ? WHERE recording_id = ? AND todo_index = ?`,
		t.Kind, t.Title, t.Detail, t.Confidence, t.Status, t.ProjectID, t.ProjectTitle, t.ObjectID, t.ObjectRef,
		t.Reason, t.OwnerName, t.DueAt, t.ObjectID, t.UpdatedAt, t.RecordingID, t.Index)
	return err
}

// todosPending 是一条录音里还没确认、没忽略的候选数（列表徽标用）。
func todosPending(ctx context.Context, st plugin.Store, recordingID string) (int, error) {
	var n int
	err := st.QueryRow(ctx, `SELECT count(*) FROM recording_todos WHERE recording_id = ? AND status = 'pending'`, recordingID).Scan(&n)
	return n, err
}

// findRecordingByTitle 按标题找一条录音（SOP 节点配置里可以写标题），重名取最早建的。
func findRecordingByTitle(ctx context.Context, st plugin.Store, title string) (recordingRow, error) {
	return scanRecording(st.QueryRow(ctx, `SELECT `+recordingCols+` FROM recording_recordings WHERE title = ? ORDER BY created_at, id LIMIT 1`, title))
}

func deleteRecordingRows(ctx context.Context, st plugin.Store, recordingID string) error {
	for _, q := range []string{
		`DELETE FROM recording_segments WHERE recording_id = ?`,
		`DELETE FROM recording_speakers WHERE recording_id = ?`,
		`DELETE FROM recording_jobs WHERE recording_id = ?`,
		`DELETE FROM recording_todos WHERE recording_id = ?`,
		`DELETE FROM recording_archives WHERE recording_id = ?`,
		`DELETE FROM recording_recordings WHERE id = ?`,
	} {
		if _, err := st.Exec(ctx, q, recordingID); err != nil {
			return err
		}
	}
	return nil
}

// resolveAudioPath 把库里存的相对路径（attachments/recording/<id>/audio.webm）解析成绝对路径，
// 以解析后的真实路径为准，不许跑出 attachments 目录（防软链和 .. 穿越）。
func resolveAudioPath(c plugin.Core, rel string) (string, error) {
	attachments := c.AttachmentDir()
	if attachments == "" {
		return "", errors.New("数据目录没接上，读不到音频文件")
	}
	if rel == "" {
		return "", errors.New("这条录音没有音频文件")
	}
	base, err := filepath.Abs(attachments)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(filepath.Join(filepath.Dir(base), rel))
	if err != nil {
		return "", err
	}
	realBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	relCheck, err := filepath.Rel(realBase, real)
	if err != nil || relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(filepath.Separator)) {
		return "", errors.New("音频路径不在附件目录里")
	}
	return real, nil
}

// audioRel 是 attachments 下的相对路径（存库用）。
func audioRel(recordingID, ext string) string {
	return filepath.Join(plugin.AttachmentsSubdir, "recording", recordingID, "audio."+ext)
}

// audioDir 是一条录音的音频目录（绝对路径）。
func audioDir(c plugin.Core, recordingID string) string {
	return filepath.Join(c.AttachmentDir(), "recording", recordingID)
}

// retryBackoff 是转写失败后的重试间隔。
func retryBackoff(attempts int) time.Duration {
	switch {
	case attempts <= 1:
		return 30 * time.Second
	case attempts == 2:
		return 2 * time.Minute
	default:
		return 10 * time.Minute
	}
}
