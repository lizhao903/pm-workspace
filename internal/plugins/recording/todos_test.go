// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

/* ---------- 测试替身：只实现确认/忽略用得到的那几个句柄 ---------- */

// fakeCore 用内嵌接口兜住 Core 的其他方法（用不到，调到会 panic，正好说明用超了）。
type fakeCore struct {
	plugin.Core
	store         plugin.Store
	objects       plugin.ObjectReader
	contacts      plugin.ContactReader
	writer        plugin.ObjectWriter
	audit         plugin.AuditLog
	agentSvc      plugin.AgentService
	runs          plugin.RunService
	notified      []plugin.Notification
	attachmentDir string
	cacheDir      string
}

func (c *fakeCore) Store() plugin.Store          { return c.store }
func (c *fakeCore) Objects() plugin.ObjectReader { return c.objects }
func (c *fakeCore) Contacts() plugin.ContactReader {
	return c.contacts
}
func (c *fakeCore) ObjectWriter() plugin.ObjectWriter { return c.writer }
func (c *fakeCore) Audit() plugin.AuditLog            { return c.audit }
func (c *fakeCore) Agent() plugin.AgentService        { return c.agentSvc }
func (c *fakeCore) Runs() plugin.RunService           { return c.runs }
func (c *fakeCore) AttachmentDir() string             { return c.attachmentDir }
func (c *fakeCore) CacheDir() string                  { return c.cacheDir }
func (c *fakeCore) Log() *slog.Logger                 { return slog.New(slog.DiscardHandler) }
func (c *fakeCore) Notify(_ context.Context, n plugin.Notification) error {
	c.notified = append(c.notified, n)
	return nil
}

// fakeStore 只服务 QueryRow（读一条候选）和 Exec（记下来给断言）。
type fakeStore struct {
	row    []any
	rowErr error
	execs  []string
	args   [][]any
}

func (s *fakeStore) Exec(_ context.Context, query string, args ...any) (sql.Result, error) {
	s.execs = append(s.execs, query)
	s.args = append(s.args, args)
	return fakeResult{}, nil
}

func (s *fakeStore) Query(context.Context, string, ...any) (*sql.Rows, error) {
	return nil, errors.New("fakeStore 不支持 Query")
}

func (s *fakeStore) QueryRow(context.Context, string, ...any) plugin.Row {
	if s.rowErr != nil {
		return fakeRow{err: s.rowErr}
	}
	return fakeRow{values: s.row}
}

func (s *fakeStore) lastExec() (string, []any) {
	if len(s.execs) == 0 {
		return "", nil
	}
	return s.execs[len(s.execs)-1], s.args[len(s.args)-1]
}

func (s *fakeStore) hasExec(substr string) bool {
	for _, q := range s.execs {
		if strings.Contains(q, substr) {
			return true
		}
	}
	return false
}

type fakeResult struct{}

func (fakeResult) LastInsertId() (int64, error) { return 0, nil }
func (fakeResult) RowsAffected() (int64, error) { return 1, nil }

// fakeRow 按 Scan 的目标类型赋值。
type fakeRow struct {
	values []any
	err    error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return errors.New("fakeRow: 列数对不上")
	}
	for i, d := range dest {
		switch p := d.(type) {
		case *string:
			*p, _ = r.values[i].(string)
		case *int:
			*p, _ = r.values[i].(int)
		case *float64:
			*p, _ = r.values[i].(float64)
		default:
			return errors.New("fakeRow: 不认识的 Scan 类型")
		}
	}
	return nil
}

type fakeObjects struct {
	plugin.ObjectReader
	byID map[string]plugin.ObjectInfo
}

func (o *fakeObjects) Get(_ context.Context, id string) (plugin.ObjectInfo, error) {
	if obj, ok := o.byID[id]; ok {
		return obj, nil
	}
	return plugin.ObjectInfo{}, plugin.ErrNoRows
}

func (o *fakeObjects) List(context.Context, plugin.ObjectQuery) ([]plugin.ObjectInfo, error) {
	out := make([]plugin.ObjectInfo, 0, len(o.byID))
	for _, v := range o.byID {
		out = append(out, v)
	}
	return out, nil
}

type fakeContacts struct {
	plugin.ContactReader
	byName map[string]plugin.ContactInfo
}

func (c *fakeContacts) Get(_ context.Context, id string) (plugin.ContactInfo, error) {
	for _, v := range c.byName {
		if v.ID == id {
			return v, nil
		}
	}
	return plugin.ContactInfo{}, plugin.ErrNoRows
}

func (c *fakeContacts) FindByName(_ context.Context, name string) (plugin.ContactInfo, error) {
	if v, ok := c.byName[name]; ok {
		return v, nil
	}
	return plugin.ContactInfo{}, plugin.ErrNoRows
}

type fakeWriter struct {
	plugin.ObjectWriter
	gotNew  plugin.NewObject
	gotMeta plugin.WriteMeta
	out     plugin.CreatedObject
	err     error
}

func (w *fakeWriter) CreateAs(_ context.Context, o plugin.NewObject, m plugin.WriteMeta) (plugin.CreatedObject, error) {
	w.gotNew, w.gotMeta = o, m
	return w.out, w.err
}

type fakeAudit struct{ notes int }

func (a *fakeAudit) Note(context.Context, plugin.AuditNote, plugin.WriteMeta) { a.notes++ }
func (a *fakeAudit) Find(context.Context, string, string, plugin.WriteMeta) (plugin.NotedAudit, bool, error) {
	return plugin.NotedAudit{}, false, nil
}

// todoRowValues 按 todoCols 的列顺序排 Scan 的值。
func todoRowValues(t todoRow) []any {
	return []any{t.RecordingID, t.Index, t.Kind, t.Title, t.Detail, t.Confidence, t.Status, t.ProjectID,
		t.ProjectTitle, t.ObjectID, t.ObjectRef, t.Reason, t.OwnerName, t.DueAt, t.CreatedAt, t.UpdatedAt}
}

func newConfirmHandler(t *testing.T, todo todoRow) (*handlers, *fakeStore, *fakeWriter, *fakeCore) {
	t.Helper()
	store := &fakeStore{row: todoRowValues(todo)}
	writer := &fakeWriter{}
	c := &fakeCore{
		store:    store,
		objects:  &fakeObjects{byID: map[string]plugin.ObjectInfo{"prj_1": {ID: "prj_1", Title: "官网改版", Type: "project"}}},
		contacts: &fakeContacts{byName: map[string]plugin.ContactInfo{"张三": {ID: "sh_1", Name: "张三"}}},
		writer:   writer,
		audit:    &fakeAudit{},
	}
	return &handlers{c: c}, store, writer, c
}

/* ---------- confirm / ignore 的校验分支 ---------- */

func TestConfirmProjectCandidate(t *testing.T) {
	todo := todoRow{RecordingID: "rec_1", Index: 1, Kind: "project", Title: "官网改版", Confidence: 0.9,
		Status: "pending", ProjectID: "prj_1", ProjectTitle: "官网改版",
		CreatedAt: "2026-11-10T00:00:00Z", UpdatedAt: "2026-11-10T00:00:00Z"}
	h, store, _, _ := newConfirmHandler(t, todo)
	got, err := h.confirmTodo(context.Background(), recordingRow{ID: "rec_1"}, 1, confirmTodoRequest{})
	if err != nil {
		t.Fatalf("确认项目候选失败：%v", err)
	}
	if got.Status != "confirmed" || got.ProjectID != "prj_1" || got.ProjectTitle != "官网改版" {
		t.Errorf("确认后候选不对：%+v", got)
	}
	if !store.hasExec("UPDATE recording_recordings SET project_id") {
		t.Errorf("应该把录音挂到项目，实际执行：%v", store.execs)
	}
}

func TestConfirmProjectCandidateNeedsProjectID(t *testing.T) {
	todo := todoRow{RecordingID: "rec_1", Index: 0, Kind: "project", Title: "没匹配上的项目", Status: "pending"}
	h, _, _, _ := newConfirmHandler(t, todo)
	if _, err := h.confirmTodo(context.Background(), recordingRow{ID: "rec_1"}, 0, confirmTodoRequest{}); !errors.Is(err, errValidation) {
		t.Fatalf("没有 project_id 应该 400，实际 %v", err)
	}
}

func TestConfirmProjectCandidateUnknownProject(t *testing.T) {
	todo := todoRow{RecordingID: "rec_1", Index: 0, Kind: "project", Title: "x", Status: "pending"}
	h, _, _, _ := newConfirmHandler(t, todo)
	if _, err := h.confirmTodo(context.Background(), recordingRow{ID: "rec_1"}, 0, confirmTodoRequest{ProjectID: "nope"}); !errors.Is(err, errValidation) {
		t.Fatalf("不存在的项目应该 400，实际 %v", err)
	}
}

func TestConfirmAlreadyConfirmed(t *testing.T) {
	todo := todoRow{RecordingID: "rec_1", Index: 2, Kind: "task", Title: "x", Status: "confirmed"}
	h, _, _, _ := newConfirmHandler(t, todo)
	if _, err := h.confirmTodo(context.Background(), recordingRow{ID: "rec_1"}, 2, confirmTodoRequest{}); !errors.Is(err, errConflict) {
		t.Fatalf("重复确认应该 409，实际 %v", err)
	}
}

func TestConfirmTodoNotFound(t *testing.T) {
	h, store, _, _ := newConfirmHandler(t, todoRow{})
	store.rowErr = plugin.ErrNoRows
	if _, err := h.confirmTodo(context.Background(), recordingRow{ID: "rec_1"}, 9, confirmTodoRequest{}); !errors.Is(err, errNotFound) {
		t.Fatalf("候选不存在应该 404，实际 %v", err)
	}
}

func TestConfirmTaskCandidateCreatesTask(t *testing.T) {
	todo := todoRow{
		RecordingID: "rec_1", Index: 3, Kind: "task", Title: "出改版方案", Detail: "下周给方案",
		Confidence: 0.92, Status: "pending", ProjectID: "prj_1", ProjectTitle: "官网改版",
		OwnerName: "张三", DueAt: "2026-11-20", CreatedAt: "2026-11-10T00:00:00Z", UpdatedAt: "2026-11-10T00:00:00Z",
	}
	h, _, writer, _ := newConfirmHandler(t, todo)
	writer.out = plugin.CreatedObject{ID: "obj_1", Ref: "TSK-0001", Title: "出改版方案"}
	rec := recordingRow{ID: "rec_1", Title: "官网改版评审"}
	got, err := h.confirmTodo(context.Background(), rec, 3, confirmTodoRequest{})
	if err != nil {
		t.Fatalf("确认任务候选失败：%v", err)
	}
	if got.Status != "confirmed" || got.ObjectID != "obj_1" || got.ObjectRef != "TSK-0001" {
		t.Errorf("确认后候选不对：%+v", got)
	}
	o := writer.gotNew
	if o.TypeID != "task" || o.Title != "出改版方案" || o.Body != "下周给方案" {
		t.Errorf("建任务参数不对：%+v", o)
	}
	if o.ProjectID == nil || *o.ProjectID != "prj_1" {
		t.Errorf("任务应挂项目：%+v", o.ProjectID)
	}
	if o.OwnerID == nil || *o.OwnerID != "sh_1" {
		t.Errorf("负责人名字应匹配到联系人：%+v", o.OwnerID)
	}
	if o.DueAt == nil || o.DueAt.Format("2006-01-02") != "2026-11-20" {
		t.Errorf("截止时间应解析：%+v", o.DueAt)
	}
	if o.Props["recording_id"] != "rec_1" || o.Props["goal"] != false || o.Props["confidence"] != 0.92 {
		t.Errorf("props 不对：%+v", o.Props)
	}
	if writer.gotMeta.Key != "recording/rec_1/todo/3" {
		t.Errorf("幂等键不对：%q", writer.gotMeta.Key)
	}
	if writer.gotMeta.Session != "rec_1" {
		t.Errorf("操作者会话应是录音 id：%q", writer.gotMeta.Session)
	}
}

func TestConfirmGoalCandidate(t *testing.T) {
	todo := todoRow{RecordingID: "rec_1", Index: 4, Kind: "goal", Title: "Q4 上线新版官网", Confidence: 0.8, Status: "pending"}
	h, _, writer, _ := newConfirmHandler(t, todo)
	writer.out = plugin.CreatedObject{ID: "obj_2", Ref: "TSK-0002"}
	if _, err := h.confirmTodo(context.Background(), recordingRow{ID: "rec_1"}, 4, confirmTodoRequest{Title: "改写后的目标"}); err != nil {
		t.Fatalf("确认目标候选失败：%v", err)
	}
	if writer.gotNew.Title != "改写后的目标" {
		t.Errorf("请求里的标题应覆盖：%q", writer.gotNew.Title)
	}
	if writer.gotNew.Props["goal"] != true {
		t.Errorf("目标候选 props.goal 应为 true：%+v", writer.gotNew.Props)
	}
}

func TestConfirmTaskBadDue(t *testing.T) {
	todo := todoRow{RecordingID: "rec_1", Index: 5, Kind: "task", Title: "x", Status: "pending"}
	h, _, _, _ := newConfirmHandler(t, todo)
	if _, err := h.confirmTodo(context.Background(), recordingRow{ID: "rec_1"}, 5, confirmTodoRequest{DueAt: "下周五"}); !errors.Is(err, errValidation) {
		t.Fatalf("请求里日期格式不对应该 400，实际 %v", err)
	}
}

func TestConfirmTaskCandidateBadDueIgnored(t *testing.T) {
	// 候选里 AI 给的日期解析不了时忽略，不挡建任务。
	todo := todoRow{RecordingID: "rec_1", Index: 6, Kind: "task", Title: "x", Status: "pending", DueAt: "下周五"}
	h, _, writer, _ := newConfirmHandler(t, todo)
	writer.out = plugin.CreatedObject{ID: "obj_3", Ref: "TSK-0003"}
	if _, err := h.confirmTodo(context.Background(), recordingRow{ID: "rec_1"}, 6, confirmTodoRequest{}); err != nil {
		t.Fatalf("候选日期坏掉不该挡确认：%v", err)
	}
	if writer.gotNew.DueAt != nil {
		t.Errorf("坏日期应忽略：%+v", writer.gotNew.DueAt)
	}
}

func TestConfirmTaskWriterValidation(t *testing.T) {
	todo := todoRow{RecordingID: "rec_1", Index: 7, Kind: "task", Title: "x", Status: "pending"}
	h, _, writer, _ := newConfirmHandler(t, todo)
	writer.err = domain.ErrValidation
	if _, err := h.confirmTodo(context.Background(), recordingRow{ID: "rec_1"}, 7, confirmTodoRequest{}); !errors.Is(err, errValidation) {
		t.Fatalf("内核校验错误应映射成 400，实际 %v", err)
	}
}

func TestIgnoreTodo(t *testing.T) {
	todo := todoRow{RecordingID: "rec_1", Index: 8, Kind: "task", Title: "确认预算", Confidence: 0.35, Status: "pending"}
	h, store, _, _ := newConfirmHandler(t, todo)
	got, err := h.ignoreTodo(context.Background(), recordingRow{ID: "rec_1"}, 8)
	if err != nil {
		t.Fatalf("忽略失败：%v", err)
	}
	if got.Status != "ignored" {
		t.Errorf("忽略后状态 = %q", got.Status)
	}
	if q, _ := store.lastExec(); !strings.Contains(q, "UPDATE recording_todos SET") {
		t.Errorf("应该写回候选状态，实际执行：%v", store.execs)
	}
}

func TestIgnoreAlreadyIgnored(t *testing.T) {
	todo := todoRow{RecordingID: "rec_1", Index: 0, Kind: "project", Title: "x", Status: "ignored"}
	h, store, _, _ := newConfirmHandler(t, todo)
	got, err := h.ignoreTodo(context.Background(), recordingRow{ID: "rec_1"}, 0)
	if err != nil || got.Status != "ignored" {
		t.Fatalf("重复忽略应该幂等：%+v %v", got, err)
	}
	if len(store.execs) != 0 {
		t.Errorf("重复忽略不该再写库：%v", store.execs)
	}
}

func TestIgnoreConfirmedRejected(t *testing.T) {
	todo := todoRow{RecordingID: "rec_1", Index: 0, Kind: "task", Title: "x", Status: "confirmed"}
	h, _, _, _ := newConfirmHandler(t, todo)
	if _, err := h.ignoreTodo(context.Background(), recordingRow{ID: "rec_1"}, 0); !errors.Is(err, errConflict) {
		t.Fatalf("已确认的候选不能忽略（409），实际 %v", err)
	}
}

func TestMapObjectWriteErr(t *testing.T) {
	if err := mapObjectWriteErr(nil); err != nil {
		t.Errorf("nil 应回 nil：%v", err)
	}
	if err := mapObjectWriteErr(domain.ErrNotFound); !errors.Is(err, errNotFound) {
		t.Errorf("domain not found 应映射成 404：%v", err)
	}
	internal := errors.New("boom")
	if err := mapObjectWriteErr(internal); !errors.Is(err, internal) {
		t.Errorf("其他错误应原样返回：%v", err)
	}
}
