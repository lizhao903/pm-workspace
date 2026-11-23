// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 执行完成改待验收（TSK-0861，SPEC-tasks-6.42）：后台执行、终端交接、工作台 Agent 成功完成后任务改成 review；
// 失败、取消、终态、执行期间改过状态、同任务还有别的执行没结束都不改。

func taskStatus(t *testing.T, f *fakeStore, id string) string {
	t.Helper()
	o, err := f.GetObject(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	return o.Status
}

func TestStreamRunDoneMovesTaskToReview(t *testing.T) {
	s, f, obj, _ := runFixture(t, "cat <<'EOF'\n"+runNDJSON+"\nEOF")
	allTaskStatuses(f)
	evs := runEvents(t, do(s, "POST", "/api/objects/"+obj.ID+"/run", `{"allow_writes":true}`))
	runID, _ := evs[len(evs)-1]["run_id"].(string)
	if got := taskStatus(t, f, obj.ID); got != domain.TaskStatusReview {
		t.Fatalf("成功完成后应是 review，得到 %s", got)
	}
	notes, _ := f.ListProgress(t.Context(), obj.ID, 10)
	if len(notes) == 0 || notes[0].Text != "Claude Code 执行完成（执行记录 "+store.ShortRunID(runID)+"），状态改为待验收" || notes[0].Status != domain.TaskStatusReview {
		t.Fatalf("应记一条带状态的进展：%+v", notes)
	}
}

func TestStreamRunFailedKeepsDoing(t *testing.T) {
	s, f, obj, _ := runFixture(t, "echo '鉴权失败' >&2\nexit 2")
	allTaskStatuses(f)
	runEvents(t, do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`))
	if got := taskStatus(t, f, obj.ID); got != "doing" {
		t.Fatalf("执行失败不该改状态，得到 %s", got)
	}
}

// 类型状态集里没有 review（用户在设置里删了）时不改，执行照常收尾。
func TestStreamRunDoneWithoutReviewStatus(t *testing.T) {
	s, f, obj, _ := runFixture(t, "cat <<'EOF'\n"+runNDJSON+"\nEOF")
	runEvents(t, do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`))
	if got := taskStatus(t, f, obj.ID); got != "doing" {
		t.Fatalf("没有 review 状态时不该改，得到 %s", got)
	}
}

func TestRunReviewStatusRules(t *testing.T) {
	_, f, task, _ := terminalFixture(t)
	allTaskStatuses(f)
	ctx := t.Context()
	set := func(st string) {
		t.Helper()
		if _, err := f.UpdateObject(ctx, task.ID, domain.ObjectPatch{Status: &st}, store.DefaultActor); err != nil {
			t.Fatal(err)
		}
	}
	run, err := f.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: task.ID, Workdir: t.TempDir(), Status: domain.RunRunning, Mode: domain.RunModeStream})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.FinishTaskRun(ctx, run.ID, domain.RunDone, 0, "", ""); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		status, expect, want string
	}{
		{"doing", "doing", domain.TaskStatusReview},
		{"todo", "", domain.TaskStatusReview},     // 插件运行发起时读到 todo、没改过
		{"todo", "todo", domain.TaskStatusReview}, // 同上
		{"blocked", "doing", ""},                  // 执行期间人改成受阻：以人改的为准
		{"todo", "doing", ""},                     // 执行期间被改回未开工
		{"review", "doing", ""},                   // 执行者经 MCP 自己提交了验收
		{"done", "doing", ""},                     // 终态不倒退
		{"cancelled", "doing", ""},
	} {
		set(c.status)
		key, why, err := store.RunReviewStatus(ctx, f, task.ID, run.ID, c.expect)
		if err != nil || key != c.want {
			t.Errorf("%s（发起时 %q）：应得 %q，得到 %q（%s，%v）", c.status, c.expect, c.want, key, why, err)
		}
	}

	// 状态集里标了 terminal 的自定义终态也不倒退
	f.mu.Lock()
	f.types["task"].Statuses = append(f.types["task"].Statuses, domain.Status{Key: "archived", Label: "归档", Terminal: true})
	f.mu.Unlock()
	set("archived")
	if key, _, _ := store.RunReviewStatus(ctx, f, task.ID, run.ID, ""); key != "" {
		t.Errorf("自定义终态不该改，得到 %q", key)
	}

	// 同一任务还有别的执行没结束（在跑或等人确认）：等它收尾再说
	set("doing")
	other, _ := f.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: task.ID, Workdir: t.TempDir(), Status: domain.RunWaiting, Mode: domain.RunModeStream})
	if key, why, _ := store.RunReviewStatus(ctx, f, task.ID, run.ID, "doing"); key != "" || !strings.Contains(why, other.ID) {
		t.Errorf("还有执行没结束时不该改，得到 %q（%s）", key, why)
	}
	if _, err := f.FinishTaskRun(ctx, other.ID, domain.RunDone, 0, "", ""); err != nil {
		t.Fatal(err)
	}
	if key, _, _ := store.RunReviewStatus(ctx, f, task.ID, other.ID, "doing"); key != domain.TaskStatusReview {
		t.Errorf("最后一个收尾时应改，得到 %q", key)
	}

	// 不是任务的不改
	if key, _, _ := store.RunReviewStatus(ctx, f, *task.ProjectID, run.ID, ""); key != "" {
		t.Errorf("项目不该改，得到 %q", key)
	}
}

// 终端交接：回报 done 改待验收，failed / canceled 不改；终端里的 claude 已经自己改成已完成的不倒退。
func TestTerminalFinishMovesTaskToReview(t *testing.T) {
	for _, c := range []struct{ status, preset, want string }{
		{"done", "", domain.TaskStatusReview},
		{"failed", "", "doing"},
		{"canceled", "", "doing"},
		{"done", "done", "done"},
	} {
		s, f, task, _ := terminalFixture(t)
		allTaskStatuses(f)
		w := do(s, "POST", "/api/objects/"+task.ID+"/run/terminal", `{}`)
		if w.Code != http.StatusCreated {
			t.Fatalf("终端交接 %d %s", w.Code, w.Body)
		}
		run := decodeEnvelope(t, w)["data"].(map[string]any)["run"].(map[string]any)
		if c.preset != "" {
			st := c.preset
			if _, err := f.UpdateObject(t.Context(), task.ID, domain.ObjectPatch{Status: &st}, store.DefaultActor); err != nil {
				t.Fatal(err)
			}
		}
		if w := do(s, "POST", "/api/runs/"+run["id"].(string)+"/finish", `{"status":"`+c.status+`","summary":"做完了"}`); w.Code != http.StatusOK {
			t.Fatalf("finish %d %s", w.Code, w.Body)
		}
		if got := taskStatus(t, f, task.ID); got != c.want {
			t.Errorf("终端回报 %s（执行中改成 %q）后应是 %s，得到 %s", c.status, c.preset, c.want, got)
		}
	}
}

// 工作台 Agent：完成时改待验收，和「执行完成」那条进展一次写；Agent 自己改了状态的不覆盖。
func TestAgentRunDoneMovesTaskToReview(t *testing.T) {
	f := newAgentRunFixture(t, `{"read_tasks":"auto","write_tasks":"auto"}`)
	ctx := context.Background()
	f.up.push(`{"message":{"role":"assistant","content":"结论：看完了，清单在正文里。"},"done":true}`)
	f.run(t, `{"harness":"agent","agent_id":"`+f.agent+`"}`)
	obj, _ := f.st.GetObject(ctx, f.task)
	if obj.Status != domain.TaskStatusReview {
		t.Fatalf("Agent 完成后应是 review，得到 %s", obj.Status)
	}
	list, _ := f.st.ListProgress(ctx, f.task, 0)
	if len(list) == 0 || !strings.Contains(list[0].Text, "执行完成") || !strings.Contains(list[0].Text, "状态改为待验收") || list[0].Status != domain.TaskStatusReview {
		t.Fatalf("进展 = %+v", list)
	}

	// Agent 执行中把任务改成受阻：不覆盖
	f.up.push(
		toolCallLine("update_object", `{"ref":"`+f.ref+`","status":"blocked"}`),
		`{"message":{"role":"assistant","content":"缺资料，先停下。"},"done":true}`,
	)
	f.run(t, `{"harness":"agent","agent_id":"`+f.agent+`"}`)
	if obj, _ = f.st.GetObject(ctx, f.task); obj.Status != "blocked" {
		t.Fatalf("Agent 自己改成受阻的不该被覆盖，得到 %s", obj.Status)
	}
}
