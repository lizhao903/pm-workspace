// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// newToolbox 用真库而不是 mock：这几个工具的价值全在「真的写进去了、
// 并且留下了可追溯的修订记录」，换成 mock 就什么都没验到。
func newToolbox(t *testing.T) (*Toolbox, *sqlite.Store, context.Context, string) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	wd := newWorkdir(t)
	sess, err := st.CreateAgentSession(ctx, &domain.AgentSession{Title: "测试会话", Workdir: wd})
	if err != nil {
		t.Fatalf("建会话: %v", err)
	}
	return NewToolbox(st, sess), st, ctx, wd
}

func call(t *testing.T, tb *Toolbox, ctx context.Context, name string, args map[string]any) ToolResult {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatalf("编码参数: %v", err)
	}
	return tb.Invoke(ctx, ToolCall{ID: "c1", Name: name, Args: string(raw)})
}

// TestCreateObjectRecordsAgentSource 是可追溯性的核心断言：
// Agent 写的东西必须在 revisions 里留下 source=agent，
// 否则事后没法区分某条状态变更是用户点的还是模型改的。
func TestCreateObjectRecordsAgentSource(t *testing.T) {
	tb, st, ctx, _ := newToolbox(t)

	res := call(t, tb, ctx, "create_object", map[string]any{
		"type_id": "task",
		"title":   "明天和财务对账单口径",
	})
	if res.ObjectID == "" {
		t.Fatalf("创建失败: %s", res.Summary)
	}
	// ObjectID 必须是能查回对象的内部 id。只断言非空不够——
	// 人读编号 TSK-0001 也非空，但前端拿它 select 会查不到。
	got, err := st.GetObject(ctx, res.ObjectID)
	if err != nil {
		t.Fatalf("ObjectID %q 查不回对象: %v", res.ObjectID, err)
	}
	if !strings.HasPrefix(got.Ref, "TSK-") {
		t.Errorf("待办编号应以 TSK- 开头，得到 %q", got.Ref)
	}
	// Summary 是给人看的一句话，要带上编号，前端直接显示它。
	if !strings.Contains(res.Summary, got.Ref) {
		t.Errorf("summary 应带上对象编号，得到 %q", res.Summary)
	}

	items, _, err := st.ListObjects(ctx, domain.ObjectFilter{Query: "对账单口径"})
	if err != nil || len(items) != 1 {
		t.Fatalf("查对象: %v (%d 条)", err, len(items))
	}
	obj := items[0]
	if obj.Source != "agent" {
		t.Errorf("对象 source = %q，期望 agent", obj.Source)
	}

	revs, err := st.ListRevisions(ctx, obj.ID, 50)
	if err != nil {
		t.Fatalf("查修订: %v", err)
	}
	if len(revs) == 0 {
		t.Fatal("创建应当留下修订记录")
	}
	for _, r := range revs {
		if r.Source != "agent" {
			t.Errorf("修订 %s 的 source = %q，期望 agent", r.Field, r.Source)
		}
		if r.Actor != "agent" {
			t.Errorf("修订 %s 的 actor = %q，期望 agent", r.Field, r.Actor)
		}
	}
}

func TestUpdateObjectByRefRecordsAgentSource(t *testing.T) {
	tb, st, ctx, _ := newToolbox(t)

	created := call(t, tb, ctx, "create_object", map[string]any{
		"type_id": "task", "title": "对账",
	})
	createdObj, err := st.GetObject(ctx, created.ObjectID)
	if err != nil {
		t.Fatalf("取创建结果: %v", err)
	}

	// 用编号（而不是内部 id）来改，这是模型实际会给出的形式。
	res := call(t, tb, ctx, "update_object", map[string]any{
		"ref": createdObj.Ref, "status": "doing", "priority": "p1",
	})
	if res.ObjectID != created.ObjectID {
		t.Fatalf("更新失败: %s", res.Summary)
	}

	items, _, err := st.ListObjects(ctx, domain.ObjectFilter{Query: "对账"})
	if err != nil || len(items) != 1 {
		t.Fatalf("查对象: %v", err)
	}
	if items[0].Status != "doing" {
		t.Errorf("状态 = %q，期望 doing", items[0].Status)
	}
	// 小写的 p1 要被规范成 P1，模型经常给小写。
	if items[0].Priority != "P1" {
		t.Errorf("优先级 = %q，期望 P1", items[0].Priority)
	}

	revs, err := st.ListRevisions(ctx, items[0].ID, 50)
	if err != nil {
		t.Fatalf("查修订: %v", err)
	}
	var sawStatus bool
	for _, r := range revs {
		if r.Source != "agent" {
			t.Errorf("修订 %s 的 source = %q，期望 agent", r.Field, r.Source)
		}
		if r.Field == "status" {
			sawStatus = true
		}
	}
	if !sawStatus {
		t.Error("状态变更应当在 revisions 里留痕")
	}
}

func TestUpdateObjectRejectsUnknownRef(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)
	res := call(t, tb, ctx, "update_object", map[string]any{"ref": "TSK-9999", "status": "done"})
	if res.ObjectID != "" {
		t.Fatal("不存在的编号不该更新成功")
	}
	// 失败也要回一句模型读得懂的话，让它下一轮自己纠正。
	if !strings.Contains(res.Content, "错误") {
		t.Errorf("失败结果应告知模型原因，得到 %q", res.Content)
	}
}

func TestSearchObjectsFindsAndReportsEmpty(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)

	empty := call(t, tb, ctx, "search_objects", map[string]any{"query": "还没有的东西"})
	if !strings.Contains(empty.Content, "没有匹配") {
		t.Errorf("空结果要明确告诉模型可以放心创建，得到 %q", empty.Content)
	}

	call(t, tb, ctx, "create_object", map[string]any{"type_id": "task", "title": "季度复盘会"})
	found := call(t, tb, ctx, "search_objects", map[string]any{"query": "复盘"})
	if !strings.Contains(found.Content, "季度复盘会") {
		t.Errorf("应当搜到已有对象，得到 %q", found.Content)
	}
}

func TestListTypesReturnsStatusKeys(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)
	res := call(t, tb, ctx, "list_types", nil)
	// 模型要靠它拿到合法的 type_id 和 status key。
	for _, want := range []string{"type_id=task", "type_id=requirement", "todo", "doing"} {
		if !strings.Contains(res.Content, want) {
			t.Errorf("结果里缺 %q: %s", want, res.Content)
		}
	}
}

// TestWriteFileWritesAndRecordsArtifact 验证正常写盘路径，
// 并确认库里记的是相对路径而不是绝对路径。
func TestWriteFileWritesAndRecordsArtifact(t *testing.T) {
	tb, st, ctx, wd := newToolbox(t)

	res := call(t, tb, ctx, "write_file", map[string]any{
		"path":    "docs/角色权限矩阵.md",
		"content": "# 角色权限矩阵\n\n| 角色 | 权限 |\n",
	})
	if res.Artifact == nil {
		t.Fatalf("写文件失败: %s", res.Summary)
	}

	// 文件真的落在 workdir 里。
	got, err := os.ReadFile(filepath.Join(wd, "docs", "角色权限矩阵.md"))
	if err != nil {
		t.Fatalf("读回文件: %v", err)
	}
	if !strings.Contains(string(got), "角色权限矩阵") {
		t.Errorf("内容不对: %q", got)
	}

	// 0012 之后 Path 存绝对路径、BaseDir 存基准目录，相对路径由两者现算。
	// 两个都要断言：只验 RelPath 的话，BaseDir 漏填时 RelPath 会退回成绝对路径，
	// 断言还是绿的（因为它比的是拼出来的那个值），而库里躺着一条没有基准的记录。
	wantRel := filepath.Join("docs", "角色权限矩阵.md")
	if res.Artifact.RelPath != wantRel {
		t.Errorf("相对路径 = %q，期望 %q", res.Artifact.RelPath, wantRel)
	}
	if !filepath.IsAbs(res.Artifact.Path) {
		t.Errorf("产物 Path 应是绝对路径，得到 %q", res.Artifact.Path)
	}
	if res.Artifact.BaseDir == "" {
		t.Error("产物 BaseDir 不能为空，否则相对路径无从解释")
	}

	arts, _, err := st.ListArtifacts(ctx, domain.ArtifactFilter{SessionID: tb.session.ID})
	if err != nil || len(arts) != 1 {
		t.Fatalf("列产物: %v (%d 条)", err, len(arts))
	}
	if arts[0].Size != int64(len(got)) {
		t.Errorf("size = %d，期望 %d", arts[0].Size, len(got))
	}
}

// TestWriteFileNormalizesPath 确认没折平的写法不会在产物表里造出重复记录。
func TestWriteFileNormalizesPath(t *testing.T) {
	tb, st, ctx, _ := newToolbox(t)

	call(t, tb, ctx, "write_file", map[string]any{"path": "报告.md", "content": "v1"})
	call(t, tb, ctx, "write_file", map[string]any{"path": "./报告.md", "content": "v2"})
	call(t, tb, ctx, "write_file", map[string]any{"path": "tmp/../报告.md", "content": "v3"})

	arts, _, err := st.ListArtifacts(ctx, domain.ArtifactFilter{SessionID: tb.session.ID})
	if err != nil {
		t.Fatalf("列产物: %v", err)
	}
	if len(arts) != 1 {
		paths := make([]string, len(arts))
		for i, a := range arts {
			paths[i] = a.Path
		}
		t.Fatalf("同一个文件的三种写法应只留 1 条产物，得到 %d 条: %v", len(arts), paths)
	}
}

// TestWriteFileRejectsEscapes 是 workdir_test.go 那组断言在工具层的复核：
// 越界不仅要被 ResolveInWorkdir 拒，还必须表现为「工具返回失败」而不是 panic 或静默成功，
// 并且绝不能在 workdir 之外留下任何文件。
func TestWriteFileRejectsEscapes(t *testing.T) {
	tb, st, ctx, wd := newToolbox(t)

	outside := filepath.Join(filepath.Dir(wd), "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatalf("建目录: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(wd, "escape")); err != nil {
		t.Skipf("当前环境不支持创建软链: %v", err)
	}

	cases := []struct{ name, path string }{
		{"上跳一级", "../planted.txt"},
		{"上跳到系统目录", "../../etc/passwd"},
		{"绝对路径", "/tmp/pmw-planted.txt"},
		{"绕一圈出界", "a/../../planted.txt"},
		{"经软链逃逸", "escape/planted.txt"},
		{"空路径", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := call(t, tb, ctx, "write_file", map[string]any{
				"path": c.path, "content": "planted",
			})
			if res.Artifact != nil {
				t.Fatalf("越界路径 %q 竟然写成功了", c.path)
			}
			if !strings.Contains(res.Content, "错误") {
				t.Errorf("应当回一条失败说明，得到 %q", res.Content)
			}
		})
	}

	// 一条产物都不该被记下。
	arts, _, err := st.ListArtifacts(ctx, domain.ArtifactFilter{SessionID: tb.session.ID})
	if err != nil {
		t.Fatalf("列产物: %v", err)
	}
	if len(arts) != 0 {
		t.Errorf("越界写入不该留下产物记录，得到 %d 条", len(arts))
	}
	// workdir 之外一个文件都不该出现。
	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatalf("读外部目录: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("workdir 之外被写入了 %d 个文件", len(entries))
	}
	if _, err := os.Stat("/tmp/pmw-planted.txt"); err == nil {
		_ = os.Remove("/tmp/pmw-planted.txt")
		t.Error("绝对路径写入没有被拦住")
	}
}

// TestWriteFileWithoutWorkdir 覆盖「会话没设产物目录」：要给一句能指导用户的话，
// 而不是一个解释不清的失败。
func TestWriteFileWithoutWorkdir(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatalf("开库: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	sess, err := st.CreateAgentSession(ctx, &domain.AgentSession{Title: "无目录会话"})
	if err != nil {
		t.Fatalf("建会话: %v", err)
	}
	tb := NewToolbox(st, sess)

	res := call(t, tb, ctx, "write_file", map[string]any{"path": "a.md", "content": "x"})
	if res.Artifact != nil {
		t.Fatal("没有产物目录时不该写成功")
	}
	if !strings.Contains(res.Content, "产物目录") {
		t.Errorf("应当提示用户去设置产物目录，得到 %q", res.Content)
	}
}

func TestInvokeHandlesBadArgs(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)

	// 模型吐出半截 JSON 是常见故障，不能让它炸掉整轮对话。
	bad := tb.Invoke(ctx, ToolCall{Name: "create_object", Args: `{"type_id":`})
	if !strings.Contains(bad.Content, "错误") {
		t.Errorf("坏 JSON 应回一条失败说明，得到 %q", bad.Content)
	}

	unknown := tb.Invoke(ctx, ToolCall{Name: "rm_rf", Args: "{}"})
	if !strings.Contains(unknown.Content, "没有名为") {
		t.Errorf("未知工具应被拒，得到 %q", unknown.Content)
	}

	// 缺必填参数。
	missing := call(t, tb, ctx, "create_object", map[string]any{"title": "只有标题"})
	if missing.ObjectID != "" {
		t.Error("缺 type_id 不该创建成功")
	}
}

// TestCreateObjectParsesDueDate 确认「明天」被模型折算成日期后能被正确吃进去。
func TestCreateObjectParsesDueDate(t *testing.T) {
	tb, st, ctx, _ := newToolbox(t)

	res := call(t, tb, ctx, "create_object", map[string]any{
		"type_id": "task", "title": "交周报", "due_at": "2026-09-16",
	})
	if res.ObjectID == "" {
		t.Fatalf("创建失败: %s", res.Summary)
	}
	items, _, err := st.ListObjects(ctx, domain.ObjectFilter{Query: "交周报"})
	if err != nil || len(items) != 1 {
		t.Fatalf("查对象: %v", err)
	}
	if items[0].DueAt == nil {
		t.Fatal("due_at 没有被写进去")
	}
	if got := items[0].DueAt.Format("2006-01-02"); got != "2026-09-16" {
		t.Errorf("到期日 = %s，期望 2026-09-16", got)
	}

	bad := call(t, tb, ctx, "create_object", map[string]any{
		"type_id": "task", "title": "坏日期", "due_at": "明天",
	})
	if bad.ObjectID != "" {
		t.Error("解析不了的日期应当被拒，而不是静默丢弃")
	}
}

// TestArgStrsAcceptsBareString 覆盖一个高频的模型输出偏差：
// 只有一个标签时常常写成裸字符串而不是数组。
func TestArgStrsAcceptsBareString(t *testing.T) {
	args := map[string]any{"tags": "财务"}
	if got := argStrs(args, "tags"); len(got) != 1 || got[0] != "财务" {
		t.Errorf("裸字符串应被当成单元素数组，得到 %v", got)
	}
	args = map[string]any{"tags": []any{"财务", "月结"}}
	if got := argStrs(args, "tags"); len(got) != 2 {
		t.Errorf("数组解析错了: %v", got)
	}
}

// TestParseDueAcceptsModelTimeFormats 钉死真机跑出来的那个缺口：
// 模型给「明天下午两点」时产出 2026-09-16T14:00:00——不带时区，
// 既不是合法 RFC3339 也不是纯日期，卡在两个标准中间。只要用户说了时刻就必然撞上。
func TestParseDueAcceptsModelTimeFormats(t *testing.T) {
	cases := []struct {
		name, in            string
		wantH, wantM, wantS int
	}{
		{"模型最常给的写法", "2026-09-16T14:00:00", 14, 0, 0},
		{"空格分隔带秒", "2026-09-16 14:00:00", 14, 0, 0},
		{"T 分隔不带秒", "2026-09-16T14:00", 14, 0, 0},
		{"空格分隔不带秒", "2026-09-16 14:00", 14, 0, 0},
		{"上午十点", "2026-09-16T10:00:00", 10, 0, 0},
		// 纯日期没有时刻信息，落当天最后一秒：落 00:00 会让它当天一开始就算逾期。
		{"纯日期落当天 23:59:59", "2026-09-16", 23, 59, 59},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseDue(c.in)
			if err != nil {
				t.Fatalf("解析 %q 失败: %v", c.in, err)
			}
			// 一律按本地时区解析：单机工具，用户嘴里的「下午两点」就是他机器上的两点。
			if got.Location() != time.Local {
				t.Errorf("时区 = %v，期望本地时区", got.Location())
			}
			if got.Year() != 2026 || got.Month() != time.September || got.Day() != 16 {
				t.Errorf("日期 = %s，期望 2026-09-16", got.Format("2006-01-02"))
			}
			if got.Hour() != c.wantH || got.Minute() != c.wantM || got.Second() != c.wantS {
				t.Errorf("时刻 = %02d:%02d:%02d，期望 %02d:%02d:%02d",
					got.Hour(), got.Minute(), got.Second(), c.wantH, c.wantM, c.wantS)
			}
		})
	}

	// 带时区的仍然照常认。
	if got, err := parseDue("2026-09-16T14:00:00+08:00"); err != nil {
		t.Errorf("RFC3339 应当仍被接受: %v", err)
	} else if got.UTC().Hour() != 6 {
		t.Errorf("带时区的应按其偏移解析，UTC 小时 = %d，期望 6", got.UTC().Hour())
	}

	// 真的解析不了的仍要报错，不能静默当成今天。
	for _, bad := range []string{"明天", "next friday", "", "2026/09/16"} {
		if _, err := parseDue(bad); err == nil {
			t.Errorf("%q 不该被解析成功", bad)
		}
	}
}

// TestCreateObjectKeepsTimeOfDay 是上面那条在工具层的落地：
// 带时刻的 due_at 必须原样落库，而不是被抹成当天 23:59:59。
func TestCreateObjectKeepsTimeOfDay(t *testing.T) {
	tb, st, ctx, _ := newToolbox(t)

	res := call(t, tb, ctx, "create_object", map[string]any{
		"type_id": "task",
		"title":   "下午和财务核对账单口径",
		"due_at":  "2026-09-16T14:00:00", // 模型的真实产出形态
	})
	if res.ObjectID == "" {
		t.Fatalf("带时刻的 due_at 应当创建成功，实际失败: %s", res.Summary)
	}

	obj, err := st.GetObject(ctx, res.ObjectID)
	if err != nil {
		t.Fatalf("取对象: %v", err)
	}
	if obj.DueAt == nil {
		t.Fatal("due_at 没落库")
	}
	local := obj.DueAt.In(time.Local)
	if local.Hour() != 14 || local.Minute() != 0 {
		t.Errorf("落库时刻 = %02d:%02d，期望 14:00——时刻信息被丢掉了",
			local.Hour(), local.Minute())
	}
}

// TestDueErrorMessageListsFormats 确认报错本身不会把模型带偏。
// 原来那句「请用 YYYY-MM-DD 格式」是在明示模型丢掉时刻，属于错误文案反向诱导。
func TestDueErrorMessageListsFormats(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)

	res := call(t, tb, ctx, "create_object", map[string]any{
		"type_id": "task", "title": "坏日期", "due_at": "明天",
	})
	if res.ObjectID != "" {
		t.Fatal("解析不了的日期不该创建成功")
	}
	// 要列出可接受格式，而不是只说一种。
	for _, want := range []string{"2026-09-16 14:00", "明天"} {
		if !strings.Contains(res.Content, want) {
			t.Errorf("报错应包含 %q，得到 %q", want, res.Content)
		}
	}
	// 要明确指回同一个工具：真机上模型把「改参数重试」理解成了「换个工具」，
	// 改调 update_object 又因为没有 ref 而失败，整轮陷进死路。
	if !strings.Contains(res.Content, "create_object") {
		t.Errorf("报错要指明重新调用同一个工具，得到 %q", res.Content)
	}
}

// --- get_object ---

// TestGetObjectReturnsBodyLinksAndRevisions 盯的是「写需求分析文档」这件事的前提：
// 正文、关联对象、修订记录三样必须一次拿全。缺任何一样，模型就只能照着标题编。
func TestGetObjectReturnsBodyLinksAndRevisions(t *testing.T) {
	tb, st, ctx, _ := newToolbox(t)

	req, err := st.CreateObject(ctx, &domain.Object{
		TypeID: "requirement",
		Title:  "导出对账单",
		Body:   "财务每月要一份带口径说明的对账单，现在是手工拼的。",
	}, agentActor)
	if err != nil {
		t.Fatalf("建需求: %v", err)
	}
	task, err := st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "写导出接口"}, agentActor)
	if err != nil {
		t.Fatalf("建任务: %v", err)
	}
	if _, err := st.CreateLink(ctx, req.ID, task.ID, domain.RelBlocks, ""); err != nil {
		t.Fatalf("建关联: %v", err)
	}
	// 制造一条修订：状态变更是「这件事推进到哪了」最直接的证据。
	doing := "doing"
	if _, err := st.UpdateObject(ctx, req.ID, domain.ObjectPatch{Status: &doing}, agentActor); err != nil {
		t.Fatalf("改状态: %v", err)
	}

	res := call(t, tb, ctx, "get_object", map[string]any{"ref": req.Ref})
	for _, want := range []string{
		"财务每月要一份带口径说明的对账单", // 正文全文
		task.Ref,         // 关联对象带编号
		domain.RelBlocks, // 关联的关系名
		"status",         // 修订记录里的字段名
	} {
		if !strings.Contains(res.Content, want) {
			t.Errorf("get_object 的内容里缺少 %q\n实际内容：\n%s", want, res.Content)
		}
	}
	if res.ObjectID != req.ID {
		t.Errorf("ObjectID = %q, 期望内部 id %q", res.ObjectID, req.ID)
	}
}

// TestGetObjectClipsLongBody 保证超长正文不会把系统提示词挤出上下文，
// 而且截断这件事本身要写在文本里——不写的话模型会把半句话当成全文。
func TestGetObjectClipsLongBody(t *testing.T) {
	tb, st, ctx, _ := newToolbox(t)
	long := strings.Repeat("需", maxBodyRunes+500)
	o, err := st.CreateObject(ctx, &domain.Object{TypeID: "requirement", Title: "长正文", Body: long}, agentActor)
	if err != nil {
		t.Fatalf("建对象: %v", err)
	}

	res := call(t, tb, ctx, "get_object", map[string]any{"ref": o.Ref})
	if len([]rune(res.Content)) > maxBodyRunes+1000 {
		t.Errorf("正文没有被截断，长度 %d", len([]rune(res.Content)))
	}
	if !strings.Contains(res.Content, "截断") {
		t.Errorf("截断了却没说明，模型会把半句话当全文：\n%s", res.Content)
	}
}

func TestGetObjectUnknownRef(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)
	res := call(t, tb, ctx, "get_object", map[string]any{"ref": "REQ-9999"})
	if !strings.Contains(res.Content, "错误") {
		t.Errorf("不存在的编号应该回一条错误，实际：%s", res.Content)
	}
}

// --- ask_user ---

func TestAskUserProducesQuestion(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)

	res := call(t, tb, ctx, "ask_user", map[string]any{
		"question": "这个需求只做云端还是本地端也要跟？",
		"options": []any{
			map[string]any{"label": "只做云端", "detail": "本期只覆盖 web 后台，本地端排后续迭代"},
			map[string]any{"label": "两端都做", "detail": "范围翻倍，需要本地端同学一起排期"},
		},
	})
	q := res.Question
	if q == nil {
		t.Fatalf("没有产出 Question：%s", res.Content)
	}
	if !strings.HasPrefix(q.ID, "q_") {
		t.Errorf("id = %q，契约要求 q_ 前缀", q.ID)
	}
	if len(q.Options) != 2 || q.Options[1].Detail == "" {
		t.Fatalf("选项解析错了：%+v", q.Options)
	}
	if q.Multi {
		t.Errorf("没传 multi 时应该是单选")
	}
	// 回给模型的内容必须说清「本轮到此为止」，否则它会接着替用户把答案假设出来。
	if !strings.Contains(res.Content, "不要再调用任何工具") {
		t.Errorf("没有告诉模型停手：%s", res.Content)
	}
}

// TestAskUserRejectsOptionWithoutDetail 是这条线上最容易被「优化」掉的一条：
// 只给 label 的选项等于逼用户猜选它会怎样，必须退回让模型重填。
func TestAskUserRejectsOptionWithoutDetail(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)
	res := call(t, tb, ctx, "ask_user", map[string]any{
		"question": "要不要拆？",
		"options": []any{
			map[string]any{"label": "拆", "detail": "按前后端拆成三条任务"},
			map[string]any{"label": "不拆"},
		},
	})
	if res.Question != nil {
		t.Fatalf("缺 detail 的选项被放行了")
	}
	if !strings.Contains(res.Content, "detail") {
		t.Errorf("错误里没点明是 detail 的问题，模型不知道改哪：%s", res.Content)
	}
}

func TestAskUserRejectsSingleOption(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)
	res := call(t, tb, ctx, "ask_user", map[string]any{
		"question": "行吗？",
		"options":  []any{map[string]any{"label": "行", "detail": "就这么定"}},
	})
	if res.Question != nil {
		t.Fatalf("单选项被放行了——那是通知，不是提问")
	}
}

// TestAskUserAcceptsFlatStrings 是给 4B 模型留的容错：它时不时把嵌套对象拍平成
// "选项名|说明"。为此白白浪费一轮重试不值得。
func TestAskUserAcceptsFlatStrings(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)
	res := call(t, tb, ctx, "ask_user", map[string]any{
		"question": "先做哪个？",
		"options":  []any{"先做导出|接口简单，一天能完", "先做对账|依赖财务给口径，要等"},
		"multi":    "true", // 字符串形式的 true 也要认
	})
	if res.Question == nil {
		t.Fatalf("字符串写法的选项没被认出来：%s", res.Content)
	}
	if res.Question.Options[0].Detail != "接口简单，一天能完" {
		t.Errorf("detail 没切出来：%+v", res.Question.Options[0])
	}
	if !res.Question.Multi {
		t.Errorf(`multi="true" 应该认成多选`)
	}
}

// TestAskUserCapsQuestionCount 挡的是「答完一个又冒出一个」：
// 问满上限后必须退回，并且要告诉模型改用「在方案里标成待确认」收场。
func TestAskUserCapsQuestionCount(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)
	args := map[string]any{
		"question": "问题",
		"options": []any{
			map[string]any{"label": "A", "detail": "选 A 的代价"},
			map[string]any{"label": "B", "detail": "选 B 的代价"},
		},
	}
	for i := 0; i < maxQuestions; i++ {
		if call(t, tb, ctx, "ask_user", args).Question == nil {
			t.Fatalf("第 %d 个问题就被拦了", i+1)
		}
	}
	res := call(t, tb, ctx, "ask_user", args)
	if res.Question != nil {
		t.Fatalf("超过上限还能接着问")
	}
	if !strings.Contains(res.Content, "待确认") {
		t.Errorf("没给出收场方式，模型会卡住：%s", res.Content)
	}
}

// TestAskUserRejectsPreamble 挡的是真机上见过的一种形状：question 写成
// 「这条需求需要先厘清两个问题：」，后面的选项分属两个不同问题，
// 用户挑了一个，另一个就永远没人答。
func TestAskUserRejectsPreamble(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)
	res := call(t, tb, ctx, "ask_user", map[string]any{
		"question": "这条需求的推进方案需要先厘清两个问题：",
		"options": []any{
			map[string]any{"label": "按业务线拆分要做", "detail": "范围扩大，要加拆分维度"},
			map[string]any{"label": "退款口径优先级要调", "detail": "先确认它是不是阻塞项"},
		},
	})
	if res.Question != nil {
		t.Fatalf("开场白被当成问题放行了")
	}
	if !strings.Contains(res.Content, "分几次调用") {
		t.Errorf("没告诉模型该怎么改：%s", res.Content)
	}
}

// TestAskUserAcceptsQuestionWithoutQuestionMark 是上一条的边界：
// 只卡冒号结尾，不要求必须有问号——「请确认是否需要按业务线拆分」是个合格的问题，
// 卡它只会白白浪费一轮重试。
func TestAskUserAcceptsQuestionWithoutQuestionMark(t *testing.T) {
	tb, _, ctx, _ := newToolbox(t)
	res := call(t, tb, ctx, "ask_user", map[string]any{
		"question": "请确认是否需要按业务线拆分",
		"options": []any{
			map[string]any{"label": "需要", "detail": "加一个业务线维度，工期多一周"},
			map[string]any{"label": "不需要", "detail": "保持现在的范围"},
		},
	})
	if res.Question == nil {
		t.Fatalf("没有问号的合格问题被误伤了：%s", res.Content)
	}
}
