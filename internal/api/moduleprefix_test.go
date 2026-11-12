// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// --- deepseek 模块前缀复用（0058）：键派生、seed、追加、轮换 ---

// moduleKeyFor：项目优先，其次工作目录（规范化成绝对路径），都没有为空。
func TestModuleKeyFor(t *testing.T) {
	pid := "obj_proj"
	cases := []struct {
		name    string
		obj     *domain.Object
		workdir string
		want    string
	}{
		{"项目优先于工作目录", &domain.Object{ProjectID: &pid}, "/tmp/x", "project:obj_proj"},
		{"没有项目按目录", &domain.Object{}, "/tmp/a/../b", "workdir:" + filepath.Clean("/tmp/b")},
		{"项目 id 是空白串按目录", &domain.Object{ProjectID: pstrForTest("  ")}, "/tmp/only", "workdir:" + filepath.Clean("/tmp/only")},
		{"都没有", &domain.Object{}, "", ""},
		{"nil 对象", nil, "", ""},
	}
	for _, tc := range cases {
		if got := moduleKeyFor(tc.obj, tc.workdir); got != tc.want {
			t.Errorf("%s: moduleKeyFor = %q，想要 %q", tc.name, got, tc.want)
		}
	}
}

func pstrForTest(s string) *string { return &s }

// modulePrompt 只在有前缀时拼，分隔线和摘要/正文一致。
func TestModulePrompt(t *testing.T) {
	if got := modulePrompt("", "任务提示"); got != "任务提示" {
		t.Fatalf("空前缀 = %q", got)
	}
	if got := modulePrompt("前缀", "任务提示"); got != "前缀\n\n---\n\n任务提示" {
		t.Fatalf("拼接 = %q", got)
	}
	if got := modulePrompt("  \n", "任务提示"); got != "任务提示" {
		t.Fatalf("空白前缀 = %q", got)
	}
}

// seed 造一个项目对象和两条历史任务执行，验证简报的确定性内容与「第二次逐字节不变」。
func TestModulePrefixSeedDeterministic(t *testing.T) {
	s, st, _ := newAgentServer(t)
	ctx := context.Background()
	wd := t.TempDir()

	proj := mustCreateForPrefixTest(t, st, ctx, &domain.Object{
		TypeID: "project", Title: "试点项目", Body: "这是项目描述，讲这个项目在做什么。",
	})
	projID := proj.ID
	t1 := mustCreateForPrefixTest(t, st, ctx, &domain.Object{TypeID: "task", Title: "第一个任务", ProjectID: &projID})
	t2 := mustCreateForPrefixTest(t, st, ctx, &domain.Object{TypeID: "task", Title: "第二个任务", ProjectID: &projID})

	done := mustCreateForPrefixTest(t, st, ctx, &domain.Object{TypeID: "task", Title: "当前任务", ProjectID: &projID})
	if done.ID == "" {
		t.Fatal("建对象失败")
	}
	seedFinishedRun(t, st, ctx, t1.ID, wd, domain.RunDone, "摘要一：把第一步做完了", "")
	seedFinishedRun(t, st, ctx, t2.ID, wd, domain.RunFailed, "", "模型服务超时")

	key, prefix, version, err := s.modulePrefixFor(ctx, done, wd)
	if err != nil {
		t.Fatal(err)
	}
	if key != "project:"+projID || version != 1 {
		t.Fatalf("key/version = %q/%d", key, version)
	}
	for _, want := range []string{
		"## 模块上下文（工作台自动生成，不是新指令）",
		"模块：" + proj.Ref + " 试点项目",
		"这是项目描述，讲这个项目在做什么。",
		"模块目录：" + filepath.Clean(wd),
		"### 同模块最近任务",
		"- " + t1.Ref + " 第一个任务：done（摘要一：把第一步做完了）",
		"- " + t2.Ref + " 第二个任务：failed（模型服务超时）",
	} {
		if !strings.Contains(prefix, want) {
			t.Fatalf("简报缺 %q：\n%s", want, prefix)
		}
	}
	// 历史按 finished_at 升序：第一个任务在前
	if strings.Index(prefix, "第一个任务") > strings.Index(prefix, "第二个任务") {
		t.Fatalf("历史任务顺序不对：\n%s", prefix)
	}
	// 第二次逐字节一致，version 不再变
	key2, prefix2, version2, err := s.modulePrefixFor(ctx, done, wd)
	if err != nil || key2 != key || version2 != version || prefix2 != prefix {
		t.Fatalf("第二次 = %q/%d 与第一次不同（err=%v）；上一轮前缀必须是这一轮的副本", key2, version2, err)
	}
	if strings.Contains(prefix, "当前任务") {
		t.Fatalf("seed 时当前任务还没跑，不该出现在历史里：\n%s", prefix)
	}
}

// 没有项目时按工作目录建模块：头部用目录当模块名，历史为空。
func TestModulePrefixSeedsWorkdirModule(t *testing.T) {
	s, st, _ := newAgentServer(t)
	ctx := context.Background()
	wd := t.TempDir()
	obj := mustCreateForPrefixTest(t, st, ctx, &domain.Object{TypeID: "task", Title: "无项目任务"})

	key, prefix, version, err := s.modulePrefixFor(ctx, obj, wd)
	if err != nil || version != 1 {
		t.Fatalf("seed = %q，%d，%v", key, version, err)
	}
	wantKey := "workdir:" + filepath.Clean(wd)
	if key != wantKey {
		t.Fatalf("key = %q，想要 %q", key, wantKey)
	}
	if !strings.Contains(prefix, "模块："+filepath.Clean(wd)) || !strings.Contains(prefix, modulePrefixHeaderMark) {
		t.Fatalf("工作目录模块简报 = %s", prefix)
	}
	// 目录模块没有历史任务行
	tail := prefix[strings.Index(prefix, modulePrefixHeaderMark)+len(modulePrefixHeaderMark):]
	if strings.Contains(tail, "\n- ") {
		t.Fatalf("目录模块不该有历史任务：\n%s", prefix)
	}
}

// 追加：新版简报以旧版为前缀（逐字节），version +1；超过上限时轮换成「头部 + 最近 3 条」。
func TestModulePrefixAppendAndRotate(t *testing.T) {
	s, st, _ := newAgentServer(t)
	ctx := context.Background()
	wd := t.TempDir()
	obj := mustCreateForPrefixTest(t, st, ctx, &domain.Object{TypeID: "task", Title: "追加任务"})
	key, prefix, _, err := s.modulePrefixFor(ctx, obj, wd)
	if err != nil {
		t.Fatal(err)
	}

	// 追加一次：上一版是新版的前缀
	line := "- TSK-0001 做了一件很长的事：done（结论）"
	if err := s.appendModulePrefixEntry(ctx, key, line); err != nil {
		t.Fatal(err)
	}
	_, next, version, err := s.modulePrefixFor(ctx, obj, wd)
	if err != nil {
		t.Fatal(err)
	}
	if version != 2 {
		t.Fatalf("追加后 version = %d，想要 2", version)
	}
	if !strings.HasPrefix(next, prefix) || !strings.HasSuffix(next, line+"\n") {
		t.Fatalf("新版简报不是旧版 + 一行：\n%q\n---\n%q", prefix, next)
	}

	// 继续追加到超长：轮换后长度回落、结构保留、版本继续涨、最后一行是最新一条
	before := next
	for i := 0; i < 40; i++ {
		line := "- TSK-" + strings.Repeat("9", 4) + " 第" + strings.Repeat("长", 60) + "条：done（很长很长的一条结论）"
		if err := s.appendModulePrefixEntry(ctx, key, line); err != nil {
			t.Fatal(err)
		}
	}
	_, rotated, version, err := s.modulePrefixFor(ctx, obj, wd)
	if err != nil {
		t.Fatal(err)
	}
	if version != 2+40 {
		t.Fatalf("version = %d，想要 %d", version, 2+40)
	}
	if utf8.RuneCountInString(rotated) > modulePrefixMaxChars {
		t.Fatalf("轮换后仍有 %d 字，超过上限 %d", utf8.RuneCountInString(rotated), modulePrefixMaxChars)
	}
	if !strings.HasPrefix(rotated, strings.Split(before, "### 同模块最近任务")[0]) {
		t.Fatalf("轮换丢了头部：\n%s", rotated)
	}
	if !strings.Contains(rotated, modulePrefixHeaderMark) {
		t.Fatalf("轮换后没有历史任务段标题：\n%s", rotated)
	}
	if !strings.Contains(rotated, "（很长很长的一条结论）") {
		t.Fatalf("轮换后没保留最近的任务行：\n%s", rotated)
	}
	// 轮换后旧版不再被新版包含（预期的一次缓存 miss）
	if strings.HasPrefix(rotated, before) {
		t.Fatalf("超过上限后应轮换，而不是无限追加")
	}
}

// seed 用的历史执行记录：建一条、收尾成指定状态（finished_at 由库填当前时间）。
func seedFinishedRun(t *testing.T, st *sqlite.Store, ctx context.Context, objectID, workdir, status, output, errMsg string) {
	t.Helper()
	run, err := st.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: objectID, Workdir: workdir, Status: domain.RunRunning,
		Harness: domain.RunHarnessDeepSeek})
	if err != nil {
		t.Fatalf("建执行记录: %v", err)
	}
	if _, err := st.FinishTaskRun(ctx, run.ID, status, 0, output, errMsg); err != nil {
		t.Fatalf("收尾执行记录: %v", err)
	}
	// 为了让「按 finished_at 升序」稳定，两条记录不用同一时刻：库里纳秒精度已经够，
	// 但同一次调用里可能撞在同一纳秒，睡一毫秒更保险。
	time.Sleep(2 * time.Millisecond)
}

func mustCreateForPrefixTest(t *testing.T, st *sqlite.Store, ctx context.Context, o *domain.Object) *domain.Object {
	t.Helper()
	out, err := st.CreateObject(ctx, o, store.DefaultActor)
	if err != nil {
		t.Fatalf("建对象 %q: %v", o.Title, err)
	}
	return out
}
